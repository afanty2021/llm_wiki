# src-server Embedding 管线设计（Layer 2a）

> **状态**：设计确认（2026-06-20）| **依赖**：Layer 1（wiki 数据层 + ingest pipeline，已完成并端到端验证）
>
> **范围**：把 embedding 生成接入 src-server，让 `embeddings` 表从"0 行死表"变成与 `wiki_pages` 同步维护的派生数据，为 Layer 2b（向量/混合搜索）提供向量来源。本 spec 只做 embedding 管线，不含搜索融合、图谱、insights（后续 2b/2c/2d）。

---

## 1. 背景与目标

Layer 1 已让 ingest 端到端跑通（文档 → 解析 → 两步 LLM → wiki_pages 落库）。但 `embeddings` 表始终为空——ingest 从不生成向量，`vector_search` 因此形同虚设。本层的目标：

- **`embeddings` 表与 `wiki_pages` 同步**：wiki 页写入处（ingest 批量、pages CRUD 单页）都维护对应向量。
- **全本地**：用 omlx 的 `bge-m3-mlx-fp16`，与聊天模型 Qwen3.6 同栈，数据不出内网、无外部 API 依赖。
- **非阻塞**：embedding 是派生数据，其失败只降级搜索，不破坏 wiki_pages 真源。

### 现状核实（已查证）

| 项 | 现状 |
|----|------|
| `embeddings` 表 | 存在但 **0 行**；`content VECTOR(1536)`（可空）；`wiki_page_id VARCHAR(255)` 存页面 path；**无 `(project_id, wiki_page_id)` 唯一约束**；ivfflat `lists=100` 索引 |
| `services/embedding.rs` | 有 `vector_search`(pgvector 余弦) + `get_embeddings`，但后者**硬编码 `text-embedding-ada-002`** 且按 per-project `LlmConfig` 取配置 |
| ingest pipeline | `run_ingest_job` 全程不调用 embedding —— 根因 |
| omlx `/v1/embeddings` + bge-m3 | **已实测可用**：POST `{base_url}/v1/embeddings`，返回 **1024 维**向量，支持批量输入 |

---

## 2. 关键决策（已与用户确认）

| 决策 | 选择 | 理由 |
|------|------|------|
| 向量库 | **pgvector** | 已在 schema/docker/代码里、内网规模够用；换库是纯负债 |
| embedding 模型 | **bge-m3（本地 via omlx，1024 维）** | 已验证可用、本地免费、多语言、与 Qwen3.6 同栈 |
| 生成编排 | **ingest worker 内、按 job 批量** | 复用现有 worker、批量高效、embedding 永远与 wiki_pages 同步、不加新基础设施 |
| 粒度 | **一页一向量，不切块** | wiki 页是聚焦的实体/概念短文档；长源文档切块是远期 |
| 配置归属 | **全局**（`config/default.json`） | embedding 是基础设施，所有项目共享，不像聊天模型要 per-project |

---

## 3. 数据流

embedding 是 `wiki_pages` 的派生数据。两条写入路径都维护它，一条读取路径消费它：

```
写入①  ingest worker（批量）
  run_ingest_job:
    解析 → step1 LLM 分析 → step2 LLM 生成 → upsert wiki_pages【现有】
      → 收集本批 (page_path, text)
      → embed_and_store()  批量嵌入 + bulk upsert embeddings【新】
      → rebuild reserved pages【现有】

写入②  pages CRUD（单页）
  create_page / update_page → embed_page()
  delete_page               → delete_embedding()

读取   vector_search()  —— 供 Layer 2b 搜索用（现有函数，列维度变了自动正确）
```

---

## 4. Schema 变更（migration `005_embedding_bge_m3.sql`）

```sql
-- 维度 1536→1024（bge-m3）。表当前为空，零数据迁移成本。
ALTER TABLE embeddings ALTER COLUMN content TYPE vector(1024);

-- 补幂等 upsert 约束（现状缺失，会导致同页多向量、search 返回重复）。
-- 表为空，加约束无冲突。
ALTER TABLE embeddings ADD CONSTRAINT uniq_embeddings_page
    UNIQUE (project_id, wiki_page_id);

-- 维度变更后旧 ivfflat 索引失效，重建。
-- 顺带升级为 HNSW：pgvector 现代默认，对"持续增长的 wiki"无需调 lists、召回更稳。
DROP INDEX IF EXISTS idx_embeddings_content;
CREATE INDEX idx_embeddings_content ON embeddings USING hnsw (content vector_cosine_ops);
```

> ivfflat→HNSW 是顺带升级（反正要重建）。若倾向最小改动可保留 ivfflat（`lists` 按向量数 √n 调），但 HNSW 对增量数据更省心。

---

## 5. 组件改动

### 5.1 `config.rs` + `config/default.json`

新增全局 embedding 配置段：

```rust
#[derive(Debug, Clone, Deserialize)]
pub struct EmbeddingConfig {
    pub base_url: String,   // http://localhost:8001/v1
    pub model: String,      // bge-m3-mlx-fp16
    pub dim: usize,         // 1024
    pub timeout_secs: u64,  // 60
}
// AppConfig 增加 pub embedding: EmbeddingConfig
```

```json
"embedding": {
  "base_url": "http://localhost:8001/v1",
  "model": "bge-m3-mlx-fp16",
  "dim": 1024,
  "timeout_secs": 60
}
```

### 5.2 `services/embedding.rs`（重构）

删除旧的 `get_embeddings(text, llm: &LlmConfig)`（硬编码 ada-002 + per-project），改为基于全局 `EmbeddingConfig` 的批量 API + 维护层：

