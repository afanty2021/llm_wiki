import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// Stub getHttpFetch so streamChat hits our in-test responder; keep the
// rest of tauri-fetch (notably isFetchNetworkError) real so the existing
// cross-webview tests below still exercise the genuine classifier.
const mockHttpFetch = vi.fn<(url: string, opts?: RequestInit) => Promise<Response>>()
vi.mock("./tauri-fetch", async () => {
  const actual = await vi.importActual<typeof import("./tauri-fetch")>("./tauri-fetch")
  return { ...actual, getHttpFetch: () => Promise.resolve(mockHttpFetch) }
})

// Layer 5:caps.platform 决定 streamChat 分发。jsdom 环境下 detect() 天然判为
// "web",会让下方桌面 abort 测试误走 streamViaServer 而超时。默认 mock 成 tauri
// 保持桌面路径;web 分发测试用 vi.resetModules + vi.doMock 覆盖。
vi.mock("@/lib/capabilities", () => ({ caps: { platform: "tauri" } }))

import { isFetchNetworkError, isReasoningOnlyResponseError, streamChat } from "./llm-client"
import type { LlmConfig } from "@/stores/wiki-store"

/**
 * Guards for cross-webview error detection. Tauri renders the frontend
 * with WebKit on macOS/Linux and Edge WebView2 (Chromium) on Windows,
 * and each backend phrases fetch failures differently. These tests pin
 * down that every real-world error shape gets classified as a network
 * error so the user sees a helpful message instead of a raw stack.
 */
describe("isFetchNetworkError — cross-webview fetch failures", () => {
  it("recognises WebKit's 'Load failed' (macOS / Linux GTK)", () => {
    const e = new Error("Load failed")
    expect(isFetchNetworkError(e)).toBe(true)
  })

  it("recognises Chromium/Edge's TypeError: Failed to fetch (Windows)", () => {
    // Real Chromium throws a TypeError with this exact shape.
    const e = new TypeError("Failed to fetch")
    expect(isFetchNetworkError(e)).toBe(true)
  })

  it("recognises any TypeError (Chromium fetch failure class)", () => {
    // Chromium also throws TypeError with messages like "NetworkError
    // when attempting to fetch resource." — the name alone is enough.
    const e = new TypeError("NetworkError when attempting to fetch resource.")
    expect(isFetchNetworkError(e)).toBe(true)
  })

  it("recognises messages containing 'network error' (mid-stream drops)", () => {
    const e = new Error("The network error occurred while reading")
    expect(isFetchNetworkError(e)).toBe(true)
  })

  it("rejects AbortError (user cancelled)", () => {
    const e = new Error("The operation was aborted.")
    e.name = "AbortError"
    expect(isFetchNetworkError(e)).toBe(false)
  })

  it("rejects plain application errors (HTTP 4xx surfaced as Error)", () => {
    const e = new Error("HTTP 401: Unauthorized")
    expect(isFetchNetworkError(e)).toBe(false)
  })

  it("rejects non-Error values (strings, null, objects)", () => {
    expect(isFetchNetworkError("boom")).toBe(false)
    expect(isFetchNetworkError(null)).toBe(false)
    expect(isFetchNetworkError(undefined)).toBe(false)
    expect(isFetchNetworkError({ message: "Load failed" })).toBe(false)
  })
})

describe("isReasoningOnlyResponseError", () => {
  it("recognises the reasoning-only stream diagnostic", () => {
    expect(isReasoningOnlyResponseError(
      new Error("Model produced 2,176 characters of reasoning / chain-of-thought, but no actual response content. Try again."),
    )).toBe(true)
    expect(isReasoningOnlyResponseError(new Error("plain provider error"))).toBe(false)
  })
})

/**
 * The streaming-path abort handling. When the 30-min backstop fires
 * mid-stream the Tauri HTTP plugin tears the body stream down with a
 * BARE STRING "Request cancelled" (controller.error(string)), not an
 * Error. The old guard only matched `err instanceof Error`, so that
 * string fell through to the generic branch and surfaced verbatim —
 * exactly the cryptic "request cancelled" the dedup scan showed. These
 * pin down that the string is now recognized as an abort and mapped to
 * the actionable timeout message (or a silent cancel when no backstop).
 */
