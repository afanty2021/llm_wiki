# Layer 6 Phase 1 — 基础设施 Trait 抽象（行为零回归）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 src-server 里硬编码的文件存储（`std::fs`）和向量库（pgvector SQL）抽成 `StorageBackend` / `VectorStore` 两个 trait，默认实现就是现有行为（`LocalStorage` / `PgVectorStore`），所有现有测试保持绿色——纯抽象清债，不改任何外部行为。

**Architecture:** 定义两个 `async trait`（`Send + Sync`），用 `Arc<dyn Trait>` 注入 `AppState`。`StorageBackend` 方法接收**逻辑坐标** `(team_id, project_id, rel_path)`——`project_base` + `safe_resolve` + `base.exists()` 短路全部下沉进 `LocalStorage` 内部，handler 只传逻辑坐标、只保留 HTTP 特有的错误映射（stat 的 `exists:false`、raw/read 的 404、read 的「是目录」400）。`PgVectorStore` 收拢 `embedding.rs` 的 3 段 SQL。逻辑坐标对 Local/S3 都成立（S3 key = `teams/{tid}/projects/{pid}/{rel}`），trait 不泄漏 LocalStorage 物理布局。

**Tech Stack:** Rust + axum 0.7 + sqlx + pgvector 0.3 + tokio + async-trait。测试：cargo test + 已有 `setup_test_app()` 集成测试基建（连 docker-compose 的 pgvector:5433 + redis:6380）。

**关联 spec:** `docs/superpowers/specs/2026-06-24-layer6-infra-design.md` §4（文件存储）/ §5.2（VectorStore trait）/ §7（trait 清债）/ §12 Phase 1。

---

## 设计决策（实施前必读，已根据 code-review 修正）

1. **trait 方法接收逻辑坐标 `(team_id, project_id, rel_path)`**（spec §4.1 原设计）。早期草稿曾改为接收已解析的本地绝对 `&Path` 以「减少改动面」——但 code-review 指出那会泄漏 LocalStorage 物理布局（canonicalize 后的本地路径对 S3 无语义），且让 handler 的错误映射回归（stat 的 `exists:false`、raw 的 404 被吞成 IoError 500）。**正确做法**：逻辑坐标进 trait，`project_base`/`safe_resolve`/`ensure_dir`/`base.exists()` 短路全部下沉进 `LocalStorage`，handler 反而更简单（删掉 base 构造与 safe_resolve 调用），错误映射在 handler 原位保留。

2. **`FileEntry`/`FileMeta` 必须携带原响应的全部字段**：原 `list_files` 返回 `{name,path,is_dir,size,modified}`，原 `stat_file` 返回 `{exists,is_dir,size,modified}`。trait 的 `FileEntry{name,path,is_dir,size,modified}`、`FileMeta{is_dir,size,modified}` 对齐之，否则前端文件列表 size 列、按修改时间排序、`getFileModifiedTime` 增量同步全部回归。

3. **handler 的 HTTP 错误映射在 handler 保留**，不下沉进 trait：
   - `stat_file`：trait `metadata()` 返 Err（含文件/项目目录不存在）→ handler 映射成 `StatResp{exists:false,...}`（原行为：任何 metadata 错误都降级 exists:false）。
   - `raw_file`：trait `read_bytes()` 返 Err → handler `map_err(|_| ResourceNotFound)`（原 404）。
   - `read_file`：先 `metadata()` 判存在+是否目录（404 / BadRequest 400），再读内容。

4. **`embed_and_store`/`embed_page`/`delete_embedding`/`vector_search` 四个函数保留为薄包装**（内部改调 `VectorStore`），调用方接口最小改动。**注意：`delete_embedding` 有 4 个外部调用点**（pages.rs:169/247/271、review.rs:502），不是 1 个。

5. **`PgVectorStore` 持 `PgPool`（= `Pool<Postgres>`，内部已 Arc）**，不再外层包 `Arc<PgPool>`——`Pool` 本身 Clone 廉价且 Send+Sync，外层 Arc 是冗余双层 Arc。

6. **不碰队列**：spec §12 Phase 1 原列「队列接口收拢」，推迟到 Phase 3（队列可靠性那一阶段做更自然）。Phase 1 聚焦 storage + vector 两 trait。

7. **ON CONFLICT / chunk 化 / 维度统一都在 Phase 2**：Phase 1 不动 migration、不动 embedding 写入语义（仍 `ON CONFLICT (project_id, wiki_page_id)`，旧约束 `uniq_embeddings_page` 仍在、仍有效）。`embed_and_store` 搬进 `PgVectorStore` 时**原样保留 SQL**。

---

## 文件结构

| 文件 | 责任 | 动作 |
|------|------|------|
| `src/services/storage.rs` | `StorageBackend` trait + `LocalStorage`（持 root，内部 project_base/safe_resolve）+ `S3Storage`（逻辑坐标占位） | 修改（追加；保留 project_base/safe_resolve/ensure_dir/file_ext） |
| `src/services/vector_store.rs` | `VectorStore` trait + `PgVectorStore`（持 PgPool） | 新建 |
| `src/services/mod.rs` | 模块声明 | 修改（加 `pub mod vector_store;`） |
| `src/services/embedding.rs` | `embed_and_store`/`embed_page`/`delete_embedding`/`vector_search` 改为调 VectorStore | 修改（4 个函数体） |
| `src/lib.rs` | `AppState` 加 `storage`/`vector_store` 字段 + `create_app` 构造注入 | 修改 |
| `src/routes/files.rs` | 7 处 fs 调用改为 `state.storage.xxx(team_id, project_id, rel)`；删 handler 内 project_base/safe_resolve/base.exists | 修改 |
| `src/tests/storage_test.rs` | LocalStorage 单元测试（路径穿越 + 字段完整性） | 新建 |
| `src/tests/mod.rs` | 测试模块声明 | 修改 |
| `Cargo.toml` | 加 `tempfile` dev-dependency | 修改 |

---

## Task 1: 定义 StorageBackend trait + LocalStorage 实现（逻辑坐标）

