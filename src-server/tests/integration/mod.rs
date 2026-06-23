pub mod auth_test;
pub mod ingest_queue_test;
pub mod ingest_test;
pub mod pages_test;
pub mod files_stat_test;
pub mod chat_stream_test;
pub mod servedir_test;
mod chat_sessions_test;
mod reviews_test;
mod permissions_test;
mod research_test;

use axum::Router;
use llm_wiki_server::AppState;

/// 构建测试 app（连 live DB 5433 + Redis 6380，配置来自 config/default.json）。
pub async fn setup_test_app() -> (Router, AppState) {
    let config = llm_wiki_server::AppConfig::from_env().expect("Failed to load test config");
    llm_wiki_server::create_app(config)
        .await
        .expect("Failed to create test app")
}

/// 注册用户，返回 access_token（register 响应已含 token，无需再 login）。
pub async fn register_user(
    server: &axum_test::TestServer,
    username: &str,
    email: &str,
    password: &str,
) -> String {
    let resp = server
        .post("/api/v1/auth/register")
        .content_type("application/json")
        .json(&serde_json::json!({"username":username,"email":email,"password":password}))
        .await;
    assert_eq!(resp.status_code(), axum::http::StatusCode::CREATED);
    resp.json::<serde_json::Value>()["access_token"]
        .as_str()
        .expect("access_token in response")
        .to_string()
}
