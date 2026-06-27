// routes/ingest.rs
// ingest API 端点：入队 + 查进度 + 列历史 + 取消/重试/SSE 流。全部 handler 调子系统 C 的 helper。
// project-scoped 路由通过 .merge() 合入 project_routes()。
// global route 独立挂载在 create_router。

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::sse::{Event, KeepAlive, Sse},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use std::convert::Infallible;
use futures::stream::{self, StreamExt};          // once, chain, filter_map
use tokio_stream::wrappers::BroadcastStream;      // broadcast::Receiver → Stream adapter
use crate::{AppError, AppState};
use crate::middleware::project_guard::{check_project_access, check_project_access_with_role, RequiredRole};
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

/// POST /api/v1/ingest/jobs/:id/cancel
async fn cancel_job(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(job_id): Path<Uuid>,
) -> Result<(StatusCode, Json<serde_json::Value>), AppError> {
    // 鉴权：取 job 的 project_id，校验 Admin
    let project_id: i32 = sqlx::query_scalar("SELECT project_id FROM ingest_jobs WHERE id=$1")
        .bind(job_id).fetch_optional(&state.db).await?
        .ok_or_else(|| AppError::ResourceNotFound("job not found".into()))?;
    let _ = check_project_access_with_role(&state, &headers, project_id, RequiredRole::Admin).await?;
    ingest_queue::request_cancel(&state, job_id).await?;
    Ok((StatusCode::ACCEPTED, Json(serde_json::json!({"status": "cancel_requested"}))))
}

/// POST /api/v1/ingest/jobs/:id/retry
async fn retry_job(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(job_id): Path<Uuid>,
) -> Result<(StatusCode, Json<serde_json::Value>), AppError> {
    let project_id: i32 = sqlx::query_scalar("SELECT project_id FROM ingest_jobs WHERE id=$1")
        .bind(job_id).fetch_optional(&state.db).await?
        .ok_or_else(|| AppError::ResourceNotFound("job not found".into()))?;
    let _ = check_project_access_with_role(&state, &headers, project_id, RequiredRole::Admin).await?;
    ingest_queue::manual_retry(&state, job_id).await?;
    Ok((StatusCode::OK, Json(serde_json::json!({"status": "re_enqueued"}))))
}

/// GET /api/v1/ingest/jobs/:id/stream
async fn stream_job(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(job_id): Path<Uuid>,
) -> Result<Sse<impl futures::Stream<Item = Result<Event, Infallible>>>, AppError> {
    // 鉴权（读权限）
    let project_id: i32 = sqlx::query_scalar("SELECT project_id FROM ingest_jobs WHERE id=$1")
        .bind(job_id).fetch_optional(&state.db).await?
        .ok_or_else(|| AppError::ResourceNotFound("job not found".into()))?;
    let _ = check_project_access(&state, &headers, project_id).await?;

    // ⚠️ 先订阅 broadcast，再取 PG 快照——避免快任务在「快照-订阅」窗口期发出的终态事件
    //    （含快速 job_succeeded/job_failed）无接收端而被丢。订阅之后的增量由 incr 捕获；
    //    快照提供初值（可能略滞后），事件追平，重复幂等。
    let rx = state.job_events.subscribe();

    // 首帧：当前 PG 快照
    let snapshot = ingest_queue::job_status(&state, job_id).await?;
    let first = stream::once(async move {
        Ok::<_, Infallible>(
            Event::default().event("job_status").json_data(&snapshot).unwrap_or_else(|_| Event::default())
        )
    });

    // 增量：过滤本 job_id（BroadcastStream 包装 broadcast::Receiver）
    let incr = BroadcastStream::new(rx).filter_map(move |res| async move {
        let evt = match res {
            Ok(e) => e,
            Err(_) => return None, // BroadcastStreamRecvError（lagged）→ 跳过
        };
        if evt.job_id == job_id {
            Some(Ok(Event::default().event(evt.kind).json_data(&evt).unwrap_or_else(|_| Event::default())))
        } else {
            None
        }
    });

    let stream = first.chain(incr);
    Ok(Sse::new(stream).keep_alive(KeepAlive::default().interval(std::time::Duration::from_secs(15))))
}

// ── Routers ──

/// project-scoped：通过 .merge() 合入 project_routes()。
/// 路径参数语法用 :id（matchit 0.7.3，与 pages.rs / files.rs 一致）。
pub fn ingest_routes() -> Router<AppState> {
    Router::new()
        .route("/:id/ingest",      axum::routing::post(create_ingest_job))
        .route("/:id/ingest/jobs", axum::routing::get(list_ingest_jobs))
}

/// global：job-id-scoped 路由，独立挂载到 create_router。
/// 路径参数语法用 :id（matchit 0.7.3）。
pub fn global_ingest_routes() -> Router<AppState> {
    Router::new()
        .route("/api/v1/ingest/jobs/:id",        axum::routing::get(get_job_status))
        .route("/api/v1/ingest/jobs/:id/cancel", axum::routing::post(cancel_job))
        .route("/api/v1/ingest/jobs/:id/retry",  axum::routing::post(retry_job))
        .route("/api/v1/ingest/jobs/:id/stream", axum::routing::get(stream_job))
}
