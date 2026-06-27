# Layer 6 Phase 3 — 任务队列可靠性 设计（src-server）

> 日期：2026-06-26 · 范围：src-server ingest 队列 · 部署形态：**单实例 / 单 worker（自托管）**
> 状态：设计稿，待 review → 通过后交 writing-plans 拆实施计划
> 上游设计：`docs/superpowers/specs/2026-06-24-layer6-infra-design.md` §6（本期为其细化 + 收敛）

---

## 1. 背景 与 起点（已核查的代码事实）

Layer 6 Phase 1/2 已完成 storage/vector 抽象与向量调优。Phase 3 针对 ingest 长任务的**可靠性**补强。当前队列基线（已核查）：

| 组件 | 现状 |
|------|------|
| 持久化 | PG `ingest_jobs`（migration 004）：`status VARCHAR(20)`、`stage VARCHAR(40)`、`progress`、`error`、`result JSONB`、`source_paths TEXT[]`、时间戳 |
| 触发 | Redis `ingest:queue` LPUSH（enqueue）+ worker BRPOP |
| worker | `src/services/ingest_worker.rs`：**单 worker**（`spawn_worker` 起一个 tokio task），BRPOP → mark running → `run_ingest_job` → mark succeeded/failed；启动跑 `recover_pending`（扫 pending/running 重投）|
| pipeline | `src/services/ingest_pipeline.rs::run_ingest_job`：per-source 循环 `process_source_path`，stage=parsing/generating → `rebuild_reserved_pages`(building_index) → batch `embed_and_store`。**per-source 错误非致命**（收 warnings），全失败才 Err |
| 写入 | wiki_pages（upsert ON CONFLICT）、ingested_files（mark_file_ingested，幂等）、reviews（insert_review_items）、embeddings（embed_and_store，Phase 2 chunk 级 DELETE+INSERT）|
| 状态机 | `pending → running → succeeded / failed`（**无 cancelled、无 succeeded_with_warnings、无重试**）|
| 路由 | `src/routes/ingest.rs`：`POST /projects/:id/ingest`、`GET /projects/:id/ingest/jobs`、`GET /ingest/jobs/:id`（**无 cancel/retry/stream**）|
| queue 函数 | `src/services/ingest_queue.rs`：`enqueue`/`job_status`/`list_jobs`/`update_job_stage`/`mark_job_failed`/`mark_job_succeeded` |

**缺口**：无取消、无重试、部分失败无显式状态、无 SSE 实时进度。

---

## 2. 目标 与 非目标

### 2.1 目标
1. **取消**：协作式（cooperative）取消 + `cancelled` 状态。
2. **重试**：自动（瞬态错误）+ 手动，含**部分续传**（跳过已 done 的 source）。
3. **部分失败隔离**：`succeeded_with_warnings` 三态状态机。
4. **细粒度进度 + SSE**：per-source 进度 + `broadcast` 实时推。

### 2.2 非目标（YAGNI）
- ❌ 多 worker 分布式队列（可见性超时/分布式锁）—— `lease_expires_at` 字段占位，逻辑不做（单实例单 worker 够用）。
- ❌ SSE 走 Redis pub/sub —— 单实例用 `tokio::sync::broadcast` 足够；多实例时再换。
- ❌ 取消级联删除已写数据 —— 写入是幂等 upsert 的有效内容，保留（见 §4 决策）。
- ❌ 优先级队列、死信队列、速率限制（生产级 SaaS 特性）。
- ❌ `TaskQueue` trait —— 队列紧绑 PG+Redis，上 trait 价值低（spec §6.8）。

### 2.3 关键决策（brainstorming 收敛）
1. **部署**：单实例 + 单 worker → SSE 用 AppState `broadcast`；lease 字段占位。
2. **取消清理**：**只停不清**——取消=checkpoint 协作停 + status=cancelled，已写 wiki_pages/embeddings/reviews 保留（幂等 upsert 有效，重跑补齐；零误删风险，避开共享/已更新页的级联删除陷阱）。
3. **重试**：自动（瞬态）+ 手动，靠 `item_states` 部分续传。

---

## 3. migration 012（扩展 ingest_jobs）

