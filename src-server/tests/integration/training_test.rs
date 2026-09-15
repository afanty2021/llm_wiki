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

/// 测试自清（双保险第二层）：按精确 email 删除**本测试本轮**造出的用户——bind 的
/// email 合成式恒为 `{wid}@wecom.local`（routes/training.rs，全量 wid 不截断），
/// 精确匹配零误删面；DELETE users 级联带走 teacher_profiles/team_members/
/// refresh_tokens/learning_plans/events 等（引用 users 的 13 条 FK 除
/// projects.created_by 与 activity_logs 外全部 ON DELETE CASCADE，2026-09-15
/// 对 live PG \d 逐一实证）。不受 SWEEPS 的 cutoff 约束——cutoff=本进程首次
/// sweep-60s，背靠背连跑（无改动重跑 10-20s 一轮）时上一轮行永远新于 cutoff、
/// 只能等 >60s 间隔的下一轮收账（2026-09-15 残渣事故机理：4 轮 56 秒内连跑，
/// 280 users/88 teams/88 projects 全数幸存，bind 教师以假「王老师」暴露进 roster）。
/// 教师行是 roster 可见面，本轮内立即自删不再等下一轮；t6_ fixture 用户
/// （owner/admin/member，无 profile 不进 roster）仍走 SWEEPS 下一轮收尾。
async fn cleanup_test_user_by_email(db: &sqlx::Pool<sqlx::Postgres>, email: String) {
    sqlx::query("DELETE FROM users WHERE email = $1")
        .bind(email)
        .execute(db)
        .await
        .expect("cleanup_test_user_by_email sweep failed");
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
    // 测试卫生（双保险第一层）：测试开始处先清上一轮残渣。SWEEPS 的 cutoff（首次
    // sweep-60s）使 <60s 间隔的背靠背连跑整链互不清账（机理见 cleanup_test_user_by_email
    // 注）；此处让每个测试开始时都尝试收账——>60s 间隔后的第一轮即可清掉，不再依赖
    // 恰好有测试跑到末尾。cutoff 保护在飞测试，本轮自己的行不受影响。
    crate::teardown_test_data(&_state1).await;
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

    // 「改 config 后 create_app」（T3 模式）：TRAINING__PROJECT_ID 进程内不可变，经 config 注入。
    // SEC-2：media.allowed_roots 注入 "/transcoded"——playback_path 校验（下方
    // media_assets_playback_path_boundary）与 COALESCE 回归（/transcoded/*.mp4 值）共用。
    crate::ensure_test_jwt_secret();
    let mut cfg = llm_wiki_server::AppConfig::from_env().unwrap();
    cfg.training.project_id = Some(project_id);
    cfg.training.admin_token = "tok123".to_string();
    cfg.media.allowed_roots = vec!["/transcoded".to_string()];
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

/// SEC-2（终审必修）upsert 侧：playback_path 越界 → 400，被拒请求不落库。
/// fixture 的许可根集 = ["/transcoded"]：
/// - 库外绝对路径（"/etc/passwd"）→ 400（修复前 200 直落库——/media 侧即任意文件读源）；
/// - 相对路径 `..` 穿越越出根（"sub/../../escape.mp4"）→ 400；
/// - 根内绝对（"/transcoded/ok.mp4"）与根内相对（"ok.mp4"）→ 200（控制组）。
#[tokio::test]
async fn media_assets_playback_path_boundary() {
    let (server, state, admin, _member) = training_fixture_with_config_project("pbb").await;

    let post = |item: serde_json::Value| {
        server
            .post("/api/v1/training/media-assets")
            .add_header("authorization", bearer(&admin))
            .json(&json!({"items":[item]}))
    };
    let item = |slug: &str, playback: Option<&str>| match playback {
        Some(p) => json!({"slug":slug,"media_ref":"/tmp/x.mov","playback_path":p,"duration_s":60,"kind":"video","chapters":[]}),
        None => json!({"slug":slug,"media_ref":"/tmp/x.mov","duration_s":60,"kind":"video","chapters":[]}),
    };

    // 库外绝对路径 → 400（red：修复前 200）
    let slug_abs = unique("pabs");
    let r = post(item(&slug_abs, Some("/etc/passwd"))).await;
    assert_eq!(r.status_code(), StatusCode::BAD_REQUEST, "absolute path outside roots must 400");

    // `..` 穿越越出根 → 400（red：修复前 200）
    let slug_trav = unique("ptrav");
    let r = post(item(&slug_trav, Some("sub/../../escape.mp4"))).await;
    assert_eq!(r.status_code(), StatusCode::BAD_REQUEST, "traversal escaping roots must 400");

    // 被拒请求零落库
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM media_assets WHERE slug = ANY($1)")
        .bind(vec![slug_abs, slug_trav])
        .fetch_one(&state.db)
        .await
        .unwrap();
    assert_eq!(n, 0, "rejected playback_path must not persist");

    // 控制组：根内绝对/相对均放行
    let r = post(item(&unique("pok"), Some("/transcoded/ok.mp4"))).await;
    assert_eq!(r.status_code(), StatusCode::OK, "absolute under root passes");
    let r = post(item(&unique("prel"), Some("rel_ok.mp4"))).await;
    assert_eq!(r.status_code(), StatusCode::OK, "relative inside root passes");
    // 测试卫生：清理上一轮残留（cutoff 保护在飞测试，见 mod.rs）
    crate::teardown_test_data(&state).await;
}

// ============ bind display_name 缺省回落（2026-09-05）============
#[tokio::test]
async fn bind_defaults_display_name_to_wecom_userid() {
    let (server, state, _admin, _member) = training_fixture_with_config_project("binddef").await;
    let wid = unique("tdef");
    // 不传 display_name → users.full_name 与 teacher_profiles.display_name 均回落 wecom_userid
    let r = server
        .post("/api/v1/training/bind")
        .add_header("x-training-admin-token", "tok123")
        .json(&json!({"wecom_userid": wid}))
        .await;
    assert_eq!(r.status_code(), StatusCode::OK, "{}", r.text());
    let v = r.json::<serde_json::Value>();
    assert_eq!(v["user"]["full_name"].as_str().unwrap(), wid);
    let dn: Option<String> = sqlx::query_scalar(
        "SELECT tp.display_name FROM teacher_profiles tp JOIN users u ON u.id=tp.user_id WHERE u.username = $1",
    )
    .bind(format!("wecom_{wid}"))
    .fetch_one(&state.db)
    .await
    .unwrap();
    assert_eq!(dn.as_deref(), Some(wid.as_str()));
    // 测试卫生：本轮内自清教师账号（本测试原无任何 teardown，事故残渣幸存路径之一）
    cleanup_test_user_by_email(&state.db, format!("{wid}@wecom.local")).await;
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
    assert_eq!(v["expires_in"], 14400);

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

    // 重绑不覆盖真名（评审 N2 钉）：existing 路径只轮换凭证/ healed membership，
    // 不得回写 display_name——无名重绑若把已设真名重置为 wecom_userid 回落值，此断言捕获
    let r3 = server
        .post("/api/v1/training/bind")
        .add_header("x-training-admin-token", "tok123")
        .json(&json!({"wecom_userid": wid}))
        .await;
    assert_eq!(r3.status_code(), StatusCode::OK, "{}", r3.text());
    let dn: String = sqlx::query_scalar(
        "SELECT display_name FROM teacher_profiles WHERE wecom_userid = $1",
    )
    .bind(&wid)
    .fetch_one(&state.db)
    .await
    .unwrap();
    assert_eq!(dn, "王老师", "re-bind without display_name must not reset the stored name");
    let full: Option<String> = sqlx::query_scalar(
        "SELECT u.full_name FROM users u JOIN teacher_profiles tp ON u.id = tp.user_id WHERE tp.wecom_userid = $1",
    )
    .bind(&wid)
    .fetch_one(&state.db)
    .await
    .unwrap();
    assert_eq!(full.as_deref(), Some("王老师"), "users.full_name likewise untouched");
    // 测试卫生：本轮内自清教师账号（display_name「王老师」= 事故暴露的假教师类）
    cleanup_test_user_by_email(&state.db, format!("{wid}@wecom.local")).await;
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
    // 测试卫生：本轮内自清教师账号（CJK 截断分支：username 无 t6_ 锚点，唯 email 可精确清）
    cleanup_test_user_by_email(&_state.db, format!("{wid}@wecom.local")).await;
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
    let c1u = unique("c1u"); // 占位用户 email 留柄：测试末自清定位键（下同 wid2）
    sqlx::query(
        "INSERT INTO users (username, email, password_hash, full_name) VALUES ($1, $2, $3, $4)",
    )
    .bind(format!("wecom_{wid1}"))
    .bind(format!("{c1u}@t6.com"))
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
    // 测试卫生：本轮内自清两个占位用户（SQL 直插、无 profile，按精确 email 删）
    cleanup_test_user_by_email(&state.db, format!("{c1u}@t6.com")).await;
    cleanup_test_user_by_email(&state.db, format!("{wid2}@wecom.local")).await;
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
    // 测试卫生：本轮内自清教师账号（并发老师）
    cleanup_test_user_by_email(&state.db, format!("{wid}@wecom.local")).await;
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
    // 测试卫生：本轮内自清边界教师（edge_id 是跨轮固定字面量——上一轮残行在库时
    // 本轮 bind 走幂等 200 复用，可过；但与并发 sweep 删行竞态时 SELECT-after-DELETE
    // 后 INSERT 撞唯一索引 → 409 红，2026-09-15 16:45 瞬态失败的最可能身份。自清
    // 让固定字面量每轮归零，竞态窗口随之消失）
    cleanup_test_user_by_email(&state.db, format!("{edge_id}@wecom.local")).await;
    // 测试卫生：清理上一轮残留（cutoff 保护在飞测试，见 mod.rs）
    crate::teardown_test_data(&state).await;
}

/// SEC-3（终审必修）：/training/bind IP 级固定窗口限流（10/min/IP）。
/// 同 IP 第 11 次 → 429（red：修复前永远 401）；换 IP 不受前桶影响（per-IP key）。
/// key 取 Cf-Connecting-Ip 头（隧道场景；测试显式带头模拟）。限流先于 admin token
/// 校验——防 TRAINING__ADMIN_TOKEN 暴力枚举。
#[tokio::test]
async fn bind_rate_limited_per_ip_429() {
    let (server, _state, _admin, _member) = training_fixture_with_config_project("rate").await;
    let body = json!({"wecom_userid": unique("rl")});

    let call = |ip: &str| {
        server
            .post("/api/v1/training/bind")
            .add_header("cf-connecting-ip", ip)
            .add_header("x-training-admin-token", "wrong-token")
            .json(&body)
    };
    // 同 IP 10 次（错 token → 401，但也计数）
    for i in 0..10 {
        let r = call("203.0.113.7").await;
        assert_eq!(r.status_code(), StatusCode::UNAUTHORIZED, "within cap #{i}");
    }
    // 第 11 次同 IP → 429（red：修复前 401）
    let r = call("203.0.113.7").await;
    assert_eq!(r.status_code(), StatusCode::TOO_MANY_REQUESTS, "11th same-IP bind must 429");
    // 换 IP → 独立桶，不受前桶影响（仍 401：token 错）
    let r = call("198.51.100.9").await;
    assert_eq!(r.status_code(), StatusCode::UNAUTHORIZED, "different IP has its own bucket");
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
    // 2 items（pending/completed）；plan_new 1 天前（7d 窗内）3 items（viewed/watched/completed）
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
    for (i, status) in ["viewed", "watched", "completed"].iter().enumerate() {
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

    // A：全期 items=5（1 viewed/1 watched/2 completed），7d 窗 items=3（1 viewed/1 watched/1 completed）
    let ta = t3_find_teacher(teachers, &wid_a);
    assert_eq!(ta["display_name"], "甲老师");
    assert_eq!(ta["onboarding_state"], "surveyed");
    assert_eq!(ta["plans_total"], 2);
    assert_eq!(ta["items"], json!({"total": 5, "viewed": 1, "watched": 1, "completed": 2}));
    assert_eq!(ta["items_7d"], json!({"total": 3, "viewed": 1, "watched": 1, "completed": 1}));
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
    assert_eq!(tb["items"], json!({"total": 0, "viewed": 0, "watched": 0, "completed": 0}));
    assert_eq!(tb["items_7d"], json!({"total": 0, "viewed": 0, "watched": 0, "completed": 0}));
    assert_eq!(tb["last_active_at"], serde_json::Value::Null);
    assert_eq!(tb["last_ask_at"], serde_json::Value::Null);
    // 测试卫生：本轮内自清两名 t3_ 教师（t3_ 前缀同在 SWEEPS 域，自清逻辑一致）
    cleanup_test_user_by_email(&state.db, format!("{wid_a}@wecom.local")).await;
    cleanup_test_user_by_email(&state.db, format!("{wid_b}@wecom.local")).await;
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
    // 测试卫生：本轮内自清 t3_ 教师账号（周老师）
    cleanup_test_user_by_email(&state.db, format!("{wid}@wecom.local")).await;
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
    // 测试卫生：本轮内自清教师账号（冒烟老师）
    cleanup_test_user_by_email(&state.db, format!("{wid}@wecom.local")).await;
    // 测试卫生：清理上一轮残留（cutoff 保护在飞测试，见 mod.rs）
    crate::teardown_test_data(&state).await;
}

// ============ 视频学习任务 T1：GET /member-role + GET /media/search（两只读端点）============

/// 鉴权与参数校验矩阵：无 token → 401、错 token → 401（require_training_admin，
/// 同 /bind、/overview）；参数缺失 / 空串 / 纯空白 wecom_userid → 400（token 正确时）。
#[tokio::test]
async fn member_role_auth_and_param_validation() {
    let (server, _state, _admin, _member) = training_fixture_with_config_project("mrauth").await;

    // 无 token → 401
    let r = server.get("/api/v1/training/member-role?wecom_userid=whoever").await;
    assert_eq!(r.status_code(), StatusCode::UNAUTHORIZED);

    // 错 token → 401
    let r = server
        .get("/api/v1/training/member-role?wecom_userid=whoever")
        .add_header("x-training-admin-token", "wrong")
        .await;
    assert_eq!(r.status_code(), StatusCode::UNAUTHORIZED);

    // 缺参 → 400
    let r = server
        .get("/api/v1/training/member-role")
        .add_header("x-training-admin-token", "tok123")
        .await;
    assert_eq!(r.status_code(), StatusCode::BAD_REQUEST);

    // 空串 / 纯空白 → 400
    for bad in ["", "%20%20%20"] {
        let r = server
            .get(&format!("/api/v1/training/member-role?wecom_userid={bad}"))
            .add_header("x-training-admin-token", "tok123")
            .await;
        assert_eq!(r.status_code(), StatusCode::BAD_REQUEST, "blank wecom_userid must 400: {bad:?}");
    }
    // 测试卫生：清理上一轮残留（cutoff 保护在飞测试，见 mod.rs）
    crate::teardown_test_data(&_state).await;
}

/// 200 面：bind 造一名教师（角色恒 'member'）→ 精确 / 小写 / 大写三种形态查询均
/// 200，role 与 team_members 落库值一致（大小写归一 = SQL lower()，019 迁移/bind
/// 同一语义——Wendy/wendy 双档案事故的回归锚）。动态比对 DB 值，不硬编码断言。
#[tokio::test]
async fn member_role_returns_team_role_case_insensitively() {
    let (server, state, _admin, _member) = training_fixture_with_config_project("mrcase").await;
    let wid = unique("mrl"); // 小写 canonical 形态落库（t6_ 前缀，SWEEPS 可清）
    bind_t3_teacher(&server, &wid, "角色老师").await;

    let db_role: String = sqlx::query_scalar(
        "SELECT tm.role FROM teacher_profiles tp \
         JOIN team_members tm ON tm.team_id = (SELECT team_id FROM projects WHERE id = $1) \
           AND tm.user_id = tp.user_id \
         WHERE lower(tp.wecom_userid) = lower($2)",
    )
    .bind(state.config.training.project_id.unwrap())
    .bind(&wid)
    .fetch_one(&state.db)
    .await
    .unwrap();

    for form in [wid.clone(), wid.to_uppercase()] {
        let r = server
            .get(&format!(
                "/api/v1/training/member-role?wecom_userid={}",
                form // 查询串 ASCII（unique() 产物），无需编码
            ))
            .add_header("x-training-admin-token", "tok123")
            .await;
        assert_eq!(r.status_code(), StatusCode::OK, "form={form}");
        let v = r.json::<serde_json::Value>();
        assert_eq!(
            v["role"].as_str().unwrap(),
            db_role,
            "endpoint role must equal team_members.role for {form}"
        );
    }
    // 测试卫生：本轮内自清教师账号（角色老师）
    cleanup_test_user_by_email(&state.db, format!("{wid}@wecom.local")).await;
    // 测试卫生：清理上一轮残留（cutoff 保护在飞测试，见 mod.rs）
    crate::teardown_test_data(&state).await;
}

/// 404 面：从未绑定的 userid → 404；**有 teacher_profiles 行但不在 TRAINING
/// 项目 team** 的真教师（fixture team 是新造的，生产库 27 条档案无一在列，纯
/// 只读取一行）→ 同样 404——端点不区分两种缺失（防探测口径，同 get_plan）。
#[tokio::test]
async fn member_role_404_when_unbound_or_outside_team() {
    let (server, state, _admin, _member) = training_fixture_with_config_project("mr404").await;
    let team_id: i32 =
        sqlx::query_scalar("SELECT team_id FROM projects WHERE id = $1")
            .bind(state.config.training.project_id.unwrap())
            .fetch_one(&state.db)
            .await
            .unwrap();

    // 从未绑定 → 404
    let r = server
        .get(&format!(
            "/api/v1/training/member-role?wecom_userid={}",
            unique("ghost")
        ))
        .add_header("x-training-admin-token", "tok123")
        .await;
    assert_eq!(r.status_code(), StatusCode::NOT_FOUND);

    // 档案存在但不在本 team（只读取生产库任一 team 外教师；无档案的空库跳过）
    let outsider: Option<String> = sqlx::query_scalar(
        "SELECT tp.wecom_userid FROM teacher_profiles tp \
         WHERE NOT EXISTS (SELECT 1 FROM team_members tm \
           WHERE tm.team_id = $1 AND tm.user_id = tp.user_id) \
         ORDER BY tp.id LIMIT 1",
    )
    .bind(team_id)
    .fetch_optional(&state.db)
    .await
    .unwrap();
    if let Some(wid) = outsider {
        let r = server
            .get(&format!(
                "/api/v1/training/member-role?wecom_userid={}",
                urlencoding_lite(&wid)
            ))
            .add_header("x-training-admin-token", "tok123")
            .await;
        assert_eq!(
            r.status_code(),
            StatusCode::NOT_FOUND,
            "teacher outside the training team must 404: {wid}"
        );
    }
    // 测试卫生：清理上一轮残留（cutoff 保护在飞测试，见 mod.rs）
    crate::teardown_test_data(&state).await;
}

/// 查询串百分比编码（仅测试用：wecom_userid 可能含非 ASCII，如 bind 截断测试的
/// CJK 档案）。serde_urlencoded 形态足够——只需与 axum Query 的解码对称。
fn urlencoding_lite(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// 鉴权与参数校验矩阵（media/search）：无/错 token → 401；q 缺失/空白 → 400；
/// 无命中关键词 → 200 `[]`（空数组而非 404/null）。
#[tokio::test]
async fn media_search_auth_and_param_validation() {
    let (server, _state, _admin, _member) = training_fixture_with_config_project("msauth").await;

    let r = server.get("/api/v1/training/media/search?q=x").await;
    assert_eq!(r.status_code(), StatusCode::UNAUTHORIZED);

    let r = server
        .get("/api/v1/training/media/search?q=x")
        .add_header("x-training-admin-token", "wrong")
        .await;
    assert_eq!(r.status_code(), StatusCode::UNAUTHORIZED);

    // q 缺失 / 空白 → 400
    let r = server
        .get("/api/v1/training/media/search")
        .add_header("x-training-admin-token", "tok123")
        .await;
    assert_eq!(r.status_code(), StatusCode::BAD_REQUEST);
    for bad in ["", "%20%20"] {
        let r = server
            .get(&format!("/api/v1/training/media/search?q={bad}"))
            .add_header("x-training-admin-token", "tok123")
            .await;
        assert_eq!(r.status_code(), StatusCode::BAD_REQUEST, "blank q must 400: {bad:?}");
    }

    // 无命中 → 200 []
    let r = server
        .get("/api/v1/training/media/search?q=no_such_media_keyword_zz9x")
        .add_header("x-training-admin-token", "tok123")
        .await;
    assert_eq!(r.status_code(), StatusCode::OK);
    assert_eq!(
        r.json::<serde_json::Value>(),
        serde_json::json!([]),
        "no hit must be an empty array"
    );
    // 测试卫生：清理上一轮残留（cutoff 保护在飞测试，见 mod.rs）
    crate::teardown_test_data(&_state).await;
}

/// 命中面（生产库只读，~983 行 media）：slug 精确关键词命中（含字段回显）；
/// 转录页标题关键词命中（LEFT JOIN 等值 JOIN，title 回显 wp.title）；
/// transcript_page_path IS NULL 行 title 回落 slug（COALESCE 语义）。
#[tokio::test]
async fn media_search_hits_slug_title_and_null_transcript_fallback() {
    let (server, _state, _admin, _member) = training_fixture_with_config_project("mshit").await;
    let tok = "tok123";

    // 1) slug 命中：取任一 media 行，q = 完整 slug（ILIKE %slug% 至少命中自身）
    let (slug, tp_path, duration_s): (String, Option<String>, i32) = sqlx::query_as(
        "SELECT slug, transcript_page_path, duration_s FROM media_assets ORDER BY id LIMIT 1",
    )
    .fetch_one(&_state.db)
    .await
    .unwrap();
    let r = server
        .get(&format!(
            "/api/v1/training/media/search?q={}",
            urlencoding_lite(&slug)
        ))
        .add_header("x-training-admin-token", tok)
        .await;
    assert_eq!(r.status_code(), StatusCode::OK);
    let items = r.json::<serde_json::Value>();
    let arr = items.as_array().unwrap();
    assert!(!arr.is_empty(), "slug '{slug}' must hit at least itself");
    let hit = arr
        .iter()
        .find(|it| it["slug"] == slug)
        .unwrap_or_else(|| panic!("slug '{slug}' missing from results"));
    let expected_tp = match &tp_path {
        Some(p) => serde_json::Value::from(p.as_str()),
        None => serde_json::Value::Null,
    };
    assert_eq!(
        hit["transcript_page_path"], expected_tp,
        "transcript_page_path passthrough"
    );
    assert_eq!(hit["duration_s"].as_i64().unwrap(), duration_s as i64, "duration_s passthrough");
    assert!(!hit["title"].as_str().unwrap_or_default().is_empty(), "title never null (COALESCE slug)");

    // 2) 转录页标题命中：取任一 JOIN 得到非空标题的行，q = 完整标题
    let (jslug, jtitle): (String, String) = sqlx::query_as(
        "SELECT ma.slug, wp.title FROM media_assets ma \
         JOIN wiki_pages wp ON wp.path = ma.transcript_page_path \
         WHERE COALESCE(wp.title, '') <> '' ORDER BY ma.id LIMIT 1",
    )
    .fetch_one(&_state.db)
    .await
    .unwrap();
    let r = server
        .get("/api/v1/training/media/search")
        .add_query_param("q", &jtitle) // add_query_param 走 serde_urlencoded，中文安全
        .add_header("x-training-admin-token", tok)
        .await;
    assert_eq!(r.status_code(), StatusCode::OK);
    let arr = r.json::<serde_json::Value>().as_array().unwrap().clone();
    let hit = arr
        .iter()
        .find(|it| it["slug"] == jslug)
        .unwrap_or_else(|| panic!("slug '{jslug}' missing from title '{jtitle}' hits"));
    assert_eq!(hit["title"], jtitle, "title hit must echo the wiki page title");

    // 3) NULL transcript 回落：任一 transcript_page_path IS NULL 行，title == slug
    let nslug: String = sqlx::query_scalar(
        "SELECT slug FROM media_assets WHERE transcript_page_path IS NULL ORDER BY id LIMIT 1",
    )
    .fetch_one(&_state.db)
    .await
    .unwrap();
    let r = server
        .get(&format!(
            "/api/v1/training/media/search?q={}",
            urlencoding_lite(&nslug)
        ))
        .add_header("x-training-admin-token", tok)
        .await;
    assert_eq!(r.status_code(), StatusCode::OK);
    let arr = r.json::<serde_json::Value>().as_array().unwrap().clone();
    let hit = arr
        .iter()
        .find(|it| it["slug"] == nslug)
        .unwrap_or_else(|| panic!("null-transcript slug '{nslug}' missing from its own hits"));
    assert_eq!(hit["title"], nslug, "title must fall back to slug when transcript page is NULL");
    assert_eq!(hit["transcript_page_path"], serde_json::Value::Null);
    // 测试卫生：清理上一轮残留（cutoff 保护在飞测试，见 mod.rs）
    crate::teardown_test_data(&_state).await;
}

/// 相关度排序钉子（T6 试跑 LOE 大水漫灌事故的回归防御，max 评审 Important）：
/// q 同时命中「转录页标题」与「仅 slug」两行时，标题命中（tier 0）必须排在
/// 仅 slug 命中（tier 1）之前——删掉 ORDER BY CASE 分层此断言即红。
/// 夹具自造自清（SWEEPS media 前缀兜底），只引用现有 wiki_pages.path 不写该表。
#[tokio::test]
async fn media_search_orders_title_hits_before_slug_only_hits() {
    let (server, state, _admin, _member) = training_fixture_with_config_project("msord").await;
    let tok = "tok123";

    // 借一行现有转录页作标题源（只读 path/title，不写 wiki_pages）
    let (page_path, title): (String, String) = sqlx::query_as(
        "SELECT path, title FROM wiki_pages WHERE COALESCE(title, '') <> '' ORDER BY id LIMIT 1",
    )
    .fetch_one(&state.db)
    .await
    .unwrap();
    let token: String = title.chars().take(6).collect();

    // F_title：transcript_page_path 指向该页 → wp.title 含 token → tier 0；
    // F_slug：NULL 转录页 + slug 内嵌 token → 仅 slug 命中 → tier 1
    let base = unique("ord");
    let f_title = format!("{base}ttl");
    let f_slug = format!("{base}slu_{}", token);
    for (slug, tp) in [(&f_title, Some(page_path.as_str())), (&f_slug, None)] {
        sqlx::query(
            "INSERT INTO media_assets (slug, media_ref, duration_s, kind, transcript_page_path) \
             VALUES ($1, '/tmp/nonexistent.mp4', 0, 'video', $2)",
        )
        .bind(slug)
        .bind(tp)
        .execute(&state.db)
        .await
        .unwrap();
    }

    let r = server
        .get("/api/v1/training/media/search")
        .add_query_param("q", &token)
        .add_header("x-training-admin-token", tok)
        .await;
    assert_eq!(r.status_code(), StatusCode::OK);
    let arr = r.json::<serde_json::Value>().as_array().unwrap().clone();
    let pos = |s: &str| arr.iter().position(|it| it["slug"] == s);
    let i_title = pos(&f_title).unwrap_or_else(|| panic!("title-hit fixture '{f_title}' missing from results"));
    let i_slug = pos(&f_slug).unwrap_or_else(|| panic!("slug-only fixture '{f_slug}' missing from results"));
    assert!(
        i_title < i_slug,
        "title hit (idx {i_title}) must rank before slug-only hit (idx {i_slug})"
    );

    // 本轮内自清（SWEEPS media 前缀清扫兜底）
    sqlx::query("DELETE FROM media_assets WHERE slug = ANY($1)")
        .bind(&[f_title, f_slug])
        .execute(&state.db)
        .await
        .unwrap();
    // 测试卫生：清理上一轮残留（cutoff 保护在飞测试，见 mod.rs）
    crate::teardown_test_data(&state).await;
}

// ============ T1b 补遗：GET /training/roster（教师名册检索，仅两键）============

/// 反泄漏硬契约钉子：响应条目的键**恰好** {wecom_userid, display_name}——
/// 任何人往 RosterItem 加 progress/计数/role 等额外字段即红（overview 的
/// 逐教师聚合不进主管分享面）。
fn assert_roster_keys_exact(item: &serde_json::Value) {
    let keys = item.as_object().expect("roster item must be an object");
    assert_eq!(
        keys.len(),
        2,
        "roster item must have exactly 2 keys (anti-leak contract): {:?}",
        keys.keys().collect::<Vec<_>>()
    );
    assert!(
        keys.contains_key("wecom_userid") && keys.contains_key("display_name"),
        "roster keys must be exactly {{wecom_userid, display_name}}: {:?}",
        keys.keys().collect::<Vec<_>>()
    );
}

/// 鉴权与参数校验矩阵：无/错 token → 401；q 缺失/空白 → 400；无命中 → 200 `[]`
/// （检索语义，非 member-role 的点查 404）。
#[tokio::test]
async fn roster_auth_and_param_validation() {
    let (server, _state, _admin, _member) = training_fixture_with_config_project("rauth").await;

    // 无 token → 401
    let r = server.get("/api/v1/training/roster?q=x").await;
    assert_eq!(r.status_code(), StatusCode::UNAUTHORIZED);

    // 错 token → 401
    let r = server
        .get("/api/v1/training/roster?q=x")
        .add_header("x-training-admin-token", "wrong")
        .await;
    assert_eq!(r.status_code(), StatusCode::UNAUTHORIZED);

    // q 缺失 / 空白 → 400
    let r = server
        .get("/api/v1/training/roster")
        .add_header("x-training-admin-token", "tok123")
        .await;
    assert_eq!(r.status_code(), StatusCode::BAD_REQUEST);
    for bad in ["", "%20%20"] {
        let r = server
            .get(&format!("/api/v1/training/roster?q={bad}"))
            .add_header("x-training-admin-token", "tok123")
            .await;
        assert_eq!(r.status_code(), StatusCode::BAD_REQUEST, "blank q must 400: {bad:?}");
    }

    // 无命中 → 200 []
    let r = server
        .get("/api/v1/training/roster?q=no_such_teacher_keyword_zz9x")
        .add_header("x-training-admin-token", "tok123")
        .await;
    assert_eq!(r.status_code(), StatusCode::OK);
    assert_eq!(
        r.json::<serde_json::Value>(),
        serde_json::json!([]),
        "no hit must be an empty array"
    );
    // 测试卫生：清理上一轮残留（cutoff 保护在飞测试，见 mod.rs）
    crate::teardown_test_data(&_state).await;
}

/// 命中面（生产库只读）：display_name 完整命中；wecom_userid 子串命中
/// （取 display_name ≠ wecom_userid 的教师，隔离出 wecom_userid ILIKE 分支——
/// bind 缺省回填的教师两字段同值，两分支不可分辨）；两命中条目均钉两键契约。
#[tokio::test]
async fn roster_hits_display_name_and_wecom_userid_with_exact_keys() {
    let (server, _state, _admin, _member) = training_fixture_with_config_project("rhit").await;

    // 动态取一名 display_name 非空且 ≠ wecom_userid 的既有教师（生产 51 行满足）
    let (wid, dn): (String, String) = sqlx::query_as(
        "SELECT wecom_userid, display_name FROM teacher_profiles \
         WHERE COALESCE(display_name, '') <> '' AND display_name IS DISTINCT FROM wecom_userid \
         ORDER BY id LIMIT 1",
    )
    .fetch_one(&_state.db)
    .await
    .unwrap();

    // 1) display_name 命中：q = 完整 display_name（add_query_param 中文安全编码）
    let r = server
        .get("/api/v1/training/roster")
        .add_query_param("q", &dn)
        .add_header("x-training-admin-token", "tok123")
        .await;
    assert_eq!(r.status_code(), StatusCode::OK);
    let arr = r.json::<serde_json::Value>().as_array().unwrap().clone();
    assert!(!arr.is_empty(), "display_name '{dn}' must hit at least itself");
    let hit = arr
        .iter()
        .find(|it| it["wecom_userid"] == wid)
        .unwrap_or_else(|| panic!("teacher '{wid}' missing from display_name '{dn}' hits"));
    assert_eq!(hit["display_name"], dn, "display_name must be echoed as stored");
    assert_roster_keys_exact(hit);

    // 2) wecom_userid 子串命中：display_name ≠ wid ⇒ 命中只能来自 wecom_userid 分支
    // （取中段子串，纯 ASCII 段；若含 '_' 仅放宽 LIKE 匹配，contains 断言不受影响）
    let sub = if wid.chars().count() > 12 {
        wid.chars().skip(2).take(8).collect::<String>()
    } else {
        wid.clone()
    };
    let r = server
        .get(&format!(
            "/api/v1/training/roster?q={}",
            urlencoding_lite(&sub)
        ))
        .add_header("x-training-admin-token", "tok123")
        .await;
    assert_eq!(r.status_code(), StatusCode::OK);
    let arr = r.json::<serde_json::Value>().as_array().unwrap().clone();
    let hit = arr
        .iter()
        .find(|it| it["wecom_userid"] == wid)
        .unwrap_or_else(|| panic!("teacher '{wid}' missing from wecom_userid substring '{sub}' hits"));
    assert_eq!(hit["display_name"], dn);
    assert_roster_keys_exact(hit);
    // 测试卫生：清理上一轮残留（cutoff 保护在飞测试，见 mod.rs）
    crate::teardown_test_data(&_state).await;
}
