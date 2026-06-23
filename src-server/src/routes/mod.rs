mod health;
mod auth;
mod users;
mod teams;
mod projects;
mod files;
mod search;
mod chat;
mod graph;
mod pages;
mod ingest;
mod llm_providers;
mod search_providers;
pub mod chat_sessions;
pub mod reviews;
pub mod research;

pub use pages::WikiPage;

use axum::{Router, routing::get};
use tower_http::services::{ServeDir, ServeFile};
use crate::AppState;

pub fn create_router(state: AppState) -> Router {
    // Layer 5：ServeDir 同源托管前端 dist（SPA history mode fallback）。
    // API 路由在 Router::new() 内显式声明，优先于 fallback_service。
    let dist_dir = state.config.dist_dir().to_string();
    let index_html = state.config.index_html().to_string();
    let spa = ServeDir::new(&dist_dir).fallback(ServeFile::new(&index_html));

    Router::new()
        .route("/health", get(health::health_check))
        .nest("/api/v1/auth", auth::auth_routes())
        .nest("/api/v1/users", users::user_routes())
        .nest("/api/v1/teams", teams::team_routes())
        .nest("/api/v1/projects", projects::project_routes())
        .nest("/api/v1/files", files::file_routes())
        .nest("/api/v1/search", search::search_routes())
        .nest("/api/v1/chat", chat::chat_routes())
        .nest("/api/v1/graph", graph::graph_routes())
        .merge(ingest::global_ingest_routes())
        .merge(research::global_research_routes())
        .merge(llm_providers::llm_provider_routes())
        .merge(search_providers::search_provider_routes())
        .fallback_service(spa)
        .with_state(state)
}
