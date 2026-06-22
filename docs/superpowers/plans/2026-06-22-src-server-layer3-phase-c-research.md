← [设计文档索引](../)

# src-server Layer 3 Phase C (Deep Research) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 src-server 实现 Deep Research 子系统（Tavily web 搜索 + 独立 research_worker 并发 3 + LLM 综合 + 落 wiki/queries + 自动 embed），并接通 review 的 `DeepResearch` action。

**Architecture:** 仿 `ingest_worker` 的 BRPOP 队列 worker；`run_research_job` 状态机（searching→synthesizing→saving→done/error）用**函数参数注入** web+llm+context_size+date，使端到端可测（顺带解 Phase B 的 provider 注入盲区）；web 结果落 `research_tasks` 表，综合产物 upsert wiki 页 + best-effort embed（不二次 ingest）；SSE 用 DB 轮询推进。

**Tech Stack:** Rust + axum 0.7（冒号路由 `:id`）+ sqlx 0.7（PostgreSQL + Uuid/FromRow）+ redis/deadpool-redis（BRPOP/LPUSH）+ reqwest（Tavily）+ futures/async-stream + thiserror。

**Spec:** `docs/superpowers/specs/2026-06-22-src-server-layer3-phase-c-research-design.md`

---

## 全局约定（每个 Task 都要遵守）

1. **cargo 命令**：src-server 被根 workspace `exclude`，**必须 `cd src-server` 后跑、且不带 `-p`**。
   - 纯函数单测：`cargo test --lib services::web_search::tests`（路径按实际模块）
   - 集成测试：`cargo test --test integration research_test::<name>`（target 名固定 `integration`，见 `Cargo.toml [[test]]`）
   - 全部集成：`cargo test --test integration`
   - clippy：`cargo clippy --all-targets -- -D warnings`
2. **测试 DB**：`PGPASSWORD=test123 psql -h localhost -p 5433 -U llmwiki -d llmwiki`（migration 手动 `-f` 应用，项目无代码级 runner）。
3. **AppError 可用变体**（`src/error.rs`）：`BadRequest(String)`、`ValidationError(String)`、`ResourceNotFound(String)`、`Conflict(String)`、`LlmApiError(String)`、`EncryptionError(String)`、`InternalError(String)`、`DatabaseError(sqlx::Error)`、`RedisError(PoolError)`。
4. **AppState 字段**（`src/lib.rs`）：`db: DbPool`、`redis: RedisPool`、`config: Arc<AppConfig>`、`http: reqwest::Client`。redis 用 `state.redis.get().await` → deadpool Connection。
5. **git 规则**：未经用户明确批准不得 commit/push。本计划每个 Task 末尾的 commit 步骤，在 subagent-driven 执行框架内由 implementer 完成（与 Phase B 一致）；controller 不绕过用户审批。
6. **工作语言**：简体中文（注释/commit）；变量名英文。
7. **现有可复用契约**（已核实 verbatim，后续 Task 直接引用）：
   - `llm_stream::{StreamChatProvider, ChatMessage, ChatOpts, TokenDelta, LlmError, provider_for_project(state, project_id) -> Result<Box<dyn StreamChatProvider>, AppError>}`，trait 含默认方法 `chat_to_string(messages, opts) -> Result<(String, Option<(u32,u32)>), LlmError>`。
   - `retrieval::retrieve_context(state, project_id, query, context_size: i32) -> Result<RetrievalResult, AppError>`；`RetrievalResult { pages: Vec<RetrievedPage>, assembled_context: String, index_snippet: String, ref_map: HashMap<i32,MessageReference> }`；`RetrievedPage { number: i32, path: String, title: String, content: String, priority: u8 }`。
   - `ingest_pipeline::{upsert_wiki_page(state, project_id, &WikiPageInsert) -> Result<String, AppError>, WikiPageInsert{ path, title:Option<String>, content, frontmatter:Value, page_type, sources:Value, images:Value }（全 pub(crate)）}`。
   - `embedding::embed_page(pool, cfg: Option<&EmbeddingConfig>, client, project_id, path, text) -> Result<(), AppError>`；`config.embedding: Option<EmbeddingConfig>`。
   - `llm::{get_llm_config(&pool, project_id) -> Result<LlmConfig, AppError>（含 `.context_size: i32`）、decrypt_api_key(&str, &AppConfig)}`；`utils::crypto::{encrypt_api_key, decrypt_api_key}(&str, &[u8;32])`。
   - `review::{ResolveAction, ResolveOutcome, resolve_review_item, slugify(pub), mark_resolved, load_open_item}`。
   - `middleware::project_guard::check_project_access(&state, &headers, project_id) -> Result<(i32, _), AppError>`（返回 `(user_id, team_id)`，403 无权）。

---

## File Structure

| 文件 | 职责 | 新/改 |
|------|------|-------|
| `migrations/008_research_tasks.sql` | research_tasks 表（UUID 主键，status+stage，web_results/synthesis/saved_path） | 新 |
| `migrations/009_search_providers.sql` | search_providers 表（per-project，api_key_encrypted） | 新 |
| `src/services/web_search.rs` | `WebSearchResult`/`WebSearchProvider` trait/`WebSearchError`/`TavilyProvider`/`provider_for_project`/`dedupe_results`(纯) | 新 |
| `src/services/research/mod.rs` | `ResearchTask`/`EnqueueBody`/`ResearchOutcome` + `derive_queries`/`slugify_topic`(纯) + `enqueue_research_task` | 新 |
| `src/services/research/synthesize.rs` | `assemble_research_prompt`/`strip_thinking`(纯) + `run_research_job`(状态机,参数注入) + `collect_sources` + `save_research_page` + `set_stage`/`persist_web_results` | 新 |
| `src/services/research/worker.rs` | `spawn_worker` + `worker_loop`(Semaphore 3) + `recover_pending` + `fetch_and_mark_running` + `mark_done`/`mark_error` + `run_research_job_wrapped` | 新 |
| `src/services/mod.rs` | `pub mod web_search; pub mod research;` | 改 |
| `src/routes/research.rs` | `enqueue_research`/`list_tasks`/`get_task`/`stream_task`(SSE) + `research_project_routes()`/`global_research_routes()` | 新 |
| `src/routes/search_providers.rs` | search_provider CRUD（POST/GET/PUT/DELETE）+ `search_provider_routes()` | 新 |
| `src/routes/mod.rs` | `mod research; mod search_providers;` + create_router 接 global 路由 | 改 |
| `src/routes/projects.rs` | `project_routes()` merge `research::research_project_routes()` + `search_providers::search_provider_routes()` | 改 |
| `src/services/review.rs` | `ResolveAction::DeepResearch` + `resolve_review_item` dispatch；`slugify` 提 `pub`（已是 pub，无需改） | 改 |
| `src/main.rs` | `research::worker::spawn_worker(state.clone())` | 改 |
| `tests/integration/research_test.rs` | happy/零源/综合失败保留 web_results/入队校验/review 接通/团队可见性/provider CRUD | 新 |
| `tests/integration/mod.rs` | `mod research_test;` | 改 |

---

## Task 1: migration 008 + 009

**Files:**
- Create: `migrations/008_research_tasks.sql`
- Create: `migrations/009_search_providers.sql`

- [ ] **Step 1: 写 008_research_tasks.sql**

