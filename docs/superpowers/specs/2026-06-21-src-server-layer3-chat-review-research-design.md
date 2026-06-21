← [设计文档索引](../)

# src-server Layer 3 设计总览：Chat / Review / Deep Research

> **Date**: 2026-06-21 · **Status**: Draft (待 review) · **Type**: 架构总览
> **Scope**: src-server（Axum 0.7 + PostgreSQL/pgvector + Redis + tokio）的 Layer 3
> **Related**: [web 架构总览](2026-06-13-llm-wiki-web-architecture-design.md) · [search](2026-06-20-src-server-search-design.md) · [graph](2026-06-20-src-server-graph-design.md) · [insights](2026-06-20-src-server-insights-design.md) · [ingest pipeline](2026-06-19-src-server-ingest-design.md)

---

## 1. 背景与现状

src-server 已分两层建成：

- **Layer 1**：wiki CRUD + 文件存储 + 摄取管线 + 队列 worker。表 `projects / wiki_pages / ingested_files / ingest_jobs`。
- **Layer 2**：混合检索（关键词 + 向量 + RRF，`services/search.rs`）+ 知识图谱（Louvain + 四信号相关性 + insights，`services/graph.rs`）+ BGE-M3 嵌入（`services/embedding.rs`）。

**Layer 3 = 4 个缺口**，本文档为总览设计：

| 子系统 | 现状 | 桌面参考实现 |
|--------|------|-------------|
| Chat w/ wiki context | 有端点但**仅裸 OpenAI SSE 代理**（`POST /api/v1/chat/stream`），无检索/无引用/无记忆 | `src/components/chat/chat-panel.tsx`（4 阶段检索 + 编号引用 `[1][2]` + `<!-- cited:1,3 -->`） |
| 会话持久化 | 完全无状态 | `src/stores/chat-store.ts` + `.llm-wiki/conversations.json` |
| Deep Research | 无 Tavily/任何 web 搜索 | `src/lib/deep-research.ts`（队列并发 3 + LLM 综合 + 存 `wiki/queries/research-*.md`） |
| 审核系统 | 无（仅摄取 job 队列） | `src/stores/review-store.ts` + `ingest.ts::parseReviewBlocks` |

桌面版这 4 个功能均已实现且经过验证。Layer 3 本质是**把桌面设计移植到「服务端 + 多用户 + Postgres + HTTP/SSE」**，而非从零发明。

## 2. 目标与非目标

**目标**
1. Chat 能检索 wiki、组装预算上下文、流式输出、编号引用、多轮会话持久化
2. Review：摄取期生成审核项 → 团队共享队列 → action 执行（可触发 research）
3. Deep Research：Tavily web 搜索 + LLM 综合 + 存 wiki + 自动摄取
4. 三个子系统共享检索/LLM/引用基础设施，零重复实现

**非目标（YAGNI，明确延后）**
- 事件驱动解耦（Redis pub/sub）—— 当前规模过度设计
- Chat 直接触发 Research（"帮我研究这个"）—— 延后，等基础跑通
- Web-search 的 SerpApi/SearXNG/Ollama provider 实现 —— 仅留 trait，先做 Tavily
- 团队级 search_provider 默认回退 —— 先 per-project，需要再加
- 审核项指派/认领（assignee）—— 当前任意成员可处理即足够
- 多模态（图片消息）—— 桌面 chat-store 存消息前剥离图片，服务端先纯文本

## 3. 架构策略：共享契约 + 组合（方案 B）

三个 Layer 3 子系统都需要「检索 wiki + 组装上下文 + 调 LLM」。先抽**共享层**，子系统在其上组合：

```
共享层 services/
  retrieval/      ← 统一 wiki 检索入口（复用 search.rs + graph.rs + 上下文预算组装）
  llm/            ← 统一 LLM 客户端（流式/非流式），chat + research + ingest 共用
  citations/      ← 引用契约（编号 [1][2] + <!-- cited --> 解析 + MessageReference 类型）
  web_search/     ← provider trait（先实现 Tavily）
子系统 routes/services/
  chat/      ← 检索→组装→流式 + 会话持久化
  research/  ← 队列→web_search→LLM综合→存wiki/queries→自动摄取
  review/    ← 摄取LLM输出解析→review_items表→action执行(可触发research)
```

