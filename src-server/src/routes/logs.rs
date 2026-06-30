//! /api/v1/logs —— 日志查看/级别/导出/清除（admin 权限）
//!
//! 同步 fs 操作（read/get/export/clear）用 spawn_blocking 包裹，避免阻塞 tokio
//! worker（代码库惯例见 routes/files.rs:191 对阻塞子进程的处理）。require_admin
//! 在 spawn_blocking 外（JWT verify 是 async）。

use axum::{
    body::Body,
    extract::{Query, State},
    http::{HeaderMap, HeaderName, StatusCode},
    Json,
    response::Response,
    Router,
};
use serde::Deserialize;
use serde_json::json;

use crate::{middleware::require_admin, services::logging, AppError, AppState};

pub fn logs_routes() -> Router<AppState> {
    Router::new()
        .route("/", axum::routing::get(list_logs).delete(clear_logs_handler))
        .route("/files", axum::routing::get(list_log_files))
        .route("/export", axum::routing::get(export_logs_handler))
        .route("/level", axum::routing::get(get_level).put(set_level))
}

#[derive(Deserialize)]
pub struct ListLogsQuery {
    pub limit: Option<usize>,
    pub offset: Option<usize>,
    /// 逗号分隔多级别，如 "ERROR,WARN"
    pub level: Option<String>,
    pub keyword: Option<String>,
    pub trace_id: Option<String>,
}

/// GET /api/v1/logs —— 分页查看（级别/关键字/trace_id 过滤）
pub async fn list_logs(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<ListLogsQuery>,
) -> Result<Json<logging::ReadLogResponse>, AppError> {
    let _claims = require_admin(&state, &headers).await?;
    let log_dir = state.config.log_dir().to_string();
    let level_filter = q
        .level
        .as_ref()
        .map(|s| {
            s.split(',')
                .map(|x| x.trim().to_string())
                .filter(|x| !x.is_empty())
                .collect::<Vec<_>>()
        })
        .filter(|v: &Vec<String>| !v.is_empty());
    let res = tokio::task::spawn_blocking(move || {
        logging::read_log_file(
            log_dir.into(),
            q.limit.unwrap_or(100),
            q.offset.unwrap_or(0),
            level_filter,
            q.keyword,
            q.trace_id,
        )
    })
    .await
    .map_err(|e| AppError::InternalError(format!("read_log_file join error: {}", e)))?
    .map_err(AppError::InternalError)?;
    Ok(Json(res))
}

/// GET /api/v1/logs/files —— 列日志文件
pub async fn list_log_files(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<logging::LogFileEntry>>, AppError> {
    let _claims = require_admin(&state, &headers).await?;
    let log_dir = state.config.log_dir().to_string();
    let files = tokio::task::spawn_blocking(move || logging::get_log_files(log_dir.into()))
        .await
        .map_err(|e| AppError::InternalError(format!("get_log_files join error: {}", e)))?
        .map_err(AppError::InternalError)?;
    Ok(Json(files))
}

#[derive(Deserialize)]
pub struct ExportQuery {
    pub days: Option<u32>,
}

/// GET /api/v1/logs/export?days=N —— 导出 JSONL 文件下载
///
/// export_logs 落盘后读出内容返回，并删除临时导出文件：HTTP 下载无需落盘残留，
/// 且 .jsonl 不被 get_log_files/clear_logs（仅 .log）覆盖，避免在 log_dir 累积。
pub async fn export_logs_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<ExportQuery>,
) -> Result<Response, AppError> {
    let _claims = require_admin(&state, &headers).await?;
    let log_dir = state.config.log_dir().to_string();
    let days = q.days.unwrap_or(7);
    let path = tokio::task::spawn_blocking(move || logging::export_logs(log_dir.into(), days))
        .await
        .map_err(|e| AppError::InternalError(format!("export_logs join error: {}", e)))?
        .map_err(AppError::InternalError)?;
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|e| AppError::InternalError(format!("read export: {}", e)))?;
    // 读后删除（HTTP 下载无需残留，避免 .jsonl 累积且不可清理）
    let _ = tokio::fs::remove_file(&path).await;
    let filename = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("llm-wiki-export.jsonl")
        .to_string();
    let resp = Response::builder()
        .status(StatusCode::OK)
        .header(HeaderName::from_static("content-type"), "application/x-ndjson")
        .header(
            HeaderName::from_static("content-disposition"),
            format!("attachment; filename=\"{}\"", filename),
        )
        .body(Body::from(bytes))
        .map_err(|e| AppError::InternalError(format!("build export response: {}", e)))?;
    Ok(resp)
}

/// DELETE /api/v1/logs —— 清除日志（reopen 重建当前 fd）
pub async fn clear_logs_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, AppError> {
    let _claims = require_admin(&state, &headers).await?;
    let log_dir = state.config.log_dir().to_string();
    tokio::task::spawn_blocking(move || logging::clear_logs(log_dir.into()))
        .await
        .map_err(|e| AppError::InternalError(format!("clear_logs join error: {}", e)))?
        .map_err(AppError::InternalError)?;
    Ok(Json(json!({ "status": "ok" })))
}

/// GET /api/v1/logs/level —— 当前级别（内存，无 fs）
pub async fn get_level(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, AppError> {
    let _claims = require_admin(&state, &headers).await?;
    Ok(Json(json!({ "level": logging::get_log_level() })))
}

#[derive(Deserialize)]
pub struct SetLevelBody {
    pub level: String,
}

/// PUT /api/v1/logs/level —— 设置级别（reload 立即生效，不持久化，无 fs）
pub async fn set_level(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<SetLevelBody>,
) -> Result<Json<serde_json::Value>, AppError> {
    let _claims = require_admin(&state, &headers).await?;
    logging::set_log_level(body.level).map_err(AppError::InternalError)?;
    Ok(Json(json!({ "status": "ok", "level": logging::get_log_level() })))
}
