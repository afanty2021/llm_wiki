← [设计文档索引](../)

# src-server Layer 3 Phase B 设计：审核系统（Review）

> **Date**: 2026-06-21 · **Status**: Draft (待 review) · **Type**: 子系统详细设计
> **Scope**: src-server 审核系统（异步人机协作）—— 摄取期生成 review、团队共享队列、resolve action 执行
> **Related**: [Layer 3 总览](2026-06-21-src-server-layer3-chat-review-research-design.md) §7、§12 Phase B · [Phase A 计划](../plans/2026-06-21-layer3-phase-a-chat.md) · [ingest pipeline 设计](2026-06-19-src-server-ingest-design.md)

---

## 1. 背景与依赖

Layer 3 总览已定架构（方案 B：共享层 + 子系统组合）与多用户归属（**审核队列项目级团队共享**）。Phase A 建好了共享层（`citations`/`retrieval`，复用既有 `llm_stream`）与 Chat 子系统。

**Phase B = 审核系统**：把桌面版 `parseReviewBlocks` + review action 工作流移植到服务端。**关键事实**（探索确认）：

- 服务端 ingest **目前不产生 REVIEW 块** —— `services/prompts/step2_generate.txt` 无相关指令。Phase B **必须**给该 prompt 增补 review 块指令。
- `services/ingest_pipeline.rs::parse_file_blocks`（行 71-140）是 FILE 块解析的姐妹函数；`parse_review_blocks` 与之并列。
- `process_source_path`（行 457-530）在 `step2_generate` 之后处理 LLM 输出 —— review 挂钩点。
- `upsert_wiki_page(state, project_id, &WikiPageInsert)`（行 538-563）是可复用的建页函数 → `create_page` action 直接用（需提为 `pub(crate)`）。
- `delete_page` 路由（`routes/pages.rs:253-273`）含 embedding 清理，graph 缓存按时间戳自动失效 → `delete` action 复用同款 SQL。
- 桌面参考：`src/lib/ingest.ts::parseReviewBlocks`（行 1633-1694）、`src/components/review/review-view.tsx`（action 处理）、`buildReviewSuggestionPrompt`（行 1928-1985，dedicated review stage）。

## 2. 范围

**包含（最小集 + dedicated review stage）**：
1. `step2_generate.txt` 增补 REVIEW 块指令 + `parse_review_blocks` 解析 + 摄取期存储 `review_items`
2. dedicated review stage（第 3 次 LLM 调用，移植 `buildReviewSuggestionPrompt`）—— 当生成量大时额外产出高价值 review
3. reviews 路由（list / resolve / dismiss）+ action 执行器（`create_page` / `skip` / `delete` / `open`）

**不包含（YAGNI / 延后）**：
- `deep_research` action —— Phase C 建 research 子系统后接入；`review_items.search_queries` 字段已存好待用
- `save:<base64>` action —— 桌面特有，并入 `create_page`
- 桌面 fuzzy 字符串匹配 —— 服务端用结构化 action 枚举
- 跨摄取去重（re-ingest 同源可能再生同类 review）—— 用户可 dismiss；仅做 step2+dedicated 的批内去重

## 3. 关键设计决策

| 决策 | 取值 | 依据 |
|------|------|------|
| review 生成源 | step2 输出 + dedicated review stage | 服务端当前无，必须新增 |
| 模块结构 | 独立 `services/review.rs`（方案 A） | 纯函数可测、action 集中、ingest 不膨胀 |
| resolve API | 结构化 `ResolveAction` 枚举 | 比桌面 fuzzy 干净，无歧义 |
| OPTIONS | 限定 `Create Page \| Skip`（prompt 约束） | 对齐桌面 |
| review_type 归一化 | contradiction/duplicate/missing-page/suggestion，未知→`confirm` | 移植桌面 |
| create_page embedding | 触发（best-effort） | 比桌面更对齐 ingest，成本低 |
| resolved_by | `ON DELETE SET NULL` | 对齐 `ingest_jobs.created_by` |
| 队列归属 | project-scoped 团队共享 | 总览已确认 |
| dedicated stage 触发 | ≥10K 字 / ≥4 file 块 / 含 `---REVIEW:` | 移植桌面阈值 |

