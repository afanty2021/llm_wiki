// src-server/src/services/llm_stream.rs
// LLM 流式客户端：StreamChatProvider trait + OpenAI/Anthropic SSE 实现 + provider 工厂。

use crate::{AppError, AppState};
use async_trait::async_trait;
use futures::stream::{BoxStream, StreamExt};
use serde::Serialize;
use std::collections::VecDeque;

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

// ── Anthropic 实现 ──

pub struct AnthropicProvider {
    client: reqwest::Client,
    endpoint: String,
    api_key: String,
    model: String,
    api_version: String,
}

impl AnthropicProvider {
    pub fn new(endpoint: String, api_key: String, model: String, timeout_secs: Option<u64>) -> Self {
        let mut b = reqwest::Client::builder();
        if let Some(t) = timeout_secs {
            b = b.timeout(std::time::Duration::from_secs(t));
        }
        Self {
            client: b.build().expect("reqwest Client"),
            endpoint, api_key, model,
            api_version: "2023-06-01".to_string(),
        }
    }
}

/// MVP 简化版状态：单 content_block (index=0)，不追踪 index/HashMap。
/// 后续加工具调用时加回 Option<u32> cur_index。
#[derive(Default)]
pub(crate) struct AnthropicStreamState {
    pub(crate) events: VecDeque<TokenDelta>,
    input_tokens: Option<u32>,
    output_tokens: Option<u32>,
    done: bool,
}

impl AnthropicProvider {
    /// 解析一对 (event:, data:) 并推进状态机。emit 的 delta 写入 state.events。
    pub(crate) fn parse_sse_event(
        event_type: &str,
        data: &str,
        state: &mut AnthropicStreamState,
    ) -> Result<(), LlmError> {
        let v: serde_json::Value = serde_json::from_str(data)
            .map_err(|e| LlmError::InvalidSse(format!("JSON parse: {}", e)))?;

        match event_type {
            "message_start" => {
                if let Some(i) = v["message"]["usage"]["input_tokens"].as_u64() {
                    state.input_tokens = Some(i as u32);
                }
            }
            "content_block_delta" => {
                let delta_type = v["delta"]["type"].as_str().unwrap_or("");
                if delta_type == "text_delta" {
                    if let Some(t) = v["delta"]["text"].as_str() {
                        if !t.is_empty() {
                            state.events.push_back(TokenDelta::Text(t.to_string()));
                        }
                    }
                }
                // 其他 delta_type (input_json_delta 等)忽略
            }
            "message_delta" => {
                if let Some(o) = v["usage"]["output_tokens"].as_u64() {
                    state.output_tokens = Some(o as u32);
                }
            }
            "message_stop" => {
                let prompt = state.input_tokens.unwrap_or(0);
                let completion = state.output_tokens.unwrap_or(0);
                state.events.push_back(TokenDelta::Usage {
                    prompt_tokens: prompt,
                    completion_tokens: completion,
                });
                state.events.push_back(TokenDelta::Done);
                state.done = true;
            }
            _ => {} // content_block_start/stop/ping — 不 emit
        }
        Ok(())
    }
}

#[async_trait]
impl StreamChatProvider for AnthropicProvider {
    async fn stream_chat(
        &self,
        messages: Vec<ChatMessage>,
        opts: ChatOpts,
    ) -> Result<BoxStream<'static, Result<TokenDelta, LlmError>>, LlmError> {
        // 系统 prompt 放顶层 system 字段（Anthropic 非 role:system message）
        let msgs: Vec<serde_json::Value> = messages
            .iter()
            .map(|m| serde_json::json!({"role":m.role,"content":m.content}))
            .collect();

        let mut body = serde_json::json!({
            "model": opts.model,
            "messages": msgs,
            "max_tokens": opts.max_tokens,
            "temperature": opts.temperature,
            "stream": true,
        });
        if let Some(sp) = &opts.system_prompt {
            body["system"] = serde_json::json!(sp);
        }

        let resp = self.client
            .post(&self.endpoint)
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", &self.api_version)
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

        // 行缓冲 + event:data: 配对解析
        let stream = async_stream::stream! {
            let mut line_buf: Vec<u8> = Vec::new();
            let mut current_event: Option<String> = None;
            let mut pinned = Box::pin(byte_stream);
            let mut state = AnthropicStreamState::default();

            while let Some(chunk_result) = pinned.next().await {
                let chunk = match chunk_result {
                    Ok(b) => b,
                    Err(e) => { yield Err(LlmError::ConnectionFailed(e.to_string())); return; }
                };
                line_buf.extend_from_slice(&chunk);
                while let Some(pos) = line_buf.iter().position(|&b| b == b'\n') {
                    let line_bytes: Vec<u8> = line_buf.drain(..=pos).collect();
                    let line = std::str::from_utf8(&line_bytes).unwrap_or("").trim().to_string();
                    if line.is_empty() { continue; }

                    if let Some(data) = line.strip_prefix("data: ") {
                        if let Some(ev) = &current_event {
                            if let Err(e) = Self::parse_sse_event(ev, data, &mut state) {
                                yield Err(e);
                                return;
                            }
                            while let Some(delta) = state.events.pop_front() {
                                yield Ok(delta);
                            }
                            current_event = None;
                        }
                        // data: 无前置 event: → 忽略
                    } else if let Some(ev) = line.strip_prefix("event: ") {
                        current_event = Some(ev.trim().to_string());
                    }
                }
            }

            // 处理尾部残留行（无 \n 结尾的最后一帧）—— 对齐 OpenAiProvider
            if !line_buf.is_empty() {
                let line = std::str::from_utf8(&line_buf).unwrap_or("").trim().to_string();
                if !line.is_empty() {
                    if let Some(data) = line.strip_prefix("data: ") {
                        if let Some(ev) = &current_event {
                            if let Err(e) = Self::parse_sse_event(ev, data, &mut state) {
                                yield Err(e);
                                return;
                            }
                            while let Some(delta) = state.events.pop_front() {
                                yield Ok(delta);
                            }
                        }
                    }
                }
            }

            // 流结束时若仍未 done，以 StreamEnded 收尾
            if !state.done {
                yield Err(LlmError::StreamEnded);
            }
        };

