//! Task 6：POST /api/v1/training/media-assets（批量 upsert，LT team Admin 鉴权）。
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
    let mut cfg = llm_wiki_server::AppConfig::from_env().unwrap();
    cfg.training.project_id = Some(project_id);
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
