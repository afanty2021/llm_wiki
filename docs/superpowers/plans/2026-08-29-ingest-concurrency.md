# ingest 并发化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** src-server 摄取管线 `run_ingest_job` 从 source 级全串行改为"生成段并发 N 路 + 归并段按源序串行"两段分离，CLI 契约与数据语义零漂移。

**Architecture:** 生成段独立 tokio task（`futures::stream::iter(...).map(...).buffered(N)` 保序 + `mpsc::channel(32)` 与归并段解耦防饿死）；归并段 = 今日循环体原样搬移（取消检查点重构为 drain-received：移除②与页级检查点，终止信号 = ①按序 Cancelled 变体 + 尾段兜底）；worker 层与尾段零改动。

**Tech Stack:** Rust / tokio / futures 0.3（Cargo.toml 已有）/ sqlx PG / axum 测试 stub / Vitest（面板）。

**Spec:** `docs/superpowers/specs/2026-08-29-ingest-concurrency-design.md`（round2 Approve 定稿，b9b78601）——本计划的全部语义裁定出处，执行者须先读 spec。

## Global Constraints

- cargo 一律在 `src-server/` 目录内跑（根目录是另一个 workspace）。
- 集成测需 docker PG@5433 + Redis@6380；`#[ignore]` 门，显式 `cargo test --test integration -- --ignored` 跑（打爆 live DB 是既有红线）。
- **Redis DB1 隔离（T4 执行裁定）**：docker redis@6380 **DB0 就是 live redis**（launchd `wiki.src-server` worker 在 BRPOP 同一队列，会抢跑测试 job 造成非确定性失败）——集成测一律加 `REDIS_URL=redis://localhost:6380/1`（T4 实证：共库 2 例随机挂，DB1 全绿）。live 进程不动。
- 测试不经 enqueue/HTTP 触发 job（LPUSH 进共享 redis 会被 launchd worker 抢走双跑）——一律直接 INSERT `ingest_jobs` + 直调 `run_ingest_job`（t8_insert_and_run 既有模式）。
- `git add` 只加本任务清单点名的文件，禁 `-A`（untracked 有 MEMORY/WORK、Plans/ 运维残留）。
- 提交前必查 `git branch --show-current` = `feat/ingest-concurrency`（并行会话 checkout 冲突史）。
- commit message 中文、一行主题。
- vitest 从仓库 root 跑指定路径：`npx vitest run src/components/web/web-ingest-panel.test.tsx`。
- 集成测 FILE 块 fixture 的 frontmatter **必须带 `sources: [raw/…​.md]` 行**（照 t8_file_block 模板，merge_ingest_test.rs:278-283）——parse_single_block 对缺失 sources 默认 `[]`，碰撞并集会丢源（评审 I-1）。
- 集成测一律加 `--test-threads=1` 串行跑（评审 M-5，merge_ingest_test.rs:6 文档化先例；flake 首查此处）。
- 前端改动部署需 `npm run build:web`（dist 运行时读盘）——本计划只改代码，部署是收官动作不在任务内。
- `AppError` 无 Clone（error.rs:23）——`JobError(AppError)` 经 mpsc 只需 Send，move 语义，勿加 Clone。

---

### Task 1: 配置面 IngestConfig + 并发度 clamp

**Files:**
- Modify: `src-server/src/config.rs`（AppConfig 加 `ingest` 字段 + IngestConfig 结构体）
- Modify: `src-server/src/services/ingest_pipeline.rs`（`clamp_source_concurrency` 纯函数 + 单测）

**Interfaces:**
- Produces: `AppConfig.ingest: IngestConfig`（`IngestConfig { source_concurrency: usize }`，serde default 3，env `INGEST__SOURCE_CONCURRENCY`）；`pub(crate) fn clamp_source_concurrency(n: usize) -> usize`（Task 4 的 run_ingest_job 消费）

- [ ] **Step 1: 写失败单测**（ingest_pipeline.rs `mod tests` 内追加）

```rust
    // —— spec §4：并发度 clamp 1..=8（0/异常 → 1，超上限 → 8）——
    #[test]
    fn clamp_source_concurrency_bounds() {
        assert_eq!(clamp_source_concurrency(0), 1);
        assert_eq!(clamp_source_concurrency(1), 1);
        assert_eq!(clamp_source_concurrency(3), 3);
        assert_eq!(clamp_source_concurrency(8), 8);
        assert_eq!(clamp_source_concurrency(9), 8);
        assert_eq!(clamp_source_concurrency(usize::MAX), 8);
    }
```

- [ ] **Step 2: 跑测确认失败**

Run: `cd src-server && cargo test --lib clamp_source_concurrency`
Expected: FAIL（`cannot find function`）

- [ ] **Step 3: 实现**——ingest_pipeline.rs 纯函数区（`fold_page_write_outcomes` 之后）加：

```rust
/// spec §4：ingest 并发度 clamp——1..=8；0 或异常值 → 1，超上限 → 8。
/// config 侧只存原始值，消费点（run_ingest_job）读取时统一过本函数，
/// 集成测试直接改 state.config.ingest.source_concurrency 后无需自行 clamp。
pub(crate) fn clamp_source_concurrency(n: usize) -> usize {
    n.clamp(1, 8)
}
```

config.rs：`AppConfig` 结构体 `pub logging: LoggingConfig,` 之后加一行字段；文件内 LoggingConfig 定义附近加结构体：

```rust
    #[serde(default)]
    pub logging: LoggingConfig,
    #[serde(default)]
    pub ingest: IngestConfig,
```

```rust
/// ingest 并发配置（spec 2026-08-29 §4）：source 级生成并发度，默认 3（对齐
/// transcriber 侧裁定），env INGEST__SOURCE_CONCURRENCY 覆盖；消费侧经
/// ingest_pipeline::clamp_source_concurrency 收敛到 1..=8。
#[derive(Debug, Clone, Deserialize)]
pub struct IngestConfig {
    #[serde(default = "default_source_concurrency")]
    pub source_concurrency: usize,
}

fn default_source_concurrency() -> usize {
    3
}

impl Default for IngestConfig {
    fn default() -> Self {
        Self {
            source_concurrency: default_source_concurrency(),
        }
    }
}
```

- [ ] **Step 4: 跑测确认过 + 编译面**

Run: `cd src-server && cargo test --lib clamp_source_concurrency && cargo build --tests`
Expected: PASS；编译零错（AppConfig 派生 Clone/Deserialize 已有，新字段 serde default 兼容全部既有构造路径）

- [ ] **Step 5: Commit**

```bash
git branch --show-current   # 必须是 feat/ingest-concurrency
git add src-server/src/config.rs src-server/src/services/ingest_pipeline.rs
git commit -m "feat(ingest): IngestConfig 配置面 + 并发度 clamp 纯函数（spec §4）"
```

---

### Task 2: 429/限流归入 transient 分类

**Files:**
- Modify: `src-server/src/services/ingest_queue.rs`（`is_transient_msg` + `is_transient_job_err` InternalError 分支 + 单测）

**Interfaces:**
- Produces: transient 分类扩展——`AppError::LlmApiError` 含 429/rate limit 语义、`InternalError`（all-failed 承重路径）含 "Rate limited" 字样时均判瞬态。Task 8 集成测消费。

- [ ] **Step 1: 写失败单测**（ingest_queue.rs `mod tests` 的 `is_transient_classification` 内追加）

```rust
    // —— r1 G-1：429/限流归入瞬态。承重链：批量 429 → 单源 Failed → warnings →
    // all-failed InternalError，消息含 "Rate limited"（429 在 llm_stream.rs:207
    // 前置映射为 RateLimited，Display "Rate limited"，不会以 "API error 429"
    // 形态出现——"rate limit" 模式承重，不可精简掉）。
    assert!(is_transient_job_err(&AppError::LlmApiError("step1: Rate limited".into())));
    assert!(is_transient_job_err(&AppError::LlmApiError("embed HTTP 429: quota".into())));
    assert!(is_transient_job_err(&AppError::InternalError(
        "all 3 source(s) failed: process raw/a.md: step1: Rate limited".into()
    )));
    // 非瞬态面不受影响
    assert!(!is_transient_job_err(&AppError::LlmApiError("HTTP 400 content violation".into())));
```

- [ ] **Step 2: 跑测确认失败**

Run: `cd src-server && cargo test --lib is_transient_classification`
Expected: FAIL（前三断言——现分类不含 rate 模式）

- [ ] **Step 3: 实现**

`is_transient_msg` 追加三模式：

```rust
fn is_transient_msg(msg: &str) -> bool {
    let m = msg.to_lowercase();
    // 两种 5xx 报文格式：embedding.rs 用 "HTTP {status}"；LLM streaming（LlmError::ApiError Display）用 "API error {status}"
    // r1 G-1：429/限流归瞬态——批量 429 经 all-failed 路径以 InternalError 到达
    // worker（含 "Rate limited"，429 在 llm_stream.rs:207 前置映射，不走
    // "API error 429"）；"rate limit" 是承重模式，不可精简（spec §7）。
    m.contains("http 5") || m.contains("api error 5") || m.contains("timeout") || m.contains("connect") || m.contains("connection")
        || m.contains("http 429") || m.contains("api error 429") || m.contains("rate limit")
}
```

`is_transient_job_err` 的 `InternalError` 分支同样追加三模式：

```rust
        AppError::InternalError(msg) => {
            let m = msg.to_lowercase();
            // r1 G-1：all-failed join 文本含 "Rate limited" → 瞬态（同上，"rate limit" 承重）
            m.contains("redis") || m.contains("connection refused") || m.contains("timeout") || m.contains("connect")
                || m.contains("http 429") || m.contains("api error 429") || m.contains("rate limit")
        }
```

- [ ] **Step 4: 跑测确认过**

Run: `cd src-server && cargo test --lib is_transient`
Expected: PASS（含既有全部断言零回归）

- [ ] **Step 5: Commit**

```bash
git add src-server/src/services/ingest_queue.rs
git commit -m "feat(ingest): 429/限流归入 transient 分类（all-failed 承重 + LlmApiError 双保险，spec §7）"
```

---

### Task 3: Phase1Output + 纯函数四件套 + peek_cancel

**Files:**
- Modify: `src-server/src/services/ingest_pipeline.rs`（`Phase1Output` 枚举 + `dedupe_targets` / `item_progress` / `verify_generator_completeness` / `peek_outcome` + 单测）
- Modify: `src-server/src/services/ingest_queue.rs`（`peek_cancel` 只读函数）

**Interfaces:**
- Produces（Task 4 消费，签名逐字）：
  - `enum Phase1Output { Done { sp: String, processed: Option<ProcessedSource> }, Failed { sp: String, err: String }, Cancelled, JobError(AppError) }`
  - `pub(crate) fn dedupe_targets(source_paths: &[String]) -> Vec<String>`
  - `pub(crate) fn item_progress(done: usize, total: usize) -> i32`
  - `pub(crate) fn verify_generator_completeness(received: usize, expected: usize) -> Result<(), AppError>`
  - `fn peek_outcome(r: Result<bool, AppError>) -> Option<Phase1Output>`
  - `pub async fn peek_cancel(state: &AppState, job_id: Uuid) -> Result<bool, AppError>`（ingest_queue.rs）

- [ ] **Step 1: 写失败单测**（ingest_pipeline.rs `mod tests` 追加）

