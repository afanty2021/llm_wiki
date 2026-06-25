# Layer 6 — 基础设施抽象与调优设计（src-server）

> 日期：2026-06-24 · 范围：src-server（Web 后端） · 部署形态：**单机 / 小团队自托管**
> 状态：设计稿，待 review → 通过后交 writing-plans 拆实施计划

---

## 1. 背景与起点

Layer 1–5 已把 `src-server` 建成完整服务端（axum + PostgreSQL + pgvector + Redis + 同进程 worker）。Layer 6 **不是「把桌面端单机迁移到服务端」**（那 Layer 1–5 已做），而是针对 src-server 当前基础设施做两件事：

1. **清技术债**：storage / vector / queue 三处硬编码实现，抽出可插拔 trait。
2. **针对性调优/补强**：解决向量检索质量与 ingest 长任务可靠性两个实际痛点。

### 1.1 当前基线（已核查的代码事实）

| 组件 | 现状 | 抽象 | 关键短板 |
|------|------|------|----------|
| 文件存储 | `std::fs` 直写本地磁盘 `{storage_path}/teams/{tid}/projects/{pid}/`，`safe_resolve` 防穿越；配置已预留 S3 字段但**零实现** | ❌ 无 trait | 无统一边界，换 S3 要改散落各处的 fs 调用 |
| 向量库 | **pgvector**（不是 LanceDB），`embeddings` 表，**索引已是 HNSW**（m=16/ef_construction=64），检索**已是混合检索**（Keyword 多信号 + 向量余弦 + RRF `1/(60+rank)`），无 rerank | ❌ 无 trait，SQL 硬编码 3 处（embedding.rs INSERT/DELETE/SELECT） | **「每 wiki_page 一行向量」，无 chunk 级向量** → 长文档语义检索精度受限；embedding 远程调用零重试；**维度冲突（见下）** |
| 任务队列 | PG `ingest_jobs` 真相源 + Redis `ingest:queue` BRPOP + 同进程**单 worker** + `recover_pending` 崩溃恢复（扫 pending+running 重投）+ 整体百分比**轮询**进度 | ⚠️ 半成型 | **无取消、无重试、无部分失败隔离、无 SSE**；全有全无 |

> ⚠️ **维度冲突（实测确认，spec 原假设有误）**：生产库 `embeddings.content` 实测为 **`vector(1536)`**（migration 001:59 建表，005 的 `CREATE TABLE IF NOT EXISTS` 因表已存在而 skip，005 全文**没有 `ALTER COLUMN content TYPE`**，所以 005 注释说的「改 1024」对已存在表无效）。但 `config/default.json` 的 `embedding.dim=1024` + bge-m3 模型返回 1024 维 → **当前任何 embedding 写入都会报 `expected 1536 dimensions, not 1024`**（实测复现）。主库 embeddings 当前 0 条数据，说明生产从未成功写过 embedding。**Layer 6 migration 011 必须统一到 1024（跟 config 走）**，见 §5.1。
> 注：桌面端（Tauri）用 LanceDB + `ingest-queue.ts` 是单机原型，与 src-server 不是一回事；Layer 6 只针对 src-server。

### 1.2 已有可复用抽象

- `StreamChatProvider` trait（LLM，src/services/llm_stream.rs）— 不动
- `WebSearchProvider` trait（src/services/web_search.rs）— 不动
- 本次新增：`StorageBackend`、`VectorStore`，队列做接口收拢

---

## 2. 目标与非目标

### 2.1 目标
1. **文件存储**：抽 `StorageBackend` trait，`LocalStorage` 默认实现行为不变，`S3Storage` 占位（trait + 配置）为未来留口子。
2. **向量库**：① chunk 级向量（扩展单表）② HNSW `ef_search` 调参 ③ embedding 重试 ④ LLM rerank ⑤ `VectorStore` trait。
3. **任务队列**：① 取消 + 级联清理 ② 重试（自动 + 手动）③ 部分失败隔离 ④ 细粒度进度 + SSE。
4. 贯穿：三个 trait 把硬编码变可切换后端，默认实现 = 现有本地/pgvector/PG+Redis，行为不变。

