# 日志系统阶段 3 批次 A 实施计划（console 迁移 + 采样）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将前端 202 处散落的 `console.*` 调用迁移到 Logger Facade，并在 Logger 中加默认关闭的时间窗口采样器。

**Architecture:** Task 1 用 TDD 在 `logger.ts` 加 `shouldSampleAt` 纯函数 + `shouldSample` 薄包装（ERROR 免疫、默认 Infinity）。Task 2 建立标准迁移流程并以 App.tsx 为完整范例。Task 3-8 按模块聚类批量迁移（每批独立 commit），每批给出精确文件清单 + module 名 + console 定位命令。Task 9 用 grep 脚本 + 测试验证零残留。

**Tech Stack:** TypeScript, React 19, Vitest（前端测试）。复用阶段 1 的 `createLogger`（`src/lib/logger.ts`）。

**参考设计:** `docs/superpowers/specs/2026-06-15-logging-phase3-batchA-design.md` (v0.1.0)

**分支:** `log-system`

---

## File Structure

### 修改的核心文件
- `src/lib/logger.ts` —— 加采样器（Task 1）
- `src/lib/__tests__/logger-sampler.test.ts` —— 新建，采样器单测（Task 1）
- 46 个业务文件 —— console 迁移（Task 2-8）

### module 名映射表（迁移时 createLogger 的参数，全局统一）

| 文件 | module 名 | console 数 |
|------|-----------|-----------|
| `src/main.tsx` | `"main"` | 1 |
| `src/App.tsx` | `"app"` | 16 |
| `src/components/error-boundary.tsx` | `"error-boundary"` | 1 |
| `src/lib/ingest.ts` | `"ingest"` | 38 |
| `src/lib/ingest-queue.ts` | `"ingest-queue"` | 12 |
| `src/lib/ingest-cache.ts` | `"ingest-cache"` | 1 |
| `src/lib/dedup-queue.ts` | `"dedup-queue"` | 6 |
| `src/lib/dedup-runner.ts` | `"dedup-runner"` | 1 |
| `src/lib/sweep-reviews.ts` | `"sweep-reviews"` | 5 |
| `src/lib/page-merge.ts` | `"page-merge"` | 4 |
| `src/lib/embedding.ts` | `"embedding"` | 11 |
| `src/lib/deep-research.ts` | `"deep-research"` | 3 |
| `src/lib/extract-source-images.ts` | `"extract-images"` | 3 |
| `src/lib/image-caption-pipeline.ts` | `"image-caption"` | 5 |
| `src/lib/reset-project-state.ts` | `"reset-project"` | 10 |
| `src/lib/source-lifecycle.ts` | `"source-lifecycle"` | 8 |
| `src/lib/project-file-sync.ts` | `"file-sync"` | 4 |
| `src/lib/wiki-page-delete.ts` | `"wiki-delete"` | 2 |
| `src/lib/scheduled-import.ts` | `"scheduled-import"` | 6 |
| `src/lib/project-identity.ts` | `"project-identity"` | 1 |
| `src/lib/mineru.ts` | `"mineru"` | 1 |
| `src/lib/anytxt-search.ts` | `"anytxt-search"` | 1 |
| `src/lib/clip-watcher.ts` | `"clip-watcher"` | 1 |
| `src/lib/theme.ts` | `"theme"` | 2 |
| `src/lib/claude-cli-transport.ts` | `"claude-cli"` | 1 |
| `src/lib/codex-cli-transport.ts` | `"codex-cli"` | 1 |
| `src/components/settings/settings-view.tsx` | `"settings"` | 7 |
| `src/components/settings/sections/api-server-section.tsx` | `"api-server"` | 4 |
| `src/components/settings/logging-config.tsx` | `"logging-config"` | 4 |
| `src/components/settings/sections/maintenance-section.tsx` | `"maintenance"` | 2 |
| `src/components/settings/sections/about-section.tsx` | `"about"` | 2 |
| `src/components/settings/sections/scheduled-import-section.tsx` | `"scheduled-import"` | 1 |
| `src/components/lint/lint-view.tsx` | `"lint"` | 7 |
| `src/components/sources/sources-view.tsx` | `"sources"` | 6 |
| `src/components/chat/chat-message.tsx` | `"chat-message"` | 6 |
| `src/components/chat/chat-panel.tsx` | `"chat"` | 1 |
| `src/components/graph/graph-view.tsx` | `"graph"` | 3 |
| `src/components/search/search-view.tsx` | `"search"` | 5 |
| `src/components/review/review-view.tsx` | `"review"` | 3 |
| `src/components/layout/app-layout.tsx` | `"layout"` | 1 |
| `src/components/layout/activity-panel.tsx` | `"activity"` | 1 |
| `src/components/layout/file-tree.tsx` | `"file-tree"` | 1 |
| `src/components/layout/knowledge-tree.tsx` | `"knowledge-tree"` | 1 |
| `src/components/layout/preview-panel.tsx` | `"preview"` | 1 |
| `src/components/layout/update-banner.tsx` | `"update-banner"` | 1 |
| **合计** | — | **~202** |

