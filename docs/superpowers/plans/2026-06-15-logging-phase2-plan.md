# LLM Wiki 日志系统阶段 2 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现日志系统阶段 2——请求追踪传播（前端 invoke 自动注入 trace_id，后端核心命令 #[instrument] 绑定）与 Error 桌面通知（自定义 tracing Layer 捕获 ERROR，经 tauri-plugin-notification 在主线程弹出，10s 去重，设置开关）。

**Architecture:** 前端新增 `invokeTraced` 封装自动注入 UUID；后端核心命令加 `trace_id` 参数与 `#[instrument]` span（spawn_blocking 命令需 `Span::current().enter()` 显式跨线程传播）；新增 `NotifyLayer`（tracing Layer）+ `config.rs`（读 app-state.json）捕获所有 ERROR event，经 `run_on_main_thread` 在主线程发通知；`init_logging` 增参 `AppHandle` 注入第 4 层；配置 UI 新增手写 Switch 开关。

**Tech Stack:** Rust（tracing, tracing-subscriber, tauri-plugin-notification）、TypeScript/React 19（Vitest, tauri-plugin-store JS API, 手写 Switch 组件）。

**参考设计文档:** `docs/superpowers/specs/2026-06-15-logging-phase2-design.md` (v0.7.1)

**分支:** `log-system`（所有提交在此分支）

---

## File Structure

### 新建文件
| 文件 | 职责 |
|------|------|
| `src/lib/invoke-traced.ts` | 带 trace_id 的 invoke 封装 |
| `src/lib/__tests__/invoke-traced.test.ts` | invokeTraced 单元测试 |
| `src-tauri/src/logging/config.rs` | 读 app-state.json 的 error_notification 配置 |
| `src-tauri/src/logging/notify_layer.rs` | NotifyLayer（ERROR 捕获 + 去重 + 通知） |
| `src/components/ui/switch.tsx` | 手写 Switch 组件（非 radix） |
| `docs/superpowers/tests/2026-06-15-logging-phase2-validation.md` | 手动验证文档 |

### 修改文件
| 文件 | 改动 |
|------|------|
| `src-tauri/Cargo.toml` | 加 `tauri-plugin-notification = "2"` |
| `package.json` | 加 `@tauri-apps/plugin-notification` |
| `src-tauri/capabilities/*.json` | 加 notification 权限 |
| `src-tauri/src/lib.rs` | 注册 notification 插件；init_logging 调用传 AppHandle |
| `src-tauri/src/logging/mod.rs` | 导出 notify_layer、config 模块 |
| `src-tauri/src/logging/manager.rs` | init_logging 加 app_handle 参数 + 注入 NotifyLayer |
| `src-tauri/src/commands/fs.rs` | read_file/write_file/delete_file/list_directory 加 trace_id + #[instrument] |
| `src-tauri/src/commands/vectorstore.rs` | vector_* 命令加 trace_id + #[instrument] |
| `src/commands/fs.ts` | 核心命令 invoke → invokeTraced |
| `src/lib/embedding.ts` | invoke → invokeTraced |
| `src/components/settings/logging-config.tsx` | 加错误通知开关 |

### 关键技术约束（实施前必读）
1. **后端命令当前无 trace_id 参数**：加 `#[instrument(fields(trace_id = %trace_id))]` 要求函数签名新增 `trace_id: String` 参数，且**前端必须传**（否则 Tauri 报参数缺失）。故每个命令前后端必须同步修改。
2. **spawn_blocking 命令的 span 传播**：`read_file` 等用 `spawn_blocking` 包裹 `run_guarded`，阻塞线程池的闭包默认不继承调用线程的 span。必须在闭包内显式 `let _g = tracing::Span::current().enter();`，否则内部 ERROR 不带 trace_id。
3. **参数名是 `path`（非 file_path）**：现有 fs 命令参数名为 `path`、`extract_images`，保持不变，仅在末尾追加 `trace_id`。
4. **readFile 有 USE_HTTP 分支**：`invokeTraced` 仅替换走 `invoke` 的分支，USE_HTTP（走 apiClient）分支不动。
5. **Switch 手写**：项目无任何 @radix-ui 依赖，Switch 参照 `label.tsx` 手写（React.ComponentProps + cn），避免引入 radix 依赖链。

---

## Task 1: 添加 tauri-plugin-notification 依赖与注册

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `package.json`
- Modify: `src-tauri/capabilities/`（确认 capabilities 文件名）
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: 用 tauri CLI 添加插件（自动改 Cargo.toml + package.json + capabilities）**

Run:
```bash
npm run tauri add notification
```
Expected: 命令成功，输出表明添加了 Rust 依赖与 npm 依赖、更新了 capabilities。若 CLI 交互式询问，选择默认（添加全部默认权限）。

- [ ] **Step 2: 验证 Cargo.toml 已添加依赖**

Run:
```bash
grep "tauri-plugin-notification" src-tauri/Cargo.toml
```
Expected: 输出含 `tauri-plugin-notification = "2"`（或具体版本号）。

若 CLI 未自动添加，手动在 `src-tauri/Cargo.toml` 的 `[dependencies]` 段（`tauri-plugin-store` 行附近）追加：
```toml
tauri-plugin-notification = "2"
```

- [ ] **Step 3: 验证 package.json 已添加前端依赖**

Run:
```bash
grep "plugin-notification" package.json
```
Expected: 输出含 `"@tauri-apps/plugin-notification"`。

- [ ] **Step 4: 注册插件到 lib.rs**

在 `src-tauri/src/lib.rs` 的 `tauri::Builder::default()` 链中，于 `.plugin(tauri_plugin_opener::init())` **之前**添加 notification 插件：

```rust
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())  // ★新增：错误桌面通知
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
```

- [ ] **Step 5: 确认 capabilities 文件含 notification 权限**

Run:
```bash
ls src-tauri/capabilities/ && grep -rl "notification" src-tauri/capabilities/
```
Expected: 列出 capabilities 文件，并至少有一个文件含 `"notification:default"` 或 `"notification:allow-show"`。

若 `tauri add` 未自动写入权限，在主 capability 文件（通常 `src-tauri/capabilities/default.json`）的 `permissions` 数组中追加 `"notification:default"`。

- [ ] **Step 6: 安装前端依赖**

Run:
```bash
npm install
```
Expected: 安装成功，无报错。

- [ ] **Step 7: 编译验证后端能识别插件**