```rust
    // —— spec §1 dispatch 去重（r1 控制器补项）：同 path 首现保留、保序 ——
    #[test]
    fn dedupe_targets_keeps_first_occurrence_ordered() {
        let paths = vec!["raw/a.md".to_string(), "raw/b.md".to_string(), "raw/a.md".to_string()];
        assert_eq!(dedupe_targets(&paths), vec!["raw/a.md".to_string(), "raw/b.md".to_string()]);
        assert_eq!(dedupe_targets(&[]), Vec::<String>::new());
    }

    // —— spec §2/D-2：进度 = 完成数*100/total.max(1)，total=0 恒 0 ——
    #[test]
    fn item_progress_formula_with_zero_total_guard() {
        assert_eq!(item_progress(0, 10), 0);
        assert_eq!(item_progress(3, 10), 30);
        assert_eq!(item_progress(10, 10), 100);
        assert_eq!(item_progress(0, 0), 0);
        assert_eq!(item_progress(2, 3), 66);
    }

    // —— spec §6：生成段计数不变量——只防"提前死"（Cancelled/JobError 提前 return，
    // 走到这里且短缺 = generator 异常终止，防残缺 job 静默 succeeded）
    #[test]
    fn verify_generator_completeness_flags_shortfall() {
        assert!(verify_generator_completeness(3, 3).is_ok());
        assert!(verify_generator_completeness(0, 0).is_ok());
        let err = verify_generator_completeness(1, 3).unwrap_err();
        assert!(err.to_string().contains("generator terminated early"));
    }

    // —— spec §1/C-1：① peek 三分支——Ok(false) 继续（None）、Ok(true) → Cancelled、
    // Err 原值 → JobError（transient 分类零漂移，防误映射为 Failed）
    #[test]
    fn peek_outcome_preserves_job_error_variant() {
        assert!(peek_outcome(Ok(false)).is_none());
        assert!(matches!(peek_outcome(Ok(true)), Some(Phase1Output::Cancelled)));
        let db_err = AppError::DatabaseError(sqlx::Error::ColumnNotFound("x".into()));
        match peek_outcome(Err(db_err)) {
            Some(Phase1Output::JobError(e)) => {
                assert!(matches!(e, AppError::DatabaseError(_)));
            }
            other => panic!("Err 必须映射为 JobError 变体，got {:?}", other.map(|_| ())),
        }
    }
```

- [ ] **Step 2: 跑测确认失败**

Run: `cd src-server && cargo test --lib dedupe_targets item_progress verify_generator_completeness peek_outcome`
Expected: FAIL（类型/函数不存在）

- [ ] **Step 3: 实现**——ingest_pipeline.rs `PageWriteOutcome` 枚举附近加：

**前置一行（评审 I-A 编译必修）**：给 `ProcessedSource`（ingest_pipeline.rs:32，现无任何 derive）加 `#[derive(Debug)]`——`Phase1Output` 的 derive(Debug) 需要 `Option<ProcessedSource>: Debug`；内层 `WikiPageInsert`（:18-19）与 `ParsedReview`（review.rs:17-18）均已 Debug，一行即过。

```rust
/// 生成段 → 归并段的通道消息（spec §1）。Done 携带 process_source_path 产出
/// （None = hash 未变跳过）；Failed = 单源生成失败（今日 1300-1305 源级隔离）；
/// Cancelled = ①领任务 peek 命中（归并段负责唯一 mark，B-3 单事件）；
/// JobError = ① peek 的 job 级异常原值透传（保 transient 分类，C-1）。
#[derive(Debug)]
enum Phase1Output {
    Done { sp: String, processed: Option<ProcessedSource> },
    Failed { sp: String, err: String },
    Cancelled,
    JobError(AppError),
}

/// ① 领任务 peek 的三分支判定（纯函数供单测钉死映射语义）。
fn peek_outcome(r: Result<bool, AppError>) -> Option<Phase1Output> {
    match r {
        Ok(false) => None,
        Ok(true) => Some(Phase1Output::Cancelled),
        Err(e) => Some(Phase1Output::JobError(e)),
    }
}

/// dispatch 保序去重（r1 控制器补项）：同 job 重复 source_path 首现保留——
/// 消除"第二出现的生成段跑在第一出现 mark_file_ingested 之前 → hash 未命中
/// 重跑"的角点。
/// 隐含接受面（评审控制器补 2）：含重复 path 的 job 去重后 item 数 <
/// source_paths.len() → 终态 progress <100、item_states 条目少于源数——
/// spec 去重裁定的既定行为，勿误判为进度 bug。
pub(crate) fn dedupe_targets(source_paths: &[String]) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for sp in source_paths {
        if seen.insert(sp.clone()) {
            out.push(sp.clone());
        }
    }
    out
}

/// 归并段进度（spec §2）：完成 item 数 → 百分比。total=0 恒 0（max(1) 守卫，
/// 与今日 (i+1)*100/total.max(1) 分母口径一致）。
pub(crate) fn item_progress(done: usize, total: usize) -> i32 {
    (done * 100 / total.max(1)) as i32
}

/// spec §6 生成段计数不变量：归并段循环正常结束（channel 关闭）后调用，
/// 已收数 < expected 且未见 Cancelled/JobError（二者在循环内提前 return）
/// = generator panic 等异常终止 → Err 走 mark_job_failed（manual_retry 自愈）。
pub(crate) fn verify_generator_completeness(received: usize, expected: usize) -> Result<(), AppError> {
    if received < expected {
        return Err(AppError::InternalError(format!(
            "generator terminated early: received {} of {} items",
            received, expected
        )));
    }
    Ok(())
}
```

ingest_queue.rs `check_cancel` 之后加：

```rust
/// ① 领任务检查点（只读，spec §1/B-3）：cancel_requested=true → Ok(true)。
/// 与 check_cancel 的区别：不 mark_job_cancelled、不发事件——并发领任务的
/// N 路各自 peek 零副作用；唯一的 mark 由归并段收到 Cancelled 变体时执行
/// （每 job 恰一次、job_cancelled 事件恰一条）。
pub async fn peek_cancel(state: &AppState, job_id: Uuid) -> Result<bool, AppError> {
    let cancel: bool = sqlx::query_scalar("SELECT cancel_requested FROM ingest_jobs WHERE id=$1")
        .bind(job_id)
        .fetch_optional(&state.db)
        .await?
        .unwrap_or(false);
    Ok(cancel)
}
```

- [ ] **Step 4: 跑测确认过**

Run: `cd src-server && cargo test --lib dedupe_targets item_progress verify_generator_completeness peek_outcome`
Expected: 4 组全 PASS（注意：`Phase1Output` 此时未被 run_ingest_job 引用，`JobError(AppError)` 变体与 `peek_outcome` 因单测消费不触发 dead_code；若编译器警告 unused，`#[allow(dead_code)]` 暂不加——Task 4 即接线）

- [ ] **Step 5: Commit**

```bash
git add src-server/src/services/ingest_pipeline.rs src-server/src/services/ingest_queue.rs
git commit -m "feat(ingest): Phase1Output + dispatch 去重/进度/计数不变量/peek 判定纯函数（spec §1/§2/§6）"
```

---

### Task 4: run_ingest_job 两段化重构（核心）

**Files:**
- Modify: `src-server/src/services/ingest_pipeline.rs:1063-1361`（`run_ingest_job` 主体重构）
- Test: 既有 `cargo test --lib` 全套 + 集成四件套（`src-server/tests/integration/ingest_test.rs` / `ingest_reliability_test.rs` / `ingest_queue_test.rs` / `merge_ingest_test.rs`）——零修改必须全绿

**Interfaces:**
- Consumes: Task 1 `clamp_source_concurrency`、Task 3 全部（`Phase1Output` / `dedupe_targets` / `item_progress` / `verify_generator_completeness` / `peek_outcome`）+ `ingest_queue::peek_cancel`
- Produces: `run_ingest_job` 新执行模型（签名不变）；stage 枚举 `processing`（新）+ `building_index`（既有）；`parsing`/`generating` 不再由本函数写入

- [ ] **Step 1: 重构 run_ingest_job**

用下面的完整结构替换现有函数体（语义出处逐段标注 spec 章节）。**归并段 `Done { processed: Some }` 臂的页循环 = 今日 1146-1250 逐字保留，仅一处删除：页循环开头的页级 `check_cancel` 块（今日 1147-1153，drain 裁定）**。今日 1100-1135 的 for 循环头、already_done 分支、`update_job_stage("parsing"/"generating")` 两处调用全部删除：

