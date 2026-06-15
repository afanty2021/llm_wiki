# LLM Wiki 日志系统阶段 2 设计文档

> **日期**: 2026-06-15 | **版本**: 0.7.1 | **状态**: 设计已确认，已纳入审查反馈（v0.7.1），待实施
> **前置**: 阶段 1（P0 基础设施）已完成，详见 `2026-06-14-logging-system-design.md`
> **分支**: `log-system`

---

## 1. 概述

阶段 2（P1 增强功能）在阶段 1 的日志基础设施之上，补齐两项用户可感知能力：

1. **请求追踪传播** —— 让一个用户操作在前端→IPC→后端命令→子调用的全链路携带同一 `trace_id`，可在日志中串联起一次完整请求的全部记录。
2. **Error 桌面通知** —— 任意 ERROR 级别日志（前后端统一）触发原生桌面通知，让用户在应用未聚焦时也能感知到错误。

### 1.1 目标

- 前端 `invoke` 调用自动注入 `trace_id`，核心业务命令零手动维护即可关联
- 后端核心命令通过 `#[instrument]` 将 `trace_id` 绑定到 tracing span，子调用自动继承
- ERROR 日志通过自定义 tracing Layer 统一捕获，触发桌面通知（前后端单一来源，零漏抓）
- 通知可在设置界面开关，默认开启
- 短时间连续 ERROR 通过时间窗口去重，避免通知刷屏

### 1.2 非目标（YAGNI）

- ❌ 应用内日志查看器（阶段 3）
- ❌ 日志采样降频（阶段 3）
- ❌ 远程日志收集（Sentry/Datadog，未规划）
- ❌ 通知交互按钮（Reply / Mark-read 等，超出阶段 2 范围）
- ❌ Error 日志独立 channel / 独立文件（阶段 1 已论证无收益，单 channel 架构保持不变）

---

## 2. 背景：阶段 1 已完成状态

阶段 1 已交付 945 行代码，22 个 commit，11 个自动化测试全通过。与本阶段相关的现状：

| 组件 | 阶段 1 状态 | 阶段 2 增量 |
|------|-----------|-----------|
| 前端 Logger Facade (`src/lib/logger.ts`) | ✅ 自动生成 trace_id（`crypto.randomUUID()`），但仅用于前端日志 | 无需改动 |
| 后端 `FrontendLogEntry` 类型 | ✅ 含 `trace_id` 字段，router 接收 | 无需改动 |
| Tauri 命令 `#[instrument]` | ❌ 全部命令无 span | **新增**（核心命令） |
| 前端 `invoke` trace_id 注入 | ❌ 直接调用 `invoke`，无 trace_id | **新增**（invokeTraced 封装） |
| `init_logging` 签名 | `(app_data_dir: PathBuf)` | **变更为** `(app_data_dir, app_handle)` |
| tracing subscriber | 3 层（filter + fmt console + fmt json file） | **新增第 4 层**（NotifyLayer） |
| 配置持久化 | `app-state.json`（tauri-plugin-store） | **新增** `error_notification` 键 |

**原阶段 2 计划中的 `export_logs` / `clear_logs` 已在阶段 1 实现并测试**，故本阶段不再包含。

**阶段 1 遗留 eprintln! 状态澄清**：阶段 1 早期审查时 `src-tauri/src/commands/fs.rs` 曾残留 7 处测试代码中的 `eprintln!`。已在 commit `821a30e`（"address code review findings"）中全部迁移至 tracing 宏 + `init_test_logger()` 订阅者（保留 `--nocapture` 可见性）。当前 `fs.rs` 生产代码 `eprintln!` 计数为 **0**（全仓仅剩注释中的提及）。本阶段无需再处理此项。

---

## 3. 架构总览

