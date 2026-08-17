# LT 教师培训系统改造设计（llm_wiki × Hermes × 企业微信）

**日期**: 2026-08-17
**状态**: 待用户审阅
**路径分类**: Architectural（多子系统，已分解为 4 个子项目、4 个里程碑）

---

## 1. 背景与目标

把 llm_wiki（文档知识库）改造为面向 15 名老师的师训学习系统：

- 内容源：`~/Github/L T师训 2024-2025`（1111 个媒体文件：699 mp3 / 401 mp4 / 60 VOB / 16 wma / 6 mov / 4 m4a；另 276 PDF、49 pptx、26 docx）+ 知识库已有的 pdf/md 文档
- 通道：Hermes agent（已接通企业微信，本机常驻 gateway）
- 老师体验：手机企微里问答 → 收到个性化学习清单 → 点链接看视频/文档 → 系统记录进度 → 定期收到推荐
- 部署：全部在本机 Mac（hermes gateway + llm_wiki src-server + Postgres + 转写批处理）

**已确认的关键决策**（brainstorming 问答结论）：

| 决策点 | 结论 |
|---|---|
| 学习形态 | 问答 + 学习清单（无固定课程路径） |
| 转写策略 | 分批：先核心专栏跑通全链路，再后台扩全量 |
| 教师画像冷启动 | 首次对话 agent 自动问卷（3-4 问），之后行为累积修正 |
| 进度判定 | 链接点击记"已查看" + 对话确认记"已完成"（不做播放埋点） |
| 架构方案 | 方案三：数据底座在 src-server，智能编排在 Hermes 的 LLM |
| Agent 运行时 | Hermes（pi 继续作为开发工具，不做老师侧运行时） |

## 2. 总体架构

```
┌─ 内容侧（管理员 + 后台批处理）───────────────────────────┐
│ LT师训目录 → 转写管线(独立 CLI) → 带时间戳 md → 现有两步摄取 │
│                                        → wiki + 向量 + 图谱  │
└─────────────────────────────────────────────────────────┘
┌─ 知识服务 src-server（本机 Postgres）────────────────────┐
│ 现有: search/chat/graph/pages API（零改动）+ web 前端托管   │
│ 新增: training 域(4 表 + API + /t/:token 落地页)           │
│       /media/* 带鉴权的媒体文件服务(Range 流式)             │
└─────────────────────────────────────────────────────────┘
┌─ 通道侧 Hermes gateway（已接企微）───────────────────────┐
│ teacher-tutor skill: 问卷建档/检索答疑/清单生成/进度确认    │
│ 周报 cron: 每周五逐人生成并推送学习清单                     │
│ 安全收敛: 专用 prompt + 工具白名单 + 服务 token             │
└─────────────────────────────────────────────────────────┘
┌─ 老师侧（手机企微，零安装）──────────────────────────────┐
│ 问答 → 清单(带 /t/ 链接) → 企微浏览器打开落地页 → 视频播放   │
│ + 时间戳跳转 + 点击记进度 → 回企微说"学完了" → 完成态        │
└─────────────────────────────────────────────────────────┘
```

**职责边界**：
- 转写管线 = 独立批处理 CLI，产出 md 文件，不进 src-server 进程
- src-server = 结构化数据 + CRUD + 内容分发，不含推荐算法
- Hermes skill = 全部对话智能（清单生成、推荐、进度确认），通过 REST API 读写服务端
- 三个单元可独立测试、独立替换（换 agent 通道不丢数据）

**典型数据流**：
1. 老师问"怎么设计课堂提问？" → Hermes skill 携该老师 JWT 调 src-server
2. skill 调 `search` 检索 → 回答（带引用）→ 选 3-5 项组成清单 → `POST /training/plans` → 回复附 `/t/:token` 链接
3. 老师点链接 → 落地页验 token → 记 `view` 事件 → 播放视频（可跳时间戳）
4. 老师回企微说"看完了" → agent 确认对应项 → 记 `complete` 事件，item 状态更新
5. 每周五 09:00 cron：无头跑推荐编排 → `POST /plans`(origin=weekly) → 逐人企微推送

