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
        .route("/:project_id/related", axum::routing::get(get_related))
}

pub async fn get_graph(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(project_id): Path<i32>,
) -> Result<impl IntoResponse, AppError> {
    let (_user_id, _team_id) = check_project_access(&state, &headers, project_id).await?;
    let graph_data = crate::services::graph::build_graph(&state.db, project_id).await?;
    Ok(Json(graph_data))
}

pub async fn get_insights(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(project_id): Path<i32>,
) -> Result<impl IntoResponse, AppError> {
    let (_user_id, _team_id) = check_project_access(&state, &headers, project_id).await?;
    let graph_data = crate::services::graph::build_graph(&state.db, project_id).await?;
    Ok(Json(serde_json::json!({
        "node_count": graph_data.nodes.len(),
        "edge_count": graph_data.edges.len(),
        "density": if graph_data.nodes.len() > 1 {
            let max_edges = graph_data.nodes.len() * (graph_data.nodes.len() - 1) / 2;
            graph_data.edges.len() as f64 / max_edges as f64
        } else { 0.0 },
        "communities": graph_data.communities,
    })))
}

#[derive(serde::Deserialize)]
pub struct RelatedQuery {
    pub path: String,
    pub limit: Option<usize>,
}

pub async fn get_related(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(project_id): Path<i32>,
    axum::extract::Query(q): axum::extract::Query<RelatedQuery>,
) -> Result<Json<Vec<crate::services::graph::RelatedNode>>, AppError> {
    let (_user_id, _team_id) = check_project_access(&state, &headers, project_id).await?;
    let g = crate::services::graph::build_graph(&state.db, project_id).await?;
    if !g.nodes.iter().any(|n| n.id == q.path) {
        return Err(AppError::ResourceNotFound("page not in graph".into()));
    }
    let limit = q.limit.unwrap_or(10).min(50);
    Ok(Json(crate::services::graph::related_nodes(&g, &q.path, limit)))
}
