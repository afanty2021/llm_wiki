use anyhow::{Context, Result};
use dotenvy::dotenv;
use llm_wiki_server::create_app;

#[tokio::main]
async fn main() -> Result<()> {
    // 加载环境变量
    dotenv().ok();

    // 读取配置（在 init_logging 前，日志参数从 config 取）
    let config = llm_wiki_server::AppConfig::from_env()?;

    // 初始化日志系统（文件轮转 + 级别控制；在 create_app 前使启动期日志可写文件）
    llm_wiki_server::services::logging::init_logging(
        config.logging.dir.clone().into(),
        config.logging.level.clone(),
        config.logging.max_size_bytes,
        config.logging.max_files,
    )
    .expect("Failed to initialize logging");

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
