// Phase 3 队列可靠性集成测：取消 + 手动重试重置。
// 需 PG(docker @5433) + Redis(@6380)。#[ignore] → 显式 `cargo test --test integration ingest_reliability_test -- --ignored`。
// 照 ingest_queue_test 的自播种 setup（register→team→project via API），不依赖固定 project id。
use llm_wiki_server::services::ingest_queue;
use std::sync::atomic::{AtomicU64, Ordering};

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// 复用 ingest_queue_test 的成熟 setup 模式（唯一 username/project，避免 DB 残留 + 并发冲突）。
async fn setup() -> (axum_test::TestServer, llm_wiki_server::AppState, i32, String) {
    let (app, state) = crate::setup_test_app().await;
    let server = axum_test::TestServer::new(app).unwrap();
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let username = format!("rtest_{}_{}", std::process::id(), n);
    let token = crate::register_user(
        &server,
        &username,
        &format!("{}@t.com", username),
        "password123",
    )
    .await;
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
        .json(&serde_json::json!({"name": format!("rproj-{}", std::process::id()), "team_id": team_id}))
        .await;
    assert_eq!(resp.status_code(), axum::http::StatusCode::CREATED);
    let pid = resp.json::<serde_json::Value>()["id"].as_i64().unwrap() as i32;
    (server, state, pid, token)
}

/// 取消：request_cancel → check_cancel 命中 → mark_cancelled + Err(Cancelled)；status=cancelled。
#[tokio::test]
#[ignore = "requires PG + Redis"]
async fn cancel_marks_cancelled_and_leaves_writes() {
    let (_server, state, pid, token) = setup().await;
    let claims = llm_wiki_server::utils::verify_token(
        &format!("Bearer {}", token),
        state.config.jwt_secret(),
    )
    .unwrap();
    let uid: i32 = claims.sub.parse().unwrap();

    let job_id = ingest_queue::enqueue(&state, pid, uid, vec!["raw/cancel_probe.md".into()])
        .await
        .unwrap();

    // 请求取消（仅置 cancel_requested=TRUE）
    ingest_queue::request_cancel(&state, job_id).await.unwrap();

    // check_cancel 应 mark_cancelled 并返 Err(Cancelled)
    let err = ingest_queue::check_cancel(&state, job_id).await.unwrap_err();
    assert!(
        matches!(err, llm_wiki_server::AppError::Cancelled),
        "应返 AppError::Cancelled，got {:?}",
        err
    );

    let status: String = sqlx::query_scalar("SELECT status FROM ingest_jobs WHERE id=$1")
        .bind(job_id)
        .fetch_one(&state.db)
        .await
        .unwrap();
    assert_eq!(status, "cancelled");
}

/// 手动重试重置 retry_count=0（验证 §6.3：manual_retry 重新发放自动重试额度）。
#[tokio::test]
#[ignore = "requires PG + Redis"]
async fn manual_retry_resets_retry_count() {
    let (_server, state, pid, token) = setup().await;
    let claims = llm_wiki_server::utils::verify_token(
        &format!("Bearer {}", token),
        state.config.jwt_secret(),
    )
    .unwrap();
    let uid: i32 = claims.sub.parse().unwrap();

    let job_id = ingest_queue::enqueue(&state, pid, uid, vec!["raw/retry_probe.md".into()])
        .await
        .unwrap();
    // 模拟自动重试耗尽：status=failed, retry_count=3（== max_retries 默认）
    sqlx::query("UPDATE ingest_jobs SET status='failed', retry_count=3 WHERE id=$1")
        .bind(job_id)
        .execute(&state.db)
        .await
        .unwrap();

    ingest_queue::manual_retry(&state, job_id).await.unwrap();

    let (status, rc): (String, i32) =
        sqlx::query_as("SELECT status, retry_count FROM ingest_jobs WHERE id=$1")
            .bind(job_id)
            .fetch_one(&state.db)
            .await
            .unwrap();
    assert_eq!(status, "pending");
    assert_eq!(rc, 0, "手动重试应重置 retry_count=0，got {}", rc);
}

