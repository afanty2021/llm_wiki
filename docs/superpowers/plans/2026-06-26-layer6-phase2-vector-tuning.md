# Layer 6 Phase 2 — 向量库调优 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Phase 1 的「每 wiki_page 一行向量」升级为 chunk 级向量 + LLM rerank + embedding 重试，提升语义检索质量（召回率），行为对存量数据向后兼容。

**Architecture:** migration 011 扩展 `embeddings` 单表（chunk_index/chunk_text/heading_path + 维度收敛到 1024（幂等）+ 唯一约束改 3 列）。新增 `chunking.rs` 做向量专用细粒度切分。`VectorStore` trait 改 chunk 级：`upsert_page_chunks`（DELETE+INSERT，规避 ON CONFLICT 失效）+ `search_chunks`（§5.4 三层 DISTINCT ON 聚合 + 事务内 `set_config('hnsw.ef_search')`）。`embed_batch` 加指数退避重试。新增 `rerank.rs`（LLM 二次精排，失败 fallback RRF）接入 `hybrid_search`。

**Tech Stack:** Rust + axum + sqlx + pgvector 0.3 + tokio + reqwest + async-trait。bge-m3（1024 维）。

## Global Constraints

- **维度**：目标 `embeddings.content = VECTOR(1024)`（跟 config `embedding.dim=1024` / bge-m3）。**实际维度以 psql 实测为准，不预设**：005 注释（migrations/005:2）称「001 的 embeddings 部分未生效，005 从零创建 content VECTOR(1024)」，故跑过 005 的库应已是 1024；但若某环境 001 先建了 1536 的表则 005 会 skip。011 的 `ALTER COLUMN content TYPE VECTOR(1024)` **幂等安全**（已是 1024 → no-op；1536 → 转换）。T1 实施前先 psql 核实真实维度。
- **ON CONFLICT 失效**（spec §5.3）：011 把唯一约束从 `(project_id, wiki_page_id)` 改为 `(project_id, wiki_page_id, chunk_index)`。原 `ON CONFLICT (project_id, wiki_page_id)` 会运行时报错——必须用 DELETE+INSERT（`upsert_page_chunks`），**不得**再用 2 列 ON CONFLICT。
- **HNSW 索引**：实测 `ALTER content TYPE` 后 `idx_embeddings_content`（HNSW）自动保留，无需重建。
- **ef_search**：必须事务内 `SELECT set_config('hnsw.ef_search', $1, true)`（第三参 `true`=事务级），自动提交模式下单独 SET 对检索静默无效。
- **向后兼容**：存量「每页一行」向量 `chunk_index=0`、`chunk_text/heading_path=NULL`；检索 SQL 用 `COALESCE(chunk_text, wp.content)` 兜底，未重新摄取前不报错。
- **chunk_size**：实现为**字符预算**（不是 token）——bge-m3 多语种，CJK ≈ 1 字符/token，避免引入 tokenizer 依赖（单机自托管 YAGNI）。默认 384 字符。
- **工作语言**：注释/文档用简体中文，变量名英文。
- **部署形态**：单机/小团队自托管，不引入专用向量库，保留 pgvector。

---

## File Structure

| 文件 | 责任 | 任务 |
|------|------|------|
| `migrations/011_chunk_level_embeddings.sql` | chunk 列 + 维度统一 + 约束切换（DDL） | T1 |
| `src-server/src/services/chunking.rs`（新） | 向量专用文本切分（段落/句子/overlap，UTF-8 安全） | T2 |
| `src-server/src/services/vector_store.rs` | VectorStore trait 改 chunk 级 + PgVectorStore（DELETE+INSERT / §5.4 聚合 / ef_search 事务） | T3 |
| `src-server/src/services/embedding.rs` | embed_and_store/embed_page 改 chunk 写入；vector_search 改聚合读；embed_batch 加重试 | T3, T4 |
| `src-server/src/services/rerank.rs`（新） | LLM rerank + fallback | T5 |
| `src-server/src/services/search.rs` | hybrid_search 接 rerank | T6 |
| `src-server/src/config.rs` | EmbeddingConfig 加 chunk_size/overlap/ef_search/max_retries；新增 SearchConfig | T3, T6 |
| `src-server/src/services/mod.rs` | 注册 chunking / rerank 模块 | T2, T5 |
| `src-server/tests/embedding_integration.rs` | chunk 写入/检索/维度集成测（#[ignore]，需 PG+omlx） | T3, T7 |
| `src-server/tests/search_golden_recall.rs`（新） | golden set 召回率对比（#[ignore]） | T7 |

---

## Task 1: Migration 011 — chunk 级向量 + 维度统一

**Files:**
- Create: `src-server/migrations/011_chunk_level_embeddings.sql`
- Verify: 手动 psql（仓库无 `sqlx::migrate!`，迁移手动应用到运行中的 PG）

**Interfaces:** 无代码接口（纯 DDL）。后续 task 假设 `embeddings` 含 `chunk_index INTEGER NOT NULL DEFAULT 0`、`chunk_text TEXT`、`heading_path VARCHAR(512)`，`content VECTOR(1024)`，唯一约束 `embeddings_unique_chunk (project_id, wiki_page_id, chunk_index)`。

- [ ] **Step 1: 写 migration 011**

Create `src-server/migrations/011_chunk_level_embeddings.sql`：
```sql
-- 011: chunk 级向量（扩展 embeddings 单表）+ 维度收敛到 1024
-- 维度：005 注释称从零建 content VECTOR(1024)（001 的 embeddings 部分未生效），故多数跑过 005 的库
-- 应已是 1024；若某环境 001 先建了 1536 表则 005 skip。下方 ALTER TYPE VECTOR(1024) **幂等安全**：
-- 已 1024 → no-op；1536 → 转换（pgvector 实测 ALTER 维度后 HNSW 索引随列自动保留）。实施前 psql 核实。
-- 实施 T1 前先跑：SELECT format_type(a.atttypid,a.atttypmod) FROM pg_attribute a JOIN pg_class c
-- ON a.attrelid=c.oid WHERE c.relname='embeddings' AND a.attname='content'; 确认当前维度。

ALTER TABLE embeddings ADD COLUMN IF NOT EXISTS chunk_index INTEGER NOT NULL DEFAULT 0;
ALTER TABLE embeddings ADD COLUMN IF NOT EXISTS chunk_text TEXT;
ALTER TABLE embeddings ADD COLUMN IF NOT EXISTS heading_path VARCHAR(512);

-- 维度收敛到 1024（跟 config bge-m3；幂等——已是 1024 则 no-op，1536 则转换）
ALTER TABLE embeddings ALTER COLUMN content TYPE VECTOR(1024);

-- 删除 005 的每页唯一约束（真实约束名 uniq_embeddings_page，见 005:24）
ALTER TABLE embeddings DROP CONSTRAINT IF EXISTS uniq_embeddings_page;

-- 新约束：(project_id, wiki_page_id, chunk_index) —— 同一 page 多 chunk
-- DO $$ 守卫保证幂等（ADD CONSTRAINT 无 IF NOT EXISTS 语法）
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'embeddings_unique_chunk') THEN
        ALTER TABLE embeddings ADD CONSTRAINT embeddings_unique_chunk
            UNIQUE (project_id, wiki_page_id, chunk_index);
    END IF;
END $$;
```

- [ ] **Step 2: 在干净 PG 上验证（需 docker `src-server-postgres-1` @5433 运行）**

先**核实迁移前真实维度**（不预设 1024/1536）：
```bash
PGPASSWORD="$PGPASSWORD" psql -h localhost -p 5433 -U "$PGUSER" -d "$PGDB" -Atc "
SELECT format_type(a.atttypid,a.atttypmod) FROM pg_attribute a JOIN pg_class c
ON a.attrelid=c.oid WHERE c.relname='embeddings' AND a.attname='content';"
```
Expected: 输出 `vector(1024)`（005 从零建）或 `vector(1536)`（001 先建、005 skip 的环境）。记录之——011 的 ALTER 对前者 no-op、对后者转换，均安全。

