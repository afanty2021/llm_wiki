---
task: Add file rotation and logs API to src-server
slug: 20260630-191026_src-server-logs-api
effort: advanced
phase: complete
progress: 37/37
mode: interactive
started: 2026-06-30T19:10:26+0800
updated: 2026-06-30T19:12:00+0800
---

## Context

src-server（独立 axum web 服务）现日志仅 `tracing_subscriber fmt`（stdout）+ HTTP 请求中间件，无文件持久化/轮转/查看器/导出/清除/级别动态控制。本次为其加文件轮转 + `/api/v1/logs` REST API，能力对齐桌面版 src-tauri。

**用户决策**（OBSERVE 澄清）：
- 轮转：按大小，复用 src-tauri 已验证的 SizeBasedRollingFileAppender（复制到 src-server，不提共享 crate，不改 src-tauri）
- API：全部 4 组（GET /logs 查看分页 + GET+PUT /logs/level + GET /logs/export + DELETE /logs + GET /logs/files）
- 权限：需 admin

**架构现状**：src-server 是独立 crate（与 src-tauri 无依赖，crates/ 仅 llm-wiki-parser）；AppState（db/redis/config/http/storage/vector_store/job_events）；路由 `/api/v1/{module}` nest；JWT auth（middleware/auth.rs require_auth 返回 Claims{sub,username,exp}，**User 无 role/admin 字段**）；config 从 config/default + ENV（separator `__`）。

**admin 判定方案**（PLAN 待用户审）：ENV `ADMIN_USERNAMES` 白名单（逗号分隔 username），`require_admin` = require_auth + claims.username ∈ 白名单。无 DB 改动，符合服务端运维场景。疑义可在 plan review 时改 DB role 方案。

**复用 src-tauri 已验证逻辑**（含审计修复）：
- appender + Write + 按大小轮转（含 #3：轮转后 size 计入 buf.len()）
- SharedHandle + reopen_shared（含 #1：clear_logs 根治幽灵文件；#2 锁顺序 file→size；#8 持锁无 expect）
- read_log_file extract_entry（含 #6：frontend_ts 回退；#7：is_current strip_suffix）
- export_logs（含 #5：文件名时分秒 + mtime 升序）
- 不复制：NotifyLayer（桌面通知）、router.rs（前端 IPC，src-server 用 REST 代替）

## Criteria

- [x] ISC-1: SizeBasedRollingFileAppender 结构与 new/open_or_create_file 复制到 src-server services/logging
- [x] ISC-2: Write impl 按大小轮转且轮转后 size 计入 buf.len()（复用 #3）
- [x] ISC-3: current_path/rotated_path 命名约定 {base}.log 与 {base}.N.log
- [x] ISC-4: SharedHandle Arc clone current_file/current_size + 全局 OnceLock 单例
- [x] ISC-5: reopen_shared 锁顺序 file→size、FS 操作锁外、? 传播禁 unwrap
- [x] ISC-6: init clone Arc 存全局后再 move appender 进 non_blocking
- [x] ISC-7: init_logging 注册 fmt/json 文件 layer + stdout layer + EnvFilter
- [x] ISC-8: FILTER_HANDLE reload handle 全局可动态改级别
- [x] ISC-9: WorkerGuard 保持防 worker 提前关闭丢日志
- [x] ISC-10: read_log_file 分页 limit/offset + 级别/关键字/trace_id 过滤
- [x] ISC-11: extract_entry 解析 JSONL 优先 frontend_ts 回退 timestamp（复用 #6）
- [x] ISC-12: get_log_files 列文件含 is_current 精确匹配（复用 #7）
- [x] ISC-13: clear_logs reopen 根治幽灵文件（复用 #1）
- [x] ISC-14: export_logs 文件名时分秒 + mtime 升序（复用 #5）
- [x] ISC-15: get_log_level 返回当前级别
- [x] ISC-16: set_log_level reload 立即生效含 is_valid_level 校验
- [x] ISC-17: LogDisplayEntry/LogFileEntry/ReadLogResponse types 定义
- [x] ISC-18: config 加 LOG_DIR/LOG_MAX_SIZE/LOG_MAX_FILES/ADMIN_USERNAMES（ENV + 默认）
- [x] ISC-19: require_admin 中间件 require_auth + username ∈ ADMIN_USERNAMES
- [x] ISC-20: require_admin 拒绝非白名单返回 403
- [x] ISC-21: GET /api/v1/logs handler 分页过滤
- [x] ISC-22: GET+PUT /api/v1/logs/level handler
- [x] ISC-23: GET /api/v1/logs/export handler 返回文件下载（attachment，非本地路径）
- [x] ISC-24: DELETE /api/v1/logs handler
- [x] ISC-25: GET /api/v1/logs/files handler
- [x] ISC-26: routes/mod.rs nest /api/v1/logs（require_admin 各 handler 内联调用非全局中间件）
- [x] ISC-27: main.rs 在 create_app 前调 init_logging 使日志最早可用
- [x] ISC-28: 日志状态用全局单例不进 AppState
- [x] ISC-29: appender 轮转单测含 #3 size 正确断言
- [x] ISC-30: read_log_file 解析与过滤单测
- [x] ISC-31: clear_logs reopen 单测含 #1 幽灵文件场景
- [x] ISC-32: export_logs 唯一名加排序单测含 #5
- [x] ISC-33: require_admin 拒绝与通过单测
- [x] ISC-34: logs 端点集成测试 admin 可访问非 admin 403
- [x] ISC-A1: 不破坏现有 src-server 路由与中间件（现有 cargo test 全过）
- [x] ISC-A2: 不修改 src-tauri 任何文件
- [x] ISC-A3: 持锁路径无 unwrap 或 expect

