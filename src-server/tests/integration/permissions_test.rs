use axum::http::StatusCode;
use std::sync::atomic::{AtomicU64, Ordering};

static COUNTER: AtomicU64 = AtomicU64::new(0);
fn unique_prefix(tag: &str) -> String {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    format!("{}_{}_{}", tag, std::process::id(), n)
}
fn auth(token: &str) -> String { format!("Bearer {}", token) }

/// 注册 owner → 其 personal team；再注册 admin/member 并以 SQL 直加进 team。返回各 token + team_id。
async fn setup_team_with_roles(
    tag: &str,
) -> (axum_test::TestServer, llm_wiki_server::AppState, i32, String, String, String) {
    let (app, state) = crate::setup_test_app().await;
    let server = axum_test::TestServer::new(app).unwrap();
    let owner = unique_prefix(&format!("{}-owner", tag));
    let owner_token = crate::register_user(&server, &owner, &format!("{}@t.com", owner), "password123").await;
    let team_id: i32 = sqlx::query_scalar(
        "SELECT id FROM teams WHERE created_by = (SELECT id FROM users WHERE username = $1)")
        .bind(&owner).fetch_one(&state.db).await.unwrap();
    let admin = unique_prefix(&format!("{}-admin", tag));
    let member = unique_prefix(&format!("{}-member", tag));
    let admin_token = crate::register_user(&server, &admin, &format!("{}@t.com", admin), "password123").await;
    let member_token = crate::register_user(&server, &member, &format!("{}@t.com", member), "password123").await;
    sqlx::query("INSERT INTO team_members (team_id, user_id, role) VALUES ($1, (SELECT id FROM users WHERE username=$2), 'admin')")
        .bind(team_id).bind(&admin).execute(&state.db).await.unwrap();
    sqlx::query("INSERT INTO team_members (team_id, user_id, role) VALUES ($1, (SELECT id FROM users WHERE username=$2), 'member')")
        .bind(team_id).bind(&member).execute(&state.db).await.unwrap();
    (server, state, team_id, owner_token, admin_token, member_token)
}

#[tokio::test]
async fn llm_provider_crud_roundtrip() {
    let (server, state, team_id, _owner, admin_token, _member_token) = setup_team_with_roles("prov-crud").await;
    // CREATE (admin)
    let r = server.post(&format!("/api/v1/teams/{}/llm-providers", team_id))
        .add_header("authorization", auth(&admin_token))
        .json(&serde_json::json!({"provider_type":"openai","api_key":"secret-xyz","model":"gpt-4o"})).await;
    assert_eq!(r.status_code(), StatusCode::CREATED);
    let body: serde_json::Value = r.json();
    assert_eq!(body["provider_type"], "openai");
    assert_eq!(body["has_key"], true);
    assert!(body.get("api_key").is_none(), "GET 响应不得回传 api_key");
    let sid = body["id"].as_i64().unwrap() as i32;
    // 加密往返：DB 存密文，decrypt 还原
    let enc: String = sqlx::query_scalar("SELECT api_key_encrypted FROM llm_providers WHERE id=$1")
        .bind(sid).fetch_one(&state.db).await.unwrap();
    assert_ne!(enc, "secret-xyz");
    assert_eq!(llm_wiki_server::services::llm::decrypt_api_key(&enc, &state.config).unwrap(), "secret-xyz");
    // 同 team 重复 provider_type → 409
    let dup = server.post(&format!("/api/v1/teams/{}/llm-providers", team_id))
        .add_header("authorization", auth(&admin_token))
        .json(&serde_json::json!({"provider_type":"openai","api_key":"k2"})).await;
    assert_eq!(dup.status_code(), StatusCode::CONFLICT);
    // DELETE
    let d = server.delete(&format!("/api/v1/teams/{}/llm-providers/{}", team_id, sid))
        .add_header("authorization", auth(&admin_token)).await;
    assert_eq!(d.status_code(), StatusCode::OK);
}