## 3. 子项目 P0：转写摄取管线

**新增独立 Node CLI**（放 `tools/transcriber/`，TypeScript，复用仓库 vitest 基建），五段式：

### 3.1 扫描与分类
- 遍历 LT 目录（**排除 `L T师训 2024-2025（HEVC）` 副本目录**），按扩展名分类：
  - 直收音频：mp3 / m4a / wma
  - 视频抽音频：mp4 / mov / vob / mkv / avi / flv / wmv / m4v
  - 文档（不走转写，走现有摄取）：pdf / pptx / docx / md
- 批次控制：config 文件指定首批专栏目录（建议"独立教师教学力专栏"，约 40 个视频）

### 3.2 去重
- 文件名归一化（去编号前缀、空格、全半角、扩展名）后匹配同名 audio/video 对 → 共享一份转写稿（LT 课程常见"视频 + 音频版"配套，预计省近半转写量）
- 转写状态按媒体内容 SHA-256 做增量：已转写的文件自动跳过（与现有 ingest-cache 同思路）

### 3.3 音频规范化
- `ffmpeg -ac 1 -ar 16000` 统一转 mono 16kHz wav（whisper 标准输入）
- VOB 额外产出 H.264 mp4 播放副本（企微内置浏览器对 VOB 无播放能力）

### 3.4 转写
- 引擎：本机已装 openai-whisper（PyTorch/MPS），**model = large-v3-turbo**（arm64 上约 4-8× 实时，质量接近 large-v3）
- **language 强制 zh**（LT 为中文授课夹英文术语，auto-detect 在 code-switching 上不稳定；zh 模式可正常转出英文词）
- `initial_prompt` 注入 LT 域词表（师训、自然拼读、独立教师、双减等），降低专有名词错误率
- 升级路径：若 turbo 在本机仍过慢 → 换 whisper.cpp（量化 large-v3，约 2-4× 实时），管线接口不变（输入 wav，输出 SRT + JSON）
- 作业管理：JSONL 状态文件（文件 hash / 状态 pending|running|done|failed / 耗时），支持断点续跑；单文件失败重试 2 次后标 failed，不阻塞队列，可单独重跑

### 3.5 产物包装与入库
- 每个媒体产出 `<slug>.md`：frontmatter（title、源文件路径、`media_ref`、时长、语言）+ 正文按 ~5 分钟窗口聚合，每段以 `[mm:ss]` 时间戳开头
- md 放入 wiki 项目 sources 目录 → **现有两步摄取零改动**接手（分析 → 生成 wiki 页 + 向量 + 图谱）
- `media_ref`（源媒体绝对路径）随 frontmatter 进 wiki 页 `sources` 元数据，落地页据此定位播放文件

## 4. 子项目 P1：src-server training 域

### 4.1 数据模型（migration `013_training.sql`）

```sql
teacher_profiles   -- 老师档案（1:1 user）
  id, user_id UNIQUE FK, wecom_userid UNIQUE, display_name,
  subject TEXT, grade_levels JSONB, goals JSONB, interests JSONB,
  created_at, updated_at

learning_plans     -- 学习清单（一次对话或一次周报生成）
  id, user_id FK, title, reason TEXT, origin 'chat'|'weekly',
  status 'active'|'archived', created_at

learning_items     -- 清单项
  id, plan_id FK, kind 'wiki_page'|'media',
  target_ref TEXT,          -- wiki 页路径 或 media_ref
  timecode_start_s INT NULL, label TEXT, sort_order INT,
  status 'pending'|'viewed'|'completed', completed_at

learning_events    -- 事件流（源数据；items.status 是投影）
  id, user_id FK, item_id NULL FK,
  event_type 'view'|'complete'|'ask'|'plan_created',
  payload JSONB, created_at
```

