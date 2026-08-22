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

    /// SEC-1（终审必修）：GET /users/:id 必须鉴权——公网遍历即拉教师 PII
    /// （username/email/full_name）。无 token → 401；带 token → 200。
    /// 调用方核查（2026-08-22）：桌面端走自有 API（src/lib/api-client.ts 仅
    /// /users/me*），transcriber/mcp 只用 /training/*，全仓无 public 形态依赖。
    #[tokio::test]
    async fn users_id_requires_auth() {
        let (app, _state) = crate::setup_test_app().await;
        let server = axum_test::TestServer::new(app).unwrap();

        // 无 token → 401（修复前为 200 public）
        let r = server.get("/api/v1/users/1").await;
        assert_eq!(r.status_code(), axum::http::StatusCode::UNAUTHORIZED, "no token must be 401");

        // 畸形 token → 401（鉴权路径而非透传）
        let r = server
            .get("/api/v1/users/1")
            .add_header("authorization", "Bearer not-a-jwt")
            .await;
        assert_eq!(r.status_code(), axum::http::StatusCode::UNAUTHORIZED, "bad token must be 401");

        // 有效 token → 200（鉴权后语义不变：任意登录用户可按 id 查）
        let username = format!("usersid_{}", std::process::id());
        let token = crate::register_user(
            &server,
            &username,
            &format!("{}@t.com", username),
            "password123",
        )
        .await;
        let me = server
            .get("/api/v1/users/me")
            .add_header("authorization", format!("Bearer {}", token))
            .await;
        let uid = me.json::<serde_json::Value>()["id"].as_i64().unwrap();
        let r = server
            .get(&format!("/api/v1/users/{uid}"))
            .add_header("authorization", format!("Bearer {}", token))
            .await;
        assert_eq!(r.status_code(), axum::http::StatusCode::OK, "valid token must reach handler");
        assert_eq!(r.json::<serde_json::Value>()["id"].as_i64(), Some(uid));
    }

    /// SEC-3（终审必修）：/auth/login IP 级固定窗口限流（10/min/IP）。
    /// 同 IP 第 11 次 → 429（red：修复前永远 401）——防口令暴力猜解。
    #[tokio::test]
    async fn login_rate_limited_per_ip_429() {
        let (app, _state) = crate::setup_test_app().await;
        let server = axum_test::TestServer::new(app).unwrap();

        let username = format!("loginrl_{}", std::process::id());
        crate::register_user(
            &server,
            &username,
            &format!("{}@t.com", username),
            "password123",
        )
        .await;

        let login = |ip: &str, pw: &str| {
            server
                .post("/api/v1/auth/login")
                .add_header("cf-connecting-ip", ip)
                .content_type("application/json")
                .json(&serde_json::json!({"username": username, "password": pw}))
        };
        // 同 IP 10 次错密码 → 401（计数）
        for i in 0..10 {
            let r = login("203.0.113.8", "wrong-password").await;
            assert_eq!(r.status_code(), axum::http::StatusCode::UNAUTHORIZED, "within cap #{i}");
        }
        // 第 11 次同 IP → 429（red：修复前 401）——即使密码正确也拒（限流先于校验）
        let r = login("203.0.113.8", "password123").await;
        assert_eq!(r.status_code(), axum::http::StatusCode::TOO_MANY_REQUESTS, "11th same-IP login must 429");
        // 换 IP → 独立桶：正确密码可登录成功
        let r = login("198.51.100.10", "password123").await;
        assert_eq!(r.status_code(), axum::http::StatusCode::OK, "different IP unaffected, valid creds pass");
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
