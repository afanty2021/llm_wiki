/** 日志级别枚举（大写，与后端统一） */
export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

/** 前端日志条目（通过 IPC 发送到后端） */
export interface FrontendLogEntry {
  /** ISO 8601 时间戳 */
  timestamp: string;
  /** 日志级别（大写） */
  level: LogLevel;
  /** 模块名称（如 "src/lib/ingest.ts"） */
  module: string;
  /** 请求追踪 ID（UUID v4，snake_case 与后端统一） */
  trace_id: string;
  /** 日志消息 */
  message: string;
  /** 额外数据字段 */
  data?: Record<string, unknown>;
}

/** Logger 接口 */
export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

/** Logger 配置选项 */
export interface LoggerOptions {
  /** 是否启用控制台输出（开发模式） */
  enableConsole?: boolean;
  /** 批处理 debounce 延迟（毫秒） */
  batchDebounce?: number;
  /** 批处理最大条数 */
  batchMaxSize?: number;
}

/** 日志文件信息（来自后端 get_log_files 命令） */
export interface LogFileEntry {
  /** 文件名 */
  name: string;
  /** 文件大小（字节） */
  size: number;
  /** 修改时间（Unix 秒） */
  modified: number;
  /** 是否为当前活跃日志文件 */
  is_current: boolean;
}