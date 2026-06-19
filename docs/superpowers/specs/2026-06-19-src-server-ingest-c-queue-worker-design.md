# 子系统 C 详细设计 — 队列 + worker 骨架

> **状态**：详细设计草稿（2026-06-19）| **上级**：[ingest Plan B 总览设计](2026-06-19-src-server-ingest-design.md) §4
>
> 定义 `ingest_jobs` PG 表（真相源）+ redis 触发队列 + 同进程 tokio worker + 进度回写 + 重启恢复，为 ingest pipeline (D) 提供异步调度骨架。

---

## 1. 目标与边界

**C 做什么**：
- 管理 `ingest_jobs` 表的 CRUD（入队 / 查进度 / 列历史 / 更新进度）
- redis 触发队列（LPUSH job_id + BRPOP 消费），**不**在 redis 存 job 详情——详情只在 PG
- 同进程 tokio worker task（`spawn_worker(state)` → `worker_loop` → 从 redis/恢复取 job → 调 D 编排 → 回写 PG）
- 重启恢复：启动时扫 PG `pending`/`running` 重投 redis 队列

**C 不做什么**：
- 不管解析、LLM、分块、缓存（那是 A/B/D 的事）
- 不管 API 响应格式（那是 E 的事）
- 不管 job 的 `result` 字段结构（D 产出→C 透传存 JSONB）
- 不管自动重试（MVP 失败人工重投）

**边界**：C 的接口是 worker 调度层。D（编排）被 `worker_loop` 调用，D 返回 `IngestJobResult` 后 C 回写 PG。E（API）调用 C 的数据层 helper（`enqueue` / `job_status` / `list_jobs`）。

---

## 2. 模块结构

```
src-server/src/services/ingest_queue.rs      (~120 行)
 ├── IngestJob 模型 (sqlx::FromRow + Serialize)
 ├── IngestJobResult 模型 (与 D 共享)
 ├── enqueue(state, pid, uid, source_paths) → Uuid
 ├── job_status(state, job_id) → JobResponse
 ├── list_jobs(state, pid, opts) → Vec<JobResponse>
 ├── update_job_stage(state, job_id, stage, progress) → ()
 ├── mark_job_failed(state, job_id, error) → ()
 └── mark_job_succeeded(state, job_id, result) → ()

src-server/src/services/ingest_worker.rs     (~100 行)
 ├── spawn_worker(state)  // server main 调，tokio::spawn
 ├── worker_loop(state)   // BRPOP → fetch → dispatch → progress
 └── recover_pending(state)  // 启动扫 pending/running → LPUSH 重投
```

不分文件理由：queue = 数据层（~100 行），worker = 调度层（~80 行），两者职责清晰，接口通过 `state` 共享（均需 db + redis）。后续多 worker 时拆更合理但 MVP 够。

---

## 3. 数据模型

### ingest_jobs PG 表 DDL

```sql
-- migration 004_add_ingest_jobs.sql
CREATE TABLE ingest_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    source_paths TEXT[] NOT NULL,       -- 源文件路径列表，单 job 可多文件
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
                                        -- pending | running | succeeded | failed
    stage VARCHAR(40),                   -- parsing | analyzing | generating | building_index
    progress INTEGER DEFAULT 0,          -- 0-100
    error TEXT,                          -- 失败原因（mark_job_failed 写）
    result JSONB,                        -- IngestJobResult 的 JSON 映射（mark_job_succeeded 写）
    created_at TIMESTAMPTZ DEFAULT NOW(),
    started_at TIMESTAMPTZ,              -- worker 取到 job 时更新
    finished_at TIMESTAMPTZ              -- succeeded/failed 时更新
);

CREATE INDEX idx_ingest_jobs_project ON ingest_jobs(project_id);
-- 加速 worker 重启扫描：只扫 pending 和 running
CREATE INDEX idx_ingest_jobs_status  ON ingest_jobs(status) WHERE status IN ('pending', 'running');
```

设计要点：
- `source_paths TEXT[]`：单次入队可多个文件（POST body `{ source_paths: [...] }`）。worker 串行处理每个 path。
- `stage` 与 `progress` 分离：`stage` 描述当前阶段（6 个枚举值），`progress` 是 0-100 整数（前端进度条）。`update_job_stage` 同时更新两者。
- **不加 FOREIGN KEY ON DELETE SET NULL** for `created_by`——用户被删时 job 保留（审计用途）。on `project_id` 用 CASCADE（项目删时 job 也删）。
- **不存 redis**：redis 只存队列触发键（`ingest:queue` list），不复制 job 详情。job 信息查询全走 PG。

