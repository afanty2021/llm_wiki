// services/ingest_queue.rs
// ingest job 数据模型 + 入队/查询/进度更新 helper。
// 所有 job 详情只存 PG（不存 redis）。redis 仅做触发队列（ingest:queue list）。

use sqlx::Row;
use uuid::Uuid;
use crate::{AppError, AppState};

/// 状态机转移规则（纯函数，单测用）。非法转移 → None。
/// 实际转移由 mark_* 函数命令式执行；此函数固化 §4 规则供测试 + 文档。
pub fn next_status(current: &str, trigger: &str) -> Option<&'static str> {
    match (current, trigger) {
        ("pending", "claim") => Some("running"),
        ("running", "succeeded_clean") => Some("succeeded"),
        ("running", "succeeded_with_warnings") => Some("succeeded_with_warnings"),
        ("running", "cancel") => Some("cancelled"),
        ("running", "transient_retry") => Some("pending"),
        ("running", "fail") => Some("failed"),
        ("failed", "manual_retry") => Some("pending"),
        ("cancelled", "manual_retry") => Some("pending"),
        _ => None,
    }
}

/// job 级瞬态错误判定（spec §6.1）。瞬态 → 自动重试候选。
pub fn is_transient_job_err(e: &AppError) -> bool {
    match e {
        AppError::DatabaseError(_) | AppError::RedisError(_) | AppError::IoError(_) => true,
        AppError::LlmApiError(msg) => is_transient_msg(msg),
        // redis 命令错现映射为 InternalError（如 cache_step1_result），按 message 特判
        AppError::InternalError(msg) => {
            let m = msg.to_lowercase();
            m.contains("redis") || m.contains("connection refused") || m.contains("timeout") || m.contains("connect")
        }
        AppError::Cancelled => false,
        _ => false,
    }
}

fn is_transient_msg(msg: &str) -> bool {
    let m = msg.to_lowercase();
    // 两种 5xx 报文格式：embedding.rs 用 "HTTP {status}"；LLM streaming（LlmError::ApiError Display）用 "API error {status}"
    m.contains("http 5") || m.contains("api error 5") || m.contains("timeout") || m.contains("connect") || m.contains("connection")
}

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
    pub retry_count: i32,
    pub max_retries: i32,
    pub cancel_requested: bool,
    pub item_states: serde_json::Value,  // JSONB
    pub lease_expires_at: Option<chrono::DateTime<chrono::Utc>>,
}

/// D 产出 → C 透传存 result JSONB + 发给 API 前端。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct IngestJobResult {
    pub new_pages: Vec<String>,
    pub updated_reserved: Vec<String>,
    pub warnings: Vec<String>,
}

/// ingest job 生命周期事件（SSE 推送给前端 + 内部观察）。
#[derive(Clone, serde::Serialize)]
pub struct JobEvent {
    pub job_id: Uuid,
    pub kind: &'static str,  // stage_changed|progress|item_done|item_failed|job_succeeded|job_failed|job_cancelled（示意，非穷举）
    pub payload: serde_json::Value,
}

/// 发事件到 broadcast channel（无接收端时 send 报错忽略——`let _ =`）。
pub fn emit_job_event(state: &AppState, job_id: Uuid, kind: &'static str, payload: serde_json::Value) {
    let _ = state.job_events.send(JobEvent { job_id, kind, payload });
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
    pub retry_count: i32,
    pub cancel_requested: bool,
    pub item_states: serde_json::Value,
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
        retry_count: job.retry_count,
        cancel_requested: job.cancel_requested,
        item_states: job.item_states,
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
    // #2 修正（code-review）：发 stage_changed 事件，让 SSE 客户端看到进度推进（spec §8.2）。
    emit_job_event(
        state,
        job_id,
        "stage_changed",
        serde_json::json!({ "stage": stage, "progress": progress }),
    );
    Ok(())
}

/// 标记 running（pending→running + started_at + 发 job_running 事件）。
/// worker 取到 job 后调（#2：经此函数统一发事件，替代既存内联 UPDATE）。
pub async fn mark_job_running(state: &AppState, job_id: Uuid) -> Result<(), AppError> {
    sqlx::query("UPDATE ingest_jobs SET status='running', started_at=NOW() WHERE id=$1")
        .bind(job_id)
        .execute(&state.db)
        .await?;
    emit_job_event(state, job_id, "job_running", serde_json::json!({}));
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
    emit_job_event(state, job_id, "job_failed", serde_json::json!({}));
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
    emit_job_event(state, job_id, "job_succeeded", serde_json::json!({}));
    Ok(())
}

