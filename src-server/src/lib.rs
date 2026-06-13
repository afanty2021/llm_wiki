use anyhow::Result;
use std::sync::Arc;

pub mod config;
pub mod db;
pub mod error;
pub mod middleware;
pub mod models;
pub mod routes;
pub mod services;
pub mod utils;

pub use config::AppConfig;
pub use db::DbPool;
pub use error::{AppError, IntoAppError};

#[derive(Clone)]
pub struct AppState {
    pub db: DbPool,
    pub redis: deadpool_redis::Pool,
    pub config: Arc<AppConfig>,
}

pub async fn create_app(config: AppConfig) -> Result<(axum::Router, AppState)> {
    // 初始化数据库连接池
    let db = db::create_pool(config.database_url(), config.database_max_connections()).await?;

    // 初始化 Redis 连接池
    let redis = db::create_redis_pool(config.redis_url()).await?;

    let state = AppState {
        db,
        redis,
        config: Arc::new(config),
    };

    // 构建路由
    let app = routes::create_router(state.clone());

    Ok((app, state))
}
