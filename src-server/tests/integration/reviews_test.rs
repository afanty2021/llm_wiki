use axum::http::StatusCode;
use std::sync::atomic::{AtomicU64, Ordering};

static COUNTER: AtomicU64 = AtomicU64::new(0);

fn unique_prefix(tag: &str) -> String {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    format!("{}_{}_{}", tag, std::process::id(), n)
}

async fn setup_project(tag: &str) -> (axum_test::TestServer, llm_wiki_server::AppState, i32, String) {
    let (app, state) = crate::setup_test_app().await;
    let server = axum_test::TestServer::new(app).unwrap();
    let username = unique_prefix(tag);
    let token = crate::register_user(&server, &username, &format!("{}@t.com", username), "password123").await;
    let team_id: i32 = sqlx::query_scalar(
        "SELECT id FROM teams WHERE created_by = (SELECT id FROM users WHERE username = $1)",
    )
    .bind(&username).fetch_one(&state.db).await.unwrap();
    let resp = server.post("/api/v1/projects")
        .add_header("authorization", format!("Bearer {}", token))
        .json(&serde_json::json!({"name":"test-proj","team_id":team_id})).await;
    assert_eq!(resp.status_code(), StatusCode::CREATED);
    let project_id = resp.json::<serde_json::Value>()["id"].as_i64().unwrap() as i32;
    (server, state, project_id, token)
}

fn auth(token: &str) -> String { format!("Bearer {}", token) }

use llm_wiki_server::services::review::{parse_review_blocks, insert_review_items};

#[tokio::test]
async fn insert_review_items_stores_rows() {
    let (_server, state, pid, _token) = setup_project("rev-insert").await;
    let llm_out = "---REVIEW: suggestion | Add X---\nThe wiki lacks X.\nOPTIONS: Create Page | Skip\nSEARCH: x basics | x tutorial\n---END REVIEW---\n---REVIEW: contradiction | Y vs Z---\nY conflicts with Z.\n---END REVIEW---";
    let parsed = parse_review_blocks(llm_out, "sources/doc.md");
    assert_eq!(parsed.len(), 2);
    let n = insert_review_items(&state, pid, &parsed).await.unwrap();
    assert_eq!(n, 2);

    let rows: Vec<(String, String, Option<String>)> = sqlx::query_as(
        "SELECT review_type, title, source_path FROM review_items WHERE project_id=$1 ORDER BY title",
    )
    .bind(pid).fetch_all(&state.db).await.unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].0, "suggestion");
    assert_eq!(rows[0].1, "Add X");
    assert_eq!(rows[0].2.as_deref(), Some("sources/doc.md"));
    assert_eq!(rows[1].0, "contradiction");
}

#[tokio::test]
async fn parse_handles_realistic_step2_output() {
    // step2 output with FILE blocks + a trailing REVIEW block
    let out = "---FILE: concepts/foo.md ---\n---\ntitle: Foo\ntype: concept\n---\n# Foo\nbody\n---END FILE---\n---REVIEW: missing-page | Add Bar---\nBar referenced but missing.\nOPTIONS: Create Page | Skip\nPAGES: wiki/concepts/bar.md\n---END REVIEW---";
    let r = parse_review_blocks(out, "src.md");
    assert_eq!(r.len(), 1);
    assert_eq!(r[0].review_type, "missing-page");
    assert_eq!(r[0].affected_pages.as_deref().unwrap(), &["wiki/concepts/bar.md"]);
}

use futures::stream::BoxStream;
use llm_wiki_server::services::llm_stream::{ChatMessage, ChatOpts, LlmError, StreamChatProvider, TokenDelta};
use llm_wiki_server::services::review::{run_dedicated_review_stage, should_run_dedicated_review_stage};

struct FakeReviewProvider { reply: String }
#[async_trait::async_trait]
impl StreamChatProvider for FakeReviewProvider {
    async fn stream_chat(
        &self, _messages: Vec<ChatMessage>, _opts: ChatOpts,
    ) -> Result<BoxStream<'static, Result<TokenDelta, LlmError>>, LlmError> {
        let reply = self.reply.clone();
        let s = async_stream::stream! {
            yield Ok(TokenDelta::Text(reply));
            yield Ok(TokenDelta::Done);
        };
        Ok(Box::pin(s))
    }
    fn provider_type(&self) -> &'static str { "fake" }
    fn model_name(&self) -> &str { "fake" }
}