// ── 取消（cancel_requested 协作式）──

/// 请求取消（endpoint 调）：仅置 cancel_requested=TRUE。worker 在下个 checkpoint 响应。
pub async fn request_cancel(state: &AppState, job_id: Uuid) -> Result<(), AppError> {
    sqlx::query("UPDATE ingest_jobs SET cancel_requested=TRUE WHERE id=$1")
        .bind(job_id).execute(&state.db).await?;
    Ok(())
}

/// 标记 cancelled（pipeline check_cancel 命中时调）。
pub async fn mark_job_cancelled(state: &AppState, job_id: Uuid) -> Result<(), AppError> {
    sqlx::query("UPDATE ingest_jobs SET status='cancelled', finished_at=NOW() WHERE id=$1")
        .bind(job_id).execute(&state.db).await?;
    emit_job_event(state, job_id, "job_cancelled", serde_json::json!({}));
    Ok(())
}

/// 检查取消：cancel_requested=true → mark_cancelled + Err(Cancelled)；否则 Ok。
pub async fn check_cancel(state: &AppState, job_id: Uuid) -> Result<(), AppError> {
    let cancel: bool = sqlx::query_scalar("SELECT cancel_requested FROM ingest_jobs WHERE id=$1")
        .bind(job_id).fetch_optional(&state.db).await?.unwrap_or(false);
    if cancel {
        mark_job_cancelled(state, job_id).await?;
        return Err(AppError::Cancelled);
    }
    Ok(())
}

// ── 重试 ──

/// 自动重试：status=pending, retry_count++（worker 在调此函数前已 sleep backoff）。不校验当前 status。重投 Redis。
/// 清 finished_at/progress/stage——避免重投 job 携带矛盾状态（finished_at 非 NULL / progress=100）。
pub async fn mark_job_retry_pending(state: &AppState, job_id: Uuid, error: &str) -> Result<(), AppError> {
    sqlx::query("UPDATE ingest_jobs SET status='pending', retry_count=retry_count+1, error=$2, finished_at=NULL, progress=0, stage=NULL WHERE id=$1")
        .bind(job_id).bind(error).execute(&state.db).await?;
    emit_job_event(state, job_id, "job_retry", serde_json::json!({}));
    // 重投 Redis（复用 enqueue 的 LPUSH；enqueue 还做 INSERT——这里只 LPUSH）
    if let Ok(mut redis) = state.redis.get().await {
        let _: i64 = redis::cmd("LPUSH").arg("ingest:queue").arg(job_id.to_string())
            .query_async(&mut *redis).await.unwrap_or(0);
    }
    Ok(())
}

/// 手动重试（endpoint 调）：校验 status∈{failed,cancelled}，retry_count **重置 0**（重新发放自动重试额度），重投。
/// 清 finished_at/progress/stage/error——failed/cancelled job 的 finished_at 已设、progress 多为 100，须一并清。
pub async fn manual_retry(state: &AppState, job_id: Uuid) -> Result<(), AppError> {
    let affected = sqlx::query(
        "UPDATE ingest_jobs
         SET status='pending', retry_count=0, error=NULL, cancel_requested=FALSE,
             finished_at=NULL, progress=0, stage=NULL
         WHERE id=$1 AND status IN ('failed','cancelled')",
    ).bind(job_id).execute(&state.db).await?.rows_affected();
    if affected == 0 {
        return Err(AppError::BadRequest("job not in failed/cancelled state".into()));
    }
    emit_job_event(state, job_id, "job_retry", serde_json::json!({}));
    if let Ok(mut redis) = state.redis.get().await {
        let _: i64 = redis::cmd("LPUSH").arg("ingest:queue").arg(job_id.to_string())
            .query_async(&mut *redis).await.unwrap_or(0);
    }
    Ok(())
}

// ── 三态标记 + item_state ──

