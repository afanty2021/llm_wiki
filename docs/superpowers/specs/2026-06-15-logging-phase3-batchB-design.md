# LLM Wiki 日志系统阶段 3 - 批次 B 设计文档（read_log_file 命令 + 应用内日志查看器）

> **日期**: 2026-06-15 | **版本**: 0.1.0 | **状态**: 设计已确认，待实施
> **前置**: 阶段 1（基础设施）、阶段 2（trace 传播 + Error 通知）、批次 A（console 迁移 + 采样）已完成
> **分支**: `log-system`

---

## 1. 概述

批次 B 是阶段 3 的**观察层**，补齐"让日志可观察"的能力。阶段 1 交付了日志写入基础设施（文件轮转、6 个 Tauri 命令），但唯独缺少 `read_log_file` 命令——这意味着日志写入了文件，却没有任何方式在应用内查看它们。批次 B 补齐这个命令，并构建一个集成在 Settings 中的日志查看器 UI。

### 1.1 目标

- 后端新增 `read_log_file` 命令：分页读取 JSONL 日志，支持级别/关键字/trace_id 过滤，反序扫描避免加载全文件到内存
- 前端新增 LogsSection 查看器组件：级别复选、搜索框、trace_id 输入、分页翻页、ERROR 行高亮
- 发挥阶段 2 trace 传播价值：输入一个 trace_id 即可追踪该请求的全链路日志

### 1.2 非目标（YAGNI）

- ❌ 实时 tail -f 跟踪（桌面应用查看器非持续监视，页面刷新即可）
- ❌ 导出筛选结果（已有 `export_logs` 命令覆盖全部文件导出）
- ❌ 日志统计/聚合/图表（批次 C 可考虑）
- ❌ 日志文件删除/清除（已有 `clear_logs` 命令）
- ❌ read_log_file 不修改日志文件内容——纯只读

### 1.3 批次划分回顾

| 批次 | 内容 | 状态 |
|------|------|------|
| A | console 迁移 + 采样 | ✅ 已完成 |
| **B（本文档）** | read_log_file 命令 + 应用内日志查看器 | 设计中 |
| C | JSONL 结构化查询（可能并入批次 B 的查看器） | 待 brainstorm |

---

## 2. 背景：当前日志基础设施现状

| 能力 | 阶段 | 状态 |
|------|------|------|
| 日志写入（JSONL，10MB 轮转，保留 5 个历史） | 1 | ✅ |
| 级别控制（6 个命令：send/get/set/list/clear/export） | 1 | ✅ |
| trace_id 传播（前后端） | 2 | ✅ |
| ERROR 桌面通知 | 2 | ✅ |
| **应用内查看日志** | — | ❌ **缺失** |
| **read_log_file 命令** | — | ❌ **缺失** |

现有日志命令清单（`src-tauri/src/lib.rs:251+`）：
```
send_log, get_log_files, clear_logs, export_logs, get_log_level, set_log_level
```

缺失：`read_log_file`（阶段 1 设计文档 §6 接口表中列了但未实现）。

---

## 3. 架构总览

```
┌────────── 前端 LogsSection（settings 新章节）──────────┐
│                                                        │
│  Level: [DEBUG☐] [INFO☑] [WARN☑] [ERROR☑]             │
│  🔍 [keyword search]   trace_id: [________________]    │
│                                              [Refresh] │
│                                                        │
│  ┌── 条目列表（按时间降序，每页 100 条）──────────────┐│
│  │ ─ Time ───── L ── Module ── Message ───────────── ││
│  │ 10:00:01     ERR  ingest    Failed to read file   ││
│  │ 09:59:58     WARN app       update-check 429      ││
│  │ 09:59:50     DBG  ingest    step 1: analysis      ││
│  └────────────────────────────────────────────────────┘│
│                                                        │
│              ← Prev  [1 / 5]  Next →     共 487 条    │
└───────────┬────────────────────────────────────────────┘
            │ invoke("read_log_file", { limit, offset, ... })
            ▼
┌─────────── 后端 read_log_file（manager.rs）──────────────┐
│  1. 收集 logs/ 下所有 *.log 文件（按修改时间降序）        │
│  2. 逐文件反序读取行块                                   │
│  3. 每行 serde_json → 提取 timestamp/level/module/msg/   │
│     trace_id，按条件过滤                                  │
│  4. 跳过 offset 条，收集 limit 条 → 提前终止             │
│  5. 返回 ReadLogResponse                                 │
└──────────────────────────────────────────────────────────┘
```