### 4.2 API（`/api/v1/training/*`）

| 端点 | 鉴权 | 说明 |
|---|---|---|
| `POST /bind` | 管理员服务 token | {wecom_userid, display_name} → 建/复用 user + profile → 返回该老师长期 JWT |
| `GET/PUT /profile` | 老师 JWT | 读写档案（问卷结果、interests 累积） |
| `POST /plans` | 老师 JWT | agent 创建清单 {title, reason, origin, items[]}，响应逐项返回 `/t/:token` 链接 |
| `GET /plans` `GET /plans/:id` | 老师 JWT | 列出/查看清单 |
| `POST /items/:id/link` | 老师 JWT | 为清单项补签 `/t/:token`（历史项重发链接用） |
| `POST /events` | 老师 JWT | 记 view/complete/ask 事件，更新 item 投影 |
| `GET /progress` | 老师 JWT | 个人进度汇总 |
| `GET /overview` | 管理员 token | 15 人进度总览（JSON，先不做 UI） |
| `GET /t/:token` | 短期 token | 落地页 HTML |

### 4.3 落地页 `/t/:token`
- token = 短期 JWT（user_id + item_id + exp，如 30 天），创建清单时由 `/plans` 响应逐项签发，历史项经 `POST /items/:id/link` 补签（skill 的 issue_link 工具封装此端点）
- media 项：HTML5 播放器（`<video>`/`<audio>`）+ 转写稿章节列表（点击跳时间戳）+ wiki 摘要侧栏
- wiki_page 项：渲染 wiki 页正文（只读）
- 页面加载即 `POST /events(view)`；页内"标记完成"按钮 = `POST /events(complete)`（与对话确认双通道，任一即可）
- token 过期 → 页面提示"回企微找助手重新获取链接"（老师 JWT 未过期时 agent 可随时重签）

### 4.4 媒体服务 `/media/*`
- 从 LT 目录 serve 已入库媒体：JWT 鉴权 + HTTP Range（流式拖动）
- 只 serve 出现在 learning_items / 已转写清单中的文件（不做整库开放）
- HEVC 兼容性：iOS/企微内置浏览器可播 HEVC，安卓不保证 → 入库时（M4 批次阶段）预转 H.264 副本；首批专栏直接用源 mp4（多为 H.264）

### 4.5 身份打通（15 人，不做 OAuth）
- 老师首次发消息 → skill 拿 wecom_userid → 调 `POST /bind`（管理员服务 token）→ 拿到老师 JWT
- JWT 由 skill 持久存储（wecom_userid → token 映射）；失效自动重新 bind
- 管理员服务 token 存 hermes 配置，仅用于 /bind 和 /overview

## 5. 子项目 P2：Hermes 技能层（含推荐与周报）

### 5.1 teacher-tutor skill
SKILL.md + 最小工具集（RPC 封装，agent 只见这些）：

```
kb_search(query) / kb_answer(question)     -- 调 src-server search/chat
get_profile / upsert_profile               -- 问卷与画像
create_plan(title, items) / list_plans     -- 清单
mark_complete(item_id) / get_progress      -- 进度
issue_link(item_id)                        -- 签发 /t/ token 链接
```

**对话编排（prompt 定义，非硬编码状态机）**：
- 新用户（无 profile）→ 问卷 3-4 问（学科 / 学段 / 最想提升的 2 件事）→ upsert_profile → 生成首个清单
- 答疑：kb_answer → 带来源引用回答 + 相关片段时间戳链接
- 清单生成：profile + 当次问题 → 多查询 kb_search → LLM 挑 3-5 项 → create_plan → 回复带 /t/ 链接
- 完成确认：老师 report → list_plans 对齐是哪项 → mark_complete