```sql
-- migrations/012_ingest_reliability.sql
-- 004 定义 status VARCHAR(20)，放不下 succeeded_with_warnings(23 字符)。
ALTER TABLE ingest_jobs ALTER COLUMN status TYPE VARCHAR(40);

ALTER TABLE ingest_jobs ADD COLUMN IF NOT EXISTS retry_count     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ingest_jobs ADD COLUMN IF NOT EXISTS max_retries     INTEGER NOT NULL DEFAULT 3;
ALTER TABLE ingest_jobs ADD COLUMN IF NOT EXISTS cancel_requested BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE ingest_jobs ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;  -- 多 worker 占位，单 worker 不用
ALTER TABLE ingest_jobs ADD COLUMN IF NOT EXISTS item_states     JSONB NOT NULL DEFAULT '[]'::jsonb;
-- item_states: [{ "path": "raw/sources/x.md", "status": "done|failed|skipped", "error": null }]
-- 注：只停不清 → 不存 page_ids（无级联删除）；item_states 仅驱动部分续传 + 部分失败展示
```

幂等（`IF NOT EXISTS` / `ALTER TYPE`）；`max_retries` 默认 3；可重跑。迁移前 psql 核实 `status` 现宽（20）。

---

## 4. 状态机

```
pending  → running  → succeeded                  (全部 source done)
                    → succeeded_with_warnings    (部分 source failed，warnings 非空 + item_states 有 failed)
                    → failed                     (全部 source failed / 致命错误 / 自动重试超限)
running  → cancelled                              (cancel_requested 且 worker 在 checkpoint 停)
failed   → pending                                (手动 retry：retry_count **重置为 0**，重新发放自动重试额度)
cancelled → pending                               (手动 retry：retry_count **重置为 0**)
running  → pending                                (自动 retry：瞬态错误 & retry_count < max_retries；**重投前退避**)
```

- 新增值：`succeeded_with_warnings`、`cancelled`（VARCHAR(40) 容纳）。
- 三态判定由 **worker** 按 pipeline 返回的 `IngestJobResult.warnings` 做（§7.2，pipeline 不自标记；否则现网 worker Ok 分支无条件 mark_job_succeeded 会覆盖）：
  - `Ok` + warnings 空 → `succeeded`
  - `Ok` + warnings 非空 → `succeeded_with_warnings`
  - `Err`（全 source failed / 致命 / 瞬态耗尽 / 非瞬态）→ `failed`（或 cancelled / retry_pending，见 §6.2/§5.2）

---

## 5. 取消（协作式，只停不清）

### 5.1 触发
- endpoint `POST /api/v1/ingest/jobs/:id/cancel` → `ingest_queue::request_cancel(state, job_id)`：`UPDATE ingest_jobs SET cancel_requested=TRUE WHERE id=$1`。返回 202（已请求）。

### 5.2 worker 检查点
pipeline 在以下点调 `check_cancel(state, job_id).await?`：
1. **每个 source 处理前**（`process_source_path` 循环顶端）
2. **`rebuild_reserved_pages` 前**
3. **batch `embed_and_store` 前**

`check_cancel`：读 `cancel_requested`；为 true → 调 `mark_job_cancelled`（status=cancelled, finished_at=NOW）+ `emit_job_event(job_cancelled)`，返回 `Err(AppError::...)`（专用 `Cancelled` 信号——见 §8 错误模型）中断 pipeline。

### 5.3 清理策略：只停不清
- 命中取消时，**不删**任何已写 wiki_pages / embeddings / reviews / ingested_files 标记。
- 理由：写入是幂等 upsert 的**有效内容**（正确解析/生成/embedding 的页）；未处理的 source 不摄入；用户重跑同源（幂等补齐）或手动删页（有 delete 端点）即可。
- 规避陷阱：wiki_pages 可能被多 job 共享或在本 job 前已存在（updated），级联删除会误伤旧版本——只停不清彻底避开。

### 5.4 协作式语义
- LLM 调用、embedding HTTP 本身**不中断**（无法安全 kill tokio task 的 in-flight 请求）；下一次 checkpoint 生效。粒度足够细（每 source 每步），可接受。

---

## 6. 重试（自动 + 手动，部分续传）

### 6.1 瞬态错误分类
`is_transient_job_err(e: &AppError) -> bool`：