---

## 4. `read_log_file` 命令设计

### 4.1 参数（前端传入）

```typescript
// 前端类型（src/lib/logger-types.ts 新增）
interface ReadLogRequest {
  limit: number        // 每页条数，默认 100，最大 500
  offset: number       // 偏移量，默认 0
  level?: LogLevel[]   // 级别筛选，默认不过滤（空数组 = 全部）
  keyword?: string     // 关键字模糊搜索（message + module）
  traceId?: string     // 精确 trace_id 匹配
}

interface LogDisplayEntry {
  timestamp: string    // "2026-06-15T10:00:01.123Z"
  level: LogLevel      // "DEBUG" | "INFO" | "WARN" | "ERROR"
  module: string       // 后端: target（如 llm_wiki::commands::fs）；前端: span.module
  message: string      // 日志正文（从 fields.message 提取）
  traceId: string | null  // 请求追踪 ID（阶段 2 起有；旧日志可为 null）
}

interface ReadLogResponse {
  entries: LogDisplayEntry[]
  total: number        // 符合筛选条件的总条数
  offset: number
  limit: number
}
```

### 4.2 后端实现（manager.rs 新增）

```rust
/// 分页读取日志文件（反序扫描，不支持实时追加扫描）。
///
/// # 参数
/// - app_data_dir: 应用数据目录（内部拼接 "logs" 子目录）
/// - limit: 每页条数（最大 500）
/// - offset: 偏移量
/// - level_filter: 级别筛选（如 ["ERROR","WARN"]，空 = 不限）
/// - keyword: 模糊匹配 message + module
/// - trace_id: 精确匹配 span.trace_id
///
/// # 返回
/// ReadLogResponse { entries, total, offset, limit }
///
/// # 读取策略
/// 1. 收集 logs/ 下所有 *.log 文件，按修改时间降序（当前文件在前）
/// 2. 逐文件从尾向首扫描（通过 seek + read 块读取 → 按行 reverse），
///    避免加载全文件到内存
/// 3. 每行尝试 serde_json::from_str，失败则跳过（容忍非 JSON 行）
/// 4. 提取字段：timestamp/level/target → module / span.trace_id / fields.message
/// 5. 应用过滤条件
/// 6. 跳过 offset 条，收集 limit 条后提前终止
/// 7. total 仅在首次请求（offset=0, 相同 filter）时计算；翻页请求复用
///    首次请求的 total（通过 "上次过滤条件 hash → total 值" 缓存）
///    简化：每次调用都扫描完打印 total，性能够用（文本扫描 60MB < 1s）
pub fn read_log_file(
    app_data_dir: PathBuf,
    limit: usize,
    offset: usize,
    level_filter: Option<Vec<String>>,
    keyword: Option<String>,
    trace_id: Option<String>,
) -> Result<ReadLogResponse, String>
```

### 4.3 JSONL 字段提取规则

日志文件是 `tracing-subscriber` JSON fmt layer 的输出。每条日志是一行 JSON：

```json
{"timestamp":"...","level":"ERROR","target":"llm_wiki::commands::fs",
 "span":{"name":"read_file","trace_id":"uuid","path":"../doc.pdf"},
 "fields":{"message":"Failed to read file: PermissionDenied"}}
```

**字段映射**：

| LogDisplayEntry 字段 | JSONL 来源（按优先级） | 后备 |
|---------------------|-----------|------|
| `timestamp` | `json["timestamp"]` | — |
| `level` | `json["level"]` | — |
| `module` | ① `json["span"]["module"]`（前端日志，如 `"src/lib/ingest.ts"`）<br>② `json["target"]`（后端日志，如 `llm_wiki::commands::fs`；**仅当 target ≠ `"frontend"`** 时采用，前端日志的 target 恒为 `"frontend"` 无意义） | `"(unknown)"` |
| `message` | `json["fields"]["message"]` | `"(no message)"` |
| `traceId` | `json["span"]["trace_id"]` | `null`（阶段 1 日志无 trace_id） |

**module 提取逻辑**（伪代码）：
```
if let Some(m) = span.get("module") { module = m }           // 前端日志
else if target != "frontend" { module = target }             // 后端日志
else { module = "(unknown)" }                                // 后备
```

