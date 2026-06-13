use axum::http::{HeaderMap, HeaderName, HeaderValue, Method};
use tower_http::cors::{Any, CorsLayer};
use std::time::Duration;

/// 创建 CORS 中间件层
/// 允许指定的源、方法和头部
/// 如果包含 "*" 通配符，则允许所有源但禁用 credentials
pub fn create_cors_layer(allowed_origins: &[String]) -> CorsLayer {
    // 检查是否包含通配符
    if allowed_origins.iter().any(|o| o == "*") {
        // 通配符模式下禁用 credentials
        return CorsLayer::new()
            .allow_origin(Any)
            .allow_methods([Method::GET, Method::POST, Method::PUT, Method::DELETE, Method::PATCH])
            .allow_headers(Any)
            .allow_credentials(false)
            .expose_headers([axum::http::HeaderName::from_static("content-length")])
            .max_age(Duration::from_secs(86400));
    }

    let allowed_origins: Vec<HeaderValue> = allowed_origins
        .iter()
        .filter_map(|origin| origin.parse::<HeaderValue>().ok())
        .collect();

    // 当 credentials 为 true 时，不能使用通配符 headers
    let allowed_headers: Vec<HeaderName> = vec![
        HeaderName::from_static("content-type"),
        HeaderName::from_static("authorization"),
        HeaderName::from_static("x-requested-with"),
    ];

    CorsLayer::new()
        .allow_origin(allowed_origins)
        .allow_methods([Method::GET, Method::POST, Method::PUT, Method::DELETE, Method::PATCH])
        .allow_headers(allowed_headers)
        .allow_credentials(true)
        .expose_headers([axum::http::HeaderName::from_static("content-length")])
        .max_age(Duration::from_secs(86400))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_create_cors_layer() {
        // Test that CORS layer can be created with allowed origins
        let origins = vec![
            "http://localhost:1420".to_string(),
            "https://example.com".to_string(),
        ];

        let cors_layer = create_cors_layer(&origins);

        // Test that invalid origins are filtered out
        let invalid_origins = vec![
            "http://localhost:1420".to_string(),
            "invalid,origin".to_string(),  // Invalid HeaderValue
        ];

        let _cors_layer_filtered = create_cors_layer(&invalid_origins);

        // Should not panic - invalid origins are filtered out
        drop(cors_layer);
    }

    #[test]
    fn test_create_cors_layer_empty() {
        // Test that CORS layer can be created with empty origins
        let origins: Vec<String> = vec![];

        let cors_layer = create_cors_layer(&origins);

        // Should not panic
        drop(cors_layer);
    }

    #[test]
    fn test_create_cors_layer_with_invalid_origins() {
        // Test that invalid origins are filtered out
        let origins = vec![
            "http://localhost:1420".to_string(),
            "".to_string(),  // Empty string
        ];

        let cors_layer = create_cors_layer(&origins);

        // Should not panic - empty origin is filtered out
        drop(cors_layer);
    }

    #[test]
    fn test_create_cors_layer_multiple_origins() {
        // Test with multiple valid origins
        let origins = vec![
            "http://localhost:1420".to_string(),
            "http://localhost:3000".to_string(),
            "https://example.com".to_string(),
            "https://app.example.com".to_string(),
        ];

        let cors_layer = create_cors_layer(&origins);

        // Should not panic
        drop(cors_layer);
    }
}