### 2.2 非目标（YAGNI，明确不做）
- ❌ 不实现 S3 后端（只占 trait 位 + 配置字段）
- ❌ 不引入专用向量库（Qdrant/Milvus），保留 pgvector
- ❌ 不做多 worker 分布式队列（可见性超时/分布式锁），只在接口留 lease 扩展点
- ❌ 不换 LLM/WebSearch 已有抽象
- ❌ 不改桌面端（Tauri）任何代码
- ❌ 不做优先级队列、速率限制、死信队列（生产级 SaaS 特性，单机不需要）

---

## 3. 设计哲学

**「可插拔 trait 抽象 + 针对性调优/补强」**，而非上 SaaS 级重型基础设施。单机自托管前提下，pgvector 和 PG+Redis 都够用——问题不是「组件不够强」，而是「实现硬编码 + 几个具体短板」。trait 让实现可切换（未来想上 S3/专用库/分布式队列时只加 impl），默认实现保持现状，行为零回归。

---

## 4. 子系统 1：文件存储（抽象为主）

### 4.1 StorageBackend trait

```rust
// src-server/src/services/storage.rs
#[async_trait]
pub trait StorageBackend: Send + Sync {
    /// 读取文本文件
    async fn read(&self, team_id: i32, project_id: i32, rel_path: &str) -> Result<String, AppError>;
    /// 读取二进制（图片 raw）
    async fn read_bytes(&self, team_id: i32, project_id: i32, rel_path: &str) -> Result<Vec<u8>, AppError>;
    /// 写文本
    async fn write(&self, team_id: i32, project_id: i32, rel_path: &str, data: &str) -> Result<(), AppError>;
    /// 写二进制（上传）
    async fn write_bytes(&self, team_id: i32, project_id: i32, rel_path: &str, data: &[u8]) -> Result<(), AppError>;
    /// 列目录（递归）
    async fn list(&self, team_id: i32, project_id: i32, dir_rel: &str) -> Result<Vec<FileNode>, AppError>;
    /// stat（大小/mtime/is_dir）
    async fn stat(&self, team_id: i32, project_id: i32, rel_path: &str) -> Result<FileStat, AppError>;
    /// 删除（带重试）
    async fn delete(&self, team_id: i32, project_id: i32, rel_path: &str) -> Result<(), AppError>;
    /// 上传（multipart）：返回最终 rel_path
    async fn upload(&self, team_id: i32, project_id: i32, dir_rel: &str, filename: &str, data: Vec<u8>) -> Result<String, AppError>;
}

pub struct FileNode { pub name: String, pub rel_path: String, pub is_dir: bool, pub size: i64 }
pub struct FileStat { pub size: i64, pub modified: SystemTime, pub is_dir: bool }
```

### 4.2 LocalStorage（默认实现）
- 复用现有 `project_base(storage_path, team_id, project_id)` + `safe_resolve`（路径穿越防护，保留）
- 所有 IO 用 `tokio::fs`（替换 `std::fs::write` 的阻塞调用，顺手修一处阻塞点）
- `delete` 保留现有重试逻辑
- 行为与当前 `routes/files.rs` 完全一致

### 4.3 S3Storage（占位，不实现）
- 定义 struct + `StorageBackend` impl，所有方法返回 `AppError::NotImplemented("s3 storage not yet implemented")`
- 配置字段（`StorageConfig.s3_*`）已预留，`from_env` 增 `storage_type` 分发：`"local"` → LocalStorage（默认），`"s3"` → S3Storage（占位）
- **本次不引入 S3 SDK 依赖**，impl 桩不调用任何 S3 API

### 4.4 收敛点
- `routes/files.rs`（upload/list/stat/raw/read/write/delete，约 7 个 handler）把内部 `std::fs` 直调全部改为 `state.storage.xxx(...)` 调用
- `AppState` 增 `pub storage: Arc<dyn StorageBackend>`
- `config.rs` 启动时按 `storage_type` 构造对应实现注入

### 4.5 测试
- `LocalStorage` 单测：read/write/list/stat/delete/upload + 路径穿越攻击用例（`../`、绝对路径、符号链接）
- `routes/files.rs` 集成测：复用现有，确认行为不变（file_count 类型、read 404 守卫等既有契约）
- S3 占位：单测确认返回 NotImplemented