```rust
/// 批量嵌入：一次 HTTP 调 {base_url}/embeddings（bge-m3 支持多文本输入）。
/// 返回与 texts 等长、每条 dim 维的向量。
/// 校验返回维度 == cfg.dim，不一致直接报错（防模型/配置错配静默写入错误维度）。
pub async fn embed_batch(cfg: &EmbeddingConfig, texts: &[String])
    -> Result<Vec<Vec<f32>>, AppError>;

/// 批量嵌入 + bulk upsert（ingest 用）。pages 形如 (wiki_page_path, text)。
/// upsert 键 (project_id, wiki_page_id)，ON CONFLICT DO UPDATE。
pub async fn embed_and_store(
    pool: &PgPool, cfg: &EmbeddingConfig, project_id: i32,
    pages: &[(String, String)],
) -> Result<usize /*写入行数*/, AppError>;

/// 单页嵌入（pages CRUD 的 create/update 用）。= embed_and_store 的一条。
pub async fn embed_page(
    pool: &PgPool, cfg: &EmbeddingConfig, project_id: i32,
    path: &str, text: &str,
) -> Result<(), AppError>;

/// 删页向量（pages CRUD 的 delete 用）。
pub async fn delete_embedding(
    pool: &PgPool, project_id: i32, path: &str,
) -> Result<(), AppError>;
```

`vector_search` 保持不变——它按列读取向量，列维度改成 1024 后自动正确。

bulk upsert SQL：
```sql
INSERT INTO embeddings (project_id, wiki_page_id, content)
VALUES ($1, $2, $3), ...
ON CONFLICT (project_id, wiki_page_id) DO UPDATE
SET content = EXCLUDED.content;
```

### 5.3 `services/ingest_pipeline.rs`

在 `run_ingest_job` 的 upsert 循环中，每成功 upsert 一页就收集 `(page.path, page.content)`；循环结束后、`rebuild_reserved` 之前，调用：

```rust
if !collected.is_empty() {
    if let Err(e) = embedding::embed_and_store(
        &state.db, &state.config.embedding, job.project_id, &collected
    ).await {
        result.warnings.push(format!("embed batch: {}", e));  // 非致命
    }
}
```

reserved 页（index/log/overview）若也含 content，一并纳入 `collected`。

### 5.4 `routes/pages.rs`

`create_page` / `update_page`：DB 写入成功后调 `embedding::embed_page`；`delete_page`：调 `embedding::delete_embedding`。

embedding 失败**只 log warning，不阻断页面写入**（页面是真源、embedding 是派生）。例：

```rust
// create_page 末尾
if let Err(e) = embedding::embed_page(&state.db, &state.config.embedding, project_id, &req.path, &content).await {
    tracing::warn!("embed page {} failed (search degraded): {}", req.path, e);
}
Ok((StatusCode::CREATED, Json(page)))  // 页面写入结果不受影响
```

---

## 6. 错误处理与幂等

- **非致命**：embedding 失败（omlx 挂、超时、返回异常）→
  - ingest：`result.warnings.push`，job 仍 `succeeded`。
  - pages：log warning，页面写入成功。
  - 后果仅是 search 降级（该页缺向量），不损坏数据。
- **幂等**：
  - 所有 upsert 按 `(project_id, wiki_page_id)` + UNIQUE 约束，重复执行安全。
  - ingest 的 parse 级 content-hash 去重（`ingested_files` 表）已跳过未变更源文件 → 不重复嵌入已处理内容。
- **部分失败**：批量中某页 embed 失败而其它成功时，该页在 `embeddings` 缺行 → `vector_search` 不返回它，keyword 搜索（2b）仍能命中兜底。

---

## 7. 测试策略

- **单元**：
  - `embed_batch`：mock omlx `/v1/embeddings` 响应，断言返回 `texts.len()` 条、每条 `dim` 维。
  - bulk upsert：`embed_and_store` 两次同一批 → 行数不翻倍（ON CONFLICT）。
- **集成**（复用 Layer 1 已搭好的 omlx bge-m3 + PG + src-server）：
  - ingest 一个文档 → 断言 `embeddings` 表按页填充（每生成页一行、`vector_dims(content)=1024`）。
  - `vector_search("Alice 在哪工作")` 召回 `entities/alice.md`（余弦相似度排序）。
- **pages 维护**：create→embedding 出现；update content→向量变化；delete→embedding 消失。

---

## 8. 已知限制 / 范围边界

1. **换 embedding 模型需全量重嵌入**：维度或语义变了，旧向量不兼容 → `TRUNCATE embeddings` + 重新 ingest。re-embed 脚本不在 2a 范围。
2. **不切块**：整页一向量。长源文档切块是远期（wiki 页本身是聚焦短文档，当前够用）。
3. **配置全局**：所有项目共享 bge-m3（embedding 是基础设施）。
4. **embedding 缺失不报错**：omlx 不可用时搜索降级但不阻塞任何写入。

---

## 9. 验收标准

- [ ] migration 005 应用后：`embeddings.content` 为 `vector(1024)`，存在 `uniq_embeddings_page` 约束，索引为 HNSW。
- [ ] ingest 一个文档后：每个生成的 wiki 页在 `embeddings` 表有且仅有一行 1024 维向量。
- [ ] 重新 ingest 同一文档（内容未变）：`embeddings` 行数不增加（parse 级去重 + ON CONFLICT）。
- [ ] pages CRUD create/update/delete 正确增删改对应向量。
- [ ] omlx 不可用时：ingest 仍 succeeded（带 warning）、页面 CRUD 仍成功。
- [ ] `vector_search` 能按语义召回相关页（集成测试覆盖）。

---

## 10. 与后续层的关系

- **2b（search）**：消费本层产出的向量做 vector 分支；keyword 分支已有；hybrid 融合是 2b 的工作。
- **2c（graph）/ 2d（insights）**：不依赖 embedding，可并行设计/实现。
