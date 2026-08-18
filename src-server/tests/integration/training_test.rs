//! Task 6：POST /api/v1/training/media-assets（批量 upsert，LT team Admin 鉴权）。
//! Task 8：POST /api/v1/training/bind（幂等建号 + refresh 轮换）。
//! 鉴权目标 project 取 `state.config.training.project_id`——测试用 T3 建立的
//! 「改 config 后 create_app」模式注入（registration_gate_test 同款）。
//! 用户名/slug 用 unique() 隔离，避免重复跑撞唯一约束（test_register_and_login_flow 的已知缺陷不复刻）。

use axum::http::StatusCode;
use axum_test::TestServer;
use serde_json::json;
use std::sync::atomic::{AtomicU64, Ordering};

static COUNTER: AtomicU64 = AtomicU64::new(0);

fn unique(tag: &str) -> String {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    format!("t6_{}_{}_{}", tag, std::process::id(), n)
}

fn bearer(token: &str) -> String {
    format!("Bearer {}", token)
}

/// GET /users/me → user id（register 响应体被 mod.rs 助手丢弃，这里按 token 反查）。
async fn user_id_of(server: &TestServer, token: &str) -> i64 {
    let resp = server
        .get("/api/v1/users/me")
        .add_header("authorization", bearer(token))
        .await;
    assert_eq!(resp.status_code(), StatusCode::OK);
    resp.json::<serde_json::Value>()["id"]
        .as_i64()
        .unwrap()
}

/// 建 owner→team→project→admin/member 两用户（经默认 config 的 app1），再用
/// 「改 config 后 create_app」模式把 project_id 注入 training 段得到最终 server。
/// 两个 app 连同一个库，token/数据互通。返回 (server, state, admin_token, member_token)。
async fn training_fixture_with_config_project(
    tag: &str,
) -> (TestServer, llm_wiki_server::AppState, String, String) {
    let (app1, _state1) = crate::setup_test_app().await;
    let s1 = TestServer::new(app1).unwrap();

    let owner_name = unique(tag);
    let owner = crate::register_user(
        &s1,
        &owner_name,
        &format!("{}@t6.com", owner_name),
        "secret123",
    )
    .await;

    // 建队（创建者自动 owner）
    let team = s1
        .post("/api/v1/teams")
        .add_header("authorization", bearer(&owner))
        .json(&json!({"name": format!("LT测试team_{}", owner_name)}))
        .await;
    assert_eq!(team.status_code(), StatusCode::CREATED);
    let team_id = team.json::<serde_json::Value>()["id"].as_i64().unwrap();

    let proj = s1
        .post("/api/v1/projects")
        .add_header("authorization", bearer(&owner))
        .json(&json!({"name": format!("LT项目_{}", owner_name), "team_id": team_id}))
        .await;
    assert_eq!(proj.status_code(), StatusCode::CREATED);
    let project_id = proj.json::<serde_json::Value>()["id"].as_i64().unwrap() as i32;

    // 第二用户 → team admin；第三用户 → team member（add_member 的 role 是小写字符串）
    let admin_name = unique(tag);
    let admin = crate::register_user(
        &s1,
        &admin_name,
        &format!("{}@t6.com", admin_name),
        "secret123",
    )
    .await;
    let m = s1
        .post(&format!("/api/v1/teams/{team_id}/members"))
        .add_header("authorization", bearer(&owner))
        .json(&json!({"user_id": user_id_of(&s1, &admin).await, "role": "admin"}))
        .await;
    assert_eq!(m.status_code(), StatusCode::CREATED);

    let member_name = unique(tag);
    let member = crate::register_user(
        &s1,
        &member_name,
        &format!("{}@t6.com", member_name),
        "secret123",
    )
    .await;
    let m2 = s1
        .post(&format!("/api/v1/teams/{team_id}/members"))
        .add_header("authorization", bearer(&owner))
        .json(&json!({"user_id": user_id_of(&s1, &member).await, "role": "member"}))
        .await;
    assert_eq!(m2.status_code(), StatusCode::CREATED);

    // 「改 config 后 create_app」（T3 模式）：TRAINING__PROJECT_ID 进程内不可变，经 config 注入
    crate::ensure_test_jwt_secret();
    let mut cfg = llm_wiki_server::AppConfig::from_env().unwrap();
    cfg.training.project_id = Some(project_id);
    cfg.training.admin_token = "tok123".to_string();
    let (app2, state) = llm_wiki_server::create_app(cfg).await.unwrap();
    let server = TestServer::new(app2).unwrap();
    (server, state, admin, member)
}