### 4.4 过滤逻辑

- **level**：`entry.level` 在 `level_filter` 集合中（空 = 全通过）
- **keyword**：`entry.message.contains(kw)` 或 `entry.module.contains(kw)`（大小写不敏感）
- **trace_id**：`entry.traceId == Some(tid)`（精确匹配）

### 4.5 读取算法（反序扫描，伪代码）

```
files = sort_by_mtime_desc(glob(logs/*.log))
collected = []
total = 0

for file in files:
    for line in file.read_lines_reverse():  // 从文件尾向前逐行读取
        entry = serde_json::from_str(line)
        if entry is Err → skip（非 JSON 行，容忍）

        display = extract_fields(entry)
        if !matches_filter(display) → continue

        total += 1
        if total > offset:
            collected.push(display)

        if collected.len() >= limit:
            break  // 提前终止

    if collected.len() >= limit → break

return ReadLogResponse { entries: collected, total, offset, limit }
```

> 反序逐行读取的实现：用 `BufReader` + `seek` 从文件尾向前读块（如 8KB 块），在块内按 `\n` 分割行后反转顺序。标准库无内置反序行读取器，但可以简单实现（**约 30–80 行**，视边界处理复杂度——需处理：① UTF-8 多字节字符被块边界截断、② `\r\n` 换行、③ 文件开头不足一块的边界）。

### 4.6 Tauri 命令注册

在 `src-tauri/src/lib.rs` 的 `generate_handler!` 数组中追加：
```rust
read_log_file,
```

命令函数体（lib.rs 内，**async fn** 以支持 spawn_blocking）：
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
    // spawn_blocking：文件扫描是阻塞 I/O，移到 tokio 阻塞线程池，
    // 避免占用 async worker。命令必须为 async fn 才能用 spawn_blocking。
    tauri::async_runtime::spawn_blocking(move || {
        logging::read_log_file(app_data_dir, limit, offset, level, keyword, trace_id)
    })
    .await
    .map_err(|e| format!("read_log_file task join error: {e}"))?
}
```

### 4.7 并发安全（reader 与 NonBlocking writer）

`read_log_file` 用独立 `File::open` 打开日志文件，与 `SizeBasedRollingFileAppender` 的后台写线程（`Arc<Mutex<File>>`）并发访问同一文件。三种场景分析：

| 场景 | 行为 | 降级 |
|------|------|------|
| **正常并发读（Unix）** | reader/writer 两个 fd 共享 inode，reader 能看到已落盘数据 | ✅ 无问题 |
| **轮转竞态** | reader 打开 `llm-wiki.log` 后，writer 触发轮转将其 rename 为 `llm-wiki.1.log`。Unix fd 跟踪 inode，reader 继续从已重命名文件读取，可能跨两个物理文件边界 → 部分行丢失或截断 | **不崩溃**：截断的行 JSON 解析失败 → 跳过（§4.5 容忍逻辑）。轮转是低频事件（10MB 才触发），影响极小 |
| **部分写入行** | writer buffered 状态写入半行 JSON，reader 读到不完整行 | `serde_json::from_str` 返回 Err → 跳过该行，不中断扫描 |
| **Windows** | `append(true)` 默认 `FILE_SHARE_READ`，允许并发读 | ✅ 无问题 |

**结论**：read_log_file 无需加锁，与 writer 并发安全。最坏情况（轮转瞬间）丢失少量行，可接受——查看器是诊断工具而非审计系统。

### 4.8 前端封装（`src/commands/logging.ts` 新增）

```typescript
export async function readLogFile(
  limit: number = 100,
  offset: number = 0,
  level?: LogLevel[],
  keyword?: string,
  traceId?: string,
): Promise<ReadLogResponse> {
  return invoke("read_log_file", { limit, offset, level, keyword, traceId })
}
```

---

## 5. LogsSection UI 组件设计

### 5.1 放置位置

`src/components/settings/sections/logs-section.tsx`，在 `settings-view.tsx` 的 section 列表中注册（如 `GeneralSection` 下的独立 section）。

### 5.2 布局结构

```
┌── Level ────────────────────────── Search ─────────────────────┐
│                                                                 │
│  [DEBUG] [INFO] [WARN] [ERROR]                                 │
│  🔍 [          keyword search            ]                     │
│  trace_id: [______________________________]                    │
│                                                       [刷新]    │
│                                                                 │
├── 日志表格 ─────────────────────────────────────────────────────┤
│                                                                 │
│  时间          级别   模块       消息                            │
│  ────────────  ────  ─────────  ────────────────────────────    │
│  10:00:01.123  ERROR  ingest     Failed to read file (红色背景) │
│  09:59:58.456  WARN   app        update check: HTTP 429         │
│  09:59:50.789  DEBUG  ingest     step 1: analysis done          │
│                                                                 │
├── 分页 ─────────────────────────────────────────────────────────┤
│                                                                 │
│  ← 上一页          [1 / 5]          下一页 →         共 487 条  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 5.3 核心状态与逻辑