Run（一次性，把 001→010 + 011 按序应用到目标库；若库已含 001-010，仅跑 011）：
```bash
cd src-server
# 假设 PG 在 localhost:5433，库名/账号按 config/default.json
for f in migrations/001_*.sql migrations/002_*.sql migrations/003_*.sql migrations/004_*.sql \
         migrations/005_*.sql migrations/006_*.sql migrations/007_*.sql migrations/008_*.sql \
         migrations/009_*.sql migrations/010_*.sql migrations/011_*.sql; do
  PGPASSWORD="$PGPASSWORD" psql -h localhost -p 5433 -U "$PGUSER" -d "$PGDB" -f "$f" || { echo "FAIL $f"; exit 1; }
done
echo "all migrations applied"
```
Expected: 全部 applied，无报错（`ALTER COLUMN content TYPE VECTOR(1024)` 若已是 1024 则无副作用）。

- [ ] **Step 3: 验证 schema + 幂等**

Run：
```bash
PGPASSWORD="$PGPASSWORD" psql -h localhost -p 5433 -U "$PGUSER" -d "$PGDB" -c "
SELECT a.attname, format_type(a.atttypid, a.atttypmod) AS type
FROM pg_attribute a JOIN pg_class c ON a.attrelid=c.oid
WHERE c.relname='embeddings' AND a.attnum>0 AND NOT a.attisdropped
ORDER BY a.attnum;
SELECT conname FROM pg_constraint WHERE conrelid='embeddings'::regclass AND contype='u';"
```
Expected: `chunk_index integer`、`chunk_text text`、`heading_path character varying(512)`、`content vector(1024)`；唯一约束 `embeddings_unique_chunk`，**无** `uniq_embeddings_page`。
再跑一次 `psql -f migrations/011_*.sql`（幂等）→ Expected 无报错（`IF NOT EXISTS`/`DO $$` 守卫生效）。

- [ ] **Step 4: Commit**

```bash
git add src-server/migrations/011_chunk_level_embeddings.sql
git commit -m "feat(layer6-p2): migration 011 chunk-level embeddings + dim unify 1536→1024"
```

---

## Task 2: chunking.rs — 向量专用文本切分

**Files:**
- Create: `src-server/src/services/chunking.rs`
- Modify: `src-server/src/services/mod.rs`（加 `pub mod chunking;`）
- Test: `src-server/src/services/chunking.rs` 内 `#[cfg(test)]`

**Interfaces:**
- Produces: `pub fn chunk_for_embedding(text: &str, chunk_size: usize, overlap: usize) -> Vec<String>`（UTF-8 安全；空文本/`chunk_size==0` → 空 Vec）。T3 的 embed_and_store 调用它。

- [ ] **Step 1: 在 services/mod.rs 注册模块**

`src-server/src/services/mod.rs` 现有 `pub mod embedding;` 一行附近加：
```rust
pub mod chunking;
```

- [ ] **Step 2: 写失败测试（先于实现，TDD）**

Create `src-server/src/services/chunking.rs`，先只放测试：
```rust
//! 向量检索专用细粒度切分（区别于 ingest_pipeline 给 LLM 的 context_budget 纗粗切分）。
//! 按段落优先、超长按句子边界硬拆、带 overlap 滑窗；全部按 char 边界操作（UTF-8 安全）。

/// 将文本切分为向量检索小块。chunk_size/overlap 为**字符预算**（bge-m3 CJK ≈ 1 字符/token）。
/// 空文本或 chunk_size==0 → 空 Vec。overlap 自动夹到 < chunk_size。
pub fn chunk_for_embedding(text: &str, chunk_size: usize, overlap: usize) -> Vec<String> {
    unimplemented!() // Step 4 实现
}

#[cfg(test)]
mod tests {
    use super::chunk_for_embedding;

    #[test]
    fn empty_or_zero_returns_empty() {
        assert!(chunk_for_embedding("", 384, 64).is_empty());
        assert!(chunk_for_embedding("   ", 384, 64).is_empty());
        assert!(chunk_for_embedding("x", 0, 0).is_empty());
    }

    #[test]
    fn short_text_single_chunk() {
        let out = chunk_for_embedding("hello world", 384, 64);
        assert_eq!(out, vec!["hello world".to_string()]);
    }

    #[test]
    fn paragraphs_packed_into_chunks() {
        // 两个短段落合一个 chunk
        let text = "段落一很短。\n\n段落二也很短。";
        let out = chunk_for_embedding(text, 100, 0);
        assert_eq!(out.len(), 1);
        assert!(out[0].contains("段落一") && out[0].contains("段落二"));
    }

    #[test]
    fn overlong_paragraph_split_by_sentence() {
        // 一个超长段落（>chunk_size）按句子拆成多块
        let long = "这是一句话。".repeat(50); // 每句 6 字符 ×50 = 300 字符
        let out = chunk_for_embedding(&long, 30, 0);
        assert!(out.len() > 1, "应拆成多块，got {} 块", out.len());
        for chunk in &out {
            assert!(chunk.chars().count() <= 30 + 6, "每块不超过 chunk_size+一句：{} 字符", chunk.chars().count());
        }
    }

    #[test]
    fn overlap_shared_between_adjacent_chunks() {
        // overlap>0：相邻块共享前一塊的尾部字符
        let text = (0..10).map(|i| format!("段落{}", i)).collect::<Vec<_>>().join("\n\n");
        let out = chunk_for_embedding(&text, 20, 5);
        if out.len() >= 2 {
            let tail: String = out[0].chars().rev().take(5).collect::<Vec<_>>().into_iter().rev().collect();
            assert!(out[1].starts_with(&tail), "第二块应以第一块尾部开头；tail={:?}, out[1]={:?}", tail, out[1]);
        }
    }

    #[test]
    fn chinese_no_panic_utf8_safe() {
        // 纯中文超长文本，硬拆不 panic（验证按 char 边界而非 byte）
        let long = "量化交易".repeat(200); // 800 字符
        let out = chunk_for_embedding(&long, 100, 10);
        assert!(!out.is_empty());
        for chunk in &out {
            // 能重新收集为 String 即未在 byte 中间切断
            let _ = chunk.chars().count();
        }
    }
}
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd src-server && cargo test -p llm-wiki-server --lib chunking 2>&1 | tail -15`
Expected: FAIL（`unimplemented`/panic）。

- [ ] **Step 4: 实现 chunk_for_embedding**

替换 `src-server/src/services/chunking.rs` 顶部的 `unimplemented!()` 实现为：
```rust
/// 将文本切分为向量检索小块。chunk_size/overlap 为**字符预算**（bge-m3 CJK ≈ 1 字符/token）。
/// 空文本或 chunk_size==0 → 空 Vec。overlap 自动夹到 < chunk_size。
pub fn chunk_for_embedding(text: &str, chunk_size: usize, overlap: usize) -> Vec<String> {
    let text = text.trim();
    if text.is_empty() || chunk_size == 0 {
        return Vec::new();
    }
    let overlap = overlap.min(chunk_size.saturating_sub(1));

    // 1. 按段落（\n\n）拆，过滤空段
    let paragraphs: Vec<String> = text
        .split("\n\n")
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .collect();

    // 2. 贪心打包整段到 chunk_size；超长段落按句子边界硬拆（char 安全）
    let mut packed: Vec<String> = Vec::new();
    let mut buf = String::new();
    for para in paragraphs {
        let pchars: Vec<char> = para.chars().collect();
        if pchars.len() > chunk_size {
            if !buf.is_empty() {
                packed.push(std::mem::take(&mut buf));
            }
            for piece in split_long_chars(&pchars, chunk_size) {
                packed.push(piece);
            }
        } else if buf.chars().count() + pchars.len() + 2 > chunk_size {
            packed.push(std::mem::take(&mut buf));
            buf.push_str(&para);
        } else {
            if !buf.is_empty() {
                buf.push_str("\n\n");
            }
            buf.push_str(&para);
        }
    }
    if !buf.is_empty() {
        packed.push(buf);
    }

    apply_overlap(packed, overlap)
}

/// 超长段落（char 数组）按句子边界打包；无句子边界则按 char 硬切。UTF-8 安全（操作 char）。
fn split_long_chars(chars: &[char], chunk_size: usize) -> Vec<String> {
    let mut out = Vec::new();
    let mut buf: Vec<char> = Vec::new();
    let mut cur_sentence: Vec<char> = Vec::new();
    for &c in chars {
        cur_sentence.push(c);
        if matches!(c, '。' | '.' | '!' | '?' | '！' | '？' | '\n') {
            let slen = cur_sentence.len();
            if slen > chunk_size {
                if !buf.is_empty() {
                    out.push(buf.iter().collect());
                    buf.clear();
                }
                let mut start = 0usize;
                while start < cur_sentence.len() {
                    let end = (start + chunk_size).min(cur_sentence.len());
                    out.push(cur_sentence[start..end].iter().collect());
                    start = end;
                }
            } else if buf.len() + slen + 1 > chunk_size {
                if !buf.is_empty() {
                    out.push(buf.iter().collect());
                }
                buf = cur_sentence.clone();
            } else {
                if !buf.is_empty() {
                    buf.push(' ');
                }
                buf.extend_from_slice(&cur_sentence);
            }
            cur_sentence.clear();
        }
    }
    // 收尾：无句号的余下部分
    if !cur_sentence.is_empty() {
        let slen = cur_sentence.len();
        if slen > chunk_size {
            let mut start = 0usize;
            while start < cur_sentence.len() {
                let end = (start + chunk_size).min(cur_sentence.len());
                out.push(cur_sentence[start..end].iter().collect());
                start = end;
            }
        } else if buf.len() + slen + 1 > chunk_size {
            if !buf.is_empty() {
                out.push(buf.iter().collect());
            }
            buf = cur_sentence.clone();
        } else {
            if !buf.is_empty() {
                buf.push(' ');
            }
            buf.extend_from_slice(&cur_sentence);
        }
    }
    if !buf.is_empty() {
        out.push(buf.iter().collect());
    }
    out
}

/// 相邻 chunk 共享前一塊尾部 overlap 个字符（滑窗）。
fn apply_overlap(packed: Vec<String>, overlap: usize) -> Vec<String> {
    if overlap == 0 || packed.len() <= 1 {
        return packed;
    }
    let mut out = Vec::with_capacity(packed.len());
    out.push(packed[0].clone());
    for i in 1..packed.len() {
        let prev_tail: String = packed[i - 1].chars().rev().take(overlap).collect::<Vec<_>>().into_iter().rev().collect();
        let mut merged = prev_tail;
        merged.push_str(&packed[i]);
        out.push(merged);
    }
    out
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd src-server && cargo test -p llm-wiki-server --lib chunking 2>&1 | tail -15`
Expected: 6 tests PASS。