**Files:**
- Modify: `src-server/src/services/storage.rs`（追加 trait + LocalStorage，保留现有 `project_base`/`safe_resolve`/`ensure_dir`/`file_ext` 不动）

- [ ] **Step 1: 确认 async-trait 依赖**

Run: `cd src-server && grep -n "async-trait" Cargo.toml`
Expected: 命中 `async-trait = "0.1"`（已确认存在）。若无则加到 `[dependencies]`。

- [ ] **Step 2: 在 storage.rs 末尾追加 trait + LocalStorage**

在 `src-server/src/services/storage.rs` 文件**末尾**追加（不动现有 1-65 行）：

```rust
use std::path::PathBuf;
use async_trait::async_trait;

/// 文件存储后端抽象。方法接收**逻辑坐标** (team_id, project_id, rel_path)，
/// 对 Local（本地路径）和 S3（object key = teams/{tid}/projects/{pid}/{rel}）都成立。
/// LocalStorage 内部负责 project_base + safe_resolve + ensure_dir + base.exists 短路。
#[async_trait]
pub trait StorageBackend: Send + Sync {
    /// 读文本（文件/项目目录不存在 → Err，由 handler 决定映射 404/exists:false）。
    async fn read_string(&self, team_id: i32, project_id: i32, rel_path: &str) -> Result<String, AppError>;
    /// 读字节。
    async fn read_bytes(&self, team_id: i32, project_id: i32, rel_path: &str) -> Result<Vec<u8>, AppError>;
    /// 写文本（含 ensure_dir 父目录）。
    async fn write_string(&self, team_id: i32, project_id: i32, rel_path: &str, data: &str) -> Result<(), AppError>;
    /// 写字节。
    async fn write_bytes(&self, team_id: i32, project_id: i32, rel_path: &str, data: &[u8]) -> Result<(), AppError>;
    /// 列目录；项目目录不存在 → 返回空 Vec（对齐原 list_files 短路）。
    async fn list_dir(&self, team_id: i32, project_id: i32, dir_rel: &str) -> Result<Vec<FileEntry>, AppError>;
    /// 元信息；文件/目录不存在 → Err（由 handler 映射 exists:false）。
    async fn metadata(&self, team_id: i32, project_id: i32, rel_path: &str) -> Result<FileMeta, AppError>;
    /// 删除（自动判断文件/目录）。
    async fn remove(&self, team_id: i32, project_id: i32, rel_path: &str) -> Result<(), AppError>;
}

/// 对齐原 files.rs FileNode：list_files 响应需要全部 5 字段。
#[derive(Debug, Clone, serde::Serialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: i64,
}

/// 对齐原 files.rs StatResp 的 exists:true 分支字段。
#[derive(Debug, Clone)]
pub struct FileMeta {
    pub is_dir: bool,
    pub size: u64,
    pub modified: i64,
}

/// 把 SystemTime 转 unix 秒（原 list_files/stat_file 重复逻辑，此处统一）。
fn modified_secs(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 本地磁盘实现（默认）。持 storage root，内部做 project_base + safe_resolve + base.exists 短路。
pub struct LocalStorage {
    root: String,
}

impl LocalStorage {
    pub fn new(root: String) -> Self {
        Self { root }
    }

    /// 解析项目 base；对不存在的项目目录返回 None（让调用方短路）。
    fn base(&self, team_id: i32, project_id: i32) -> PathBuf {
        project_base(&self.root, team_id, project_id)
    }
}

#[async_trait]
impl StorageBackend for LocalStorage {
    async fn read_string(&self, team_id: i32, project_id: i32, rel_path: &str) -> Result<String, AppError> {
        let base = self.base(team_id, project_id);
        if !base.exists() {
            return Err(AppError::ResourceNotFound("project storage not found".into()));
        }
        let p = safe_resolve(&base, rel_path)?;
        tokio::fs::read_to_string(&p).await.map_err(AppError::IoError)
    }

    async fn read_bytes(&self, team_id: i32, project_id: i32, rel_path: &str) -> Result<Vec<u8>, AppError> {
        let base = self.base(team_id, project_id);
        if !base.exists() {
            return Err(AppError::ResourceNotFound("project storage not found".into()));
        }
        let p = safe_resolve(&base, rel_path)?;
        tokio::fs::read(&p).await.map_err(AppError::IoError)
    }

    async fn write_string(&self, team_id: i32, project_id: i32, rel_path: &str, data: &str) -> Result<(), AppError> {
        self.write_bytes(team_id, project_id, rel_path, data.as_bytes()).await
    }

    async fn write_bytes(&self, team_id: i32, project_id: i32, rel_path: &str, data: &[u8]) -> Result<(), AppError> {
        let base = self.base(team_id, project_id);
        // 写操作：父目录可能不存在，safe_resolve 用 parent canonicalize（见 storage.rs:31-39）。
        let p = safe_resolve(&base, rel_path)?;
        if let Some(parent) = p.parent() {
            ensure_dir(parent)?;
        }
        tokio::fs::write(&p, data).await.map_err(AppError::IoError)
    }

    async fn list_dir(&self, team_id: i32, project_id: i32, dir_rel: &str) -> Result<Vec<FileEntry>, AppError> {
        let base = self.base(team_id, project_id);
        if !base.exists() {
            return Ok(Vec::new()); // 对齐原 list_files:123 短路
        }
        let dir = if dir_rel.trim_matches('/').is_empty() {
            base.clone()
        } else {
            safe_resolve(&base, dir_rel)?
        };
        let mut out = Vec::new();
        let mut entries = tokio::fs::read_dir(&dir).await.map_err(AppError::IoError)?;
        while let Some(entry) = entries.next_entry().await.map_err(AppError::IoError)? {
            let meta = entry.metadata().map_err(AppError::IoError)?;
            let path = entry.path().strip_prefix(&base).unwrap_or(&entry.path()).to_string_lossy().to_string();
            out.push(FileEntry {
                name: entry.file_name().to_string_lossy().to_string(),
                path,
                is_dir: meta.is_dir(),
                size: meta.len(),
                modified: modified_secs(&meta),
            });
        }
        Ok(out)
    }

    async fn metadata(&self, team_id: i32, project_id: i32, rel_path: &str) -> Result<FileMeta, AppError> {
        let base = self.base(team_id, project_id);
        if !base.exists() {
            return Err(AppError::ResourceNotFound("project storage not found".into()));
        }
        let p = safe_resolve(&base, rel_path)?;
        let meta = tokio::fs::metadata(&p).await.map_err(AppError::IoError)?;
        Ok(FileMeta {
            is_dir: meta.is_dir(),
            size: meta.len(),
            modified: modified_secs(&meta),
        })
    }

    async fn remove(&self, team_id: i32, project_id: i32, rel_path: &str) -> Result<(), AppError> {
        let base = self.base(team_id, project_id);
        if !base.exists() {
            return Err(AppError::ResourceNotFound("project storage not found".into()));
        }
        let p = safe_resolve(&base, rel_path)?;
        let meta = tokio::fs::metadata(&p).await.map_err(AppError::IoError)?;
        if meta.is_dir() {
            tokio::fs::remove_dir_all(&p).await.map_err(AppError::IoError)
        } else {
            tokio::fs::remove_file(&p).await.map_err(AppError::IoError)
        }
    }
}
```

