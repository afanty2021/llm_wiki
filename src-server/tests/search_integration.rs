// 需 PG(project 249 有 wiki_pages) + omlx bge-m3。cargo test --test search_integration -- --ignored
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

/// 确保 project 249 有向量（自给自足播种：读真实 wiki_pages → embed_and_store，幂等）。
/// 不 cleanup——保留向量供复用。
async fn ensure_project_seeded(
    store: &dyn llm_wiki_server::services::vector_store::VectorStore,
    pool: &sqlx::PgPool,
    emb_cfg: &llm_wiki_server::config::EmbeddingConfig,
    client: &reqwest::Client,
) {
    let pages: Vec<(String, String)> = sqlx::query_as::<_, (String, String)>(
        "SELECT path, COALESCE(content,'') FROM wiki_pages WHERE project_id = 249",
    )
    .fetch_all(pool)
    .await
    .unwrap()
    .into_iter()
    .filter(|(_, c)| !c.trim().is_empty())
    .collect();
    assert!(!pages.is_empty(), "project 249 应有 wiki 页");
    embedding::embed_and_store(store, Some(emb_cfg), client, 249, &pages)
        .await
        .unwrap();
}

#[tokio::test]
#[ignore = "requires PG(project 249) + omlx"]
async fn hybrid_search_finds_alice() {
    let (pool, cfg, client) = setup().await;
    let store = PgVectorStore::new(pool.clone());
    let emb_cfg = cfg.embedding.as_ref().expect("embedding configured");
    ensure_project_seeded(&store, &pool, emb_cfg, &client).await; // 自给自足播种

    let resp = search::hybrid_search(
        &pool,
        &store,
        &SearchConfig::default(),
        Some(emb_cfg),
        &client,
        249,
        "Alice",
        10,
        None,
    )
    .await
    .unwrap();
    assert!(matches!(resp.mode.as_str(), "hybrid" | "keyword" | "vector"));
    // emb_cfg=Some + "Alice"：keyword(alice token) + vector(语义) 应同时命中 → 真 hybrid
    assert!(
        resp.token_hits > 0 && resp.vector_hits > 0,
        "应触发真 hybrid (keyword+vector 同时命中): mode={}, token_hits={}, vector_hits={}",
        resp.mode, resp.token_hits, resp.vector_hits
    );
    assert!(
        resp.results
            .iter()
            .any(|r| r.path.contains("alice")),
        "alice.md 应在结果中: {:?}",
        resp.results.iter().map(|r| &r.path).collect::<Vec<_>>()
    );
}