#[tokio::test]
async fn dedicated_stage_parses_provider_output() {
    let (_server, state, pid, _token) = setup_project("rev-dedicated").await;
    // a step2 output long enough to trigger + containing a REVIEW marker
    let step2 = format!("---REVIEW: suggestion | From Step2---\nx\n---END REVIEW---\n{}", "y".repeat(10_000));
    assert!(should_run_dedicated_review_stage(&step2));

    let provider = FakeReviewProvider {
        reply: "---REVIEW: missing-page | From Dedicated---\nA gap.\nOPTIONS: Create Page | Skip\nSEARCH: gap query\n---END REVIEW---".into(),
    };
    let step1 = serde_json::json!({"entities":[],"connections":[],"contradictions":[]});
    let out = run_dedicated_review_stage(&state, pid, "sources/doc.md", "source text", &step1, &step2, &provider).await.unwrap();
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].review_type, "missing-page");
    assert_eq!(out[0].title, "From Dedicated");
}

#[tokio::test]
async fn dedicated_stage_skips_below_threshold() {
    let (_server, state, pid, _token) = setup_project("rev-skip").await;
    let step2 = "short output, no review"; // below all thresholds
    let provider = FakeReviewProvider { reply: "---REVIEW: suggestion | Should Not Happen---\nx\n---END REVIEW---".into() };
    let step1 = serde_json::json!({});
    let out = run_dedicated_review_stage(&state, pid, "src.md", "t", &step1, step2, &provider).await.unwrap();
    assert!(out.is_empty());
}

// ── Task 5: resolve / dismiss / visibility / filter ──

/// Insert one open review item directly and return its id.
async fn seed_review(state: &llm_wiki_server::AppState, pid: i32, title: &str, rtype: &str, affected: Option<&[&str]>) -> i64 {
    let mut p = parse_review_blocks(
        &format!("---REVIEW: {} | {}---\nBody.\nOPTIONS: Create Page | Skip\n---END REVIEW---", rtype, title),
        "src.md",
    );
    if let Some(pages) = affected {
        p[0].affected_pages = Some(pages.iter().map(|s| s.to_string()).collect());
    }
    insert_review_items(state, pid, &p).await.unwrap();
    sqlx::query_scalar("SELECT id FROM review_items WHERE project_id=$1 AND title=$2")
        .bind(pid).bind(title).fetch_one(&state.db).await.unwrap()
}

#[tokio::test]
async fn resolve_create_page_builds_and_resolves() {
    let (server, state, pid, token) = setup_project("rev-create").await;
    let iid = seed_review(&state, pid, "Add Foo", "missing-page", None).await;
    let user_id: i32 = sqlx::query_scalar("SELECT created_by FROM projects WHERE id=$1")
        .bind(pid).fetch_one(&state.db).await.unwrap();

    let resp = server
        .post(&format!("/api/v1/projects/{}/reviews/{}/resolve", pid, iid))
        .add_header("authorization", auth(&token))
        .content_type("application/json")
        .json(&serde_json::json!({"kind":"create_page"}))
        .await;
    assert_eq!(resp.status_code(), axum::http::StatusCode::OK);
    let body: serde_json::Value = resp.json();
    assert_eq!(body["kind"], "resolved");
    assert_eq!(body["resolvedAction"], "create_page");
    let created_path = body["createdPath"].as_str().unwrap();
    assert!(created_path.starts_with("wiki/concepts/"));

    let title: String = sqlx::query_scalar("SELECT title FROM wiki_pages WHERE project_id=$1 AND path=$2")
        .bind(pid).bind(created_path).fetch_one(&state.db).await.unwrap();
    assert_eq!(title, "Add Foo");

    let status: String = sqlx::query_scalar("SELECT status FROM review_items WHERE id=$1")
        .bind(iid).fetch_one(&state.db).await.unwrap();
    assert_eq!(status, "resolved");
    let resolved_by: i32 = sqlx::query_scalar("SELECT resolved_by FROM review_items WHERE id=$1")
        .bind(iid).fetch_one(&state.db).await.unwrap();
    assert_eq!(resolved_by, user_id);
}

#[tokio::test]
async fn resolve_delete_removes_page_and_resolves() {
    let (server, state, pid, token) = setup_project("rev-delete").await;
    sqlx::query("INSERT INTO wiki_pages (project_id, path, title, content, page_type) VALUES ($1,'wiki/concepts/doomed.md','Doomed','x','concept') ON CONFLICT DO NOTHING")
        .bind(pid).execute(&state.db).await.unwrap();
    let iid = seed_review(&state, pid, "Remove Doomed", "duplicate", Some(&["wiki/concepts/doomed.md"])).await;

    let resp = server
        .post(&format!("/api/v1/projects/{}/reviews/{}/resolve", pid, iid))
        .add_header("authorization", auth(&token))
        .content_type("application/json")
        .json(&serde_json::json!({"kind":"delete"}))
        .await;
    assert_eq!(resp.status_code(), axum::http::StatusCode::OK);
    let body: serde_json::Value = resp.json();
    assert_eq!(body["resolvedAction"], "delete");

    let exists: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM wiki_pages WHERE project_id=$1 AND path=$2")
        .bind(pid).bind("wiki/concepts/doomed.md").fetch_one(&state.db).await.unwrap();
    assert_eq!(exists, 0);
}