        Ok(Box::pin(stream))
    }

    fn provider_type(&self) -> &'static str { "anthropic" }
    fn model_name(&self) -> &str { &self.model }
}

// ── Provider 工厂 ──

/// 从 llm_providers 表为指定 project 构造 StreamChatProvider。
/// 复用 services/llm.rs 的 get_llm_config（含 provider_type/base_url/加密 key）→ 解密 key → 构造 impl。
pub async fn provider_for_project(
    state: &AppState,
    project_id: i32,
) -> Result<Box<dyn StreamChatProvider>, AppError> {
    // 复用 llm.rs 取配置——不重复查表
    let config = crate::services::llm::get_llm_config(&state.db, project_id).await?;

    // 解密 key（&state.config 经 deref coercion 转为 &AppConfig）
    let api_key = crate::services::llm::decrypt_api_key(&config.api_key, &state.config)?;

    let timeout = config.timeout_secs;            // 来自 get_llm_config，当前恒 None（DB 无列）
    let base = config.base_url.as_deref().unwrap_or("");

    match config.provider_type.as_str() {
        "openai" => {
            let endpoint = if base.is_empty() {
                "https://api.openai.com/v1/chat/completions".to_string()
            } else {
                format!("{}/chat/completions", base.trim_end_matches('/'))
            };
            Ok(Box::new(OpenAiProvider::new(
                endpoint, api_key, config.model, timeout,
            )))
        }
        "anthropic" => {
            let endpoint = if base.is_empty() {
                "https://api.anthropic.com/v1/messages".to_string()
            } else {
                format!("{}/messages", base.trim_end_matches('/'))
            };
            Ok(Box::new(AnthropicProvider::new(
                endpoint, api_key, config.model, timeout,
            )))
        }
        other => Err(AppError::ValidationError(
            format!("Unsupported provider type: {:?}", other)
        )),
    }
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

    // ── Anthropic 状态机测试 ──

    /// 模拟 Anthropic SSE 事件序列（逐对 (event:, data:)）
    struct MockAnthropicEvents {
        events: Vec<(&'static str, &'static str)>,
    }
    impl MockAnthropicEvents {
        fn apply(&self) -> Vec<TokenDelta> {
            let mut state = AnthropicStreamState::default();
            let mut out = Vec::new();
            for (ev_type, data) in &self.events {
                AnthropicProvider::parse_sse_event(ev_type, data, &mut state).unwrap();
                while let Some(delta) = state.events.pop_front() {
                    out.push(delta);
                }
            }
            out
        }
    }

    #[test]
    fn test_anthropic_simple_text_flow() {
        let mock = MockAnthropicEvents {
            events: vec![
                ("message_start", r#"{"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":10}}}"#),
                ("content_block_delta", r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}"#),
                ("content_block_delta", r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}"#),
                ("message_delta", r#"{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}"#),
                ("message_stop", r#"{"type":"message_stop"}"#),
            ],
        };
        let deltas = mock.apply();
        assert_eq!(deltas.len(), 4);
        assert!(matches!(&deltas[0], TokenDelta::Text(t) if t == "Hello"));
        assert!(matches!(&deltas[1], TokenDelta::Text(t) if t == " world"));
        assert!(matches!(&deltas[2], TokenDelta::Usage { prompt_tokens: 10, completion_tokens: 3 }));
        assert!(matches!(&deltas[3], TokenDelta::Done));
    }

    #[test]
    fn test_anthropic_ping_ignored() {
        let mock = MockAnthropicEvents {
            events: vec![
                ("ping", r#"{"type":"ping"}"#),
                ("message_start", r#"{"type":"message_start","message":{"id":"msg","usage":{"input_tokens":1}}}"#),
                ("content_block_delta", r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}"#),
                ("message_delta", r#"{"type":"message_delta","delta":{},"usage":{"output_tokens":1}}"#),
                ("message_stop", r#"{"type":"message_stop"}"#),
            ],
        };
        let deltas = mock.apply();
        // ping 不产出 delta → 只有 3 个（Text, Usage, Done）
        assert_eq!(deltas.len(), 3);
    }

    #[test]
    fn test_anthropic_missing_usage_is_zero() {
        let mock = MockAnthropicEvents {
            events: vec![
                ("message_start", r#"{"type":"message_start","message":{"id":"msg"}}"#),
                ("message_delta", r#"{"type":"message_delta","delta":{}}"#),
                ("message_stop", r#"{"type":"message_stop"}"#),
            ],
        };
        let deltas = mock.apply();
        // 无 usage 字段时应为 (0,0) 然后 Done
        assert_eq!(deltas.len(), 2);
        assert!(matches!(deltas[0], TokenDelta::Usage { prompt_tokens: 0, completion_tokens: 0 }));
        assert!(matches!(deltas[1], TokenDelta::Done));
    }
}
