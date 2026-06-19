# 子系统 B — LLM 流式客户端 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 `StreamChatProvider` trait + OpenAI/Anthropic SSE 流式实现 + `provider_for_project` 工厂，为 ingest pipeline (D) 提供统一 LLM 调用接口。

**Architecture:** `services/llm_stream.rs`（~550 行单文件）：trait + 共用类型 → OpenAI impl（标准 SSE 解析）→ Anthropic impl（event: 状态机，简化为单 content_block）→ 工厂函数 `provider_for_project(pool, project_id)` 读 `llm_providers` 表 + 复用 `llm.rs` 解密 key。行缓冲（`line_buf`）两 impl 共用。测试用 table-driven + mock。

**Tech Stack:** Rust + axum（不直接用到，复用现有 deps）+ reqwest 0.12（新增，`stream` feature）+ sqlx（查 `llm_providers` 表）+ chrono + tokio。

**依据 spec:** `docs/superpowers/specs/2026-06-19-src-server-ingest-b-llm-stream-design.md`

---

## File Structure

| 文件 | 职责 | 改动 |
|------|------|------|
| `src-server/Cargo.toml` | 加 reqwest 0.12 + stream feature | Modify |
| `src-server/config/default.json` | 加 `llm_timeout_secs: 120` | Modify |
| `src-server/src/services/llm.rs` | `LlmConfig` 加 `timeout_secs` 字段 | Modify |
| `src-server/src/services/llm_stream.rs` | Trait + types + OpenAI impl + Anthropic impl + factory（~550 行） | Create |
| `src-server/src/services/mod.rs` | 加 `pub mod llm_stream;` | Modify |

---

## Task 0: 前置依赖（Cargo.toml + LlmConfig + config）

**编译阻断项**，Task 1-4 依赖。

### Step 1: Cargo.toml 加 reqwest + async-stream

`src-server/Cargo.toml` 的 `[dependencies]` 区域加：

```toml
reqwest = { version = "0.12", features = ["json", "stream"] }
async-stream = "0.3"
```

### Step 2: LlmConfig 加 timeout_secs（**仅新增字段，不动其它**）

`src-server/src/services/llm.rs` 第 6 行 `pub struct LlmConfig` 末尾加一行：

```rust
pub struct LlmConfig {
    pub provider_type: String,
    pub api_key: String,
    pub base_url: Option<String>,
    pub model: String,
    pub context_size: i32,
    pub timeout_secs: Option<u64>,      // 新增。从 config 读取，默认 120s
}
```

并补 `Default for LlmConfig`（同文件第 23 行）：

```rust
impl Default for LlmConfig {
    fn default() -> Self {
        Self {
            provider_type: "openai".into(),
            api_key: String::new(),
            base_url: Some("https://api.openai.com/v1".into()),
            model: "gpt-4o".into(),
            context_size: 128000,
            timeout_secs: Some(120),    // 新增
        }
    }
}
```

`get_llm_config` 返回的 `LlmConfig` 里 `timeout_secs` 暂无 DB 列——暂不映射,保留 `None` 或设默认 120。后续 migration 可加列,先按代码文本处理:

`get_llm_config` 返回的构造处补 `timeout_secs: None`:

### Step 3: config/default.json 加 timeout

`src-server/config/default.json` 加一行：

```json
  "llm_timeout_secs": 120
```

### Step 4: 编译验证

```bash
cargo build -p llm_wiki_server
```
Expected：0 error。（reqwest 拉取编译，LlmConfig 新字段无调用方不 warning——struct 字段不被 `dead_code` lint 覆盖。）

### Step 5: commit

```bash
git add src-server/Cargo.toml src-server/Cargo.lock src-server/src/services/llm.rs src-server/config/default.json
git commit -m "chore(src-server): reqwest 0.12 + LlmConfig.timeout_secs（子系统 B 前置）"
```

---

## Task 1: Trait + 共用类型（编译骨架）

