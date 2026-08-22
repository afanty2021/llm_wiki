//! 注册开关 gate：`auth.registration_enabled=false` 时 register 返回 403。
//! 「改 config 后 create_app」模式在本任务首次建立，Task 6/7/8 复用。

use axum_test::TestServer;

#[tokio::test]
async fn register_rejected_when_disabled() {
    // 改 config 后 create_app 模式（本任务首次建立，T6/T8 复用）
    crate::ensure_test_jwt_secret();
    let mut cfg = llm_wiki_server::AppConfig::from_env().unwrap();
    cfg.auth.registration_enabled = false;
    // create_app 返回 (Router, AppState) 元组——须解构，T6/T7/T8 复用此模式
    let (app, _state) = llm_wiki_server::create_app(cfg).await.unwrap();
    let server = TestServer::new(app).unwrap();
    let resp = server.post("/api/v1/auth/register")
        .json(&serde_json::json!({"username":"blocked","email":"b@x.com","password":"secret123"}))
        .await;
    assert_eq!(resp.status_code(), 403);
    // PermissionDenied 为无载荷单元变体（error.rs:33），响应 message 固定为
    // "Permission denied"；具体原因 "registration disabled" 走 tracing::warn 日志。
    assert!(resp.text().contains("Permission denied"));
}

/// Task 6（r3）：default.json 翻 registration_enabled=false（fail-closed）后，
/// setup_test_app 必须注入 registration_enabled=true 再 create_app——否则测试
/// 二进制（from_env 无 dotenv，直读 default.json）27 处 register_user 全 403。
#[tokio::test]
async fn register_still_enabled_via_setup_test_app() {
    let (app, _state) = crate::setup_test_app().await;
    let server = TestServer::new(app).unwrap();
    let uname = format!("t6gate_{}", std::process::id());
    let resp = server
        .post("/api/v1/auth/register")
        .json(&serde_json::json!({
            "username": uname,
            "email": format!("{uname}@t6.com"),
            "password": "secret123"
        }))
        .await;
    assert_eq!(resp.status_code(), 201, "setup_test_app must re-enable registration for tests");
}
