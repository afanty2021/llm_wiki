pub mod auth_test;
pub mod ingest_queue_test;
pub mod ingest_reliability_test;
pub mod ingest_test;
pub mod pages_test;
pub mod files_stat_test;
pub mod files_raw_test;
pub mod files_list_test;
pub mod files_fresh_project_test;
pub mod projects_list_test;
pub mod chat_stream_test;
pub mod servedir_test;
mod chat_sessions_test;
mod reviews_test;
mod permissions_test;
mod research_test;
mod registration_gate_test;
mod techdebt_r3_test;
mod training_test;
mod learning_api_test;
mod media_test;
mod t_page_test;

use axum::Router;
use llm_wiki_server::AppState;

/// default.json 的 jwt.secret 已出库置空（M1 评审 #1：靠 env 注入倒逼非默认值）。
/// 测试二进制在 from_env 前统一注入非黑名单 secret；若外部已设置（本地调试覆盖）则不覆盖。
/// 同一二进制内并发测试 set 的是同一常量值，无实际竞争。
pub fn ensure_test_jwt_secret() {
    if std::env::var("JWT__SECRET").unwrap_or_default().is_empty() {
        std::env::set_var("JWT__SECRET", "integration_test_secret_not_for_prod_32b");
    }
}

/// 构建测试 app（连 live DB 5433 + Redis 6380，配置来自 config/default.json）。
/// default.json 已翻 registration_enabled=false（Task 6 r3 fail-closed；测试二进制
/// 不读 .env——from_env 无 dotenv），故 from_env 后显式注入 true 再 create_app，
/// 否则本文件 27 处 register_user 调用全 403。
pub async fn setup_test_app() -> (Router, AppState) {
    ensure_test_jwt_secret();
    let mut config = llm_wiki_server::AppConfig::from_env().expect("Failed to load test config");
    config.auth.registration_enabled = true;
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