**Files:**
- Create: `src-server/src/services/llm_stream.rs`（trait + types 部分）
- Modify: `src-server/src/services/mod.rs`（加模块声明）

**目标**：定义 `StreamChatProvider` trait + `ChatMessage`/`ChatOpts`/`TokenDelta`/`LlmError`，编译通过但无 impl。

### Step 1: 写 llm_stream.rs（trait + types）

```rust
// src-server/src/services/llm_stream.rs
// LLM 流式客户端：StreamChatProvider trait + OpenAI/Anthropic SSE 实现 + provider 工厂。

use async_trait::async_trait;
use futures::stream::{BoxStream, StreamExt};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use crate::{AppError, AppState};

// ── 共用类型 ──

#[derive(Debug, Clone, Serialize)]
pub struct ChatMessage {
    pub role: String,       // "system" | "user" | "assistant"
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
    Usage { prompt_tokens: u32, completion_tokens: u32 },
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
                TokenDelta::Usage { prompt_tokens, completion_tokens } => {
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
```

### Step 2: mod.rs 加模块声明

`src-server/src/services/mod.rs` 现有 `pub mod llm;` 后加：

```rust
pub mod llm_stream;
```

### Step 3: 编译验证

```bash
cargo build -p llm_wiki_server
```
Expected：0 error。trait 无调用方 → 可能 warning（`unused import` 如 `BoxStream`/`PgPool`），按编译提示移除未用 import 或加 `#[allow(unused_imports)]` 直到 0 warning 新增。

### Step 4: commit

```bash
git add src-server/src/services/llm_stream.rs src-server/src/services/mod.rs
git commit -m "feat(src-server): StreamChatProvider trait + 共用类型（子系统 B 骨架）"
```

---

## Task 2: OpenAI 实现 + SSE 解析 + 单元测试

**Files:**
- Modify: `src-server/src/services/llm_stream.rs`（追加 OpenAiProvider + `mod tests`）

### Step 1: 写失败测试

追加到 llm_stream.rs 末尾：

```rust
#[cfg(test)]
mod tests {
    use super::*;

    // ── OpenAI SSE 解析器 table-driven 测试 ──

    /// 模拟 OpenAI SSE 解析器（对 pub 函数 parse_openai_sse_line 的单元测试）。
    /// 注：实际函数为 OpenAiProvider 私有方法，此处测试代理到公开的 helper。
    /// 若无公开出口，可改为测试 OpenAiProvider::new 构造 + 通过 wiremock mock server。
    /// MVP：直接用 table-driven 测核心解析逻辑（抽出纯函数 `parse_openai_sse_line`）。
    #[test]
    fn test_openai_sse_parsing_text_delta() {
        // 待实现：parse_openai_sse_line 是 OpenAiProvider 的关联函数，
        // MVP 改为 pub(crate) 可见以便测试。
        // 此处先写测试骨架，实现后在 Step 3 验证。
    }

    #[test]
    fn test_openai_sse_parsing_done() {
        // 同上
    }

    #[test]
    fn test_openai_sse_parsing_usage() {
        // 同上
    }
}
```

### Step 2: 跑测试验证失败

```bash
cargo test -p llm_wiki_server --lib llm_stream::tests -- --nocapture
```
Expected：FAIL（无实现）

### Step 3: 实现 OpenAiProvider

在 llm_stream.rs 的 trait 定义后追加：

```rust
// ── OpenAI 实现 ──

use std::pin::Pin;
use futures::stream;

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
    let v: serde_json::Value = serde_json::from_str(data)
        .map_err(|e| LlmError::InvalidSse(format!("JSON parse: {}", e)))?;

    let choice = &v["choices"][0];

    // text delta
    if let Some(t) = choice["delta"]["content"].as_str() {
        if !t.is_empty() {
            return Some(Ok(TokenDelta::Text(t.to_string())));
        }
    }

    // usage（末尾 chunk，choices 为空数组时 usage 字段有值）
    if let Some(u) = v["usage"].as_object() {
        return Some(Ok(TokenDelta::Usage {
            prompt_tokens: u["prompt_tokens"].as_u64().unwrap_or(0) as u32,
            completion_tokens: u["completion_tokens"].as_u64().unwrap_or(0) as u32,
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
        // system prompt 放 messages[0]（OpenAI 标准）
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
                } else if e.is_connect() {
                    LlmError::ConnectionFailed(e.to_string())
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

        // 行缓冲 + SSE 解析
        let stream = async_stream::stream! {
            let mut line_buf: Vec<u8> = Vec::new();
            use futures::StreamExt;
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
            // 处理尾部残留行(无 \n)
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
```

