// 需 PG(project 249 已 ingest)。cargo test --test graph_integration -- --ignored
#![cfg(test)]
use llm_wiki_server::services::graph;

#[tokio::test]
#[ignore = "requires PG with ingested project 249"]
async fn build_graph_assigns_communities_and_relevance_weights() {
    let cfg = llm_wiki_server::AppConfig::from_env().expect("from_env");
    let pool = sqlx::postgres::PgPoolOptions::new().max_connections(2).connect(cfg.database_url()).await.unwrap();
    let g = graph::build_graph(&pool, 249).await.unwrap();
    assert!(!g.nodes.is_empty(), "project 249 应有 wiki 页");
    assert!(g.nodes.iter().all(|n| n.id == n.path), "node id 应=path");
    // 边权非全 1.0（relevance 生效）
    let all_one = g.edges.iter().all(|e| (e.weight - 1.0).abs() < 1e-9);
    assert!(!all_one || g.edges.is_empty(), "边权应为 relevance（非全 1.0）: {:?}", g.edges.iter().map(|e| e.weight).collect::<Vec<_>>());
    // 单节点社区 cohesion=0（无 NaN）
    assert!(g.communities.iter().all(|c| c.cohesion.is_finite()));
}
