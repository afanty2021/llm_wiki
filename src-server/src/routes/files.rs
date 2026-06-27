use axum::{
    extract::{DefaultBodyLimit, Multipart, Path, State, Json, Query},
    http::StatusCode,
    response::IntoResponse,
};
use serde::{Deserialize, Serialize};
use crate::{
    AppState, AppError,
    middleware::project_guard::{check_project_access, check_project_access_with_role, RequiredRole},
    services::storage,
};

const MAX_UPLOAD_SIZE: usize = 100 * 1024 * 1024; // 100MB

pub fn file_routes() -> axum::Router<AppState> {
    axum::Router::new()
        // 通配符路由匹配架构文档 §3.1.2
        // 注意：通配符路由必须在最后定义
        .route("/:project_id/upload", axum::routing::post(upload_file)
            .layer(DefaultBodyLimit::max(MAX_UPLOAD_SIZE)))
        .route("/:project_id/list", axum::routing::get(list_files))
        // stat 显式路由，必须在 /*path 通配符之前，否则会被 read_file 吞掉
        .route("/:project_id/stat/*path", axum::routing::get(stat_file))
        // raw 二进制端点:返回文件原始字节(图片/视频/音频/pdf),供 web 预览。
        // read_file 用 read_to_string 对二进制会乱码,故 raw 直接吐字节流。
        // 静态段 raw 优先于 /*path 通配符(matchit 0.7),但顺序上仍放 stat 之后、/*path 之前。
        .route("/:project_id/raw/*path", axum::routing::get(raw_file))
        .route("/:project_id/*path", axum::routing::get(read_file))
        .route("/:project_id/*path", axum::routing::post(write_file))
        .route("/:project_id/*path", axum::routing::delete(delete_file))
}

// POST /api/v1/files/:project_id/upload
pub async fn upload_file(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(project_id): Path<i32>,
    mut multipart: Multipart,
) -> Result<impl IntoResponse, AppError> {
    let (_user_id, team_id) = check_project_access(&state, &headers, project_id).await?;

    let mut dest_subdir = String::new();
    let mut file_data: Vec<u8> = Vec::new();
    let mut file_name = String::from("upload.bin");

    while let Some(field) = multipart.next_field().await
        .map_err(|_| AppError::FileUploadFailed)?
    {
        match field.name().unwrap_or("") {
            "path" => {
                dest_subdir = field.text().await
                    .map_err(|_| AppError::BadRequest("Invalid path field".into()))?;
            }
            "file" => {
                file_name = field.file_name()
                    .unwrap_or("upload.bin").to_string();
                file_data = field.bytes().await
                    .map_err(|_| AppError::FileUploadFailed)?
                    .to_vec();
            }
            _ => {}
        }
    }

    if file_data.is_empty() {
        return Err(AppError::BadRequest("No file provided".into()));
    }

    let subdir_rel = dest_subdir.trim_start_matches('/');
    if subdir_rel.contains("..") {
        return Err(AppError::BadRequest("Invalid upload path".into()));
    }
    // rel = project-relative path（原 dest.strip_prefix(&base) 的等价形式，无前导斜杠）
    // write_bytes 内部创建 project base + 父目录，故不再需要显式 ensure_dir。
    let rel = if subdir_rel.is_empty() {
        file_name.clone()
    } else {
        format!("{}/{}", subdir_rel, file_name)
    };
    state.storage.write_bytes(team_id, project_id, &rel, &file_data).await?;

    Ok((StatusCode::CREATED, Json(serde_json::json!({
        "name": file_name,
        "path": rel,
        "size": file_data.len(),
    }))))
}

#[derive(Deserialize)]
struct ListQuery {
    dir: Option<String>,
}

// GET /api/v1/files/:project_id/list?dir=...
pub async fn list_files(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(project_id): Path<i32>,
    Query(params): Query<ListQuery>,
) -> Result<impl IntoResponse, AppError> {
    let (_user_id, team_id) = check_project_access(&state, &headers, project_id).await?;
    // list_dir 对不存在的 base / dir 返回空 Vec（对齐原 base.exists/dir.exists 短路）。
    let dir_rel = params.dir.unwrap_or_default();
    let entries = state.storage.list_dir(team_id, project_id, &dir_rel).await?;
    Ok(Json(serde_json::json!(entries)))
}

// GET /api/v1/files/:project_id/stat/*path — 文件元信息
// 供前端 fs.ts 的 fileExists/getFileSize/getFileModifiedTime 共用。
// 不存在的文件返回 exists=false（而非 404），便于前端区分“无文件”与“鉴权/路径错误”。
#[derive(Serialize)]
struct StatResp {
    exists: bool,
    is_dir: bool,
    size: u64,
    modified: i64,
}

pub async fn stat_file(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Path((project_id, path)): Path<(i32, String)>,
) -> Result<impl IntoResponse, AppError> {
    let (_user_id, team_id) = check_project_access(&state, &headers, project_id).await?;

    // metadata 对 base 不存在 / 文件不存在均返回 Err → 统一映射 exists:false（软失败，对齐原行为）。
    let resp = match state.storage.metadata(team_id, project_id, &path).await {
        Ok(m) => StatResp { exists: true, is_dir: m.is_dir, size: m.size, modified: m.modified },
        Err(_) => StatResp { exists: false, is_dir: false, size: 0, modified: 0 },
    };
    Ok(Json(serde_json::json!(resp)))
}

