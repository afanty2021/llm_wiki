# Layer 6 Phase 3 — 队列可靠性 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 ingest 队列加 取消（协作式只停不清）+ 重试（自动瞬态退避+手动，手动重置额度）+ 部分失败隔离（worker 三态标记）+ SSE（AppState broadcast），修 all-failed 既存 bug。

**Architecture:** migration 012 扩 `ingest_jobs`（retry/cancel/item_states + status 加宽）。`ingest_queue.rs` 增状态机/瞬态分类/标记函数 + broadcast 事件。pipeline 加 cancel 检查点 + per-source item_states + all-failed 修正 + 部分续传。worker 按结果三态标记 + 自动重试退避。新 routes：cancel/retry/stream。

**Tech Stack:** Rust + axum 0.7 + sqlx + tokio（`broadcast`、`Sse`）+ redis。

## Global Constraints

- **只停不清**：取消不删已写 wiki_pages/embeddings/reviews（幂等 upsert 有效；规避共享页误删）。
- **终态由 worker 标记**（pipeline 不自标记），否则现网 worker Ok 分支无条件 `mark_job_succeeded` 覆盖 `succeeded_with_warnings`。
- **手动重试重置 `retry_count=0`**（非 ++）；自动重试 `retry_count < max_retries` 且重投前 `backoff_delay` 退避。
- **瞬态分类**：`DatabaseError`/`RedisError`/`IoError` 瞬态；`LlmApiError`/`InternalError` 按 message 特判（HTTP 5/timeout/connect/redis）；`AppError::Cancelled` 非瞬态。
- **all-failed 判定**：用 item_states（全 failed → Err），**不**用现行 `updated_reserved.is_empty()`（恒假，是既存 bug）。
- **broadcast 容量 64**；SSE 首帧回放 PG 快照兜底溢出。
- **工作语言**：注释/文档简体中文，变量名英文。
- 部署：单实例 + 单 worker（`lease_expires_at` 字段占位，逻辑不做）。

---

## File Structure

| 文件 | 责任 | 任务 |
|------|------|------|
| `migrations/012_ingest_reliability.sql`（新）| status 加宽 + retry/cancel/item_states 字段 | T1 |
| `src-server/src/error.rs` | `AppError::Cancelled` 变体 + IntoResponse | T2 |
| `src-server/src/services/ingest_queue.rs` | `next_status`/`is_transient_job_err` 纯函数；`JobEvent`/`emit_job_event`；`request_cancel`/`mark_job_cancelled`/`mark_job_retry_pending`/`mark_job_succeeded_with_warnings`/`manual_retry`/`update_item_state`/`check_cancel`；扩 `IngestJob`/`JobResponse` | T2,T3,T4 |
| `src-server/src/lib.rs` | AppState 加 `job_events: broadcast::Sender<JobEvent>`；create_app 构造 | T3 |
| `src-server/src/services/ingest_pipeline.rs` | run_ingest_job 加 check_cancel 检查点 + item_states + all-failed 修正 + 部分续传 | T5 |
| `src-server/src/services/ingest_worker.rs` | worker_loop 三态标记 + 自动重试退避 + cancel 处理 | T6 |
| `src-server/src/routes/ingest.rs` | POST /cancel、POST /retry、GET /stream | T7 |
| `src-server/tests/integration/ingest_queue_test.rs` + 新 `ingest_reliability_test.rs` | 状态机/瞬态单测 + cancel/retry/partial/SSE 集成测 | T2,T8 |

---

## Task 1: migration 012 — ingest_jobs 可靠性字段

**Files:**
- Create: `src-server/migrations/012_ingest_reliability.sql`
- Verify: psql（仓库无 `sqlx::migrate!`，手动应用到 PG）

**Interfaces:** 后续 task 假设 `ingest_jobs` 含 `retry_count/max_retries/cancel_requested/lease_expires_at/item_states`，`status VARCHAR(40)`。

- [ ] **Step 1: 写 migration**

Create `src-server/migrations/012_ingest_reliability.sql`：
```sql
-- 012: ingest 队列可靠性字段（取消/重试/部分失败/SSE）
-- 004 定义 status VARCHAR(20)，放不下 succeeded_with_warnings(23)。
ALTER TABLE ingest_jobs ALTER COLUMN status TYPE VARCHAR(40);
ALTER TABLE ingest_jobs ADD COLUMN IF NOT EXISTS retry_count      INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ingest_jobs ADD COLUMN IF NOT EXISTS max_retries      INTEGER NOT NULL DEFAULT 3;
ALTER TABLE ingest_jobs ADD COLUMN IF NOT EXISTS cancel_requested BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE ingest_jobs ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;  -- 多 worker 占位，单 worker 不用
ALTER TABLE ingest_jobs ADD COLUMN IF NOT EXISTS item_states      JSONB NOT NULL DEFAULT '[]'::jsonb;
-- item_states: [{ "path": "raw/x.md", "status": "done|failed|skipped", "error": null }]
```

