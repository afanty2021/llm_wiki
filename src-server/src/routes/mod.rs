mod health;
mod auth;

use axum::{Router, routing::get};
use crate::AppState;

pub fn create_router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health::health_check))
        .nest("/api/v1/auth", auth::auth_routes())
        .with_state(state)
}
