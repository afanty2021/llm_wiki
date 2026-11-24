- mcp == 2.0.0
- mcp-types == 2.0.0
- anthropic == 0.87.0
- openai == 2.24.0
- pillow-heif == 1.6.0

## ① import 面（全树）
- import 语句 232 条（其中 try/except ImportError 守护 33 条），钉版下解析失败 **4** 条
  - 守护内 `tests/test_mcp_circuit_breaker.py:21` from mcp.shared.exceptions :: McpError → missing name 'McpError' in mcp.shared.exceptions
  - 守护内 `tools/mcp_oauth_provider.py:21` from mcp.client.auth.utils :: issuers_match → missing name 'issuers_match' in mcp.client.auth.utils
  - 守护内 `tools/mcp_tool.py:574` from mcp.shared.exceptions :: McpError → missing name 'McpError' in mcp.shared.exceptions
  - 守护内 `tools/mcp_tool.py:581` from mcp.types :: McpError → missing name 'McpError' in mcp.types

## ② 模块别名上的属性链
- 属性链 114 条，钉版下解析失败 **0** 条

## ③ 调用点 kwargs 对钉版方法签名
- 已构造只读客户端对象（不发网络）：anthropic.Anthropic, anthropic.AsyncAnthropic, openai.OpenAI, openai.AsyncOpenAI
- 调用点分类：anthropic_calls=1, anthropic_calls_noimport=2, anthropic_calls_test=1, mcp_session_calls=2, openai_calls=39, openai_calls_noimport=11, openai_calls_test=14, openai_calls_test_noimport=42
- 解析到的 SDK 方法路径 13 个（非测试文件计）：
  - `ClientSession.call_tool` ×1
  - `ClientSession.list_tools` ×1
  - `anthropic:messages.create` ×3
  - `anthropic:messages.stream` ×1
  - `openai:audio.speech.create` ×1
  - `openai:audio.speech.with_streaming_response.create` ×1
  - `openai:audio.transcriptions.create` ×2
  - `openai:chat.completions.create` ×84
  - `openai:images.generate` ×2
  - `openai:responses.create` ×13
  - `openai:videos.create` ×1
  - `openai:videos.download_content` ×1
  - `openai:videos.retrieve` ×1

- **kwargs/位置实参与钉版签名不符且无守护的调用：0 处**

- SDK 形态（≥2 段）但未在钉版客户端上解析出方法的 receiver 尾链（供人工复核，非测试文件）：
  - `beta.extract` ×1  @ plugins/web/parallel/provider.py
  - `beta.search` ×1  @ plugins/web/parallel/provider.py
  - `chat.completions._fold_pending_accounting` ×1  @ evals/postmortem/review_probes/deadline_probe.py
  - `chat.completions.consume_and_save_trace` ×1  @ agent/moa_loop.py
  - `chat.completions.consume_reference_usage` ×1  @ agent/moa_loop.py
  - `chat.completions.last_reference_metrics` ×1  @ agent/moa_loop.py
  - `client.chat.completions.prepare` ×1  @ agent/chat_completion_helpers.py
