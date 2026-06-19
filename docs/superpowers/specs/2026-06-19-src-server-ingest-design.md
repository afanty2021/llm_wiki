# src-server ingest 详细设计（Plan B）

> **状态**：总览设计确认（2026-06-19）| **依赖**：Plan A（wiki 数据层）已完成
>
> Plan B 实现 src-server 端全自动 wiki 摄取：源文档上传 → 队列 → 解析 → LLM 两步(分析+生成)→ 写 wiki_pages。覆盖 pdf/docx/xlsx/pptx/.md 主流格式。

---

## 1. 架构概览

```
┌─────────────────────────────────────────────────────────┐
│ E. API (routes/ingest.rs)                               │
│  POST /projects/:pid/ingest → 入队(C)                  │
│  GET /ingest/jobs/:id → 查进度(C)                      │
│  GET /projects/:pid/ingest/jobs → 列历史(C)            │
└───────────────┬─────────────────────────┬───────────────┘
                │ enqueue                 │ poll status
                ▼                         ▼
┌───────────────────────┐   ┌─────────────────────────────┐
│ C. 队列 + worker 骨架  │   │ D. ingest 编排               │
│ ingest_jobs PG 表(真相)│   │ services/ingest_pipeline.rs  │
│ redis 触发队列(LPUSH/  │   │ 两步 LLM(分析→生成)          │
│ BRPOP)                 │   │ 长文档分块                   │
│ 同进程 tokio worker    │──▶│ content-hash 缓存            │
│ 进度回写 + 重启恢复    │   │ 写 wiki_pages + reserved     │
└───────────────────────┘   └───────┬─────────┬───────────┘
                                    │ 解析    │ LLM
                                    ▼         ▼
                          ┌──────────────┐ ┌──────────────────┐
                          │ A. 解析 crate │ │ B. LLM 流式客户端 │
                          │ llm-wiki-     │ │ services/         │
                          │ parser        │ │ llm_stream.rs     │
                          │ (workspace)   │ │ StreamChatProvider │
                          └──────────────┘ │ OpenAI/Anthropic  │
                                           └──────────────────┘
```

**5 个子系统**：A(解析) + B(LLM 流式) + C(队列) → D(编排) → E(API)。A/B/C 互相独立可并行设计。

---

## 2. 子系统 A — 解析 crate `llm-wiki-parser`

### 职责
workspace 独立 crate，纯函数接口。pdf/docx/xlsx/pptx → 文本 + 图片提取。`src-server` 和 `src-tauri` 均可依赖复用（后者将来可替换桌面端内联解析）。

### 接口
```rust
pub struct ParsedDoc {
    pub text: String,          // Markdown，图片引用为相对路径
    pub images: Vec<ExtractedImage>,
    pub meta: DocMeta,         // 文件名、页数、作者等
}
pub struct ExtractedImage {
    pub name: String,          // 如 "page3_image1.png"
    pub data: Vec<u8>,
}
pub struct DocMeta { pub filename: String, pub page_count: Option<u32>, pub file_type: String }

pub enum ParseError {
    UnsupportedFormat(String),
    PdfiumError(String),
    Io(String),
    CorruptFile(String),
}

/// 全格式入口(内部 dispatch)，加 pdfium 全局锁串行化
pub fn parse_bytes(filename: &str, bytes: &[u8]) -> Result<ParsedDoc, ParseError>;
```

### 内置细节
- **pdfium 线程安全**：全局 `std::sync::Mutex` 串行化 PDF 操作(与桌面同)——锁在 crate 内不外溢,调用方无感。
- **缓存解耦**：crate **不做缓存**。调用方(worker)按 content-hash(redis) + `ingested_files` 表(PG)自行管理。
- **图片提取(MVP)**：PDF 内嵌图 → `Vec<u8>`，worker 写 `storage/media/{project_id}/{image_name}`。多模态 caption 后续。
- **遗留格式**：.doc/odt/ods 不在 MVP，crate 保留 `UnsupportedFormat` 错误。

### 部署
- **开发**：`apt install libpdfium-dev`(Ubuntu) 或 `brew install pdfium`(macOS 已验证有)。
- **Docker 部署**：Dockerfile 捆绑 `libpdfium-dev` + 环境变量 `LD_LIBRARY_PATH`。
- crate 在 repo 内为 workspace member（路径 `crates/llm-wiki-parser/`），CI 多 OS 需各自装 pdfium。

