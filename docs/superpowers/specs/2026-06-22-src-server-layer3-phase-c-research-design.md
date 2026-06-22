← [设计文档索引](../)

# src-server Layer 3 Phase C 设计：Deep Research（Tavily）

> **Date**: 2026-06-22 · **Status**: Draft (待 review) · **Type**: 子系统详细设计
> **Scope**: src-server Deep Research 子系统——Tavily web 搜索 + 独立 research_worker（并发 3）+ LLM 综合 + 存 wiki/queries + 自动 embed/入图；接通 review 的 deep_research action。
> **Related**: [Layer 3 总览](2026-06-21-src-server-layer3-chat-review-research-design.md) §8、§12 Phase C · [Phase B spec](2026-06-21-src-server-layer3-phase-b-review-design.md)（ResolveAction 接通）· [Phase A spec/plan](2026-06-21-src-server-layer3-chat-review-research-design.md) §6（共享层）

---

## 1. 背景与依赖

Layer 3 总览定 Phase C = Deep Research（Tavily）。Phase A 建好共享层（`retrieval` / `llm_stream` / `citations`），Phase B 建好 review 子系统（`ResolveAction` 待接 `DeepResearch`）。本 Phase 在其上组合。

**关键事实**（探索确认）：

- **既有 worker 模式**：`services/ingest_worker.rs::spawn_worker`（main.rs:27 spawn）→ `recover_pending` → `worker_loop`（`BRPOP ingest:queue` 阻塞取 → fetch job → 标 running → `run_ingest_job` → 标 succeeded/failed）。research_worker 直接仿此结构。
- **既有队列表**：`ingest_jobs`（migration 004）——**UUID 主键**、`status VARCHAR`、`stage VARCHAR` 细粒度、`created_by ON DELETE SET NULL`。research_tasks 镜像此设计。
- **既有 provider 抽象**：`services/llm_stream.rs`（`StreamChatProvider` trait + OpenAI/Anthropic + `provider_for_project`）；`services/llm.rs::decrypt_api_key(encrypted: &str, config: &AppConfig)`（JWT secret 派生 key，复用此路径加密 search_provider key）。
- **Phase B 已提 pub(crate)**：`ingest_pipeline::{upsert_wiki_page, WikiPageInsert}`（research 产物落库直接复用）；`embedding::embed_page(pool, cfg, client, project_id, path, text)`。
- **Phase B ResolveAction**：`services/review.rs::ResolveAction { CreatePage, Skip, Delete{..}, Open{..} }`（`#[serde(rename_all="snake_case", tag="kind")]`）。Phase C 加 `DeepResearch` 变体。
- **桌面参考**：`src/lib/deep-research.ts`（350 行，`collectResearchSources` 跨 query 并发 + URL 去重 + max cap；`processQueue` 并发上限；`executeResearch` searching→synthesizing→saving）。

**Phase B 留下的测试盲区（Phase C 一并解决）**：`ingest_pipeline` 内部 step1/step2/dedicated 三处硬编码 `provider_for_project`（无注入缝），故 Phase B 无法端到端测 ingest→review。Phase C 的 `run_research_job` 采用**函数参数注入**（web + llm 双 provider 注入），端到端可测；此模式也为未来重构 ingest_pipeline 的 provider 注入建立范式。

## 2. 范围

**包含**：
1. `services/web_search.rs`：`WebSearchProvider` trait + `TavilyProvider` + `provider_for_project()` + 去重 helper
2. `services/research/{mod,worker,synthesize}.rs`：worker（Semaphore 并发 3）+ `run_research_job` 状态机（searching→synthesizing→saving→done/error）
3. migration `008_research_tasks.sql` + `009_search_providers.sql`
4. `routes/research.rs`：POST 入队 / GET 列表 / GET 详情(全局 uuid) / GET stream(SSE)
5. `routes/search_providers.rs`：search_provider CRUD（POST/GET/PUT/DELETE）
6. `services/review.rs::ResolveAction` 加 `DeepResearch` 变体 + dispatch（用 review_item.search_queries 入队）
7. research 产物 upsert wiki/queries/research-{slug}-{date}.md + best-effort embed（graph 自然扫到，不二次 ingest）