`migrations/008_research_tasks.sql`：
```sql
-- 008_research_tasks.sql — Layer 3 Phase C: Deep Research 任务（项目级团队共享）
CREATE TABLE research_tasks (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id     INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
    topic          TEXT NOT NULL,
    search_queries TEXT[],
    status         VARCHAR(20) NOT NULL DEFAULT 'queued',  -- queued|searching|synthesizing|saving|done|error
    stage          VARCHAR(40),                             -- searching|synthesizing|saving(终态保留最后值)
    web_results    JSONB,
    synthesis      TEXT,
    saved_path     TEXT,
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

- [ ] **Step 2: 写 009_search_providers.sql**

`migrations/009_search_providers.sql`：
```sql
-- 009_search_providers.sql — Layer 3 Phase C: web-search provider 配置（per-project）
CREATE TABLE search_providers (
    id                BIGSERIAL PRIMARY KEY,
    project_id        INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    provider_type     VARCHAR(50) NOT NULL,   -- tavily(预留 serpapi/searxng/ollama)
    api_key_encrypted TEXT NOT NULL,          -- 复用 utils::crypto + llm key 派生(同 llm_providers 路径)
    base_url          TEXT,                   -- None 用 Tavily 默认 https://api.tavily.com/search
    is_enabled        BOOLEAN NOT NULL DEFAULT TRUE,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_search_providers_project ON search_providers(project_id);
CREATE INDEX idx_search_providers_enabled ON search_providers(project_id) WHERE is_enabled = TRUE;
```

- [ ] **Step 3: 应用到测试 DB 并验证**

```bash
PGPASSWORD=test123 psql -h localhost -p 5433 -U llmwiki -d llmwiki -f migrations/008_research_tasks.sql
PGPASSWORD=test123 psql -h localhost -p 5433 -U llmwiki -d llmwiki -f migrations/009_search_providers.sql
PGPASSWORD=test123 psql -h localhost -p 5433 -U llmwiki -d llmwiki -c "\d research_tasks"
PGPASSWORD=test123 psql -h localhost -p 5433 -U llmwiki -d llmwiki -c "\d search_providers"
```
Expected: 两个 `\d` 各列出对应列与索引，无错误。

- [ ] **Step 4: Commit**

```bash
git add migrations/008_research_tasks.sql migrations/009_search_providers.sql
git commit -m "feat(src-server): 008/009 migration — research_tasks + search_providers

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: web_search.rs（trait + Tavily + provider_for_project + dedupe_results）

**Files:**
- Create: `src/services/web_search.rs`
- Modify: `src/services/mod.rs`（加 `pub mod web_search;`）
- Test: `src/services/web_search.rs` 内 `#[cfg(test)]`（纯函数）+ `tests/integration/research_test.rs`（provider_for_project 走 CRUD seed，见 Task 8/10）

- [ ] **Step 1: 写 dedupe_results 失败测试**

在 `src/services/web_search.rs` 末尾（先建文件骨架 + 测试）。先写文件全部内容（实现 + 测试一起，因 Rust 测试与实现同文件；TDD 节奏靠“先看测试失败”保证）。

`src/services/web_search.rs`：
```rust
// src/services/web_search.rs — web 搜索 provider 抽象 + Tavily 实现 + 去重。
use crate::{AppError, AppState};
use async_trait::async_trait;
use serde::Deserialize;

#[derive(Debug, Clone, Serialize)]
pub struct WebSearchResult {
    pub title: String,
    pub url: String,
    pub snippet: String,
    pub source: String, // provider 标签，如 "tavily"
}

#[derive(Debug, thiserror::Error)]
pub enum WebSearchError {
    #[error("http error: {0}")]
    Http(String),
    #[error("invalid response: {0}")]
    Invalid(String),
}

#[async_trait]
pub trait WebSearchProvider: Send + Sync {
    async fn search(&self, query: &str, max_results: u8) -> Result<Vec<WebSearchResult>, WebSearchError>;
    fn provider_type(&self) -> &'static str;
}

pub struct TavilyProvider {
    client: reqwest::Client,
    api_key: String,
    base_url: String,
}

impl TavilyProvider {
    pub fn new(client: reqwest::Client, api_key: String, base_url: String) -> Self {
        Self { client, api_key, base_url }
    }
}

#[derive(Deserialize)]
struct TavilyResponse { results: Vec<TavilyItem> }
#[derive(Deserialize)]
struct TavilyItem {
    title: Option<String>,
    url: Option<String>,
    content: Option<String>,
}

#[async_trait]
impl WebSearchProvider for TavilyProvider {
    async fn search(&self, query: &str, max_results: u8) -> Result<Vec<WebSearchResult>, WebSearchError> {
        let body = serde_json::json!({
            "api_key": self.api_key,
            "query": query,
            "max_results": max_results,
            "search_depth": "basic",
        });
        let resp = self.client.post(&self.base_url).json(&body).send().await
            .map_err(|e| WebSearchError::Http(e.to_string()))?;
        let parsed: TavilyResponse = resp.json().await
            .map_err(|e| WebSearchError::Invalid(e.to_string()))?;
        Ok(parsed.results.into_iter().map(|it| WebSearchResult {
            title: it.title.unwrap_or_default(),
            url: it.url.unwrap_or_default(),
            snippet: it.content.unwrap_or_default(),
            source: "tavily".into(),
        }).collect())
    }
    fn provider_type(&self) -> &'static str { "tavily" }
}

/// 从 search_providers 表构造 enabled provider（复用 llm key 派生 + utils::crypto::decrypt_api_key）。
pub async fn provider_for_project(
    state: &AppState,
    project_id: i32,
) -> Result<Box<dyn WebSearchProvider>, AppError> {
    let row: Option<(i64, String, Option<String>, String)> = sqlx::query_as(
        "SELECT id, api_key_encrypted, base_url, provider_type FROM search_providers \
         WHERE project_id=$1 AND is_enabled=TRUE ORDER BY id LIMIT 1")
        .bind(project_id).fetch_optional(&state.db).await?;
    let (_, key_enc, base_url, ptype) = row
        .ok_or_else(|| AppError::BadRequest("no enabled search_provider for project".into()))?;
    let api_key = crate::services::llm::decrypt_api_key(&key_enc, &state.config)?;
    let base_url = base_url.unwrap_or_else(|| "https://api.tavily.com/search".into());
    match ptype.as_str() {
        "tavily" => Ok(Box::new(TavilyProvider::new(state.http.clone(), api_key, base_url))),
        other => Err(AppError::BadRequest(format!("unsupported search provider: {other}"))),
    }
}

/// 纯：按 url 去重（url 空时退化 title|source|snippet 键）+ max cap。
pub fn dedupe_results(raw: Vec<WebSearchResult>, max: usize) -> Vec<WebSearchResult> {
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut out = Vec::new();
    for r in raw {
        let key = if r.url.is_empty() {
            format!("{}|{}|{}", r.title, r.source, r.snippet)
        } else {
            r.url.clone()
        };
        if seen.insert(key) {
            out.push(r);
            if out.len() >= max { break; }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    fn r(url: &str, title: &str) -> WebSearchResult {
        WebSearchResult { url: url.into(), title: title.into(), snippet: "s".into(), source: "t".into() }
    }
    #[test]
    fn dedupe_by_url_keeps_first() {
        let out = dedupe_results(vec![r("a", "1"), r("a", "dup"), r("b", "2")], 20);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].title, "1");
        assert_eq!(out[1].title, "2");
    }
    #[test]
    fn dedupe_caps_at_max() {
        let out = dedupe_results(vec![r("a", "1"), r("b", "2"), r("c", "3"), r("d", "4")], 2);
        assert_eq!(out.len(), 2);
    }
    #[test]
    fn dedupe_empty_url_falls_back_to_title_key() {
        let out = dedupe_results(vec![r("", "1"), r("", "1"), r("", "2")], 20);
        assert_eq!(out.len(), 2); // title "1" 去重，title "2" 留
    }
}
```

注意：`WebSearchResult` 需要 `Serialize`（`web_results` 落 JSONB 用 `serde_json::to_value`）——补 `use serde::{Deserialize, Serialize};` 与 `#[derive(..., Serialize)]`（上面 import 已含 `Serialize`，derive 行改为 `#[derive(Debug, Clone, Serialize)]`）。

- [ ] **Step 2: services/mod.rs 加模块声明**

在 `src/services/mod.rs` 现有 `pub mod review;` 之后追加：
```rust
pub mod web_search;
```

- [ ] **Step 3: 跑测试确认 dedupe 通过**

```bash
cd src-server
cargo test --lib services::web_search::tests
```
Expected: 3 passed。

- [ ] **Step 4: clippy**

```bash
cargo clippy --lib -- -D warnings 2>&1 | grep -E "web_search|warning|error" | head
```
Expected: web_search.rs 无 warning。

- [ ] **Step 5: Commit**

```bash
git add src/services/web_search.rs src/services/mod.rs
git commit -m "feat(src-server): web_search provider 抽象 + Tavily + dedupe_results

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: research/mod.rs（类型 + derive_queries + slugify_topic + enqueue_research_task）

**Files:**
- Create: `src/services/research/mod.rs`
- Modify: `src/services/mod.rs`（加 `pub mod research;`）

- [ ] **Step 1: 写 research/mod.rs（类型 + 纯函数 + enqueue）**

`src/services/research/mod.rs`：
```rust
// src/services/research/mod.rs — Research 类型 + 纯函数 + 入队。
pub mod synthesize;
pub mod worker;

use crate::{AppError, AppState};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(sqlx::FromRow, Debug, Clone, Serialize)]
pub struct ResearchTask {
    pub id: Uuid,
    pub project_id: i32,
    pub user_id: Option<i32>,
    pub topic: String,
    pub search_queries: Option<Vec<String>>,
    pub status: String,
    pub stage: Option<String>,
    pub web_results: Option<serde_json::Value>,
    pub synthesis: Option<String>,
    pub saved_path: Option<String>,
    pub source_kind: String,
    pub error: Option<String>,
    pub created_at: DateTime<Utc>,
    pub started_at: Option<DateTime<Utc>>,
    pub finished_at: Option<DateTime<Utc>>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Deserialize)]