```rust
pub async fn run_ingest_job(
    state: &AppState,
    job: &IngestJob,
) -> Result<IngestJobResult, AppError> {
    let (team_id, ingest_language) = load_project_ingest_context(state, job.project_id).await?;
    let language = ingest_language.as_deref();

    let mut result = IngestJobResult {
        new_pages: vec![],
        merged_pages: vec![],
        updated_reserved: vec![],
        warnings: vec![],
    };
    let mut collected: Vec<(String, String)> = Vec::new();
    // merge provider 懒获取（评审 A-M6）：首次碰撞才取，失败并入整页回退（I1）
    let mut merge_provider: Option<Box<dyn StreamChatProvider>> = None;

    // —— §1 dispatch：prior-done 过滤 + 保序去重 ——
    let is_prior_done = |sp: &str| -> bool {
        job.item_states
            .as_array()
            .map(|arr| {
                arr.iter().any(|v| {
                    v.get("path").and_then(|p| p.as_str()) == Some(sp)
                        && v.get("status").and_then(|s| s.as_str()) == Some("done")
                })
            })
            .unwrap_or(false)
    };
    // prior-done 计入 done_this_run（今日 1116-1121 语义：历史成功不算 all-failed）。
    // 经 is_prior_done 逐 path 判定 = 与 source_paths 天然求交——item_states 理论上
    // 可含非本 job 路径的条目，交集计数防 progress 初值虚高（评审控制器补 1）。
    let prior_done: usize = job
        .source_paths
        .iter()
        .filter(|sp| is_prior_done(sp.as_str()))
        .count();
    let mut done_this_run = prior_done;
    let targets: Vec<String> = dedupe_targets(&job.source_paths)
        .into_iter()
        .filter(|sp| !is_prior_done(sp))
        .collect();
    let expected = targets.len();
    let total = job.source_paths.len();

    // §2 清单 + cap 联动（I-5，不变）
    let context_size = crate::services::llm::get_llm_config(&state.db, job.project_id)
        .await
        .map(|c| c.context_size.max(0) as u32)
        .unwrap_or(128_000);
    let paths_cap = existing_paths_cap(context_size);
    let existing_paths = fetch_concept_entity_paths(state, job.project_id, paths_cap).await;

    // stage 单一化（spec §2 唯一表示法变化）：processing + item 计数进度
    let _ = ingest_queue::update_job_stage(state, job.id, "processing", item_progress(prior_done, total)).await;

    // —— §1 生成段（独立 task：buffered(N) 保序 + channel(32) 解耦防饿死）——
    let raw_concurrency = state.config.ingest.source_concurrency;
    let n = clamp_source_concurrency(raw_concurrency);
    // spec §4：超界 clamp 落 warn（观测性——评审 M-1）
    if n != raw_concurrency {
        tracing::warn!(raw = raw_concurrency, clamped = n, "INGEST__SOURCE_CONCURRENCY out of 1..=8, clamped");
    }
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Phase1Output>(32);
    {
        let state = state.clone();
        let job_id = job.id;
        let project_id = job.project_id;
        let language_owned = ingest_language.clone();
        let existing_paths = existing_paths.clone();
        let paths_cap_usize = paths_cap as usize;
        tokio::spawn(async move {
            use futures::StreamExt;
            let mut stream = futures::stream::iter(targets)
                .map(|sp| {
                    let state = state.clone();
                    let language = language_owned.clone();
                    let existing_paths = existing_paths.clone();
                    async move {
                        // ① 领任务检查点（peek 只读——B-3：并发 peek 零副作用，
                        // 唯一 mark 在归并段收变体时执行）
                        if let Some(out) = peek_outcome(ingest_queue::peek_cancel(&state, job_id).await) {
                            return out;
                        }
                        match process_source_path(
                            &state,
                            project_id,
                            team_id,
                            &sp,
                            language.as_deref(),
                            &existing_paths,
                            paths_cap_usize,
                        )
                        .await
                        {
                            Ok(p) => Phase1Output::Done { sp, processed: p },
                            Err(e) => Phase1Output::Failed { sp, err: e.to_string() },
                        }
                    }
                })
                .buffered(n);
            while let Some(item) = stream.next().await {
                // spec §6：变体（Cancelled/JobError）之后不再 send——后续 poll 只会
                // 再产变体（零工作 peek），break 省一次空转（评审 M-7 对齐字面）
                let terminal = matches!(item, Phase1Output::Cancelled | Phase1Output::JobError(_));
                if tx.send(item).await.is_err() {
                    break; // 归并段提前 return（JobError/§6）→ rx drop；在飞 future abort（B-2，安全）
                }
                if terminal {
                    break;
                }
            }
        });
    }

    // —— §2 归并段（按源序串行：竞争点全部在此消解）——
    let mut received = 0usize;
    while let Some(item) = rx.recv().await {
        received += 1;
        match item {
            Phase1Output::Cancelled => {
                // 唯一的 mark（B-3 单事件保证；spec §5 终止信号）
                let _ = ingest_queue::mark_job_cancelled(state, job.id).await;
                return Err(AppError::Cancelled);
            }
            Phase1Output::JobError(e) => return Err(e),
            Phase1Output::Failed { sp, err } => {
                // 今日 1300-1305 原样：源级隔离
                result.warnings.push(format!("process {}: {}", sp, err));
                let _ = ingest_queue::update_item_state(state, job.id, &sp, "failed", Some(&err)).await;
            }
            Phase1Output::Done { sp, processed: None } => {
                let _ = ingest_queue::update_item_state(state, job.id, &sp, "done", None).await;
                done_this_run += 1;
            }
            Phase1Output::Done { sp, processed: Some(processed) } => {
                let pages_to_write = processed.pages.len();
                let mut outcomes: Vec<PageWriteOutcome> = Vec::with_capacity(pages_to_write);
                for page in &processed.pages {
                    // 【删除今日 1147-1153 的页级 check_cancel 块——drain 裁定：
                    // cancel 后已生成 cohort 完整落库，F1 威胁由 ① 关口 + 有界
                    // cohort 结构性约束（spec §2）】
                    //
                    // —— 以下今日 1155-1250 逐字保留（含 W2 注释）——
                    if is_llm_generated_path(&page.path) {
                        tracing::warn!(path = %page.path, source = %sp, "skip LLM page into transcripts/ namespace");
                        outcomes.push(PageWriteOutcome::GuardSkipped);
                        continue;
                    }
                    let existing = match fetch_existing_page(state, job.project_id, &page.path).await {
                        Ok(e) => e,
                        Err(err) => {
                            result.warnings.push(format!("fetch existing {}: {}", page.path, err));
                            outcomes.push(PageWriteOutcome::UpsertFailed);
                            continue;
                        }
                    };
                    let mode = existing
                        .as_ref()
                        .map_or(CollisionMode::Replace, |e| collision_mode(&e.sources, &page.sources, &sp));
                    let merged_write: Option<Result<(String, serde_json::Value), String>> = match (&mode, existing.as_ref()) {
                        (CollisionMode::Merge, Some(e)) => {
                            if merge_provider.is_none() {
                                match llm_stream::provider_for_project(state, job.project_id).await {
                                    Ok(p) => merge_provider = Some(p),
                                    Err(err) => result.warnings.push(format!("merge provider unavailable: {}", err)),
                                }
                            }
                            match merge_provider.as_ref() {
                                Some(p) => match merge_pages_via(&**p, language, &sp, &e.content, &page.content).await {
                                    Ok(merged_content) => {
                                        if merged_content.len() > (e.content.len() + page.content.len()) * 4 / 5 {
                                            result.warnings.push(format!(
                                                "merge {}: output longer than 80% of combined inputs (inflation watch)",
                                                page.path
                                            ));
                                        }
                                        Some(Ok((merged_content, union_sources(&e.sources, &page.sources, &sp))))
                                    }
                                    Err(err) => Some(Err(format!("merge {}: {} — fallback replace", page.path, err))),
                                }
                                None => Some(Err(format!("merge {}: no provider — fallback replace", page.path))),
                            }
                        }
                        _ => None,
                    };
                    match merged_write {
                        Some(Ok((merged_content, merged_sources))) => match existing.as_ref() {
                            Some(e) => {
                                match update_merged_page(state, job.project_id, &page.path, &merged_content, &merged_sources, &e.frontmatter).await {
                                    Ok(()) => {
                                        result.merged_pages.push(page.path.clone());
                                        if !merged_content.trim().is_empty() {
                                            collected.push((page.path.clone(), merged_content));
                                        }
                                        outcomes.push(PageWriteOutcome::Upserted);
                                    }
                                    Err(err) => {
                                        result.warnings.push(format!("update merged {}: {}", page.path, err));
                                        outcomes.push(PageWriteOutcome::UpsertFailed);
                                    }
                                }
                            }
                            None => unreachable!("merge 分支必有 existing"),
                        },
                        Some(Err(warn)) => {
                            result.warnings.push(warn);
                            match upsert_wiki_page(state, job.project_id, page).await {
                                Ok(path) => {
                                    result.new_pages.push(path.clone());
                                    if let Some(text) = page_content_for_embed(page) {
                                        collected.push((path, text));
                                    }
                                    outcomes.push(PageWriteOutcome::Upserted);
                                }
                                Err(err) => {
                                    result.warnings.push(format!("upsert {}: {}", sp, err));
                                    outcomes.push(PageWriteOutcome::UpsertFailed);
                                }
                            }
                        }
                        None => match upsert_wiki_page(state, job.project_id, page).await {
                            Ok(path) => {
                                result.new_pages.push(path.clone());
                                if let Some(text) = page_content_for_embed(page) {
                                    collected.push((path, text));
                                }
                                outcomes.push(PageWriteOutcome::Upserted);
                            }
                            Err(err) => {
                                result.warnings.push(format!("upsert {}: {}", sp, err));
                                outcomes.push(PageWriteOutcome::UpsertFailed);
                            }
                        },
                    }
                }
                // —— 今日 1252-1298 逐字保留（fold 计账 + deferred-write + item_state）——
                let (pages_written, all_upserted) = fold_page_write_outcomes(&outcomes);
                if all_upserted {
                    if let Err(e) = mark_file_ingested(
                        state,
                        job.project_id,
                        &sp,
                        &processed.content_hash,
                        processed.file_size,
                        &processed.file_type,
                    )
                    .await
                    {
                        result.warnings.push(format!("mark ingested {}: {}", sp, e));
                    }
                    if !processed.reviews.is_empty() {
                        if let Err(e) = crate::services::review::insert_review_items(
                            state,
                            job.project_id,
                            &processed.reviews,
                        )
                        .await
                        {
                            result.warnings.push(format!("insert reviews for {}: {}", sp, e));
                        }
                    }
                }
                if pages_written > 0 || pages_to_write == 0 {
                    let _ = ingest_queue::update_item_state(state, job.id, &sp, "done", None).await;
                    done_this_run += 1;
                } else {
                    let _ = ingest_queue::update_item_state(
                        state,
                        job.id,
                        &sp,
                        "failed",
                        Some("all page upserts failed"),
                    )
                    .await;
                }
            }
        }
        // 每 item 完成推进进度（含 Failed 与 hash 跳过——spec §2）
        let _ = ingest_queue::update_job_stage(state, job.id, "processing", item_progress(prior_done + received, total)).await;
    }

    // §6 计数不变量：循环正常结束但收数短缺 = generator 异常终止（Cancelled/
    // JobError 已在循环内提前 return，不会到达此处）
    verify_generator_completeness(received, expected)?;

    // —— 尾段（今日 1317-1360 逐字保留：check_cancel 兜底 + building_index +
    // reserved 重建 + all-failed 判定 + 批量 embed）——
    if let Err(e) = ingest_queue::check_cancel(state, job.id).await {
        return Err(e);
    }
    let _ = ingest_queue::update_job_stage(state, job.id, "building_index", 100).await;
    match rebuild_reserved_pages(state, job.project_id, language).await {
        Ok(reserved) => {
            result.updated_reserved = reserved.iter().map(|(p, _)| p.clone()).collect();
            collected.extend(reserved);
        }
        Err(e) => result.warnings.push(format!("reserved pages: {}", e)),
    }
    let total_sources = job.source_paths.len();
    if total_sources > 0 && done_this_run == 0 && !result.warnings.is_empty() {
        return Err(AppError::InternalError(format!(
            "all {} source(s) failed: {}",
            total_sources,
            result.warnings.join("; ")
        )));
    }
    if let Err(e) = ingest_queue::check_cancel(state, job.id).await {
        return Err(e);
    }
    if !collected.is_empty() {
        if let Err(e) = crate::services::embedding::embed_and_store(
            &*state.vector_store,
            state.config.embedding.as_ref(),
            &state.http,
            job.project_id,
            &collected,
        )
        .await
        {
            result.warnings.push(format!("embed batch: {}", e));
        }
    }

    Ok(result)
}
```

实现注意（对照今日源码逐条核对）：
1. 生成段闭包捕获按值 clone（`AppState` 是 Arc 族 Clone）；`language_owned` 归并段继续用借用 `language`（merge_pages_via 需要）——两层各自持有。
2. `Some(Err(warn))` 臂 `result.warnings.push(warn)` 直接 move（与今日 1222 一致，评审 M-8：无 clone）。
3. 删除点清单：今日 1100（for 头）、1102-1104（源级 check_cancel）、1105-1121（already_done 分支——逻辑上移 dispatch）、1123-1124（parsing stage 写）、1147-1153（页级 check_cancel）、1308-1314（generating stage 写）。
4. `expected`/`received`/`prior_done`/`total` 命名与 Task 3 纯函数签名一致。

- [ ] **Step 2: lib 全量单测**

Run: `cd src-server && cargo test --lib`
Expected: 全 PASS（40+ 既有用例零回归；`Phase1Output` 各变体已被消费，无 dead_code 警告）

- [ ] **Step 3: 集成四件套回归**（docker PG/Redis 起着的前提下）

Run: `cd src-server && cargo test --test integration -- --ignored ingest --test-threads=1`
Expected: ingest_test / ingest_reliability_test / ingest_queue_test / merge_ingest_test 全 PASS（默认 N=3 走并发路径 = 天然回归网）

