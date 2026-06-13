#[cfg(test)]
mod tests {
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use tower::ServiceExt;

    // 注意: 完整集成测试需要先创建测试数据库
    // 此处提供基本框架，实际运行时需要设置 DATABASE_URL

    fn setup_test_app() -> (axum::Router, llm_wiki_server::AppState) {
        let config = llm_wiki_server::AppConfig::from_env()
            .expect("Failed to load test config");
        tokio_test::block_on(llm_wiki_server::create_app(config))
            .expect("Failed to create test app")
    }

    #[tokio::test]
    #[ignore = "Requires database — run with DATABASE_URL set"]
    async fn test_health_check() {
        let (app, _state) = setup_test_app();

        let response = app
            .oneshot(Request::builder()
                .uri("/health")
                .body(Body::empty())
                .unwrap())
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    #[ignore = "Requires database — run with DATABASE_URL set"]
    async fn test_register_and_login_flow() {
        let (app, _state) = setup_test_app();

        // 注册
        let register_body = serde_json::json!({
            "username": "testuser_int",
            "email": "test_int@example.com",
            "password": "password123",
        });
        let response = app.clone()
            .oneshot(Request::builder()
                .method("POST")
                .uri("/api/v1/auth/register")
                .header("Content-Type", "application/json")
                .body(Body::from(serde_json::to_string(&register_body).unwrap()))
                .unwrap())
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::CREATED);

        // 登录
        let login_body = serde_json::json!({
            "username": "testuser_int",
            "password": "password123",
        });
        let response = app
            .oneshot(Request::builder()
                .method("POST")
                .uri("/api/v1/auth/login")
                .header("Content-Type", "application/json")
                .body(Body::from(serde_json::to_string(&login_body).unwrap()))
                .unwrap())
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
    }
}
