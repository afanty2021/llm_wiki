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
    // 测试卫生：清理上一轮残留（cutoff 保护在飞测试，见 mod.rs）
    crate::teardown_test_data(&state).await;
}

/// Task 16a 回归：playback_path 的 COALESCE upsert 语义。
/// 常规 transcribe CLI 重跑发 `playback_path: None`（或省略字段），不得清空
/// demo/人工补登的转码覆盖值（2026-08-19 线上事故：3 条 H.264 覆盖被 NULL）。
/// Some(B) 再覆盖仍生效——demo 模式重复注册保持最后写入胜出。
#[tokio::test]
async fn media_assets_upsert_preserves_playback_path() {
    let (server, state, admin, _member) = training_fixture_with_config_project("pbk").await;
    let slug = unique("s3");
    let upsert = |playback_path: Option<&str>, media_ref: &str| {
        let item = match playback_path {
            Some(p) => json!({"slug":slug,"media_ref":media_ref,"playback_path":p,"duration_s":60,"kind":"video","chapters":[]}),
            None => json!({"slug":slug,"media_ref":media_ref,"duration_s":60,"kind":"video","chapters":[]}),
        };
        server
            .post("/api/v1/training/media-assets")
            .add_header("authorization", bearer(&admin))
            .json(&json!({"items":[item]}))
    };

    // 1) 首次注册带覆盖值 A → 落库 Some(A)
    let r = upsert(Some("/transcoded/a_h264.mp4"), "/tmp/a.mov").await;
    assert_eq!(r.status_code(), StatusCode::OK);

    // 2) CLI 重跑发 None → 既有覆盖值 A 保留（不被 NULL 掉）
    let r = upsert(None, "/tmp/a2.mov").await;
    assert_eq!(r.status_code(), StatusCode::OK);
    let pb: Option<String> =
        sqlx::query_scalar("SELECT playback_path FROM media_assets WHERE slug = $1")
            .bind(&slug)
            .fetch_one(&state.db)
            .await
            .unwrap();
    assert_eq!(pb.as_deref(), Some("/transcoded/a_h264.mp4"), "None must not wipe existing override");

    // 3) Some(B) 再注册 → 覆盖为 B（demo 模式重复注册仍生效）
    let r = upsert(Some("/transcoded/b_h264.mp4"), "/tmp/a2.mov").await;
    assert_eq!(r.status_code(), StatusCode::OK);
    let pb: Option<String> =
        sqlx::query_scalar("SELECT playback_path FROM media_assets WHERE slug = $1")
            .bind(&slug)
            .fetch_one(&state.db)
            .await
            .unwrap();
    assert_eq!(pb.as_deref(), Some("/transcoded/b_h264.mp4"));

    // 其他列不受 COALESCE 影响：media_ref 照常被最后一次导入覆盖
    let mr: String = sqlx::query_scalar("SELECT media_ref FROM media_assets WHERE slug = $1")
        .bind(&slug)
        .fetch_one(&state.db)
        .await
        .unwrap();
    assert_eq!(mr, "/tmp/a2.mov");
    // 测试卫生：清理上一轮残留（cutoff 保护在飞测试，见 mod.rs）
    crate::teardown_test_data(&state).await;
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

    // slug 超长（>200 chars）→ 400，且批量原子：不落库
    let long_slug = "s".repeat(201);
    let r = server
        .post("/api/v1/training/media-assets")
        .add_header("authorization", bearer(&admin))
        .json(&json!({"items":[{"slug":long_slug,"media_ref":"/tmp/l.mp4","duration_s":10,"kind":"video","chapters":[]}]}))
        .await;
    assert_eq!(r.status_code(), StatusCode::BAD_REQUEST);
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM media_assets WHERE slug = $1")
        .bind(&long_slug)
        .fetch_one(&state.db)
        .await
        .unwrap();
    assert_eq!(n, 0, "oversized slug must not persist");

    // 边界内：slug 恰 200 chars → 200（VARCHAR(255) 内，业务上限本身合法）
    let edge_slug = "e".repeat(200);
    let r = server
        .post("/api/v1/training/media-assets")
        .add_header("authorization", bearer(&admin))
        .json(&json!({"items":[{"slug":edge_slug,"media_ref":"/tmp/e.mp4","duration_s":10,"kind":"video","chapters":[]}]}))
        .await;
    assert_eq!(r.status_code(), StatusCode::OK);
    // 测试卫生：清理上一轮残留（cutoff 保护在飞测试，见 mod.rs）
    crate::teardown_test_data(&state).await;
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
    // 测试卫生：清理上一轮残留（cutoff 保护在飞测试，见 mod.rs）
    crate::teardown_test_data(&state).await;
}

