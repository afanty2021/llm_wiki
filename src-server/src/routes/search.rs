use axum::{
    extract::{Query, State},
    Json,
    response::IntoResponse,
};
use serde::Deserialize;
use crate::{AppState, AppError};
use crate::middleware::project_guard::check_project_access;

#[derive(Deserialize)]
pub struct SearchQueryParams {
    pub project_id: i32,
    pub query: String,
    pub limit: Option<i32>,
}

pub fn search_routes() -> axum::Router<AppState> {
    axum::Router::new()
        .route("/", axum::routing::get(search_handler))
        .route("/vector", axum::routing::get(vector_search_handler))
}

/// GET /api/v1/search?project_id=<id>&query=<q>[&limit=<n>]
pub async fn search_handler(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Query(params): Query<SearchQueryParams>,
) -> Result<impl IntoResponse, AppError> {
    let _user_id = check_project_access(&state, &headers, params.project_id).await?.0;
    // TRANSIENT STUB: search_wiki 已移除（2b 重写 services/search.rs）。
    // hybrid_search 在 Task 7 实现、Task 8 把此 stub 替换为 search::hybrid_search 调用。
    // 期间 /search 返回空结果（不重启 server，无影响）。
    Ok(Json(serde_json::json!({
        "results": [],
        "query": params.query,
        "total": 0,
    })))
}

/// GET /api/v1/search/vector?project_id=<id>&query=<q>[&limit=<n>]
pub async fn vector_search_handler(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Query(params): Query<SearchQueryParams>,
) -> Result<impl IntoResponse, AppError> {
    let _user_id = check_project_access(&state, &headers, params.project_id).await?.0;
    let limit = params.limit.unwrap_or(10).min(50);

    let emb_cfg = state.config.embedding.as_ref().ok_or_else(|| {
        AppError::BadRequest("embedding not configured (vector search disabled)".into())
    })?;
    let embedding = crate::services::embedding::embed_query(emb_cfg, &state.http, &params.query).await?;

    let results = crate::services::embedding::vector_search(
        &state.db,
        params.project_id,
        embedding,
        limit,
    )
    .await?;

    Ok(Json(serde_json::json!({
        "results": results,
        "query": params.query,
        "total": results.len(),
    })))
}