### 5.2 推荐信号（LLM 编排的输入，无独立算法服务）
- 冷启动：问卷画像（subject / grade_levels / goals）
- 行为累积：`ask` 事件主题、view/complete 的内容类型 → agent 定期回写 profile.interests
- 图谱邻居：search/graph API 的相邻页面（"学了 A 推相邻 B"，四信号相关性天然可用）
- 去重：已完成项与历史清单项降权（查 events + plans）

### 5.3 周报（hermes scheduled automations）
- 每周五 09:00 cron → 对每个有 profile 的老师无头跑清单编排 → `POST /plans(origin=weekly)` → 逐人企微推送
- 推送内容含上周完成情况摘要（get_progress）

### 5.4 安全收敛（上线前必做）
- 面向老师的通道使用独立实例/频道配置：system prompt 严格限定"LT 师训学习助手"角色
- 工具白名单：仅 skill 的 RPC 工具 + 消息收发；shell / 文件系统 / 任意 web 工具全部禁用
- 若 hermes 频道级工具限制能力不足 → 跑专用 hermes 实例（独立配置目录）只挂这一 skill

## 6. 错误处理

| 故障点 | 处理 |
|---|---|
| 单文件转写失败 | 重试 2 次 → 标 failed 不阻塞队列，可单独重跑；批处理日志落盘 |
| whisper 批处理中断 | JSONL 状态文件支持断点续跑（文件粒度） |
| 磁盘水位 | 转写前检查可用空间，低于阈值（如 20GB）暂停并告警 |
| 落地页 token 过期 | 页面提示回企微重新获取；agent 重签（老师 JWT 有效即可） |
| 老师 JWT 失效 | skill 检测 401 → 自动重新 /bind |
| hermes / src-server 挂 | macOS launchd 保活两个常驻进程 |
| 企微消息重试 | hermes gateway 现有机制，不另行设计 |

## 7. 测试策略

- **转写 CLI（vitest）**：扩展名分类、去重匹配、md 包装格式、断点状态机单测；1 个真实媒体文件端到端冒烟（含 ffmpeg/whisper 真实调用，标记 slow）
- **src-server（cargo test）**：training API CRUD、鉴权（老师 JWT / 管理员 token 越权测试）、/t/ token 签发与过期、/media Range 请求——复用现有 axum 测试基建（参照 auth_tests.rs）
- **skill**：对话脚本 dry-run（mock 工具返回）验证编排逻辑；自测企微号端到端
- **E2E 验收**：管理员作为第 16 个用户走全流程——问答 → 收清单 → 点击 → 播放 → 确认完成 → overview 可见进度 → 收到周报

## 8. 里程碑

| 里程碑 | 内容 | 验收标准 |
|---|---|---|
| **M1（第 1 周）** | 转写管线 + 首批专栏（~40 视频）入库 + `/media` 路由 | src-server search 能命中转写内容并返回片段时间戳；浏览器能流式播放 |
| **M2（第 2 周）** | training 四表 + API + /bind + 落地页；skill 最小版（答疑/清单/确认） | 企微端到端：问答 → 清单链接 → 点击记进度 → 对话确认完成 |
| **M3（第 3 周）** | 问卷建档、/overview、周报 cron、安全收敛审计 | 可交付 15 位老师试用；工具白名单验证通过 |
| **M4（持续后台）** | 全量 1111 文件转写 + HEVC→H.264 副本 + 推荐质量迭代 | 全部内容可检索；周报点击率/完成率可观测 |

## 9. 明确不做（YAGNI）

- 不做企微 OAuth（15 人，/bind 足够）
- 不做播放埋点与防作弊（链接点击 + 对话确认即可）
- 不做管理后台 UI（/overview 先出 JSON）
- 不做多租户 / 权限层级（一个 team，15 个 member）
- 老师不能上传内容（单向消费，内容由管理员 curate）
- 不改造 Tauri 桌面端（老师路径完全不经过桌面应用）
- 不做独立推荐算法服务（编排归 agent）
