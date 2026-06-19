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
