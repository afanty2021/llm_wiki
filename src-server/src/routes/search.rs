use axum::{
    extract::{Query, State},
    Json,
};
use serde::Deserialize;
use crate::{AppState, AppError};
use crate::middleware::project_guard::check_project_access;
use crate::services::search::{self, SearchResponse, DEFAULT_RESULTS, MAX_RESULTS};

#[derive(Deserialize)]
pub struct SearchQueryParams {
    pub project_id: i32,
    pub query: String,
    pub limit: Option<usize>,
}

pub fn search_routes() -> axum::Router<AppState> {
    axum::Router::new().route("/", axum::routing::get(search_handler))
}

/// GET /api/v1/search?project_id=&query=&limit=  → 统一 hybrid 搜索（自动 keyword/vector/hybrid）
pub async fn search_handler(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Query(params): Query<SearchQueryParams>,
) -> Result<Json<SearchResponse>, AppError> {
    check_project_access(&state, &headers, params.project_id).await?;
    if params.query.trim().is_empty() {
        return Err(AppError::ValidationError("query is required".into()));
    }
    let limit = params.limit.unwrap_or(DEFAULT_RESULTS).min(MAX_RESULTS);
    // 解析 LLM provider；失败 → None（hybrid_search 走 RRF fallback，不阻断）
    let provider_box = crate::services::llm_stream::provider_for_project(&state, params.project_id)
        .await
        .ok();
    let provider_ref: Option<&dyn crate::services::llm_stream::StreamChatProvider> =
        provider_box.as_deref();
    let resp = search::hybrid_search(
        &state.db,
        &*state.vector_store,
        &state.config.search,
        state.config.embedding.as_ref(),
        &state.http,
        params.project_id,
        &params.query,
        limit,
        provider_ref,
    )
    .await?;
    Ok(Json(resp))
}
