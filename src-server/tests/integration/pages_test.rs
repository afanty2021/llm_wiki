use axum::http::StatusCode;
use llm_wiki_server::WikiPage;
use std::sync::atomic::{AtomicU64, Ordering};

/// 全局单调计数器，保证同进程内多次调用绝对唯一
/// （多测试并行跑时，仅用 nanos 可能碰撞；atomic 计数器 + process id 双保险）。
static COUNTER: AtomicU64 = AtomicU64::new(0);

/// 唯一前缀：进程 id + 全局计数器。
fn unique_prefix(tag: &str) -> String {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    format!("{}_{}_{}", tag, std::process::id(), n)
}

/// 建一个 project（register 建 team → POST /projects），返回 (server, state, project_id, token)。
async fn setup_project(tag: &str) -> (axum_test::TestServer, llm_wiki_server::AppState, i32, String) {
    let (app, state) = crate::setup_test_app().await;
    let server = axum_test::TestServer::new(app).unwrap();
    let username = unique_prefix(tag);
    let token = crate::register_user(
        &server,
        &username,
        &format!("{}@t.com", username),
        "password123",
    )
    .await;

    // register 已建 personal team（Task 1），查出 team_id
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
        .json(&serde_json::json!({"name":"test-proj","team_id":team_id}))
        .await;
    assert_eq!(resp.status_code(), StatusCode::CREATED);
    let project_id = resp.json::<serde_json::Value>()["id"].as_i64().unwrap() as i32;
    (server, state, project_id, token)
}

#[tokio::test]
async fn list_pages_empty_then_create_then_list() {
    let (server, state, pid, token) = setup_project("page").await;
    let auth = format!("Bearer {}", token);

    // 空列表
    let r = server
        .get(&format!("/api/v1/projects/{}/pages", pid))
        .add_header("authorization", &auth)
        .await;
    assert_eq!(r.status_code(), 200);
    assert_eq!(r.json::<Vec<WikiPage>>().len(), 0);

    // 直接 INSERT 一条供 GET 验证（POST 在 Task 4）
    sqlx::query(
        "INSERT INTO wiki_pages (project_id, path, title) VALUES ($1, 'concepts/foo.md', 'Foo')",
    )
    .bind(pid)
    .execute(&state.db)
    .await
    .unwrap();

    // 列表含 1 条
    let r = server
        .get(&format!("/api/v1/projects/{}/pages", pid))
        .add_header("authorization", &auth)
        .await;
    let pages: Vec<WikiPage> = r.json();
    assert_eq!(pages.len(), 1);
    assert_eq!(pages[0].path, "concepts/foo.md");
    assert_eq!(pages[0].title.as_deref(), Some("Foo"));
}

#[tokio::test]
async fn get_page_by_path_returns_page() {
    let (server, state, pid, token) = setup_project("page").await;
    let auth = format!("Bearer {}", token);

    // INSERT 一条
    sqlx::query(
        "INSERT INTO wiki_pages (project_id, path, title, content) \
         VALUES ($1, 'concepts/bar.md', 'Bar', 'bar body')",
    )
    .bind(pid)
    .execute(&state.db)
    .await
    .unwrap();

    // GET ?path=
    let r = server
        .get(&format!("/api/v1/projects/{}/page?path=concepts/bar.md", pid))
        .add_header("authorization", &auth)
        .await;
    assert_eq!(r.status_code(), 200);
    let page: WikiPage = r.json();
    assert_eq!(page.path, "concepts/bar.md");
    assert_eq!(page.title.as_deref(), Some("Bar"));
    assert_eq!(page.content.as_deref(), Some("bar body"));
}

#[tokio::test]
async fn get_page_not_found_returns_404() {
    let (server, _state, pid, token) = setup_project("page").await;
    let auth = format!("Bearer {}", token);

    let r = server
        .get(&format!("/api/v1/projects/{}/page?path=nonexistent.md", pid))
        .add_header("authorization", &auth)
        .await;
    assert_eq!(r.status_code(), 404);
}

#[tokio::test]
async fn list_pages_unauthorized_returns_401() {
    let (server, _state, pid, _token) = setup_project("page").await;

    // 不带 authorization header
    let r = server
        .get(&format!("/api/v1/projects/{}/pages", pid))
        .await;
    assert_eq!(r.status_code(), 401);
}