**选型理由**：Layer 2 已把 search.rs/graph.rs 建成可复用 service；把检索/上下文/引用抽成共享层可避免方案 A（桌面忠实移植）的三份重复；多用户权限在共享层 + 路由钩一次最干净；单元边界清晰，每个 service 独立可测。

## 4. 关键设计决策（默认值，review 可推翻）

| 决策 | 取值 | 依据 |
|------|------|------|
| 引用格式 | `[1][2]` + `<!-- cited:1,3 -->` 解析 | 桌面/服务端一致 |
| Chat 检索深度 | 完整 4 阶段（分词→图扩展→预算→组装） | search/graph service 已存在 |
| 上下文预算 | 5% index / 50% pages / 15% response reserve / 单页上限 30% | 照搬桌面 `context-budget.ts` |
| 历史消息窗口 | 最近 10 条 | 对齐桌面 `maxHistoryMessages` |
| 单会话消息上限 | 100 | 对齐桌面 |
| Web-search provider | Tavily 优先，走 trait | 用户明确指定 + YAGNI |
| Web-search 配置作用域 | per-project（镜像 `llm_providers`） | 现有模式一致 |
| 会话归属 | per-user 私有 | 已确认 |
| 审核队列归属 | per-project 团队共享 | 已确认 |
| 裸 `/api/v1/chat/stream` | 保留为低级透传 | 不破坏既有调用方 |

## 5. 共享层

### 5.1 新增 Postgres 表

> 服务端 wiki 内容存在 Postgres `wiki_pages` 表（`path` 为逻辑列，如 `wiki/queries/research-*.md`），**不是文件系统**。下文所有"建 wiki 页 / 存 wiki/queries/..."均指**插入/更新 `wiki_pages` 行**（含 frontmatter、page_type、sources、触发 embedding）。migration 按实现阶段拆分，每阶段一个：
>
> - `006_chat_sessions.sql`（表 ①，Phase A）
> - `007_review_items.sql`（表 ②，Phase B）
> - `008_research_tasks.sql`（表 ③，Phase C）
> - `009_search_providers.sql`（表 ④，Phase C）

```sql
-- ① 会话私有（chat 子系统）
CREATE TABLE chat_conversations (
  id          BIGSERIAL PRIMARY KEY,
  uuid        UUID UNIQUE NOT NULL,
  project_id  INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- ← 私有归属
  title       TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_chat_conv_owner ON chat_conversations(project_id, user_id, updated_at DESC);

CREATE TABLE chat_messages (
  id               BIGSERIAL PRIMARY KEY,
  uuid             UUID UNIQUE NOT NULL,
  conversation_id  BIGINT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  role             TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
  content          TEXT NOT NULL,
  refs             JSONB,    -- MessageReference[]（命名避开 SQL 保留字 REFERENCES）
  citations        INT[],    -- 从 <!-- cited:1,3 --> 解析出的页码
  retrieval_ctx    JSONB,    -- 快照：本次检索命中的页（调试/重放用）
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_chat_msg_conv ON chat_messages(conversation_id, created_at);

-- ② 审核团队共享（review 子系统）
CREATE TABLE review_items (
  id              BIGSERIAL PRIMARY KEY,
  uuid            UUID UNIQUE NOT NULL,
  project_id      INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_path     TEXT,              -- 生成该项的源文件
  review_type     TEXT NOT NULL,     -- contradiction|duplicate|missing-page|confirm|suggestion
  title           TEXT NOT NULL,
  description     TEXT NOT NULL,
  affected_pages  TEXT[],            -- wiki 路径
  search_queries  TEXT[],            -- 预生成（供 deep-research 复用）
  options         JSONB NOT NULL,    -- ReviewOption[{label, action}]
  status          TEXT NOT NULL DEFAULT 'open',  -- open|resolved|dismissed
  resolved_action TEXT,
  resolved_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,  -- 对齐 ingest_jobs.created_by
  resolved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_review_open ON review_items(project_id, status, created_at);

-- ③ Deep research 任务（research 子系统）
CREATE TABLE research_tasks (
  id             BIGSERIAL PRIMARY KEY,
  uuid           UUID UNIQUE NOT NULL,
  project_id     INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,  -- 触发者；删用户保留产物(对齐 ingest_jobs.created_by)
  topic          TEXT NOT NULL,
  search_queries TEXT[],
  status         TEXT NOT NULL DEFAULT 'queued',  -- queued|searching|synthesizing|saving|done|error
  web_results    JSONB,        -- WebSearchResult[]
  synthesis      TEXT,         -- LLM 综合输出
  saved_path     TEXT,         -- wiki/queries/research-*.md
  source_kind    TEXT,         -- manual|graph_insight|review|chat
  error          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_research_status ON research_tasks(project_id, status, created_at);

-- ④ Web-search provider 配置（per-project，镜像 llm_providers）
CREATE TABLE search_providers (
  id                BIGSERIAL PRIMARY KEY,
  project_id        INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  provider_type     VARCHAR(50) NOT NULL,   -- tavily（预留 serpapi/searxng/ollama）
  api_key_encrypted TEXT NOT NULL,          -- 复用 services/llm.rs::decrypt_api_key(&str)（与 llm_providers 同路径）
  base_url          TEXT,
  is_enabled        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_search_providers_project ON search_providers(project_id);
CREATE INDEX idx_search_providers_enabled ON search_providers(project_id) WHERE is_enabled = TRUE;
```

