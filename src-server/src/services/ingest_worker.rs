// services/ingest_worker.rs
// ingest worker 调度层——redis 触发队列消费 + 同进程 tokio task + 重启恢复。
// D (ingest_pipeline) 已就绪：worker_loop 取到 job → run_ingest_job → 按结果标记 succeeded/failed。

use uuid::Uuid;
use crate::{AppError, AppState};
use crate::services::ingest_queue::IngestJob;

/// server 启动时调用一次。spawn tokio task → recover_pending → worker_loop。
pub fn spawn_worker(state: AppState) {
    tokio::spawn(async move {
        tracing::info!("ingest worker started");

        match recover_pending(&state).await {
            Ok(n) if n > 0 => tracing::info!("recovered {} pending ingest jobs", n),
            Ok(_) => {}
            Err(e) => tracing::error!("recover_pending error: {}", e),
        }

        worker_loop(state).await;

        tracing::info!("ingest worker stopped");
    });
}

async fn worker_loop(state: AppState) {
    loop {
        // BRPOP 阻塞等待（0 = 无限超时）；返回 (key, value) tuple
        let (queue_key, job_id_str): (String, String) = {
            let mut redis = match state.redis.get().await {
                Ok(c) => c,
                Err(e) => {
                    tracing::error!("redis get in worker: {}——retry in 5s", e);
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                    continue;
                }
            };
            match redis::cmd("BRPOP")
                .arg("ingest:queue")
                .arg("0")
                .query_async(&mut *redis)
                .await
            {
                Ok(val) => val,
                Err(e) => {
                    tracing::error!("BRPOP error: {}——retry in 2s", e);
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                    continue;
                }
            }
        };
        let _ = queue_key; // BRPOP key，已确认是 "ingest:queue"

        let job_id: Uuid = match job_id_str.parse() {
            Ok(id) => id,
            Err(e) => {
                tracing::warn!("invalid job_id in queue: {}——skipping: {}", job_id_str, e);
                continue;
            }
        };

        // 从 PG 取完整 job 详情
        let job: IngestJob = match sqlx::query_as::<_, IngestJob>(
            "SELECT * FROM ingest_jobs WHERE id = $1"
        )
        .bind(job_id)
        .fetch_optional(&state.db)
        .await
        {
            Ok(Some(j)) => j,
            Ok(None) => {
                tracing::warn!("job {} not found in PG——stale queue entry", job_id);
                continue;
            }
            Err(e) => {
                tracing::error!("fetch job {}: {}", job_id, e);
                continue;
            }
        };

        // 标记 running（pending→running + started_at + 发 job_running 事件，#2：经 mark_job_running 统一发事件）
        let _ = crate::services::ingest_queue::mark_job_running(&state, job_id).await;

        // D (ingest_pipeline) 已就绪：执行 job，按结果标记 succeeded/failed。
        match crate::services::ingest_pipeline::run_ingest_job(&state, &job).await {
            Ok(result) => {
                tracing::info!(
                    "job {} done: {} new pages, {} reserved, {} warnings",
                    job_id,
                    result.new_pages.len(),
                    result.updated_reserved.len(),
                    result.warnings.len()
                );
                if result.warnings.is_empty() {
                    let _ = crate::services::ingest_queue::mark_job_succeeded(&state, job_id, &result)
                        .await;
                } else {
                    let _ = crate::services::ingest_queue::mark_job_succeeded_with_warnings(&state, job_id, &result)
                        .await;
                }
            }
            Err(AppError::Cancelled) => {
                // pipeline check_cancel 已 mark_job_cancelled；此处仅记日志，不重试、不 mark_failed
                tracing::info!("job {} cancelled at checkpoint", job_id);
            }
            Err(e) => {
                // 瞬态 & 额度内 → 退避后重投；否则 mark_failed
                let transient = crate::services::ingest_queue::is_transient_job_err(&e);
                let under_budget = job.retry_count < job.max_retries;
                if transient && under_budget {
                    tracing::warn!(
                        "job {} transient err (attempt {}/{}): {}——retry after backoff",
                        job_id, job.retry_count, job.max_retries, e
                    );
                    tokio::time::sleep(crate::services::embedding::backoff_delay(job.retry_count as u32)).await;
                    let _ = crate::services::ingest_queue::mark_job_retry_pending(&state, job_id, &e.to_string())
                        .await;
                } else {
                    tracing::error!("job {} failed: {}", job_id, e);
                    let _ = crate::services::ingest_queue::mark_job_failed(&state, job_id, &e.to_string())
                        .await;
                }
            }
        }
    }
}

/// 启动时扫描 PG 中未完成的 job（pending + running）→ 重新 LPUSH 到队列。
/// "running" 的 job 是上次崩溃/重启前正在处理的——pipeline 内缓存+幂等 upsert 保证重投安全。
async fn recover_pending(state: &AppState) -> Result<usize, AppError> {
    let pending: Vec<Uuid> = sqlx::query_scalar(
        "SELECT id FROM ingest_jobs WHERE status IN ('pending', 'running')"
    )
    .fetch_all(&state.db)
    .await?;

    if pending.is_empty() { return Ok(0); }

    let mut redis = state.redis.get().await.map_err(AppError::from)?;
    for id in &pending {
        let _: i64 = redis::cmd("LPUSH")
            .arg("ingest:queue")
            .arg(id.to_string())
            .query_async(&mut *redis)
            .await
            .unwrap_or_else(|e| {
                tracing::error!("recover_pending LPUSH {}: {}", id, e);
                0
            });
    }
    Ok(pending.len())
}