> 确认 `AppError` 有 `ResourceNotFound(String)` 变体（files.rs 现有 `AppError::ResourceNotFound("file".into())` 用法佐证；routes/files.rs:234 等）。

- [ ] **Step 3: 编译确认**

Run: `cd src-server && cargo check -p llm-wiki-server 2>&1 | tail -20`
Expected: 无错误（unused warning 可有，因尚未注入/调用）。若 `AppError` 变体名不符，按 `src/error.rs` 调整。

- [ ] **Step 4: Commit（获用户批准后）**

```bash
cd src-server && git add src/services/storage.rs
git commit -m "feat(layer6-p1): add StorageBackend trait + LocalStorage (logical coords)"
```

> ⚠️ 提交规则：本仓库要求用户批准后才能 git commit。每个 commit 步骤都需先向用户展示 diff 摘要、获明确批准后再执行。

---

## Task 2: S3Storage 占位实现（逻辑坐标，对 S3 成立）

**Files:**
- Modify: `src-server/src/services/storage.rs`（在 Task 1 追加内容之后继续追加）

- [ ] **Step 1: 追加 S3Storage 占位**

在 storage.rs 末尾（LocalStorage impl 之后）追加。逻辑坐标对 S3 成立（object key 可由 team/project/rel 构造），故此占位是「真实可填」的，非死路：

```rust
/// S3 / 对象存储实现 —— 占位。Phase 1 不实现真实 S3 调用（不引入 S3 SDK 依赖）。
/// 逻辑坐标 (team_id, project_id, rel_path) 可直接映射为 object key
/// teams/{team_id}/projects/{project_id}/{rel_path}，故未来实现时 trait 签名无需改动。
pub struct S3Storage {
    #[allow(dead_code)]
    endpoint: Option<String>,
    #[allow(dead_code)]
    bucket: Option<String>,
}

impl S3Storage {
    pub fn new(endpoint: Option<String>, bucket: Option<String>) -> Self {
        Self { endpoint, bucket }
    }
}

#[async_trait]
impl StorageBackend for S3Storage {
    async fn read_string(&self, _t: i32, _p: i32, _r: &str) -> Result<String, AppError> {
        Err(AppError::InternalError("s3 storage not yet implemented".into()))
    }
    async fn read_bytes(&self, _t: i32, _p: i32, _r: &str) -> Result<Vec<u8>, AppError> {
        Err(AppError::InternalError("s3 storage not yet implemented".into()))
    }
    async fn write_string(&self, _t: i32, _p: i32, _r: &str, _d: &str) -> Result<(), AppError> {
        Err(AppError::InternalError("s3 storage not yet implemented".into()))
    }
    async fn write_bytes(&self, _t: i32, _p: i32, _r: &str, _d: &[u8]) -> Result<(), AppError> {
        Err(AppError::InternalError("s3 storage not yet implemented".into()))
    }
    async fn list_dir(&self, _t: i32, _p: i32, _r: &str) -> Result<Vec<FileEntry>, AppError> {
        Err(AppError::InternalError("s3 storage not yet implemented".into()))
    }
    async fn metadata(&self, _t: i32, _p: i32, _r: &str) -> Result<FileMeta, AppError> {
        Err(AppError::InternalError("s3 storage not yet implemented".into()))
    }
    async fn remove(&self, _t: i32, _p: i32, _r: &str) -> Result<(), AppError> {
        Err(AppError::InternalError("s3 storage not yet implemented".into()))
    }
}
```

> 注：生产配置若误切 `storage_type=s3`，首次文件操作会 500（InternalError）。Phase 1 默认 `local`，且 `is_s3_storage()` 仅当显式配置才为 true。

- [ ] **Step 2: 编译确认**

Run: `cd src-server && cargo check -p llm-wiki-server 2>&1 | tail -20`
Expected: 无错误。

- [ ] **Step 3: Commit（获用户批准后）**

```bash
cd src-server && git add src/services/storage.rs
git commit -m "feat(layer6-p1): add S3Storage placeholder (logical coords)"
```

---

## Task 3: 定义 VectorStore trait + PgVectorStore 实现（持 PgPool）

**Files:**
- Create: `src-server/src/services/vector_store.rs`
- Modify: `src-server/src/services/mod.rs`

- [ ] **Step 1: 在 services/mod.rs 加声明**

Run: `cd src-server && grep -n "pub mod" src/services/mod.rs`
按现有格式（如 `pub mod embedding;`）加一行：

```rust
pub mod vector_store;
```

- [ ] **Step 2: 新建 vector_store.rs**

创建 `src-server/src/services/vector_store.rs`（`PgVectorStore` 持 `PgPool`，非 `Arc<PgPool>`——Pool 内部已 Arc）：

