# LLM Wiki 日志系统阶段 3 - 批次 A 设计文档（console 迁移 + 采样）

> **日期**: 2026-06-15 | **版本**: 0.1.0 | **状态**: 设计已确认，待实施
> **前置**: 阶段 1（基础设施）+ 阶段 2（trace 传播 + Error 通知）已完成
> **分支**: `log-system`

---

## 1. 概述

阶段 3 分解为 3 个独立批次。本批次（A）是**基础层**，包含两项相互独立但都围绕 Logger Facade 的功能：

1. **console 迁移清理** —— 将前端 202 处散落的 `console.log/warn/error` 迁移到阶段 1 的 Logger Facade，让所有前端日志进入统一系统（阶段 1 只完成了 Rust 端 eprintln! 迁移，前端 console 是未完成的半边）。
2. **时间窗口采样器** —— 在 Logger Facade 内部加轻量采样，默认关闭，为未来高频模块（流式 LLM token、向量搜索）预留防爆炸能力。

### 1.1 目标

- 前端业务代码全部通过 Logger Facade 记日志（统一格式、持久化、可追溯 trace_id）
- console 调用仅保留在合理例外处（Logger 自身 fallback、测试、初始化前）
- Logger Facade 具备采样能力（默认关闭，配置即启用，ERROR 免疫）

### 1.2 非目标（YAGNI）

- ❌ 模块级精细采样率配置（每模块独立采样率）—— 当前无高频源，过早
- ❌ 采样配置 UI —— 默认关闭，未来按需加
- ❌ 批次 B/C 的内容（read_log_file 命令、应用内查看器、JSONL 查询）—— 独立批次
- ❌ 改变 Logger 已有行为（批处理、级别过滤、IPC、trace_id 生成）—— 仅增量

### 1.3 批次划分回顾

| 批次 | 内容 | 状态 |
|------|------|------|
| **A（本文档）** | console 迁移 + 采样 | 设计中 |
| B | read_log_file 命令 + 应用内查看器 | 待 brainstorm |
| C | JSONL 结构化查询 | 待 brainstorm |

---

## 2. 背景：当前 console 现状

阶段 1 完成了 Rust 端 `eprintln!` → tracing 迁移（62 处 + panic_guard），但**前端 console 未动**。当前实测：

| console 调用 | 数量 | 典型场景 |
|-------------|------|---------|
| `console.warn` | 90 | 设置变更、降级提示、兼容性警告 |
| `console.error` | 63 | catch 块错误（App.tsx 启动流程占约 6 处）、IPC 失败 |
| `console.log` | 48 | 调试输出（`[test]`、`[update-check]` 前缀） |
| **合计** | **202** | 分布在 20+ 个文件 |

**关键事实**：
- 目前仅 **1 个业务文件** 使用了 `createLogger`（阶段 2 间接引入）
- `logger.ts:55` 有 1 处 `console.error`（Logger 自身 IPC 失败的 fallback）—— **不能迁移**，否则递归
- `llm-client.ts`（流式 token）当前 **0 处日志** —— 采样是前瞻性准备，非紧急

---

## 3. 架构

```
┌──────────── 前端业务代码（20+ 文件）────────────┐
│  每个文件顶部：const logger = createLogger("xxx") │
│  console.error → logger.error                     │
│  console.warn  → logger.warn                      │
│  console.log   → logger.debug                     │
└──────────────────────────┬────────────────────────┘
                           ▼
┌──────────── Logger Facade（src/lib/logger.ts）──┐
│  现有：shouldLog 级别过滤 → 批处理 → IPC           │
│  ★新增：shouldSample 时间窗口采样（log() 入口）    │
│    ├─ ERROR 免疫                                  │
│    ├─ 默认 Infinity（不启用）                     │
│    └─ 每秒窗口计数，超阈值丢弃非 ERROR             │
└──────────────────────────┬────────────────────────┘
                           ▼ IPC → 后端（阶段 1 既有，不变）
```

---

## 4. 功能 1：console 迁移

### 4.1 迁移规则

| 原调用 | 迁移目标 | 级别语义 |
|--------|---------|---------|
| `console.error(...)` | `logger.error(msg, data)` | 诊断错误，持久化 + 触发阶段 2 的 ERROR 通知 |
| `console.warn(...)` | `logger.warn(msg, data)` | 警告，持久化 |
| `console.log(...)` | `logger.debug(msg, data)` | 调试输出，降级为 DEBUG（生产默认 WARN 不显示） |
| `console.info(...)` (1 处) | `logger.info(msg, data)` | 罕见，保持 INFO |
| `console.debug(...)` (1 处) | `logger.debug(msg, data)` | 直接映射 |

