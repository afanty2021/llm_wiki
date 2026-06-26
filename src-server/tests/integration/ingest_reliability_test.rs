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