---

## 5. 子系统 2：向量库（调优 + 抽象）

### 5.1 chunk 级向量（质量核心）— migration 011

扩展 `embeddings` 单表（不加新表，对齐用户决策「扩展单表」）：

```sql
-- migrations/011_chunk_level_embeddings.sql
-- 每 wiki_page 一行 → 按 chunk 多行（对齐桌面 wiki_chunks_v2 思路）
ALTER TABLE embeddings ADD COLUMN IF NOT EXISTS chunk_index INTEGER NOT NULL DEFAULT 0;
ALTER TABLE embeddings ADD COLUMN IF NOT EXISTS chunk_text TEXT;
ALTER TABLE embeddings ADD COLUMN IF NOT EXISTS heading_path VARCHAR(512);

-- ⚠️ 维度统一：生产库 content 是 vector(1536)（001 建，005 未 ALTER，实测确认），
-- 与 config embedding.dim=1024 / bge-m3 冲突，导致 embedding 写入报 expected 1536 dimensions。
-- 统一到 1024（跟 config 走）。主库 embeddings 0 条数据，无数据迁移损失。
-- 实测：pgvector ALTER 维度后 HNSW 索引自动随列保留（无需手动重建）。
ALTER TABLE embeddings ALTER COLUMN content TYPE VECTOR(1024);

-- 唯一约束：UNIQUE(project_id, wiki_page_id) → UNIQUE(project_id, wiki_page_id, chunk_index)
-- ⚠️ 必须删除 005 建的「每页唯一」约束，真实约束名是 uniq_embeddings_page
-- （见 005_embedding_bge_m3.sql:24，显式命名）。若 DROP 错名字会被 IF EXISTS 静默吞掉，
-- 旧约束 UNIQUE(project_id, wiki_page_id) 残留 → 同一 page 多 chunk 写入必违反唯一约束。
ALTER TABLE embeddings DROP CONSTRAINT IF EXISTS uniq_embeddings_page;

-- DO $$ 守卫保证幂等（对齐 005 风格；PostgreSQL 的 ADD CONSTRAINT 无 IF NOT EXISTS 语法，裸跑会因约束已存在报错）
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'embeddings_unique_chunk') THEN
        ALTER TABLE embeddings ADD CONSTRAINT embeddings_unique_chunk
            UNIQUE (project_id, wiki_page_id, chunk_index);
    END IF;
END $$;

-- chunk_text 用于 snippet + rerank 输入；可选 GIN 索引辅助 keyword 侧
-- HNSW 索引（005 已建）：上面 ALTER content TYPE 后实测索引自动保留，无需手动重建
```

> 现有「每页一行」数据 chunk_index=0、chunk_text/heading_path=NULL，**向后兼容**，不强制回填。新写入按 chunk 多行。

### 5.2 VectorStore trait

```rust
// src-server/src/services/vector_store.rs
#[async_trait]
pub trait VectorStore: Send + Sync {
    async fn upsert_page_chunks(
        &self,
        project_id: i32,
        page_id: &str,                       // wiki_page.path
        chunks: Vec<PageChunk>,
    ) -> Result<(), AppError>;
    async fn delete_page(&self, project_id: i32, page_id: &str) -> Result<(), AppError>;
    /// chunk 级向量检索，返回命中的 chunk（含 chunk_text/heading_path）供 rerank 与聚合
    async fn search_chunks(
        &self,
        project_id: i32,
        query_vec: Vec<f32>,
        top_k_chunks: usize,
    ) -> Result<Vec<ChunkHit>, AppError>;
}

pub struct PageChunk { pub chunk_index: i32, pub chunk_text: String, pub heading_path: Option<String>, pub vector: Vec<f32> }
pub struct ChunkHit { pub page_id: String, pub chunk_index: i32, pub chunk_text: String, pub heading_path: Option<String>, pub score: f32 }
```

`PgVectorStore` 实现 = 现有 embedding.rs 三处 SQL 收拢 + chunk 化。