```
┌──────────────────────── 前端 (React 19) ────────────────────────┐
│                                                                   │
│  invokeTraced(cmd, args)   ← 新增 src/lib/invoke-traced.ts        │
│  ├─ trace_id = args.trace_id ?? crypto.randomUUID()                │
│  └─ invoke(cmd, { ...args, trace_id })                            │
│        │                                                           │
│        │  (业务命令调用，如 readFile / embedding)                    │
│        ▼                                                           │
│  Logger.error(msg, { trace_id }) ──IPC──► send_log ──┐           │
└─────────────────────────────────────────────────────────┼────────┘
                                                          │
┌──────────────────────── 后端 (Rust) ────────────────────┼────────┐
│                                                          ▼        │
│  router.rs → tracing::error!(target:"frontend", trace_id, msg)     │
│                                                                     │
│  #[tauri::command]                                                  │
│  #[instrument(name="read_file", fields(trace_id, file_path))]       │
│  fn read_file(file_path, trace_id) ──── span ──┐                    │
│                                                  │                   │
│  tracing Registry ◄──────── 所有 event 流经 ────┘                   │
│   ├─ EnvFilter (reload::Handle，运行时级别控制)                      │
│   ├─ fmt layer → stdout（开发模式人类可读）                          │
│   ├─ fmt json layer → 文件（10MB 轮转，保留 5）                      │
│   └─ NotifyLayer ★新增 → 捕获所有 ERROR event                       │
│         ├─ 读 error_notification 配置开关                            │
│         ├─ 10s 时间窗口去重（last_notify: Mutex<Option<Instant>>）   │
│         └─ tokio::spawn → app_handle.notification().show()          │
└─────────────────────────────────────────────────────────────────────┘
```

**设计要点**：前端 ERROR 经 `router.rs` 转为 `tracing::error!(target:"frontend")` event（阶段 1 已实现），后端 ERROR 直接用 `tracing::error!` 宏。两者流经同一 Registry，因此**单一 NotifyLayer 即可统一捕获前后端 ERROR**，无需为前端单独处理。

---

## 4. 功能 1：请求追踪传播

### 4.1 前端：invokeTraced 封装层

**新增文件** `src/lib/invoke-traced.ts`（约 40 行）

```typescript
import { invoke } from "@tauri-apps/api/core";

/**
 * 带 trace_id 的 Tauri invoke 封装。
 *
 * - 若 args.trace_id 为合法非空字符串（调用方显式传入，用于一个操作内多次 invoke 关联），透传
 * - 否则自动生成 UUID v4
 * - trace_id 注入到 invoke 参数，后端 #[instrument] 通过同名参数捕获
 *
 * 合约约束：调用方传入的 trace_id 必须是合法 UUID v4 或 null/undefined。
 * 传入空字符串 "" 会被视为未提供（用 || 而非 ??，避免空串透传成无效值）。
 *
 * 用法：
 *   import { invokeTraced } from "@/lib/invoke-traced";
 *   const content = await invokeTraced<string>("read_file", { filePath });
 */
export async function invokeTraced<T>(
  cmd: string,
  args?: Record<string, unknown>
): Promise<T> {
  // 用 || 而非 ??：空字符串 "" 是 falsy，会触发自动生成，避免透传无效 trace_id。
  // trace_id 为 string 类型时，"" 是唯一需要防御的 falsy 值（不会出现 0/false）。
  const trace_id = (args?.trace_id as string) || crypto.randomUUID();
  return invoke<T>(cmd, { ...args, trace_id });
}
```

**说明**：不替换 `@tauri-apps/api/core` 的 `invoke`，而是提供独立封装。原因：
- 渐进迁移：现有调用点可逐步切换，不破坏未迁移命令
- 日志命令（`send_log` 等）不追踪，避免递归污染
- 显式选择：开发者明确知道哪些调用会注入 trace_id

### 4.2 核心命令迁移范围

**筛选规则**：涉及文件 I/O、LLM 调用、长耗时操作、易错操作的命令纳入追踪；纯状态查询、日志命令本身排除。

| 前端文件 | 迁移内容 | 后端 #[instrument] |
|---------|---------|-------------------|
| `src/commands/fs.ts` | `readFile`, `writeFile`, `deleteFile`, `listFiles` 等 I/O 命令 | ✅ 对应 Rust 命令加 span |
| `src/commands/file-sync.ts` | `fileSync` 系列 | ✅ |
| `src/lib/embedding.ts` | 7 处 `invoke` 调用（embed/search 等向量操作） | ✅ |
| `src/lib/search.ts` | search 相关 invoke | ✅ |
| `src/lib/extract-source-images.ts` | 图片提取 invoke | ✅ |
| `src/lib/claude-cli-transport.ts` | claude_cli_spawn 等 | ✅ |
| `src/lib/codex-cli-transport.ts` | codex_cli_spawn 等 | ✅ |
| `src/commands/logging.ts` | **不迁移**（日志命令，避免递归） | ❌ 跳过 |
| `src/lib/markdown-image-resolver.ts` | **不迁移**（`convertFileSrc` 非命令调用） | ❌ 跳过 |