- [ ] **Step 2: 应用到 PG（docker src-server-postgres-1 @5433，llmwiki:test123@localhost:5433/llmwiki）**

```bash
cd /Users/berton/Github/kb-obsidian/llm_wiki && PGPASSWORD=test123 psql -h localhost -p 5433 -U llmwiki -d llmwiki -f src-server/migrations/012_ingest_reliability.sql
PGPASSWORD=test123 psql -h localhost -p 5433 -U llmwiki -d llmwiki -c "\d ingest_jobs"
```
Expected: 无报错；columns 含 retry_count/max_retries/cancel_requested/lease_expires_at/item_states；status `character varying(40)`。再跑一次 012（幂等）→ 无报错。

- [ ] **Step 3: Commit**

```bash
git add src-server/migrations/012_ingest_reliability.sql
git commit -m "feat(layer6-p3): migration 012 ingest reliability fields (retry/cancel/item_states)"
```

---

## Task 2: error.rs Cancelled + 纯函数（next_status / is_transient_job_err）+ 单测

**Files:**
- Modify: `src-server/src/error.rs`（加 Cancelled 变体 + IntoResponse 臂）
- Modify: `src-server/src/services/ingest_queue.rs`（加 `next_status` + `is_transient_job_err` 纯函数 + 测试）
- Test: ingest_queue.rs 内 `#[cfg(test)]`

**Interfaces:**
- Produces: `AppError::Cancelled`；`pub fn next_status(current: &str, trigger: &str) -> Option<&'static str>`；`pub fn is_transient_job_err(e: &AppError) -> bool`。T4/T5/T6 用。

- [ ] **Step 1: error.rs 加 Cancelled 变体**

`src-server/src/error.rs` 的 `AppError` enum（`Conflict` 后）加：
```rust
    #[error("ingest cancelled by request")]
    Cancelled,
```
`IntoResponse` 的 match（`Conflict` 臂后）加：
```rust
            AppError::Cancelled => (
                StatusCode::OK,
                ERR_INTERNAL_ERROR,
                "ingest cancelled".to_string(),
            ),
```
（cancel 非用户错误，200 + 惰性信息码；HTTP 码选 200 因 cancel 是预期结果。若 review 倾向专用 code 可改。）

- [ ] **Step 2: 写失败测试（next_status + is_transient）**

在 `src-server/src/services/ingest_queue.rs` 末尾加 `#[cfg(test)] mod tests`（若已有则并入）：
```rust
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
        assert!(is_transient_job_err(&AppError::DatabaseError(sqlx::Error::PoolClosed)));
        assert!(is_transient_job_err(&AppError::IoError(std::io::Error::new(std::io::ErrorKind::TimedOut, "x"))));
        assert!(is_transient_job_err(&AppError::LlmApiError("embed HTTP 503: down".into())));  // embedding.rs 格式
        assert!(is_transient_job_err(&AppError::LlmApiError("step1: API error 503: upstream down".into())));  // LLM streaming 真实格式（ingest_pipeline step1/step2 包 LlmError::ApiError 的 Display "API error {status}"）
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
```
> `sqlx::Error::PoolClosed` 用于构造 DatabaseError——若该变体在当前 sqlx 版本不存在，改用任意可构造的 `sqlx::Error`（如 `sqlx::Error::Configuration("x".into())` 以编译为准）。

- [ ] **Step 3: 跑测试确认失败**

`cd src-server && cargo test -p llm-wiki-server --lib ingest_queue::tests 2>&1 | tail -10` → Expected FAIL（函数未定义）。

- [ ] **Step 4: 实现 next_status + is_transient_job_err**

在 `src-server/src/services/ingest_queue.rs`（顶部 helper 区，`use` 之后）加：
```rust
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
    use crate::AppError;
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
```
（`AppError` 已在 crate 作用域，去掉 match 内重复 `use`——以编译为准。）

- [ ] **Step 5: 跑测试确认通过 + cargo check**

`cargo test -p llm-wiki-server --lib ingest_queue::tests 2>&1 | grep "test result"` → Expected 3 tests PASS。`cargo check -p llm-wiki-server 2>&1 | grep -E "^error|Finished"` → 无 error。

- [ ] **Step 6: Commit**

```bash
git add src-server/src/error.rs src-server/src/services/ingest_queue.rs
git commit -m "feat(layer6-p3): AppError::Cancelled + state-machine + transient classifier (pure fns, tested)"
```

---

## Task 3: AppState broadcast + JobEvent + emit_job_event

**Files:**
- Modify: `src-server/src/services/ingest_queue.rs`（加 `JobEvent` + `emit_job_event`）
- Modify: `src-server/src/lib.rs`（AppState 加 `job_events` + create_app 构造）