## 4. 数据模型 — migration `007_review_items.sql`

```sql
-- 007_review_items.sql — Layer 3 Phase B: 审核队列（项目级团队共享）
CREATE TABLE review_items (
    id              BIGSERIAL PRIMARY KEY,
    uuid            UUID UNIQUE NOT NULL DEFAULT gen_random_uuid(),
    project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    source_path     TEXT,                  -- 生成该项的源文件
    review_type     TEXT NOT NULL,         -- contradiction|duplicate|missing-page|confirm|suggestion
    title           TEXT NOT NULL,
    description     TEXT NOT NULL,
    affected_pages  TEXT[],                -- wiki 路径
    search_queries  TEXT[],                -- 预生成（供 Phase C deep research 复用）
    options         JSONB NOT NULL,        -- ReviewOption[{label, action}]，供前端渲染按钮
    status          TEXT NOT NULL DEFAULT 'open',  -- open|resolved|dismissed
    resolved_action TEXT,
    resolved_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,  -- 对齐 ingest_jobs.created_by
    resolved_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_review_open ON review_items(project_id, status, created_at);
```

> 服务端 wiki 内容存 Postgres `wiki_pages` 表（path 为逻辑列）。create_page/delete action 操作的是该表行，非文件系统。

## 5. 模块结构（方案 A）

| 文件 | 职责 | 新/改 |
|------|------|-------|
| `services/review.rs` | 类型 + `parse_review_blocks()`(纯) + `insert_review_items()` + `run_dedicated_review_stage()` + `should_run_dedicated_review_stage()` + `fetch_overview()`/`fetch_index_snippet()`(读 reserved wiki_pages 行) + `resolve_review_item()`(调度) + `detect_page_type()` + `page_type_to_dir()` + `slugify()` + action 执行器 | 新建 |
| `routes/reviews.rs` | `GET /:id/reviews`、`POST /:id/reviews/:iid/resolve`、`POST /:id/reviews/:iid/dismiss`、`reviews_routes()` | 新建 |
| `services/mod.rs` | `pub mod review;` | 改 |
| `routes/mod.rs` | `pub mod reviews;` | 改 |
| `routes/projects.rs` | `.merge(reviews::reviews_routes())` | 改 |
| `services/prompts/step2_generate.txt` | 追加 REVIEW 块指令 | 改 |
| `services/prompts/step3_review.txt` | dedicated review stage prompt | 新建 |
| `services/ingest_pipeline.rs` | `process_source_path` 计算 reviews 入 `ProcessedSource.reviews`（compute-only）；`run_ingest_job` 页落库后插 review；`upsert_wiki_page`/`WikiPageInsert` 提 `pub(crate)` | 改 |
| `migrations/007_review_items.sql` | review_items 表 | 新建 |
| `tests/integration/reviews_test.rs` | parse/CRUD/action/团队可见性测试 | 新建 |

## 6. resolve API 契约

review_item 的 `options`（LLM label，如 "Create Page"|"Skip"）**仅供前端渲染按钮**；resolve 端点接收结构化枚举：

```rust
// POST /api/v1/projects/:id/reviews/:iid/resolve
#[derive(Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum ResolveAction {
    CreatePage,
    Skip,
    Delete { path: Option<String> },  // 缺省取 affected_pages[0]
    Open { path: Option<String> },    // 缺省取 affected_pages[0]；不 resolve
}

pub enum ResolveOutcome {
    Resolved { resolved_action: String, created_path: Option<String> }, // 200
    Opened { page: PageSnippet },                                       // 200，item 仍 open
}
// PageSnippet = { path: String, title: String, content: String }
```
- `deep_research` **不在 Phase B 枚举**（Phase C 加）；`search_queries` 已存好
- `Open` 唯一不 resolve（预览后另选）
- `resolved_by` 记操作者 user_id

## 7. step2 prompt 改造 + parse_review_blocks + ingest 挂钩

