use axum::{
    extract::Request,
    middleware::Next,
    response::Response,
};
use tracing::info;

/// 日志中间件
/// 记录每个请求的方法、路径和响应状态
pub async fn logging_middleware(
    req: Request,
    next: Next,
) -> Response {
    let method = req.method().clone();
    let uri = req.uri().clone();

    info!(method = %method, uri = %uri, "incoming request");

    let response = next.run(req).await;

    info!(method = %method, uri = %uri, status = ?response.status(), "request completed");

    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::Router;
    use axum::routing::get;
    use tower::util::ServiceExt;

    #[tokio::test]
    async fn test_logging_middleware() {
        // Test that logging middleware doesn't break request flow
        async fn handler() -> &'static str {
            "Hello, World!"
        }

        let app = Router::new()
            .route("/test", get(handler))
            .layer(axum::middleware::from_fn(logging_middleware));

        let response = app
            .oneshot(Request::builder().uri("/test").body(axum::body::Body::empty()).unwrap())
            .await
            .unwrap();

        assert_eq!(response.status(), 200);
    }
}
