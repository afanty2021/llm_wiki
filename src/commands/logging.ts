import { invoke } from "@tauri-apps/api/core";
import type { FrontendLogEntry, LogLevel, LogFileEntry, ReadLogResponse } from "@/lib/logger-types";

/** 批量发送日志到后端 */
export async function sendLog(logs: FrontendLogEntry[]): Promise<void> {
  return invoke("send_log", { logs });
}

/** 获取日志文件列表 */
export async function getLogFiles(): Promise<LogFileEntry[]> {
  return invoke("get_log_files");
}

/** 清理所有日志文件 */
export async function clearLogs(): Promise<void> {
  return invoke("clear_logs");
}

/** 导出日志 */
export async function exportLogs(days: number): Promise<string> {
  return invoke("export_logs", { days });
}

/** 获取日志级别 */
export async function getLogLevel(): Promise<LogLevel> {
  return invoke("get_log_level");
}

/** 设置日志级别 */
export async function setLogLevel(level: LogLevel): Promise<void> {
  return invoke("set_log_level", { level });
}

/** 分页读取日志（带级别/关键字/trace_id 过滤） */
export async function readLogFile(
  limit: number = 100,
  offset: number = 0,
  level?: LogLevel[],
  keyword?: string,
  traceId?: string,
): Promise<ReadLogResponse> {
  return invoke<ReadLogResponse>("read_log_file", {
    limit,
    offset,
    level,
    keyword,
    traceId,
  });
}