**迁移模式**（以 `commands/fs.ts` 为例）

```typescript
// 之前
import { invoke } from "@tauri-apps/api/core";
export async function readFile(filePath: string): Promise<string> {
  return invoke<string>("read_file", { filePath });
}

// 之后
import { invokeTraced } from "@/lib/invoke-traced";
export async function readFile(filePath: string): Promise<string> {
  return invokeTraced<string>("read_file", { filePath });
}
```

**跨命令关联**（同一操作多次 invoke）：
```typescript
// autoIngest 内部：一次摄取涉及多次后端调用，显式共享 trace_id
import { invokeTraced } from "@/lib/invoke-traced";
const trace_id = crypto.randomUUID();
await invokeTraced("read_file", { filePath, trace_id });      // 读取
await invokeTraced("write_wiki", { content, trace_id });      // 写入
logger.info("摄取完成", { trace_id });                          // 前端日志同 trace_id
```

### 4.3 后端：#[instrument] span

**`#[instrument]` 与 `panic_guard` 兼容性**（已技术验证）：
- `panic_guard::run_guarded` 用 `catch_unwind` 包裹命令**函数体**
- `#[instrument]` 加在**函数签名**上，span 在 `catch_unwind` 外部创建/退出
- panic 被 catch 时 span 仍处于活跃状态，`error!(panic_message=...)` 能正确记录到带 `trace_id` 的 span 内

**示例**（`src-tauri/src/commands/fs.rs`）

```rust
use tracing::instrument;

#[tauri::command]
#[instrument(
    name = "read_file",
    skip(file_path),  // 不记录路径值到 span name（隐私），但记录到 fields
    fields(trace_id = %trace_id, file_path = %file_path)
)]
fn read_file(file_path: String, trace_id: String) -> Result<String, String> {
    run_guarded("read_file", || {
        // 原有逻辑不变
        fs::read_to_string(&file_path)
            .map_err(|e| format!("Failed to read file: {}", e))
    })
}
```

**span fields 说明**：
- `trace_id = %trace_id`：`%` 表示用 Display 格式化，写入 span field
- `skip(file_path)` 避免 file_path 出现在 span **名称**中（保持名称为固定 `read_file`，便于筛选），但 `fields(file_path = %file_path)` 仍将其记入 span 字段
- tracing 自动将 span fields 合并到该 span 内每个 event 的 JSON 输出中

**JSON 日志输出示例**（trace_id 贯穿）
```json
{"timestamp":"2026-06-15T10:00:00Z","level":"ERROR","target":"llm_wiki::commands::fs",
 "trace_id":"550e8400-e29b-41d4-a716-446655440000",
 "span":{"name":"read_file","file_path":"/path/to/doc.pdf","trace_id":"550e8400-..."},
 "fields":{"message":"Failed to read file: PermissionDenied"}}
```

### 4.4 异步命令处理

部分命令是 `async fn`（如 LLM 相关）。`#[instrument]` 原生支持 async，span 自动跨 `.await` 保持：

```rust
#[tauri::command]
#[instrument(name = "embed_documents", fields(trace_id = %trace_id), skip(docs))]
async fn embed_documents(docs: Vec<String>, trace_id: String) -> Result<(), String> {
    run_guarded_async("embed_documents", async {
        // 跨 await 点，trace_id 始终在 span context 中
        do_embed(&docs).await.map_err(|e| e.to_string())
    }).await
}
```

---

## 5. 功能 2：Error 桌面通知

### 5.1 tauri-plugin-notification 集成

**依赖添加**
```bash
npm run tauri add notification
```
该命令自动：
1. 添加 `tauri-plugin-notification = "2"` 到 `src-tauri/Cargo.toml`
2. 添加 `@tauri-apps/plugin-notification` 到 `package.json`
3. 在 capabilities 配置中授予默认权限（`allow-notify`, `allow-show` 等）