| AppError 变体 | 瞬态？ | 理由 |
|---|---|---|
| `DatabaseError(sqlx::Error)` | ✅ 是 | 连接 blip、临时约束冲突 |
| `RedisError`（`#[from] deadpool_redis::PoolError`，连接池获取失败） | ✅ 是 | 连接池临时不可达 |
| `InternalError` 含 `"redis"` / `"connection refused"` / `"timeout"` / `"connect"` | ✅ 是 | **redis 命令错误现映射为 InternalError**（如 `cache_step1_result` 的 `InternalError("redis SET: …")`），按 message 特判为瞬态；长期应改映射为独立可重试变体（见 §12） |
| `IoError` | ✅ 是 | 文件 IO 临时失败 |
| `LlmApiError` 含 "HTTP 5" / "timeout" / "connect" | ✅ 是 | 上游 5xx / 超时（注：embed_batch 已在 HTTP 层重试 3 次，job 级再兜底） |
| `LlmApiError` 其它（4xx 内容违规、body 解析） | ❌ 否 | 内容问题，重试不变 |
| `BadRequest` / `ValidationError` | ❌ 否 | 输入问题 |
| `ResourceNotFound` | ❌ 否 | 项目/资源不存在 |
| `InternalError` 其它（解析失败、pdftotext 退出码非 0 等，不含上述 redis/network 特判） | ❌ 否 | 确定性失败 |
| `Cancelled`（§8 信号） | ❌ 否 | 取消不重试 |
| 其它（Auth/Jwt/Encryption/Conflict/FileUpload/NotImplemented） | ❌ 否 | 与 ingest 无关 |

### 6.2 自动重试
worker 捕获 `run_ingest_job` 的 Err：
- `Cancelled` → 已 `mark_job_cancelled`（§5.2），不再处理。
- 瞬态 & `retry_count < max_retries` → **先 `tokio::time::sleep(backoff_delay(retry_count)).await` 退避**（复用 `crate::services::embedding::backoff_delay`：1s/2s/4s 上限 30s；防快速失败瞬态如连接被拒在毫秒内撞满 3 次预算）→ `mark_job_retry_pending`（status=pending, retry_count++, error 记录）+ `emit_job_event` + LPUSH 重投。
- 瞬态 & 超限 / 非瞬态 → `mark_job_failed`。

### 6.3 手动重试
- endpoint `POST /api/v1/ingest/jobs/:id/retry` → `manual_retry(state, job_id)`：
  - 校验 `status IN ('failed','cancelled')`，否则 `BadRequest`。
  - **`retry_count = 0`（重置，重新发放自动重试额度）**——手动重试常发生在自动重试已耗尽后；若只 `++`，retry_count 已达 max_retries 的 job 手动后 `retry_count(4) < max(3)` 为假，再遇瞬态直接 failed（=手动后 0 次自动重试），与重试预期相悖。
  - status=pending、清 `error`、`cancel_requested=FALSE`、**保留 item_states**（不清 done，续传）、LPUSH 重投。

### 6.4 部分续传
重跑时 `process_source_path`（或循环顶端）先查 `item_states[sp].status`：
- `done` → **跳过**（幂等，省 LLM/embedding 调用）。
- `failed` / 无记录 → 重新处理；成功后更新为 `done`，失败更新为 `failed`（带 error）。
- item_states **跨重试保留**（重投不重置），只更新 `failed` 项 → 续传累积。

---

## 7. 部分失败隔离 + 细粒度进度

### 7.1 隔离
- per-source 失败 → `update_item_state(state, job_id, sp, "failed", Some(err))` + `result.warnings.push(...)`，**不中断**循环（pipeline 现已是 non-fatal）。
- 仅致命错误（DB 连接断、项目不存在、Cancelled）才整体 `Err`。

### 7.2 终态标记交接（pipeline 不标记，worker 按结果三态标记）—— 防 succeeded_with_warnings 被覆盖
- **pipeline `run_ingest_job` 不自标记终态**，返回 `Result<IngestJobResult, AppError>`（`IngestJobResult` 含 `warnings` / `new_pages`）。
- worker 接力标记（改 `ingest_worker.rs` 的 Ok 分支——现行无条件 `mark_job_succeeded` 会把 succeeded_with_warnings / 全失败覆盖成 succeeded）：
  - `Ok(result)` + `result.warnings.is_empty()` → `mark_job_succeeded`
  - `Ok(result)` + `warnings 非空` → **`mark_job_succeeded_with_warnings`**（新函数，§9.1）
  - `Err(Cancelled)` → 已在 checkpoint `mark_job_cancelled`（§5.2），不再处理
  - `Err(瞬态 & retry_count<max)` → §6.2 退避 + `mark_job_retry_pending`
  - `Err(其它)` → `mark_job_failed`
