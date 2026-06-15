# 日志系统阶段 3 批次 B 实施计划（read_log_file + 应用内日志查看器）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐 `read_log_file` 命令（分页读取 JSONL 日志，带级别/关键字/trace_id 过滤）并构建集成在 Settings 的 LogsSection 查看器 UI。

**Architecture:** Task 1 在 `manager.rs` 用 TDD 实现 `read_log_file`（逻辑反序：逐文件读全部行 → `.rev()` → 解析过滤 → 历史文件提前终止）+ `ReadLogResponse` 类型。Task 2 注册 Tauri 命令（async fn + spawn_blocking）+ 前端封装与类型。Task 3 构建 LogsSection UI。Task 4 注册到 settings-view。Task 5 验证。

**Tech Stack:** Rust（tracing JSONL 解析, serde_json, tempfile 测试）、TypeScript/React 19（Vitest, shadcn/ui）。

**参考设计:** `docs/superpowers/specs/2026-06-15-logging-phase3-batchB-design.md` (v0.1.0)

**分支:** `log-system`

**工程决策（偏离设计 §4.5）**：设计文档的"物理反序 seek 读取"需手写 UTF-8 边界安全的反序读取器（30-80 行，易错）。本计划改用**逻辑反序**——`fs::read_to_string` 读当前文件全部行 → `.lines().rev()` → 解析过滤。理由：日志单文件最大 10MB，全读 <200ms；历史文件在收集够 `offset+limit` 后跳过遍历（仍提前终止）。避免 UTF-8 多字节边界 bug，可靠性优先。性能对桌面应用诊断工具足够（设计 §9 也认可 60MB <1s）。

---

## File Structure

### 新建文件
- `src/components/settings/sections/logs-section.tsx` —— LogsSection 查看器组件
- `docs/superpowers/tests/2026-06-15-logging-phase3-batchB-validation.md` —— 验证文档

### 修改文件
- `src-tauri/src/logging/types.rs` —— 新增 `ReadLogResponse`、`LogDisplayEntry`
- `src-tauri/src/logging/manager.rs` —— 新增 `read_log_file` 函数 + 测试
- `src-tauri/src/logging/mod.rs` —— 导出新类型
- `src-tauri/src/lib.rs` —— 注册 `read_log_file` 命令
- `src/commands/logging.ts` —— 新增 `readLogFile` 封装
- `src/lib/logger-types.ts` —— 新增前端类型
- `src/components/settings/settings-view.tsx` —— 注册 LogsSection
- `src/i18n/zh.json` / `en.json` —— 新增 logs section 文案

---

## Task 1: 后端 read_log_file + 类型 + 测试（TDD）

**Files:**
- Modify: `src-tauri/src/logging/types.rs`
- Modify: `src-tauri/src/logging/manager.rs`
- Modify: `src-tauri/src/logging/mod.rs`

- [ ] **Step 1: 新增类型定义（types.rs）**

在 `src-tauri/src/logging/types.rs` 末尾追加：

```rust
/// 日志查看器展示的单条日志（从 JSONL 提取）
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct LogDisplayEntry {
    /// ISO 8601 时间戳
    pub timestamp: String,
    /// 日志级别（大写）
    pub level: String,
    /// 模块：前端日志取 span.module，后端日志取 target，后备 "(unknown)"
    pub module: String,
    /// 日志消息正文
    pub message: String,
    /// 请求追踪 ID（阶段 2 起有；旧日志为 None）
    pub trace_id: Option<String>,
}

/// read_log_file 命令的返回
#[derive(Debug, Clone, Serialize)]
pub struct ReadLogResponse {
    /// 当前页的日志条目（时间降序）
    pub entries: Vec<LogDisplayEntry>,
    /// 符合筛选条件的总条数
    pub total: usize,
    /// 当前偏移量
    pub offset: usize,
    /// 每页条数
    pub limit: usize,
}
```

- [ ] **Step 2: mod.rs 导出新类型**

修改 `src-tauri/src/logging/mod.rs` 的 types 导出行。原：
```rust
pub use types::{FrontendLogEntry, LogLevel, LogFileEntry};
```
改为：
```rust
pub use types::{FrontendLogEntry, LogDisplayEntry, LogLevel, LogFileEntry, ReadLogResponse};
```

