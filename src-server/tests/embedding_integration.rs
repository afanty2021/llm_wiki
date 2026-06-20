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
    // project_id=249 真实存在(E2E Project);wiki_page_id 无 FK,可用任意路径。清理:
    let pid = 249i32;
    sqlx::query("DELETE FROM embeddings WHERE project_id=$1").bind(pid).execute(&pool).await.unwrap();

    let pages = vec![
        ("wiki/test-alice.md".to_string(), "Alice works at Acme Corp".to_string()),
        ("wiki/test-bob.md".to_string(), "Bob is a data scientist at Acme".to_string()),
    ];
    let n1 = embedding::embed_and_store(&pool, Some(emb_cfg), &client, pid, &pages).await.unwrap();
    assert_eq!(n1, 2);

    // 幂等：同批再调一次，行数不翻倍（ON CONFLICT）
    let _n2 = embedding::embed_and_store(&pool, Some(emb_cfg), &client, pid, &pages).await.unwrap();
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM embeddings WHERE project_id=$1")
        .bind(pid).fetch_one(&pool).await.unwrap();
    assert_eq!(count, 2, "ON CONFLICT should not duplicate; got {}", count);

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
    let (pool, _cfg, client) = setup().await;
    let n = embedding::embed_and_store(&pool, None, &client, 249, &[("x.md".into(), "x".into())]).await.unwrap();
    assert_eq!(n, 0);
}

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
        .bind(pid).bind(path).fetch_one(&pool).await.unwrap();
    assert_eq!(count, 1);

    embedding::delete_embedding(&pool, pid, path).await.unwrap();
    let count2: i64 = sqlx::query_scalar("SELECT count(*) FROM embeddings WHERE project_id=$1 AND wiki_page_id=$2")
        .bind(pid).bind(path).fetch_one(&pool).await.unwrap();
    assert_eq!(count2, 0);
}
