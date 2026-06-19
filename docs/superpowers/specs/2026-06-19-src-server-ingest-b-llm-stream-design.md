# 子系统 B 详细设计 — LLM 流式客户端 (`services/llm_stream.rs`)

> **状态**：详细设计草稿（2026-06-19）| **上级**：[ingest Plan B 总览设计](2026-06-19-src-server-ingest-design.md) §3
>
> 为 `StreamChatProvider` trait、OpenAI/Anthropic SSE 实现、provider 工厂、错误分类提供文件结构 + trait 方法签名 + 实现要点级别的设计。

---

## 1. 目标与边界

**B 做什么**：
- 提供统一 `StreamChatProvider` trait，屏蔽 OpenAI/Anthropic SSE 格式差异
- 从 `llm_providers` 表读 per-project 配置（endpoint/model/api_key_encrypted）→ 工厂函数 `provider_for_project(pool, project_id)` 返 `Box<dyn StreamChatProvider>`
- key 解密复用 `services/llm.rs` 的 `get_llm_config` + `decrypt_api_key`

**B 不做什么**：
- 不管 prompt 构造（那是 D/编排的事）
- 不管缓存/重试/限流（那是 C/队列 + D/编排的事）
- 不管其他 provider（Google/Ollama/Azure/CLI —— 后续加 impl 即可，trait 不破）

**边界**：`StreamChatProvider` trait 定义在本模块，被 `services/ingest_pipeline.rs` (D) 通过 `Box<dyn StreamChatProvider>` 调用。模块内不引入 DB/redis 之外的依赖。

---

## 2. 模块结构

```
src-server/src/services/llm_stream.rs         (~550 行)
 ├── trait StreamChatProvider + 共用类型        (~80 行)
 │    ChatMessage, ChatOpts, TokenDelta, LlmError
 │
 ├── mod openai                                    (~120 行)
 │    OpenAiProvider { client, endpoint, api_key, model }
 │    impl StreamChatProvider → 标准 SSE 解析
 │
 ├── mod anthropic                                  (~200 行)
 │    AnthropicProvider { client, endpoint, api_key, model }
 │    impl StreamChatProvider → event: 状态机 + token 重建
 │
 ├── pub fn provider_for_project(pool, pid)         (~50 行)
 │    读 llm_providers 表 → 匹配 provider_type → 解密 key → 构造 impl
 │
 └── #[cfg(test)] mod tests                        (~100 行)
      MockProvider, 构造逻辑的单元测试
```

不分文件理由（MVP）：Anthropic 状态机 ~120 行 + OpenAI SSE 解析 ~80 行 + trait~60 行 = ~260 行核心逻辑，单文件够。后续多 provider 再拆 `llm_stream/openai.rs` 等子模块。

---

## 3. Trait 与共用类型

```rust
use futures::stream::{BoxStream, StreamExt};
use serde::{Deserialize, Serialize};
use std::pin::Pin;

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
    pub timeout_secs: Option<u64>,  // None = 使用 reqwest Client 默认。config 读取。(review item #4)
}

#[derive(Debug, Clone, Serialize)]
pub enum TokenDelta {
    Text(String),                                 // 逐 token 文本增量
    Usage { prompt_tokens: u32, completion_tokens: u32 }, // 用量
    Done,                                         // 流正常结束
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

/// 异步流式 LLM provider。实现者将 messages 序列化为 provider 专用 JSON，
/// 发起 SSE 请求，返回 `TokenDelta` 流。
#[async_trait]
pub trait StreamChatProvider: Send + Sync {
    /// 发起流式对话。返回 BoxStream 而不是 impl Stream —— 不同 impl 返回
    /// 不同类型（OpenAI 用标准 SSE parser、Anthropic 用 state machine），
    /// trait object 安全要求。
    async fn stream_chat(
        &self,
        messages: Vec<ChatMessage>,
        opts: ChatOpts,
    ) -> Result<BoxStream<'static, Result<TokenDelta, LlmError>>, LlmError>;

    /// 便捷方法：收集所有 Text token 并返回完整文本 + 最终 usage。
    /// 默认实现逐 TokenDelta 累加，子类型可覆盖。
    async fn chat_to_string(&self, messages: Vec<ChatMessage>, opts: ChatOpts)
        -> Result<(String, Option<(u32, u32)>), LlmError>
    {
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

设计要点：
- `BoxStream<'static>`：OpenAI/Anthropic 各自的 SSE stream 在不同 async block 内产生 `Pin<Box<dyn Stream>>`，box 化 + `'static`（无外部引用）后返回。
- `Send + Sync`：tokio 多线程 runtime 要求。`reqwest::Client` 本身是 `Send + Sync + Clone`。
- `chat_to_string` 是便利方法，但 ingest pipeline (D) 直接用 `stream_chat` 收集 token + usage（可以边收边更新进度）。

---

## 4. OpenAI 实现

```rust
pub struct OpenAiProvider {
    client: reqwest::Client,
    endpoint: String,       // "https://api.openai.com/v1/chat/completions"
    api_key: String,        // 已解密
    model: String,          // "gpt-4o" / "gpt-4.1" 等
}