---

## 3. 子系统 B — LLM 流式客户端 `services/llm_stream.rs`

### 职责
封装 OpenAI/Anthropic SSE 流式调用，提供统一 `StreamChatProvider` trait。从 `llm_providers` 表读 per-project 配置(key 复用 `llm.rs` 解密)。

### trait
```rust
use futures::stream::BoxStream;

#[derive(Debug, Clone)]
pub struct ChatMessage { pub role: String, pub content: String }

#[derive(Debug, Clone)]
pub struct ChatOpts {
    pub model: String,
    pub temperature: f64,
    pub max_tokens: u32,
    pub system_prompt: Option<String>,
}

#[derive(Debug)]
pub enum TokenDelta {
    Text(String),                    // 逐 token 文本
    Usage { prompt: u32, completion: u32 }, // 流结束时用量的最后一片
    Done,                            // 流结束信号
}

#[async_trait]
pub trait StreamChatProvider: Send + Sync {
    async fn stream_chat(
        &self,
        messages: Vec<ChatMessage>,
        opts: ChatOpts,
    ) -> Result<BoxStream<'static, Result<TokenDelta, LlmError>>, LlmError>;
}

pub async fn provider_for_project(
    pool: &PgPool,
    project_id: i32,
) -> Result<Box<dyn StreamChatProvider>, AppError>;
```

### impl 要点
- **OpenAI**：`POST /v1/chat/completions` SSE，`data:` 行逐 token 标准格式(`data: {"choices":[{"delta":{"content":"hi"}}]}`)。直读现成 impl(标准 SSE 解析)。
- **Anthropic**：`POST /v1/messages`，`event:` 分隔 `message_start` / `content_block_delta` / `message_delta`。**content_block_delta** 需** state machine** 重建 token(`delta.type == "text_delta" → delta.text`，按 `index` 重组多 content_block)。非标准 SSE(无 `data:` 前缀)。
- **key 解密**：复用 `src-server/src/services/llm.rs` 的 `get_llm_config(pool, project_id)`→`decrypt_api_key(config.api_key_encrypted, config.jwt_secret)`。
- **同步**：并行调用复用 `reqwest` crate(已在 server deps)→ 流式 `reqwest::Response::bytes_stream`。LLM 调用密集于网络 IO，tokio 调度已够，不引入单独 HTTP 线程池。

### 错误处理
```rust
pub enum LlmError {
    ProviderNotFound, RateLimited, AuthFailed, ConnectionFailed(String), Timeout,
    ApiError { status: u16, body: String }, InvalidSse(String), StreamEnded,
}
```

---

## 4. 子系统 C — 队列 + worker 骨架

### 数据模型 — `ingest_jobs` PG 表(真相源)
```sql
CREATE TABLE ingest_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    source_paths TEXT[] NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',  -- pending | running | succeeded | failed
    stage VARCHAR(40),                               -- parsing | analyzing | generating | building_index
    progress INTEGER DEFAULT 0,                      -- 0-100
    error TEXT,                                      -- 失败原因
    result JSONB,                                    -- {new_pages: [...], updated_reserved: [...]}
    created_at TIMESTAMPTZ DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ
);
CREATE INDEX idx_ingest_jobs_project ON ingest_jobs(project_id);
CREATE INDEX idx_ingest_jobs_status  ON ingest_jobs(status) WHERE status IN ('pending','running');
```

### redis 触发队列
```
ingest:queue — list, LPUSH job_id(BRPOP 消费)
ingest:cache:{content_sha256} — hash, 分析 JSON 缓存(跨 project 复用, TTL 随需)
ingest:progress:{job_id} — hash(可选, PG progress 列为主)
```
**一致性与恢复**：入队先 PG INSERT → 成功再 LPUSH queue(保证不丢)。若 LPUSH 失败 job 已写 PG，worker 启动时扫 `pending`/`running` 重投 → 恢复。