#[tokio::test]
async fn media_assets_matrix() {
    let (server, state, admin, member) = training_fixture_with_config_project("matrix").await;
    let slug = unique("s1");
    let body = json!({"items":[{"slug":slug,"media_ref":"/tmp/x.mp4","duration_s":100,"kind":"video","chapters":[]}]});

    // 无 token → 401（require_auth 拒绝）
    let r = server.post("/api/v1/training/media-assets").json(&body).await;
    assert_eq!(r.status_code(), StatusCode::UNAUTHORIZED);

    // Member（在 team 但 role 不够）→ 403
    let r = server
        .post("/api/v1/training/media-assets")
        .add_header("authorization", bearer(&member))
        .json(&body)
        .await;
    assert_eq!(r.status_code(), StatusCode::FORBIDDEN);

    // Admin → 200 且 imported=1
    let r = server
        .post("/api/v1/training/media-assets")
        .add_header("authorization", bearer(&admin))
        .json(&body)
        .await;
    assert_eq!(r.status_code(), StatusCode::OK);
    assert_eq!(r.json::<serde_json::Value>()["imported"], 1);

    // upsert 幂等：改 media_ref 再导入，imported=1、行被更新且不新增
    let body2 = json!({"items":[{"slug":slug,"media_ref":"/tmp/x2.mp4","duration_s":120,"kind":"video","chapters":[]}]});
    let r2 = server
        .post("/api/v1/training/media-assets")
        .add_header("authorization", bearer(&admin))
        .json(&body2)
        .await;
    assert_eq!(r2.status_code(), StatusCode::OK);
    assert_eq!(r2.json::<serde_json::Value>()["imported"], 1);

    let row: (String, i32) =
        sqlx::query_as("SELECT media_ref, duration_s FROM media_assets WHERE slug = $1")
            .bind(&slug)
            .fetch_one(&state.db)
            .await
            .unwrap();
    assert_eq!(row.0, "/tmp/x2.mp4");
    assert_eq!(row.1, 120);
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM media_assets WHERE slug = $1")
        .bind(&slug)
        .fetch_one(&state.db)
        .await
        .unwrap();
    assert_eq!(n, 1, "upsert must not duplicate rows");
}

#[tokio::test]
async fn media_assets_validation_and_atomicity() {
    let (server, state, admin, _member) = training_fixture_with_config_project("valid").await;

    // 空 items → 400
    let r = server
        .post("/api/v1/training/media-assets")
        .add_header("authorization", bearer(&admin))
        .json(&json!({"items":[]}))
        .await;
    assert_eq!(r.status_code(), StatusCode::BAD_REQUEST);

    // 非法 kind → 400，且批量事务原子：同批第一条不落库
    let slug = unique("s2");
    let r = server
        .post("/api/v1/training/media-assets")
        .add_header("authorization", bearer(&admin))
        .json(&json!({"items":[
            {"slug":slug,"media_ref":"/tmp/a.mp4","duration_s":10,"kind":"video","chapters":[]},
            {"slug":format!("{}_b", slug),"media_ref":"/tmp/b.mp3","duration_s":10,"kind":"bogus","chapters":[]}
        ]}))
        .await;
    assert_eq!(r.status_code(), StatusCode::BAD_REQUEST);
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM media_assets WHERE slug = $1 OR slug = $2")
        .bind(&slug)
        .bind(format!("{}_b", slug))
        .fetch_one(&state.db)
        .await
        .unwrap();
    assert_eq!(n, 0, "partial batch must not persist (tx rollback)");
}