### 4.2 合理例外（保留 console，不迁移）

| 场景 | 文件:行 | 原因 |
|------|---------|------|
| Logger 自身 IPC fallback | `logger.ts:55` | 替换会递归（logger 内部失败再调 logger） |
| 测试文件 | `*.test.ts(x)` | 测试输出不经业务日志系统 |
| Logger 初始化前的启动代码 | `main.tsx` initLogger() 调用之前的行 | Logger 模块级状态未就绪（logger.ts 已有 console fallback + 缓冲，但启动最早期保守保留） |

> **注**：`error-boundary.tsx` **不列为例外** —— 迁移为 `logger.error`。Logger 内部已有 try-catch + console fallback，即使 React 渲染崩溃时调用也安全。这是有价值的：渲染崩溃能被持久化并触发通知。

### 4.3 迁移模式

**步骤 1：每个业务文件顶部加 logger**

```typescript
import { createLogger } from "@/lib/logger"
const logger = createLogger("module-name")
```

**步骤 2：参数规范化**

console 的多参数/模板字符串习惯需转为 Logger 的 `(message, data?)` 结构：

```typescript
// 之前（console 习惯：多参数拼接）
console.error("Failed to restore ingest queue:", err)
console.log("[update-check] skipped:", reason, "version:", version)

// 之后（Logger 结构化）
logger.error("Failed to restore ingest queue", { error: String(err) })
logger.debug("update check skipped", { reason, version })
```

**规范化规则**：
- 第一个参数提取为人类可读 `message`（去 `[prefix]` 前缀，前缀作为 module 名已在 createLogger 体现）
- 后续参数转为 `data` 对象（`{ error: String(err) }` 避免序列化异常对象）
- 模板字符串 `` `text ${x}` `` 拆为 `("text", { x })`

### 4.4 模块命名约定

取文件核心职责的短名（snake/kebab 不限，保持简洁）：

| 文件 | module 名 |
|------|----------|
| `App.tsx` | `"app"` |
| `main.tsx` | `"main"` |
| `components/chat/chat-panel.tsx` | `"chat"` |
| `components/graph/graph-view.tsx` | `"graph"` |
| `components/settings/settings-view.tsx` | `"settings"` |
| `components/layout/app-layout.tsx` | `"layout"` |
| `components/search/search-view.tsx` | `"search"` |
| `components/error-boundary.tsx` | `"error-boundary"` |
| `lib/wiki-graph.ts` | `"wiki-graph"` |
| 其余类推（按文件功能取短名） | — |

> 注：Logger 的 `extractModule()` 会从调用栈提取文件路径作为 module 字段，`createLogger(name)` 的 `name` 参数实际用于日志的可读标识。两者并存，`name` 是显式可读名。

---

## 5. 功能 2：时间窗口采样器

### 5.1 设计

在 `src/lib/logger.ts` 的 `log()` 函数中，`shouldLog` 之后新增 `shouldSample` 检查。

**模块分割**：核心判定逻辑提取为**导出的纯函数 `shouldSampleAt`**（无副作用、可单测），`shouldSample` 是薄包装（读取/写回模块级状态）。这样 5.1 的实现与 7.1 的测试策略一致。

