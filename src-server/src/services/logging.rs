//! src-server 日志系统：基于大小轮转的文件 appender + 日志查看/导出/清除/级别控制。
//!
//! 移植自 src-tauri/src/logging/manager.rs（含审计 #1/#3/#5/#6/#7/#8 修复），
//! 适配 src-server（无 Tauri AppHandle / 无 NotifyLayer / 无 app-state.json 持久化）。
//! 级别控制仅内存 + reload（重启回 ENV 默认）。
//!
//! 维护：核心逻辑（appender/轮转/reopen/extract）与 src-tauri 版保持同步；
//! 审计修复（#1/#3/#5/#6/#7/#8）须双向传播，勿使两实现漂移。

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use serde::Serialize;
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::{fmt, prelude::*, registry::Registry, EnvFilter, reload};

// ============================================================================
// 全局静态（单例，init_logging 一次性初始化）
// ============================================================================

/// 全局日志级别（运行时可通过 set_log_level 修改）
static LOG_LEVEL: OnceLock<Mutex<String>> = OnceLock::new();

/// EnvFilter 重载句柄（运行时级别控制）
static FILTER_HANDLE: OnceLock<reload::Handle<EnvFilter, Registry>> = OnceLock::new();

/// Worker Guard（必须保持存活到进程结束，否则丢未刷新日志）
static NORMAL_GUARD: OnceLock<WorkerGuard> = OnceLock::new();

/// 当前日志文件 base_name（不含扩展名）。init_logging 与 clear_logs 的 reopen 共用。
pub const LOG_BASE_NAME: &str = "llm-wiki";

/// clear_logs 触达 worker fd/size 的共享句柄（审计 #1 修复机制）。
/// init_logging 中、appender move 进 non_blocking 之前构造（clone 现有 Arc）。
#[derive(Clone)]
struct SharedHandle {
    current_file: Arc<Mutex<File>>,
    current_size: Arc<Mutex<u64>>,
}

static SHARED: OnceLock<SharedHandle> = OnceLock::new();

/// Mutex 中毒时的 io::Error 构造辅助
fn poison_err(e: impl std::fmt::Display) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::Other, e.to_string())
}

// ============================================================================
// 级别校验（迁移自 src-tauri logging/config.rs）
// ============================================================================

/// 合法日志级别校验（set_log_level 依赖）
pub fn is_valid_level(level: &str) -> bool {
    matches!(level, "DEBUG" | "INFO" | "WARN" | "ERROR")
}

// ============================================================================
// SizeBasedRollingFileAppender（基于大小轮转，移植自 src-tauri）
// ============================================================================

struct SizeBasedRollingFileAppender {
    log_dir: PathBuf,
    base_name: String,
    max_size_bytes: u64,
    max_files: usize,
    current_file: Arc<Mutex<File>>,
    current_size: Arc<Mutex<u64>>,
}

impl SizeBasedRollingFileAppender {
    /// 当前活跃日志文件路径：{log_dir}/{base_name}.log
    fn current_path(log_dir: &Path, base_name: &str) -> PathBuf {
        log_dir.join(format!("{}.log", base_name))
    }

    /// 轮转历史文件路径：{log_dir}/{base_name}.{n}.log
    fn rotated_path(log_dir: &Path, base_name: &str, n: usize) -> PathBuf {
        log_dir.join(format!("{}.{}.log", base_name, n))
    }

    fn new(log_dir: &Path, base_name: &str, max_size_bytes: u64, max_files: usize) -> std::io::Result<Self> {
        std::fs::create_dir_all(log_dir)?;
        let current_path = Self::current_path(log_dir, base_name);
        let (current_file, current_size) = Self::open_or_create_file(&current_path)?;
        Ok(Self {
            log_dir: log_dir.to_path_buf(),
            base_name: base_name.to_string(),
            max_size_bytes,
            max_files,
            current_file: Arc::new(Mutex::new(current_file)),
            current_size: Arc::new(Mutex::new(current_size)),
        })
    }

    /// 打开或创建当前日志文件（append 模式，返回文件 + 现有大小）
    fn open_or_create_file(path: &Path) -> std::io::Result<(File, u64)> {
        let file = OpenOptions::new().create(true).append(true).open(path)?;
        let size = file.metadata()?.len();
        Ok((file, size))
    }

