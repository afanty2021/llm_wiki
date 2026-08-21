//! Task 7：learning API 批1 —— GET/PUT /api/v1/training/profile、
//! POST /api/v1/training/events（仅 ask）、GET /api/v1/training/progress。
//! Task 8：learning API 批2 —— POST/GET /plans、GET /plans/:id、POST /plans/:id/link、
//! POST /items/:id/complete、POST /progress/rebuild + services::projection
//! （complete_item / apply_seen / rebuild：事件→状态投影，单调守卫）。
//! 教师账号经 M1 的 /training/bind 建立（profile 行随 bind 落 pending）；
//! 普通注册用户无 teacher_profiles 行 → profile 404（跨用户隔离：token 即本人）。
//! unique() 隔离防重复跑撞唯一约束；「改 config 后 create_app」注入 training 段（training_test 同款）。

use axum::http::StatusCode;
use axum_test::TestServer;
use serde_json::json;
use std::sync::atomic::{AtomicU64, Ordering};

static COUNTER: AtomicU64 = AtomicU64::new(0);

fn unique(tag: &str) -> String {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    format!("t7_{}_{}_{}", tag, std::process::id(), n)
}

fn bearer(token: &str) -> String {
    format!("Bearer {}", token)
}

/// 当前 ISO 周串（与服务端 weekly period_key 自算同法：本地时区，`YYYY-Www`
/// 周数两位补零）。M3 Task 3 起 origin="weekly" 的 period_key 必须等于当周
/// （服务端权威源，错周/格式非法 400）——本文件经 **API** 建 weekly plan 的
/// 测试一律动态取当周（硬编码周串自次周起恒 400）；经 SQL 直插的播种类
/// 不经 API 校验，硬编码串仍可用。
fn current_iso_week() -> String {
    use chrono::Datelike as _;
    let iw = chrono::Local::now().iso_week();
    format!("{:04}-W{:02}", iw.year(), iw.week())
}