- [ ] **Step 3: 写失败测试**

在 `src-tauri/src/logging/manager.rs` 的 `#[cfg(test)] mod tests` 中追加测试（在现有 tests mod 内）。首先在 tests mod 顶部加一个辅助函数生成测试日志文件：

```rust
        /// 写入若干 JSONL 测试日志行到指定文件。
        /// 每行是一个 tracing JSON fmt 输出格式的简化版。
        fn write_test_log(path: &std::path::Path, lines: &[&str]) {
            let content = lines.join("\n") + "\n";
            std::fs::write(path, content).unwrap();
        }

        /// 构造一行后端日志 JSONL（target = Rust 模块路径）
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

        /// 构造一行前端日志 JSONL（target = "frontend"，module 在 span fields）
        fn frontend_log(ts: &str, level: &str, module: &str, msg: &str, trace_id: &str) -> String {
            format!(
                r#"{{"timestamp":"{}","level":"{}","target":"frontend","span":{{"name":"frontend_log","trace_id":"{}","module":"{}"}},"fields":{{"message":"{}"}}}}"#,
                ts, level, trace_id, module, msg
            )
        }
```

然后追加测试用例（在 tests mod 内，辅助函数之后）：

```rust
        #[test]
        fn read_empty_dir_returns_empty() {
            let dir = tempfile::TempDir::new().unwrap();
            let logs_dir = dir.path().join("logs");
            std::fs::create_dir_all(&logs_dir).unwrap();
            // 目录存在但无 .log 文件
            let res = read_log_file(dir.path().to_path_buf(), 100, 0, None, None, None).unwrap();
            assert_eq!(res.entries.len(), 0);
            assert_eq!(res.total, 0);
        }

        #[test]
        fn read_missing_dir_returns_empty() {
            // logs 目录不存在（应用未运行过）
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

            // 第一页：最新 5 条（降序），即 msg 9..5
            let p1 = read_log_file(dir.path().to_path_buf(), 5, 0, None, None, None).unwrap();
            assert_eq!(p1.entries.len(), 5);
            assert_eq!(p1.total, 10);
            assert_eq!(p1.entries[0].message, "msg 9"); // 最新在前
            assert_eq!(p1.entries[4].message, "msg 5");

            // 第二页：offset 5
            let p2 = read_log_file(dir.path().to_path_buf(), 5, 5, None, None, None).unwrap();
            assert_eq!(p2.entries.len(), 5);
            assert_eq!(p2.entries[0].message, "msg 4");
            assert_eq!(p2.entries[4].message, "msg 0");
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
            assert_eq!(res.total, 1); // total 不变
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
            // keyword "read" 大小写不敏感，应匹配 "Failed to READ file"
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
            assert_eq!(res.entries[0].message, "b");
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
            // 前端日志：module 取自 span.module，不是 target("frontend")
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
            assert_eq!(res.entries.len(), 2); // 非_json 行被跳过
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
            // limit=10000 应被 clamp 到 500
            let res = read_log_file(dir.path().to_path_buf(), 10000, 0, None, None, None).unwrap();
            assert_eq!(res.limit, 500);
        }
```

- [ ] **Step 4: 运行测试确认失败**

Run: `cd src-tauri && cargo test logging::manager::tests::read_ 2>&1 | tail -15`
Expected: FAIL — `cannot find function read_log_file`（函数未实现）。

- [ ] **Step 5: 实现 read_log_file**

在 `src-tauri/src/logging/manager.rs` 中（`export_logs` 函数之后）添加：

