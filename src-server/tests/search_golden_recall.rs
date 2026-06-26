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

/// golden set：自给自足播种若干语义近似/相远 page，断言 chunk 级检索召回相关页。
#[tokio::test]
#[ignore = "requires PG(011 applied) + omlx bge-m3"]
async fn chunk_search_recalls_relevant_page() {
    let _g = serial_lock().await;
    let (pool, cfg, client) = setup().await;
    let emb_cfg = cfg.embedding.as_ref().expect("embedding configured");
    let store = PgVectorStore::with_ef_search(pool.clone(), emb_cfg.ef_search);
    let pid = 249i32;

    // 确保 project 249 存在（FK 约束；若已存在则跳过插入）
    sqlx::query("INSERT INTO projects (id, name, storage_path) VALUES ($1, 'p2-golden', '/tmp/x') ON CONFLICT (id) DO NOTHING")
        .bind(pid).execute(&pool).await.unwrap();
    // 播种 3 page：alice（相关）、bob（无关）、carol（部分相关）
    let pages = vec![
        ("wiki/golden-alice.md".to_string(),
         "Alice 在 Acme 公司负责量化研究，常用 Python 与 pandas 构建因子模型。".to_string()),
        ("wiki/golden-bob.md".to_string(),
         "Bob 喜欢园艺，周末种番茄和玫瑰。".to_string()),
        ("wiki/golden-carol.md".to_string(),
         "Carol 是数据工程师，维护特征仓库与数据管道。".to_string()),
    ];
    // 先清旧（幂等）
    for (p, _) in &pages {
        sqlx::query("DELETE FROM embeddings WHERE project_id=$1 AND wiki_page_id=$2").bind(pid).bind(p).execute(&pool).await.unwrap();
        sqlx::query("DELETE FROM wiki_pages WHERE project_id=$1 AND path=$2").bind(pid).bind(p).execute(&pool).await.unwrap();
    }
    // 播种 wiki_pages（search_chunks 的 SQL JOIN 需要）+ 向量
    for (p, text) in &pages {
        sqlx::query("INSERT INTO wiki_pages (project_id, path, title, content) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING")
            .bind(pid).bind(p).bind(p).bind(text).execute(&pool).await.unwrap();
    }
    let _ = embedding::embed_and_store(&store, Some(emb_cfg), &client, pid, &pages).await.unwrap();

    // 查询「量化研究员是谁」→ alice 应被召回（top-2 内），且分数高于明显无关的 bob。
    let qvec = embedding::embed_query(emb_cfg, &client, "量化研究员是谁").await.unwrap();
    let hits = store.search_chunks(pid, qvec, 40, 5).await.unwrap();
    let top_paths: Vec<&str> = hits.iter().map(|h| h.page_id.as_str()).collect();
    assert!(
        top_paths.iter().take(2).any(|p| p.contains("alice")),
        "alice 应在 top-2；got {:?}", top_paths
    );
    let score_of = |name: &str| -> f64 {
        hits.iter().find(|h| h.page_id.contains(name)).map(|h| h.score).unwrap_or(-1.0)
    };
    assert!(score_of("alice") > score_of("bob"),
        "alice 分数应高于 bob；alice={}, bob={}", score_of("alice"), score_of("bob"));

    // cleanup（不留测试数据）
    for (p, _) in &pages {
        sqlx::query("DELETE FROM embeddings WHERE project_id=$1 AND wiki_page_id=$2").bind(pid).bind(p).execute(&pool).await.unwrap();
        sqlx::query("DELETE FROM wiki_pages WHERE project_id=$1 AND path=$2").bind(pid).bind(p).execute(&pool).await.unwrap();
    }
}
