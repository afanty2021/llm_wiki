# src-server Embedding 管线设计（Layer 2a）

> **状态**：设计确认（2026-06-20，已并入 review 反馈）| **依赖**：Layer 1（wiki 数据层 + ingest pipeline，已完成并端到端验证）
>
> **范围**：把 embedding 生成接入 src-server，让 `embeddings` 表从"0 行死表"变成与 `wiki_pages` 同步维护的派生数据，为 Layer 2b（向量/混合搜索）提供向量来源。本 spec 只做 embedding 管线，不含搜索融合、图谱、insights（后续 2b/2c/2d）。

---

## 1. 背景与目标

Layer 1 已让 ingest 端到端跑通（文档 → 解析 → 两步 LLM → wiki_pages 落库）。但 `embeddings` 表始终为空——ingest 从不生成向量，`vector_search` 因此形同虚设。本层的目标：

- **`embeddings` 表与 `wiki_pages` 同步**：wiki 页写入处（ingest 批量、pages CRUD 单页）都维护对应向量。
- **全本地**：用 omlx 的 `bge-m3-mlx-fp16`，与聊天模型 Qwen3.6 同栈，数据不出内网、无外部 API 依赖。
- **可选且非阻塞**：embedding 是可选基础设施，未配置/失败时只降级搜索，不破坏 wiki_pages 真源、不阻止 server 启动。

### 现状核实（已查证）

| 项 | 现状 |
|----|------|
| `embeddings` 表 | 存在但 **0 行**；`content VECTOR(1536)`（可空）；`wiki_page_id VARCHAR(255)` 存页面 **path**（列名有误导性，见 §8）；**无 `(project_id, wiki_page_id)` 唯一约束**；ivfflat `lists=100` 索引 |
| `services/embedding.rs` | 有 `vector_search`(pgvector 余弦) + `get_embeddings`，但后者**硬编码 `text-embedding-ada-002`**、按 per-project `LlmConfig` 取配置、且 `reqwest::Client::new()` 每次新建 |
| ingest pipeline | `run_ingest_job` 全程不调用 embedding —— 根因 |
| omlx `/v1/embeddings` + bge-m3 | **已实测可用**：POST `{base_url}/v1/embeddings`，返回 **1024 维**向量，支持批量输入 |

---

## 2. 关键决策（已与用户确认 + review 修订）

| 决策 | 选择 | 理由 |
|------|------|------|
| 向量库 | **pgvector** | 已在 schema/docker/代码里、内网规模够用；换库是纯负债 |
| embedding 模型 | **bge-m3（本地 via omlx，1024 维）** | 已验证可用、本地免费、多语言、与 Qwen3.6 同栈 |
| 生成编排 | **ingest worker 内、按 job 批量** | 复用现有 worker、批量高效、不加新基础设施 |
| 粒度 | **一页一向量，不切块** | wiki 页是聚焦短文档；长源文档切块是远期 |
| 配置归属 | **全局，且可选**（`Option<EmbeddingConfig>`） | embedding 是基础设施、所有项目共享；未配则 no-op，而非静默调 localhost |

---

## 3. 数据流

embedding 是 `wiki_pages` 的派生数据。两条写入路径都维护它，一条读取路径消费它：

```
写入①  ingest worker（批量，覆盖 source 页 + reserved 页）
  run_ingest_job:
    解析 → step1 LLM → step2 LLM → upsert wiki_pages【现有】
      → rebuild_reserved_pages（index/log/overview 落库）【现有】
      → 收集本 job 全部新/改页面的 (page_path, text)   ← 含 source 页 + reserved 页
      → embed_and_store()  批量嵌入 + bulk upsert embeddings【新】

写入②  pages CRUD（单页）
  create_page / update_page：
      content 非空 → embed_page()
      content 为 None/空 → delete_embedding()（清旧向量，该页不做语义搜索）
  delete_page → delete_embedding()

读取   vector_search()  —— 供 Layer 2b 搜索用（现有函数，列维度变了自动正确）
```