```rust
use super::types::{LogDisplayEntry, ReadLogResponse};

/// read_log_file 的最大每页条数（前端 limit 超出时 clamp）
const MAX_LOG_LIMIT: usize = 500;

/// 分页读取日志文件（逻辑反序：逐文件读全部行 → reverse → 解析过滤）。
///
/// 读取策略：收集 logs/ 下所有 *.log 文件按修改时间降序，逐文件读取全部行
/// 并反序遍历，每行解析 JSONL 提取字段，应用过滤条件，收集够 offset+limit
/// 条后停止遍历历史文件。详见设计文档 §4.5。
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

    // 收集 *.log 文件，按修改时间降序（当前文件在前）
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

    // 规范化过滤参数：空字符串视为 None
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

    let mut all_matched: Vec<LogDisplayEntry> = Vec::new();
    let need = offset + limit; // 收集到此数量即可停止遍历历史文件

    for (path, _mtime) in &files {
        // 当前文件（最新）必须全读才能拿最新条目；历史文件在收集够后跳过
        if all_matched.len() >= need {
            break;
        }

        let content = match std::fs::read_to_string(path) {
            Ok(c) => c,
            Err(_) => continue, // 文件可能被轮转删除，跳过
        };

        // 逻辑反序：行反序遍历（最新行先处理）
        for line in content.lines().rev() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            // 解析 JSONL，失败则跳过（容忍非 JSON 行）
            let json: serde_json::Value = match serde_json::from_str(line) {
                Ok(v) => v,
                Err(_) => continue,
            };

            let entry = match extract_entry(&json) {
                Some(e) => e,
                None => continue,
            };

            // 应用过滤
            if !matches_filter(&entry, &level_set, &keyword, &trace_id) {
                continue;
            }

            all_matched.push(entry);

            if all_matched.len() >= need {
                break; // 当前文件内收集够，提前终止
            }
        }
    }

    let total = all_matched.len();
    // all_matched 已是时间降序（每文件内行反序 + 文件按 mtime 降序）
    // 跳过 offset，取 limit 条
    let page: Vec<LogDisplayEntry> = all_matched
        .into_iter()
        .skip(offset)
        .take(limit)
        .collect();

    Ok(ReadLogResponse {
        entries: page,
        total,
        offset,
        limit,
    })
}

/// 从单行 JSONL 提取展示字段。失败返回 None（缺关键字段）。
fn extract_entry(json: &serde_json::Value) -> Option<LogDisplayEntry> {
    let timestamp = json.get("timestamp")?.as_str()?.to_string();
    let level = json.get("level")?.as_str()?.to_string();

    // module 提取：① span.module（前端）② target != "frontend"（后端）③ "(unknown)"
    let module = json
        .get("span")
        .and_then(|s| s.get("module"))
        .and_then(|m| m.as_str())
        .map(|s| s.to_string())
        .or_else(|| {
            let target = json.get("target").and_then(|t| t.as_str());
            target.filter(|t| *t != "frontend").map(|s| s.to_string())
        })
        .unwrap_or_else(|| "(unknown)".to_string());

    // message：fields.message，后备 "(no message)"
    let message = json
        .get("fields")
        .and_then(|f| f.get("message"))
        .and_then(|m| m.as_str())
        .unwrap_or("(no message)")
        .to_string();

    // trace_id：span.trace_id（可能不存在）
    let trace_id = json
        .get("span")
        .and_then(|s| s.get("trace_id"))
        .and_then(|t| t.as_str())
        .map(|s| s.to_string());

    Some(LogDisplayEntry {
        timestamp,
        level,
        module,
        message,
        trace_id,
    })
}

/// 判断条目是否匹配过滤条件。
fn matches_filter(
    entry: &LogDisplayEntry,
    level_set: &Option<std::collections::HashSet<String>>,
    keyword: &Option<String>,
    trace_id: &Option<String>,
) -> bool {
    if let Some(set) = level_set {
        if !set.contains(&entry.level.to_uppercase()) {
            return false;
        }
    }
    if let Some(tid) = trace_id {
        if entry.trace_id.as_deref() != Some(tid.as_str()) {
            return false;
        }
    }
    if let Some(kw) = keyword {
        // 大小写不敏感：message 或 module 含关键字
        let msg_lower = entry.message.to_lowercase();
        let mod_lower = entry.module.to_lowercase();
        if !msg_lower.contains(kw) && !mod_lower.contains(kw) {
            return false;
        }
    }
    true
}
```

> 注：`use super::types::{LogDisplayEntry, ReadLogResponse};` 若与文件顶部现有 import 冲突，合并到现有 use 行。`use std::collections::HashSet;` 若顶部已有则不重复。

- [ ] **Step 6: 运行测试确认通过**

Run: `cd src-tauri && cargo test logging::manager::tests 2>&1 | tail -20`
Expected: 全部测试通过（含新增 10 个 read_* 测试 + 现有测试）。

