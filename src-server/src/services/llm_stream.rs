// src-server/src/services/llm_stream.rs
// LLM 流式客户端：StreamChatProvider trait + OpenAI/Anthropic SSE 实现 + provider 工厂。

use async_trait::async_trait;
use futures::stream::{BoxStream, StreamExt};
use serde::Serialize;

// ── 共用类型 ──

#[derive(Debug, Clone, Serialize)]
pub struct ChatMessage {
    pub role: String, // "system" | "user" | "assistant"
    pub content: String,
}

#[derive(Debug, Clone)]
pub struct ChatOpts {
    pub model: String,
    pub temperature: f64,
    pub max_tokens: u32,
    pub system_prompt: Option<String>,
    /// 每请求超时秒数。None = 使用 reqwest Client 默认或 config 默认（120s）。
    pub timeout_secs: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub enum TokenDelta {
    /// 逐 token 文本增量
    Text(String),
    /// 流最后一帧的用量统计
    Usage {
        prompt_tokens: u32,
        completion_tokens: u32,
    },
    /// 流正常结束
    Done,
}

#[derive(Debug, thiserror::Error)]
pub enum LlmError {
    #[error("Provider '{0}' not found or not supported")]
    ProviderNotFound(String),
    #[error("Rate limited")]
    RateLimited,
    #[error("Authentication failed")]
    AuthFailed,
    #[error("Connection failed: {0}")]
    ConnectionFailed(String),
    #[error("Request timed out after {0}s")]
    Timeout(u64),
    #[error("API error {status}: {body}")]
    ApiError { status: u16, body: String },
    #[error("Invalid SSE format: {0}")]
    InvalidSse(String),
    #[error("Stream ended unexpectedly")]
    StreamEnded,
}

// ── Trait ──

/// 异步流式 LLM provider。
/// 实现者负责将 messages 转换为 provider 专用 JSON body、发起 SSE 请求、返回 TokenDelta 流。
#[async_trait]
pub trait StreamChatProvider: Send + Sync {
    /// 发起流式对话。返回 BoxStream 而非 impl Stream —— 不同 impl 返回不同类型
    /// （OpenAI 标准 SSE / Anthropic 状态机），trait object 安全要求 box 化。
    async fn stream_chat(
        &self,
        messages: Vec<ChatMessage>,
        opts: ChatOpts,
    ) -> Result<BoxStream<'static, Result<TokenDelta, LlmError>>, LlmError>;

    /// 便捷方法：收集所有 Text token 并返回完整文本 + 最终 usage。
    async fn chat_to_string(
        &self,
        messages: Vec<ChatMessage>,
        opts: ChatOpts,
    ) -> Result<(String, Option<(u32, u32)>), LlmError> {
        let mut stream = self.stream_chat(messages, opts).await?;
        let mut text = String::new();
        let mut usage = None;
        while let Some(delta) = stream.next().await {
            match delta? {
                TokenDelta::Text(t) => text.push_str(&t),
                TokenDelta::Usage {
                    prompt_tokens,
                    completion_tokens,
                } => {
                    usage = Some((prompt_tokens, completion_tokens));
                }
                TokenDelta::Done => break,
            }
        }
        Ok((text, usage))
    }

    /// 返回此 provider 的类型标签("openai"|"anthropic")，供日志/调试。
    fn provider_type(&self) -> &'static str;

    /// 返回 model 名称。
    fn model_name(&self) -> &str;
}

// ── OpenAI 实现 ──

pub struct OpenAiProvider {
    client: reqwest::Client,
    endpoint: String,
    api_key: String,
    model: String,
}

impl OpenAiProvider {
    pub fn new(endpoint: String, api_key: String, model: String, timeout_secs: Option<u64>) -> Self {
        let mut b = reqwest::Client::builder();
        if let Some(t) = timeout_secs {
            b = b.timeout(std::time::Duration::from_secs(t));
        }
        Self { client: b.build().expect("reqwest Client"), endpoint, api_key, model }
    }
}

/// OpenAI SSE 行解析器（纯函数，pub(crate) 以测）。
pub(crate) fn parse_openai_sse_line(line: &str) -> Option<Result<TokenDelta, LlmError>> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    let data = line.strip_prefix("data: ")?;
    if data == "[DONE]" {
        return Some(Ok(TokenDelta::Done));
    }
    // 显式 match：该函数返回 Option<Result<..>>，? 无法直接作用于 Result 残差。
    let v: serde_json::Value = match serde_json::from_str(data) {
        Ok(v) => v,
        Err(e) => return Some(Err(LlmError::InvalidSse(format!("JSON parse: {}", e)))),
    };

    let choice = &v["choices"][0];

    // text delta
    if let Some(t) = choice["delta"]["content"].as_str() {
        if !t.is_empty() {
            return Some(Ok(TokenDelta::Text(t.to_string())));
        }
    }