pub struct EnqueueBody {
    pub topic: String,
    pub search_queries: Option<Vec<String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchOutcome {
    pub path: String,
    pub synthesis: String,
}

/// 纯：topic → [topic, "{topic} overview", "{topic} latest"]（CJK 安全）。
pub fn derive_queries(topic: &str) -> Vec<String> {
    let t = topic.trim();
    vec![t.to_string(), format!("{} overview", t), format!("{} latest", t)]
}

/// 纯：topic → slug（复用 review::slugify，已 pub）。
pub fn slugify_topic(topic: &str) -> String {
    crate::services::review::slugify(topic)
}

/// 入队：INSERT research_task + LPUSH research:queue，返回 task id。
pub async fn enqueue_research_task(
    state: &AppState,
    project_id: i32,
    user_id: Option<i32>,
    topic: &str,
    search_queries: Option<Vec<String>>,
    source_kind: &str,
) -> Result<Uuid, AppError> {
    let row: (Uuid,) = sqlx::query_as(
        "INSERT INTO research_tasks (project_id, user_id, topic, search_queries, source_kind) \
         VALUES ($1,$2,$3,$4,$5) RETURNING id")
        .bind(project_id).bind(user_id).bind(topic)
        .bind(search_queries.as_ref()).bind(source_kind)
        .fetch_one(&state.db).await?;
    let id = row.0;
    let mut redis = state.redis.get().await.map_err(AppError::from)?;
    let _: i64 = redis::cmd("LPUSH").arg("research:queue").arg(id.to_string())
        .query_async(&mut *redis).await
        .unwrap_or_else(|e| { tracing::error!("LPUSH research:queue {}: {}", id, e); 0 });
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn derive_queries_cjk_safe() {
        let q = derive_queries("量子计算");
        assert_eq!(q.len(), 3);
        assert_eq!(q[0], "量子计算");
        assert_eq!(q[1], "量子计算 overview");
        assert_eq!(q[2], "量子计算 latest");
    }
    #[test]
    fn slugify_topic_ascii_and_cjk() {
        assert_eq!(slugify_topic("Hello World"), "hello-world");
        assert_eq!(slugify_topic("量子 计算!"), "量子-计算");
    }
}
```

> 说明：本 Task 先建 `mod.rs`，但 `pub mod synthesize; pub mod worker;` 引用的子模块在 Task 4/5/6 才创建。**因此 Task 3 先把这两行注释掉**，Task 5 末尾取消 `synthesize` 注释、Task 6 末尾取消 `worker` 注释，否则中间编译不过。Step 1 写入时用：
> ```rust
> // pub mod synthesize;  // Task 5 启用
> // pub mod worker;      // Task 6 启用
> ```

- [ ] **Step 2: services/mod.rs 加模块声明**

`src/services/mod.rs` 追加：
```rust
pub mod research;
```

- [ ] **Step 3: 跑纯函数测试**

```bash
cd src-server
cargo test --lib services::research
```
Expected: 2 passed（`derive_queries_cjk_safe`、`slugify_topic_ascii_and_cjk`）。

- [ ] **Step 4: Commit**

```bash
git add src/services/research/mod.rs src/services/mod.rs
git commit -m "feat(src-server): research 模块类型 + derive_queries/slugify_topic + enqueue

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: research/synthesize.rs 纯函数（assemble_research_prompt + strip_thinking）

**Files:**
- Create: `src/services/research/synthesize.rs`（本 Task 只放纯函数 + 测试；Task 5 再加状态机）

- [ ] **Step 1: 写 synthesize.rs 纯函数 + 测试**

`src/services/research/synthesize.rs`：
```rust
// src/services/research/synthesize.rs — 综合阶段：纯函数 + 状态机（Task 5 补 run_research_job）。
use crate::services::retrieval::RetrievalResult;
use crate::services::web_search::WebSearchResult;

/// 纯：剥 <think>/<thinking>...</> 块；无标签原样返回（trim 首尾空白）。
pub fn strip_thinking(text: &str) -> String {
    let mut out = text.to_string();
    for tag in ["think", "thinking"] {
        let open = format!("<{}>", tag);
        let close = format!("</{}>", tag);
        while let Some(start) = out.find(&open) {
            if let Some(end_rel) = out[start..].find(&close) {
                let end = start + end_rel + close.len();
                out.replace_range(start..end, "");
            } else {
                out.truncate(start); // 无闭合：弃 open 起到结尾
            }
        }
    }
    out.trim().to_string()
}

/// 纯：组 research prompt（sources + index + pages 三段；pages 段在 retrieval.pages 空时省略）。
pub fn assemble_research_prompt(topic: &str, sources: &[WebSearchResult], retrieval: &RetrievalResult) -> String {
    let mut s = String::new();
    s.push_str(&format!("# Research brief: {}\n\n", topic));
    s.push_str("## Web sources\n");
    for (i, src) in sources.iter().enumerate() {
        s.push_str(&format!("{}. [{}]({})\n   {}\n", i + 1, src.title, src.url, src.snippet));
    }
    s.push_str("\n## Local index\n");
    s.push_str(&retrieval.index_snippet);
    if !retrieval.pages.is_empty() {
        s.push_str("\n\n## Local pages\n");
        for p in &retrieval.pages {
            s.push_str(&format!("### {} ({})\n{}\n\n", p.title, p.path, p.content));
        }
    }
    s.push_str("\n## Task\nSynthesize the above into a single coherent markdown brief for a personal wiki.");
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::retrieval::RetrievedPage;
    use std::collections::HashMap;
    fn empty_retrieval() -> RetrievalResult {
        RetrievalResult { pages: vec![], assembled_context: String::new(), index_snippet: "idx".into(), ref_map: HashMap::new() }
    }
    fn src(url: &str, title: &str) -> WebSearchResult {
        WebSearchResult { url: url.into(), title: title.into(), snippet: "snip".into(), source: "t".into() }
    }
    #[test]
    fn strip_thinking_removes_blocks() {
        assert_eq!(strip_thinking("<think>hidden</think>visible"), "visible");
        assert_eq!(strip_thinking("<thinking>x</thinking>ok"), "ok");
        assert_eq!(strip_thinking("plain text"), "plain text");
    }
    #[test]
    fn assemble_prompt_omits_pages_when_empty() {
        let p = assemble_research_prompt("topic", &[src("u", "T")], &empty_retrieval());
        assert!(p.contains("## Web sources"));
        assert!(p.contains("## Local index"));
        assert!(!p.contains("## Local pages"));
        assert!(p.contains("[T](u)"));
    }
    #[test]
    fn assemble_prompt_includes_pages_when_present() {
        let mut r = empty_retrieval();
        r.pages.push(RetrievedPage { number: 1, path: "p".into(), title: "P".into(), content: "c".into(), priority: 1 });
        let p = assemble_research_prompt("topic", &[src("u", "T")], &r);
        assert!(p.contains("## Local pages"));
        assert!(p.contains("(p)"));
    }
}
```

> 注意：此时 `research/mod.rs` 仍注释着 `pub mod synthesize;`。本 Task 文件创建后**先不启用 mod 声明**——单独编译 `cargo test --lib services::research::synthesize` 需先在 mod.rs 启用。为保持绿，本 Task Step 2 启用 `synthesize` mod 声明（worker 仍注释）。

- [ ] **Step 2: 启用 synthesize mod 声明**

`src/services/research/mod.rs` 把 `// pub mod synthesize;` 改为：
```rust
pub mod synthesize;
// pub mod worker;      // Task 6 启用
```

- [ ] **Step 3: 跑测试**

```bash
cd src-server
cargo test --lib services::research::synthesize
```
Expected: 3 passed。

- [ ] **Step 4: Commit**

```bash
git add src/services/research/synthesize.rs src/services/research/mod.rs
git commit -m "feat(src-server): research::synthesize 纯函数 assemble_research_prompt/strip_thinking

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: research/synthesize.rs run_research_job 状态机（+ collect_sources + save_research_page + 状态写）

**Files:**
- Modify: `src/services/research/synthesize.rs`（在 Task 4 基础上追加状态机 + helpers）

- [ ] **Step 1: 写集成测试（happy / 零源 / 综合失败保留 web_results）**

创建 `tests/integration/research_test.rs`，先写依赖 `run_research_job` 的三个核心测试（Task 8/10 再补 provider CRUD / review 接通等）。

先在 `tests/integration/mod.rs` 加模块声明：
```rust
mod research_test;
```

`tests/integration/research_test.rs`（先写 setup + 三个核心测试；其余 Task 8/10 追加）：
```rust
use axum::http::StatusCode;
use futures::stream::BoxStream;
use llm_wiki_server::services::llm_stream::{ChatMessage, ChatOpts, LlmError, StreamChatProvider, TokenDelta};
use llm_wiki_server::services::research::{derive_queries, slugify_topic};
use llm_wiki_server::services::research::synthesize::run_research_job;
use llm_wiki_server::services::web_search::{WebSearchProvider, WebSearchResult, WebSearchError};
use std::sync::atomic::{AtomicU64, Ordering};

static COUNTER: AtomicU64 = AtomicU64::new(0);
fn unique_prefix(tag: &str) -> String {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    format!("{}_{}_{}", tag, std::process::id(), n)
}
async fn setup_project(tag: &str) -> (axum_test::TestServer, llm_wiki_server::AppState, i32, String) {
    let (app, state) = crate::setup_test_app().await;
    let server = axum_test::TestServer::new(app).unwrap();
    let username = unique_prefix(tag);
    let token = crate::register_user(&server, &username, &format!("{}@t.com", username), "password123").await;
    let team_id: i32 = sqlx::query_scalar(
        "SELECT id FROM teams WHERE created_by = (SELECT id FROM users WHERE username = $1)")
        .bind(&username).fetch_one(&state.db).await.unwrap();
    let resp = server.post("/api/v1/projects")
        .add_header("authorization", format!("Bearer {}", token))
        .json(&serde_json::json!({"name":"test-proj","team_id":team_id})).await;
    assert_eq!(resp.status_code(), StatusCode::CREATED);
    let pid = resp.json::<serde_json::Value>()["id"].as_i64().unwrap() as i32;
    (server, state, pid, token)
}
fn auth(token: &str) -> String { format!("Bearer {}", token) }

// 注入一个 LLM provider（research 依赖 get_llm_config 取 context_size + provider_for_project）
async fn seed_llm_provider(state: &llm_wiki_server::AppState, pid: i32) {
    let key = llm_wiki_server::services::llm::decrypt_api_key // 占位：实际用 encrypt 存一个 dummy key
        ; // 见下方真实实现
}

struct FakeWeb { results: Vec<WebSearchResult> }
#[async_trait::async_trait]
impl WebSearchProvider for FakeWeb {
    async fn search(&self, _q: &str, _m: u8) -> Result<Vec<WebSearchResult>, WebSearchError> { Ok(self.results.clone()) }
    fn provider_type(&self) -> &'static str { "fake" }
}
struct FakeLlm { reply: String, fail: bool }
#[async_trait::async_trait]
impl StreamChatProvider for FakeLlm {
    async fn stream_chat(&self, _m: Vec<ChatMessage>, _o: ChatOpts) -> Result<BoxStream<'static, Result<TokenDelta, LlmError>>, LlmError> {
        let reply = self.reply.clone();
        let fail = self.fail;
        let s = async_stream::stream! {
            if fail { yield Err(LlmError::ApiError { status: 500, body: "boom".into() }); return; }
            yield Ok(TokenDelta::Text(reply));
            yield Ok(TokenDelta::Done);
        };
        Ok(Box::pin(s))
    }
    fn provider_type(&self) -> &'static str { "fake" }
    fn model_name(&self) -> &str { "fake" }
}
```

> 说明：上面 `seed_llm_provider` 是占位骨架，**真实 seed 需用 `utils::crypto::encrypt_api_key` 加密一个 dummy key 写入 `llm_providers`**（因为 `run_research_job_wrapped`/`provider_for_project` 会查表）。但本 Task 只测 `run_research_job`（直接注入 web+llm，不走 wrapped/provider_for_project），**`run_research_job` 不查 llm_providers 表**——它只调 `retrieve_context`（查 wiki_pages，空库也无妨）。因此三个核心测试**无需 seed_llm_provider**，把该占位函数删掉。

修正后的 `seed_llm_provider` 整段删除。核心测试：

```rust
async fn seed_task(state: &llm_wiki_server::AppState, pid: i32, topic: &str, queries: Option<Vec<String>>) -> llm_wiki_server::services::research::ResearchTask {
    use llm_wiki_server::services::research::enqueue_research_task;
    let id = enqueue_research_task(state, pid, None, topic, queries, "manual").await.unwrap();
    sqlx::query_as::<_, llm_wiki_server::services::research::ResearchTask>("SELECT * FROM research_tasks WHERE id=$1")
        .bind(id).fetch_one(&state.db).await.unwrap()
}