- [ ] **Step 4: Commit**

```bash
git branch --show-current
git add src-server/src/services/ingest_pipeline.rs
git commit -m "feat(ingest): run_ingest_job 两段化——生成段 buffered(N)+channel 并发、归并段按源序串行（drain 取消语义，spec §1/§2/§5）"
```

---

### Task 5: 路由 stub 基建 + 并发正确性 / N=1 等价 / 确定性归并

**Files:**
- Create: `src-server/tests/integration/ingest_concurrency_test.rs`
- Modify: `src-server/tests/integration/mod.rs`（挂模块 + SWEEPS 加 `t10_` 前缀族）

**Interfaces:**
- Consumes: Task 4 的 `run_ingest_job` 新模型；`AppConfig.ingest.source_concurrency`（经 `(*state.config).clone()` + `create_app` 注入并发度——t8_setup_project 同款手法）
- Produces（后续 Task 6/7/8 复用，均在 ingest_concurrency_test.rs 内 `pub(crate)`）：`RoutingStub` / `StubRoute` / `RouteResp` / `spawn_routing_stub` / `IcEnv` / `ic_setup` / `ic_write_source` / `ic_insert_job` / `ic_run_ok` / `ic_fetch_item_states`

- [ ] **Step 1: mod.rs 挂模块 + SWEEPS 扩 t10_**

`pub mod merge_ingest_test;` 后加 `pub mod ingest_concurrency_test;`。SWEEPS 三条 SQL 的 LIKE 列表逐条追加：projects 加 `OR name LIKE 'LT项目_t10\\_%'`；users 的 username 锚定加 `OR username LIKE 't10\\_%'`、email 非锚定加 `OR email LIKE '%t10\\_%'`（照 t8 的位置与转义逐字模仿）。

- [ ] **Step 2: 路由 stub 完整实现**（ingest_concurrency_test.rs 文件头 + 类型 + stub）

```rust
// ingest 并发化集成测（spec 2026-08-29 §测试与验收 1/2/6：并发正确性、确定性
// 归并、N=1 等价）。需 PG(docker @5433) + Redis(@6380)；#[ignore] 门。
// 铁律：直 INSERT ingest_jobs + 直调 run_ingest_job（不经 enqueue/HTTP——LPUSH
// 会被共享 redis 侧 worker 抢走双跑，t8_insert_and_run 同款）。
// 命名：t10_ 前缀族（mod.rs SWEEPS 已扩入）。
use llm_wiki_server::services::ingest_pipeline;
use llm_wiki_server::services::ingest_queue::IngestJob;
use sqlx::Row;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

// —— 路由 stub：按请求体 content 的子串组合路由（并发下"按序弹栈"会竞态）——

#[derive(Clone)]
pub(crate) enum RouteResp {
    /// SSE 文本响应（step1/step2/review/merge 通用三帧）
    Text(String),
    Error(u16),
}

/// 调用类型锚（llm prompt 结构性差异，稳定可依赖）：step1 = "<document>"；
/// step2 = "<analysis>"；dedicated review = "## Wiki Purpose"；merge = "<existing>"。
/// 源身份锚 = fixture 内容埋 MARKxx（step1 的 <document> 与 step2 的 <source> 都
/// 内嵌原文 → 同一 marker 命中两调用）。
#[derive(Clone)]
pub(crate) struct StubRoute {
    /// 全部子串都出现在请求 content 里 → 命中（组合定位：调用类型 + 源身份）
    pub all: Vec<&'static str>,
    pub delay_ms: u64,
    pub resp: RouteResp,
}

pub(crate) struct RoutingStub {
    pub base: String,
    /// 完成序 marker 记录（断言调用次序用；marker = all.join("+")）
    pub calls: Arc<Mutex<Vec<String>>>,
    /// 每 marker 进入即计（delay 前）——测试等待"已开始"锚点
    pub started: Arc<Mutex<HashMap<String, usize>>>,
}

pub(crate) async fn spawn_routing_stub(routes: Vec<StubRoute>) -> RoutingStub {
    use axum::extract::{Json, State};
    use axum::response::IntoResponse;
    use axum::routing::post;
    use axum::Router;

    let routes = Arc::new(routes);
    let calls: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let started: Arc<Mutex<HashMap<String, usize>>> = Arc::new(Mutex::new(HashMap::new()));

    let app = Router::new()
        .route(
            "/chat/completions",
            post(
                |State((routes, calls, started)): State<(
                    Arc<Vec<StubRoute>>,
                    Arc<Mutex<Vec<String>>>,
                    Arc<Mutex<HashMap<String, usize>>>,
                )>,
                 Json(body): Json<serde_json::Value>| async move {
                    // openai provider 把 system_prompt 折进 messages（role=system）
                    // ——拼 messages 各项 content 即覆盖 system + user。
                    let content: String = body["messages"]
                        .as_array()
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|m| m["content"].as_str().map(String::from))
                                .collect::<Vec<_>>()
                                .join("\n")
                        })
                        .unwrap_or_default();
                    let hit = routes.iter().find(|r| r.all.iter().all(|m| content.contains(m)));
                    let route = match hit {
                        Some(r) => r,
                        None => {
                            return (axum::http::StatusCode::INTERNAL_SERVER_ERROR, "no route")
                                .into_response()
                        }
                    };
                    let marker = route.all.join("+");
                    *started.lock().unwrap().entry(marker.clone()).or_insert(0) += 1;
                    if route.delay_ms > 0 {
                        tokio::time::sleep(Duration::from_millis(route.delay_ms)).await;
                    }
                    calls.lock().unwrap().push(marker);
                    match &route.resp {
                        RouteResp::Text(t) => {
                            // SSE 三帧照 merge_ingest_test::spawn_stub_chat_server
                            // 逐字节同款（text delta → usage → [DONE]）
                            let content_json = serde_json::to_string(t).unwrap();
                            let sse = format!(
                                "data: {{\"choices\":[{{\"delta\":{{\"content\":{}}}}}]}}\n\n\
                                 data: {{\"choices\":[],\"usage\":{{\"prompt_tokens\":10,\"completion_tokens\":100}}}}\n\n\
                                 data: [DONE]\n\n",
                                content_json
                            );
                            (
                                [(axum::http::header::CONTENT_TYPE, "text/event-stream")],
                                sse,
                            )
                                .into_response()
                        }
                        RouteResp::Error(code) => {
                            (axum::http::StatusCode::from_u16(*code).unwrap(), "stub error")
                                .into_response()
                        }
                    }
                },
            ),
        )
        .with_state((routes, calls, started));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap(); });
    RoutingStub {
        base: format!("http://{}", addr),
        calls,
        started,
    }
}
```

- [ ] **Step 3: 编译核对 stub**

Run: `cd src-server && cargo build --tests`
Expected: 零错。若 closure 双 extractor（`|State(...), Json(body)|`）在当前 axum 版本报 trait bound 错，退路是把 handler 改为具名 `async fn`（参数 `State<...>` + `Json<serde_json::Value>`，照 merge_ingest_test 的具名路由函数形态），语义不变。

- [ ] **Step 4: fixture 完整实现**（ic_setup / ic_write_source / ic_insert_job / ic_run_ok / ic_run_existing / ic_fetch_page / ic_fetch_item_states）

照 merge_ingest_test 的 t8 模式逐段移植（命名 t10 化、并发度参数化）：

```rust
pub(crate) struct IcEnv {
    pub state: llm_wiki_server::AppState,
    pub pid: i32,
    pub team_id: i32,
    pub stub: RoutingStub,
}

/// 并发度参数化 setup：stub 先 spawn 拿 base → clone state.config 设
/// ingest.source_concurrency → create_app（同库同 Redis，t8_setup_project 同款）
/// → 注册 t10_conc_{uuid} 用户 → LT项目_t10_{uuid} 项目 → team provider 指向
/// 路由 stub 根（providers HTTP API，owner 权限；请求体字段照
/// merge_ingest_test.rs:159-171 的 t8 原样，仅 base_url 换 stub.base）。
pub(crate) async fn ic_setup(routes: Vec<StubRoute>, n: usize) -> IcEnv {
    let stub = spawn_routing_stub(routes).await;
    let (app, state) = crate::setup_test_app().await;
    let mut cfg = (*state.config).clone();
    cfg.ingest.source_concurrency = n;
    let (_app2, state) = llm_wiki_server::create_app(cfg).await.expect("并发度注入 app");
    let server = axum_test::TestServer::new(app).unwrap();
    let n_id = COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let uuid = format!("{}_{}", std::process::id(), n_id);
    let username = format!("t10_conc_{uuid}");
    let token = crate::register_user(&server, &username, &format!("{}@t10.com", username), "password123").await;
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
        .json(&serde_json::json!({"name": format!("LT项目_t10_{uuid}"), "team_id": team_id}))
        .await;
    assert_eq!(resp.status_code(), axum::http::StatusCode::CREATED);
    let pid = resp.json::<serde_json::Value>()["id"].as_i64().unwrap() as i32;
    // team provider → stub 根（t8 同款端点与字段；base_url 指到 stub）
    let resp = server
        .post(&format!("/api/v1/teams/{}/llm-providers", team_id))
        .add_header("authorization", format!("Bearer {}", token))
        .json(&serde_json::json!({
            "provider_type": "openai",
            "base_url": stub.base.clone(),
            // model/api_key 等其余字段照 merge_ingest_test.rs t8 的 JSON 原样补齐
        }))
        .await;
    assert!(resp.status_code().is_success(), "team provider 创建失败: {}", resp.text());
    IcEnv { state, pid, team_id, stub }
}

/// 经 storage 后端写 fixture source（t8_write_source 同款）。
pub(crate) async fn ic_write_source(env: &IcEnv, rel: &str, content: &str) {
    env.state
        .storage
        .write_string(env.team_id, env.pid, rel, content)
        .await
        .expect("storage write_string fixture source");
}

/// INSERT 'running' job 行 + 回读（t8_insert_and_run 前半；text[] bind）。
pub(crate) async fn ic_insert_job(env: &IcEnv, sources: Vec<String>) -> IngestJob {
    let job_id = uuid::Uuid::new_v4();
    sqlx::query(
        "INSERT INTO ingest_jobs (id, project_id, source_paths, status) \
         VALUES ($1, $2, $3, 'running')",
    )
    .bind(job_id)
    .bind(env.pid)
    .bind(&sources)
    .execute(&env.state.db)
    .await
    .expect("insert ingest_jobs 行");
    sqlx::query_as("SELECT * FROM ingest_jobs WHERE id=$1")
        .bind(job_id)
        .fetch_one(&env.state.db)
        .await
        .expect("回读 IngestJob")
}

/// insert + run + 落 succeeded 终态；Err → 落 failed 后 panic（携带全文诊断）。
/// 返回 (job, result)——job 供 item_states 断言。
pub(crate) async fn ic_run_ok(
    env: &IcEnv,
    sources: Vec<String>,
) -> (IngestJob, llm_wiki_server::services::ingest_queue::IngestJobResult) {
    let job = ic_insert_job(env, sources).await;
    match ingest_pipeline::run_ingest_job(&env.state, &job).await {
        Ok(res) => {
            sqlx::query("UPDATE ingest_jobs SET status='succeeded', finished_at=NOW() WHERE id=$1")
                .bind(job.id)
                .execute(&env.state.db)
                .await
                .expect("落 succeeded 终态");
            (job, res)
        }
        Err(e) => {
            sqlx::query(
                "UPDATE ingest_jobs SET status='failed', error=$1, finished_at=NOW() WHERE id=$2",
            )
            .bind(e.to_string())
            .bind(job.id)
            .execute(&env.state.db)
            .await
            .expect("落 failed 终态");
            panic!("run_ingest_job 应返回 Ok: {e}");
        }
    }
}

/// 回读既有 job + run + 落 succeeded（resume 用例复用）。
pub(crate) async fn ic_run_existing(
    env: &IcEnv,
    job_id: uuid::Uuid,
) -> llm_wiki_server::services::ingest_queue::IngestJobResult {
    let job: IngestJob = sqlx::query_as("SELECT * FROM ingest_jobs WHERE id=$1")
        .bind(job_id)
        .fetch_one(&env.state.db)
        .await
        .expect("回读 IngestJob");
    match ingest_pipeline::run_ingest_job(&env.state, &job).await {
        Ok(res) => {
            sqlx::query("UPDATE ingest_jobs SET status='succeeded', finished_at=NOW() WHERE id=$1")
                .bind(job_id)
                .execute(&env.state.db)
                .await
                .expect("落 succeeded 终态");
            res
        }
        Err(e) => {
            sqlx::query(
                "UPDATE ingest_jobs SET status='failed', error=$1, finished_at=NOW() WHERE id=$2",
            )
            .bind(e.to_string())
            .bind(job_id)
            .execute(&env.state.db)
            .await
            .expect("落 failed 终态");
            panic!("resume run 应返回 Ok: {e}");
        }
    }
}

/// 取 DB 页行 (content, sources, updated_at)——t8_fetch_page 简化版。
pub(crate) async fn ic_fetch_page(env: &IcEnv, path: &str) -> (String, serde_json::Value, chrono::DateTime<chrono::Utc>) {
    sqlx::query_as(
        "SELECT content, sources, updated_at FROM wiki_pages WHERE project_id=$1 AND path=$2",
    )
    .bind(env.pid)
    .bind(path)
    .fetch_one(&env.state.db)
    .await
    .expect("页面必须已落库")
}

/// 展开 item_states 为 (path, status, error) 三元组列表。
pub(crate) async fn ic_fetch_item_states(env: &IcEnv, job_id: uuid::Uuid) -> Vec<(String, String, Option<String>)> {
    let v: serde_json::Value = sqlx::query_scalar("SELECT item_states FROM ingest_jobs WHERE id=$1")
        .bind(job_id)
        .fetch_one(&env.state.db)
        .await
        .expect("读 item_states");
    v.as_array()
        .map(|arr| {
            arr.iter()
                .map(|e| {
                    (
                        e["path"].as_str().unwrap_or_default().to_string(),
                        e["status"].as_str().unwrap_or_default().to_string(),
                        e["error"].as_str().map(String::from),
                    )
                })
                .collect()
        })
        .unwrap_or_default()
}
```