/// 超 44 chars（触发 username 截断分支）但 ≤ 64（Step 2 新上限内）的 wecom_userid
/// （含多字节 CJK）→ username 走 chars 截断合成，不 panic、长度 ≤ 50、无重复建号。
/// 注：原 M1 版用 74 chars 输入——Step 2 落 64 chars 上限后该域非法（400），
/// 收缩到 (44, 64] 区间保持测试意图不变（截断分支 + 多字节安全）。
#[tokio::test]
async fn bind_truncates_long_wecom_userid_by_chars() {
    let (server, _state, _admin, _member) = training_fixture_with_config_project("bindlong").await;
    // "王a" 交替（多字节混排）+ unique 后缀：既保证任何按字节的截断都会切在多字节
    // 字符中间，又保证重复运行时 wecom_userid 唯一；40 + 后缀 ≈ 56 chars ∈ (44, 64]，
    // 必走截断分支且不触发长度 400。
    let wid = format!("{}{}", "王a".repeat(20), unique("lw"));
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
    // 测试卫生：清理上一轮残留（cutoff 保护在飞测试，见 mod.rs）
    crate::teardown_test_data(&_state).await;
}

/// R7（m3-impl-review 次级收编）：bind 23505 → 409 **中性文案**回归锚定。
/// 「已被占用或已绑定」不向调用方泄漏具体命中哪张表/哪个唯一约束（users.username /
/// users.email / teacher_profiles.wecom_userid 三者共用同一串）。冲突场景断言：
/// - 状态 409、code=CONFLICT；
/// - message 恰为中性串，不含表名/列名/约束号/db error detail 等内部语义；
/// - 提前 return → 事务回滚，不留半账号（无 teacher_profiles 残行）。
/// 回归意义：任何人把 23505 映射改成透传数据库错误详情即红。
#[tokio::test]
async fn bind_conflict_409_message_stays_neutral() {
    let (server, state, _admin, _member) = training_fixture_with_config_project("bind409").await;

    // 冲突源 1：username 占用——users 已有行恰占 bind 合成 username（wecom_{wid}）
    // （直接 SQL 落历史占位用户；app2 未开注册，无法经 /auth/register 制造）
    let wid1 = unique("c1");
    sqlx::query(
        "INSERT INTO users (username, email, password_hash, full_name) VALUES ($1, $2, $3, $4)",
    )
    .bind(format!("wecom_{wid1}"))
    .bind(format!("{}@t6.com", unique("c1u")))
    .bind("placeholder-not-a-login-hash")
    .bind("占位用户")
    .execute(&state.db)
    .await
    .unwrap();

    // 冲突源 2：email 占用——users 已有行恰占 bind 合成 email（{wid}@wecom.local）
    let wid2 = unique("c2");
    sqlx::query(
        "INSERT INTO users (username, email, password_hash, full_name) VALUES ($1, $2, $3, $4)",
    )
    .bind(unique("c2n"))
    .bind(format!("{wid2}@wecom.local"))
    .bind("placeholder-not-a-login-hash")
    .bind("占位用户")
    .execute(&state.db)
    .await
    .unwrap();

    for (i, wid) in [&wid1, &wid2].into_iter().enumerate() {
        let r = server
            .post("/api/v1/training/bind")
            .add_header("x-training-admin-token", "tok123")
            .json(&json!({"wecom_userid": wid, "display_name": "冲突老师"}))
            .await;
        assert_eq!(r.status_code(), StatusCode::CONFLICT, "conflict source #{i} must 409");
        let v = r.json::<serde_json::Value>();
        assert_eq!(v["error"]["code"], "CONFLICT");
        let msg = v["error"]["message"].as_str().unwrap();
        assert_eq!(msg, "已被占用或已绑定", "409 message 必须恰为中性串: {msg}");
        // 中性：不泄漏表名/列名/约束号等内部语义（"占用/绑定"两词本身是允许面）
        for leak in [
            "users", "teacher_profiles", "wecom_userid", "constraint",
            "23505", "unique", "username", "email", "detail",
        ] {
            assert!(!msg.contains(leak), "409 message leaks '{leak}': {msg}");
        }
        // 无半账号：提前 return → tx 回滚，wid 不落 teacher_profiles
        let n: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM teacher_profiles WHERE wecom_userid = $1")
                .bind(wid)
                .fetch_one(&state.db)
                .await
                .unwrap();
        assert_eq!(n, 0, "conflict bind must roll back (no profile for {wid})");
    }
    // 测试卫生：清理上一轮残留（cutoff 保护在飞测试，见 mod.rs）
    crate::teardown_test_data(&state).await;
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

/// Step 1（bind 并发竞态）：8 路 bind 同时 in-flight 打同一**新** wecom_userid。
/// 修复前：existing 查询不在事务内且 FOR UPDATE 锁不住 absent 行 →
/// 双双 INSERT → 23505 → 一方 500。修复后（事务级 advisory lock）：均 200、同一
/// user_id、单条 teacher_profiles/单合成账号；且未创建 personal team（M1 行为回归）。
/// multi_thread(4)：默认 current_thread 风味下 8 个 future 只是交替 poll，不真正
/// 并行——advisory lock 的竞态窗口（两个事务同时过 existing 检查）压不出来。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn bind_concurrent_same_wecom_userid_converges_on_one_account() {
    let (server, state, _admin, _member) = training_fixture_with_config_project("bindrace").await;
    let wid = unique("race");
    let body = json!({"wecom_userid": wid, "display_name": "并发老师"});

    async fn call(srv: &TestServer, b: &serde_json::Value) -> axum_test::TestResponse {
        srv.post("/api/v1/training/bind")
            .add_header("x-training-admin-token", "tok123")
            .json(b)
            .await
    }
    // 8 路真并发（4 worker 线程）：join_all 全部同时 in-flight
    let responses = futures::future::join_all((0..8).map(|_| call(&server, &body))).await;
    for (i, r) in responses.iter().enumerate() {
        assert_eq!(r.status_code(), StatusCode::OK, "concurrent bind #{i} must succeed");
    }
    let first = responses[0].json::<serde_json::Value>();
    for r in &responses[1..] {
        assert_eq!(
            r.json::<serde_json::Value>()["user"]["id"],
            first["user"]["id"],
            "all 8 must converge on the same account",
        );
    }
    let v1 = &first;

    // 只落一条 teacher_profiles 与一个合成账号（无半账号/无双号）
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM teacher_profiles WHERE wecom_userid = $1")
        .bind(&wid)
        .fetch_one(&state.db)
        .await
        .unwrap();
    assert_eq!(n, 1);
    let n_users: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE email = $1")
        .bind(format!("{}@wecom.local", wid))
        .fetch_one(&state.db)
        .await
        .unwrap();
    assert_eq!(n_users, 1);

    // M1 行为回归：未创建 personal team——bound 用户只属于 LT team
    let teams = server
        .get("/api/v1/teams")
        .add_header("authorization", format!("Bearer {}", v1["access_token"].as_str().unwrap()))
        .await;
    assert_eq!(teams.status_code(), StatusCode::OK);
    let n = teams.json::<serde_json::Value>()["data"]
        .as_array()
        .map(|a| a.len())
        .unwrap();
    assert_eq!(n, 1, "bound user must belong to exactly the LT team, no personal team");
    // 测试卫生：清理上一轮残留（cutoff 保护在飞测试，见 mod.rs）
    crate::teardown_test_data(&state).await;
}