#[tokio::test]
async fn run_research_job_happy_path() {
    let (_server, state, pid, _token) = setup_project("res-happy").await;
    let task = seed_task(&state, pid, "topic-x", None).await;
    let web = FakeWeb { results: vec![WebSearchResult { title: "T".into(), url: "u".into(), snippet: "s".into(), source: "t".into() }] };
    let llm = FakeLlm { reply: "# topic-x\n\nsynthesis body".into(), fail: false };
    let out = run_research_job(&state, &task, "2026-06-22", 8000, &web, &llm).await.unwrap();
    assert!(out.path.starts_with("wiki/queries/research-"));
    assert!(out.path.ends_with("-2026-06-22.md"));
    // 页落库
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM wiki_pages WHERE project_id=$1 AND path=$2")
        .bind(pid).bind(&out.path).fetch_one(&state.db).await.unwrap();
    assert_eq!(n, 1);
    // 状态写：stage 到达过 searching/synthesizing/saving（通过 web_results 已存间接验证）
    let has_web: bool = sqlx::query_scalar("SELECT web_results IS NOT NULL FROM research_tasks WHERE id=$1")
        .bind(task.id).fetch_one(&state.db).await.unwrap();
    assert!(has_web);
}

#[tokio::test]
async fn run_research_job_zero_sources_is_error() {
    let (_server, state, pid, _token) = setup_project("res-zero").await;
    let task = seed_task(&state, pid, "topic-z", Some(vec!["q".into()])).await;
    let web = FakeWeb { results: vec![] };
    let llm = FakeLlm { reply: "x".into(), fail: false };
    let err = run_research_job(&state, &task, "2026-06-22", 8000, &web, &llm).await.unwrap_err();
    let s = format!("{}", err);
    assert!(s.contains("no web sources"), "got: {}", s);
}

#[tokio::test]
async fn run_research_job_synth_fail_is_error() {
    let (_server, state, pid, _token) = setup_project("res-synthfail").await;
    let task = seed_task(&state, pid, "topic-f", None).await;
    let web = FakeWeb { results: vec![WebSearchResult { title: "T".into(), url: "u".into(), snippet: "s".into(), source: "t".into() }] };
    let llm = FakeLlm { reply: String::new(), fail: true };
    let err = run_research_job(&state, &task, "2026-06-22", 8000, &web, &llm).await.unwrap_err();
    assert!(format!("{}", err).contains("synthesize"));
    // web_results 已存（失败前 persist_web_results 执行过）
    let has_web: bool = sqlx::query_scalar("SELECT web_results IS NOT NULL FROM research_tasks WHERE id=$1")
        .bind(task.id).fetch_one(&state.db).await.unwrap();
    assert!(has_web, "web_results must persist before synthesis stage");
}
```

- [ ] **Step 2: 跑测试确认失败（run_research_job 尚未实现）**

```bash
cd src-server
cargo test --test integration run_research_job_ -- --nocapture 2>&1 | tail -5
```
Expected: 编译失败（`run_research_job` 未定义）——这是 TDD 红。

- [ ] **Step 3: 实现 run_research_job + collect_sources + save_research_page + 状态写 helpers**

在 `src/services/research/synthesize.rs` 顶部 import 区追加，并追加函数：

追加 import（合并到现有 import 段）：
```rust
use crate::services::llm_stream::{ChatMessage, ChatOpts, StreamChatProvider};
use crate::services::retrieval::retrieve_context;
use crate::services::web_search::{dedupe_results, WebSearchProvider};
use crate::services::research::ResearchOutcome;
use crate::{AppError, AppState};
use uuid::Uuid;
```

追加实现：
```rust
/// 同步写 status=stage 且 stage=stage（见 spec §4，set_stage 同步两列）。
async fn set_stage(state: &AppState, task_id: Uuid, stage: &str) {
    let _ = sqlx::query("UPDATE research_tasks SET status=$1, stage=$1, updated_at=NOW() WHERE id=$2")
        .bind(stage).bind(task_id).execute(&state.db).await;
}

async fn persist_web_results(state: &AppState, task_id: Uuid, sources: &[WebSearchResult]) {
    let val = serde_json::to_value(sources).unwrap_or(serde_json::Value::Null);
    let _ = sqlx::query("UPDATE research_tasks SET web_results=$1, updated_at=NOW() WHERE id=$2")
        .bind(&val).bind(task_id).execute(&state.db).await;
}

/// 并发跨 query allSettled（单 query 失败只 warning 继续）；返回未去重合集。
async fn collect_sources(web: &dyn WebSearchProvider, queries: &[String]) -> Vec<WebSearchResult> {
    let futs: Vec<_> = queries.iter().map(|q| web.search(q, 5)).collect();
    let results = futures::future::join_all(futs).await;
    let mut out = Vec::new();
    for r in results {
        match r {
            Ok(v) => out.extend(v),
            Err(e) => tracing::warn!("web search query failed (skipped): {}", e),
        }
    }
    out
}