### Redis 键设计

```
ingest:queue           LIST    LPUSH job_id (尾部) / BRPOP (头部取)—— FIFO
ingest:cache:{sha256}  STRING  Step1 分析 JSON 缓存（由 D 管理, C 不管）
```
**不**存 `ingest:progress:{job_id}` hash——进度直接写 PG `stage` + `progress` 列。前端 poll `GET /ingest/jobs/:id` 查 PG。

### Rust 模型

```rust
// services/ingest_queue.rs

#[derive(Debug, Clone, sqlx::FromRow, Serialize)]
pub struct IngestJob {
    pub id: Uuid,
    pub project_id: i32,
    pub created_by: Option<i32>,
    pub source_paths: Vec<String>,       // sqlx 自动解析 TEXT[]
    pub status: String,
    pub stage: Option<String>,
    pub progress: i32,
    pub error: Option<String>,
    pub result: Option<serde_json::Value>,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub started_at: Option<chrono::DateTime<chrono::Utc>>,
    pub finished_at: Option<chrono::DateTime<chrono::Utc>>,
}

/// D 产出 → C 透传存 result JSONB + 发给 E / 前端。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IngestJobResult {
    pub new_pages: Vec<String>,
    pub updated_reserved: Vec<String>,
    pub warnings: Vec<String>,
}

/// E（API）返回给前端的视图。
#[derive(Debug, Serialize)]
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
```

---

## 4. 接口签名

### ingest_queue.rs — 数据层 helper

```rust
/// ① 入队：PG INSERT（真相源）→ 成功 → LPUSH redis 队列。
/// 若 redis LPUSH 失败（job 已写 PG），worker 启动时 recovre_pending 会重投——一致。
pub async fn enqueue(
    state: &AppState,
    project_id: i32,
    user_id: i32,
    source_paths: Vec<String>,
) -> Result<Uuid, AppError>;

/// ② 查进度（GET /ingest/jobs/:id 用）
pub async fn job_status(state: &AppState, job_id: Uuid) -> Result<JobResponse, AppError>;

/// ③ 列历史（GET /projects/:pid/ingest/jobs 用）
pub async fn list_jobs(
    state: &AppState,
    project_id: i32,
    status_filter: Option<&str>,
    limit: Option<i64>,
) -> Result<Vec<JobResponse>, AppError>;

/// ④ 更新进度（worker loop 每步调 D 后回写）
pub async fn update_job_stage(
    state: &AppState,
    job_id: Uuid,
    stage: &str,
    progress: i32,
) -> Result<(), AppError>;

/// ⑤ 失败回写
pub async fn mark_job_failed(
    state: &AppState,
    job_id: Uuid,
    error: &str,
) -> Result<(), AppError>;

/// ⑥ 成功回写
pub async fn mark_job_succeeded(
    state: &AppState,
    job_id: Uuid,
    result: &IngestJobResult,
) -> Result<(), AppError>;
```

### ingest_worker.rs — 调度层

```rust
/// server 启动时调用一次。若 redis 连不上 → 打 log 但不 panic（server 可启动，摄入暂时不可用）。
pub fn spawn_worker(state: AppState);

/// worker 主循环。在独立 tokio task 内运行。
async fn worker_loop(state: AppState);

/// 启动时扫描 PG 中未完成的 job（pending/running）→ 重新 LPUSH 到队列。
/// 这些 job 可能是上次 server 崩溃/重启时被中断的。
async fn recover_pending(state: &AppState) -> Result<usize, AppError>;
```

---

## 5. 入队与一致性

### enqueue 实现（关键路径）

```
① PG INSERT
  INSERT INTO ingest_jobs (project_id, created_by, source_paths)
  VALUES ($1, $2, $3::text[])
  RETURNING id

② 事务提交后（PG INSERT 已保证落库）
  → redis: LPUSH ingest:queue <job_id>

如果②失败（redis 断连）:
  job_id 已写到 PG(status='pending')，但未入 redis 队列
  → worker 启动时 recovre_pending 扫描 pending → 重投 → 不会丢
```