> **关键时序**（review 修订）：`embed_and_store` 必须在 `rebuild_reserved_pages` **之后**调用，且把 reserved 页一并纳入批量——否则 index/log/overview 永远拿不到向量。

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

新增全局 embedding 配置段。**用 `Option<EmbeddingConfig>`**——未配置时不启动 embedding 管线（所有 embed 调用 no-op），而非 `#[serde(default)]`（后者会静默去调 localhost omlx 直至超时）。这样配置缺了 server 照常起、搜索降级，符合"可选基础设施"语义。

```rust
#[derive(Debug, Clone, Deserialize)]
pub struct EmbeddingConfig {
    pub base_url: String,   // http://localhost:8001/v1
    pub model: String,      // bge-m3-mlx-fp16
    pub dim: usize,         // 1024
    pub timeout_secs: u64,  // 60
}
// AppConfig 增加：pub embedding: Option<EmbeddingConfig>
// None → embed_and_store / embed_page no-op（启动时 log 一次 "embedding disabled"）
// delete_embedding 始终生效（纯幂等 SQL DELETE，与 embedding 配置无关，需能清理旧向量）
```

`config/default.json` 仍写入 embedding 段（dev 默认启用）；生产/CI 若不配则自动禁用。

### 5.2 `services/embedding.rs`（重构）

删除旧的 `get_embeddings(text, llm: &LlmConfig)`（硬编码 ada-002 + per-project + 每次 new Client），改为基于全局 `Option<EmbeddingConfig>` 的批量 API + 维护层：

```rust
/// 批量嵌入：一次 HTTP 调 {base_url}/embeddings（bge-m3 支持多文本输入）。
/// 返回与 texts 等长、每条 dim 维的向量。
/// 校验返回维度 == cfg.dim，不一致直接报错（防模型/配置错配静默写入错误维度）。
/// 共享 reqwest::Client（注入 AppState 或 OnceCell），复用连接池，避免每次 new()。
pub async fn embed_batch(cfg: &EmbeddingConfig, client: &reqwest::Client, texts: &[String])
    -> Result<Vec<Vec<f32>>, AppError>;

/// 批量嵌入 + bulk upsert（ingest 用）。pages 形如 (wiki_page_path, text)。
/// cfg 为 None → no-op 返回 Ok(0)。
pub async fn embed_and_store(
    pool: &PgPool, cfg: Option<&EmbeddingConfig>, client: &reqwest::Client,
    project_id: i32, pages: &[(String, String)],
) -> Result<usize /*写入行数*/, AppError>;

/// 单页嵌入（pages CRUD 的 create/update 用，content 非空时）。
pub async fn embed_page(
    pool: &PgPool, cfg: Option<&EmbeddingConfig>, client: &reqwest::Client,
    project_id: i32, path: &str, text: &str,
) -> Result<(), AppError>;

/// 删页向量（pages CRUD 的 delete 用；update 时 content 变 None 也用）。
/// 不接收 cfg——纯幂等 SQL DELETE，与 embedding 配置无关、始终生效（便于清理积攒的旧向量）。
pub async fn delete_embedding(pool: &PgPool, project_id: i32, path: &str)
    -> Result<(), AppError>;
```

`vector_search` 保持不变——它按列读取向量，列维度改成 1024 后自动正确。

**bulk upsert 实现要点**（review #4）：pgvector 不支持把 `Vec<f32>` 直接绑到 vector 列，每条需 `pgvector::Vector::from(vec.clone())` 包装后再 bind。批量构造时逐行 wrap、用 `QueryBuilder::push_values` 拼多值 INSERT：

```sql
INSERT INTO embeddings (project_id, wiki_page_id, content)
VALUES ($1, $2, $3), ... /* 每行 content 是 pgvector::Vector */
ON CONFLICT (project_id, wiki_page_id) DO UPDATE SET content = EXCLUDED.content;
```

