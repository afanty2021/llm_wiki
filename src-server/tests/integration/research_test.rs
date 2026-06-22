use axum::http::StatusCode;
use futures::stream::BoxStream;
use llm_wiki_server::services::llm_stream::{
    ChatMessage, ChatOpts, LlmError, StreamChatProvider, TokenDelta,
};
use llm_wiki_server::services::research::synthesize::run_research_job;
use llm_wiki_server::services::web_search::{WebSearchError, WebSearchProvider, WebSearchResult};
use std::sync::atomic::{AtomicU64, Ordering};

static COUNTER: AtomicU64 = AtomicU64::new(0);

fn unique_prefix(tag: &str) -> String {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    format!("{}_{}_{}", tag, std::process::id(), n)
}

async fn setup_project(
    tag: &str,
) -> (axum_test::TestServer, llm_wiki_server::AppState, i32, String) {
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
    let team_id: i32 =
        sqlx::query_scalar("SELECT id FROM teams WHERE created_by = (SELECT id FROM users WHERE username = $1)")
            .bind(&username)
            .fetch_one(&state.db)
            .await
            .unwrap();
    let resp = server
        .post("/api/v1/projects")
        .add_header("authorization", format!("Bearer {}", token))
        .json(&serde_json::json!({"name":"test-proj","team_id":team_id}))
        .await;
    assert_eq!(resp.status_code(), StatusCode::CREATED);
    let pid = resp.json::<serde_json::Value>()["id"].as_i64().unwrap() as i32;
    (server, state, pid, token)
}

#[allow(dead_code)]
fn auth(token: &str) -> String {
    format!("Bearer {}", token)
}

struct FakeWeb {
    results: Vec<WebSearchResult>,
}

#[async_trait::async_trait]
impl WebSearchProvider for FakeWeb {
    async fn search(
        &self,
        _q: &str,
        _m: u8,
    ) -> Result<Vec<WebSearchResult>, WebSearchError> {
        Ok(self.results.clone())
    }
    fn provider_type(&self) -> &'static str {
        "fake"
    }
}

struct FakeLlm {
    reply: String,
    fail: bool,
}

