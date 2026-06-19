// services/ingest_queue.rs
// ingest job 数据模型 + 入队/查询/进度更新 helper。
// 所有 job 详情只存 PG（不存 redis）。redis 仅做触发队列（ingest:queue list）。

use sqlx::Row;
use uuid::Uuid;
use crate::{AppError, AppState};

// ── 模型 ──

#[derive(Debug, Clone, sqlx::FromRow, serde::Serialize)]
pub struct IngestJob {
    pub id: Uuid,
    pub project_id: i32,
    pub created_by: Option<i32>,
    pub source_paths: Vec<String>,       // sqlx 自动 TEXT[]→Vec<String>
    pub status: String,
    pub stage: Option<String>,
    pub progress: i32,
    pub error: Option<String>,
    pub result: Option<serde_json::Value>,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub started_at: Option<chrono::DateTime<chrono::Utc>>,
    pub finished_at: Option<chrono::DateTime<chrono::Utc>>,
}

/// D 产出 → C 透传存 result JSONB + 发给 API 前端。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct IngestJobResult {
    pub new_pages: Vec<String>,
    pub updated_reserved: Vec<String>,
    pub warnings: Vec<String>,
}

/// API 返回给前端的精简视图。
#[derive(Debug, serde::Serialize)]
pub struct JobResponse {
    pub id: String,
    pub project_id: i32,
    pub status: String,
    pub stage: Option<String>,
    pub progress: i32,
    pub error: Option<String>,
    pub result: Option<serde_json::Value>,
    pub created_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
}

// ── 映射 helper ──

fn job_to_response(job: IngestJob) -> JobResponse {
    JobResponse {
        id: job.id.to_string(),
        project_id: job.project_id,
        status: job.status,
        stage: job.stage,
        progress: job.progress,
        error: job.error,
        result: job.result,
        created_at: job.created_at.to_rfc3339(),
        started_at: job.started_at.map(|t| t.to_rfc3339()),
        finished_at: job.finished_at.map(|t| t.to_rfc3339()),
    }
}

// ── 入队 ──

/// ① PG INSERT（真相源）→ 成功 → LPUSH redis 队列。
/// LPUSH 失败不返 Err——recover_pending 下次启动/恢复重投。
pub async fn enqueue(
    state: &AppState,
    project_id: i32,
    user_id: i32,
    source_paths: Vec<String>,
) -> Result<Uuid, AppError> {
    let row = sqlx::query(
        "INSERT INTO ingest_jobs (project_id, created_by, source_paths) \
         VALUES ($1, $2, $3::text[]) RETURNING id"
    )
    .bind(project_id)
    .bind(user_id)
    .bind(&source_paths)
    .fetch_one(&state.db)
    .await
    .map_err(AppError::from)?;

    let job_id: Uuid = row.get("id");

    // LPUSH——失败不致命。job 在 PG 里，recover_pending 补偿。
    // redis get 失败 fall through（不返 Err）；LPUSH 失败 warn 不致命。
    match state.redis.get().await {
        Ok(mut redis) => {
            // LPUSH 返回 list 长度（i64），我们不关心该值。
            let _: i64 = redis::cmd("LPUSH")
                .arg("ingest:queue")
                .arg(job_id.to_string())
                .query_async(&mut *redis)
                .await
                .unwrap_or_else(|e| {
                    tracing::warn!(
                        "LPUSH failed for {}: {}——recover_pending will retry on restart",
                        job_id, e
                    );
                    0
                });
        }
        Err(e) => {
            tracing::warn!(
                "enqueue redis get for {}: {}——job in PG, recover_pending will retry on restart",
                job_id, e
            );
        }
    }
    Ok(job_id)
}

// ── 进度查询 ──

pub async fn job_status(state: &AppState, job_id: Uuid) -> Result<JobResponse, AppError> {
    let job: IngestJob = sqlx::query_as::<_, IngestJob>(
        "SELECT * FROM ingest_jobs WHERE id = $1"
    )
    .bind(job_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::ResourceNotFound("ingest job not found".into()))?;
    Ok(job_to_response(job))
}

pub async fn list_jobs(
    state: &AppState,
    project_id: i32,
    status_filter: Option<&str>,
    limit: Option<i64>,
) -> Result<Vec<JobResponse>, AppError> {
    let limit = limit.unwrap_or(20).min(100);
    let jobs: Vec<IngestJob> = if let Some(status) = status_filter {
        sqlx::query_as::<_, IngestJob>(
            "SELECT * FROM ingest_jobs WHERE project_id = $1 AND status = $2 \
             ORDER BY created_at DESC LIMIT $3"
        )
        .bind(project_id).bind(status).bind(limit)
        .fetch_all(&state.db).await?
    } else {
        sqlx::query_as::<_, IngestJob>(
            "SELECT * FROM ingest_jobs WHERE project_id = $1 \
             ORDER BY created_at DESC LIMIT $2"
        )
        .bind(project_id).bind(limit)
        .fetch_all(&state.db).await?
    };
    Ok(jobs.into_iter().map(job_to_response).collect())
}

// ── 进度更新（worker / D 用）──

pub async fn update_job_stage(
    state: &AppState,
    job_id: Uuid,
    stage: &str,
    progress: i32,
) -> Result<(), AppError> {
    sqlx::query("UPDATE ingest_jobs SET stage=$1, progress=$2 WHERE id=$3")
        .bind(stage).bind(progress).bind(job_id)
        .execute(&state.db).await?;
    Ok(())
}

pub async fn mark_job_failed(
    state: &AppState,
    job_id: Uuid,
    error: &str,
) -> Result<(), AppError> {
    sqlx::query("UPDATE ingest_jobs SET status='failed', error=$1, finished_at=NOW() WHERE id=$2")
        .bind(error).bind(job_id)
        .execute(&state.db).await?;
    Ok(())
}

pub async fn mark_job_succeeded(
    state: &AppState,
    job_id: Uuid,
    result: &IngestJobResult,
) -> Result<(), AppError> {
    let result_json = serde_json::to_value(result)
        .map_err(|e| AppError::InternalError(format!("serialize result: {}", e)))?;
    sqlx::query("UPDATE ingest_jobs SET status='succeeded', result=$1, progress=100, finished_at=NOW() WHERE id=$2")
        .bind(&result_json).bind(job_id)
        .execute(&state.db).await?;
    Ok(())
}
