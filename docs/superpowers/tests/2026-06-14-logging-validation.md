# 日志系统阶段 1 验证报告

> **测试日期**: 2026-06-14（文档创建于子代理环境）
> **版本**: 阶段 1 实现
> **范围**: 日志系统阶段 1 全部功能
> **验证方法**: 自动化测试（cargo test / vitest）+ 静态代码审计 + 待人工运行验证

---

## 概述

本文档据实记录日志系统阶段 1 的验证状态。验证分两类：

1. **自动化测试覆盖** —— 通过 `cargo test` 或 `vitest` 验证过的逻辑。
2. **待人工运行验证** —— 子代理环境无法运行桌面应用（`npm run tauri dev` 需 GUI），必须由人工启动应用后才能验证的端到端行为。

**关键说明**：本文档由子代理生成。子代理无法运行 Tauri 桌面应用，因此凡涉及「实际启动 app 后观察到的行为」（如控制台真实输出格式、文件实际路径、UI 真实渲染、trace_id 端到端传播、10MB 实际触发轮转）一律标记为「待人工验证」，不会为了完成 checklist 而标成「已验证」。

---

## 一、自动化测试覆盖（已验证）

以下项目均由真实自动化测试覆盖，已在子代理环境中通过。每项标注验证文件与测试用例。

### 1.1 Logger Facade（前端）—— `src/lib/__tests__/logger.test.ts`

- [x] **实例创建**：`createLogger("test")` 返回含 `debug/info/warn/error` 方法的对象
  - 验证：`should create logger instance`
- [x] **级别过滤**：在 WARN 级别下，仅 `WARN`/`ERROR` 通过；DEBUG/INFO 在进入批量前被过滤
  - 验证：`should respect log level filtering`（fake timers + 真实 debounce + 实际 invoke 拦截，断言只发出 1 次 RPC，载荷包含恰好 `["WARN", "ERROR"]`）
- [x] **trace_id 自动生成**：未提供 `trace_id` 时调用 `crypto.randomUUID()`
  - 验证：`should generate trace_id when not provided`（spy on `global.crypto.randomUUID`）
- [x] **trace_id 复用**：调用方提供 `trace_id` 时不重新生成
  - 验证：`should use provided trace_id`（spy 未被调用）

### 1.2 端到端集成（前端）—— `src/lib/__tests__/logging-integration.test.ts`

- [x] **级别 RPC 往返**：`setLogLevelRpc("INFO")` → `getLogLevel()` 返回 `"INFO"`
  - 验证：`should read and write log level via RPC`
- [x] **批量日志送达**：连续发送 15 条 INFO 消息，断言所有 15 条最终通过 `send_log` RPC 送达（跨多个批次）
  - 验证：`should batch multiple log messages and flush them`（断言 `totalSent === 15` 且每条消息格式正确）
- [x] **级别过滤（集成层）**：在 ERROR 级别下，DEBUG/INFO/WARN 被过滤，仅 ERROR 送达
  - 验证：`should filter out messages below the configured level`（断言 `sendLogCallCount === 1` 且载荷恰好 1 条 ERROR）

### 1.3 Log Router（后端）—— `src-tauri/src/logging/router.rs`

- [x] **`route_batch_logs` 不 panic**：单条日志通过批量入口正常路由（不验证 tracing 实际输出，因 global subscriber 在测试环境未初始化）
  - 验证：`test_route_single_log_via_batch`
- [x] **4 级别路由不 panic**：DEBUG + ERROR 两条混合批量正常处理
  - 验证：`test_route_batch_logs`

### 1.4 轮转与清理（后端）—— `src-tauri/src/logging/manager.rs`

- [x] **`SizeBasedRollingFileAppender` 写入 + 轮转**：
  - 写入小数据 → 验证文件内容为 `"hello from test\n"`
  - 写入超过 `max_size_bytes`（100 字节）的数据 → 验证当前文件被重命名为 `llm-wiki.1.log`，内容为旧数据；新当前文件内容为新数据
  - 验证：`test_log_file_creation_and_write`