#[tokio::test]
async fn resolve_open_returns_content_without_resolving() {
    let (server, state, pid, token) = setup_project("rev-open").await;
    sqlx::query("INSERT INTO wiki_pages (project_id, path, title, content, page_type) VALUES ($1,'wiki/concepts/peek.md','Peek','secret body','concept') ON CONFLICT DO NOTHING")
        .bind(pid).execute(&state.db).await.unwrap();
    let iid = seed_review(&state, pid, "Look at Peek", "confirm", Some(&["wiki/concepts/peek.md"])).await;

    let resp = server
        .post(&format!("/api/v1/projects/{}/reviews/{}/resolve", pid, iid))
        .add_header("authorization", auth(&token))
        .content_type("application/json")
        .json(&serde_json::json!({"kind":"open"}))
        .await;
    assert_eq!(resp.status_code(), axum::http::StatusCode::OK);
    let body: serde_json::Value = resp.json();
    assert_eq!(body["kind"], "opened");
    assert_eq!(body["page"]["content"], "secret body");

    let status: String = sqlx::query_scalar("SELECT status FROM review_items WHERE id=$1")
        .bind(iid).fetch_one(&state.db).await.unwrap();
    assert_eq!(status, "open");
}

#[tokio::test]
async fn resolve_twice_returns_conflict() {
    let (server, _state, pid, token) = setup_project("rev-conflict").await;
    let iid = seed_review(&_state, pid, "Skip Me", "suggestion", None).await;
    let r1 = server.post(&format!("/api/v1/projects/{}/reviews/{}/resolve", pid, iid))
        .add_header("authorization", auth(&token)).content_type("application/json")
        .json(&serde_json::json!({"kind":"skip"})).await;
    assert_eq!(r1.status_code(), axum::http::StatusCode::OK);
    let r2 = server.post(&format!("/api/v1/projects/{}/reviews/{}/resolve", pid, iid))
        .add_header("authorization", auth(&token)).content_type("application/json")
        .json(&serde_json::json!({"kind":"skip"})).await;
    assert_eq!(r2.status_code(), axum::http::StatusCode::CONFLICT);
}

#[tokio::test]
async fn dismiss_marks_dismissed() {
    let (server, state, pid, token) = setup_project("rev-dismiss").await;
    let iid = seed_review(&state, pid, "Dismiss Me", "suggestion", None).await;
    let resp = server.post(&format!("/api/v1/projects/{}/reviews/{}/dismiss", pid, iid))
        .add_header("authorization", auth(&token)).await;
    assert_eq!(resp.status_code(), axum::http::StatusCode::OK);
    let status: String = sqlx::query_scalar("SELECT status FROM review_items WHERE id=$1")
        .bind(iid).fetch_one(&state.db).await.unwrap();
    assert_eq!(status, "dismissed");
}

#[tokio::test]
async fn team_shared_visibility() {
    // user A's project; user B is NOT a member -> 403 on list
    let (server, _state, pid, _token_a) = setup_project("rev-vis").await;
    let uname = unique_prefix("rev-vis-b");
    let user_b = crate::register_user(&server, &uname, &format!("{}@t.com", uname), "password123").await;
    let r = server.get(&format!("/api/v1/projects/{}/reviews", pid))
        .add_header("authorization", auth(&user_b)).await;
    assert_eq!(r.status_code(), axum::http::StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn list_filters_by_status() {
    let (server, state, pid, token) = setup_project("rev-list").await;
    let _open1 = seed_review(&state, pid, "Open One", "suggestion", None).await;
    let open2 = seed_review(&state, pid, "Open Two", "suggestion", None).await;
    // dismiss Open Two
    let _ = server.post(&format!("/api/v1/projects/{}/reviews/{}/dismiss", pid, open2))
        .add_header("authorization", auth(&token)).await;

    let r = server.get(&format!("/api/v1/projects/{}/reviews?status=open", pid))
        .add_header("authorization", auth(&token)).await;
    assert_eq!(r.status_code(), axum::http::StatusCode::OK);
    let list: serde_json::Value = r.json();
    assert_eq!(list.as_array().unwrap().len(), 1);
    assert_eq!(list[0]["title"], "Open One");
}