- [ ] **Step 7: 编译验证**

Run: `cd src-tauri && cargo check 2>&1 | grep -E "^error" | head`
Expected: 0 error。（`read_log_file` 未被 lib.rs 引用可能有 dead_code 警告，Task 2 注册后消失。）

- [ ] **Step 8: 提交**

```bash
git add src-tauri/src/logging/types.rs src-tauri/src/logging/manager.rs src-tauri/src/logging/mod.rs
git commit -m "feat(logging): implement read_log_file with JSONL parsing + filtering

Paginated log read with level/keyword/trace_id filters. Logical reverse
(read lines then .rev()) instead of physical reverse-seek to avoid UTF-8
boundary bugs. Module field fallback: span.module → target≠frontend →
\"(unknown)\". 10 unit tests covering pagination, filters, cross-file,
invalid JSONL skip, limit clamp.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: Tauri 命令注册 + 前端封装 + 类型

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/commands/logging.ts`
- Modify: `src/lib/logger-types.ts`

- [ ] **Step 1: lib.rs 注册 read_log_file 命令**

READ `src-tauri/src/lib.rs`。在现有日志命令区（`export_logs` 函数之后，约第 170 行附近）添加命令函数：

```rust
#[tauri::command]
async fn read_log_file(
    app: tauri::AppHandle,
    limit: usize,
    offset: usize,
    level: Option<Vec<String>>,
    keyword: Option<String>,
    trace_id: Option<String>,
) -> Result<logging::ReadLogResponse, String> {
    let app_data_dir = app.path().app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {}", e))?;
    // spawn_blocking：文件扫描是阻塞 I/O，移到 tokio 阻塞线程池。
    tauri::async_runtime::spawn_blocking(move || {
        logging::read_log_file(app_data_dir, limit, offset, level, keyword, trace_id)
    })
    .await
    .map_err(|e| format!("read_log_file task join error: {e}"))?
}
```

然后在 `generate_handler!` 数组中（现有 `export_logs,` 之后）追加 `read_log_file,`。

- [ ] **Step 2: 编译验证**

Run: `cd src-tauri && cargo check 2>&1 | grep -E "^error" | head`
Expected: 0 error。

- [ ] **Step 3: 前端类型定义（logger-types.ts）**

在 `src/lib/logger-types.ts` 末尾追加：

```typescript
/** 日志查看器展示的单条日志 */
export interface LogDisplayEntry {
  timestamp: string;
  level: LogLevel;
  module: string;
  message: string;
  trace_id: string | null;
}

/** read_log_file 命令的返回 */
export interface ReadLogResponse {
  entries: LogDisplayEntry[];
  total: number;
  offset: number;
  limit: number;
}
```

- [ ] **Step 4: 前端封装（logging.ts）**

在 `src/commands/logging.ts` 末尾追加（注意 import `ReadLogResponse` 类型）：

```typescript
import type { ReadLogResponse } from "@/lib/logger-types"

// ... 现有封装 ...

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
  })
}
```

> 注：`logging.ts` 顶部已有 `import type { ... LogLevel ... } from "@/lib/logger-types"`，确认 `ReadLogResponse` 加入该 import 行。若顶部用单独 import 行，按现有风格添加。

- [ ] **Step 5: 类型检查**

Run: `npm run typecheck 2>&1 | grep -iE "logging\.ts|logger-types" | head`
Expected: 0 新错误。

- [ ] **Step 6: 提交**