**实现提示**：`ic_setup` 里 team provider 的 JSON 若字段名对不上（t8 用了 model/api_key 等字段），以 merge_ingest_test.rs:159-171 实际请求体为准补齐——不要凭记忆造字段名。

- [ ] **Step 5: 用例 1——并发正确性（3 源 N=2 乱序）**

```rust
/// spec 测 1：3 源 N=2，stub 延迟乱序（za 慢 400ms、zb/zc 快 30ms）→ 全部落库、
/// item_states 全 done、页面内容正确。
#[tokio::test]
#[ignore = "requires PG + Redis"]
async fn concurrent_sources_all_land_in_order() {
    let s1 = r#"{"entities":[{"name":"EA"}],"connections":[],"contradictions":[]}"#;
    let s2 = |slug: &str| format!(
        "---FILE: concepts/{slug}.md ---\n---\ntitle: {slug}\ntype: concept\nsources: [raw/{slug}.md]\n---\n# {slug}\n{slug} body MARK{slug}.\n---END FILE---"
    );
    let routes = vec![
        // za：step1 快、step2 慢（制造乱序完成）
        StubRoute { all: vec!["MARKza", "<document>"], delay_ms: 30, resp: RouteResp::Text(s1.into()) },
        StubRoute { all: vec!["MARKza", "<analysis>"], delay_ms: 400, resp: RouteResp::Text(s2("za")) },
        StubRoute { all: vec!["MARKzb", "<document>"], delay_ms: 30, resp: RouteResp::Text(s1.into()) },
        StubRoute { all: vec!["MARKzb", "<analysis>"], delay_ms: 30, resp: RouteResp::Text(s2("zb")) },
        StubRoute { all: vec!["MARKzc", "<document>"], delay_ms: 30, resp: RouteResp::Text(s1.into()) },
        StubRoute { all: vec!["MARKzc", "<analysis>"], delay_ms: 30, resp: RouteResp::Text(s2("zc")) },
    ];
    let env = ic_setup(routes, 2).await;
    ic_write_source(&env, "raw/za.md", "za content MARKza za body text").await;
    ic_write_source(&env, "raw/zb.md", "zb content MARKzb zb body text").await;
    ic_write_source(&env, "raw/zc.md", "zc content MARKzc zc body text").await;
    let (job, res) = ic_run_ok(&env, vec!["raw/za.md".into(), "raw/zb.md".into(), "raw/zc.md".into()]).await;
    assert_eq!(res.new_pages.len(), 3, "三源各一页：{:?}", res.new_pages);
    let (content, _, _) = ic_fetch_page(&env, "concepts/za.md").await;
    assert!(content.contains("MARKza"));
    let states = ic_fetch_item_states(&env, job.id).await;
    assert_eq!(states.len(), 3);
    assert!(states.iter().all(|(_, s, _)| s == "done"), "{:?}", states);
}
```

（`ic_fetch_page` 照 t8_fetch_page 移植。）**review 第三调在本 fixture 下根本不触发**（评审 M-9：`should_run_dedicated_review_stage` 对 <4 块且 <10000 字符的 step2 输出直接跳过）——无需为 review 调用配路由；若未来 fixture 变大触发第三调，未命中路由的 500 也只是 tolerated warn（run_dedicated_review_stage Err 仅 warn），不阻断断言。

- [ ] **Step 6: 跑用例 1**

Run: `cd src-server && cargo test --test integration -- --ignored concurrent_sources_all_land --test-threads=1`
Expected: PASS（若 FAIL 先核对 stub 路由命中：`no route` 500 会在 warnings 里暴露——`ic_run_ok` 的 Err panic 全文可诊断）

- [ ] **Step 7: 用例 2——确定性归并（后源先完成，merge 仍源序）**

```rust
/// spec 测 2：za/zb 各生成 concepts/shared.md（跨源碰撞 Merge），stub 让 zb 的
/// step2 先完成（za 慢 400ms）→ merge 调用时 existing 必是 za 版（源序归并）。
/// stub 的 merge 路由记录调用序，merged 输出埋 marker 供二次 merge 区分。
#[tokio::test]
#[ignore = "requires PG + Redis"]
async fn merge_order_is_source_order_despite_reversed_completion() {
    let s1 = r#"{"entities":[{"name":"E"}],"connections":[],"contradictions":[]}"#;
    let page = |slug: &str| format!(
        "---FILE: concepts/shared.md ---\n---\ntitle: Shared\ntype: concept\nsources: [raw/{slug}.md]\n---\n# Shared\n{slug} version.\n---END FILE---"
    );
    let routes = vec![
        StubRoute { all: vec!["MARKza", "<document>"], delay_ms: 30, resp: RouteResp::Text(s1.into()) },
        StubRoute { all: vec!["MARKza", "<analysis>"], delay_ms: 400, resp: RouteResp::Text(page("za")) },
        StubRoute { all: vec!["MARKzb", "<document>"], delay_ms: 30, resp: RouteResp::Text(s1.into()) },
        StubRoute { all: vec!["MARKzb", "<analysis>"], delay_ms: 30, resp: RouteResp::Text(page("zb")) },
        // merge：existing=za 版时出 ZA_FIRST，existing=zb 版（顺序错乱才会出现）出 WRONG
        StubRoute { all: vec!["za version", "<existing>"], delay_ms: 30, resp: RouteResp::Text("merged: ZA_FIRST".into()) },
        StubRoute { all: vec!["zb version", "<existing>"], delay_ms: 30, resp: RouteResp::Text("merged: WRONG_ORDER".into()) },
    ];
    let env = ic_setup(routes, 2).await;
    ic_write_source(&env, "raw/za.md", "za content MARKza").await;
    ic_write_source(&env, "raw/zb.md", "zb content MARKzb").await;
    let (job, res) = ic_run_ok(&env, vec!["raw/za.md".into(), "raw/zb.md".into()]).await;
    assert_eq!(res.merged_pages, vec!["concepts/shared.md".to_string()]);
    let (content, sources, _) = ic_fetch_page(&env, "concepts/shared.md").await;
    assert!(content.contains("ZA_FIRST"), "merge 的 existing 必须是 za 版（源序）：{}", content);
    assert!(sources.to_string().contains("raw/za.md") && sources.to_string().contains("raw/zb.md"));
}
```

- [ ] **Step 8: 跑用例 2**

Run: `cd src-server && cargo test --test integration -- --ignored merge_order_is_source --test-threads=1`
Expected: PASS

- [ ] **Step 9: 用例 3——N=1 等价性（结构回归保险）**

```rust
/// spec 测 6：N=1 时 buffered(1)+channel ≈ 今日串行——同用例 1 场景在 n=1 下
/// 结果一致（全落库 + 全 done）。
#[tokio::test]
#[ignore = "requires PG + Redis"]
async fn n1_equivalence_lands_all() {
    let s1 = r#"{"entities":[],"connections":[],"contradictions":[]}"#;
    let s2 = |slug: &str| format!(
        "---FILE: concepts/{slug}.md ---\n---\ntitle: {slug}\ntype: concept\nsources: [raw/{slug}.md]\n---\n# {slug}\n{slug} body.\n---END FILE---"
    );
    let mk = |m: &str| vec![
        StubRoute { all: vec![m, "<document>"], delay_ms: 10, resp: RouteResp::Text(s1.into()) },
        StubRoute { all: vec![m, "<analysis>"], delay_ms: 10, resp: RouteResp::Text(s2(m.trim_start_matches("MARK"))) },
    ];
    let mut routes = vec![];
    routes.extend(mk("MARKza")); routes.extend(mk("MARKzb"));
    let env = ic_setup(routes, 1).await;
    ic_write_source(&env, "raw/za.md", "a MARKza").await;
    ic_write_source(&env, "raw/zb.md", "b MARKzb").await;
    let (_job, res) = ic_run_ok(&env, vec!["raw/za.md".into(), "raw/zb.md".into()]).await;
    assert_eq!(res.new_pages.len(), 2);
}
```

- [ ] **Step 10: 跑用例 3 + 本任务全部**

Run: `cd src-server && cargo test --test integration -- --ignored ingest_concurrency --test-threads=1`
Expected: 3 用例全 PASS

- [ ] **Step 11: Commit**