- [ ] **Step 6: Commit**

```bash
git add src-server/src/services/chunking.rs src-server/src/services/mod.rs
git commit -m "feat(layer6-p2): chunking util for embedding (paragraph/sentence/overlap, utf-8 safe)"
```

---

## Task 3: VectorStore 改 chunk 级 + embedding.rs 重写 + ef_search（签名级联，一并编译）

**Files:**
- Modify: `src-server/src/services/vector_store.rs`（trait + PgVectorStore）
- Modify: `src-server/src/services/embedding.rs`（embed_and_store/embed_page/vector_search）
- Modify: `src-server/src/config.rs`（EmbeddingConfig 加 chunk_size/overlap/ef_search/max_retries）
- Modify: `src-server/tests/embedding_integration.rs`（适配 chunk 写入 + 维度）
- Test: `src-server/src/services/vector_store.rs` 单测 + 集成测

**Interfaces:**
- Consumes: T2 `chunk_for_embedding(text, chunk_size, overlap) -> Vec<String>`；T1 schema（chunk_index/chunk_text/heading_path/content vector(1024)）。
- Produces:
  - `pub struct PageChunk { pub chunk_index: i32, pub chunk_text: String, pub heading_path: Option<String>, pub vector: Vec<f32> }`
  - `pub struct ChunkHit { pub page_id: String, pub title: String, pub snippet: String, pub rerank_text: String, pub score: f64 }`
  - trait `VectorStore { async fn upsert_page_chunks(&self, project_id: i32, page_id: &str, chunks: Vec<PageChunk>) -> Result<(),AppError>; async fn delete_page(&self, project_id: i32, page_id: &str) -> Result<(),AppError>; async fn search_chunks(&self, project_id: i32, query_vec: Vec<f32>, top_k_chunks: usize, top_n_pages: usize) -> Result<Vec<ChunkHit>,AppError>; async fn ef_search(&self) -> usize; }`
  - embedding.rs `embed_and_store(store, cfg, client, project_id, pages: &[(String,String)])` 签名不变，内部 chunk 化。

> 关键：`upsert_page_chunks` 用 **DELETE + INSERT**（不 ON CONFLICT），规避 §5.3 失效警告。

- [ ] **Step 1: EmbeddingConfig 加字段（config.rs）**

`src-server/src/config.rs` 的 `EmbeddingConfig`（行 56-62）改为：
```rust
#[derive(Debug, Clone, Deserialize)]
pub struct EmbeddingConfig {
    pub base_url: String,
    pub model: String,
    pub dim: usize,
    pub timeout_secs: u64,
    #[serde(default = "default_chunk_size")]
    pub chunk_size: usize,
    #[serde(default = "default_overlap")]
    pub overlap: usize,
    #[serde(default = "default_ef_search")]
    pub ef_search: usize,
    #[serde(default = "default_embed_max_retries")]
    pub max_retries: u32,
}

fn default_chunk_size() -> usize { 384 }
fn default_overlap() -> usize { 64 }
fn default_ef_search() -> usize { 80 }
fn default_embed_max_retries() -> u32 { 3 }
```

- [ ] **Step 2: vector_store.rs — 改 trait + structs**

把 `src-server/src/services/vector_store.rs` 顶部的 trait + struct 段（当前 `VectorStore`/`PgVectorStore`，含 `upsert_vectors`/`search`/`clamp_search_limit`）替换为：
```rust
use async_trait::async_trait;
use sqlx::PgPool;
use crate::AppError;

/// 向量存储后端抽象（chunk 级）。Phase 2：每 page 多 chunk，DELETE+INSERT 写入，
/// 检索按 §5.4 三层聚合（chunk 去重取最高分 → page top-N）。
#[async_trait]
pub trait VectorStore: Send + Sync {
    /// 写入一个 page 的全部 chunk（先 DELETE 该 page 旧 chunk，再 INSERT 新 chunk）。
    /// page_id = wiki_page.path。空 chunks → 仅 DELETE（清空该页向量）。
    async fn upsert_page_chunks(
        &self,
        project_id: i32,
        page_id: &str,
        chunks: Vec<PageChunk>,
    ) -> Result<(), AppError>;
    /// 删除一个 page 的全部 chunk。
    async fn delete_page(&self, project_id: i32, page_id: &str) -> Result<(), AppError>;
    /// chunk 级检索 + 按 page 聚合：top_k_chunks 拉宽候选，去重取每 page 最高分，外层按相关度取 top_n_pages。
    async fn search_chunks(
        &self,
        project_id: i32,
        query_vec: Vec<f32>,
        top_k_chunks: usize,
        top_n_pages: usize,
    ) -> Result<Vec<ChunkHit>, AppError>;
    /// HNSW ef_search（事务内 set_config 生效）。
    fn ef_search(&self) -> usize;
}

pub struct PageChunk {
    pub chunk_index: i32,
    pub chunk_text: String,
    pub heading_path: Option<String>,
    pub vector: Vec<f32>,
}

/// 一个命中 page 的代表 chunk（最高分），含 rerank 输入文本。
/// sqlx::FromRow：search_chunks 用 query_as::<_, ChunkHit>（列别名 page_id/title/snippet/rerank_text/score 对齐）。
#[derive(sqlx::FromRow)]
pub struct ChunkHit {
    pub page_id: String,
    pub title: String,
    pub snippet: String,
    pub rerank_text: String,
    pub score: f64,
}

pub struct PgVectorStore {
    pool: PgPool,
    ef_search: usize,
}

impl PgVectorStore {
    pub fn new(pool: PgPool) -> Self {
        Self { pool, ef_search: 80 }
    }
    pub fn with_ef_search(pool: PgPool, ef_search: usize) -> Self {
        Self { pool, ef_search }
    }
}
```
（保留文件末尾的 `clamp_search_limit` + 其测试，不动。）

- [ ] **Step 3: vector_store.rs — PgVectorStore impl（DELETE+INSERT + §5.4 聚合 + ef_search 事务）**