**不包含（YAGNI / 延后）**：
- chat 触发 research / graph_insight 自动触发
- anyTxt 本地源 / serpapi/searxng/ollama provider（仅留 trait，实现 tavily）
- Redis pub/sub 推进（用 DB 轮询 SSE）
- 任务取消端点（worker 跑完仅数分钟，YAGNI）
- 综合流式 token（非流式 `chat_to_string`）
- 综合产物存 `refs` 结构化引用（citation 只留 markdown 文本）
- 任务级"续跑"重试（重试=从头跑，覆盖 web_results）
- 综合阶段的 query 扩写 LLM 调用（缺省查询由 topic 简单派生）

## 3. 关键设计决策

| 决策 | 取值 | 依据 |
|------|------|------|
| 研究源 | 仅 web（Tavily） | 总览 §8「Tavily 优先，YAGNI」；本地交叉引用靠 synthesis 阶段 retrieve_context |
| provider 注入 | 函数参数注入（web+llm 双 provider） | 端到端可测；顺带解 Phase B 盲区；最干净 |
| 综合交付 | 非流式（chat_to_string）+ SSE 状态 | 简单可靠，流中断不存半截 |
| 自动摄取 | 不二次 ingest，只 embed + 入图 | research 产物已是成品 wiki 页，LLM 二次生成会产矛盾/重复 |
| 并发模型 | Semaphore(3) 仿桌面 | research 是交互任务，并发改善体验；长任务不阻塞短任务 |
| 触发来源 | manual + review action | 兑现总览 §9 组合点 Review→Research；chat/graph 延后 |
| 零源处理 | error（不综合） | research 本质依赖 web，零源报错让用户查配置 |
| 重试语义 | 任务级从头跑，Tavily 调用级不退避（allSettled 容忍） | 避免"续跑"状态机复杂度 |
| SSE 推进 | DB 轮询 1-2s（非 pub/sub） | 总览 §2 pub/sub 列 YAGNI |
| search_provider 作用域 | per-project（镜像 llm_providers） | 总览 §4 已定 |
| api_key 加密 | 复用 llm.rs::decrypt_api_key | 同加密路径，不另造 |
| 队列主键 | UUID 主键（镜像 ingest_jobs） | 风格一致 + 全局 uuid 查询 |

## 4. 数据模型

### migration `008_research_tasks.sql`

```sql
-- 008_research_tasks.sql — Layer 3 Phase C: Deep Research 任务（项目级团队共享）
CREATE TABLE research_tasks (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id     INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,  -- 触发者;删用户保留产物(对齐 ingest_jobs.created_by)
    topic          TEXT NOT NULL,
    search_queries TEXT[],                    -- 入队时给;缺省由 topic 派生 2-3 条
    status         VARCHAR(20) NOT NULL DEFAULT 'queued',  -- queued|searching|synthesizing|saving|done|error
    stage          VARCHAR(40),               -- 细粒度阶段(供 SSE/调试): searching|synthesizing|saving;终态保留最后值
    web_results    JSONB,                     -- WebSearchResult[] 去重后(max 20);searching 成功后即存(失败可重试)
    synthesis      TEXT,                      -- LLM 综合输出(仅 done 时存)
    saved_path     TEXT,                      -- wiki/queries/research-{slug}-{date}.md
    source_kind    VARCHAR(20) NOT NULL DEFAULT 'manual',  -- manual|review
    error          TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at     TIMESTAMPTZ,
    finished_at    TIMESTAMPTZ,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_research_status ON research_tasks(project_id, status, created_at);
CREATE INDEX idx_research_running ON research_tasks(status) WHERE status IN ('queued','searching','synthesizing','saving');
```

> `status` 与 `stage` 的写入规则：`set_stage(state, task_id, phase)` **同步写两列**——`status=phase` 且 `stage=phase`（phase ∈ searching/synthesizing/saving）。即 status 取 migration 行 76 的全部 6 值（queued 在入队时、searching/synthesizing/saving 在运行中、done/error 在终态），不是「粗状态」；这样 `?status=` 列表过滤与部分索引 `idx_research_running` 才有意义。两列的区别仅在**终态**：done/error 时 `status` 切到终态值，`stage` **保留最后到达的阶段**（「跑到哪一步」），调试/SSE 友好。`started_at`/`finished_at` 对齐 ingest_jobs。