impl OpenAiProvider {
    pub fn new(endpoint: String, api_key: String, model: String, timeout_secs: Option<u64>) -> Self {
        let client = {
            let mut b = reqwest::Client::builder();
            if let Some(t) = timeout_secs { b = b.timeout(std::time::Duration::from_secs(t)); }
            b.build().expect("reqwest Client")
        };
        Self { client, endpoint, api_key, model }
    }
}
```

### stream_chat 实现流程

```
① 构 JSON body {
     model, messages: [{role:"system",content:system_prompt}, {role,content}...],
        ↑ system prompt 拼在 messages[0]（OpenAI 方式）
     temperature, max_tokens,
     stream: true,
     stream_options: {include_usage: true}  // 最后一帧包 usage
   }
② POST endpoint → reqwest::Response → .bytes_stream() → Bytes 流
③ 行缓冲：Bytes chunk 边界不对齐 SSE 行边界——需 `line_buf: Vec<u8>` 累积字节，
   遇到 `\n` 才弹出一行（两个 impl 共用同样需求，可抽 `fn split_sse_lines(stream) -> LineStream`）
④ SSE 解析：
   每行 "data: [DONE]" → TokenDelta.Done
   每行 "data: {...}" → JSON 解析 → choices[0].delta.content → TokenDelta.Text
   末尾 chunk(stream_options: {include_usage: true} 后) choices 为空数组、
     usage 字段有值 → TokenDelta::Usage
⑤ stream.map(|bytes| parse_sse_line(bytes) -> TokenDelta).boxed()
```

### SSE 解析器

用简单行解析（OpenAI 格式稳定，不引入 sse crate 以减少依赖）：

```rust
fn parse_openai_sse_line(line: &str) -> Option<Result<TokenDelta, LlmError>> {
    let line = line.trim();
    if line.is_empty() { return None; }
    let data = line.strip_prefix("data: ")?;
    if data == "[DONE]" { return Some(Ok(TokenDelta::Done)); }

    let v: serde_json::Value = serde_json::from_str(data)
        .map_err(|e| LlmError::InvalidSse(format!("JSON parse: {}", e)))?;
    let choice = &v["choices"][0];

    // text delta
    if let Some(t) = choice["delta"]["content"].as_str() {
        if !t.is_empty() { return Some(Ok(TokenDelta::Text(t.to_string()))); }
    }
    // usage（最终帧）
    if let Some(u) = v["usage"].as_object() {
        return Some(Ok(TokenDelta::Usage {
            prompt_tokens: u["prompt_tokens"].as_u64().unwrap_or(0) as u32,
            completion_tokens: u["completion_tokens"].as_u64().unwrap_or(0) as u32,
        }));
    }
    None
}
```

### 错误映射(HTTP status → LlmError)

| HTTP status | LlmError |
|-------------|----------|
| 401 | `AuthFailed` |
| 429 | `RateLimited` |
| 4xx(其他) | `ApiError { status, body }` |
| 5xx | `ApiError { status, body }` |
| timeout | `Timeout(t)` |
| connection fail | `ConnectionFailed(err)` |

---

## 5. Anthropic 实现

```
Anthropic SSE 格式（非标准，无 data: 前缀）:

