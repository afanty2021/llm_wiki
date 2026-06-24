/// files stat 端点集成测试（Layer 5 Task 3）。
///
/// 复用 ingest_test.rs 的 setup 模式（register → personal team → SQL 查 team_id → POST /projects）。
///
/// 2 用例覆盖：
///   - GET /api/v1/files/:pid/stat/*path → 200 + exists/is_dir/size/modified
///   - GET /api/v1/files/:pid/stat/missing → 200 + exists=false
///
/// 注册：在 tests/integration/mod.rs 加 `pub mod files_stat_test;`。
/// 运行：`cargo test --test integration files_stat`。
use axum::http::StatusCode;
use std::sync::atomic::{AtomicU64, Ordering};

/// 全局单调计数器，保证同进程并发测试 username 绝对唯一
/// （照 ingest_test.rs / pages_test.rs 的唯一化模式）。
static COUNTER: AtomicU64 = AtomicU64::new(0);

/// 复用 ingest_test.rs 的 setup 模式：register → 查 team_id → POST /projects。
/// 返回 (server, state, pid, token)，state 用于定位真实存储根目录。
async fn setup() -> (
    axum_test::TestServer,
    llm_wiki_server::AppState,
    i32,
    String,
) {
    let (app, state) = crate::setup_test_app().await;
    let server = axum_test::TestServer::new(app).unwrap();
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let username = format!("fstat_{}_{}", std::process::id(), n);
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
        .json(&serde_json::json!({"name": format!("fproj-{}-{}", std::process::id(), n), "team_id": team_id}))
        .await;
    assert_eq!(resp.status_code(), StatusCode::CREATED);
    let pid = resp.json::<serde_json::Value>()["id"].as_i64().unwrap() as i32;
    (server, state, pid, token)
}

/// 写 fixture 文件到项目存储目录（{storage}/teams/{team}/projects/{pid}/{name}）。
/// 直接落盘而非走 POST /files：全新项目的 storage base 尚不存在，POST /files 的 safe_resolve
/// 会对不存在的 base 做 canonicalize 而 500（pre-existing，非本 task 范围；见 report concerns）。
async fn write_fixture(state: &llm_wiki_server::AppState, pid: i32, name: &str, contents: &str) {
    let team_id: i32 = sqlx::query_scalar("SELECT team_id FROM projects WHERE id = $1")
        .bind(pid)
        .fetch_one(&state.db)
        .await
        .unwrap();
    let base = std::path::PathBuf::from(state.config.storage_path())
        .join("teams")
        .join(team_id.to_string())
        .join("projects")
        .join(pid.to_string());
    std::fs::create_dir_all(&base).unwrap();
    std::fs::write(base.join(name), contents).unwrap();
}

#[tokio::test]
async fn stat_returns_exists_size_modified() {
    let (server, state, pid, token) = setup().await;
    write_fixture(&state, pid, "note.md", "hello").await;

    let resp = server
        .get(&format!("/api/v1/files/{}/stat/note.md", pid))
        .add_header("authorization", format!("Bearer {}", token))
        .await;
    assert_eq!(resp.status_code(), StatusCode::OK);
    let body: serde_json::Value = resp.json();
    assert_eq!(body["exists"], true);
    assert_eq!(body["is_dir"], false);
    assert_eq!(body["size"], 5);
    assert!(body["modified"].as_i64().unwrap() > 0);
}

#[tokio::test]
async fn stat_missing_file_exists_false() {
    let (server, _state, pid, token) = setup().await;
    let resp = server
        .get(&format!("/api/v1/files/{}/stat/missing.md", pid))
        .add_header("authorization", format!("Bearer {}", token))
        .await;
    assert_eq!(resp.status_code(), StatusCode::OK);
    let body: serde_json::Value = resp.json();
    assert_eq!(body["exists"], false);
}