### 7.1 `step2_generate.txt` 末尾追加

```text
## Review blocks (optional, after all FILE blocks)

After all FILE blocks, optionally emit REVIEW blocks for anything needing human judgment.

Review types:
- contradiction: analysis found conflicts with existing wiki content
- duplicate: an entity/concept may already exist under a different name
- missing-page: an important concept is referenced but has no dedicated page
- suggestion: ideas for further research or connections worth exploring

Only emit reviews that genuinely need human input. Don't create trivial reviews.

OPTIONS: only use "Create Page" and "Skip" (the system adds a Deep Research action automatically).
For suggestion/missing-page, include a SEARCH line with 2-3 keyword-rich web search queries.

REVIEW block template:
---REVIEW: suggestion | Precise title---
Description of what needs the user's attention.
OPTIONS: Create Page | Skip
PAGES: wiki/page1.md, wiki/page2.md
SEARCH: query 1 | query 2 | query 3
---END REVIEW---
```

### 7.2 `parse_review_blocks()` — 纯函数状态机（code-fence 感知，与 `parse_file_blocks` 同款）

```rust
#[derive(Debug, Clone)]
pub struct ParsedReview {
    pub review_type: String,             // 归一化: contradiction|duplicate|missing-page|confirm|suggestion
    pub title: String,
    pub description: String,             // body 去掉 OPTIONS/PAGES/SEARCH 行
    pub source_path: Option<String>,
    pub affected_pages: Option<Vec<String>>,
    pub search_queries: Option<Vec<String>>,
    pub options: Vec<ReviewOption>,      // {label, action:label}
}
pub fn parse_review_blocks(text: &str, source_path: &str) -> Vec<ParsedReview> { /* 状态机 */ }
```
逐行扫描：`---REVIEW:` 开头 + `---` 结尾 → `split_once('|')` 取 type|Title；遇 `---END REVIEW---` 闭合。body 内解析 `OPTIONS:`(split `|`)、`PAGES:`(split `,`)、`SEARCH:`(split `|`)；类型归一化（未知→`confirm`）；缺 OPTIONS 默认 `[Create Page, Skip]`；description = body 去掉那三行。**纯函数，单测**。

### 7.3 reviews 计算与持久化（守 process_source_path 的 deferred-write 不变量）

`process_source_path` 的契约是**只计算、返回 `ProcessedSource`，持久化全部延迟到 `run_ingest_job`**（页 upsert 成功、`all_upserted` 后才 `mark_file_ingested`，见 ingest_pipeline.rs:24-26 / 374-391）。**reviews 的 DB 写同样必须延迟**，否则页 upsert 失败时会留下孤儿 review，且因文件未 mark 而重处理→重复 review（§13 又省了跨摄取去重）。

因此：reviews 在 `process_source_path` 内**计算**（parse + dedicated，均无 DB 写），随 `ProcessedSource` 返回；由 `run_ingest_job` 在页 upsert 循环成功后插入。

```rust
// process_source_path 内（compute-only）：
let llm_output = step2_generate(state, project_id, &text, &step1_result).await?;
let blocks = parse_file_blocks(&llm_output);
let mut reviews = crate::services::review::parse_review_blocks(&llm_output, source_path);
let mut dedicated = crate::services::review::run_dedicated_review_stage(
    state, project_id, source_path, &text, &step1_result, &llm_output).await?;
reviews.append(&mut dedicated);
let mut seen: HashSet<(String, String)> = HashSet::new();
reviews.retain(|r| seen.insert((r.review_type.clone(), r.title.clone()))); // 批内 (type,title) 去重
Ok(Some(ProcessedSource { pages, reviews, content_hash, file_size, file_type }))
```