    // usage（末尾 chunk，choices 为空数组时 usage 字段有值）
    if let Some(_u) = v["usage"].as_object() {
        return Some(Ok(TokenDelta::Usage {
            prompt_tokens: v["usage"]["prompt_tokens"].as_u64().unwrap_or(0) as u32,
            completion_tokens: v["usage"]["completion_tokens"].as_u64().unwrap_or(0) as u32,
        }));
    }

    None
}

#[async_trait]
impl StreamChatProvider for OpenAiProvider {
    async fn stream_chat(
        &self,
        messages: Vec<ChatMessage>,
        opts: ChatOpts,
    ) -> Result<BoxStream<'static, Result<TokenDelta, LlmError>>, LlmError> {
        let mut msgs: Vec<serde_json::Value> = Vec::new();
        if let Some(sp) = &opts.system_prompt {
            msgs.push(serde_json::json!({"role":"system","content":sp}));
        }
        for m in &messages {
            msgs.push(serde_json::json!({"role":m.role,"content":m.content}));
        }

        let body = serde_json::json!({
            "model": opts.model,
            "messages": msgs,
            "temperature": opts.temperature,
            "max_tokens": opts.max_tokens,
            "stream": true,
            "stream_options": {"include_usage": true}
        });

        let resp = self.client
            .post(&self.endpoint)
            .header("Authorization", format!("Bearer {}", self.api_key))
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| {
                if e.is_timeout() {
                    LlmError::Timeout(opts.timeout_secs.unwrap_or(0))
                } else {
                    LlmError::ConnectionFailed(e.to_string())
                }
            })?;

        let status = resp.status();
        if status == reqwest::StatusCode::UNAUTHORIZED {
            return Err(LlmError::AuthFailed);
        }
        if status.as_u16() == 429 {
            return Err(LlmError::RateLimited);
        }
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(LlmError::ApiError { status: status.as_u16(), body });
        }

        let byte_stream = resp.bytes_stream();

        let stream = async_stream::stream! {
            let mut line_buf: Vec<u8> = Vec::new();
            let mut pinned = Box::pin(byte_stream);
            while let Some(chunk_result) = pinned.next().await {
                let chunk = match chunk_result {
                    Ok(b) => b,
                    Err(e) => { yield Err(LlmError::ConnectionFailed(e.to_string())); return; }
                };
                line_buf.extend_from_slice(&chunk);
                while let Some(pos) = line_buf.iter().position(|&b| b == b'\n') {
                    let line_bytes: Vec<u8> = line_buf.drain(..=pos).collect();
                    let line = std::str::from_utf8(&line_bytes).unwrap_or("");
                    if let Some(parsed) = parse_openai_sse_line(line) {
                        yield parsed;
                    }
                }
            }
            if !line_buf.is_empty() {
                let line = std::str::from_utf8(&line_buf).unwrap_or("");
                if let Some(parsed) = parse_openai_sse_line(line) {
                    yield parsed;
                }
            }
        };

        Ok(Box::pin(stream))
    }

    fn provider_type(&self) -> &'static str { "openai" }
    fn model_name(&self) -> &str { &self.model }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_openai_sse_text_delta() {
        let line = r#"data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":0,"model":"gpt-4o","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}"#;
        let result = parse_openai_sse_line(line).unwrap().unwrap();
        match result {
            TokenDelta::Text(t) => assert_eq!(t, "Hello"),
            other => panic!("expected Text, got {:?}", other),
        }
    }

    #[test]
    fn test_parse_openai_sse_done() {
        let line = "data: [DONE]";
        let result = parse_openai_sse_line(line).unwrap().unwrap();
        assert!(matches!(result, TokenDelta::Done));
    }

    #[test]
    fn test_parse_openai_sse_usage() {
        let line = r#"data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":0,"model":"gpt-4o","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}"#;
        let result = parse_openai_sse_line(line).unwrap().unwrap();
        match result {
            TokenDelta::Usage { prompt_tokens, completion_tokens } => {
                assert_eq!(prompt_tokens, 10);
                assert_eq!(completion_tokens, 5);
            }
            other => panic!("expected Usage, got {:?}", other),
        }
    }

    #[test]
    fn test_parse_openai_sse_empty_line() {
        assert!(parse_openai_sse_line("").is_none());
        assert!(parse_openai_sse_line("  ").is_none());
    }

    #[test]
    fn test_parse_openai_sse_no_data_prefix() {
        assert!(parse_openai_sse_line("event: message").is_none());
    }

    #[test]
    fn test_parse_openai_sse_invalid_json() {
        let line = "data: {not valid json}";
        let result = parse_openai_sse_line(line).unwrap();
        assert!(result.is_err());
        match result.unwrap_err() {
            LlmError::InvalidSse(_) => {},
            e => panic!("expected InvalidSse, got {:?}", e),
        }
    }
}