- **修正现行 all-failed 判定 bug**：当前 `run_ingest_job` 的「全失败→Err」条件依赖 `updated_reserved.is_empty()`，而 `rebuild_reserved_pages` 恒返回保留页 → 条件恒假 → 全失败落到 Ok → 被标 succeeded。Phase 3 改用 **item_states 判定**：循环后若所有 source 的 `item_states.status == "failed"`（无 done/skipped）→ `Err("all sources failed")`（落入 worker 的 `mark_job_failed`）。此为 Phase 3 必须一并修的既有 bug。

### 7.3 进度
- 每 source 完成 / item_states 变更 → `progress = done_count / total * 100` + 当前 stage 写回（`update_job_stage` 已有，复用）。
- 同时 `emit_job_event` 一条 `progress` / `item_done` / `item_failed`。

---

## 8. SSE + 事件模型 + 错误信号

### 8.1 AppState broadcast
```rust
// src/lib.rs
pub struct AppState {
    pub db: DbPool,
    pub redis: RedisPool,
    pub config: Arc<AppConfig>,
    pub http: reqwest::Client,
    pub storage: Arc<dyn services::storage::StorageBackend>,
    pub vector_store: Arc<dyn services::vector_store::VectorStore>,
    pub job_events: tokio::sync::broadcast::Sender<JobEvent>,  // 容量 64
}
```
`create_app`：`let (job_events, _) = broadcast::channel(64);` 注入。

### 8.2 JobEvent
```rust
// src/services/ingest_queue.rs（或新 events.rs）
#[derive(Clone, serde::Serialize)]
pub struct JobEvent {
    pub job_id: Uuid,
    pub kind: &'static str,   // "stage_changed"|"progress"|"item_done"|"item_failed"|"job_succeeded"|"job_failed"|"job_cancelled"
    pub payload: serde_json::Value,  // {stage?,progress?,path?,error?,result?}
}
```
- worker / queue 函数在更新 job 时 `state.job_events.send(JobEvent{...})`（接收端没了 send 报错忽略——`let _ =`）。
- 容量 64 溢出 → 旧事件被丢弃；SSE handler **首帧回放当前 PG 状态**兜底，事件幂等。

### 8.3 SSE endpoint
`GET /api/v1/ingest/jobs/:id/stream` → axum `Sse<impl Stream<Item = Event>>`：
1. 首帧：`job_status(state, job_id)` 的 PG 快照作为 `job_status` 事件。
2. 订阅 `state.job_events.subscribe()`，`filter(|e| e.job_id == job_id)`，每事件转 `Event::data(json)`。
3. 保活：定期 `Event::comment(".")`（防代理超时）。

### 8.4 Cancelled 错误信号（已定：新增 AppError::Cancelled 变体）
为让 worker 类型安全地区分取消 vs 失败，**新增 `AppError::Cancelled` 变体**（`#[error("ingest cancelled by request")]`，映射 HTTP 499 或复用 200——cancel 非错误响应；IntoResponse 加分支）。pipeline `check_cancel` 命中取消时 `mark_job_cancelled` 后 `Err(AppError::Cancelled)`；worker 捕到 `Cancelled` → 不重试、不 mark failed（已在 checkpoint mark cancelled）。

---

## 9. 接口收拢 + endpoints

### 9.1 ingest_queue.rs 新增函数
- `request_cancel(state, job_id) -> Result<(), AppError>`
- `mark_job_cancelled(state, job_id) -> Result<(), AppError>`
- `mark_job_retry_pending(state, job_id) -> Result<(), AppError>`（自动重试用，不校验 status）
- `mark_job_succeeded_with_warnings(state, job_id, result) -> Result<(), AppError>`（status=succeeded_with_warnings，§7.2 worker Ok+warnings 分支用）
- `manual_retry(state, job_id) -> Result<(), AppError>`（校验 status∈{failed,cancelled}，**retry_count 重置为 0**，§6.3）
- `update_item_state(state, job_id, path, status, error) -> Result<(), AppError>`
- `check_cancel(state, job_id) -> Result<(), AppError>`（读 cancel_requested，true 则 mark_cancelled + Err）
- `is_transient_job_err(e: &AppError) -> bool`（纯函数，可单测）
- `emit_job_event(state, event)`（`let _ = state.job_events.send(event);`）
- `next_status(current, outcome) -> &'static str`（纯函数状态机，可单测）

