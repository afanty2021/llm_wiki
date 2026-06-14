# LLM Wiki 日志系统设计

> **日期**: 2026-06-14 | **版本**: 0.6.0 | **状态**: 已实施（阶段 1 完成）

---

## 概述

为 LLM Wiki 桌面应用构建完整的日志基础设施，替代当前零散的 `console.log` / `eprintln!` 方案，实现结构化日志、级别控制、持久化、请求追踪等能力。

### 目标

- 统一的日志收集（前端通过 Tauri IPC → 后端文件写入）
- 结构化 JSON 格式（便于机器解析和查询）
- 可配置的日志级别（开发/生产环境自适应 + 设置界面）
- 基于大小的文件轮转（10MB，保留 5 个文件）
- UUID 请求追踪（跨前后端关联）
- Error 日志优先级提升 + 可选用户通知（独立大 channel，降低丢失概率）

---

## 架构

```
┌─────────────────────────────────────────────────────────────┐
│                       Frontend (React 19)                     │
│  ┌───────────────────────────────────────────────────────┐  │
│  │                    Logger Facade                        │  │
│  │  - createLogger(module) → { info, warn, error, debug } │  │
│  │  - 自动生成 trace_id (UUID v4)，除非 data.trace_id 已存在  │  │
│  │  - 模块名称自动提取                                     │  │
│  │  - 高频批处理：50ms debounce 或每 10 条日志一次 IPC   │  │
│  │  - 通过 Tauri IPC sendLog() 发送到后端                  │  │
│  └───────────────────────────────────────────────────────┘  │
│                              │                                │
│                     Tauri IPC (invoke)                        │
├──────────────────────────────┼──────────────────────────────┤
│                       Backend (Rust)                          │
│  ┌───────────────────────────────────────────────────────┐  │
│  │                  Log Router (Tauri Command)             │  │
│  │  - 接收前端日志 (IPC)                                    │  │
│  │  - 统一日志格式 (JSON)                                   │  │
│  │  - 分发到 Tracing 层                                    │  │
│  └───────────────────────────────────────────────────────┘  │
│                              │                                │
│  ┌───────────────────────────────────────────────────────┐  │
│  │              Tracing Layer (tracing crate)              │  │
│  │  - 结构化 Span 追踪                                      │  │
│  │  - 上下文传播 (trace_id)                                 │  │
│  │  - 日志级别过滤 (LevelFilter)                           │  │
│  └───────────────────────────────────────────────────────┘  │
│                              │                                │
│  ┌───────────────────────────────────────────────────────┐  │
│  │              File Writer (tracing-appender)             │  │
│  │  - 日志文件路径: {app_data_dir}/logs/llm-wiki.log       │  │
│  │  - NonBlocking 模式（后台线程异步写入）                  │  │
│  │  - Error 日志优先级提升（但不保证立即 flush）            │  │
│  │  - 基于大小轮转 (10MB, 保留 5 个文件)                   │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

---

## 数据结构

### 前端日志（通过 IPC 发送）

```typescript
interface FrontendLogEntry {
  timestamp: string       // ISO 8601
  level: "DEBUG" | "INFO" | "WARN" | "ERROR"  // 大写，与后端统一
  module: string          // "src/lib/ingest.ts"
  trace_id: string        // UUID v4，snake_case 与后端 span fields 统一
  message: string
  data?: Record<string, unknown>
}
```

**规范化层**：前端 Logger Facade 内部将日志级别转为大写后再发送到后端，确保与后端 tracing 层的级别格式一致。

### 后端统一 JSON 格式

```json
{
  "timestamp": "2026-06-14T12:30:45.123Z",
  "level": "WARN",
  "target": "llm_wiki::commands::fs",
  "trace_id": "550e8400-e29b-41d4-a716-446655440000",
  "fields": {
    "message": "读取文件失败: 权限不足",
    "file_path": "/path/to/file.pdf",
    "error": "PermissionDenied"
  },
  "span": {
    "name": "read_file",
    "file_path": "/path/to/file.pdf"
  }
}
```

### 日志文件组织

```
{app_data_dir}/logs/
  ├── llm-wiki.log           # 当前日志（最新）
  ├── llm-wiki.1.log         # 上一轮轮转
  ├── llm-wiki.2.log
  ├── llm-wiki.3.log
  ├── llm-wiki.4.log
  └── llm-wiki.5.log         # 最老（最多保留 5 个文件）
