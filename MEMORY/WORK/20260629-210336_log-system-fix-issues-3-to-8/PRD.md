---
task: Fix six logging hidden issues on new branch
slug: 20260629-210336_log-system-fix-issues-3-to-8
effort: extended
phase: complete
progress: 19/19
mode: interactive
started: 2026-06-29T21:03:36+0800
updated: 2026-06-29T21:20:00+0800
---

## Context

日志系统审计（见 `MEMORY/WORK/20260628-231701_log-system-hidden-issues-audit/`）发现 8 个隐藏问题。#1（clear_logs 幽灵文件）+ #2（stdout layer release 未禁）已于 2026-06-29 修复并合入 main（merge b8a43cc）。本次在新分支上修复剩余 #3-#8 共 6 个问题。

所有行号已按 #1#2 修复后的当前 main 重新核对（manager.rs 现 898 行）：

- **#3 current_size 漏算 buf.len()**（manager.rs:126-155，🟡 中等）。`Write::write` 第 131 行 `*size_guard += buf.len()`，但轮转分支第 148 行 `*size_guard = new_size` 把本次 buf.len() 覆盖丢失；第 154 行 write_all 写入新文件后 size 未加回。后果：每次轮转漏算一次 write 字节数，轮转阈值判定偏晚。
- **#4 clip_server 启动早于 init_logging**（lib.rs:203 vs 226，🟡 中等）。`start_clip_server()` 在 `run()` 顶部、`.setup` 之外调用，早于 `init_logging`。clip_server 启动期的日志（含启动失败诊断）丢失。
- **#5 export_logs 同日覆盖 + 未排序拼接**（manager.rs:739/742/747，🟡 中等）。文件名仅含日期 `%Y-%m-%d`，同日重复导出被 `File::create` 截断覆盖；read_dir 未排序即 write_all 拼接，历史文件顺序不确定。
- **#6 前端 timestamp 端到端丢失**（router.rs + manager.rs:861，🟢 轻微）。`FrontendLogEntry.timestamp`（types.rs:16）在 router 完全未用；日志文件记录的是 tracing event 的后端 wall-clock 时间。`extract_entry` 取顶层 `timestamp` 字段。
- **#7 is_current 启发式脆弱**（manager.rs:336，🟢 轻微）。`!name.chars().any(|c| c.is_ascii_digit())` —— 若 base_name 含数字即误判。当前 base_name="llm-wiki" 未触发，但脆弱。
- **#8 NotifyLayer expect panic 风险**（notify_layer.rs:56，🟢 轻微）。`last_notify.lock().expect(...)` 持锁前 panic 会中毒 mutex，后续每次 lock 失败。

### Risks

- #3 修复须同时保证非轮转路径不重复加 size（Splitting Test 拆出独立 ISC）。
- #4 移动 start_clip_server 位置须不破坏 clip_server 的现有生命周期（它在 .setup 外可能有意为之，需确认无 tauri-app-handle 依赖）。
- #6 端到端：router 加 field + extract_entry 回退，须保证后端日志 timestamp 不受影响（回退路径）。
- #1#2 已修逻辑不可回归（clear_logs reopen / stdout cfg）。

## Criteria

- [x] ISC-1: 轮转后 current_size 计入本次 buf.len()（manager.rs Write::write 轮转分支）
- [x] ISC-2: 非轮转路径 size 累计保持正确不重复加（manager.rs Write::write）
- [x] ISC-3: 单测验证轮转后 size 等于 new_size 加 buf.len()
- [x] ISC-4: start_clip_server 调用移至 init_logging 之后（lib.rs）
- [x] ISC-5: clip_server 启动期日志不再早于 logging 初始化
- [x] ISC-6: 同日多次导出文件名唯一不再覆盖（export_logs）
- [x] ISC-7: export 拼接顺序确定按 mtime 升序（老到新）
- [x] ISC-8: export_logs 单测验证唯一文件名加排序
- [x] ISC-9: router 将 entry.timestamp 写入 tracing fields（frontend_ts）
- [x] ISC-10: extract_entry 优先读 frontend_ts 回退顶层 timestamp
- [x] ISC-11: 后端日志 timestamp 不受 frontend_ts 影响（回退正常）
- [x] ISC-12: 端到端测试前端 timestamp 透传至 LogDisplayEntry
- [x] ISC-13: is_current 改精确文件名匹配弃用数字启发式
- [x] ISC-14: is_current 单测验证 base_name 含数字场景正确判定
- [x] ISC-15: acquire_slot_at 锁失败不 panic 中毒 mutex 容错
- [x] ISC-16: acquire_slot_at 中毒 mutex 单测不 panic
- [x] ISC-17: logging 模块全部 cargo test 通过且不破坏其他测试
- [x] ISC-A1: 不回归 clear_logs reopen 与 stdout cfg 已修逻辑
- [x] ISC-A2: 持锁路径不引入新的 unwrap 或 expect