    /// 执行文件轮转：删除最老 → 后移编号 → 当前重命名为 .1.log
    fn rotate_files(&self) -> std::io::Result<()> {
        let oldest_path = Self::rotated_path(&self.log_dir, &self.base_name, self.max_files);
        let _ = std::fs::remove_file(&oldest_path); // 忽略不存在

        for i in (1..self.max_files).rev() {
            let old_name = Self::rotated_path(&self.log_dir, &self.base_name, i);
            let new_name = Self::rotated_path(&self.log_dir, &self.base_name, i + 1);
            let _ = std::fs::rename(&old_name, &new_name); // 不存在时静默忽略
        }

        let current_path = Self::current_path(&self.log_dir, &self.base_name);
        let slot1_path = Self::rotated_path(&self.log_dir, &self.base_name, 1);
        let _ = std::fs::rename(&current_path, &slot1_path);
        Ok(())
    }
}

/// 实现 Write trait（tracing-appender non_blocking 要求 W: Write + Send + 'static）
impl Write for SizeBasedRollingFileAppender {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        // 检查是否需要轮转
        let should_rotate = {
            let mut size_guard = self.current_size.lock().map_err(poison_err)?;
            *size_guard += buf.len() as u64;
            *size_guard > self.max_size_bytes
        };

        if should_rotate {
            self.rotate_files()?;
            let current_path = Self::current_path(&self.log_dir, &self.base_name);
            let (new_file, new_size) = Self::open_or_create_file(&current_path)?;

            let mut file_guard = self.current_file.lock().map_err(poison_err)?;
            *file_guard = new_file;

            let mut size_guard = self.current_size.lock().map_err(poison_err)?;
            // 审计 #3：轮转后新文件已写入本次 buf，size 须计入 buf.len()
            *size_guard = new_size + buf.len() as u64;
        }

        let mut file_guard = self.current_file.lock().map_err(poison_err)?;
        file_guard.write_all(buf)?;
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        let mut file_guard = self.current_file.lock().map_err(poison_err)?;
        file_guard.flush()
    }
}

impl Clone for SizeBasedRollingFileAppender {
    fn clone(&self) -> Self {
        Self {
            log_dir: self.log_dir.clone(),
            base_name: self.base_name.clone(),
            max_size_bytes: self.max_size_bytes,
            max_files: self.max_files,
            current_file: Arc::clone(&self.current_file),
            current_size: Arc::clone(&self.current_size),
        }
    }
}

// ============================================================================
// reopen（clear_logs 根治幽灵文件，审计 #1 修复机制）
// ============================================================================

/// reopen 核心逻辑（纯函数，可测）：关闭并重建共享的当前日志 fd，重置 size。
///
/// **锁顺序严格 file→size**（与 Write::write 轮转路径一致，反序会死锁）。
/// 全程 `?` 传播，禁 unwrap/expect（持锁 panic 中毒 Mutex）。FS 操作锁外执行。
fn reopen_shared(handle: &SharedHandle, log_dir: &Path) -> std::io::Result<()> {
    let current_path = SizeBasedRollingFileAppender::current_path(log_dir, LOG_BASE_NAME);
    let _ = std::fs::remove_file(&current_path); // 容忍 ENOENT
    let (new_file, new_size) = SizeBasedRollingFileAppender::open_or_create_file(&current_path)?;
    let mut file_guard = handle.current_file.lock().map_err(poison_err)?;
    let mut size_guard = handle.current_size.lock().map_err(poison_err)?;
    *file_guard = new_file; // 旧 fd drop（unlinked inode 释放）
    *size_guard = new_size;
    Ok(())
}

// ============================================================================
// init_logging
// ============================================================================