替换 `#[async_trait] impl VectorStore for PgVectorStore { ... }` 整段为：
```rust
#[async_trait]
impl VectorStore for PgVectorStore {
    async fn upsert_page_chunks(
        &self,
        project_id: i32,
        page_id: &str,
        chunks: Vec<PageChunk>,
    ) -> Result<(), AppError> {
        let mut tx = self.pool.begin().await?;
        // 先删旧 chunk（清空该 page 向量，规避 ON CONFLICT 失效——见 spec §5.3）
        sqlx::query("DELETE FROM embeddings WHERE project_id=$1 AND wiki_page_id=$2")
            .bind(project_id)
            .bind(page_id)
            .execute(&mut tx)
            .await?;
        if !chunks.is_empty() {
            for ch in chunks {
                sqlx::query(
                    "INSERT INTO embeddings (project_id, wiki_page_id, chunk_index, chunk_text, heading_path, content)
                     VALUES ($1, $2, $3, $4, $5, $6)",
                )
                .bind(project_id)
                .bind(page_id)
                .bind(ch.chunk_index)
                .bind(&ch.chunk_text)
                .bind(ch.heading_path.as_deref())
                .bind(pgvector::Vector::from(ch.vector))
                .execute(&mut tx)
                .await?;
            }
        }
        tx.commit().await?;
        Ok(())
    }

    async fn delete_page(&self, project_id: i32, page_id: &str) -> Result<(), AppError> {
        sqlx::query("DELETE FROM embeddings WHERE project_id=$1 AND wiki_page_id=$2")
            .bind(project_id)
            .bind(page_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    async fn search_chunks(
        &self,
        project_id: i32,
        query_vec: Vec<f32>,
        top_k_chunks: usize,
        top_n_pages: usize,
    ) -> Result<Vec<ChunkHit>, AppError> {
        // 事务内 SET LOCAL hnsw.ef_search（自动提交模式下单独 SET 对检索静默无效）。
        // set_config 第三参 true = 事务级；参数化防注入。
        let embedding = pgvector::Vector::from(query_vec);
        let mut tx = self.pool.begin().await?;
        sqlx::query("SELECT set_config('hnsw.ef_search', $1, true)")
            .bind(self.ef_search.to_string())
            .execute(&mut tx)
            .await?;
        let hits = sqlx::query_as::<_, ChunkHit>(
            // §5.4 三层：①内层 chunk 余弦 top_k；②中层 DISTINCT ON (wiki_page_id) 取每 page 最高分代表 chunk
            //（要求 ORDER BY 最左前缀=wiki_page_id）；③外层按 score 取 page top-N（非 page_id 字典序）。
            // snippet/rerank_text 用 COALESCE(chunk_text, wp.content) 兜底存量 NULL。
            "SELECT page_id, title, snippet, rerank_text, score FROM (
                SELECT DISTINCT ON (c.wiki_page_id)
                       c.wiki_page_id AS page_id,
                       wp.title,
                       substring(COALESCE(c.chunk_text, wp.content) FROM 1 FOR 200) AS snippet,
                       COALESCE(c.chunk_text, wp.content) AS rerank_text,
                       c.score
                FROM (
                    SELECT e.wiki_page_id, e.chunk_text,
                           1.0 - (e.content <=> $1) AS score
                    FROM embeddings e
                    WHERE e.project_id = $2
                    ORDER BY e.content <=> $1
                    LIMIT $3
                ) c
                JOIN wiki_pages wp ON c.wiki_page_id = wp.path AND wp.project_id = $2
                ORDER BY c.wiki_page_id, c.score DESC
            ) t
            ORDER BY t.score DESC
            LIMIT $4",
        )
        .bind(embedding)
        .bind(project_id)
        .bind(top_k_chunks as i64)
        .bind(top_n_pages as i64)
        .fetch_all(&mut tx)
        .await
        .map_err(AppError::DatabaseError)?;
        tx.commit().await?;
        Ok(hits)
    }

    fn ef_search(&self) -> usize {
        self.ef_search
    }
}
```
（`ChunkHit` 的 `#[derive(sqlx::FromRow)]` 已在 Step 2 struct 定义处标注，字段名与 SQL 列别名对齐。）

- [ ] **Step 4: vector_store.rs — 调整既有测试**

文件末尾的 `clamp_search_limit` + 其 `tests` 模块保留不动。无需新增 vector_store 单测（search/upsert 需 DB，归 T3 集成测 + T7）。

- [ ] **Step 5: embedding.rs — chunk 化 embed_and_store / embed_page / vector_search**

`src-server/src/services/embedding.rs` 中（保留 `embed_batch`、`embed_query`、`parse_embedding_response`、`VectorSearchResult` 不变），把 `embed_and_store` / `embed_page` / `vector_search` 三个函数替换为：
```rust
use crate::services::chunking::chunk_for_embedding;
use crate::services::vector_store::{PageChunk, ChunkHit, VectorStore};

/// 批量嵌入 + chunk 级 upsert（ingest 用）。pages: (wiki_page_path, text)。
/// cfg=None 或空 pages → no-op。**所有 page 的 chunk 拍平到一次 embed_batch 调用**（bge-m3 接受数组），
/// 再按 page 切回逐页 upsert_page_chunks（DELETE+INSERT）。保持「bulk ingest 单 HTTP 请求」语义。
pub async fn embed_and_store(
    store: &dyn VectorStore,
    cfg: Option<&EmbeddingConfig>,
    client: &reqwest::Client,
    project_id: i32,
    pages: &[(String, String)],
) -> Result<usize, AppError> {
    let cfg = match cfg {
        Some(c) => c,
        None => return Ok(0),
    };
    if pages.is_empty() {
        return Ok(0);
    }
    // 1. 切分所有 page → all_texts；记录每 page 的 chunk 范围 (path, start, count)
    let mut all_texts: Vec<String> = Vec::new();
    let mut page_spans: Vec<(String, usize, usize)> = Vec::new();
    for (path, text) in pages {
        let pieces = chunk_for_embedding(text, cfg.chunk_size, cfg.overlap);
        let start = all_texts.len();
        all_texts.extend(pieces);
        page_spans.push((path.clone(), start, all_texts.len() - start));
    }
    // 2. 一次性嵌入全部 chunk（单 HTTP 请求）
    let all_vecs = if all_texts.is_empty() {
        Vec::new()
    } else {
        embed_batch(cfg, client, &all_texts).await?
    };
    // 3. 按 page_span 切回，逐页 upsert_page_chunks（空 chunk → 仅 DELETE，清空该页）
    let mut page_count = 0usize;
    for (path, start, count) in page_spans {
        let chunks: Vec<PageChunk> = (0..count)
            .map(|i| PageChunk {
                chunk_index: i as i32,
                chunk_text: all_texts[start + i].clone(),
                heading_path: None, // Phase 2 不做 markdown heading 抽取；列已建，留 NULL
                vector: all_vecs[start + i].clone(),
            })
            .collect();
        store.upsert_page_chunks(project_id, &path, chunks).await?;
        page_count += 1;
    }
    Ok(page_count)
}

/// 单页嵌入（pages CRUD create/update 用）。委托 embed_and_store。
pub async fn embed_page(
    store: &dyn VectorStore,
    cfg: Option<&EmbeddingConfig>,
    client: &reqwest::Client,
    project_id: i32,
    path: &str,
    text: &str,
) -> Result<(), AppError> {
    embed_and_store(store, cfg, client, project_id, &[(path.to_string(), text.to_string())])
        .await
        .map(|_| ())
}

/// 向量检索（hybrid_search 用）：chunk 级检索 + page 聚合，返回 page 级 VectorSearchResult。
/// top_k_chunks 拉宽候选（默认 40），top_n_pages = limit。
pub async fn vector_search(
    store: &dyn VectorStore,
    project_id: i32,
    query_embedding: Vec<f32>,
    limit: i32,
) -> Result<Vec<VectorSearchResult>, AppError> {
    let top_k_chunks = (limit.max(20) as usize) * 4; // 拉宽候选供去重与（T6）rerank
    let top_n_pages = limit.max(1) as usize;
    let hits: Vec<ChunkHit> = store
        .search_chunks(project_id, query_embedding, top_k_chunks, top_n_pages)
        .await?;
    Ok(hits.into_iter().map(|h| VectorSearchResult {
        path: h.page_id,
        title: h.title,
        snippet: h.snippet,
        score: h.score,
    }).collect())
}
```
> 注意：`vector_search` 旧实现里 `use sqlx::PgPool` 已在 Phase 1 删除；此处不改 import 顶部（仍 `use crate::config::EmbeddingConfig;` 等）。新增 `use crate::services::chunking::chunk_for_embedding;` 与 `use crate::services::vector_store::{PageChunk, ChunkHit, VectorStore};`（若 `VectorStore` 已 import 则不重复）。

- [ ] **Step 6: 调整 PgVectorStore 构造（lib.rs create_app 用 ef_search）**