**lib.rs 注册插件**
```rust
tauri::Builder::default()
    .plugin(tauri_plugin_notification::init())  // ★新增
    .plugin(tauri_plugin_opener::init())
    // ...其余插件
```

### 5.2 NotifyLayer —— 自定义 tracing Layer

**新增文件** `src-tauri/src/logging/notify_layer.rs`（约 120 行）

```rust
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;
use tracing::field::Visit;
use tracing::{Event, Subscriber};
use tracing_subscriber::Layer;

/// 通知去重窗口（秒）：窗口内仅发送首条 ERROR 通知
const NOTIFY_DEBOUNCE_SECS: u64 = 10;

/// 捕获所有 ERROR 级别 event，触发桌面通知。
///
/// 前后端统一：前端 ERROR 经 router.rs 转为 tracing::error!(target:"frontend")，
/// 后端 ERROR 直接用 tracing::error! 宏，两者流经同一 Registry，均被本 Layer 捕获。
pub struct NotifyLayer {
    app_handle: AppHandle,
    last_notify: Mutex<Option<Instant>>,
}

impl NotifyLayer {
    pub fn new(app_handle: AppHandle) -> Self {
        Self {
            app_handle,
            last_notify: Mutex::new(None),
        }
    }

    /// 时间窗口去重：窗口内抑制后续通知
    fn acquire_slot(&self) -> bool {
        let mut last = self.last_notify.lock()
            .expect("last_notify mutex poisoned");
        let now = Instant::now();
        if let Some(t) = *last {
            if now.duration_since(t) < Duration::from_secs(NOTIFY_DEBOUNCE_SECS) {
                return false; // 窗口内，抑制
            }
        }
        *last = Some(now);
        true
    }

    /// 读取 error_notification 配置（默认开启）
    fn notification_enabled(&self) -> bool {
        // 复用 proxy.rs 的 app-state.json 读取模式
        // ERROR 频率低，每次读取文件开销可接受（文件通常 < 10KB）
        read_error_notification_config(&self.app_handle).unwrap_or(true)
    }
}

impl<S: Subscriber> Layer<S> for NotifyLayer {
    fn on_event(&self, event: &Event<'_>, _ctx: tracing_subscriber::layer::Context<'_, S>) {
        // 仅 ERROR 级别触发
        if event.metadata().level() != &tracing::Level::ERROR {
            return;
        }

        if !self.notification_enabled() {
            return;
        }

        if !self.acquire_slot() {
            return; // 去重窗口内，静默抑制
        }

        // 提取消息文本
        let mut visitor = MessageVisitor::default();
        event.record(&mut visitor);
        let body = visitor.message
            .unwrap_or_else(|| "(no message)".to_string());

        // 截断超长消息（通知 UI 限制）
        let body = if body.chars().count() > 200 {
            let truncated: String = body.chars().take(197).collect();
            format!("{}...", truncated)
        } else {
            body
        };

        // 异步发送：避免阻塞日志写入线程。
        // macOS 关键约束：UNUserNotificationCenter 必须在主线程调用（见技术验证 4、
        // tauri issue #3241），故用 run_on_main_thread 将 show() 调度到主线程执行。
        // Linux/Windows 同样兼容（多一次主线程调度，开销可忽略）。
        let app = self.app_handle.clone();
        let final_body = format!("{}\n（更多错误详见日志）", body);
        tauri::async_runtime::spawn(async move {
            let app_for_closure = app.clone();
            let _ = app.run_on_main_thread(move || {
                let _ = app_for_closure
                    .notification()
                    .builder()
                    .title("LLM Wiki 发生错误")
                    .body(final_body)
                    .show();
            })
            .await;
        });
    }
}

/// 从 event fields 提取 message 字段。
///
/// tracing 的事件消息（`tracing::error!("text")` 或 `error!("{}", msg)`）经名为
/// "message" 的 field 传递。字符串字面量与 Display 值在 tracing 内部以 Debug 形式
/// 记录（走 record_debug），`format!("{:?}", "失败")` 产出 `"失败"`（带引号）。
/// 故 record_debug 中需去除首尾引号，避免通知显示为 `"\"失败\""`。
#[derive(Default)]
struct MessageVisitor {
    message: Option<String>,
}

impl Visit for MessageVisitor {
    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" {
            let formatted = format!("{:?}", value);
            self.message = Some(strip_debug_quotes(&formatted));
        }
    }
    fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
        if field.name() == "message" {
            self.message = Some(value.to_string());
        }
    }
}

/// 去除 Debug 格式化给字符串值加的首尾引号。
///
/// 仅当首尾字符均为 `"` 时去除（避免误删消息内容中合法的引号）。
/// 权衡：内部转义序列（如 `\"`、`\n`）不反转义——对通知场景（用户可读摘要）足够；
/// 若未来需要精确反转义，可改为 unescape 处理。
fn strip_debug_quotes(s: &str) -> String {
    let bytes = s.as_bytes();
    if bytes.len() >= 2 && bytes.first() == Some(&b'"') && bytes.last() == Some(&b'"') {
        s[1..s.len() - 1].to_string()
    } else {
        s.to_string()
    }
}
```

**`mod.rs` 导出更新**
```rust
mod manager;
mod notify_layer;  // ★新增
mod router;
mod types;

