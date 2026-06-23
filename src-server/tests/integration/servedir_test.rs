/// ServeDir 集成测试（Layer 5 Task 9）。
/// 验证 API 路由优先于 ServeDir fallback。SPA index.html 内容验证需 dist 存在（靠手动/CI build，不强测）。
/// 注册：tests/integration/mod.rs 加 `pub mod servedir_test;`。运行 `cargo test --test integration servedir`。
use axum::http::StatusCode;

#[tokio::test]
async fn health_route_not_swallowed_by_servedir() {
    let (app, _state) = crate::setup_test_app().await;
    let server = axum_test::TestServer::new(app).unwrap();
    let resp = server.get("/health").await;
    assert_eq!(resp.status_code(), StatusCode::OK); // /health 显式路由优先于 fallback_service
}

#[tokio::test]
async fn unknown_path_does_not_500() {
    let (app, _state) = crate::setup_test_app().await;
    let server = axum_test::TestServer::new(app).unwrap();
    let resp = server.get("/some/unknown/spa/route").await;
    // ServeDir fallback：dist 文件不存在→ServeFile 返回 404；存在→200 index.html。绝不 500。
    assert_ne!(resp.status_code(), StatusCode::INTERNAL_SERVER_ERROR);
}