handler / worker 统一调这些，不上 trait（spec §6.8）。

### 9.2 新 routes（挂 src/routes/ingest.rs）
- `POST /api/v1/ingest/jobs/:id/cancel` → `cancel_job` handler
- `POST /api/v1/ingest/jobs/:id/retry` → `retry_job` handler
- `GET  /api/v1/ingest/jobs/:id/stream` → `stream_job` handler（Sse）
- 鉴权：cancel/retry 用 `check_project_access_with_role(Admin)`（删/改语义）；stream 用 `check_project_access`（读）。

---

## 10. 测试

- **状态机单测**：`next_status` 所有合法转移 + 非法转移拒绝。
- **瞬态分类单测**：`is_transient_job_err` 对每类 AppError 变体的判定（构造各变体断言 true/false）。
- **取消**（集成，#[ignore] 需 PG+Redis）：请求取消 → worker 下个 checkpoint 停 → status=cancelled；**断言已写 wiki_pages 保留**（验证只停不清）。
- **自动重试**（集成）：mock/构造瞬态错误 → retry_count 递增 → 到 max_retries 转 failed；中间成功则 succeeded。
- **手动 retry + 部分续传**（集成）：3 source 1 failed → succeeded_with_warnings；manual retry → 重投，跳过 done（item_states 续传），重处理 failed。
- **SSE**（集成）：订阅 → 收首帧（PG 快照）+ 增量事件序列；job 完成/取消收尾帧。
- **并发回归**：单 worker 串行契约不变（现有 ingest_queue_test 仍绿）。
- **migration 012**：干净库 + 已有 ingest_jobs 数据库双测幂等。

---

## 11. 风险 与 权衡

| 风险 | 缓解 |
|------|------|
| 协作式取消在长 LLM 调用期间无法立即停 | 文档说明；checkpoint 每.source 每步，粒度足够细 |
| broadcast 容量 64 在高频更新下丢事件 | SSE 首帧回放 PG 快照；事件幂等；溢出降级（订阅者下次首帧补） |
| 自动重试重跑整个 pipeline（含 LLM）贵 | item_states 部分续传跳过 done source；embed_batch 已在 HTTP 层先重试（减少 job 级触发） |
| 只停不清留「半成品」数据 | 写入是有效内容；幂等重跑补齐；手动删页端点兜底；规避级联误删（优于 spec §6.3 原文） |
| `succeeded_with_warnings` 让前端需区分新状态 | UI 已有 warnings 展示；status 字符串契约扩展，前端按枚举兼容 |
| 瞬态分类误判（把确定性错误当瞬态→无限重跑） | retry_count 上限 max_retries 兜底；分类偏保守（InternalError 默认非瞬态） |

### 11.1 已知限制 / tech-debt（第二轮 `/code-review` 发现，2026-06-27）

> 8-angle recall review 发现的 10 项。**#1/#2 已修**（commit `3d6e246`，含回归测）；**#3–#10 单实例单 worker 下接受 / 记录**，多 worker 或注入缝落地前不修。

