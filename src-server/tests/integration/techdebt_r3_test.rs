//! Task 6（M3，r3 技术债收编）：服务端行为回归矩阵。
//! - items cap：POST /training/plans items>50 → 400（50 边界仍 201）；
//! - 限流：GET /s/:code 30 次/分钟（key=code）、POST /t/:token/seen|complete
//!   beacon 60 次/分钟（key=token hash 前 16 hex，seen/complete 共桶）→ 429
//!   TooManyRequests；其余 key（他 code / 他 token）不受影响；
//! - 归档事件闸：complete_item（training.rs）与 /t/ seen/complete（"viewed"）
//!   对 archived plan → 404，零事件写入（r3 Minor #4：归档 = 吊销，与 /s/ 门禁
//!   语义一致）。
//! fixture 模式：training 段经「改 config 后 create_app」注入（learning_api_test
//! 同款）；unique() 用独立计数器 + `td*` tag 与 training_test 的 t6_ 前缀隔离。

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

/// 建 owner→team→project（app1）后注入 training 段建 app2，bind 一名教师。
/// 返回 (server, state, teacher_token, teacher_id)。
async fn td_fixture(tag: &str) -> (TestServer, llm_wiki_server::AppState, String, i64) {
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

    crate::ensure_test_jwt_secret();
    let mut cfg = llm_wiki_server::AppConfig::from_env().unwrap();
    cfg.training.project_id = Some(project_id);
    cfg.training.admin_token = "tok123".to_string();
    let (app2, state) = llm_wiki_server::create_app(cfg).await.unwrap();
    let server = TestServer::new(app2).unwrap();

    let wid = unique("tdw");
    let r = server
        .post("/api/v1/training/bind")
        .add_header("x-training-admin-token", "tok123")
        .json(&json!({"wecom_userid": wid, "display_name": "王老师"}))
        .await;
    assert_eq!(r.status_code(), StatusCode::OK);
    let v = r.json::<serde_json::Value>();
    let teacher = v["access_token"]
        .as_str()
        .unwrap()
        .to_string();
    let teacher_id = v["user"]["id"].as_i64().unwrap();
    (server, state, teacher, teacher_id)
}

/// 播种 media_assets（slug 全局唯一），返回 slug。
async fn seed_media(state: &llm_wiki_server::AppState, slug: &str) {
    sqlx::query(
        "INSERT INTO media_assets (slug, media_ref, duration_s, kind, chapters) \
         VALUES ($1, $2, 600, 'video', '[]')",
    )
    .bind(slug)
    .bind(format!("/tmp/{slug}.mp4"))
    .execute(&state.db)
    .await
    .unwrap();
}

/// 建 plan（N 个 media 项共用同一 slug——target_ref 合法即可），返回 (link, first_item_id)。
async fn make_plan(
    server: &TestServer,
    teacher: &str,
    slug: &str,
    n_items: usize,
) -> (String, i64) {
    let items: Vec<serde_json::Value> = (0..n_items)
        .map(|i| json!({"kind": "media", "target_ref": slug, "label": format!("条目{i}")}))
        .collect();
    let r = server
        .post("/api/v1/training/plans")
        .add_header("authorization", bearer(teacher))
        .json(&json!({"title": "r3技术债", "origin": "chat", "period_key": null, "items": items}))
        .await;
    assert_eq!(r.status_code(), StatusCode::CREATED, "plan create must succeed");
    let v = r.json::<serde_json::Value>();
    let link = v["link"].as_str().unwrap().to_string();
    let item_id = v["items"][0]["id"].as_i64().unwrap();
    (link, item_id)
}

/// 解析 /s/<code> → (code, token)：GET /s/:code 303 → Location /t/<token>。
async fn resolve_short_link(server: &TestServer, link: &str) -> (String, String) {
    let code = link.strip_prefix("/s/").expect("link is /s/<code>").to_string();
    let r = server.get(&format!("/s/{code}")).await;
    assert_eq!(r.status_code(), StatusCode::SEE_OTHER, "GET /s/:code must 303");
    let loc = r
        .headers()
        .get("location")
        .and_then(|v| v.to_str().ok())
        .expect("Location header")
        .to_string();
    let token = loc.strip_prefix("/t/").expect("Location is /t/<token>").to_string();
    (code, token)
}

