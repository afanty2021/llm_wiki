mod health;
mod auth;
mod users;

use axum::{Router, routing::get};
use crate::AppState;

pub fn create_router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health::health_check))
        .nest("/api/v1/auth", auth::auth_routes())
        .nest("/api/v1/users", users::user_routes())
        .with_state(state)
}
