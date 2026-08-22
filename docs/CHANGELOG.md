← [CLAUDE.md](../CLAUDE.md)

## 📋变更记录 (Changelog)

### 2026-08-22 - LT 师训系统 M3（身份会话级绑定 + overview + 周报 cron + 技术债收敛）
- ✅ **身份会话级绑定（结构性根治 prompt 注入冒用）**：Hermes `_meta` 身份戳（tools/call 注入会话身份，agent 线程捕获 + strict 读取）+ mcp-server `resolveIdentity` 三态硬闸（用户模式/系统模式/两类硬拒 fail-closed，10 工具接闸，wecom_userid schema 放开可选）——三层 live 证实（meta 实弹/SKILL 4 拒/协议探针 S1-S3）
- ✅ **GET /api/v1/training/overview**：管理总览（require_training_admin 常量时间比较、三预聚合子查询、items_7d 周报口径）+ weekly `period_key` 服务端自算（ISO 周收口，杜绝 LLM 手算；400 含 expected_period_key 改口重试）
- ✅ **周五周报 cron**：SKILL 流程⑤（系统模式编排）+ per-teacher job（分钟 cksum(uid)%15 散列错峰 09:00-09:14，deliver wecom 单聊直推）+ `weekly-report-register.sh`（add/list/remove/fire）；幂等 live 三证；T9 实测 cron catch-up 单次补跑——补跑双通道语义回写 spec §5.3
- ✅ **技术债两批（r3 收编）**：items cap/409 文案/归档事件闸/非对象不缓存/beacon+/s/ 限流 429/registration fail-closed/withinWindow 含端/healthSrc 降级链路/重试收窄/PUBLIC_T_BASE 必填/回滚原子化/teardown SWEEPS
- 🔧 **T8 E2E 三热修**：SKILL 清单视频优先硬规则（39e42b69）/章节小数秒解析（0f7b542b）/read_file 404 改正常返回防 Hermes 熔断误伤（990eac2b）——安卓 OPPO PHJ110/Android 13 HEVC 原件直播成功（M4 转码退役依据）
- ✅ **计划外：wiki 中文化批次**（止血→577 页翻译 v2/v3→2 页污染根因修复（关 thinking）→全量审计 LLM 保真 4.87/流利 4.92→标题收口（英文 title 25 全为品牌）→23 页非 slug 收编，图 650→633）+ 恢复工具/收编工具 105 测试
- ✅ **计划外：upstream v0.6.10 试合并草稿**（merge-upstream-trial 05ac9031：40 冲突全解 + 8 处语义破损修复，三套测试绿，待正式合并）
- ✅ **T9 重启演练**：自愈链 9/9（reboot→容器 47s→launchd 全起→隧道/omlx/iogpu→inbound 15.5s 回复）+ cron catch-up 实测（停机盖过触发→起后 5s 自动补跑）
- 📄 **灰度 runbook**（`docs/superpowers/deploy/m3-gray-runbook.md`：3-5 教师加白/每日 5 分钟观察/一周退出判据/异常处置）
- 🧪 src-server lib 269 + integration 107/107 · mcp 54/54 · transcriber 130 · E2E v3 live 全绿（冷启动/对抗三连/鉴权矩阵/周报三连 fire）
- 📈 验收：`docs/superpowers/specs/m3-acceptance-2026-08-22.md`（计划外中文化与 upstream 试合并单列切割；偏差与遗留逐项披露）

### 2026-08-20 - LT 师训系统 M2（learning 域 + 企微通道 + 基础设施）
- ✅ **服务端 learning 域**：migration 014（plans/items/events + period_key 部分唯一）、JWT typ 隔离（access/plan_link 互斥）、training API（profile/events/progress/plans/link/complete + 事件投影：单调守卫/幂等/归属 404）
- ✅ **/t/ 教师落地页**：view 事件同事务、seen 双粒度 beacon（Option\<Json\> 空 body 兼容）、XSS 五字符转义先转义后 linkify、媒体签名 fingerprint 三段式（Rust/TS 双锁向量）、`playsinline` 三连（iOS 企微 WebView 必需）、**/s/ 短链**（303 现签跳转，根治 LLM 转发截断）
- ✅ **MCP teacher-tutor 工具组**：src-server 形态 10 工具、TeacherCredentialStore（600/原子写/single-flight/bind 自愈）、BASE_URL fail-fast
- ✅ **Hermes 企微通道**：lt-tutor profile（platform_toolsets 白名单）、owner keep-route 路由防劫持、SKILL.md 四流程 + 身份硬规则 + 对抗 dry-run、deploy.sh 四态（含字节级回滚）
- ✅ **基础设施**：/ingest 项目鉴权 + /t,/media,/s 日志脱敏、launchd 保活（src-server/cloudflared/omlx-8001/iogpu-42GB）、重启自愈链（Docker 登录项 + unless-stopped）
- ✅ **前置收编**：step1 max_tokens 32000 + usage/截断日志 + 解析失败自动重试（瞬态兜底）、transcripts/ 命名空间守卫、bind advisory lock、compose prod 真实可启动（try_parsing/with_list_parse_key）、夜窗重转 48/48 + ingest 48/48（首批全量）
- 🧪 cargo lib 242 + integration 98 · vitest 123 · mcp node --test 27 · E2E live 全链（iPhone 真机播放/完成投影/白名单拒绝/鉴权矩阵）
- 📈 验收：`docs/superpowers/specs/m2-acceptance-2026-08-20.md`（偏差与残余风险逐项披露）

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

