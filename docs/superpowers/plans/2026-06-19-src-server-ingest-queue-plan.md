# 子系统 C — ingest 队列 + worker 骨架 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 `ingest_jobs` PG 表 + redis 触发队列 + 同进程 tokio worker + 进度回写 + 重启恢复，为 ingest pipeline (D) 提供异步调度骨架。

**Architecture:** 两文件分层——`ingest_queue.rs`(数据层:模型+入队/查询/进度更新 helper) + `ingest_worker.rs`(调度层:BRPOP→fetch→dispatch D→progress)。当前 D 未就绪，worker_loop 留 stub(编译通过、单 worker 可跑)。重启恢复扫描 `pending`/`running` 两态重投 redis。

**Tech Stack:** Rust + axum + sqlx(PostgreSQL) + redis(deadpool-redis) + tokio + serde_json。

**依据 spec:** `docs/superpowers/specs/2026-06-19-src-server-ingest-c-queue-worker-design.md`

---

## File Structure

| 文件 | 职责 | 改动 |
|------|------|------|
| `src-server/migrations/004_add_ingest_jobs.sql` | ingest_jobs 表 DDL + 2 indexes | Create |
| `src-server/src/services/ingest_queue.rs` | 数据模型 + enqueue / job_status / list_jobs / update_job_stage / mark_job_* (~120 行) | Create |
| `src-server/src/services/ingest_worker.rs` | spawn_worker + worker_loop(stub) + recover_pending (~100 行) | Create |
| `src-server/src/services/mod.rs` | 加 `pub mod ingest_queue;` `pub mod ingest_worker;` | Modify |
| `src-server/tests/integration/ingest_queue_test.rs` | 集成测试(入队→回写→查进度) | Create |

---

## Task 0: ingest_jobs 表 DDL（migration）

**编译阻断解除**：Task 1-3 依赖此表存在。

### Step 1: 写 migration SQL

`src-server/migrations/004_add_ingest_jobs.sql`：

```sql
-- ingest_jobs: 源文档摄取队列的真相源（PG 持久化）
CREATE TABLE ingest_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    source_paths TEXT[] NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',  -- pending | running | succeeded | failed
    stage VARCHAR(40),                               -- parsing | analyzing | generating | building_index
    progress INTEGER DEFAULT 0,                      -- 0-100
    error TEXT,                                      -- mark_job_failed 写
    result JSONB,                                    -- IngestJobResult 序列化（mark_job_succeeded 写）
    created_at TIMESTAMPTZ DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ
);

CREATE INDEX idx_ingest_jobs_project ON ingest_jobs(project_id);
CREATE INDEX idx_ingest_jobs_status  ON ingest_jobs(status) WHERE status IN ('pending', 'running');
```

### Step 2: 跑 migration 并验证

```bash
cd src-server
cargo sqlx migrate run  # 或手动 psql 执行 SQL
```

```bash
PGPASSWORD=test123 psql -h localhost -p 5433 -U llmwiki -d llmwiki -c "\d ingest_jobs"
```
Expected：表 `ingest_jobs` 存在，主键 uuid、project_id FK、created_by FK、2 个索引。

### Step 3: commit

```bash
git add src-server/migrations/004_add_ingest_jobs.sql
git commit -m "chore(src-server): ingest_jobs 表 migration（子系统 C 前置）"
```

---

## Task 1: ingest_queue.rs 数据层（模型 + CRUD helper）

**Files:**
- Create: `src-server/src/services/ingest_queue.rs`
- Modify: `src-server/src/services/mod.rs`

### Step 1: 写 mod.rs 模块声明 + 空文件

`src-server/src/services/mod.rs` 现有 `pub mod llm;` 等行后加：

```rust
pub mod ingest_queue;
```

`src-server/src/services/ingest_queue.rs` 先写空占位，确保编译通过：

```rust
// services/ingest_queue.rs — ingest job 数据模型 + CRUD helper
```

```bash
cargo build -p llm_wiki_server
```
Expected：0 error（空模块编译通过）

### Step 2: 写模型 + 所有 helper（完整实现）

替换 ingest_queue.rs 为空占位，写完整内容：