### 5.3 chunk 切分与写入改造
- **新增向量专用细粒度切分**（区别于 `ingest_pipeline.rs` 给 LLM 分析用的粗切分——后者是 `context_budget` 128k 级大块，不适合向量检索）。新工具函数 `chunk_for_embedding(text, chunk_size, overlap)`：按段落 `\n\n` 优先、超长按句子边界硬拆、带 overlap 滑窗，产出 256–512 token 小块
- chunk 参数化：`embedding.chunk_size`（默认 384 token）/ `overlap`（默认 64）
- `upsert_page_chunks`：先 `DELETE WHERE project_id=? AND wiki_page_id=?`（删旧 chunk），再批量 INSERT 新 chunk
- `embed_batch` 批量调用不变，输入为各 chunk 的 `chunk_text`（可拼 title + heading_path 前缀增语义）

> ⚠️ **ON CONFLICT 失效警告（migration 011 必读）**：011 把唯一约束从 `UNIQUE(project_id, wiki_page_id)` 改为 `UNIQUE(project_id, wiki_page_id, chunk_index)`。现有 `embed_and_store`（`embedding.rs:82`）的 `INSERT ... ON CONFLICT (project_id, wiki_page_id) DO UPDATE` 会**运行时报错** `there is no unique or exclusion constraint matching the ON CONFLICT specification`——PostgreSQL 的 ON CONFLICT 推断要求声明列集与唯一索引键列**精确匹配**，2 列声明无法匹配 3 列索引。该 SQL 字符串语法合法、编译期不报，**运行时才暴露**。
>
> `upsert_page_chunks` 的 DELETE+INSERT 已规避此问题。但**必须同步迁移全部既有调用点**（5 处）：迁移时机在 **Phase 2**——011 落地 + chunk 化与 `upsert_page_chunks` 的 DELETE+INSERT 一并改写。**Phase 1 不动 ON CONFLICT**：011 未跑、旧约束 `UNIQUE(project_id, wiki_page_id)` 仍匹配，ON CONFLICT 继续有效，保持行为零回归。注意该 SQL 字符串语法合法、编译期不报，**运行时才暴露**，故 Phase 2 必须用集成测覆盖每条写入路径。
> - `embed_and_store` 定义：`embedding.rs:50`（含 `:82` 的 ON CONFLICT）→ Phase 2 改为 DELETE+INSERT，或 chunk 化后下沉进 `VectorStore::upsert_page_chunks`
> - `embed_and_store` 直调：`ingest_pipeline.rs:447`
> - `embed_page` 调用（内部转 `embed_and_store`）：`pages.rs:161`、`pages.rs:239`、`review.rs:470`、`synthesize.rs:154`
>
> 不受 011 影响（无需改动）：`teams.rs:313`（team_members）、`pages.rs:142`（wiki_pages DO NOTHING）、`ingest_pipeline.rs:335/590/675`（wiki_pages/ingested_files）——均在其它表。

### 5.4 检索 SQL 改造（chunk → page 聚合）
原 `vector_search`（embedding.rs:143）按 page 一行 top-k。新版：

```sql
-- chunk 级检索 + 按 page 去重取最高分 chunk + 外层按相关度取 top-N。
-- 三层结构各有不可省的理由：
--  1) DISTINCT ON (wiki_page_id) 取每个 page 的最高分代表 chunk，避免 GROUP BY 标量列报错；
--     但它要求 ORDER BY 最左前缀 = wiki_page_id，故输出按 page_id 排序。
--  2) 所以外层再包一层子查询 ORDER BY score DESC LIMIT $4 —— 否则 LIMIT 会按 page_id
--     字典序而非相关度取页，高相关度但 page_id 靠后的页被错误丢弃，削弱 rerank 候选质量。
--  3) snippet/rerank 输入用 COALESCE(chunk_text, wp.content)：存量「每页一行」向量行
--     chunk_text 为 NULL（011 不回填），未重新摄取前回退到 wiki_pages.content 保留质量。
SELECT page_id, title, snippet, score, rerank_text, heading_path
FROM (
    SELECT DISTINCT ON (c.wiki_page_id)
           c.wiki_page_id AS page_id,
           wp.title,
           substring(COALESCE(c.chunk_text, wp.content) FROM 1 FOR 200) AS snippet,
           COALESCE(c.chunk_text, wp.content) AS rerank_text,
           c.heading_path,
           c.score
    FROM (
        SELECT e.wiki_page_id, e.chunk_index, e.chunk_text, e.heading_path,
               1.0 - (e.content <=> $1) AS score
        FROM embeddings e
        WHERE e.project_id = $2
        ORDER BY e.content <=> $1
        LIMIT $3   -- top_k_chunks（如 40，拉宽候选供去重与 rerank）
    ) c
    JOIN wiki_pages wp ON c.wiki_page_id = wp.path AND wp.project_id = $2
    ORDER BY c.wiki_page_id, c.score DESC   -- DISTINCT ON 要求最左前缀 = 去重表达式
) t
ORDER BY t.score DESC
LIMIT $4;  -- page top-N（如 20，喂给 rerank），按相关度而非 page_id 取
```

