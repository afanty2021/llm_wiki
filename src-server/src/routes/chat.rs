use axum::{
    extract::State,
    response::IntoResponse,
    Json,
};
use serde::Deserialize;
use crate::{AppState, AppError};
use crate::middleware::project_guard::check_project_access;

#[derive(Deserialize)]
struct ChatMessage {
    role: String,
    content: String,
}

pub fn chat_routes() -> axum::Router<AppState> {
    axum::Router::new()
        .route("/stream", axum::routing::post(chat_stream))
        .route("/message", axum::routing::post(chat_message))
}

/// POST /api/v1/chat/stream — 直通上游 LLM 原始 SSE 字节流。
///
/// 返回 `text/event-stream`，客户端收到标准单层 OpenAI SSE，
/// 可复用桌面版 parseLines/parseStream 解析逻辑。
pub async fn chat_stream(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> Result<axum::response::Response, AppError> {
    let project_id = body
        .get("project_id")
        .and_then(|v| v.as_i64())
        .unwrap_or(0) as i32;
    let _user_id = check_project_access(&state, &headers, project_id).await?.0;

    let messages: Vec<ChatMessage> = body
        .get("messages")
        .and_then(|m| serde_json::from_value(m.clone()).ok())
        .unwrap_or_default();

    let model_override = body
        .get("model")
        .and_then(|m| m.as_str().map(String::from));

    stream_chat_raw(&state, project_id, &messages, model_override).await
}

/// POST /api/v1/chat/message — non-streaming single message
pub async fn chat_message(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> Result<impl IntoResponse, AppError> {
    let messages: Vec<ChatMessage> = body
        .get("messages")
        .and_then(|m| serde_json::from_value(m.clone()).ok())
        .unwrap_or_default();

    let project_id = body
        .get("project_id")
        .and_then(|v| v.as_i64())
        .unwrap_or(0) as i32;

    let _user_id = check_project_access(&state, &headers, project_id).await?.0;

    let model = body
        .get("model")
        .and_then(|m| m.as_str())
        .unwrap_or("gpt-4o");

    let llm = crate::services::llm::get_llm_config(&state.db, project_id).await?;
    let api_key = crate::services::llm::decrypt_api_key(&llm.api_key, &state.config)?;
    let base_url = llm
        .base_url
        .as_deref()
        .unwrap_or("https://api.openai.com/v1");

    let client = reqwest::Client::new();
    let response = client
        .post(format!("{}/chat/completions", base_url))
        .header("Authorization", format!("Bearer {}", api_key))
        .json(&serde_json::json!({
            "model": model,
            "messages": messages.iter().map(|m| {
                serde_json::json!({"role": m.role, "content": m.content})
            }).collect::<Vec<_>>(),
            "stream": false,
        }))
        .send()
        .await?;

    let body: serde_json::Value = response.json().await?;

    Ok(Json(serde_json::json!({
        "content": body["choices"][0]["message"]["content"],
        "model": model,
    })))
}

/// 直通：把 reqwest bytes_stream 作为响应 body，Content-Type text/event-stream。
///
/// 客户端收到标准单层 OpenAI SSE，可复用桌面版 parseLines/parseStream。
/// 不再用 axum `Event::data`（它按 \n 拆行加 `data: ` 前缀，造成双层 `data: data:`）。
///
/// 错误用 `?` 传播（不再包成 SSE event 返回 200），使鉴权/配置错误能正确映射为 4xx/5xx。
async fn stream_chat_raw(
    state: &AppState,
    project_id: i32,
    messages: &[ChatMessage],
    model_override: Option<String>,
) -> Result<axum::response::Response, AppError> {
    // 取 LLM 配置（无 provider 时报错 → 4xx BadRequest）
    let llm_config = crate::services::llm::get_llm_config(&state.db, project_id).await?;
    let api_key = crate::services::llm::decrypt_api_key(&llm_config.api_key, &state.config)?;
    let base_url = llm_config
        .base_url
        .as_deref()
        .unwrap_or("https://api.openai.com/v1");
    let model = model_override.unwrap_or(llm_config.model);

    let system_prompt = "You are a helpful knowledge assistant.";
    let openai_messages: Vec<serde_json::Value> = std::iter::once(
        serde_json::json!({"role": "system", "content": system_prompt}),
    )
    .chain(
        messages
            .iter()
            .map(|m| serde_json::json!({"role": m.role, "content": m.content})),
    )
    .collect();

    let client = reqwest::Client::new();
    let upstream = client
        .post(format!("{}/chat/completions", base_url))
        .header("Authorization", format!("Bearer {}", api_key))
        .json(&serde_json::json!({
            "model": model,
            "messages": openai_messages,
            "stream": true,
        }))
        .send()
        .await?;

    if !upstream.status().is_success() {
        let status = upstream.status();
        let text = upstream.text().await.unwrap_or_default();
        return Err(AppError::LlmApiError(format!(
            "LLM upstream {}: {}",
            status, text
        )));
    }

    // 直通原始字节流；axum Body::from_stream 把 reqwest Stream 转为响应 body。
    // 不再注入 keep-alive 心跳（部署层调大 proxy_read_timeout + proxy_buffering off 缓解）。
    let stream = upstream.bytes_stream();
    Ok((
        [(axum::http::header::CONTENT_TYPE, "text/event-stream")],
        axum::body::Body::from_stream(stream),
    )
        .into_response())
}
