// src/routes/research.rs — research 端点（project-scoped 入队/列表 + 全局详情/SSE）。
use crate::middleware::project_guard::check_project_access;
use crate::services::research::{self, EnqueueBody, ResearchTask};
use crate::{AppError, AppState};
use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::Json;
use futures::stream::Stream;
use serde::Deserialize;
use std::convert::Infallible;
use std::time::Duration;
use uuid::Uuid;

pub fn research_project_routes() -> axum::Router<AppState> {
    axum::Router::new()
        .route("/:id/research", axum::routing::post(enqueue_research))
        .route("/:id/research/tasks", axum::routing::get(list_tasks))
}

pub fn global_research_routes() -> axum::Router<AppState> {
    axum::Router::new()
        .route("/api/v1/research/tasks/:uuid", axum::routing::get(get_task))
        .route(
            "/api/v1/research/tasks/:uuid/stream",
            axum::routing::get(stream_task),
        )
}

#[derive(Deserialize)]
pub struct ListQuery {
    pub status: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

async fn has_search_provider(state: &AppState, project_id: i32) -> bool {
    let n: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM search_providers sp JOIN projects p ON sp.team_id = p.team_id \
         WHERE p.id=$1 AND sp.is_enabled=TRUE",
    )
    .bind(project_id)
    .fetch_one(&state.db)
    .await
    .unwrap_or(0);
    n > 0
}

pub async fn enqueue_research(
    State(state): State<AppState>,
    Path(project_id): Path<i32>,
    headers: HeaderMap,
    Json(body): Json<EnqueueBody>,
) -> Result<Json<serde_json::Value>, AppError> {
    let (user_id, _) = check_project_access(&state, &headers, project_id).await?;
    let topic = body.topic.trim();
    if topic.is_empty() {
        return Err(AppError::ValidationError("topic required".into()));
    }
    if !has_search_provider(&state, project_id).await {
        return Err(AppError::BadRequest(
            "no enabled search_provider for project".into(),
        ));
    }
    let uuid = research::enqueue_research_task(
        &state,
        project_id,
        Some(user_id),
        topic,
        body.search_queries,
        "manual",
    )
    .await?;
    Ok(Json(serde_json::json!({"uuid": uuid})))
}

pub async fn list_tasks(
    State(state): State<AppState>,
    Path(project_id): Path<i32>,
    Query(q): Query<ListQuery>,
    headers: HeaderMap,
) -> Result<Json<Vec<ResearchTask>>, AppError> {
    check_project_access(&state, &headers, project_id).await?;
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    let offset = q.offset.unwrap_or(0).max(0);
    let rows: Vec<ResearchTask> = match q.status.as_deref() {
        Some(s) => sqlx::query_as(
            "SELECT * FROM research_tasks WHERE project_id=$1 AND status=$2 \
             ORDER BY created_at DESC LIMIT $3 OFFSET $4",
        )
        .bind(project_id)
        .bind(s)
        .bind(limit)
        .bind(offset),
        None => sqlx::query_as(
            "SELECT * FROM research_tasks WHERE project_id=$1 \
             ORDER BY created_at DESC LIMIT $2 OFFSET $3",
        )
        .bind(project_id)
        .bind(limit)
        .bind(offset),
    }
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

pub async fn get_task(
    State(state): State<AppState>,
    Path(uuid): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Json<ResearchTask>, AppError> {
    let row: ResearchTask = sqlx::query_as("SELECT * FROM research_tasks WHERE id=$1")
        .bind(uuid)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| AppError::ResourceNotFound("research task".into()))?;
    check_project_access(&state, &headers, row.project_id).await?;
    Ok(Json(row))
}

fn sse_data(event: &'static str, data: &serde_json::Value) -> Result<Event, Infallible> {
    Ok(Event::default()
        .event(event)
        .data(data.to_string()))
}
#[allow(clippy::type_complexity)] // SSE 轮询返回类型复杂(Box<dyn Stream>),axum SSE 固有
pub async fn stream_task(
    State(state): State<AppState>,
    Path(uuid): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Sse<std::pin::Pin<Box<dyn Stream<Item = Result<Event, Infallible>> + Send>>>, AppError>
{
    let init: ResearchTask = sqlx::query_as("SELECT * FROM research_tasks WHERE id=$1")
        .bind(uuid)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| AppError::ResourceNotFound("research task".into()))?;
    check_project_access(&state, &headers, init.project_id).await?;
    let db = state.db.clone();
    let stream: std::pin::Pin<Box<dyn Stream<Item = Result<Event, Infallible>> + Send>> =
        Box::pin(async_stream::stream! {
            let mut last_stage: Option<String> = None;
            for _ in 0..200 {
                let row: Option<(
                    String,
                    Option<String>,
                    Option<String>,
                    Option<String>,
                    Option<String>,
                )> = sqlx::query_as(
                    "SELECT status, stage, synthesis, saved_path, error FROM research_tasks WHERE id=$1",
                )
                .bind(uuid)
                .fetch_optional(&db)
                .await
                .ok()
                .flatten();
                match row {
                    Some((status, stage, synth, path, err)) => {
                        let cur_stage = stage.clone().unwrap_or_else(|| status.clone());
                        if last_stage.as_deref() != Some(&cur_stage) {
                            last_stage = Some(cur_stage.clone());
                            yield sse_data(
                                "stage",
                                &serde_json::json!({"stage": cur_stage, "status": status}),
                            );
                        }
                        if status == "done" {
                            yield sse_data(
                                "done",
                                &serde_json::json!({"synthesis": synth, "savedPath": path}),
                            );
                            return;
                        }
                        if status == "error" {
                            yield sse_data(
                                "error",
                                &serde_json::json!({"message": err.unwrap_or_default()}),
                            );
                            return;
                        }
                    }
                    None => {
                        yield sse_data(
                            "error",
                            &serde_json::json!({"message": "task vanished"}),
                        );
                        return;
                    }
                }
                tokio::time::sleep(Duration::from_millis(1500)).await;
            }
            yield sse_data("error", &serde_json::json!({"message": "timeout"}));
        });
    Ok(Sse::new(stream)
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(15)).text("ping")))
}
