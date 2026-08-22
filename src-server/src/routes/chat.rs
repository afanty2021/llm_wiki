use axum::{
    extract::State,
    response::IntoResponse,
    Json,
};
use serde::Deserialize;
use crate::{AppState, AppError};
use crate::middleware::project_guard::check_project_access;

#[derive(Debug, Deserialize)]
struct ChatMessage {
    role: String,
    content: String,
}

/// messages JSON → Vec<ChatMessage>（#4 fail-loud）。
///
/// 原 `from_value(..).ok().unwrap_or_default()` 对任一畸形条目静默清空整个
/// 向量：消息被丢、服务端仍拼 system prompt 发上游并 200 流回，模型看不到
/// 问题与历史，调用方无感知（web 直发链路答非所问的根因半边）。现改为：
/// - content 支持字符串与 OpenAI ContentBlock 数组（拼接 text 块，非 text
///   块如 image_url 忽略——前端 web 门控已拦图片，这里按降级语义收 text）
/// - 任一条目畸形（messages 非数组 / role/content 缺失或形态不对）→
///   `Err(BadRequest)`，消息体带索引与原因
fn parse_chat_messages(raw: Option<&serde_json::Value>) -> Result<Vec<ChatMessage>, AppError> {
    let Some(raw) = raw else {
        return Err(AppError::BadRequest("messages is required".into()));
    };
    let arr = raw
        .as_array()
        .ok_or_else(|| AppError::BadRequest("messages must be an array".into()))?;
    let mut out = Vec::with_capacity(arr.len());
    for (i, item) in arr.iter().enumerate() {
        let role = item
            .get("role")
            .and_then(|v| v.as_str())
            .ok_or_else(|| AppError::BadRequest(format!("messages[{i}].role must be a string")))?;
        let content = item
            .get("content")
            .ok_or_else(|| AppError::BadRequest(format!("messages[{i}].content is required")))?;
        let content = content_to_text(content)
            .map_err(|e| AppError::BadRequest(format!("messages[{i}].content: {e}")))?;
        out.push(ChatMessage { role: role.to_string(), content });
    }
    Ok(out)
}

/// 单条 content → 纯文本。String 原样；数组按 ContentBlock 拼接 text 块
/// （多块以 \n 连接，非 text 块忽略）；其余形态（数字/对象/null）Err。
fn content_to_text(v: &serde_json::Value) -> Result<String, String> {
    match v {
        serde_json::Value::String(s) => Ok(s.clone()),
        serde_json::Value::Array(blocks) => {
            let mut text = String::new();
            for b in blocks {
                if b.get("type").and_then(|t| t.as_str()) == Some("text") {
                    if let Some(t) = b.get("text").and_then(|t| t.as_str()) {
                        if !text.is_empty() {
                            text.push('\n');
                        }
                        text.push_str(t);
                    }
                }
            }
            Ok(text)
        }
        _ => Err("must be a string or an array of content blocks".into()),
    }
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
        .unwrap_or(0);
    // 显式 try_from（遗留债）：JSON i64 越界时 400 而非静默截断
    let project_id = i32::try_from(project_id)
        .map_err(|_| AppError::BadRequest("project_id out of range".into()))?;
    let _user_id = check_project_access(&state, &headers, project_id).await?.0;

    // #4：畸形 messages 显式 400（带索引与原因），不再 unwrap_or_default 静默清空
    let messages = parse_chat_messages(body.get("messages"))?;

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
    // #4：畸形 messages 显式 400（带索引与原因），不再 unwrap_or_default 静默清空
    let messages = parse_chat_messages(body.get("messages"))?;

    let project_id = body
        .get("project_id")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    // 显式 try_from（遗留债）：JSON i64 越界时 400 而非静默截断
    let project_id = i32::try_from(project_id)
        .map_err(|_| AppError::BadRequest("project_id out of range".into()))?;

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

#[cfg(test)]
mod tests {
    use super::*;

    /// #4：字符串 content 原样直收（既有正常路径零变化）。
    #[test]
    fn parse_chat_messages_plain_strings() {
        let raw = serde_json::json!([
            {"role": "user", "content": "你好"},
            {"role": "assistant", "content": "在"},
        ]);
        let out = parse_chat_messages(Some(&raw)).unwrap();
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].role, "user");
        assert_eq!(out[0].content, "你好");
        assert_eq!(out[1].content, "在");
    }

    /// ContentBlock 数组：拼接 text 块（\n 连接），非 text 块（image_url）忽略——
    /// 多模态消息降级为纯文本而非静默丢弃整条。
    #[test]
    fn parse_chat_messages_content_blocks_text_only() {
        let raw = serde_json::json!([
            {"role": "user", "content": [
                {"type": "text", "text": "这是什么？"},
                {"type": "image_url", "image_url": {"url": "https://x/y.png"}},
                {"type": "text", "text": "请看图回答"},
            ]},
        ]);
        let out = parse_chat_messages(Some(&raw)).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].content, "这是什么？\n请看图回答");
    }

    /// 全非 text 块的数组 → 空字符串 content（消息保留，role 语义不丢）。
    #[test]
    fn parse_chat_messages_blocks_without_text_yields_empty() {
        let raw = serde_json::json!([
            {"role": "user", "content": [{"type": "image_url", "image_url": {"url": "x"}}]},
        ]);
        let out = parse_chat_messages(Some(&raw)).unwrap();
        assert_eq!(out[0].content, "");
    }

    /// 畸形形态显式 400（fail-loud）：数字 content / role 缺失 / messages 非数组 /
    /// messages 缺失——错误信息带索引与原因，替换 unwrap_or_default 静默清空。
    #[test]
    fn parse_chat_messages_malformed_rejects_with_index() {
        let num = serde_json::json!([{"role": "user", "content": 42}]);
        let err = parse_chat_messages(Some(&num)).unwrap_err();
        let msg = format!("{err}");
        assert!(msg.contains("messages[0].content"), "got: {msg}");
        assert!(msg.contains("string or an array"), "got: {msg}");

        let no_role = serde_json::json!([{"content": "x"}]);
        let err = parse_chat_messages(Some(&no_role)).unwrap_err();
        assert!(format!("{err}").contains("messages[0].role"));

        let not_array = serde_json::json!({"role": "user"});
        assert!(parse_chat_messages(Some(&not_array)).is_err());

        assert!(parse_chat_messages(None).is_err(), "messages 缺失即 400");
        // 索引跟随条目位置（第二条畸形报 [1]）
        let second = serde_json::json!([
            {"role": "user", "content": "ok"},
            {"role": "user", "content": {"deep": "obj"}},
        ]);
        let err = parse_chat_messages(Some(&second)).unwrap_err();
        assert!(format!("{err}").contains("messages[1].content"));
    }

    /// 空数组 → Ok(vec![])（合法：仅 system prompt 的空对话）。
    #[test]
    fn parse_chat_messages_empty_array_ok() {
        let out = parse_chat_messages(Some(&serde_json::json!([]))).unwrap();
        assert!(out.is_empty());
    }
}
