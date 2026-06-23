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
use std::path::PathBuf;

const MAX_UPLOAD_SIZE: usize = 100 * 1024 * 1024; // 100MB

#[derive(Serialize)]
struct FileNode {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
    modified: i64,
}

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
    let base = storage::project_base(&state.config.storage_path(), team_id, project_id);

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

    // safe_resolve 防止路径遍历
    let dest = storage::safe_resolve(&base, &format!("{}/{}", dest_subdir, file_name))?;
    if let Some(parent) = dest.parent() {
        storage::ensure_dir(parent)?;
    }
    std::fs::write(&dest, &file_data).map_err(|e| AppError::IoError(e))?;

    Ok((StatusCode::CREATED, Json(serde_json::json!({
        "name": file_name,
        "path": dest.strip_prefix(&base).unwrap_or(&dest).to_string_lossy(),
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
    let base = storage::project_base(&state.config.storage_path(), team_id, project_id);
    let dir_path = if let Some(dir) = params.dir {
        if dir.is_empty() {
            base.clone()
        } else {
            storage::safe_resolve(&base, &dir)?
        }
    } else {
        base.clone()
    };

    if !dir_path.exists() {
        // GET 不应产生副作用 — 返回空列表而非自动创建目录
        return Ok(Json(serde_json::json!([])));
    }

    let mut nodes: Vec<FileNode> = Vec::new();
    for entry in std::fs::read_dir(&dir_path).map_err(|e| AppError::IoError(e))? {
        let entry = entry.map_err(|e| AppError::IoError(e))?;
        let meta = entry.metadata().map_err(|e| AppError::IoError(e))?;
        nodes.push(FileNode {
            name: entry.file_name().to_string_lossy().to_string(),
            path: entry.path().strip_prefix(&base)
                .unwrap_or(&entry.path())
                .to_string_lossy()
                .to_string(),
            is_dir: meta.is_dir(),
            size: meta.len(),
            modified: meta.modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0),
        });
    }

    Ok(Json(serde_json::json!(nodes)))
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
    let base = storage::project_base(state.config.storage_path(), team_id, project_id);

    // 项目存储根尚不存在（全新项目未写入过任何文件）→ 目标必然不存在。
    // 直接返回 exists=false，避免 safe_resolve 对不存在的 base canonicalize 导致 500。
    if !base.exists() {
        return Ok(Json(serde_json::json!(StatResp {
            exists: false,
            is_dir: false,
            size: 0,
            modified: 0,
        })));
    }

    let file_path = storage::safe_resolve(&base, &path)?;

    let resp = match std::fs::metadata(&file_path) {
        Ok(meta) => StatResp {
            exists: true,
            is_dir: meta.is_dir(),
            size: meta.len(),
            modified: meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0),
        },
        Err(_) => StatResp {
            exists: false,
            is_dir: false,
            size: 0,
            modified: 0,
        },
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
    let base = storage::project_base(state.config.storage_path(), team_id, project_id);
    // 全新项目 storage base 尚不存在 → 目标必然不存在,直接 404(避免 safe_resolve 对
    // 不存在 base canonicalize 导致 500,与 stat_file 同款短路)。
    if !base.exists() {
        return Err(AppError::ResourceNotFound("file".into()));
    }
    let full = storage::safe_resolve(&base, &path)?;
    let bytes = tokio::fs::read(&full)
        .await
        .map_err(|_| AppError::ResourceNotFound("file".into()))?;
    let mime = mime_guess::from_path(&full)
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

// GET /api/v1/files/:project_id/{*path}
pub async fn read_file(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Path((project_id, path)): Path<(i32, String)>,
) -> Result<impl IntoResponse, AppError> {
    let (_user_id, team_id) = check_project_access(&state, &headers, project_id).await?;
    let base = storage::project_base(&state.config.storage_path(), team_id, project_id);
    let file_path = storage::safe_resolve(&base, &path)?;

    if !file_path.exists() {
        return Err(AppError::ResourceNotFound("File not found".into()));
    }
    if !file_path.is_file() {
        return Err(AppError::BadRequest("Path is a directory".into()));
    }

    let ext = storage::file_ext(&file_path).to_lowercase();
    let content = match ext.as_str() {
        "pdf" => extract_pdf(&file_path)?,
        "docx" => extract_docx(&file_path)?,
        "xlsx" | "xls" | "ods" => extract_spreadsheet(&file_path)?,
        _ => std::fs::read_to_string(&file_path)
            .map_err(|e| AppError::IoError(e))?,
    };

    Ok(Json(serde_json::json!({
        "path": path,
        "content": content,
        "extension": ext,
    })))
}

fn extract_pdf(path: &PathBuf) -> Result<String, AppError> {
    // 依赖外部 pdftotext 工具（Dockerfile 需安装 poppler-utils）
    use std::process::Command;
    let output = Command::new("pdftotext")
        .arg("-layout")
        .arg(path)
        .arg("-")
        .output()
        .map_err(|_| AppError::InternalError(
            "pdftotext not available. Install poppler-utils in Dockerfile.".into()
        ))?;
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn extract_docx(path: &PathBuf) -> Result<String, AppError> {
    let bytes = std::fs::read(path).map_err(|e| AppError::IoError(e))?;
    docx_rs::read_docx(&bytes)
        .map(|doc| doc.json())
        .map_err(|e| AppError::InternalError(format!("DOCX parse error: {}", e)))
}

fn extract_spreadsheet(path: &PathBuf) -> Result<String, AppError> {
    use calamine::{open_workbook, Reader};
    let mut workbook = open_workbook::<calamine::Xlsx<_>, _>(path)
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
#[derive(Deserialize)]
pub struct WriteRequest {
    pub contents: String,
}

pub async fn write_file(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Path((project_id, path)): Path<(i32, String)>,
    Json(payload): Json<WriteRequest>,
) -> Result<impl IntoResponse, AppError> {
    let (_user_id, team_id) = check_project_access(&state, &headers, project_id).await?;
    let base = storage::project_base(&state.config.storage_path(), team_id, project_id);
    let file_path = storage::safe_resolve(&base, &path)?;

    if let Some(parent) = file_path.parent() {
        storage::ensure_dir(parent)?;
    }
    std::fs::write(&file_path, &payload.contents)
        .map_err(|e| AppError::IoError(e))?;

    Ok(Json(serde_json::json!({"status": "ok"})))
}

// DELETE /api/v1/files/:project_id/{*path}
pub async fn delete_file(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Path((project_id, path)): Path<(i32, String)>,
) -> Result<impl IntoResponse, AppError> {
    let (_user_id, team_id, _) = check_project_access_with_role(&state, &headers, project_id, RequiredRole::Admin).await?;
    let base = storage::project_base(&state.config.storage_path(), team_id, project_id);
    let file_path = storage::safe_resolve(&base, &path)?;

    if !file_path.exists() {
        return Err(AppError::ResourceNotFound("File not found".into()));
    }

    if file_path.is_dir() {
        std::fs::remove_dir_all(&file_path).map_err(|e| AppError::IoError(e))?;
    } else {
        std::fs::remove_file(&file_path).map_err(|e| AppError::IoError(e))?;
    }

    Ok(Json(serde_json::json!({"status": "deleted"})))
}