```

**轮转策略**：
- 单文件超过 10MB 时触发轮转
- 检查频率：每写入 100 条日志后检查一次文件大小（减少 I/O 开销）
- 保留策略：最多 5 个历史文件，超过时删除最老的 `.5.log`

---

## 接口

### Tauri IPC 接口

| 命令 | 输入 | 输出 | 说明 |
|------|------|------|------|
| `send_log` | `Vec<FrontendLogEntry>` | `Result<(), String>` | 前端批量发送日志（批处理） |
| `get_log_files` | — | `Result<Vec<LogFileEntry>, String>` | 获取日志文件列表 |
| `clear_logs` | — | `Result<(), String>` | 清理所有日志文件（删除所有 .log 文件） |
| `export_logs` | `days: u32` | `Result<String, String>` | 导出为 JSONL，返回绝对路径（如 `/abs/path/to/llm-wiki-export-2026-06-14.jsonl`） |
| `get_log_level` | — | `Result<String, String>` | 读取日志级别 |
| `set_log_level` | `level: String` | `Result<(), String>` | 设置日志级别（立即生效） |

```typescript
interface LogFileEntry {
  name: string      // "llm-wiki.log", "llm-wiki.1.log", ...
  size: number      // 字节数
  modified: number  // Unix 时间戳
  isCurrent: boolean  // 是否是当前活跃日志文件
}
```

### 前端 Logger Facade

基于浏览器原生 API 的轻量封装（约 80–120 行）：

- **初始化**：应用启动时 async 调用 `get_log_level()` 获取初始级别，失败则默认为 WARN
- 控制台输出（开发模式保留 console API）
- JSON 序列化（生产模式）
- Tauri IPC 发送到后端
- 自动 trace_id 生成（UUID v4），若 data.trace_id 已存在则使用提供的值
- **关闭处理**：监听 `window.beforeunload` 和 Tauri `closeRequested` 事件，刷新前强制 flush 缓冲区

```typescript
function createLogger(module: string): Logger

interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void
  info(msg: string, data?: Record<string, unknown>): void
  warn(msg: string, data?: Record<string, unknown>): void
  error(msg: string, data?: Record<string, unknown>): void
}
```

**说明**：不使用第三方日志库（如 pino），因为 Tauri WebView 不支持 Node.js 特定的 stream API。自定义 facade 更轻量且完全可控。

### 使用示例

```typescript
// 之前
console.warn(`[ingest] ${msg}`)

// 之后
const logger = createLogger("ingest")
logger.warn(msg, { file_name: fileName })
```

---

## 日志级别控制

| 环境 | 默认日志级别 |
|------|-------------|
| 开发模式 (`npm run tauri dev`) | debug |
| 生产模式 (打包后) | warn |

用户可在设置界面自定义日志级别，配置持久化到 `app_settings.json`：

```json
{
  "logging": {
    "level": "info",
    "error_notification": true
  }
}
```

---

## 请求追踪

每个用户操作或系统事件生成一个 `trace_id`，在操作链中传递：

```typescript
// 前端
const trace_id = crypto.randomUUID()
logger.info("开始摄取文件", { trace_id, file_name: "doc.pdf" })

// IPC 调用时 trace_id 自动附加
await invoke("auto_ingest", { filePath: "doc.pdf", trace_id })
```

后端接收 trace_id 后，通过 tracing span 在整个调用链中传播：

```rust
#[instrument(name = "auto_ingest", skip(file_path), fields(trace_id = %trace_id, file_path = %file_path))]
async fn auto_ingest(file_path: String, trace_id: String) -> Result<(), String> {
    info!("开始摄取文件");
    // ... 所有子调用继承 trace_id
}
```

**注**：`#[instrument(fields(...))]` 中定义的参数会自动出现在 span 的 fields 中，同时也合并到每个 event 的 fields 中。因此 JSON 输出中 `file_path` 同时出现在 `span` 和 `fields` 里是正常的 tracing 行为，不是重复记录。

---

## 错误处理与降级

1. **IPC 不可用**（应用启动早期）：回退到原生 console API
2. **后端日志模块未初始化**：前端累积缓冲（最多 50 条），初始化后批量发送
3. **磁盘空间不足**：记录警告并停止写入，不影响应用运行
4. **日志发送失败**：不影响业务逻辑，静默丢弃
5. **clear_logs 后文件重建**：tracing-appender 的 RollingFileAppender 会在下次写入时自动创建新文件，无需应用侧手动重建

### 敏感数据脱敏策略

以下字段类型在写入日志前自动脱敏：
- **API Key / Token**：替换为 `[REDACTED:credential]`
- **用户内容**：截断至前 100 字符，附加 `...(truncated)`
- **文件路径**：保留文件名，隐藏用户目录路径（如 `~/.../document.pdf`）
- **请求体**：仅记录大小（`payload: 1024 bytes`），不记录内容

脱敏在 Logger Facade（前端）和 Log Router（后端）分别执行，双重防护。

---

## 实施阶段

### 阶段 1：基础设施（优先级 P0）

- 添加依赖：`tracing`, `tracing-subscriber`, `tracing-appender`（Rust）
- 实现 Logger Facade（`src/lib/logger.ts`）——基于浏览器原生 API
- 实现后端 Log Router + Tracing Layer（`src-tauri/src/logging/`）
- 统一日志管理器（初始化、级别控制、轮转）
- 设置界面的日志级别配置项
- **迁移现有日志**：替换 62 个 eprintln! 调用（含 panic_guard.rs）

### 阶段 2：增强功能（优先级 P1）

- UUID 请求追踪
- Error 日志优先级提升 + 用户通知（独立大 channel，降低丢失概率）
- 日志导出功能
- 日志清理功能

### 阶段 3：高级功能（优先级 P2）