/// 建 owner→team→project（app1）后，用「改 config 后 create_app」注入 training 段
/// 得最终 server；再 bind 一名教师（profile 随之落 pending）。
/// 另注册一名普通用户（无 profile）。返回 (server, state, teacher_token, teacher_id, plain_token)。
async fn learning_fixture(
    tag: &str,
) -> (TestServer, llm_wiki_server::AppState, String, i64, String) {
    let (app1, _state1) = crate::setup_test_app().await;
    let s1 = TestServer::new(app1).unwrap();

    let owner_name = unique(tag);
    let owner = crate::register_user(
        &s1,
        &owner_name,
        &format!("{}@t7.com", owner_name),
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

    // 「改 config 后 create_app」（T3 模式，training_test 同款）。
    // registration_enabled 同 setup_test_app 显式 true（Task 6 r3：default.json 已翻
    // false，本 fixture 的 app2 也要注册 plain 用户——from_env 直读 default.json）
    crate::ensure_test_jwt_secret();
    let mut cfg = llm_wiki_server::AppConfig::from_env().unwrap();
    cfg.training.project_id = Some(project_id);
    cfg.training.admin_token = "tok123".to_string();
    cfg.auth.registration_enabled = true;
    let (app2, state) = llm_wiki_server::create_app(cfg).await.unwrap();
    let server = TestServer::new(app2).unwrap();

    // 普通注册用户（无 teacher_profiles 行）
    let plain_name = unique(tag);
    let plain = crate::register_user(
        &server,
        &plain_name,
        &format!("{}@t7.com", plain_name),
        "secret123",
    )
    .await;

    // bind 教师 → access token + profile(pending)
    let wid = unique("t7w");
    let r = server
        .post("/api/v1/training/bind")
        .add_header("x-training-admin-token", "tok123")
        .json(&json!({"wecom_userid": wid, "display_name": "王老师"}))
        .await;
    assert_eq!(r.status_code(), StatusCode::OK);
    let v = r.json::<serde_json::Value>();
    let teacher_token = v["access_token"].as_str().unwrap().to_string();
    let teacher_id = v["user"]["id"].as_i64().unwrap();

    (server, state, teacher_token, teacher_id, plain)
}

/// 矩阵：四个端点全部要求 access token——无 authorization 头 → 401。
#[tokio::test]
async fn auth_required_for_all_four_endpoints() {
    let (server, _state, _teacher, _tid, _plain) = learning_fixture("auth").await;

    let cases: Vec<(&str, axum::http::Method, serde_json::Value)> = vec![
        ("profile", axum::http::Method::GET, json!({})),
        ("profile", axum::http::Method::PUT, json!({})),
        ("events", axum::http::Method::POST, json!({"event_type":"ask"})),
        ("progress", axum::http::Method::GET, json!({})),
    ];
    for (path, method, body) in cases {
        let desc = format!("no-token {method} /training/{path} must be 401");
        let r = server
            .method(method, &format!("/api/v1/training/{path}"))
            .json(&body)
            .await;
        assert_eq!(r.status_code(), StatusCode::UNAUTHORIZED, "{desc}");
    }
}

/// 矩阵：仅 event_type="ask" 落库；其他（含 DB CHECK 允许但 API 不收的
/// view/complete/plan_created，及任意串）→ 400 且不落库；ask 带 payload 落原样、
/// 缺省 payload 落 {}；事件 user_id 必须是 token 本人（claims.sub）。
#[tokio::test]
async fn ask_event_persisted_and_other_types_rejected() {
    let (server, state, teacher, teacher_id, _plain) = learning_fixture("event").await;

    // 非 ask → 400（含内部事件类型 view/seen/complete/plan_created——它们由服务端
    // 内部路径产生，不开放给 API 客户端——以及任意非法串）
    for et in ["view", "seen", "complete", "plan_created", "bogus", "ASK"] {
        let r = server
            .post("/api/v1/training/events")
            .add_header("authorization", bearer(&teacher))
            .json(&json!({"event_type": et, "payload": {"q": "x"}}))
            .await;
        assert_eq!(r.status_code(), StatusCode::BAD_REQUEST, "event_type={et} must be 400");
    }
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM learning_events WHERE user_id = $1")
        .bind(teacher_id as i32)
        .fetch_one(&state.db)
        .await
        .unwrap();
    assert_eq!(n, 0, "rejected event types must not persist");

    // ask + payload → 200，返回事件 id；落库校验 user_id/event_type/payload
    let r = server
        .post("/api/v1/training/events")
        .add_header("authorization", bearer(&teacher))
        .json(&json!({"event_type": "ask", "payload": {"q": "分数怎么讲", "ctx": {"page": "fractions"}}}))
        .await;
    assert_eq!(r.status_code(), StatusCode::OK);
    let id = r.json::<serde_json::Value>()["id"].as_i64().expect("event id in response");
    assert!(id > 0);

    let row: (i32, String, serde_json::Value) = sqlx::query_as(
        "SELECT user_id, event_type, payload FROM learning_events WHERE id = $1",
    )
    .bind(id as i32)
    .fetch_one(&state.db)
    .await
    .unwrap();
    assert_eq!(row.0, teacher_id as i32, "event must be attributed to claims.sub");
    assert_eq!(row.1, "ask");
    assert_eq!(row.2, json!({"q": "分数怎么讲", "ctx": {"page": "fractions"}}));

    // ask 缺省 payload → 200，落 DB 默认 {}
    let r = server
        .post("/api/v1/training/events")
        .add_header("authorization", bearer(&teacher))
        .json(&json!({"event_type": "ask"}))
        .await;
    assert_eq!(r.status_code(), StatusCode::OK);
    let id2 = r.json::<serde_json::Value>()["id"].as_i64().unwrap();
    let p: serde_json::Value = sqlx::query_scalar("SELECT payload FROM learning_events WHERE id = $1")
        .bind(id2 as i32)
        .fetch_one(&state.db)
        .await
        .unwrap();
    assert_eq!(p, json!({}));

    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM learning_events WHERE user_id = $1")
        .bind(teacher_id as i32)
        .fetch_one(&state.db)
        .await
        .unwrap();
    assert_eq!(n, 2);
}

/// 矩阵：无档案用户 GET/PUT → 404；绑定教师 PUT→GET 往返（可变字段）；
/// onboarding_state 仅 pending→surveyed（反向 409、非法值 400）；超长字段 400；
/// 被拒请求不产生半写。跨用户隔离：他人有档案不影响本人 404。
#[tokio::test]
async fn profile_not_found_then_put_get_roundtrip() {
    let (server, _state, teacher, _tid, plain) = learning_fixture("profile").await;

    // 无档案（普通注册用户）：GET → 404、PUT → 404（profile 行只能由 bind 创建）
    let r = server
        .get("/api/v1/training/profile")
        .add_header("authorization", bearer(&plain))
        .await;
    assert_eq!(r.status_code(), StatusCode::NOT_FOUND);
    let r = server
        .put("/api/v1/training/profile")
        .add_header("authorization", bearer(&plain))
        .json(&json!({"subject": "数学"}))
        .await;
    assert_eq!(r.status_code(), StatusCode::NOT_FOUND);

    // 绑定教师初始档案：bind 写入的 display_name + 空档 + pending
    let r = server
        .get("/api/v1/training/profile")
        .add_header("authorization", bearer(&teacher))
        .await;
    assert_eq!(r.status_code(), StatusCode::OK);
    let v = r.json::<serde_json::Value>();
    assert_eq!(v["display_name"], "王老师");
    assert_eq!(v["subject"], serde_json::Value::Null);
    assert_eq!(v["grade_levels"], json!([]));
    assert_eq!(v["goals"], json!([]));
    assert_eq!(v["interests"], json!([]));
    assert_eq!(v["onboarding_state"], "pending");
    let wid = v["wecom_userid"].as_str().unwrap().to_string();
    assert!(wid.starts_with("t7_"), "wecom_userid comes from bind: {wid}");

    // PUT 可变字段 → 200 且响应即更新后档案
    let update = json!({
        "display_name": "王老师（数学）",
        "subject": "数学",
        "grade_levels": ["初一", "初二"],
        "goals": ["备课提效", "讲透分数"],
        "interests": ["可视化教学", "奥数"]
    });
    let r = server
        .put("/api/v1/training/profile")
        .add_header("authorization", bearer(&teacher))
        .json(&update)
        .await;
    assert_eq!(r.status_code(), StatusCode::OK);
    let v = r.json::<serde_json::Value>();
    assert_eq!(v["display_name"], "王老师（数学）");
    assert_eq!(v["subject"], "数学");
    assert_eq!(v["grade_levels"], json!(["初一", "初二"]));
    assert_eq!(v["goals"], json!(["备课提效", "讲透分数"]));
    assert_eq!(v["interests"], json!(["可视化教学", "奥数"]));
    assert_eq!(v["onboarding_state"], "pending");

    // GET 往返：读回与 PUT 响应一致
    let r = server
        .get("/api/v1/training/profile")
        .add_header("authorization", bearer(&teacher))
        .await;
    assert_eq!(r.status_code(), StatusCode::OK);
    assert_eq!(r.json::<serde_json::Value>(), v, "GET must roundtrip PUT result");

    // onboarding_state：pending→surveyed 允许
    let r = server
        .put("/api/v1/training/profile")
        .add_header("authorization", bearer(&teacher))
        .json(&json!({"onboarding_state": "surveyed"}))
        .await;
    assert_eq!(r.status_code(), StatusCode::OK);
    assert_eq!(r.json::<serde_json::Value>()["onboarding_state"], "surveyed");

    // surveyed→pending 反向 → 409（与当前状态冲突）
    let r = server
        .put("/api/v1/training/profile")
        .add_header("authorization", bearer(&teacher))
        .json(&json!({"onboarding_state": "pending"}))
        .await;
    assert_eq!(r.status_code(), StatusCode::CONFLICT);

    // 非法值 → 400
    let r = server
        .put("/api/v1/training/profile")
        .add_header("authorization", bearer(&teacher))
        .json(&json!({"onboarding_state": "done"}))
        .await;
    assert_eq!(r.status_code(), StatusCode::BAD_REQUEST);

    // 超长 display_name（101 CJK chars > VARCHAR(100)）→ 400；subject 同理
    let r = server
        .put("/api/v1/training/profile")
        .add_header("authorization", bearer(&teacher))
        .json(&json!({"display_name": "名".repeat(101)}))
        .await;
    assert_eq!(r.status_code(), StatusCode::BAD_REQUEST);
    let r = server
        .put("/api/v1/training/profile")
        .add_header("authorization", bearer(&teacher))
        .json(&json!({"subject": "s".repeat(101)}))
        .await;
    assert_eq!(r.status_code(), StatusCode::BAD_REQUEST);

    // 被拒后无半写：state 仍 surveyed、subject 未被超长写坏
    let r = server
        .get("/api/v1/training/profile")
        .add_header("authorization", bearer(&teacher))
        .await;
    let v = r.json::<serde_json::Value>();
    assert_eq!(v["onboarding_state"], "surveyed");
    assert_eq!(v["subject"], "数学");

    // 跨用户隔离（token 即本人）：教师档案已填，普通用户依旧 404
    let r = server
        .get("/api/v1/training/profile")
        .add_header("authorization", bearer(&plain))
        .await;
    assert_eq!(r.status_code(), StatusCode::NOT_FOUND);
}

/// 矩阵：progress 空态（plans/recent_events 均空数组）；有数据态——
/// plans 按 created_at DESC、items 计数（total/viewed/completed 按状态精确计数）、
/// recent_events 取最近 20 条（created_at DESC）；跨用户隔离（普通用户恒空态）。
/// 注：plans 创建 API 是 Task 8，这里直接 SQL 播种。
#[tokio::test]
async fn progress_empty_then_populated() {
    let (server, state, teacher, teacher_id, plain) = learning_fixture("prog").await;

    // 空态：两数组均为空（非 null）
    let r = server
        .get("/api/v1/training/progress")
        .add_header("authorization", bearer(&teacher))
        .await;
    assert_eq!(r.status_code(), StatusCode::OK);
    assert_eq!(r.json::<serde_json::Value>(), json!({"plans": [], "recent_events": []}));

    // 跨用户隔离：普通用户看到的也是自己的空态
    let r = server
        .get("/api/v1/training/progress")
        .add_header("authorization", bearer(&plain))
        .await;
    assert_eq!(r.status_code(), StatusCode::OK);
    assert_eq!(r.json::<serde_json::Value>(), json!({"plans": [], "recent_events": []}));

    // 播种：plan A（chat/active，较早）3 items（pending/viewed/completed）；
    // plan B（weekly/archived，较晚）0 items
    let now = chrono::Utc::now();
    let plan_a: i32 = sqlx::query_scalar(
        "INSERT INTO learning_plans (user_id, title, origin, period_key, status, created_at) \
         VALUES ($1, $2, 'chat', NULL, 'active', $3) RETURNING id",
    )
    .bind(teacher_id as i32)
    .bind("分数教学补强")
    .bind(now - chrono::Duration::hours(2))
    .fetch_one(&state.db)
    .await
    .unwrap();
    for (i, status) in ["pending", "viewed", "completed"].iter().enumerate() {
        sqlx::query(
            "INSERT INTO learning_items (plan_id, kind, target_ref, label, sort_order, status) \
             VALUES ($1, 'wiki_page', $2, $3, $4, $5)",
        )
        .bind(plan_a)
        .bind(format!("pages/{}.md", i))
        .bind(format!("item-{}", i))
        .bind(i as i32)
        .bind(status)
        .execute(&state.db)
        .await
        .unwrap();
    }
    let plan_b: i32 = sqlx::query_scalar(
        "INSERT INTO learning_plans (user_id, title, origin, period_key, status, created_at) \
         VALUES ($1, $2, 'weekly', '2026-W33', 'archived', $3) RETURNING id",
    )
    .bind(teacher_id as i32)
    .bind("第33周周计划")
    .bind(now - chrono::Duration::hours(1))
    .fetch_one(&state.db)
    .await
    .unwrap();

    // 播种 25 条 ask 事件，created_at 显式递增（防同秒 tie 破坏排序断言）
    for i in 0..25i64 {
        sqlx::query("INSERT INTO learning_events (user_id, event_type, payload, created_at) VALUES ($1, 'ask', $2, $3)")
            .bind(teacher_id as i32)
            .bind(json!({"n": i}))
            .bind(now - chrono::Duration::seconds(1000 - i * 10))
            .execute(&state.db)
            .await
            .unwrap();
    }

    // 有数据态
    let r = server
        .get("/api/v1/training/progress")
        .add_header("authorization", bearer(&teacher))
        .await;
    assert_eq!(r.status_code(), StatusCode::OK);
    let v = r.json::<serde_json::Value>();

    let plans = v["plans"].as_array().expect("plans array");
    assert_eq!(plans.len(), 2);
    // created_at DESC：新的（archived 周计划）在前
    assert_eq!(plans[0]["id"], plan_b as i64);
    assert_eq!(plans[0]["title"], "第33周周计划");
    assert_eq!(plans[0]["origin"], "weekly");
    assert_eq!(plans[0]["status"], "archived");
    assert_eq!(plans[0]["items"], json!({"total": 0, "viewed": 0, "completed": 0}));
    assert_eq!(plans[1]["id"], plan_a as i64);
    assert_eq!(plans[1]["title"], "分数教学补强");
    assert_eq!(plans[1]["origin"], "chat");
    assert_eq!(plans[1]["status"], "active");
    assert_eq!(plans[1]["items"], json!({"total": 3, "viewed": 1, "completed": 1}));

    // recent_events：恰好最近 20 条、最新在前（payload.n 标识）
    let evs = v["recent_events"].as_array().expect("recent_events array");
    assert_eq!(evs.len(), 20);
    assert_eq!(evs[0]["payload"]["n"], 24, "newest event first");
    assert_eq!(evs[19]["payload"]["n"], 5, "window covers last 20 of 25");
    assert_eq!(evs[0]["event_type"], "ask");
    assert!(evs[0]["created_at"].is_string(), "created_at serialized as string");
    assert!(evs[0]["id"].is_i64());
}

// ============ Task 8：plans / items / link / complete + 事件投影 ============

/// bind 一名教师（与 learning_fixture 同流程，可多次调用建多名教师做归属测试）。
async fn bind_teacher(server: &TestServer, wid: &str) -> (String, i64) {
    let r = server
        .post("/api/v1/training/bind")
        .add_header("x-training-admin-token", "tok123")
        .json(&json!({"wecom_userid": wid, "display_name": "测试教师"}))
        .await;
    assert_eq!(r.status_code(), StatusCode::OK);
    let v = r.json::<serde_json::Value>();
    (
        v["access_token"].as_str().unwrap().to_string(),
        v["user"]["id"].as_i64().unwrap(),
    )
}

/// 在 training.project_id 项目下播种一页 wiki 页（target_ref=wiki_page 的合法标的）。
async fn seed_wiki_page(state: &llm_wiki_server::AppState, path: &str) {
    let pid = state.config.training.project_id.unwrap();
    sqlx::query("INSERT INTO wiki_pages (project_id, path, title) VALUES ($1, $2, '测试页')")
        .bind(pid)
        .bind(path)
        .execute(&state.db)
        .await
        .unwrap();
}

/// 播种一个 media_assets 行（target_ref=media 的合法标的，slug 全局唯一）。
async fn seed_media_asset(state: &llm_wiki_server::AppState, slug: &str) {
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

fn plan_body(origin: &str, period_key: Option<&str>, items: serde_json::Value) -> serde_json::Value {
    json!({"title": "分数教学补强", "reason": "ask 之后生成", "origin": origin, "period_key": period_key, "items": items})
}

/// 矩阵：创建往返——201 {plan, items, link}；link 为 /t/<token> 且可用
/// verify_plan_link_token 验签得 (user_id, plan_id)；items 落库 pending/sort_order；
/// plan_created 事件恰一条；GET /plans 列表 + status 过滤；GET /plans/:id 往返；
/// POST /plans/:id/link 重签可验且与创建时不同；跨用户 GET → 404。
#[tokio::test]
async fn plan_create_roundtrip_link_and_get() {
    let (server, state, teacher, teacher_id, plain) = learning_fixture("plan8").await;

    let page_path = format!("concepts/frac-{}.md", unique("pg"));
    seed_wiki_page(&state, &page_path).await;
    let slug = unique("md");
    seed_media_asset(&state, &slug).await;

    let body = plan_body(
        "chat",
        None,
        json!([
            {"kind": "wiki_page", "target_ref": page_path, "label": "分数概念"},
            {"kind": "media", "target_ref": slug, "label": "分数视频",
             "timecode_start_s": 10, "timecode_end_s": 90}
        ]),
    );
    let r = server
        .post("/api/v1/training/plans")
        .add_header("authorization", bearer(&teacher))
        .json(&body)
        .await;
    assert_eq!(r.status_code(), StatusCode::CREATED, "first create must be 201");
    let v = r.json::<serde_json::Value>();

    let plan = &v["plan"];
    let plan_id = plan["id"].as_i64().expect("plan id");
    assert!(plan_id > 0);
    assert_eq!(plan["title"], "分数教学补强");
    assert_eq!(plan["origin"], "chat");
    assert_eq!(plan["status"], "active");
    assert_eq!(plan["period_key"], serde_json::Value::Null);
    assert_eq!(plan["reason"], "ask 之后生成");
    assert!(plan["created_at"].is_string());

    let items = v["items"].as_array().expect("items array");
    assert_eq!(items.len(), 2);
    assert_eq!(items[0]["kind"], "wiki_page");
    assert_eq!(items[0]["target_ref"], page_path);
    assert_eq!(items[0]["status"], "pending");
    assert_eq!(items[0]["sort_order"], 0);
    assert_eq!(items[0]["completed_at"], serde_json::Value::Null);
    assert_eq!(items[1]["kind"], "media");
    assert_eq!(items[1]["timecode_start_s"], 10);
    assert_eq!(items[1]["timecode_end_s"], 90);
    assert_eq!(items[1]["sort_order"], 1);
    let item0 = items[0]["id"].as_i64().unwrap();
    let item1 = items[1]["id"].as_i64().unwrap();

    // link 为 /s/<code>（Task 9b：对外只吐 10-char 短链，/t/ 由 GET /s/:code
    // 303 现签跳转）；短码本身不过期（capability URL，plan 存活期间每次点击
    // 现签新 7d token）。经跳转取回 token 验签：(user_id, plan_id) 与创建者/计划一致
    // （T6 typ=plan_link token）。
    let link = v["link"].as_str().expect("link field").to_string();
    assert!(link.starts_with("/s/"), "link must be /s/<code>: {link}");
    let code = link.strip_prefix("/s/").unwrap();
    assert_eq!(code.len(), 10, "code is exactly 10 chars: {code}");
    assert!(code.chars().all(|c| c.is_ascii_alphanumeric()), "code url-safe alnum: {code}");
    let r = server.get(&link).await;
    assert_eq!(r.status_code(), StatusCode::SEE_OTHER, "GET /s/:code must 303");
    let loc = r.headers().get("location").and_then(|v| v.to_str().ok()).unwrap().to_string();
    let token = loc.strip_prefix("/t/").expect("Location is /t/<token>");
    let (uid, plid) =
        llm_wiki_server::utils::verify_plan_link_token(token, state.config.jwt_secret()).unwrap();
    assert_eq!(uid, teacher_id as i32);
    assert_eq!(plid, plan_id as i32);

    // plan_created 事件恰一条（user 本人、item_id NULL、payload 携带 plan_id）
    let rows: Vec<(i32, Option<i32>, serde_json::Value)> = sqlx::query_as(
        "SELECT user_id, item_id, payload FROM learning_events \
         WHERE user_id = $1 AND event_type = 'plan_created'",
    )
    .bind(teacher_id as i32)
    .fetch_all(&state.db)
    .await
    .unwrap();
    assert_eq!(rows.len(), 1, "exactly one plan_created event");
    assert_eq!(rows[0].0, teacher_id as i32);
    assert_eq!(rows[0].1, None);
    assert_eq!(rows[0].2["plan_id"], plan_id);

    // GET /plans：列表含本计划；status 过滤（archived 不含 active；bogus → 400）
    let r = server
        .get("/api/v1/training/plans")
        .add_header("authorization", bearer(&teacher))
        .await;
    assert_eq!(r.status_code(), StatusCode::OK);
    let list = r.json::<serde_json::Value>();
    let arr = list.as_array().unwrap();
    assert!(arr.iter().any(|p| p["id"] == plan_id), "list contains plan");
    assert_eq!(arr[0]["items"]["total"], 2);

    let r = server
        .get("/api/v1/training/plans?status=archived")
        .add_header("authorization", bearer(&teacher))
        .await;
    assert_eq!(r.status_code(), StatusCode::OK);
    assert_eq!(r.json::<serde_json::Value>().as_array().unwrap().len(), 0);
    let r = server
        .get("/api/v1/training/plans?status=bogus")
        .add_header("authorization", bearer(&teacher))
        .await;
    assert_eq!(r.status_code(), StatusCode::BAD_REQUEST);

    // GET /plans/:id 往返：plan + items（排序 sort_order）
    let r = server
        .get(&format!("/api/v1/training/plans/{plan_id}"))
        .add_header("authorization", bearer(&teacher))
        .await;
    assert_eq!(r.status_code(), StatusCode::OK);
    let v2 = r.json::<serde_json::Value>();
    assert_eq!(v2["plan"]["id"], plan_id);
    let got = v2["items"].as_array().unwrap();
    assert_eq!(got.len(), 2);
    assert_eq!(got[0]["id"], item0);
    assert_eq!(got[1]["id"], item1);

    // 不存在的 plan → 404（本人）
    let r = server
        .get("/api/v1/training/plans/999999999")
        .add_header("authorization", bearer(&teacher))
        .await;
    assert_eq!(r.status_code(), StatusCode::NOT_FOUND);

    // POST /plans/:id/link 重签：同样吐 /s/ 短链（Task 9b），跳转现签 token 可验得
    // (user_id, plan_id)。注：不断言 token 必然不同——plan_link claims 无 iat/jti，
    // exp 为秒粒度，同秒内重签的 HS256 输出逐字节相同（确定性签名，语义上仍是有效
    // 重签：短码不过期，点击即现签 7d 窗口）。
    let r = server
        .post(&format!("/api/v1/training/plans/{plan_id}/link"))
        .add_header("authorization", bearer(&teacher))
        .await;
    assert_eq!(r.status_code(), StatusCode::OK);
    let link2 = r.json::<serde_json::Value>()["link"].as_str().unwrap().to_string();
    assert!(link2.starts_with("/s/"), "re-signed link must be /s/<code>: {link2}");
    assert_eq!(link2.strip_prefix("/s/").unwrap().len(), 10, "regen code 10 chars");
    let r = server.get(&link2).await;
    assert_eq!(r.status_code(), StatusCode::SEE_OTHER);
    let loc2 = r.headers().get("location").and_then(|v| v.to_str().ok()).unwrap().to_string();
    let token2 = loc2.strip_prefix("/t/").unwrap();
    let (uid2, plid2) =
        llm_wiki_server::utils::verify_plan_link_token(token2, state.config.jwt_secret()).unwrap();
    assert_eq!((uid2, plid2), (teacher_id as i32, plan_id as i32));

    // 跨用户：普通用户 token GET 他人 plan → 404（归属不泄漏 403）
    let r = server
        .get(&format!("/api/v1/training/plans/{plan_id}"))
        .add_header("authorization", bearer(&plain))
        .await;
    assert_eq!(r.status_code(), StatusCode::NOT_FOUND);
    let r = server
        .post(&format!("/api/v1/training/plans/{plan_id}/link"))
        .add_header("authorization", bearer(&plain))
        .await;
    assert_eq!(r.status_code(), StatusCode::NOT_FOUND);
}

/// period_key 幂等：同 (user, origin, period_key) 二次创建 → 200 且返回既有 plan
/// （标题/items 保持原样，不追加、不覆盖）；plan_created 不重复记；
/// origin 不同或 period_key 为 NULL 不受唯一索引约束（各自 201）。
#[tokio::test]
async fn plan_period_key_idempotent_second_create_returns_existing() {
    let (server, state, teacher, teacher_id, _plain) = learning_fixture("pkey").await;
    let page_path = format!("concepts/idem-{}.md", unique("pg"));
    seed_wiki_page(&state, &page_path).await;
    // M3：weekly period_key 服务端自算当周（错周 400）——动态取当周保幂等语义可测
    let pk = current_iso_week();

    let first = plan_body(
        "weekly",
        Some(&pk),
        json!([{"kind": "wiki_page", "target_ref": page_path, "label": "a"}]),
    );
    let r = server
        .post("/api/v1/training/plans")
        .add_header("authorization", bearer(&teacher))
        .json(&first)
        .await;
    assert_eq!(r.status_code(), StatusCode::CREATED);
    let v1 = r.json::<serde_json::Value>();
    let plan_id = v1["plan"]["id"].as_i64().unwrap();
    assert_eq!(v1["items"].as_array().unwrap().len(), 1);

    // 二次（不同标题/items）→ 200 同 id，内容保持既有
    let second = plan_body(
        "weekly",
        Some(&pk),
        json!([
            {"kind": "wiki_page", "target_ref": page_path, "label": "x"},
            {"kind": "wiki_page", "target_ref": page_path, "label": "y"}
        ]),
    );
    let mut second = second;
    second["title"] = json!("试图覆盖的标题");
    let r = server
        .post("/api/v1/training/plans")
        .add_header("authorization", bearer(&teacher))
        .json(&second)
        .await;
    assert_eq!(r.status_code(), StatusCode::OK, "second create must be 200");
    let v2 = r.json::<serde_json::Value>();
    assert_eq!(v2["plan"]["id"], plan_id, "same plan id");
    assert_eq!(v2["plan"]["title"], "分数教学补强", "existing title preserved");
    assert_eq!(v2["items"].as_array().unwrap().len(), 1, "items not appended");
    assert!(v2["link"].as_str().unwrap().starts_with("/s/"), "existing plan also gets a /s/ link");

    // plan_created 只记一次；items 行数仍 1
    let n: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM learning_events WHERE user_id = $1 AND event_type = 'plan_created'",
    )
    .bind(teacher_id as i32)
    .fetch_one(&state.db)
    .await
    .unwrap();
    assert_eq!(n, 1);
    let n_items: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM learning_items WHERE plan_id = $1")
        .bind(plan_id as i32)
        .fetch_one(&state.db)
        .await
        .unwrap();
    assert_eq!(n_items, 1);

    // 同 period_key 不同 origin → 不冲突（索引含 origin），201 新 plan。
    // origin=chat 不做周校验（M3 仅 weekly 自算）——任意串（含非当周）原样透传
    let mut other = plan_body(
        "chat",
        Some("2026-W33"),
        json!([{"kind": "wiki_page", "target_ref": page_path, "label": "b"}]),
    );
    other["title"] = json!("同 period 不同 origin");
    let r = server
        .post("/api/v1/training/plans")
        .add_header("authorization", bearer(&teacher))
        .json(&other)
        .await;
    assert_eq!(r.status_code(), StatusCode::CREATED);
    assert_ne!(r.json::<serde_json::Value>()["plan"]["id"].as_i64().unwrap(), plan_id);

    // NULL period_key 两次 → 均互不冲突（部分索引 WHERE period_key IS NOT NULL）
    for t in ["一", "二"] {
        let mut b = plan_body("chat", None, json!([]));
        b["title"] = json!(t);
        let r = server
            .post("/api/v1/training/plans")
            .add_header("authorization", bearer(&teacher))
            .json(&b)
            .await;
        assert_eq!(r.status_code(), StatusCode::CREATED, "NULL period_key never conflicts ({t})");
    }
}

/// 并发收敛：4 个并发同 period_key 创建 → 恰一个 201、其余 200、同 plan id、无 500。
#[tokio::test]
async fn plan_period_key_concurrent_converges_without_500() {
    let (server, state, teacher, teacher_id, _plain) = learning_fixture("conc").await;
    let page_path = format!("concepts/conc-{}.md", unique("pg"));
    seed_wiki_page(&state, &page_path).await;
    // M3：weekly period_key 必须等于服务端自算当周（格式非法/错周均 400）——
    // 动态取当周（unique() 任意串过不了新校验）；4 个并发请求共用同一 key
    let pk = current_iso_week();

    // TestServer 非 Clone，但请求方法取 &self——4 个借用同一 server 的 future 并发打点
    let bodies: Vec<serde_json::Value> = (0..4)
        .map(|i| {
            let mut b = plan_body(
                "weekly",
                Some(&pk),
                json!([{"kind": "wiki_page", "target_ref": page_path, "label": "c"}]),
            );
            b["title"] = json!(format!("并发-{i}"));
            b
        })
        .collect();
    let jobs = bodies.iter().map(|b| {
        let s = &server;
        let tok = teacher.as_str();
        async move {
            s.post("/api/v1/training/plans")
                .add_header("authorization", bearer(tok))
                .json(b)
                .await
        }
    });
    let results = futures::future::join_all(jobs).await;
    let mut ids = Vec::new();
    let mut created = 0;
    for (i, r) in results.into_iter().enumerate() {
        let code = r.status_code();
        assert!(
            code == StatusCode::CREATED || code == StatusCode::OK,
            "concurrent create #{i} must be 200/201, got {code}"
        );
        if code == StatusCode::CREATED {
            created += 1;
        }
        ids.push(r.json::<serde_json::Value>()["plan"]["id"].as_i64().unwrap());
    }
    assert_eq!(created, 1, "exactly one winner creates");
    assert!(ids.windows(2).all(|w| w[0] == w[1]), "all converge on same id: {ids:?}");

    // 收敛后仅一个 plan、一条 plan_created、一个 item
    let plan_id = ids[0] as i32;
    let n_plans: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM learning_plans WHERE user_id = $1 AND period_key = $2",
    )
    .bind(teacher_id as i32)
    .bind(&pk)
    .fetch_one(&state.db)
    .await
    .unwrap();
    assert_eq!(n_plans, 1);
    let n_items: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM learning_items WHERE plan_id = $1")
        .bind(plan_id)
        .fetch_one(&state.db)
        .await
        .unwrap();
    assert_eq!(n_items, 1, "loser items must not append");
}

