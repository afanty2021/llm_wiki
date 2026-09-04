//! GET /api/v1/search 的 rerank opt-out 参数（`rerank=false`）集成测试。
//!
//! 背景：hybrid_search 默认注入团队 LLM provider 做 rerank（rerank_pages，
//! SSE chat 一轮往返，live 实测 ~6s/次）。延迟敏感调用方（教师 MCP
//! llm_wiki_search，每回合 3-5 次）经 `rerank=false` 显式跳过，回落 RRF 序。
//!
//! 断言策略：计数 stub 记录 /chat/completions 命中次数——
//! - 不带参数（默认）：rerank 触发，stub 命中 ≥1（provider 在场且结果 >1）
//! - rerank=false：stub 命中数不增加（provider 根本不注入）
//! rerank 失败也会回落 RRF，故"调用次数"是区分 opt-out 与失败回落的唯一可观测量。

use axum::{routing::post, Router};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

/// SSE chat stub（chat_to_string 走 stream_chat，需 data: 行 + [DONE]），
/// 永远应答同一 rerank 形状文本，并计数。rerank 解析失败也无妨——
/// 本测试只看调用次数，不看序。
async fn spawn_counting_chat_stub() -> (String, Arc<AtomicUsize>) {
    let hits: Arc<AtomicUsize> = Arc::new(AtomicUsize::new(0));
    let hits_clone = hits.clone();
    let app = Router::new().route(
        "/chat/completions",
        post(move || {
            let hits = hits_clone.clone();
            async move {
                hits.fetch_add(1, Ordering::SeqCst);
                axum::response::Response::builder()
                    .header("content-type", "text/event-stream")
                    .body(axum::body::Body::from(
                        "data: {\"choices\":[{\"delta\":{\"content\":\"a.md 9\\nb.md 1\"}}]}\n\ndata: [DONE]\n\n",
                    ))
                    .unwrap()
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{}", addr), hits)
}

async fn setup() -> (
    axum_test::TestServer,
    llm_wiki_server::AppState,
    i32,
    String,
) {
    let (app, state) = crate::setup_test_app().await;
    let server = axum_test::TestServer::new(app).unwrap();
    let uuid = uuid::Uuid::new_v4().simple().to_string();
    let username = format!("rr_opt_{}", uuid);
    let token = crate::register_user(&server, &username, &format!("{}@t.com", username), "password123").await;
    let team_id: i32 = sqlx::query_scalar(
        "SELECT id FROM teams WHERE created_by = (SELECT id FROM users WHERE username = $1)",
    )
    .bind(&username)
    .fetch_one(&state.db)
    .await
    .unwrap();
    let resp = server
        .post("/api/v1/projects")
        .add_header("authorization", format!("Bearer {}", token))
        .json(&serde_json::json!({"name": format!("proj_{}", uuid), "team_id": team_id}))
        .await;
    assert_eq!(resp.status_code(), axum::http::StatusCode::CREATED);
    let pid = resp.json::<serde_json::Value>()["id"].as_i64().unwrap() as i32;
    (server, state, pid, token)
}

#[tokio::test]
async fn rerank_false_skips_llm_call_default_does_not() {
    let (server, state, pid, token) = setup().await;
    let auth = format!("Bearer {}", token);
    let (stub_root, hits) = spawn_counting_chat_stub().await;

    // 团队 provider 指到计数 stub（provider_for_project 只取 is_enabled 最小 id 一条）
    let r = server
        .post(&format!("/api/v1/teams/{}/llm-providers", team_id_of(&state, &auth, pid).await))
        .add_header("authorization", &auth)
        .json(&serde_json::json!({
            "provider_type": "openai",
            "api_key": "sk-rr-stub",
            "base_url": stub_root,
            "model": "rr-stub-model",
        }))
        .await;
    assert_eq!(r.status_code(), axum::http::StatusCode::CREATED, "provider 创建失败: {}", r.text());

    // 两个候选页（hybrid_search 仅在 results.len()>1 时走 rerank 分支）
    for (path, title) in [("a.md", "alpha 词汇教学"), ("b.md", "beta 词汇教学")] {
        sqlx::query("INSERT INTO wiki_pages (project_id, path, title, content) VALUES ($1, $2, $3, $4)")
            .bind(pid)
            .bind(path)
            .bind(title)
            .bind("词汇教学 分层练习")
            .execute(&state.db)
            .await
            .unwrap();
    }

    // 默认（不带 rerank）：rerank 分支触发 → stub 命中 ≥1
    let r = server
        .get(&format!("/api/v1/search?project_id={}&query={}&limit=5", pid, "词汇教学"))
        .add_header("authorization", &auth)
        .await;
    assert_eq!(r.status_code(), axum::http::StatusCode::OK, "默认搜索应 200: {}", r.text());
    let after_default = hits.load(Ordering::SeqCst);
    assert!(after_default >= 1, "默认路径应触发 rerank LLM 调用，实命中 {}", after_default);

    // rerank=false：provider 不注入 → stub 命中数不增加
    let r = server
        .get(&format!("/api/v1/search?project_id={}&query={}&limit=5&rerank=false", pid, "词汇教学"))
        .add_header("authorization", &auth)
        .await;
    assert_eq!(r.status_code(), axum::http::StatusCode::OK, "opt-out 搜索应 200: {}", r.text());
    let body = r.json::<serde_json::Value>();
    let n = body["results"].as_array().map(|a| a.len()).unwrap_or(0);
    assert!(n >= 1, "opt-out 仍应返回结果，实得 {}", n);
    let after_optout = hits.load(Ordering::SeqCst);
    assert_eq!(after_optout, after_default, "rerank=false 不得触发任何 LLM 调用（{}→{}）", after_default, after_optout);
}

/// 经 project 反查 team_id（setup 里已建，此处避免改 setup 签名）。
async fn team_id_of(_state: &llm_wiki_server::AppState, _auth: &str, pid: i32) -> i32 {
    sqlx::query_scalar("SELECT team_id FROM projects WHERE id = $1")
        .bind(pid)
        .fetch_one(&_state.db)
        .await
        .unwrap()
}