/// 初始化日志系统（在 create_app 前调用，使启动期日志可写文件）。
///
/// - log_dir: 日志目录（config.log_dir）
/// - level: 初始级别（config.log_level，无效回退 INFO）
/// - max_size_bytes / max_files: 轮转参数
pub fn init_logging(
    log_dir: PathBuf,
    level: String,
    max_size_bytes: u64,
    max_files: usize,
) -> Result<(), String> {
    std::fs::create_dir_all(&log_dir)
        .map_err(|e| format!("Failed to create log directory: {}", e))?;

    let initial_level = if is_valid_level(&level) { level } else { "INFO".to_string() };
    LOG_LEVEL.set(Mutex::new(initial_level.clone()))
        .map_err(|_| "Failed to initialize LOG_LEVEL".to_string())?;

    let file_appender = SizeBasedRollingFileAppender::new(&log_dir, LOG_BASE_NAME, max_size_bytes, max_files)
        .map_err(|e| format!("Failed to create file appender: {}", e))?;

    // clone appender 的 current_file/current_size Arc 存全局（须在 move 进 non_blocking 之前）
    let _ = SHARED.set(SharedHandle {
        current_file: Arc::clone(&file_appender.current_file),
        current_size: Arc::clone(&file_appender.current_size),
    });

    let (normal_appender, normal_guard) = tracing_appender::non_blocking(file_appender);
    NORMAL_GUARD.set(normal_guard)
        .map_err(|_| "Failed to initialize NORMAL_GUARD".to_string())?;

    let (filter, reload_handle) = tracing_subscriber::reload::Layer::new(EnvFilter::new(initial_level));
    FILTER_HANDLE.set(reload_handle)
        .map_err(|_| "Failed to initialize FILTER_HANDLE".to_string())?;

    // debug：stdout 人类可读 + 文件 JSON；release：仅文件 JSON（审计 #2）
    let subscriber = Registry::default().with(filter);

    #[cfg(debug_assertions)]
    let subscriber = subscriber.with(
        fmt::layer()
            .with_writer(std::io::stdout)
            .with_target(true)
            .with_ansi(true),
    );

    let subscriber = subscriber.with(
        fmt::layer()
            .json()
            .with_writer(normal_appender)
            .with_target(true),
    );

    tracing::subscriber::set_global_default(subscriber)
        .map_err(|e| format!("Failed to set tracing subscriber: {}", e))?;

    Ok(())
}

// ============================================================================
// 级别控制（内存 + reload，无持久化）
// ============================================================================

pub fn get_log_level() -> String {
    LOG_LEVEL.get()
        .and_then(|l| l.lock().ok())
        .map(|g| g.clone())
        .unwrap_or_else(|| "INFO".to_string())
}

pub fn set_log_level(level: String) -> Result<(), String> {
    if !is_valid_level(&level) {
        return Err(format!("Invalid log level: {}", level));
    }
    if let Some(lg) = LOG_LEVEL.get() {
        if let Ok(mut g) = lg.lock() {
            *g = level.clone();
        }
    }
    if let Some(handle) = FILTER_HANDLE.get() {
        handle.reload(EnvFilter::new(level))
            .map_err(|e| format!("Failed to reload log filter: {}", e))?;
    }
    Ok(())
}

// ============================================================================
// 日志文件操作
// ============================================================================

/// 日志文件信息
#[derive(Debug, Clone, Serialize)]
pub struct LogFileEntry {
    pub name: String,
    pub size: u64,
    pub modified: i64,
    pub is_current: bool,
}

/// 判断日志文件名是否为当前活跃文件（精确匹配 {base}.log，审计 #7）
pub fn is_current_log(name: &str, base_name: &str) -> bool {
    name.strip_suffix(".log") == Some(base_name)
}

/// 获取日志文件列表
pub fn get_log_files(log_dir: PathBuf) -> Result<Vec<LogFileEntry>, String> {
    let mut entries = Vec::new();
    let entries_iter = std::fs::read_dir(&log_dir)
        .map_err(|e| format!("Failed to read log directory: {}", e))?;

    for entry in entries_iter {
        let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("log") {
            continue;
        }
        let metadata = std::fs::metadata(&path)
            .map_err(|e| format!("Failed to read metadata: {}", e))?;
        let name = path.file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("unknown")
            .to_string();
        let is_current = is_current_log(&name, LOG_BASE_NAME);
        entries.push(LogFileEntry {
            name,
            size: metadata.len(),
            modified: metadata
                .modified()
                .map_err(|e| format!("Failed to get modified time: {}", e))?
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|e| format!("Failed to convert time: {}", e))?
                .as_secs() as i64,
            is_current,
        });
    }
    entries.sort_by(|a, b| b.name.cmp(&a.name));
    Ok(entries)
}

/// 清理所有日志文件（ reopen 重建当前 fd，审计 #1 根治幽灵文件）
pub fn clear_logs(log_dir: PathBuf) -> Result<(), String> {
    let current_path = SizeBasedRollingFileAppender::current_path(&log_dir, LOG_BASE_NAME);

    // 删除所有 .log 历史文件，跳过当前（由 reopen 重建，避免双删）
    let entries = std::fs::read_dir(&log_dir)
        .map_err(|e| format!("Failed to read log directory: {}", e))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("log") {
            continue;
        }
        if path == current_path {
            continue;
        }
        std::fs::remove_file(&path)
            .map_err(|e| format!("Failed to remove log file: {}", e))?;
    }

    let handle = SHARED.get().ok_or("logging not initialized")?;
    reopen_shared(handle, &log_dir).map_err(|e| format!("Failed to reopen current log: {}", e))?;
    Ok(())
}