Run:
```bash
cd src-tauri && cargo check 2>&1 | tail -20
```
Expected: 编译通过（可能仍有阶段 1 的 dead_code 警告，但 0 error）。若报 `unresolved import tauri_plugin_notification`，检查 Cargo.toml 依赖与 lib.rs 注册行。

- [ ] **Step 8: 提交**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock package.json package-lock.json src-tauri/src/lib.rs src-tauri/capabilities/
git commit -m "deps(logging): add tauri-plugin-notification for error desktop notifications

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: invokeTraced 封装 + 单元测试（TDD）

**Files:**
- Create: `src/lib/invoke-traced.ts`
- Test: `src/lib/__tests__/invoke-traced.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `src/lib/__tests__/invoke-traced.test.ts`：

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { invokeTraced } from "../invoke-traced";

// Mock Tauri invoke
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

describe("invokeTraced", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("auto-generates a UUID v4 trace_id when none provided", async () => {
    const mockedInvoke = vi.mocked(invoke);
    mockedInvoke.mockResolvedValue("ok");

    await invokeTraced("read_file", { path: "/x" });

    const args = mockedInvoke.mock.calls[0];
    expect(args[0]).toBe("read_file");
    const passedArgs = args[1] as Record<string, unknown>;
    // trace_id 是合法 UUID v4 格式：8-4-4-4-12 hex
    expect(passedArgs.trace_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  it("passes through caller-provided trace_id", async () => {
    const mockedInvoke = vi.mocked(invoke);
    mockedInvoke.mockResolvedValue("ok");
    const callerTraceId = "11111111-2222-4333-8444-555555555555";

    await invokeTraced("read_file", { path: "/x", trace_id: callerTraceId });

    const passedArgs = mockedInvoke.mock.calls[0][1] as Record<string, unknown>;
    expect(passedArgs.trace_id).toBe(callerTraceId);
  });

  it("treats empty string trace_id as absent and generates a new one", async () => {
    const mockedInvoke = vi.mocked(invoke);
    mockedInvoke.mockResolvedValue("ok");

    await invokeTraced("read_file", { path: "/x", trace_id: "" });

    const passedArgs = mockedInvoke.mock.calls[0][1] as Record<string, unknown>;
    // 空串不应透传，应生成新 UUID
    expect(passedArgs.trace_id).not.toBe("");
    expect(passedArgs.trace_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  it("preserves other args alongside injected trace_id", async () => {
    const mockedInvoke = vi.mocked(invoke);
    mockedInvoke.mockResolvedValue(42);

    const result = await invokeTraced<number>("count", { path: "/x", deep: true });

    const passedArgs = mockedInvoke.mock.calls[0][1] as Record<string, unknown>;
    expect(passedArgs.path).toBe("/x");
    expect(passedArgs.deep).toBe(true);
    expect(passedArgs.trace_id).toBeDefined();
    expect(result).toBe(42);
  });

  it("works with no args at all", async () => {
    const mockedInvoke = vi.mocked(invoke);
    mockedInvoke.mockResolvedValue(null);

    await invokeTraced("ping");

    const passedArgs = mockedInvoke.mock.calls[0][1] as Record<string, unknown>;
    expect(passedArgs.trace_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:
```bash
npm test -- --run src/lib/__tests__/invoke-traced.test.ts
```
Expected: FAIL，错误为 `Failed to resolve import "../invoke-traced"`（文件不存在）。

- [ ] **Step 3: 实现 invokeTraced**

创建 `src/lib/invoke-traced.ts`：

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
 *   const content = await invokeTraced<string>("read_file", { path });
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

- [ ] **Step 4: 运行测试确认通过**

Run:
```bash
npm test -- --run src/lib/__tests__/invoke-traced.test.ts
```
Expected: PASS，5 个测试全通过。

- [ ] **Step 5: 类型检查**

Run:
```bash
npm run typecheck
```
Expected: 不引入新错误（阶段 1 基线已有 8 个预存错误，确认 invoke-traced.ts 相关 0 错误）。

- [ ] **Step 6: 提交**

```bash
git add src/lib/invoke-traced.ts src/lib/__tests__/invoke-traced.test.ts
git commit -m "feat(logging): add invokeTraced wrapper with auto trace_id injection

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: 后端 fs.rs 核心命令加 trace_id + #[instrument]

**Files:**
- Modify: `src-tauri/src/commands/fs.rs`（read_file:58, write_file:973, delete_file:1224, list_directory:1065）

> **重要**：read_file 与 list_directory 用 `spawn_blocking`，闭包内必须 `Span::current().enter()` 才能让内部 ERROR 携带 trace_id。write_file/delete_file 若同样用 spawn_blocking 则同样处理；否则 #[instrument] 直接生效。实施时逐个确认函数体结构。

- [ ] **Step 1: 确认 fs.rs 顶部已导入 instrument**

Run:
```bash
grep -n "use tracing" src-tauri/src/commands/fs.rs | head -5
```

若没有 `use tracing::instrument;`，在 fs.rs 顶部 import 区（现有 `use tracing::...` 附近）添加：
```rust
use tracing::instrument;
```

- [ ] **Step 2: read_file 加 trace_id + #[instrument]（spawn_blocking 跨线程传播）**

修改 `src-tauri/src/commands/fs.rs` 第 57-58 行，函数签名加 `trace_id` 参数并加 `#[instrument]`，在 `spawn_blocking` 闭包内显式进入 span：

原代码：
```rust
#[tauri::command]
pub async fn read_file(path: String, extract_images: Option<bool>) -> Result<String, String> {
    // `spawn_blocking` is REQUIRED ...
    tauri::async_runtime::spawn_blocking(move || {
        run_guarded("read_file", || {
```

改为：
```rust
#[tauri::command]
#[instrument(name = "read_file", skip(path), fields(trace_id = %trace_id, path = %path))]
pub async fn read_file(
    path: String,
    extract_images: Option<bool>,
    trace_id: String,
) -> Result<String, String> {
    // 捕获 #[instrument] 创建的当前 span，供 spawn_blocking 闭包显式进入。
    // spawn_blocking 在独立阻塞线程执行，默认不继承调用线程的 span context，
    // 不显式 enter 则内部 run_guarded 的 error! 不带 trace_id。
    let span = tracing::Span::current();
    // `spawn_blocking` is REQUIRED ...
    tauri::async_runtime::spawn_blocking(move || {
        let _span_guard = span.enter();
        run_guarded("read_file", || {
```