### 5.2 共享 service

| service | 职责 | 使用者 | 复用现状 |
|--------|------|--------|---------|
| `services/retrieval/` | 统一 wiki 检索 + 上下文组装（4 阶段：hybrid_search→图扩展→预算填充→编号组装）→ `RetrievalResult` | chat、research 综合 | 复用 `search.rs` + `graph.rs`，把桌面 `chat-panel.tsx` 检索逻辑抽成可复用 service |
| `services/llm/` | 统一 LLM 客户端：`chat_stream()`(SSE) + `chat_to_string()`(综合) + 共享消息类型/reasoning 处理 | chat、research、ingest | **整合**现有 `services/llm.rs`(80 行) + `llm_stream.rs`，消除三处重复 |
| `services/citations/` | 引用契约：`MessageReference` 类型 + `parse_cited()` + 编号组装 helper | chat、research | 新建，照搬桌面格式 |
| `services/web_search/` | `trait WebSearchProvider` + `TavilyProvider` + `provider_for_project()` | research | 新建，Tavily 优先 |

### 5.3 关键契约类型

```rust
// citations/
pub struct MessageReference {
    pub title: String,
    pub path: Option<String>,     // wiki 页路径（external 时 None）
    pub kind: RefKind,            // Wiki | External
    pub url: Option<String>,
    pub snippet: Option<String>,
}

// retrieval/
pub struct RetrievedPage {
    pub number: usize,            // 引用编号 [1]
    pub path: String,
    pub title: String,
    pub content: String,
    pub priority: u8,             // P0 标题命中 / P1 内容 / P2 图扩展 / P3 overview 兜底
}
pub struct RetrievalResult {
    pub pages: Vec<RetrievedPage>,
    pub assembled_context: String,  // "### [1] Title\nPath:..\n\n{content}" 拼接
    pub index_snippet: String,      // wiki index（预算 5%）
    pub ref_map: HashMap<usize, MessageReference>,  // 编号→引用，供 cited 解析后查
}

// web_search/
pub struct WebSearchResult { pub title: String, pub url: String, pub snippet: String, pub source: String }
```

### 5.4 多用户权限钩子

- 所有路由复用现有 **project guard** 中间件（鉴权 + 项目访问权）
- **chat 路由**额外按 JWT 的 `user_id` 过滤 `chat_conversations`（私有）
- **review / research 路由**仅 project-scoped（团队共享，任何有项目权限成员可操作）

## 6. 子系统 1 · Chat（wiki 上下文 + 会话持久化）

### 6.1 端点

```
GET    /api/v1/projects/:id/chat/conversations                  列出当前用户会话(私有)
POST   /api/v1/projects/:id/chat/conversations                  建会话
GET    /api/v1/projects/:id/chat/conversations/:cid/messages    取消息(最近100,分页)
DELETE /api/v1/projects/:id/chat/conversations/:cid             删会话(级联消息)
POST   /api/v1/projects/:id/chat/conversations/:cid/stream      ★ RAG 流式问答(SSE)
```

### 6.2 RAG 流式数据流