```bash
git branch --show-current
git add src-server/tests/integration/ingest_concurrency_test.rs src-server/tests/integration/mod.rs
git commit -m "test(ingest): 路由 stub 基建 + 并发正确性/确定性归并/N=1 等价三用例（spec 测 1/2/6）"
```

---

### Task 6: 取消 drain 三用例（drain 落库 / 积压交织 / cancel→resume）

**Files:**
- Modify: `src-server/tests/integration/ingest_concurrency_test.rs`（追加三用例 + `ic_spawn_run` helper）

**Interfaces:**
- Consumes: Task 5 全部 fixture；`ingest_queue::request_cancel`（PG 直写等价：测试内直接 UPDATE cancel_requested=TRUE 也行——用 UPDATE，免依赖函数语义）
- Produces: `ic_spawn_run(env, sources) -> (JoinHandle<Result<IngestJobResult, AppError>>, IngestJob)`——INSERT 后 spawn run_ingest_job（不落终态；cancel 用例自行断言 status）

- [ ] **Step 1: 用例 4——取消 drain（在飞 cohort 完整落库 + 无新 LLM + 单事件）**

```rust
/// spec 测 3：N=2、za/zb 两源 step2 均慢（500ms 窗口），两源均已开始（started==2）
/// 后置 cancel → Err(Cancelled)；za/zb 页面全部落库 + item_states 全 done（drain）；
/// zc 零 LLM 调用（① 关口）；status=cancelled；job_cancelled 事件恰一条（经
/// broadcast 无接收者不落库——以 mark 的 DB 效果 + 单次性靠代码结构保证，此处
/// 断言 DB 终态即可）。
#[tokio::test]
#[ignore = "requires PG + Redis"]
async fn cancel_drains_inflight_cohort_and_stops_new() {
    let s1 = r#"{"entities":[],"connections":[],"contradictions":[]}"#;
    let s2 = |slug: &str| format!(
        "---FILE: concepts/{slug}.md ---\n---\ntitle: {slug}\ntype: concept\nsources: [raw/{slug}.md]\n---\n# {slug}\n{slug} body.\n---END FILE---"
    );
    let routes = vec![
        StubRoute { all: vec!["MARKza", "<document>"], delay_ms: 10, resp: RouteResp::Text(s1.into()) },
        StubRoute { all: vec!["MARKza", "<analysis>"], delay_ms: 500, resp: RouteResp::Text(s2("za")) },
        StubRoute { all: vec!["MARKzb", "<document>"], delay_ms: 10, resp: RouteResp::Text(s1.into()) },
        StubRoute { all: vec!["MARKzb", "<analysis>"], delay_ms: 500, resp: RouteResp::Text(s2("zb")) },
        // zc 的任何生成调用若发生都会命中（延迟 0）；断言其零调用
        StubRoute { all: vec!["MARKzc"], delay_ms: 0, resp: RouteResp::Text("must-not-be-called".into()) },
    ];
    let env = ic_setup(routes, 2).await;
    ic_write_source(&env, "raw/za.md", "a MARKza").await;
    ic_write_source(&env, "raw/zb.md", "b MARKzb").await;
    ic_write_source(&env, "raw/zc.md", "c MARKzc").await;
    let (handle, job) = ic_spawn_run(&env, vec!["raw/za.md".into(), "raw/zb.md".into(), "raw/zc.md".into()]).await;

    // 等 za/zb 的 step2 都已开始（① 已过 → 必然 drain 落库）
    wait_started(&env, "MARKza+<analysis>", 1).await;
    wait_started(&env, "MARKzb+<analysis>", 1).await;

    sqlx::query("UPDATE ingest_jobs SET cancel_requested=TRUE WHERE id=$1")
        .bind(job.id)
        .execute(&env.state.db)
        .await
        .unwrap();

    let out = handle.await.unwrap();
    assert!(matches!(out, Err(llm_wiki_server::AppError::Cancelled)), "{:?}", out.map(|_| ()));
    let status: String = sqlx::query_scalar("SELECT status FROM ingest_jobs WHERE id=$1")
        .bind(job.id).fetch_one(&env.state.db).await.unwrap();
    assert_eq!(status, "cancelled");
    // drain：za/zb 落库 + done；zc 不在 item_states（未开始即被①拦下）
    let (_, _, _) = ic_fetch_page(&env, "concepts/za.md").await;
    let (_, _, _) = ic_fetch_page(&env, "concepts/zb.md").await;
    let states = ic_fetch_item_states(&env, job.id).await;
    assert!(states.iter().all(|(p, s, _)| s == "done"), "{:?}", states);
    assert_eq!(states.len(), 2, "zc 不应出现：{:?}", states);
    // zc 零 LLM 调用（生成段①关口）
    assert_eq!(env.stub.started.lock().unwrap().get("MARKzc"), None, "cancel 后不得领新任务");
}
```

`wait_started`（轮询 started 计数，10ms 间隔、上限 5s）：

```rust
async fn wait_started(env: &IcEnv, marker: &str, want: usize) {
    for _ in 0..500 {
        let cur = *env.stub.started.lock().unwrap().get(marker).unwrap_or(&0);
        if cur >= want { return; }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("等待 stub marker {} 达 {} 超时", marker, want);
}
```

`ic_spawn_run`（INSERT 'running' + spawn，返回 handle 与 IngestJob——Cancel 场景终态由 pipeline 的 mark 落，无需 t8 式人工终态）：

```rust
pub(crate) async fn ic_spawn_run(
    env: &IcEnv,
    sources: Vec<String>,
) -> (tokio::task::JoinHandle<Result<llm_wiki_server::services::ingest_queue::IngestJobResult, llm_wiki_server::AppError>>, IngestJob) {
    let job = ic_insert_job(env, sources).await;
    let state = env.state.clone();
    let job_clone = job.clone();
    let handle = tokio::spawn(async move {
        ingest_pipeline::run_ingest_job(&state, &job_clone).await
    });
    (handle, job)
}
```

- [ ] **Step 2: 跑用例 4**

Run: `cd src-server && cargo test --test integration -- --ignored cancel_drains --test-threads=1`
Expected: PASS

- [ ] **Step 3: 用例 5——cancel × channel 积压交织（spec 测 8）**

```rust
/// spec 测 8：归并段被 merge 拖慢制造 channel 积压 + cancel → 积压 cohort 全落库、
/// 变体后零新 LLM 调用。N=2：za/zb 碰撞 shared.md 且 merge 慢 600ms；两源生成
/// 完成进积压（started/calls 都齐）后 cancel。
#[tokio::test]
#[ignore = "requires PG + Redis"]
async fn cancel_with_backlog_drains_buffered_items() {
    let s1 = r#"{"entities":[],"connections":[],"contradictions":[]}"#;
    let page = |slug: &str| format!(
        "---FILE: concepts/shared.md ---\n---\ntitle: Shared\ntype: concept\nsources: [raw/{slug}.md]\n---\n# Shared\n{slug} version.\n---END FILE---"
    );
    let routes = vec![
        StubRoute { all: vec!["MARKza", "<document>"], delay_ms: 10, resp: RouteResp::Text(s1.into()) },
        StubRoute { all: vec!["MARKza", "<analysis>"], delay_ms: 50, resp: RouteResp::Text(page("za")) },
        StubRoute { all: vec!["MARKzb", "<document>"], delay_ms: 10, resp: RouteResp::Text(s1.into()) },
        StubRoute { all: vec!["MARKzb", "<analysis>"], delay_ms: 50, resp: RouteResp::Text(page("zb")) },
        StubRoute { all: vec!["za version", "<existing>"], delay_ms: 600, resp: RouteResp::Text("merged backlog".into()) },
        StubRoute { all: vec!["MARKzz", "<document>"], delay_ms: 0, resp: RouteResp::Text("must-not".into()) },
    ];
    let env = ic_setup(routes, 2).await;
    ic_write_source(&env, "raw/za.md", "a MARKza").await;
    ic_write_source(&env, "raw/zb.md", "b MARKzb").await;
    ic_write_source(&env, "raw/zz.md", "z MARKzz").await;
    let (handle, job) = ic_spawn_run(&env, vec!["raw/za.md".into(), "raw/zb.md".into(), "raw/zz.md".into()]).await;
    // 等 za/zb 生成完成（calls 记录齐）→ 必有一源进 merge（600ms 窗口）→ 置 cancel
    wait_calls(&env, "MARKza+<analysis>", 1).await;
    wait_calls(&env, "MARKzb+<analysis>", 1).await;
    sqlx::query("UPDATE ingest_jobs SET cancel_requested=TRUE WHERE id=$1")
        .bind(job.id).execute(&env.state.db).await.unwrap();
    let out = handle.await.unwrap();
    // 两条终止路径（见下竞态论证）都以 Err(Cancelled) 收尾：变体路径（归并段收
    // Cancelled 变体）/ 尾段兜底路径（zz 被领走走完 → 无变体 → 尾段 check_cancel）
    assert!(matches!(out, Err(llm_wiki_server::AppError::Cancelled)));
    let status: String = sqlx::query_scalar("SELECT status FROM ingest_jobs WHERE id=$1")
        .bind(job.id).fetch_one(&env.state.db).await.unwrap();
    assert_eq!(status, "cancelled");
    // drain：积压的 zb 页经 merge 落库（za 先 upsert、zb 碰撞 merge）
    let (content, _, _) = ic_fetch_page(&env, "concepts/shared.md").await;
    assert!(content.contains("backlog"), "积压 cohort 的 merge 必须完成：{}", content);
    // 竞态实况（评审 I-2）：za 完成瞬间 buffered eager refill zz，其 ① peek 的
    // SELECT 快照大概率早于测试 UPDATE 提交 → 多数运行 zz 被领走：step1 返回
    // "must-not"（非 JSON）→ 两轮解析失败 → Failed 非 done，此路径无 Cancelled
    // 变体、终态经尾段兜底。少数运行 cancel 先落 → zz 未领走、item_states 无 zz。
    // 断言按两分支兼容写：len ∈ 2..=3；za/zb 必 done；zz 若在必 failed；
    // zz 的 step2 永不发生（step1 必败）；step1 解析失败重试一次 → ≤2 次。
    let states = ic_fetch_item_states(&env, job.id).await;
    assert!((2..=3).contains(&states.len()), "{:?}", states);
    for (p, s, _) in &states {
        if p == "raw/za.md" || p == "raw/zb.md" {
            assert_eq!(s, "done", "{:?}", states);
        } else {
            assert_eq!((p.as_str(), s.as_str()), ("raw/zz.md", "failed"), "{:?}", states);
        }
    }
    let calls = env.stub.calls.lock().unwrap().clone();
    let zz_step2 = calls.iter().filter(|c| c.contains("MARKzz") && c.contains("<analysis>")).count();
    let zz_step1 = calls.iter().filter(|c| c.contains("MARKzz") && c.contains("<document>")).count();
    assert_eq!(zz_step2, 0, "zz step1 必败（非 JSON），step2 永不发生");
    assert!(zz_step1 <= 2, "step1 解析失败重试一次 → 至多 2 次，got {}", zz_step1);
}
```

（`wait_calls` 与 `wait_started` 同款，查 calls 计数。）

- [ ] **Step 4: 跑用例 5**

Run: `cd src-server && cargo test --test integration -- --ignored cancel_with_backlog --test-threads=1`
Expected: PASS

- [ ] **Step 5: 用例 6——cancel → manual retry 语义 → resume（spec 测 9）**