/// 三态之一：部分 source failed 但有成功 → succeeded_with_warnings。
pub async fn mark_job_succeeded_with_warnings(state: &AppState, job_id: Uuid, result: &IngestJobResult) -> Result<(), AppError> {
    sqlx::query("UPDATE ingest_jobs SET status='succeeded_with_warnings', progress=100, result=$2, finished_at=NOW() WHERE id=$1")
        .bind(job_id).bind(serde_json::to_value(result).unwrap_or(serde_json::Value::Null))
        .execute(&state.db).await?;
    emit_job_event(state, job_id, "job_succeeded_with_warnings", serde_json::json!({}));
    Ok(())
}

/// 更新某 source 的 item_state（done/failed/skipped + error）。item_states 是 JSONB 数组。
pub async fn update_item_state(state: &AppState, job_id: Uuid, path: &str, item_status: &str, error: Option<&str>) -> Result<(), AppError> {
    // 读当前 item_states，upsert 该 path，写回
    let cur: serde_json::Value = sqlx::query_scalar("SELECT item_states FROM ingest_jobs WHERE id=$1")
        .bind(job_id).fetch_one(&state.db).await?;
    let mut arr = cur.as_array().cloned().unwrap_or_default();
    let entry = serde_json::json!({ "path": path, "status": item_status, "error": error });
    if let Some(slot) = arr.iter_mut().find(|v| v.get("path").and_then(|p| p.as_str()) == Some(path)) {
        *slot = entry;
    } else {
        arr.push(entry);
    }
    sqlx::query("UPDATE ingest_jobs SET item_states=$2 WHERE id=$1")
        .bind(job_id).bind(serde_json::Value::Array(arr)).execute(&state.db).await?;
    let kind = if item_status == "done" { "item_done" } else { "item_failed" };
    emit_job_event(state, job_id, kind, serde_json::json!({ "path": path, "status": item_status }));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{next_status, is_transient_job_err};
    use crate::AppError;

    #[test]
    fn next_status_legal_transitions() {
        assert_eq!(next_status("pending", "claim"), Some("running"));
        assert_eq!(next_status("running", "succeeded_clean"), Some("succeeded"));
        assert_eq!(next_status("running", "succeeded_with_warnings"), Some("succeeded_with_warnings"));
        assert_eq!(next_status("running", "cancel"), Some("cancelled"));
        assert_eq!(next_status("running", "transient_retry"), Some("pending"));
        assert_eq!(next_status("running", "fail"), Some("failed"));
        assert_eq!(next_status("failed", "manual_retry"), Some("pending"));
        assert_eq!(next_status("cancelled", "manual_retry"), Some("pending"));
    }

    #[test]
    fn next_status_illegal_rejected() {
        assert_eq!(next_status("succeeded", "claim"), None);
        assert_eq!(next_status("pending", "cancel"), None); // 未运行不可取消
        assert_eq!(next_status("failed", "transient_retry"), None); // 失败只走手动 retry
    }

    #[test]
    fn is_transient_classification() {
        // sqlx 0.7 无 PoolClosed 变体；用 ColumnNotFound 作为可构造的 DatabaseError 来源
        assert!(is_transient_job_err(&AppError::DatabaseError(sqlx::Error::ColumnNotFound("x".into()))));
        assert!(is_transient_job_err(&AppError::IoError(std::io::Error::new(std::io::ErrorKind::TimedOut, "x"))));
        assert!(is_transient_job_err(&AppError::LlmApiError("embed HTTP 503: down".into())));
        assert!(is_transient_job_err(&AppError::LlmApiError("step1: API error 503: upstream down".into())));
        assert!(is_transient_job_err(&AppError::LlmApiError("connect timeout".into())));
        assert!(is_transient_job_err(&AppError::InternalError("redis SET: connection refused".into())));
        // 非瞬态
        assert!(!is_transient_job_err(&AppError::BadRequest("bad".into())));
        assert!(!is_transient_job_err(&AppError::ResourceNotFound("x".into())));
        assert!(!is_transient_job_err(&AppError::InternalError("DOCX parse error: bad format".into())));
        assert!(!is_transient_job_err(&AppError::LlmApiError("HTTP 400 content violation".into())));
        assert!(!is_transient_job_err(&AppError::Cancelled));
    }
}
