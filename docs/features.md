← [CLAUDE.md](../CLAUDE.md)

## 🔑 关键特性

### 1. 两步链式摄取

- **Step 1 (Analysis)**: LLM 读取源文件 → 结构化分析
- **Step 2 (Generation)**: LLM 基于分析生成 wiki 文件
- **增强功能**:
  - SHA256 增量缓存（未变更文件自动跳过）
  - 持久化摄取队列（串行处理，崩溃恢复）
  - 文件夹导入（保留目录结构）
  - 自动嵌入（启用向量搜索时）
  - 源文件可追溯性

### 2. 知识图谱与社区检测

- **四信号相关性模型**: Direct link, Source overlap, Adamic-Adar, Type affinity
- **Louvain 算法**: 自动发现知识聚类，计算内聚度
- **交互式可视化**: 悬停高亮、缩放控制、位置缓存
- **图洞察**: 惊喜连接、知识缺口（孤立页面、稀疏社区、桥接节点）

### 3. 多阶段检索管道

- **Phase 1**: 分词搜索（英文单词分割 + 中文 CJK bigram，标题匹配 +10 分）
- **Phase 1.5**: 向量语义搜索（可选，OpenAI 兼容端点，LanceDB 存储）
- **Phase 2**: 图扩展（2-hop 遍历，衰减）
- **Phase 3**: 预算控制（4K-1M tokens，60/20/5/15 分配）
- **Phase 4**: 上下文组装（编号页面，引用格式 [1], [2]）

### 4. Deep Research

- **Web 搜索**: Tavily API，完整内容提取（无截断）
- **多查询**: 每个主题多个 LLM 优化的搜索查询
- **LLM 优化主题**: 从 Graph Insights 触发时，LLM 读取 overview.md + purpose.md
- **用户确认**: 可编辑的主题和搜索查询确认对话框
- **自动摄取**: 研究结果自动处理以提取实体/概念

### 5. Chrome Web Clipper

- **Mozilla Readability.js**: 准确的文章提取（去除广告、导航、侧边栏）
- **Turndown.js**: HTML → Markdown 转换（支持表格）
- **项目选择器**: 选择要剪辑的 wiki（支持多项目）
- **本地 HTTP API**: 端口 19827，扩展与应用通信
- **自动摄取**: 剪辑内容自动触发两步摄取管道
- **离线预览**: 应用未运行时显示提取的内容

### 6. 多格式文档支持

| 格式 | 提取方法 |
|------|---------|
| PDF | pdf-extract (Rust) + 文件缓存 |
| DOCX | docx-rs — 标题、粗体/斜体、列表、表格 → 结构化 Markdown |
| PPTX | ZIP + XML — 逐页提取，标题/列表结构 |
| XLSX/XLS/ODS | calamine — 正确的单元格类型，多表支持，Markdown 表格 |
| 图片 | 原生预览 (png, jpg, gif, webp, svg 等) |
| 视频/音频 | 内置播放器 |
| Web clips | Readability.js + Turndown.js → 清洁 Markdown |

### 7. 审核系统（异步人机协作）

- LLM 在摄取期间标记需要人工判断的项目
- **预定义操作类型**: Create Page, Deep Research, Skip
- **摄取时生成搜索查询**: LLM 为每个审核项预生成优化的 Web 搜索查询
- 用户方便时处理审核（不阻塞摄取）

### 8. 其他增强

- **i18n**: 英文 + 中文界面 (react-i18next)
- **设置持久化**: LLM provider、API key、模型、上下文大小、语言
- **Obsidian 兼容**: 自动生成 `.obsidian/` 目录
- **Markdown 渲染**: GFM 表格、代码块、wikilink 处理
- **多 provider LLM 支持**: OpenAI, Anthropic, Google, Ollama, MiniMax, Custom
- **15 分钟超时**: 长时间摄取操作不会过早失败
- **dataVersion 信号**: wiki 内容更改时自动刷新图和 UI
- **级联删除**: 智能清理相关 wiki 页面，保留共享实体

### 9. 日志系统

**阶段 1 — 基础设施**
- **前端 Logger Facade**: `src/lib/logger.ts`（批处理：50ms / 100 条双阈值 + 级别过滤 + IPC 发送）
- **前端类型定义**: `src/lib/logger-types.ts`（LogLevel / LogEntry / LogFileEntry / LogDisplayEntry / ReadLogResponse）
- **前端命令封装**: `src/commands/logging.ts`（7 个 Tauri 命令封装）
- **后端 Tracing Layer**: `src-tauri/src/logging/`（types / router / manager / mod / config / notify_layer 六文件）
  - 单 channel 架构（OnceLock<LogManager>，规避 unsafe）
  - 文件轮转：10MB + 保留 5 个历史文件，rotate 校验文件存在性
  - 双格式：开发控制台人类可读 fmt layer + 文件 JSON 格式
- **初始化时序**: 前端 `src/main.tsx::initLogger()` + 后端 `lib.rs` setup 钩子 `init_logging(app_data_dir, app_handle)`
- **eprintln! 迁移**: `panic_guard.rs` + 其他 Rust 文件 62 处 → tracing 宏

**阶段 2 — 请求追踪 + Error 通知**
- **trace 传播**: `invokeTraced`（`src/lib/invoke-traced.ts`）自动注入 trace_id；后端核心命令 `#[instrument]` 绑定 span（spawn_blocking 命令用 `Span::current().enter()` 跨线程）
- **Error 桌面通知**: `NotifyLayer`（自定义 tracing Layer）捕获所有 ERROR（前后端统一），经 `run_on_main_thread` 调度（macOS 主线程安全），10s 时间窗口去重，`strip_debug_quotes` 去除 Debug 引号
- **通知配置**: `error-notification-config.ts` 读写 app-state.json（默认开启），配置 UI 开关（手写 `Switch` 组件）
- **配置 UI**: `logging-config.tsx`（级别选项卡 + 错误通知开关，集成在 GeneralSection）

**阶段 3 批次 A — console 迁移 + 采样**
- **console 迁移**: 前端 202 处 `console.*` → Logger Facade（46 文件，module 名映射表统一）
- **采样器**: `shouldSampleAt` 纯函数 + `shouldSample` 薄包装（默认 Infinity 关闭，ERROR 免疫，1s 窗口）

**阶段 3 批次 B — read_log_file + 查看器**
- **read_log_file 命令**: 分页读取 JSONL（逻辑反序），后端过滤（级别/关键字大小写不敏感/trace_id 精确），module 字段后备链（span.module → target≠frontend → "(unknown)"），JSONL 异常行容忍
- **LogsSection 查看器**: `src/components/settings/sections/logs-section.tsx`（级别 toggle chip + 关键字搜索 + trace_id 过滤 + 分页 + ERROR 高亮，注册在 settings 导航）

**级别持久化**（阶段 2 补齐）
- `set_log_level` 写入 app-state.json；`init_logging` 启动恢复（重启不丢失，默认 WARN）

- **Tauri 命令** (7 个): `send_log` / `get_log_level` / `set_log_level` / `get_log_files` / `read_log_file` / `clear_logs` / `export_logs`
- **测试**: 前端 1415 + 后端 logging 35 个自动化测试全通过