- 混合检索流程（`search.rs:368`）：向量侧改为调用 `search_chunks`（返回上述去重 + 相关度排序后的 page top-N），再与 keyword 侧 RRF 融合
- HNSW 查询参数：**显式事务内** `SET LOCAL hnsw.ef_search = 80` 后执行检索 SELECT（`pool.begin()` → `SET LOCAL` → `SELECT` → `commit()`）。`SET LOCAL` 是**事务级**而非会话级——自动提交模式下单独执行会随隐式事务结束而失效，对检索语句静默无效；同事务保证生效，事务结束自动恢复默认 40，不污染连接池。参数化 `embedding.ef_search` 默认 80

### 5.5 LLM rerank（对齐用户决策「做 LLM rerank」）
- 混合检索（keyword + vector+RRF）产出 page top-N（默认 20）后，调 LLM 二次精排：
  - prompt：给 query + N 个候选（title + 代表文本 = §5.4 的 `rerank_text`，已 COALESCE 兜底存量 NULL），要求输出按相关性排序的 page_id 列表 + 0–10 分
  - 用 `StreamChatProvider` 复用现有 LLM 抽象，provider 维度走 team 配置
- 配置开关 `search.rerank_enabled`（默认 true）、`search.rerank_top_n`（20）、`search.rerank_final_k`（5）
- **fallback**：LLM rerank 失败/超时 → 回退 RRF 融合结果，不阻断搜索
- 新文件 `src-server/src/services/rerank.rs`，函数 `rerank_pages(query, candidates, llm) -> Result<Vec<RerankedPage>>`

### 5.6 embedding 重试
- `embed_batch`（embedding.rs:25）加指数退避重试：网络错误/5xx/超时重试 3 次（base 1s × 2^n + jitter）
- 复用 `reqwest` 现有 client，不引入新依赖

### 5.7 测试
- migration 011：在干净 DB（001+005 后 content=1536）跑 011，确认 ① content→1024 ② 约束切 embeddings_unique_chunk、旧 uniq_embeddings_page 删除 ③ HNSW 索引保留 ④ 二次执行幂等（实测脚本：tests_tmp/layer6_spec/011+verify2.sql 已全部通过）
- chunk 切分单测：边界（空、超长、单句）、token 计数、overlap
- 检索聚合单测：一 page 多 chunk 命中 → DISTINCT ON 取最高分代表 chunk；外层 ORDER BY score DESC LIMIT 取相关度最高 N 页（**非 page_id 字典序**——构造 page_id 靠后但相关度最高的用例断言不被丢弃）
- 存量数据回退单测：chunk_text=NULL 的存量行 → snippet/rerank 输入 COALESCE 回退到 `wp.content`，不为空
- ef_search 生效验证：显式事务内 `SET LOCAL hnsw.ef_search` + 检索同事务执行；对比 ef_search=40 vs 80 的召回差异，确认设置真实生效（防自动提交模式下静默失效）
- rerank 单测：mock LLM 返回排序，确认聚合；LLM 失败 → fallback RRF
- embedding 重试单测：mock 503 → 重试 → 成功；超过次数 → 错误
- 回归：现有 search 集成测（混合检索契约）保持通过
- **检索质量评测**：构造 10–20 条 query + 期望命中 page 的 golden set，对比 chunk 前后召回率（量化收益）

