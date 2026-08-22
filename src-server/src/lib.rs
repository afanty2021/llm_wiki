use anyhow::Result;
use std::sync::Arc;
use axum::middleware::from_fn;
use tokio::sync::broadcast;

use crate::services::ingest_queue::JobEvent;

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
    ERR_LLM_API_ERROR, ERR_INTERNAL_ERROR, ERR_CONFLICT, ERR_TOO_MANY_REQUESTS,
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
    pub job_events: broadcast::Sender<JobEvent>,
    /// t_page 三端点限流（Task 6 r3）：/s/ 30/min（key=code）+ beacon 60/min
    /// （key=token 指纹，seen/complete 共桶）。两档规格组合为一个字段，内含
    /// 两个 FixedWindowLimiter（services/rate_limit.rs，评审 R3 正名：实现是固定窗口计数非令牌桶）。
    /// 评审 R4：cap 经 config 注入（page_rate_limits.s_per_min / beacon_per_min，
    /// 默认 30/60 与旧硬编码一致，env PAGE_RATE_LIMITS__* 可覆盖）。
    pub limiter: Arc<services::rate_limit::PageRateLimits>,
    /// SEC-3（终审必修）：bind/login IP 级限流（各 10/min/IP，FixedWindowLimiter
    /// 独立两桶；key 见 rate_limit::ClientIp——Cf-Connecting-Ip 头优先回落 socket addr）。
    pub ip_limiter: Arc<services::rate_limit::IpRateLimits>,
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

    // 向量后端：PgVectorStore 持 PgPool（db.clone()，DbPool 是 Clone）。ef_search 取 EmbeddingConfig（默认 80）。
    let vector_store: Arc<dyn services::vector_store::VectorStore> =
        Arc::new(services::vector_store::PgVectorStore::with_ef_search(
            db.clone(),
            config.embedding.as_ref().map(|c| c.ef_search).unwrap_or(80),
        ));

    let (job_events, _job_events_rx) = broadcast::channel::<JobEvent>(64);

    let limiter = Arc::new(services::rate_limit::PageRateLimits::with_caps(
        config.page_rate_limits.s_per_min,
        config.page_rate_limits.beacon_per_min,
        config.page_rate_limits.t_per_min,
    ));

    let ip_limiter = Arc::new(services::rate_limit::IpRateLimits::new());

    let state = AppState {
        db,
        redis,
        config: Arc::new(config),
        http,
        storage,
        vector_store,
        job_events,
        limiter,
        ip_limiter,
    };

    // 构建 CORS 中间件层
    let cors_layer = middleware::create_cors_layer(state.config.allowed_origins());

    // 构建路由并附加中间件层（从外到内: CORS -> Logging -> Router）
    let app = routes::create_router(state.clone())
        .layer(from_fn(middleware::logging_middleware))
        .layer(cors_layer);

    Ok((app, state))
}