### migration `009_search_providers.sql`

```sql
-- 009_search_providers.sql — Layer 3 Phase C: web-search provider 配置（per-project）
CREATE TABLE search_providers (
    id                BIGSERIAL PRIMARY KEY,
    project_id        INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    provider_type     VARCHAR(50) NOT NULL,   -- tavily(预留 serpapi/searxng/ollama)
    api_key_encrypted TEXT NOT NULL,          -- 复用 services/llm.rs::decrypt_api_key(JWT secret 派生 key,同 llm_providers 路径)
    base_url          TEXT,                   -- None 用 Tavily 默认 https://api.tavily.com
    is_enabled        BOOLEAN NOT NULL DEFAULT TRUE,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_search_providers_project ON search_providers(project_id);
CREATE INDEX idx_search_providers_enabled ON search_providers(project_id) WHERE is_enabled = TRUE;
-- 入队校验:项目无 enabled search_provider → 400(总览 §8.3)
```

## 5. 模块结构

| 文件 | 职责 | 新/改 |
|------|------|-------|
| `services/web_search.rs` | `WebSearchResult`/`WebSearchProvider` trait + `TavilyProvider` + `provider_for_project()` + `dedupe_results()`(纯) | 新建 |
| `services/research/mod.rs` | 类型（`ResearchTask`/`ResearchStage`/`EnqueueBody`/`ResearchOutcome`）+ `derive_queries()`/`slugify_topic()`(纯) + `pub` 接口 | 新建 |
| `services/research/worker.rs` | `spawn_worker` + `worker_loop`(Semaphore 3 + BRPOP research:queue) + `recover_pending` + `run_research_job_wrapped`(取真实 provider 注入) | 新建 |
| `services/research/synthesize.rs` | `run_research_job`(状态机编排,参数注入 web+llm) + `collect_sources`(并发去重) + `assemble_research_prompt`(纯) + `strip_thinking`(纯) + `save_research_page`(复用 upsert_wiki_page+embed_page) + stage 状态写 | 新建 |
| `routes/research.rs` | `enqueue_research`/`list_research_tasks`/`get_research_task`/`stream_research_task`(SSE 轮询) + `research_routes()` | 新建 |
| `routes/search_providers.rs` | search_provider CRUD + `search_provider_routes()` | 新建 |
| `services/mod.rs` | `pub mod web_search; pub mod research;` | 改 |
| `routes/mod.rs` | `pub mod research; pub mod search_providers;` | 改 |
| `routes/projects.rs` | `.merge(research::research_routes())` + `.merge(search_providers::search_provider_routes())` | 改 |
| `services/review.rs` | `ResolveAction` 加 `DeepResearch` 变体 + `resolve_review_item` dispatch(入队 research_task) | 改 |
| `services/review.rs::slugify` | 提为 `pub(crate)` 供 research 复用（或 research 自带 `slugify_topic`） | 改（提 pub(crate)） |
| `main.rs` | `research_worker::spawn_worker(state.clone())` | 改 |
| `migrations/008_research_tasks.sql` | research_tasks 表 | 新建 |
| `migrations/009_search_providers.sql` | search_providers 表 | 新建 |
| `tests/integration/research_test.rs` | happy path/零源/综合失败保留 web_results/入队校验/review 接通/团队可见性/provider CRUD | 新建 |
| `tests/integration/mod.rs` | `mod research_test;` | 改 |

**为何 `research/` 拆 3 文件、`web_search.rs` 单列**：research 涉及 worker/synthesis/类型多职责，单文件会过载；web_search 是独立 provider 抽象（未来 chat 也可用），不归属 research 子目录。

## 6. 关键契约类型

```rust
// services/web_search.rs
pub struct WebSearchResult { pub title: String, pub url: String, pub snippet: String, pub source: String }

#[async_trait]
pub trait WebSearchProvider: Send + Sync {
    async fn search(&self, query: &str, max_results: u8) -> Result<Vec<WebSearchResult>, WebSearchError>;
    fn provider_type(&self) -> &'static str;
}

pub struct TavilyProvider { client: reqwest::Client, api_key: String, base_url: String }

/// 从 search_providers 表构造（取 enabled tavily + decrypt_api_key 解密）。
pub async fn provider_for_project(state: &AppState, project_id: i32) -> Result<Box<dyn WebSearchProvider>, AppError>;

/// 纯:按 url(退化 title:source:snippet) 去重 + max cap。
pub fn dedupe_results(raw: Vec<WebSearchResult>, max: usize) -> Vec<WebSearchResult>;
```