/// 归属链 404：B 的 token 访 A 的 plan（GET/link/complete）→ 404；
/// A 完成 B 的 item → 404 且 B 的 item 不动、无 A 的 complete 事件落库。
#[tokio::test]
async fn ownership_chain_404_cross_user() {
    let (server, state, teacher_a, _aid, _plain) = learning_fixture("own").await;
    let (teacher_b, _bid) = bind_teacher(&server, &unique("wb")).await;

    let page_path = format!("concepts/own-{}.md", unique("pg"));
    seed_wiki_page(&state, &page_path).await;
    let mk = |title: &str| {
        let mut b = plan_body(
            "chat",
            None,
            json!([{"kind": "wiki_page", "target_ref": page_path.clone(), "label": "i"}]),
        );
        b["title"] = json!(title);
        b
    };

    // A 建 plan_a
    let r = server
        .post("/api/v1/training/plans")
        .add_header("authorization", bearer(&teacher_a))
        .json(&mk("A的计划"))
        .await;
    assert_eq!(r.status_code(), StatusCode::CREATED);
    let plan_a = r.json::<serde_json::Value>()["plan"]["id"].as_i64().unwrap();

    // B 建 plan_b（拿一个 B 的 item）
    let r = server
        .post("/api/v1/training/plans")
        .add_header("authorization", bearer(&teacher_b))
        .json(&mk("B的计划"))
        .await;
    assert_eq!(r.status_code(), StatusCode::CREATED);
    let vb = r.json::<serde_json::Value>();
    let plan_b = vb["plan"]["id"].as_i64().unwrap();
    let item_b = vb["items"][0]["id"].as_i64().unwrap();

    // B 的 token 访 A 的 plan → 404（GET / GET list 隔离 / link / complete）
    let r = server
        .get(&format!("/api/v1/training/plans/{plan_a}"))
        .add_header("authorization", bearer(&teacher_b))
        .await;
    assert_eq!(r.status_code(), StatusCode::NOT_FOUND);
    let r = server
        .post(&format!("/api/v1/training/plans/{plan_a}/link"))
        .add_header("authorization", bearer(&teacher_b))
        .await;
    assert_eq!(r.status_code(), StatusCode::NOT_FOUND);
    let r = server
        .post(&format!("/api/v1/training/items/{item_b}/complete"))
        .add_header("authorization", bearer(&teacher_a))
        .await;
    assert_eq!(r.status_code(), StatusCode::NOT_FOUND, "A completing B's item must 404");

    // B 列表只含自己的
    let r = server
        .get("/api/v1/training/plans")
        .add_header("authorization", bearer(&teacher_b))
        .await;
    let arr = r.json::<serde_json::Value>().as_array().unwrap().clone();
    assert_eq!(arr.len(), 1);
    assert_eq!(arr[0]["id"], plan_b);

    // B 的 item 状态不动、A 无 complete 事件（无泄漏写）
    let st: String = sqlx::query_scalar("SELECT status FROM learning_items WHERE id = $1")
        .bind(item_b as i32)
        .fetch_one(&state.db)
        .await
        .unwrap();
    assert_eq!(st, "pending");
    let n: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM learning_events WHERE event_type = 'complete' AND item_id = $1",
    )
    .bind(item_b as i32)
    .fetch_one(&state.db)
    .await
    .unwrap();
    assert_eq!(n, 0);
}