### 5.3 `services/ingest_pipeline.rs`

在 `run_ingest_job` 中：upsert 循环收集 source 页的 `(path, content)`；`rebuild_reserved_pages` 改为返回 `Vec<(path, content)>`（reserved 内容本就在函数体内逐条构造，带上零额外成本，避免 rebuild 后再回查 DB），其结果直接并入 `collected`；最后**统一一次** `embed_and_store`：

```rust
// rebuild_reserved 之后（rebuild_reserved_pages 现返回 Vec<(path, content)>）
collected.extend(reserved_pages);  // reserved 也纳入
if !collected.is_empty() {
    if let Err(e) = embedding::embed_and_store(
        &state.db, state.config.embedding.as_ref(), &state.http, job.project_id, &collected,
    ).await {
        result.warnings.push(format!("embed batch: {}", e));  // 非致命
    }
}
```

> `state.http` 为 AppState 新增的共享 `reqwest::Client`（见 §5.1/5.2，连接池复用）。

### 5.4 `routes/pages.rs`

`create_page` / `update_page`：DB 写入成功后，**按 content 是否为空分流**：

```rust
match req.content.as_deref().filter(|s| !s.trim().is_empty()) {
    Some(text) => {
        if let Err(e) = embedding::embed_page(&state.db, state.config.embedding.as_ref(), &state.http, project_id, &req.path, text).await {
            tracing::warn!("embed page {} failed (search degraded): {}", req.path, e);
        }
    }
    None => {
        // content 被清空 → 该页不再适合语义搜索，清掉旧向量（idempotent）
        let _ = embedding::delete_embedding(&state.db, project_id, &req.path).await;
    }
}
// 页面写入结果不受 embedding 成败影响
```

`delete_page`：调 `embedding::delete_embedding`。

embedding 失败**只 log warning，不阻断页面写入**（页面是真源、embedding 是派生）。

---

## 6. 错误处理与幂等

- **配置缺失**：`AppConfig.embedding == None` → 嵌入调用（`embed_and_store`/`embed_page`）no-op（启动时 log 一次 "embedding disabled"）；`delete_embedding` 仍生效（与配置无关）。server 正常起、wiki 正常写，仅无向量搜索。
- **非致命**：embedding 失败（omlx 挂、超时、返回异常、维度不符）→
  - ingest：`result.warnings.push`，job 仍 `succeeded`。
  - pages：log warning，页面写入成功。
  - 后果仅是 search 降级（该页缺向量），不损坏数据。
- **幂等**：
  - 所有 upsert 按 `(project_id, wiki_page_id)` + UNIQUE 约束，重复执行安全。
  - ingest 的 parse 级 content-hash 去重（`ingested_files` 表）已跳过未变更源文件 → 不重复嵌入已处理内容。
- **content 清空**：update 把 content 设 None/空 → `delete_embedding` 清旧向量，避免残留过期向量误导搜索。
- **部分失败**：批量中某页 embed 失败而其它成功时，该页在 `embeddings` 缺行 → `vector_search` 不返回它，keyword 搜索（2b）兜底。

---

## 7. 测试策略

- **单元**（CI 可跑，mock omlx）：
  - `embed_batch`：mock `/v1/embeddings` 响应，断言返回 `texts.len()` 条、每条 `dim` 维；返回维度不符时报错。
  - bulk upsert：`embed_and_store` 两次同一批 → 行数不翻倍（ON CONFLICT）。
  - 配置缺失：`cfg=None` → no-op，不发起 HTTP。
- **集成**（**`#[ignore]`，需 omlx bge-m3 本地运行**——首次在 src-server 引入 `#[ignore]`；pdfium 的 `--ignored` 先例在 src-tauri 桌面端、不跨 crate 复用，但同模式）：
  - ingest 一个文档 → 断言 `embeddings` 表按页填充（source 页 + reserved 页，每页一行、`vector_dims(content)=1024`）。
  - `vector_search("Alice 在哪工作")` 召回 `entities/alice.md`。
