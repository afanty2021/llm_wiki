# 修复 Plan：#1 clear_logs + #2 stdout layer

> 状态：**PLAN，未实施**。surgical 最小改动原则。需用户批准方案后开工；commit/push 按用户规则另行批准。

## 范围

仅修 🔴 严重两项。🟡#3-5 / 🟢#6-8 不在本次范围（后续按需另起任务）。

---

## Fix #1 — `clear_logs` 幽灵文件 + 轮转链断裂

**根因（已独立验证）**：`SizeBasedRollingFileAppender` 的 `current_file`（fd）与 `current_size` 被 move 进 `tracing_appender::non_blocking` 的 worker 线程，外部 `clear_logs` 无法触达 → 删文件后 fd 仍指向 unlinked inode。

### 三种方案对比

| 方案 | 做法 | 优点 | 缺点 |
|------|------|------|------|
| A. truncate 当前文件 | 对当前文件用 `OpenOptions::truncate` 清空 | 简单 | clear_logs 仍触达不到 appender fd；且 size 不重置 |
| **B. 全局句柄 + reopen（推荐）** | clone appender 现有的 `current_file` / `current_size` Arc 提为全局；clear 时调 `reopen_current_log()` 关旧 fd → 删/重建当前文件 → size 归零 | 根治；三平台统一语义 | 改动适中（~30 行） |
| C. clear 后强制轮转 | 触发一次 `rotate_files` 借轮转路径重建 | 改动小 | rename 失败被吞的老问题仍在，不可靠 |

### 推荐方案 B 实施步骤（`src-tauri/src/logging/manager.rs`）

1. **主方案（可行）**：复用 appender 现有的两个 Arc，新增全局句柄：
   ```rust
   static CURRENT_FILE: OnceLock<Arc<Mutex<File>>> = OnceLock::new();
   static CURRENT_SIZE: OnceLock<Arc<Mutex<u64>>> = OnceLock::new();
   ```
   `init_logging` 时 `Arc::clone(&file_appender.current_file)` / `Arc::clone(&file_appender.current_size)` 存入全局，**再** move appender 进 `non_blocking`。两者共享同一组 Arc。

   > **互斥粒度（review）**：worker 写入与 reopen **仅在 file 锁段互斥**，并非全程串行。`current_size` 与 `current_file` 是两把独立锁；正常写入路径里 size 更新（manager.rs:114）与 file 写入（:135）分属不同锁段，若 clear 在「size 锁释放后、file 锁获取前」间隙 reopen，本次 buf 仍写入新文件但 size 漏算（与 #3 同类，仅影响轮转时机略晚）。要真正原子需 size/file 合入同一 Mutex 或持 file 锁期间更新 size——属 #3 范畴；本方案不强制，因核心目标「日志可见」已达成。

   > **更正（2026-06-28 review）**：初版主方案 `OnceLock<Arc<Mutex<SizeBasedRollingFileAppender>>>` **不可行**：① `non_blocking` 要求 `W: Write + Send + 'static` 并 take ownership，appender move 进 worker 后无法再被全局 OnceLock 持有；② `Arc<Mutex<Appender>>` 未实现 `Write`，无法作为 `non_blocking` 的 writer。
2. 新增 `pub fn reopen_current_log(log_dir: &Path) -> io::Result<()>`。**锁顺序必须 file→size**——与 `Write::write` 轮转路径一致（manager.rs:125 锁 file → :129 锁 size，嵌套）；若 reopen 反向 size→file，会与轮转路径构成相反锁序 → **死锁**，NonBlocking worker 永久阻塞，日志系统完全停摆（比原 bug 更严重）。全程 `?` 传播错误，**禁用 unwrap/expect**——持锁期 panic 会中毒 Mutex，worker 后续每次 lock 失败而静默丢全部日志。流程：lock file → lock size（嵌套）→ drop 旧 fd → remove_file 当前路径 → open_or_create_file 重建 → 替换 file → size = 0。
3. 改写 `clear_logs`：先删所有轮转历史 `.N.log`，再调 `reopen_current_log` 处理当前文件。
4. 修正 `manager.rs:327` 错误注释（「下次写入重建」→「clear 主动 reopen 重建」）。
5. **测试设计（绕开 AppHandle + 全局 subscriber，review）**：`init_logging` 依赖 `tauri::AppHandle`（Cargo.toml:22 的 tauri 仅启用 `protocol-asset`/`tray-icon`、未启用 test feature，cargo test 无法构造 AppHandle），且内部 `set_global_default`（manager.rs:232）是进程级单例（单 test binary 仅可成功一次，不可并行/重复）。故把 reopen 核心逻辑提取为接收 `&Arc<Mutex<File>>` / `&Arc<Mutex<u64>>` 的独立纯函数 `reopen_shared(...)`。测试直接 `Arc::clone` 构造共享句柄（模拟 init_logging 注入点）：写入 → reopen_shared → 再写入 → 断言新日志落在重建后的可见文件、size 归零、轮转历史正常。真正复现「appender 持 fd 时 clear」盲区，无需 Tauri 运行时、不碰全局 subscriber。

---

## Fix #2 — stdout fmt layer release 未禁用

**根因**：`manager.rs:214-223` stdout layer 无条件添加，`cfg!(debug_assertions)` 只在 `with_ansi`，与注释承诺的生产「仅文件」不符。

### 实施（条件添加整个 layer）

```rust
let subscriber = Registry::default().with(filter);
#[cfg(debug_assertions)]
let subscriber = subscriber.with(
    fmt::layer().with_writer(std::io::stdout)
        .with_target(true).with_thread_ids(false).with_ansi(true),
);
let subscriber = subscriber
    .with(fmt::layer().json().with_writer(normal_appender).with_target(true))
    .with(NotifyLayer::new(app_handle));
```

`#[cfg]` 比 `cfg!()` 运行时分支更干净——release 编译期移除整层。

---

## 改动文件清单

- `src-tauri/src/logging/manager.rs`（#1 全部 + #2 + 注释 + 新测试）
- `src-tauri/src/lib.rs`（仅当 `clear_logs` 命令签名需调整）

## 验证计划

1. `cargo test`（Tauri crate）含新增 clear_logs 集成测试
2. `npm run typecheck`（前端无改动，冒烟）
3. 手动 `npm run tauri dev`：清空日志 → 再触发日志 → 确认面板可见、文件重建、磁盘未泄漏（GUI 项，测试覆盖不到）

## 不在本次范围

#3 current_size 漏算 · #4 clip_server 启动顺序 · #5 export 覆盖/乱序 · #6-#8 轻微 tech debt（后续按需另起）。