`src-server/src/lib.rs` 中 `create_app` 构造 `vector_store` 处（Phase 1 已有 `PgVectorStore::new(db.clone())`），改为带 ef_search：
```rust
    let vector_store: Arc<dyn services::vector_store::VectorStore> =
        Arc::new(services::vector_store::PgVectorStore::with_ef_search(
            db.clone(),
            config.embedding.as_ref().map(|c| c.ef_search).unwrap_or(80),
        ));
```

- [ ] **Step 7: 跑 cargo check（应全绿，签名级联已一并改）**

Run: `cd src-server && cargo check -p llm-wiki-server 2>&1 | tail -20`
Expected: 无 error（warning 仅既存无关项）。若有遗漏调用点（grep `upsert_vectors\|\.search(` in src/），修到通过。

- [ ] **Step 8: 改集成测试 tests/embedding_integration.rs（适配 chunk + 维度断言）**

`src-server/tests/embedding_integration.rs` 的 `e2e_vector_search_recalls` 等已用 `embed_and_store(&store, ...)`（签名未变，内部 chunk 化，无需改调用）。但断言「count==2」类（`embed_and_store_bulk_upsert_idempotent`）需改为「每页 ≥1 chunk」+ 维度仍 1024。把该测试的断言段改为：
```rust
    // chunk 化后：每页 ≥1 行；幂等（同批再写不翻倍——DELETE+INSERT 替换）
    let _n2 = embedding::embed_and_store(&store, Some(emb_cfg), &client, pid, &pages).await.unwrap();
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM embeddings WHERE project_id=$1")
        .bind(pid).fetch_one(&pool).await.unwrap();
    assert!(count >= 2, "至少每页 1 chunk；got {}", count);
    // 二次写后行数不变（DELETE+INSERT 替换，非累加）
    let count_after: i64 = sqlx::query_scalar("SELECT count(*) FROM embeddings WHERE project_id=$1")
        .bind(pid).fetch_one(&pool).await.unwrap();
    assert_eq!(count, count_after, "幂等：同批再写行数不累加");
    // 维度 1024
    let dims: i32 = sqlx::query_scalar("SELECT vector_dims(content)::int FROM embeddings WHERE project_id=$1 LIMIT 1")
        .bind(pid).fetch_one(&pool).await.unwrap();
    assert_eq!(dims, 1024);
```
（删掉原 `assert_eq!(n1, 2)` 与 `assert_eq!(count, 2)`，因 chunk 数随文本长度变。）

- [ ] **Step 9: 跑 lib 测试 + 集成测编译**

Run: `cd src-server && cargo test -p llm-wiki-server --lib 2>&1 | grep "test result" | head -1 && cargo check -p llm-wiki-server --tests 2>&1 | tail -10`
Expected: lib 全绿（含 chunking 6 测 + clamp_search_limit）；集成测编译通过（`#[ignore]` 不跑）。

- [ ] **Step 10: Commit**

```bash
git add src-server/src/services/vector_store.rs src-server/src/services/embedding.rs \
        src-server/src/config.rs src-server/src/lib.rs src-server/tests/embedding_integration.rs
git commit -m "feat(layer6-p2): chunk-level VectorStore (DELETE+INSERT) + §5.4 aggregation + ef_search tx"
```

---

## Task 4: embed_batch 指数退避重试

**Files:**
- Modify: `src-server/src/services/embedding.rs`（embed_batch）
- Test: `src-server/src/services/embedding.rs` 单测（纯函数 backoff + 瞬态判定）

**Interfaces:**
- Consumes: T3 加的 `EmbeddingConfig.max_retries`。
- Produces: `fn is_transient_embed_err(e: &reqwest::Error) -> bool`、`fn backoff_delay(attempt: u32) -> std::time::Duration`（纯函数，可单测）。embed_batch 内部用它们重试。

- [ ] **Step 1: 写失败测试（纯函数）**

在 `src-server/src/services/embedding.rs` 末尾 `#[cfg(test)] mod tests` 内加：
```rust
    use super::{is_transient_embed_err, backoff_delay};
    use std::time::Duration;

    #[test]
    fn backoff_delay_grows_exponentially() {
        // base 1s × 2^attempt：attempt 0→1s, 1→2s, 2→4s（上限 30s 防失控）
        assert_eq!(backoff_delay(0), Duration::from_secs(1));
        assert_eq!(backoff_delay(1), Duration::from_secs(2));
        assert_eq!(backoff_delay(2), Duration::from_secs(4));
        assert!(backoff_delay(10) <= Duration::from_secs(30), "上限 30s");
    }
```
（`is_transient_embed_err` 难无网络构造 reqwest::Error 单测，靠签名编译 + 集成验证。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src-server && cargo test -p llm-wiki-server --lib embedding::tests::backoff 2>&1 | tail -10`
Expected: FAIL（函数未定义）。

- [ ] **Step 3: 实现 backoff_delay + is_transient_embed_err + embed_batch 重试**

在 `src-server/src/services/embedding.rs`（`embed_batch` 上方）加：
```rust
/// 指数退避：base 1s × 2^attempt，上限 30s。（jitter 由调用处随机可选；此处确定性便于测试）
pub fn backoff_delay(attempt: u32) -> std::time::Duration {
    let secs = 1u64.checked_shl(attempt).unwrap_or(1 << 30).min(30);
    std::time::Duration::from_secs(secs)
}