event: message_start
data: {"type":"message_start","message":{"id":"...","usage":{...}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":" World"}}
# ← index:1 是第二个 content_block (tool_use / 多块返回)，按 index 追踪

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":42}}

event: message_stop
data: {"type":"message_stop"}
```

关键挑战：content_block_delta 文本可能有多个 `index`（多 content_block 并发），需 **state machine** 按 `index` 追踪累积 token 直到 `message_stop` 才发 Done。

**System prompt 差异（关键）**：Anthropic 的 `system` 是顶层字段（非 role:system message）。`stream_chat` 内部需：取 `opts.system_prompt` → 放入 JSON body 的 `system` 字段；`messages` 数组不含 `role:"system"` 条目（Anthropic API 拒绝这种 message）。

### 状态机设计（简化版）

MVP 假定单 content_block（index=0，text-only），**不追踪 block index，不维护 HashMap**。后续加工具调用时加回 `Option<u32>` cur_index 字段即可。

```
逐行读 stream，维护 current_event: Option<String> + line_buf: Vec<u8>
event: 行 → 设 current_event
data: 行 → 按 current_event match:

  "message_start"        → 缓存 input_tokens (message.usage.input_tokens)
                            （不 emit）
  "content_block_delta"  → 取 delta.text → emit TokenDelta::Text(t)
  "message_delta"        → 提取 usage.output_tokens + stop_reason
                            （不 emit，暂存）
  "message_stop"         → 用缓存的 input_tokens + 暂存的 output_tokens
                            → emit TokenDelta::Usage
                            → emit TokenDelta::Done
  "ping"                 → 忽略
  其他                    → 忽略

**Usage 来源**：两个事件拼出来——
  - message_start.message.usage.input_tokens  → prompt_tokens
  - message_delta.usage.output_tokens          → completion_tokens
  - message_stop 无 usage，仅结束信号
```

```rust
struct AnthropicProvider {
    client: reqwest::Client,
    endpoint: String,       // "https://api.anthropic.com/v1/messages"
    api_key: String,
    model: String,          // "claude-sonnet-4-20250514" 等
    api_version: String,    // "2023-06-01"
}

/// 简化版状态：MVP 单 content_block，不追踪 index/HashMap。
struct AnthropicStreamState {
    events: VecDeque<TokenDelta>,     // 待 emit 的 delta(先入先出)
    input_tokens: Option<u32>,        // 从 message_start 缓存
    output_tokens: Option<u32>,       // 从 message_delta 暂存
    done: bool,
}

impl AnthropicProvider {
    fn parse_sse_event(event_type: &str, data: &str, state: &mut AnthropicStreamState)
        -> Result<(), LlmError>
    {
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
                // 其他 delta_type (input_json_delta 等)忽略(MVP)
            }
            "message_delta" => {
                // output_tokens 在 message_delta 最终确定
                if let Some(o) = v["usage"]["output_tokens"].as_u64() {
                    state.output_tokens = Some(o as u32);
                }
            }
            "message_stop" => {
                // 先发 Usage(从两个事件拼) 再 Done
                let prompt = state.input_tokens.unwrap_or(0);
                let completion = state.output_tokens.unwrap_or(0);
                state.events.push_back(TokenDelta::Usage { prompt_tokens: prompt, completion_tokens: completion });
                state.events.push_back(TokenDelta::Done);
                state.done = true;
            }
            _ => {} // content_block_start/stop/ping — 无需 emit
        }
        Ok(())
    }
}
```

### Anthropic 错误映射

| 行为 | LlmError |
|------|----------|
| HTTP 401 | `AuthFailed` |
| HTTP 429 | `RateLimited` |
| HTTP 4xx/5xx | `ApiError { status, body }` |
| SSE 格式异常 | `InvalidSse(...)` |
| 超时 | `Timeout(...)` |

---

## 6. Provider 工厂

```rust
/// 从 llm_providers 表为指定 project 构造 StreamChatProvider。
/// 读 provider_type、endpoint、model、api_key_encrypted → 解密 key → 构造。
pub async fn provider_for_project(
    pool: &PgPool,
    project_id: i32,
) -> Result<Box<dyn StreamChatProvider>, AppError> {
    // llm_providers 表有 project_id → 可配置每个 project 用哪个 provider
    let row = sqlx::query!(
        "SELECT provider_type, endpoint, model, api_key_encrypted
         FROM llm_providers WHERE project_id = $1 LIMIT 1",
        project_id
    )
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::ResourceNotFound("LLM provider not configured for this project".into()))?;

    let config = crate::services::llm::get_llm_config(pool, project_id).await?;
    let api_key = crate::services::llm::decrypt_api_key(
        &row.api_key_encrypted,
        config.jwt_secret,
    ).map_err(|e| AppError::InternalError(e.to_string()))?;

    match row.provider_type.as_deref() {
        Some("openai") => Ok(Box::new(OpenAiProvider::new(
            row.endpoint, api_key, row.model,
            config.timeout_secs,  // 从 config 读（新增字段）
        ))),
        Some("anthropic") => Ok(Box::new(AnthropicProvider::new(
            row.endpoint, api_key, row.model,
            config.timeout_secs,
        ))),
        other => Err(AppError::ValidationError(
            format!("Unsupported provider type: {:?}", other)
        )),
    }
}
```

---

## 7. reqwest 集成

**依赖**：`src-server/Cargo.toml` 加 `reqwest = { version = "0.12", features = ["json", "stream"] }`。（流式 bytes_stream 需 `stream` feature。）

**Client 策略**：每个 provider 实例内部持有 `reqwest::Client`（构造时开；若有 timeout 通过 builder 设）。多 provider 不共享 Client——避免 OpenAI 和 Anthropic 不同 timeout/header 混在一起。这是每个 impl 内部管理的低开销对象——因为单 worker 串行，OpenAI 和 Anthropic 对应同一个 project 无需同时持活，复用能简单构造。

**不引入 reqwest middleware**：OpenAI 和 Anthropic 需要的 header 不同（OpenAI: `Authorization: Bearer`、Anthropic: `x-api-key` + `anthropic-version`），直接在 `stream_chat` 内拼 `Request`，无需重试 middle(已在 D 层处理 job 级失败)。

---

## 8. LlmConfig 扩展

在 `services/llm.rs` 的 `LlmConfig` 加 `timeout_secs` 字段：

```rust
pub struct LlmConfig {
    pub provider: String,
    pub model: String,
    pub api_key_encrypted: String,
    pub endpoint: String,
    pub timeout_secs: Option<u64>,      // ← 新增。从 config 读取，默认 120s
    // ... 其他字段不变
}
```

从 `config/default.json` + env 读取 `LLM_TIMEOUT_SECS`（默认 120）。

---

## 9. 测试策略

| 测试类型 | 内容 | 实现 |
|----------|------|------|
| unit: SSE 解析 | 给一段合法的 OpenAI SSE 文本 → 期望正确的 TokenDelta 序列 | `parse_openai_sse_line` 纯函数，table-driven |
| unit: Anthropic 状态机 | 按顺序喂各 event → 期望事件序列 | `parse_sse_event` mock 输入 |
| unit: HTTP error 映射 | mock reqwest Response(status=401/429/...) → 期望 LlmError | 用 `wiremock`(轻量级 HTTP mock server) 或直接构造 response bytes |
| unit: provider_for_project | mock llm_providers 表行 → 期望返正确 impl 类型 | 用 sqlx `sqlx::test`（需 runtime PG）或 trait 抽象 DB |
| integ: E2E(带真实 API) | 真实 OpenAI/Anthropic key → stream_chat → 确认返回非空 text | **注：`#[ignore]`——需 API key + 网络 + 花钱。不跑 CI，仅本地手动。** |

```rust
// 示例 table-driven test (OpenAI SSE 解析)
#[test]
fn test_openai_sse_parsing() {
    let cases = vec![
        ("data: {\"choices\":[{\"delta\":{\"content\":\"Hi\"}}]}", Some(TokenDelta::Text("Hi".into()))),
        ("data: [DONE]", Some(TokenDelta::Done)),
        ("", None),  // 空行被 SSE 协议忽略
    ];
    for (input, expected) in cases {
        assert_eq!(parse_openai_sse_line(input), expected);
    }
}
```

---

## 10. 文件改动清单（子系统 B）

| 文件 | 改动 |
|------|------|
| `src-server/Cargo.toml` | 加 `reqwest = { version = "0.12", features = ["json", "stream"] }` |
| `src-server/src/services/llm_stream.rs` | **新建**（~550 行）：trait + types + OpenAI impl + Anthropic impl + factory |
| `src-server/src/services/mod.rs` | 加 `pub mod llm_stream;` |
| `src-server/src/services/llm.rs` | `LlmConfig` 加 `timeout_secs: Option<u64>` |
| `src-server/config/default.json` | 加 `"llm_timeout_secs": 120` |