/// 自动重试机制：worker 瞬态错时调 mark_job_retry_pending（retry_count++、pending、
/// 清 finished_at/progress/stage、重投 redis）。worker 决策依据 is_transient_job_err 另由单测覆盖。
#[tokio::test]
#[ignore = "requires PG + Redis"]
async fn mark_job_retry_pending_advances_retry_state_and_reenqueues() {
    let (_server, state, pid, token) = setup().await;
    let claims = llm_wiki_server::utils::verify_token(
        &format!("Bearer {}", token),
        state.config.jwt_secret(),
    )
    .unwrap();
    let uid: i32 = claims.sub.parse().unwrap();
    let job_id =
        ingest_queue::enqueue(&state, pid, uid, vec!["raw/auto_retry_probe.md".into()])
            .await
            .unwrap();

    // 模拟 worker 连续 3 次瞬态重试
    for attempt in 1..=3i32 {
        ingest_queue::mark_job_retry_pending(&state, job_id, &format!("transient attempt {}", attempt))
            .await
            .unwrap();
        let row: (
            String,
            i32,
            Option<chrono::DateTime<chrono::Utc>>,
            i32,
            Option<String>,
        ) = sqlx::query_as(
            "SELECT status, retry_count, finished_at, progress, stage FROM ingest_jobs WHERE id=$1",
        )
        .bind(job_id)
        .fetch_one(&state.db)
        .await
        .unwrap();
        assert_eq!(row.0, "pending", "attempt {}: status 应 pending", attempt);
        assert_eq!(row.1, attempt, "attempt {}: retry_count 应 {}", attempt, attempt);
        assert!(row.2.is_none(), "attempt {}: finished_at 必须清 NULL", attempt);
        assert_eq!(row.3, 0, "attempt {}: progress 必须清 0", attempt);
        assert!(row.4.is_none(), "attempt {}: stage 必须清 NULL", attempt);
    }

    // 重投 redis：队列里应有该 job（多次 LPUSH 至少 1 次）
    let mut redis = state.redis.get().await.unwrap();
    let members: Vec<String> = redis::cmd("LRANGE")
        .arg("ingest:queue")
        .arg(0)
        .arg(-1)
        .query_async(&mut *redis)
        .await
        .unwrap();
    assert!(
        members.iter().any(|m| m == &job_id.to_string()),
        "job 应被重投到 ingest:queue"
    );

    // 瞬态分类（worker 决策依据）：真实 LLM 5xx 报文格式应判为瞬态
    use llm_wiki_server::AppError;
    assert!(ingest_queue::is_transient_job_err(&AppError::LlmApiError(
        "step1: API error 503: upstream down".into()
    )));
    assert!(ingest_queue::is_transient_job_err(&AppError::IoError(
        std::io::Error::new(std::io::ErrorKind::TimedOut, "x")
    )));
    assert!(!ingest_queue::is_transient_job_err(&AppError::ResourceNotFound(
        "not found".into()
    )));
}

/// 部分续传：item_states 已有 done 的 source 被跳过，且计入 done_this_run——
/// 即使剩余 source 全失败，也不判 all-failed（验证 576b7b5 修复 + 部分续传语义）。
#[tokio::test]
#[ignore = "requires PG + Redis"]
async fn partial_resume_skips_done_source_and_avoids_all_failed() {
    let (_server, state, pid, _token) = setup().await;
    // 建项目存储根目录（让 raw/missing.md 走 "file not found" 而非 "project storage not found"）
    let team_id: i32 =
        sqlx::query_scalar("SELECT team_id FROM projects WHERE id=$1")
            .bind(pid)
            .fetch_one(&state.db)
            .await
            .unwrap();
    let base = format!("/tmp/llmwiki_storage/teams/{}/projects/{}", team_id, pid);
    let _ = std::fs::create_dir_all(format!("{}/raw", base));

    // 构造 job：source_paths=[done 的 + 缺失的]，item_states 已标记 done
    let job_id = uuid::Uuid::new_v4();
    let item_states = serde_json::json!([
        { "path": "raw/done_probe.md", "status": "done", "error": null }
    ]);
    sqlx::query(
        "INSERT INTO ingest_jobs (id, project_id, source_paths, status, item_states) \
         VALUES ($1, $2, ARRAY['raw/done_probe.md','raw/missing.md'], 'running', $3)",
    )
    .bind(job_id)
    .bind(pid)
    .bind(&item_states)
    .execute(&state.db)
    .await
    .unwrap();

    // 直接调 run_ingest_job（不经 worker）
    let job: llm_wiki_server::services::ingest_queue::IngestJob =
        sqlx::query_as("SELECT * FROM ingest_jobs WHERE id=$1")
            .bind(job_id)
            .fetch_one(&state.db)
            .await
            .unwrap();
    let result =
        llm_wiki_server::services::ingest_pipeline::run_ingest_job(&state, &job).await;

    // 关键断言：NOT all-failed（done_this_run 计了 already_done 的 source）→ Ok，warnings 非空
    assert!(
        result.is_ok(),
        "部分续传 + 剩余失败应返回 Ok（succeeded_with_warnings），不应 all-failed；got {:?}",
        result.err()
    );
    let res = result.unwrap();
    assert!(!res.warnings.is_empty(), "raw/missing.md 失败应产生 warning");
}

