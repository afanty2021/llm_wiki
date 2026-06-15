use std::collections::HashSet;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::AppHandle;
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::{fmt, prelude::*, registry::Registry, EnvFilter, reload};

use super::types::{LogDisplayEntry, ReadLogResponse};
use crate::logging::NotifyLayer;

// ============================================================================
// 全局静态变量
// ============================================================================

/// 全局日志级别（使用 OnceLock 进行安全的一次性初始化）
static LOG_LEVEL: OnceLock<Mutex<String>> = OnceLock::new();

/// 全局 EnvFilter 重载句柄（用于运行时级别控制）
static FILTER_HANDLE: OnceLock<reload::Handle<EnvFilter, Registry>> = OnceLock::new();

/// 全局 Worker Guard（必须保持存活以防止日志丢失）
/// 设计说明：原计划的「双 channel（normal + error）」因两个 appender 共享同一文件而无实际收益，
/// 已简化为单 channel。如未来需要 error 日志独立通道/文件，应让 error appender 写不同文件。
static NORMAL_GUARD: OnceLock<WorkerGuard> = OnceLock::new();

// ============================================================================
// SizeBasedRollingFileAppender（基于大小轮转的文件 appender）
// ============================================================================

/// 基于大小轮转的文件 appender（tracing-appender 仅支持时间轮转）
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

    /// 创建新的轮转 appender
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

    /// 打开或创建当前日志文件
    fn open_or_create_file(path: &Path) -> std::io::Result<(File, u64)> {
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)?;

        let metadata = file.metadata()?;
        let size = metadata.len();

        Ok((file, size))
    }

    /// 执行文件轮转
    /// 命名约定：当前文件 {base}.log，轮转历史 {base}.1.log、{base}.2.log、…
    fn rotate_files(&self) -> std::io::Result<()> {
        // 删除最老的文件 {base}.{max_files}.log
        let oldest_path = Self::rotated_path(&self.log_dir, &self.base_name, self.max_files);
        let _ = std::fs::remove_file(&oldest_path); // 忽略不存在错误

        // 后移编号文件：.{max-1}.log → .{max}.log，…，.1.log → .2.log
        // 从高到低遍历，避免覆盖（先移高编号，再移低编号）
        for i in (1..self.max_files).rev() {
            let old_name = Self::rotated_path(&self.log_dir, &self.base_name, i);
            let new_name = Self::rotated_path(&self.log_dir, &self.base_name, i + 1);
            let _ = std::fs::rename(&old_name, &new_name); // 文件不存在时静默忽略
        }

        // 当前文件 {base}.log 重命名为 {base}.1.log
        let current_path = Self::current_path(&self.log_dir, &self.base_name);
        let slot1_path = Self::rotated_path(&self.log_dir, &self.base_name, 1);
        let _ = std::fs::rename(&current_path, &slot1_path);

        Ok(())
    }
}

/// 实现 Write trait 用于 tracing-appender
impl Write for SizeBasedRollingFileAppender {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        // 检查是否需要轮转
        let should_rotate = {
            let mut size_guard = self.current_size.lock()
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
            *size_guard += buf.len() as u64;
            *size_guard > self.max_size_bytes
        };

        if should_rotate {
            self.rotate_files()?;

            // 创建新的当前文件
            let current_path = Self::current_path(&self.log_dir, &self.base_name);
            let (new_file, new_size) = Self::open_or_create_file(&current_path)?;

            let mut file_guard = self.current_file.lock()
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
            *file_guard = new_file;

            let mut size_guard = self.current_size.lock()
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
            *size_guard = new_size;
        }

        // 写入当前文件
        let mut file_guard = self.current_file.lock()
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
        file_guard.write_all(buf)?;
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        let mut file_guard = self.current_file.lock()
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
        file_guard.flush()
    }
}

/// Clone 实现（用于双 channel）
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
// init_logging（日志系统初始化）
// ============================================================================