```bash
git add src-tauri/src/lib.rs src/commands/logging.ts src/lib/logger-types.ts
git commit -m "feat(logging): register read_log_file command + frontend wrappers

async fn + spawn_blocking for blocking file I/O. Frontend readLogFile()
wrapper + ReadLogResponse/LogDisplayEntry types.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: LogsSection UI 组件

**Files:**
- Create: `src/components/settings/sections/logs-section.tsx`

- [ ] **Step 1: 创建 LogsSection 组件**

创建 `src/components/settings/sections/logs-section.tsx`：

```tsx
import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { RefreshCw, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { readLogFile } from "@/commands/logging"
import { createLogger } from "@/lib/logger"
import type { LogDisplayEntry, LogLevel } from "@/lib/logger-types"

const logger = createLogger("logs-section")

const ALL_LEVELS: LogLevel[] = ["DEBUG", "INFO", "WARN", "ERROR"]
const DEFAULT_LEVELS: LogLevel[] = ["ERROR", "WARN", "INFO"] // DEBUG default off
const PAGE_SIZE = 100

/**
 * In-app log viewer. Paginated, with level toggle chips, keyword search,
 * and trace_id filter. ERROR rows highlighted.
 *
 * Fetches from backend read_log_file (server-side filtering + pagination).
 */
export function LogsSection() {
  const { t } = useTranslation()
  const [entries, setEntries] = useState<LogDisplayEntry[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [levels, setLevels] = useState<LogLevel[]>(DEFAULT_LEVELS)
  const [keyword, setKeyword] = useState("")
  const [traceId, setTraceId] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  const loadLogs = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      // 4 个级别全选时等效于不传 level（后端 None = 全通过）
      const levelFilter = levels.length < ALL_LEVELS.length ? levels : undefined
      const res = await readLogFile(
        PAGE_SIZE,
        page * PAGE_SIZE,
        levelFilter,
        keyword.trim() || undefined,
        traceId.trim() || undefined,
      )
      setEntries(res.entries)
      setTotal(res.total)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
      logger.error("Failed to load logs", { error: msg })
    } finally {
      setLoading(false)
    }
  }, [page, levels, keyword, traceId])

  useEffect(() => {
    void loadLogs()
  }, [loadLogs])

  const toggleLevel = (lvl: LogLevel) => {
    setLevels((prev) =>
      prev.includes(lvl)
        ? prev.filter((l) => l !== lvl)
        : [...prev, lvl],
    )
    setPage(0)
  }

  // 搜索/trace_id 输入变更时重置到第一页
  const onKeywordChange = (v: string) => { setKeyword(v); setPage(0) }
  const onTraceIdChange = (v: string) => { setTraceId(v); setPage(0) }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-medium">{t("settings.logs.title")}</h3>
        <p className="text-sm text-muted-foreground">{t("settings.logs.description")}</p>
      </div>

      {/* 过滤栏 */}
      <div className="space-y-2">
        <div className="flex flex-wrap gap-2">
          {ALL_LEVELS.map((lvl) => {
            const active = levels.includes(lvl)
            return (
              <button
                key={lvl}
                type="button"
                onClick={() => toggleLevel(lvl)}
                aria-pressed={active}
                className={`rounded-md border px-3 py-1 text-xs font-medium transition-colors ${
                  active
                    ? levelChipActiveClass(lvl)
                    : "border-border text-muted-foreground hover:bg-accent"
                }`}
              >
                {lvl}
              </button>
            )
          })}
        </div>
        <div className="flex gap-2">
          <Input
            placeholder={t("settings.logs.searchPlaceholder")}
            value={keyword}
            onChange={(e) => onKeywordChange(e.target.value)}
            className="flex-1"
          />
          <Input
            placeholder="trace_id"
            value={traceId}
            onChange={(e) => onTraceIdChange(e.target.value)}
            className="flex-1"
          />
          <Button variant="outline" size="icon" onClick={() => void loadLogs()} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </Button>
        </div>
      </div>

      {/* 日志列表 */}
      {error ? (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          {t("settings.logs.loadError")}: {error}
        </div>
      ) : loading && entries.length === 0 ? (
        <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> {t("settings.logs.loading")}
        </div>
      ) : entries.length === 0 ? (
        <div className="py-8 text-center text-sm text-muted-foreground">
          {t("settings.logs.empty")}
        </div>
      ) : (
        <div className="max-h-[480px] overflow-auto rounded-md border">
          <table className="w-full text-xs">
            <tbody>
              {entries.map((e, i) => (
                <tr
                  key={i}
                  className={`border-b last:border-0 ${e.level === "ERROR" ? "bg-destructive/10" : ""}`}
                >
                  <td className="whitespace-nowrap px-2 py-1 font-mono text-muted-foreground">
                    {formatTime(e.timestamp)}
                  </td>
                  <td className={`whitespace-nowrap px-2 py-1 font-semibold ${levelTextClass(e.level)}`}>
                    {e.level}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1 font-mono text-muted-foreground">
                    {e.module}
                  </td>
                  <td className="px-2 py-1 break-all">{e.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 分页栏 */}
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">
          {t("settings.logs.total", { count: total })}
        </span>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0 || loading}
          >
            {t("settings.logs.prev")}
          </Button>
          <span className="text-muted-foreground">
            {page + 1} / {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            disabled={page >= totalPages - 1 || loading}
          >
            {t("settings.logs.next")}
          </Button>
        </div>
      </div>
    </div>
  )
}

/** 级别 chip 激活时的背景色 */
function levelChipActiveClass(lvl: LogLevel): string {
  switch (lvl) {
    case "ERROR": return "border-destructive bg-destructive/10 text-destructive"
    case "WARN": return "border-yellow-500 bg-yellow-500/10 text-yellow-700 dark:text-yellow-400"
    case "INFO": return "border-blue-500 bg-blue-500/10 text-blue-700 dark:text-blue-400"
    case "DEBUG": return "border-border bg-accent text-foreground"
  }
}

/** 级别文字颜色 */
function levelTextClass(lvl: LogLevel): string {
  switch (lvl) {
    case "ERROR": return "text-destructive"
    case "WARN": return "text-yellow-700 dark:text-yellow-400"
    case "INFO": return "text-blue-700 dark:text-blue-400"
    case "DEBUG": return "text-muted-foreground"
  }
}

/** "2026-06-15T10:00:01.123Z" → "10:00:01" */
function formatTime(iso: string): string {
  // 取时间部分（T 之后，. 之前）
  const tIdx = iso.indexOf("T")
  if (tIdx < 0) return iso
  const timePart = iso.slice(tIdx + 1)
  const dotIdx = timePart.indexOf(".")
  return dotIdx < 0 ? timePart : timePart.slice(0, dotIdx)
}
```

> 注：组件依赖 `@/components/ui/input`（确认存在，阶段 1 ui 清单有 input.tsx）。`Button`、`Label` 已存在。

- [ ] **Step 2: 类型检查**

Run: `npm run typecheck 2>&1 | grep -iE "logs-section" | head`
Expected: 0 新错误。

- [ ] **Step 3: 提交**

```bash
git add src/components/settings/sections/logs-section.tsx
git commit -m "feat(logging): add LogsSection in-app log viewer

Level toggle chips, keyword search, trace_id filter, pagination,
ERROR row highlight. Fetches via readLogFile (server-side filtering).

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: settings-view 注册 + i18n

**Files:**
- Modify: `src/components/settings/settings-view.tsx`
- Modify: `src/i18n/zh.json`
- Modify: `src/i18n/en.json`

- [ ] **Step 1: settings-view.tsx 注册 LogsSection**

READ `src/components/settings/settings-view.tsx`，做 4 处修改：

**(a) CategoryId 类型**（约第 50-65 行）：在 `"maintenance"` 后追加 `"logs"`：
```typescript
  | "maintenance"
  | "logs"
  | "changelog"
  | "about"
```

**(b) import**（约第 47 行 `MaintenanceSection` import 附近）追加：
```typescript
import { LogsSection } from "./sections/logs-section"
```

**(c) CATEGORIES 数组**（约第 89 行 maintenance 项后）追加（用 ScrollText 图标）：
```typescript
  { id: "maintenance", labelKey: "settings.categories.maintenance", icon: Wrench },
  { id: "logs", labelKey: "settings.categories.logs", icon: ScrollText },
  { id: "changelog", labelKey: "settings.categories.changelog", icon: History },
```

确认 `ScrollText` 在 lucide-react import 中（约第 30-40 行的 `import { ... } from "lucide-react"`）。若无，追加 `ScrollText`。

**(d) body switch**（约第 608-609 行）追加 case：
```typescript
      case "maintenance":
        return <MaintenanceSection />
      case "logs":
        return <LogsSection />
      case "changelog":
```

- [ ] **Step 2: i18n zh.json**

在 `src/i18n/zh.json` 的 `settings.categories` 节点追加 logs 类目：
```json
        "logs": "日志查看器"
```
并在 `settings` 节点下新增 `logs` 对象（与 `categories` 同级）：
```json
    "logs": {
      "title": "日志查看器",
      "description": "查看和搜索应用日志",
      "searchPlaceholder": "搜索关键字...",
      "loading": "加载中...",
      "empty": "暂无日志记录",
      "loadError": "加载日志失败",
      "total": "共 {{count}} 条",
      "prev": "上一页",
      "next": "下一页"
    }
```
（确认 JSON 结构：categories 与 logs 都在 settings 下，逗号正确。）

- [ ] **Step 3: i18n en.json**

在 `src/i18n/en.json` 对应位置追加：
```json
        "logs": "Log Viewer"
```
和：
```json
    "logs": {
      "title": "Log Viewer",
      "description": "View and search application logs",
      "searchPlaceholder": "Search keyword...",
      "loading": "Loading...",
      "empty": "No log entries",
      "loadError": "Failed to load logs",
      "total": "{{count}} entries",
      "prev": "Prev",
      "next": "Next"
    }
```

- [ ] **Step 4: 类型检查 + 测试**

Run:
```bash
npm run typecheck 2>&1 | grep -iE "settings-view|logs-section|i18n" | head
npm test -- --run 2>&1 | grep -E "Tests" | tail -2
```
Expected: 0 新错误；测试不回归。

- [ ] **Step 5: 提交**

```bash
git add src/components/settings/settings-view.tsx src/i18n/zh.json src/i18n/en.json
git commit -m "feat(logging): register LogsSection in settings + i18n

Adds 'logs' category to CategoryId, CATEGORIES nav, body switch.
ScrollText icon. zh/en i18n strings.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: 验证文档

**Files:**
- Create: `docs/superpowers/tests/2026-06-15-logging-phase3-batchB-validation.md`

- [ ] **Step 1: 创建验证文档**

创建 `docs/superpowers/tests/2026-06-15-logging-phase3-batchB-validation.md`：

```markdown
# 日志系统阶段 3 批次 B 手动验证

> 日期: 2026-06-15 | 验证者: _____ | 应用版本: _____

## 自动化测试
- [ ] `cd src-tauri && cargo test logging::manager::tests` — read_* 10 个测试全通过
- [ ] `cd src-tauri && cargo check` — 0 error
- [ ] `npm run typecheck` — 无新增错误
- [ ] `npm test -- --run` — 全绿

## read_log_file 命令验证
- [ ] **空日志目录**：首次运行（无日志）打开查看器显示"暂无日志记录"
- [ ] **基本加载**：产生若干日志后打开查看器，显示最新 100 条（时间降序）
- [ ] **分页**：日志 >100 条时，下一页/上一页按钮工作正常
- [ ] **级别筛选**：点击级别 chip toggle，列表随之过滤
- [ ] **关键字搜索**：输入关键字，模糊匹配 message + module（大小写不敏感）
- [ ] **trace_id 过滤**：输入一个 trace_id，精确匹配该请求日志
- [ ] **ERROR 高亮**：ERROR 行红色背景
- [ ] **并发安全**：查看器打开时持续产生日志（不崩溃，轮转瞬间最多丢几行）

## 字段提取验证
- [ ] **前端日志 module**：前端日志显示 span.module（如 src/lib/ingest.ts），非 "frontend"
- [ ] **后端日志 module**：后端日志显示 Rust target（如 llm_wiki::commands::fs）
- [ ] **trace_id 显示**：阶段 2 起的日志带 trace_id

## 已知限制
- 反序读取为逻辑反序（read lines then .rev()），非物理反序 seek——当前文件全读（10MB <200ms）
- total 每次请求重新扫描全部文件（YAGNI，不缓存；60MB <1s）
```

- [ ] **Step 2: 提交**

```bash
git add -f docs/superpowers/tests/2026-06-15-logging-phase3-batchB-validation.md
git commit -m "docs(logging): add phase 3 batch B validation checklist

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## 最终验证（全部任务完成后）

- [ ] `cd src-tauri && cargo test logging` 全绿（含 read_* 10 个）
- [ ] `cd src-tauri && cargo check` 0 error
- [ ] `npm run typecheck` 仅基线 8 错误
- [ ] `npm test -- --run` 全绿
- [ ] 按 Task 5 文档完成 GUI 手动验证
- [ ] 更新 CLAUDE.md 标注阶段 3 批次 B 完成