/// Step 2（长度校验矩阵）：wecom_userid >64 chars / display_name >100 chars → 400；
/// 边界值（64 / 100）→ 200；被拒请求不落库。
#[tokio::test]
async fn bind_length_validation_matrix() {
    let (server, state, _admin, _member) = training_fixture_with_config_project("bindlen").await;

    // 65 chars → 400
    let over_id = "a".repeat(65);
    let r = server
        .post("/api/v1/training/bind")
        .add_header("x-training-admin-token", "tok123")
        .json(&json!({"wecom_userid": over_id}))
        .await;
    assert_eq!(r.status_code(), StatusCode::BAD_REQUEST);

    // display_name 101 chars（CJK 按字符计）→ 400
    let r = server
        .post("/api/v1/training/bind")
        .add_header("x-training-admin-token", "tok123")
        .json(&json!({"wecom_userid": unique("dn"), "display_name": "名".repeat(101)}))
        .await;
    assert_eq!(r.status_code(), StatusCode::BAD_REQUEST);

    // 被拒的 wecom_userid 不落库
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM teacher_profiles WHERE wecom_userid = $1")
        .bind(&over_id)
        .fetch_one(&state.db)
        .await
        .unwrap();
    assert_eq!(n, 0);

    // 边界值合法：wecom_userid 恰 64、display_name 恰 100 → 200
    // （重复运行走幂等路径同样 200，断言稳定）
    // 前缀 t6_e（评审 F5）：合成 email=全量 wid@wecom.local——无前缀时 SWEEPS
    // 的 t6_ 模式扫不到该边界用户，成确定性残留
    let edge_id = format!("t6_e{}", "b".repeat(60));
    let r = server
        .post("/api/v1/training/bind")
        .add_header("x-training-admin-token", "tok123")
        .json(&json!({"wecom_userid": edge_id, "display_name": "名".repeat(100)}))
        .await;
    assert_eq!(r.status_code(), StatusCode::OK);
    let uname = r.json::<serde_json::Value>()["user"]["username"].as_str().unwrap().to_string();
    assert!(uname.chars().count() <= 50, "synthesized username must fit VARCHAR(50)");
    // 测试卫生：清理上一轮残留（cutoff 保护在飞测试，见 mod.rs）
    crate::teardown_test_data(&state).await;
}