### Rust 接口
```rust
#[derive(Debug, sqlx::FromRow, Serialize)]
pub struct IngestJob { pub id: Uuid, pub project_id: i32, pub created_by: i32,
    pub source_paths: Vec<String>, pub status: String, pub stage: Option<String>,
    pub progress: i32, pub error: Option<String>, pub result: Option<serde_json::Value>,
    pub created_at: chrono::DateTime<chrono::Utc>, pub started_at: Option<chrono::DateTime<chrono::Utc>>,
    pub finished_at: Option<chrono::DateTime<chrono::Utc>>, }

// 入队(PG INSERT + LPUSH)
pub async fn enqueue(state: &AppState, project_id: i32, user_id: i32, source_paths: Vec<String>) -> Result<Uuid, AppError>;

// 查进度(GET 用)
pub async fn job_status(state: &AppState, job_id: Uuid) -> Result<JobResponse, AppError>;

// 列历史
pub async fn list_jobs(state: &AppState, project_id: i32) -> Result<Vec<JobResponse>, AppError>;

// 启动 worker(server main 调)
pub fn spawn_worker(state: AppState);
```

### worker 细节
- **同进程 tokio task**：server binary 启动时 `tokio::spawn(async move { worker_loop(state).await })`。非独立 binary，共享 AppState(db/redis/config)。
- **生命周期**：`BRPOP ingest:queue 0` 阻塞等待，取回 job_id → PG fetch 详情 → 依次处理各 source_path → 调 D(编排)→ 回写 PG status/stage/progress。若无任务 BRPOP 阻塞（不占 CPU）。
- **串行**：单 worker 逐 job 处理。同一 job 内 source_paths 串行(避免并发 LLM 超 token budget+ 保证 reserved 重建原子)。
- **重启恢复**：启动时扫 `SELECT id FROM ingest_jobs WHERE status IN ('pending','running')` → 对每个 LPUSH 重投队列(幂等，worker 处理时若已有结果缓存则快速跳过)。
- **进度**：管程(h)后更新 PG `stage`+`progress` 列(前端轮询 5-10s)。
- **优雅关闭**：server shutdown 时 tokio task 收到信号 → 完成处理中的 job(标记 finished)后才退出(未来可加 context cancellation)。

---

## 5. 子系统 D — ingest 编排 `services/ingest_pipeline.rs`

### 职责
协调 A(解析) + B(LLM) + C(队列进度)，实现完整的源文档 → wiki 页面转换。

### core 接口
```rust
pub struct IngestJobResult {
    pub new_pages: Vec<String>,          // 新建的 path 列表
    pub updated_reserved: Vec<String>,   // 更新的 reserved page 列表
}

pub async fn run_ingest_job(state: &AppState, job: &IngestJob) -> Result<IngestJobResult, AppError>;
```

### 内部流程
```
for each source_path in job.source_paths {
    ① 读 storage 源文件(state.storage_path)
    ② 解析(A::parse_bytes) → ParsedDoc{text, images}
    ③ 存图片到 storage/media/{project_id}/
    ④ 长文档分块：
        if text 估算 token > context_budget -> 按段落边界拆 chunk
        -> 每 chunk Step1 分析 -> digest 合并 -> Step2 生成(同桌面策略)
    ⑤ 检查缓存：
        sha256(text).如果在 redis ingest:cache:{hash} → 复用分析结果，跳过 Step1
        ingested_files 表查出源文件内容哈希 → 无变化跳过整个文件
    ⑥ Step1 LLM(B::stream_chat)：分析 prompt(移植桌面) → 结构化 JSON(实体/概念/连接/矛盾)
    ⑦ 缓存 step1 结果到 redis ingest:cache:{sha256}(TTL 略长)
    ⑧ Step2 LLM(B::stream_chat)：生成 prompt → 多个 FILE block(concept/entity + frontmatter)
    ⑨ parse_file_blocks (移植桌面 parseFileBlocks) → 每个 FILE block 插入 wiki_pages
    ⑩ 更新进度(job.stage/index += 1/job.progress)
}
⑪ 重建 reserved pages(见下)
⑫ 标记 job.succeeded
```

