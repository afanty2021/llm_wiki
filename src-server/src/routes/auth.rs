use axum::Router;
use crate::AppState;

pub fn auth_routes() -> Router<AppState> {
    Router::new()
        // 路由将在后续任务中实现
}