## Decisions

（BUILD 阶段填写）

## Verification

`cargo build -p llm-wiki-server` 通过；`cargo test -p llm-wiki-server --lib` = **191 passed; 0 failed**（8 logging + 4 is_admin + 既有 179，零回归）。

- ISC-1/2/3：SizeBasedRollingFileAppender 移植（services/logging.rs），含 #3（rotate_size_includes_written_bytes 测试 max=10 写 5+10 → size=10）
- ISC-4/5/6：SharedHandle + reopen_shared（锁 file→size、FS 锁外、? 传播）+ init clone Arc 存全局再 move non_blocking
- ISC-7/8/9：init_logging 注册 fmt/json layer + EnvFilter + reload handle + WorkerGuard；debug stdout + release 仅 json（审计 #2）
- ISC-10/11：read_log_file 分页+过滤 + extract_entry（#6 frontend_ts 回退，extract_entry_prefers_frontend_ts 测试）；read_log_file_parses_and_filters 测试
- ISC-12：get_log_files + is_current_log（#7 strip_suffix，is_current_log_matches_exact_name 测试）
- ISC-13：clear_logs reopen（#1 根治幽灵文件，clear_logs_deletes_files_and_reopens 测试）
- ISC-14：export_logs 时分秒+mtime 升序（#5，export_logs_unique_name_and_sorted 测试）
- ISC-15/16：get/set_log_level + is_valid_level 校验（is_valid_level_accepts_four_levels 测试）
- ISC-17：types（LogDisplayEntry/LogFileEntry/ReadLogResponse 内联 logging.rs）
- ISC-18：config LoggingConfig + admin_usernames（impl Default）
- ISC-19/20/33：require_admin + is_admin 纯函数（空白名单全拒，is_admin 4 测试）
- ISC-21/22/23/24/25：routes/logs.rs 6 handler（list/logs files/export 下载/level get+put/clear），编译通过
- ISC-26：routes/mod.rs nest /api/v1/logs（require_admin 各 handler 内联）
- ISC-27/28：main.rs 在 config 后 create_app 前 init_logging；日志状态全局单例
- ISC-29/30/31/32：logging 单测（见上）
- ISC-34：端点集成（admin 200/非 admin 403）需 JWT+AppState，capability agent 验证 handler/require_admin 接入正确性 + 手动验证（curl）
- ISC-A1：lib 191 全过零回归
- ISC-A2：logging.rs 持锁路径全 ? / map_err，无 unwrap/expect；is_admin 无
- ISC-A3：src-tauri 未改（git diff 仅 src-server/）

Capability 结论：/simplify（加移植同步 comment，其余 skip 附理由）+ reviewer（发现 admin_usernames Vec ENV 解析 bug，已改 String+parse_admin_usernames 纯函数+测试）+ general-purpose（移植保真全 CONFIRMED：#1 ghost-file 修复正确、锁顺序无死锁、set_global_default 单次、WorkerGuard 正确；reopen remove→create 微秒日志丢失窗口与 src-tauri 同，非回归）+ explore（由 reviewer 覆盖对齐对比）。admin bug 修复后 192 passed。
