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
    let graph = crate::services::graph::build_graph(&state.db, project_id).await?;
    let surprising = crate::services::graph::find_surprising_connections(&graph, 5);
    let gaps = crate::services::graph::detect_knowledge_gaps(&graph, 8);
    Ok(Json(serde_json::json!({
        "surprisingConnections": surprising,
        "knowledgeGaps": gaps,
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
