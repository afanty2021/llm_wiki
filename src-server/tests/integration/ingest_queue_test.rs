use llm_wiki_server::services::ingest_queue::IngestJobResult;
use std::sync::atomic::{AtomicU64, Ordering};

/// 全局单调计数器，保证同进程并发测试 username 绝对唯一
/// （照 pages_test.rs 的 unique_prefix 模式，subsec_nanos 并发可碰撞）。
static COUNTER: AtomicU64 = AtomicU64::new(0);

/// 复用 pages_test 的成熟 setup 模式：register → 查 team_id → POST /projects。
/// 每次跑用唯一 username/project，避免 live DB 残留 + 并发冲突。
async fn setup() -> (
    axum_test::TestServer,
    llm_wiki_server::AppState,
    i32,
    String,
) {
    let (app, state) = crate::setup_test_app().await;
    let server = axum_test::TestServer::new(app).unwrap();
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let username = format!("qtest_{}_{}", std::process::id(), n);
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
        .json(&serde_json::json!({"name": format!("qproj-{}", std::process::id()), "team_id": team_id}))
        .await;
    assert_eq!(resp.status_code(), axum::http::StatusCode::CREATED);
    let pid = resp.json::<serde_json::Value>()["id"].as_i64().unwrap() as i32;
    (server, state, pid, token)
}

#[tokio::test]
async fn enqueue_and_job_status_roundtrip() {
    let (_server, state, pid, token) = setup().await;
    let claims = llm_wiki_server::utils::verify_token(
        &format!("Bearer {}", token),
        state.config.jwt_secret(),
    )
    .unwrap();
    let uid: i32 = claims.sub.parse().unwrap();

    let job_id = llm_wiki_server::services::ingest_queue::enqueue(
        &state,
        pid,
        uid,
        vec!["test/foo.md".into()],
    )
    .await
    .unwrap();

    let job = llm_wiki_server::services::ingest_queue::job_status(&state, job_id)
        .await
        .unwrap();
    assert_eq!(job.status, "pending");
    assert_eq!(job.progress, 0);

    let mut redis = state.redis.get().await.unwrap();
    let queue_len: i64 = redis::cmd("LLEN")
        .arg("ingest:queue")
        .query_async(&mut *redis)
        .await
        .unwrap();
    assert!(queue_len >= 1, "queue should have at least 1 item");
}

#[tokio::test]
async fn mark_job_lifecycle() {
    let (_server, state, pid, token) = setup().await;
    let claims = llm_wiki_server::utils::verify_token(
        &format!("Bearer {}", token),
        state.config.jwt_secret(),
    )
    .unwrap();
    let uid: i32 = claims.sub.parse().unwrap();

    let job_id = llm_wiki_server::services::ingest_queue::enqueue(
        &state,
        pid,
        uid,
        vec!["test/bar.md".into()],
    )
    .await
    .unwrap();

    llm_wiki_server::services::ingest_queue::update_job_stage(
        &state,
        job_id,
        "analyzing",
        30,
    )
    .await
    .unwrap();
    let job = llm_wiki_server::services::ingest_queue::job_status(&state, job_id)
        .await
        .unwrap();
    assert_eq!(job.stage.as_deref(), Some("analyzing"));
    assert_eq!(job.progress, 30);

    let result = IngestJobResult {
        new_pages: vec!["concepts/x.md".into()],
        updated_reserved: vec![],
        warnings: vec![],
    };
    llm_wiki_server::services::ingest_queue::mark_job_succeeded(&state, job_id, &result)
        .await
        .unwrap();
    let job = llm_wiki_server::services::ingest_queue::job_status(&state, job_id)
        .await
        .unwrap();
    assert_eq!(job.status, "succeeded");
    assert_eq!(job.progress, 100);
    assert!(job.result.is_some());

    // Phase 3 新字段默认值（T4 扩 JobResponse）
    assert_eq!(job.retry_count, 0);
    assert!(!job.cancel_requested);

    let jobs = llm_wiki_server::services::ingest_queue::list_jobs(&state, pid, None, None)
        .await
        .unwrap();
    assert!(!jobs.is_empty());
}
