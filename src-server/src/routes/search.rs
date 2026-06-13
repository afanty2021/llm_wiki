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
    let limit = params.limit.unwrap_or(20).min(100);

    let results = crate::services::search::search_wiki(
        &state.db,
        params.project_id,
        &params.query,
        limit,
    )
    .await?;

    Ok(Json(serde_json::json!({
        "results": results,
        "query": params.query,
        "total": results.len(),
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

    let llm_cfg = crate::services::llm::get_llm_config(&state.db, params.project_id).await?;

    let embedding = crate::services::embedding::get_embeddings(&params.query, &llm_cfg).await?;

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
