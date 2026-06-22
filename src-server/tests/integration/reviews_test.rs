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