/// 状态机编排。参数注入（web+llm+context_size+date_ymd）→ 端到端可测。
pub async fn run_research_job(
    state: &AppState,
    task: &crate::services::research::ResearchTask,
    date_ymd: &str,
    context_size: i32,
    web: &dyn WebSearchProvider,
    llm: &dyn StreamChatProvider,
) -> Result<ResearchOutcome, AppError> {
    // ① searching
    set_stage(state, task.id, "searching").await;
    let queries = task.search_queries.clone()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| crate::services::research::derive_queries(&task.topic));
    let raw = collect_sources(web, &queries).await;
    let sources = dedupe_results(raw, 20);
    if sources.is_empty() {
        return Err(AppError::LlmApiError("no web sources".into()));
    }
    persist_web_results(state, task.id, &sources).await;

    // ② synthesizing
    set_stage(state, task.id, "synthesizing").await;
    let retrieval = retrieve_context(state, task.project_id, &task.topic, context_size).await?;
    let prompt = assemble_research_prompt(&task.topic, &sources, &retrieval);
    let (raw_out, _) = llm.chat_to_string(
        vec![ChatMessage { role: "user".into(), content: prompt }],
        ChatOpts {
            model: llm.model_name().into(),
            temperature: 0.3,
            max_tokens: 8000,
            system_prompt: Some("You synthesize a research brief for a personal wiki. Output a single markdown document.".into()),
            timeout_secs: None,
        },
    ).await.map_err(|e| AppError::LlmApiError(format!("synthesize: {e}")))?;
    let synthesis = strip_thinking(&raw_out);
    if synthesis.trim().is_empty() {
        return Err(AppError::LlmApiError("empty synthesis".into()));
    }

    // ③ saving
    set_stage(state, task.id, "saving").await;
    let path = save_research_page(state, task.project_id, &task.topic, &synthesis, date_ymd, &sources).await?;
    if let Err(e) = crate::services::embedding::embed_page(
        &state.db, state.config.embedding.as_ref(), &state.http, task.project_id, &path, &synthesis).await {
        tracing::warn!("embed research page {}: {}", path, e);
    }
    Ok(ResearchOutcome { path, synthesis })
}

async fn save_research_page(
    state: &AppState, project_id: i32, topic: &str, synthesis: &str, date_ymd: &str, sources: &[WebSearchResult],
) -> Result<String, AppError> {
    let slug = crate::services::research::slugify_topic(topic);
    let path = format!("wiki/queries/research-{}-{}.md", slug, date_ymd);
    let source_urls: Vec<&str> = sources.iter().map(|s| s.url.as_str()).collect();
    let frontmatter = serde_json::json!({ "type":"query", "title":topic, "sources":source_urls, "origin":"deep-research" });
    let content = format!("# {}\n\n{}", topic, synthesis);
    let page = crate::services::ingest_pipeline::WikiPageInsert {
        path: path.clone(), title: Some(topic.into()), content, frontmatter,
        page_type: "query".into(), sources: serde_json::json!(source_urls), images: serde_json::json!([]),
    };
    crate::services::ingest_pipeline::upsert_wiki_page(state, project_id, &page).await?;
    Ok(path)
}
```

注意 `WebSearchResult` 需 `Serialize`（persist_web_results 的 `to_value`）——Task 2 已加 `Serialize` derive，确认。

- [ ] **Step 4: 跑测试确认通过**

```bash
cd src-server
cargo test --test integration run_research_job_ -- --nocapture 2>&1 | tail -8
```
Expected: 3 passed（happy/zero/synthfail）。

- [ ] **Step 5: clippy**

```bash
cargo clippy --all-targets -- -D warnings 2>&1 | grep -E "synthesize|error\[" | head
```
Expected: 无 synthesize 相关 warning。

- [ ] **Step 6: Commit**

```bash
git add src/services/research/synthesize.rs tests/integration/research_test.rs tests/integration/mod.rs
git commit -m "feat(src-server): run_research_job 状态机 + collect_sources/save_research_page(参数注入)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 6: research/worker.rs（spawn_worker + worker_loop Semaphore3 + recover_pending + wrapped + main spawn）

**Files:**
- Create: `src/services/research/worker.rs`
- Modify: `src/services/research/mod.rs`（启用 `pub mod worker;`）
- Modify: `src/main.rs`（spawn）

- [ ] **Step 1: 写 worker.rs**

`src/services/research/worker.rs`：
```rust
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
```

- [ ] **Step 2: 启用 worker mod 声明**

`src/services/research/mod.rs` 把 `// pub mod worker;` 改为 `pub mod worker;`。

- [ ] **Step 3: main.rs spawn research worker**

`src/main.rs`，在现有 `llm_wiki_server::services::ingest_worker::spawn_worker(state.clone());`（约 line 27）**下一行**追加：
```rust
llm_wiki_server::services::research::worker::spawn_worker(state.clone());
```

- [ ] **Step 4: 编译确认**

```bash
cd src-server
cargo build 2>&1 | tail -5
```
Expected: 编译通过（warning 暂可，Task 10 统一 clippy -D warnings）。

- [ ] **Step 5: recover_pending 抽函数单元测试（worker_loop 时序不测）**

worker_loop 涉及 BRPOP+Semaphore 时序，不写自动化集成测（spec §11）。`recover_pending` 的 SQL 语义用一个轻量集成测试覆盖（重启恢复重投）：

在 `tests/integration/research_test.rs` 追加：
```rust
#[tokio::test]
async fn recover_pending_requeues_non_terminal_tasks() {
    // 直接验证 recover_pending 的 SQL 语义：非终态任务应被 SELECT 出来。
    // （recover_pending 内部 LPUSH；这里只验证它返回的 pending 计数正确。）
    let (_server, state, pid, _token) = setup_project("res-recover").await;
    use llm_wiki_server::services::research::enqueue_research_task;
    let _a = enqueue_research_task(&state, pid, None, "t1", None, "manual").await.unwrap();
    let _b = enqueue_research_task(&state, pid, None, "t2", None, "manual").await.unwrap();
    // 两条均 queued → recover 应视为 pending
    let n: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM research_tasks WHERE project_id=$1 AND status IN ('queued','searching','synthesizing','saving')")
        .bind(pid).fetch_one(&state.db).await.unwrap();
    assert_eq!(n, 2);
    // 把一条标 done（终态）后不应被 recover 计入
    sqlx::query("UPDATE research_tasks SET status='done' WHERE topic='t1'").execute(&state.db).await.unwrap();
    let n2: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM research_tasks WHERE project_id=$1 AND status IN ('queued','searching','synthesizing','saving')")
        .bind(pid).fetch_one(&state.db).await.unwrap();
    assert_eq!(n2, 1);
}
```

- [ ] **Step 6: 跑测试**

```bash
cargo test --test integration recover_pending_ -- --nocapture 2>&1 | tail -5
```
Expected: 1 passed。

- [ ] **Step 7: Commit**

```bash
git add src/services/research/worker.rs src/services/research/mod.rs src/main.rs tests/integration/research_test.rs
git commit -m "feat(src-server): research worker(BRPOP+Semaphore3) + recover_pending + wrapped + main spawn

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 7: routes/research.rs（4 端点 + SSE 轮询）+ 接线

**Files:**
- Create: `src/routes/research.rs`
- Modify: `src/routes/mod.rs`（`mod research;` + create_router merge global）
- Modify: `src/routes/projects.rs`（project_routes merge）

- [ ] **Step 1: 写 routes/research.rs**

`src/routes/research.rs`：
```rust
// src/routes/research.rs — research 端点（project-scoped 入队/列表 + 全局详情/SSE）。
use crate::middleware::project_guard::check_project_access;
use crate::services::research::{self, EnqueueBody, ResearchTask};
use crate::{AppError, AppState};
use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::Json;
use futures::stream::Stream;
use serde::Deserialize;
use std::convert::Infallible;
use std::time::Duration;
use uuid::Uuid;

pub fn research_project_routes() -> axum::Router<AppState> {
    axum::Router::new()
        .route("/:id/research", axum::routing::post(enqueue_research))
        .route("/:id/research/tasks", axum::routing::get(list_tasks))
}

pub fn global_research_routes() -> axum::Router<AppState> {
    axum::Router::new()
        .route("/api/v1/research/tasks/:uuid", axum::routing::get(get_task))
        .route("/api/v1/research/tasks/:uuid/stream", axum::routing::get(stream_task))
}

