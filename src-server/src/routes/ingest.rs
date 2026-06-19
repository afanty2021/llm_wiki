// routes/ingest.rs
// ingest API 端点：入队 + 查进度 + 列历史。全部 handler 调子系统 C 的 helper。
// project-scoped 路由通过 .merge() 合入 project_routes()。
// global route 独立挂载在 create_router。

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use crate::{AppError, AppState};
use crate::middleware::project_guard::check_project_access;
use crate::services::ingest_queue;

// ── Request DTO / Response struct ──

#[derive(Debug, Deserialize)]
pub struct CreateIngestRequest {
    pub source_paths: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct ListIngestJobsQuery {
    pub status: Option<String>,
    pub limit: Option<i64>,
}

#[derive(Debug, Serialize)]
struct ListJobsResponse {
    items: Vec<ingest_queue::JobResponse>,
    count: usize,
}

// ── Handlers ──

/// POST /api/v1/projects/:id/ingest
async fn create_ingest_job(
    State(state): State<AppState>,
    Path(project_id): Path<i32>,
    headers: HeaderMap,
    Json(req): Json<CreateIngestRequest>,
) -> Result<(StatusCode, Json<serde_json::Value>), AppError> {
    let (user_id, _team_id) = check_project_access(&state, &headers, project_id).await?;
    let job_id = ingest_queue::enqueue(&state, project_id, user_id, req.source_paths).await?;
    Ok((
        StatusCode::CREATED,
        Json(serde_json::json!({"job_id": job_id.to_string(), "status": "pending"})),
    ))
}

/// GET /api/v1/projects/:id/ingest/jobs
async fn list_ingest_jobs(
    State(state): State<AppState>,
    Path(project_id): Path<i32>,
    Query(q): Query<ListIngestJobsQuery>,
    headers: HeaderMap,
) -> Result<Json<ListJobsResponse>, AppError> {
    check_project_access(&state, &headers, project_id).await?;
    let items = ingest_queue::list_jobs(&state, project_id, q.status.as_deref(), q.limit).await?;
    let count = items.len();
    Ok(Json(ListJobsResponse { items, count }))
}

/// GET /api/v1/ingest/jobs/:id（不绑 project，按 job_id UUID 查）
async fn get_job_status(
    State(state): State<AppState>,
    Path(job_id): Path<Uuid>,
) -> Result<Json<ingest_queue::JobResponse>, AppError> {
    let job = ingest_queue::job_status(&state, job_id).await?;
    Ok(Json(job))
}

// ── Routers ──

/// project-scoped：通过 .merge() 合入 project_routes()。
/// 路径参数语法用 :id（matchit 0.7.3，与 pages.rs / files.rs 一致）。
pub fn ingest_routes() -> Router<AppState> {
    Router::new()
        .route("/:id/ingest",      axum::routing::post(create_ingest_job))
        .route("/:id/ingest/jobs", axum::routing::get(list_ingest_jobs))
}

/// global：GET /api/v1/ingest/jobs/:id。独立挂载到 create_router。
pub fn global_ingest_routes() -> Router<AppState> {
    Router::new()
        .route("/api/v1/ingest/jobs/:id", axum::routing::get(get_job_status))
}