/// items cap：>50 → 400（VALIDATION_FAILED 文案含 items 上限）；恰 50 → 201（边界含）。
#[tokio::test]
async fn plan_items_over_50_rejected() {
    let (server, state, teacher, teacher_id) = td_fixture("tdcap").await;
    let slug = unique("capmd");
    seed_media(&state, &slug).await;

    // 51 项 → 400
    let r = server
        .post("/api/v1/training/plans")
        .add_header("authorization", bearer(&teacher))
        .json(&json!({"title": "超限计划", "origin": "chat", "period_key": null,
                      "items": (0..51).map(|i| json!({"kind": "media", "target_ref": slug, "label": format!("条目{i}")})).collect::<Vec<_>>()}))
        .await;
    assert_eq!(r.status_code(), StatusCode::BAD_REQUEST, "51 items must be rejected");
    let body = r.json::<serde_json::Value>();
    assert_eq!(body["error"]["code"], "VALIDATION_FAILED");
    assert!(
        body["error"]["message"].as_str().unwrap().contains("items"),
        "error message should mention items cap: {}",
        body["error"]["message"]
    );
    // 零半写：该教师此时 plans 数为 0（按 user_id 精确计——并行测试的教师互不干扰）
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM learning_plans WHERE user_id = $1")
        .bind(teacher_id as i32)
        .fetch_one(&state.db)
        .await
        .unwrap();
    assert_eq!(n, 0, "rejected request must not write any plan");

    // 边界：恰 50 项 → 201
    let (_link, _item) = make_plan(&server, &teacher, &slug, 50).await;
}

/// /s/ 限流：同 code 第 31 次（含第 61 次）→ 429 TooManyRequests；他 code 不受影响。
#[tokio::test]
async fn s_redirect_rate_limited_30_per_minute() {
    let (server, state, teacher, _tid) = td_fixture("tdrls").await;
    let slug = unique("rlmd");
    seed_media(&state, &slug).await;
    let (link1, _item1) = make_plan(&server, &teacher, &slug, 1).await;
    let code1 = link1.strip_prefix("/s/").unwrap().to_string();

    // 1..=30 次：303 正常
    for i in 1..=30 {
        let r = server.get(&format!("/s/{code1}")).await;
        assert_eq!(r.status_code(), StatusCode::SEE_OTHER, "request #{i} within cap must 303");
    }
    // 第 31 次 → 429（30 次/分钟）
    let r = server.get(&format!("/s/{code1}")).await;
    assert_eq!(r.status_code(), StatusCode::TOO_MANY_REQUESTS, "31st /s/ hit must 429");
    let body = r.json::<serde_json::Value>();
    assert_eq!(body["error"]["code"], "TOO_MANY_REQUESTS", "429 body carries the new error code");
    // 第 61 次 → 仍 429（brief Step 1：61 次 /s/ → 429）
    for _ in 32..=60 {
        let r = server.get(&format!("/s/{code1}")).await;
        assert_eq!(r.status_code(), StatusCode::TOO_MANY_REQUESTS);
    }
    let r = server.get(&format!("/s/{code1}")).await;
    assert_eq!(r.status_code(), StatusCode::TOO_MANY_REQUESTS, "61st /s/ must stay 429");

    // 其余 key 不受影响：他 plan 的 code 照常 303
    let (link2, _item2) = make_plan(&server, &teacher, &slug, 1).await;
    let code2 = link2.strip_prefix("/s/").unwrap().to_string();
    let r = server.get(&format!("/s/{code2}")).await;
    assert_eq!(r.status_code(), StatusCode::SEE_OTHER, "other code unaffected by exhausted key");
}

