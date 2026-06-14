import { invoke } from "@tauri-apps/api/core";
import type { FrontendLogEntry, LogLevel, Logger } from "./logger-types";

/** 全局日志级别缓存 */
let globalLogLevel: LogLevel = "WARN";

/** 批处理缓冲区 */
let batchBuffer: FrontendLogEntry[] = [];

/** 批处理定时器 */
let batchTimer: ReturnType<typeof setTimeout> | null = null;

/** 批处理配置 */
const BATCH_CONFIG = {
  debounceMs: 50,
  maxSize: 10,
};

/** 模块名称提取（从调用栈） */
function extractModule(): string {
  const stack = new Error().stack || "";
  const lines = stack.split("\n");
  // 跳过 Error、extractModule、logger 方法
  for (const line of lines.slice(3, 10)) {
    const match = line.match(/at\s+.*\((.+:\d+:\d+)\)/);
    if (match) {
      return match[1].split("/").slice(-2).join("/");
    }
  }
  return "unknown";
}

/** 级别检查 */
function shouldLog(level: LogLevel): boolean {
  const levels: LogLevel[] = ["DEBUG", "INFO", "WARN", "ERROR"];
  return levels.indexOf(level) >= levels.indexOf(globalLogLevel);
}

/** 刷新批处理缓冲区 */
async function flushBatch(): Promise<void> {
  if (batchBuffer.length === 0) return;

  const batch = [...batchBuffer];
  batchBuffer = [];

  if (batchTimer) {
    clearTimeout(batchTimer);
    batchTimer = null;
  }

  try {
    await invoke("send_log", { logs: batch });
  } catch (error) {
    // 静默丢弃，不影响业务逻辑
    console.error("[logger] Failed to send logs:", error);
  }
}

/** 添加日志到批处理缓冲区 */
function addToBatch(entry: FrontendLogEntry): void {
  batchBuffer.push(entry);

  if (batchBuffer.length >= BATCH_CONFIG.maxSize) {
    void flushBatch();
    return;
  }

  if (batchTimer) {
    clearTimeout(batchTimer);
  }

  batchTimer = setTimeout(() => {
    void flushBatch();
  }, BATCH_CONFIG.debounceMs);
}

/** 记录日志核心函数 */
function log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
  if (!shouldLog(level)) return;

  const entry: FrontendLogEntry = {
    timestamp: new Date().toISOString(),
    level,
    module: extractModule(),
    trace_id: (data?.trace_id as string) ?? crypto.randomUUID(),
    message,
    data,
  };

  // 控制台输出（开发模式）
  if (import.meta.env.DEV) {
    const consoleMethod: "debug" | "info" | "warn" | "error" =
      level === "DEBUG" ? "debug" : level.toLowerCase() as "info" | "warn" | "error";
    // eslint-disable-next-line no-console
    console[consoleMethod](`[${entry.module}]`, message, data ?? "");
  }

  addToBatch(entry);
}

/** 创建 Logger 实例 */
export function createLogger(_module: string): Logger {
  return {
    debug: (msg, data) => log("DEBUG", msg, data),
    info: (msg, data) => log("INFO", msg, data),
    warn: (msg, data) => log("WARN", msg, data),
    error: (msg, data) => log("ERROR", msg, data),
  };
}

/** 初始化 Logger */
export async function initLogger(): Promise<void> {
  try {
    const level = await invoke<string>("get_log_level");
    globalLogLevel = level as LogLevel;
  } catch {
    // 失败时默认为 WARN
    globalLogLevel = "WARN";
  }

  // 监听浏览器关闭事件
  window.addEventListener("beforeunload", () => {
    void flushBatch();
  });

  // 监听 Tauri 关闭请求事件（更可靠的关闭通知）
  try {
    const { listen } = await import("@tauri-apps/api/event");
    await listen("tauri://close-requested", async () => {
      await flushBatch();
    });
  } catch {
    // Tauri API 不可用时忽略（开发环境）
  }
}

/** 更新日志级别 */
export function setLogLevel(level: LogLevel): void {
  globalLogLevel = level;
}
