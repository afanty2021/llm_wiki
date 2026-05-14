import { describe, expect, it } from "vitest"
import { parseCodexCliLine } from "./codex-cli-transport"

describe("parseCodexCliLine", () => {
  it("extracts completed agent messages from Codex JSONL", () => {
    expect(
      parseCodexCliLine(
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "pong" },
        }),
      ),
    ).toBe("pong")
  })

  it("ignores lifecycle events and malformed lines", () => {
    expect(parseCodexCliLine('{"type":"turn.started"}')).toBeNull()
    expect(parseCodexCliLine("not json")).toBeNull()
  })
})
