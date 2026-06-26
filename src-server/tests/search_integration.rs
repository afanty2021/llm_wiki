// 需 PG + omlx bge-m3。cargo test --test search_integration -- --ignored
// 自给自足播种临时 project（不依赖任何外部 fixture 数据），跑完即清理。
#![cfg(test)]
use llm_wiki_server::config::{AppConfig, SearchConfig};
use llm_wiki_server::services::{embedding, search};
use llm_wiki_server::services::vector_store::PgVectorStore;

async fn setup() -> (sqlx::PgPool, AppConfig, reqwest::Client) {
    let cfg = AppConfig::from_env().expect("from_env");
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(2)
        .connect(cfg.database_url())
        .await
        .unwrap();
    (pool, cfg, reqwest::Client::new())
}

/// 临时 project id（避开 search_golden_recall 用的 249，防并行 ignored 测互扰）。
const PID: i32 = 250;

/// 自给自足播种 alice/bob 两页 + 向量，返回路径列表供清理。幂等（先清旧再插）。
async fn seed(
    store: &dyn llm_wiki_server::services::vector_store::VectorStore,
    pool: &sqlx::PgPool,
    emb_cfg: &llm_wiki_server::config::EmbeddingConfig,
    client: &reqwest::Client,
) -> Vec<(String, String)> {
    sqlx::query("INSERT INTO projects (id, name, storage_path) VALUES ($1,'p2-search-int','/tmp/x') ON CONFLICT (id) DO NOTHING")
        .bind(PID).execute(pool).await.unwrap();
    let pages = vec![
        ("wiki/si-alice.md".to_string(),
         "Alice works at Acme on quantitative research with Python and pandas.".to_string()),
        ("wiki/si-bob.md".to_string(),
         "Bob enjoys gardening and grows tomatoes on weekends.".to_string()),
    ];
    for (p, _) in &pages {
        sqlx::query("DELETE FROM embeddings WHERE project_id=$1 AND wiki_page_id=$2").bind(PID).bind(p).execute(pool).await.unwrap();
        sqlx::query("DELETE FROM wiki_pages WHERE project_id=$1 AND path=$2").bind(PID).bind(p).execute(pool).await.unwrap();
    }
    for (p, text) in &pages {
        sqlx::query("INSERT INTO wiki_pages (project_id, path, title, content) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING")
            .bind(PID).bind(p).bind(p).bind(text).execute(pool).await.unwrap();
    }
    embedding::embed_and_store(store, Some(emb_cfg), client, PID, &pages).await.unwrap();
    pages
}

async fn cleanup(pool: &sqlx::PgPool, pages: &[(String, String)]) {
    for (p, _) in pages {
        sqlx::query("DELETE FROM embeddings WHERE project_id=$1 AND wiki_page_id=$2").bind(PID).bind(p).execute(pool).await.unwrap();
        sqlx::query("DELETE FROM wiki_pages WHERE project_id=$1 AND path=$2").bind(PID).bind(p).execute(pool).await.unwrap();
    }
}

#[tokio::test]
#[ignore = "requires PG + omlx"]
async fn hybrid_search_finds_alice() {
    let (pool, cfg, client) = setup().await;
    let store = PgVectorStore::new(pool.clone());
    let emb_cfg = cfg.embedding.as_ref().expect("embedding configured");
    let pages = seed(&store, &pool, emb_cfg, &client).await;

    let resp = search::hybrid_search(
        &pool, &store, &SearchConfig::default(), Some(emb_cfg), &client, PID, "Alice", 10, None,
    ).await.unwrap();

    assert!(matches!(resp.mode.as_str(), "hybrid" | "keyword" | "vector"));
    // emb_cfg=Some + "Alice"：keyword(alice token) + vector(语义) 应同时命中 → 真 hybrid
    assert!(
        resp.token_hits > 0 && resp.vector_hits > 0,
        "应触发真 hybrid (keyword+vector 同时命中): mode={}, token_hits={}, vector_hits={}",
        resp.mode, resp.token_hits, resp.vector_hits
    );
    assert!(
        resp.results.iter().any(|r| r.path.contains("alice")),
        "alice 页应在结果中: {:?}",
        resp.results.iter().map(|r| &r.path).collect::<Vec<_>>()
    );

    // 成功路径清理（断言失败时残留数据由 seed 的幂等清旧兜底）
    cleanup(&pool, &pages).await;
}