/// 单调 + 幂等 + 重建：complete 落 completed/completed_at；二次 complete 200 且
/// completed_at 不变（事件仍记账）；apply_seen 对 completed 不回退、对 pending → viewed、
/// 页面级仅事件；rebuild 清零后按 item 级事件重放收敛（含脏数据回正）。
#[tokio::test]
async fn complete_monotonic_idempotent_and_rebuild() {
    let (server, state, teacher, teacher_id, _plain) = learning_fixture("mono").await;

    // transcripts/ 前缀的 wiki_page 允许无实体页（transcriber 命名空间）
    let tr = format!("transcripts/mono-{}.md", unique("tr"));
    let body = plan_body(
        "chat",
        None,
        json!([
            {"kind": "wiki_page", "target_ref": tr.clone(), "label": "t1"},
            {"kind": "wiki_page", "target_ref": tr, "label": "t2"}
        ]),
    );
    let r = server
        .post("/api/v1/training/plans")
        .add_header("authorization", bearer(&teacher))
        .json(&body)
        .await;
    assert_eq!(r.status_code(), StatusCode::CREATED);
    let v = r.json::<serde_json::Value>();
    let plan_id = v["plan"]["id"].as_i64().unwrap() as i32;
    let item1 = v["items"][0]["id"].as_i64().unwrap() as i32;
    let item2 = v["items"][1]["id"].as_i64().unwrap() as i32;

    // 404：不存在的 item
    let r = server
        .post("/api/v1/training/items/999999999/complete")
        .add_header("authorization", bearer(&teacher))
        .await;
    assert_eq!(r.status_code(), StatusCode::NOT_FOUND);

    // complete → 200；DB completed + completed_at
    let r = server
        .post(&format!("/api/v1/training/items/{item1}/complete"))
        .add_header("authorization", bearer(&teacher))
        .await;
    assert_eq!(r.status_code(), StatusCode::OK);
    let (st, at): (String, Option<chrono::DateTime<chrono::Utc>>) =
        sqlx::query_as("SELECT status, completed_at FROM learning_items WHERE id = $1")
            .bind(item1)
            .fetch_one(&state.db)
            .await
            .unwrap();
    assert_eq!(st, "completed");
    let at = at.expect("completed_at set");

    // 二次 complete → 200 幂等；completed_at 不变；complete 事件记账两次（事件即事实）
    let r = server
        .post(&format!("/api/v1/training/items/{item1}/complete"))
        .add_header("authorization", bearer(&teacher))
        .await;
    assert_eq!(r.status_code(), StatusCode::OK);
    let at2: Option<chrono::DateTime<chrono::Utc>> =
        sqlx::query_scalar("SELECT completed_at FROM learning_items WHERE id = $1")
            .bind(item1)
            .fetch_one(&state.db)
            .await
            .unwrap();
    assert_eq!(at2, Some(at), "second complete must not reset completed_at");
    let n_ev: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM learning_events WHERE event_type='complete' AND item_id = $1",
    )
    .bind(item1)
    .fetch_one(&state.db)
    .await
    .unwrap();
    assert_eq!(n_ev, 2, "event log records each complete");

    // apply_seen（lib 直调，事务内）：completed 不回退；pending → viewed
    {
        let mut tx = state.db.begin().await.unwrap();
        llm_wiki_server::services::projection::apply_seen(
            &mut tx, plan_id, Some(item1), teacher_id as i32,
        )
        .await
        .unwrap();
        llm_wiki_server::services::projection::apply_seen(
            &mut tx, plan_id, Some(item2), teacher_id as i32,
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();
    }
    let st1: String = sqlx::query_scalar("SELECT status FROM learning_items WHERE id = $1")
        .bind(item1)
        .fetch_one(&state.db)
        .await
        .unwrap();
    let st2: String = sqlx::query_scalar("SELECT status FROM learning_items WHERE id = $1")
        .bind(item2)
        .fetch_one(&state.db)
        .await
        .unwrap();
    assert_eq!(st1, "completed", "seen must not regress completed");
    assert_eq!(st2, "viewed", "pending → viewed one-way");

    // 页面级 seen（item_id=None）：仅事件，不触碰投影
    let before: Vec<(i32, String)> = sqlx::query_as(
        "SELECT id, status FROM learning_items WHERE plan_id = $1 ORDER BY id",
    )
    .bind(plan_id)
    .fetch_all(&state.db)
    .await
    .unwrap();
    {
        let mut tx = state.db.begin().await.unwrap();
        llm_wiki_server::services::projection::apply_seen(
            &mut tx, plan_id, None, teacher_id as i32,
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();
    }
    let n_seen_page: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM learning_events WHERE user_id = $1 AND event_type='seen' AND item_id IS NULL",
    )
    .bind(teacher_id as i32)
    .fetch_one(&state.db)
    .await
    .unwrap();
    assert_eq!(n_seen_page, 1, "page-level seen recorded as event");
    let after: Vec<(i32, String)> = sqlx::query_as(
        "SELECT id, status FROM learning_items WHERE plan_id = $1 ORDER BY id",
    )
    .bind(plan_id)
    .fetch_all(&state.db)
    .await
    .unwrap();
    assert_eq!(before, after, "page-level seen must not touch projection");

    // 脏数据：SQL 直插一个无事件支撑的 completed item（rebuild 的存在意义）
    let item3: i32 = sqlx::query_scalar(
        "INSERT INTO learning_items (plan_id, kind, target_ref, label, sort_order, status, completed_at) \
         VALUES ($1, 'wiki_page', $2, 'dirty', 2, 'completed', NOW()) RETURNING id",
    )
    .bind(plan_id)
    .bind(format!("transcripts/dirty-{}.md", unique("d")))
    .fetch_one(&state.db)
    .await
    .unwrap();

    // rebuild（端点）：清零后按 item 级事件重放——item1 completed（complete 事件）、
    // item2 viewed（seen 事件）、item3 pending（无事件 → 脏 completed 回正）
    let r = server
        .post("/api/v1/training/progress/rebuild")
        .add_header("authorization", bearer(&teacher))
        .await;
    assert_eq!(r.status_code(), StatusCode::OK);
    async fn item_of(server: &TestServer, token: &str, plan_id: i32, id: i32) -> serde_json::Value {
        let r = server
            .get(&format!("/api/v1/training/plans/{plan_id}"))
            .add_header("authorization", bearer(token))
            .await;
        assert_eq!(r.status_code(), StatusCode::OK);
        let items = r.json::<serde_json::Value>()["items"].as_array().unwrap().clone();
        items
            .into_iter()
            .find(|i| i["id"] == id as i64)
            .unwrap_or_else(|| panic!("item {id} missing"))
    }
    assert_eq!(item_of(&server, &teacher, plan_id, item1).await["status"], "completed");
    assert_eq!(item_of(&server, &teacher, plan_id, item2).await["status"], "viewed");
    assert_eq!(
        item_of(&server, &teacher, plan_id, item3).await["status"],
        "pending",
        "event-less completed is corrected"
    );
    let at3: Option<chrono::DateTime<chrono::Utc>> =
        sqlx::query_scalar("SELECT completed_at FROM learning_items WHERE id = $1")
            .bind(item3)
            .fetch_one(&state.db)
            .await
            .unwrap();
    assert_eq!(at3, None, "completed_at cleared for reverted item");
    // item1 的 completed_at 重建为首个 complete 事件时间（MIN(created_at)，非空）
    let at_r: Option<chrono::DateTime<chrono::Utc>> =
        sqlx::query_scalar("SELECT completed_at FROM learning_items WHERE id = $1")
            .bind(item1)
            .fetch_one(&state.db)
            .await
            .unwrap();
    let at_r = at_r.expect("completed_at replayed from events");
    assert!(at_r <= at, "replayed completed_at (first complete event) must not be later than original");
}

