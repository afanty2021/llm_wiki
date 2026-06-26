// 需 PG(docker src-server-postgres-1 @5433) + omlx(@8001 bge-m3) 本地运行。
// cargo test --test embedding_integration -- --ignored
#![cfg(test)]
use llm_wiki_server::config::AppConfig;
use llm_wiki_server::services::embedding;
use llm_wiki_server::services::vector_store::PgVectorStore;
use std::sync::OnceLock;
use tokio::sync::Mutex;

// 所有 #[ignore] 测试共享 PG project 249（含播种数据），并行会竞态。
// 全局锁强制串行——`cargo test --test embedding_integration -- --ignored` 默认多线程也能稳定通过。
static SERIAL_GUARD: OnceLock<Mutex<()>> = OnceLock::new();
async fn serial_lock() -> tokio::sync::MutexGuard<'static, ()> {
    SERIAL_GUARD.get_or_init(|| Mutex::new(())).lock().await
}

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
    let _g = serial_lock().await;
    let (pool, cfg, client) = setup().await;
    let store = PgVectorStore::new(pool.clone());
    let emb_cfg = cfg.embedding.as_ref().expect("embedding configured");
    // project_id=249 真实存在(E2E Project);wiki_page_id 无 FK,可用任意路径。清理:
    let pid = 249i32;
    sqlx::query("DELETE FROM embeddings WHERE project_id=$1").bind(pid).execute(&pool).await.unwrap();

    let pages = vec![
        ("wiki/test-alice.md".to_string(), "Alice works at Acme Corp".to_string()),
        ("wiki/test-bob.md".to_string(), "Bob is a data scientist at Acme".to_string()),
    ];
    let _n1 = embedding::embed_and_store(&store, Some(emb_cfg), &client, pid, &pages).await.unwrap();

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

    // cleanup
    sqlx::query("DELETE FROM embeddings WHERE project_id=$1").bind(pid).execute(&pool).await.unwrap();
}

#[tokio::test]
#[ignore = "requires PG"]
async fn embed_and_store_noop_when_cfg_none() {
    let _g = serial_lock().await;
    let (pool, _cfg, client) = setup().await;
    let store = PgVectorStore::new(pool.clone());
    let n = embedding::embed_and_store(&store, None, &client, 249, &[("x.md".into(), "x".into())]).await.unwrap();
    assert_eq!(n, 0);
}

#[tokio::test]
#[ignore = "requires PG + omlx"]
async fn embed_page_then_delete() {
    let _g = serial_lock().await;
    let (pool, cfg, client) = setup().await;
    let store = PgVectorStore::new(pool.clone());
    let emb_cfg = cfg.embedding.as_ref().unwrap();
    let pid = 249i32;
    let path = "wiki/test-single.md";
    sqlx::query("DELETE FROM embeddings WHERE project_id=$1 AND wiki_page_id=$2")
        .bind(pid).bind(path).execute(&pool).await.unwrap();

    embedding::embed_page(&store, Some(emb_cfg), &client, pid, path, "single page text").await.unwrap();
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM embeddings WHERE project_id=$1 AND wiki_page_id=$2")
        .bind(pid).bind(path).fetch_one(&pool).await.unwrap();
    assert_eq!(count, 1);

    embedding::delete_embedding(&store, pid, path).await.unwrap();
    let count2: i64 = sqlx::query_scalar("SELECT count(*) FROM embeddings WHERE project_id=$1 AND wiki_page_id=$2")
        .bind(pid).bind(path).fetch_one(&pool).await.unwrap();
    assert_eq!(count2, 0);
}

/// 端到端：自给自足播种临时 project 的 alice 页 → embed_query → vector_search 召回 alice。
/// 不依赖任何外部 fixture（原读 project 249 真实 wiki_pages，本 dev DB 已空 → 改自播种）。
#[tokio::test]
#[ignore = "requires PG + omlx bge-m3"]
async fn e2e_vector_search_recalls() {
    let _g = serial_lock().await;
    let (pool, cfg, client) = setup().await;
    let store = PgVectorStore::new(pool.clone());
    let emb_cfg = cfg.embedding.as_ref().unwrap();
    let pid = 251i32; // 临时 project（避开 golden_recall 249 / search_integration 250）
    let path = "wiki/e2e-alice.md";
    let text = "Alice 在 Acme 公司负责量化研究，常用 Python 构建因子模型。";

    sqlx::query("INSERT INTO projects (id, name, storage_path) VALUES ($1,'p2-e2e','/tmp/x') ON CONFLICT (id) DO NOTHING")
        .bind(pid).execute(&pool).await.unwrap();
    sqlx::query("DELETE FROM embeddings WHERE project_id=$1 AND wiki_page_id=$2").bind(pid).bind(path).execute(&pool).await.unwrap();
    sqlx::query("DELETE FROM wiki_pages WHERE project_id=$1 AND path=$2").bind(pid).bind(path).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO wiki_pages (project_id, path, title, content) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING")
        .bind(pid).bind(path).bind(path).bind(text).execute(&pool).await.unwrap();
    embedding::embed_and_store(&store, Some(emb_cfg), &client, pid, &[(path.to_string(), text.to_string())]).await.unwrap();

    // 召回：query 语义近似 alice
    let qvec = embedding::embed_query(emb_cfg, &client, "Alice 在哪里工作").await.unwrap();
    let results = embedding::vector_search(&store, pid, qvec, 5).await.unwrap();
    assert!(!results.is_empty(), "vector_search should return results");
    let paths: Vec<&str> = results.iter().map(|r| r.path.as_str()).collect();
    assert!(
        paths.iter().any(|p| p.contains("alice")),
        "alice 页应被召回；got {:?}", paths
    );

    // cleanup
    sqlx::query("DELETE FROM embeddings WHERE project_id=$1 AND wiki_page_id=$2").bind(pid).bind(path).execute(&pool).await.unwrap();
    sqlx::query("DELETE FROM wiki_pages WHERE project_id=$1 AND path=$2").bind(pid).bind(path).execute(&pool).await.unwrap();
    sqlx::query("DELETE FROM projects WHERE id=$1").bind(pid).execute(&pool).await.unwrap();
}