- [x] **`clear_logs` 文件过滤**：删除 `.log` 后缀文件，保留非 `.log` 文件（如 `other.txt`）
  - 验证：`test_clear_logs_deletes_files`（断言仅剩 1 个文件 `other.txt`）
- [x] **`rotate_files` 链完整性**（代码审计 + 测试间接覆盖）：三步法（删除最老 → 后移编号 → 当前文件重命名为 `.1.log`），从高到低遍历避免覆盖，保留 5 个历史文件
  - 验证：代码审计 + `test_log_file_creation_and_write` 中单步轮转已验证；多步链由代码路径推断（10MB 阈值需人工触发完整链）

### 1.5 编译与类型检查

- [x] **Rust 编译通过**：`cargo check` 无错误
- [x] **后端 0 个 `eprintln!`**：生产代码全部迁移到 tracing 宏（含 `panic_guard.rs` 及 `commands/*.rs` 等 11 个文件）
  - 注：`src-tauri/src/commands/fs.rs` 测试模块内的诊断输出也已迁移到 tracing 宏，并在测试内初始化 subscriber（`init_test_logger()`），保证 `--nocapture` 可见性
  - 注：`src-tauri/src/clip_server.rs:92` 的 `println!` 是 clip_server 启动横幅，发生在 `init_logging` 之前（详见技术债）
- [x] **TypeScript 类型检查通过**：`npm run typecheck` 在日志系统相关文件中 0 错误
  - 注：仓库整体存在 8 个预存的、与日志系统无关的类型错误（阶段 1 范围外）

---

## 二、待人工运行验证（未验证）

以下项目子代理环境无法验证，需要人工启动应用后逐项确认。

### 2.1 控制台输出实际格式（stdout fmt 层）

- [ ] **人类可读格式**：开发模式下 stdout 输出应包含时间戳、级别、target、消息
  - 验证步骤：`npm run tauri dev` → 在 DevTools 或运行终端观察 stdout → 触发任意前端日志（如聊天交互）→ 确认输出形如 `2026-06-14T12:00:00Z INFO module_name message`
- [ ] **包含模块名称**：前端日志应在 span 字段或 message 中可见 `module`（router.rs 将前端 module 作为 span 字段）
  - 验证步骤：触发前端日志 → 观察 stdout 中 `module=` 字段是否存在
- [ ] **ANSI 颜色（仅 debug 模式）**：`with_ansi(cfg!(debug_assertions))` 配置下，debug 构建应有颜色，release 构建应无颜色
  - 验证步骤：分别运行 `npm run tauri dev`（debug）与生产构建，对比输出
- [ ] **时间戳正确**：时间戳使用本地时区还是 UTC、是否与应用实际时间一致
  - 验证步骤：触发日志 → 对比日志时间与系统时钟

### 2.2 日志文件实际输出（JSON fmt 层）

- [ ] **文件实际路径**：`{app_data_dir}/logs/llm-wiki.log` 路径下确实生成文件
  - 验证步骤：启动 app → 触发日志 → 用文件管理器或 `ls "$APP_DATA_DIR/logs/"` 确认 `llm-wiki.log` 存在
  - 注：macOS 上 `app_data_dir` 通常为 `~/Library/Application Support/com.llm-wiki.app/` 或类似（具体 bundle identifier 见 `tauri.conf.json`）
- [ ] **JSON 格式正确**：每行是一个有效 JSON 对象（tracing-subscriber 默认 JSON 格式）
  - 验证步骤：`cat llm-wiki.log | head -1 | jq .` 应解析成功
- [ ] **包含所有必需字段**：每条日志应含 `timestamp`、`level`、`target`、`fields.message`、`fields.trace_id`、`fields.module`（前端路由日志）
  - 验证步骤：触发前端日志 → 读文件 → 确认字段齐全
- [ ] **trace_id 在文件中正确传播**：前端日志的 `trace_id` 字段在 JSON 输出中出现
  - 验证步骤：在前端代码中提供固定 `trace_id` 触发日志 → grep 文件确认 trace_id 出现

### 2.3 日志级别控制

