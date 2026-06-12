/**
 * Unit coverage for `buildDedupLlmCall`. Mocks streamChat so we can
 * pin the request overrides it forwards — specifically that dedup
 * (like every other structured-output caller) disables thinking. A
 * reasoning-capable model left thinking-on burns its whole budget on
 * chain-of-thought and ends the stream with empty content, which on
 * the scan path runs silently to the 30-min backstop and surfaces as
 * a bare "Request cancelled".
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

// vi.mock is hoisted above imports; vi.hoisted keeps the fn out of the TDZ.
const { mockStreamChat } = vi.hoisted(() => ({ mockStreamChat: vi.fn() }))
vi.mock("./llm-client", async () => {
  const actual = await vi.importActual<typeof import("./llm-client")>("./llm-client")
  return { ...actual, streamChat: mockStreamChat }
})

import { buildDedupLlmCall } from "./dedup-runner"
import type { LlmConfig } from "@/stores/wiki-store"

const cfg: LlmConfig = {
  provider: "ollama",
  apiKey: "",
  model: "qwen3:8b",
  ollamaUrl: "http://localhost:11434",
  customEndpoint: "",
  apiMode: "chat_completions",
  maxContextSize: 8192,
}

beforeEach(() => {
  mockStreamChat.mockReset()
})

describe("buildDedupLlmCall", () => {
  it("disables thinking and caps output so reasoning models answer instead of streaming chain-of-thought to the backstop", async () => {
    mockStreamChat.mockImplementation(async (_c, _m, cb) => {
      cb.onToken('{"groups": []}')
      cb.onDone()
    })

    const call = buildDedupLlmCall(cfg, 8192)
    const out = await call("system prompt", "user message", undefined)
    expect(out).toBe('{"groups": []}')

    const overrides = mockStreamChat.mock.calls[0][4]
    expect(overrides).toMatchObject({
      temperature: 0.1,
      reasoning: { mode: "off" },
      max_tokens: 8192,
    })
  })

  it("forwards the caller's max_tokens budget (detection small, merge generous)", async () => {
    mockStreamChat.mockImplementation(async (_c, _m, cb) => cb.onDone())

    await buildDedupLlmCall(cfg, 32768)("s", "u", undefined)
    expect(mockStreamChat.mock.calls[0][4]).toMatchObject({ max_tokens: 32768 })
  })

  it("forces reasoning off even when the config requests a thinking mode", async () => {
    mockStreamChat.mockImplementation(async (_c, _m, cb) => cb.onDone())

    const reasoningCfg: LlmConfig = { ...cfg, reasoning: { mode: "high" } }
    await buildDedupLlmCall(reasoningCfg, 8192)("s", "u", undefined)

    expect(mockStreamChat.mock.calls[0][4]).toMatchObject({
      reasoning: { mode: "off" },
    })
  })

  it("forwards the abort signal through to streamChat", async () => {
    mockStreamChat.mockImplementation(async (_c, _m, cb) => cb.onDone())
    const controller = new AbortController()

    await buildDedupLlmCall(cfg, 8192)("s", "u", controller.signal)

    expect(mockStreamChat.mock.calls[0][3]).toBe(controller.signal)
  })

  it("rethrows when streamChat reports an error (no silent empty result)", async () => {
    mockStreamChat.mockImplementation(async (_c, _m, cb) => {
      cb.onError(new Error("HTTP 500: model unavailable"))
    })

    await expect(buildDedupLlmCall(cfg, 8192)("s", "u", undefined)).rejects.toThrow(
      /HTTP 500: model unavailable/,
    )
  })
})
