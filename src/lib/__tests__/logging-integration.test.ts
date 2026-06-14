import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { createLogger, initLogger, setLogLevel } from "../logger";
import { getLogLevel, setLogLevel as setLogLevelRpc } from "@/commands/logging";

// Tauri invoke mock (hoisted — vitest lifts this above all imports)
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

// Tauri event mock (hoisted — needed by initLogger's dynamic import of
// @tauri-apps/api/event in node environment)
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(vi.fn()),
}));

// The vitest config sets environment: "node", so no `window` global exists.
// initLogger() needs window.addEventListener("beforeunload", ...).
// Stub a minimal window before any describe/initLogger runs.
vi.stubGlobal("window", {
  addEventListener: vi.fn(),
});

describe("Logging Integration", () => {
  beforeEach(async () => {
    vi.useFakeTimers();

    // Default mock: get_log_level returns "WARN", send_log is a no-op
    vi.mocked(invoke).mockImplementation(async (cmd: string, _args?: object) => {
      if (cmd === "get_log_level") return "WARN";
      if (cmd === "send_log") return undefined;
      if (cmd === "set_log_level") return undefined;
      throw new Error(`Unknown command: ${cmd}`);
    });

    await initLogger();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    setLogLevel("DEBUG");
  });

  describe("Log level round-trip", () => {
    it("should read and write log level via RPC", async () => {
      // Arrange: mock get_log_level to return a different level
      vi.mocked(invoke).mockImplementation(async (cmd: string, _args?: object) => {
        if (cmd === "set_log_level") return undefined;
        if (cmd === "get_log_level") return "INFO";
        throw new Error(`Unknown command: ${cmd}`);
      });

      // Act: set via RPC
      await setLogLevelRpc("INFO");

      // Act: read back via RPC
      const level = await getLogLevel();
      expect(level).toBe("INFO");
    });
  });

  describe("Batch logging", () => {
    it("should batch multiple log messages and flush them", async () => {
      let sendLogCallCount = 0;
      const sentBatches: Array<{ logs: Array<{ level: string; message: string }> }> = [];

      vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
        if (cmd === "send_log") {
          sendLogCallCount++;
          sentBatches.push(args as { logs: Array<{ level: string; message: string }> });
          return undefined;
        }
        if (cmd === "get_log_level") return "DEBUG";
        throw new Error(`Unknown command: ${cmd}`);
      });

      setLogLevel("DEBUG");
      const logger = createLogger("integration-test");

      // Send enough messages to fill multiple batches (BATCH_CONFIG.maxSize = 10)
      for (let i = 0; i < 15; i++) {
        logger.info(`Batch test message ${i}`);
      }

      // The first 10 messages should trigger an immediate flush (maxSize reached),
      // then we need to advance timers for the remaining 5 to be flushed via debounce
      await vi.runAllTimersAsync();

      // Should have been called at least once
      expect(sendLogCallCount).toBeGreaterThan(0);

      // Total messages sent across all batches should equal 15
      const totalSent = sentBatches.reduce((sum, b) => sum + b.logs.length, 0);
      expect(totalSent).toBe(15);

      // Each sent log should have the expected level and format
      for (const batch of sentBatches) {
        for (const entry of batch.logs) {
          expect(entry.level).toBe("INFO");
          expect(entry.message).toMatch(/^Batch test message \d+$/);
        }
      }
    });
  });

  describe("Log level filtering", () => {
    it("should filter out messages below the configured level", async () => {
      let sendLogCallCount = 0;
      let sentLogs: Array<{ level: string; message: string }> = [];

      vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
        if (cmd === "send_log") {
          sendLogCallCount++;
          sentLogs = (args as { logs: Array<{ level: string; message: string }> }).logs;
          return undefined;
        }
        if (cmd === "get_log_level") return "WARN";
        throw new Error(`Unknown command: ${cmd}`);
      });

      // Set filter: only ERROR and above
      setLogLevel("ERROR");
      const logger = createLogger("integration-test");

      // These should ALL be filtered (below ERROR)
      logger.debug("debug message");
      logger.info("info message");
      logger.warn("warn message");

      // This should pass the filter
      logger.error("error message");

      // Advance timers to flush the batch
      await vi.runAllTimersAsync();

      // Only ERROR-level entries should have been sent
      expect(sendLogCallCount).toBe(1);
      expect(sentLogs).toHaveLength(1);
      expect(sentLogs[0].level).toBe("ERROR");
      expect(sentLogs[0].message).toBe("error message");
    });
  });
});