/// 导出日志为 JSONL（文件名含时分秒避免覆盖，按 mtime 升序拼接，审计 #5）。
/// 返回导出文件路径（handler 读内容返回下载，不直接返回路径给客户端）。
pub fn export_logs(log_dir: PathBuf, days: u32) -> Result<PathBuf, String> {
    let export_path = log_dir.join(format!("llm-wiki-export-{}.jsonl",
        chrono::Utc::now().format("%Y-%m-%d-%H%M%S")));

    let mut output = std::fs::File::create(&export_path)
        .map_err(|e| format!("Failed to create export file: {}", e))?;

    let cutoff_time = chrono::Utc::now() - chrono::Duration::days(days as i64);

    // 收集 .log 文件并按 mtime 升序（老→新）排序（审计 #5）
    let mut files: Vec<(PathBuf, std::time::SystemTime)> = Vec::new();
    for entry in std::fs::read_dir(&log_dir)
        .map_err(|e| format!("Failed to read log directory: {}", e))?
    {
        let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("log") {
            continue;
        }
        // 跳过导出文件自身（避免递归拼接历史导出）
        if path.file_name() == export_path.file_name() {
            continue;
        }
        let metadata = std::fs::metadata(&path)
            .map_err(|e| format!("Failed to read metadata: {}", e))?;
        let modified = metadata
            .modified()
            .map_err(|e| format!("Failed to get modified time: {}", e))?;
        files.push((path, modified));
    }
    files.sort_by(|a, b| a.1.cmp(&b.1));

    for (path, modified) in files {
        let modified_chrono = chrono::DateTime::<chrono::Utc>::from(modified);
        if modified_chrono < cutoff_time {
            continue;
        }
        let content = std::fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read log file: {}", e))?;
        output.write_all(content.as_bytes())
            .map_err(|e| format!("Failed to write export: {}", e))?;
    }

    output.flush().map_err(|e| format!("Failed to flush export: {}", e))?;
    Ok(export_path)
}

// ============================================================================
// read_log_file（日志查看器，分页/级别/关键字/trace_id 过滤）
// ============================================================================

/// 日志查看器展示的单条日志（从 JSONL 提取）
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct LogDisplayEntry {
    pub timestamp: String,
    pub level: String,
    pub module: String,
    pub message: String,
    pub trace_id: Option<String>,
}

/// read_log_file 返回
#[derive(Debug, Clone, Serialize)]
pub struct ReadLogResponse {
    pub entries: Vec<LogDisplayEntry>,
    pub total: usize,
    pub offset: usize,
    pub limit: usize,
}

const MAX_LOG_LIMIT: usize = 500;

pub fn read_log_file(
    log_dir: PathBuf,
    limit: usize,
    offset: usize,
    level_filter: Option<Vec<String>>,
    keyword: Option<String>,
    trace_id: Option<String>,
) -> Result<ReadLogResponse, String> {
    let limit = limit.min(MAX_LOG_LIMIT);

    // Collect *.log files sorted by mtime desc (current file first)
    let mut files: Vec<(PathBuf, std::time::SystemTime)> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&log_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) == Some("log") {
                if let Ok(meta) = path.metadata() {
                    if let Ok(mtime) = meta.modified() {
                        files.push((path, mtime));
                    }
                }
            }
        }
    }
    files.sort_by(|a, b| b.1.cmp(&a.1));

    let keyword = keyword.and_then(|k| {
        let trimmed = k.trim();
        if trimmed.is_empty() { None } else { Some(trimmed.to_lowercase()) }
    });
    let trace_id = trace_id.and_then(|t| {
        let trimmed = t.trim();
        if trimmed.is_empty() { None } else { Some(trimmed.to_string()) }
    });
    let level_set: Option<std::collections::HashSet<String>> = level_filter.map(|v| {
        v.into_iter().map(|s| s.to_uppercase()).collect()
    });

    let mut page: Vec<LogDisplayEntry> = Vec::new();
    let mut total: usize = 0;
    let need_end = offset + limit;

    for (path, _mtime) in &files {
        let content = match std::fs::read_to_string(path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        for line in content.lines().rev() {
            let line = line.trim();
            if line.is_empty() { continue; }
            let json: serde_json::Value = match serde_json::from_str(line) {
                Ok(v) => v,
                Err(_) => continue,
            };
            let entry = match extract_entry(&json) {
                Some(e) => e,
                None => continue,
            };
            if !matches_filter(&entry, &level_set, &keyword, &trace_id) { continue; }
            if total >= offset && total < need_end {
                page.push(entry);
            }
            total += 1;
        }
    }

    Ok(ReadLogResponse { entries: page, total, offset, limit })
}

