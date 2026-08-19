use axum::{
    extract::Request,
    middleware::Next,
    response::Response,
};
use tracing::info;

/// /t/<token>、/media/<id>、/s/<code> 的路径与 query 整体脱敏（token/签名/短码不落日志）
/// 注：brief 原文 format 串 "/{}[REDACTED]" 产 "/t[REDACTED]"，与其自述输出
/// "/t/[REDACTED]"（注释 + 3 测试用例）矛盾——按测试期望补斜杠。
/// /s/（Task 9b）：短码是 capability URL 主体，与 /t/ token 同级敏感，同样脱敏。
pub fn redact_uri(uri: &axum::http::Uri) -> String {
    let path = uri.path();
    if path.starts_with("/t/") || path.starts_with("/media/") || path.starts_with("/s/") {
        let prefix = path.split('/').nth(1).unwrap_or("");
        format!("/{}/[REDACTED]", prefix) // "/t/[REDACTED]" / "/media/[REDACTED]" / "/s/[REDACTED]"
    } else {
        uri.to_string()
    }
}

/// 日志中间件
/// 记录每个请求的方法、路径和响应状态（/t/、/s/、/media/ 路径脱敏后再落日志）
pub async fn logging_middleware(
    req: Request,
    next: Next,
) -> Response {
    let method = req.method().clone();
    let uri = req.uri().clone();

    info!(method = %method, uri = %redact_uri(&uri), "incoming request");

    let response = next.run(req).await;

    info!(method = %method, uri = %redact_uri(&uri), status = ?response.status(), "request completed");

    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::Router;
    use axum::routing::get;
    use tower::util::ServiceExt;

    #[test]
    fn test_redact_uri_t_token() {
        let uri = "/t/x?sig=1".parse::<axum::http::Uri>().unwrap();
        assert_eq!(redact_uri(&uri), "/t/[REDACTED]");
    }

    #[test]
    fn test_redact_uri_media_sig() {
        let uri = "/media/y?exp=2".parse::<axum::http::Uri>().unwrap();
        assert_eq!(redact_uri(&uri), "/media/[REDACTED]");
    }

    #[test]
    fn test_redact_uri_s_short_code() {
        let uri = "/s/x?y=1".parse::<axum::http::Uri>().unwrap();
        assert_eq!(redact_uri(&uri), "/s/[REDACTED]");
    }

    #[test]
    fn test_redact_uri_other_paths_untouched() {
        let uri = "/api/v1/health".parse::<axum::http::Uri>().unwrap();
        assert_eq!(redact_uri(&uri), "/api/v1/health");
    }

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