### reserved pages 重建
```rust
// 每个 job 完成后，在同一个事务内全量重建 index/log/overview(对齐桌面 updateReservedPages)
async fn rebuild_reserved_pages(tx: &mut Transaction<Postgres>, project_id: i32) -> Result<(), AppError> {
    // 用 SELECT FOR UPDATE 锁住 3 条 reserved pages 行，读-改-写(MVP 单 worker 已防竞态，多 worker 将来)
    // index.md：遍历 wiki_pages ORDER BY path 生成目录
    // log.md：重建所有摄入日志条目 ORDER BY created_at
    // overview.md：重建项目总览(统计/关键词/模式)
}
```

### 端口移植策略
| 元素 | 源 | 策略 |
|------|-----|------|
| Step1 分析 prompt | `ingest.ts` Step1 | 直接移植到 Rust const string |
| Step2 生成 prompt | `ingest.ts` Step2 | 移植，适配 server-side 上下文 |
| 分块策略 | `ingest.ts` chunk/digest | 移植逻辑（按字节/段落边界拆，逐 chunk 分析 + 合并） |
| `parseFileBlocks` | `ingest.ts` → Rust 重写 | 移植正则 + 状态机逻辑成 Rust fn，去 CommonMark fence 兼容性 |
| 缓存 | `ingest-cache.ts` | 对 content-hash 缓存分析结果到 redis `ingest:cache:{sha256}` |
| `ingested_files` | migration 001 已有表 | 复用，摄取前后查/写(去重) |

---

## 6. 子系统 E — API 端点 `routes/ingest.rs`

### 端点
```
POST  /api/v1/projects/:pid/ingest
  请求 { "source_paths": ["uploads/foo.pdf", "uploads/bar.docx"] }
  鉴权 middleware::project_guard::check_project_access
  响应 201 { "job_id": "<uuid>", "status": "pending" }
  语义 异步：立即返回，worker 后台处理

GET   /api/v1/ingest/jobs/:id
  响应 200 { id, project_id, status, stage, progress, error, result, created_at, started_at, finished_at }
        404 { "error": "not found" }

GET   /api/v1/projects/:pid/ingest/jobs
  可选 query: ?status=succeeded&limit=10
  响应 200 { "items": [JobResponse...], "count": 42 }
  语义 列该项目下的历史摄取 job(按创建降序)
```

### 路由
```rust
// routes/ingest.rs
pub fn ingest_routes() -> axum::Router<AppState> {
    axum::Router::new()
        .route("/:pid/ingest",        axum::routing::post(create_ingest_job))
        .route("/:pid/ingest/jobs",   axum::routing::get(list_ingest_jobs))
}
// filter/routes.rs 新增
Router::new()
    .nest("/api/v1/projects", projects::project_routes())
    .nest("/api/v1/projects/", ingest::ingest_routes())  // 放在 /api/v1/projects/ 下面
    .nest("/api/v1/ingest",    ingest::global_routes())   // GET /ingest/jobs/:id 不绑 project
```
注：`GET /ingest/jobs/:id` 不鉴权 project(直接按 job_id 查)，但可考虑加 user 级鉴权(查 job.created_by)。MVP 先不鉴权(只看已创建 job)。

### response 格式
```rust
#[derive(Serialize)]
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

## 7. 数据流集成

### 与 Plan A(wiki 数据层)的关系
```
Plan A: wiki_pages(CRUD API + 导入)
Plan B: ingest pipeline ──→ 写 wiki_pages(ON CONFLICT upsert)
                     ──→ 写 ingested_files 表
                     ──→ 回写 ingest_jobs 表
                     ──→ 重建 reserved pages(也是 wiki_pages)