pub use manager::{...};
pub use notify_layer::NotifyLayer;  // ★新增
```

### 5.3 配置读取（app-state.json 模式）

**新增文件** `src-tauri/src/logging/config.rs`（约 30 行）

```rust
use tauri::AppHandle;
use tauri::Manager;

/// 从 app-state.json 读取 error_notification 配置。
///
/// 复用 proxy.rs 的读取模式：直接读 tauri-plugin-store 写入的 JSON 文件。
/// 返回 None 时，调用方使用默认值（true = 开启通知）。
///
/// 约定存储结构：
/// {
///   "error_notification": true,   // ← 本配置
///   "proxyConfig": { ... },       // 已有
///   ...
/// }
///
/// 【前提与风险】本项目前端通过 `load("app-state.json", ...)` 显式使用 `.json`
/// 扩展名，实测 plugin-store 2.4.x 将该文件存为**纯明文 JSON**（已用 python
/// json.load 验证，proxy.rs 同样方式读取 proxyConfig 长期稳定）。故直接文件 +
/// serde_json 解析可行，且与 proxy.rs 保持一致的读取模式。
///
/// 风险：若未来 tauri-plugin-store 升级后默认改用二进制格式（CBOR 等），
/// 本函数会静默返回 None（解析失败 → 默认开启通知，不致崩溃）。届时应迁移到
/// tauri-plugin-store 的 Rust API（StoreExt）读取，而非直接文件解析。
pub fn read_error_notification_config(app: &AppHandle) -> Option<bool> {
    let app_data_dir = app.path().app_data_dir().ok()?;
    let store_path = app_data_dir.join("app-state.json");
    let content = std::fs::read_to_string(&store_path).ok()?;
    let json: serde_json::Value = serde_json::from_str(&content).ok()?;
    let val = json.get("error_notification")?;
    val.as_bool()
}
```

**性能考量**：ERROR 频率低（正常使用每日个位数），每次触发读取一次小文件（< 10KB）开销可忽略。无需引入缓存与刷新机制的复杂度（YAGNI）。若未来 ERROR 频率升高，再加 `Arc<Mutex<Option<bool>>>` 缓存 + set_error_notification 命令刷新。

### 5.4 init_logging 签名变更

**`src-tauri/src/logging/manager.rs`**

```rust
// 之前
pub fn init_logging(app_data_dir: PathBuf) -> Result<(), String> { ... }

// 之后
pub fn init_logging(app_data_dir: PathBuf, app_handle: AppHandle) -> Result<(), String> {
    // ...（原有 appender / guard / filter 构建不变）

    // ★ 新增：导入 NotifyLayer（需在文件顶部 use crate::logging::NotifyLayer）
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
        .with(NotifyLayer::new(app_handle));  // ★新增第 4 层

    tracing::subscriber::set_global_default(subscriber)
        .map_err(|e| format!("Failed to set tracing subscriber: {}", e))?;

    Ok(())
}
```

**`src-tauri/src/lib.rs` setup 钩子调用变更**
```rust
.setup(|app| {
    let app_data_dir = app.path().app_data_dir()
        .expect("Failed to resolve app data dir");

    // ★ 传入 app_handle 供 NotifyLayer 使用
    logging::init_logging(app_data_dir, app.handle().clone())
        .expect("Failed to initialize logging");
    // ...
})
```

### 5.5 配置 UI 扩展

**`src/components/settings/logging-config.tsx`** 新增「错误通知」开关

```tsx
import { Switch } from "@/components/ui/switch";
import { useState, useEffect } from "react";

