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

#[tokio::test]
async fn llm_provider_update_changes_fields() {
    let (server, _state, team_id, _owner, admin_token, _member_token) = setup_team_with_roles("prov-upd").await;
    // 先 CREATE
    let r = server.post(&format!("/api/v1/teams/{}/llm-providers", team_id))
        .add_header("authorization", auth(&admin_token))
        .json(&serde_json::json!({"provider_type":"openai","api_key":"k1","model":"gpt-4o"})).await;
    assert_eq!(r.status_code(), StatusCode::CREATED);
    let sid = r.json::<serde_json::Value>()["id"].as_i64().unwrap() as i32;
    // PUT 改 model + api_key
    let u = server.put(&format!("/api/v1/teams/{}/llm-providers/{}", team_id, sid))
        .add_header("authorization", auth(&admin_token))
        .json(&serde_json::json!({"model":"gpt-4o-mini","api_key":"k2"})).await;
    assert_eq!(u.status_code(), StatusCode::OK);
    let body: serde_json::Value = u.json();
    assert_eq!(body["model"], "gpt-4o-mini");
    // GET 验证 model 持久化
    let g = server.get(&format!("/api/v1/teams/{}/llm-providers", team_id))
        .add_header("authorization", auth(&admin_token)).await;
    assert_eq!(g.json::<serde_json::Value>()["model"], "gpt-4o-mini");
}

/// 在 team 下建一个 project（owner 直建），返回 project_id。
async fn seed_project_in_team(state: &llm_wiki_server::AppState, team_id: i32) -> i32 {
    let owner_id: i32 = sqlx::query_scalar("SELECT created_by FROM teams WHERE id=$1")
        .bind(team_id).fetch_one(&state.db).await.unwrap();
    let uid = uuid::Uuid::new_v4();
    let row = sqlx::query(
        "INSERT INTO projects (team_id, name, storage_path, created_by) VALUES ($1,$2,$3,$4) RETURNING id")
        .bind(team_id).bind(format!("p-{}", uid))
        .bind(format!("/tmp/{}", uid)).bind(owner_id)
        .fetch_one(&state.db).await.unwrap();
    sqlx::Row::get::<i32, _>(&row, "id")
}

#[tokio::test]
async fn role_matrix_delete_page() {
    let (server, state, team_id, _owner, admin_token, member_token) = setup_team_with_roles("perm-page").await;
    let pid = seed_project_in_team(&state, team_id).await;
    sqlx::query("INSERT INTO wiki_pages (project_id, path, title, content, page_type) VALUES ($1,'wiki/x.md','X','c','concept') ON CONFLICT DO NOTHING")
        .bind(pid).execute(&state.db).await.unwrap();
    // member 删页 → 403
    let m = server.delete(&format!("/api/v1/projects/{}/page?path=wiki/x.md", pid))
        .add_header("authorization", auth(&member_token)).await;
    assert_eq!(m.status_code(), StatusCode::FORBIDDEN);
    // admin 删页 → 204
    let a = server.delete(&format!("/api/v1/projects/{}/page?path=wiki/x.md", pid))
        .add_header("authorization", auth(&admin_token)).await;
    assert_eq!(a.status_code(), StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn role_matrix_delete_project() {
    let (server, state, team_id, owner_token, admin_token, member_token) = setup_team_with_roles("perm-delproj").await;
    let pid_m = seed_project_in_team(&state, team_id).await;
    let m = server.delete(&format!("/api/v1/projects/{}", pid_m))
        .add_header("authorization", auth(&member_token)).await;
    assert_eq!(m.status_code(), StatusCode::FORBIDDEN);
    let pid_a = seed_project_in_team(&state, team_id).await;
    let a = server.delete(&format!("/api/v1/projects/{}", pid_a))
        .add_header("authorization", auth(&admin_token)).await;
    assert_eq!(a.status_code(), StatusCode::FORBIDDEN);
    let pid_o = seed_project_in_team(&state, team_id).await;
    let o = server.delete(&format!("/api/v1/projects/{}", pid_o))
        .add_header("authorization", auth(&owner_token)).await;
    assert_eq!(o.status_code(), StatusCode::OK);
}