注意：`move ||` 闭包现在捕获 `span`（Clone 的 Span，move 安全）。闭包体其余逻辑完全不变。

- [ ] **Step 3: write_file 加 trace_id + #[instrument]**

> **结构已确认**：write_file（行 973）、delete_file（行 1224）、list_directory（行 1065）与 read_file 结构完全相同——均为 `spawn_blocking(move || { run_guarded(...) })`。故 Step 3-5 均按 Step 2 的 spawn_blocking 模式：加 `trace_id` 参数、`#[instrument]`、闭包内 `Span::current().enter()`。

原代码（第 973 行）：
```rust
#[tauri::command]
pub async fn write_file(path: String, contents: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_guarded("write_file", || {
```

改为：
```rust
#[tauri::command]
#[instrument(name = "write_file", skip(path, contents), fields(trace_id = %trace_id, path = %path))]
pub async fn write_file(path: String, contents: String, trace_id: String) -> Result<(), String> {
    let span = tracing::Span::current();
    tauri::async_runtime::spawn_blocking(move || {
        let _span_guard = span.enter();
        run_guarded("write_file", || {
```

（`skip(path, contents)` 避免大内容写入 span name；trace_id 与 path 入 fields 供查询。闭包体其余逻辑不变。）

- [ ] **Step 4: delete_file 加 trace_id + #[instrument]**

同 Step 3 模式（spawn_blocking + run_guarded）。原签名 `pub async fn delete_file(path: String)`，改为：

```rust
#[tauri::command]
#[instrument(name = "delete_file", skip(path), fields(trace_id = %trace_id, path = %path))]
pub async fn delete_file(path: String, trace_id: String) -> Result<(), String> {
    let span = tracing::Span::current();
    tauri::async_runtime::spawn_blocking(move || {
        let _span_guard = span.enter();
        run_guarded("delete_file", || {
```

- [ ] **Step 5: list_directory 加 trace_id + #[instrument]**

同 Step 3 模式（spawn_blocking + run_guarded）。原签名 `pub async fn list_directory(path: String)`，改为：

```rust
#[tauri::command]
#[instrument(name = "list_directory", skip(path), fields(trace_id = %trace_id, path = %path))]
pub async fn list_directory(path: String, trace_id: String) -> Result<Vec<FileNode>, String> {
    let span = tracing::Span::current();
    tauri::async_runtime::spawn_blocking(move || {
        let _span_guard = span.enter();
        run_guarded("list_directory", || {
```

- [ ] **Step 6: 编译验证**

Run:
```bash
cd src-tauri && cargo check 2>&1 | grep -E "error|warning: unused" | head -20
```
Expected: 0 error。可能有 `trace_id` 未使用的警告？不会——`#[instrument(fields(trace_id = %trace_id))]` 会消费它。若报 `unused variable trace_id`，检查 #[instrument] 是否拼写正确。

- [ ] **Step 7: 预检测试调用点 + 补参 + 运行测试**

Skip 独立单元测试（async fn 的函数指针类型断言过于复杂，无实用价值）。trace_id 参数的存在由 Rust 编译器验证——若 #[instrument(fields(trace_id = %trace_id))] 中的 `trace_id` 拼错或参数未加，cargo check 会在 Step 6 报编译错误。

但 fs.rs 的 `#[cfg(test)] mod tests` 中**确实存在**直接调用命令的测试（当前 `read_file(path.clone(), None)` 约行 1631 及 1646），旧签名只有 2 个参数，加 `trace_id` 后编译失败。

先 grep 预检所有直接调用点：
```bash
grep -n "read_file(\|write_file(\|delete_file(\|list_directory(" src-tauri/src/commands/fs.rs | grep -v "pub async fn \|#\["
```
Expected: 列出测试中的直接调用行。

对每条调用补第三个参数 `trace_id: "test-read".to_string()`：
```rust
// 之前
let result = read_file(path.clone(), None).await;
// 之后
let result = read_file(path.clone(), None, "test-read".to_string()).await;
```

（`"test-read"` 是测试用的固定 trace_id，不影响测试逻辑。）

补参后运行测试：
```bash
cd src-tauri && cargo test commands::fs 2>&1 | tail -15
```
Expected: 全部通过（编译期已保证 trace_id 参数匹配，补参后应 0 编译错误）。

- [ ] **Step 8: 提交**

```bash
git add src-tauri/src/commands/fs.rs
git commit -m "feat(logging): add trace_id + #[instrument] to fs core commands

read_file/list_directory use spawn_blocking, so Span::current().enter()
inside the closure is required for trace_id to propagate to internal errors.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: 前端 fs.ts 迁移到 invokeTraced

**Files:**
- Modify: `src/commands/fs.ts`（readFile, writeFile, deleteFile, listDirectory 的 invoke 分支）

> **注意**：仅替换走 `invoke(...)` 的分支。USE_HTTP（走 apiClient）分支不动，因为 HTTP API 不经过 Tauri 命令签名。

- [ ] **Step 1: 加 invokeTraced import**

在 `src/commands/fs.ts` 顶部第 1 行后追加 import：

```typescript
import { invoke } from "@tauri-apps/api/core"
import { invokeTraced } from "@/lib/invoke-traced"
```

- [ ] **Step 2: 迁移 readFile 的 invoke 分支**

原代码（第 23-36 行）：
```typescript
export async function readFile(
  path: string,
  options?: { extractImages?: boolean },
): Promise<string> {
  if (USE_HTTP) {
    const projectId = getCurrentProjectId()
    const result = await apiClient.readFile(projectId, path)
    return result.content
  }
  return invoke<string>("read_file", {
    path,
    extractImages: options?.extractImages,
  })
}
```

把最后一处 `invoke<string>` 改为 `invokeTraced<string>`：
```typescript
  return invokeTraced<string>("read_file", {
    path,
    extractImages: options?.extractImages,
  })
```

- [ ] **Step 3: 迁移 writeFile 的 invoke 分支**

原代码（第 38-46 行）末尾：
```typescript
  assertAbsoluteFsPath("writeFile", path)
  return invoke<void>("write_file", { path, contents })
```
改为：
```typescript
  assertAbsoluteFsPath("writeFile", path)
  return invokeTraced<void>("write_file", { path, contents })