> **实现注**：`async-stream` crate 需要加到 Cargo.toml dep，或改用 `futures::stream::unfold` 手写 Stream。MVP 用 `async_stream::stream!` 宏最简洁。Task 0 若未加 `async-stream`，本 task 补上：`async-stream = "0.3"`。  

### Step 4: 补充单元测试

替换 Step 1 的测试骨架为真实的 table-driven 测试：

```rust
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
```

### Step 5: 跑测试验证通过

```bash
cargo test -p llm_wiki_server --lib llm_stream::tests -- --nocapture
```
Expected：6 passed, 0 failed

### Step 6: commit

```bash
git add src-server/src/services/llm_stream.rs src-server/Cargo.toml src-server/Cargo.lock
git commit -m "feat(src-server): OpenAI SSE 实现 + table-driven 解析器测试"
```

---

## Task 3: Anthropic 实现 + 状态机 + 单元测试

**Files:**
- Modify: `src-server/src/services/llm_stream.rs`（追加 AnthropicProvider）

### Step 1: 写失败测试

在 `mod tests` 中追加：

```rust
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
```

### Step 2: 跑测试验证失败

```bash
cargo test -p llm_wiki_server --lib llm_stream::tests -- --nocapture
```
Expected：3 个 Anthropic 测试 FAIL（`AnthropicStreamState`、`AnthropicProvider::parse_sse_event` 未定义）

### Step 3: 实现 AnthropicProvider + 状态机

在 OpenAI impl 后追加（llm_stream.rs 内）：

```rust
// ── Anthropic 实现 ──

use std::collections::VecDeque;

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
                // 缓存 input_tokens（usage 半片）
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
                // output_tokens 在 message_delta 最终确定
                if let Some(o) = v["usage"]["output_tokens"].as_u64() {
                    state.output_tokens = Some(o as u32);
                }
            }
            "message_stop" => {
                // 拼出 Usage（两半 + 容缺 → 0）再 Done
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
                } else if e.is_connect() {
                    LlmError::ConnectionFailed(e.to_string())
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
            use futures::StreamExt;
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
                        // data: 无前置 event: → 忽略或报错（Anthropic SSE 要求 data: 前必有 event:）
                    } else if let Some(ev) = line.strip_prefix("event: ") {
                        current_event = Some(ev.trim().to_string());
                    }
                }
            }

            // 流结束时若仍有 pending，以 StreamEnded 收尾
            if !state.done {
                yield Err(LlmError::StreamEnded);
            }
        };

        Ok(Box::pin(stream))
    }

    fn provider_type(&self) -> &'static str { "anthropic" }
    fn model_name(&self) -> &str { &self.model }
}
```

### Step 4: 跑测试验证通过

```bash
cargo test -p llm_wiki_server --lib llm_stream::tests -- --nocapture
```
Expected：9 passed（6 OpenAI + 3 Anthropic），0 failed

### Step 5: commit

```bash
git add src-server/src/services/llm_stream.rs
git commit -m "feat(src-server): Anthropic SSE 实现 + 状态机（子系统 B）"
```

---

## Task 4: Provider 工厂 + 模块集成编译

**Files:**
- Modify: `src-server/src/services/llm_stream.rs`（追加 `provider_for_project`）

### Step 1: 实现 `provider_for_project`

在 llm_stream.rs 末尾（Anthropic impl 后）追加：