/// beacon 限流：同 token seen 第 61 次 → 429；seen/complete 共桶（耗尽后 complete 也 429）；
/// 他 token 不受影响。
#[tokio::test]
async fn beacon_seen_rate_limited_60_per_minute() {
    let (server, state, teacher, _tid) = td_fixture("tdrlb").await;
    let slug = unique("rlmd");
    seed_media(&state, &slug).await;
    let (link1, item1) = make_plan(&server, &teacher, &slug, 1).await;
    let (_code1, token1) = resolve_short_link(&server, &link1).await;

    // 页面级 seen（空 body）：1..=60 次 200
    for i in 1..=60 {
        let r = server.post(&format!("/t/{token1}/seen")).await;
        assert_eq!(r.status_code(), StatusCode::OK, "seen #{i} within cap must 200");
    }
    // 第 61 次 → 429（60 次/分钟）
    let r = server.post(&format!("/t/{token1}/seen")).await;
    assert_eq!(r.status_code(), StatusCode::TOO_MANY_REQUESTS, "61st seen must 429");

    // seen/complete 共桶（key 同为 token）：seen 耗尽后 complete 也 429，零事件写入
    let r = server
        .post(&format!("/t/{token1}/complete"))
        .content_type("application/json")
        .json(&json!({"item_id": item1}))
        .await;
    assert_eq!(r.status_code(), StatusCode::TOO_MANY_REQUESTS, "complete shares the token bucket");
    let st: String = sqlx::query_scalar("SELECT status FROM learning_items WHERE id = $1")
        .bind(item1)
        .fetch_one(&state.db)
        .await
        .unwrap();
    assert_eq!(st, "pending", "rate-limited complete must not write projection");
    let n_complete: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM learning_events WHERE item_id = $1 AND event_type = 'complete'")
            .bind(item1)
            .fetch_one(&state.db)
            .await
            .unwrap();
    assert_eq!(n_complete, 0, "rate-limited complete must not write events");

    // 其余 key 不受影响：他 plan 的 token seen 照常 200
    let (link2, _item2) = make_plan(&server, &teacher, &slug, 1).await;
    let (_code2, token2) = resolve_short_link(&server, &link2).await;
    let r = server.post(&format!("/t/{token2}/seen")).await;
    assert_eq!(r.status_code(), StatusCode::OK, "other token unaffected by exhausted key");
}

/// 归档事件闸（r3 Minor #4）：archived plan 上 training complete_item 与 /t/ seen/
/// complete（viewed）一律 404，零事件写入、投影不动（与 /s/ 归档吊销语义一致）。
#[tokio::test]
async fn archived_plan_complete_and_viewed_404() {
    let (server, state, teacher, _tid) = td_fixture("tdarc").await;
    let slug = unique("arcmd");
    seed_media(&state, &slug).await;
    let (link, item) = make_plan(&server, &teacher, &slug, 1).await;
    let (code, token) = resolve_short_link(&server, &link).await;

    // 归档（API 层等价物：UPDATE status='archived'）
    sqlx::query("UPDATE learning_plans SET status = 'archived' WHERE status = 'active' AND id = (SELECT plan_id FROM learning_items WHERE id = $1)")
        .bind(item)
        .execute(&state.db)
        .await
        .unwrap();

    // /s/ 归档吊销（既有语义锚点）
    let r = server.get(&format!("/s/{code}")).await;
    assert_eq!(r.status_code(), StatusCode::NOT_FOUND, "archived /s/ must 404");

    // training.rs complete_item（r3 收编点）：archived → 404
    let r = server
        .post(&format!("/api/v1/training/items/{item}/complete"))
        .add_header("authorization", bearer(&teacher))
        .await;
    assert_eq!(r.status_code(), StatusCode::NOT_FOUND, "training complete on archived plan must 404");

    // /t/ viewed（seen）与 complete：archived → 404（与 /s/ 门禁语义一致）
    let r = server.post(&format!("/t/{token}/seen")).await;
    assert_eq!(r.status_code(), StatusCode::NOT_FOUND, "archived seen must 404");
    let r = server
        .post(&format!("/t/{token}/complete"))
        .content_type("application/json")
        .json(&json!({"item_id": item}))
        .await;
    assert_eq!(r.status_code(), StatusCode::NOT_FOUND, "archived complete must 404");

    // 零事件写入 + 投影不动
    let n_ev: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM learning_events WHERE item_id = $1 AND event_type IN ('seen', 'complete')")
            .bind(item)
            .fetch_one(&state.db)
            .await
            .unwrap();
    assert_eq!(n_ev, 0, "archived plan must not record seen/complete events");
    let st: String = sqlx::query_scalar("SELECT status FROM learning_items WHERE id = $1")
        .bind(item)
        .fetch_one(&state.db)
        .await
        .unwrap();
    assert_eq!(st, "pending", "archived plan items untouched");
}