```
Plan B 的产出是 wiki_pages(Plan A 管理的数据)、ingested_files(去重源)、ingest_jobs(审计)。Plan B 不重复 CRUD API(不直接改 wiki_pages 路由)，独立写 wiki_pages 表。

### 与既有 services 的集成
- `services/embedding.rs`：后续(Plan B 未含)为新 wiki_pages 生成向量 → pgvector。
- `services/search.rs`：后续基于 vector 的语义检索。Plan B 不触发搜索重建。
- `services/graph.rs`：后续为新 wiki_pages 更新图谱。Plan B 不触发图谱重建(MVP 手動刷)。
- `services/llm.rs`：复用 `get_llm_config` + `decrypt_api_key`。

---

## 8. MVP 范围声明

### 含
- 解析 crate：.md + pdf + docx + xlsx + pptx(pdfium 部署)
- LLM provider：OpenAI + Anthropic only
- `ingest_jobs` 表 + redis 触发队列 + 同进程 tokio worker
- 重启恢复(启动扫 pending/running)
- 两步 LLM + 长文档分块 + content-hash 缓存 + reserved pages 重建
- API：POST + 按 ID GET + 项目级列出
- 前端轮询(SSE 后续)
- 失败不自动重试(用户介入后从 PG 重投)

### 不含
- ❌ review stage(LLM 一致性审核,桌面有 server 无)
- ❌ 多模态 caption
- ❌ 其他 provider(Google/Ollama/Azure/CLI)
- ❌ .doc/odt/ods 遗留格式
- ❌ 多 worker + 项目级锁
- ❌ 自动重试 + retryCount
- ❌ SSE 进度推送

---

## 9. 文件结构

| 文件 | 职责 | 改动 |
|------|------|------|
| `crates/llm-wiki-parser/Cargo.toml` | A 解析 crate manifest | Create |
| `crates/llm-wiki-parser/src/lib.rs` + `parser/*.rs` | A 核心逻辑 | Create |
| `Cargo.toml`(root) | workspace members 加 crate | Modify |
| `src-server/src/services/llm_stream.rs` | B LLM 流式客户端 | Create |
| `src-server/src/services/ingest_queue.rs` | C 队列接口(enqueue/job_status/spawn_worker) | Create |
| `src-server/src/services/ingest_worker.rs` | C worker loop + 恢复 | Create |
| `src-server/src/services/ingest_pipeline.rs` | D 编排 | Create |
| `src-server/src/routes/ingest.rs` | E API handler | Create |
| `src-server/src/routes/mod.rs` | 注册 ingest_routes | Modify |
| `src-server/src/lib.rs` | 注册 worker(server 启动) | Modify |
| `src-server/migrations/004_add_ingest_jobs.sql` | ingest_jobs 表 DDL | Create |
| `src-server/tests/integration/ingest_test.rs` | E2E 测试(小文件 md) | Create |
| 桌面 ingest.ts(prompt 移植) ⊂ Rust string const，不删桌面文件 |

---

## 10. 决策记录

| # | 决策 | 选择 | 理由 |
|---|------|------|------|
| 1 | 解析格式 MVP | 含 PDF(pdfium) | 覆盖最主流格式, 用户确认 |
| 2 | job 持久化 | PG ingest_jobs 真相源 + redis 触发队列 | 重启可靠 + 可观测 + 可重试管理 |
| 3 | worker 进程模型 | 同进程 tokio task | 单二进制简单, 有 PG 真相源恢复 |
| 4 | prompt | 移植桌面 ingest.ts | 语义已验证, 对齐桌面行为 |
| 5 | 分块 | 移植桌面策略 | 同 prompt 理由 |
| 6 | review stage | MVP 不含 | spec §4.1 已声明 |
| 7 | 其他 provider | MVP OpenAI+Anthropic only | spec §4.2 降首版风险 |
| 8 | 多 worker | MVP 单 worker | spec §8.3 后续 |
| 9 | SSE 推送 | MVP 轮询 | spec §4.5 后续 |

---

## 11. 风险

1. **pdfium 部署(§8.1 延续)**：多 OS lib 捆绑(Dockerfile/CI)。crate 内置 Mutex 串行化保线程安全。
2. **Anthropic SSE(§8.2 延续)**：content_block_delta state machine 重建 token(非标准 SSE)。
3. **prompt 移植**：从 TypeScript/JS 移植到 Rust string const 可能引入字符转义/模板变量差异。每一 prompt 移植需小文件 E2E 测试跑通。
4. **ingest job 积压**：单 worker 串行处理，上传多个源文件需排队。后续多 worker 缓解。
5. **LLM API 离崩/超时**：单 file 失败不丢(缓存在 redis 复用)，整 job 失败退可重新提交。

---

## 12. 后续

- **下一阶段**：按子系统逐份 brainstorm 细化(B→C→A→D→E)
- writing-plans 后形成类似 Plan A 的 file structure + step 级实施 plan