/// 初始化日志系统
pub fn init_logging(app_data_dir: PathBuf, app_handle: AppHandle) -> Result<(), String> {
    let log_dir = app_data_dir.join("logs");

    // 创建日志目录
    std::fs::create_dir_all(&log_dir)
        .map_err(|e| format!("Failed to create log directory: {}", e))?;

    // 初始化日志级别：优先读取持久化配置（fallback WARN）
    let initial_level = crate::logging::config::read_log_level(&app_data_dir)
        .unwrap_or_else(|| "WARN".to_string());
    LOG_LEVEL.set(Mutex::new(initial_level))
        .map_err(|_| "Failed to initialize LOG_LEVEL".to_string())?;

    // 创建基于大小轮转的文件 appender（10MB，保留5个文件）
    // base_name 不含扩展名：当前文件 llm-wiki.log，轮转历史 llm-wiki.1.log、llm-wiki.2.log、…
    let file_appender = SizeBasedRollingFileAppender::new(
        &log_dir,
        "llm-wiki",
        10 * 1024 * 1024, // 10MB
        5, // 保留5个历史文件
    ).map_err(|e| format!("Failed to create file appender: {}", e))?;

    // 创建 NonBlocking channel（tracing-appender 异步写入，防止日志 IO 阻塞业务）
    let (normal_appender, normal_guard) = tracing_appender::non_blocking(file_appender);

    // 保存 worker guard（必须保持存活到进程结束，否则会丢失未刷新的日志）
    NORMAL_GUARD.set(normal_guard)
        .map_err(|_| "Failed to initialize NORMAL_GUARD (already initialized?)".to_string())?;

    // 读取初始日志级别
    let level = {
        let level_guard = LOG_LEVEL.get()
            .ok_or("LOG_LEVEL not initialized")?
            .lock()
            .map_err(|e| format!("Failed to lock LOG_LEVEL: {}", e))?;
        level_guard.clone()
    };

    // 构建 EnvFilter（支持运行时重载）
    let (filter, reload_handle) = tracing_subscriber::reload::Layer::new(
        EnvFilter::new(level)
    );

    // 保存重载句柄
    FILTER_HANDLE.set(reload_handle)
        .map_err(|_| "Failed to initialize FILTER_HANDLE".to_string())?;

    // 配置 subscriber（开发模式：控制台人类可读 + 文件JSON；生产模式：仅文件JSON）
    let subscriber = Registry::default()
        .with(filter)
        .with(
            fmt::layer()
                .with_writer(std::io::stdout)
                .with_target(true)
                .with_thread_ids(false)
                .with_ansi(cfg!(debug_assertions))
        )
        .with(
            fmt::layer()
                .json()
                .with_writer(normal_appender)
                .with_target(true)
        )
        .with(NotifyLayer::new(app_handle));

    tracing::subscriber::set_global_default(subscriber)
        .map_err(|e| format!("Failed to set tracing subscriber: {}", e))?;

    Ok(())
}

// ============================================================================
// 级别控制
// ============================================================================

/// 获取当前日志级别
pub fn get_log_level() -> String {
    LOG_LEVEL.get()
        .and_then(|level| level.lock().ok())
        .map(|level| level.clone())
        .unwrap_or_else(|| "WARN".to_string())
}

/// 设置日志级别（立即生效，通过 reload handle；并持久化到 app-state.json）
pub fn set_log_level(app_data_dir: PathBuf, level: String) -> Result<(), String> {
    // 校验级别（必须在内存更新前校验，避免脏数据）
    if !crate::logging::config::is_valid_level(&level) {
        return Err(format!("Invalid log level: {}", level));
    }
    // 更新全局级别变量
    if let Some(level_guard) = LOG_LEVEL.get() {
        if let Ok(mut guard) = level_guard.lock() {
            *guard = level.clone();
        }
    }

    // 通过 reload handle 实际更新 EnvFilter（立即生效）
    if let Some(handle) = FILTER_HANDLE.get() {
        let new_filter = EnvFilter::new(level.clone());
        handle.reload(new_filter)
            .map_err(|e| format!("Failed to reload log filter: {}", e))?;
    }

    // 持久化（失败不阻断主流程，仅记录警告）
    if let Err(e) = crate::logging::config::write_log_level(&app_data_dir, &level) {
        tracing::warn!(error = %e, "failed to persist log level to app-state.json");
    }

    Ok(())
}