```rust
use async_trait::async_trait;
use sqlx::PgPool;
use crate::AppError;
use crate::services::embedding::VectorSearchResult;

/// 向量存储后端抽象。Phase 1：PgVectorStore 原样收拢 embedding.rs 的 3 段 SQL，
/// 语义不变（仍 ON CONFLICT (project_id, wiki_page_id)，旧约束未变）。Phase 2 才改 chunk 级。
#[async_trait]
pub trait VectorStore: Send + Sync {
    async fn upsert_vectors(
        &self,
        project_id: i32,
        pages: &[(String, Vec<f32>)],
    ) -> Result<usize, AppError>;
    async fn delete_page(&self, project_id: i32, path: &str) -> Result<(), AppError>;
    async fn search(
        &self,
        project_id: i32,
        query_embedding: Vec<f32>,
        limit: i32,
    ) -> Result<Vec<VectorSearchResult>, AppError>;
}

/// pgvector 实现。持 PgPool（= Pool<Postgres>，内部已 Arc，Clone 廉价，无需外层 Arc）。
pub struct PgVectorStore {
    pool: PgPool,
}

impl PgVectorStore {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl VectorStore for PgVectorStore {
    async fn upsert_vectors(
        &self,
        project_id: i32,
        pages: &[(String, Vec<f32>)],
    ) -> Result<usize, AppError> {
        if pages.is_empty() {
            return Ok(0);
        }
        let mut qb = sqlx::QueryBuilder::new(
            "INSERT INTO embeddings (project_id, wiki_page_id, content) VALUES ",
        );
        for (i, (path, vec)) in pages.iter().enumerate() {
            if i > 0 {
                qb.push(",");
            }
            qb.push("(")
                .push_bind(project_id)
                .push(", ")
                .push_bind(path.clone())
                .push(", ")
                .push_bind(pgvector::Vector::from(vec.clone()))
                .push(")");
        }
        // ⚠️ Phase 1 保留原 ON CONFLICT（旧约束 uniq_embeddings_page 仍在）。
        // Phase 2 改 DELETE+INSERT（见 spec §5.3 ON CONFLICT 失效警告）。
        qb.push(" ON CONFLICT (project_id, wiki_page_id) DO UPDATE SET content = EXCLUDED.content");
        let rows = qb.build().execute(&self.pool).await?.rows_affected();
        Ok(rows as usize)
    }

    async fn delete_page(&self, project_id: i32, path: &str) -> Result<(), AppError> {
        sqlx::query("DELETE FROM embeddings WHERE project_id=$1 AND wiki_page_id=$2")
            .bind(project_id)
            .bind(path)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    async fn search(
        &self,
        project_id: i32,
        query_embedding: Vec<f32>,
        limit: i32,
    ) -> Result<Vec<VectorSearchResult>, AppError> {
        let embedding = pgvector::Vector::from(query_embedding);
        let results = sqlx::query_as::<_, VectorSearchResult>(
            "SELECT
                wp.path,
                wp.title,
                COALESCE(substring(COALESCE(wp.content, '') FROM 1 FOR 200), '') as snippet,
                1.0 - (e.content <=> $1) as score
            FROM embeddings e
            JOIN wiki_pages wp ON e.wiki_page_id = wp.path AND e.project_id = wp.project_id
            WHERE e.project_id = $2
            ORDER BY e.content <=> $1
            LIMIT $3",
        )
        .bind(embedding)
        .bind(project_id)
        .bind(limit)
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::DatabaseError)?;
        Ok(results)
    }
}
```

> 确认：`upsert_vectors`/`delete_page` 的裸 `?` 依赖 `From<sqlx::Error> for AppError`（`AppError::DatabaseError(#[from] sqlx::Error)` 提供，error.rs:41 已确认）。`search` 显式 `map_err(AppError::DatabaseError)` 保留原 embedding.rs 风格——二者等价。

- [ ] **Step 3: 确认 VectorSearchResult 是 pub**

Run: `cd src-server && grep -n "pub struct VectorSearchResult" src/services/embedding.rs`
Expected: `pub struct VectorSearchResult { path, title, snippet, score }`（已确认 pub）。

- [ ] **Step 4: 编译确认**

Run: `cd src-server && cargo check -p llm-wiki-server 2>&1 | tail -20`
Expected: 无错误。

- [ ] **Step 5: Commit（获用户批准后）**

```bash
cd src-server && git add src/services/vector_store.rs src/services/mod.rs
git commit -m "feat(layer6-p1): add VectorStore trait + PgVectorStore impl"
```

---

## Task 4: embedding.rs 改为薄包装调 VectorStore

**Files:**
- Modify: `src-server/src/services/embedding.rs`（4 个函数体）

- [ ] **Step 1: 顶部加 import**

在 `src-server/src/services/embedding.rs` import 区（行 1-3 附近）加：

```rust
use crate::services::vector_store::VectorStore;
```

- [ ] **Step 2: 改 embed_and_store（行 50-86）**

```rust
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
    let texts: Vec<String> = pages.iter().map(|(_, t)| t.clone()).collect();
    let vectors = embed_batch(cfg, client, &texts).await?;
    let page_vecs: Vec<(String, Vec<f32>)> = pages.iter().zip(vectors.into_iter())
        .map(|((path, _), vec)| (path.clone(), vec))
        .collect();
    store.upsert_vectors(project_id, &page_vecs).await
}
```

- [ ] **Step 3: 改 embed_page（行 89-100）**

```rust
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
```

- [ ] **Step 4: 改 delete_embedding（行 113-124）**

```rust
pub async fn delete_embedding(
    store: &dyn VectorStore,
    project_id: i32,
    path: &str,
) -> Result<(), AppError> {
    store.delete_page(project_id, path).await
}
```

- [ ] **Step 5: 改 vector_search（行 135-163）**

```rust
pub async fn vector_search(
    store: &dyn VectorStore,
    project_id: i32,
    query_embedding: Vec<f32>,
    limit: i32,
) -> Result<Vec<VectorSearchResult>, AppError> {
    store.search(project_id, query_embedding, limit).await
}
```

- [ ] **Step 6: 暂不编译——调用方未改，预期类型错误（Task 6 修）**

此时 `cargo check` 报调用方传 `&state.db` 不匹配新 `&dyn VectorStore` 首参。预期，继续。