export function LoggingConfig() {
  const [errorNotify, setErrorNotify] = useState(true);

  useEffect(() => {
    // 启动时读取当前配置
    loadErrorNotifyConfig().then(setErrorNotify);
  }, []);

  const toggleErrorNotify = async (enabled: boolean) => {
    setErrorNotify(enabled);  // optimistic
    try {
      await setErrorNotifyConfig(enabled);  // 写入 app-state.json
    } catch {
      setErrorNotify(!enabled);  // 失败回滚
    }
  };

  return (
    <div className="space-y-4">
      {/* 原有日志级别按钮组 */}
      <LogLevelButtons ... />

      {/* ★ 新增错误通知开关 */}
      <div className="flex items-center justify-between">
        <div>
          <Label>错误桌面通知</Label>
          <p className="text-sm text-muted-foreground">
            发生错误时显示桌面通知（10 秒内仅提示一次）
          </p>
        </div>
        <Switch checked={errorNotify} onCheckedChange={toggleErrorNotify} />
      </div>
    </div>
  );
}
```

**前端配置读写**：通过 tauri-plugin-store 的 JS API（`@tauri-apps/plugin-store`）读写 `app-state.json` 的 `error_notification` 键，与现有设置持久化方式一致。

---

## 6. 接口汇总

### 6.1 新增 Tauri 命令

无新增命令。`error_notification` 配置通过 tauri-plugin-store 的 JS API 直接读写 `app-state.json`，无需专用命令（与现有 proxyConfig 模式一致）。

### 6.2 新增前端模块

| 文件 | 导出 | 职责 |
|------|------|------|
| `src/lib/invoke-traced.ts` | `invokeTraced<T>(cmd, args)` | 带 trace_id 的 invoke 封装 |

### 6.3 变更的后端签名

| 函数 | 变更 |
|------|------|
| `logging::init_logging` | 新增第二参数 `app_handle: AppHandle` |
| `lib.rs` setup 钩子 | 调用处传入 `app.handle().clone()` |

### 6.4 新增后端模块

| 文件 | 导出 | 职责 |
|------|------|------|
| `src-tauri/src/logging/notify_layer.rs` | `NotifyLayer` | ERROR 事件捕获 + 通知触发 + 去重 |
| `src-tauri/src/logging/config.rs` | `read_error_notification_config` | 读取通知开关配置 |

---

## 7. 错误处理与降级

| 场景 | 处理 | 影响 |
|------|------|------|
| 系统通知权限被拒（macOS 系统设置关闭） | `notification().show()` 返回 Err，Layer 的 `let _ =` 静默忽略 | 日志正常写入，仅无通知 |
| `AppHandle` 未就绪 | 不会发生——`init_logging` 在 setup 钩子内、`app.handle()` 可用时调用 | 无 |
| `tokio::spawn` 内 panic | 通知静默失败，不影响主流程 | 无 |
| macOS 通知需主线程 | `show()` 经 `run_on_main_thread` 调度到主线程执行（见技术验证 4） | macOS 通知正常弹出 |
| 通知线程阻塞 | `show()` 在主线程异步执行，`on_event` 不阻塞日志写入线程 | 无 |
| Windows 开发模式 | 通知显示 PowerShell 图标与名称 | 仅视觉，生产模式（已安装）正常 |
| `app-state.json` 读取失败 | `read_error_notification_config` 返回 None → 默认 true（开启） | 通知照常 |
| 短时间大量 ERROR | 10s 窗口去重，仅首条通知，body 追加「更多错误详见日志」 | 无刷屏 |
| 前端 ERROR 在应用未聚焦时 | 通知照常发送（这正是桌面通知的核心价值） | 无 |

**降级保证**：通知功能的任何失败都不影响日志系统的核心职责（写入文件）。`NotifyLayer.on_event` 中所有外部调用均用 `let _ =` 或 `Result::ok()` 吞掉错误。

---

## 8. 测试策略

### 8.1 可自动化测试

| 测试项 | 类型 | 验证点 |
|--------|------|--------|
| `invokeTraced` 自动生成 trace_id | Vitest 单测 | 调用后 invoke 收到合法 UUID v4 |
| `invokeTraced` 透传已有 trace_id | Vitest 单测 | 传入 `args.trace_id` 时使用传入值，不覆盖 |
| `#[instrument]` span 含 trace_id | cargo test | （编译期保证；可加 doc-test 示例） |
| `NotifyLayer.acquire_slot` 时间窗口 | cargo 单测 | 10s 内第二次调用返回 false；模拟超时后返回 true |
| `NotifyLayer` 仅 ERROR 触发 | cargo 单测 | mock WARN/INFO event 不调用 notification |
| `read_error_notification_config` | cargo 单测 | 读到 `true`/`false` 正确解析；文件缺失返回 None |
| 配置开关关闭时不通知 | cargo 集成测试 | `error_notification=false` 时 Layer 不触发 |