```typescript
function LogsSection() {
  const [entries, setEntries] = useState<LogDisplayEntry[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [limit] = useState(100)
  const [levels, setLevels] = useState<LogLevel[]>(["ERROR","WARN","INFO"])  // DEBUG default off
  const [keyword, setKeyword] = useState("")
  const [traceId, setTraceId] = useState("")
  const [loading, setLoading] = useState(false)

  // 翻页 / 过滤变更 → 重新加载
  useEffect(() => {
    setLoading(true)
    const offset = page * limit
    readLogFile(limit, offset, levels.length < 4 ? levels : undefined, keyword || undefined, traceId || undefined)
      .then(res => { setEntries(res.entries); setTotal(res.total) })
      .catch(err => { /* error boundary fallback */ })
      .finally(() => setLoading(false))
  }, [page, levels, keyword, traceId])
}
```

### 5.4 UI 细节

- **级别按钮**：4 个 toggle chip（参照 stage2 `LoggingConfig` 风格），默认选中 ERROR+WARN+INFO，DEBUG off。点击切换选中/反选。当 4 个全选时等效于不传 level（后端 level_filter=None）。
- **搜索框**：input field, 200ms debounce 后触发重新查询（页重置为 0）。
- **trace_id 输入**：input field, 300ms debounce，仅在非空时作为过滤条件传入。
- **表格行**：单行高约 36px，最多显示 100 行（高度 ~3600px），无需虚拟滚动。ERROR 行用 `bg-destructive/10` 高亮。
- **分页栏**：`totalPages = ceil(total / limit)`，当前页 `< 0 ? disable Prev`，`>= totalPages ? disable Next`。
- **空状态**：无日志时显示 `"暂无日志记录"` 提示文字。
- **加载状态**：查询中显示 spinner 或骨架。

### 5.5 与现有 settings section 模式一致

参照现有 section（如 `GeneralSection`、`MaintenanceSection`）的卡片式布局：
```tsx
<div className="space-y-4">
  <div>
    <h3 className="text-lg font-medium">Log Viewer</h3>
    <p className="text-sm text-muted-foreground">View and search application logs</p>
  </div>
  {/* level filters + search */}
  {/* log table */}
  {/* pagination */}
</div>
```

---

## 6. 接口汇总

### 6.1 新增 Tauri 命令

| 命令 | 输入 | 输出 | 说明 |
|------|------|------|------|
| `read_log_file` | `ReadLogRequest` | `ReadLogResponse` | 分页读取日志（带过滤） |

### 6.2 新增/修改文件

| 文件 | 职责 | 类型 |
|------|------|------|
| `src-tauri/src/logging/manager.rs` | 新增 `read_log_file` 函数 + 反序行读取器 | 修改 |
| `src-tauri/src/lib.rs` | 注册 `read_log_file` 命令 | 修改 |
| `src/commands/logging.ts` | 新增 `readLogFile` 封装 | 修改 |
| `src/lib/logger-types.ts` | 新增 `ReadLogRequest/Response/LogDisplayEntry` | 修改 |
| `src/components/settings/sections/logs-section.tsx` | LogsSection 查看器 UI 组件 | 新建 |
| `src/components/settings/settings-view.tsx` | 注册 LogsSection | 修改 |

---

## 7. 错误处理与降级