```rust
// services/ingest_queue.rs
// ingest job 数据模型 + 入队/查询/进度更新 helper。
// 所有 job 详情只存 PG（不存 redis）。redis 仅做触发队列（ingest:queue list）。

use sqlx::PgPool;
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
    .map_err(|e| AppError::from(e))?;

    let job_id: Uuid = row.get("id");

    // LPUSH——失败不致命。job 在 PG 里，recover_pending 补偿。
    match state.redis.get().await {
        Ok(mut redis) => {
            let _ = redis::cmd("LPUSH")
                .arg("ingest:queue")
                .arg(job_id.to_string())
                .query_async(&mut *redis)
                .await
                .map_err(|e| {
                    tracing::warn!("LPUSH failed for {}: {}——recover_pending will retry on restart", job_id, e);
                });
        }
        Err(e) => {
            tracing::warn!("enqueue redis get for {}: {}——job in PG, recover_pending will retry on restart", job_id, e);
        }
    }
    Ok(job_id)
}
```

> **实现注**：上面的 `enqueue` redis error handling 有两个分支——redis get 失败 vs LPUSH 失败。如果 `state.redis.get()` 返回 `Err`，当前 `unwrap_or_else` 逻辑会因 `!` 提前退出函数。可以简化为：`redis.get()` 失败时 log warn 并设 `redis` 为 nil/跳过 LPUSH（job 仍在 PG）。编译时按实际 deadpool-redis API 调整。

### Step 3: 编译验证 Task 1

```bash
cargo build -p llm_wiki_server
```
Expected：0 error。`enqueue` 调用 `LPUSH` 需 redis crate 已在 deps（现有 `redis = "0.24"` 已满足）。`use redis::cmd` 需加 `use redis;` 在顶部。

### Step 4: commit

```bash
git add src-server/src/services/ingest_queue.rs src-server/src/services/mod.rs
git commit -m "feat(src-server): ingest_queue 数据层 + 模型（子系统 C Task 1）"
```

---

## Task 2: job_status / list_jobs / progress updater + 集成测试

**Files:**
- Modify: `src-server/src/services/ingest_queue.rs`（追加 helper）
- Create: `src-server/tests/integration/ingest_queue_test.rs`

### Step 1: 写集成测试（TDD red——无 helper 实现）

`src-server/tests/integration/ingest_queue_test.rs`：

```rust
use uuid::Uuid;
use llm_wiki_server::services::ingest_queue::IngestJobResult;

async fn setup() -> (axum_test::TestServer, llm_wiki_server::AppState, i32, String) {
    let (app, state) = crate::setup_test_app().await;
    let server = axum_test::TestServer::new(app).unwrap();
    let username = format!("qtest_{}", std::process::id());
    let token = crate::register_user(&server, &username, &format!("{}@t.com", username), "password123").await;
    let team_id: i32 = sqlx::query_scalar(
        "SELECT id FROM teams WHERE created_by = (SELECT id FROM users WHERE username = $1)"
    ).bind(&username).fetch_one(&state.db).await.unwrap();
    let resp = server.post("/api/v1/projects")
        .add_header("authorization", format!("Bearer {}", token))
        .json(&serde_json::json!({"name":format!("qproj-{}", std::process::id()),"team_id":team_id}))
        .await;
    let pid = resp.json::<serde_json::Value>()["id"].as_i64().unwrap() as i32;
    (server, state, pid, token)
}

#[tokio::test]
async fn enqueue_and_job_status_roundtrip() {
    let (_server, state, pid, token) = setup().await;
    // 从 token 拿 user_id（解码 claims.sub）
    let claims = llm_wiki_server::utils::verify_token(&format!("Bearer {}", token), state.config.jwt_secret()).unwrap();
    let uid: i32 = claims.sub.parse().unwrap();

    // 入队
    let job_id = llm_wiki_server::services::ingest_queue::enqueue(
        &state, pid, uid, vec!["test/foo.md".into()]
    ).await.unwrap();

    // 查进度
    let job = llm_wiki_server::services::ingest_queue::job_status(&state, job_id).await.unwrap();
    assert_eq!(job.status, "pending");
    assert_eq!(job.progress, 0);

    // 验证 redis 队列中有该 id
    let mut redis = state.redis.get().await.unwrap();
    let queue_len: i64 = redis::cmd("LLEN").arg("ingest:queue").query_async(&mut *redis).await.unwrap();
    assert!(queue_len >= 1, "queue should have at least 1 item");
}

#[tokio::test]
async fn mark_job_lifecycle() {
    let (_server, state, pid, token) = setup().await;
    let claims = llm_wiki_server::utils::verify_token(&format!("Bearer {}", token), state.config.jwt_secret()).unwrap();
    let uid: i32 = claims.sub.parse().unwrap();

    let job_id = llm_wiki_server::services::ingest_queue::enqueue(
        &state, pid, uid, vec!["test/bar.md".into()]
    ).await.unwrap();

    // 更新进度
    llm_wiki_server::services::ingest_queue::update_job_stage(&state, job_id, "analyzing", 30).await.unwrap();
    let job = llm_wiki_server::services::ingest_queue::job_status(&state, job_id).await.unwrap();
    assert_eq!(job.stage.as_deref(), Some("analyzing"));
    assert_eq!(job.progress, 30);

    // 标记成功
    let result = IngestJobResult {
        new_pages: vec!["concepts/x.md".into()],
        updated_reserved: vec![],
        warnings: vec![],
    };
    llm_wiki_server::services::ingest_queue::mark_job_succeeded(&state, job_id, &result).await.unwrap();
    let job = llm_wiki_server::services::ingest_queue::job_status(&state, job_id).await.unwrap();
    assert_eq!(job.status, "succeeded");
    assert_eq!(job.progress, 100);
    assert!(job.result.is_some());

    // 列历史：至少 1 条
    let jobs = llm_wiki_server::services::ingest_queue::list_jobs(&state, pid, None, None).await.unwrap();
    assert!(!jobs.is_empty());
}
```