---

## Task 5: AppState 注入 storage + vector_store 字段

**Files:**
- Modify: `src-server/src/lib.rs`（AppState 行 26-32 + create_app 行 34-62）

> 真实变量名核查：`create_app(config: AppConfig)`（lib.rs:34），局部变量是 **`config`**（不是 state_config）。`let db`、`let redis`、`let http` 在前，`AppState{..., config: Arc::new(config), ...}` 在后（config 在此 move）。

- [ ] **Step 1: AppState 加两字段**

`src-server/src/lib.rs:26-32` 改为：

```rust
#[derive(Clone)]
pub struct AppState {
    pub db: DbPool,
    pub redis: RedisPool,
    pub config: Arc<AppConfig>,
    pub http: reqwest::Client,
    pub storage: Arc<dyn services::storage::StorageBackend>,
    pub vector_store: Arc<dyn services::vector_store::VectorStore>,
}
```

- [ ] **Step 2: create_app 在 AppState 字面量之前构造 storage/vector_store**

在 `create_app` 内 `let http = ...` 之后、`let state = AppState {...}` 之前插入（用**尚未 move 的 `config`**，因为 `Arc::new(config)` 在字面量里才 move）：

```rust
    // Layer 6 Phase 1：按 storage_type 分发构造存储后端（用尚未 move 的 config）
    let storage: Arc<dyn services::storage::StorageBackend> =
        if config.is_s3_storage() {
            Arc::new(services::storage::S3Storage::new(
                config.storage.s3_endpoint.clone(),
                config.storage.s3_bucket.clone(),
            ))
        } else {
            Arc::new(services::storage::LocalStorage::new(config.storage.path.clone()))
        };

    // 向量后端：PgVectorStore 持 PgPool（db.clone()，DbPool 是 Clone）
    let vector_store: Arc<dyn services::vector_store::VectorStore> =
        Arc::new(services::vector_store::PgVectorStore::new(db.clone()));
```

AppState 字面量补两字段：

```rust
    let state = AppState {
        db,
        redis,
        config: Arc::new(config),
        http,
        storage,
        vector_store,
    };
```

> 顺序正确性：`db.clone()` 在 `db` move 进字面量之前调用（db 在字面量才 move），`config.storage.path.clone()` 在 `config` move（Arc::new(config)）之前。两个 Arc 构造都在字面量前。

- [ ] **Step 3: 确认 config getter 存在**

Run: `cd src-server && grep -n "fn is_s3_storage\|fn storage_path\|pub path\|pub storage_type" src/config.rs`
Expected: `is_s3_storage` getter 或 `storage_type` 字段 + `path` 字段（StorageConfig 已确认含 path/storage_type/s3_*）。若无 `is_s3_storage()`，改用 `config.storage.storage_type == "s3"`。

- [ ] **Step 4: 编译确认（此时调用方未改，会有 embedding 调用的类型错误——Task 6 修）**

Run: `cd src-server && cargo check -p llm-wiki-server 2>&1 | tail -20`
Expected: 仅 embedding 调用方的首参类型错误（预期），无 lib.rs 内部错误。

---

## Task 6: 改 embedding.rs 全部调用方传 VectorStore（含 4 个 delete_embedding 点）

**Files:**
- Modify: `src-server/src/routes/pages.rs`（embed_page:161/239；**delete_embedding:169/247/271**）
- Modify: `src-server/src/services/review.rs`（embed_page:470；**delete_embedding:502**）
- Modify: `src-server/src/services/ingest_pipeline.rs`（embed_and_store:447）
- Modify: `src-server/src/services/research/synthesize.rs`（embed_page:154）
- Modify: `src-server/src/services/search.rs`（hybrid_search:368 签名 + vector_search:429 调用）

> 先 grep 确认全部调用点（实测清单如下，不可遗漏，否则编译失败）：
> - `embed_page`: pages.rs:161、pages.rs:239、review.rs:470、synthesize.rs:154
> - `embed_and_store`: ingest_pipeline.rs:447
> - `delete_embedding`: **pages.rs:169、pages.rs:247、pages.rs:271、review.rs:502**（共 4 处，不是 1 处）
> - `vector_search`: search.rs:429

- [ ] **Step 1: pages.rs — 2 个 embed_page + 3 个 delete_embedding**

`create_page`(161)、`update_page`(239) 的 `embed_page(&state.db, ...)` → `embed_page(&*state.vector_store, ...)`：

```rust
embedding::embed_page(&*state.vector_store, state.config.embedding.as_ref(), &state.http, project_id, &path, &content).await
```

`delete_page`(169/247/271) 的 `delete_embedding(&state.db, project_id, &path)` → `delete_embedding(&*state.vector_store, project_id, &path)`：

```rust
let _ = embedding::delete_embedding(&*state.vector_store, project_id, &req.path).await;  // 行 169
let _ = embedding::delete_embedding(&*state.vector_store, project_id, &pq.path).await;   // 行 247
let _ = embedding::delete_embedding(&*state.vector_store, project_id, &pq.path).await;   // 行 271
```

- [ ] **Step 2: review.rs — embed_page(470) + delete_embedding(502)**

```rust
embedding::embed_page(&*state.vector_store, ..., project_id, path, text).await       // 行 470
let _ = embedding::delete_embedding(&*state.vector_store, project_id, path).await;   // 行 502
```

> review.rs:470/502 所在函数需有 `&AppState`（`state`）。grep 确认该函数签名持有 state；若只有 pool，把 `&dyn VectorStore`（即 `&*state.vector_store`）作为参数传入，连带改其上游调用。review.rs 的 review 流程通常由 route handler 持 state 调起，应可达。

- [ ] **Step 3: ingest_pipeline.rs — embed_and_store(447)**

`run_ingest_job(state: &AppState, ...)`（已确认签名持 state，ingest_pipeline.rs:352），直接用 `&*state.vector_store`：

```rust
embedding::embed_and_store(&*state.vector_store, state.config.embedding.as_ref(), &state.http, project_id, &pages).await
```