```rust
// ── Provider 工厂 ──

/// 从 llm_providers 表为指定 project 构造 StreamChatProvider。
/// 复用 services/llm.rs 的 get_llm_config（含 provider_type/base_url/加密 key）→ 解密 key → 构造 impl。
pub async fn provider_for_project(
    state: &AppState,
    project_id: i32,
) -> Result<Box<dyn StreamChatProvider>, AppError> {
    // 复用 llm.rs 取配置——不重复查表
    let config = crate::services::llm::get_llm_config(&state.db, project_id).await?;

    // 解密 key（decrypt_api_key 的第二个参数是 &AppConfig）
    let api_key = crate::services::llm::decrypt_api_key(
        &config.api_key,
        &state.config,
    )?;

    let timeout = config.timeout_secs;            // 来自 DB/默认 120
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
```

### Step 2: 编译验证全模块

```bash
cargo build -p llm_wiki_server
```
Expected：0 error。llm_stream.rs 完整编译，`provider_for_project` 引用了 `llm::get_llm_config` + `llm::decrypt_api_key`（已在 llm.rs 中），确认类型对齐。

> **可能遇到的编译问题**：
> - `provider_for_project` 通过 `get_llm_config` 间接读表（已含加密 key），不自行查 `llm_providers`。若报未用 import `PgPool` 可移除（工厂用 `&AppState`）。
> - `async_stream::stream!` 若编译报错（未装），Cargo.toml 确认 `async-stream = "0.3"` 在 Task 0 Step 1 已加。
> - 两个 impl 的 `stream_chat` 相似度较高（行缓冲逻辑重复），MVP 单文件可接受，后续可抽 helper `split_sse_lines`。

### Step 3: 跑全量单元测试

```bash
cargo test -p llm_wiki_server --lib -- --nocapture
```
Expected：llm_stream 的 9 tests PASS；lib 全部已有 tests 也 PASS（无 regression）。

### Step 4: commit

```bash
git add src-server/src/services/llm_stream.rs
git commit -m "feat(src-server): provider_for_project 工厂 + 子系统 B 集成编译"
```

---

## 最终验证

```bash
cargo build -p llm_wiki_server   # 0 error
cargo test -p llm_wiki_server --lib   # llm_stream 9 tests PASS, 无 regression
```

---

## Self-Review

**1. Spec 覆盖：**
- §3 Trait + types → Task 1 ✅
- §4 OpenAI SSE impl + 解析器测试 → Task 2 ✅
- §5 Anthropic 状态机 + 事件配对 + usage 两事件拼 → Task 3 ✅
- §6 Provider 工厂 + key 解密 → Task 4 ✅
- §7 reqwest 集成 → Task 0 ✅
- §8 LlmConfig.timeout_secs → Task 0 ✅
- §2 行缓冲(line_buf) → 两个 impl 内嵌在 `stream_chat` ✅
- §4 OpenAI usage 说明(stream_options) → Task 2 ✅
- §5 System prompt 差异(OpenAI messages[0] vs Anthropic 顶层 system)→ Task 2/3 ✅

**2. 占位符扫描：** 无 TBD/TODO。Task 4 Step 2 列了可能编译问题及解法。`async-stream` dep 标记为 Task 2 补充。

**3. 类型一致：**
- `ChatMessage`/`ChatOpts`/`TokenDelta`/`LlmError` 在 Task 1 定义，Task 2-4 一致使用 ✅
- `StreamChatProvider` trait 在 Task 1 定义，两 impl 在 Task 2/3 实现 ✅
- `OpenAiProvider::new(endpoint, api_key, model, timeout)` 签名在 Task 2/4 一致 ✅
- `AnthropicProvider::new(...)` 同在 ✅
- `AnthropicStreamState` + `parse_sse_event` 在 Task 3 定义并测试 ✅

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-19-src-server-llm-stream-plan.md`. Two execution options:

**1. Subagent-Driven（推荐）** — 每 task 派发独立 subagent + 两轮 review
**2. Inline Execution** — 本会话批量执行 + checkpoint

Which approach?
