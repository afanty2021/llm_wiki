# src-server Embedding 管线 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `embeddings` 表与 `wiki_pages` 同步——ingest 批量 + pages CRUD 单页维护，用本地 omlx 的 bge-m3(1024 维)，为 Layer 2b 向量搜索提供向量来源。

**Architecture:** pgvector 存 1024 维向量；`services/embedding.rs` 提供批量嵌入 + 维护层(embed_and_store/embed_page/delete_embedding)，全局 `Option<EmbeddingConfig>` 控制开关；ingest worker 在 reserved 重建后统一批量嵌入；pages CRUD 单页维护；共享 `reqwest::Client` 复用连接池。

**Tech Stack:** Rust + Axum + SQLx + pgvector + reqwest + omlx(`/v1/embeddings`, bge-m3-mlx-fp16)

**Spec:** `docs/superpowers/specs/2026-06-20-src-server-embedding-pipeline-design.md`

---

## 前置条件（已就绪）

- PG(docker `src-server-postgres-1` @ 5433)、Redis(@ 6380)、omlx(@ 8001, bge-m3 已验证) 在跑
- `crates/` 无关；所有改动在 `src-server/`
- migrations 手动经 psql 应用（main.rs 不自动 migrate，sqlx-cli 未装）
- 测试需要 PG+omlx 的标 `#[ignore]`，`cargo test -- --ignored` 本地跑

## 文件结构

| 文件 | 责任 | 动作 |
|------|------|------|
| `src-server/migrations/005_embedding_bge_m3.sql` | 维度 1536→1024 + 幂等约束 + HNSW | Create |
| `src-server/src/config.rs` | `EmbeddingConfig` + `AppConfig.embedding: Option<...>` | Modify |
| `src-server/config/default.json` | embedding 配置段 | Modify |
| `src-server/src/lib.rs` | `AppState.http: reqwest::Client` | Modify |
| `src-server/src/services/embedding.rs` | 嵌入 + 维护层（删 get_embeddings） | Modify(大改) |
| `src-server/src/services/ingest_pipeline.rs` | rebuild 返回 (path,content)；批量嵌入接入 | Modify |
| `src-server/src/routes/pages.rs` | CRUD 维护向量 | Modify |
| `src-server/src/routes/search.rs` | /search/vector 查询侧改用 bge-m3 | Modify |
| `src-server/tests/embedding_integration.rs` | 端到端 #[ignore] 测试 | Create |

---

## Task 1: Migration 005 — schema for bge-m3

**Files:**
- Create: `src-server/migrations/005_embedding_bge_m3.sql`

- [ ] **Step 1: 写 migration 文件**

```sql
-- 005: embedding 维度 1536→1024 (bge-m3) + 幂等 upsert 约束 + HNSW 索引
-- 表当前为空（ingest 从未生成向量），零数据迁移成本。

ALTER TABLE embeddings ALTER COLUMN content TYPE vector(1024);

ALTER TABLE embeddings ADD CONSTRAINT uniq_embeddings_page
    UNIQUE (project_id, wiki_page_id);

DROP INDEX IF EXISTS idx_embeddings_content;
CREATE INDEX idx_embeddings_content ON embeddings USING hnsw (content vector_cosine_ops);
```

- [ ] **Step 2: 应用 migration（psql via docker）**

```bash
cd src-server
docker exec -i src-server-postgres-1 psql -U llmwiki -d llmwiki < migrations/005_embedding_bge_m3.sql
```
Expected: 输出 `ALTER TABLE / ALTER TABLE / DROP INDEX / CREATE INDEX`，无 error。

- [ ] **Step 3: 验证 schema**

```bash
docker exec src-server-postgres-1 psql -U llmwiki -d llmwiki -c "\d embeddings"
```
Expected: `content | vector(1024)`；`"embeddings_project_id_wiki_page_id_key" UNIQUE CONSTRAINT, (project_id, wiki_page_id)`；Indexes 列表含 `idx_embeddings_content ... USING hnsw`。

- [ ] **Step 4: Commit**

```bash
git add src-server/migrations/005_embedding_bge_m3.sql
git commit -m "feat(src-server): migration 005 — embedding 维度 1024 + 幂等约束 + HNSW"
```

---

## Task 2: EmbeddingConfig（全局可选）

**Files:**
- Modify: `src-server/src/config.rs`
- Modify: `src-server/config/default.json`