---

## 6. 子系统 3：任务队列（可靠性补强）— migration 012

### 6.1 migration 012（ingest 可靠性字段）

```sql
-- migrations/012_ingest_reliability.sql

-- ⚠️ 004 定义 status VARCHAR(20)，放不下 succeeded_with_warnings(23 字符)。
-- 不加宽则任何写入该状态都会 value too long for type character varying(20)。
ALTER TABLE ingest_jobs ALTER COLUMN status TYPE VARCHAR(40);

ALTER TABLE ingest_jobs ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ingest_jobs ADD COLUMN IF NOT EXISTS max_retries INTEGER NOT NULL DEFAULT 3;
ALTER TABLE ingest_jobs ADD COLUMN IF NOT EXISTS cancel_requested BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE ingest_jobs ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;  -- 多 worker 留口子，单 worker 不用

-- 部分失败：per-file 明细（source 级状态）
ALTER TABLE ingest_jobs ADD COLUMN IF NOT EXISTS item_states JSONB NOT NULL DEFAULT '[]'::jsonb;
-- item_states: [{ "path": "raw/sources/x.pdf", "status": "done|failed|skipped", "error": null, "page_ids": [...] }]
```

### 6.2 扩展状态机
```
pending → running → succeeded                      (全部成功)
                  → succeeded_with_warnings         (部分失败，result.warnings 非空 + item_states 有 failed)
                  → failed                          (全部失败 / 致命错误 / 超过重试)
running → cancelled                                 (cancel_requested 且已清理)

失败自动重试：failed 且 retry_count < max_retries 且 error∈瞬态类 → 重新 pending（retry_count++）
```
- `status` 增加 `succeeded_with_warnings`、`cancelled` 两个值
- 瞬态错误判定：`is_transient(err)` = 网络超时 / HTTP 5xx / embedding 远程不可达；非瞬态（解析失败、LLM 内容违规）不自动重试

### 6.3 取消 + 级联清理
- endpoint：`POST /api/v1/ingest/jobs/:id/cancel` → 置 `cancel_requested=true`
- worker 检查点：pipeline 每步（解析/分析/生成/embedding/写库）前置 `check_cancel(state, job_id).await?`，发现请求则：
  - 调 `cleanup_written(job)`：删除本 job 已写入的 wiki_pages（按 item_states.page_ids）+ 对应 embeddings（按 page_id，级联 `DELETE FROM embeddings WHERE project_id=? AND wiki_page_id=ANY($page_ids)`）+ 标记 `mark_file_ingested` 回滚
  - 对齐桌面端 `cleanupWrittenFiles` + LanceDB chunk 级联删
  - status → `cancelled`
- 取消是协作式（cooperative），不强行 kill tokio task；LLM 调用本身不中断（下一次检查点生效）

### 6.4 重试（自动 + 手动）
- 自动：pipeline 返回瞬态错误 → `retry_count < max_retries` → status 重置 `pending`、`error` 记录、`LPUSH` 重投；超限 → `failed`
- 手动：`POST /api/v1/ingest/jobs/:id/retry` → 校验 status∈{failed, cancelled} → 重置 `pending`、清 `error`、`retry_count++`、重投
- 重投不重置 `item_states` 中已 `done` 的文件 → **部分失败续传**：pipeline 跳过 `done` 项，只重处理 `failed`

### 6.5 部分失败隔离
- pipeline（ingest_pipeline.rs:376）循环每个 source：单文件失败 → `item_states[i].status="failed"` + warnings，**不 return Err 中断整个 job**，继续下一文件
- 全部失败才 `failed`；有成功有失败 → `succeeded_with_warnings`；全成功 → `succeeded`
- 仅致命错误（DB 连接断、项目不存在）才整体 `failed`

### 6.6 细粒度进度 + SSE
- per-file 进度：每次 `item_states[i]` 变更时更新 job.progress = `done_count / total * 100`，并把当前 stage（parsing/generating/embedding）写回
- SSE：新 endpoint `GET /api/v1/ingest/jobs/:id/stream`，axum `Sse<impl Stream>`
  - 实现机制：AppState 增 `job_events: broadcast::Sender<JobEvent>`；worker 更新 job 时 `broadcast` 一条事件；SSE handler 订阅 + 先回放当前 PG 状态（首帧）再增量推
  - 事件类型：`stage_changed` / `progress` / `item_done` / `item_failed` / `job_succeeded` / `job_failed` / `job_cancelled`
  - 前端 web 侧 `useIngest` 增 SSE 订阅（capabilities.web），保留轮询作 fallback