// ============ Task 8：POST /api/v1/training/bind ============

#[tokio::test]
async fn bind_lifecycle() {
    let (server, state, _admin, _member) = training_fixture_with_config_project("bind").await;
    let pid = state.config.training.project_id.unwrap();
    let wid = unique("t01"); // wecom_userid 也 unique() 化，防重复跑撞 users/teacher_profiles 唯一约束
    let body = json!({"wecom_userid": wid, "display_name": "王老师"});

    // 无 token → 401
    let r = server.post("/api/v1/training/bind").json(&body).await;
    assert_eq!(r.status_code(), StatusCode::UNAUTHORIZED);

    // 错 token → 401
    let r = server
        .post("/api/v1/training/bind")
        .add_header("x-training-admin-token", "wrong")
        .json(&body)
        .await;
    assert_eq!(r.status_code(), StatusCode::UNAUTHORIZED);

    // 空白 wecom_userid → 400（即使 token 正确）
    let r = server
        .post("/api/v1/training/bind")
        .add_header("x-training-admin-token", "tok123")
        .json(&json!({"wecom_userid": "   ", "display_name": "王老师"}))
        .await;
    assert_eq!(r.status_code(), StatusCode::BAD_REQUEST);

    // 正确 token → 200，含 access/refresh 与 user（username 合成、email 域名固定）
    let r = server
        .post("/api/v1/training/bind")
        .add_header("x-training-admin-token", "tok123")
        .json(&body)
        .await;
    assert_eq!(r.status_code(), StatusCode::OK);
    let v = r.json::<serde_json::Value>();
    let refresh1 = v["refresh_token"].as_str().unwrap().to_string();
    let access1 = v["access_token"].as_str().unwrap().to_string();
    assert!(!refresh1.is_empty() && !access1.is_empty());
    assert_eq!(v["user"]["username"].as_str().unwrap(), format!("wecom_{}", wid));
    assert_eq!(v["user"]["email"].as_str().unwrap(), format!("{}@wecom.local", wid));
    assert_eq!(v["user"]["full_name"].as_str().unwrap(), "王老师");
    assert_eq!(v["expires_in"], 300);

    // 该 access 能通过项目鉴权（team_members 已写入）：GET search → 200
    let s = server
        .get(&format!("/api/v1/search?project_id={pid}&query=x"))
        .add_header("authorization", bearer(&access1))
        .await;
    assert_eq!(s.status_code(), StatusCode::OK);

    // 不建 personal team：用户 team 列表只含 LT team 一个（响应形如 {"data":[...]}）
    let teams = server
        .get("/api/v1/teams")
        .add_header("authorization", bearer(&access1))
        .await;
    assert_eq!(teams.status_code(), StatusCode::OK);
    let tv = teams.json::<serde_json::Value>();
    let n = tv["data"].as_array().map(|a| a.len()).unwrap();
    assert_eq!(n, 1, "bound user must belong to exactly the LT team, no personal team");

    // teacher_profiles 落 pending
    let st: String = sqlx::query_scalar(
        "SELECT onboarding_state FROM teacher_profiles WHERE wecom_userid = $1",
    )
    .bind(&wid)
    .fetch_one(&state.db)
    .await
    .unwrap();
    assert_eq!(st, "pending");

    // 幂等：再 bind 同一 wecom_userid → 200 新 refresh、同一 user；旧 refresh 立即失效
    let r2 = server
        .post("/api/v1/training/bind")
        .add_header("x-training-admin-token", "tok123")
        .json(&body)
        .await;
    assert_eq!(r2.status_code(), StatusCode::OK);
    let v2 = r2.json::<serde_json::Value>();
    let refresh2 = v2["refresh_token"].as_str().unwrap().to_string();
    assert_ne!(refresh1, refresh2, "re-bind must rotate the refresh token");
    assert_eq!(v2["user"]["id"], v["user"]["id"], "re-bind must reuse the same account");

    let old = server
        .post("/api/v1/auth/refresh")
        .json(&json!({"refresh_token": refresh1}))
        .await;
    assert_eq!(old.status_code(), StatusCode::UNAUTHORIZED, "old refresh must be revoked");

    // 新 refresh 仍可用（未误伤）
    let fresh = server
        .post("/api/v1/auth/refresh")
        .json(&json!({"refresh_token": refresh2}))
        .await;
    assert_eq!(fresh.status_code(), StatusCode::OK);
}