- [ ] **Step 1: 写失败测试（config 能加载 embedding 且为 Some）**

在 `src/config.rs` 的 `#[cfg(test)] mod tests` 末尾追加：

```rust
    #[test]
    fn test_embedding_config_loaded() {
        // config/default.json 含 embedding 段；cargo test cwd = src-server
        let cfg = AppConfig::from_env().expect("from_env");
        let emb = cfg.embedding.expect("embedding should be configured in default.json");
        assert_eq!(emb.model, "bge-m3-mlx-fp16");
        assert_eq!(emb.dim, 1024);
    }

    #[test]
    fn test_embedding_config_optional_when_absent() {
        // 构造无 embedding 段的最小 JSON，确认 Option → None（serde 默认行为）
        let json = r#"{
            "server": {"host": "0.0.0.0", "port": 8080},
            "database": {"url": "postgres://x", "max_connections": 1},
            "redis_url": "redis://x",
            "jwt": {"secret": "test_secret_for_development_32bytes!"},
            "storage": {"path": "/tmp/x"},
            "cors": {"allowed_origins": ["http://localhost"]}
        }"#;
        let cfg: AppConfig = serde_json::from_str(json).unwrap();
        assert!(cfg.embedding.is_none());
    }
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd src-server && cargo test --lib config::tests:: -- --nocapture 2>&1 | tail -5
```
Expected: 编译失败（`no field embedding on type AppConfig`）。

- [ ] **Step 3: 实现 EmbeddingConfig + Option 字段**

在 `src/config.rs` 的 `CorsConfig` 定义之后、`AppConfig` 之前加：

```rust
#[derive(Debug, Clone, Deserialize)]
pub struct EmbeddingConfig {
    pub base_url: String,
    pub model: String,
    pub dim: usize,
    pub timeout_secs: u64,
}
```

在 `AppConfig` struct 里加一行（紧跟 `cors`）：

```rust
    pub cors: CorsConfig,
    pub embedding: Option<EmbeddingConfig>,
}
```

- [ ] **Step 4: 在 `config/default.json` 加 embedding 段**

在 JSON 顶层对象里（与 `"cors"` 同级，注意逗号）加：

```json
  "embedding": {
    "base_url": "http://localhost:8001/v1",
    "model": "bge-m3-mlx-fp16",
    "dim": 1024,
    "timeout_secs": 60
  }
```

- [ ] **Step 5: 跑测试确认通过**

```bash
cd src-server && cargo test --lib config::tests:: 2>&1 | tail -5
```
Expected: `test result: ok. ... passed`（含两个新测试）。

- [ ] **Step 6: Commit**

```bash
git add src-server/src/config.rs src-server/config/default.json
git commit -m "feat(src-server): EmbeddingConfig (全局 Option) + default.json bge-m3"
```

---

## Task 3: AppState 共享 reqwest::Client

**Files:**
- Modify: `src-server/src/lib.rs`

- [ ] **Step 1: 加 http 字段到 AppState**

`src/lib.rs` 的 `AppState` 改为：

```rust
#[derive(Clone)]
pub struct AppState {
    pub db: DbPool,
    pub redis: RedisPool,
    pub config: Arc<AppConfig>,
    pub http: reqwest::Client,
}
```

- [ ] **Step 2: create_app 里初始化 client**

在 `create_app` 里（`let state = AppState {` 之前）加：

```rust
    // 共享 HTTP client（连接池复用）。无全局 timeout——LLM 长请求/嵌入各设各自超时。
    let http = reqwest::Client::builder()
        .build()
        .expect("failed to build reqwest Client");
```

AppState 字面量加字段：

```rust
    let state = AppState {
        db,
        redis,
        config: Arc::new(config),
        http,
    };
```

- [ ] **Step 3: 编译确认**

```bash
cd src-server && cargo check 2>&1 | tail -5
```
Expected: `Finished`（warning 可忽略，无 error）。

- [ ] **Step 4: Commit**

```bash
git add src-server/src/lib.rs
git commit -m "feat(src-server): AppState 共享 reqwest::Client（连接池复用）"
```

---

## Task 4: parse_embedding_response（纯） + embed_batch（HTTP）

**Files:**
- Modify: `src-server/src/services/embedding.rs`

- [ ] **Step 1: 写 parse_embedding_response 的失败测试**

在 `src/services/embedding.rs` 末尾加测试模块：

