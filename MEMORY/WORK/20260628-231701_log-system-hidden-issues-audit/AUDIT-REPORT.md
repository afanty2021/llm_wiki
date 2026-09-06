# 日志系统审计报告

> 审计时间：2026-06-28 · 审计人：AI（PAI Algorithm） · 状态：**仅审计，未改任何源码**
> 审计对象：llm_wiki 日志系统（前端 `src/lib/logger.ts` + 后端 `src-tauri/src/logging/*.rs` + `lib.rs` 启动注册）

## 状态校准（重要）

13 天前的项目记忆声称「日志系统 phase 1 在 log-system 分支未合并」——**已过时**。
`git merge-base --is-ancestor log-system main` = **MERGED**：phase 1-3 全部已合并 main。
当前 main 的 `src-tauri/src/logging/` 含 6 文件：`types / mod / router / config / notify_layer / manager.rs`（比早期记忆多 `config.rs` + `notify_layer.rs`）。以下全部基于当前 main 代码。

## 发现总览

共 **8 个隐藏问题**：🔴 严重 2 · 🟡 中等 3 · 🟢 轻微 3。最严重者（#1）经独立 agent 逐假设交叉验证。

---

## 🔴 严重（真实 bug，建议优先修）

### #1. `clear_logs` 幽灵文件 + 轮转链断裂（三平台一致）

- **位置**：`manager.rs:328-347`（clear_logs）、`:101`（rename 静默吞错）、`:327`（错误注释）
- **机制**：`init_logging` 把 `SizeBasedRollingFileAppender`（持有打开的 `current_file` fd）move 进 `tracing_appender::non_blocking` 的 worker 线程，此后**任何人无法触达**它的内部状态。而 `clear_logs` 只对 `logs/*.log` 调 `std::fs::remove_file`，完全没碰 appender 的 fd 和 `current_size`。
  - **macOS/Linux**（开发机 darwin 即此）：`remove_file` 只删目录项，已打开 fd 仍有效（unlinked-but-open）。清空后所有新日志 `write_all` 写进**不可见的幽灵 inode**——日志面板空白，`get_log_files`/`read_log_file`/`export_logs` 全部失明，磁盘空间悄悄泄漏，直到进程退出。**更糟**：等累积到 10MB 触发轮转时，`rotate_files` 试图把已被删除的 `llm-wiki.log` rename 成 `.1.log`（`:101`），失败被 `let _ =` 静默吞掉，**连历史轮转链都断了**，只剩一个新建的空文件。
  - **Windows**：与 macOS/Linux **行为一致**，均为幽灵文件——Rust std 在 Windows 默认以 `FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE` 打开文件（见 `std/src/sys/fs/windows.rs` 及 `OpenOptionsExt::share_mode` 文档），故 `remove_file` 对 appender 已打开的文件**成功返回 Ok**（解除目录项、标记删除），fd 仍有效，新日志继续写进不可见 inode，`clear_logs` 返回 Ok。三平台失效方式统一为「命令成功但日志失明」，**无平台差异**。

  > **更正（2026-06-28 review）**：初版误判 Windows 会因 sharing violation 报错——错把 Win32 `CreateFile` 默认当作 Rust std 默认。Rust std 的 Windows fs 默认开了 `FILE_SHARE_DELETE`，故三平台失效方式统一为幽灵文件，**无平台差异**。
- **注释错误**：`manager.rs:327` 声称「clear_logs 后文件会在下次写入时自动重建（NonBlocking 特性）」——**错误**。NonBlocking 从不重建文件，重建只发生在轮转分支，真实表述是「下次轮转（≈10MB 日志后）才重建」。实现者误判机制，这是 bug 未被发现的原因。
- **测试盲区**：现有单测 `test_clear_logs_deletes_files`（`:400-437`）不经过 `init_logging`、无 appender 持 fd，**完美规避此场景**——测试绿但 bug 在。
- **严重度**：用户可感知的功能损坏（点「清空日志」后长时间看不到日志）+ 磁盘泄漏 + 跨平台都坏。不致命（重启自愈）。

### #2. stdout 日志层在 release 未禁用（注释与代码不符）

- **位置**：`manager.rs:214-223`
- **机制**：注释写「开发模式：控制台人类可读 + 文件JSON；生产模式：仅文件JSON」。但代码里 stdout `fmt::layer()` 是**无条件添加**的，`cfg!(debug_assertions)` 只作用于 `.with_ansi(...)`（颜色开关），**不影响是否添加该层**。release build 仍向 stdout 输出人类可读日志。
- **影响**：从终端启动打包应用会刷大量日志；release 下多一层不必要的格式化 IO。

---

## 🟡 中等

### #3. `current_size` 在触发轮转的写入中漏算 `buf.len()`

- **位置**：`manager.rs:114`（先 `+= buf.len()`）→ `:131`（轮转后 `= new_size` 即 0）→ `:137`（`write_all(buf)` 但未加回）
- **机制**：触发轮转的那次 write，buf 实际写进了新文件，但 `current_size` 被重置为 0 后没把这次 `buf.len()` 加回。每轮转一次漏算一次，`current_size` 比真实文件偏小，轮转触发时机略晚。非致命的状态不一致。

### #4. `clip_server` 启动早于 `init_logging`，早期日志全部丢失

- **位置**：`lib.rs:203`（`clip_server::start_clip_server()`）vs `:226`（`init_logging` 在 `.setup` 内）
- **机制**：`start_clip_server()` 在 `tauri::Builder` 构建之前、`.setup` 之外执行，早于 `init_logging`。clip_server 启动期间（端口绑定失败、冲突等）的任何 `tracing` 日志都发生在 subscriber 初始化前 → **静默丢失**。旧 tech debt，确认仍在。

### #5. `export_logs` 同日覆盖 + 多文件未排序拼接

- **位置**：`manager.rs:624`（按日期命名 + `File::create` 截断）、`:632`（`read_dir` 未排序即拼接）
- **机制**：导出文件名仅按日期 `llm-wiki-export-YYYY-MM-DD.jsonl`，同日二次导出 `File::create` 直接截断覆盖，前次导出丢失。多个 `.log` 文件按 `read_dir` 任意顺序拼接（未排序），导出的日志**时序可能错乱**。

---

## 🟢 轻微（多为已知接受的 tech debt）

### #6. 前端 `timestamp` 端到端丢失
`router.rs` 把前端 entry 转为 tracing event 时**不转发** `entry.timestamp`，文件里前端日志用后端接收时间，非前端发生时间。

### #7. `is_current` 启发式脆弱
`manager.rs:307` 用 `!name.chars().any(|c| c.is_ascii_digit())` 判定当前文件。当前 `base_name="llm-wiki"` 无数字尚 OK，但若 base 含数字即误判。

### #8. `NotifyLayer` mutex 用 `expect` 有 panic 传播风险
`notify_layer.rs:56` 的 `.expect("last_notify mutex poisoned")` 在 mutex 中毒时 panic。通知是 best-effort 功能，不宜因 poison 让通知路径 panic。

---

## 验证方式

- 全部发现基于当前 main 代码（非记忆），每条含 `file:line` 证据。
- #1 派独立 agent 验证 A/B/C（NonBlocking 复用同一 fd / 幽灵文件 / size 漏算）确认 + 补充轮转链断裂证据；**假设 D（Windows 报错）经 review 撤销**——Rust std 默认 `FILE_SHARE_DELETE`，Windows 同为幽灵文件而非报错。
- `git status` 实测：仅审计产物未跟踪，**零源码改动**。

完整 ISC 与证据见同目录 `PRD.md`；修复方案见同目录 `FIX-PLAN.md`。
