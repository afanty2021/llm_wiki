use axum::{
    extract::{Path, State},
    Json,
    response::IntoResponse,
};
use crate::{AppState, AppError};
use crate::middleware::project_guard::check_project_access;

pub fn graph_routes() -> axum::Router<AppState> {
    axum::Router::new()
        .route("/:project_id", axum::routing::get(get_graph))
        .route("/:project_id/insights", axum::routing::get(get_insights))
}

pub async fn get_graph(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(project_id): Path<i32>,
) -> Result<impl IntoResponse, AppError> {
    let (_user_id, _team_id) = check_project_access(&state, &headers, project_id).await?;
    // TRANSIENT STUB: build_graph 在 2c Task5 重建（真 Louvain + relevance 边权）。
    // 期间 /graph 返回空；Task5 恢复 crate::services::graph::build_graph 调用。
    Ok(Json(serde_json::json!({ "nodes": [], "edges": [], "communities": [] })))
}

pub async fn get_insights(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(project_id): Path<i32>,
) -> Result<impl IntoResponse, AppError> {
    let (_user_id, _team_id) = check_project_access(&state, &headers, project_id).await?;
    // TRANSIENT STUB：build_graph 在 Task5 重建，insights 在 2d 重写。期间返回空 stats。
    Ok(Json(serde_json::json!({ "node_count": 0, "edge_count": 0, "density": 0.0, "communities": [] })))
}