/// target_ref / body 校验 400 矩阵：非法 kind、绝对路径、wiki_page 不存在、
/// media slug 不存在、origin 非法、超长 title/label/period_key；被拒请求零半写。
#[tokio::test]
async fn target_ref_and_body_validation_400() {
    let (server, state, teacher, teacher_id, _plain) = learning_fixture("val").await;
    let page_path = format!("concepts/val-{}.md", unique("pg"));
    seed_wiki_page(&state, &page_path).await;
    let slug = unique("md");
    seed_media_asset(&state, &slug).await;

    let wiki = |target: &str| json!([{"kind": "wiki_page", "target_ref": target, "label": "l"}]);
    // 超长字段（title/label >200、period_key >20 → 400）
    let mut long_title = plan_body("chat", None, wiki(&page_path));
    long_title["title"] = json!("长".repeat(201));
    let long_label = plan_body(
        "chat",
        None,
        json!([{"kind": "wiki_page", "target_ref": page_path.clone(), "label": "标".repeat(201)}]),
    );
    let long_pk = plan_body("chat", Some(&"k".repeat(21)), wiki(&page_path));
    let bad_bodies: Vec<(serde_json::Value, &str)> = vec![
        (plan_body("chat", None, json!([{"kind": "bogus", "target_ref": page_path.clone(), "label": "l"}])), "bad kind"),
        (plan_body("chat", None, wiki("/etc/passwd.md")), "absolute path"),
        (plan_body("chat", None, wiki(&format!("pages/missing-{}.md", unique("m")))), "missing wiki page"),
        (plan_body("chat", None, json!([{"kind": "media", "target_ref": format!("no-such-{}", unique("s")), "label": "l"}])), "missing media slug"),
        (plan_body("daily", None, wiki(&page_path)), "bad origin"),
        (long_title, "title >200"),
        (long_label, "label >200"),
        (long_pk, "period_key >20"),
    ];

    for (body, why) in &bad_bodies {
        let r = server
            .post("/api/v1/training/plans")
            .add_header("authorization", bearer(&teacher))
            .json(body)
            .await;
        assert_eq!(r.status_code(), StatusCode::BAD_REQUEST, "must 400: {why}");
    }

    // 被拒零半写：本测试用户无 plan、无 plan_created 事件
    let n_plans: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM learning_plans WHERE user_id = $1")
        .bind(teacher_id as i32)
        .fetch_one(&state.db)
        .await
        .unwrap();
    assert_eq!(n_plans, 0, "rejected creates leave no plans");
    let n_ev: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM learning_events WHERE user_id = $1 AND event_type='plan_created'",
    )
    .bind(teacher_id as i32)
    .fetch_one(&state.db)
    .await
    .unwrap();
    assert_eq!(n_ev, 0, "rejected creates leave no plan_created events");

    // transcripts/ 前缀 wiki_page：无实体页也合法（transcriber 命名空间，创建即可能未同步）
    let tr = format!("transcripts/ok-{}.md", unique("tr"));
    let r = server
        .post("/api/v1/training/plans")
        .add_header("authorization", bearer(&teacher))
        .json(&plan_body("chat", None, wiki(&tr)))
        .await;
    assert_eq!(r.status_code(), StatusCode::CREATED, "transcripts/ prefix allowed without page");

    // 合法 media slug 复验（对照组）
    let r = server
        .post("/api/v1/training/plans")
        .add_header("authorization", bearer(&teacher))
        .json(&plan_body("chat", None, json!([{"kind": "media", "target_ref": slug, "label": "l"}])))
        .await;
    assert_eq!(r.status_code(), StatusCode::CREATED, "seeded media slug accepted");
}