- 单机下 broadcast channel 容量 64 足够

### 6.7 多 worker（留口子，不做）
- `lease_expires_at` 字段已加（占位）；`enqueue` 时留注释：未来多 worker 改用 `UPDATE ... SET status='running', lease_expires_at=now()+interval WHERE status='pending' RETURNING` 抢占
- 单 worker `recover_pending` 已够（重启扫 running 重投）

### 6.8 队列接口收拢（轻量，不上重型 trait）
- 队列紧绑 PG+Redis，上 trait 价值低 → 新建 `src-server/src/services/ingest_queue.rs`（若已有则扩展），收拢 `enqueue / cancel / retry / recover_pending / mark_*` 为一组函数，handler 与 worker 统一调用
- 不定义 `TaskQueue` trait（YAGNI）

### 6.9 测试
- 状态机单测：所有转移路径 + 非法转移拒绝
- 取消：请求取消 → worker 下个检查点清理 → wiki_pages/embeddings 确实删除 + status=cancelled
- 重试：瞬态错误自动重试到成功 / 到 max_retries 转 failed；手动 retry 重投且跳过 done
- 部分失败：3 文件 1 失败 → succeeded_with_warnings + 该文件可单独 retry
- SSE：订阅后收到首帧 + 增量事件序列；job 完成收尾帧
- 并发安全回归：单 worker 串行契约不变

---

## 7. 贯穿：trait 清债汇总

| trait | 文件 | 实现 | 默认 |
|-------|------|------|------|
| `StorageBackend` | services/storage.rs | LocalStorage（本次）/ S3Storage（占位） | LocalStorage |
| `VectorStore` | services/vector_store.rs | PgVectorStore（本次） | PgVectorStore |
| 队列接口 | services/ingest_queue.rs（函数组） | PG+Redis（本次） | — |
| `StreamChatProvider` | services/llm_stream.rs（既有） | OpenAI/Anthropic | 不动 |
| `WebSearchProvider` | services/web_search.rs（既有） | Tavily | 不动 |

`AppState` 注入 `Arc<dyn StorageBackend>` 和 `Arc<dyn VectorStore>`。

---

## 8. migration 清单

| 编号 | 文件 | 内容 |
|------|------|------|
| 011 | `011_chunk_level_embeddings.sql` | embeddings 加 chunk_index/chunk_text/heading_path + **content 维度统一 1536→1024** + 改唯一约束（已实测：HNSW 索引自动保留、幂等） |
| 012 | `012_ingest_reliability.sql` | ingest_jobs 加 retry_count/max_retries/cancel_requested/lease_expires_at/item_states |

无其它 schema 变更。文件存储、rerank、SSE 无 migration。

---

## 9. 配置变更（config/default.json + from_env）

```json
{
  "storage": { "path": "...", "storage_type": "local" },         // storage_type: local(默认)|s3
  "embedding": { ..., "chunk_size": 384, "overlap": 64, "ef_search": 80, "max_retries": 3 },
  "search": { "rerank_enabled": true, "rerank_top_n": 20, "rerank_final_k": 5 },
  "ingest": { "max_retries": 3 }
}
```
- S3 相关字段（s3_endpoint 等）已存在，本次不新增、不启用

---

## 10. 测试策略总览

- **回归优先**：Phase 1（抽象）必须行为零回归，所有既有集成测保持绿
- **量化质量**：向量库配 golden set 评测召回率（chunk 前后对比），证明 chunk 级向量 + rerank 的实际收益
- **可靠性场景**：取消/重试/部分失败/SSE 各有专项集成测，覆盖单机真实路径
- 沿用现有测试基建（src-server/tests/、mcp__playwright 可选做 web 端 SSE 验证）

---

## 11. 风险与权衡

