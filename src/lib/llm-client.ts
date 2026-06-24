import type { LlmConfig } from "@/stores/wiki-store"
import { isAzureOpenAiEndpoint } from "@/lib/azure-openai"
import { getProviderConfig, type RequestOverrides } from "./llm-providers"
import { getHttpFetch, isFetchNetworkError } from "./tauri-fetch"
import { countReasoningCharsInLine, extractReasoningTextFromLine } from "./reasoning-detector"
import { caps } from "@/lib/capabilities"
import { API_BASE } from "@/lib/api-client"

export type { ChatMessage, ContentBlock, RequestOverrides } from "./llm-providers"
export { isFetchNetworkError } from "./tauri-fetch"

export interface StreamCallbacks {
  onToken: (token: string) => void
  onReasoningToken?: (token: string) => void
  onDone: () => void
  onError: (error: Error) => void
}

// Lazy import keeps the Tauri event/invoke bindings out of bundles that
// never touch the subprocess provider (e.g. vitest with a fetch mock).
async function streamViaClaudeCodeCli(
  config: LlmConfig,
  messages: import("./llm-providers").ChatMessage[],
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
  requestOverrides?: RequestOverrides,
) {
  const mod = await import("./claude-cli-transport")
  return mod.streamClaudeCodeCli(config, messages, callbacks, signal, requestOverrides)
}

async function streamViaCodexCli(
  config: LlmConfig,
  messages: import("./llm-providers").ChatMessage[],
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
  requestOverrides?: RequestOverrides,
) {
  const mod = await import("./codex-cli-transport")
  return mod.streamCodexCli(config, messages, callbacks, signal, requestOverrides)
}

const DECODER = new TextDecoder()

function parseLines(chunk: Uint8Array, buffer: string): [string[], string] {
  const text = buffer + DECODER.decode(chunk, { stream: true })
  const lines = text.split("\n")
  const remaining = lines.pop() ?? ""
  return [lines, remaining]
}

function isRequestCancelledError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /^request cancel(?:l)?ed$/i.test(message.trim())
}

