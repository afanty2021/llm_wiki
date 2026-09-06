---
task: 审计 llm_wiki 日志系统隐藏问题
slug: 20260628-231701_log-system-hidden-issues-audit
effort: standard
phase: complete
progress: 9/9
mode: interactive
started: 2026-06-28T23:17:01+0800
updated: 2026-06-28T23:22:00+0800
---

## Context

用户要求检查 llm_wiki 日志记录系统是否存在隐藏问题。纯审计任务，不修改代码。

记忆校准：13 天前记忆声称日志系统 phase 1 在 log-system 分支未合并——已过时。`git merge-base --is-ancestor log-system main` = MERGED，phase 1-3 全部已合入 main。

## Criteria

- [x] ISC-1: 定位 clear_logs 幽灵文件 fd 泄漏根因（manager.rs:328-347 + agent 验证 A/B）
- [x] ISC-2: 验证 clear_logs 注释"下次写入自动重建"为错误声明（manager.rs:327；实际需等轮转）
- [x] ISC-3: 定位 stdout fmt layer 在 release 未禁用（manager.rs:214-223 注释与代码不符）
- [x] ISC-4: 定位 current_size 漏算 buf.len()（manager.rs:114/131/137 + agent 验证 C）
- [x] ISC-5: 定位 clip_server 启动早于 init_logging（lib.rs:203 vs 226）
- [x] ISC-6: 定位 export_logs 同日覆盖 + 未排序拼接（manager.rs:624/632）
- [x] ISC-7: 确认前端 timestamp 端到端丢失（router.rs 不转发 entry.timestamp）
- [x] ISC-8: 按严重度分级输出报告且每条附 file:line 证据（已输出）
- [x] ISC-A1: 不修改任何源码（仅审计，修复待用户批准）

## Decisions

报告分三级（严重/中等/轻微），区分"真实 bug"与"已知接受的 tech debt"。最严重发现（clear_logs 幽灵文件）因反直觉+跨平台差异，派独立 agent 交叉验证而非单点断言。

## Verification

全部 9 条 ISC 通过，证据如下（均基于当前 main 代码，非记忆）：

- ISC-1/2：独立 agent 验证 A/B 确认 + 补充轮转链断裂证据（manager.rs:101 rename 失败被 `let _ =` 吞掉）。**三平台统一幽灵文件失效**：Windows 因 Rust std 默认 `FILE_SHARE_DELETE`，remove_file 成功返回 Ok 而非报错（review 更正：初版误判 sharing violation，源于错把 Win32 默认当 Rust std 默认；agent 假设 D 实为未实测的常识推断，已撤销）。
- ISC-3：直接读 manager.rs:214-223，cfg!(debug_assertions) 仅在 with_ansi 参数，stdout layer 无条件添加。
- ISC-4：独立 agent 验证 C 确认；manager.rs:114 加 size → :131 重置为 0 → :137 write_all 未加回。
- ISC-5：lib.rs:203 start_clip_server 在 .setup(:219) 外、init_logging(:226) 前。
- ISC-6：manager.rs:624 File::create 截断 + 按日期命名；:632 read_dir 未排序即 write_all 拼接。
- ISC-7：router.rs route_single_log 未引用 entry.timestamp，tracing event 用自身时间戳。
- ISC-8：报告已按严重/中等/轻微三级输出，每条含 file:line。
- ISC-A1：git status 干净，仅新增 MEMORY/WORK/.../PRD.md（审计产物），未触碰任何源码。

Capability 调用检查：独立 Agent 交叉验证已在 BUILD 阶段通过 Agent 工具实际 invoke（非文本伪调用）。