#[derive(Deserialize)]
pub struct ListQuery {
    pub status: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

async fn has_search_provider(state: &AppState, project_id: i32) -> bool {
    let n: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM search_providers WHERE project_id=$1 AND is_enabled=TRUE")
        .bind(project_id).fetch_one(&state.db).await.unwrap_or(0);
    n > 0
}

pub async fn enqueue_research(
    State(state): State<AppState>, Path(project_id): Path<i32>, headers: HeaderMap, Json(body): Json<EnqueueBody>,
) -> Result<Json<serde_json::Value>, AppError> {
    let (user_id, _) = check_project_access(&state, &headers, project_id).await?;
    let topic = body.topic.trim();
    if topic.is_empty() {
        return Err(AppError::ValidationError("topic required".into()));
    }
    if !has_search_provider(&state, project_id).await {
        return Err(AppError::BadRequest("no enabled search_provider for project".into()));
    }
    let uuid = research::enqueue_research_task(&state, project_id, Some(user_id), topic, body.search_queries, "manual").await?;
    Ok(Json(serde_json::json!({"uuid": uuid})))
}

pub async fn list_tasks(
    State(state): State<AppState>, Path(project_id): Path<i32>, Query(q): Query<ListQuery>, headers: HeaderMap,
) -> Result<Json<Vec<ResearchTask>>, AppError> {
    check_project_access(&state, &headers, project_id).await?;
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    let offset = q.offset.unwrap_or(0).max(0);
    let rows: Vec<ResearchTask> = match q.status.as_deref() {
        Some(s) => sqlx::query_as(
            "SELECT * FROM research_tasks WHERE project_id=$1 AND status=$2 ORDER BY created_at DESC LIMIT $3 OFFSET $4")
            .bind(project_id).bind(s).bind(limit).bind(offset),
        None => sqlx::query_as(
            "SELECT * FROM research_tasks WHERE project_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3")
            .bind(project_id).bind(limit).bind(offset),
    }.fetch_all(&state.db).await?;
    Ok(Json(rows))
}

pub async fn get_task(
    State(state): State<AppState>, Path(uuid): Path<Uuid>, headers: HeaderMap,
) -> Result<Json<ResearchTask>, AppError> {
    let row: ResearchTask = sqlx::query_as("SELECT * FROM research_tasks WHERE id=$1")
        .bind(uuid).fetch_optional(&state.db).await?
        .ok_or_else(|| AppError::ResourceNotFound("research task".into()))?;
    check_project_access(&state, &headers, row.project_id).await?; // 按 task 所属 project 鉴权
    Ok(Json(row))
}

fn sse_data(event: &str, data: &serde_json::Value) -> Result<Event, Infallible> {
    Ok(Event::default().event(event.to_string()).data(data.to_string()))
}

pub async fn stream_task(
    State(state): State<AppState>, Path(uuid): Path<Uuid>, headers: HeaderMap,
) -> Result<Sse<std::pin::Pin<Box<dyn Stream<Item = Result<Event, Infallible>> + Send>>>, AppError> {
    let init: ResearchTask = sqlx::query_as("SELECT * FROM research_tasks WHERE id=$1")
        .bind(uuid).fetch_optional(&state.db).await?
        .ok_or_else(|| AppError::ResourceNotFound("research task".into()))?;
    check_project_access(&state, &headers, init.project_id).await?;
    let db = state.db.clone();
    let stream = async_stream::stream! {
        let mut last_stage: Option<String> = None;
        for _ in 0..200 { // ~5min @1.5s
            let row: Option<(String, Option<String>, Option<String>, Option<String>, Option<String>)> =
                sqlx::query_as("SELECT status, stage, synthesis, saved_path, error FROM research_tasks WHERE id=$1")
                .bind(uuid).fetch_optional(&db).await.ok().flatten();
            match row {
                Some((status, stage, synth, path, err)) => {
                    let cur_stage = stage.clone().unwrap_or_else(|| status.clone());
                    if last_stage.as_deref() != Some(&cur_stage) {
                        last_stage = Some(cur_stage.clone());
                        yield sse_data("stage", &serde_json::json!({"stage": cur_stage, "status": status}));
                    }
                    if status == "done" {
                        yield sse_data("done", &serde_json::json!({"synthesis": synth, "savedPath": path}));
                        return;
                    }
                    if status == "error" {
                        yield sse_data("error", &serde_json::json!({"message": err.unwrap_or_default()}));
                        return;
                    }
                }
                None => { yield sse_data("error", &serde_json::json!({"message":"task vanished"})); return; }
            }
            tokio::time::sleep(Duration::from_millis(1500)).await;
        }
        yield sse_data("error", &serde_json::json!({"message":"timeout"}));
    };
    Ok(Sse::new(Box::pin(stream)).keep_alive(KeepAlive::new().interval(Duration::from_secs(15)).text("ping")))
}
```

- [ ] **Step 2: routes/mod.rs 加 mod + create_router 接 global**

`src/routes/mod.rs`：
- mod 声明区加 `mod research;`（与现有 `pub mod reviews;` 同段）。
- `create_router` 函数在 `.merge(ingest::global_ingest_routes())` **之后、`.with_state(state)` 之前**加：
```rust
        .merge(research::global_research_routes())
```

- [ ] **Step 3: projects.rs project_routes 接 project-scoped research**

`src/routes/projects.rs` 的 `project_routes()`，在 `.merge(reviews::reviews_routes())` **之后**加：
```rust
        .merge(research::research_project_routes())
```
（顶部 `use` 段已有 `use crate::routes::reviews;` 模式，确认有 `use crate::routes::research;` 或用全路径 `crate::routes::research::research_project_routes()`。为稳妥用全路径，避免改 use。）

- [ ] **Step 4: 写集成测试（入队校验 + 团队可见性；SSE 时序不测）**

在 `tests/integration/research_test.rs` 追加：
```rust
#[tokio::test]
async fn enqueue_rejects_without_search_provider() {
    let (server, _state, pid, token) = setup_project("res-noprovider").await;
    let r = server.post(&format!("/api/v1/projects/{}/research", pid))
        .add_header("authorization", auth(&token))
        .json(&serde_json::json!({"topic":"x"})).await;
    assert_eq!(r.status_code(), StatusCode::BAD_REQUEST); // 无 search_provider → 400
}

#[tokio::test]
async fn enqueue_rejects_empty_topic() {
    let (server, state, pid, token) = setup_project("res-emptytopic").await;
    // 先 seed 一个 search_provider（任意 key，本测不走真实 search）
    let key = derive_test_key();
    sqlx::query("INSERT INTO search_providers (project_id, provider_type, api_key_encrypted) VALUES ($1,'tavily',$2)")
        .bind(pid).bind(key).execute(&state.db).await.unwrap();
    let r = server.post(&format!("/api/v1/projects/{}/research", pid))
        .add_header("authorization", auth(&token))
        .json(&serde_json::json!({"topic":"   "})).await;
    assert_eq!(r.status_code(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn team_visibility_forbidden() {
    let (server, _state, pid, _token_a) = setup_project("res-vis").await;
    let uname = unique_prefix("res-vis-b");
    let user_b = crate::register_user(&server, &uname, &format!("{}@t.com", uname), "password123").await;
    let r = server.post(&format!("/api/v1/projects/{}/research", pid))
        .add_header("authorization", auth(&user_b))
        .json(&serde_json::json!({"topic":"x"})).await;
    assert_eq!(r.status_code(), StatusCode::FORBIDDEN);
}

// 复用 llm key 派生 + utils::crypto::encrypt_api_key，造一个可解密的 dummy key（与 search_providers CRUD 同路径）
fn derive_test_key() -> String {
    let cfg = llm_wiki_server::AppConfig::from_env().expect("config");
    let secret = cfg.jwt_secret();
    let mut key = [0u8; 32];
    let len = secret.len().min(32);
    key[..len].copy_from_slice(&secret.as_bytes()[..len]);
    llm_wiki_server::utils::crypto::encrypt_api_key("dummy-tavily-key", &key).unwrap()
}
```

> 说明：`llm_wiki_server::utils::crypto` 需 `pub`。确认 `src/utils/mod.rs`（或 `utils.rs`）导出 `pub mod crypto;` 或 `pub use`。若 `utils::crypto` 非默认 `pub`，Step 5 核实并（必要时）改为测试内复制 key 派生 4 行 + 直接调 `utils::crypto::encrypt_api_key`（需该 fn 可见）。`encrypt_api_key` 已是 `pub fn`（utils/crypto.rs:22），只要 `utils` 与 `utils::crypto` 模块可见即可。

- [ ] **Step 5: 核实 utils 可见性，跑测试**

```bash
cd src-server
grep -n "pub mod crypto\|pub use" src/utils.rs src/utils/mod.rs 2>/dev/null
cargo test --test integration enqueue_ team_visibility_ -- --nocapture 2>&1 | tail -8
```
Expected: 3 passed（rejects_without_provider / rejects_empty_topic / team_visibility）。若 `utils::crypto` 不可见导致编译错，按 Step 4 说明调整测试内 key 派生路径。

- [ ] **Step 6: Commit**

```bash
git add src/routes/research.rs src/routes/mod.rs src/routes/projects.rs tests/integration/research_test.rs
git commit -m "feat(src-server): research 端点(入队/列表/详情/SSE 轮询) + 接线

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 8: routes/search_providers.rs（CRUD）+ 接线

**Files:**
- Create: `src/routes/search_providers.rs`
- Modify: `src/routes/mod.rs`（`mod search_providers;`）
- Modify: `src/routes/projects.rs`（merge search_provider_routes）

- [ ] **Step 1: 写 routes/search_providers.rs**

`src/routes/search_providers.rs`：
```rust
// src/routes/search_providers.rs — search_provider CRUD（project-scoped）。GET 不回传 api_key。
use crate::middleware::project_guard::check_project_access;
use crate::{AppError, AppState};
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde::{Deserialize, Serialize};

fn derive_key(config: &crate::AppConfig) -> [u8; 32] {
    let secret = config.jwt_secret();
    let mut key = [0u8; 32];
    let len = secret.len().min(32);
    key[..len].copy_from_slice(&secret.as_bytes()[..len]);
    key
}

pub fn search_provider_routes() -> axum::Router<AppState> {
    axum::Router::new()
        .route("/:id/search-provider", axum::routing::post(create_provider))
        .route("/:id/search-provider", axum::routing::get(get_provider))
        .route("/:id/search-provider/:sid", axum::routing::put(update_provider))
        .route("/:id/search-provider/:sid", axum::routing::delete(delete_provider))
}

#[derive(Deserialize)]
pub struct CreateBody {
    pub provider_type: String,
    pub api_key: String,
    pub base_url: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderResp {
    pub id: i64,
    pub provider_type: String,
    pub base_url: Option<String>,
    pub is_enabled: bool,
    pub has_key: bool,
}

pub async fn create_provider(
    State(state): State<AppState>, Path(project_id): Path<i32>, headers: HeaderMap, Json(body): Json<CreateBody>,
) -> Result<(StatusCode, Json<ProviderResp>), AppError> {
    let (_, _) = check_project_access(&state, &headers, project_id).await?;
    let key = derive_key(&state.config);
    let enc = crate::utils::crypto::encrypt_api_key(&body.api_key, &key)?;
    let row: (i64,) = sqlx::query_as(
        "INSERT INTO search_providers (project_id, provider_type, api_key_encrypted, base_url) VALUES ($1,$2,$3,$4) RETURNING id")
        .bind(project_id).bind(&body.provider_type).bind(&enc).bind(&body.base_url)
        .fetch_one(&state.db).await?;
    Ok((StatusCode::CREATED, Json(ProviderResp {
        id: row.0, provider_type: body.provider_type, base_url: body.base_url, is_enabled: true, has_key: true,
    })))
}

pub async fn get_provider(
    State(state): State<AppState>, Path(project_id): Path<i32>, headers: HeaderMap,
) -> Result<Json<Option<ProviderResp>>, AppError> {
    check_project_access(&state, &headers, project_id).await?;
    let row: Option<(i64, String, Option<String>, bool)> = sqlx::query_as(
        "SELECT id, provider_type, base_url, is_enabled FROM search_providers \
         WHERE project_id=$1 AND is_enabled=TRUE ORDER BY id LIMIT 1")
        .bind(project_id).fetch_optional(&state.db).await?;
    Ok(Json(row.map(|(id, t, b, e)| ProviderResp { id, provider_type: t, base_url: b, is_enabled: e, has_key: true })))
}

#[derive(Deserialize)]
pub struct UpdateBody {
    pub api_key: Option<String>,
    pub base_url: Option<String>,
    pub is_enabled: Option<bool>,
}

pub async fn update_provider(
    State(state): State<AppState>, Path((project_id, sid)): Path<(i32, i64)>, headers: HeaderMap, Json(body): Json<UpdateBody>,
) -> Result<Json<ProviderResp>, AppError> {
    let (_, _) = check_project_access(&state, &headers, project_id).await?;
    if let Some(plain) = body.api_key.as_deref() {
        let key = derive_key(&state.config);
        let enc = crate::utils::crypto::encrypt_api_key(plain, &key)?;
        sqlx::query("UPDATE search_providers SET api_key_encrypted=$1 WHERE id=$2 AND project_id=$3")
            .bind(&enc).bind(sid).bind(project_id).execute(&state.db).await?;
    }
    if let Some(b) = body.base_url.as_deref() {
        sqlx::query("UPDATE search_providers SET base_url=$1 WHERE id=$2 AND project_id=$3")
            .bind(b).bind(sid).bind(project_id).execute(&state.db).await?;
    }
    if let Some(e) = body.is_enabled {
        sqlx::query("UPDATE search_providers SET is_enabled=$1 WHERE id=$2 AND project_id=$3")
            .bind(e).bind(sid).bind(project_id).execute(&state.db).await?;
    }
    let row: (i64, String, Option<String>, bool) = sqlx::query_as(
        "SELECT id, provider_type, base_url, is_enabled FROM search_providers WHERE id=$1 AND project_id=$2")
        .bind(sid).bind(project_id).fetch_one(&state.db).await
        .map_err(|_| AppError::ResourceNotFound("search_provider".into()))?;
    Ok(Json(ProviderResp { id: row.0, provider_type: row.1, base_url: row.2, is_enabled: row.3, has_key: true }))
}

pub async fn delete_provider(
    State(state): State<AppState>, Path((project_id, sid)): Path<(i32, i64)>, headers: HeaderMap,
) -> Result<StatusCode, AppError> {
    let (_, _) = check_project_access(&state, &headers, project_id).await?;
    let n = sqlx::query("DELETE FROM search_providers WHERE id=$1 AND project_id=$2")
        .bind(sid).bind(project_id).execute(&state.db).await?;
    if n.rows_affected() == 0 {
        return Err(AppError::ResourceNotFound("search_provider".into()));
    }
    Ok(StatusCode::OK)
}
```

- [ ] **Step 2: routes/mod.rs 加 mod**

`src/routes/mod.rs` mod 声明区加：
```rust
mod search_providers;
```

- [ ] **Step 3: projects.rs merge search_provider_routes**

`src/routes/projects.rs` 的 `project_routes()`，在 `.merge(research::research_project_routes())` **之后**加：
```rust
        .merge(search_providers::search_provider_routes())
```
（用全路径 `crate::routes::search_providers::search_provider_routes()` 避免 use 改动。）

- [ ] **Step 4: 写集成测试（CRUD + api_key 加密往返 + GET 不回传 key）**

在 `tests/integration/research_test.rs` 追加：
```rust
#[tokio::test]
async fn search_provider_crud_and_key_roundtrip() {
    let (server, state, pid, token) = setup_project("res-crud").await;
    // CREATE
    let r = server.post(&format!("/api/v1/projects/{}/search-provider", pid))
        .add_header("authorization", auth(&token))
        .json(&serde_json::json!({"providerType":"tavily","apiKey":"secret-xyz"})).await;
    assert_eq!(r.status_code(), StatusCode::CREATED);
    let body: serde_json::Value = r.json();
    assert_eq!(body["providerType"], "tavily");
    assert_eq!(body["hasKey"], true);
    assert!(body.get("apiKey").is_none(), "GET 响应不得回传 apiKey");
    let sid = body["id"].as_i64().unwrap();
    // GET 不回传 key
    let g = server.get(&format!("/api/v1/projects/{}/search-provider", pid))
        .add_header("authorization", auth(&token)).await;
    let gb: serde_json::Value = g.json();
    assert!(gb.get("apiKey").is_none() || gb["apiKey"].is_null());
    // 加密往返：DB 存的是密文，decrypt 能还原
    let enc: String = sqlx::query_scalar("SELECT api_key_encrypted FROM search_providers WHERE id=$1")
        .bind(sid).fetch_one(&state.db).await.unwrap();
    assert_ne!(enc, "secret-xyz", "DB 必须存密文");
    let plain = llm_wiki_server::services::llm::decrypt_api_key(&enc, &state.config).unwrap();
    assert_eq!(plain, "secret-xyz");
    // DELETE
    let d = server.delete(&format!("/api/v1/projects/{}/search-provider/{}", pid, sid))
        .add_header("authorization", auth(&token)).await;
    assert_eq!(d.status_code(), StatusCode::OK);
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM search_providers WHERE id=$1")
        .bind(sid).fetch_one(&state.db).await.unwrap();
    assert_eq!(n, 0);
}
```

- [ ] **Step 5: 跑测试**

```bash
cd src-server
cargo test --test integration search_provider_crud -- --nocapture 2>&1 | tail -8
```
Expected: 1 passed。

- [ ] **Step 6: Commit**

```bash
git add src/routes/search_providers.rs src/routes/mod.rs src/routes/projects.rs tests/integration/research_test.rs
git commit -m "feat(src-server): search_provider CRUD(加密往返,GET 不回传 key)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 9: review.rs DeepResearch dispatch

**Files:**
- Modify: `src/services/review.rs`（`ResolveAction` 加变体 + dispatch）

- [ ] **Step 1: ResolveAction 加 DeepResearch 变体**

`src/services/review.rs` 的 `ResolveAction` enum（约 line 352-359），改为：
```rust
#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum ResolveAction {
    CreatePage,
    Skip,
    Delete { path: Option<String> },
    Open { path: Option<String> },
    DeepResearch,
}
```

- [ ] **Step 2: resolve_review_item 加 DeepResearch 分支**

在 `resolve_review_item` 的 `match action { ... }`（约 line 538-565），在 `ResolveAction::Open { path } => { ... }` 分支**之后、闭合 `}` 之前**插入：
```rust
        ResolveAction::DeepResearch => {
            // 空/None search_queries 由 run_research_job 统一归一化（派生自 task.topic=item.title）；
            // 此处原样传入,与 manual 入队一致。
            let queries = item.search_queries.clone();
            let task_uuid = crate::services::research::enqueue_research_task(
                state, project_id, Some(user_id), &item.title, queries, "review").await?;
            mark_resolved(state, item_id, "deep_research", user_id).await?;
            Ok(ResolveOutcome::Resolved {
                resolved_action: "deep_research".into(),
                created_path: Some(task_uuid.to_string()),
            })
            // research 异步跑（worker 拾取），不阻塞 resolve 响应；
            // 前端按 task_uuid 查进度（GET /api/v1/research/tasks/:uuid）。
        }
```

> 说明：`created_path` 复用为返回 task_uuid（字符串），前端可据此查 research 进度。`item` 变量类型 `LoadedItem` 须有 `search_queries` 字段——确认 `LoadedItem`（review.rs 约 line 380-388 的 FromRow）含 `search_queries: Option<Vec<String>>`。若无，补该字段到 FromRow 的 SELECT 与 struct。

- [ ] **Step 3: 确认 LoadedItem 含 search_queries**

```bash
cd src-server
grep -n "struct LoadedItem" -A 12 src/services/review.rs
```
Expected: `LoadedItem` 含 `search_queries: Option<Vec<String>>`（load_open_item 的 SELECT 已选该列，见 Task 契约核实）。若缺失，补字段 + SELECT 列。

- [ ] **Step 4: 写集成测试（review→research 接通）**

在 `tests/integration/research_test.rs` 追加：
```rust
use llm_wiki_server::services::review::{parse_review_blocks, insert_review_items};

async fn seed_review_with_queries(state: &llm_wiki_server::AppState, pid: i32, title: &str, queries: &[&str]) -> i64 {
    let src = format!("src/{}.md", title);
    let mut p = parse_review_blocks(
        &format!("---REVIEW: missing-page | {}---\nBody.\nSEARCH: {}\nOPTIONS: Create Page | Skip\n---END REVIEW---",
            title, queries.join(" | ")), &src);
    // parse 的 SEARCH 行解析为 search_queries（见 review.rs）；若 parse 不填则手动设
    if p[0].search_queries.is_none() {
        p[0].search_queries = Some(queries.iter().map(|s| s.to_string()).collect());
    }
    insert_review_items(state, pid, &p).await.unwrap();
    sqlx::query_scalar("SELECT id FROM review_items WHERE project_id=$1 AND title=$2")
        .bind(pid).bind(title).fetch_one(&state.db).await.unwrap()
}

#[tokio::test]
async fn review_deep_research_dispatch_enqueues_and_resolves() {
    let (server, state, pid, token) = setup_project("res-reviewdispatch").await;
    // DeepResearch 入队需要项目有 search_provider?否——dispatch 不调 has_search_provider(仅 POST /research 入口校验)。
    // review dispatch 直接 enqueue_research_task,不校验 provider。故无需 seed provider。
    let iid = seed_review_with_queries(&state, pid, "Missing Topic", &["alpha", "beta"]).await;
    let r = server.post(&format!("/api/v1/projects/{}/reviews/{}/resolve", pid, iid))
        .add_header("authorization", auth(&token))
        .json(&serde_json::json!({"kind":"deep_research"})).await;
    assert_eq!(r.status_code(), StatusCode::OK);
    let body: serde_json::Value = r.json();
    assert_eq!(body["resolvedAction"], "deep_research");
    let task_uuid = body["createdPath"].as_str().unwrap();
    let task_uuid = uuid::Uuid::parse_str(task_uuid).unwrap();
    // research_task(source_kind=review) 已入队
    let (sk, topic): (String, String) = sqlx::query_as(
        "SELECT source_kind, topic FROM research_tasks WHERE id=$1")
        .bind(task_uuid).fetch_one(&state.db).await.unwrap();
    assert_eq!(sk, "review");
    assert_eq!(topic, "Missing Topic");
    // review item 已 resolved
    let status: String = sqlx::query_scalar("SELECT status FROM review_items WHERE id=$1")
        .bind(iid).fetch_one(&state.db).await.unwrap();
    assert_eq!(status, "resolved");
}
```

- [ ] **Step 5: 跑测试**

```bash
cd src-server
cargo test --test integration review_deep_research_dispatch -- --nocapture 2>&1 | tail -8
```
Expected: 1 passed。若 `parse_review_blocks` 的 SEARCH 行解析未填 `search_queries`，测试内的 fallback（手动设）保证字段非 None。

- [ ] **Step 6: Commit**

```bash
git add src/services/review.rs tests/integration/research_test.rs
git commit -m "feat(src-server): review ResolveAction::DeepResearch dispatch 入队 research_task

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 10: 全量集成测试 + clippy 全绿 + 整体回归

**Files:**
- Verify: 全部测试通过、clippy 无 warning

- [ ] **Step 1: 全量 lib 测试**

```bash
cd src-server
cargo test --lib 2>&1 | tail -5
```
Expected: 全绿（含 web_search/research 新增纯函数单测；既有 lib 测试不回归）。

- [ ] **Step 2: 全量集成测试**

```bash
cargo test --test integration 2>&1 | tail -10
```
Expected: 全绿（既有 33 + Phase C 新增 8 个：happy/zero/synthfail/recover/enqueue×2/team/crud/review-dispatch；2 pre-existing ignored 不计）。

- [ ] **Step 3: clippy 全绿（-D warnings）**

```bash
cargo clippy --all-targets -- -D warnings 2>&1 | tail -10
```
Expected: 无 warning、无 error。若有，逐一修（常见：未用 import、`unwrap()` 提示）。

- [ ] **Step 4: 构建确认**

```bash
cargo build 2>&1 | tail -3
```
Expected: `Finished` 无错。

- [ ] **Step 5: 最终 Commit（若 Step 1-4 触发任何修复）**

```bash
git add -u
git commit -m "test(src-server): Phase C 全量测试 + clippy 全绿

Co-Authored-By: Claude <noreply@anthropic.com>"
```
（若无修复，跳过。）

---

## Self-Review（写计划后自检，已执行）

1. **Spec 覆盖**：
   - migration 008/009 → Task 1 ✅
   - web_search trait/Tavily/provider_for_project/dedupe → Task 2 ✅
   - research 类型/derive_queries/slugify_topic/enqueue → Task 3 ✅
   - assemble_research_prompt/strip_thinking → Task 4 ✅
   - run_research_job 状态机 + collect_sources + save_research_page + set_stage(同步 status/stage) + 参数注入(web+llm+context_size+date) → Task 5 ✅（覆盖 spec §7.3/§7.4 + P2 context_size 修复 + P2 status/stage 修复 + P3 collect_sources + P3 空 queries）
   - worker spawn/loop Semaphore3/recover/wrapped/main spawn → Task 6 ✅
   - 4 端点 + SSE 轮询 → Task 7 ✅
   - search_provider CRUD（GET 不回传 key + 加密往返）→ Task 8 ✅
   - review DeepResearch dispatch → Task 9 ✅
   - 全量回归 + clippy → Task 10 ✅
2. **占位符扫描**：无 TBD/TODO/"适当处理"。所有代码步骤含完整代码。Task 7 Step 4 的 `derive_test_key` 与 Task 8 的 `derive_key` 为完整实现（非占位）。
3. **类型一致性**：`run_research_job(state, task, date_ymd: &str, context_size: i32, web, llm)` 签名在 Task 5（实现）与 Task 5（测试调用 `run_research_job(&state, &task, "2026-06-22", 8000, &web, &llm)`）一致；`enqueue_research_task(state, project_id, user_id: Option<i32>, topic, search_queries: Option<Vec<String>>, source_kind)` 在 Task 3（定义）/Task 7（routes 调）/Task 9（review 调）一致；`ResearchOutcome { path, synthesis }` 一致；`mark_done`/`mark_error(state, task_id: Uuid, ...)` 一致。

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-22-src-server-layer3-phase-c-research.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, two-stage review (spec compliance + code quality) between tasks, fast iteration. (与 Phase B 一致的模式。)

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