```rust
#[cfg(test)]
mod tests {
    use super::parse_embedding_response;
    use serde_json::json;

    #[test]
    fn parse_valid_response() {
        let body = json!({
            "data": [
                { "embedding": [0.1, 0.2, 0.3] },
                { "embedding": [0.4, 0.5, 0.6] },
            ]
        });
        let out = parse_embedding_response(&body, 3).unwrap();
        assert_eq!(out.len(), 2);
        assert_eq!(out[0], vec![0.1, 0.2, 0.3]);
    }

    #[test]
    fn parse_wrong_dim_errors() {
        let body = json!({ "data": [{ "embedding": [0.1, 0.2] }] });
        let err = parse_embedding_response(&body, 3).unwrap_err();
        assert!(err.to_string().contains("dim"));
    }

    #[test]
    fn parse_missing_data_errors() {
        let body = json!({});
        assert!(parse_embedding_response(&body, 3).is_err());
    }
}
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd src-server && cargo test --lib embedding::tests:: 2>&1 | tail -5
```
Expected: 编译失败（`cannot find function parse_embedding_response`）。

- [ ] **Step 3: 实现 parse_embedding_response + embed_batch**

在 `src/services/embedding.rs` 顶部（`use` 之后）加：

```rust
use crate::config::EmbeddingConfig;

/// 解析 omlx /v1/embeddings 响应。纯函数，便于单测。
/// 校验每条维度 == expected_dim，不符报错（防模型/配置错配）。
fn parse_embedding_response(body: &serde_json::Value, expected_dim: usize) -> Result<Vec<Vec<f32>>, AppError> {
    let data = body["data"].as_array()
        .ok_or_else(|| AppError::LlmApiError("embedding response missing 'data' array".into()))?;
    let mut out = Vec::with_capacity(data.len());
    for item in data {
        let emb = item["embedding"].as_array()
            .ok_or_else(|| AppError::LlmApiError("embedding item missing 'embedding'".into()))?;
        if emb.len() != expected_dim {
            return Err(AppError::LlmApiError(format!(
                "embedding dim {} != configured {}", emb.len(), expected_dim
            )));
        }
        out.push(emb.iter().map(|v| v.as_f64().unwrap_or(0.0) as f32).collect());
    }
    Ok(out)
}

/// 批量嵌入：一次 HTTP 调 {base_url}/embeddings（bge-m3 支持多文本）。
pub async fn embed_batch(
    cfg: &EmbeddingConfig,
    client: &reqwest::Client,
    texts: &[String],
) -> Result<Vec<Vec<f32>>, AppError> {
    let resp = client
        .post(format!("{}/embeddings", cfg.base_url.trim_end_matches('/')))
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({ "model": cfg.model, "input": texts }))
        .timeout(std::time::Duration::from_secs(cfg.timeout_secs))
        .send()
        .await
        .map_err(|e| AppError::LlmApiError(format!("embed request: {}", e)))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(AppError::LlmApiError(format!("embed HTTP {}: {}", status, body)));
    }
    let body: serde_json::Value = resp.json().await
        .map_err(|e| AppError::LlmApiError(format!("embed body parse: {}", e)))?;
    parse_embedding_response(&body, cfg.dim)
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd src-server && cargo test --lib embedding::tests:: 2>&1 | tail -5
```
Expected: 3 个 parse 测试通过。

- [ ] **Step 5: Commit**

```bash
git add src-server/src/services/embedding.rs
git commit -m "feat(src-server): embed_batch + parse_embedding_response（bge-m3 批量嵌入）"
```

---

## Task 5: embed_and_store（批量嵌入 + bulk upsert）

**Files:**
- Modify: `src-server/src/services/embedding.rs`
- Create: `src-server/tests/embedding_integration.rs`

- [ ] **Step 1: 写 #[ignore] 集成测试**

`src/tests/embedding_integration.rs`：