| 场景 | 处理 |
|------|------|
| logs 目录不存在（应用未运行过） | 返回空列表 `{ entries:[], total:0 }` |
| 日志文件为空 | 返回空列表 |
| 某行 JSONL 解析失败（非 JSON 文本） | 跳过该行（`serde_json::from_str` Err → continue），不中断扫描 |
| offset 超出 total | 返回空 `entries`，`total` 不变 |
| keyword 是空字符串或纯空格 | 后端视为 `None`（不过滤 keyword） |
| trace_id 格式非 UUID（传入任意字符串） | 作为普通字符串精确匹配（宽容处理） |
| 日志文件超过 10MB | 反序扫描只遍历到 offset+limit 条匹配即停止，不会读完整文件 |
| IPC 调用失败（前端） | catch 抛 error，UI 显示 "加载日志失败" |
| 日志文件被外部进程删除/轮转中 | 扫描时自动跳过不存在文件（`read_dir` → `filter_map`） |

---

## 8. 测试策略

### 8.1 可自动化测试（read_log_file 命令）

| 测试项 | 验证点 | 测试文件 |
|--------|--------|---------|
| 空目录返回空列表 | entries=[], total=0 | manager.rs test |
| 基本分页 | limit=5, offset=0 → 5 条；offset=5 → 下 5 条 | manager.rs test |
| offset 超出 total | entries=[], total 不变 | manager.rs test |
| level 过滤 | level=["ERROR"] → 仅返回 ERROR 条目 | manager.rs test |
| keyword 搜索 | keyword="read" → 仅返回 message 含 "read" 的条目 | manager.rs test |
| trace_id 精确匹配 | 仅返回匹配的条目 | manager.rs test |
| 跨文件读取（当前 + 轮转） | 当前文件和 .1.log 均可读取 | manager.rs test |
| JSONL 异常行跳过 | 插入非 JSON 行后不中断、不丢数据 | manager.rs test |
| limit 上限保护 | limit=1000 → 自动 clamp 到 500 | manager.rs test |
| 大小写不敏感 keyword | keyword="READ" 匹配 "read" | manager.rs test |

### 8.2 手动验证（GUI）

- `npm run tauri dev` → Settings → Logs section，确认默认加载最新 100 条
- 级别 toggle 开关 DEBUG，确认可见
- 搜索关键字，确认过滤
- trace_id 输入，确认精确匹配
- 翻页确认 offset 正确

---

## 9. 性能考虑

1. **反序扫描**：从文件尾向前读 8KB 块，在块内按 `\n` 反序——仅读取需要的行。匹配 `offset+limit` 条后立即终止。
2. **最大场景 60MB（6 文件）**：10MB 日志 + 5 个历史轮转。扫描全部 60MB 文本约 <1 秒（SSD），反序扫描仅在需要时遍历文件的一小部分。
3. **spawn_blocking**：文件 I/O 在 tokio 阻塞线程池执行，不阻塞主事件循环。Tauri 命令函数用 `tauri::async_runtime::spawn_blocking` 包裹。
4. **分页上限 500**：前端单次 IPC 最大 ~500 条 JSON 条目（约 500KB），可接受。
5. **翻页请求的 total**：每次 `read_log_file` 调用都完整扫描全部匹配文件以计算 `total`（伪代码 §4.5 即此行为）。这是**有意的简化（YAGNI）**——不引入"过滤条件 hash → total 缓存"的复杂度。最坏情况 60MB 文本扫描 <1 秒（SSD），翻页延迟可接受。若未来日志量增长到秒级延迟，再加缓存。

---

## 10. 与阶段 1/2/批次 A 的关系

- **不修改**阶段 1 的日志写入、轮转、级别控制
- **不修改**阶段 2 的 trace_id 传播、NotifyLayer
- **不修改**批次 A 的采样器、console 迁移
- **新增**只读命令 `read_log_file`（与已有的 `get_log_files`/`clear_logs`/`export_logs` 并列）
- **新增**前端 LogsSection（与 setting sections 并列，参照 `GeneralSection` 风格）

---

## 11. 实施任务拆解（批次 B，5 项）

| # | 任务 | 依赖 | 产出 |
|---|------|------|------|
| 1 | manager.rs 实现 `read_log_file` + 反序行读取器 + 10 个单测 | 无 | manager.rs |
| 2 | lib.rs 注册 `read_log_file` 命令 + logging.ts 新增前端封装 + 类型定义 | 1 | lib.rs, logging.ts, logger-types.ts |
| 3 | LogsSection UI 组件（级别复选/搜索/trace_id/分页/ERROR 高亮） | 2 | logs-section.tsx |
| 4 | settings-view.tsx 注册 LogsSection | 3 | settings-view.tsx |
| 5 | 手动验证文档 | 全部 | validation doc |

---

*设计文档完成时间：2026-06-15*
