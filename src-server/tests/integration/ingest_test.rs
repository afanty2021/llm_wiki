/// ingest API 集成测试（子系统 E Task 1）。
///
/// 复用 ingest_queue_test.rs 的成熟 setup 模式（AtomicU64 + pid 唯一化 username），
/// 不用 plan 原文 `format!("etest_{}", std::process::id())`——并行测试同秒碰撞。
///
/// 4 用例覆盖：
///   - POST   /api/v1/projects/:id/ingest           → 201 + job_id + status=pending
///   - GET    /api/v1/ingest/jobs/:id               → 200 + status=pending + progress=0
///   - GET    /api/v1/projects/:id/ingest/jobs      → 200 + items.len>=2
///   - POST   /api/v1/projects/:id/ingest (no auth) → 401
use axum::http::StatusCode;
use std::sync::atomic::{AtomicU64, Ordering};

/// 全局单调计数器，保证同进程并发测试 username 绝对唯一
/// （照 pages_test.rs / ingest_queue_test.rs 的 unique_prefix 模式）。
static COUNTER: AtomicU64 = AtomicU64::new(0);

/// 复用 ingest_queue_test.rs 的 setup 模式：register → 查 team_id → POST /projects。
async fn setup() -> (
    axum_test::TestServer,
    llm_wiki_server::AppState,
    i32,
    String,
) {
    let (app, state) = crate::setup_test_app().await;
    let server = axum_test::TestServer::new(app).unwrap();
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let username = format!("etest_{}_{}", std::process::id(), n);
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
        .json(&serde_json::json!({"name": format!("eproj-{}-{}", std::process::id(), n), "team_id": team_id}))
        .await;
    assert_eq!(resp.status_code(), StatusCode::CREATED);
    let pid = resp.json::<serde_json::Value>()["id"].as_i64().unwrap() as i32;
    (server, state, pid, token)
}

#[tokio::test]
async fn create_ingest_job_returns_201() {
    let (server, _state, pid, token) = setup().await;
    let resp = server
        .post(&format!("/api/v1/projects/{}/ingest", pid))
        .add_header("authorization", format!("Bearer {}", token))
        .json(&serde_json::json!({"source_paths": ["test/foo.md"]}))
        .await;
    assert_eq!(resp.status_code(), StatusCode::CREATED);
    let body: serde_json::Value = resp.json();
    assert!(body["job_id"].as_str().is_some());
    assert_eq!(body["status"], "pending");
}

#[tokio::test]
async fn get_job_status_returns_200() {
    let (server, _state, pid, token) = setup().await;
    let resp = server
        .post(&format!("/api/v1/projects/{}/ingest", pid))
        .add_header("authorization", format!("Bearer {}", token))
        .json(&serde_json::json!({"source_paths": ["test/bar.md"]}))
        .await;
    let job_id = resp.json::<serde_json::Value>()["job_id"]
        .as_str()
        .unwrap()
        .to_string();

    let resp = server
        .get(&format!("/api/v1/ingest/jobs/{}", job_id))
        .await;
    assert_eq!(resp.status_code(), StatusCode::OK);
    let job: serde_json::Value = resp.json();
    assert_eq!(job["status"], "pending");
    assert_eq!(job["progress"], 0);
}

#[tokio::test]
async fn list_ingest_jobs_returns_items() {
    let (server, _state, pid, token) = setup().await;
    for path in &["a.md", "b.md"] {
        server
            .post(&format!("/api/v1/projects/{}/ingest", pid))
            .add_header("authorization", format!("Bearer {}", token))
            .json(&serde_json::json!({"source_paths": [path]}))
            .await;
    }
    let resp = server
        .get(&format!("/api/v1/projects/{}/ingest/jobs", pid))
        .add_header("authorization", format!("Bearer {}", token))
        .await;
    assert_eq!(resp.status_code(), StatusCode::OK);
    let body: serde_json::Value = resp.json();
    let items = body["items"].as_array().unwrap();
    assert!(items.len() >= 2);
}

#[tokio::test]
async fn create_ingest_job_unauthorized_returns_401() {
    let (server, _state, pid, _token) = setup().await;
    let resp = server
        .post(&format!("/api/v1/projects/{}/ingest", pid))
        .json(&serde_json::json!({"source_paths": ["test/x.md"]}))
        .await;
    assert_eq!(resp.status_code(), StatusCode::UNAUTHORIZED);
}