- [ ] **Step 4: synthesize.rs — embed_page(154)**

`run_research_job(state, ...)`（已确认持 state，synthesize.rs:94）：

```rust
embedding::embed_page(&*state.vector_store, state.config.embedding.as_ref(), &state.http, ...).await
```

- [ ] **Step 5: search.rs — hybrid_search 签名加 vector_store 参数**

`hybrid_search`（search.rs:368）当前签名 `(pool: &PgPool, emb_cfg, client, project_id, query, limit)`，**不持 state**。hybrid_search 仍需 `pool` 做 keyword 侧 SQL，故**新增一个参数** `vector_store: &dyn VectorStore`，保留 pool：

```rust
pub async fn hybrid_search(
    pool: &PgPool,
    vector_store: &dyn VectorStore,
    emb_cfg: Option<&EmbeddingConfig>,
    client: &reqwest::Client,
    project_id: i32,
    query: &str,
    limit: usize,
) -> Result<SearchResponse, AppError> {
```

行 429 的 `embedding::vector_search(pool, project_id, qvec, ...)` → `embedding::vector_search(vector_store, project_id, qvec, ...)`。

顶部加 import：`use crate::services::vector_store::VectorStore;`

- [ ] **Step 6: 改 hybrid_search 的调用方**

Run: `cd src-server && grep -rn "hybrid_search(" src/`
对每个调用点（应在 routes 搜索相关 handler，持 `state`），加传 `&*state.vector_store`：

```rust
search::hybrid_search(&state.db, &*state.vector_store, state.config.embedding.as_ref(), &state.http, project_id, &query, limit).await
```

- [ ] **Step 7: 全量编译**

Run: `cd src-server && cargo check -p llm-wiki-server 2>&1 | tail -30`
Expected: 无错误。所有 embedding/vector_search 调用方已传 `&*state.vector_store`。逐个修剩余编译错误（review.rs/search.rs 若签名 cascade 触发上游，连带改）。

- [ ] **Step 8: Commit（获用户批准后）**

```bash
cd src-server && git add -A
git commit -m "refactor(layer6-p1): route embedding writes through VectorStore trait"
```

---

## Task 7: routes/files.rs 7 处 fs 调用改为 state.storage（逻辑坐标）

**Files:**
- Modify: `src-server/src/routes/files.rs`（upload 98、list 142、stat 196、raw 234、read 285、write 369、delete 402）

> 策略：handler **删掉** `let base = project_base(...)`、`safe_resolve(...)`、`if !base.exists()` 短路、`ensure_dir`（这些都下沉进 LocalStorage 了），改成直接 `state.storage.xxx(team_id, project_id, rel).await`。HTTP 特有的错误映射（stat exists:false、raw 404、read 404/400）在 handler 保留。

- [ ] **Step 1: upload_file（行 98）**

原 `let base = project_base(...); ...; std::fs::write(&dest, &file_data)` 整段改为：

```rust
let rel = format!("{}/{}", dest_subdir, file_name);
state.storage.write_bytes(team_id, project_id, &rel, &file_data).await?;
```

删掉 subdir `..` 校验前的 ensure_dir/safe_resolve/dest 计算行（safe_resolve 已下沉）。保留 `file_data.is_empty()` 校验与 multipart 解析。响应 path 字段用 `rel`（原 `dest.strip_prefix(&base)` 等价于 rel）。

> 注：原 upload 对 `dest_subdir.contains("..")` 有拒绝（行 87）——保留该校验在调 trait 前。safe_resolve 在 LocalStorage 内部仍会拦穿越。

- [ ] **Step 2: list_files（行 142）**

原 `base`/`base.exists()`/`read_dir` 循环整段改为：

```rust
let dir_rel = params.dir.unwrap_or_default();
let entries = state.storage.list_dir(team_id, project_id, &dir_rel).await?;
Ok(Json(serde_json::json!(entries)))  // FileEntry {name,path,is_dir,size,modified} 与原 FileNode 对齐
```

> FileEntry 字段（name/path/is_dir/size/modified）与原 FileNode 完全一致，JSON 结构零回归。

- [ ] **Step 3: stat_file（行 196）—— 保留 exists:false 软失败**

原 `base.exists()` 短路 + `metadata` match 整段改为（**handler 保留 exists:false 映射**）：

```rust
let resp = match state.storage.metadata(team_id, project_id, &path).await {
    Ok(m) => StatResp { exists: true, is_dir: m.is_dir, size: m.size, modified: m.modified },
    Err(_) => StatResp { exists: false, is_dir: false, size: 0, modified: 0 },
};
Ok(Json(serde_json::json!(resp)))
```

> trait `metadata()` 对「项目目录不存在」或「文件不存在」都返 Err（LocalStorage 内部 base.exists 短路 + tokio::fs::metadata 失败），handler 统一映射 exists:false——与原行为（任何 metadata 错误 → exists:false）完全一致。

- [ ] **Step 4: raw_file（行 234）—— 保留 404 映射**

```rust
let bytes = state.storage.read_bytes(team_id, project_id, &path)
    .await
    .map_err(|_| AppError::ResourceNotFound("file".into()))?;
// mime 从 path 扩展名推断（mime_guess::from_path 对 rel 同样有效，或用 full path）
```

> 原行为：read 失败 → ResourceNotFound(404)。LocalStorage.read_bytes 失败（项目目录/文件不存在）→ Err → handler 映射 404，零回归。删掉原 `if !base.exists() return ResourceNotFound`（已下沉）。

- [ ] **Step 5: read_file（行 285 + extract 分发）—— 明确保留 404/400 区分 + 提取器决策**

read_file 先判存在/是否目录（404/400），再读。明确决策：

