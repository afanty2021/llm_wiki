//! Task 7：GET /media/:media_id（顶级路由，HMAC 签名 + Range 流式）。
//! 鉴权不落 JWT 体系：`?exp=<unix>&sig=<hex>`，sig = HMAC-SHA256(key, "{media_id}:{exp}")。

use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Router,
};
use tokio::io::{AsyncReadExt, AsyncSeekExt, SeekFrom};

use sqlx::Row;

use crate::{AppError, AppState};

#[derive(serde::Deserialize)]
pub struct MediaQuery {
    pub exp: i64,
    pub sig: String,
}

pub fn media_routes() -> Router<AppState> {
    Router::new().route("/media/:media_id", axum::routing::get(get_media))
}

/// "bytes=a-b" | "bytes=a-" → Some((start, end_inclusive))；total=0 / 无法解析 / 后缀式 "bytes=-n" → None（按全量 200）。
/// 畸形头（start>end 或 start≥total）→ Some((total, total-1)) 哨兵，调用方判 416。total=0 已早退，哨兵不构造失败。
pub fn parse_range(h: Option<&str>, total: u64) -> Option<(u64, u64)> {
    if total == 0 {
        return None;
    }
    let h = h?.strip_prefix("bytes=")?;
    let (a, b) = h.split_once('-')?;
    let start: u64 = a.parse().ok()?; // 后缀式 a 为空 → parse 失败 → None
    let end = if b.is_empty() {
        total - 1
    } else {
        b.parse::<u64>().ok()?.min(total - 1)
    };
    if start >= total || start > end {
        return Some((total, total - 1)); // 哨兵 → 416
    }
    Some((start, end))
}

/// 查询参数用 Option<Query>：缺失/畸形（axum 默认会 400）统一并入 403 验签失败路径，不泄露参数信息。
async fn get_media(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(media_id): Path<String>,
    q: Option<Query<MediaQuery>>,
) -> Result<Response, AppError> {
    let key = &state.config.media.signing_key;
    if key.is_empty() {
        return Err(AppError::InternalError(
            "MEDIA__SIGNING_KEY not configured".into(),
        ));
    }
    let ok = match &q {
        Some(Query(q)) if q.exp > chrono::Utc::now().timestamp() => {
            crate::utils::media_sign::verify_media_sig(key, &media_id, q.exp, &q.sig)
        }
        _ => false,
    };
    if !ok {
        tracing::warn!(media_id = %media_id, "media request rejected: invalid or expired signature");
        return Err(AppError::PermissionDenied);
    }
    let row = sqlx::query(
        "SELECT COALESCE(playback_path, media_ref) AS p, kind FROM media_assets WHERE slug = $1",
    )
    .bind(&media_id)
    .fetch_optional(&state.db)
    .await
    .map_err(AppError::from)?;
    let (path, _kind): (String, String) = row
        .map(|r| (r.get("p"), r.get("kind")))
        .ok_or_else(|| AppError::ResourceNotFound("media".into()))?;
    let file = tokio::fs::File::open(&path)
        .await
        .map_err(|_| AppError::ResourceNotFound("media file".into()))?;
    let total = file
        .metadata()
        .await
        .map_err(|_| AppError::InternalError("stat".into()))?
        .len();
    let mime = match std::path::Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
    {
        Some("mp4") | Some("m4v") => "video/mp4",
        Some("mp3") => "audio/mpeg",
        Some("m4a") | Some("aac") => "audio/aac",
        _ => "application/octet-stream",
    };
    let range_hdr = headers.get(header::RANGE).and_then(|v| v.to_str().ok());
    match parse_range(range_hdr, total) {
        Some((s, _)) if s >= total => Ok((
            StatusCode::RANGE_NOT_SATISFIABLE,
            [(header::CONTENT_RANGE, format!("bytes */{total}"))],
        )
            .into_response()),
        Some((s, e)) => {
            let mut f = file;
            f.seek(SeekFrom::Start(s))
                .await
                .map_err(|_| AppError::InternalError("seek".into()))?;
            let len = e - s + 1;
            let stream = tokio_util::io::ReaderStream::with_capacity(f.take(len), 64 * 1024);
            Ok(Response::builder()
                .status(206)
                .header(header::CONTENT_TYPE, mime)
                .header(header::CONTENT_LENGTH, len.to_string())
                .header(header::CONTENT_RANGE, format!("bytes {s}-{e}/{total}"))
                .header(header::ACCEPT_RANGES, "bytes")
                .body(axum::body::Body::from_stream(stream))
                .unwrap())
        }
        None => {
            let stream = tokio_util::io::ReaderStream::with_capacity(file, 64 * 1024);
            Ok(Response::builder()
                .status(200)
                .header(header::CONTENT_TYPE, mime)
                .header(header::CONTENT_LENGTH, total.to_string())
                .header(header::ACCEPT_RANGES, "bytes")
                .body(axum::body::Body::from_stream(stream))
                .unwrap())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::parse_range;

    #[test]
    fn parse_range_inverted_start_gt_end_yields_416_sentinel() {
        // start > end → 哨兵 (total, total-1)，调用方判 416（s >= total 分支）
        assert_eq!(parse_range(Some("bytes=5-2"), 100), Some((100, 99)));
    }

    #[test]
    fn parse_range_suffix_none_serves_full_200() {
        // 后缀式 "bytes=-500"：a 为空 → parse 失败 → None（按全量 200，不支持后缀式）
        assert_eq!(parse_range(Some("bytes=-500"), 100), None);
    }

    #[test]
    fn parse_range_open_end_covers_rest_of_file() {
        // "bytes=0-" 开区间 → 全量 (0, total-1)（206）
        assert_eq!(parse_range(Some("bytes=0-"), 100), Some((0, 99)));
        // end 超 total-1 → min 截断
        assert_eq!(parse_range(Some("bytes=90-500"), 100), Some((90, 99)));
    }

    #[test]
    fn parse_range_zero_total_is_none_regardless_of_header() {
        assert_eq!(parse_range(Some("bytes=0-"), 0), None);
        assert_eq!(parse_range(None, 0), None);
    }
}