**Interfaces:**
- Produces: `pub struct JobEvent { job_id, kind, payload }`；`pub fn emit_job_event(state, event)`。T4/T5/T6/T7 用。

- [ ] **Step 1: ingest_queue.rs 加 JobEvent + emit_job_event**

在 `src-server/src/services/ingest_queue.rs`（struct 区）加：
```rust
use uuid::Uuid;

/// ingest job 生命周期事件（SSE 推送给前端 + 内部观察）。
#[derive(Clone, serde::Serialize)]
pub struct JobEvent {
    pub job_id: Uuid,
    pub kind: &'static str,  // stage_changed|progress|item_done|item_failed|job_succeeded|job_failed|job_cancelled
    pub payload: serde_json::Value,
}

/// 发事件到 broadcast channel（无接收端时 send 报错忽略——`let _ =`）。
pub fn emit_job_event(state: &AppState, job_id: Uuid, kind: &'static str, payload: serde_json::Value) {
    let _ = state.job_events.send(JobEvent { job_id, kind, payload });
}
```
（`AppState` 已 `use` 在 crate 顶；`Uuid` 按现有 import 补。）

- [ ] **Step 2: lib.rs AppState 加 job_events + create_app 构造**

`src-server/src/lib.rs` 顶部 use 加 `use tokio::sync::broadcast;` + `use crate::services::ingest_queue::JobEvent;`（或全限定）。`AppState` struct 加字段：
```rust
    pub job_events: broadcast::Sender<JobEvent>,
```
`create_app` 在 `let state = AppState { ... }` 字面量前构造：
```rust
    let (job_events, _job_events_rx) = broadcast::channel::<JobEvent>(64);
```
字面量加字段 `job_events,`（与现有 storage/vector_store 并列）。

- [ ] **Step 3: cargo check 全绿**

`cd src-server && cargo check -p llm-wiki-server 2>&1 | grep -E "^error|Finished"` → 无 error（现有 spawn_worker 持有 AppState 副本——`AppState: Clone` 因 broadcast::Sender: Clone 保持）。

- [ ] **Step 4: Commit**

```bash
git add src-server/src/services/ingest_queue.rs src-server/src/lib.rs
git commit -m "feat(layer6-p3): AppState job_events broadcast + JobEvent + emit_job_event"
```

---

## Task 4: ingest_queue schema-backed 函数 + 扩 IngestJob/JobResponse

**Files:**
- Modify: `src-server/src/services/ingest_queue.rs`（新函数 + 扩 struct）

**Interfaces:**
- Consumes: T2 `emit_job_event`/`is_transient_job_err`；T3 `JobEvent`；T1 schema。
- Produces: `request_cancel`、`mark_job_cancelled`、`mark_job_retry_pending`、`mark_job_succeeded_with_warnings`、`manual_retry`、`update_item_state`、`check_cancel`。扩 `IngestJob`（含新列）+ `JobResponse`（暴露 retry_count/cancel_requested/item_states）。T5/T6/T7 用。

- [ ] **Step 1: 扩 IngestJob + JobResponse（映射新列）**

找到 `ingest_queue.rs` 的 `IngestJob` struct（`#[derive(sqlx::FromRow)]`，`SELECT *` 映射）。加字段：
```rust
    pub retry_count: i32,
    pub max_retries: i32,
    pub cancel_requested: bool,
    pub item_states: serde_json::Value,  // JSONB
```
（`lease_expires_at` 单 worker 不用，可不映射；若 SELECT * 含该列且 struct 无字段会报列不匹配——加 `pub lease_expires_at: Option<chrono::DateTime<chrono::Utc>>` 以匹配 `SELECT *`，或改 query 为显式列。推荐加 Option 字段避免 SELECT * 报错。）
`JobResponse` struct 加（供前端 + SSE 首帧）：
```rust
    pub retry_count: i32,
    pub cancel_requested: bool,
    pub item_states: serde_json::Value,
```
`job_to_response` 映射这 3 字段。

- [ ] **Step 2: 加 request_cancel + mark_job_cancelled + check_cancel**

```rust
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
```

- [ ] **Step 3: 加 mark_job_retry_pending + manual_retry**

```rust
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
```

- [ ] **Step 4: 加 mark_job_succeeded_with_warnings + update_item_state**

```rust
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
```

- [ ] **Step 5: 改造既存 mark_job_succeeded + mark_job_failed 发 JobEvent（SSE 终态必备）**

worker 最常走的两条终态——干净成功（`mark_job_succeeded`）和永久失败（`mark_job_failed`）——是**既存函数**，T4 新增的 emit 没覆盖它们。若不改，SSE 客户端收不到 `job_succeeded`/`job_failed`，前端无法靠 SSE 判定完成。在这两个既存函数（`src-server/src/services/ingest_queue.rs` 现有）的 UPDATE 之后各加一行 emit：
```rust
// mark_job_succeeded 末尾（UPDATE 之后，return Ok 之前）：
emit_job_event(state, job_id, "job_succeeded", serde_json::json!({}));

// mark_job_failed 末尾（UPDATE 之后，return Ok 之前）：
emit_job_event(state, job_id, "job_failed", serde_json::json!({}));
```
（先 Read 这两个现有函数定位 UPDATE 语句，在其 `.execute(...).await?;` 之后插入对应 emit 行。不改它们的 SQL/签名，仅补事件广播。）