```rust
// ① 存在 + 是否目录（保留原 404/400 区分）
let meta = match state.storage.metadata(team_id, project_id, &path).await {
    Ok(m) => m,
    Err(_) => return Err(AppError::ResourceNotFound("file".into())),  // 原不存在 → 404
};
if meta.is_dir {
    return Err(AppError::BadRequest("Path is a directory".into()));   // 原目录 → 400
}
// ② 按扩展名分发
match file_ext_str {
    "txt" | "md" | "" => {
        state.storage.read_string(team_id, project_id, &path).await?
    }
    "docx" | "xlsx" => {
        // docx/xlsx：trait 读字节一次，提取器接 &[u8]（extract_docx 内部本就先 std::fs::read 再解析，
        // 现把 read 上移到 trait，提取器签名改为 fn(&[u8]) -> Result<String>）
        let bytes = state.storage.read_bytes(team_id, project_id, &path).await?;
        extract_docx(&bytes)?  // 改造 extract_docx/extract_spreadsheet 接 &[u8]
    }
    "pdf" => {
        // extract_pdf 用 pdftotext 外部二进制按 Path 调用，无法纯字节。
        // Phase 1（仅 LocalStorage）保留按本地路径：trait 暴露的读已保证文件在 LocalStorage 磁盘上，
        // 但为拿本地绝对路径，这里仍需 project_base+safe_resolve —— 见下方说明。
        extract_pdf_from_local(team_id, project_id, &path)?
    }
    _ => state.storage.read_string(team_id, project_id, &path).await?,
}
```

> **pdf 决策（明确）**：extract_pdf 依赖 pdftotext 二进制按文件路径调用，无法改成纯字节接口。Phase 1 唯一实现是 LocalStorage，文件确在本地磁盘。处理：read_file 的 pdf 分支保留一条「本地路径」路径——由 `storage::project_base(&state.config.storage_path(), team_id, project_id)` + `safe_resolve` 得到本地绝对路径传给 extract_pdf。**这是 Phase 1 唯一不通过 trait 的读取分支**，已知且受控；S3 阶段需换支持 stdin/字节的 pdf 提取方案（届时一并处理，spec §4 标注）。docx/xlsx 走字节接口、通过 trait，行为不变。

- [ ] **Step 6: 改 extract_docx/extract_spreadsheet 接 &[u8]**

原 `extract_docx(path: &Path)`（内部 `std::fs::read(path)` 后解析）改为 `extract_docx(bytes: &[u8])`，删内部 `std::fs::read`。extract_spreadsheet 同理。pdf 保留 `extract_pdf(path: &Path)`（外加 `extract_pdf_from_local` 用 project_base+safe_resolve 取路径）。

- [ ] **Step 7: write_file（行 369）**

```rust
state.storage.write_string(team_id, project_id, &payload.path, &payload.contents).await?;
```

删原 `base`/`safe_resolve`/`ensure_dir` 行（下沉）。

- [ ] **Step 8: delete_file（行 402）**

```rust
state.storage.remove(team_id, project_id, &payload.path).await?;
```

删原 is_dir 分支判断（LocalStorage.remove 内部已判断）。

- [ ] **Step 9: 全量编译**

Run: `cd src-server && cargo check -p llm-wiki-server 2>&1 | tail -30`
Expected: 无错误。若 extract_docx/spreadsheet 签名改触发其他调用点，连带改（grep 确认）。

- [ ] **Step 10: Commit（获用户批准后）**

```bash
cd src-server && git add -A
git commit -m "refactor(layer6-p1): route file ops through StorageBackend (logical coords)"
```

---

## Task 8: LocalStorage 单元测试 + tempfile dev-dependency

**Files:**
- Modify: `src-server/Cargo.toml`（加 tempfile dev-dep）
- Create: `src-server/src/tests/storage_test.rs`
- Modify: `src-server/src/tests/mod.rs`

- [ ] **Step 1: 加 tempfile dev-dependency（先做，否则测试无法编译）**

读 `src-server/Cargo.toml`，找到 `[dev-dependencies]` 区（若无则新建）。加：

```toml
[dev-dependencies]
tempfile = "3"
```

> 实测确认 tempfile 当前**不在**任何依赖区，必须显式加。

- [ ] **Step 2: 写测试**

创建 `src-server/src/tests/storage_test.rs`：

```rust
use crate::services::storage::{LocalStorage, StorageBackend, FileEntry};

fn tmp_store() -> (tempfile::TempDir, LocalStorage) {
    let tmp = tempfile::tempdir().unwrap();
    let store = LocalStorage::new(tmp.path().to_string_lossy().to_string());
    (tmp, store)
}

#[tokio::test]
async fn local_storage_write_read_remove() {
    let (_tmp, store) = tmp_store();
    store.write_string(1, 1, "raw/sources/a.txt", "hello").await.unwrap();
    assert_eq!(store.read_string(1, 1, "raw/sources/a.txt").await.unwrap(), "hello");
    let meta = store.metadata(1, 1, "raw/sources/a.txt").await.unwrap();
    assert!(!meta.is_dir && meta.size == 5 && meta.modified > 0);
    store.remove(1, 1, "raw/sources/a.txt").await.unwrap();
    assert!(store.read_string(1, 1, "raw/sources/a.txt").await.is_err());
}

#[tokio::test]
async fn local_storage_list_dir_fields_complete() {
    let (_tmp, store) = tmp_store();
    store.write_string(1, 1, "d/x.txt", "x").await.unwrap();
    let entries: Vec<FileEntry> = store.list_dir(1, 1, "d").await.unwrap();
    assert_eq!(entries.len(), 1);
    let e = &entries[0];
    // 验证全部 5 字段都填了（防 FileEntry 字段缺失回归）
    assert_eq!(e.name, "x.txt");
    assert!(e.path.ends_with("x.txt"));
    assert!(!e.is_dir);
    assert_eq!(e.size, 1);
    assert!(e.modified > 0);
}

#[tokio::test]
async fn local_storage_missing_project_returns_err_or_empty() {
    let (_tmp, store) = tmp_store();
    // 项目目录不存在：list 返空，read/stat/remove 返 Err（handler 映射 exists:false/404）
    assert!(store.list_dir(1, 999, "").await.unwrap().is_empty());
    assert!(store.read_string(1, 999, "x").await.is_err());
    assert!(store.metadata(1, 999, "x").await.is_err());
}

#[tokio::test]
async fn local_storage_traversal_blocked() {
    let (_tmp, store) = tmp_store();
    store.write_string(1, 1, "real.txt", "x").await.unwrap();
    // 正常路径 OK
    assert!(store.read_string(1, 1, "real.txt").await.is_ok());
    // 穿越 ../../etc/passwd 由 LocalStorage 内部 safe_resolve 拒绝
    assert!(store.read_string(1, 1, "../../etc/passwd").await.is_err());
}
```