```rust
// services/research/mod.rs
pub struct ResearchTask { /* FromRow: 全列 */ }
pub struct EnqueueBody { pub topic: String, pub search_queries: Option<Vec<String>> }
pub struct ResearchOutcome { pub path: String, pub synthesis: String }

/// 纯:topic → [topic, "{topic} overview", "{topic} latest"]（CJK 安全）。
pub fn derive_queries(topic: &str) -> Vec<String>;
/// 纯:topic → slug（复用 review::slugify 提 pub(crate)，或独立同款实现）。
pub fn slugify_topic(topic: &str) -> String;
```

```rust
// services/research/synthesize.rs
/// 状态机编排。provider 参数注入（web + llm），不自己取 provider → 端到端可测。
/// date_ymd / context_size 由调用方注入（测试确定性；worker 内 Date 不可用，且不依赖全局配置）。
/// context_size 类型 i32，对齐 retrieve_context 第 4 参与 LlmConfig.context_size。
pub async fn run_research_job(
    state: &AppState,
    task: &ResearchTask,
    date_ymd: &str,                         // "2026-06-22"，由 worker 注入
    context_size: i32,                      // worker 取 get_llm_config().context_size 注入（对齐 chat_sessions.rs:458/468）
    web: &dyn WebSearchProvider,
    llm: &dyn StreamChatProvider,
) -> Result<ResearchOutcome, AppError>;

pub fn assemble_research_prompt(topic: &str, sources: &[WebSearchResult], retrieval: &RetrievalResult) -> String;
pub fn strip_thinking(text: &str) -> String;
```

## 7. worker 状态机 + 数据流

### 7.1 spawn_worker（仿 ingest_worker，main.rs spawn）

```rust
pub fn spawn_worker(state: AppState) {
    tokio::spawn(async move {
        tracing::info!("research worker started");
        recover_pending(&state).await;       // 重启恢复 queued/searching/... → LPUSH
        let semaphore = Arc::new(tokio::sync::Semaphore::new(3));
        worker_loop(state, semaphore).await;
    });
}
```

### 7.2 worker_loop（Semaphore 并发 3）

```rust
async fn worker_loop(state: AppState, sem: Arc<Semaphore>) {
    loop {
        let task_uuid = match brpop_task(&state).await { Some(u) => u, None => continue }; // BRPOP research:queue
        let permit = sem.clone().acquire_owned().await.unwrap();  // 第 4+ 任务在此等
        let state = state.clone();
        tokio::spawn(async move {            // 子 task,不阻塞主 loop
            let _permit = permit;            // RAII 释放
            run_research_job_wrapped(&state, task_uuid).await;
        });
    }
}
```

### 7.3 run_research_job_wrapped（生产路径：取真实 provider 注入）

```rust
async fn run_research_job_wrapped(state: &AppState, task_uuid: Uuid) {
    let task = match fetch_and_mark_running(state, task_uuid).await { Ok(t) => t, Err(e) => { mark_error(...); return; } };
    let web = match web_search::provider_for_project(state, task.project_id).await {
        Ok(p) => p, Err(e) => { mark_error(state, task.id, &format!("web provider: {e}")).await; return; } };
    let llm = match llm_stream::provider_for_project(state, task.project_id).await {
        Ok(p) => p, Err(e) => { mark_error(state, task.id, &format!("llm provider: {e}")).await; return; } };
    // date_ymd 由 worker 生产路径取系统日期注入(UTC ymd);run_research_job 签名要求注入是为了
    // 让集成测试传确定性 date(测试不依赖系统时钟)。生产 worker 此处取 chrono::Utc::now() 格式化。
    let date = chrono::Utc::now().format("%Y-%m-%d").to_string();
    // context_size 同理由 worker 注入(对齐 chat_sessions.rs:458 get_llm_config + :468 传参):
    // 取该 project 启用 LLM provider 的 context_size;失败 mark_error(并入「provider 获取失败」错误类)。
    let context_size = match llm::get_llm_config(&state.db, task.project_id).await {
        Ok(c) => c.context_size,
        Err(e) => { mark_error(state, task.id, &format!("llm config: {e}")).await; return; } };
    match run_research_job(state, &task, &date, context_size, &*web, &*llm).await {
        Ok(o) => { let _ = mark_done(state, task.id, &o.synthesis, &o.path).await; }
        Err(e) => { let _ = mark_error(state, task.id, &e.to_string()).await; }  // 保留 web_results
    }
}
```