```rust
// run_ingest_job 内，页 upsert 循环成功（all_upserted=true）后、与 mark_file_ingested 同处：
if !processed.reviews.is_empty() {
    if let Err(e) = crate::services::review::insert_review_items(
        state, job.project_id, &processed.reviews).await {
        result.warnings.push(format!("insert reviews for {}: {}", sp, e)); // 不阻断
    }
}
```
> `ProcessedSource` 增字段 `reviews: Vec<ParsedReview>`（ingest_pipeline 私有结构，增字段无外部影响）。如此：页 upsert 失败 → 不 mark_file_ingested → 不插 review → 下次重处理不产生孤儿/重复。

## 8. dedicated review stage（第 3 次 LLM 调用）

### 8.1 触发条件

```rust
const REVIEW_STAGE_MIN_SIGNAL_CHARS: usize = 10_000;
const REVIEW_STAGE_MIN_FILE_BLOCKS: usize = 4;
fn should_run_dedicated_review_stage(generation: &str) -> bool {
    generation.chars().count() >= REVIEW_STAGE_MIN_SIGNAL_CHARS
        || count_file_blocks(generation) >= REVIEW_STAGE_MIN_FILE_BLOCKS
        || generation.contains("---REVIEW:")
}
```

### 8.2 新建 `services/prompts/step3_review.txt`（移植 buildReviewSuggestionPrompt 指令）

```text
You are identifying high-value follow-up research items for a personal wiki.
Do not output chain-of-thought, hidden reasoning, or explanatory preamble.

Your job is NOT to generate wiki pages. Generation already happened.
Output only REVIEW blocks for unresolved knowledge gaps that deserve human attention.

Create REVIEW blocks only for genuinely useful follow-up work:
- missing-page: an important entity/concept referenced but lacking a dedicated page
- suggestion: a research question, source type, or comparison that would materially improve the wiki
- contradiction: a conflict or tension requiring user judgment
- duplicate: likely duplicate pages/names needing review

Prefer 1-5 high-signal reviews. If nothing is worth reviewing, output nothing.
For suggestion/missing-page, include a SEARCH line with 2-3 keyword-rich web queries separated by ` | `.
Use only: OPTIONS: Create Page | Skip

REVIEW block template:
---REVIEW: suggestion | Precise title---
Concise description of the gap and why it matters.
OPTIONS: Create Page | Skip
PAGES: wiki/page1.md, wiki/page2.md
SEARCH: query 1 | query 2 | query 3
---END REVIEW---

Return REVIEW blocks only. No FILE blocks. Do not wrap in markdown fences.
```
上下文段（Wiki Purpose / Index / Source / Analysis / Source Context / Generated Output）由 Rust 注入，各段裁剪到固定上限（6000 字符，`trim_to` helper）。

### 8.3 `run_dedicated_review_stage()` + ingest 合并去重

```rust
pub async fn run_dedicated_review_stage(
    state: &AppState, project_id: i32, source_path: &str,
    source_text: &str, step1_json: &serde_json::Value, step2_output: &str,
) -> Result<Vec<ParsedReview>, AppError> {
    if !should_run_dedicated_review_stage(step2_output) { return Ok(vec![]); }
    let provider = crate::services::llm_stream::provider_for_project(state, project_id).await?;
    let purpose = fetch_overview(state, project_id).await.unwrap_or_default();
    let index = fetch_index_snippet(state, project_id).await;
    let prompt = include_str!("../services/prompts/step3_review.txt");
    // ... 组装 user msg（各段 trim_to 6000）...
    let opts = ChatOpts { model: provider.model_name().into(), temperature: 0.4, max_tokens: 8000,
        system_prompt: Some("You identify high-value follow-up review items. Output REVIEW blocks only.".into()), timeout_secs: None };
    let (out, _) = provider.chat_to_string(messages, opts).await
        .map_err(|e| AppError::LlmApiError(format!("dedicated review stage: {e}")))?;
    Ok(parse_review_blocks(&out, source_path))
}
```
`fetch_overview` / `fetch_index_snippet` 定义（读 `rebuild_reserved_pages` 写的 reserved 行）：
```rust
// 读 wiki/overview.md / wiki/index.md 行内容；不存在（首次摄取前）→ None → unwrap_or_default()
async fn fetch_overview(state: &AppState, project_id: i32) -> Option<String> {
    sqlx::query_scalar::<_, Option<String>>(
        "SELECT content FROM wiki_pages WHERE project_id=$1 AND path='wiki/overview.md'")
        .bind(project_id).fetch_optional(&state.db).await.ok().flatten().flatten()
}
async fn fetch_index_snippet(state: &AppState, project_id: i32) -> String {
    sqlx::query_scalar::<_, Option<String>>(
        "SELECT content FROM wiki_pages WHERE project_id=$1 AND path='wiki/index.md'")
        .bind(project_id).fetch_optional(&state.db).await.ok().flatten().flatten().unwrap_or_default()
}
```
> `run_dedicated_review_stage` 由 `process_source_path` 调用（compute 阶段，仅 LLM 调用无 DB 写）；其返回的 `Vec<ParsedReview>` 与 step2 reviews 合并 + 批内 `(type,title)` 去重（§7.3），最终由 `run_ingest_job` 在页落库后插入。dedicated LLM 出错 → 该函数返回 `Err`，`process_source_path` 记 warning 并以空 dedicated 继续（不阻断摄取）。