- [ ] **Step 3: 加测试模块声明**

在 `src-server/src/tests/mod.rs` 加：

```rust
pub mod storage_test;
```

- [ ] **Step 4: 运行测试**

Run: `cd src-server && cargo test -p llm-wiki-server storage_test 2>&1 | tail -20`
Expected: 4 个测试 PASS。若 `tempfile` 报 unresolved，确认 Step 1 的 `[dev-dependencies]` 写对。

- [ ] **Step 5: Commit（获用户批准后）**

```bash
cd src-server && git add src/tests/storage_test.rs src/tests/mod.rs Cargo.toml Cargo.lock
git commit -m "test(layer6-p1): LocalStorage unit tests (field completeness + traversal)"
```

---

## Task 9: 现有集成测试全量回归（行为零回归验证）

**Files:** 无新增——跑现有测试。

- [ ] **Step 1: 起 docker-compose 依赖**

Run: `cd src-server && docker compose up -d postgres redis && docker compose ps`
Expected: postgres (pgvector:5433) + redis (6380) healthy。若已跑（如 llmwiki-pg-test），跳过。

- [ ] **Step 2: 跑全量集成测试**

Run: `cd src-server && cargo test -p llm-wiki-server 2>&1 | tail -40`
Expected: 全部现有测试 PASS。重点：
- `files_*`（list/stat/raw/read/write/delete 通过 StorageBackend 后响应字段/状态码不变——重点验 list 的 size/modified、stat 的 exists:false、raw 的 404）
- `pages_test`（embed_page 通过 VectorStore 写入正常）
- `embedding_integration`（向量 upsert/search 不变；需 omlx @8001 的 `--ignored` 未起则 skip，非回归）
- `search_integration`（vector_search 通过 trait 后检索结果不变）

- [ ] **Step 3: 失败处理**

FAIL 时**不要为通过测试改 trait 行为**（Phase 1 承诺零回归）：
- 文件字段/状态码回归 → 检查 Task 7 是否保留了 handler 错误映射（stat exists:false / raw 404）、FileEntry 字段是否全。
- 向量回归 → 检查 Task 4/6 store 参数传递。

- [ ] **Step 4: 仅当修了回归 bug 才 Commit（获用户批准后）**

若 Task 9 纯运行无代码变更，不 commit。修了 bug 才：

```bash
cd src-server && git add -A && git commit -m "fix(layer6-p1): regression fixes from integration suite"
```

---

## Task 10: Phase 1 收尾 — spec §12 标记完成

**Files:**
- Modify: `docs/superpowers/specs/2026-06-24-layer6-infra-design.md`

- [ ] **Step 1: spec §12 Phase 1 标记 done**

在 §12 Phase 1 标题后加「✅ 已完成（实施计划：docs/superpowers/plans/2026-06-24-layer6-phase1-abstraction.md）」。

- [ ] **Step 2: Commit（获用户批准后）**

```bash
git add docs/superpowers/specs/2026-06-24-layer6-infra-design.md
git commit -m "docs(layer6-p1): mark Phase 1 done in spec"
```

---

## Self-Review（修正后复查）

**1. Spec 覆盖：** §4 StorageBackend/LocalStorage/S3 → Task 1,2 ✅；§5.2 VectorStore/PgVectorStore → Task 3 ✅；§7 trait 注入 → Task 5 ✅；§12 Phase 1 收拢 → Task 4,6,7 ✅；队列收拢显式推迟 Phase 3（设计决策 #6）✅。

**2. code-review 10 项核对：**
- #1 tempfile 缺失 → Task 8 Step 1 显式加 dev-dep ✅
- #2 state_config 变量名/move 顺序 → Task 5 用真实变量 `config` + 顺序说明 ✅
- #3 FileEntry/FileMeta 字段缺失 → Task 1 补 path/size/modified，Task 7 list/stat 对齐 ✅
- #4 stat exists:false 软失败 → Task 7 Step 3 handler 保留 match 映射 ✅
- #5 raw 404 → Task 7 Step 4 map_err(ResourceNotFound) ✅
- #6 delete_embedding 4 调用点遗漏 → Task 6 列全 4 处（pages 169/247/271、review 502）✅
- #7 hybrid_search 签名 cascade → Task 6 Step 5/6 显式加 vector_store 参数 + 改调用方 ✅
- #8 extract_docx/pdf 推迟 → Task 7 Step 5/6 明确决策（docx/xlsx 接 &[u8]，pdf 保留本地路径受控）✅
- #9 双层 Arc<PgPool> → Task 3 PgVectorStore 持 PgPool ✅
- #10 trait &Path 泄漏/S3 死路 → 设计决策 #1 改回逻辑坐标，Task 1/2/5/7/8 全用逻辑坐标，S3 占位成立 ✅

**3. 类型一致性：** StorageBackend 方法名（read_string/read_bytes/write_string/write_bytes/list_dir/metadata/remove）+ (team_id,project_id,rel_path) 签名在 Task 1 定义、Task 7/8 使用一致 ✅；FileEntry{path,size,modified...}/FileMeta{is_dir,size,modified} 一致 ✅；VectorStore{upsert_vectors,delete_page,search} 一致 ✅；embed_* 新签名首参 `&dyn VectorStore` 在 Task 4 定义、Task 6 调用一致 ✅；PgVectorStore{pool:PgPool}::new(PgPool) 在 Task 3 定义、Task 5 `PgVectorStore::new(db.clone())` 一致 ✅；LocalStorage::new(String) 在 Task 1 定义、Task 5 `LocalStorage::new(config.storage.path.clone())`、Task 8 一致 ✅。

**4. 范围：** Phase 1 聚焦 storage+vector 两 trait，行为零回归，10 task 各自可独立 commit+测试 ✅。