export async function streamChat(
  config: LlmConfig,
  messages: import("./llm-providers").ChatMessage[],
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
  /**
   * Wire-agnostic sampling knobs. The provider's buildBody() translates
   * these into its native schema — OpenAI-style wires accept them at
   * the top level ({temperature: 0.1}), Gemini nests them under
   * generationConfig with renamed keys ({generationConfig: {temperature: 0.1}}).
   * Previously we spread them onto the body here, which broke Gemini
   * with "Unknown name 'temperature': Cannot find field." HTTP 400.
   */
  requestOverrides?: RequestOverrides,
): Promise<void> {
  // Layer 5:web(纯浏览器)走 src-server 代理(POST /api/v1/chat/stream),
  // 服务器按 project_id 取 team provider 直通上游标准 OpenAI SSE,前端不持 key。
  // 桌面(tauri)继续走下方既有 HTTP/invoke 路径,行为零变化。
  if (caps.platform === "web") {
    return streamViaServer(config, messages, callbacks, signal)
  }

  const { onToken, onDone, onError } = callbacks

  // Claude Code CLI uses a subprocess transport (stdin/stdout), not
  // HTTP. Dispatch before getProviderConfig — that function throws for
  // this provider because it has no URL/headers.
  if (config.provider === "claude-code") {
    return streamViaClaudeCodeCli(config, messages, callbacks, signal, requestOverrides)
  }

  if (config.provider === "codex-cli") {
    return streamViaCodexCli(config, messages, callbacks, signal, requestOverrides)
  }

  const providerConfig = getProviderConfig(config)

  // Combined abort: (a) user cancel, (b) our long-horizon timeout.
  // The long timeout is a backstop for truly stuck requests; it's NOT
  // what fires when a user sees "Timeout" after 2 seconds — that is
  // almost always a fast network failure (DNS, TLS, 404, refused) that
  // WebKit surfaces as a generic "Load failed". We track whether the
  // backstop actually fired so we can tell the two apart in the error.
  const timeoutMs = 30 * 60 * 1000 // 30 min — generous backstop for huge-context reasoning models
  let combinedSignal = signal
  let timeoutController: AbortController | undefined
  let timeoutFired = false

  if (typeof AbortSignal.timeout === "function") {
    timeoutController = new AbortController()
    const timeoutId = setTimeout(() => {
      timeoutFired = true
      timeoutController?.abort()
    }, timeoutMs)

    if (signal) {
      signal.addEventListener("abort", () => {
        clearTimeout(timeoutId)
        timeoutController?.abort()
      })
    }
    combinedSignal = timeoutController.signal
  }

  let response: Response
  try {
    const body = providerConfig.buildBody(messages, requestOverrides)
    const httpFetch = await getHttpFetch()
    response = await httpFetch(providerConfig.url, {
      method: "POST",
      headers: providerConfig.headers,
      body: JSON.stringify(body),
      signal: combinedSignal,
    })
  } catch (err) {
    if (signal?.aborted) {
      onDone()
      return
    }
    if ((err instanceof Error && err.name === "AbortError") || isRequestCancelledError(err)) {
      // Backstop timeout aborted the request (we tracked this via
      // timeoutFired); treat it as a real timeout rather than a cancel.
      if (timeoutFired) {
        onError(new Error(`Request timed out after ${Math.round(timeoutMs / 60000)} min. Try a faster model or a smaller context.`))
        return
      }
      onDone()
      return
    }
    if (isFetchNetworkError(err)) {
      if (timeoutFired) {
        onError(new Error(`Request timed out after ${Math.round(timeoutMs / 60000)} min. Try a faster model or a smaller context.`))
        return
      }
      // Fast fetch failure: DNS, TLS handshake, connection refused,
      // wrong endpoint, CORS preflight rejection, etc. All webviews
      // collapse this class of failure into an opaque error — point
      // users at the likely cause (endpoint / key / connectivity).
      onError(new Error(`Network error reaching ${providerConfig.url}. Check endpoint URL, API key, and connectivity.`))
      return
    }
    onError(err instanceof Error ? err : new Error(String(err)))
    return
  }

  if (!response.ok) {
    let errorDetail = `HTTP ${response.status}: ${response.statusText}`
    try {
      const body = await response.text()
      if (body) errorDetail += ` — ${body}`
    } catch {
      // ignore body read failure
    }
    if (
      response.status === 404 &&
      (config.provider === "azure" ||
        (config.provider === "custom" && isAzureOpenAiEndpoint(config.customEndpoint)))
    ) {
      onError(
        new Error(
          `${errorDetail} — Azure 404 usually means the deployment name is wrong. ` +
            `Set Model to your Azure deployment name (not the model SKU), ` +
            `and Endpoint to https://<resource>.openai.azure.com ` +
            `or .../openai/deployments/<deployment-name>.`,
        ),
      )
      return
    }
    onError(new Error(errorDetail))
    return
  }

  if (!response.body) {
    onError(new Error("Response body is null"))
    return
  }

  const reader = response.body.getReader()
  let lineBuffer = ""

  // Diagnostic counters. Some OpenAI-compatible endpoints stream
  // chain-of-thought through a `reasoning_content` (DeepSeek-R1,
  // Kimi K2.x) or `reasoning` (Qwen-flavored deployments) field
  // and only put the actual answer in `delta.content` after
  // thinking ends. Misbehaving endpoints sometimes emit kilobytes
  // of reasoning and end the stream with no content at all,
  // leaving the user with a silent empty analysis. We track the
  // two channels separately so the stream-end path can tell the
  // difference between "model said nothing" and "model thought
  // out loud but never produced an answer". See reasoning-
  // detector.ts.
  let contentCharsEmitted = 0
  let reasoningCharsObserved = 0
  const recordToken = (text: string) => {
    contentCharsEmitted += text.length
    onToken(text)
  }
  const recordReasoning = (line: string) => {
    const reasoningParts = extractReasoningTextFromLine(line)
    for (const part of reasoningParts) {
      callbacks.onReasoningToken?.(part)
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read()

      if (done) {
        if (lineBuffer.trim()) {
          const trimmed = lineBuffer.trim()
          reasoningCharsObserved += countReasoningCharsInLine(trimmed)
          recordReasoning(trimmed)
          const token = providerConfig.parseStream(trimmed)
          if (token !== null) recordToken(token)
        }
        break
      }

      const [lines, remaining] = parseLines(value, lineBuffer)
      lineBuffer = remaining

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        reasoningCharsObserved += countReasoningCharsInLine(trimmed)
        recordReasoning(trimmed)
        const token = providerConfig.parseStream(trimmed)
        if (token !== null) recordToken(token)
      }
    }

    // Stream ended cleanly. If the model produced thinking tokens
    // but no actual answer, surface that as a clear diagnostic
    // instead of letting the caller silently see "" (which usually
    // surfaces several layers up as "analysis not available" with
    // no clue why). Threshold guards against single-stray-byte
    // false positives from spurious empty `reasoning:""` deltas.
    const REASONING_DIAGNOSTIC_THRESHOLD = 200
    if (
      contentCharsEmitted === 0 &&
      reasoningCharsObserved >= REASONING_DIAGNOSTIC_THRESHOLD
    ) {
      onError(
        new Error(
          `Model produced ${reasoningCharsObserved.toLocaleString()} characters of reasoning / chain-of-thought, but no actual response content. ` +
          `This usually means the endpoint hit a thinking-token limit, the model didn't transition from thinking to answering, ` +
          `or the endpoint is misbehaving (the official Anthropic / OpenAI APIs don't have this issue). ` +
          `Try a shorter input, increase max_tokens, or switch to a different model in Settings.`,
        ),
      )
      return
    }

    onDone()
  } catch (err) {
    // The abort can reach us two ways: a real AbortError, or — when the
    // Tauri HTTP plugin tears down the body stream — a bare *string*
    // "Request cancelled" passed to controller.error(). The latter is not
    // an Error, so the old `err instanceof Error` guard let it fall through
    // to the generic branch and surface verbatim. Recognize both shapes.
    const isAbort =
      signal?.aborted ||
      timeoutFired ||
      (err instanceof Error && err.name === "AbortError") ||
      isRequestCancelledError(err)
    if (isAbort) {
      // Mirror the pre-fetch catch: distinguish our long-horizon backstop
      // (an actionable timeout) from a user-initiated cancel (silent).
      if (timeoutFired) {
        onError(new Error(`Request timed out after ${Math.round(timeoutMs / 60000)} min. Try a faster model or a smaller context.`))
        return
      }
      onDone()
      return
    }
    if (isFetchNetworkError(err)) {
      // Stream reader threw a network error mid-response (connection
      // dropped, server closed early, network blip). Same message
      // regardless of whether the webview is WebKit or Chromium.
      onError(new Error("Connection lost during streaming. Try again."))
      return
    }
    onError(err instanceof Error ? err : new Error(String(err)))
  } finally {
    reader.releaseLock()
  }
}