#[async_trait::async_trait]
impl StreamChatProvider for FakeLlm {
    async fn stream_chat(
        &self,
        _m: Vec<ChatMessage>,
        _o: ChatOpts,
    ) -> Result<BoxStream<'static, Result<TokenDelta, LlmError>>, LlmError> {
        let reply = self.reply.clone();
        let fail = self.fail;
        let s = async_stream::stream! {
            if fail {
                yield Err(LlmError::ApiError { status: 500, body: "boom".into() });
                return;
            }
            yield Ok(TokenDelta::Text(reply));
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

async fn seed_task(
    state: &llm_wiki_server::AppState,
    pid: i32,
    topic: &str,
    queries: Option<Vec<String>>,
) -> llm_wiki_server::services::research::ResearchTask {
    use llm_wiki_server::services::research::enqueue_research_task;
    let id = enqueue_research_task(state, pid, None, topic, queries, "manual")
        .await
        .unwrap();
    sqlx::query_as::<_, llm_wiki_server::services::research::ResearchTask>(
        "SELECT * FROM research_tasks WHERE id=$1",
    )
    .bind(id)
    .fetch_one(&state.db)
    .await
    .unwrap()
}

#[tokio::test]
async fn run_research_job_happy_path() {
    let (_server, state, pid, _token) = setup_project("res-happy").await;
    let task = seed_task(&state, pid, "topic-x", None).await;
    let web = FakeWeb {
        results: vec![WebSearchResult {
            title: "T".into(),
            url: "u".into(),
            snippet: "s".into(),
            source: "t".into(),
        }],
    };
    let llm = FakeLlm {
        reply: "# topic-x\n\nsynthesis body".into(),
        fail: false,
    };
    let out = run_research_job(&state, &task, "2026-06-22", 8000, &web, &llm)
        .await
        .unwrap();
    assert!(out.path.starts_with("wiki/queries/research-"));
    assert!(out.path.ends_with("-2026-06-22.md"));
    let n: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM wiki_pages WHERE project_id=$1 AND path=$2")
            .bind(pid)
            .bind(&out.path)
            .fetch_one(&state.db)
            .await
            .unwrap();
    assert_eq!(n, 1);
    let has_web: bool =
        sqlx::query_scalar("SELECT web_results IS NOT NULL FROM research_tasks WHERE id=$1")
            .bind(task.id)
            .fetch_one(&state.db)
            .await
            .unwrap();
    assert!(has_web);
}

#[tokio::test]
async fn run_research_job_zero_sources_is_error() {
    let (_server, state, pid, _token) = setup_project("res-zero").await;
    let task = seed_task(&state, pid, "topic-z", Some(vec!["q".into()])).await;
    let web = FakeWeb { results: vec![] };
    let llm = FakeLlm { reply: "x".into(), fail: false };
    let err = run_research_job(&state, &task, "2026-06-22", 8000, &web, &llm)
        .await
        .unwrap_err();
    let s = format!("{}", err);
    assert!(s.contains("no web sources"), "got: {}", s);
}

#[tokio::test]
async fn run_research_job_synth_fail_is_error() {
    let (_server, state, pid, _token) = setup_project("res-synthfail").await;
    let task = seed_task(&state, pid, "topic-f", None).await;
    let web = FakeWeb {
        results: vec![WebSearchResult {
            title: "T".into(),
            url: "u".into(),
            snippet: "s".into(),
            source: "t".into(),
        }],
    };
    let llm = FakeLlm { reply: String::new(), fail: true };
    let err = run_research_job(&state, &task, "2026-06-22", 8000, &web, &llm)
        .await
        .unwrap_err();
    assert!(format!("{}", err).contains("synthesize"));
    let has_web: bool =
        sqlx::query_scalar("SELECT web_results IS NOT NULL FROM research_tasks WHERE id=$1")
            .bind(task.id)
            .fetch_one(&state.db)
            .await
            .unwrap();
    assert!(has_web, "web_results must persist before synthesis stage");
}

#[tokio::test]
async fn run_research_job_empty_synthesis_is_error() {
    let (_server, state, pid, _token) = setup_project("res-empty").await;
    let task = seed_task(&state, pid, "topic-e", None).await;
    let web = FakeWeb {
        results: vec![WebSearchResult {
            title: "T".into(),
            url: "u".into(),
            snippet: "s".into(),
            source: "t".into(),
        }],
    };
    // LLM 只输出 think 块,strip_thinking 后为空
    let llm = FakeLlm {
        reply: "<think>only thinking</think>".into(),
        fail: false,
    };
    let err = run_research_job(&state, &task, "2026-06-22", 8000, &web, &llm)
        .await
        .unwrap_err();
    assert!(
        format!("{}", err).contains("empty synthesis"),
        "got: {}",
        err
    );
}

#[tokio::test]
async fn recover_pending_requeues_non_terminal_tasks() {
    let (_server, state, pid, _token) = setup_project("res-recover").await;
    use llm_wiki_server::services::research::enqueue_research_task;
    let _a = enqueue_research_task(&state, pid, None, "t1", None, "manual").await.unwrap();
    let _b = enqueue_research_task(&state, pid, None, "t2", None, "manual").await.unwrap();
    let n: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM research_tasks WHERE project_id=$1 AND status IN ('queued','searching','synthesizing','saving')")
        .bind(pid).fetch_one(&state.db).await.unwrap();
    assert_eq!(n, 2);
    sqlx::query("UPDATE research_tasks SET status='done' WHERE topic='t1'").execute(&state.db).await.unwrap();
    let n2: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM research_tasks WHERE project_id=$1 AND status IN ('queued','searching','synthesizing','saving')")
        .bind(pid).fetch_one(&state.db).await.unwrap();
    assert_eq!(n2, 1);
}

// --- Phase C Task 7: HTTP 端点测试 ---

#[tokio::test]
async fn enqueue_rejects_without_search_provider() {
    let (server, _state, pid, token) = setup_project("res-noprovider").await;
    let r = server
        .post(&format!("/api/v1/projects/{}/research", pid))
        .add_header("authorization", &auth(&token))
        .json(&serde_json::json!({"topic":"x"}))
        .await;
    assert_eq!(r.status_code(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn enqueue_rejects_empty_topic() {
    let (server, state, pid, token) = setup_project("res-emptytopic").await;
    let key = derive_test_key();
    let team_id: i32 = sqlx::query_scalar("SELECT team_id FROM projects WHERE id=$1")
        .bind(pid)
        .fetch_one(&state.db)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO search_providers (team_id, provider_type, api_key_encrypted) VALUES ($1,'tavily',$2)",
    )
    .bind(team_id)
    .bind(key)
    .execute(&state.db)
    .await
    .unwrap();
    let r = server
        .post(&format!("/api/v1/projects/{}/research", pid))
        .add_header("authorization", &auth(&token))
        .json(&serde_json::json!({"topic":"   "}))
        .await;
    assert_eq!(r.status_code(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn team_visibility_forbidden() {
    let (server, _state, pid, _token_a) = setup_project("res-vis").await;
    let uname = unique_prefix("res-vis-b");
    let user_b =
        crate::register_user(&server, &uname, &format!("{}@t.com", uname), "password123").await;
    let r = server
        .post(&format!("/api/v1/projects/{}/research", pid))
        .add_header("authorization", &auth(&user_b))
        .json(&serde_json::json!({"topic":"x"}))
        .await;
    assert_eq!(r.status_code(), StatusCode::FORBIDDEN);
}

fn derive_test_key() -> String {
    let cfg = llm_wiki_server::AppConfig::from_env().expect("config");
    let secret = cfg.jwt_secret();
    let mut key = [0u8; 32];
    let len = secret.len().min(32);
    key[..len].copy_from_slice(&secret.as_bytes()[..len]);
    llm_wiki_server::utils::crypto::encrypt_api_key("dummy-tavily-key", &key).unwrap()
}

// --- Phase C Task 8: search_provider team-scoped CRUD ---

#[tokio::test]
async fn search_provider_crud_and_key_roundtrip() {
    let (server, state, pid, token) = setup_project("res-crud").await;
    let team_id: i32 = sqlx::query_scalar("SELECT team_id FROM projects WHERE id=$1")
        .bind(pid)
        .fetch_one(&state.db)
        .await
        .unwrap();
    let r = server
        .post(&format!("/api/v1/teams/{}/search-providers", team_id))
        .add_header("authorization", &auth(&token))
        .json(&serde_json::json!({"provider_type":"tavily","api_key":"secret-xyz"}))
        .await;
    assert_eq!(r.status_code(), StatusCode::CREATED);
    let body: serde_json::Value = r.json();
    assert_eq!(body["provider_type"], "tavily");
    assert_eq!(body["has_key"], true);
    assert!(
        body.get("api_key").is_none(),
        "GET 响应不得回传 api_key"
    );
    let sid = body["id"].as_i64().unwrap();
    let g = server
        .get(&format!("/api/v1/teams/{}/search-providers", team_id))
        .add_header("authorization", &auth(&token))
        .await;
    let gb: serde_json::Value = g.json();
    assert!(
        gb.get("api_key").is_none() || gb["api_key"].is_null(),
        "GET 响应不得回传 api_key"
    );
    let enc: String =
        sqlx::query_scalar("SELECT api_key_encrypted FROM search_providers WHERE id=$1")
            .bind(sid)
            .fetch_one(&state.db)
            .await
            .unwrap();
    assert_ne!(enc, "secret-xyz", "DB 必须存密文");
    let plain =
        llm_wiki_server::services::llm::decrypt_api_key(&enc, &state.config).unwrap();
    assert_eq!(plain, "secret-xyz");
    let d = server
        .delete(&format!("/api/v1/teams/{}/search-providers/{}", team_id, sid))
        .add_header("authorization", &auth(&token))
        .await;
    assert_eq!(d.status_code(), StatusCode::OK);
    let n: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM search_providers WHERE id=$1")
            .bind(sid)
            .fetch_one(&state.db)
            .await
            .unwrap();
    assert_eq!(n, 0);
}
