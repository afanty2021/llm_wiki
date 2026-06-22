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