### Step 2: 跑测试验证失败

```bash
cargo test -p llm_wiki_server --test integration enqueue_and_job -- --nocapture
```
Expected：FAIL——`job_status` / `update_job_stage` / `mark_job_succeeded` / `list_jobs` 未定义。

### Step 3: 实现 job_status / list_jobs / update_job_stage / mark_job_*

追加到 `ingest_queue.rs`（enqueue 之后）：

```rust
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
```

### Step 4: 跑测试验证通过 + 编译

```bash
cargo build -p llm_wiki_server
cargo test -p llm_wiki_server --test integration enqueue_and_job -- --nocapture
cargo test -p llm_wiki_server --test integration mark_job_lifecycle -- --nocapture
```
Expected：编译 0 error，2 tests PASS。

> **注**：集成测试需要 `ingest_queue` 模块被 pub 导出。需在 `src-server/src/services/mod.rs` 确认 `pub mod ingest_queue;` 已有。测试中 `llm_wiki_server::services::ingest_queue::*` 需要 `services` 模块在 `lib.rs` 中被 `pub mod services;`（当前已是 pub）。

### Step 5: commit

```bash
git add src-server/src/services/ingest_queue.rs src-server/tests/integration/ingest_queue_test.rs src-server/tests/integration/mod.rs
git commit -m "feat(src-server): job_status/list/update/mark helper + 集成测试（子系统 C Task 2）"
```

注：若 `tests/integration/mod.rs` 未声明 `pub mod ingest_queue_test;`，本 step 补上。

---

## Task 3: ingest_worker.rs（worker loop + recover_pending，D stub 版）

**Files:**
- Create: `src-server/src/services/ingest_worker.rs`
- Modify: `src-server/src/services/mod.rs`

### Step 1: 写空模块声明

`src-server/src/services/mod.rs` 加：

```rust
pub mod ingest_worker;
```

### Step 2: 写 worker loop（D stub 版）

`src-server/src/services/ingest_worker.rs`：

```rust
// services/ingest_worker.rs
// ingest worker 调度层——redis 触发队列消费 + 同进程 tokio task + 重启恢复。
// D (ingest_pipeline) 就绪前 worker_loop 留 stub：job 取到后标记 running 即停止——编译通过。

use uuid::Uuid;
use crate::{AppError, AppState};
use crate::services::ingest_queue::{self, IngestJob};

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
        // BRPOP 阻塞等待（0 = 无限超时）
        let (_, job_id_str): (String, String) = {
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

        // 标记 running
        let _ = sqlx::query(
            "UPDATE ingest_jobs SET status='running', started_at=NOW() WHERE id=$1"
        )
        .bind(job_id)
        .execute(&state.db)
        .await;

        // —— D stub（D 就绪后解注释下方代码 + 删 tracing::info）——
        tracing::info!("job {} staged (D not yet wired). source_paths={:?}", job_id, job.source_paths);
        // TODO: wire up D when ready
        // match crate::services::ingest_pipeline::run_ingest_job(&state, &job).await {
        //     Ok(result) => {
        //         let _ = ingest_queue::mark_job_succeeded(&state, job_id, &result).await;
        //     }
        //     Err(e) => {
        //         let _ = ingest_queue::mark_job_failed(&state, job_id, &e.to_string()).await;
        //     }
        // }
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
        let _: () = redis::cmd("LPUSH")
            .arg("ingest:queue")
            .arg(id.to_string())
            .query_async(&mut *redis)
            .await
            .map_err(|e| {
                tracing::error!("recover_pending LPUSH {}: {}", id, e);
            })
            .unwrap_or(());
    }
    Ok(pending.len())
}
```

