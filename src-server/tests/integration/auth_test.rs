#[cfg(test)]
mod tests {
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use tower::ServiceExt;

    // 注意: setup_test_app 已抽到 crate::tests::integration::setup_test_app（mod.rs）
    // 完整集成测试需要先创建测试数据库（当前对 live DB 5433 真跑）。

    #[tokio::test]
    #[ignore = "Requires database — run with DATABASE_URL set"]
    async fn test_health_check() {
        let (app, _state) = crate::setup_test_app().await;

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
        let (app, _state) = crate::setup_test_app().await;

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

    #[tokio::test]
    async fn register_creates_personal_team_with_owner_membership() {
        let (app, state) = crate::setup_test_app().await;
        let server = axum_test::TestServer::new(app).unwrap();

        // 唯一用户名保证可重复运行（测试共享 live DB）
        let username = format!("teamtest_{}", std::process::id());
        let body = serde_json::json!({
            "username": username,
            "email": format!("{}@t.com", username),
            "password": "password123"
        });
        let resp = server.post("/api/v1/auth/register")
            .content_type("application/json")
            .json(&body)
            .await;
        assert_eq!(resp.status_code(), axum::http::StatusCode::CREATED);

        // 查 teams：应有 1 行 created_by = 新用户
        let team: Option<(i32, String)> = sqlx::query_as(
            "SELECT id, name FROM teams WHERE created_by = (SELECT id FROM users WHERE username = $1)"
        ).bind(&username).fetch_optional(&state.db).await.unwrap();
        let (team_id, team_name) = team.expect("personal team should be created");
        assert!(team_name.contains(&username), "team name should contain username, got: {}", team_name);

        // team_members：owner
        let role: Option<String> = sqlx::query_scalar(
            "SELECT role FROM team_members WHERE team_id = $1"
        ).bind(team_id).fetch_one(&state.db).await.unwrap();
        assert_eq!(role.as_deref(), Some("owner"));
    }
}