/// 从单行 JSON 提取 LogDisplayEntry。
/// 审计 #6：前端日志优先 span.frontend_ts，后端日志回退顶层 timestamp。
fn extract_entry(json: &serde_json::Value) -> Option<LogDisplayEntry> {
    let timestamp = json.get("span")
        .and_then(|s| s.get("frontend_ts"))
        .and_then(|t| t.as_str())
        .or_else(|| json.get("timestamp").and_then(|t| t.as_str()))?
        .to_string();
    let level = json.get("level")?.as_str()?.to_string();
    let module = json.get("span")
        .and_then(|s| s.get("module")).and_then(|m| m.as_str())
        .map(|s| s.to_string())
        .or_else(|| {
            let target = json.get("target").and_then(|t| t.as_str());
            target.filter(|t| *t != "frontend").map(|s| s.to_string())
        })
        .unwrap_or_else(|| "(unknown)".to_string());
    let message = json.get("fields")
        .and_then(|f| f.get("message")).and_then(|m| m.as_str())
        .unwrap_or("(no message)").to_string();
    let trace_id = json.get("span")
        .and_then(|s| s.get("trace_id")).and_then(|t| t.as_str())
        .map(|s| s.to_string());
    Some(LogDisplayEntry { timestamp, level, module, message, trace_id })
}

