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

// ---- Task 6: stream-turn test with injected FakeProvider ----

use futures::stream::{BoxStream, StreamExt};
use llm_wiki_server::routes::chat_sessions::{stream_conversation_turn, ChatStreamEvent};
use llm_wiki_server::services::llm_stream::{
    ChatMessage, ChatOpts, LlmError, StreamChatProvider, TokenDelta,
};

/// Fake provider emitting canned tokens (no real LLM).
struct FakeProvider {
    tokens: Vec<String>,
}

#[async_trait::async_trait]
impl StreamChatProvider for FakeProvider {
    async fn stream_chat(
        &self,
        _messages: Vec<ChatMessage>,
        _opts: ChatOpts,
    ) -> Result<BoxStream<'static, Result<TokenDelta, LlmError>>, LlmError> {
        let tokens = self.tokens.clone();
        let s = async_stream::stream! {
            for t in tokens {
                yield Ok(TokenDelta::Text(t));
            }
            yield Ok(TokenDelta::Done);
        };
        Ok(Box::pin(s))
    }
    fn provider_type(&self) -> &'static str {
        "fake"
    }
    fn model_name(&self) -> &str {
        "fake"
    }
}

#[tokio::test]
async fn stream_turn_emits_tokens_citations_and_persists() {
    let (server, state, pid, token) = setup("conv-stream").await;

    // insert a wiki page the query will match (keyword mode; embedding endpoint
    // may be unreachable in the test env -> hybrid_search falls back to keyword)
    sqlx::query(
        "INSERT INTO wiki_pages (project_id, path, title, content, page_type) \
         VALUES ($1, 'concepts/rust.md', 'Rust Ownership', 'Rust ownership is about memory safety.', 'concept') \
         ON CONFLICT (project_id, path) DO NOTHING",
    )
    .bind(pid)
    .execute(&state.db)
    .await
    .unwrap();

    // create conversation via the API (real create path), then read its owner
    let c = create_conv(&server, pid, &token, None).await;
    let conv_id = c["id"].as_i64().unwrap();
    let user_id: i32 = sqlx::query_scalar("SELECT user_id FROM chat_conversations WHERE id = $1")
        .bind(conv_id)
        .fetch_one(&state.db)
        .await
        .unwrap();

    // run the turn with a fake provider that emits a cited answer
    let provider = Box::new(FakeProvider {
        tokens: vec![
            "Rust ownership ensures memory safety. ".into(),
            "<!-- cited: 1 -->".into(),
        ],
    });
    let mut turn = stream_conversation_turn(
        state.clone(),
        pid,
        user_id,
        conv_id,
        "What is rust ownership?".into(),
        provider,
        "fake".into(),
        100_000,
    )
    .await
    .unwrap();

    // collect structured events
    let mut names: Vec<&'static str> = Vec::new();
    let mut tokens = String::new();
    let mut done = None;
    while let Some(e) = turn.next().await {
        match e {
            ChatStreamEvent::Retrieval(_) => names.push("retrieval"),
            ChatStreamEvent::Token(t) => {
                names.push("token");
                tokens.push_str(&t);
            }
            ChatStreamEvent::Done {
                references,
                citations,
            } => {
                names.push("done");
                done = Some((references, citations));
            }
            ChatStreamEvent::Error(_) => names.push("error"),
        }
    }

    assert!(names.contains(&"retrieval"), "events: {:?}", names);
    assert!(names.contains(&"token"), "events: {:?}", names);
    assert!(names.contains(&"done"), "events: {:?}", names);
    assert!(!names.contains(&"error"), "unexpected error event");
    assert_eq!(
        tokens,
        "Rust ownership ensures memory safety. <!-- cited: 1 -->"
    );

    let (refs, citations) = done.unwrap();
    assert_eq!(citations, vec![1]);
    assert_eq!(refs[0].path.as_deref(), Some("concepts/rust.md"));

    // persisted messages (+ retrieval_ctx snapshot on assistant only)
    let rows: Vec<(String, Option<Vec<i32>>, Option<serde_json::Value>)> = sqlx::query_as(
        "SELECT role, citations, retrieval_ctx FROM chat_messages WHERE conversation_id = $1 ORDER BY created_at",
    )
    .bind(conv_id)
    .fetch_all(&state.db)
    .await
    .unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].0, "user");
    assert!(rows[0].2.is_none(), "user message has no retrieval_ctx");
    assert_eq!(rows[1].0, "assistant");
    assert_eq!(rows[1].1.as_deref(), Some(&[1][..]));
    let ctx = rows[1]
        .2
        .as_ref()
        .expect("assistant retrieval_ctx must be persisted");
    assert!(
        ctx.to_string().contains("concepts/rust.md"),
        "retrieval_ctx snapshot includes the cited page"
    );

    // auto-title set from first user message
    let title: String = sqlx::query_scalar("SELECT title FROM chat_conversations WHERE id = $1")
        .bind(conv_id)
        .fetch_one(&state.db)
        .await
        .unwrap();
    assert_eq!(title, "What is rust ownership?");
}

#[tokio::test]
async fn stream_endpoint_rejects_unauthenticated() {
    let (server, _state, pid, token) = setup("conv-auth").await;
    let c = create_conv(&server, pid, &token, None).await;
    let cid = c["id"].as_i64().unwrap();
    let r = server
        .post(&format!(
            "/api/v1/projects/{}/chat/conversations/{}/stream",
            pid, cid
        ))
        .content_type("application/json")
        .json(&serde_json::json!({"message":"hi"}))
        .await;
    // No Authorization header -> 401
    assert_eq!(r.status_code(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn stream_endpoint_403_for_non_member() {
    let (server, _state, pid, token_a) = setup("conv-403").await;
    let c = create_conv(&server, pid, &token_a, None).await;
    let cid = c["id"].as_i64().unwrap();

    // user B is NOT a project member -> check_project_access returns 403
    // (fires before the ownership check).
    let uname_b = unique_prefix("conv-403-b");
    let user_b = crate::register_user(&server, &uname_b, &format!("{}@t.com", uname_b), "password123").await;
    let r = server
        .post(&format!(
            "/api/v1/projects/{}/chat/conversations/{}/stream",
            pid, cid
        ))
        .add_header("authorization", auth(&user_b))
        .content_type("application/json")
        .json(&serde_json::json!({"message":"hi"}))
        .await;
    assert_eq!(r.status_code(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn stream_endpoint_400_on_empty_message() {
    let (server, _state, pid, token) = setup("conv-empty").await;
    let c = create_conv(&server, pid, &token, None).await;
    let cid = c["id"].as_i64().unwrap();
    let r = server
        .post(&format!(
            "/api/v1/projects/{}/chat/conversations/{}/stream",
            pid, cid
        ))
        .add_header("authorization", auth(&token))
        .content_type("application/json")
        .json(&serde_json::json!({"message":"   "}))
        .await;
    assert_eq!(r.status_code(), StatusCode::BAD_REQUEST);
}