/// 超 50 chars 的 wecom_userid（含多字节 CJK）→ username 走 chars 截断合成，
/// 不 panic、长度 ≤ 50、无重复建号。
#[tokio::test]
async fn bind_truncates_long_wecom_userid_by_chars() {
    let (server, _state, _admin, _member) = training_fixture_with_config_project("bindlong").await;
    // "王a" 交替（多字节混排）+ unique 后缀：既保证任何按字节的截断都会切在多字节
    // 字符中间，又保证重复运行时 wecom_userid 唯一；总长 > 44 chars 必走截断分支。
    let wid = format!("{}{}", "王a".repeat(29), unique("lw"));
    let r = server
        .post("/api/v1/training/bind")
        .add_header("x-training-admin-token", "tok123")
        .json(&json!({"wecom_userid": wid, "display_name": "长名老师"}))
        .await;
    assert_eq!(r.status_code(), StatusCode::OK);
    let v = r.json::<serde_json::Value>();
    let uname = v["user"]["username"].as_str().unwrap();
    assert!(uname.chars().count() <= 50, "username must fit VARCHAR(50): {}", uname);
    assert!(uname.starts_with("wecom_"), "synthesized prefix: {}", uname);
    assert!(v["user"]["id"].as_i64().unwrap() > 0);

    // 二次 bind（幂等）→ 同一 user id，不再新号
    let r2 = server
        .post("/api/v1/training/bind")
        .add_header("x-training-admin-token", "tok123")
        .json(&json!({"wecom_userid": wid}))
        .await;
    assert_eq!(r2.status_code(), StatusCode::OK);
    assert_eq!(r2.json::<serde_json::Value>()["user"]["id"], v["user"]["id"]);
}

/// fail closed：TRAINING__ADMIN_TOKEN 未配置 → 500（即使无 token 头也绝不放行）；
/// ADMIN_TOKEN 配了但 TRAINING__PROJECT_ID 缺失 → 500。
#[tokio::test]
async fn bind_fail_closed_on_missing_config() {
    // default.json 无 training 段 → admin_token 为空
    let (app, _state) = crate::setup_test_app().await;
    let server = TestServer::new(app).unwrap();
    let r = server
        .post("/api/v1/training/bind")
        .json(&json!({"wecom_userid": "whoever"}))
        .await;
    assert_eq!(r.status_code(), StatusCode::INTERNAL_SERVER_ERROR);
    let r = server
        .post("/api/v1/training/bind")
        .add_header("x-training-admin-token", "")
        .json(&json!({"wecom_userid": "whoever"}))
        .await;
    assert_eq!(r.status_code(), StatusCode::INTERNAL_SERVER_ERROR);

    // 有 admin_token、无 project_id → 500
    crate::ensure_test_jwt_secret();
    let mut cfg = llm_wiki_server::AppConfig::from_env().unwrap();
    cfg.training.admin_token = "tok123".to_string();
    cfg.training.project_id = None;
    let (app2, _state2) = llm_wiki_server::create_app(cfg).await.unwrap();
    let server2 = TestServer::new(app2).unwrap();
    let r = server2
        .post("/api/v1/training/bind")
        .add_header("x-training-admin-token", "tok123")
        .json(&json!({"wecom_userid": "whoever"}))
        .await;
    assert_eq!(r.status_code(), StatusCode::INTERNAL_SERVER_ERROR);
}