// GET /api/v1/files/:project_id/raw/*path — 二进制原始字节(图片/视频/音频/pdf)
// read_file 用 read_to_string 对图片/媒体会乱码,故 raw 端点直接吐字节流。
// 鉴权与 stat_file/read_file 同款(check_project_access + safe_resolve)。
pub async fn raw_file(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Path((project_id, path)): Path<(i32, String)>,
) -> Result<axum::response::Response, AppError> {
    let (_user_id, team_id) = check_project_access(&state, &headers, project_id).await?;
    // read_bytes 对缺失返回 ResourceNotFound，其余 IO 错误返回 IoError；统一映射 404
    // （对齐原 tokio::fs::read().map_err(|_| ResourceNotFound) 的全错误折叠）。
    let bytes = state.storage.read_bytes(team_id, project_id, &path)
        .await
        .map_err(|_| AppError::ResourceNotFound("file".into()))?;
    let mime = mime_guess::from_path(&path)
        .first_or_octet_stream()
        .essence_str()
        .to_string();
    Ok(axum::response::Response::builder()
        .status(StatusCode::OK)
        .header("content-type", mime)
        .header("x-content-type-options", "nosniff") // 防 MIME sniffing(服务用户上传字节)
        .header("cache-control", "private, max-age=3600")
        .body(axum::body::Body::from(bytes))
        .unwrap())
}

// GET /api/v1/files/:project_id/read?path=<project-relative> — 读文本文件内容。
// path 取 query(apiClient.readFile URL /read?path=),非 URL *path(="read",仅占位);
// 早期用 URL *path 导致永远读 base/read(query path 被忽略),web 文件读取全坏。
#[derive(Deserialize)]
struct ReadQuery {
    path: String,
}

pub async fn read_file(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Path((project_id, _)): Path<(i32, String)>,
    Query(q): Query<ReadQuery>,
) -> Result<impl IntoResponse, AppError> {
    let (_user_id, team_id) = check_project_access(&state, &headers, project_id).await?;

    // ① 存在 + 是否目录（保留原 404/400 区分，经 trait metadata）
    let meta = match state.storage.metadata(team_id, project_id, &q.path).await {
        Ok(m) => m,
        Err(_) => return Err(AppError::ResourceNotFound("File not found".into())),
    };
    if meta.is_dir {
        return Err(AppError::BadRequest("Path is a directory".into()));
    }
    // ② 按扩展名分发
    let ext = storage::file_ext(std::path::Path::new(&q.path)).to_lowercase();
    let content = match ext.as_str() {
        "pdf" => {
            // 经 trait 读字节；extract_pdf 是阻塞子进程 → spawn_blocking 移出 reactor（review #1）
            let bytes = state.storage.read_bytes(team_id, project_id, &q.path).await?;
            tokio::task::spawn_blocking(move || extract_pdf(&bytes))
                .await
                .map_err(|e| AppError::InternalError(format!("pdf extract join failed: {}", e)))??
        }
        "docx" => {
            let bytes = state.storage.read_bytes(team_id, project_id, &q.path).await?;
            extract_docx(&bytes)?
        }
        "xlsx" | "xls" | "ods" => {
            let bytes = state.storage.read_bytes(team_id, project_id, &q.path).await?;
            extract_spreadsheet(&bytes)?
        }
        _ => state.storage.read_string(team_id, project_id, &q.path).await?,
    };

    Ok(Json(serde_json::json!({
        "path": q.path,
        "content": content,
        "extension": ext,
    })))
}

/// PDF 文本提取（**同步阻塞**——调用方须在 `spawn_blocking` 内执行）。
/// pdftotext 走 stdin(-)→stdout，输入字节而非本地路径，使 pdf 读取也能经
/// StorageBackend::read_bytes（消除 LocalStorage 路径依赖，S3 就绪）。
/// 检查退出码：损坏/加密 PDF 等非零退出 → 报错，而非静默返回空串（review #1）。
fn extract_pdf(bytes: &[u8]) -> Result<String, AppError> {
    use std::io::Write;
    use std::process::{Command, Stdio};
    let mut child = Command::new("pdftotext")
        .arg("-layout")
        .arg("-") // stdin
        .arg("-") // stdout
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped()) // 捕获 stderr 供错误诊断（原 Stdio::null 使失败不可见）
        .spawn()
        .map_err(|_| AppError::InternalError(
            "pdftotext not available. Install poppler-utils in Dockerfile.".into(),
        ))?;
    if let Some(mut stdin) = child.stdin.take() {
        // 写 stdin；broken pipe（pdftotext 提前退出，如损坏 PDF）→ 报错交调用方知悉，不静默吞
        stdin
            .write_all(bytes)
            .map_err(|e| AppError::InternalError(format!("pdftotext stdin write failed: {}", e)))?;
    }
    let output = child
        .wait_with_output()
        .map_err(|e| AppError::InternalError(format!("pdftotext wait failed: {}", e)))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::InternalError(format!(
            "pdftotext exited {}: {}",
            output.status,
            stderr.trim()
        )));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn extract_docx(bytes: &[u8]) -> Result<String, AppError> {
    docx_rs::read_docx(bytes)
        .map(|doc| doc.json())
        .map_err(|e| AppError::InternalError(format!("DOCX parse error: {}", e)))
}