- [ ] **DEBUG/INFO/WARN/ERROR 级别正确过滤**：自动化测了前端层和 RPC 往返，但后端 `EnvFilter` 实际作用于 tracing 输出的端到端行为未验证
  - 验证步骤：启动 app → 设置界面切换到 INFO → 触发 DEBUG 日志 → 确认文件中无 DEBUG 条目；切换到 DEBUG → 确认 DEBUG 条目出现
- [ ] **设置界面更改立即生效**：UI 改级别 → 后端 reload → 当下新日志立即按新级别过滤
  - 验证步骤：启动 app → 设置中切到 WARN → 触发 INFO（应无）→ 切到 INFO → 触发 INFO（应有），无需重启 app

### 2.4 设置界面 UI 实际渲染

- [ ] **`logging-config.tsx` 渲染级别选择器**：按钮或下拉正确渲染 4 个级别
  - 验证步骤：启动 app → 进入设置 → 找到日志配置区 → 确认 UI 控件可交互
- [ ] **UI 与后端状态同步**：UI 显示的当前级别与后端 `get_log_level` 返回值一致
  - 验证步骤：UI 切换级别 → 重启 app → 确认 UI 显示与上次设置一致（持久化）

### 2.5 文件轮转（实际触发）

- [ ] **10MB 实际触发轮转**：自动化测了 100 字节阈值的轮转逻辑，10MB 是生产配置值，需要长时间运行或大量日志才能触发
  - 验证步骤：方案 A（推荐）—— 临时修改 `init_logging` 中的 `max_size_bytes` 为小值（如 1KB），启动 app → 触发若干日志 → 确认 `llm-wiki.1.log` 生成；验证后回滚改动。方案 B —— 长时间运行真实应用直至自然触发
- [ ] **保留 5 个历史文件**：多次轮转后应最多保留 `llm-wiki.1.log` ~ `llm-wiki.5.log`，第 6 次轮转时最老文件被删除
  - 验证步骤：方案 A 触发 6 次以上轮转 → 列出 logs 目录 → 确认最多 5 个历史文件 + 1 个当前文件

### 2.6 trace_id 端到端传播

- [ ] **前端→后端→文件全链路**：前端生成的 trace_id 经 `send_log` RPC → `route_single_log` → tracing span → JSON 文件
  - 验证步骤：在前端代码临时硬编码 `trace_id: "manual-test-xyz"` → 触发日志 → `grep manual-test-xyz llm-wiki.log` 应命中
  - 注：此为完整链路验证，超出单测范围（单测分别验证了前端 trace_id 生成与后端 router 不 panic，但未连接）

### 2.7 应用启动初始化

- [ ] **`init_logging` 在应用启动时被调用**：`src-tauri/src/lib.rs` 的 setup hook 中应调用 `logging::init_logging`
  - 验证步骤：启动 app → 无报错 → 触发任意前端日志 → 确认文件生成（间接验证初始化成功）
- [ ] **前端 `initLogger` 在 React 启动时执行**：拉取后端初始级别、注册 `beforeunload` flush
  - 验证步骤：启动 app → 关闭 app → 确认未 flush 的批量日志在关闭前被 flush（grep 文件）

---

## 三、已知限制与技术债

以下问题在代码评审中发现，据实记录。多数为阶段 1 范围内的妥协，建议在后续阶段处理。

### 3.1 架构性妥协

- **前端日志 target 过滤粒度受限** —— 来源：Task 6 / router.rs（Task 15 复审后已部分恢复）
  - 现状：router 的 span/event 使用固定字面量 `target: "frontend"`（tracing 宏的 callsite 要求 target 为编译期 `'static str`，无法用运行时的 `entry.module`——计划原版 `target: target` 会触发 E0435 无法编译）。前端 `module` 作为 span 字段保留。
  - 能力：`RUST_LOG=frontend=debug` 可单独控制所有前端日志（与后端分离）；EnvFilter 字段语法 `frontend[module="src/lib/ingest.ts"]=debug` 可按模块筛选。
  - 限制：无法做到 `RUST_LOG=src/lib/ingest.ts=debug`（动态 target 在 tracing 宏体系下不可行，需底层 Metadata API，代价过大，留待未来按需评估）。