```
JWT→user_id + project_guard→project_id
  ├─ 加载会话 + 最近 10 条历史(对齐桌面 maxHistoryMessages)
  ├─ retrieval::retrieve_context(project_id, 用户消息, 预算)   ← 复用共享层(4阶段)
  │     hybrid_search → 图扩展 → 预算填充 → 编号组装 [1][2]
  ├─ 组装 system prompt: 目的 + wiki index(5%) + 命中页 + 引用指令 + 语言指令
  ├─ messages = [system, history..., 用户消息]
  ├─ llm::chat_stream(provider, messages) → SSE 推 token
  │     事件: retrieval(先推命中页,供前端展示引用) | token | done | error
  ├─ 流结束 → citations::parse_cited("<!-- cited:1,3 -->") → citations[]
  │            → 经 ref_map 解析为 MessageReference[]
  └─ 持久化: user消息 + assistant消息(content/refs/citations/retrieval_ctx)
              + 会话 updated_at + 自动标题(首条用户消息前50字)
```

### 6.3 错误处理

- LLM provider 4xx/5xx → SSE `error` 事件 + 日志
- 检索为空 → 无上下文继续（优雅降级）
- 流中断 → **丢弃部分输出**（对齐桌面：仅流完成才存，避免脏数据）

### 6.4 测试

- `retrieval` / `citations` 单测（mock search/graph）
- SSE 集成测试注入假 `LlmClient` 吐固定 token
- **会话隔离测试**（用户 A 看不到 B 的会话）

## 7. 子系统 2 · 审核系统（异步人机协作）

### 7.1 生成（嵌入摄取管线）

摄取 Step 2 的 LLM 输出可能含 `---REVIEW: type | Title--- ... ---END REVIEW---` 块。把桌面 `parseReviewBlocks()` 正则移植到 Rust，摄取写完 wiki 页后解析 → 批量插入 `review_items`（project-scoped，团队共享）。可选第 4 个 LLM 调用（桌面 "dedicated review stage"）做额外建议。

### 7.2 端点（团队共享）

```
GET   /api/v1/projects/:id/reviews?status=open          列出待审核项
POST  /api/v1/projects/:id/reviews/:item_id/resolve     执行选定 action
POST  /api/v1/projects/:id/reviews/:item_id/dismiss     驳回
```

### 7.3 action 执行器（移植桌面 `review-view.tsx`）

`ReviewOption.action` 字段携带编码动作：

| action | 行为 |
|--------|------|
| `create_page:title` | 插入 wiki_pages 行(frontmatter+type)+更新 index/log+embedding → resolve |
| `deep_research` | 用 item 的 `search_queries`/`title` 入队 research_task(source_kind=review) → resolve |
| `delete:path` | 删 wiki_pages 行+级联清理 → resolve |
| `open:path` | 仅返回页内容供前端预览（**不** resolve） |
| `skip` | resolve 无动作 |

### 7.4 错误处理

- action 执行失败（建页失败/入队失败）→ **不 resolve**，item 保持 open，返回错误
- 建页 + resolve 尽量同事务保证一致

### 7.5 测试

- `parseReviewBlocks` 对样例 LLM 输出单测
- 各 action 执行器测试
- **团队可见性测试**（A 摄取 → B 看到项）
- resolve 幂等性

## 8. 子系统 3 · Deep Research（Tavily）

### 8.1 端点

```
POST  /api/v1/projects/:id/research               入队任务 {topic, search_queries?, source_kind}
GET   /api/v1/projects/:id/research/tasks         列出任务(分页)
GET   /api/v1/research/tasks/:tid                 任务状态/详情(全局,仿 ingest jobs)
GET   /api/v1/research/tasks/:tid/stream          ★ SSE 进度(状态迁移 + 综合流式)
```

### 8.2 入队 → 处理流

独立 `research_worker`（仿 ingest worker 在 main.rs spawn，并发上限 3 对齐桌面）：

```
POST 建 research_task(queued) → 返回 uuid
worker 拾取:
  ├─ searching:    web_search::provider_for_project() 跨 search_queries 取源
  │                (按 url/title 去重, max 20)
  ├─ synthesizing: retrieval::retrieve_context(topic) 取 wiki index 交叉引用
  │                → 组装综合 prompt(编号源 + [[wikilink]] 指令 + 引用格式)
  │                → llm::chat_stream/chat_to_string (流推 SSE)
  ├─ saving:       剥 <thinking> → 插入 wiki_pages 行
  │                (path=wiki/queries/research-{topic}-{date}.md, frontmatter type=query, origin=deep-research)
  └─ 自动摄取:     复用现有 ingest 管线提取实体/概念
状态: queued→searching→synthesizing→saving→done | error
```