// ============ M3 Task 3：GET /training/overview + weekly period_key 自算 ============

use chrono::Datelike as _;

static T3_COUNTER: AtomicU64 = AtomicU64::new(0);

/// unique() 同构，前缀 t3_（Task 3 数据隔离，防重复跑撞唯一约束）。
fn unique_t3(tag: &str) -> String {
    let n = T3_COUNTER.fetch_add(1, Ordering::SeqCst);
    format!("t3_{}_{}_{}", tag, std::process::id(), n)
}

/// bind 一名教师（返回 (access_token, user_id)）；profile 随之落 pending。
async fn bind_t3_teacher(server: &TestServer, wid: &str, name: &str) -> (String, i64) {
    let r = server
        .post("/api/v1/training/bind")
        .add_header("x-training-admin-token", "tok123")
        .json(&json!({"wecom_userid": wid, "display_name": name}))
        .await;
    assert_eq!(r.status_code(), StatusCode::OK);
    let v = r.json::<serde_json::Value>();
    (
        v["access_token"].as_str().unwrap().to_string(),
        v["user"]["id"].as_i64().unwrap(),
    )
}

/// 当前 ISO 周串（与服务端同法：本地时区 iso_week，`YYYY-Www` 周数两位补零）。
fn t3_iso_week_now() -> String {
    let iw = chrono::Local::now().iso_week();
    format!("{:04}-W{:02}", iw.year(), iw.week())
}