### Plan

修复方案（已验证 prerequisite）：

- **#3**（manager.rs:148）：轮转分支 `*size_guard = new_size + buf.len() as u64;`（new_size 通常 0，覆盖了原重置丢失的本次写入字节数）
- **#4**（lib.rs:203→227）：删除 `run()` 顶部 `start_clip_server()`，移入 `.setup` 内 `init_logging` 之后（已确认无 AppHandle 依赖、非阻塞 spawn、内部依赖 subscriber 已就绪）
- **#5**（manager.rs:739/747）：文件名加 `-%H%M%S` 时分秒；read_dir 后按 mtime 升序排序（老→新连续叙事）
- **#6**（router.rs 4 event + manager.rs:861）：tracing event 加 `frontend_ts = %entry.timestamp` field；`extract_entry` 优先读 `fields.frontend_ts`，回退顶层 `timestamp`（后端日志不受影响）
- **#7**（manager.rs:336）：提纯 `is_current_log(name, base)` 纯函数 `name == format!("{}.log", base)`，弃用数字启发式
- **#8**（notify_layer.rs:56）：`match lock { Ok(g)=>g, Err(e)=>e.into_inner() }`，中毒容错不 panic

测试：#3 轮转后 size 断言；#5 export 唯一名+排序；#6 extract_entry 优先 frontend_ts；#7 is_current_log 含数字 base；#8 acquire_slot_at 中毒 mutex 不 panic。全部 `cargo test --manifest-path src-tauri/Cargo.toml`。

## Decisions

（BUILD 阶段填写具体修复实现选择）

## Verification

全部 19 条 ISC 通过。测试：`cargo test --manifest-path src-tauri/Cargo.toml` = **163 passed; 0 failed; 1 ignored**（logging 41 + 其他 122 零回归）。

- ISC-1/2/3：`rotate_size_includes_written_bytes` 验证 max=10 写 5+10 字节后 size=10。agent 深度确认：line131 `+=` 在 should_rotate block guard drop 后，line146 是新 lock 覆盖（非累加），无 double-count，`+buf.len()` 精确对应 line155 write_all。
- ISC-4/5：lib.rs start_clip_server 移入 .setup init_logging 后（line 227）。agent 确认非阻塞 spawn、无 AppHandle 依赖、bind-retry 独立于调用点。#4 为启动顺序，代码审查验证（非单测，需 tauri runtime）。
- ISC-6/7/8：`export_logs_unique_name_and_sorted` 验证文件名含时分秒（`-` 段≥5）+ 跨秒唯一 + 内容 "oldest\nmiddle\nnewest\n"（mtime 升序）。
- ISC-9/10/11/12：`extract_entry_prefers_frontend_ts` 验证 span.frontend_ts 优先、后端无 span 回退顶层 timestamp。agent 确认 fmt::layer().json()（manager.rs:253-259）序列化 span fields（既有 span.module/trace_id 测试证明），frontend_ts 同路径。
- ISC-13/14：`is_current_log_matches_exact_name` 验证精确匹配 + base 含数字（app2）。simplify 后改 strip_suffix 无分配。
- ISC-15/16：`acquire_slot_handles_poisoned_mutex` 验证中毒 mutex 不 panic（into_inner 取中毒值）。
- ISC-17：全量 163 passed 0 failed。
- ISC-A1：reviewer 确认 reopen_shared(line373) + stdout cfg(line244) 不在 diff hunk，#1#2 完整；test_clear_logs_deletes_files + reopen_shared_replaces_fd_and_resets_size 仍通过。
- ISC-A2：reviewer 确认新增 unwrap/expect 全在 #[cfg(test)]；唯一生产 lock 改动（notify_layer:56）是 expect→into_inner 容错。

Capability 调用检查：/simplify（Skill simplify，4 agent）、reviewer（Agent）、general-purpose（Agent）均实际 invoke，非文本伪调用。
