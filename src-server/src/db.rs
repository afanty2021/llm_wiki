use anyhow::Result;
use deadpool_redis::{Config as RedisConfig, Pool as RedisPool, Runtime};
use sqlx::{postgres::PgPoolOptions, Pool};
use std::time::Duration;

pub type DbPool = Pool<sqlx::Postgres>;
pub type RedisPoolType = RedisPool;

pub async fn create_pool(database_url: &str, max_connections: u32) -> Result<DbPool> {
    let pool = PgPoolOptions::new()
        .max_connections(max_connections)
        .acquire_timeout(Duration::from_secs(30))
        .idle_timeout(Duration::from_secs(600))
        .max_lifetime(Duration::from_secs(1800))
        .connect(database_url)
        .await?;

    // 验证连接
    sqlx::query("SELECT 1")
        .execute(&pool)
        .await
        .map_err(|e| anyhow::anyhow!("Failed to verify database connection: {}", e))?;

    tracing::info!("Connected to database");
    Ok(pool)
}

pub async fn create_redis_pool(redis_url: &str) -> Result<RedisPoolType> {
    let cfg = RedisConfig::from_url(redis_url);
    let pool = cfg
        .create_pool(Some(Runtime::Tokio1))
        .map_err(|e| anyhow::anyhow!("Failed to create Redis pool: {}", e))?;

    // 验证连接
    let mut conn = pool
        .get()
        .await
        .map_err(|e| anyhow::anyhow!("Failed to get Redis connection: {}", e))?;

    let _: String = redis::cmd("PING")
        .query_async(&mut conn)
        .await
        .map_err(|e| anyhow::anyhow!("Failed to PING Redis: {}", e))?;

    tracing::info!("Connected to Redis");
    Ok(pool)
}