### 8.3 错误处理

- Tavily 失败 → 有限退避重试 → 否则 `status=error` 并存错误
- 综合失败 → `status=error`，保留 `web_results` 允许重试
- **入队时校验**：项目无 `search_provider` 配置 → 400（非运行时才发现）

### 8.4 测试

- mock `WebSearchProvider`（假结果）
- 去重逻辑测试；综合 prompt 组装测试
- worker 状态机迁移测试；save→ingest 链测试（mock ingest）

## 9. 组合关系（方案 B 收益兑现）

```
            ┌──────────── 共享层 ────────────┐
            │ retrieval  llm  citations  web_search │
            └──┬──────────┬──────┬──────────┬───────┘
               │          │      │          │
     Chat ─────┘          │      │          │
  (retrieval + llm + citations) │          │
                               │          │
     Review ─── action:deep_research ────→ 入队 Research
     (ingest 解析→items→action 执行)      │
                                         │
     Research ────────────────────────────┘
  (web_search + retrieval + llm)
```

- **Chat** = retrieval + llm + citations
- **Review** 的 `deep_research` action → 复用 Research 入队
- **Research** = web_search + retrieval(交叉引用) + llm
- 三者共享 LLM/检索/引用，无重复；多用户权限在共享层 + 路由钩一次

## 10. 错误处理汇总

| 子系统 | 失败点 | 处理 |
|--------|--------|------|
| Chat | LLM 4xx/5xx | SSE `error` 事件 + 日志 |
| Chat | 检索为空 | 无上下文继续 |
| Chat | 流中断 | 丢弃部分输出，不存 |
| Review | action 执行失败 | 不 resolve，item 保持 open |
| Research | Tavily 失败 | 退避重试 → 否则 error |
| Research | 综合失败 | error，保留 web_results 允许重试 |
| Research | 无 search_provider | 入队时 400 |
| 跨子系统 | DB 操作 | 事务保证一致（建页+resolve 同 tx） |

## 11. 测试策略

- **共享层单测**：retrieval（mock search/graph）、citations::parse_cited、web_search 去重、llm 客户端（mock HTTP）
- **子系统单测**：parseReviewBlocks、各 review action 执行器、research worker 状态机
- **集成测试**：Chat SSE（注入假 LlmClient）、research save→ingest 链（mock ingest）
- **多用户测试**：会话隔离（A≠B）、审核团队可见性（A 摄取→B 可见）、权限边界（无项目权限 403）

## 12. 实现阶段排序（推荐）

每阶段 = 一份独立 spec → plan → 实现：

1. **Phase A：共享层 + Chat 子系统**（最高价值、最核心、耦合最紧）
   - 建 `services/{retrieval,llm,citations}/`，整合现有 `llm.rs`/`llm_stream.rs`
   - migration `006_chat_sessions.sql`
   - Chat 5 端点 + RAG 流式 + 会话持久化
2. **Phase B：Review 子系统**
   - migration `007_review_items.sql`
   - parseReviewBlocks 移植 + 摄取管线挂钩
   - review 端点 + action 执行器（`deep_research` action 先桩，待 C）
3. **Phase C：Deep Research 子系统**
   - migration `008_research_tasks.sql` + `009_search_providers.sql`
   - `services/web_search/` + TavilyProvider
   - research_worker + 4 端点 + 自动摄取

> 依赖：B 的 `deep_research` action 依赖 C；可先做 A→B（action 桩）→C（接通）。

## 13. 待定 / 延后（open questions）

- 裸 `/api/v1/chat/stream` 是否最终废弃？暂保留，迁移完成后评估
- `chat_messages.retrieval_ctx` 快照是否持久化？默认持久化（调试/重放），量大后评估裁剪
- Research 综合用 `chat_stream` 还是 `chat_to_string`？默认 stream（前端实时），离线场景用 to_string
- 团队级 search_provider 默认回退 —— 需要时再加 `team_settings` 表

---

## 附录：本总览与后续详细 spec 的关系

本文件是 **Layer 3 的架构总览**，定义共享契约 + 4 子系统高层设计。每个子系统的**可实施详细 spec**（含逐字段类型、逐端点请求/响应、逐函数签名、错误码、测试用例）将在 Phase A/B/C 各自的 spec 中展开，由 writing-plans 进一步拆成实现计划。