fn t3_parse_ts(v: &serde_json::Value) -> chrono::DateTime<chrono::Utc> {
    chrono::DateTime::parse_from_rfc3339(v.as_str().expect("timestamp as string"))
        .unwrap()
        .with_timezone(&chrono::Utc)
}

/// 共享 live DB（5433）：overview 列出全库 teacher_profiles，不断言总数，
/// 按 wecom_userid 定位本测试教师（其他测试的 t6_/t7_ 教师同时在列属预期）。
fn t3_find_teacher<'a>(teachers: &'a [serde_json::Value], wid: &str) -> &'a serde_json::Value {
    teachers
        .iter()
        .find(|t| t["wecom_userid"] == wid)
        .unwrap_or_else(|| panic!("teacher {wid} missing from overview"))
}

/// 鉴权矩阵：无 token → 401、错 token → 401（require_training_admin，同 /bind）；
/// 正确 token → 200 且形状正确（teachers 数组 + generated_at 字符串）。
#[tokio::test]
async fn overview_requires_training_admin_token() {
    let (server, _state, _admin, _member) = training_fixture_with_config_project("ovauth").await;

    // 无 token → 401
    let r = server.get("/api/v1/training/overview").await;
    assert_eq!(r.status_code(), StatusCode::UNAUTHORIZED);

    // 错 token → 401
    let r = server
        .get("/api/v1/training/overview")
        .add_header("x-training-admin-token", "wrong")
        .await;
    assert_eq!(r.status_code(), StatusCode::UNAUTHORIZED);

    // 正确 token → 200（形状：teachers 数组 + generated_at 字符串）
    let r = server
        .get("/api/v1/training/overview")
        .add_header("x-training-admin-token", "tok123")
        .await;
    assert_eq!(r.status_code(), StatusCode::OK);
    let v = r.json::<serde_json::Value>();
    assert!(v["teachers"].as_array().is_some(), "teachers must be an array");
    assert!(v["generated_at"].as_str().is_some(), "generated_at must be a string");
    // 测试卫生：清理上一轮残留（cutoff 保护在飞测试，见 mod.rs）
    crate::teardown_test_data(&_state).await;
}

