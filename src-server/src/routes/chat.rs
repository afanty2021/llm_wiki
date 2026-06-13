use axum::{
    extract::State,
    response::sse::{Event, Sse},
    response::IntoResponse,
    Json,
};
use futures::stream::{self, Stream, StreamExt};
use serde::Deserialize;
use std::convert::Infallible;
use std::pin::Pin;
use std::time::Duration;
use crate::{AppState, AppError};
use crate::middleware::project_guard::check_project_access;

/// Type alias for a boxed stream of SSE events (type-erased).
type SseStream = Pin<Box<dyn Stream<Item = Result<Event, Infallible>> + Send>>;

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

/// POST /api/v1/chat/stream — server-sent events streaming chat
pub async fn chat_stream(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> Result<Sse<SseStream>, AppError> {
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

    Ok(stream_chat_to_sse(&state, project_id, &messages, model_override).await)
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

/// Build an SSE stream that proxies LLM streaming responses.
/// Uses `Pin<Box<dyn Stream>>` to type-erase the different branch return types.
async fn stream_chat_to_sse(
    state: &AppState,
    project_id: i32,
    messages: &[ChatMessage],
    model_override: Option<String>,
) -> Sse<SseStream> {
    // Fetch LLM config from database
    let llm_config = match crate::services::llm::get_llm_config(&state.db, project_id).await {
        Ok(cfg) => cfg,
        Err(e) => {
            let s: SseStream = Box::pin(stream::once(async move {
                Ok(Event::default().data(format!("Error: {}", e)))
            }));
            return Sse::new(s);
        }
    };

    // Decrypt API key
    let api_key = match crate::services::llm::decrypt_api_key(&llm_config.api_key, &state.config)
    {
        Ok(k) => k,
        Err(e) => {
            let s: SseStream = Box::pin(stream::once(async move {
                Ok(Event::default().data(format!("Decrypt error: {}", e)))
            }));
            return Sse::new(s);
        }
    };

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
    let response = match client
        .post(format!("{}/chat/completions", base_url))
        .header("Authorization", format!("Bearer {}", api_key))
        .json(&serde_json::json!({
            "model": model,
            "messages": openai_messages,
            "stream": true,
        }))
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            let s: SseStream = Box::pin(stream::once(async move {
                Ok(Event::default().data(format!("LLM request error: {}", e)))
            }));
            return Sse::new(s);
        }
    };

    let byte_stream = response.bytes_stream().map(|result| match result {
        Ok(bytes) => Ok(Event::default().data(String::from_utf8_lossy(&bytes).to_string())),
        Err(e) => Ok(Event::default().data(format!("Stream error: {}", e))),
    });

    Sse::new(Box::pin(byte_stream) as SseStream).keep_alive(
        axum::response::sse::KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("ping"),
    )
}