```

- [ ] **Step 4: 迁移 deleteFile 的 invoke 分支**

原代码（第 91-98 行）末尾：
```typescript
  return invoke("delete_file", { path })
```
改为：
```typescript
  return invokeTraced<void>("delete_file", { path })
```

- [ ] **Step 5: 迁移 listDirectory 的 invoke 分支**

原代码（第 64-71 行）末尾：
```typescript
  return invoke<FileNode[]>("list_directory", { path })
```
改为：
```typescript
  return invokeTraced<FileNode[]>("list_directory", { path })
```

- [ ] **Step 6: 类型检查**

Run:
```bash
npm run typecheck 2>&1 | grep -i "fs.ts\|invoke-traced" | head
```
Expected: fs.ts 与 invoke-traced 相关 0 错误。

- [ ] **Step 7: 运行 fs.test.ts 确认不回归**

Run:
```bash
npm test -- --run src/commands/fs.test.ts
```
Expected: 现有测试通过。若 fs.test.ts 直接 mock invoke，需确认 invokeTraced 内部仍调用被 mock 的 invoke（vi.mock("@tauri-apps/api/core") 会同时影响 invokeTraced 的 invoke 调用，通常无需改测试）。

- [ ] **Step 8: 提交**

```bash
git add src/commands/fs.ts
git commit -m "feat(logging): migrate fs.ts core commands to invokeTraced

readFile/writeFile/deleteFile/listDirectory now inject trace_id.
USE_HTTP branches unchanged (HTTP API bypasses Tauri command signature).

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: config.rs（读 error_notification 配置）+ 单元测试（TDD）

**Files:**
- Create: `src-tauri/src/logging/config.rs`
- Modify: `src-tauri/src/logging/mod.rs`

- [ ] **Step 1: 更新 mod.rs 声明 config 模块**

修改 `src-tauri/src/logging/mod.rs`，加 `mod config;`：

```rust
mod config;
mod manager;
mod router;
mod types;

pub use manager::{clear_logs, export_logs, get_log_files, get_log_level, init_logging, set_log_level};
pub use router::route_batch_logs;
pub use types::{FrontendLogEntry, LogLevel, LogFileEntry};
```

（notify_layer 的导出在 Task 7 一起加，本任务先只加 config 模块声明。）

- [ ] **Step 2: 写失败测试**

创建 `src-tauri/src/logging/config.rs`，先只写测试（实现待 Step 3）：

```rust
use tauri::Manager;

/// 从 app-state.json 读取 error_notification 配置。
///
/// 复用 proxy.rs 的读取模式：直接读 tauri-plugin-store 写入的 JSON 文件。
/// 返回 None 时，调用方使用默认值（true = 开启通知）。
///
/// 【前提与风险】本项目前端通过 `load("app-state.json", ...)` 显式使用 `.json`
/// 扩展名，实测 plugin-store 2.4.x 将该文件存为纯明文 JSON（见设计文档技术验证 5）。
/// 风险：若未来 plugin-store 改用二进制格式，本函数静默返回 None（→默认开启），
/// 届时应迁移到 StoreExt API。
pub fn read_error_notification_config(app: &tauri::AppHandle) -> Option<bool> {
    let app_data_dir = app.path().app_data_dir().ok()?;
    let store_path = app_data_dir.join("app-state.json");
    let content = std::fs::read_to_string(&store_path).ok()?;
    let json: serde_json::Value = serde_json::from_str(&content).ok()?;
    let val = json.get("error_notification")?;
    val.as_bool()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 不依赖 AppHandle：直接测「给定 JSON 内容，能否正确提取 error_notification」。
    /// 把核心解析逻辑抽出为纯函数 parse_error_notification，便于单测。
    fn parse_error_notification(json_str: &str) -> Option<bool> {
        let json: serde_json::Value = serde_json::from_str(json_str).ok()?;
        json.get("error_notification")?.as_bool()
    }

    #[test]
    fn parses_true() {
        assert_eq!(parse_error_notification(r#"{"error_notification": true}"#), Some(true));
    }

    #[test]
    fn parses_false() {
        assert_eq!(
            parse_error_notification(r#"{"error_notification": false, "other": 1}"#),
            Some(false)
        );
    }

    #[test]
    fn missing_key_returns_none() {
        assert_eq!(parse_error_notification(r#"{"proxyConfig": {}}"#), None);
    }

    #[test]
    fn invalid_json_returns_none() {
        assert_eq!(parse_error_notification("not json"), None);
    }

    #[test]
    fn non_bool_value_returns_none() {
        // error_notification 存在但非 bool → None（调用方回退默认 true）
        assert_eq!(parse_error_notification(r#"{"error_notification": "yes"}"#), None);
    }
}
```

> 注意：测试用纯函数 `parse_error_notification`（与 read_error_notification_config 内部解析逻辑一致），避免构造 AppHandle。read_error_notification_config 的 I/O 部分由集成/手动验证覆盖。

- [ ] **Step 3: 运行测试确认通过**

由于 Step 2 已含实现，测试应直接通过（这是「实现即测试」的纯解析函数，无需先看失败）。但为遵循 TDD，确认：

Run:
```bash
cd src-tauri && cargo test logging::config 2>&1 | tail -15
```
Expected: 5 个测试通过（parses_true, parses_false, missing_key_returns_none, invalid_json_returns_none, non_bool_value_returns_none）。

> 说明：read_error_notification_config 内部用了与 parse_error_notification 相同的 `serde_json::from_str` + `get` + `as_bool` 逻辑，二者保持一致是关键。若未来 read 函数解析逻辑变更，须同步更新 parse 测试。

- [ ] **Step 4: 编译验证**

Run:
```bash
cd src-tauri && cargo check 2>&1 | grep -E "^error" | head
```
Expected: 0 error。若 `read_error_notification_config` 报 unused（notify_layer 还没引用它），属正常警告，Task 6 引入后消失。

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/logging/config.rs src-tauri/src/logging/mod.rs
git commit -m "feat(logging): add config.rs to read error_notification from app-state.json

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 6: notify_layer.rs（NotifyLayer）+ 单元测试（TDD）

**Files:**
- Create: `src-tauri/src/logging/notify_layer.rs`

- [ ] **Step 1: 写实现（含可测试的纯逻辑分离）**

创建 `src-tauri/src/logging/notify_layer.rs`：