- **`message` 与 `data` 分两条 event（非原子）** —— 来源：Task 6 / router.rs
  - 现状：`route_single_log` 中先发一条 `tracing::info!("{}", entry.message)`，再发一条 `tracing::info!(data = ?data, "context")`。
  - 影响：在 JSON 日志中，同一条业务日志被拆为两行；并发场景下两行可能被其他日志插入，破坏 1:1 对应关系。
  - 缓解：trace_id 相同可事后关联；建议未来合并为单 event（如 `tracing::info!(data = ?data, "{}", entry.message)`）。

### 3.2 实现细节

- **`clip_server` 启动期 tracing 日志是 no-op** —— 来源：Task 10
  - 现状：`clip_server.rs:92` 的 `println!("[Clip Server] Listening on ...")` 发生在 `init_logging` 调用之前（启动顺序），因此该行无法被 tracing 捕获。
  - 影响：clip_server 启动横幅只到 stdout，不进 JSON 日志文件。
  - 缓解：可接受（启动横幅属于运维信息）；如需进文件，应调整初始化顺序或显式 emit 一次。

- **`is_current` 启发式脆弱** —— 来源：Task 7 / manager.rs
  - 现状：`get_log_files` 中判断「是否为当前活跃文件」的逻辑是 `!name.chars().any(|c| c.is_ascii_digit())`（文件名无数字）。
  - 影响：若未来 base_name 含数字（如 `llm-wiki-2.log`），会被误判为非当前文件。
  - 缓解：当前 base_name `llm-wiki.log` 不含数字，工作正常；建议未来用正则匹配 `\.(\d+)\.log$` 后缀更稳健。

- **`get_log_level` 返回类型窄化** —— 来源：Task 9
  - 现状：后端 `get_log_level` 返回裸 `String`，前端 `commands/logging.ts` 信任其为合法 `LogLevel` 联合类型。
  - 影响：若后端因 bug 返回 `"trace"` 或 `"TRACE"`（小写或非枚举值），前端类型系统不会捕获，运行时行为未定义。
  - 缓解：阶段 1 后端逻辑受控，不会返回非法值；建议未来在前后端边界加 zod/schema 校验。

- **`manager.rs` 移除了双 channel** —— 来源：Task 7
  - 现状：原计划「双 channel（normal + error）」因两个 appender 共享同一文件而无实际收益，已简化为单 channel。代码中保留了 `Clone for SizeBasedRollingFileAppender`（注释「用于双 channel」）。
  - 影响：无功能影响；`Clone` impl 成为 dead code（仅未来如恢复双 channel 时复用）。
  - 缓解：保留以备未来需求；或可在阶段 2 清理时删除。

### 3.3 测试债

- **Task 17 测试：`batchBuffer` 在测试失败时未清理** —— 来源：Task 17 / logging-integration.test.ts
  - 现状：`logging-integration.test.ts` 中若测试失败（断言抛错），`afterEach` 仍会运行但 module 级 `batchBuffer`（`logger.ts` 中的全局数组）可能残留条目，影响后续测试。
  - 影响：单测隔离性不完美；失败场景下可能连锁。
  - 缓解：当前所有测试均通过，未触发；建议未来在 `logger.ts` 暴露 `_resetForTesting()` 钩子或在 `afterEach` 中显式清空。

---

## 四、验证结论

**阶段 1 实现完成。**

- **核心逻辑**（Logger Facade、Log Router、级别控制、轮转算法、clear_logs 文件过滤）由自动化测试覆盖，已通过。
- **编译与类型检查**通过（日志系统范围内 0 错误）。
- **端到端桌面行为**（控制台实际输出、文件实际路径、UI 渲染、trace_id 全链路、10MB 实际触发轮转、设置实时生效）**待人工运行验证**。

子代理无法在无 GUI 环境运行 Tauri 桌面应用，因此本报告不对「实际运行效果」做任何虚假声明。所有「待人工」项目均给出了具体验证步骤，可直接照做。

**建议下一步**：在桌面环境执行「待人工运行验证」章节的所有项目，将结果回填至本文档（将 `[ ]` 改为 `[x]` 并注明验证日期与观察到的实际行为）。