fn extract_spreadsheet(bytes: &[u8]) -> Result<String, AppError> {
    use calamine::{Reader, open_workbook_auto_from_rs};
    let mut workbook = open_workbook_auto_from_rs(std::io::Cursor::new(bytes.to_vec()))
        .map_err(|e| AppError::InternalError(format!("XLSX open error: {}", e)))?;
    let mut result = String::new();
    let sheet_names = workbook.sheet_names().to_vec();
    for name in sheet_names {
        if let Ok(range) = workbook.worksheet_range(&name) {
            result.push_str(&format!("\n## {}\n\n", name));
            for row in range.rows() {
                let cells: Vec<String> = row.iter()
                    .map(|c| c.to_string())
                    .collect();
                result.push_str(&cells.join(" | "));
                result.push('\n');
            }
        }
    }
    Ok(result)
}

// POST /api/v1/files/:project_id/{*path} — 写入文件
// 目标路径取自 body(WriteRequest.path);URL *path 仅占位(="write"),前端 apiClient.writeFile
// 发 body {path, contents}。早期实现误用 URL *path,写到 base/write(body path 被忽略)。
#[derive(Deserialize)]
pub struct WriteRequest {
    pub path: String,
    pub contents: String,
}

pub async fn write_file(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Path((project_id, _)): Path<(i32, String)>,
    Json(payload): Json<WriteRequest>,
) -> Result<impl IntoResponse, AppError> {
    let (_user_id, team_id) = check_project_access(&state, &headers, project_id).await?;
    // write_string → write_bytes 内部创建 project base + 父目录；safe_resolve 在
    // LocalStorage 内部捕获 .. → BadRequest(400)（原显式检查冗余，错误信息由 "Invalid
    // write path" 变为 "Path traversal detected"，均 400，可接受）。
    state.storage.write_string(team_id, project_id, &payload.path, &payload.contents).await?;
    Ok(Json(serde_json::json!({"status": "ok", "path": payload.path})))
}

// DELETE /api/v1/files/:project_id/{*path} — 目标 path 取自 body(DeleteRequest.path),
// URL *path 仅占位(="delete");与 read/write 一致,前端 apiClient.deleteFile 发 body {path}。
#[derive(Deserialize)]
struct DeleteRequest {
    path: String,
}

pub async fn delete_file(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Path((project_id, _)): Path<(i32, String)>,
    Json(payload): Json<DeleteRequest>,
) -> Result<impl IntoResponse, AppError> {
    let (_user_id, team_id, _) = check_project_access_with_role(&state, &headers, project_id, RequiredRole::Admin).await?;
    // remove() 缺失目标 → ResourceNotFound(→404)；权限等其它 IO 错误 → IoError(→500)。
    // 不再前置 metadata 预检查（消除双 stat + 修复权限被掩盖为 404）。
    state.storage.remove(team_id, project_id, &payload.path).await?;
    Ok(Json(serde_json::json!({"status": "deleted"})))
}

#[cfg(test)]
mod tests {
    use super::extract_pdf;

    #[test]
    fn extract_pdf_invalid_bytes_returns_error() {
        // review #1：非 PDF 输入 → pdftotext 非零退出 → 报错而非静默空串。
        // （pdftotext 二进制缺失时 spawn 失败也返 Err，测试同样通过。）
        let res = extract_pdf(b"definitely not a pdf");
        assert!(res.is_err(), "invalid PDF must error, not return empty; got {:?}", res);
    }

    #[test]
    fn extract_pdf_valid_bytes_returns_text() {
        // review #2：pdf 经 stdin 提取的端到端覆盖（防静默回归）。
        // fixture：同仓 crates/llm-wiki-parser/tests/fixtures/sample.pdf（标题含「定价未来」）。
        // 无 pdftotext 或无 fixture 时跳过（不 fail）。
        if std::process::Command::new("pdftotext").arg("-v").output().is_err() {
            eprintln!("skip: pdftotext not on PATH");
            return;
        }
        let pdf_path = format!(
            "{}/../crates/llm-wiki-parser/tests/fixtures/sample.pdf",
            env!("CARGO_MANIFEST_DIR")
        );
        let bytes = match std::fs::read(&pdf_path) {
            Ok(b) => b,
            Err(e) => {
                eprintln!("skip: sample.pdf fixture unavailable: {}", e);
                return;
            }
        };
        let text = extract_pdf(&bytes).expect("valid PDF should extract");
        assert!(
            text.contains("定价未来"),
            "应提取到样本 PDF 标题「定价未来」；got first 40 chars: {}",
            text.chars().take(40).collect::<String>()
        );
    }
}