- [ ] **Step 6: cargo check 全绿**

`cargo check -p llm-wiki-server 2>&1 | grep -E "^error|Finished"` → 无 error。

- [ ] **Step 7: Commit**

```bash
git add src-server/src/services/ingest_queue.rs
git commit -m "feat(layer6-p3): ingest_queue cancel/retry/mark/item_state fns + extend IngestJob/JobResponse"
```

---

## Task 5: pipeline 检查点 + item_states + all-failed 修正 + 部分续传

**Files:**
- Modify: `src-server/src/services/ingest_pipeline.rs::run_ingest_job`（约 352-470）

**Interfaces:**
- Consumes: T4 `check_cancel`/`update_item_state`；`IngestJob.item_states`（T4 扩）。
- Produces: run_ingest_job 在检查点响应取消（Err Cancelled）、per-source 写 item_state、全 failed→Err。

> 核心改动：①每 source 处理前 `check_cancel` + 部分续传（item_states 已 done 则跳过）；②process 结果写 item_state；③rebuild_reserved 前 + embed 前 `check_cancel`；④循环后按 item_states 判 all-failed→Err（替代现行 `updated_reserved.is_empty()` 恒假条件）。

- [ ] **Step 1: 循环顶端 — check_cancel + 部分续传**

在 `run_ingest_job` 的 `for (i, sp) in job.source_paths.iter().enumerate() {` 循环体内、`update_job_stage("parsing", ...)` 之前插入：
```rust
        // 取消检查点（每 source 前）
        if let Err(e) = ingest_queue::check_cancel(state, job.id).await {
            return Err(e); // AppError::Cancelled，已 mark_cancelled
        }
        // 部分续传：item_states 中该 source 已 done → 跳过（省 LLM/embedding）
        let already_done = job.item_states.as_array()
            .map(|arr| arr.iter().any(|v| v.get("path").and_then(|p| p.as_str()) == Some(sp.as_str())
                && v.get("status").and_then(|s| s.as_str()) == Some("done")))
            .unwrap_or(false);
        if already_done {
            continue;
        }
```

- [ ] **Step 2: process 结果写 item_state**

在循环内 `match process_source_path(...)` 的每个分支末尾加 `update_item_state`：
- `Ok(None) => {}` 改为：
```rust
            Ok(None) => {
                let _ = ingest_queue::update_item_state(state, job.id, sp, "done", None).await; // 内容未变视为 done
            }
```
- `Ok(Some(processed)) => { ... }` 整个分支末尾（`update_job_stage("generating")` 之前）加：
```rust
                let _ = ingest_queue::update_item_state(state, job.id, sp, "done", None).await;
```
- `Err(e) => result.warnings.push(...)` 改为：
```rust
            Err(e) => {
                result.warnings.push(format!("process {}: {}", sp, e));
                let _ = ingest_queue::update_item_state(state, job.id, sp, "failed", Some(&e.to_string())).await;
            }
```

- [ ] **Step 3: rebuild_reserved 前 + embed 前 check_cancel**

在 `// reserved 重建`（`update_job_stage("building_index")` 之前）加：
```rust
    if let Err(e) = ingest_queue::check_cancel(state, job.id).await { return Err(e); }
```
在 `// 批量嵌入`（`if !collected.is_empty()` 之前）加：
```rust
    if let Err(e) = ingest_queue::check_cancel(state, job.id).await { return Err(e); }
```

- [ ] **Step 4: all-failed 修正（替代 updated_reserved 恒假条件）**

找到循环后判定全失败的 `if result.new_pages.is_empty() && result.updated_reserved.is_empty() && !result.warnings.is_empty()` 段（约 460-470）。**删除该条件**，改为基于 item_states 判定。在 `rebuild_reserved` 之后、`if !collected.is_empty()`（embed）之前，加：
```rust
    // all-failed 判定（修正既存 bug：现行 updated_reserved.is_empty() 恒假）
    // 所有 source 在 item_states 里都 failed（无 done）→ Err（落入 worker 的 mark_job_failed）
    let total_sources = job.source_paths.len();
    let done_count = job.item_states.as_array()
        .map(|arr| arr.iter().filter(|v| v.get("status").and_then(|s| s.as_str()) == Some("done")).count())
        .unwrap_or(0);
    if total_sources > 0 && done_count == 0 && !result.warnings.is_empty() {
        return Err(AppError::InternalError(format!("all {} source(s) failed: {}", total_sources, result.warnings.join("; "))));
    }
```
（注意：item_states 在本次 run_ingest_job 内是增量更新的，但 `job` 是 run 开始时的快照——`done_count` 读的是快照，对「本次全失败」判定可能漏掉本次刚写的 done。**改用本地累加**：在循环内维护 `let mut done_this_run = 0;`，done 分支 `+= 1`，此处判 `done_this_run == 0`。以本地变量为准，不读 job.item_states 快照。）