## 9. reviews 路由 + resolve action 执行器

### 9.1 路由（`routes/reviews.rs`）

```
GET   /api/v1/projects/:id/reviews?status=open|resolved|dismissed|all   列出审核项
POST  /api/v1/projects/:id/reviews/:iid/resolve     执行 ResolveAction 并 resolve
POST  /api/v1/projects/:id/reviews/:iid/dismiss     驳回
```
全部经 `check_project_access`（团队任意成员可操作）。

### 9.2 `resolve_review_item()` 调度（`services/review.rs`）

```rust
pub async fn resolve_review_item(
    state: &AppState, project_id: i32, user_id: i32, item_id: i64, action: ResolveAction,
) -> Result<ResolveOutcome, AppError> {
    let item = load_open_item(state, project_id, item_id).await?; // 未找到→404；找到但非 open→409
    match action {
        ResolveAction::CreatePage => {
            let path = exec_create_page(state, project_id, &item).await?;
            mark_resolved(state, item_id, "create_page", user_id).await?;
            Ok(ResolveOutcome::Resolved { resolved_action: "create_page".into(), created_path: Some(path) })
        }
        ResolveAction::Skip => { mark_resolved(state, item_id, "skip", user_id).await?;
            Ok(ResolveOutcome::Resolved { resolved_action: "skip".into(), created_path: None }) }
        ResolveAction::Delete { path } => {
            let p = path.or_else(|| item.affected_pages.clone().and_then(|v| v.into_iter().next()))
                .ok_or_else(|| AppError::ValidationError("delete needs a path".into()))?;
            exec_delete_page(state, project_id, &p).await?;
            mark_resolved(state, item_id, "delete", user_id).await?;
            Ok(ResolveOutcome::Resolved { resolved_action: "delete".into(), created_path: None })
        }
        ResolveAction::Open { path } => {
            let p = path.or_else(|| item.affected_pages.clone().and_then(|v| v.into_iter().next()))
                .ok_or_else(|| AppError::ValidationError("open needs a path".into()))?;
            let page = fetch_page(state, project_id, &p).await?;
            Ok(ResolveOutcome::Opened { page })  // 不 resolve
        }
    }
}
```
- `mark_resolved`：`UPDATE review_items SET status='resolved', resolved_action=$, resolved_by=$, resolved_at=NOW() WHERE id=$ AND project_id=$ AND status='open'`；`rows_affected==0` → `409`（并发安全）

### 9.3 action 执行器（复用既有路径）

```rust
/// 单数 page_type（写入 frontmatter `type:` + wiki_pages.page_type 列）
fn detect_page_type(review_type: &str) -> &'static str {
    match review_type { "missing-page" => "concept", "contradiction"|"suggestion" => "query", _ => "query" }
}
/// 复数目录（服务端约定：复数目录 + 单数 page_type，如 concepts/topic.md + type: concept）
fn page_type_to_dir(page_type: &str) -> &'static str {
    match page_type { "entity" => "entities", "concept" => "concepts", _ => "queries" }
}
fn slugify(title: &str) -> String { /* 小写 + 空格→连字符 + 去非字母数字 */ }
```
> create_page 由 `detect_page_type` 得单数 page_type → frontmatter/DB；由 `page_type_to_dir(page_type)` 得复数目录 → path。review 永不映射到 `entity`（无 review_type 对应），故 `entities/` 目录在 create_page 不可达 —— 保留映射仅为对称。