```typescript
/** 采样配置：每秒最多记录的非 ERROR 日志条数。
 *  默认 Infinity（不启用限流）。当前无高频源，保持关闭。
 *  未来高频模块出现时，改为具体数值（如 100）或从 app-state.json 读取。 */
const RATE_LIMIT_PER_SEC = Infinity;

/** 采样器状态（模块级，所有 Logger 实例共享） */
let sampleWindowStart = 0;
let sampleWindowCount = 0;

/** 纯函数：时间窗口采样判定（无副作用，供单测直接调用）。
 *  输入当前状态，返回是否允许 + 新状态。shouldSample 薄包装负责写回。
 *
 *  - ERROR 永不采样丢弃（诊断价值最高，且阶段 2 通知依赖）
 *  - 未启用限流（Infinity）时全通过
 *  - 每秒一个窗口，窗口内超阈值则丢弃该条 */
export function shouldSampleAt(
  level: LogLevel,
  now: number,
  windowStart: number,
  windowCount: number,
  threshold: number
): { allow: boolean; newWindowStart: number; newWindowCount: number } {
  if (level === "ERROR") return { allow: true, newWindowStart: windowStart, newWindowCount: windowCount };
  if (threshold === Infinity) return { allow: true, newWindowStart: windowStart, newWindowCount: windowCount };

  if (now - windowStart >= 1000) {
    // 窗口过期：重置
    return {
      allow: 1 <= threshold,
      newWindowStart: now,
      newWindowCount: 1,
    };
  }
  const newCount = windowCount + 1;
  return {
    allow: newCount <= threshold,
    newWindowStart: windowStart,
    newWindowCount: newCount,
  };
}

/** 薄包装：读取模块级状态 → 调用纯函数 → 写回状态。 */
function shouldSample(level: LogLevel): boolean {
  const result = shouldSampleAt(
    level,
    Date.now(),
    sampleWindowStart,
    sampleWindowCount,
    RATE_LIMIT_PER_SEC
  );
  sampleWindowStart = result.newWindowStart;
  sampleWindowCount = result.newWindowCount;
  return result.allow;
}
```

**集成到 `log()`**：

```typescript
function log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
  if (!shouldLog(level)) return;
  if (!shouldSample(level)) return;  // ★新增：采样拦截（在级别过滤之后）

  // ... 原有 entry 构建、console 输出、addToBatch 不变
}
```

### 5.2 设计要点

1. **位置在 `shouldLog` 之后**：级别过滤优先（低于设定级别的日志先丢弃，不占采样配额）。
2. **ERROR 免疫**：与阶段 2 NotifyLayer 的"ERROR 永不漏抓"理念一致。
3. **默认关闭（Infinity）**：当前无高频源，迁移后行为零变化。仅当未来将常量改为数值时才生效。
4. **共享模块级状态**：`sampleWindowStart/Count` 是模块级变量，所有 createLogger 实例共享，实现全局限流。
5. **被丢弃日志不进批处理缓冲**：在 `log()` 入口拦截，减少 IPC 开销。
6. **扩展点**：`RATE_LIMIT_PER_SEC` 是常量，未来改为 `let` + 从 app-state.json 读取（类似阶段 2 的 error_notification 配置）即可启用，无需改 `shouldSample` 逻辑。

### 5.3 为什么不做模块级采样

- 当前 0 个高频模块（llm-client 流式 token 不记日志）
- 模块级采样需维护"每模块独立窗口 + 配置 API"，约 80 行代码 + UI，YAGNI
- 全局令牌桶足以防爆炸；真出现单模块刷屏，再加模块级（届时已有真实数据指导阈值）

---

## 6. 错误处理

| 场景 | 处理 | 影响 |
|------|------|------|
| 迁移后 logger 未初始化（main.tsx 早期） | logger.ts 已有 console fallback + 50 条缓冲，初始化后批量发送 | 安全 |
| error-boundary 中 logger 自身崩溃 | logger.ts flushBatch 内部 try-catch + console.error fallback | 安全 |
| 采样误丢关键日志 | ERROR 免疫 + 默认关闭 | 风险极低 |
| console 调用序列化异常对象（如 DOM 节点） | 迁移时用 `String(err)` / 选择性字段，避免 JSON.stringify 崩溃 | 迁移时规范化 |
| `Date.now()` 在 logger 不可用时 | 不会发生（Date 是浏览器原生，始终可用） | 无 |

---

## 7. 测试策略

### 7.1 可自动化测试（采样器）

| 测试项 | 验证点 |
|--------|--------|
| 默认 Infinity 全通过 | RATE_LIMIT_PER_SEC=Infinity 时 shouldSample 对所有级别返回 true |
| ERROR 免疫 | 即使超阈值，ERROR 仍返回 true |
| 窗口内超阈值丢弃 | 阈值=2，连续 3 条 DEBUG：前 2 条 true，第 3 条 false |
| 窗口重置恢复 | 跨过 1 秒窗口后计数重置，恢复允许 |
| 非首条 INFO 受限 | 阈值=2 下 DEBUG+INFO+DEBUG+INFO 序列验证计数跨级别累计 |

