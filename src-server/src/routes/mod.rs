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

pub use pages::WikiPage;

use axum::{Router, routing::get};
use crate::AppState;

pub fn create_router(state: AppState) -> Router {
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
        .with_state(state)
}