| 风险 | 缓解 |
|------|------|
| chunk 化导致向量表行数暴涨、检索变慢 | HNSW 已就位；ef_search 调参；按 project_id 分区过滤；必要时后续加表分区 |
| LLM rerank 增加搜索延迟 + 成本 | 默认 top_n=20 受控；fallback RRF；开关可关；异步可后续优化为缓存 |
| migration 011 约束切换在已有数据上失败 | IF EXISTS 守卫；旧数据 chunk_index=0 兼容；干净库 + 有数据库双测 |
| **011 维度统一 1536→1024**：若某环境 embeddings 已有 1536 维数据，ALTER TYPE 会失败 | 主库实测 0 条数据；Phase 2 上线前确认目标库 embeddings 为空（或先清空再迁移）；实测 ALTER 在空表 + HNSW 索引保留均通过 |
| **011 使现有 `ON CONFLICT (project_id, wiki_page_id)` 运行时报错** | 5 处 embed 写入调用点在 **Phase 2** 随 chunk 化迁到 `upsert_page_chunks` 的 DELETE+INSERT（清单见 §5.3）；Phase 2 集成测覆盖每条写入路径（SQL 字符串编译期不报、运行时才暴露）；Phase 1 不动，保持零回归 |
| SSE broadcast 在多 tab/高频更新下丢消息 | 首帧回放当前 PG 状态；事件幂等；channel 容量 64 + 溢出降级轮询 |
| 抽象 trait 引入间接层，调试变难 | trait 实现保持薄；单测覆盖；日志带 backend 类型标签 |
| 取消是协作式，长 LLM 调用期间无法立即停 | 文档说明；检查点粒度足够细（每文件每步）；可接受 |

---

## 12. 实施阶段（每阶段一个 implementation plan）

> 每阶段独立可交付、独立可测、独立可合并。建议顺序：

### Phase 1 — 抽象清债（行为零回归）✅ 已完成（2026-06-25）
- 实施计划：`docs/superpowers/plans/2026-06-24-layer6-phase1-abstraction.md`
- 分支：`feat/layer6-phase1-abstraction`（10 commits）
- `StorageBackend` trait + LocalStorage + S3 占位 + routes/files.rs 7 处 handler 收敛（逻辑坐标）
- `VectorStore` trait + PgVectorStore（收拢现有 3 处 SQL，暂不 chunk 化）
- `embedding.rs` 改为薄包装；AppState 注入 `storage` + `vector_store`；10 处 embedding 调用 + 2 处 hybrid_search 调用改传 `&*state.vector_store`
- 队列接口收拢 → **推迟到 Phase 3**（设计决策：队列紧绑 PG+Redis，上 trait 价值低，与可靠性补强一并做，见 §6.8）
- **验收**：158 lib 单测 + 非忽略集成测全绿；2 个预存失败/抖动集成测（`ingest_queue`/`research`，需 PG+Redis）经 base `e4c4baa` 对照证明非回归；行为零回归（HTTP 错误码/JSON 契约经 review 逐项核对）

### Phase 2 — 向量库调优
- migration 011（chunk 表）+ chunk 切分进向量库 + 检索 SQL 聚合改造 + HNSW ef_search + embedding 重试
- LLM rerank（rerank.rs + search 流程接入 + fallback）
- **验收**：golden set 召回率提升；现有 search 测试绿

### Phase 3 — 队列可靠性
- migration 012（可靠性字段）+ 状态机扩展
- 取消 + 级联清理 / 重试（自动+手动）/ 部分失败隔离 / SSE
- web 端 SSE 订阅
- **验收**：四项可靠性场景集成测通过

---

## 13. 待 review 的开放点

1. chunk_size 默认 384 / overlap 64 / ef_search 80 — 是否需要先在你的语料上跑评测再定？（可留 Phase 2 调参时确认）
2. LLM rerank 复用哪个 provider/模型 — 走 team 配置的默认 chat provider，还是单独配 `search.rerank_model`？
3. SSE 事件 channel 用 AppState broadcast（简单）vs Redis pub/sub（多实例友好）— 单机建议前者，确认？
4. Phase 顺序是否按 1→2→3，还是你想先做队列可靠性（Phase 3）缓解痛点？
