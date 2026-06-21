use axum::http::StatusCode;
use serde_json::Value;
use std::sync::atomic::{AtomicU64, Ordering};

// NOTE: this suite's crate root (tests/integration/mod.rs) exposes only
// setup_test_app + register_user. setup_project is defined per-file (see
// pages_test.rs), so we provide our own copy here rather than crate::setup_project.
static COUNTER: AtomicU64 = AtomicU64::new(0);

/// Unique prefix: pid + monotonic counter (mirrors pages_test.rs).
fn unique_prefix(tag: &str) -> String {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    format!("{}_{}_{}", tag, std::process::id(), n)
}

/// register a user + personal team + one project; return (server, state, pid, token).
async fn setup_project(tag: &str) -> (axum_test::TestServer, llm_wiki_server::AppState, i32, String) {
    let (app, state) = crate::setup_test_app().await;
    let server = axum_test::TestServer::new(app).unwrap();
    let username = unique_prefix(tag);
    let token = crate::register_user(&server, &username, &format!("{}@t.com", username), "password123").await;
    let team_id: i32 = sqlx::query_scalar(
        "SELECT id FROM teams WHERE created_by = (SELECT id FROM users WHERE username = $1)",
    )
    .bind(&username)
    .fetch_one(&state.db)
    .await
    .unwrap();
    let resp = server
        .post("/api/v1/projects")
        .add_header("authorization", format!("Bearer {}", token))
        .json(&serde_json::json!({ "name": "test-proj", "team_id": team_id }))
        .await;
    assert_eq!(resp.status_code(), StatusCode::CREATED);
    let project_id = resp.json::<serde_json::Value>()["id"].as_i64().unwrap() as i32;
    (server, state, project_id, token)
}

async fn setup(tag: &str) -> (axum_test::TestServer, llm_wiki_server::AppState, i32, String) {
    setup_project(tag).await
}

fn auth(token: &str) -> String {
    format!("Bearer {}", token)
}

async fn create_conv(
    server: &axum_test::TestServer,
    pid: i32,
    token: &str,
    title: Option<&str>,
) -> Value {
    let body = match title {
        Some(t) => serde_json::json!({ "title": t }),
        None => serde_json::json!({}),
    };
    let r = server
        .post(&format!("/api/v1/projects/{}/chat/conversations", pid))
        .add_header("authorization", auth(token))
        .content_type("application/json")
        .json(&body)
        .await;
    assert_eq!(r.status_code(), StatusCode::CREATED);
    r.json()
}

#[tokio::test]
async fn create_list_delete_conversation() {
    let (server, _state, pid, token) = setup("conv-crud").await;
    let c = create_conv(&server, pid, &token, Some("My chat")).await;
    let cid = c["id"].as_i64().unwrap();
    assert_eq!(c["title"], "My chat");

    // list shows it
    let r = server
        .get(&format!("/api/v1/projects/{}/chat/conversations", pid))
        .add_header("authorization", auth(&token))
        .await;
    assert_eq!(r.status_code(), StatusCode::OK);
    let list: Vec<Value> = r.json();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0]["id"], c["id"]);

    // delete -> 204
    let r = server
        .delete(&format!("/api/v1/projects/{}/chat/conversations/{}", pid, cid))
        .add_header("authorization", auth(&token))
        .await;
    assert_eq!(r.status_code(), StatusCode::NO_CONTENT);

    // list now empty
    let r = server
        .get(&format!("/api/v1/projects/{}/chat/conversations", pid))
        .add_header("authorization", auth(&token))
        .await;
    let list: Vec<Value> = r.json();
    assert!(list.is_empty());
}

#[tokio::test]
async fn default_title_when_none() {
    let (server, _state, pid, token) = setup("conv-default").await;
    let c = create_conv(&server, pid, &token, None).await;
    assert_eq!(c["title"], "New chat");
}

#[tokio::test]
async fn conversations_are_private_per_user() {
    let (server, _state, pid, token_a) = setup("conv-iso").await;
    // user A creates a conversation
    let c = create_conv(&server, pid, &token_a, Some("A's secret")).await;
    let cid = c["id"].as_i64().unwrap();

    // user B (new registration) is NOT a member of A's team/project -> 403 on project access.
    // Register B with a unique name (persistent test DB — avoid re-run username collision).
    let uname_b = unique_prefix("conv-iso-b");
    let user_b = crate::register_user(&server, &uname_b, &format!("{}@t.com", uname_b), "password123").await;

    // B cannot list A's conversations (no project membership) -> 403
    let r = server
        .get(&format!("/api/v1/projects/{}/chat/conversations", pid))
        .add_header("authorization", auth(&user_b))
        .await;
    assert_eq!(r.status_code(), StatusCode::FORBIDDEN);

    // B cannot delete A's conversation through this project (403 before ownership check)
    let r = server
        .delete(&format!("/api/v1/projects/{}/chat/conversations/{}", pid, cid))
        .add_header("authorization", auth(&user_b))
        .await;
    assert_eq!(r.status_code(), StatusCode::FORBIDDEN);

    // A still sees their conversation
    let r = server
        .get(&format!("/api/v1/projects/{}/chat/conversations", pid))
        .add_header("authorization", auth(&token_a))
        .await;
    let list: Vec<Value> = r.json();
    assert_eq!(list.len(), 1);
}

#[tokio::test]
async fn list_messages_empty_for_new_conversation() {
    let (server, _state, pid, token) = setup("conv-msgs").await;
    let c = create_conv(&server, pid, &token, None).await;
    let cid = c["id"].as_i64().unwrap();
    let r = server
        .get(&format!(
            "/api/v1/projects/{}/chat/conversations/{}/messages",
            pid, cid
        ))
        .add_header("authorization", auth(&token))
        .await;
    assert_eq!(r.status_code(), StatusCode::OK);
    let msgs: Vec<Value> = r.json();
    assert!(msgs.is_empty());
}