```rust
// 需 PG(docker src-server-postgres-1 @5433) + omlx(@8001 bge-m3) 本地运行。
// cargo test --test embedding_integration -- --ignored
#![cfg(test)]
use llm_wiki_server::config::AppConfig;
use llm_wiki_server::services::embedding;

async fn setup() -> (sqlx::PgPool, AppConfig, reqwest::Client) {
    let cfg = AppConfig::from_env().expect("from_env");
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(2)
        .connect(cfg.database_url()).await.unwrap();
    (pool, cfg, reqwest::Client::new())
}

#[tokio::test]
#[ignore = "requires PG + omlx bge-m3"]
async fn embed_and_store_bulk_upsert_idempotent() {
    let (pool, cfg, client) = setup().await;
    let emb_cfg = cfg.embedding.as_ref().expect("embedding configured");
    // 用唯一 project_id 避免污染（用一个不存在的 id；embeddings.project_id 无 FK 约束? 有 FK→用真实 project）
    // 这里复用 project_id=999 假设不存在→FK 会失败;改为先建或用已知 project。
    // 简化:用 249(E2E 已建)。清理:
    let pid = 249i32;
    sqlx::query("DELETE FROM embeddings WHERE project_id=$1").bind(pid).execute(&pool).await.unwrap();

    let pages = vec![
        ("wiki/test-alice.md".to_string(), "Alice works at Acme Corp".to_string()),
        ("wiki/test-bob.md".to_string(), "Bob is a data scientist at Acme".to_string()),
    ];
    let n1 = embedding::embed_and_store(&pool, Some(emb_cfg), &client, pid, &pages).await.unwrap();
    assert_eq!(n1, 2);

    // 幂等：同批再调一次，行数不翻倍（ON CONFLICT）
    let n2 = embedding::embed_and_store(&pool, Some(emb_cfg), &client, pid, &pages).await.unwrap();
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM embeddings WHERE project_id=$1")
        .bind(pid).execute(&pool).await.unwrap();
    assert_eq!(count, 2, "ON CONFLICT should not duplicate; got {}", count);

    // 维度 1024
    let dims: i32 = sqlx::query_scalar("SELECT vector_dims(content)::int FROM embeddings WHERE project_id=$1 LIMIT 1")
        .bind(pid).execute(&pool).await.unwrap();
    assert_eq!(dims, 1024);

    // cleanup
    sqlx::query("DELETE FROM embeddings WHERE project_id=$1").bind(pid).execute(&pool).await.unwrap();
}

#[tokio::test]
#[ignore = "requires PG"]
async fn embed_and_store_noop_when_cfg_none() {
    let (pool, _cfg, client) = setup().await;
    let n = embedding::embed_and_store(&pool, None, &client, 249, &[("x.md".into(), "x".into())]).await.unwrap();
    assert_eq!(n, 0);
}
```

> 测试用 project_id=249（E2E 已存在），结束后清理。

- [ ] **Step 2: 跑确认失败（函数未实现）**

```bash
cd src-server && cargo test --test embedding_integration -- --ignored 2>&1 | tail -5
```
Expected: 编译失败（`no function embed_and_store`）。

- [ ] **Step 3: 实现 embed_and_store**

在 `src/services/embedding.rs` 加（embed_batch 之后）：

```rust
/// 批量嵌入 + bulk upsert（ingest 用）。pages: (wiki_page_path, text)。
/// cfg=None → no-op 返回 Ok(0)。
pub async fn embed_and_store(
    pool: &sqlx::PgPool,
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

    let mut qb = sqlx::QueryBuilder::new(
        "INSERT INTO embeddings (project_id, wiki_page_id, content) VALUES ",
    );
    for (i, ((path, _), vec)) in pages.iter().zip(vectors.iter()).enumerate() {
        if i > 0 {
            qb.push(",");
        }
        qb.push("(")
            .push_bind(project_id)
            .push_bind(path.clone())
            .push_bind(pgvector::Vector::from(vec.clone()))
            .push(")");
    }
    qb.push(" ON CONFLICT (project_id, wiki_page_id) DO UPDATE SET content = EXCLUDED.content");

    let rows = qb.build().execute(pool).await?.rows_affected();
    Ok(rows as usize)
}
```

- [ ] **Step 4: 跑 --ignored 确认通过**

```bash
cd src-server && cargo test --test embedding_integration -- --ignored 2>&1 | tail -8
```
Expected: 2 个测试 passed（前提 PG+omlx 在跑）。

- [ ] **Step 5: Commit**

```bash
git add src-server/src/services/embedding.rs src-server/tests/embedding_integration.rs
git commit -m "feat(src-server): embed_and_store 批量嵌入 + bulk upsert(幂等)"
```

---

## Task 6: embed_page + embed_query + delete_embedding

**Files:**
- Modify: `src-server/src/services/embedding.rs`
- Modify: `src-server/tests/embedding_integration.rs`

- [ ] **Step 1: 加 delete/embed_page/embed_query 的 #[ignore] 测试**

在 `embedding_integration.rs` 追加：

