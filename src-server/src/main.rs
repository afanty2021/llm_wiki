use anyhow::{Context, Result};
use dotenvy::dotenv;
use llm_wiki_server::create_app;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

#[tokio::main]
async fn main() -> Result<()> {
    // 加载环境变量
    dotenv().ok();

    // 初始化日志
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "llm_wiki_server=info,tower_http=debug,axum=trace".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    // 读取配置
    let config = llm_wiki_server::AppConfig::from_env()?;

    // 创建应用
    let (app, state) = create_app(config).await?;

    // 启动 ingest worker（同进程 tokio task）
    llm_wiki_server::services::ingest_worker::spawn_worker(state.clone());
    llm_wiki_server::services::research::worker::spawn_worker(state.clone());

    // 启动服务器
    let addr = format!("{}:{}", state.config.host(), state.config.port());
    tracing::info!("listening on {}", addr);

    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .context("Failed to bind to address")?;
    axum::serve(listener, app).await?;

    Ok(())
}