/** web 通路:fetch POST /api/v1/chat/stream + Authorization + ReadableStream 逐行解析。
 *  服务器按 project_id 查 team provider(见 chat.rs stream_chat_raw),前端不持 key。
 *  复用桌面版的逐行解析(parseLines)与 reasoning 检测(reasoning-detector),
 *  服务器侧约束 provider 恒为 OpenAI-compatible,故用 openai parseStream 单层解析。 */
async function streamViaServer(
  _config: LlmConfig,
  messages: import("./llm-providers").ChatMessage[],
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
): Promise<void> {
  const { onToken, onDone, onError } = callbacks
  // __currentProjectId 由 handleProjectOpened 注入(WikiProject.id,string,web 下 String(p.id))。
  // chat.rs 用 as_i64 解析 project_id,字符串会 None→unwrap_or(0)→check_project_access(0) 4xx,
  // 故 JSON body 前转 number(fs/file-url 仅 URL 拼接 string 可,唯 chat JSON body 需 number)。
  const projectId = Number(
    (typeof window !== "undefined" && (window as any).__currentProjectId) || 0,
  )
  const { apiClient } = await import("@/lib/api-client")
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...apiClient.authHeaders(),
  }

  let response: Response
  try {
    response = await fetch(`${API_BASE}/api/v1/chat/stream`, {
      method: "POST",
      headers,
      body: JSON.stringify({ project_id: projectId, messages }),
      signal,
    })
  } catch (err) {
    if (signal?.aborted) {
      onDone()
      return
    }
    onError(err instanceof Error ? err : new Error(String(err)))
    return
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    onError(new Error(`chat upstream HTTP ${response.status}: ${detail}`))
    return
  }
  if (!response.body) {
    onError(new Error("chat stream body null"))
    return
  }

  // 逐行解析复用桌面版 OpenAI-compatible 通路 + reasoning 检测(DeepSeek-R1 等思考模型)。
  // getProviderConfig 用顶层静态 import(测试不 mock ./llm-providers,无需动态隔离)。
  const providerConfig = getProviderConfig({
    provider: "openai",
    apiKey: "",
    model: "",
  } as LlmConfig)
  const reader = response.body.getReader()
  let lineBuffer = ""
  let contentCharsEmitted = 0
  let reasoningCharsObserved = 0
  const REASONING_DIAGNOSTIC_THRESHOLD = 200
  const recordToken = (text: string) => {
    contentCharsEmitted += text.length
    onToken(text)
  }
  const recordReasoning = (line: string) => {
    for (const part of extractReasoningTextFromLine(line)) {
      callbacks.onReasoningToken?.(part)
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        if (lineBuffer.trim()) {
          const trimmed = lineBuffer.trim()
          reasoningCharsObserved += countReasoningCharsInLine(trimmed)
          recordReasoning(trimmed)
          const token = providerConfig.parseStream(trimmed)
          if (token !== null) recordToken(token)
        }
        break
      }
      const [lines, remaining] = parseLines(value, lineBuffer)
      lineBuffer = remaining
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        reasoningCharsObserved += countReasoningCharsInLine(trimmed)
        recordReasoning(trimmed)
        const token = providerConfig.parseStream(trimmed)
        if (token !== null) recordToken(token)
      }
    }
    // 只思考无答案的诊断(与桌面版 streamChat 一致)
    if (
      contentCharsEmitted === 0 &&
      reasoningCharsObserved >= REASONING_DIAGNOSTIC_THRESHOLD
    ) {
      onError(
        new Error(
          `Model produced ${reasoningCharsObserved.toLocaleString()} chars of reasoning but no content. Try shorter input, increase max_tokens, or switch model.`,
        ),
      )
      return
    }
    onDone()
  } catch (err) {
    if (signal?.aborted) {
      onDone()
      return
    }
    onError(err instanceof Error ? err : new Error(String(err)))
  } finally {
    reader.releaseLock()
  }
}