**时间窗口测试要点**：`Instant::now()` 无法注入假时钟。采用暴露 `acquire_slot_with_threshold(now: Instant, threshold: Duration)` 的内部函数，测试直接传入构造的 `Instant`，避免依赖真实时间。

### 8.2 手动验证（GUI 依赖，无法自动化）

记录到 `docs/superpowers/tests/2026-06-15-logging-phase2-validation.md`：

| 验证项 | 步骤 | 预期 |
|--------|------|------|
| trace_id 端到端一致 | 触发文件读取 → 查看日志文件 | 前端日志与后端 span 的 trace_id 相同 |
| ERROR 触发通知 | 制造一个后端 ERROR（如读取不存在文件） | 桌面通知弹出，含错误摘要 |
| 前端 ERROR 触发通知 | 制造一个前端 ERROR | 同样弹出通知 |
| 10s 去重 | 连续制造多个 ERROR | 10s 内仅一条通知 |
| 配置开关 | 设置界面关闭「错误通知」后再制造 ERROR | 无通知 |
| Windows 开发模式 | Windows 上 `tauri dev` 触发 ERROR | 通知显示（图标为 PowerShell，生产正常） |
| macOS 权限 | 首次运行 | 系统弹出通知权限请求 |

---

## 9. 实施任务拆解

按依赖顺序，共 8 项任务：

