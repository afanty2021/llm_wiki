---
task: 实施 clear_logs 修复 + stdout layer 条件化
slug: 20260629-095711_implement-clear-logs-stdout-fix
effort: extended
phase: complete
progress: 18/18
mode: interactive
started: 2026-06-29T09:57:11+0800
updated: 2026-06-29T10:10:00+0800
---

## Context

用户批准实施审计 #1（clear_logs 幽灵文件）+ #2（stdout layer）。FIX-PLAN 三轮 review 定稿后实施，并经 /simplify 二次质量审查重构。

## Criteria

- [x] ISC-1: 全局共享句柄（重构后为 SharedHandle.current_file，合并自原两把 OnceLock）
- [x] ISC-2: 全局共享句柄（SharedHandle.current_size）
- [x] ISC-3: init_logging clone current_file Arc 存全局（move 进 non_blocking 前）
- [x] ISC-4: init_logging clone current_size Arc 存全局
- [x] ISC-5: reopen_shared 纯函数（接 &SharedHandle + log_dir）
- [x] ISC-6: reopen_shared 锁顺序严格 file→size
- [x] ISC-7: reopen_shared 全程 ? 无 unwrap/expect
- [x] ISC-8: reopen_shared 流程 remove→open_or_create→替换→size=0
- [x] ISC-9: reopen 逻辑接入 clear_logs（simplify 后内联，移除单调用方 reopen_current_log）
- [x] ISC-10: clear_logs 改写「删历史(跳过当前) + reopen 当前」
- [x] ISC-11: 移除原错误注释「下次写入自动重建」
- [x] ISC-12: stdout fmt layer #[cfg(debug_assertions)] 条件添加
- [x] ISC-13: 新增 reopen_shared 单测（Arc::clone 构造，复现盲区）
- [x] ISC-14: 单测断言 reopen 后 size=0、新 fd 可写、内容非幽灵
- [x] ISC-15: cargo test --lib logging → 36 passed; 0 failed
- [x] ISC-16: cargo check --release --lib 通过（仅既有 warning）
- [x] ISC-A1: lib.rs clear_logs 命令签名不变（git diff 仅 manager.rs）
- [x] ISC-A2: 不 commit/push（待用户批准）

## Decisions

- SharedHandle 合并 file+size（/simplify 重构）：消除「file 设了 size 没设」非法中间态，get/set 各一次
- FS 操作（remove/open）移出锁外：仅赋值持锁，缩短 worker 停顿窗口（/simplify Efficiency#4）
- clear_logs 跳过当前文件：避免循环删 + reopen 双删（/simplify Efficiency#1）
- LOG_BASE_NAME 常量：消除 init/reopen base_name 分歧（/simplify Altitude#2）
- 跳过：lock→io helper（cross-cutting 超 diff）、remove→truncate（新语义风险）

## Verification

- ISC-1~14：代码改动落地于 manager.rs（git diff HEAD --stat 仅该文件，+141/-31 量级，重构后相近）
- ISC-15：`cargo test --manifest-path src-tauri/Cargo.toml --lib logging` → **36 passed; 0 failed**（含新 reopen_shared 测试 + 重写后的 clear_logs 测试）
- ISC-16：`cargo check --release --lib` 通过（1m35s），stdout layer 在 release 编译期移除，类型链合法；仅既有 warning（fs.rs / types.rs timestamp never read = 审计 #6 已知 tech debt，非本次引入）
- ISC-A1：`git diff HEAD --stat` 确认仅 `src-tauri/src/logging/manager.rs`，lib.rs 未动
- ISC-A2：未执行 git commit/push
- 重构后 manager.rs 无新 warning（cargo check grep logging/manager 无输出）
- capability：/simplify 已 invoke（4 并发 cleanup agent + 应用 A-D 重构）

## 待用户批准

实施 + 自测完成。**未提交**。手动 GUI 验证项（npm run tauri dev：清空日志→触发日志→确认面板可见/文件重建/磁盘未泄漏）无法在无 GUI 环境自动验证，建议用户手动确认后再 commit。