const cfg: LlmConfig = {
  provider: "ollama",
  apiKey: "",
  model: "qwen3:8b",
  ollamaUrl: "http://localhost:11434",
  customEndpoint: "",
  apiMode: "chat_completions",
  maxContextSize: 8192,
}

const customStreamingCfg: LlmConfig = {
  ...cfg,
  provider: "custom",
  model: "local-openai-model",
  customEndpoint: "http://127.0.0.1:13305/v1",
}

function openAiSseToken(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}`
}

describe("streamChat — buffered streaming responses", () => {
  beforeEach(() => mockHttpFetch.mockReset())

  it("surfaces a JSON endpoint error returned inside HTTP 200", async () => {
    mockHttpFetch.mockResolvedValue(new Response(JSON.stringify({
      error: { code: 400, message: "request exceeds available context" },
    }), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }))
    const onToken = vi.fn()
    const onDone = vi.fn()
    const onError = vi.fn()

    await streamChat(
      customStreamingCfg,
      [{ role: "user", content: "hi" }],
      { onToken, onDone, onError },
    )

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0].message).toBe(
      "LLM endpoint error 400: request exceeds available context",
    )
    expect(onToken).not.toHaveBeenCalled()
    expect(onDone).not.toHaveBeenCalled()
  })

  it("retries a custom endpoint without temperature when the provider rejects it", async () => {
    mockHttpFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: "Unsupported parameter: temperature" },
      }), { status: 400 }))
      .mockResolvedValueOnce(new Response([
        openAiSseToken("retried"),
        "data: [DONE]",
      ].join("\n\n"), { status: 200 }))
    const onToken = vi.fn()
    const onDone = vi.fn()
    const onError = vi.fn()

    await streamChat(
      customStreamingCfg,
      [{ role: "user", content: "hi" }],
      { onToken, onDone, onError },
      undefined,
      { temperature: 0.1, max_tokens: 512 },
    )

    expect(mockHttpFetch).toHaveBeenCalledTimes(2)
    expect(JSON.parse(String(mockHttpFetch.mock.calls[0][1]?.body))).toMatchObject({
      temperature: 0.1,
      max_tokens: 512,
    })
    const retryBody = JSON.parse(String(mockHttpFetch.mock.calls[1][1]?.body))
    expect(retryBody.temperature).toBeUndefined()
    expect(retryBody.max_tokens).toBe(512)
    expect(onToken).toHaveBeenCalledWith("retried")
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()
  })

  it("cancels a still-open response body after an SSE endpoint error", async () => {
    let bodyCancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          'data: {"error":{"message":"stream failed"}}\n',
        ))
      },
      cancel() {
        bodyCancelled = true
      },
    })
    mockHttpFetch.mockResolvedValue(new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }))
    const onToken = vi.fn()
    const onDone = vi.fn()
    const onError = vi.fn()

    await streamChat(
      customStreamingCfg,
      [{ role: "user", content: "hi" }],
      { onToken, onDone, onError },
    )

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0].message).toBe("LLM endpoint error: stream failed")
    expect(bodyCancelled).toBe(true)
    expect(onToken).not.toHaveBeenCalled()
    expect(onDone).not.toHaveBeenCalled()
  })

  it("parses every record from a fully buffered SSE body", async () => {
    const body = [
      openAiSseToken("Hello"),
      "",
      openAiSseToken(" world"),
      "",
      "data: [DONE]",
      "",
    ].join("\n")
    mockHttpFetch.mockResolvedValue(new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }))
    const onToken = vi.fn()
    const onDone = vi.fn()
    const onError = vi.fn()

    await streamChat(
      customStreamingCfg,
      [{ role: "user", content: "hi" }],
      { onToken, onDone, onError },
    )

    expect(onToken.mock.calls.map(([token]) => token)).toEqual(["Hello", " world"])
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()
  })

  it("normalizes escaped separators in a buffered SSE body", async () => {
    const body = [
      openAiSseToken("Hello"),
      openAiSseToken(" world"),
      "data: [DONE]",
    ].join("\\n\\n")
    mockHttpFetch.mockResolvedValue(new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }))
    const onToken = vi.fn()
    const onDone = vi.fn()
    const onError = vi.fn()

    await streamChat(
      customStreamingCfg,
      [{ role: "user", content: "hi" }],
      { onToken, onDone, onError },
    )

    expect(onToken.mock.calls.map(([token]) => token)).toEqual(["Hello", " world"])
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()
  })

  it("does not split separator-like text inside streamed JSON content", async () => {
    const content = "first line\n\ndata: still model output"
    const body = [
      openAiSseToken(content),
      "data: [DONE]",
    ].join("\\n\\n")
    mockHttpFetch.mockResolvedValue(new Response(body, { status: 200 }))
    const onToken = vi.fn()
    const onDone = vi.fn()
    const onError = vi.fn()

    await streamChat(
      customStreamingCfg,
      [{ role: "user", content: "hi" }],
      { onToken, onDone, onError },
    )

    expect(onToken).toHaveBeenCalledWith(content)
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()
  })
})

describe("streamChat — non-streaming HTTP responses", () => {
  beforeEach(() => mockHttpFetch.mockReset())

  it("emits one complete token and completes", async () => {
    mockHttpFetch.mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: "complete answer" } }],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }))
    const onToken = vi.fn()
    const onDone = vi.fn()
    const onError = vi.fn()

    await streamChat(
      { ...cfg, streamingEnabled: false },
      [{ role: "user", content: "hi" }],
      { onToken, onDone, onError },
    )

    expect(onToken).toHaveBeenCalledTimes(1)
    expect(onToken).toHaveBeenCalledWith("complete answer")
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()
    expect(JSON.parse(String(mockHttpFetch.mock.calls[0][1]?.body))).toMatchObject({ stream: false })
  })

  it("reports an empty complete response instead of silently succeeding", async () => {
    mockHttpFetch.mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: "" } }],
    }), { status: 200 }))
    const onError = vi.fn()

    await streamChat(
      { ...cfg, streamingEnabled: false },
      [{ role: "user", content: "hi" }],
      { onToken: vi.fn(), onDone: vi.fn(), onError },
    )

    expect(onError.mock.calls[0][0].message).toContain("empty non-streaming response")
  })
})

/** A Response whose reader.read() stays pending until we reject it,
 *  letting the test interleave the 30-min backstop before the abort.
 *  `readCalled` resolves once streamChat reaches read(), so the test
 *  can await it instead of guessing how many microtasks to flush. */
function pendingStreamResponse(): {
  response: Response
  getReject: () => (e: unknown) => void
  readCalled: Promise<void>
} {
  let reject!: (e: unknown) => void
  let signalReadCalled!: () => void
  const readCalled = new Promise<void>((res) => { signalReadCalled = res })
  const reader = {
    read: () =>
      new Promise<never>((_resolve, rej) => {
        reject = rej
        signalReadCalled()
      }),
    releaseLock: () => {},
    cancel: () => {},
  }
  const response = {
    ok: true,
    body: { getReader: () => reader },
  } as unknown as Response
  return { response, getReject: () => reject, readCalled }
}

describe("streamChat — mid-stream abort mapping", () => {
  beforeEach(() => {
    mockHttpFetch.mockReset()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("maps the plugin's bare-string abort to the timeout message when the 30-min backstop fired", async () => {
    const { response, getReject, readCalled } = pendingStreamResponse()
    mockHttpFetch.mockResolvedValue(response)

    const onError = vi.fn()
    const onDone = vi.fn()
    const promise = streamChat(
      cfg,
      [{ role: "user", content: "hi" }],
      { onToken: vi.fn(), onDone, onError },
      undefined,
      {},
    )

    // Wait until streamChat is parked in read(), then fire the long-horizon
    // backstop and let the plugin error the stream with its bare string.
    await readCalled
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000)
    getReject()("Request cancelled")
    await promise

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0].message).toMatch(/timed out after 30 min/)
    expect(onDone).not.toHaveBeenCalled()
  })

  it("uses the provider's configured request timeout", async () => {
    const { response, getReject, readCalled } = pendingStreamResponse()
    mockHttpFetch.mockResolvedValue(response)
    const onError = vi.fn()
    const promise = streamChat(
      { ...cfg, requestTimeoutMinutes: 90 },
      [{ role: "user", content: "hi" }],
      { onToken: vi.fn(), onDone: vi.fn(), onError },
    )
    await readCalled
    await vi.advanceTimersByTimeAsync(90 * 60 * 1000)
    getReject()("Request cancelled")
    await promise
    expect(onError.mock.calls[0][0].message).toMatch(/timed out after 90 min/)
  })

  it("treats a bare-string abort as a silent cancel when the backstop did NOT fire", async () => {
    const { response, getReject, readCalled } = pendingStreamResponse()
    mockHttpFetch.mockResolvedValue(response)

    const onError = vi.fn()
    const onDone = vi.fn()
    const promise = streamChat(
      cfg,
      [{ role: "user", content: "hi" }],
      { onToken: vi.fn(), onDone, onError },
      undefined,
      {},
    )

    await readCalled
    getReject()("Request cancelled")
    await promise

    expect(onDone).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()
  })

  it("recognises lowercase and single-l cancelled spellings as silent cancels", async () => {
    for (const message of ["request cancelled", "Request canceled"]) {
      const { response, getReject, readCalled } = pendingStreamResponse()
      mockHttpFetch.mockResolvedValueOnce(response)

      const onError = vi.fn()
      const onDone = vi.fn()
      const promise = streamChat(
        cfg,
        [{ role: "user", content: "hi" }],
        { onToken: vi.fn(), onDone, onError },
        undefined,
        {},
      )

      await readCalled
      getReject()(message)
      await promise

      expect(onDone).toHaveBeenCalledTimes(1)
      expect(onError).not.toHaveBeenCalled()
    }
  })

  it("treats pre-fetch bare-string cancel spellings as silent cancels", async () => {
    for (const message of ["request cancelled", "Request canceled"]) {
      mockHttpFetch.mockReset()
      mockHttpFetch.mockRejectedValueOnce(message)

      const onError = vi.fn()
      const onDone = vi.fn()
      await streamChat(
        cfg,
        [{ role: "user", content: "hi" }],
        { onToken: vi.fn(), onDone, onError },
        undefined,
        {},
      )

      expect(onDone).toHaveBeenCalledTimes(1)
      expect(onError).not.toHaveBeenCalled()
    }
  })
})

// ===== Layer 5: web 分发(streamChat → streamViaServer)=====
// caps.platform==="web" 时走 fetch POST /api/v1/chat/stream + Authorization,
// 服务器自取 team provider,前端不持 key。本组用 vi.resetModules + 动态 import
// 让 caps/api-client mock 生效(顶层 vi.mock("./tauri-fetch") 对 web 路径无害)。
describe("streamChat web 分发", () => {
  it("web 走 streamViaServer(POST /chat/stream + Authorization)", async () => {
    vi.resetModules()
    vi.doMock("@/lib/capabilities", () => ({ caps: { platform: "web" } }))
    vi.doMock("@/lib/api-client", () => ({
      API_BASE: "",
      apiClient: { isAuthenticated: true, authHeaders: () => ({ Authorization: "Bearer tok" }) },
    }))

    const encoder = new TextEncoder()
    const sseBody = `data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: [DONE]\n\n`
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(encoder.encode(sseBody), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    )
    vi.stubGlobal("fetch", mockFetch)
    // string,模拟真实 web:handleProjectOpened 设 WikiProject.id=String(p.id) → __currentProjectId="9"
    vi.stubGlobal("window", { __currentProjectId: "9" })

    const { streamChat: streamChatWeb } = await import("./llm-client")
    const tokens: string[] = []
    const cb = {
      onToken: (t: string) => tokens.push(t),
      onDone: () => {},
      onError: (e: Error) => { throw e },
    }
    await streamChatWeb(
      { provider: "openai", apiKey: "x", model: "gpt-4o" } as any,
      [{ role: "user", content: "hi" }],
      cb,
    )

    expect(mockFetch).toHaveBeenCalled()
    const [url, init] = mockFetch.mock.calls[0]
    expect(url).toContain("/api/v1/chat/stream")
    expect((init as RequestInit).method).toBe("POST")
    expect(((init as RequestInit).headers as Record<string, string>)["Authorization"]).toBe("Bearer tok")
    // project_id 必须是 number(非 string):chat.rs as_i64 对字符串返回 None→unwrap_or(0)→4xx,
    // web 聊天失效。streamViaServer 发送前 Number() 转换(string "9" → number 9)。
    const reqBody = JSON.parse((init as RequestInit).body as string)
    expect(reqBody.project_id).toBe(9)
    expect(typeof reqBody.project_id).toBe("number")
    expect(tokens.join("")).toBe("Hi")

    vi.unstubAllGlobals()
    vi.doUnmock("@/lib/capabilities")
    vi.doUnmock("@/lib/api-client")
  })
})