### 7.4 run_research_job 状态机（synthesize.rs，纯编排，参数注入）

```rust
pub async fn run_research_job(state, task, date_ymd, context_size, web, llm) -> Result<ResearchOutcome, AppError> {
    // ① searching
    set_stage(state, task.id, "searching").await;   // 同步写 status='searching' AND stage='searching'(见 §4 注)
    // 空 search_queries 归一化:Some([]) 与 None 一视同仁 → 派生(对齐 review dispatch,见 §9),
    // 避免 manual 入队传空数组落入「零源 error」。
    let queries = task.search_queries.clone()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| derive_queries(&task.topic));
    let raw = collect_sources(web, &queries).await;     // 并发 allSettled(单 query 失败只 warning 继续);返回未去重合集(Vec,非 Result)
    let sources = dedupe_results(raw, 20);              // 去重交由纯函数 dedupe_results(§7.5)
    if sources.is_empty() { return Err(AppError::LlmApiError("no web sources".into())); }  // 零源即 error
    persist_web_results(state, task.id, &sources).await;  // searching 成功后即存(失败可重试)

    // ② synthesizing
    set_stage(state, task.id, "synthesizing").await;
    let retrieval = retrieve_context(state, task.project_id, &task.topic, context_size).await?;
    let prompt = assemble_research_prompt(&task.topic, &sources, &retrieval);
    let (raw_out, _) = llm.chat_to_string(
        vec![ChatMessage { role: "user".into(), content: prompt }],
        ChatOpts { model: llm.model_name().into(), temperature: 0.3, max_tokens: 8000,
                   system_prompt: Some("You synthesize a research brief for a personal wiki. Output a single markdown document.".into()), timeout_secs: None },
    ).await.map_err(|e| AppError::LlmApiError(format!("synthesize: {e}")))?;
    let synthesis = strip_thinking(&raw_out);
    if synthesis.trim().is_empty() { return Err(AppError::LlmApiError("empty synthesis".into())); }

    // ③ saving
    set_stage(state, task.id, "saving").await;
    let path = save_research_page(state, task.project_id, &task.topic, &synthesis, date_ymd, &sources).await?;
    // best-effort embed(失败 warning 不阻断);graph 下次 build_graph 自然扫到
    if let Err(e) = embed_page(&state.db, state.config.embedding.as_ref(), &state.http, task.project_id, &path, &synthesis).await {
        tracing::warn!("embed research page {}: {}", path, e);
    }
    Ok(ResearchOutcome { path, synthesis })
}
```

### 7.5 collect_sources（移植桌面 collectResearchSources）

跨 query 并发 `web.search(q, 5)`（`futures::join_all` / `FuturesUnordered`，allSettled 式：单 query 失败只 warning 继续），返回未去重的合集。去重交给 `dedupe_results`（纯函数单测）。

### 7.6 save_research_page（复用 upsert_wiki_page）

```rust
async fn save_research_page(state, project_id, topic, synthesis, date_ymd, sources) -> Result<String, AppError> {
    let slug = slugify_topic(topic);
    let path = format!("wiki/queries/research-{}-{}.md", slug, date_ymd);
    let source_urls: Vec<&str> = sources.iter().map(|s| s.url.as_str()).collect();
    let frontmatter = serde_json::json!({ "type":"query", "title":topic, "sources":source_urls, "origin":"deep-research" });
    let content = format!("# {}\n\n{}", topic, synthesis);
    let page = WikiPageInsert { path: path.clone(), title: Some(topic.into()), content, frontmatter,
                                page_type: "query".into(), sources: serde_json::json!(source_urls), images: serde_json::json!([]) };
    upsert_wiki_page(state, project_id, &page).await?;   // UNIQUE(project_id,path) → 同 topic 同天重跑覆盖(合理)
    Ok(path)
}
```

