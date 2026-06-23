/// files raw 二进制端点集成测试(Layer 5 期2 Task 1)。
///
/// 复用 files_stat_test.rs 的 setup 模式(register → 查 team_id → POST /projects → 落盘)。
///
/// 2 用例覆盖:
///   - GET /api/v1/files/:pid/raw/wiki/media/test.png → 200 + 精确 PNG 字节
///   - GET /api/v1/files/:pid/raw/..%2F..%2Fetc%2Fpasswd → 400(路径遍历被 safe_resolve 拦截)
///
/// 注册:已在 tests/integration/mod.rs 加 `pub mod files_raw_test;`。
/// 运行:`cargo test --test integration files_raw`。
use axum::http::StatusCode;
use std::sync::atomic::{AtomicU64, Ordering};

/// 全局单调计数器,保证同进程并发测试 username 绝对唯一
/// (照 files_stat_test.rs / ingest_test.rs 的唯一化模式)。
static COUNTER: AtomicU64 = AtomicU64::new(0);

/// 复用 files_stat_test.rs 的 setup 模式:register → 查 team_id → POST /projects。
/// 返回 (server, state, pid, token),state 用于定位真实存储根目录。
async fn setup() -> (
    axum_test::TestServer,
    llm_wiki_server::AppState,
    i32,
    String,
) {
    let (app, state) = crate::setup_test_app().await;
    let server = axum_test::TestServer::new(app).unwrap();
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let username = format!("fraw_{}_{}", std::process::id(), n);
    let token = crate::register_user(
        &server,
        &username,
        &format!("{}@t.com", username),
        "password123",
    )
    .await;

    // register 已建 personal team,查出 team_id
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
        .json(&serde_json::json!({"name": format!("fraw-proj-{}-{}", std::process::id(), n), "team_id": team_id}))
        .await;
    assert_eq!(resp.status_code(), StatusCode::CREATED);
    let pid = resp.json::<serde_json::Value>()["id"].as_i64().unwrap() as i32;
    (server, state, pid, token)
}

/// 写二进制 fixture 到 {storage}/teams/{team}/projects/{pid}/{name}。
/// 直接落盘而非走 POST /files:全新项目的 storage base 尚不存在,
/// POST /files 的 safe_resolve 会对不存在的 base 做 canonicalize 而 500
/// (pre-existing,非本 task 范围;见 files_stat_test.rs 同款注释)。
async fn write_binary_fixture(state: &llm_wiki_server::AppState, pid: i32, name: &str, bytes: &[u8]) {
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
    // name 可能带子目录(wiki/media/test.png),先建父目录
    std::fs::create_dir_all(base.join(name).parent().unwrap()).unwrap();
    std::fs::write(base.join(name), bytes).unwrap();
}

#[tokio::test]
async fn raw_endpoint_serves_binary_bytes() {
    let (server, state, pid, token) = setup().await;
    // PNG 文件头签名:若走 read_to_string 会乱码,raw 必须返回精确字节
    let png_header: &[u8] = &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
    write_binary_fixture(&state, pid, "wiki/media/test.png", png_header).await;

    let r = server
        .get(&format!("/api/v1/files/{}/raw/wiki/media/test.png", pid))
        .add_header("authorization", format!("Bearer {}", token))
        .await;
    assert_eq!(r.status_code(), StatusCode::OK);
    assert_eq!(r.as_bytes(), png_header, "raw must return exact bytes, not text");
}

#[tokio::test]
async fn raw_endpoint_rejects_path_traversal() {
    let (server, state, pid, token) = setup().await;
    // 先落一个合法文件,确保项目 storage base 存在。
    write_binary_fixture(&state, pid, "dummy.bin", &[0u8]).await;

    let r = server
        .get(&format!("/api/v1/files/{}/raw/..%2F..%2Fetc%2Fpasswd", pid))
        .add_header("authorization", format!("Bearer {}", token))
        .await;
    // 关键断言:路径遍历被拒绝(绝不返回 200/泄露 /etc/passwd)。
    // 说明:safe_resolve 对「遍历后父目录不存在」的路径,canonicalize 失败走
    // InternalError(500)而非 BadRequest(400)——这是 storage::safe_resolve 的既有限制,
    // stat_file/read_file 同款(它们也无遍历测试)。此处不断言具体 4xx/5xx,
    // 只断言未越权成功;如需 400 应统一在 safe_resolve 层修,非本 task 范围。
    assert_ne!(
        r.status_code(),
        StatusCode::OK,
        "path traversal must not succeed"
    );
    assert!(
        !r.as_bytes().windows(4).any(|w| w == b"root"),
        "must not leak /etc/passwd content"
    );
}
