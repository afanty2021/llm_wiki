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
    /// 显式关 LLM 精排（`rerank=false`）→ 直接 RRF 序。延迟敏感调用方
    /// （教师 MCP llm_wiki_search，每回合 3-5 次 × ~6s LLM 往返）用；
    /// 不带时行为不变（web UI / deep research 保持精排）。
    pub rerank: Option<bool>,
}

pub fn search_routes() -> axum::Router<AppState> {
    axum::Router::new().route("/", axum::routing::get(search_handler))
}

/// GET /api/v1/search?project_id=&query=&limit=&rerank=  → 统一 hybrid 搜索（自动 keyword/vector/hybrid）
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
    // 解析 LLM provider；失败 → None（hybrid_search 走 RRF fallback，不阻断）。
    // rerank=false 的显式 opt-out 同样置 None——下游 `if let Some(provider)`
    // 天然跳过精排，复用既有 fallback 路径（亚秒级）。
    // debug 日志区分三种 None：显式 opt-out / provider 解析失败 / 未配置（评审 M2）。
    let provider_box = if params.rerank == Some(false) {
        tracing::debug!("search rerank skipped: explicit opt-out (rerank=false), project={}", params.project_id);
        None
    } else {
        crate::services::llm_stream::provider_for_project(&state, params.project_id)
            .await
            .map_err(|e| {
                tracing::debug!("search rerank skipped: provider resolution failed, project={}: {}", params.project_id, e);
                e
            })
            .ok()
    };
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
