//! Task 7：learning API 批1 —— GET/PUT /api/v1/training/profile、
//! POST /api/v1/training/events（仅 ask）、GET /api/v1/training/progress。
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

    // 「改 config 后 create_app」（T3 模式，training_test 同款）
    crate::ensure_test_jwt_secret();
    let mut cfg = llm_wiki_server::AppConfig::from_env().unwrap();
    cfg.training.project_id = Some(project_id);
    cfg.training.admin_token = "tok123".to_string();
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