```rust
#[tokio::test]
#[ignore = "requires PG + omlx"]
async fn embed_page_then_delete() {
    let (pool, cfg, client) = setup().await;
    let emb_cfg = cfg.embedding.as_ref().unwrap();
    let pid = 249i32;
    let path = "wiki/test-single.md";
    sqlx::query("DELETE FROM embeddings WHERE project_id=$1 AND wiki_page_id=$2")
        .bind(pid).bind(path).execute(&pool).await.unwrap();

    embedding::embed_page(&pool, Some(emb_cfg), &client, pid, path, "single page text").await.unwrap();
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM embeddings WHERE project_id=$1 AND wiki_page_id=$2")
        .bind(pid).bind(path).execute(&pool).await.unwrap();
    assert_eq!(count, 1);

    embedding::delete_embedding(&pool, pid, path).await.unwrap();
    let count2: i64 = sqlx::query_scalar("SELECT count(*) FROM embeddings WHERE project_id=$1 AND wiki_page_id=$2")
        .bind(pid).bind(path).execute(&pool).await.unwrap();
    assert_eq!(count2, 0);
}
```

- [ ] **Step 2: 跑确认失败**

```bash
cd src-server && cargo test --test embedding_integration -- --ignored 2>&1 | tail -3
```
Expected: 编译失败（`no embed_page/delete_embedding`）。

- [ ] **Step 3: 实现三个函数**

在 `src/services/embedding.rs` 加（embed_and_store 之后）：

```rust
/// 单页嵌入（pages CRUD create/update 用，content 非空时）。
pub async fn embed_page(
    pool: &sqlx::PgPool,
    cfg: Option<&EmbeddingConfig>,
    client: &reqwest::Client,
    project_id: i32,
    path: &str,
    text: &str,
) -> Result<(), AppError> {
    embed_and_store(pool, cfg, client, project_id, &[(path.to_string(), text.to_string())])
        .await
        .map(|_| ())
}

/// 单条文本嵌入（/search/vector 查询侧用）。返回 dim 维向量。
pub async fn embed_query(
    cfg: &EmbeddingConfig,
    client: &reqwest::Client,
    text: &str,
) -> Result<Vec<f32>, AppError> {
    let mut vecs = embed_batch(cfg, client, &[text.to_string()]).await?;
    vecs.pop().ok_or_else(|| AppError::LlmApiError("embed_query: empty response".into()))
}

/// 删页向量。不接收 cfg——纯幂等 SQL DELETE，与 embedding 配置无关、始终生效。
pub async fn delete_embedding(
    pool: &sqlx::PgPool,
    project_id: i32,
    path: &str,
) -> Result<(), AppError> {
    sqlx::query("DELETE FROM embeddings WHERE project_id=$1 AND wiki_page_id=$2")
        .bind(project_id)
        .bind(path)
        .execute(pool)
        .await?;
    Ok(())
}
```

- [ ] **Step 4: 跑 --ignored 确认通过**

```bash
cd src-server && cargo test --test embedding_integration -- --ignored 2>&1 | tail -5
```
Expected: 全部 #[ignore] 测试 passed。

- [ ] **Step 5: Commit**

```bash
git add src-server/src/services/embedding.rs src-server/tests/embedding_integration.rs
git commit -m "feat(src-server): embed_page/embed_query/delete_embedding 维护层"
```

---

## Task 7: /search/vector 查询侧迁到 bge-m3；删除 get_embeddings

**Files:**
- Modify: `src-server/src/routes/search.rs`
- Modify: `src-server/src/services/embedding.rs`

> 必要性：删 get_embeddings 会让 vector_search_handler 编译失败；且向量搜索要求 query 与 doc 同模型（doc 用 bge-m3 1024 维，query 也必须）。完整 hybrid 搜索融合仍是 2b。

- [ ] **Step 1: 改 vector_search_handler 用 embed_query + 全局配置**

`src/routes/search.rs` 的 `vector_search_handler`，把这两行：

```rust
    let llm_cfg = crate::services::llm::get_llm_config(&state.db, params.project_id).await?;
    let embedding = crate::services::embedding::get_embeddings(&params.query, &llm_cfg).await?;
```

替换为：

```rust
    let emb_cfg = state.config.embedding.as_ref().ok_or_else(|| {
        AppError::BadRequest("embedding not configured (vector search disabled)".into())
    })?;
    let embedding = crate::services::embedding::embed_query(emb_cfg, &state.http, &params.query).await?;
```

