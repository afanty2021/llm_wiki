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

/// 当前日志文件 base_name（不含扩展名）。init_logging 与 clear_logs 的 reopen 共用，
/// 消除两处硬编码分歧（否则 init 改名后 reopen 会重建错误路径 → 幽灵 bug 复现）。
const LOG_BASE_NAME: &str = "llm-wiki";

/// clear_logs 触达 worker fd/size 的共享句柄。init_logging 中、appender move 进
/// non_blocking 之前构造（clone 现有 Arc）。合并 file+size 为单结构体，消除「file 设了
/// size 没设」的非法中间态，且让 get/set 各一次。
/// 不可存 appender 本体——non_blocking take ownership move 进 worker，且
/// Arc<Mutex<Appender>> 不 impl Write（见 FIX-PLAN 方案 B）。
#[derive(Clone)]
struct SharedHandle {
    current_file: Arc<Mutex<File>>,
    current_size: Arc<Mutex<u64>>,
}

static SHARED: OnceLock<SharedHandle> = OnceLock::new();

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
            // 轮转后新文件已写入本次 buf，size 须计入 buf.len()（审计 #3：原仅 = new_size 漏算）
            *size_guard = new_size + buf.len() as u64;
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
        LOG_BASE_NAME,
        10 * 1024 * 1024, // 10MB
        5, // 保留5个历史文件
    ).map_err(|e| format!("Failed to create file appender: {}", e))?;

    // clone appender 的 current_file / current_size Arc 存入全局（须在 move 进 non_blocking 之前），
    // 让 clear_logs 的 reopen 能触达 worker 线程持有的 fd 与 size。clone 与 appender 共享同一组 Arc。
    let _ = SHARED.set(SharedHandle {
        current_file: Arc::clone(&file_appender.current_file),
        current_size: Arc::clone(&file_appender.current_size),
    });

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

    // 配置 subscriber（开发模式：控制台人类可读 + 文件JSON；生产模式：仅文件JSON）。
    // stdout layer 用 #[cfg(debug_assertions)] 条件添加——release 编译期移除整层（审计 #2）。
    let subscriber = Registry::default()
        .with(filter);

    #[cfg(debug_assertions)]
    let subscriber = subscriber.with(
        fmt::layer()
            .with_writer(std::io::stdout)
            .with_target(true)
            .with_thread_ids(false)
            .with_ansi(true),
    );

    let subscriber = subscriber
        .with(
            fmt::layer()
                .json()
                .with_writer(normal_appender)
                .with_target(true),
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

        // 判断是否为当前活跃日志文件：精确匹配 {base}.log（审计 #7：原数字启发式脆弱）
        let is_current = is_current_log(&name, LOG_BASE_NAME);

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

/// 判断日志文件名是否为当前活跃文件（精确匹配 {base}.log）。
///
/// 审计 #7：原 `!name.chars().any(|c| c.is_ascii_digit())` 启发式在 base_name 含数字时
/// 误判（如 base "llm-wiki2"）。改为 strip 后缀比较 stem，精确且无分配。
fn is_current_log(name: &str, base_name: &str) -> bool {
    name.strip_suffix(".log") == Some(base_name)
}

/// reopen 核心逻辑（纯函数，可测）：关闭并重建共享的当前日志 fd，重置 size。
///
/// 测试可直接构造 SharedHandle（Arc::clone 注入点），绕开 AppHandle 与全局 subscriber，
/// 真正复现「appender 持 fd 时 reopen」场景。
///
/// **锁顺序严格 file→size**（与 Write::write 轮转路径一致，反序会死锁，worker 停摆）。
/// 全程 `?` 传播错误，禁 unwrap/expect——持锁期 panic 会中毒 Mutex，worker 后续每次
/// lock 失败而静默丢全部日志。FS 操作（remove/open）在锁外执行，仅赋值时持锁，
/// 缩短 worker 停顿窗口。
fn reopen_shared(handle: &SharedHandle, log_dir: &Path) -> std::io::Result<()> {
    let current_path = SizeBasedRollingFileAppender::current_path(log_dir, LOG_BASE_NAME);
    // remove 当前路径（容忍 ENOENT：clear 可能已删，或首启未建）——锁外
    let _ = std::fs::remove_file(&current_path);
    // 重建空文件（create+append）——锁外
    let (new_file, new_size) = SizeBasedRollingFileAppender::open_or_create_file(&current_path)?;
    // 锁顺序 file→size（与轮转路径一致），仅赋值持锁
    let mut file_guard = handle.current_file.lock()
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
    let mut size_guard = handle.current_size.lock()
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
    *file_guard = new_file; // 旧 fd drop（unlinked inode 释放）
    *size_guard = new_size; // 新文件 size（通常 0）
    Ok(())
}

/// 清理所有日志文件。
///
/// 删除所有 .log 历史文件（跳过当前，由 reopen 处理，避免双删），再通过 reopen 重建
/// 当前文件 fd。关键：appender 的 fd 在 NonBlocking worker 线程内，直接 remove_file 会让
/// fd 指向 unlinked inode（幽灵文件，审计 #1）。reopen 通过全局共享 Arc 替换 worker 的 fd，
/// 使新日志写进重建后的可见文件，根治幽灵文件 + 磁盘泄漏，三平台一致。
pub fn clear_logs(app_data_dir: PathBuf) -> Result<(), String> {
    let log_dir = app_data_dir.join("logs");
    let current_path = SizeBasedRollingFileAppender::current_path(&log_dir, LOG_BASE_NAME);

    // 1. 删除所有 .log 历史文件，跳过当前（由 reopen 重建 fd，避免双删）
    let entries = std::fs::read_dir(&log_dir)
        .map_err(|e| format!("Failed to read log directory: {}", e))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("log") {
            continue;
        }
        if path == current_path {
            continue; // 留给 reopen，避免重复 remove
        }
        std::fs::remove_file(&path)
            .map_err(|e| format!("Failed to remove log file: {}", e))?;
    }

    // 2. reopen 当前文件：通过共享 Arc 替换 worker fd，根治幽灵文件
    let handle = SHARED.get().ok_or("logging not initialized")?;
    reopen_shared(handle, &log_dir).map_err(|e| format!("Failed to reopen current log: {}", e))?;

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

    /// 测试：clear_logs 删除所有 .log 历史文件，并通过 reopen 重建当前文件 fd。
    /// 须先初始化全局共享句柄（模拟 init_logging 注入）——clear_logs 依赖它触达 worker fd。
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

        // 初始化全局共享句柄（模拟 init_logging），指向当前 llm-wiki.log。
        // OnceLock 单例：set 容忍已初始化（并行测试下可能被先 set，无妨——reopen 以 log_dir 为准）。
        let current_path = logs_dir.join("llm-wiki.log");
        let (file, size) = SizeBasedRollingFileAppender::open_or_create_file(&current_path)
            .expect("should open current log");
        let _ = SHARED.set(SharedHandle {
            current_file: Arc::new(Mutex::new(file)),
            current_size: Arc::new(Mutex::new(size)),
        });

        // 调用 clear_logs
        clear_logs(dir.path().to_path_buf()).expect("should clear logs");

        // 验证：历史/其他 .log 被删，llm-wiki.log 被 reopen 重建（空），other.txt 保留
        let names: std::collections::HashSet<String> = std::fs::read_dir(&logs_dir)
            .expect("should read logs dir")
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();

        assert!(names.contains("other.txt"), "non-.log file should remain");
        assert!(names.contains("llm-wiki.log"), "current log should be recreated by reopen");
        assert!(!names.contains("llm-wiki.1.log"), "rotated history should be deleted");
        assert!(!names.contains("app.log"), "other .log file should be deleted");

        // reopen 重建的当前文件为空
        let content = std::fs::read_to_string(logs_dir.join("llm-wiki.log"))
            .expect("should read recreated log");
        assert_eq!(content, "", "recreated current log should be empty");
    }

    /// 测试：reopen_shared 关闭并重建 fd，复现「appender 持 fd 时 clear」盲区。
    /// 直接 Arc::clone 构造共享句柄（模拟 init_logging 注入点），绕开 AppHandle + 全局 subscriber。
    #[test]
    fn reopen_shared_replaces_fd_and_resets_size() {
        let dir = TempDir::new().expect("should create temp dir");
        let log_dir = dir.path();

        // 构造与 init_logging 相同的共享句柄
        let current_path = SizeBasedRollingFileAppender::current_path(log_dir, LOG_BASE_NAME);
        let (file, size) = SizeBasedRollingFileAppender::open_or_create_file(&current_path)
            .expect("should open_or_create");
        let handle = SharedHandle {
            current_file: Arc::new(Mutex::new(file)),
            current_size: Arc::new(Mutex::new(size)),
        };

        // 写入数据到当前文件（模拟 worker 写日志）
        {
            let mut f = handle.current_file.lock().expect("lock file");
            f.write_all(b"old data\n").expect("should write");
        }
        *handle.current_size.lock().expect("lock size") += b"old data\n".len() as u64;
        assert_eq!(*handle.current_size.lock().expect("lock size"), 9);

        // reopen：关旧 fd → remove → 重建空文件 → size=0
        reopen_shared(&handle, log_dir).expect("reopen should succeed");

        // size 归零
        assert_eq!(*handle.current_size.lock().expect("lock size"), 0);

        // 重建后文件为空（旧数据随旧 fd 的 unlinked inode 释放）
        let content = std::fs::read_to_string(&current_path).expect("should read");
        assert_eq!(content, "");

        // 新 fd 可继续写入（验证 fd 有效，非幽灵）
        {
            let mut f = handle.current_file.lock().expect("lock file");
            f.write_all(b"new data\n").expect("should write");
        }
        let content = std::fs::read_to_string(&current_path).expect("should read");
        assert_eq!(content, "new data\n");
    }

    /// 审计 #3：轮转后 current_size 须计入本次写入的 buf.len()（原仅 = new_size 漏算）。
    #[test]
    fn rotate_size_includes_written_bytes() {
        let dir = TempDir::new().expect("should create temp dir");
        // max_size=10：写入累计 >10 即触发轮转
        let mut appender = SizeBasedRollingFileAppender::new(dir.path(), "llm-wiki", 10, 3)
            .expect("should create appender");

        // 写 5 字节：不轮转，size=5
        appender.write_all(b"hello").expect("write");
        assert_eq!(*appender.current_size.lock().unwrap(), 5);

        // 写 10 字节：size 先 +=10=15 > 10 触发轮转；轮转后 size 须 = new_size(0) + 10
        appender.write_all(b"0123456789").expect("write");
        assert_eq!(
            *appender.current_size.lock().unwrap(),
            10,
            "轮转后 size 须计入本次 buf.len()"
        );
    }

    /// 审计 #7：is_current_log 精确匹配 {base}.log，base_name 含数字也不误判。
    #[test]
    fn is_current_log_matches_exact_name() {
        assert!(is_current_log("llm-wiki.log", "llm-wiki"));
        assert!(!is_current_log("llm-wiki.1.log", "llm-wiki"));
        assert!(!is_current_log("llm-wiki.2.log", "llm-wiki"));
        // base_name 含数字（原数字启发式会误判，精确匹配不受影响）
        assert!(is_current_log("app2.log", "app2"));
        assert!(!is_current_log("app2.1.log", "app2"));
    }

    /// 审计 #6：前端日志优先 span.frontend_ts，后端日志回退顶层 timestamp。
    #[test]
    fn extract_entry_prefers_frontend_ts() {
        // 前端日志：span 含 frontend_ts
        let json = serde_json::json!({
            "timestamp": "2026-06-29T12:00:00Z",
            "level": "INFO",
            "target": "frontend",
            "span": { "name": "frontend_log", "module": "src/lib/ingest.ts",
                      "trace_id": "t1", "frontend_ts": "2026-06-29T12:00:01.123Z" },
            "fields": { "message": "hello" }
        });
        let entry = extract_entry(&json).expect("should extract");
        assert_eq!(entry.timestamp, "2026-06-29T12:00:01.123Z");
        assert_eq!(entry.module, "src/lib/ingest.ts");
        assert_eq!(entry.trace_id.as_deref(), Some("t1"));

        // 后端日志：无 frontend_ts，回退顶层 timestamp
        let json2 = serde_json::json!({
            "timestamp": "2026-06-29T12:00:00Z",
            "level": "INFO",
            "target": "ingest",
            "fields": { "message": "backend" }
        });
        let entry2 = extract_entry(&json2).expect("should extract");
        assert_eq!(entry2.timestamp, "2026-06-29T12:00:00Z");
    }

    /// 审计 #5：同日多次导出文件名唯一（含时分秒）+ 按 mtime 升序拼接（老→新）。
    #[test]
    fn export_logs_unique_name_and_sorted() {
        let dir = TempDir::new().expect("should create temp dir");
        let logs_dir = dir.path().join("logs");
        std::fs::create_dir_all(&logs_dir).expect("create logs dir");

        // 三个文件，sleep 区分 mtime（现代 FS 纳秒粒度足够）：.2.log 最老，.log 最新
        std::fs::write(logs_dir.join("llm-wiki.2.log"), b"oldest\n").expect("write oldest");
        std::thread::sleep(std::time::Duration::from_millis(60));
        std::fs::write(logs_dir.join("llm-wiki.1.log"), b"middle\n").expect("write middle");
        std::thread::sleep(std::time::Duration::from_millis(60));
        std::fs::write(logs_dir.join("llm-wiki.log"), b"newest\n").expect("write newest");

        let path1 = export_logs(dir.path().to_path_buf(), 30).expect("export should succeed");
        let name1 = std::path::Path::new(&path1)
            .file_name().unwrap().to_string_lossy().to_string();
        assert!(name1.starts_with("llm-wiki-export-") && name1.ends_with(".jsonl"));
        // 含时分秒：YYYY-MM-DD-HHMMSS（至少 5 个 '-' 分隔段）
        assert!(name1.matches('-').count() >= 5, "文件名须含时分秒段");

        // 跨秒再导出：文件名唯一不覆盖
        std::thread::sleep(std::time::Duration::from_secs(1));
        let path2 = export_logs(dir.path().to_path_buf(), 30).expect("export should succeed");
        assert_ne!(path1, path2, "同日多次导出文件名须唯一");

        // 排序：老→新
        let content = std::fs::read_to_string(&path2).expect("read export");
        assert_eq!(content, "oldest\nmiddle\nnewest\n", "按 mtime 升序拼接");
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
    // 文件名含时分秒，避免同日多次导出覆盖（审计 #5）
    let export_path = app_data_dir.join(format!("llm-wiki-export-{}.jsonl",
        chrono::Utc::now().format("%Y-%m-%d-%H%M%S")));

    let mut output = std::fs::File::create(&export_path)
        .map_err(|e| format!("Failed to create export file: {}", e))?;

    let cutoff_time = chrono::Utc::now() - chrono::Duration::days(days as i64);

    // 收集 .log 文件并按 mtime 升序（老→新）排序，保证导出按时间顺序（审计 #5）
    let mut files: Vec<(PathBuf, std::time::SystemTime)> = Vec::new();
    for entry in std::fs::read_dir(&log_dir)
        .map_err(|e| format!("Failed to read log directory: {}", e))?
    {
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
    // 前端日志优先用 span.frontend_ts（router 注入的前端原始时间，审计 #6）；
    // 后端日志无此 span 字段，回退 tracing 顶层 timestamp（wall-clock）。
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