| action | 复用 | 行为 |
|--------|------|------|
| create_page | `ingest_pipeline::upsert_wiki_page`（pub(crate)）+ embedding 服务 | `detect_page_type`(单数 page_type→frontmatter/DB) + `page_type_to_dir`(复数目录) → 建 `wiki/{concepts\|queries}/{slug}.md`，content=`# {title}\n\n{description}`；**路径唯一**：slug 碰撞则追加 `-2`/`-3`（避免覆盖既有页）；upsert 后 best-effort embedding（失败 warning 不阻断） |
| delete | `pages.rs::delete_page` 同款 SQL + `embedding::delete_embedding` | 删 wiki_pages 行 + 清向量；graph 缓存按时间戳自动失效 |
| open | 直查 `wiki_pages` | 返回 `{path,title,content}` |
| skip | — | 仅 `mark_resolved` |

## 10. 错误处理汇总

| 场景 | 处理 |
|------|------|
| 摄取期 parse/insert review 失败 | 记 `warnings`，不阻断摄取 |
| dedicated review stage LLM 失败 | 记 warning，跳过 |
| resolve 不存在的 item | `404 Not Found`（load_open_item 查无） |
| resolve 非 open 项 / 并发竞争 | `409 Conflict`（已被处理，或 load 与 mark 间状态变更） |
| delete/open 缺 path 且无 affected_pages | `400 BadRequest` |
| create_page upsert 失败 | `500`，不 resolve（item 保持 open） |
| create_page embedding 失败 | best-effort warning，仍 resolve |
| delete/open 目标页不存在 | `404` |
| 无项目访问权 | `403`（check_project_access） |

## 11. 测试策略

**纯函数单测**（`services/review.rs` `#[cfg(test)]`）：`parse_review_blocks`（完整块 / 各行解析 / 类型归一化 / 缺 OPTIONS 默认 / 多块 / code fence 内不误判 / 缺 END 容错）、`should_run_dedicated_review_stage`（三阈值分支）、`detect_page_type`、`slugify`、`count_file_blocks`。

**集成测试**（`tests/integration/reviews_test.rs`，自包含 `setup_project`）：摄取生成 review（FakeProvider step2 含 REVIEW 块）/ dedicated 触发与去重 / resolve(create_page) 建页+embed+resolved_by / resolve(skip/delete/open) / 重复 resolve→409 / dismiss / **团队可见性**（A 摄取→B 可 list+resolve）。

## 12. 实现拆分（为 writing-plans 预热）

1. migration `007_review_items.sql` + 验证
2. `services/review.rs`：类型 + `parse_review_blocks`（纯，TDD）+ `insert_review_items`
3. ingest 挂钩：改 `step2_generate.txt` + `process_source_path` 计算 reviews 入 `ProcessedSource.reviews`（compute-only）；`run_ingest_job` 页落库后（`all_upserted`）插 review；`upsert_wiki_page`/`WikiPageInsert` 提 `pub(crate)`
4. dedicated review stage：`step3_review.txt` + `run_dedicated_review_stage` + `should_run_dedicated_review_stage` + 合并去重
5. reviews 路由 + `resolve_review_item` + create_page/delete/open/skip + 接入 `project_routes()`
6. 集成测试 + clippy 全绿

## 13. 待定 / 延后

- `deep_research` action —— Phase C 接入（`search_queries` 已备）
- 跨摄取去重 —— 仅批内去重，re-ingest 再生项由用户 dismiss
- `resolved_by` 显示用户名（当前只存 id）—— 前端按需 join
- review 项的通知/订阅 —— YAGNI