| # | 任务 | 依赖 | 产出 |
|---|------|------|------|
| 1 | 添加 `tauri-plugin-notification` 依赖 + capabilities | 无 | Cargo.toml / package.json / capabilities 更新 |
| 2 | 新增 `invoke-traced.ts` + 单测 | 无 | src/lib/invoke-traced.ts |
| 3 | 后端核心命令加 `#[instrument]` | 2 | commands/fs.rs, embedding 相关, search, file-sync 等 |
| 4 | 前端核心命令调用点迁移到 `invokeTraced` | 2, 3 | commands/fs.ts, lib/embedding.ts, lib/search.ts 等 |
| 5 | 新增 `notify_layer.rs` + `config.rs` | 1 | logging/notify_layer.rs, logging/config.rs |
| 6 | `init_logging` 接收 AppHandle + 注入 NotifyLayer | 5 | manager.rs, lib.rs, mod.rs |
| 7 | 配置 UI（错误通知开关） | 1, 6 | logging-config.tsx |
| 8 | 测试编写 + 手动验证文档 | 全部 | __tests__/, tests/*.md |

---

## 10. 依赖清单

### 10.1 后端新增

```toml
[dependencies]
tauri-plugin-notification = "2"
```

### 10.2 前端新增

```json
{
  "dependencies": {
    "@tauri-apps/plugin-notification": "^2"
  }
}
```

### 10.3 现有依赖复用

- `tracing`, `tracing-subscriber`（阶段 1 已加）—— `Layer` trait、`Visit` 来自此处
- `uuid`（已存在）—— 前端用 `crypto.randomUUID()`，后端无需
- `serde_json`（已存在）—— 配置读取
- `tauri-plugin-store`（已存在）—— 配置持久化载体

---

## 11. 性能考虑

1. **invokeTraced 开销**：每次 invoke 多一次 `crypto.randomUUID()`（µs 级）+ 对象浅拷贝，可忽略。
2. **#[instrument] 开销**：每个命令入口创建一个 span（分配 span ID + 存 fields），核心命令调用频率不高（用户操作驱动），开销可接受。
3. **NotifyLayer 开销**：每个 event 触发一次 `on_event`，但仅 `Level::ERROR` 时进入实质逻辑；非 ERROR 提前 return。ERROR 频率低，去重后通知频率更低。
4. **配置读取 I/O**：仅在 ERROR 触发去重通过后读取一次小文件（< 10KB），正常使用每日个位数次，无性能问题。
5. **通知异步化**：`on_event` 内 `tauri::async_runtime::spawn` 派发任务，任务内 `run_on_main_thread` 将 `show()` 调度到主线程执行（macOS 要求）。`on_event` 本身不阻塞 tracing 的日志写入线程；主线程仅承担一次轻量的通知 API 调用（去重后频率极低）。

---

## 12. 与阶段 1 设计文档的关系

本阶段不修改阶段 1 的核心架构（单 channel、`OnceLock`、轮转策略、router target 固定 `"frontend"`）。仅做增量扩展：

- `init_logging` 增参 `AppHandle`（向后不兼容，但仅 lib.rs 一处调用）
- Registry 新增第 4 层 NotifyLayer
- 前端新增 invokeTraced 封装

阶段 1 设计文档中「阶段 2」章节标注的 `export_logs` / `clear_logs` 已在阶段 1 实现完毕，阶段 1 文档的实施记录已更新。本阶段实际范围调整为「请求追踪传播 + Error 桌面通知」两项。

---

## 13. 技术验证记录（2026-06-15）

实施前已完成五项关键技术验证：

1. **tauri-plugin-notification Rust API**：确认 `NotificationExt` trait 实现于所有 `Manager<R>`（含 `AppHandle`），`app_handle.notification().builder().title().body().show()` 可用。平台支持 macOS/Linux/Windows。（来源：docs.rs/tauri-plugin-notification、v2.tauri.app/plugin/notification）

2. **`#[instrument]` 与 `panic_guard` 兼容**：`run_guarded` 的 `catch_unwind` 包裹函数体，`#[instrument]` 的 span 在函数签名层创建、位于 `catch_unwind` 外部，panic 被 catch 时 span 仍活跃，可正确记录 `panic_message` 到带 trace_id 的 span。

3. **自定义 tracing Layer 可注入**：`init_logging` 中 subscriber 用 `Registry::default().with(...)` 构建（manager.rs:208），新增 `.with(NotifyLayer::new(app_handle))` 即可。`AppHandle` 是 `Clone + Send + Sync`，满足 `Layer<S>` 的线程安全要求。

4. **notification `show()` 线程安全性**：`Notification<R>` 的 trait bound 为 `Send + Sync`（docs.rs 确认），类型契约允许跨线程持有。但 macOS 的 `UNUserNotificationCenter` **要求在主线程调用**（tauri issue #3241 证实：后台线程直接调用触发 `This API cannot be called on the main thread` panic）。故方案将 `show()` 包裹在 `run_on_main_thread` 中调度到主线程执行，而非直接在 tokio 工作线程调用。`run_on_main_thread` 是 `Manager` trait 方法，`AppHandle` 可用，返回 `Task` 可 await。Linux/Windows 平台同样兼容（多一次主线程调度）。（来源：docs.rs/tauri-plugin-notification、github.com/tauri-apps/tauri/issues/3241）

5. **app-state.json 存储格式**：前端通过 `load("app-state.json", { autoSave: true })` 显式使用 `.json` 扩展名（`src/lib/project-store.ts`）。实测 plugin-store 2.4.x 将该文件存为**纯明文 JSON**（`~/Library/Application Support/com.llmwiki.app/app-state.json`，python `json.load` 验证通过）。故 `read_error_notification_config` 的直接文件 + `serde_json` 解析可行，且与 `proxy.rs` 读取 `proxyConfig` 的既有模式一致。tauri-plugin-store v2 的二进制格式（CBOR）需显式启用 feature，本项目未启用。

---

*设计文档完成时间：2026-06-15*