## 8. 端点契约

```
POST   /api/v1/projects/:id/research              入队 {topic, search_queries?} → 201 {uuid}
GET    /api/v1/projects/:id/research/tasks        列表(?status=&limit=&offset=)
GET    /api/v1/research/tasks/:uuid               详情(全局按 uuid,仿 ingest jobs)
GET    /api/v1/research/tasks/:uuid/stream        SSE 进度(stage 迁移 + done/error)
```

**search_provider CRUD**（`routes/search_providers.rs`，project-scoped，需项目访问权）：
```
POST   /api/v1/projects/:id/search-provider       建 {provider_type, api_key, base_url?} → 201
GET    /api/v1/projects/:id/search-provider        取当前 enabled provider(api_key 不回传)
PUT    /api/v1/projects/:id/search-provider/:sid   更新 {api_key?, base_url?, is_enabled?}
DELETE /api/v1/projects/:id/search-provider/:sid   删
```
> GET 响应**不回传 api_key**（只回 sid/provider_type/base_url/is_enabled/has_key 布尔），避免泄漏。

**SSE stream**（`GET /research/tasks/:uuid/stream`）：查 task 当前 status/stage → 推初始 `stage` 事件 → **DB 轮询**（每 1.5s 查 task 状态变化）→ stage 变化推 `stage` 事件 → 终态推 `done`（含 saved_path）/ `error`（含 message）后关闭。SSE 最长 ~5min 超时。不流 token。

## 9. review→research 接通

```rust
// services/review.rs::ResolveAction 加变体
pub enum ResolveAction { CreatePage, Skip, Delete { path: Option<String> }, Open { path: Option<String> }, DeepResearch }

// resolve_review_item dispatch
ResolveAction::DeepResearch => {
    let queries = item.search_queries.clone()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| research::derive_queries(&item.title));
    let task_uuid = enqueue_research_task(state, project_id, Some(user_id), &item.title, Some(queries), "review").await?;
    mark_resolved(state, item_id, "deep_research", user_id).await?;
    Ok(ResolveOutcome::Resolved { resolved_action: "deep_research".into(), created_path: None })
    // research 异步跑(worker 拾取),不阻塞 resolve 响应;前端按 task_uuid 查进度
}
```
> `enqueue_research_task`（research/mod.rs）封装 INSERT research_task + LPUSH research:queue，供 routes 和 review dispatch 复用。

## 10. 错误处理汇总

| 场景 | 处理 | HTTP/状态 |
|------|------|----------|
| 入队项目无 enabled search_provider | 拒绝入队 | 400 |
| 入队 topic 空/空白 | 拒绝 | 400 |
| 入队 search_queries 为 `None` 或空数组 | 不拒绝；run_research_job 内归一化为 `derive_queries(topic)`（manual 与 review 两入口一致） | — |
| 无项目访问权 | check_project_access | 403 |
| Tavily 单 query 失败 | allSettled 容忍，warning 继续 | — |
| 全部 query 零源 | `no web sources` error，不综合 | task=error |
| 综合阶段 LLM 失败 | mark_error，**保留 web_results**（允许重试） | task=error |
| 综合产物空 | `empty synthesis` error | task=error |
| saving 失败（upsert） | mark_error，synthesis 不存（重试重跑） | task=error |
| embed 失败 | best-effort warning，仍 done | task=done |
| provider 获取失败（web/llm） | mark_error，不入 running | task=error |
| 查不存在的 task uuid | ResourceNotFound | 404 |
| worker 崩溃/重启 | 任务留 running → recover_pending 重投 → 幂等重跑（upsert 覆盖、web_results 覆盖） | — |
| search_provider api_key 解密失败 | EncryptionError | 500 |

**状态一致性**：`web_results` 在 searching 成功后即存（无论后续 error）；`synthesis` 仅 done 存；`error` 终态含 message。

## 11. 测试策略