- [ ] **Step 2: 删除旧 get_embeddings**

`src/services/embedding.rs`：删除整个 `pub async fn get_embeddings(...) -> Result<Vec<f32>, AppError> { ... }` 函数（约 30 行，含 `use crate::services::llm::LlmConfig;` 若仅它用则一并删）。

- [ ] **Step 3: 编译确认（无残留引用）**

```bash
cd src-server && cargo check 2>&1 | tail -8
```
Expected: `Finished`，无 error（确认无别处再调 get_embeddings / LlmConfig import）。

- [ ] **Step 4: 手动验证 /search/vector（omlx + 已有 project 249 的向量）**

```bash
# 前提：Task 8/9 后 project 249 已有向量；此处先确认端点不报 ada-002 相关错
TOKEN=$(curl -s -X POST http://localhost:8080/api/v1/auth/login -H "Content-Type: application/json" -d '{"username":"<e2e_user>","password":"Pass1234!"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['access_token'])")
curl -s "http://localhost:8080/api/v1/search/vector?project_id=249&query=Alice&limit=5" -H "Authorization: Bearer $TOKEN" | head -c 300
```
Expected: 200 + `{"results":[...]}`（向量搜索工作）。若 embedding 未配 → 400 `"embedding not configured"`。

- [ ] **Step 5: Commit**

```bash
git add src-server/src/routes/search.rs src-server/src/services/embedding.rs
git commit -m "feat(src-server): /search/vector 查询侧迁 bge-m3；删除 get_embeddings"
```

---

## Task 8: ingest_pipeline 接入批量嵌入

**Files:**
- Modify: `src-server/src/services/ingest_pipeline.rs`

- [ ] **Step 1: rebuild_reserved_pages 改返回 Vec<(String, String)>**

`src/services/ingest_pipeline.rs`：
(a) 函数签名 `Result<Vec<String>, AppError>` → `Result<Vec<(String, String)>, AppError>`。
(b) 把现有"Upsert 三条 reserved"循环 + 返回值（消费 index/log/overview 的写法）替换为：先组装 `reserved: Vec<(String,String)>`、按引用 upsert、再返回它。把这段：

```rust
    // Upsert 三条 reserved
    for (path, content) in [
        ("wiki/index.md", index),
        ("wiki/log.md", log),
        ("wiki/overview.md", overview),
    ] {
        sqlx::query(
            "INSERT INTO wiki_pages (project_id, path, title, content, page_type) \
             VALUES ($1, $2, $3, $4, 'system') \
             ON CONFLICT (project_id, path) DO UPDATE SET title=$3, content=$4, updated_at=NOW()",
        )
        .bind(project_id)
        .bind(path)
        .bind(path)
        .bind(content)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;
    Ok(vec![
        "wiki/index.md".into(),
        "wiki/log.md".into(),
        "wiki/overview.md".into(),
    ])
```

替换为：

```rust
    // 组装 reserved（path, content）——内容本就在函数体内构造，零额外查询
    let reserved: Vec<(String, String)> = vec![
        ("wiki/index.md".to_string(), index),
        ("wiki/log.md".to_string(), log),
        ("wiki/overview.md".to_string(), overview),
    ];
    // Upsert 三条 reserved（按引用，保留 reserved 供返回）
    for (path, content) in &reserved {
        sqlx::query(
            "INSERT INTO wiki_pages (project_id, path, title, content, page_type) \
             VALUES ($1, $2, $3, $4, 'system') \
             ON CONFLICT (project_id, path) DO UPDATE SET title=$3, content=$4, updated_at=NOW()",
        )
        .bind(project_id)
        .bind(path)
        .bind(path)
        .bind(content)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;
    Ok(reserved)
```

- [ ] **Step 2: run_ingest_job 收集 source 页 (path, content) + reserved，rebuild 后批量嵌入**

在 `run_ingest_job` 里：

(a) upsert 循环中收集 source 页内容。把当前的：

```rust
                for page in &processed.pages {
                    match upsert_wiki_page(state, job.project_id, page).await {
                        Ok(path) => result.new_pages.push(path),
                        Err(e) => { ... }
                    }
                }
```

改为同时收集 content：

```rust
                for page in &processed.pages {
                    match upsert_wiki_page(state, job.project_id, page).await {
                        Ok(path) => {
                            result.new_pages.push(path.clone());
                            if let Some(text) = page_content_for_embed(page) {
                                collected.push((path, text));
                            }
                        }
                        Err(e) => { result.warnings.push(format!("upsert {}: {}", sp, e)); all_upserted = false; }
                    }
                }
```