/// 聚合矩阵：两教师（A 有 plan+events、B 空）——
/// A：plans_total=全期 plan 数、items 全期按状态精确计数、items_7d 仅近 7 天
///   创建的 plan 的 items（注入 created_at 的既有模式：旧 plan 出窗、新 plan 在窗）、
///   last_active_at=最新任意事件、last_ask_at=最新 ask 事件；
/// B：无数据教师也在列——plans_total=0、items/items_7d 全零、last_* 为 null。
#[tokio::test]
async fn overview_aggregates_plans_items_events_per_teacher() {
    let (server, state, _admin, _member) = training_fixture_with_config_project("ovagg").await;

    let wid_a = unique_t3("ova");
    let wid_b = unique_t3("ovb");
    let (tok_a, uid_a) = bind_t3_teacher(&server, &wid_a, "甲老师").await;
    let _b = bind_t3_teacher(&server, &wid_b, "乙老师").await;

    // A 完成 onboarding（pending→surveyed，走既有 PUT /profile）
    let r = server
        .put("/api/v1/training/profile")
        .add_header("authorization", bearer(&tok_a))
        .json(&json!({"onboarding_state": "surveyed"}))
        .await;
    assert_eq!(r.status_code(), StatusCode::OK);

    // 播种（learning_api_test 同款注入 created_at）：plan_old 10 天前（出 7d 窗）
    // 2 items（pending/completed）；plan_new 1 天前（7d 窗内）2 items（viewed/completed）
    let now = chrono::Utc::now();
    let plan_old: i32 = sqlx::query_scalar(
        "INSERT INTO learning_plans (user_id, title, origin, period_key, created_at) \
         VALUES ($1, $2, 'chat', NULL, $3) RETURNING id",
    )
    .bind(uid_a as i32)
    .bind("旧计划（出7d窗）")
    .bind(now - chrono::Duration::days(10))
    .fetch_one(&state.db)
    .await
    .unwrap();
    for (i, status) in ["pending", "completed"].iter().enumerate() {
        sqlx::query(
            "INSERT INTO learning_items (plan_id, kind, target_ref, label, sort_order, status) \
             VALUES ($1, 'wiki_page', $2, $3, $4, $5)",
        )
        .bind(plan_old)
        .bind(format!("pages/t3-old-{i}.md"))
        .bind(format!("old-{i}"))
        .bind(i as i32)
        .bind(status)
        .execute(&state.db)
        .await
        .unwrap();
    }
    let _plan_new: i32 = sqlx::query_scalar(
        "INSERT INTO learning_plans (user_id, title, origin, period_key, created_at) \
         VALUES ($1, $2, 'chat', NULL, $3) RETURNING id",
    )
    .bind(uid_a as i32)
    .bind("新计划（7d窗内）")
    .bind(now - chrono::Duration::days(1))
    .fetch_one(&state.db)
    .await
    .unwrap();
    for (i, status) in ["viewed", "completed"].iter().enumerate() {
        sqlx::query(
            "INSERT INTO learning_items (plan_id, kind, target_ref, label, sort_order, status) \
             VALUES ($1, 'wiki_page', $2, $3, $4, $5)",
        )
        .bind(_plan_new)
        .bind(format!("pages/t3-new-{i}.md"))
        .bind(format!("new-{i}"))
        .bind(i as i32)
        .bind(status)
        .execute(&state.db)
        .await
        .unwrap();
    }
    // 事件：ask 2 小时前、view 30 分钟前（last_active 取任意最新、last_ask 仅 ask）
    sqlx::query(
        "INSERT INTO learning_events (user_id, event_type, payload, created_at) \
         VALUES ($1, 'ask', $2, $3)",
    )
    .bind(uid_a as i32)
    .bind(json!({"q": "分数怎么讲"}))
    .bind(now - chrono::Duration::hours(2))
    .execute(&state.db)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO learning_events (user_id, event_type, payload, created_at) \
         VALUES ($1, 'view', $2, $3)",
    )
    .bind(uid_a as i32)
    .bind(json!({"p": "pages/t3-new-0.md"}))
    .bind(now - chrono::Duration::minutes(30))
    .execute(&state.db)
    .await
    .unwrap();

    let r = server
        .get("/api/v1/training/overview")
        .add_header("x-training-admin-token", "tok123")
        .await;
    assert_eq!(r.status_code(), StatusCode::OK);
    let v = r.json::<serde_json::Value>();
    assert!(v["generated_at"].as_str().is_some());
    let teachers = v["teachers"].as_array().expect("teachers array");

    // A：全期 items=4（1 viewed/2 completed），7d 窗 items=2（1 viewed/1 completed）
    let ta = t3_find_teacher(teachers, &wid_a);
    assert_eq!(ta["display_name"], "甲老师");
    assert_eq!(ta["onboarding_state"], "surveyed");
    assert_eq!(ta["plans_total"], 2);
    assert_eq!(ta["items"], json!({"total": 4, "viewed": 1, "completed": 2}));
    assert_eq!(ta["items_7d"], json!({"total": 2, "viewed": 1, "completed": 1}));
    let la = t3_parse_ts(&ta["last_active_at"]);
    let lk = t3_parse_ts(&ta["last_ask_at"]);
    assert!(
        (la - (now - chrono::Duration::minutes(30))).num_seconds().abs() <= 1,
        "last_active_at = latest event of any type"
    );
    assert!(
        (lk - (now - chrono::Duration::hours(2))).num_seconds().abs() <= 1,
        "last_ask_at = latest ask event"
    );

    // B：空教师也在列，全零 / null
    let tb = t3_find_teacher(teachers, &wid_b);
    assert_eq!(tb["display_name"], "乙老师");
    assert_eq!(tb["onboarding_state"], "pending");
    assert_eq!(tb["plans_total"], 0);
    assert_eq!(tb["items"], json!({"total": 0, "viewed": 0, "completed": 0}));
    assert_eq!(tb["items_7d"], json!({"total": 0, "viewed": 0, "completed": 0}));
    assert_eq!(tb["last_active_at"], serde_json::Value::Null);
    assert_eq!(tb["last_ask_at"], serde_json::Value::Null);
    // 测试卫生：清理上一轮残留（cutoff 保护在飞测试，见 mod.rs）
    crate::teardown_test_data(&state).await;
}

