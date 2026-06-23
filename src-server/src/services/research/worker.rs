// src/services/research/worker.rs — research 队列 worker（仿 ingest_worker，并发 Semaphore 3）。
use crate::services::research::ResearchTask;
use crate::{AppError, AppState};
use std::sync::Arc;
use std::time::Duration;
use uuid::Uuid;

pub fn spawn_worker(state: AppState) {
    tokio::spawn(async move {
        tracing::info!("research worker started");
        if let Err(e) = recover_pending(&state).await {
            tracing::error!("research recover_pending: {}", e);
        }
        let sem = Arc::new(tokio::sync::Semaphore::new(3));
        worker_loop(state, sem).await;
    });
}

async fn worker_loop(state: AppState, sem: Arc<tokio::sync::Semaphore>) {
    loop {
        let task_uuid: Uuid = {
            let mut redis = match state.redis.get().await {
                Ok(c) => c,
                Err(e) => {
                    tracing::error!("redis get: {} — retry 5s", e);
                    tokio::time::sleep(Duration::from_secs(5)).await;
                    continue;
                }
            };
            let (_, v): (String, String) = match redis::cmd("BRPOP")
                .arg("research:queue").arg("0").query_async(&mut *redis).await
            {
                Ok(v) => v,
                Err(e) => {
                    tracing::error!("BRPOP research:queue: {} — retry 2s", e);
                    tokio::time::sleep(Duration::from_secs(2)).await;
                    continue;
                }
            };
            match v.parse() {
                Ok(id) => id,
                Err(e) => { tracing::warn!("bad uuid {}: {}", v, e); continue; }
            }
        };
        let permit = sem.clone().acquire_owned().await.unwrap();
        let state = state.clone();
        tokio::spawn(async move {
            let _permit = permit; // RAII：子 task 结束即释放
            run_research_job_wrapped(&state, task_uuid).await;
        });
    }
}

async fn recover_pending(state: &AppState) -> Result<usize, AppError> {
    let pending: Vec<Uuid> = sqlx::query_scalar(
        "SELECT id FROM research_tasks WHERE status IN ('queued','searching','synthesizing','saving')")
        .fetch_all(&state.db).await?;
    if pending.is_empty() { return Ok(0); }
    let mut redis = state.redis.get().await.map_err(AppError::from)?;
    for id in &pending {
        let _: i64 = redis::cmd("LPUSH").arg("research:queue").arg(id.to_string())
            .query_async(&mut *redis).await
            .unwrap_or_else(|e| { tracing::error!("recover LPUSH {}: {}", id, e); 0 });
    }
    Ok(pending.len())
}

async fn fetch_and_mark_running(state: &AppState, task_uuid: Uuid) -> Result<ResearchTask, AppError> {
    let task: ResearchTask = sqlx::query_as("SELECT * FROM research_tasks WHERE id=$1")
        .bind(task_uuid).fetch_optional(&state.db).await?
        .ok_or_else(|| AppError::ResourceNotFound("research task".into()))?;
    sqlx::query("UPDATE research_tasks SET status='searching', started_at=COALESCE(started_at, NOW()), updated_at=NOW() WHERE id=$1")
        .bind(task_uuid).execute(&state.db).await?;
    Ok(task)
}

pub async fn mark_done(state: &AppState, task_id: Uuid, synthesis: &str, path: &str) -> Result<(), AppError> {
    sqlx::query("UPDATE research_tasks SET status='done', synthesis=$1, saved_path=$2, finished_at=NOW(), updated_at=NOW() WHERE id=$3")
        .bind(synthesis).bind(path).bind(task_id).execute(&state.db).await?;
    Ok(())
}
pub async fn mark_error(state: &AppState, task_id: Uuid, error: &str) -> Result<(), AppError> {
    sqlx::query("UPDATE research_tasks SET status='error', error=$1, finished_at=NOW(), updated_at=NOW() WHERE id=$2")
        .bind(error).bind(task_id).execute(&state.db).await?;
    Ok(())
}

async fn run_research_job_wrapped(state: &AppState, task_uuid: Uuid) {
    let task = match fetch_and_mark_running(state, task_uuid).await {
        Ok(t) => t,
        Err(e) => { let _ = mark_error(state, task_uuid, &e.to_string()).await; return; }
    };
    let web = match crate::services::web_search::provider_for_project(state, task.project_id).await {
        Ok(p) => p,
        Err(e) => { let _ = mark_error(state, task.id, &format!("web provider: {e}")).await; return; }
    };
    let llm = match crate::services::llm_stream::provider_for_project(state, task.project_id).await {
        Ok(p) => p,
        Err(e) => { let _ = mark_error(state, task.id, &format!("llm provider: {e}")).await; return; }
    };
    let date = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let context_size = match crate::services::llm::get_llm_config(&state.db, task.project_id).await {
        Ok(c) => c.context_size,
        Err(e) => { let _ = mark_error(state, task.id, &format!("llm config: {e}")).await; return; }
    };
    match crate::services::research::synthesize::run_research_job(state, &task, &date, context_size, &*web, &*llm).await {
        Ok(o) => { let _ = mark_done(state, task.id, &o.synthesis, &o.path).await; }
        Err(e) => { let _ = mark_error(state, task.id, &e.to_string()).await; }
    }
}
