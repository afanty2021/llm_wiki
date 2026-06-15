import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { invokeTraced } from "../invoke-traced";

// Mock Tauri invoke
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

describe("invokeTraced", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("auto-generates a UUID v4 trace_id when none provided", async () => {
    const mockedInvoke = vi.mocked(invoke);
    mockedInvoke.mockResolvedValue("ok");

    await invokeTraced("read_file", { path: "/x" });

    const args = mockedInvoke.mock.calls[0];
    expect(args[0]).toBe("read_file");
    const passedArgs = args[1] as Record<string, unknown>;
    // trace_id 是合法 UUID v4 格式：8-4-4-4-12 hex
    expect(passedArgs.trace_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  it("passes through caller-provided trace_id", async () => {
    const mockedInvoke = vi.mocked(invoke);
    mockedInvoke.mockResolvedValue("ok");
    const callerTraceId = "11111111-2222-4333-8444-555555555555";

    await invokeTraced("read_file", { path: "/x", trace_id: callerTraceId });

    const passedArgs = mockedInvoke.mock.calls[0][1] as Record<string, unknown>;
    expect(passedArgs.trace_id).toBe(callerTraceId);
  });

  it("treats empty string trace_id as absent and generates a new one", async () => {
    const mockedInvoke = vi.mocked(invoke);
    mockedInvoke.mockResolvedValue("ok");

    await invokeTraced("read_file", { path: "/x", trace_id: "" });

    const passedArgs = mockedInvoke.mock.calls[0][1] as Record<string, unknown>;
    // 空串不应透传，应生成新 UUID
    expect(passedArgs.trace_id).not.toBe("");
    expect(passedArgs.trace_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  it("preserves other args alongside injected trace_id", async () => {
    const mockedInvoke = vi.mocked(invoke);
    mockedInvoke.mockResolvedValue(42);

    const result = await invokeTraced<number>("count", { path: "/x", deep: true });

    const passedArgs = mockedInvoke.mock.calls[0][1] as Record<string, unknown>;
    expect(passedArgs.path).toBe("/x");
    expect(passedArgs.deep).toBe(true);
    expect(passedArgs.trace_id).toBeDefined();
    expect(result).toBe(42);
  });

  it("works with no args at all", async () => {
    const mockedInvoke = vi.mocked(invoke);
    mockedInvoke.mockResolvedValue(null);

    await invokeTraced("ping");

    const passedArgs = mockedInvoke.mock.calls[0][1] as Record<string, unknown>;
    expect(passedArgs.trace_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });
});
