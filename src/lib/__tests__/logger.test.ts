import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { createLogger, setLogLevel } from "../logger";

// Mock Tauri invoke (hoisted; factory is self-contained, no external refs)
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

describe("Logger Facade", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    setLogLevel("DEBUG");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should create logger instance", () => {
    const logger = createLogger("test");
    expect(logger).toBeDefined();
    expect(typeof logger.debug).toBe("function");
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.warn).toBe("function");
    expect(typeof logger.error).toBe("function");
  });

  it("should respect log level filtering", async () => {
    const mockedInvoke = vi.mocked(invoke);
    mockedInvoke.mockResolvedValue(undefined);

    setLogLevel("WARN");
    const logger = createLogger("test");

    logger.debug("should not log");
    logger.info("should not log");
    logger.warn("should log");
    logger.error("should log");

    // Flush the debounced batch (50ms timer inside addToBatch)
    await vi.runAllTimersAsync();

    // DEBUG and INFO must be filtered before reaching the batch / invoke;
    // only WARN and ERROR entries should be sent through send_log.
    const calls = mockedInvoke.mock.calls.filter(
      (c) => c[0] === "send_log",
    );
    expect(calls).toHaveLength(1);

    const sentLogs = (calls[0]?.[1] as { logs: Array<{ level: string }> })
      .logs;
    const sentLevels = sentLogs.map((e) => e.level);
    expect(sentLevels).toEqual(["WARN", "ERROR"]);
    expect(sentLevels).not.toContain("DEBUG");
    expect(sentLevels).not.toContain("INFO");
  });

  it("should generate trace_id when not provided", () => {
    const logger = createLogger("test");
    const cryptoSpy = vi.spyOn(global.crypto, "randomUUID");

    logger.info("test message");

    expect(cryptoSpy).toHaveBeenCalled();
  });

  it("should use provided trace_id", () => {
    const logger = createLogger("test");
    const cryptoSpy = vi.spyOn(global.crypto, "randomUUID");

    logger.info("test message", { trace_id: "existing-id" });

    expect(cryptoSpy).not.toHaveBeenCalled();
  });
});