### 合理例外（保留 console，不迁移）
- `src/lib/logger.ts:55` —— Logger 自身 IPC 失败 fallback（替换会递归）
- 所有 `*.test.ts(x)` —— 测试输出

### 迁移规则（设计文档 §4.3 摘要，所有迁移任务通用）
| 原调用 | 目标 | 参数规范化 |
|--------|------|-----------|
| `console.error("x:", err)` | `logger.error("x", { error: String(err) })` | 多参数 → (message, data) |
| `console.warn(...)` | `logger.warn(...)` | 同上 |
| `console.log(...)` | `logger.debug(...)` | 降级 DEBUG |
| `` `text ${x}` `` 模板串 | `"text", { x }` | 拆 message + data |

> **关键约束**：第一个参数提取为可读 message（去掉 `[prefix]` 前缀，前缀语义已由 module 名承载）。异常对象用 `String(err)` 包裹避免序列化崩溃。

---

## Task 1: logger.ts 时间窗口采样器（TDD）

**Files:**
- Modify: `src/lib/logger.ts`
- Test: `src/lib/__tests__/logger-sampler.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `src/lib/__tests__/logger-sampler.test.ts`：

```typescript
import { describe, it, expect } from "vitest";
import { shouldSampleAt } from "../logger";

describe("shouldSampleAt", () => {
  it("allows all when threshold is Infinity", () => {
    const r1 = shouldSampleAt("DEBUG", 1000, 0, 0, Infinity);
    const r2 = shouldSampleAt("INFO", 1000, 0, 50, Infinity);
    expect(r1.allow).toBe(true);
    expect(r2.allow).toBe(true);
  });

  it("never drops ERROR regardless of threshold", () => {
    const r = shouldSampleAt("ERROR", 1000, 0, 999, 2);
    expect(r.allow).toBe(true);
  });

  it("drops non-ERROR beyond threshold within window", () => {
    // 窗口 [0, 1000)，阈值 2
    const r1 = shouldSampleAt("DEBUG", 500, 0, 0, 2); // count→1, allow
    expect(r1.allow).toBe(true);
    expect(r1.newWindowCount).toBe(1);
    const r2 = shouldSampleAt("DEBUG", 600, 0, 1, 2); // count→2, allow
    expect(r2.allow).toBe(true);
    expect(r2.newWindowCount).toBe(2);
    const r3 = shouldSampleAt("INFO", 700, 0, 2, 2); // count→3, drop
    expect(r3.allow).toBe(false);
    expect(r3.newWindowCount).toBe(3);
  });

  it("resets window after 1 second", () => {
    // 阈值 2，窗口 [0,1000) 已满（count=2）
    const r = shouldSampleAt("DEBUG", 1001, 0, 2, 2); // 跨窗口 → 重置
    expect(r.allow).toBe(true); // 新窗口首条，1 <= 2
    expect(r.newWindowStart).toBe(1001);
    expect(r.newWindowCount).toBe(1);
  });

  it("counts DEBUG and INFO against shared global bucket", () => {
    // 阈值 2，DEBUG 用掉 2 条后 INFO 应被限
    const r1 = shouldSampleAt("DEBUG", 500, 0, 0, 2); // →1 allow
    expect(r1.allow).toBe(true);
    const r2 = shouldSampleAt("DEBUG", 510, 0, r1.newWindowCount, 2); // →2 allow
    expect(r2.allow).toBe(true);
    const r3 = shouldSampleAt("INFO", 520, 0, r2.newWindowCount, 2); // →3 drop
    expect(r3.allow).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- --run src/lib/__tests__/logger-sampler.test.ts`
Expected: FAIL — `shouldSampleAt is not exported from logger`（函数未导出）。

- [ ] **Step 3: 实现采样器**

在 `src/lib/logger.ts` 中添加（放在 `shouldLog` 函数之后、`log` 函数之前）：

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
  if (level === "ERROR") {
    return { allow: true, newWindowStart: windowStart, newWindowCount: windowCount };
  }
  if (threshold === Infinity) {
    return { allow: true, newWindowStart: windowStart, newWindowCount: windowCount };
  }
  if (now - windowStart >= 1000) {
    return { allow: 1 <= threshold, newWindowStart: now, newWindowCount: 1 };
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

然后在 `log` 函数中，`shouldLog` 检查之后新增采样检查。修改 `log` 函数（原第 78-79 行）：

原代码：
```typescript
function log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
  if (!shouldLog(level)) return;
```

改为：
```typescript
function log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
  if (!shouldLog(level)) return;
  if (!shouldSample(level)) return; // 采样拦截（ERROR 免疫，默认 Infinity 全通过）
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -- --run src/lib/__tests__/logger-sampler.test.ts`
Expected: 5 个测试全通过。

- [ ] **Step 5: 运行全部 logger 相关测试不回归**

Run: `npm test -- --run src/lib/__tests__/logger.test.ts src/lib/__tests__/logging-integration.test.ts`
Expected: 原有 logger 测试全通过（采样默认 Infinity，不影响现有行为）。

- [ ] **Step 6: 类型检查**

Run: `npm run typecheck 2>&1 | grep -i "logger\|sampler"`
Expected: 0 错误。

- [ ] **Step 7: 提交**

```bash
git add src/lib/logger.ts src/lib/__tests__/logger-sampler.test.ts
git commit -m "feat(logging): add time-window sampler to logger (default disabled)

shouldSampleAt pure function (ERROR-immune, Infinity default) +
shouldSample thin wrapper. Plugged into log() after level filter.
Forward-looking: no behavior change until RATE_LIMIT_PER_SEC is set.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: 标准迁移流程 + 启动流程迁移（main.tsx, App.tsx, error-boundary.tsx）

**Files:**
- Modify: `src/main.tsx`
- Modify: `src/App.tsx`
- Modify: `src/components/error-boundary.tsx`

> 本任务建立**标准迁移流程**，后续 Task 3-8 按同一流程执行不同文件集。

### 标准迁移流程（5 步，每个文件）

1. **定位**：`grep -n "console\.\(log\|warn\|error\|info\|debug\)" <file>` 列出所有调用点
2. **加 import**：文件顶部加 `import { createLogger } from "@/lib/logger"` 和 `const logger = createLogger("<module-name>")`（module 名见映射表）
3. **替换**：按迁移规则表逐个 `console.X` → `logger.X`，规范化参数
4. **清理**：若文件已无任何 `console` 使用，移除不再需要的 `console` 相关注释；保留必要的 eslint-disable
5. **验证**：`grep -c "console\." <file>` 确认该文件 console 计数符合预期（业务文件应为 0）

- [ ] **Step 1: 迁移 main.tsx**

Run: `grep -n "console\." src/main.tsx`

main.tsx 的 1 处 console 在 `initLogger()` 之前（启动最早期，Logger 未就绪）。**这是合理例外，保留**。但若 grep 显示它在 initLogger 之后，则迁移为 `logger.error`。

读取 main.tsx 确认该 console 位置：
- 若在 `initLogger()` 调用**之前**：保留不动（加注释说明）
- 若在**之后**：按规则迁移为 `logger.error("Failed to ...", { error: String(e) })`，并在文件顶部加：
  ```typescript
  import { createLogger } from "@/lib/logger"
  const logger = createLogger("main")
  ```

- [ ] **Step 2: 迁移 App.tsx（完整范例）**

Run: `grep -n "console\.\(log\|warn\|error\)" src/App.tsx` —— 定位 16 处调用。

在 `src/App.tsx` 顶部 import 区加：
```typescript
import { createLogger } from "@/lib/logger"
const logger = createLogger("app")
```

逐个替换（示例典型几处，其余同模式）：

```typescript
// 之前
console.error("Failed to restore ingest queue:", err)
// 之后
logger.error("Failed to restore ingest queue", { error: String(err) })

// 之前
console.log("[update-check] skipped: user disabled auto-check in settings")
// 之后
logger.debug("update check skipped: user disabled auto-check in settings")
// （去 [prefix]，module="app" 已承载上下文）

// 之前
console.log("[test] update banner cleared")
// 之后
logger.debug("update banner cleared")
```

对每个 `console.error("...:", err)` 模式，统一转为 `logger.error("...", { error: String(err) })`。
对每个 `console.log/warn`，按内容提取 message，多余参数转 data 对象。

完成后验证：`grep -c "console\." src/App.tsx` —— 应为 0（除非有保留例外，记录说明）。

- [ ] **Step 3: 迁移 error-boundary.tsx**

Run: `grep -n "console\." src/components/error-boundary.tsx` —— 定位 1 处。

加 import + logger：
```typescript
import { createLogger } from "@/lib/logger"
const logger = createLogger("error-boundary")
```

替换（典型 React error boundary）：
```typescript
// 之前
componentDidCatch(error, errorInfo) {
  console.error("ErrorBoundary caught:", error, errorInfo)
}
// 之后
componentDidCatch(error, errorInfo) {
  logger.error("ErrorBoundary caught an error", {
    error: String(error),
    componentStack: errorInfo?.componentStack,
  })
}
```

> Logger 内部已有 try-catch + console fallback，即使渲染崩溃场景调用也安全。

- [ ] **Step 4: 类型检查 + 测试**

Run:
```bash
npm run typecheck 2>&1 | grep -iE "main\.tsx|App\.tsx|error-boundary" | head
npm test -- --run 2>&1 | grep -E "Tests|Test Files" | tail -3
```
Expected: 0 新错误；测试不回归。

- [ ] **Step 5: 提交**

```bash
git add src/main.tsx src/App.tsx src/components/error-boundary.tsx
git commit -m "refactor(logging): migrate startup flow console calls to logger

main.tsx, App.tsx (16 calls), error-boundary.tsx. Establishes the
standard migration pattern for subsequent tasks.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: 迁移 ingest 家族（7 文件，约 67 处）

**Files:**
- `src/lib/ingest.ts`（module `"ingest"`, 38 处）
- `src/lib/ingest-queue.ts`（`"ingest-queue"`, 12 处）
- `src/lib/ingest-cache.ts`（`"ingest-cache"`, 1 处）
- `src/lib/dedup-queue.ts`（`"dedup-queue"`, 6 处）
- `src/lib/dedup-runner.ts`（`"dedup-runner"`, 1 处）
- `src/lib/sweep-reviews.ts`（`"sweep-reviews"`, 5 处）
- `src/lib/page-merge.ts`（`"page-merge"`, 4 处）

- [ ] **Step 1: 对每个文件应用标准迁移流程（Task 2 定义）**

逐个文件：定位 → 加 `createLogger("<module>")` import → 按迁移规则表替换 → 验证 console=0。

ingest.ts 示例（38 处，多为 catch 块 error 与状态 log）：
```typescript
// 顶部
import { createLogger } from "@/lib/logger"
const logger = createLogger("ingest")

// catch 块典型
// 之前: console.error("Ingest failed for", fileName, err)
// 之后: logger.error("Ingest failed", { fileName, error: String(err) })

// 状态 log 典型
// 之前: console.log("[ingest] step complete:", step, duration + "ms")
// 之后: logger.debug("ingest step complete", { step, durationMs: duration })
```

每个文件的 module 名见上方清单。对所有 `console.error/warn` 用 `String(err)` 包裹异常对象。

- [ ] **Step 2: 验证 + 类型检查 + 测试**

Run:
```bash
grep -rn "console\." src/lib/ingest.ts src/lib/ingest-queue.ts src/lib/ingest-cache.ts src/lib/dedup-queue.ts src/lib/dedup-runner.ts src/lib/sweep-reviews.ts src/lib/page-merge.ts
# Expected: 0 行
npm run typecheck 2>&1 | grep -c "error TS"
npm test -- --run 2>&1 | grep -E "Tests" | tail -2
```
Expected: console=0；typecheck 不新增错误；测试不回归。

- [ ] **Step 3: 提交**

```bash
git add src/lib/ingest.ts src/lib/ingest-queue.ts src/lib/ingest-cache.ts src/lib/dedup-queue.ts src/lib/dedup-runner.ts src/lib/sweep-reviews.ts src/lib/page-merge.ts
git commit -m "refactor(logging): migrate ingest pipeline console calls to logger

ingest.ts (38), ingest-queue.ts (12), ingest-cache.ts, dedup-queue.ts (6),
dedup-runner.ts, sweep-reviews.ts (5), page-merge.ts (4).

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: 迁移 lib 向量+研究+媒体（4 文件，约 22 处）

**Files:**
- `src/lib/embedding.ts`（`"embedding"`, 11 处）
- `src/lib/deep-research.ts`（`"deep-research"`, 3 处）
- `src/lib/extract-source-images.ts`（`"extract-images"`, 3 处）
- `src/lib/image-caption-pipeline.ts`（`"image-caption"`, 5 处）

> 注：`embedding.ts` 在阶段 2 已 import `invokeTraced`，迁移时在现有 import 旁加 `createLogger` import。

- [ ] **Step 1: 对每个文件应用标准迁移流程（Task 2 定义）**

逐个文件迁移。embedding.ts 示例：
```typescript
// 顶部（invokeTraced import 旁）
import { createLogger } from "@/lib/logger"
const logger = createLogger("embedding")

// 之前: console.error("Embedding failed:", pageId, err)
// 之后: logger.error("Embedding failed", { pageId, error: String(err) })
```

- [ ] **Step 2: 验证**

Run:
```bash
grep -rn "console\." src/lib/embedding.ts src/lib/deep-research.ts src/lib/extract-source-images.ts src/lib/image-caption-pipeline.ts
# Expected: 0 行
npm run typecheck 2>&1 | grep -c "error TS"
npm test -- --run src/lib/embedding.test.ts 2>&1 | tail -3
```
Expected: console=0；测试不回归。

- [ ] **Step 3: 提交**

```bash
git add src/lib/embedding.ts src/lib/deep-research.ts src/lib/extract-source-images.ts src/lib/image-caption-pipeline.ts
git commit -m "refactor(logging): migrate vector/research/media console calls to logger

embedding.ts (11), deep-research.ts (3), extract-source-images.ts (3),
image-caption-pipeline.ts (5).

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: 迁移 lib 项目管理+工具（12 文件，约 38 处）

**Files:**
- `src/lib/reset-project-state.ts`（`"reset-project"`, 10）
- `src/lib/source-lifecycle.ts`（`"source-lifecycle"`, 8）
- `src/lib/project-file-sync.ts`（`"file-sync"`, 4）
- `src/lib/wiki-page-delete.ts`（`"wiki-delete"`, 2）
- `src/lib/scheduled-import.ts`（`"scheduled-import"`, 6）
- `src/lib/project-identity.ts`（`"project-identity"`, 1）
- `src/lib/mineru.ts`（`"mineru"`, 1）
- `src/lib/anytxt-search.ts`（`"anytxt-search"`, 1）
- `src/lib/clip-watcher.ts`（`"clip-watcher"`, 1）
- `src/lib/theme.ts`（`"theme"`, 2）
- `src/lib/claude-cli-transport.ts`（`"claude-cli"`, 1）
- `src/lib/codex-cli-transport.ts`（`"codex-cli"`, 1）

- [ ] **Step 1: 对每个文件应用标准迁移流程（Task 2 定义）**

逐个迁移。每文件 module 名见上方清单。

- [ ] **Step 2: 验证**

Run:
```bash
grep -l "console\." src/lib/reset-project-state.ts src/lib/source-lifecycle.ts src/lib/project-file-sync.ts src/lib/wiki-page-delete.ts src/lib/scheduled-import.ts src/lib/project-identity.ts src/lib/mineru.ts src/lib/anytxt-search.ts src/lib/clip-watcher.ts src/lib/theme.ts src/lib/claude-cli-transport.ts src/lib/codex-cli-transport.ts 2>/dev/null
# Expected: 无输出（所有文件 console 已清零）
npm run typecheck 2>&1 | grep -c "error TS"
```
Expected: 无残留文件；typecheck 不新增错误。

- [ ] **Step 3: 提交**

```bash
git add src/lib/reset-project-state.ts src/lib/source-lifecycle.ts src/lib/project-file-sync.ts src/lib/wiki-page-delete.ts src/lib/scheduled-import.ts src/lib/project-identity.ts src/lib/mineru.ts src/lib/anytxt-search.ts src/lib/clip-watcher.ts src/lib/theme.ts src/lib/claude-cli-transport.ts src/lib/codex-cli-transport.ts
git commit -m "refactor(logging): migrate project-mgmt console calls to logger

12 files: reset-project-state (10), source-lifecycle (8), project-file-sync (4),
wiki-page-delete (2), scheduled-import (6), project-identity, mineru,
anytxt-search, clip-watcher, theme (2), claude-cli-transport, codex-cli-transport.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 6: 迁移 settings 模块（6 文件，约 20 处）

**Files:**
- `src/components/settings/settings-view.tsx`（`"settings"`, 7）
- `src/components/settings/sections/api-server-section.tsx`（`"api-server"`, 4）
- `src/components/settings/logging-config.tsx`（`"logging-config"`, 4）
- `src/components/settings/sections/maintenance-section.tsx`（`"maintenance"`, 2）
- `src/components/settings/sections/about-section.tsx`（`"about"`, 2）
- `src/components/settings/sections/scheduled-import-section.tsx`（`"scheduled-import"`, 1）

> 注：`logging-config.tsx` 在阶段 2 已 import 了 Switch 等组件，迁移时加 `createLogger` import。

- [ ] **Step 1: 对每个文件应用标准迁移流程（Task 2 定义）**

逐个迁移。logging-config.tsx 的 4 处 `console.error`（加载/设置级别失败、加载/设置通知配置失败的 catch 块）转为 `logger.error`。

- [ ] **Step 2: 验证**

Run:
```bash
grep -rn "console\." src/components/settings/
# Expected: 0 行
npm run typecheck 2>&1 | grep -iE "settings" | head
npm test -- --run 2>&1 | grep -E "Tests" | tail -2
```
Expected: console=0；测试不回归。

- [ ] **Step 3: 提交**

```bash
git add src/components/settings/settings-view.tsx src/components/settings/sections/api-server-section.tsx src/components/settings/logging-config.tsx src/components/settings/sections/maintenance-section.tsx src/components/settings/sections/about-section.tsx src/components/settings/sections/scheduled-import-section.tsx
git commit -m "refactor(logging): migrate settings module console calls to logger

settings-view (7), api-server-section (4), logging-config (4),
maintenance-section (2), about-section (2), scheduled-import-section.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 7: 迁移 components 视图（7 文件，约 31 处）

**Files:**
- `src/components/lint/lint-view.tsx`（`"lint"`, 7）
- `src/components/sources/sources-view.tsx`（`"sources"`, 6）
- `src/components/chat/chat-message.tsx`（`"chat-message"`, 6）
- `src/components/chat/chat-panel.tsx`（`"chat"`, 1）
- `src/components/graph/graph-view.tsx`（`"graph"`, 3）
- `src/components/search/search-view.tsx`（`"search"`, 5）
- `src/components/review/review-view.tsx`（`"review"`, 3）

- [ ] **Step 1: 对每个文件应用标准迁移流程（Task 2 定义）**

逐个迁移。module 名见上方清单。

- [ ] **Step 2: 验证**

Run:
```bash
grep -rn "console\." src/components/lint/ src/components/sources/ src/components/chat/ src/components/graph/ src/components/search/ src/components/review/
# Expected: 0 行
npm run typecheck 2>&1 | grep -c "error TS"
npm test -- --run 2>&1 | grep -E "Tests" | tail -2
```
Expected: console=0；测试不回归。

- [ ] **Step 3: 提交**

```bash
git add src/components/lint/lint-view.tsx src/components/sources/sources-view.tsx src/components/chat/chat-message.tsx src/components/chat/chat-panel.tsx src/components/graph/graph-view.tsx src/components/search/search-view.tsx src/components/review/review-view.tsx
git commit -m "refactor(logging): migrate view components console calls to logger

lint-view (7), sources-view (6), chat-message (6), chat-panel,
graph-view (3), search-view (5), review-view (3).

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 8: 迁移 layout 模块（6 文件，约 6 处）

**Files:**
- `src/components/layout/app-layout.tsx`（`"layout"`, 1）
- `src/components/layout/activity-panel.tsx`（`"activity"`, 1）
- `src/components/layout/file-tree.tsx`（`"file-tree"`, 1）
- `src/components/layout/knowledge-tree.tsx`（`"knowledge-tree"`, 1）
- `src/components/layout/preview-panel.tsx`（`"preview"`, 1）
- `src/components/layout/update-banner.tsx`（`"update-banner"`, 1）

- [ ] **Step 1: 对每个文件应用标准迁移流程（Task 2 定义）**

每个文件 1 处 console，按规则迁移。module 名见上方清单。

- [ ] **Step 2: 验证**

Run:
```bash
grep -rn "console\." src/components/layout/
# Expected: 0 行
npm run typecheck 2>&1 | grep -iE "layout" | head
```
Expected: console=0；typecheck 不新增错误。

- [ ] **Step 3: 提交**

```bash
git add src/components/layout/app-layout.tsx src/components/layout/activity-panel.tsx src/components/layout/file-tree.tsx src/components/layout/knowledge-tree.tsx src/components/layout/preview-panel.tsx src/components/layout/update-banner.tsx
git commit -m "refactor(logging): migrate layout components console calls to logger

6 files, 1 call each: app-layout, activity-panel, file-tree,
knowledge-tree, preview-panel, update-banner.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 9: 全局验证（零残留 + 测试 + 采样器）

- [ ] **Step 1: 业务 console 零残留检查**

Run:
```bash
grep -rn "console\.\(log\|warn\|error\|info\|debug\)" src/ --include="*.ts" --include="*.tsx" \
  | grep -v "node_modules\|\.test\.\|logger\.ts" \
  | grep -v "^\s*//\|^\s*\*\|^\s*/\*\|\*/"
```
Expected: 0 行输出。唯一合理例外是 `logger.ts:55`（已在 grep 排除）。

若仍有残留，记录文件并补充迁移。

- [ ] **Step 2: AST 级兜底校验（可选，强保证）**

临时在项目 eslint 配置启用 `no-console` 规则跑一次：
```bash
npx eslint src/ --rule '{"no-console":"error"}' --no-error-on-unmatched-pattern 2>&1 | grep "no-console" | grep -v "logger\.ts\|\.test\." | head
```
Expected: 0 行（logger.ts 与 test 的 console 可加 `// eslint-disable-next-line no-console` 或在 eslint 全局 ignore）。

> 若项目 eslint 配置复杂导致此命令不适用，以 Step 1 的 grep 结果为准。

- [ ] **Step 3: 全部前端测试 + 类型检查**

Run:
```bash
npm test -- --run 2>&1 | grep -E "Tests|Test Files" | tail -3
npm run typecheck 2>&1 | grep -c "error TS"
```
Expected: 测试全绿（除预存 LoginPage.test.tsx）；typecheck 仅基线错误数（8 个预存）。

- [ ] **Step 4: 采样器测试确认**

Run: `npm test -- --run src/lib/__tests__/logger-sampler.test.ts`
Expected: 5 通过。

- [ ] **Step 5: 手动验证记录**

在 `docs/superpowers/tests/` 创建或追加批次 A 验证记录，确认：
- [ ] 触发一个业务错误（如启动失败），查看 `llm-wiki.log` 确认带 module 名 + trace_id
- [ ] 开发模式 console 仍输出（logger.ts 的 `import.meta.env.DEV` 分支）
- [ ] grep 业务 console = 0

- [ ] **Step 6: 提交验证记录**

```bash
git add -f docs/superpowers/tests/2026-06-15-logging-phase3-batchA-validation.md
git commit -m "docs(logging): add phase 3 batch A validation record

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## 最终验证（全部任务完成后）

- [ ] `grep -rn "console\." src/ --include="*.ts*" | grep -v "node_modules\|\.test\.\|logger\.ts\|//\|\*"` 输出为 0
- [ ] `npm test -- --run` 全绿
- [ ] `npm run typecheck` 仅 8 个基线错误
- [ ] 采样器 5 测试通过，默认 Infinity 不影响行为
- [ ] 更新 `CLAUDE.md` 标注阶段 3 批次 A 完成
