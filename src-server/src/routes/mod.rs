// Routes will be implemented in Task 1.5

use axum::Router;
use crate::AppState;

pub fn create_router(state: AppState) -> Router {
    Router::new()
        .route("/", axum::routing::get(|| async { "Hello, World!" }))
        .with_state(state)
}