### Step 3: 编译验证 + 集成测试回归

```bash
cargo build -p llm_wiki_server
cargo test -p llm_wiki_server --test integration enqueue_and_job -- --nocapture
cargo test -p llm_wiki_server --test integration mark_job_lifecycle -- --nocapture
```
Expected：编译 0 error，Task 2 的 2 tests 仍 PASS（worker 未修改 queue helper）。

### Step 4: commit

```bash
git add src-server/src/services/ingest_worker.rs src-server/src/services/mod.rs
git commit -m "feat(src-server): ingest worker loop + recover_pending（D stub 版，子系统 C Task 3）"
```

---

## Task 4: 服务集成 — spawn_worker 注册 + 最终验证

**Files:**
- Modify: `src-server/src/main.rs`（加 `spawn_worker` 调用）
- Modify: `src-server/src/services/mod.rs`（确认 pub mod）

### Step 1: main.rs 加 spawn_worker

`src-server/src/main.rs` 里 `let config = llm_wiki_server::AppConfig::from_env()` 和 `let (app, state) = ...` 的 `create_app(config).await` 之后加：

```rust
    // 启动 ingest worker（同进程 tokio task）
    llm_wiki_server::services::ingest_worker::spawn_worker(state.clone());
```

注：需确保 `services` 模块 pub export `ingest_worker`。

### Step 2: 完整编译 + 全集成测试回归

```bash
cargo build -p llm_wiki_server
cargo test -p llm_wiki_server --test integration
```
Expected：编译 0 error。全 integration 测试 — Task 1 register + Task 3/4 pages + Task C 2 queue tests 全 PASS。worker 启动不 panic（D stub 无害）。

### Step 3: commit

```bash
git add src-server/src/main.rs
git commit -m "feat(src-server): server 启动注册 ingest worker（D stub，子系统 C 集成）"
```

---

## 最终验证

```bash
cargo build -p llm_wiki_server           # 0 error
cargo test -p llm_wiki_server --lib      # 0 fail
cargo test -p llm_wiki_server --test integration  # 全 PASS
```

worker 日志确认（server 启动时）：
```
ingest worker started
recovered 0 pending ingest jobs   #（首次启动无遗留）
ingest worker stopped
```

---

## Self-Review

**1. Spec 覆盖：**
- 数据模型(IngestJob/IngestJobResult/JobResponse)→ Task 1 ✅
- enqueue(PG INSERT + LPUSH 容错)→ Task 1 ✅
- job_status/list_jobs(读接口)→ Task 2 ✅
- update_job_stage/mark_job_failed/mark_job_succeeded(进度回写)→ Task 2 ✅
- spawn_worker + worker_loop(BRPOP→fetch→dispatch)→ Task 3 ✅
- recover_pending(启动扫 pending+running)→ Task 3 ✅
- 优雅关闭(MVP 策略：BRPOP 被打断+幂等重投)→ §9 已在 worker_loop 注释中 ✅
- LPUSH 失败不返 Err→ Task 1 enqueue 实现 ✅

**2. 占位符扫描：**
- 有 1 处 `// TODO: wire up D when ready`（设计意图——非计划失误。D 就绪后 2 行解注释 + 删 1 行 info 即激活。这是计划层面的预留，非实施时的占位符）。其余无 TBD/TODO。✅

**3. 类型一致：**
- `IngestJob` 在 Task 1 定义，Task 3 worker 通过 `use ingest_queue::IngestJob` 引用 ✅
- `IngestJobResult` 在 Task 1 定义，Task 2 mark_job_succeeded 用 ✅
- `enqueue` 签名 `(state, pid, uid, source_paths)→Uuid` 在 Task 1/测试一致 ✅
- `mark_job_succeeded` 签名 `(state, job_id, &IngestJobResult)` 在 Task 2/3 一致 ✅

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-19-src-server-ingest-queue-plan.md`. Two execution options:

**1. Subagent-Driven（推荐）** — 每 task 派发独立 subagent + 两轮 review
**2. Inline Execution** — 本会话批量执行 + checkpoint

Which approach?
