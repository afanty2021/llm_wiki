// Database connection pool will be implemented in Task 1.4

use sqlx::PgPool;
use deadpool_redis::Pool as RedisPool;

pub type DbPool = PgPool;

pub async fn create_pool(database_url: &str, max_connections: u32) -> Result<DbPool, anyhow::Error> {
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(max_connections)
        .connect(database_url)
        .await?;

    Ok(pool)
}

pub async fn create_redis_pool(redis_url: &str) -> Result<RedisPool, anyhow::Error> {
    let config = deadpool_redis::Config::from_url(redis_url);
    let pool = config.create_pool(Some(deadpool_redis::Runtime::Tokio1))?;

    Ok(pool)
}