```rust
pub async fn enqueue(
    state: &AppState,
    project_id: i32,
    user_id: i32,
    source_paths: Vec<String>,
) -> Result<Uuid, AppError> {
    let row = sqlx::query!(
        "INSERT INTO ingest_jobs (project_id, created_by, source_paths) \
         VALUES ($1, $2, $3::text[]) RETURNING id",
        project_id, user_id, &source_paths
    )
    .fetch_one(&state.db)
    .await
    .map_err(AppError::from)?;
    let job_id: Uuid = row.id;

    // LPUSH——失败不影响 job 存在性（recover_pending 补偿）
    let mut redis = state.redis.get().await
        .map_err(|e| AppError::RedisError(e))?;
    let _: () = redis::cmd("LPUSH")
        .arg("ingest:queue")
        .arg(job_id.to_string())
        .query_async(&mut *redis)
        .await
        .map_err(|e| {
            tracing::warn!("LPUSH failed for job {}: {}——will be recovred on restart", job_id, e);
            // 非致命——job 在 PG 里，recover_pending 会重投
        })
        .unwrap_or(());

    Ok(job_id)
}
```

---

## 6. Worker 生命周期

### spawn_worker（server main 调）

```rust
pub fn spawn_worker(state: AppState) {
    tokio::spawn(async move {
        tracing::info!("ingest worker started");
        // ①——重启恢复：把未完成的 job 重投 redis
        match recover_pending(&state).await {
            Ok(n) if n > 0 => tracing::info!("recovered {} pending ingest jobs", n),
            Ok(_) => {}
            Err(e) => tracing::error!("recover_pending error: {}", e),
        }
        // ②——主循环
        worker_loop(state).await;
        tracing::info!("ingest worker stopped");
    });
}
```

### worker_loop

```rust
async fn worker_loop(state: AppState) {
    loop {
        // BRPOP 阻塞等待（0 = 无限超时）
        let job_id: Option<(String, String)> = {
            let mut redis = match state.redis.get().await {
                Ok(c) => c,
                Err(e) => {
                    tracing::error!("redis get: {}——worker will retry", e);
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                    continue;
                }
            };
            // BRPOP 在 tokio task 内阻塞——deadpool-redis 通过 tokio 运行时调度
            redis::cmd("BRPOP")
                .arg("ingest:queue")
                .arg("0")   // 无限阻塞
                .query_async(&mut *redis)
                .await
                .ok()
        };

        let (_, job_id_str) = match job_id {
            Some(val) => val,
            None => {
                // redis 断连 / BRPOP 超时 → 重试
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                continue;
            }
        };

        let job_id: Uuid = match job_id_str.parse() {
            Ok(id) => id,
            Err(e) => {
                tracing::warn!("invalid job_id in queue: {}: {}", job_id_str, e);
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
                tracing::warn!("job {} not found in PG——stale queue entry?", job_id);
                continue;
            }
            Err(e) => {
                tracing::error!("fetch job {}: {}", job_id, e);
                continue;
            }
        };

        // 标记为 running
        let _ = sqlx::query!(
            "UPDATE ingest_jobs SET status='running', started_at=NOW() WHERE id=$1",
            job_id
        )
        .execute(&state.db)
        .await;

        // 调 D——编排处理
        match crate::services::ingest_pipeline::run_ingest_job(&state, &job).await {
            Ok(result) => {
                let _ = crate::services::ingest_queue::mark_job_succeeded(
                    &state, job_id, &result,
                ).await;
            }
            Err(e) => {
                let _ = crate::services::ingest_queue::mark_job_failed(
                    &state, job_id, &e.to_string(),
                ).await;
            }
        }
    }
}
```

### recover_pending

```rust
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
            .await?;
    }
    Ok(pending.len())
}
```

---

## 7. 进度更新与回写

三个 helper（`update_job_stage` / `mark_job_failed` / `mark_job_succeeded`）都是纯 PG 写。pipeline (D) 调 `update_job_stage` 更新进度,worker 调 `mark_job_*` 终态。