```rust
/// spec 测 9：drain 落库的源在 retry 后不重烧（step1 缓存命中 + step2 零调用）。
/// 第一轮：za 完整 done 后 cancel（za step2 慢，等 started 后 cancel → drain）。
/// 第二轮：模拟 manual_retry（直 UPDATE status='pending', cancel_requested=FALSE，
/// 保 item_states）+ 重跑 → za 零 LLM 调用（缓存 + resume 双保险）、zc 正常跑。
#[tokio::test]
#[ignore = "requires PG + Redis"]
async fn cancelled_job_resume_skips_drained_sources() {
    let s1 = r#"{"entities":[],"connections":[],"contradictions":[]}"#;
    let s2 = |slug: &str| format!(
        "---FILE: concepts/{slug}.md ---\n---\ntitle: {slug}\ntype: concept\nsources: [raw/{slug}.md]\n---\n# {slug}\n{slug} body.\n---END FILE---"
    );
    let routes = vec![
        StubRoute { all: vec!["MARKza", "<document>"], delay_ms: 10, resp: RouteResp::Text(s1.into()) },
        StubRoute { all: vec!["MARKza", "<analysis>"], delay_ms: 400, resp: RouteResp::Text(s2("za")) },
        StubRoute { all: vec!["MARKzc", "<document>"], delay_ms: 10, resp: RouteResp::Text(s1.into()) },
        StubRoute { all: vec!["MARKzc", "<analysis>"], delay_ms: 10, resp: RouteResp::Text(s2("zc")) },
    ];
    let env = ic_setup(routes, 1).await;
    ic_write_source(&env, "raw/za.md", "a MARKza").await;
    ic_write_source(&env, "raw/zc.md", "c MARKzc").await;
    let (handle, job) = ic_spawn_run(&env, vec!["raw/za.md".into(), "raw/zc.md".into()]).await;
    wait_started(&env, "MARKza+<analysis>", 1).await; // N=1：za 在飞、zc 未领
    sqlx::query("UPDATE ingest_jobs SET cancel_requested=TRUE WHERE id=$1")
        .bind(job.id).execute(&env.state.db).await.unwrap();
    assert!(matches!(handle.await.unwrap(), Err(llm_wiki_server::AppError::Cancelled)));
    let za_step1_calls_before = env.stub.calls.lock().unwrap().iter()
        .filter(|c| c.contains("MARKza") && c.contains("<document>")).count();

    // 模拟 manual_retry（不调 manual_retry()——它 LPUSH 测试 redis 虽无害但引入
    // 不必要耦合；直 UPDATE 同列语义）
    sqlx::query("UPDATE ingest_jobs SET status='pending', cancel_requested=FALSE, progress=0, stage=NULL WHERE id=$1")
        .bind(job.id).execute(&env.state.db).await.unwrap();
    let res = ic_run_existing(&env, job.id).await; // 回读 job + run + 落 succeeded
    assert_eq!(res.new_pages.len(), 1, "只 zc 新页（za 已存在且 hash 命中跳过）");
    // za 零重烧：step1 调用数不变（缓存命中）、step2 调用数不变（resume 跳过）
    let calls = env.stub.calls.lock().unwrap().clone();
    let za_step1_after = calls.iter().filter(|c| c.contains("MARKza") && c.contains("<document>")).count();
    let za_step2_after = calls.iter().filter(|c| c.contains("MARKza") && c.contains("<analysis>")).count();
    assert_eq!(za_step1_after, za_step1_calls_before, "resume 不重跑 step1（缓存命中）");
    assert_eq!(za_step2_after, 1, "step2 只第一轮一次");
}
```

（`ic_run_existing(env, job_id)` = 回读 IngestJob + run_ingest_job + 落 succeeded，照 `ic_run_ok` 抽公共。）**注意**：za resume 路径走的是 `item_states done 过滤`（dispatch 层）——即使 redis 缓存 TTL 失效也零调用；两道保险都在。

- [ ] **Step 6: 跑用例 6 + 本任务全部**

Run: `cd src-server && cargo test --test integration -- --ignored ingest_concurrency --test-threads=1`
Expected: 6 用例全 PASS

- [ ] **Step 7: Commit**

```bash
git branch --show-current
git add src-server/tests/integration/ingest_concurrency_test.rs
git commit -m "test(ingest): 取消 drain 三用例——在飞 cohort 落库/积压交织/resume 零重烧（spec 测 3/8/9）"
```

---

### Task 7: resume + 失败隔离 + 进度三用例

**Files:**
- Modify: `src-server/tests/integration/ingest_concurrency_test.rs`（追加三用例）

**Interfaces:**
- Consumes: Task 5/6 fixture 全套

- [ ] **Step 1: 用例 7——resume 只处理剩余（spec 测 4）**

```rust
/// spec 测 4：item_states 预置 za done → 只处理 zb（za 零调用，精确断言）。
#[tokio::test]
#[ignore = "requires PG + Redis"]
async fn resume_processes_only_remaining_sources() {
    let s1 = r#"{"entities":[],"connections":[],"contradictions":[]}"#;
    let s2 = |slug: &str| format!(
        "---FILE: concepts/{slug}.md ---\n---\ntitle: {slug}\ntype: concept\nsources: [raw/{slug}.md]\n---\n# {slug}\n{slug} body.\n---END FILE---"
    );
    let routes = vec![
        StubRoute { all: vec!["MARKza", "<document>"], delay_ms: 0, resp: RouteResp::Text("must-not".into()) },
        StubRoute { all: vec!["MARKza", "<analysis>"], delay_ms: 0, resp: RouteResp::Text("must-not".into()) },
        StubRoute { all: vec!["MARKzb", "<document>"], delay_ms: 10, resp: RouteResp::Text(s1.into()) },
        StubRoute { all: vec!["MARKzb", "<analysis>"], delay_ms: 10, resp: RouteResp::Text(s2("zb")) },
    ];
    let env = ic_setup(routes, 2).await;
    ic_write_source(&env, "raw/za.md", "a MARKza").await;
    ic_write_source(&env, "raw/zb.md", "b MARKzb").await;
    // 预置 za done
    let job = ic_insert_job(&env, vec!["raw/za.md".into(), "raw/zb.md".into()]).await;
    sqlx::query("UPDATE ingest_jobs SET item_states=$2 WHERE id=$1")
        .bind(job.id)
        .bind(serde_json::json!([{"path": "raw/za.md", "status": "done", "error": null}]))
        .execute(&env.state.db).await.unwrap();
    let _ = llm_wiki_server::services::ingest_pipeline::run_ingest_job(&env.state, &job).await.unwrap();
    let calls = env.stub.calls.lock().unwrap().clone();
    assert!(calls.iter().all(|c| !c.contains("MARKza")), "za 不得有任何调用：{:?}", calls);
    assert!(calls.iter().any(|c| c.contains("MARKzb") && c.contains("<analysis>")));
}
```

- [ ] **Step 2: 用例 8——单源失败隔离（spec 测 5）**

```rust
/// spec 测 5：zb 的 step1 返 500 → zb failed、za done、job succeeded_with_warnings
/// 路径（直调 run_ingest_job 返 Ok + warnings 含 zb）。
#[tokio::test]
#[ignore = "requires PG + Redis"]
async fn single_source_failure_isolated() {
    let s1 = r#"{"entities":[],"connections":[],"contradictions":[]}"#;
    let s2 = "---FILE: concepts/za.md ---\n---\ntitle: za\ntype: concept\nsources: [raw/za.md]\n---\n# za\nza body.\n---END FILE---".to_string();
    let routes = vec![
        StubRoute { all: vec!["MARKza", "<document>"], delay_ms: 10, resp: RouteResp::Text(s1.into()) },
        StubRoute { all: vec!["MARKza", "<analysis>"], delay_ms: 10, resp: RouteResp::Text(s2) },
        StubRoute { all: vec!["MARKzb", "<document>"], delay_ms: 10, resp: RouteResp::Error(500) },
    ];
    let env = ic_setup(routes, 2).await;
    ic_write_source(&env, "raw/za.md", "a MARKza").await;
    ic_write_source(&env, "raw/zb.md", "b MARKzb").await;
    let job = ic_insert_job(&env, vec!["raw/za.md".into(), "raw/zb.md".into()]).await;
    let res = llm_wiki_server::services::ingest_pipeline::run_ingest_job(&env.state, &job)
        .await
        .expect("部分失败仍是 Ok（warnings 承载）");
    assert!(res.warnings.iter().any(|w| w.contains("raw/zb.md")), "{:?}", res.warnings);
    assert_eq!(res.new_pages.len(), 1);
    let states = ic_fetch_item_states(&env, job.id).await;
    assert_eq!(
        states.iter().map(|(p, s, _)| (p.clone(), s.clone())).collect::<Vec<_>>(),
        vec![("raw/za.md".to_string(), "done".to_string()), ("raw/zb.md".to_string(), "failed".to_string())]
    );
}
```

（**item_states 顺序**：归并段按源序处理 → za 先于 zb；若断言脆可改排序后比较。）

- [ ] **Step 3: 用例 9——散布 resume + 进度序列（spec 测 10）**

```rust
/// spec 测 10：za done 预置 + 3 源跑完 → progress=100、stage 不含 parsing/generating
/// 残留（终态表示法）+ 中途 progress 值（1 done 预置 → 首个 stage 写 = 33）。
#[tokio::test]
#[ignore = "requires PG + Redis"]
async fn progress_monotonic_with_prior_done_and_final_stage() {
    let s1 = r#"{"entities":[],"connections":[],"contradictions":[]}"#;
    let s2 = |slug: &str| format!(
        "---FILE: concepts/{slug}.md ---\n---\ntitle: {slug}\ntype: concept\nsources: [raw/{slug}.md]\n---\n# {slug}\n{slug} body.\n---END FILE---"
    );
    let mk = |m: &str, slug: &str| vec![
        StubRoute { all: vec![m, "<document>"], delay_ms: 10, resp: RouteResp::Text(s1.into()) },
        StubRoute { all: vec![m, "<analysis>"], delay_ms: 10, resp: RouteResp::Text(s2(slug)) },
    ];
    let mut routes = vec![];
    routes.extend(mk("MARKzb", "zb")); routes.extend(mk("MARKzc", "zc"));
    let env = ic_setup(routes, 2).await;
    for (rel, c) in [("raw/za.md", "a MARKza"), ("raw/zb.md", "b MARKzb"), ("raw/zc.md", "c MARKzc")] {
        ic_write_source(&env, rel, c).await;
    }
    let job = ic_insert_job(&env, vec!["raw/za.md".into(), "raw/zb.md".into(), "raw/zc.md".into()]).await;
    sqlx::query("UPDATE ingest_jobs SET item_states=$2 WHERE id=$1")
        .bind(job.id)
        .bind(serde_json::json!([{"path": "raw/za.md", "status": "done", "error": null}]))
        .execute(&env.state.db).await.unwrap();
    let _ = llm_wiki_server::services::ingest_pipeline::run_ingest_job(&env.state, &job).await.unwrap();
    let (progress, stage): (i32, Option<String>) =
        sqlx::query_as("SELECT progress, stage FROM ingest_jobs WHERE id=$1")
            .bind(job.id).fetch_one(&env.state.db).await.unwrap();
    assert_eq!(progress, 100);
    assert_ne!(stage.as_deref(), Some("parsing"));
    assert_ne!(stage.as_deref(), Some("generating"));
}
```

