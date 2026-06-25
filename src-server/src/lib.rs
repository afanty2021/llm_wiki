use anyhow::Result;
use std::sync::Arc;
use axum::middleware::from_fn;

pub mod config;
pub mod db;
pub mod error;
pub mod middleware;
pub mod models;
pub mod routes;
pub mod services;
pub mod utils;

#[cfg(test)]
mod tests;

pub use config::AppConfig;
pub use db::{create_pool, create_redis_pool, DbPool, RedisPoolType as RedisPool};
pub use error::{
    AppError, IntoAppError, ERR_AUTH_INVALID, ERR_AUTH_EXPIRED, ERR_PERMISSION_DENIED,
    ERR_RESOURCE_NOT_FOUND, ERR_VALIDATION_FAILED, ERR_DATABASE_ERROR, ERR_FILE_UPLOAD_FAILED,
    ERR_LLM_API_ERROR, ERR_INTERNAL_ERROR, ERR_CONFLICT,
};
pub use routes::WikiPage;

#[derive(Clone)]
pub struct AppState {
    pub db: DbPool,
    pub redis: RedisPool,
    pub config: Arc<AppConfig>,
    pub http: reqwest::Client,
    pub storage: Arc<dyn services::storage::StorageBackend>,
    pub vector_store: Arc<dyn services::vector_store::VectorStore>,
}

pub async fn create_app(config: AppConfig) -> Result<(axum::Router, AppState)> {
    // 初始化数据库连接池
    let db = db::create_pool(config.database_url(), config.database_max_connections()).await?;

    // 初始化 Redis 连接池
    let redis = db::create_redis_pool(config.redis_url()).await?;

    // 共享 HTTP client（连接池复用）。无全局 timeout——LLM 长请求/嵌入各设各自超时。
    let http = reqwest::Client::builder()
        .build()
        .expect("failed to build reqwest Client");

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

    let state = AppState {
        db,
        redis,
        config: Arc::new(config),
        http,
        storage,
        vector_store,
    };

    // 构建 CORS 中间件层
    let cors_layer = middleware::create_cors_layer(state.config.allowed_origins());

    // 构建路由并附加中间件层（从外到内: CORS -> Logging -> Router）
    let app = routes::create_router(state.clone())
        .layer(from_fn(middleware::logging_middleware))
        .layer(cors_layer);

    Ok((app, state))
}
