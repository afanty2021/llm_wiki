/// chat_stream 直通改造集成测试（Layer 5 Task 6）。
///
/// 不依赖真实 LLM：验证端点鉴权（401 无 token）+ 直通代码路径可达
/// （有 token 无 provider → 5xx，非崩溃）。
///
/// 注册：tests/integration/mod.rs 加 `pub mod chat_stream_test;`。
/// 运行：`cargo test --test integration chat_stream`。
use axum::http::StatusCode;
use std::sync::atomic::{AtomicU64, Ordering};

/// 全局单调计数器，保证同进程并发测试 username 绝对唯一
/// （照 files_stat_test.rs 的唯一化模式）。
static COUNTER: AtomicU64 = AtomicU64::new(0);

/// 复用 files_stat_test.rs 的 setup 模式：register → 查 team_id → POST /projects。
/// 返回 (server, pid, token)。
async fn setup() -> (axum_test::TestServer, i32, String) {
    let (app, state) = crate::setup_test_app().await;
    let server = axum_test::TestServer::new(app).unwrap();
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let username = format!("cstream_{}_{}", std::process::id(), n);
    let token = crate::register_user(
        &server,
        &username,
        &format!("{}@t.com", username),
        "password123",
    )
    .await;

    // register 已建 personal team，查出 team_id
    let team_id: i32 = sqlx::query_scalar(
        "SELECT id FROM teams WHERE created_by = (SELECT id FROM users WHERE username = $1)",
    )
    .bind(&username)
    .fetch_one(&state.db)
    .await
    .unwrap();

    // 建 project
    let resp = server
        .post("/api/v1/projects")
        .add_header("authorization", format!("Bearer {}", token))
        .json(&serde_json::json!({"name": format!("cproj-{}-{}", std::process::id(), n), "team_id": team_id}))
        .await;
    assert_eq!(resp.status_code(), StatusCode::CREATED);
    let pid = resp.json::<serde_json::Value>()["id"].as_i64().unwrap() as i32;
    (server, pid, token)
}

#[tokio::test]
async fn chat_stream_requires_auth() {
    let (server, pid, _token) = setup().await;
    let resp = server
        .post("/api/v1/chat/stream")
        .json(&serde_json::json!({"project_id": pid, "messages": [{"role":"user","content":"hi"}]}))
        .await;
    assert_eq!(resp.status_code(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn chat_stream_reachable_without_provider() {
    let (server, pid, token) = setup().await;
    // 无 LLM provider 配置 → get_llm_config 报错（BadRequest → 4xx）
    // → 错误经 `?` 传播为正常 HTTP 错误响应，而非双层 SSE 的 200 event。
    // 证明：端点可达、直通逻辑未崩、无双层 SSE 异常。
    let resp = server
        .post("/api/v1/chat/stream")
        .add_header("authorization", format!("Bearer {}", token))
        .json(&serde_json::json!({"project_id": pid, "messages": [{"role":"user","content":"hi"}]}))
        .await;
    let status = resp.status_code();
    assert!(
        status.is_client_error() || status.is_server_error(),
        "无 provider 应返回 4xx/5xx 错误（直通 `?` 传播），得 {}",
        status
    );
    assert_ne!(
        status,
        StatusCode::OK,
        "不应再是 200（旧双层 SSE 把错误包成 event 返回 200）"
    );
}