> 实现注意：Step 4 的 `done_count` 用**本地变量** `done_this_run`（循环内累加），而非 `job.item_states` 快照（快照不含本次写入）。在循环前声明 `let mut done_this_run = 0usize;`，每个 done 分支 `done_this_run += 1;`。判定 `if total_sources > 0 && done_this_run == 0 && !result.warnings.is_empty()`。

- [ ] **Step 5: cargo check + lib 测试**

`cargo check -p llm-wiki-server 2>&1 | grep -E "^error|Finished"` → 无 error。`cargo test -p llm-wiki-server --lib 2>&1 | grep "test result"` → 全绿（无新测，确保不破坏）。

- [ ] **Step 6: Commit**

```bash
git add src-server/src/services/ingest_pipeline.rs
git commit -m "feat(layer6-p3): pipeline cancel checkpoints + item_states + all-failed fix + partial resume"
```

---

## Task 6: worker 三态标记 + 自动重试退避 + cancel 处理

**Files:**
- Modify: `src-server/src/services/ingest_worker.rs::worker_loop`（结果处理分支）

**Interfaces:**
- Consumes: T2 `is_transient_job_err`/`AppError::Cancelled`；T4 `mark_job_succeeded_with_warnings`/`mark_job_retry_pending`；`crate::services::embedding::backoff_delay`；`IngestJob.max_retries`/`retry_count`（T4 扩）。
- Produces: worker_loop 按结果三态标记 + 瞬态自动重试（退避）+ cancel 不重试。

- [ ] **Step 1: 改 worker_loop 的结果处理分支**

找到 `worker_loop` 内 `match crate::services::ingest_pipeline::run_ingest_job(&state, &job).await { ... }`（约第 110 行）。整个 match 替换为：
```rust
        match crate::services::ingest_pipeline::run_ingest_job(&state, &job).await {
            Ok(result) => {
                tracing::info!(
                    "job {} done: {} new pages, {} warnings",
                    job_id, result.new_pages.len(), result.warnings.len()
                );
                if result.warnings.is_empty() {
                    let _ = crate::services::ingest_queue::mark_job_succeeded(&state, job_id, &result).await;
                } else {
                    let _ = crate::services::ingest_queue::mark_job_succeeded_with_warnings(&state, job_id, &result).await;
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
                    tracing::warn!("job {} transient err (attempt {}/{}): {}——retry after backoff", job_id, job.retry_count, job.max_retries, e);
                    tokio::time::sleep(crate::services::embedding::backoff_delay(job.retry_count as u32)).await;
                    let _ = crate::services::ingest_queue::mark_job_retry_pending(&state, job_id, &e.to_string()).await;
                } else {
                    tracing::error!("job {} failed: {}", job_id, e);
                    let _ = crate::services::ingest_queue::mark_job_failed(&state, job_id, &e.to_string()).await;
                }
            }
        }
```
> 关键：①Ok 按 warnings 空/非空分 succeeded / succeeded_with_warnings（**不**无条件 mark_succeeded——否则覆盖三态）；②Err(Cancelled) 单独分支（`AppError::Cancelled` 变体匹配，不进 generic Err）；③瞬态+额度 → `backoff_delay(retry_count)` 退避后 `mark_job_retry_pending`（该函数 retry_count++ 且 LPUSH）；④`job.retry_count`/`job.max_retries` 来自 T4 扩的 IngestJob（fetch 时 SELECT * 已映射）。

- [ ] **Step 2: cargo check 全绿**

`cargo check -p llm-wiki-server 2>&1 | grep -E "^error|Finished"` → 无 error（`AppError::Cancelled` match 臂要求 `AppError` 在作用域——worker.rs 已 `use crate::{AppError, AppState}`）。

- [ ] **Step 3: Commit**

```bash
git add src-server/src/services/ingest_worker.rs
git commit -m "feat(layer6-p3): worker 3-state terminal marking + transient auto-retry (backoff) + cancel"
```

---

## Task 7: routes — POST /cancel、POST /retry、GET /stream

**Files:**
- Modify: `src-server/src/routes/ingest.rs`（加 3 handler + 挂路由）

**Interfaces:**
- Consumes: T4 `request_cancel`/`manual_retry`/`job_status`/`emit_job_event`；T3 `JobEvent`/`AppState.job_events`。

- [ ] **Step 1: 加 cancel + retry handler**