/// period_key 三分支（origin=weekly）：
/// ① 省略 → 201 落库值 == 服务端自算当周串（周界竞态由 before/after 双值兜底）；
///   显式给出 == 当周（即 ① 的落库值）→ 通过校验且撞唯一索引走幂等 200 返既有；
/// ② 给错周（格式合法但 ≠ 当周）→ 400 且 body 含 expected_period_key；
/// ③ 格式非法（非 YYYY-Www）→ 400；被拒请求零落库。
/// 另证 origin=chat 不受周校验影响（period_key 可选透传，现状不变）。
#[tokio::test]
async fn weekly_plan_period_key_server_computed_and_validated() {
    let (server, state, _admin, _member) = training_fixture_with_config_project("pk3").await;
    let wid = unique_t3("pkw");
    let (teacher, uid) = bind_t3_teacher(&server, &wid, "周老师").await;

    // transcripts/ 前缀免实体页（transcriber 命名空间，learning_api_test 同款）
    let tr = format!("transcripts/t3-{}.md", unique_t3("tr"));
    let mk = |pk: Option<&str>| {
        json!({"title": "M3 周计划", "reason": "周报 cron 生成", "origin": "weekly",
               "period_key": pk,
               "items": [{"kind": "wiki_page", "target_ref": tr.clone(), "label": "a"}]})
    };

    // ① 省略 → 201，落库 = 服务端自算当周
    let pk_before = t3_iso_week_now();
    let r = server
        .post("/api/v1/training/plans")
        .add_header("authorization", bearer(&teacher))
        .json(&mk(None))
        .await;
    assert_eq!(r.status_code(), StatusCode::CREATED, "omitted period_key self-computes and creates");
    let v = r.json::<serde_json::Value>();
    let plan_id = v["plan"]["id"].as_i64().unwrap();
    let stored: Option<String> =
        sqlx::query_scalar("SELECT period_key FROM learning_plans WHERE id = $1")
            .bind(plan_id as i32)
            .fetch_one(&state.db)
            .await
            .unwrap();
    let pk_after = t3_iso_week_now();
    assert!(
        stored == Some(pk_before.clone()) || stored == Some(pk_after.clone()),
        "stored period_key must be the server-computed current ISO week \
         (got {stored:?}, before={pk_before}, after={pk_after})"
    );
    assert_eq!(v["plan"]["period_key"], json!(stored), "response reflects the computed key");

    // 显式给出 == 当周（= ① 落库值）→ 校验通过；撞唯一索引 → 幂等 200 同 plan id
    let r = server
        .post("/api/v1/training/plans")
        .add_header("authorization", bearer(&teacher))
        .json(&mk(stored.as_deref()))
        .await;
    if r.status_code() == StatusCode::OK {
        assert_eq!(r.json::<serde_json::Value>()["plan"]["id"], plan_id, "idempotent re-create");
    } else {
        // 唯一合法的非 200：测试恰跨 ISO 周界（服务端当周翻页 ≠ ① 的落库值）
        assert_eq!(r.status_code(), StatusCode::BAD_REQUEST);
        assert_ne!(t3_iso_week_now(), stored.clone().unwrap(), "400 only legal on week flip");
    }

    // ② 给错周（格式合法但 ≠ 当周）→ 400 且 body 含 expected_period_key（供 agent 改口重试）
    let r = server
        .post("/api/v1/training/plans")
        .add_header("authorization", bearer(&teacher))
        .json(&mk(Some("1999-W01")))
        .await;
    assert_eq!(r.status_code(), StatusCode::BAD_REQUEST, "wrong week must 400");
    let body = r.text();
    assert!(
        body.contains("expected_period_key"),
        "400 body must carry expected_period_key: {body}"
    );
    assert!(
        body.contains(&pk_after) || body.contains(&t3_iso_week_now()),
        "expected_period_key value = current week: {body}"
    );

    // ③ 格式非法（非 YYYY-Www 形状）→ 400
    for bad in ["2026-W3", "2026W34", "2026-W345", "x026-W34"] {
        let r = server
            .post("/api/v1/training/plans")
            .add_header("authorization", bearer(&teacher))
            .json(&mk(Some(bad)))
            .await;
        assert_eq!(r.status_code(), StatusCode::BAD_REQUEST, "invalid format must 400: {bad}");
    }

    // 被拒零落库：教师名下仍只有 ① 的那一条 weekly plan
    let n: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM learning_plans WHERE user_id = $1 AND origin = 'weekly'",
    )
    .bind(uid as i32)
    .fetch_one(&state.db)
    .await
    .unwrap();
    assert_eq!(n, 1, "rejected creates leave no weekly plans");

    // origin=chat 行为不变：period_key 可选透传，错周字符串也原样落库（不做周校验）
    let r = server
        .post("/api/v1/training/plans")
        .add_header("authorization", bearer(&teacher))
        .json(&json!({"title": "chat 计划", "origin": "chat", "period_key": "1999-W01",
                      "items": [{"kind": "wiki_page", "target_ref": tr, "label": "c"}]}))
        .await;
    assert_eq!(r.status_code(), StatusCode::CREATED);
    let chat_id = r.json::<serde_json::Value>()["plan"]["id"].as_i64().unwrap();
    let stored_chat: Option<String> =
        sqlx::query_scalar("SELECT period_key FROM learning_plans WHERE id = $1")
            .bind(chat_id as i32)
            .fetch_one(&state.db)
            .await
            .unwrap();
    assert_eq!(stored_chat.as_deref(), Some("1999-W01"), "chat passthrough unchanged");
    // 测试卫生：清理上一轮残留（cutoff 保护在飞测试，见 mod.rs）
    crate::teardown_test_data(&state).await;
}