**测试要点**：`shouldSample` 用 `Date.now()`，测试需注入假时间。方案：将核心逻辑提取为纯函数 `shouldSampleAt(level, now, windowStart, windowCount, threshold)` 返回 `{ allow, newWindowStart, newWindowCount }`，测试直接传入构造值。与阶段 2 `acquire_slot_at` 同模式。

### 7.2 迁移完整性验证（脚本检查）

```bash
# 业务 console 应为 0（排除合理例外 + 注释/字符串字面量误报）
grep -rn "console\.\(log\|warn\|error\|info\|debug\)" src/ --include="*.ts" --include="*.tsx" \
  | grep -v "node_modules\|\.test\.\|logger\.ts" \
  | grep -v "^\s*//\|^\s*\*\|^\s*/\*\|\*/"
# Expected: 0 行（或仅剩 logger.ts:55 一行）
```

> logger.ts:55 是合理例外（Logger 自身 fallback），保留。其余业务文件应为 0。
> grep 的 `-v` 分支过滤常见注释格式（`//`、`*`、`/* */`），避免匹配注释里提及 console 的文本。若需更强保证，改用 AST 级校验：在项目 `.eslintrc` 临时启用 `no-console: error` 规则跑一次 `npx eslint src/`，零误报。

### 7.3 手动验证

- 迁移后触发一个业务错误（如启动失败），查看 `llm-wiki.log` 确认带 module 名 + trace_id
- 确认 console 在开发模式仍输出（logger.ts 的 `import.meta.env.DEV` 分支）

---

## 8. 实施任务拆解（批次 A，6 项）

| # | 任务 | 依赖 | 产出 |
|---|------|------|------|
| 1 | logger.ts 加时间窗口采样器 + shouldSampleAt 纯函数 + 5 个单测 | 无 | logger.ts |
| 2 | 迁移核心启动流程（main.tsx 初始化后 + App.tsx，约 30 处） | 1 | main.tsx, App.tsx |
| 3 | 迁移 settings 模块（settings-view + 5 个 section，约 40 处） | 1 | settings/* |
| 4 | 迁移 layout/graph/chat/search 模块（约 80 处） | 1 | layout/, graph/, chat/, search/ |
| 5 | 迁移剩余文件（lint/sources/editor/project 等，约 50 处） | 1 | 其余 |
| 6 | 验证：grep 业务 console=0 + 测试全绿 + 手动确认 | 全部 | 验证记录 |

> 任务 2-5 可并行（不同文件），但每批单独 commit 便于审查回滚。

---

## 9. 依赖清单

### 新增
无。复用阶段 1 的 Logger Facade（`src/lib/logger.ts`、`logger-types.ts`）。

### 变更
- `src/lib/logger.ts`：加 `shouldSample` + `shouldSampleAt` + 采样状态变量
- 20+ 业务文件：加 `createLogger` import + 替换 console 调用

---

## 10. 性能考虑

1. **采样开销**：每条日志多一次 `Date.now()` + 整数比较（纳秒级），默认 Infinity 时仅一次比较即返回 true。
2. **console 迁移开销**：每条日志多走 Logger 的批处理（50ms/10条），反而**减少** IPC 往返（console 是同步、分散的）。
3. **被采样丢弃的日志零开销**：在 `log()` 入口 return，不构建 entry、不进缓冲。

---

## 11. 与阶段 1/2 的关系

- **不修改**阶段 1 的 Logger 批处理、级别过滤、IPC、trace_id 生成逻辑（仅增量加采样）
- **不修改**阶段 2 的 invokeTraced、#[instrument]、NotifyLayer
- console 迁移让阶段 1 的 Logger Facade 真正被业务广泛使用（之前只有 1 个文件用）
- 采样器与阶段 2 NotifyLayer 的 ERROR 优先理念一致（ERROR 免疫）

---

## 12. 风险与缓解

| 风险 | 缓解 |
|------|------|
| 202 处迁移量大，易遗漏 | 拆 4 批 commit + grep 验证脚本（任务 6）兜底 |
| console 多参数格式不统一，迁移质量参差 | 制定规范化规则（4.3），每批 commit 审查 |
| 误迁 logger.ts:55 导致递归 | 明确列为例外（4.2），任务说明强调 |
| 采样默认关闭感觉"没用" | 文档说明是前瞻性预留，YAGNI 原则下不提前加 UI |

---

*设计文档完成时间：2026-06-15*