在 `src-server/src/routes/ingest.rs` 加（鉴权：Admin——改/删语义）：
```rust
use axum::response::sse::{Event, Sse};
use futures::stream::Stream;
use uuid::Uuid;

// POST /api/v1/ingest/jobs/:id/cancel
pub async fn cancel_job(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(job_id): Path<Uuid>,
) -> Result<impl IntoResponse, AppError> {
    // 鉴权：取 job 的 project_id，校验 Admin
    let project_id: i32 = sqlx::query_scalar("SELECT project_id FROM ingest_jobs WHERE id=$1")
        .bind(job_id).fetch_optional(&state.db).await?
        .ok_or_else(|| AppError::ResourceNotFound("job not found".into()))?;
    let _ = check_project_access_with_role(&state, &headers, project_id, RequiredRole::Admin).await?;
    ingest_queue::request_cancel(&state, job_id).await?;
    Ok((StatusCode::ACCEPTED, Json(serde_json::json!({"status": "cancel_requested"}))))
}

// POST /api/v1/ingest/jobs/:id/retry
pub async fn retry_job(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(job_id): Path<Uuid>,
) -> Result<impl IntoResponse, AppError> {
    let project_id: i32 = sqlx::query_scalar("SELECT project_id FROM ingest_jobs WHERE id=$1")
        .bind(job_id).fetch_optional(&state.db).await?
        .ok_or_else(|| AppError::ResourceNotFound("job not found".into()))?;
    let _ = check_project_access_with_role(&state, &headers, project_id, RequiredRole::Admin).await?;
    ingest_queue::manual_retry(&state, job_id).await?;
    Ok((StatusCode::OK, Json(serde_json::json!({"status": "re_enqueued"}))))
}
```

- [ ] **Step 2: 加 stream handler（SSE）**

```rust
// GET /api/v1/ingest/jobs/:id/stream
pub async fn stream_job(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(job_id): Path<Uuid>,
) -> Result<Sse<impl Stream<Item = Result<Event, std::convert::Infallible>>>, AppError> {
    let project_id: i32 = sqlx::query_scalar("SELECT project_id FROM ingest_jobs WHERE id=$1")
        .bind(job_id).fetch_optional(&state.db).await?
        .ok_or_else(|| AppError::ResourceNotFound("job not found".into()))?;
    let _ = check_project_access(&state, &headers, project_id).await?; // 读权限

    // ⚠️ 先订阅 broadcast，再取 PG 快照——避免快任务在「快照-订阅」窗口期发出的终态事件
    //    （含快速 job_succeeded/job_failed）无接收端而被丢。订阅之后的增量由 incr 捕获；
    //    快照提供初值（可能略滞后），事件追平，重复幂等。
    let rx = state.job_events.subscribe();

    // 首帧：当前 PG 快照
    let snapshot = ingest_queue::job_status(&state, job_id).await?;
    let first = futures::stream::once(async move {
        Ok::<_, std::convert::Infallible>(
            Event::default().event("job_status").json_data(&snapshot).unwrap_or_else(|_| Event::default())
        )
    });

    // 增量：过滤本 job_id
    let incr = rx.into_stream().filter_map(move |evt| async move {
        if evt.job_id == job_id {
            Some(Ok(Event::default().event(evt.kind).json_data(&evt).unwrap_or_else(|_| Event::default())))
        } else {
            None
        }
    });

    let stream = first.chain(incr);
    Ok(Sse::new(stream).keep_alive(axum::response::sse::KeepAlive::default().interval(std::time::Duration::from_secs(15))))
}
```
> `futures::stream::StreamExt`（`into_stream`/`filter_map`/`once`/`chain`）需 `use futures::StreamExt;`（确认 Cargo.toml 已有 futures 依赖——若有则补 use；若无，`cargo add futures`）。`broadcast::Receiver` 的 `into_stream()` 来自 `tokio_stream::wrappers::BroadcastStream` 或 tokio 的 StreamExt——以编译为准，可能需 `tokio_stream::StreamMap`/`BroadcastStream` 包装（broadcast::Receiver 直接无 into_stream；用 `tokio_stream::wrappers::BroadcastStream::new(rx).map(|r| r.unwrap_or_default())`）。**实现时以实际可编译的 stream 适配为准**——broadcast Receiver → Stream 的标准适配是 `BroadcastStream`。

- [ ] **Step 3: 挂路由**

找到 `src-server/src/routes/ingest.rs` 的 router 构造（`.route("/api/v1/projects/:id/ingest", ...)` 等）。加：
```rust
        .route("/api/v1/ingest/jobs/:id/cancel", axum::routing::post(cancel_job))
        .route("/api/v1/ingest/jobs/:id/retry", axum::routing::post(retry_job))
        .route("/api/v1/ingest/jobs/:id/stream", axum::routing::get(stream_job))
```

- [ ] **Step 4: cargo check 全绿**

