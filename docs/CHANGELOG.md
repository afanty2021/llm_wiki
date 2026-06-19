← [CLAUDE.md](../CLAUDE.md)

## 📋变更记录 (Changelog)

### 2026-06-15 - 日志系统阶段 2/3 完成 + 级别持久化
- ✅ **阶段 2 — 请求追踪传播 + Error 桌面通知**
  - 前端 `invokeTraced` 封装（`src/lib/invoke-traced.ts`，自动注入 UUID v4 trace_id，空串防御）
  - 后端核心命令 `#[instrument]`（fs/embedding/vectorstore，spawn_blocking 命令用 `Span::current().enter()` 跨线程传播）
  - Error 通知：`NotifyLayer`（自定义 tracing Layer）捕获所有 ERROR，经 `run_on_main_thread` 调度（macOS 主线程安全），10s 时间窗口去重，设置开关
  - 依赖：`tauri-plugin-notification` + 手写 `Switch` 组件（非 radix）
- ✅ **阶段 3 批次 A — console 迁移 + 采样**
  - 前端 202 处 `console.*` → Logger Facade（46 文件，唯一例外 main.tsx 的 initLogger catch）
  - 时间窗口采样器（`shouldSampleAt` 纯函数 + `shouldSample` 包装，默认 Infinity 关闭，ERROR 免疫）
- ✅ **阶段 3 批次 B — read_log_file 命令 + 应用内查看器**
  - `read_log_file` 命令（分页 JSONL 读取，逻辑反序，级别/关键字/trace_id 后端过滤）
  - `LogsSection` 查看器（设置新章节：级别 toggle chip + 关键字搜索 + trace_id 过滤 + 分页 + ERROR 高亮）
- ✅ **级别持久化**（补齐阶段 2 缺口）：`set_log_level` 写入 app-state.json，`init_logging` 启动恢复（重启不丢失）
- 📊 新增文件：logging/{config,notify_layer}.rs、invoke-traced.ts、error-notification-config.ts、logs-section.tsx、switch.tsx
- 🧪 测试：前端 1415 + 后端 logging 35 个测试全通过
- 📈 设计/计划/验证文档：`docs/superpowers/`（阶段 2 + 阶段 3 批次 A/B）

### 2026-06-14 - 日志系统阶段 1 实施
- ✅ 新增统一日志基础设施（前端 Logger Facade + 后端 tracing Layer）
- 📊 前端：`src/lib/logger.ts` + `logger-types.ts` + `src/commands/logging.ts`
- 📊 后端：`src-tauri/src/logging/`（types/router/manager/mod 四文件）
- 🔧 配置 UI：`logging-config.tsx` 集成在 GeneralSection
- 🔧 已迁移：62 处 `eprintln!` → tracing 宏（保留 fs.rs 测试 7 处）
- 🧪 测试覆盖：11 个自动化测试全通过（前端 7 + 后端 4）
- 📈 新增 `## 关键特性 / 9. 日志系统` 章节

### 2026-04-13 12:30 - 深度补捞完成
- ✅ 完成阶段 C 深度补捞，覆盖率从 95% 提升到 98%
- 📊 深度分析 118 个文件，35 个模块
- 🔧 完善核心算法文档（四信号相关性、Louvain、多阶段检索）
- 🎯 补充架构洞察（数据流、性能优化、错误处理）
- 📈 更新索引到最新状态

### 2026-04-13 - 初始化AI上下文文档
- ✅ 创建完整的 AI 上下文文档体系
- 📊 记录项目架构、技术栈和核心功能
- 🔧 提供开发指南和 AI 使用建议
- 🎯 明确模块职责和文件组织结构