在 `run_ingest_job` 函数体顶部声明 `let mut collected: Vec<(String, String)> = Vec::new();`。

加纯辅助（文件内；`WikiPageInsert.content` 是 `String`）：

```rust
/// 取页面用于嵌入的文本（content 非空时）；None 表示不适合嵌入。
fn page_content_for_embed(page: &WikiPageInsert) -> Option<String> {
    let t = page.content.trim();
    if t.is_empty() { None } else { Some(t.to_string()) }
}
```

(b) rebuild_reserved 之后，并入 reserved 并批量嵌入：

```rust
    // reserved 重建
    let _ = ingest_queue::update_job_stage(state, job.id, "building_index", 100).await;
    match rebuild_reserved_pages(state, job.project_id).await {
        Ok(reserved) => {
            result.updated_reserved = reserved.iter().map(|(p, _)| p.clone()).collect();
            collected.extend(reserved);  // reserved 页也纳入嵌入
        }
        Err(e) => result.warnings.push(format!("reserved pages: {}", e)),
    }

    // 批量嵌入（rebuild 之后，覆盖 source + reserved）
    if !collected.is_empty() {
        if let Err(e) = crate::services::embedding::embed_and_store(
            &state.db,
            state.config.embedding.as_ref(),
            &state.http,
            job.project_id,
            &collected,
        ).await {
            result.warnings.push(format!("embed batch: {}", e));
        }
    }
```

- [ ] **Step 3: 编译确认**

```bash
cd src-server && cargo check 2>&1 | tail -8
```
Expected: `Finished`，无 error（注意 `updated_reserved` 仍是 `Vec<String>`，从元组取 path）。

- [ ] **Step 4: 重启 server + 手动验证 ingest 产向量（用既有 E2E project 249）**

```bash
pkill -f 'target/debug/llm-wiki-server'; sleep 2
cd src-server && nohup cargo run > /tmp/llmwiki_server.log 2>&1 &
# 等 listening
TOKEN=$(curl -s -X POST http://localhost:8080/api/v1/auth/login -H "Content-Type: application/json" -d '{"username":"<e2e_user>","password":"Pass1234!"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['access_token'])")
curl -s -X POST http://localhost:8080/api/v1/projects/249/ingest -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"source_paths":["sources/test.md"]}'
# 等 job succeeded 后查向量
docker exec src-server-postgres-1 psql -U llmwiki -d llmwiki -c "SELECT wiki_page_id, vector_dims(content) FROM embeddings WHERE project_id=249 ORDER BY wiki_page_id;"
```
Expected: 每个 wiki 页（含 wiki/index.md、log.md、overview.md）一行、`vector_dims=1024`。

- [ ] **Step 5: Commit**

```bash
git add src-server/src/services/ingest_pipeline.rs
git commit -m "feat(src-server): ingest 接入批量嵌入(rebuild_reserved 后, 含 reserved 页)"
```

---

## Task 9: pages.rs CRUD 维护向量

**Files:**
- Modify: `src-server/src/routes/pages.rs`

- [ ] **Step 1: create_page / update_page 末尾按 content 分流嵌入**

`src/routes/pages.rs` 的 `create_page`，在 `Ok((StatusCode::CREATED, Json(page)))` 之前加：

```rust
    // 维护 embedding（非致命：失败只 log，不影响页面写入）
    match req.content.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(text) => {
            if let Err(e) = crate::services::embedding::embed_page(
                &state.db, state.config.embedding.as_ref(), &state.http,
                project_id, &req.path, text,
            ).await {
                tracing::warn!("embed page {} failed (search degraded): {}", req.path, e);
            }
        }
        None => {
            let _ = crate::services::embedding::delete_embedding(&state.db, project_id, &req.path).await;
        }
    }
```

`update_page`：在最终 `Ok(Json(page))` 之前加同样的分流块（用 `pq.path` 或 `req.path`，二者已被校验相等）。

> `create_page` 的 `req.content` 是 `Option<String>`；若 `req` 已被 move 进 SQL，提前 `let content_for_embed = req.content.clone();` 在 bind 之前。

- [ ] **Step 2: delete_page 删向量**

`delete_page` 在 `Ok(StatusCode::NO_CONTENT)` 之前加：