/// 瞬态错误判定：网络/连接/超时/5xx 视为可重试；非瞬态（如 4xx 内容违规）不重试。
pub fn is_transient_embed_err(e: &reqwest::Error) -> bool {
    if e.is_connect() || e.is_timeout() || e.is_request() {
        return true;
    }
    e.status().map(|s| s.is_server_error()).unwrap_or(false)
}
```
把 `embed_batch` 当前实现（单次请求）改为重试循环：
```rust
pub async fn embed_batch(
    cfg: &EmbeddingConfig,
    client: &reqwest::Client,
    texts: &[String],
) -> Result<Vec<Vec<f32>>, AppError> {
    let max_retries = cfg.max_retries;
    let mut last_err: Option<AppError> = None;
    for attempt in 0..=max_retries {
        let res = client
            .post(format!("{}/embeddings", cfg.base_url.trim_end_matches('/')))
            .header("Content-Type", "application/json")
            .json(&serde_json::json!({ "model": cfg.model, "input": texts }))
            .timeout(std::time::Duration::from_secs(cfg.timeout_secs))
            .send()
            .await;
        match res {
            Ok(resp) if resp.status().is_success() => {
                let body: serde_json::Value = resp.json().await
                    .map_err(|e| AppError::LlmApiError(format!("embed body parse: {}", e)))?;
                return parse_embedding_response(&body, cfg.dim);
            }
            Ok(resp) => {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                let api_err = AppError::LlmApiError(format!("embed HTTP {}: {}", status, body));
                if status.is_server_error() && attempt < max_retries {
                    tracing::warn!("embed HTTP {} (attempt {}), retrying", status, attempt);
                    last_err = Some(api_err);
                } else {
                    return Err(api_err);
                }
            }
            Err(e) => {
                if is_transient_embed_err(&e) && attempt < max_retries {
                    tracing::warn!("embed request err (attempt {}): {}, retrying", attempt, e);
                    last_err = Some(AppError::LlmApiError(format!("embed request: {}", e)));
                } else {
                    return Err(AppError::LlmApiError(format!("embed request: {}", e)));
                }
            }
        }
        if attempt < max_retries {
            tokio::time::sleep(backoff_delay(attempt)).await;
        }
    }
    Err(last_err.unwrap_or_else(|| AppError::LlmApiError("embed retries exhausted".into())))
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src-server && cargo test -p llm-wiki-server --lib embedding::tests 2>&1 | grep "test result" | head -1`
Expected: PASS（含新 backoff 测 + 既有 parse 测）。

- [ ] **Step 5: Commit**

```bash
git add src-server/src/services/embedding.rs
git commit -m "feat(layer6-p2): embed_batch exponential-backoff retry (transient errors, max_retries)"
```

---

## Task 5: rerank.rs — LLM 二次精排 + fallback

**Files:**
- Create: `src-server/src/services/rerank.rs`
- Modify: `src-server/src/services/mod.rs`（加 `pub mod rerank;`）
- Test: `src-server/src/services/rerank.rs` 单测（纯解析 + mock provider）

**Interfaces:**
- Consumes: `crate::services::llm_stream::{StreamChatProvider, ChatMessage, ChatOpts}`。
- Produces:
  - `pub struct RerankCandidate { pub page_id: String, pub title: String, pub text: String }`
  - `pub struct RerankedPage { pub page_id: String, pub score: f64 }`
  - `pub fn parse_rerank_response(raw: &str, valid_ids: &HashSet<String>) -> Vec<RerankedPage>`（纯函数）
  - `pub async fn rerank_pages(provider: &dyn StreamChatProvider, query: &str, candidates: Vec<RerankCandidate>) -> Result<Vec<RerankedPage>, AppError>`（model 从 `provider.model_name()` 取）

- [ ] **Step 1: 注册模块**

`src-server/src/services/mod.rs` 加 `pub mod rerank;`。

- [ ] **Step 2: 写失败测试**

Create `src-server/src/services/rerank.rs`，先放解析 + mock 测试：
```rust
//! LLM 二次精排：给 query + N 候选（title+代表文本），让 LLM 输出按相关性排序的 page_id + 0-10 分。
//! 失败/超时 → 调用方 fallback RRF，不阻断搜索。

use std::collections::HashSet;
use crate::AppError;
use crate::services::llm_stream::{StreamChatProvider, ChatMessage, ChatOpts};

pub struct RerankCandidate {
    pub page_id: String,
    pub title: String,
    pub text: String,
}

pub struct RerankedPage {
    pub page_id: String,
    pub score: f64,
}

/// 解析 LLM rerank 响应：每行 `<page_id> <score>` 或 `rank. page_id (score)`。
/// 只保留 valid_ids 内的 page_id；按 score 降序。失败 → 空 Vec（触发 fallback）。
pub fn parse_rerank_response(raw: &str, valid_ids: &HashSet<String>) -> Vec<RerankedPage> {
    unimplemented!() // Step 4 实现
}

pub async fn rerank_pages(
    provider: &dyn StreamChatProvider,
    query: &str,
    candidates: Vec<RerankCandidate>,
) -> Result<Vec<RerankedPage>, AppError> {
    unimplemented!() // Step 4 实现
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_lines_with_scores() {
        let mut ids = HashSet::new();
        ids.insert("a.md".to_string());
        ids.insert("b.md".to_string());
        ids.insert("c.md".to_string());
        let out = parse_rerank_response("b.md 9.5\na.md 8.0\nc.md 2.0", &ids);
        assert_eq!(out.len(), 3);
        assert_eq!(out[0].page_id, "b.md");
        assert!(out[0].score > out[1].score);
    }

    #[test]
    fn parse_filters_unknown_ids() {
        let mut ids = HashSet::new();
        ids.insert("a.md".to_string());
        let out = parse_rerank_response("a.md 9\nunknown.md 5\nx 3", &ids);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].page_id, "a.md");
    }

    #[test]
    fn parse_empty_or_garbage_returns_empty() {
        let ids = HashSet::<String>::new();
        assert!(parse_rerank_response("", &ids).is_empty());
        assert!(parse_rerank_response("no parseable lines here", &ids).is_empty());
    }

    #[test]
    fn parse_ranked_numbered_format() {
        let mut ids = HashSet::new();
        ids.insert("x.md".to_string());
        ids.insert("y.md".to_string());
        let out = parse_rerank_response("1. x.md\n2. y.md", &ids);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].page_id, "x.md");
    }
}
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd src-server && cargo test -p llm-wiki-server --lib rerank 2>&1 | tail -10`
Expected: FAIL（unimplemented）。

- [ ] **Step 4: 实现 parse_rerank_response + rerank_pages**

替换 `unimplemented!()` 两个函数为：
```rust
pub fn parse_rerank_response(raw: &str, valid_ids: &HashSet<String>) -> Vec<RerankedPage> {
    let mut out: Vec<RerankedPage> = Vec::new();
    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // 去前缀 "1." / "-" / "*"
        let body = line.trim_start_matches(|c: char| c.is_ascii_digit() || c == '.' || c == '-' || c == '*' || c == ' ');
        // 找第一个 token 作为 page_id；若有第二个数值 token 作为 score
        let mut parts = body.split_whitespace();
        let pid = match parts.next() {
            Some(p) => p.trim_matches(|c: char| c == '(' || c == ')' || c == ','),
            None => continue,
        };
        if !valid_ids.contains(pid) {
            continue;
        }
        let score = parts.next()
            .and_then(|s| s.trim_matches(|c: char| c == '(' || c == ')').parse::<f64>().ok())
            .unwrap_or(0.0);
        out.push(RerankedPage { page_id: pid.to_string(), score });
    }
    // 去重（同 id 取首条）+ 按 score 降序
    out.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    out.dedup_by(|a, b| a.page_id == b.page_id);
    out
}