fn matches_filter(
    entry: &LogDisplayEntry,
    level_set: &Option<std::collections::HashSet<String>>,
    keyword: &Option<String>,
    trace_id: &Option<String>,
) -> bool {
    if let Some(set) = level_set {
        if !set.contains(&entry.level.to_uppercase()) { return false; }
    }
    if let Some(tid) = trace_id {
        if entry.trace_id.as_deref() != Some(tid.as_str()) { return false; }
    }
    if let Some(kw) = keyword {
        let msg_lower = entry.message.to_lowercase();
        let mod_lower = entry.module.to_lowercase();
        if !msg_lower.contains(kw) && !mod_lower.contains(kw) { return false; }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;
    use tempfile::TempDir;

    /// 审计 #3：轮转后 current_size 须计入本次写入的 buf.len()
    #[test]
    fn rotate_size_includes_written_bytes() {
        let dir = TempDir::new().expect("temp dir");
        let mut appender = SizeBasedRollingFileAppender::new(dir.path(), "llm-wiki", 10, 3)
            .expect("appender");
        appender.write_all(b"hello").expect("write");
        assert_eq!(*appender.current_size.lock().unwrap(), 5);
        appender.write_all(b"0123456789").expect("write");
        assert_eq!(*appender.current_size.lock().unwrap(), 10);
    }

    /// 审计 #7：is_current_log 精确匹配，base_name 含数字也不误判
    #[test]
    fn is_current_log_matches_exact_name() {
        assert!(is_current_log("llm-wiki.log", "llm-wiki"));
        assert!(!is_current_log("llm-wiki.1.log", "llm-wiki"));
        assert!(is_current_log("app2.log", "app2"));
        assert!(!is_current_log("app2.1.log", "app2"));
    }

    /// 审计 #6：前端日志优先 span.frontend_ts，后端回退顶层 timestamp
    #[test]
    fn extract_entry_prefers_frontend_ts() {
        let json = serde_json::json!({
            "timestamp": "2026-06-30T12:00:00Z", "level": "INFO", "target": "frontend",
            "span": { "name": "frontend_log", "module": "src/x.ts", "trace_id": "t1",
                      "frontend_ts": "2026-06-30T12:00:01.123Z" },
            "fields": { "message": "hello" }
        });
        let entry = extract_entry(&json).expect("extract");
        assert_eq!(entry.timestamp, "2026-06-30T12:00:01.123Z");
        assert_eq!(entry.module, "src/x.ts");

        let json2 = serde_json::json!({
            "timestamp": "2026-06-30T12:00:00Z", "level": "INFO", "target": "ingest",
            "fields": { "message": "backend" }
        });
        let entry2 = extract_entry(&json2).expect("extract");
        assert_eq!(entry2.timestamp, "2026-06-30T12:00:00Z");
    }

    /// 审计 #1：clear_logs 删除历史 + reopen 重建当前 fd（无幽灵文件）
    #[test]
    fn clear_logs_deletes_files_and_reopens() {
        let dir = TempDir::new().expect("temp dir");
        let log_dir = dir.path().to_path_buf();

        for name in &["llm-wiki.log", "llm-wiki.1.log", "app.log", "other.txt"] {
            std::fs::write(log_dir.join(name), b"dummy").unwrap();
        }

        // set SHARED（模拟 init_logging 注入）。OnceLock 单例：set 容忍已初始化。
        let current_path = SizeBasedRollingFileAppender::current_path(&log_dir, LOG_BASE_NAME);
        let (file, size) = SizeBasedRollingFileAppender::open_or_create_file(&current_path)
            .expect("open current");
        let _ = SHARED.set(SharedHandle {
            current_file: Arc::new(Mutex::new(file)),
            current_size: Arc::new(Mutex::new(size)),
        });

        clear_logs(log_dir.clone()).expect("clear");

        let names: std::collections::HashSet<String> = std::fs::read_dir(&log_dir).unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert!(names.contains("other.txt"), "non-.log 保留");
        assert!(names.contains("llm-wiki.log"), "当前文件 reopen 重建");
        assert!(!names.contains("llm-wiki.1.log"), "历史删除");
        assert!(!names.contains("app.log"), "其他 .log 删除");

        let content = std::fs::read_to_string(log_dir.join("llm-wiki.log")).unwrap();
        assert_eq!(content, "", "reopen 重建为空");
    }

    /// 审计 #5：export 文件名唯一（时分秒）+ 按 mtime 升序拼接
    #[test]
    fn export_logs_unique_name_and_sorted() {
        let dir = TempDir::new().expect("temp dir");
        let log_dir = dir.path().to_path_buf();

        std::fs::write(log_dir.join("llm-wiki.2.log"), b"oldest\n").expect("w");
        std::thread::sleep(std::time::Duration::from_millis(60));
        std::fs::write(log_dir.join("llm-wiki.1.log"), b"middle\n").expect("w");
        std::thread::sleep(std::time::Duration::from_millis(60));
        std::fs::write(log_dir.join("llm-wiki.log"), b"newest\n").expect("w");

        let path1 = export_logs(log_dir.clone(), 30).expect("export");
        let name1 = path1.file_name().unwrap().to_string_lossy().to_string();
        assert!(name1.starts_with("llm-wiki-export-") && name1.ends_with(".jsonl"));
        assert!(name1.matches('-').count() >= 5);

        std::thread::sleep(std::time::Duration::from_secs(1));
        let path2 = export_logs(log_dir.clone(), 30).expect("export");
        assert_ne!(path1, path2, "同日多次导出文件名唯一");

        // path2 含三段（含 path1 那次产生的导出文件——它 .jsonl 非 .log，不被收集）
        let content = std::fs::read_to_string(&path2).expect("read");
        assert_eq!(content, "oldest\nmiddle\nnewest\n", "按 mtime 升序拼接");
    }

    #[test]
    fn is_valid_level_accepts_four_levels() {
        assert!(is_valid_level("DEBUG"));
        assert!(is_valid_level("INFO"));
        assert!(is_valid_level("WARN"));
        assert!(is_valid_level("ERROR"));
        assert!(!is_valid_level("TRACE"));
    }

    /// read_log_file 基本解析 + 级别过滤
    #[test]
    fn read_log_file_parses_and_filters() {
        let dir = TempDir::new().expect("temp dir");
        let log_dir = dir.path().to_path_buf();
        let line1 = r#"{"timestamp":"2026-06-30T10:00:00Z","level":"INFO","target":"svc","fields":{"message":"hi"}}"#;
        let line2 = r#"{"timestamp":"2026-06-30T10:00:01Z","level":"ERROR","target":"svc","fields":{"message":"boom"}}"#;
        std::fs::write(log_dir.join("llm-wiki.log"), format!("{}\n{}\n", line1, line2)).unwrap();

        // 无过滤：total=2
        let res = read_log_file(log_dir.clone(), 100, 0, None, None, None).unwrap();
        assert_eq!(res.total, 2);

        // 仅 ERROR
        let res = read_log_file(log_dir, 100, 0, Some(vec!["ERROR".into()]), None, None).unwrap();
        assert_eq!(res.total, 1);
        assert_eq!(res.entries[0].level, "ERROR");
    }
}