/// SSE 广播管道：subscribe() 后触发终态 emit（check_cancel→mark_cancelled→emit "job_cancelled"），
/// recv 到对应 JobEvent。这是 stream_job 的 subscribe-before-snapshot 核心逻辑（HTTP 层经烟测覆盖）。
#[tokio::test]
#[ignore = "requires PG + Redis"]
async fn job_events_broadcast_delivers_terminal_event() {
    let (_server, state, pid, _token) = setup().await;
    let job_id = uuid::Uuid::new_v4();
    sqlx::query(
        "INSERT INTO ingest_jobs (id, project_id, source_paths, status, cancel_requested) \
         VALUES ($1, $2, ARRAY['raw/sse_probe.md'], 'pending', TRUE)",
    )
    .bind(job_id)
    .bind(pid)
    .execute(&state.db)
    .await
    .unwrap();

    // ⚠️ 先 subscribe（模拟 stream_job 的 subscribe-before-snapshot）
    let mut rx = state.job_events.subscribe();
    // 触发终态：check_cancel → mark_job_cancelled → emit "job_cancelled"
    let err = ingest_queue::check_cancel(&state, job_id).await.unwrap_err();
    assert!(matches!(err, llm_wiki_server::AppError::Cancelled));

    // recv 应拿到 job_cancelled 事件
    let evt = tokio::time::timeout(std::time::Duration::from_secs(2), rx.recv())
        .await
        .expect("recv 超时")
        .expect("channel closed");
    assert_eq!(evt.job_id, job_id);
    assert_eq!(evt.kind, "job_cancelled");
}

/// #2 回归：update_job_stage 发 stage_changed 事件（spec §8.2 进度推送，SSE 客户端可见 stage/progress）。
#[tokio::test]
#[ignore = "requires PG + Redis"]
async fn update_job_stage_emits_stage_changed_event() {
    let (_server, state, pid, _token) = setup().await;
    let job_id = uuid::Uuid::new_v4();
    sqlx::query(
        "INSERT INTO ingest_jobs (id, project_id, source_paths, status) \
         VALUES ($1, $2, ARRAY['raw/stage_probe.md'], 'running')",
    )
    .bind(job_id)
    .bind(pid)
    .execute(&state.db)
    .await
    .unwrap();

    let mut rx = state.job_events.subscribe();
    ingest_queue::update_job_stage(&state, job_id, "parsing", 42)
        .await
        .unwrap();

    let evt = tokio::time::timeout(std::time::Duration::from_secs(2), rx.recv())
        .await
        .expect("recv 超时")
        .expect("channel closed");
    assert_eq!(evt.kind, "stage_changed");
    assert_eq!(evt.job_id, job_id);
    assert_eq!(evt.payload["stage"], "parsing");
    assert_eq!(evt.payload["progress"], 42);
}

/// #2 回归：mark_job_running 发 job_running 事件 + 置 status=running（worker 取到 job 时 SSE 可知 job 开始跑）。
#[tokio::test]
#[ignore = "requires PG + Redis"]
async fn mark_job_running_emits_job_running_event() {
    let (_server, state, pid, _token) = setup().await;
    let job_id = uuid::Uuid::new_v4();
    sqlx::query(
        "INSERT INTO ingest_jobs (id, project_id, source_paths, status) \
         VALUES ($1, $2, ARRAY['raw/running_probe.md'], 'pending')",
    )
    .bind(job_id)
    .bind(pid)
    .execute(&state.db)
    .await
    .unwrap();

    let mut rx = state.job_events.subscribe();
    ingest_queue::mark_job_running(&state, job_id).await.unwrap();

    let evt = tokio::time::timeout(std::time::Duration::from_secs(2), rx.recv())
        .await
        .expect("recv 超时")
        .expect("channel closed");
    assert_eq!(evt.kind, "job_running");
    assert_eq!(evt.job_id, job_id);

    let status: String = sqlx::query_scalar("SELECT status FROM ingest_jobs WHERE id=$1")
        .bind(job_id)
        .fetch_one(&state.db)
        .await
        .unwrap();
    assert_eq!(status, "running");
}