- 日志采样（高频操作的降采样）
- 结构化日志查询（JSONL 文件搜索）
- 移除旧 console 调用（不改变日志内容，仅替换 API）——使用 lint 工具验证
- **应用内日志查看器**（扩展设置界面，直接查看最近日志）

---

## 依赖清单

### 前端新增

无新增第三方依赖。Logger Facade 基于浏览器原生 API 实现（`console` + `crypto.randomUUID()` + JSON 序列化）。

### 后端新增

```toml
[dependencies]
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["json", "env-filter", "fmt"] }
tracing-appender = "0.2"
```

**注**：`json` 和 `fmt` 特性共存是因为我们需要双输出层：开发模式控制台使用 fmt（人类可读），文件始终使用 json（结构化）。两者独立配置，不冲突。`uuid = { version = "1", features = ["v4"] }` 已存在于 Cargo.toml，无需新增。

---

## 性能考虑

1. **后台缓冲写入**：使用 tracing-appender 的 NonBlocking 模式，基于 MPSC channel + 后台写入线程，不阻塞业务逻辑。channel 满时丢弃新日志（可配置容量）。
2. **Error 日志优先级提升**：由于 NonBlocking 模式的异步特性，严格的"立即 flush"不可行（需引入文件写入竞争）。采用**方案 B**：Error 日志使用单独的、容量更大的 channel（如 10000 条 vs 普通 1000 条），降低丢弃概率，但不保证立即持久化。tradeoff：牺牲严格实时性换取架构简洁性和无锁写入。
3. **前端非阻塞**：IPC 调用使用 `async` 不等待响应，发送后立即返回。
4. **生产环境过滤**：debug/info 级别日志在生产环境默认不发送，前端预过滤减少 IPC 开销。
5. **高频模块采样**：向量搜索、文件监听等高频模块可选降采样（阶段 3）。

### 日志输出格式

| 环境 | 控制台输出 | 文件写入 |
|------|-----------|---------|
| 开发模式 | 人类可读（tracing-subscriber fmt layer） | JSON（便于查询） |
| 生产模式 | 禁用（仅写入文件） | JSON |

**注**：开发模式控制台输出使用人类可读格式，提高本地调试效率；文件始终使用 JSON 格式，便于后续分析。

---

## 测试策略

### 阶段 1

- Logger Facade 单元测试（验证 log/info/warn/error/debug 方法）
- Mock IPC 测试（验证日志正确序列化）
- Rust 端 Tracing Layer 单元测试（验证格式输出）
- 日志级别控制集成测试

### 阶段 2

- Error 日志优先级 channel 测试（验证独立 channel 容量和丢日志行为）
- 导出功能测试（验证 JSONL 格式正确）
- 轮转策略测试（验证 10MB 限制 + 5 文件保留）

### 阶段 3

- 降级策略测试（IPC 不可用时的回退）
- 采样逻辑测试

---

*设计文档完成时间：2026-06-14*

---

## 实施记录

### 阶段 1（P0 基础设施）
- ✅ 完成日期：2026-06-14
- ✅ 测试覆盖：
  - 前端 Logger Facade 单元测试：4 个（`src/lib/__tests__/logger.test.ts`）
  - 前端集成测试：3 个（`src/lib/__tests__/logging-integration.test.ts`：级别往返、批量发送、级别过滤）
  - 后端 Rust 测试：4 个（`logging::router::tests` 2 + `logging::manager::tests` 2）
  - 合计 11 个自动化测试全部通过
- ✅ 编译验证：
  - `cargo check` 通过（仅 9 个 dead_code 警告，0 错误；生产代码 0 eprintln!）
  - `npm run typecheck` 仅 8 个预存错误（均位于 `App.tsx` / `auth-*` / `api-client.ts` / `commands/fs.ts`，与日志系统无关，日志系统 0 错误）
- ✅ 关键实现决策：
  - 单 channel 架构（删除早期双 channel 设计 dead code，保留 Error 优先级通过级别本身语义表达）
  - `OnceLock<LogManager>` 取代 `static mut`，规避 unsafe
  - 前端 Logger Facade：50ms / 100 条批处理触发双阈值，level 过滤前置减少 IPC 往返
  - 文件轮转：基于 10MB 大小 + 保留 5 个历史文件，rotate 时校验文件存在性避免链断裂
  - 配置 UI：选项卡按钮模式（DEBUG / INFO / WARN / ERROR），optimistic 更新 + 失败回滚
  - Tauri 命令：6 个（`send_log` / `get_log_level` / `set_log_level` / `list_log_files` / `read_log_file` / `clear_logs`）
  - 初始化时序：前端 `main.tsx::initLogger()`（读后端 level 配置）+ 后端 `lib.rs::setup`（init_logging）
  - 已迁移：`panic_guard.rs` 1 处 + 其他 Rust 文件 61 处 `eprintln!` → tracing 宏，保留 `fs.rs` 测试 7 处

### 阶段 2 / 3（P1/P2 待实施）
- ⏳ Error 日志独立大 channel（降低丢失概率）
- ⏳ 日志导出功能（JSONL）
- ⏳ 降级策略与采样