```rust
//! NotifyLayer —— 捕获所有 ERROR 级别 tracing event，触发桌面通知。
//!
//! 前后端统一：前端 ERROR 经 router.rs 转为 tracing::error!(target:"frontend")，
//! 后端 ERROR 直接用 tracing::error! 宏，两者流经同一 Registry，均被本 Layer 捕获。

use crate::logging::config::read_error_notification_config;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;
use tracing::field::Visit;
use tracing::{Event, Subscriber};
use tracing_subscriber::Layer;

/// 通知去重窗口（秒）：窗口内仅发送首条 ERROR 通知
const NOTIFY_DEBOUNCE_SECS: u64 = 10;

/// 通知 body 最大字符数（通知 UI 限制，保守值）
const MAX_BODY_CHARS: usize = 200;

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

    /// 时间窗口去重：窗口内抑制后续通知。
    /// 内部委托给可注入的纯函数 acquire_slot_at，便于单测（避免依赖真实 Instant）。
    fn acquire_slot(&self) -> bool {
        acquire_slot_at(&self.last_notify, Instant::now(), Duration::from_secs(NOTIFY_DEBOUNCE_SECS))
    }

    /// 读取 error_notification 配置（默认开启）。
    fn notification_enabled(&self) -> bool {
        read_error_notification_config(&self.app_handle).unwrap_or(true)
    }
}

/// 纯时间窗口判定逻辑（可注入 now 与 threshold，便于单测）。
///
/// - last_notify 为 None（从未通知）→ 占用并返回 true
/// - now 距上次通知 ≥ threshold → 占用并返回 true
/// - 否则（窗口内）→ 返回 false（抑制）
fn acquire_slot_at(
    last_notify: &Mutex<Option<Instant>>,
    now: Instant,
    threshold: Duration,
) -> bool {
    let mut last = last_notify.lock().expect("last_notify mutex poisoned");
    if let Some(t) = *last {
        if now.duration_since(t) < threshold {
            return false;
        }
    }
    *last = Some(now);
    true
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
            return;
        }

        let mut visitor = MessageVisitor::default();
        event.record(&mut visitor);
        let body = visitor.message.unwrap_or_else(|| "(no message)".to_string());
        let body = truncate_message(&body);

        // macOS 关键约束：UNUserNotificationCenter 必须在主线程调用（见设计文档技术验证 4、
        // tauri issue #3241）。用 run_on_main_thread 将 show() 调度到主线程。
        let app = self.app_handle.clone();
        let final_body = format!("{}\n（更多错误详见日志）", body);
        tauri::async_runtime::spawn(async move {
            let app_for_closure = app.clone();
            let _ = app
                .run_on_main_thread(move || {
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

/// 截断超长消息（按字符数，非字节，正确处理多字节中文）。
fn truncate_message(s: &str) -> String {
    if s.chars().count() > MAX_BODY_CHARS {
        let truncated: String = s.chars().take(MAX_BODY_CHARS - 3).collect();
        format!("{}...", truncated)
    } else {
        s.to_string()
    }
}

/// 从 event fields 提取 message 字段。
///
/// tracing 的消息（tracing::error!("text")）经名为 "message" 的 field 传递，
/// 字符串以 Debug 形式记录（record_debug），format!("{:?}", "失败") 带引号。
/// 故 record_debug 中需 strip_debug_quotes 去引号。
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
/// 仅当首尾均为 `"` 时去除（避免误删消息内容中合法的引号）。
/// 权衡：内部转义序列不反转义——对通知场景足够。
fn strip_debug_quotes(s: &str) -> String {
    let bytes = s.as_bytes();
    if bytes.len() >= 2 && bytes.first() == Some(&b'"') && bytes.last() == Some(&b'"') {
        s[1..s.len() - 1].to_string()
    } else {
        s.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_quotes_removes_wrapping_double_quotes() {
        assert_eq!(strip_debug_quotes(r#""hello""#), "hello");
    }

    #[test]
    fn strip_quotes_leaves_unquoted_intact() {
        assert_eq!(strip_debug_quotes("hello"), "hello");
    }

    #[test]
    fn strip_quotes_leaves_single_quote_intact() {
        assert_eq!(strip_debug_quotes(r#""a""#), "a");
        assert_eq!(strip_debug_quotes(""), "");
        assert_eq!(strip_debug_quotes(r#"""#), r#"""#); // 单个引号，长度<2 不处理
    }

    #[test]
    fn truncate_keeps_short_message() {
        assert_eq!(truncate_message("short"), "short");
    }

    #[test]
    fn truncate_cuts_long_message_with_ellipsis() {
        let long = "x".repeat(250);
        let result = truncate_message(&long);
        assert_eq!(result.chars().count(), MAX_BODY_CHARS);
        assert!(result.ends_with("..."));
    }

    #[test]
    fn truncate_handles_multibyte_chars() {
        let long = "中".repeat(250);
        let result = truncate_message(&long);
        assert_eq!(result.chars().count(), MAX_BODY_CHARS);
        assert!(result.ends_with("..."));
    }

    #[test]
    fn acquire_slot_first_call_takes_slot() {
        let last = Mutex::new(None);
        let now = Instant::now();
        assert!(acquire_slot_at(&last, now, Duration::from_secs(10)));
        assert_eq!(*last.lock().unwrap(), Some(now));
    }

    #[test]
    fn acquire_slot_blocks_within_window() {
        let last = Mutex::new(None);
        let t0 = Instant::now();
        // 第一次占用
        assert!(acquire_slot_at(&last, t0, Duration::from_secs(10)));
        // 窗口内（+5s）第二次 → 抑制
        let t1 = t0 + Duration::from_secs(5);
        assert!(!acquire_slot_at(&last, t1, Duration::from_secs(10)));
        // last_notify 不变（仍为 t0）
        assert_eq!(*last.lock().unwrap(), Some(t0));
    }

    #[test]
    fn acquire_slot_allows_after_window_expires() {
        let last = Mutex::new(None);
        let t0 = Instant::now();
        assert!(acquire_slot_at(&last, t0, Duration::from_secs(10)));
        // 恰好 10s（>= threshold）→ 允许
        let t1 = t0 + Duration::from_secs(10);
        assert!(acquire_slot_at(&last, t1, Duration::from_secs(10)));
        // last_notify 更新为 t1
        assert_eq!(*last.lock().unwrap(), Some(t1));
    }
}
```

> 说明：`acquire_slot_at` 接收 `&Mutex<Option<Instant>>` 与注入的 `now`/`threshold`，使时间窗口逻辑可单测（无需真实 sleep）。`Instant` 支持 `Add<Duration>`（`t0 + Duration`）在测试中构造时间点。

- [ ] **Step 2: 运行测试确认通过**

Run:
```bash
cd src-tauri && cargo test logging::notify_layer 2>&1 | tail -20
```
Expected: 8 个测试通过（strip_quotes ×3、truncate ×3、acquire_slot ×3，去重逻辑各覆盖首次/窗口内/窗口外）。

- [ ] **Step 3: 编译验证（notify_layer 尚未被 init_logging 引用，可能有 dead_code 警告）**

Run:
```bash
cd src-tauri && cargo check 2>&1 | grep -E "^error" | head
```
Expected: 0 error。dead_code 警告（NotifyLayer 未使用）正常，Task 7 注入后消失。

- [ ] **Step 4: 提交**

```bash
git add src-tauri/src/logging/notify_layer.rs
git commit -m "feat(logging): add NotifyLayer tracing layer for error notifications

Captures all ERROR events (frontend via router target + backend macros),
10s time-window debounce, message extraction with quote stripping,
run_on_main_thread for macOS notification thread safety.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 7: init_logging 注入 NotifyLayer（联动 manager/lib/mod）

**Files:**
- Modify: `src-tauri/src/logging/mod.rs`
- Modify: `src-tauri/src/logging/manager.rs`（init_logging 签名）
- Modify: `src-tauri/src/lib.rs`（setup 调用）

- [ ] **Step 1: mod.rs 导出 NotifyLayer**

修改 `src-tauri/src/logging/mod.rs`：

```rust
mod config;
mod manager;
mod notify_layer;
mod router;
mod types;

pub use manager::{clear_logs, export_logs, get_log_files, get_log_level, init_logging, set_log_level};
pub use notify_layer::NotifyLayer;
pub use router::route_batch_logs;
pub use types::{FrontendLogEntry, LogLevel, LogFileEntry};
```

- [ ] **Step 2: manager.rs 的 init_logging 加 app_handle 参数并注入 NotifyLayer**

在 `src-tauri/src/logging/manager.rs` 顶部 import 区，确保有 `use tauri::AppHandle;` 与 `use crate::logging::NotifyLayer;`（若 manager.rs 已 use 了 tracing 相关，在附近加）。

修改 `init_logging` 函数签名（约第 162 行）与 subscriber 构建（约第 208-225 行）。

签名改为：
```rust
pub fn init_logging(app_data_dir: PathBuf, app_handle: AppHandle) -> Result<(), String> {
```

subscriber 构建处（原 3 层）追加第 4 层。原代码：
```rust
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
```

改为（追加 `.with(NotifyLayer::new(app_handle))`）：
```rust
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
```

- [ ] **Step 3: lib.rs setup 调用传入 AppHandle**

修改 `src-tauri/src/lib.rs` 的 setup 钩子（约第 205 行）。原：
```rust
            logging::init_logging(app_data_dir).expect("Failed to initialize logging");
```
改为：
```rust
            logging::init_logging(app_data_dir, app.handle().clone())
                .expect("Failed to initialize logging");
```

- [ ] **Step 4: 编译验证**

Run:
```bash
cd src-tauri && cargo check 2>&1 | grep -E "^error" | head
```
Expected: 0 error。若报 `app` borrow 相关错误，确认 `app.handle()` 在 setup 闭包 `|app|` 中可用（Tauri v2 setup 闭包参数为 `&mut App`，`.handle()` 返回 `&AppHandle`，`.clone()` 取得 owned）。

- [ ] **Step 5: 运行全部后端测试不回归**

Run:
```bash
cd src-tauri && cargo test logging 2>&1 | tail -15
```
Expected: logging 模块全部测试通过（router、manager、config、notify_layer）。

- [ ] **Step 6: 提交**

```bash
git add src-tauri/src/logging/mod.rs src-tauri/src/logging/manager.rs src-tauri/src/lib.rs
git commit -m "feat(logging): inject NotifyLayer into subscriber, init_logging takes AppHandle

init_logging now requires AppHandle so NotifyLayer can route notifications
via run_on_main_thread. lib.rs setup passes app.handle().clone().

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 8: 手写 Switch 组件

**Files:**
- Create: `src/components/ui/switch.tsx`

> 参照 `src/components/ui/label.tsx` 的手写风格（React.ComponentProps + cn + data-slot），不引入 @radix-ui。

- [ ] **Step 1: 创建 Switch 组件**

创建 `src/components/ui/switch.tsx`：

```typescript
import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * 手写 Switch 开关（非 radix）。
 *
 * 遵循 label.tsx 的手写风格：React.ComponentProps + cn + data-slot。
 * 基于 button + role=\"switch\"，支持受控（checked + onCheckedChange）。
 */
function Switch({
  className,
  checked,
  onCheckedChange,
  disabled,
  ...props
}: Omit<React.ComponentProps<"button">, "onChange" | "value"> & {
  checked?: boolean
  onCheckedChange?: (checked: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      data-slot="switch"
      disabled={disabled}
      onClick={() => onCheckedChange?.(!checked)}
      className={cn(
        "peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        "disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "bg-primary" : "bg-input",
        className
      )}
      {...props}
    >
      <span
        className={cn(
          "pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform",
          checked ? "translate-x-4" : "translate-x-0"
        )}
      />
    </button>
  )
}

export { Switch }
```

- [ ] **Step 2: 类型检查**

Run:
```bash
npm run typecheck 2>&1 | grep -i "switch" | head
```
Expected: switch.tsx 相关 0 错误。

- [ ] **Step 3: 提交**

```bash
git add src/components/ui/switch.tsx
git commit -m "feat(ui): add hand-written Switch component (non-radix)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 9: logging-config.tsx 错误通知开关 + 配置读写

**Files:**
- Modify: `src/components/settings/logging-config.tsx`
- Create: `src/lib/error-notification-config.ts`（封装 store 读写）

- [ ] **Step 1: 创建配置读写封装**

创建 `src/lib/error-notification-config.ts`：

```typescript
import { load } from "@tauri-apps/plugin-store"

const STORE_NAME = "app-state.json"
const KEY = "error_notification"

async function getStore() {
  return load(STORE_NAME, { autoSave: true, defaults: {} })
}

/**
 * 读取错误通知开关。默认 true（开启）。
 * 复用 project-store.ts 的 app-state.json 读取模式。
 */
export async function loadErrorNotificationConfig(): Promise<boolean> {
  const store = await getStore()
  const val = await store.get<boolean>(KEY)
  return val ?? true
}

/** 写入错误通知开关。 */
export async function setErrorNotificationConfig(enabled: boolean): Promise<void> {
  const store = await getStore()
  await store.set(KEY, enabled)
  await store.save()
}
```

- [ ] **Step 2: 修改 logging-config.tsx 加开关**

修改 `src/components/settings/logging-config.tsx`。在现有 import 后追加：

```typescript
import { Switch } from "@/components/ui/switch"
import { loadErrorNotificationConfig, setErrorNotificationConfig } from "@/lib/error-notification-config"
```

在 `LoggingConfig` 组件内（`const [pending, setPending] = useState(false)` 之后）追加 errorNotify 状态与 handler：

```typescript
  const [errorNotify, setErrorNotify] = useState(true)

  useEffect(() => {
    let cancelled = false
    loadErrorNotificationConfig()
      .then((val) => {
        if (!cancelled) setErrorNotify(val)
      })
      .catch((error) => {
        console.error("[logging-config] failed to load error notification config:", error)
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function handleNotifyToggle(enabled: boolean) {
    if (enabled === errorNotify) return
    const previous = errorNotify
    setErrorNotify(enabled)
    try {
      await setErrorNotificationConfig(enabled)
    } catch (error) {
      console.error("[logging-config] failed to set error notification:", error)
      setErrorNotify(previous)
    }
  }
```

在 return 的 JSX 中，级别按钮 `</div>`（grid 结束）之后、最外层 `</div>` 之前追加开关：

```tsx
      <div className="flex items-center justify-between pt-2">
        <div className="space-y-0.5">
          <Label>{t("settings.logging.errorNotificationTitle")}</Label>
          <p className="text-xs text-muted-foreground">
            {t("settings.logging.errorNotificationDesc")}
          </p>
        </div>
        <Switch
          checked={errorNotify}
          onCheckedChange={handleNotifyToggle}
        />
      </div>
```

> 注：i18n key `settings.logging.errorNotificationTitle` / `errorNotificationDesc` 需在 Step 3 添加。若希望先不依赖 i18n，可临时用中文字面量 `"错误桌面通知"` / `"发生错误时显示桌面通知（10 秒内仅提示一次）"`，后续补 i18n。

- [ ] **Step 3: 添加 i18n 文案**

在 `src/i18n/zh.json` 与 `src/i18n/en.json` 的 `settings.logging` 节点下追加：

zh.json:
```json
    "errorNotificationTitle": "错误桌面通知",
    "errorNotificationDesc": "发生错误时显示桌面通知（10 秒内仅提示一次）"
```

en.json:
```json
    "errorNotificationTitle": "Error Desktop Notification",
    "errorNotificationDesc": "Show a desktop notification on errors (at most once per 10 seconds)"
```

（确认 i18n 文件的 `settings.logging` 节点结构与现有 `title`/`description` key 同级。）

- [ ] **Step 4: 类型检查**

Run:
```bash
npm run typecheck 2>&1 | grep -iE "logging-config|error-notification" | head
```
Expected: 相关 0 错误。

- [ ] **Step 5: 提交**

```bash
git add src/lib/error-notification-config.ts src/components/settings/logging-config.tsx src/i18n/zh.json src/i18n/en.json
git commit -m "feat(logging): add error notification toggle to settings UI

Persisted to app-state.json via tauri-plugin-store; NotifyLayer reads it
on each ERROR (default on).

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 10: 扩展迁移 embedding.ts → vectorstore.rs

**Files:**
- Modify: `src-tauri/src/commands/vectorstore.rs`
- Modify: `src/lib/embedding.ts`

> embedding.ts 有 7 处 invoke（vector_upsert_chunks/vector_search_chunks/vector_delete_page/vector_count_chunks/vector_clear_chunks/vector_legacy_row_count/vector_drop_legacy），对应 vectorstore.rs 命令。按 Task 3/4 相同模式迁移。

- [ ] **Step 1: vectorstore.rs 顶部加 instrument import**

Run:
```bash
grep -n "use tracing" src-tauri/src/commands/vectorstore.rs | head
```
若无 `use tracing::instrument;`，添加。

- [ ] **Step 2: 给 vectorstore.rs 的 7 个命令加 trace_id + #[instrument]**

> **结构已确认**：vectorstore 所有命令均为 `run_guarded_async`（async 守卫，**不**跨越线程），`#[instrument]` 在 async fn 上直接生效，**不需要** `Span::current().enter()`（与 fs 的 spawn_blocking 不同）。

示例 1（单参数）：`vector_search_chunks`（行 496）
原签名：
```rust
pub async fn vector_search_chunks(
    project_path: String,
    query_embedding: Vec<f32>,
    top_k: usize,
) -> Result<Vec<ChunkSearchResult>, String> {
    run_guarded_async("vector_search_chunks", async move {
```
改为：
```rust
#[instrument(name = "vector_search_chunks", skip(project_path, query_embedding), fields(trace_id = %trace_id, project_path = %project_path))]
pub async fn vector_search_chunks(
    project_path: String,
    query_embedding: Vec<f32>,
    top_k: usize,
    trace_id: String,
) -> Result<Vec<ChunkSearchResult>, String> {
    run_guarded_async("vector_search_chunks", async move {
        // 原函数体不变；run_guarded_async 在同一 async task 中，
        // #[instrument] 的 span context 自动保持，无需 span enter
```

示例 2（多参数）：`vector_upsert_chunks`（行 426）
原签名：
```rust
pub async fn vector_upsert_chunks(
    project_path: String,
    page_id: String,
    chunks: Vec<ChunkUpsertInput>,
) -> Result<(), String> {
    run_guarded_async("vector_upsert_chunks", async move {
```
改为：
```rust
#[instrument(name = "vector_upsert_chunks", skip(project_path, chunks), fields(trace_id = %trace_id, project_path = %project_path, page_id = %page_id))]
pub async fn vector_upsert_chunks(
    project_path: String,
    page_id: String,
    chunks: Vec<ChunkUpsertInput>,
    trace_id: String,
) -> Result<(), String> {
    run_guarded_async("vector_upsert_chunks", async move {
        // 原函数体不变
```

其余 5 个命令按同模式迁移（在参数列表末尾加 `trace_id: String`，加 `#[instrument(name=..., skip(project_path), fields(trace_id=%trace_id, project_path=%project_path))]`，函数体不变）：
- `vector_delete_page(project_path, page_id)`（行 585）
- `vector_count_chunks(project_path)`（行 623）
- `vector_clear_chunks(project_path)`（行 660）
- `vector_legacy_row_count(project_path)`（行 691）
- `vector_drop_legacy(project_path)`（行 728）

> 若命令有额外大参数（如 `chunks: Vec<ChunkUpsertInput>`），在 `skip` 中加入该参数名避免写入 span name。函数体完全不动——`run_guarded_async` 内的 async 闭包自动继承 span context。

- [ ] **Step 3: embedding.ts 顶部加 invokeTraced import**

在 `src/lib/embedding.ts` 顶部（`import { invoke }` 行后）加：
```typescript
import { invokeTraced } from "@/lib/invoke-traced"
```

- [ ] **Step 4: 迁移 embedding.ts 的 7 处 invoke → invokeTraced**

先动态定位所有调用点（避免依赖可能随提交偏移的硬编码行号）：

Run:
```bash
grep -n "invoke(" src/lib/embedding.ts
```
Expected: 列出 7 处调用（当前约 369/395/403/410/416/423/432 行，以 grep 实际输出为准）。

逐个将 `invoke(` 替换为 `invokeTraced(`。例如第一处：
```typescript
  await invokeTraced("vector_upsert_chunks", { ... })
```
返回类型保持原泛型不变（invokeTraced<T> 推断与 invoke 一致）。

替换后再次确认无残留：
Run:
```bash
grep -n "invoke(" src/lib/embedding.ts | grep -v "invokeTraced\|import"
```
Expected: 无输出（所有 invoke 调用均已迁移，仅剩 import 行与 invokeTraced）。

- [ ] **Step 5: 编译 + 类型检查**

Run:
```bash
cd src-tauri && cargo check 2>&1 | grep -E "^error" | head
npm run typecheck 2>&1 | grep -iE "embedding" | head
```
Expected: 0 error。

- [ ] **Step 6: 提交**

```bash
git add src-tauri/src/commands/vectorstore.rs src/lib/embedding.ts
git commit -m "feat(logging): add trace_id propagation to vectorstore commands

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 11: 手动验证文档

**Files:**
- Create: `docs/superpowers/tests/2026-06-15-logging-phase2-validation.md`

- [ ] **Step 1: 创建验证文档**

创建 `docs/superpowers/tests/2026-06-15-logging-phase2-validation.md`：

```markdown
# 日志系统阶段 2 手动验证

> 日期: 2026-06-15 | 验证者: _____ | 应用版本: _____

## 验证环境
- [ ] `npm run tauri dev` 启动成功，控制台无 tracing 初始化错误
- [ ] 日志文件路径：`~/Library/Application Support/com.llmwiki.app/logs/llm-wiki.log`（macOS）

## 功能 1：请求追踪传播
- [ ] **trace_id 端到端一致**：导入一个文件触发读取 → 查看 llm-wiki.log，前端 send_log 日志与后端 read_file span 的 trace_id 相同
- [ ] **read_file span 含 trace_id**：日志中出现 `"span":{"name":"read_file","trace_id":"...","path":"..."}`
- [ ] **spawn_blocking 内部 ERROR 带 trace_id**：故意读取不存在文件，错误日志的 trace_id 与调用 trace_id 一致（验证 Span::current().enter() 生效）
- [ ] **跨命令关联**：一次摄取涉及多次调用时，前端可显式传同一 trace_id，日志中可串联

## 功能 2：Error 桌面通知
- [ ] **macOS 权限请求**：首次触发 ERROR，系统弹出通知权限请求，允许
- [ ] **后端 ERROR 触发通知**：读取不存在文件（触发后端 error!），桌面通知弹出，标题「LLM Wiki 发生错误」，body 含错误摘要
- [ ] **前端 ERROR 触发通知**：制造前端 ERROR（如调用一个会失败的操作），同样弹出通知
- [ ] **通知 body 无多余引号**：通知文本显示为「读取失败」而非 `"\"读取失败\""`（验证 strip_debug_quotes）
- [ ] **10s 去重**：连续制造多个 ERROR，10 秒内仅弹一条通知，body 含「更多错误详见日志」
- [ ] **配置开关关闭**：设置中关闭「错误桌面通知」→ 再制造 ERROR → 无通知
- [ ] **配置开关开启**：重新开启 → 制造 ERROR → 通知恢复
- [ ] **macOS 主线程安全**：通知正常弹出，无 `This API cannot be called on the main thread` panic（验证 run_on_main_thread）

## 自动化测试
- [ ] `npm test -- --run` 前端全绿（含 invoke-traced.test.ts 5 个）
- [ ] `cd src-tauri && cargo test logging` 后端全绿（含 config 5 个 + notify_layer 8 个）
- [ ] `npm run typecheck` 无新增错误
- [ ] `cd src-tauri && cargo clippy` 无新增 error 级别 lint

## 平台备注
- Windows 开发模式：通知图标显示为 PowerShell，生产构建（已安装）正常显示应用图标
- Linux：依赖桌面环境的通知守护进程（libnotify）

## 已知限制
- search.ts / file-sync.ts / *-cli-transport.ts 的 invoke 调用点需单独调查后按同模式迁移（本阶段未覆盖，因 grep 未发现明确 invoke() 调用）
```

- [ ] **Step 2: 提交**

```bash
git add docs/superpowers/tests/2026-06-15-logging-phase2-validation.md
git commit -m "docs(logging): add phase 2 manual validation checklist

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## 最终验证（全部任务完成后）

- [ ] `npm test -- --run` 全绿
- [ ] `cd src-tauri && cargo test` 全绿（注意：阶段 1 有 1 个已知 flaky 测试 api-server nanos temp-dir collision，孤立运行通过，见 memory [[api-server-flaky-test]]）
- [ ] `npm run typecheck` 仅阶段 1 基线的 8 个预存错误
- [ ] `cd src-tauri && cargo clippy` 0 error
- [ ] 按 Task 11 文档完成 GUI 手动验证
- [ ] 更新 `CLAUDE.md` 的「日志系统」章节，标注阶段 2 完成
- [ ] 更新 `docs/superpowers/specs/2026-06-15-logging-phase2-design.md` 状态为「已实施」