```rust
    let _ = crate::services::embedding::delete_embedding(&state.db, project_id, &pq.path).await;
```

- [ ] **Step 3: 编译确认**

```bash
cd src-server && cargo check 2>&1 | tail -5
```
Expected: `Finished`。

- [ ] **Step 4: 重启 + 手动验证 pages CRUD 维护**

```bash
pkill -f 'target/debug/llm-wiki-server'; sleep 2; cd src-server && nohup cargo run > /tmp/llmwiki_server.log 2>&1 &
TOKEN=...  # login
# create 有 content
curl -s -X POST "http://localhost:8080/api/v1/projects/249/pages" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"path":"entities/e2e-page.md","title":"E2E","content":"E2E test page about embedding maintenance"}'
docker exec src-server-postgres-1 psql -U llmwiki -d llmwiki -tA -c "SELECT count(*) FROM embeddings WHERE project_id=249 AND wiki_page_id='entities/e2e-page.md'"
# update content → None → 应清除
curl -s -X PUT "http://localhost:8080/api/v1/projects/249/page?path=entities/e2e-page.md" -H "Authorization: Bearer $TOKEN" -H "If-Match: <updated_at>" -H "Content-Type: application/json" -d '{"path":"entities/e2e-page.md","content":null}'
docker exec src-server-postgres-1 psql -U llmwiki -d llmwiki -tA -c "SELECT count(*) FROM embeddings WHERE project_id=249 AND wiki_page_id='entities/e2e-page.md'"
```
Expected: create 后 count=1；update content=null 后 count=0。

- [ ] **Step 5: Commit**

```bash
git add src-server/src/routes/pages.rs
git commit -m "feat(src-server): pages CRUD 维护 embedding(content 非空嵌入/空则清除/删除清向量)"
```

---

## Task 10: 端到端 #[ignore] 集成测试

**Files:**
- Modify: `src-server/tests/embedding_integration.rs`

- [ ] **Step 1: 写端到端测试（ingest → 向量 → vector_search 召回）**

在 `embedding_integration.rs` 追加（用 HTTP 客户端打真 server，或直接调 service 层；此处直接调 service 层更稳）：

```rust
#[tokio::test]
#[ignore = "requires PG + omlx + running src-server with project 249 ingested"]
async fn e2e_vector_search_recalls() {
    let (pool, cfg, client) = setup().await;
    let emb_cfg = cfg.embedding.as_ref().unwrap();
    let pid = 249i32;

    // 前提：project 249 已 ingest（Task 8 验证时产生向量）。这里只验召回。
    let qvec = embedding::embed_query(emb_cfg, &client, "Alice 在哪里工作").await.unwrap();
    let results = embedding::vector_search(&pool, pid, qvec, 5).await.unwrap();
    assert!(!results.is_empty(), "vector_search should return results");
    // alice.md 应在 top5（语义相关）
    let paths: Vec<&str> = results.iter().map(|r| r.path.as_str()).collect();
    assert!(paths.iter().any(|p| p.contains("alice")), "alice.md should be recalled; got {:?}", paths);
}
```

- [ ] **Step 2: 跑 --ignored 确认通过**

```bash
cd src-server && cargo test --test embedding_integration -- --ignored 2>&1 | tail -8
```
Expected: 全部 #[ignore] 测试 passed（含 e2e 召回）。

- [ ] **Step 3: 跑全量非 ignore 测试确认无回归**

```bash
cd src-server && cargo test --lib 2>&1 | tail -5
```
Expected: 全 pass（纯函数单测 + config 测试）。

- [ ] **Step 4: Commit**

```bash
git add src-server/tests/embedding_integration.rs
git commit -m "test(src-server): embedding 端到端 #[ignore] 集成测试(召回验证)"
```

---

## 验收对照（spec §9）

实现完成后逐条核对（与 spec §9 一致）：
- [ ] migration 005：content=vector(1024)、uniq 约束、HNSW — Task 1
- [ ] ingest 后每页（含 reserved）一行 1024 维 — Task 8 Step 4
- [ ] 重 ingest 不膨胀 — Task 5（ON CONFLICT）+ Task 8
- [ ] pages create/update(=None)/delete 维护 — Task 9
- [ ] embedding 未配 → server 起来、no-op — Task 2/5
- [ ] omlx 挂 → ingest succeeded(warning)、CRUD 成功 — 非致命（各 Task）
- [ ] vector_search 召回 — Task 10
