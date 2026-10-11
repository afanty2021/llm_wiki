// services/ingest_worker.rs
// ingest worker 调度层——redis 触发队列消费 + 同进程 tokio task + 重启恢复。
// D (ingest_pipeline) 已就绪：worker_loop 取到 job → run_ingest_job → 按结果标记 succeeded/failed。

use uuid::Uuid;
use crate::{AppError, AppState};
use crate::services::ingest_queue::IngestJob;

/// job 级消费者数收敛 1..=8（镜像 ingest_pipeline::clamp_source_concurrency；
/// config 侧只存原始值，消费点读取时统一过本函数，集成测试直接改
/// state.config.ingest.worker_concurrency 后无需自行 clamp）。
fn clamp_worker_concurrency(n: usize) -> usize {
    n.clamp(1, 8)
}

/// server 启动时调用一次：recover_pending 后 spawn N 个 worker_loop 竞争消费。
pub fn spawn_worker(state: AppState) {
    tokio::spawn(async move {
        tracing::info!("ingest worker started");

        match recover_pending(&state).await {
            Ok(n) if n > 0 => tracing::info!("recovered {} pending ingest jobs", n),
            Ok(_) => {}
            Err(e) => tracing::error!("recover_pending error: {}", e),
        }

        // recover 必须先于消费者起跑：消费者会把领取到的 job 标成 running，若 recover
        // 晚于消费者，会把在飞 job 当 stale 再投回队列——N≥2 时重复副本可能被第二个
        // 消费者并发弹出双跑。N 个消费者竞争 BRPOP 天然各领各的 job（job 级并发 =
        // worker_concurrency，上界 1..=8 镜像 source 级 clamp——BRPOP 阻塞任务各占一条
        // 共享池连接，无界 env 手滑会饿死同池 research worker，评审 I-2）。
        let consumers = clamp_worker_concurrency(state.config.ingest.worker_concurrency);
        tracing::info!("ingest worker consumers: {}", consumers);
        for _ in 0..consumers {
            let st = state.clone();
            tokio::spawn(worker_loop(st));
        }
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

        // 条件认领（I-1）：0 行 = recover 叠加的重复队列副本或已终态陈旧副本——跳过
        // 不跑，同 job 永远只被一个消费者真执行。认领查询出错同样跳过：DB 不健康时
        // run_ingest_job 也活不成，pending 行留待下次重启 recover_pending 重投。
        match crate::services::ingest_queue::mark_job_running(&state, job_id).await {
            Ok(1) => {}
            Ok(n) => {
                tracing::warn!("job {} claim skipped (rows_affected={}): 重复队列副本或已终态", job_id, n);
                continue;
            }
            Err(e) => {
                tracing::error!("claim job {}: {}——skip, 留待 recover", job_id, e);
                continue;
            }
        }

        // D (ingest_pipeline) 已就绪：执行 job，按结果标记 succeeded/failed。
        match crate::services::ingest_pipeline::run_ingest_job(&state, &job).await {
            Ok(result) => {
                tracing::info!(
                    "job {} done: {} new pages, {} merged pages, {} reserved, {} warnings",
                    job_id,
                    result.new_pages.len(),
                    result.merged_pages.len(),
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

#[cfg(test)]
mod tests {
    use super::clamp_worker_concurrency;

    #[test]
    fn clamp_worker_concurrency_bounds() {
        assert_eq!(clamp_worker_concurrency(0), 1);
        assert_eq!(clamp_worker_concurrency(1), 1);
        assert_eq!(clamp_worker_concurrency(2), 2);
        assert_eq!(clamp_worker_concurrency(8), 8);
        assert_eq!(clamp_worker_concurrency(9), 8);
        assert_eq!(clamp_worker_concurrency(usize::MAX), 8);
    }
}
