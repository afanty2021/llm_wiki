//! Training 管线路由（M1）。本任务：POST /media-assets 批量 upsert（svc-transcriber 调用，
//! LT team Admin 鉴权）。/bind 端点在 Task 8 实现。

use axum::{extract::State, http::HeaderMap, routing::post, Json, Router};
use serde::Deserialize;

use crate::middleware::project_guard::{check_project_access_with_role, RequiredRole};
use crate::{AppState, AppError};

pub fn training_routes() -> Router<AppState> {
    Router::new().route("/media-assets", post(import_media_assets))
}

#[derive(Deserialize)]
pub struct MediaAssetItem {
    pub slug: String,
    pub media_ref: String,
    pub playback_path: Option<String>,
    pub duration_s: i32,
    pub codec: Option<String>,
    pub kind: String,
    pub chapters: serde_json::Value,
    pub transcript_page_path: Option<String>,
    pub source_path: Option<String>,
}

#[derive(Deserialize)]
pub struct ImportRequest {
    pub items: Vec<MediaAssetItem>,
}

/// POST /api/v1/training/media-assets — 批量 upsert（ON CONFLICT (slug)），响应 `{"imported": N}`。
/// 鉴权：TRAINING__PROJECT_ID 所指项目的 Admin（owner 亦可通过，role_meets 语义）。
async fn import_media_assets(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<ImportRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let project_id = state
        .config
        .training
        .project_id
        .ok_or_else(|| AppError::InternalError("TRAINING__PROJECT_ID not configured".into()))?;
    let _ = check_project_access_with_role(&state, &headers, project_id, RequiredRole::Admin).await?;
    if req.items.is_empty() {
        return Err(AppError::BadRequest("items is empty".into()));
    }
    // 批量原子：中途 Err 提前返回 → tx drop 回滚，不落半批。
    let mut tx = state.db.begin().await.map_err(AppError::from)?;
    for it in &req.items {
        if !(it.kind == "video" || it.kind == "audio") {
            return Err(AppError::BadRequest(format!("bad kind: {}", it.kind)));
        }
        sqlx::query(
            "INSERT INTO media_assets (slug, media_ref, playback_path, duration_s, codec, kind, chapters, transcript_page_path, source_path) \
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) \
             ON CONFLICT (slug) DO UPDATE SET media_ref=EXCLUDED.media_ref, playback_path=EXCLUDED.playback_path, \
               duration_s=EXCLUDED.duration_s, codec=EXCLUDED.codec, kind=EXCLUDED.kind, chapters=EXCLUDED.chapters, \
               transcript_page_path=EXCLUDED.transcript_page_path, source_path=EXCLUDED.source_path, updated_at=NOW()",
        )
        .bind(&it.slug)
        .bind(&it.media_ref)
        .bind(&it.playback_path)
        .bind(it.duration_s)
        .bind(&it.codec)
        .bind(&it.kind)
        .bind(&it.chapters)
        .bind(&it.transcript_page_path)
        .bind(&it.source_path)
        .execute(&mut *tx)
        .await
        .map_err(AppError::from)?;
    }
    tx.commit().await.map_err(AppError::from)?;
    Ok(Json(serde_json::json!({ "imported": req.items.len() })))
}