/// Task 6 集成冒烟：bind 产出的 access token（内部带 typ="access"）调认证端点 → 200；
/// 同 secret 签的 plan_link token 调同一 /api 端点 → 401（typ 隔离，/t/ 凭证不可当 API 凭证）。
#[tokio::test]
async fn bind_access_token_typ_isolation_smoke() {
    let (server, state, _admin, _member) = training_fixture_with_config_project("typiso").await;
    let wid = unique("t6w");
    let r = server
        .post("/api/v1/training/bind")
        .add_header("x-training-admin-token", "tok123")
        .json(&json!({"wecom_userid": wid, "display_name": "冒烟老师"}))
        .await;
    assert_eq!(r.status_code(), StatusCode::OK);
    let v = r.json::<serde_json::Value>();
    let access = v["access_token"].as_str().unwrap().to_string();
    let uid = v["user"]["id"].as_i64().unwrap() as i32;

    // bind 的 access token（新路径，typ=access）→ 认证端点 200
    let me = server
        .get("/api/v1/users/me")
        .add_header("authorization", bearer(&access))
        .await;
    assert_eq!(me.status_code(), StatusCode::OK, "bind access token must pass require_auth");

    // 同 secret 的 plan_link token → 同一 /api 端点 401
    let secret = state.config.jwt_secret().to_string();
    let plan_link = llm_wiki_server::utils::generate_plan_link_token(
        uid,
        999, // plan 是否存在是路由层（Task 9）的事，这里只验证 /api 侧拒绝
        &secret,
        chrono::Duration::hours(1),
    )
    .unwrap();
    let denied = server
        .get("/api/v1/users/me")
        .add_header("authorization", bearer(&plan_link))
        .await;
    assert_eq!(denied.status_code(), StatusCode::UNAUTHORIZED, "plan_link token must not work as an API credential");
    // 测试卫生：清理上一轮残留（cutoff 保护在飞测试，见 mod.rs）
    crate::teardown_test_data(&state).await;
}