`cargo check -p llm-wiki-server 2>&1 | grep -E "^error|Finished"` → 无 error。broadcast→Stream 适配若报错，按 Step 2 注释用 `tokio_stream::wrappers::BroadcastStream`（`cargo add tokio-stream` 若缺）。

- [ ] **Step 5: Commit**

```bash
git add src-server/src/routes/ingest.rs src-server/Cargo.toml src-server/Cargo.lock
git commit -m "feat(layer6-p3): routes POST /cancel + /retry + GET /stream (SSE)"
```

---

## Task 8: 集成测试 + 全量回归

**Files:**
- Modify: `src-server/tests/integration/ingest_queue_test.rs`（补 lifecycle 含新字段）
- Create: `src-server/tests/integration/ingest_reliability_test.rs`（cancel/retry/partial/SSE，#[ignore] 需 PG+Redis）

**Interfaces:** 无新接口。验证 T2-T7 端到端。

- [ ] **Step 1: 补 ingest_queue_test lifecycle（新字段不破坏）**

`src-server/tests/integration/ingest_queue_test.rs` 的 `mark_job_lifecycle` 末尾断言加（确认新字段默认值）：
```rust
    // Phase 3 新字段默认值
    assert_eq!(job.retry_count, 0);
    assert!(!job.cancel_requested);
```
（JobResponse 需含这些字段——T4 已扩。若该测试用 JobResponse 断言，补字段；若用 IngestJob，同理。）

- [ ] **Step 2: 写 cancel 集成测**

Create `src-server/tests/integration/ingest_reliability_test.rs`：
```rust
// 需 PG(docker src-server-postgres-1 @5433) + Redis(@6380) + omlx(@8001)。
// cargo test --test ingest_reliability_test -- --ignored
#![cfg(test)]
use llm_wiki_server::config::AppConfig;
use llm_wiki_server::services::ingest_queue;
use llm_wiki_server::AppState;
use sqlx::PgPool;

async fn setup() -> AppState {
    let cfg = AppConfig::from_env().expect("from_env");
    let db = llm_wiki_server::db::create_pool(cfg.database_url(), cfg.database_max_connections()).await.unwrap();
    let redis = llm_wiki_server::db::create_redis_pool(cfg.redis_url()).await.unwrap();
    let http = reqwest::Client::new();
    let storage = std::sync::Arc::new(llm_wiki_server::services::storage::LocalStorage::new(cfg.storage.path.clone()));
    let vector_store = std::sync::Arc::new(llm_wiki_server::services::vector_store::PgVectorStore::new(db.clone()));
    let (job_events, _) = tokio::sync::broadcast::channel(64);
    AppState { db, redis, config: std::sync::Arc::new(cfg), http, storage, vector_store, job_events }
}

/// 取消：request_cancel → check_cancel 命中 → mark_cancelled + Err(Cancelled)；status=cancelled。
#[tokio::test]
#[ignore = "requires PG + Redis"]
async fn cancel_marks_cancelled_and_leaves_writes() {
    let state = setup().await;
    // 插一个 pending job（最小：project + source_paths）
    let job_id = uuid::Uuid::new_v4();
    sqlx::query("INSERT INTO ingest_jobs (id, project_id, source_paths, status) VALUES ($1, 249, ARRAY['raw/x.md'], 'pending')")
        .bind(job_id).execute(&state.db).await.unwrap();
    // 请求取消
    ingest_queue::request_cancel(&state, job_id).await.unwrap();
    // check_cancel 应返 Cancelled 且 mark cancelled
    let err = ingest_queue::check_cancel(&state, job_id).await.unwrap_err();
    assert!(matches!(err, llm_wiki_server::AppError::Cancelled), "应返 Cancelled");
    let status: String = sqlx::query_scalar("SELECT status FROM ingest_jobs WHERE id=$1").bind(job_id).fetch_one(&state.db).await.unwrap();
    assert_eq!(status, "cancelled");
    sqlx::query("DELETE FROM ingest_jobs WHERE id=$1").bind(job_id).execute(&state.db).await.unwrap();
}

/// 手动重试重置 retry_count=0（验证 §6.3）。
#[tokio::test]
#[ignore = "requires PG + Redis"]
async fn manual_retry_resets_retry_count() {
    let state = setup().await;
    let job_id = uuid::Uuid::new_v4();
    // 模拟自动重试耗尽：status=failed, retry_count=3
    sqlx::query("INSERT INTO ingest_jobs (id, project_id, source_paths, status, retry_count, max_retries) VALUES ($1, 249, ARRAY['raw/x.md'], 'failed', 3, 3)")
        .bind(job_id).execute(&state.db).await.unwrap();
    ingest_queue::manual_retry(&state, job_id).await.unwrap();
    let (status, rc): (String, i32) = sqlx::query_as("SELECT status, retry_count FROM ingest_jobs WHERE id=$1")
        .bind(job_id).fetch_one(&state.db).await.unwrap();
    assert_eq!(status, "pending");
    assert_eq!(rc, 0, "手动重试应重置 retry_count=0");
    sqlx::query("DELETE FROM ingest_jobs WHERE id=$1").bind(job_id).execute(&state.db).await.unwrap();
}
```
（`project_id=249` 需 projects 表有该行——若不存在，测试前 `INSERT INTO projects (id,name,storage_path) VALUES (249,...) ON CONFLICT DO NOTHING`，或用一个自播种的临时 project id 如 Phase 2 测试。）