```rust
pub async fn update_job_stage(
    state: &AppState,
    job_id: Uuid,
    stage: &str,
    progress: i32,
) -> Result<(), AppError> {
    sqlx::query!(
        "UPDATE ingest_jobs SET stage=$1, progress=$2 WHERE id=$3",
        stage, progress, job_id
    )
    .execute(&state.db)
    .await?;
    Ok(())
}

pub async fn mark_job_failed(
    state: &AppState,
    job_id: Uuid,
    error: &str,
) -> Result<(), AppError> {
    sqlx::query!(
        "UPDATE ingest_jobs SET status='failed', error=$1, finished_at=NOW() WHERE id=$2",
        error, job_id
    )
    .execute(&state.db)
    .await?;
    Ok(())
}

pub async fn mark_job_succeeded(
    state: &AppState,
    job_id: Uuid,
    result: &IngestJobResult,
) -> Result<(), AppError> {
    let result_json = serde_json::to_value(result)
        .map_err(|e| AppError::InternalError(format!("serialize result: {}", e)))?;
    sqlx::query!(
        "UPDATE ingest_jobs SET status='succeeded', result=$1, progress=100, finished_at=NOW() WHERE id=$2",
        result_json, job_id
    )
    .execute(&state.db)
    .await?;
    Ok(())
}
```

---

## 8. job_status 与 list_jobs（E 用）

```rust
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
            "SELECT * FROM ingest_jobs WHERE project_id = $1 AND status = $2 ORDER BY created_at DESC LIMIT $3"
        )
        .bind(project_id).bind(status).bind(limit)
        .fetch_all(&state.db).await?
    } else {
        sqlx::query_as::<_, IngestJob>(
            "SELECT * FROM ingest_jobs WHERE project_id = $1 ORDER BY created_at DESC LIMIT $2"
        )
        .bind(project_id).bind(limit)
        .fetch_all(&state.db).await?
    };
    Ok(jobs.into_iter().map(job_to_response).collect())
}

fn job_to_response(job: IngestJob) -> JobResponse { /* 字段映射 */ }
```

---

## 9. 优雅关闭

MVP 方案：server shutdown（Ctrl+C / SIGTERM）→ tokio runtime 给 running task 发 cancellation → worker `BRPOP` 可被打断（redis connection drop）。正在处理的 job 已在 `running` 状态——若 D 中途被打断，下次启动 `recover_pending` 会重投（pipeline 内缓存 + 幂等 upsert 保证重投安全）。

后续方案：加 graceful shutdown flag + `BRPOP` 带超时（1 秒）检查 flag。MVP 可接受当前策略。

---

## 10. 测试策略

| 测试类型 | 内容 | 实现 |
|----------|------|------|
| unit: 入队 | mock PG → INSERT 返回 UUID → 验证 LPUSH 参数 | table-driven |
| unit: recover_pending | mock PG 返回 pending ids → 验证对每条调 LPUSH | table-driven |
| unit: mark_job_* | mock PG → 验证 UPDATE SQL | table-driven |
| integ: 入队到完成全流程 | 真实 PG + redis → enqueue → mock D → mark_succeeded → 验证 DB 状态 | **需要 live DB+redis**——同 Plan A 集成测试 |
| integ: 重启恢复 | 人为插入 pending job → recover_pending → 验证 redis queue 中有该 id | **需要 live DB+redis** |

MVP 注：`recover_pending`、`enqueue` 的单元测试可 table-driven（mock 层抽象）。集成测试需要 live PG+redis（与 Plan A 测试同条件,不加 `#[ignore]`）。

---

## 11. 文件改动清单

| 文件 | 改动 |
|------|------|
| `src-server/migrations/004_add_ingest_jobs.sql` | **创建** ingest_jobs 表 + 索引 |
| `src-server/src/services/ingest_queue.rs` | **创建**（~120 行）|
| `src-server/src/services/ingest_worker.rs` | **创建**（~100 行）|
| `src-server/src/services/mod.rs` | 加 `pub mod ingest_queue;` `pub mod ingest_worker;` |
| `src-server/src/lib.rs` | server 启动时调 `spawn_worker(state)`（或留到 Task D/E 一起加——见注）|
| `src-server/tests/integration/ingest_queue_test.rs` | **创建**（集成测试,建 job + 验证回写） |

注：`spawn_worker` 的调用点放在 `lib.rs` 的 `create_app` 里（或 `main.rs`）。因 worker 依赖 D（pipeline），目前 D 未实现（只有骨架），C 的 plan 可先写 worker loop 但注释掉 `run_ingest_job` 调用——D 就绪后解注释。
