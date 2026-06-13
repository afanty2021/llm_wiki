use axum::http::{HeaderValue, Method};
use tower_http::cors::{Any, CorsLayer};
use std::time::Duration;

/// 创建 CORS 中间件层
/// 允许指定的源、方法和头部
pub fn create_cors_layer(allowed_origins: &[String]) -> CorsLayer {
    let allowed_origins: Vec<HeaderValue> = allowed_origins
        .iter()
        .filter_map(|origin| origin.parse::<HeaderValue>().ok())
        .collect();

    CorsLayer::new()
        .allow_origin(allowed_origins)
        .allow_methods([Method::GET, Method::POST, Method::PUT, Method::DELETE, Method::PATCH])
        .allow_headers(Any)
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