- [ ] **Step 4: 跑三用例**

Run: `cd src-server && cargo test --test integration -- --ignored ingest_concurrency --test-threads=1`
Expected: 9 用例全 PASS

- [ ] **Step 5: Commit**

```bash
git branch --show-current
git add src-server/tests/integration/ingest_concurrency_test.rs
git commit -m "test(ingest): resume 只处理剩余/单源失败隔离/进度终态三用例（spec 测 4/5/10）"
```

---

### Task 8: 429 all-failed 瞬态 + clamp 边界

**Files:**
- Modify: `src-server/tests/integration/ingest_concurrency_test.rs`（追加两用例；clamp 边界已由 Task 1 单测覆盖——本任务集成半验证 env 注入链）

**Interfaces:**
- Consumes: Task 2 的 transient 分类；Task 5 fixture

- [ ] **Step 1: 用例 10——all-failed 429 → transient（spec 测 14）**

```rust
/// spec 测 14：单源 step1 全 429 → all-failed → Err 为瞬态（retry 候选）。
/// 断言 is_transient_job_err（worker 侧判定函数）对实际 Err 判真 + 消息含
/// "Rate limited"（round2 更正的 Display 链）。
#[tokio::test]
#[ignore = "requires PG + Redis"]
async fn all_failed_rate_limited_is_transient() {
    let routes = vec![
        StubRoute { all: vec!["MARKzq", "<document>"], delay_ms: 10, resp: RouteResp::Error(429) },
    ];
    let env = ic_setup(routes, 2).await;
    ic_write_source(&env, "raw/zq.md", "q MARKzq").await;
    let job = ic_insert_job(&env, vec!["raw/zq.md".into()]).await;
    let err = llm_wiki_server::services::ingest_pipeline::run_ingest_job(&env.state, &job)
        .await
        .expect_err("all failed 必须 Err");
    assert!(
        llm_wiki_server::services::ingest_queue::is_transient_job_err(&err),
        "429 all-failed 应判瞬态：{:?}",
        err.to_string()
    );
    assert!(err.to_string().to_lowercase().contains("rate limit"), "{}", err.to_string());
}
```

- [ ] **Step 2: 用例 11——env 注入链（spec 测 11 集成半）**

```rust
/// spec 测 11 集成半：ic_setup 的 config 注入链冒烟——n=1 与 n=8 都能正常跑通
/// （clamp 单测已钉边界；这里只证注入生效不炸）。
#[tokio::test]
#[ignore = "requires PG + Redis"]
async fn concurrency_config_injection_smoke() {
    let s1 = r#"{"entities":[],"connections":[],"contradictions":[]}"#;
    let s2 = "---FILE: concepts/zs.md ---\n---\ntitle: zs\ntype: concept\nsources: [raw/zs.md]\n---\n# zs\nzs body.\n---END FILE---".to_string();
    let routes = vec![
        StubRoute { all: vec!["MARKzs", "<document>"], delay_ms: 5, resp: RouteResp::Text(s1.into()) },
        StubRoute { all: vec!["MARKzs", "<analysis>"], delay_ms: 5, resp: RouteResp::Text(s2) },
    ];
    for n in [1usize, 8] {
        let env = ic_setup(routes.clone(), n).await;
        ic_write_source(&env, "raw/zs.md", "s MARKzs").await;
        let (_job, res) = ic_run_ok(&env, vec!["raw/zs.md".into()]).await;
        assert_eq!(res.new_pages, vec!["concepts/zs.md".to_string()]);
    }
}
```

（`StubRoute` 与 `RouteResp` 的 `#[derive(Clone)]` 已在 Task 5 定义处带好——本用例 `routes.clone()` 循环复用直接可用。）

- [ ] **Step 3: 跑两用例**

Run: `cd src-server && cargo test --test integration -- --ignored ingest_concurrency --test-threads=1`
Expected: 11 用例全 PASS

- [ ] **Step 4: Commit**

```bash
git branch --show-current
git add src-server/tests/integration/ingest_concurrency_test.rs
git commit -m "test(ingest): 429 all-failed 瞬态 + 并发度注入冒烟（spec 测 14/11 集成半）"
```

---

### Task 9: web 面板 stage 中文映射

**Files:**
- Modify: `src/components/web/web-ingest-panel.tsx`（stage → 中文标签映射）
- Test: `src/components/web/web-ingest-panel.test.tsx`（既有 mock 兼容 + 新增映射断言）

**Interfaces:**
- Consumes: server 新 stage 枚举 `processing` / `building_index`（Task 4 产出）；旧 `parsing` / `generating` 保留映射（在飞旧 job 兼容）
- Produces: 面板轮询文案 `处理中… 处理中`（processing）等中文映射；未知 stage 裸透传

- [ ] **Step 1: 写失败测试**（web-ingest-panel.test.tsx 追加一个用例）

```tsx
  it("stage 中文映射：processing → 处理中（新枚举）且未知 stage 裸透传", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    uploadFile.mockImplementation(async (_pid: number, file: File) => ({
      name: file.name,
      path: `raw/sources/${file.name}`,
      size: file.size,
    }))
    triggerIngest.mockResolvedValue({ job_id: "job-3", status: "pending" })
    getIngestJob
      .mockResolvedValueOnce({ id: "job-3", status: "running", progress: 10, stage: "processing" })
      .mockResolvedValueOnce({ id: "job-3", status: "succeeded", progress: 100, stage: "succeeded" })

    const { WebIngestPanel } = await import("./web-ingest-panel")
    render(<WebIngestPanel projectId={1} onDone={() => {}} />)
    fireEvent.change(screen.getByLabelText(/upload/i), {
      target: { files: [new File(["x"], "d.md")] },
    })
    fireEvent.click(screen.getByRole("button", { name: /ingest|摄取/i }))

    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(2000)
    await waitFor(() => expect(screen.getByText(/处理中… 处理中/)).toBeTruthy())
    await vi.advanceTimersByTimeAsync(2000)
    await waitFor(() => expect(screen.getByText(/完成/)).toBeTruthy())
  })
```

- [ ] **Step 2: 跑测确认失败**

Run: `npx vitest run src/components/web/web-ingest-panel.test.tsx`
Expected: 新用例 FAIL（显示 `处理中… processing`）

- [ ] **Step 3: 实现**——web-ingest-panel.tsx `POLL_MAX` 常量后加映射 + 轮询行替换：

```tsx
// server ingest stage → 中文标签（spec 2026-08-29 §2 表示法变更）。旧枚举
// parsing/generating 保留映射（部署切换期在飞旧 job 兼容）；未知值裸透传。
const STAGE_LABELS: Record<string, string> = {
  processing: "处理中",
  building_index: "构建索引",
  parsing: "解析中",
  generating: "生成中",
}
const stageLabel = (stage?: string | null) =>
  (stage && STAGE_LABELS[stage]) || stage
```

轮询行改为：

```tsx
        setStatus(`处理中… ${stageLabel(job.stage) ?? job.status}`)
```

- [ ] **Step 4: 跑面板全部测试**

Run: `npx vitest run src/components/web/web-ingest-panel.test.tsx`
Expected: 4 用例全 PASS（既有 3 用例不断言 stage 文案，零回归）

- [ ] **Step 5: Commit**

```bash
git branch --show-current
git add src/components/web/web-ingest-panel.tsx src/components/web/web-ingest-panel.test.tsx
git commit -m "feat(web): 摄取面板 stage 中文映射（processing/building_index 新枚举 + 旧枚举兼容，spec §2）"
```

---

### Task 10: 全量回归 + spec 勾稽

**Files:**
- 无新改动（只跑全量 + 核对清单；发现回归回到对应任务修）

- [ ] **Step 1: Rust 全量**

Run: `cd src-server && cargo test --lib && cargo test --test integration -- --ignored`
Expected: lib 全绿 + integration 全绿（含 ingest 四件套 + ingest_concurrency 11 用例 + 其余既有套件零回归）

- [ ] **Step 1b: N=1 等价性四件套回归（评审 M-2 补）**

Run: `cd src-server && INGEST__SOURCE_CONCURRENCY=1 cargo test --test integration -- --ignored ingest`
Expected: 四件套在并发度 1 下全绿（buffered(1)+channel ≈ 今日串行——spec 测 6 的完整形态；env 经 AppConfig::from_env 全进程生效，无并行竞态）

- [ ] **Step 1c: 测试残留说明（评审 M-6，记录勿改）**

单跑过滤器（如只跑 ingest_concurrency）时 t10_ 行不被 SWEEPS 清（cutoff 机制靠全量跑收上一轮）——开发循环积累属已知取舍；Step 1 的全量跑即兜底清扫。

- [ ] **Step 2: 前端全量**

Run: `npx vitest run`
Expected: 全绿（面板 4 用例 + 既有全套）

- [ ] **Step 3: spec 语义清单勾稽**（对照 spec「语义保持清单」1-10 逐条打勾，在最终 commit message 或 PR 描述里逐条引用测试用例名）

- [ ] **Step 4: 收尾 commit（若有零星修复）**

```bash
git branch --show-current
git add <修复文件>
git commit -m "fix(ingest): 全量回归零星修复"
```

无修复则无 commit。此后走 requesting-code-review 完整流程（用户铁律：充分评审测试后才合并）。

---

## Self-Review 记录

1. **Spec coverage**：§1（Task 3/4）、§2（Task 4/9）、§3（Task 4 尾段原样）、§4（Task 1/8）、§5（Task 4/6）、§6（Task 3/4）、§7（Task 2/8）、测试 1-14（Task 5：1/2/6；Task 6：3/8/9；Task 7：4/5/10；Task 8：14/11；Task 9：13 前端半；Task 7 用例 9 含 13 server 半）。**两处如实降级（评审 I-3 更正，原"无缺口"声明不实）**：测 7（panic 注入）= Task 3 纯函数单测覆盖，实注入按 spec"代价可控时"降级；测 12（①JobError → 瞬态重试集成半）= peek 的 SELECT 故障注入无廉价机制，由 Task 3 `peek_outcome` 单测（Err→JobError 变体保 DatabaseError 原值）+ Task 2 transient 分类单测 + Task 4 代码结构（`JobError(e) => return Err(e)` 原值透传，三行直线代码）组合覆盖——集成注入留待实现后评审裁定是否值得测试钩子。
2. **Placeholder scan**：全文无 TBD/unimplemented 残留（初稿 Task 5 的两段示意骨架与 Step 4 的 unimplemented! 已在定稿前清除，改为单一完整实现）；stub 双 extractor 有具名 fn 退路注记；ic_setup 的 provider JSON 字段锚定 t8 源码行号防凭记忆造字段。
3. **Type consistency**：`Phase1Output` 四变体、`peek_outcome`/`dedupe_targets`/`item_progress`/`verify_generator_completeness`/`clamp_source_concurrency` 签名在 Task 3 定义、Task 4 消费逐字一致；测试侧 `ic_run_ok` 返回 `(IngestJob, IngestJobResult)`、`ic_fetch_item_states(env, job_id)` 带 job_id——Task 5 定义、Task 5/6/7/8 全部调用点已同步；`StubRoute` 已带 `#[derive(Clone)]`（Task 8 循环复用需要）。
