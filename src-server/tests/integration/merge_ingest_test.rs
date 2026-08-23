//! 多源累积合并集成测试（t8_ 前缀 + SWEEPS；spec §5）。
//! stub chat 服务器覆盖 step1/step2/merge 全成功路径——现有集成测试只测失败路径，
//! 这是本仓库首次在集成层跑通 LLM 成功链（SSE 格式对齐 llm_stream openai 解析：
//! choices[].delta.content + 末尾空 choices 的 usage chunk）。
//! 本文件 Task 5 只放基建（stub 服务器 + t8_ fixture helper）；用例由 Task 6 补，
//! 故暂允许未消费项（届时如仍有残留再收窄 allow 范围）。
#![allow(dead_code)]

use axum::{extract::State, response::IntoResponse, routing::post, Router};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

pub(crate) enum StubResp {
    Text(String),
    Error(u16),
}

/// 进程内 stub：POST {base}/chat/completions 按序弹出脚本化响应；耗尽 → 500。
/// 路由路径已对照 llm_stream openai provider 的实际拼接核实（llm_stream.rs
/// provider_for_project）：base_url 非空时 endpoint =
/// `base.trim_end_matches('/') + "/chat/completions"`——不自动补 /v1，故把
/// llm_providers.base_url 配成 stub 根（http://127.0.0.1:{port}）即命中本路由。
/// SSE 三帧与 parse_openai_sse_line 逐行对齐：text delta → usage（空 choices）→
/// [DONE]（缺 [DONE] 会被消费方以 StreamEnded 收尾，务必带上）。
pub(crate) async fn spawn_stub_chat_server(
    script: Vec<StubResp>,
) -> (String, tokio::task::JoinHandle<()>) {
    let script = Arc::new(Mutex::new(script));
    let app = Router::new()
        .route(
            "/chat/completions",
            post(|State(script): State<Arc<Mutex<Vec<StubResp>>>>| async move {
                let next = {
                    let mut s = script.lock().unwrap();
                    if s.is_empty() { None } else { Some(s.remove(0)) }
                };
                // 三臂响应类型不同（(StatusCode,&str) vs ([(..);1],String)），
                // 统一经 IntoResponse 收敛为 axum::response::Response。
                match next {
                    Some(StubResp::Error(code)) => (
                        axum::http::StatusCode::from_u16(code).unwrap(),
                        "stub error",
                    )
                        .into_response(),
                    Some(StubResp::Text(t)) => {
                        let content_json = serde_json::to_string(&t).unwrap();
                        let sse = format!(
                            "data: {{\"choices\":[{{\"delta\":{{\"content\":{}}}}}]}}\n\n\
                             data: {{\"choices\":[],\"usage\":{{\"prompt_tokens\":10,\"completion_tokens\":100}}}}\n\n\
                             data: [DONE]\n\n",
                            content_json
                        );
                        (
                            [(axum::http::header::CONTENT_TYPE, "text/event-stream")],
                            sse,
                        )
                            .into_response()
                    }
                    None => (
                        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                        "stub exhausted",
                    )
                        .into_response(),
                }
            }),
        )
        .with_state(script);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let handle = tokio::spawn(async move { axum::serve(listener, app).await.unwrap(); });
    (format!("http://{}", addr), handle)
}

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// t8_ fixture（评审 C-1）：命名必须与 mod.rs SWEEPS 扩入的 t8 模式逐字匹配——
/// 项目名 `LT项目_t8_{uuid}`（projects sweep：name LIKE 'LT项目_t8\_%'）、
/// username `t8_merge_{uuid}`（users sweep 锚定 username LIKE 't8\_%'）、
/// email `t8_merge_{uuid}@t8.com`（users sweep 非锚定 email LIKE '%t8\_%'）。
/// 序列模板 reviews_test.rs::setup_project（注册 / POST /teams / POST /projects），
/// 但命名不可照抄其固定 `test-proj`（不匹配 SWEEPS 模式，每轮净漏清扫）。
/// 入参 state：以其 config 克隆起临时 setup app（同库同 Redis）跑 HTTP 序列，
/// registration_enabled 强制 true（与 setup_test_app 同款防御——default.json 已翻
/// false，裸 from_env config 下注册会 403）。仅返回 project_id；token/team_id
/// 如 Task 6 用例需要再扩展返回元组（brief 定型 i32，暂不预支）。
async fn t8_setup_project(state: &llm_wiki_server::AppState) -> i32 {
    let mut cfg = (*state.config).clone();
    cfg.auth.registration_enabled = true;
    let (app, _setup_state) = llm_wiki_server::create_app(cfg).await.expect("t8 fixture app");
    let server = axum_test::TestServer::new(app).unwrap();

    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let uuid = format!("{}_{}", std::process::id(), n);
    let username = format!("t8_merge_{uuid}");
    let token =
        crate::register_user(&server, &username, &format!("{}@t8.com", username), "password123")
            .await;

    let team = server
        .post("/api/v1/teams")
        .add_header("authorization", format!("Bearer {}", token))
        .json(&serde_json::json!({"name": format!("LT测试team_t8_{uuid}")}))
        .await;
    assert_eq!(team.status_code(), axum::http::StatusCode::CREATED);
    let team_id = team.json::<serde_json::Value>()["id"].as_i64().unwrap();

    let proj = server
        .post("/api/v1/projects")
        .add_header("authorization", format!("Bearer {}", token))
        .json(&serde_json::json!({"name": format!("LT项目_t8_{uuid}"), "team_id": team_id}))
        .await;
    assert_eq!(proj.status_code(), axum::http::StatusCode::CREATED);
    proj.json::<serde_json::Value>()["id"].as_i64().unwrap() as i32
}
