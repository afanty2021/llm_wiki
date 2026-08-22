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

    /// SEC-4 补集成面（遗留债：此前仅 200-ok 路径有覆盖）：DB 池关闭 →
    /// degraded 路径。仍 200（外探针语义不变）、status=degraded、详情恒常量
    /// "unavailable"（sqlx 错误原文只进 tracing，响应不泄漏 DSN/拓扑）。
    #[tokio::test]
    async fn health_degraded_masks_detail_and_stays_200() {
        let (app, state) = crate::setup_test_app().await;
        // 关池模拟 DB 不可用：health 的 SELECT 1 acquire 失败走 degraded 分支
        // （redis 未动，degraded.redis 应为 null）
        state.db.close().await;
        let server = axum_test::TestServer::new(app).unwrap();
        let r = server.get("/health").await;
        assert_eq!(r.status_code(), StatusCode::OK, "degraded 仍 200（探针语义）");
        let v = r.json::<serde_json::Value>();
        assert_eq!(v["status"], "degraded");
        assert_eq!(v["degraded"]["db"], "unavailable", "详情恒常量，不带错误原文");
        assert!(v["degraded"]["redis"].is_null(), "redis 未动，应为 null");
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
        let username = format!("t9_usersid_{}", std::process::id());
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

    /// M4 前置收窄：users/:id 仅「本人或 ADMIN_USERNAMES 白名单」。
    /// 跨用户查询 → 403（red：收窄前任意登录用户 200）；admin 白名单 → 200。
    #[tokio::test]
    async fn users_id_narrowed_to_self_or_admin() {
        // 跨用户：B 的 token 查 A → 403
        let (app, _state) = crate::setup_test_app().await;
        let server = axum_test::TestServer::new(app).unwrap();
        let uname_a = format!("t9_uidself_a_{}", std::process::id());
        let token_a = crate::register_user(
            &server,
            &uname_a,
            &format!("{}@t.com", uname_a),
            "password123",
        )
        .await;
        let me_a = server
            .get("/api/v1/users/me")
            .add_header("authorization", format!("Bearer {}", token_a))
            .await;
        let uid_a = me_a.json::<serde_json::Value>()["id"].as_i64().unwrap();

        // is_self 主路径（终审 round3 顺手项）：本人查自己 → 200
        let r = server
            .get(&format!("/api/v1/users/{uid_a}"))
            .add_header("authorization", format!("Bearer {}", token_a))
            .await;
        assert_eq!(r.status_code(), axum::http::StatusCode::OK, "self query must pass");
        assert_eq!(r.json::<serde_json::Value>()["id"].as_i64(), Some(uid_a));

        let uname_b = format!("t9_uidself_b_{}", std::process::id());
        crate::register_user(
            &server,
            &uname_b,
            &format!("{}@t.com", uname_b),
            "password123",
        )
        .await;

        // admin 白名单放进 B：需要带白名单的独立 app 实例（AppState.config 是 Arc，
        // create_app 后不可变）。同库同用户，login 取 token（register 会 409 重复）。
        crate::ensure_test_jwt_secret();
        let mut config = llm_wiki_server::AppConfig::from_env().expect("test config");
        config.auth.registration_enabled = true;
        config.admin_usernames = uname_b.clone();
        let app2 = llm_wiki_server::create_app(config).await.expect("test app 2");
        let (app2, _state2) = app2;
        let server2 = axum_test::TestServer::new(app2).unwrap();
        let login_b = server2
            .post("/api/v1/auth/login")
            .content_type("application/json")
            .json(&serde_json::json!({"username": uname_b, "password": "password123"}))
            .await;
        assert_eq!(login_b.status_code(), axum::http::StatusCode::OK);
        let token_b = login_b.json::<serde_json::Value>()["access_token"]
            .as_str()
            .expect("access_token")
            .to_string();

        let r = server2
            .get(&format!("/api/v1/users/{uid_a}"))
            .add_header("authorization", format!("Bearer {}", token_b))
            .await;
        assert_eq!(r.status_code(), axum::http::StatusCode::OK, "admin whitelist must pass");
        assert_eq!(r.json::<serde_json::Value>()["id"].as_i64(), Some(uid_a));

        // 同一 app2 上无白名单的普通用户视角：注册 C 查 A → 403（收窄主断言）
        let uname_c = format!("t9_uidself_c_{}", std::process::id());
        let token_c = crate::register_user(
            &server2,
            &uname_c,
            &format!("{}@t.com", uname_c),
            "password123",
        )
        .await;
        let r = server2
            .get(&format!("/api/v1/users/{uid_a}"))
            .add_header("authorization", format!("Bearer {}", token_c))
            .await;
        assert_eq!(r.status_code(), axum::http::StatusCode::FORBIDDEN, "cross-user must be 403");
    }

    /// SEC-3（终审必修）：/auth/login IP 级固定窗口限流（10/min/IP）。
    /// 同 IP 第 11 次 → 429（red：修复前永远 401）——防口令暴力猜解。
    #[tokio::test]
    async fn login_rate_limited_per_ip_429() {
        let (app, _state) = crate::setup_test_app().await;
        let server = axum_test::TestServer::new(app).unwrap();

        let username = format!("t9_loginrl_{}", std::process::id());
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