- [ ] **Step 3: 跑全量 lib + 集成编译 + ignored 集成测**

```bash
cd src-server
cargo test -p llm-wiki-server --lib 2>&1 | grep "test result" | head -1   # lib 全绿
cargo check -p llm-wiki-server --tests 2>&1 | tail -5                       # 集成测编译
cargo test -p llm-wiki-server --test ingest_reliability_test -- --ignored 2>&1 | grep "test result" | head -1
```
Expected: lib 全绿；集成测编译通过；2 个 ignored 测 PASS（cancel、manual_retry_reset）。

- [ ] **Step 4: Commit**

```bash
git add src-server/tests/integration/ingest_queue_test.rs src-server/tests/integration/ingest_reliability_test.rs
git commit -m "test(layer6-p3): cancel + manual-retry-reset integration tests; lifecycle new-field assertions"
```

- [ ] **Step 5: spec §12 Phase 3 标记 done**

`docs/superpowers/specs/2026-06-24-layer6-infra-design.md` §12 Phase 3 标题改 `### Phase 3 — 队列可靠性 ✅ 已完成（2026-06-XX）`，附计划路径 + 验收（4 项可靠性场景集成测通过）。
```bash
git add docs/superpowers/specs/2026-06-24-layer6-infra-design.md
git commit -m "docs(layer6-p3): mark Phase 3 done in spec §12"
```

---

## Self-Review

**1. Spec 覆盖：**
- §3 migration 012 → T1 ✅
- §4 状态机（next_status 纯函数 + mark_* 命令式）→ T2(next_status) + T4(mark_*) + T6(worker 转移) ✅
- §5 取消（只停不清，check_cancel 检查点）→ T4(check_cancel/request_cancel/mark_cancelled) + T5(检查点) + T6(Err(Cancelled) 分支) ✅
- §6 重试（瞬态分类 + 自动退避 + 手动重置 + 部分续传）→ T2(is_transient) + T4(mark_retry_pending/manual_retry) + T6(退避+retry) + T5(部分续传) ✅
- §7 部分失败隔离（worker 三态 + all-failed 修正）→ T6(三态) + T5(all-failed via done_this_run) ✅
- §7.3 进度 → T5(update_job_stage 复用) + T4(emit item_done/failed) ✅
- §8 SSE（broadcast + JobEvent + stream endpoint）→ T3(broadcast+JobEvent) + T4(emit) + T7(stream) ✅
- §9 接口 + endpoints → T4(函数) + T7(routes) ✅
- §10 测试 → T2(单测) + T8(集成测) ✅

**2. Placeholder 扫描：** T7 Step 2 broadcast→Stream 适配给了「以 BroadcastStream 为准」的明确处置（非占位，是核对指令——tokio broadcast Receiver 无原生 into_stream）。T5 Step 4 done_count 用本地变量（明确实现注意，非占位）。无 TBD。

**3. 类型一致性：**
- `AppError::Cancelled`：T2 定义、T5(return Err)、T6(match 臂) 一致 ✅
- `next_status(&str,&str)->Option<&str>`：T2 定义、T2 测 ✅
- `is_transient_job_err(&AppError)->bool`：T2 定义、T6 用 ✅
- `JobEvent{job_id,kind,payload}`：T3 定义、T4 emit、T7 stream ✅
- `emit_job_event(state,job_id,kind,payload)`：T3 定义、T4 用 ✅
- `check_cancel(state,job_id)->Result<(),AppError>`：T4 定义、T5 用（返 AppError::Cancelled）✅
- `mark_job_succeeded_with_warnings(state,job_id,&IngestJobResult)`：T4 定义、T6 用 ✅
- `mark_job_retry_pending(state,job_id,&str)`：T4 定义、T6 用 ✅
- `manual_retry(state,job_id)`：T4 定义、T7 用 ✅
- `request_cancel(state,job_id)`：T4 定义、T7 用 ✅
- `update_item_state(state,job_id,path,&str,Option<&str>)`：T4 定义、T5 用 ✅
- `IngestJob.retry_count/max_retries/cancel_requested/item_states`：T4 扩、T5(item_states 读)/T6(retry_count/max_retries) 用 ✅
- `AppState.job_events: broadcast::Sender<JobEvent>`：T3 定义、T4/T7 用、T8 测 setup 构造 ✅

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-26-layer6-phase3-queue-reliability.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