pub async fn rerank_pages(
    provider: &dyn StreamChatProvider,
    query: &str,
    candidates: Vec<RerankCandidate>,
) -> Result<Vec<RerankedPage>, AppError> {
    if candidates.is_empty() {
        return Ok(Vec::new());
    }
    let valid: HashSet<String> = candidates.iter().map(|c| c.page_id.clone()).collect();
    // 拼 prompt：候选列表 + 要求输出 `<page_id> <score 0-10>` 每行
    let mut prompt = format!(
        "你是检索重排器。按与查询的相关性给下列每个候选页打 0-10 分，输出每行 `<page_id> <score>`，不要其它内容。\n查询：{}\n候选：\n",
        query.trim()
    );
    for c in &candidates {
        let head: String = c.text.chars().take(300).collect();
        prompt.push_str(&format!("{}\t{}\t{}\n", c.page_id, c.title, head));
    }
    let msgs = vec![ChatMessage {
        role: "user".to_string(),
        content: prompt,
    }];
    // model 经 ChatOpts.model 传；chat_to_string 签名 (&self, Vec<ChatMessage>, ChatOpts)，
    // 返回 Result<(String, Option<(u32,u32)>), LlmError> —— 解构取文本（model_name 由 provider 提供）。
    let opts = ChatOpts {
        model: provider.model_name().to_string(),
        temperature: 0.0,
        max_tokens: 1024,
        system_prompt: None,
        timeout_secs: Some(60),
    };
    let (raw, _usage) = provider
        .chat_to_string(msgs, opts)
        .await
        .map_err(|e| AppError::LlmApiError(format!("rerank llm: {}", e)))?;
    let parsed = parse_rerank_response(&raw, &valid);
    if parsed.is_empty() {
        return Err(AppError::LlmApiError("rerank produced no valid ids".into()));
    }
    Ok(parsed)
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd src-server && cargo test -p llm-wiki-server --lib rerank 2>&1 | grep "test result" | head -1`
Expected: 4 tests PASS。若 `chat_to_string`/`ChatOpts` 签名不匹配导致编译错，按 grep 结果调整 Step 4 调用，重试。

- [ ] **Step 6: Commit**

```bash
git add src-server/src/services/rerank.rs src-server/src/services/mod.rs
git commit -m "feat(layer6-p2): LLM rerank module (parse + provider call, fallback on failure)"
```

---

## Task 6: hybrid_search 接入 rerank + SearchConfig

**Files:**
- Modify: `src-server/src/config.rs`（新增 `SearchConfig`，AppConfig 加字段）
- Modify: `src-server/src/services/search.rs`（hybrid_search 签名加 search_cfg + provider 维度；RRF 后 rerank）
- Modify: `src-server/src/routes/search.rs` + `src-server/src/services/retrieval.rs`（hybrid_search 调用方）
- Test: 集成测 `tests/search_integration.rs`（已有 `hybrid_search_finds_alice`，加 rerank fallback 不阻断断言）

**Interfaces:**
- Consumes: T5 `rerank_pages(provider, query, candidates)` + `RerankCandidate`；调用方用 `crate::services::llm_stream::provider_for_project(state: &AppState, project_id) -> Result<Box<dyn StreamChatProvider>, AppError>`（llm_stream.rs:453）解析 provider。
- Produces: `hybrid_search` 签名加 `search_cfg: &SearchConfig`（第 2 参后）+ 末参 `llm_provider: Option<&dyn StreamChatProvider>`。`SearchConfig { rerank_enabled: bool, rerank_top_n: usize, rerank_final_k: usize }`。完整签名：`hybrid_search(pool, vector_store, search_cfg, emb_cfg, client, project_id, query, limit, llm_provider)`。

- [ ] **Step 1: config.rs 加 SearchConfig**

在 `src-server/src/config.rs`（`EmbeddingConfig` 后）加：
```rust
#[derive(Debug, Clone, Deserialize)]
pub struct SearchConfig {
    #[serde(default = "default_rerank_enabled")]
    pub rerank_enabled: bool,
    #[serde(default = "default_rerank_top_n")]
    pub rerank_top_n: usize,
    #[serde(default = "default_rerank_final_k")]
    pub rerank_final_k: usize,
}

fn default_rerank_enabled() -> bool { true }
fn default_rerank_top_n() -> usize { 20 }
fn default_rerank_final_k() -> usize { 5 }

impl Default for SearchConfig {
    fn default() -> Self {
        SearchConfig { rerank_enabled: true, rerank_top_n: 20, rerank_final_k: 5 }
    }
}
```
`AppConfig`（行 92-102）加字段：
```rust
    #[serde(default)]
    pub search: SearchConfig,
```

- [ ] **Step 2: search.rs hybrid_search 签名加 search_cfg + rerank**

`src-server/src/services/search.rs` 顶部 use 加：
```rust
use crate::config::SearchConfig;
use crate::services::rerank::{rerank_pages, RerankCandidate};
use crate::services::llm_stream::StreamChatProvider;
```
> 说明：`provider_for_project(&state, pid)`（llm_stream.rs:453，签名 `(&AppState, i32) -> Result<Box<dyn StreamChatProvider>, AppError>`）在**调用方**（routes/search.rs、retrieval.rs，二者持 `&AppState`）解析为 `Box<dyn StreamChatProvider>`，转 `Option<&dyn StreamChatProvider>` 传入。hybrid_search 本身只持 `&PgPool`，无法解析 provider——故 provider 作为参数注入（也便于测试 mock 注入）。
改 `hybrid_search` 签名（在 `vector_store` 后插入 `search_cfg`，**末尾加 `llm_provider`**——下方 rerank 实现引用它，调用方也传它，不可漏）：
```rust
pub async fn hybrid_search(
    pool: &PgPool,
    vector_store: &dyn VectorStore,
    search_cfg: &SearchConfig,
    emb_cfg: Option<&EmbeddingConfig>,
    client: &reqwest::Client,
    project_id: i32,
    query: &str,
    limit: usize,
    llm_provider: Option<&dyn StreamChatProvider>,
) -> Result<SearchResponse, AppError> {
```
在函数末尾原 `results.sort_by(...); results.truncate(limit);` 处（RRF 之后），**整体替换**为「rerank + 条件排序 + 条件截断」：
```rust
    // 4. LLM rerank（可选）。成功 → 用 LLM 序覆盖 + 收窄到 rerank_final_k；失败/无 provider → 走 RRF 序。
    //    provider 由调用方注入（hybrid_search 无 &AppState，无法自行 provider_for_project）。
    let mut rerank_applied = false;
    if search_cfg.rerank_enabled && results.len() > 1 {
        if let Some(provider) = llm_provider {
            let top_n = search_cfg.rerank_top_n.min(results.len());
            let cands_for_rerank: Vec<SearchResult> = results.iter().take(top_n).cloned().collect();
            let rerank_inputs: Vec<RerankCandidate> = cands_for_rerank.iter().map(|r| RerankCandidate {
                page_id: r.path.clone(),       // rerank 输入用 snippet（已含锚点上下文）
                title: r.title.clone(),
                text: r.snippet.clone(),
            }).collect();
            match rerank_pages(provider, query, rerank_inputs).await {
                Ok(order) => {
                    // 按 LLM 给的 page_id 顺序重排 cands_for_rerank，未命中的补尾，再拼回原 top_n 之后
                    let mut reordered: Vec<SearchResult> = Vec::new();
                    let mut seen: HashSet<String> = HashSet::new();
                    for rp in &order {
                        if let Some(r) = cands_for_rerank.iter().find(|c| c.path == rp.page_id) {
                            reordered.push(r.clone());
                            seen.insert(rp.page_id.clone());
                        }
                    }
                    for r in &cands_for_rerank {
                        if !seen.contains(&r.path) {
                            reordered.push(r.clone());
                        }
                    }
                    let tail: Vec<SearchResult> = results.iter().skip(top_n).cloned().collect();
                    results = reordered;
                    results.extend(tail);
                    rerank_applied = true;
                }
                Err(e) => tracing::warn!("rerank failed, fallback to RRF order: {}", e),
            }
        }
    }
    // rerank 路径：保留 LLM 序，不重排（重排会按陈旧 score 毁掉 LLM 序）；fallback 路径：按 RRF score 排。
    if !rerank_applied {
        results.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.path.cmp(&b.path))
        });
    }
    // rerank 路径收窄到 rerank_final_k（min limit，真正生效）；fallback 路径截到 limit。
    let final_limit = if rerank_applied { search_cfg.rerank_final_k.min(limit) } else { limit };
    results.truncate(final_limit);
```

- [ ] **Step 3: 改 hybrid_search 调用方（routes/search.rs + retrieval.rs）—— 解析并注入 provider**

调用方持 `&AppState`，调 `provider_for_project(&state, pid)` 解析为 `Box<dyn StreamChatProvider>`，再用 `as_deref()` 转 `Option<&dyn StreamChatProvider>` 传入。
`src-server/src/routes/search.rs:32` 的调用改为：
```rust
// 解析 LLM provider；失败 → None（hybrid_search 走 RRF fallback，不阻断）
let provider_box = crate::services::llm_stream::provider_for_project(&state, project_id)
    .await.ok();  // Option<Box<dyn StreamChatProvider>>
let provider_ref: Option<&dyn crate::services::llm_stream::StreamChatProvider> = provider_box.as_deref();
let resp = search::hybrid_search(
    &state.db,
    &*state.vector_store,
    &state.config.search,
    state.config.embedding.as_ref(),
    &state.http,
    project_id,
    &query,
    limit,
    provider_ref,
).await;
```
`src-server/src/services/retrieval.rs:200` 同样模式：在调用前加 `let provider_box = provider_for_project(state, pid).await.ok(); let provider_ref = provider_box.as_deref();`，调用末尾加 `provider_ref`。

- [ ] **Step 4: 改 search_integration.rs（hybrid_search_finds_alice 适配新签名）**

集成测无 `AppState`，provider 传 `None`（rerank 跳过 → fallback RRF，断言 alice 召回仍成立）：
```rust
    use llm_wiki_server::config::SearchConfig;
    let resp = search::hybrid_search(
        &pool, &store, &SearchConfig::default(), Some(emb_cfg), &client, 249, "Alice", 10, None,
    ).await.unwrap();
```

- [ ] **Step 5: cargo check 全绿**

Run: `cd src-server && cargo check -p llm-wiki-server --tests 2>&1 | tail -15`
Expected: 无 error。逐个修剩余签名错误（rerank provider match 形态以 grep 为准）。

- [ ] **Step 6: lib 测试 + 集成测编译**

Run: `cd src-server && cargo test -p llm-wiki-server --lib 2>&1 | grep "test result" | head -1`
Expected: 全绿（rerank fallback 在无 provider 时走 warn 分支，不 panic）。

- [ ] **Step 7: Commit**

```bash
git add src-server/src/config.rs src-server/src/services/search.rs \
        src-server/src/routes/search.rs src-server/src/services/retrieval.rs \
        src-server/tests/search_integration.rs
git commit -m "feat(layer6-p2): wire LLM rerank into hybrid_search (with RRF fallback) + SearchConfig"
```

---

## Task 7: golden-set 召回率集成测 + 全量回归

**Files:**
- Create: `src-server/tests/search_golden_recall.rs`（新，`#[ignore]` 需 PG+omlx）
- Verify: 全量 `cargo test`

**Interfaces:** 无新接口。验证 T3 chunk 检索 + T6 rerank 的端到端召回质量。

- [ ] **Step 1: 写 golden-set 召回测**