**纯函数单测**（`research/synthesize.rs` + `research/mod.rs` `#[cfg(test)]`）：
- `derive_queries`：topic → 3 条（CJK 安全）
- `assemble_research_prompt`：含 sources/index/pages 三段；pages 段在 retrieval 空时省略
- `slugify_topic`：CJK/空格/特殊字符
- `strip_thinking`：剥 `<think>`/`<thinking>`/无标签原样
- `dedupe_results`（web_search.rs）：重复 url 去重 + max 20 cap + url 缺失退化键

**provider fakes**（函数参数注入带来的便利）：
- `FakeWebProvider { results: Vec<WebSearchResult> }` impl WebSearchProvider
- 复用既有 `FakeProvider`（llm，StreamChatProvider）

**集成测试**（`tests/integration/research_test.rs`，注入 fake provider，绕过 worker BRPOP 直接调 `run_research_job`）：
1. **happy path 端到端**：run_research_job（fake web+llm）→ done，验证 wiki_pages 有 research-*.md 行 + task.status=done + saved_path
2. **零源 error**：FakeWebProvider 返空 → error（"no web sources"）
3. **综合失败保留 web_results**：FakeProvider llm 报错 → status=error，但 web_results 已存（查 DB）
4. **入队无 search_provider → 400**（走 POST /research 端点）
5. **review→research 接通**：seed review_item 带 search_queries → resolve DeepResearch → research_task(source_kind=review) 入队 + item resolved
6. **团队可见性**：B 非 member → POST research 403
7. **search_provider CRUD**：POST/GET/PUT/DELETE + api_key 加密往返（GET 不回传 key）

**worker_loop 本身不写自动化集成测**（BRPOP + Semaphore 涉及 redis 时序，脆）：
- `recover_pending` 抽纯函数测（输入 pending 列表 → 验证重投逻辑）
- Semaphore 并发靠代码审查 + 生产日志
- 与 ingest_worker 同款策略（ingest_worker 也靠 ingest_queue_test 测队列层，不测 worker_loop 时序）

## 12. 实现拆分（为 writing-plans 预热）

1. migration 008 research_tasks + 009 search_providers + 验证
2. `web_search.rs`：类型 + trait + TavilyProvider + `provider_for_project` + `dedupe_results`（纯，TDD）
3. `research/mod.rs`：类型 + `derive_queries`/`slugify_topic`（纯，TDD）+ `enqueue_research_task`
4. `research/synthesize.rs`：`assemble_research_prompt`/`strip_thinking`（纯，TDD）+ `run_research_job` 状态机（参数注入）+ `collect_sources` + `save_research_page`
5. `research/worker.rs`：`spawn_worker` + `worker_loop`(Semaphore 3) + `recover_pending` + `run_research_job_wrapped` + main.rs spawn
6. `routes/research.rs`：4 端点 + SSE 轮询 + 接入 project_routes
7. `routes/search_providers.rs`：CRUD + 接入 project_routes
8. `review.rs`：`ResolveAction::DeepResearch` + dispatch + slugify 提 pub(crate)
9. 集成测试 + clippy 全绿

## 13. 待定 / 延后

- chat 触发 research / graph_insight 自动触发 —— 后续 phase
- anyTxt 本地源 / serpapi/searxng/ollama provider —— 仅留 trait
- Redis pub/sub SSE 推进 —— 当前 DB 轮询，量大后评估
- 任务取消端点 —— YAGNI
- 综合流式 token —— 当前非流式
- 任务级"续跑"重试 —— 当前从头跑
- 综合产物 `refs` 结构化引用 —— citation 只留 markdown 文本
- ingest_pipeline 的 provider 注入重构（Phase B 盲区根因）—— Phase C 用参数注入模式为 research 解了盲区；ingest 侧的重构单独立项

---

## 附录：与总览 §8/§12 的差异说明

- 总览 §8.2 写"自动摄取：复用现有 ingest 管线提取实体/概念" → 本设计改为**不二次 ingest，只 embed + 入图**（§3 决策：research 产物已是成品 wiki 页，LLM 二次生成会产矛盾/重复）。
- 总览 §8.2 写"综合用 chat_stream/chat_to_string" → 本设计定**非流式 chat_to_string**（§3 决策）。
- 总览 §8.4 "save→ingest 链测试（mock ingest）" → 因不二次 ingest，改为 **save→embed 链测试**。
- 总览 §13 待定"综合用 stream 还是 to_string" → 本设计定 to_string（关闭该待定项）。