- **pages 维护**（单元 + 集成）：create(有content)→embedding 出现；update content→None→embedding 消失；delete→embedding 消失。

> CI 无 omlx/GPU 时，集成测试 `#[ignore]` 不阻塞；本地 `cargo test -- --ignored` 跑全。

---

## 8. 已知限制 / 范围边界

1. **换 embedding 模型需全量重嵌入**：维度或语义变了，旧向量不兼容 → `TRUNCATE embeddings` + 重新 ingest。re-embed 脚本不在 2a 范围。
2. **不切块**：整页一向量。长源文档切块是远期。
3. **配置全局且可选**：所有项目共享 bge-m3；未配则禁用。
4. **embedding 缺失不报错**：omlx 不可用时搜索降级但不阻塞任何写入。
5. **列名 `wiki_page_id` 存的是 path**（历史命名，功能正确，vector_search 的 JOIN 按 `wp.path` 匹配）。本层**不重命名**（重命名要动 migration + 多处 SQL，超出范围）；实现时在代码注释里写明 "stores page path, not integer id"。

---

## 9. 验收标准

- [ ] migration 005 应用后：`embeddings.content` 为 `vector(1024)`，存在 `uniq_embeddings_page` 约束，索引为 HNSW。
- [ ] ingest 一个文档后：每个生成的 wiki 页（**含 reserved 的 index/log/overview**）在 `embeddings` 表有且仅有一行 1024 维向量。
- [ ] 重新 ingest 同一文档（内容未变）：`embeddings` 行数不增加（parse 级去重 + ON CONFLICT）。
- [ ] pages create(有 content) → embedding 出现；update content → None → embedding 消失；delete → embedding 消失。
- [ ] `AppConfig.embedding == None`（配置缺 embedding 段）：server 正常启动，ingest/pages 正常工作，embed 调用 no-op、无 HTTP 发起。
- [ ] omlx 不可用时（配置存在但服务挂）：ingest 仍 succeeded（带 warning）、页面 CRUD 仍成功。
- [ ] `vector_search` 能按语义召回相关页（集成测试覆盖）。

---

## 10. 与后续层的关系

- **2b（search）**：消费本层产出的向量做 vector 分支；keyword 分支已有；hybrid 融合是 2b 的工作。
- **2c（graph）/ 2d（insights）**：不依赖 embedding，可并行设计/实现。

---

## 附录：review 反馈落实记录（2026-06-20）

| # | review 问题 | 落实 |
|---|------------|------|
| 1 | EmbeddingConfig 无缺省→反序列化崩 | `Option<EmbeddingConfig>`，未配 no-op（§5.1/§6） |
| 2 | reserved 页时序错 | `embed_and_store` 挪到 `rebuild_reserved` 之后并纳入 reserved（§3/§5.3） |
| 3 | update_page content=None 未交代 | None/空 → `delete_embedding`（§5.4/§6） |
| 4 | bulk upsert 需 pgvector::Vector 包装 | §5.2 补实现说明 |
| 5 | reqwest::Client 每次 new | 共享 Client 注入 AppState（§5.1/§5.2/§5.3） |
| 6 | wiki_page_id 列名存 path | 不重命名，注释说明（§8） |
| 7 | 集成测试依赖 omlx | `#[ignore]`（§7） |

### 复查 round 2（2026-06-20）

| # | 复查问题 | 落实 |
|---|---------|------|
| 8 | delete_embedding 不该 no-op（签名无 cfg） | no-op 仅限 embed_and_store/embed_page；delete 始终生效（§5.1/§5.2/§6） |
| 9 | rebuild_reserved_pages 返回 Vec<String> 不含 content | 改返回 `Vec<(path, content)>`，零额外成本（§5.3） |
| 10 | `#[ignore]` src-server 无先例 | 措辞改为"首次引入"，不谎称复用（§7） |
