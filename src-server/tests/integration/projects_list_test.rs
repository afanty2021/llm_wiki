/// list_projects 集成测试。
///
/// 回归:`SELECT 0 as file_count` postgres 推断 int4,而 ProjectResponse.file_count: i64
/// 期望 int8 → sqlx 类型不匹配。当 team 有 ≥1 project(返回行)时 query_as 映射失败 → 500;
/// 空 team(0 行,无映射)误判 200,故长期未被发现。修复:`0::bigint as file_count`。
///
/// 运行:`cargo test --test integration projects_list`(连 live DB 5433 + Redis 6380)。
use axum::http::StatusCode;
use std::sync::atomic::{AtomicU64, Ordering};

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// register → 查 team_id。返回 (server, team_id, token)。
async fn setup() -> (axum_test::TestServer, i32, String) {
    let (app, state) = crate::setup_test_app().await;
    let server = axum_test::TestServer::new(app).unwrap();
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let username = format!("plist_{}_{}", std::process::id(), n);
    let token = crate::register_user(
        &server,
        &username,
        &format!("{}@t.com", username),
        "password123",
    )
    .await;
    let team_id: i32 = sqlx::query_scalar(
        "SELECT id FROM teams WHERE created_by = (SELECT id FROM users WHERE username = $1)",
    )
    .bind(&username)
    .fetch_one(&state.db)
    .await
    .unwrap();
    (server, team_id, token)
}

async fn create_project(server: &axum_test::TestServer, team_id: i32, token: &str, name: &str) {
    let resp = server
        .post("/api/v1/projects")
        .add_header("authorization", format!("Bearer {}", token))
        .json(&serde_json::json!({"name": name, "team_id": team_id}))
        .await;
    assert_eq!(resp.status_code(), StatusCode::CREATED);
}

/// team 有 ≥1 project 时 list → 200 + items 非空(回归:file_count int4 vs i64 曾 500)。
#[tokio::test]
async fn list_projects_200_when_team_has_projects() {
    let (server, team_id, token) = setup().await;
    create_project(&server, team_id, &token, "proj-a").await;

    let r = server
        .get(&format!("/api/v1/projects?team_id={}", team_id))
        .add_header("authorization", format!("Bearer {}", token))
        .await;
    assert_eq!(
        r.status_code(),
        StatusCode::OK,
        "list with ≥1 project must not 500 (file_count type)"
    );
    let body = r.json::<serde_json::Value>();
    let items = body["items"].as_array().expect("items array");
    assert!(
        !items.is_empty(),
        "must list the created project: {:?}",
        body
    );
    // file_count 字段存在(验证 i64 映射成功)
    assert!(items[0].get("file_count").is_some(), "file_count present");
}

/// 空 team list → 200 + items=[](无行映射,本就 200;防回归)。
#[tokio::test]
async fn list_projects_200_empty_team() {
    let (server, team_id, token) = setup().await;
    let r = server
        .get(&format!("/api/v1/projects?team_id={}", team_id))
        .add_header("authorization", format!("Bearer {}", token))
        .await;
    assert_eq!(r.status_code(), StatusCode::OK);
    let body = r.json::<serde_json::Value>();
    assert_eq!(body["items"].as_array().unwrap().len(), 0);
}
