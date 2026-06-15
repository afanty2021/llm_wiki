use serde::{Deserialize, Serialize};

/// 前端日志级别（大写，与 tracing 统一）
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "UPPERCASE")]
pub enum LogLevel {
    Debug,
    Info,
    Warn,
    Error,
}

/// 前端日志条目（通过 Tauri IPC 接收）
#[derive(Debug, Clone, Deserialize)]
pub struct FrontendLogEntry {
    pub timestamp: String,
    pub level: LogLevel,
    pub module: String,
    pub trace_id: String,
    pub message: String,
    #[serde(default)]
    pub data: Option<serde_json::Value>,
}

/// 日志文件信息
#[derive(Debug, Clone, Serialize)]
pub struct LogFileEntry {
    pub name: String,
    pub size: u64,
    pub modified: i64,
    pub is_current: bool,
}

/// 日志查看器展示的单条日志（从 JSONL 提取）
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct LogDisplayEntry {
    pub timestamp: String,
    pub level: String,
    pub module: String,
    pub message: String,
    pub trace_id: Option<String>,
}

/// read_log_file 命令的返回
#[derive(Debug, Clone, Serialize)]
pub struct ReadLogResponse {
    pub entries: Vec<LogDisplayEntry>,
    pub total: usize,
    pub offset: usize,
    pub limit: usize,
}

/// 转换 LogLevel 为 tracing Level
impl From<LogLevel> for tracing::Level {
    fn from(level: LogLevel) -> Self {
        match level {
            LogLevel::Debug => tracing::Level::DEBUG,
            LogLevel::Info => tracing::Level::INFO,
            LogLevel::Warn => tracing::Level::WARN,
            LogLevel::Error => tracing::Level::ERROR,
        }
    }
}