// ============================================================================
// 日志文件操作
// ============================================================================

/// 获取日志文件列表
pub fn get_log_files(app_data_dir: PathBuf) -> Result<Vec<super::types::LogFileEntry>, String> {
    let log_dir = app_data_dir.join("logs");
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

        // 判断是否为当前活跃日志文件：无数字后缀（如 "llm-wiki.log"）
        let is_current = !name.chars().any(|c| c.is_ascii_digit());

        entries.push(super::types::LogFileEntry {
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

/// 清理所有日志文件
/// 注意：clear_logs 后文件会在下次写入时自动重建（tracing-appender 的 NonBlocking 特性）
pub fn clear_logs(app_data_dir: PathBuf) -> Result<(), String> {
    let log_dir = app_data_dir.join("logs");

    let entries = std::fs::read_dir(&log_dir)
        .map_err(|e| format!("Failed to read log directory: {}", e))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
        let path = entry.path();

        if path.extension().and_then(|s| s.to_str()) != Some("log") {
            continue;
        }

        std::fs::remove_file(&path)
            .map_err(|e| format!("Failed to remove log file: {}", e))?;
    }

    Ok(())
}

// ============================================================================
// 测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::TempDir;

    /// 测试：直接实例化 SizeBasedRollingFileAppender，写入验证（不经过 init_logging）
    #[test]
    fn test_log_file_creation_and_write() {
        let dir = TempDir::new().expect("should create temp dir");

        // 小 max_size_bytes 便于触发轮转
        // base_name 不含扩展名：当前文件 {base}.log，轮转 {base}.{N}.log
        let mut appender = SizeBasedRollingFileAppender::new(dir.path(), "llm-wiki", 100, 3)
            .expect("should create appender");

        // 写入数据
        let data = b"hello from test\n";
        let n = appender.write(data).expect("should write");
        assert_eq!(n, data.len());
        appender.flush().expect("should flush");

        // 验证文件存在且有内容
        let log_path = dir.path().join("llm-wiki.log");
        assert!(log_path.exists(), "log file should exist");
        let content = std::fs::read_to_string(&log_path).expect("should read log file");
        assert_eq!(content, "hello from test\n");

        // 写入超过 max_size_bytes 的数据触发轮转
        let big_data = "A".repeat(200);
        appender.write(big_data.as_bytes()).expect("should write big data");
        appender.flush().expect("should flush");

        // 检查轮转文件：原始文件 {base}.log 应被重命名为 {base}.1.log
        let rotated_path = dir.path().join("llm-wiki.1.log");
        assert!(rotated_path.exists(), "rotated file llm-wiki.1.log should exist");
        let rotated_content =
            std::fs::read_to_string(&rotated_path).expect("should read rotated file");
        assert_eq!(rotated_content, "hello from test\n");

        // 当前文件应包含新数据
        let current_content =
            std::fs::read_to_string(&log_path).expect("should read current file");
        assert_eq!(current_content, big_data);
    }

    /// 测试：clear_logs 删除 logs 目录下所有 .log 文件（不经过 init_logging）
    #[test]
    fn test_clear_logs_deletes_files() {
        let dir = TempDir::new().expect("should create temp dir");

        // clear_logs 期望 app_data_dir，内部会 join "logs"
        let logs_dir = dir.path().join("logs");
        std::fs::create_dir_all(&logs_dir).expect("should create logs dir");

        // 创建几个 .log 文件
        let log_files = ["llm-wiki.log", "llm-wiki.1.log", "app.log", "other.txt"];
        for name in &log_files {
            let path = logs_dir.join(name);
            std::fs::write(&path, b"dummy content").expect("should write dummy file");
        }

        // 调用 clear_logs
        clear_logs(dir.path().to_path_buf()).expect("should clear logs");

        // 验证 .log 文件被删除
        let remaining: Vec<_> = std::fs::read_dir(&logs_dir)
            .expect("should read logs dir")
            .filter_map(|e| e.ok())
            .collect();

        assert_eq!(
            remaining.len(),
            1,
            "only other.txt should remain, got: {:?}",
            remaining.iter().map(|e| e.file_name()).collect::<Vec<_>>()
        );

        let remaining_name = remaining[0].file_name();
        assert_eq!(
            remaining_name.to_str().unwrap(),
            "other.txt",
            "non-.log file should remain"
        );
    }

    // ========================================================================
    // read_log_file 测试辅助函数
    // ========================================================================

    fn write_test_log(path: &std::path::Path, lines: &[&str]) {
        let content = lines.join("\n") + "\n";
        std::fs::write(path, content).unwrap();
    }

    fn backend_log(ts: &str, level: &str, target: &str, msg: &str, trace_id: Option<&str>) -> String {
        let tid = match trace_id {
            Some(t) => format!(r#","span":{{"name":"cmd","trace_id":"{}"}}"#, t),
            None => String::new(),
        };
        format!(
            r#"{{"timestamp":"{}","level":"{}","target":"{}"{},"fields":{{"message":"{}"}}}}"#,
            ts, level, target, tid, msg
        )
    }

    fn frontend_log(ts: &str, level: &str, module: &str, msg: &str, trace_id: &str) -> String {
        format!(
            r#"{{"timestamp":"{}","level":"{}","target":"frontend","span":{{"name":"frontend_log","trace_id":"{}","module":"{}"}},"fields":{{"message":"{}"}}}}"#,
            ts, level, trace_id, module, msg
        )
    }

    // ========================================================================
    // read_log_file 测试
    // ========================================================================

    #[test]
    fn read_empty_dir_returns_empty() {
        let dir = tempfile::TempDir::new().unwrap();
        let logs_dir = dir.path().join("logs");
        std::fs::create_dir_all(&logs_dir).unwrap();
        let res = read_log_file(dir.path().to_path_buf(), 100, 0, None, None, None).unwrap();
        assert_eq!(res.entries.len(), 0);
        assert_eq!(res.total, 0);
    }

    #[test]
    fn read_missing_dir_returns_empty() {
        let dir = tempfile::TempDir::new().unwrap();
        let res = read_log_file(dir.path().to_path_buf(), 100, 0, None, None, None).unwrap();
        assert_eq!(res.entries.len(), 0);
        assert_eq!(res.total, 0);
    }

    #[test]
    fn basic_pagination() {
        let dir = tempfile::TempDir::new().unwrap();
        let logs_dir = dir.path().join("logs");
        std::fs::create_dir_all(&logs_dir).unwrap();
        let lines: Vec<String> = (0..10).map(|i| {
            backend_log(&format!("2026-06-15T10:00:{:02}Z", i), "INFO", "app", &format!("msg {}", i), None)
        }).collect();
        let line_refs: Vec<&str> = lines.iter().map(|s| s.as_str()).collect();
        write_test_log(&logs_dir.join("llm-wiki.log"), &line_refs);
        let p1 = read_log_file(dir.path().to_path_buf(), 5, 0, None, None, None).unwrap();
        assert_eq!(p1.entries.len(), 5);
        assert_eq!(p1.total, 10);
        assert_eq!(p1.entries[0].message, "msg 9");
        assert_eq!(p1.entries[4].message, "msg 5");
        let p2 = read_log_file(dir.path().to_path_buf(), 5, 5, None, None, None).unwrap();
        assert_eq!(p2.entries.len(), 5);
        assert_eq!(p2.entries[0].message, "msg 4");
    }

    #[test]
    fn offset_beyond_total_returns_empty() {
        let dir = tempfile::TempDir::new().unwrap();
        let logs_dir = dir.path().join("logs");
        std::fs::create_dir_all(&logs_dir).unwrap();
        write_test_log(&logs_dir.join("llm-wiki.log"), &[
            &backend_log("2026-06-15T10:00:00Z", "INFO", "app", "only", None),
        ]);
        let res = read_log_file(dir.path().to_path_buf(), 100, 100, None, None, None).unwrap();
        assert_eq!(res.entries.len(), 0);
        assert_eq!(res.total, 1);
    }

    #[test]
    fn level_filter() {
        let dir = tempfile::TempDir::new().unwrap();
        let logs_dir = dir.path().join("logs");
        std::fs::create_dir_all(&logs_dir).unwrap();
        write_test_log(&logs_dir.join("llm-wiki.log"), &[
            &backend_log("2026-06-15T10:00:00Z", "ERROR", "app", "e1", None),
            &backend_log("2026-06-15T10:00:01Z", "WARN", "app", "w1", None),
            &backend_log("2026-06-15T10:00:02Z", "INFO", "app", "i1", None),
        ]);
        let res = read_log_file(dir.path().to_path_buf(), 100, 0, Some(vec!["ERROR".into()]), None, None).unwrap();
        assert_eq!(res.entries.len(), 1);
        assert_eq!(res.entries[0].level, "ERROR");
        assert_eq!(res.total, 1);
    }

    #[test]
    fn keyword_search_case_insensitive() {
        let dir = tempfile::TempDir::new().unwrap();
        let logs_dir = dir.path().join("logs");
        std::fs::create_dir_all(&logs_dir).unwrap();
        write_test_log(&logs_dir.join("llm-wiki.log"), &[
            &backend_log("2026-06-15T10:00:00Z", "INFO", "ingest", "Failed to READ file", None),
            &backend_log("2026-06-15T10:00:01Z", "INFO", "app", "unrelated", None),
        ]);
        let res = read_log_file(dir.path().to_path_buf(), 100, 0, None, Some("read".into()), None).unwrap();
        assert_eq!(res.entries.len(), 1);
        assert!(res.entries[0].message.contains("READ"));
    }

    #[test]
    fn keyword_matches_module() {
        let dir = tempfile::TempDir::new().unwrap();
        let logs_dir = dir.path().join("logs");
        std::fs::create_dir_all(&logs_dir).unwrap();
        write_test_log(&logs_dir.join("llm-wiki.log"), &[
            &backend_log("2026-06-15T10:00:00Z", "INFO", "llm_wiki::commands::fs", "hello", None),
            &backend_log("2026-06-15T10:00:01Z", "INFO", "app", "world", None),
        ]);
        let res = read_log_file(dir.path().to_path_buf(), 100, 0, None, Some("commands".into()), None).unwrap();
        assert_eq!(res.entries.len(), 1);
        assert_eq!(res.entries[0].module, "llm_wiki::commands::fs");
    }

    #[test]
    fn trace_id_exact_match() {
        let dir = tempfile::TempDir::new().unwrap();
        let logs_dir = dir.path().join("logs");
        std::fs::create_dir_all(&logs_dir).unwrap();
        write_test_log(&logs_dir.join("llm-wiki.log"), &[
            &backend_log("2026-06-15T10:00:00Z", "INFO", "app", "a", Some("aaa-111")),
            &backend_log("2026-06-15T10:00:01Z", "INFO", "app", "b", Some("bbb-222")),
        ]);
        let res = read_log_file(dir.path().to_path_buf(), 100, 0, None, None, Some("bbb-222".into())).unwrap();
        assert_eq!(res.entries.len(), 1);
        assert_eq!(res.entries[0].trace_id, Some("bbb-222".into()));
    }

    #[test]
    fn frontend_log_module_extraction() {
        let dir = tempfile::TempDir::new().unwrap();
        let logs_dir = dir.path().join("logs");
        std::fs::create_dir_all(&logs_dir).unwrap();
        write_test_log(&logs_dir.join("llm-wiki.log"), &[
            &frontend_log("2026-06-15T10:00:00Z", "INFO", "src/lib/ingest.ts", "ingest done", "tid-1"),
        ]);
        let res = read_log_file(dir.path().to_path_buf(), 100, 0, None, None, None).unwrap();
        assert_eq!(res.entries.len(), 1);
        assert_eq!(res.entries[0].module, "src/lib/ingest.ts");
        assert_eq!(res.entries[0].trace_id, Some("tid-1".into()));
    }

    #[test]
    fn invalid_jsonl_line_skipped() {
        let dir = tempfile::TempDir::new().unwrap();
        let logs_dir = dir.path().join("logs");
        std::fs::create_dir_all(&logs_dir).unwrap();
        write_test_log(&logs_dir.join("llm-wiki.log"), &[
            &backend_log("2026-06-15T10:00:00Z", "INFO", "app", "valid", None),
            "this is not json {{{",
            &backend_log("2026-06-15T10:00:01Z", "INFO", "app", "also valid", None),
        ]);
        let res = read_log_file(dir.path().to_path_buf(), 100, 0, None, None, None).unwrap();
        assert_eq!(res.entries.len(), 2);
        assert_eq!(res.total, 2);
    }

    #[test]
    fn limit_clamped_to_max() {
        let dir = tempfile::TempDir::new().unwrap();
        let logs_dir = dir.path().join("logs");
        std::fs::create_dir_all(&logs_dir).unwrap();
        write_test_log(&logs_dir.join("llm-wiki.log"), &[
            &backend_log("2026-06-15T10:00:00Z", "INFO", "app", "x", None),
        ]);
        let res = read_log_file(dir.path().to_path_buf(), 10000, 0, None, None, None).unwrap();
        assert_eq!(res.limit, 500);
    }
}

/// 导出日志为 JSONL
pub fn export_logs(app_data_dir: PathBuf, days: u32) -> Result<String, String> {
    let log_dir = app_data_dir.join("logs");
    let export_path = app_data_dir.join(format!("llm-wiki-export-{}.jsonl",
        chrono::Utc::now().format("%Y-%m-%d")));

    let mut output = std::fs::File::create(&export_path)
        .map_err(|e| format!("Failed to create export file: {}", e))?;

    let cutoff_time = chrono::Utc::now() - chrono::Duration::days(days as i64);

    let entries = std::fs::read_dir(&log_dir)
        .map_err(|e| format!("Failed to read log directory: {}", e))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
        let path = entry.path();

        if path.extension().and_then(|s| s.to_str()) != Some("log") {
            continue;
        }

        let metadata = std::fs::metadata(&path)
            .map_err(|e| format!("Failed to read metadata: {}", e))?;

        let modified = metadata
            .modified()
            .map_err(|e| format!("Failed to get modified time: {}", e))?;

        let modified_chrono = chrono::DateTime::<chrono::Utc>::from(modified);

        if modified_chrono < cutoff_time {
            continue;
        }

        let content = std::fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read log file: {}", e))?;

        output.write_all(content.as_bytes())
            .map_err(|e| format!("Failed to write export: {}", e))?;
    }

    Ok(export_path.to_str()
        .ok_or("Export path is not valid UTF-8")?
        .to_string())
}

// ============================================================================
// read_log_file（日志查看器读取，支持分页 / 级别 / 关键字 / trace_id 过滤）
// ============================================================================

const MAX_LOG_LIMIT: usize = 500;

pub fn read_log_file(
    app_data_dir: PathBuf,
    limit: usize,
    offset: usize,
    level_filter: Option<Vec<String>>,
    keyword: Option<String>,
    trace_id: Option<String>,
) -> Result<ReadLogResponse, String> {
    let limit = limit.min(MAX_LOG_LIMIT);
    let log_dir = app_data_dir.join("logs");

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

    // Normalize: empty string = None
    let keyword = keyword.and_then(|k| {
        let trimmed = k.trim();
        if trimmed.is_empty() { None } else { Some(trimmed.to_lowercase()) }
    });
    let trace_id = trace_id.and_then(|t| {
        let trimmed = t.trim();
        if trimmed.is_empty() { None } else { Some(trimmed.to_string()) }
    });
    let level_set: Option<HashSet<String>> = level_filter.map(|v| {
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

fn extract_entry(json: &serde_json::Value) -> Option<LogDisplayEntry> {
    let timestamp = json.get("timestamp")?.as_str()?.to_string();
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
    level_set: &Option<HashSet<String>>,
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
