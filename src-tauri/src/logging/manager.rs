use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::{fmt, prelude::*, registry::Registry, EnvFilter, reload};

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
    /// 创建新的轮转 appender
    fn new(log_dir: &Path, base_name: &str, max_size_bytes: u64, max_files: usize) -> std::io::Result<Self> {
        std::fs::create_dir_all(log_dir)?;

        let current_path = log_dir.join(base_name);
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
    fn rotate_files(&self) -> std::io::Result<()> {
        // 删除最老的文件
        let oldest_path = self.log_dir.join(format!("{}.{}.log", self.base_name, self.max_files));
        let _ = std::fs::remove_file(&oldest_path); // 忽略不存在错误

        // 后移编号文件：.4.log → .5.log，.3.log → .4.log，...，.1.log → .2.log
        // 注意：从高到低遍历，避免覆盖（先移 .4→.5，再移 .3→.4，...）
        for i in (1..self.max_files).rev() {
            let old_name = self.log_dir.join(format!("{}.{}.log", self.base_name, i));
            let new_name = self.log_dir.join(format!("{}.{}.log", self.base_name, i + 1));
            let _ = std::fs::rename(&old_name, &new_name); // 文件不存在时静默忽略
        }

        // 当前文件重命名为 .1.log
        let current_path = self.log_dir.join(&self.base_name);
        let slot1_path = self.log_dir.join(format!("{}.1.log", self.base_name));
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
            let current_path = self.log_dir.join(&self.base_name);
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
pub fn init_logging(app_data_dir: PathBuf) -> Result<(), String> {
    let log_dir = app_data_dir.join("logs");

    // 创建日志目录
    std::fs::create_dir_all(&log_dir)
        .map_err(|e| format!("Failed to create log directory: {}", e))?;

    // 初始化日志级别（默认 WARN）
    LOG_LEVEL.set(Mutex::new("WARN".to_string()))
        .map_err(|_| "Failed to initialize LOG_LEVEL".to_string())?;

    // 创建基于大小轮转的文件 appender（10MB，保留5个文件）
    let file_appender = SizeBasedRollingFileAppender::new(
        &log_dir,
        "llm-wiki.log",
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
        );

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

/// 设置日志级别（立即生效，通过 reload handle）
pub fn set_log_level(level: String) -> Result<(), String> {
    // 更新全局级别变量
    if let Some(level_guard) = LOG_LEVEL.get() {
        if let Ok(mut guard) = level_guard.lock() {
            *guard = level.clone();
        }
    }

    // 通过 reload handle 实际更新 EnvFilter（立即生效）
    if let Some(handle) = FILTER_HANDLE.get() {
        let new_filter = EnvFilter::new(level);
        handle.reload(new_filter)
            .map_err(|e| format!("Failed to reload log filter: {}", e))?;
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
        let mut appender = SizeBasedRollingFileAppender::new(dir.path(), "llm-wiki.log", 100, 3)
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

        // 检查轮转文件：原始文件应被重命名为 llm-wiki.log.1.log
        // （base_name 包含 .log 后缀，轮转文件格式为 {base_name}.{N}.log）
        let rotated_path = dir.path().join("llm-wiki.log.1.log");
        assert!(rotated_path.exists(), "rotated file llm-wiki.log.1.log should exist");
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