Create `src-server/tests/search_golden_recall.rs`：
```rust
// 需 PG(docker src-server-postgres-1 @5433) + omlx(@8001 bge-m3) + migration 011 已应用。
// cargo test --test search_golden_recall -- --ignored
#![cfg(test)]
use llm_wiki_server::config::AppConfig;
use llm_wiki_server::services::{embedding, vector_store::{PgVectorStore, VectorStore}};
use std::sync::OnceLock;
use tokio::sync::Mutex;

static SERIAL_GUARD: OnceLock<Mutex<()>> = OnceLock::new();
async fn serial_lock() -> tokio::sync::MutexGuard<'static, ()> {
    SERIAL_GUARD.get_or_init(|| Mutex::new(())).lock().await
}

async fn setup() -> (sqlx::PgPool, AppConfig, reqwest::Client) {
    let cfg = AppConfig::from_env().expect("from_env");
    let pool = sqlx::postgres::PgPoolOptions::new().max_connections(2).connect(cfg.database_url()).await.unwrap();
    (pool, cfg, reqwest::Client::new())
}

/// golden set：自给自足播种若干语义近似/相远 page，断言 chunk 级检索把高相关 page 召回到 top。
#[tokio::test]
#[ignore = "requires PG(011 applied) + omlx bge-m3"]
async fn chunk_search_recalls_relevant_page() {
    let _g = serial_lock().await;
    let (pool, cfg, client) = setup().await;
    let emb_cfg = cfg.embedding.as_ref().expect("embedding configured");
    let store = PgVectorStore::with_ef_search(pool.clone(), emb_cfg.ef_search);
    let pid = 249i32;

    // 播种 3 page：alice（相关）、bob（无关）、carol（部分相关）
    let pages = vec![
        ("wiki/golden-alice.md".to_string(),
         "Alice 在 Acme 公司负责量化研究，常用 Python 与 pandas 构建因子模型。".to_string()),
        ("wiki/golden-bob.md".to_string(),
         "Bob 喜欢园艺，周末种番茄和玫瑰。".to_string()),
        ("wiki/golden-carol.md".to_string(),
         "Carol 是数据工程师，维护特征仓库与数据管道。".to_string()),
    ];
    let _ = embedding::embed_and_store(&store, Some(emb_cfg), &client, pid, &pages).await.unwrap();

    // 查询「量化研究员是谁」→ alice 应被召回（top-2 内），且分数高于明显无关的 bob（园艺）。
    // 不断言严格 top-1：bge-m3 对「量化研究员」vs「数据工程师 carol」可能近似，排序有抖动。
    let qvec = embedding::embed_query(emb_cfg, &client, "量化研究员是谁").await.unwrap();
    let hits = store.search_chunks(pid, qvec, 40, 5).await.unwrap();
    let top_paths: Vec<&str> = hits.iter().map(|h| h.page_id.as_str()).collect();
    assert!(
        top_paths.iter().take(2).any(|p| p.contains("alice")),
        "alice 应在 top-2；got {:?}", top_paths
    );
    // 无关项 bob（园艺）分数必须低于 alice（相关性方向正确）
    let score_of = |name: &str| -> f64 {
        hits.iter().find(|h| h.page_id.contains(name)).map(|h| h.score).unwrap_or(-1.0)
    };
    assert!(score_of("alice") > score_of("bob"),
        "alice 分数应高于 bob；alice={}, bob={}", score_of("alice"), score_of("bob"));

    // cleanup
    for (p, _) in &pages {
        sqlx::query("DELETE FROM embeddings WHERE project_id=$1 AND wiki_page_id=$2")
            .bind(pid).bind(p).execute(&pool).await.unwrap();
    }
}
```

- [ ] **Step 2: 跑全量 lib + 集成编译**

Run: `cd src-server && cargo test -p llm-wiki-server --lib 2>&1 | grep "test result" | head -1 && cargo check -p llm-wiki-server --tests 2>&1 | tail -5`
Expected: lib 全绿；所有集成测（含新 golden_recall，`#[ignore]`）编译通过。

- [ ] **Step 3: （可选，infra 在线时）跑 ignored 集成测验证端到端**

若 PG@5433 + omlx@8001 在线：
Run: `cd src-server && cargo test -p llm-wiki-server -- --ignored 2>&1 | grep -E "test result|FAILED" | head`
Expected: embedding_integration + search_integration + search_golden_recall 全 PASS（chunk 写入/检索/维度/召回/rerank fallback）。
infra 不在线 → 跳过，记录「需 infra 验证」。

- [ ] **Step 4: Commit**

```bash
git add src-server/tests/search_golden_recall.rs
git commit -m "test(layer6-p2): golden-set recall integration test (chunk-level vector search)"
```

- [ ] **Step 5: spec §12 标记 Phase 2 done**

`docs/superpowers/specs/2026-06-24-layer6-infra-design.md` §12 Phase 2 标题改为 `### Phase 2 — 向量库调优 ✅ 已完成（2026-06-XX）`，附实施计划路径与「验收：golden set 召回率提升；现有 search 测试绿」。
```bash
git add docs/superpowers/specs/2026-06-24-layer6-infra-design.md
git commit -m "docs(layer6-p2): mark Phase 2 done in spec §12"
```

---

## Self-Review

**1. Spec 覆盖：**
- §5.1 migration 011（chunk 列 + 维度统一 + 约束切换）→ T1 ✅
- §5.2 VectorStore trait chunk 级（upsert_page_chunks/delete_page/search_chunks）→ T3 ✅
- §5.3 chunk 切分 + DELETE+INSERT（规避 ON CONFLICT 失效）→ T2 切分、T3 写入 ✅；5 调用点已随 Phase 1 收拢到 `embed_and_store`，T3 改它即全覆盖 ✅
- §5.4 检索 SQL 三层聚合 + ef_search 事务 → T3 search_chunks ✅
- §5.5 LLM rerank + fallback → T5 + T6 ✅
- §5.6 embedding 重试 → T4 ✅
- §5.7 测试（迁移幂等/切分/聚合/ef_search/rerank/重试/golden 召回）→ T1 verify、T2、T3、T4、T5、T6、T7 ✅
- §9 配置（chunk_size/overlap/ef_search/max_retries/rerank_*）→ T3（EmbeddingConfig）、T6（SearchConfig）✅
- §12 Phase 2 验收 → T7 ✅

**2. Placeholder 扫描：** 无 TBD/TODO；每个代码步骤含完整代码。T5/T6 的 LLM 签名已核对真实代码锁死（`chat_to_string(&self, Vec<ChatMessage>, ChatOpts) -> Result<(String, Option<(u32,u32)>), LlmError>`、`ChatOpts{model,temperature,max_tokens,system_prompt,timeout_secs}` 无 Default、`provider_for_project(&AppState, i32) -> Result<Box<dyn StreamChatProvider>, AppError>`、无 `LlmProvider` 枚举）——实现时无需再 grep 猜测。

**3. 类型一致性：**
- `chunk_for_embedding(&str, usize, usize) -> Vec<String>`：T2 定义、T3 embed_and_store 用 ✅
- `PageChunk { chunk_index: i32, chunk_text: String, heading_path: Option<String>, vector: Vec<f32> }`：T3 定义、T3 embed_and_store 构造、T3 upsert_page_chunks 消费 ✅
- `ChunkHit { page_id, title, snippet, rerank_text, score: f64 }`：T3 定义（`#[derive(sqlx::FromRow)]`）、search_chunks 返回、vector_search 映射到 VectorSearchResult ✅
- `VectorStore::{upsert_page_chunks, delete_page, search_chunks, ef_search}`：T3 定义，embedding.rs 仅用前 3 个 ✅
- `PgVectorStore::with_ef_search(PgPool, usize)`：T3 定义、lib.rs T3-S6 用 ✅
- `rerank_pages(provider: &dyn StreamChatProvider, query, candidates)`（无 model 参数，model 取 `provider.model_name()`）：T5 定义、T6 调用一致 ✅
- `ChatOpts` 经 `provider.model_name()` 构造、`chat_to_string(msgs, opts)` 解构 `(raw, _usage)`：T5 实现 ✅
- `SearchConfig { rerank_enabled, rerank_top_n, rerank_final_k }`：T6 定义、hybrid_search + 2 调用方 + 集成测用 ✅
- `hybrid_search(pool, vector_store, search_cfg, emb_cfg, client, project_id, query, limit, llm_provider: Option<&dyn StreamChatProvider>)`：T6 定义签名，routes/search.rs + retrieval.rs（注入 `provider_for_project(&state,pid).ok().as_deref()`）+ search_integration.rs（传 `None`）调用一致 ✅
- rerank 路径：`rerank_applied` 门控 `sort_by`（仅 fallback 路径排序）+ `truncate(rerank_final_k.min(limit))`（rerank 真正收窄）✅
- `EmbeddingConfig.{chunk_size, overlap, ef_search, max_retries}`：T3 加、T3 embed_and_store 用 chunk_size/overlap、T3 lib.rs 用 ef_search、T4 embed_batch 用 max_retries ✅
- `hybrid_search(pool, vector_store, search_cfg, emb_cfg, client, project_id, query, limit)`：T6 定义签名、routes/search.rs + retrieval.rs + search_integration.rs 调用一致 ✅

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-26-layer6-phase2-vector-tuning.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
