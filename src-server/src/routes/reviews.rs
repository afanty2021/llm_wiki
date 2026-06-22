//! Layer 3 Phase B — review queue routes (project-scoped, team-shared).

use axum::{
    extract::{Path, Query, State},
    http::HeaderMap,
    Json,
};
use serde::{Deserialize, Serialize};

use crate::services::review::{self, ResolveAction, ResolveOutcome, ReviewOption};
use crate::{AppState, AppError};
use crate::middleware::project_guard::check_project_access;

#[derive(Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum StatusFilter {
    #[default]
    Open,
    Resolved,
    Dismissed,
    All,
}

#[derive(Deserialize)]
pub struct ListQuery {
    pub status: Option<StatusFilter>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewItemResp {
    pub id: i64,
    pub uuid: uuid::Uuid,
    pub project_id: i32,
    pub source_path: Option<String>,
    pub review_type: String,
    pub title: String,
    pub description: String,
    pub affected_pages: Option<Vec<String>>,
    pub search_queries: Option<Vec<String>>,
    pub options: Vec<ReviewOption>,
    pub status: String,
    pub resolved_action: Option<String>,
    pub resolved_by: Option<i32>,
    pub resolved_at: Option<chrono::DateTime<chrono::Utc>>,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

#[derive(sqlx::FromRow)]
struct ReviewItemRow {
    id: i64,
    uuid: uuid::Uuid,
    project_id: i32,
    source_path: Option<String>,
    review_type: String,
    title: String,
    description: String,
    affected_pages: Option<Vec<String>>,
    search_queries: Option<Vec<String>>,
    options: serde_json::Value,
    status: String,
    resolved_action: Option<String>,
    resolved_by: Option<i32>,
    resolved_at: Option<chrono::DateTime<chrono::Utc>>,
    created_at: chrono::DateTime<chrono::Utc>,
}

pub fn reviews_routes() -> axum::Router<AppState> {
    axum::Router::new()
        .route("/:id/reviews", axum::routing::get(list_reviews))
        .route("/:id/reviews/:iid/resolve", axum::routing::post(resolve_review))
        .route("/:id/reviews/:iid/dismiss", axum::routing::post(dismiss_review))
}

pub async fn list_reviews(
    State(state): State<AppState>,
    Path(project_id): Path<i32>,
    Query(q): Query<ListQuery>,
    headers: HeaderMap,
) -> Result<Json<Vec<ReviewItemResp>>, AppError> {
    check_project_access(&state, &headers, project_id).await?;
    let filter = q.status.unwrap_or_default();
    let rows: Vec<ReviewItemRow> = match filter {
        StatusFilter::All => sqlx::query_as::<_, ReviewItemRow>(
            "SELECT id, uuid, project_id, source_path, review_type, title, description, \
                    affected_pages, search_queries, options, status, resolved_action, resolved_by, resolved_at, created_at \
             FROM review_items WHERE project_id=$1 ORDER BY created_at DESC",
        ),
        StatusFilter::Resolved => sqlx::query_as::<_, ReviewItemRow>(
            "SELECT id, uuid, project_id, source_path, review_type, title, description, \
                    affected_pages, search_queries, options, status, resolved_action, resolved_by, resolved_at, created_at \
             FROM review_items WHERE project_id=$1 AND status='resolved' ORDER BY created_at DESC",
        ),
        StatusFilter::Dismissed => sqlx::query_as::<_, ReviewItemRow>(
            "SELECT id, uuid, project_id, source_path, review_type, title, description, \
                    affected_pages, search_queries, options, status, resolved_action, resolved_by, resolved_at, created_at \
             FROM review_items WHERE project_id=$1 AND status='dismissed' ORDER BY created_at DESC",
        ),
        StatusFilter::Open => sqlx::query_as::<_, ReviewItemRow>(
            "SELECT id, uuid, project_id, source_path, review_type, title, description, \
                    affected_pages, search_queries, options, status, resolved_action, resolved_by, resolved_at, created_at \
             FROM review_items WHERE project_id=$1 AND status='open' ORDER BY created_at DESC",
        ),
    }
    .bind(project_id)
    .fetch_all(&state.db)
    .await?;

    let out: Vec<ReviewItemResp> = rows
        .into_iter()
        .map(|r| ReviewItemResp {
            options: serde_json::from_value::<Vec<ReviewOption>>(r.options).unwrap_or_default(),
            id: r.id,
            uuid: r.uuid,
            project_id: r.project_id,
            source_path: r.source_path,
            review_type: r.review_type,
            title: r.title,
            description: r.description,
            affected_pages: r.affected_pages,
            search_queries: r.search_queries,
            status: r.status,
            resolved_action: r.resolved_action,
            resolved_by: r.resolved_by,
            resolved_at: r.resolved_at,
            created_at: r.created_at,
        })
        .collect();
    Ok(Json(out))
}

pub async fn resolve_review(
    State(state): State<AppState>,
    Path((project_id, item_id)): Path<(i32, i64)>,
    headers: HeaderMap,
    Json(body): Json<ResolveAction>,
) -> Result<Json<ResolveOutcome>, AppError> {
    let (user_id, _) = check_project_access(&state, &headers, project_id).await?;
    let outcome = review::resolve_review_item(&state, project_id, user_id, item_id, body).await?;
    Ok(Json(outcome))
}

pub async fn dismiss_review(
    State(state): State<AppState>,
    Path((project_id, item_id)): Path<(i32, i64)>,
    headers: HeaderMap,
) -> Result<axum::http::StatusCode, AppError> {
    let (user_id, _) = check_project_access(&state, &headers, project_id).await?;
    let n = sqlx::query(
        "UPDATE review_items SET status='dismissed', resolved_by=$1, resolved_at=NOW() \
         WHERE id=$2 AND project_id=$3 AND status='open'",
    )
    .bind(user_id)
    .bind(item_id)
    .bind(project_id)
    .execute(&state.db)
    .await?;
    if n.rows_affected() == 0 {
        return Err(AppError::Conflict("review item not open".into()));
    }
    Ok(axum::http::StatusCode::OK)
}