| # | 现象 | 触发条件 | 接受理由 / 何时修 |
|---|------|----------|-------------------|
| #1 | all-failed 误判：`Ok(Some)` 即使全部 upsert 失败也计 done → 静默 `succeeded_with_warnings` | 全部 source 的 page upsert 失败（DB 抖动） | **已修** `3d6e246`：`pages_written==0` 的 source 标 `failed`、不计 `done_this_run`；all-failed 守卫正确触发 |
| #2 | SSE 不发 stage_changed/progress/job_running（spec §8.2 要求） | 任何 ingest | **已修** `3d6e246`：`update_job_stage` 发 stage_changed，新增 `mark_job_running` 发 job_running |
| #3 | `mark_job_retry_pending`/`manual_retry` 吞掉 LPUSH 错 → job 在 PG=pending 但不在 redis 队列 | LPUSH 时 redis 短暂不可用 | 重启 `recover_pending` 兜底；redis 高可用/多 worker 时改「LPUSH 失败 → 不置 pending + 返回 Err 让 worker mark_failed」 |
| #4 | worker `let _ = mark_job_retry_pending` 吞错 → job 卡 running 不重投不终态 | backoff 后 mark 的 UPDATE 恰失败（同一 DB 抖动） | 重启 recover 兜底；多 worker 时该分支应 fallback `mark_job_failed` |
| #5 | cancel 在长 LLM(step1/step2)/batch embed 内不响应 → cancelled-but-written + 浪费 quota | 单 source 长 LLM/embed 期间请求取消 | checkpoint 粒度 tradeoff（spec §11 已记）；step1/step2 内部加 checkpoint 需 provider 协作（与注入缝一并） |
| #6 | `mark_job_cancelled`/`mark_job_running` UPDATE 无 `WHERE status` 守卫 → 重复消费可覆盖终态 | 队列重复条目（double-LPUSH / recover 重投 running）+ 一个 pending 的 cancel_requested | 单 worker 顺序消费下不触发；多 worker 时加 `WHERE status IN ('pending','running')` 守卫 + claim 租约 |
| #7 | `is_transient_job_err` 子串过宽（`connect`/`timeout`）→ 永久错被误判瞬态 → 重试到预算耗尽 | 含 connect/timeout 字样的确定性 InternalError/LlmApiError | max_retries 兜底；长期改 `AppError::Retryable` 结构化变体（spec §12 第 10 条） |
| #8 | 队列无去重/claim → 重复 LPUSH（retry/manual_retry/recover）使同 job_id 被多次消费 | double-click retry / recover 与 manual 竞态 | 单 worker：顺序重复跑（幂等 upsert，费 LLM）；多 worker：并发跑 race `update_item_state` RMW → 须加 claim 租约（`lease_expires_at` 字段已占位） |
| #9 | `stream_job` 终态事件后不主动关流 → keep-alive 持续到客户端断开 | 任何 SSE 订阅 | 客户端收终态后自关；服务端无泄漏。spec §10「收尾帧」未实现——可在终态 kind 处返回 `None` 终止 stream |
| #10 | `lease_expires_at` 列/字段从不读（dead state）；`next_status()` 仅自测、运行时不调（doc-as-code） | — | `lease_expires_at`：多 worker claim 落地时启用（YAGNI）；`next_status`：要么在各 `mark_*` 内作守卫调用、要么删 fn 仅留 §4 文档表（防「测试通过→以为状态机被强制」的假信心） |

---

## 12. 与 spec §6 的差异（本期收敛）

1. **取消清理**：spec §6.3「删 page_ids 驱动的 wiki_pages/embeddings」→ **只停不清**（去 page_ids，避共享页误删）。
2. **item_states**：去 `page_ids`、`page_ids` 用途（无级联删），仅 `{path,status,error}` 驱动续传+展示。
3. **SSE 通道**：spec §13 Q3 开放 → 定 **AppState broadcast**（单实例）。
4. **瞬态分类**：spec §6.2 笼统 → 落到具体 AppError 变体表（§6.1）。
5. **多 worker**：spec §6.7 → `lease_expires_at` 字段占位，逻辑不做（YAGNI）。
6. **终态标记交接**（review 发现）：pipeline **不自标记终态**，worker 按 `IngestJobResult.warnings` 三态标记——否则现网 worker Ok 分支无条件 `mark_job_succeeded` 覆盖掉 `succeeded_with_warnings` / 全失败（§7.2）。
7. **all-failed 判定 bug 修正**（review 发现）：现行 `updated_reserved.is_empty()` 条件恒假（保留页恒有）→ 全失败误标 succeeded；改用 item_states 判「全 failed」（§7.2）。
8. **自动重试退避**（review 发现）：重投前 `backoff_delay(retry_count)` 退避，防快速失败瞬态毫秒内撞满预算（§6.2）。
9. **手动重试重置额度**（review 发现）：`retry_count=0`（非 ++），重新发放自动重试额度（§6.3）。
10. **redis 命令错误瞬态**（review 发现）：现网 redis 命令错映射为 `InternalError`，§6.1 特判 message（redis/network）为瞬态；长期应改独立可重试变体。

---

## 13. 已定决策（brainstorming + review 收敛）

1. **`AppError::Cancelled` 新增变体**（§8.4）——类型安全，worker 按变体匹配（非字符串哨兵）。
2. **broadcast 容量 64**——单实例单 job source 数通常 <100，事件 per-source 数次；溢出靠 SSE 首帧回放 PG 快照兜底。
3. **SSE 用读权限** `check_project_access`（看进度=读）；cancel/retry 用 Admin。
4. **`max_retries` 默认 3**——embed_batch 已在 HTTP 层重试 3 次，job 级再 3 次（≈12 次 embedding 尝试上限），可配置。
