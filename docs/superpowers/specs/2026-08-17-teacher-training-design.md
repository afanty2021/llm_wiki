# LT 教师培训系统改造设计（llm_wiki × Hermes × 企业微信）

**日期**: 2026-08-17
**版本**: v3（v2 经 5 路并行评审修订：CLI 写入通道、编码分桶、里程碑重排、API 闭合、refresh 旋转等 10 项，见 §12）
**状态**: 待用户审阅
**路径分类**: Architectural（多子系统，M0-M4 五个里程碑，约 4.5 周）

---

## 1. 背景与目标

把 llm_wiki（文档知识库）改造为面向 15 名老师的师训学习系统：

- 内容源：`~/Github/L T师训 2024-2025` + `~/Github/L T师训 2024-2025（HEVC）`（两目录合计约 1500 个媒体文件，含约 440 个仅存在于 HEVC 目录；权威清单由 M0 对账产出）
- 通道：Hermes agent（已接通企业微信：上游自带 callback 适配器，强制 SHA1 验签 + AES-CBC 解密 + corp_id 匹配；gateway 本机常驻）
- 老师体验：手机企微里问答 → 收到个性化学习清单 → 点链接看视频/文档 → 系统记录进度 → 定期收到推荐
- 部署：本机 Mac。**公网暴露经 cloudflared 隧道**（见 §6），不开放入站端口

**已确认的关键决策**：

| 决策点 | 结论 |
|---|---|
| 学习形态 | 问答 + 学习清单（无固定课程路径） |
| 转写策略 | 分批：先核心专栏跑通全链路，再夜间窗口扩全量 |
| 教师画像冷启动 | 首次对话 agent 自动问卷（onboarding_state 跟踪），之后行为累积 |
| 进度判定 | 落地页 view（beacon 确认，防企微预取污染）+ 对话/按钮确认完成 |
| 架构方案 | 数据底座在 src-server，智能编排在 Hermes 的 LLM |
| Agent 运行时 | Hermes；自定义工具经 **扩展既有 mcp-server 包** 提供（skill 本体是纯指令文档） |

## 2. 总体架构

```
┌─ 内容侧（管理员 + 夜间批处理）────────────────────────────┐
│ 两目录(LT主库 + HEVC) → M0对账脚本(权威manifest,          │
│   按ffprobe逐个分桶: 浏览器可播(H.264+AAC/MP4) vs 需转码)  │
│   → 转写CLI(凭证=svc-transcriber服务账号):                │
│     ffmpeg抽音频/按桶转码 → whisper.cpp批转写               │
│     (23:00-08:00窗口, SHA-256增量, JSONL断点续跑)           │
│   产物三路: ①transcript源文件落项目storage                  │
│             ②POST /pages 直存transcript页(自动嵌入)         │
│             ③POST /training/media-assets 注册媒体            │
│   摘要页: storage内源文件经现有ingest生成(零改动)            │
└─────────────────────────────────────────────────────────┘
┌─ 知识服务 src-server（本机 Postgres，绑定 127.0.0.1）─────┐
│ 现有: search/graph/pages/files API（零改动，team guard 生效）│
│ 新增: training 域(5表+API)、/t/:token 落地页(顶级路径)      │
│       /media/:media_id 签名URL(顶级路径, HMAC, 无路径直传)   │
└─────────────────────────────────────────────────────────┘
┌─ 通道侧 Hermes gateway（已接企微，验签在网关层完成）───────┐
│ 独立 profile(企微频道路由) + teacher-tutor MCP server:     │
│   持有 wecom_userid→refresh token 映射(凭证不进LLM上下文)   │
│   工具: kb_search/档案/清单/进度/issue_link/record_ask      │
│ SKILL.md 指令编排: 问卷/答疑/清单/确认; 周报cron             │
└─────────────────────────────────────────────────────────┘
┌─ 网络层（cloudflared tunnel，自动 TLS）───────────────────┐
│ api.xxx → 127.0.0.1:8080 (src-server)                     │
│ cb.xxx  → 127.0.0.1:8645 (hermes 企微回调, GET验签握手同源) │
└─────────────────────────────────────────────────────────┘
┌─ 老师侧（手机企微，零安装）──────────────────────────────┐
│ 问答 → 清单(带 /t/ 链接, 一链一清单) → 企微浏览器打开落地页  │
│ → beacon确认view → 播放/跳时间戳 → 按钮或对话确认完成        │
└─────────────────────────────────────────────────────────┘
```

**职责边界**：转写 CLI = 独立批处理，**经现有 REST API 写入**（storage 源文件、POST /pages、media-assets 注册），不直连 DB、不进 src-server 进程；src-server = 结构化数据 + CRUD + 内容分发，不含推荐算法；MCP server = 凭证持有 + API 封装；Hermes LLM = 全部对话智能。

**典型数据流**：
1. 老师提问 → Hermes profile 路由到 teacher-tutor → MCP server 按会话 wecom_userid 注入该老师凭证，kb_search 检索 + `POST /training/events(ask)` 记录主题 → LLM 带引用回答 → 选 3-5 项 → `POST /training/plans`（响应返回整单 `/t/:token` 链接）
2. 老师点链接 → 落地页验 token（渲染事务记 event）→ JS beacon 确认后置 viewed 投影 → 签名媒体 URL 播放
3. 老师点"标记完成"（`POST /t/:token/complete`）或回企微说"看完了"（MCP `mark_complete` → `POST /items/:id/complete`）→ 单调更新投影
4. 周五 09:00 cron（错过的调度醒来立即补跑一次，不 burst）：逐老师生成清单（period_key 幂等）→ 推送

## 3. 子项目 P0：转写摄取管线

**新增独立 Node CLI**（放 `tools/transcriber/`，TypeScript，复用仓库 vitest 基建）。

### 3.1 M0 内容对账（先于一切转写）
- 扫描两个目录（含 HEVC 目录——约 440 个文件仅存在于此；**排除 `__MACOSX`**），对每个媒体 ffprobe：存在性、容器、视频/音频编码、时长
- **分桶规则（两桶制，修正 v2 的三桶）**：
  - 桶 A「浏览器可播」：MP4 容器 + H.264 视频 + AAC 音频 → 播放直用
  - 桶 B「一律转码」：其余全部——hevc 源、VOB/MPEG-2（60 个）、mkv/avi/flv/wmv 及任何非 H.264 编码 → ffmpeg 转 H.264+AAC mp4 播放副本
- 产出权威 manifest（JSON）：文件清单、桶归属、播放副本需求、总时长（**区间估计约 250-360h**：主库约 253h + HEVC 独有约 90-110h；夜间窗口约 3-5 晚跑完，M0 定权威值）、两目录归一化重叠分析
- 少儿影像隐私标注字段（课堂实录类内容，落地页链接生命周期见 §4.2）
- v1 三处错误据此修正：mp3↔mp4 标题归一化同名对实测 **0 对**（去重只靠音频内容 SHA-256，收益待实测）；HEVC 目录**纳入**范围；首批专栏为**教学新知班级管理专栏**（36 个 mp4/mp3）

### 3.2 管线五段式
1. **扫描分类**（以 manifest 为准）：直收音频 mp3/m4a/wma；视频抽音频（全容器）；文档 pdf/pptx/docx/md 不走转写
2. **去重**：抽出的 16kHz mono wav 按 SHA-256 内容去重
3. **规范化与转码**：`ffmpeg -ac 1 -ar 16000` 抽音频；桶 B 视频额外产出 H.264+AAC mp4 播放副本
4. **转写**：**whisper.cpp（Metal）+ ggml large-v3-turbo 为主引擎**（PyTorch whisper 已升级 20250625 含 turbo，作 fallback）。**language 强制 zh**，`--prompt` 注入 LT 域词表。JSONL 作业状态（hash/状态/耗时），断点续跑，单文件重试 2 次后标 failed 不阻塞
5. **产物写入（三路，全经 REST，凭证见 §3.3）**：
   - **① 源文件落 storage**：transcript md 经现有 files 写入接口放进 LT 项目 storage——这是现有 ingest 的输入边界（`ingest_pipeline` 经 `storage.read_bytes` 读源文件，实测确认）
   - **② transcript 页直存**：`POST /pages`（type: transcript，完整转写稿含 `[mm:ss]`）——实测确认该端点创建即 `embed_page`，向量检索天然可用
   - **③ media_assets 注册**：`POST /api/v1/training/media-assets`（管理员服务 token，仅 CLI 调用），媒体绝对路径只进这张表
   - **摘要页**：storage 内 transcript 源文件经现有 ingest 触发（upload/ingest 流程，零改动），承担策展价值

### 3.3 CLI 凭证与批产控制
- **svc-transcriber 服务账号**：LT team Admin 角色的专用账号（注册关闭前由管理员手工创建，随机密码），CLI 本地加密存储其 refresh token，自行刷新（**注意 refresh 是一次性旋转**：每次刷新废旧发新，CLI 必须持久化每次返回的新 token；丢失不可恢复，只能管理员重置后重新配置）
- `--window 23:00-08:00` 夜间窗口；首批教学新知班级管理专栏；后续批次 config 顺序排产，M4 完成全量

## 4. 子项目 P1：src-server training 域

### 4.1 数据模型（migration `013_training.sql`）

```sql
media_assets        -- 媒体注册表（仅转写 CLI 经管理员服务 token 写入）
  id, slug UNIQUE, media_ref TEXT,      -- 本机绝对路径，只在本表出现
  playback_path TEXT NULL,              -- 桶B转码副本路径
  duration_s INT, codec TEXT, kind 'video'|'audio',
  chapters JSONB,                       -- [{start_s,end_s,label}]
  transcript_page_path TEXT,            -- wiki 页路径
  source_path TEXT,                     -- 项目 storage 内源文件路径
  created_at

teacher_profiles
  id, user_id UNIQUE FK, wecom_userid UNIQUE, display_name,
  subject TEXT, grade_levels JSONB, goals JSONB, interests JSONB,
  onboarding_state 'pending'|'surveyed' NOT NULL DEFAULT 'pending',
  created_at, updated_at

learning_plans
  id, user_id FK, title, reason TEXT, origin 'chat'|'weekly',
  period_key TEXT NULL,                 -- UNIQUE(user_id, origin, period_key) 周报幂等
  status 'active'|'archived', created_at

learning_items
  id, plan_id FK, kind 'wiki_page'|'media',
  target_ref TEXT,                      -- wiki 页路径 或 media_assets.slug（校验存在性，拒绝绝对路径）
  timecode_start_s INT NULL, timecode_end_s INT NULL,
  label TEXT, sort_order INT,
  status 'pending'|'viewed'|'completed', completed_at

learning_events    -- 事件流（源数据；items.status 为投影）
  id, user_id FK, item_id NULL FK,
  event_type 'view'|'seen'|'complete'|'ask'|'plan_created',
  payload JSONB, created_at             -- view=渲染(含预取噪声) seen=beacon确认
```

**投影一致性**：`seen`/`complete` 事件与 `UPDATE learning_items` 同事务；**单调守卫** `UPDATE ... WHERE id=$1 AND status <> 'completed'`；`rebuild_projection(user_id)` 从事件流重建。
**view 语义（防企微预取污染）**：落地页渲染事务只记 `view` 事件**不改投影**；页面 JS 加载后 beacon（`POST /t/:token/seen`）确认真实打开才置 viewed——企微生成链接卡片时的服务端预取无 JS，不产生 seen。interests 回写以 `complete`/`ask` 为主信号，`seen` 为弱信号。

### 4.2 API

**training 前缀（`/api/v1/training/*`）**：

| 端点 | 鉴权 | 说明 |
|---|---|---|
| `POST /media-assets` | 管理员服务 token | CLI 批量 upsert（by slug） |
| `POST /bind` | 管理员服务 token | {wecom_userid, display_name} → 合成 email `{wecom_userid}@wecom.local` + 随机不可登录密码 → 建 user + team_members 写入 LT team + 空 profile(pending) → 返回 (access, refresh)。**幂等**：wecom_userid 已存在 → 不重建，轮换 refresh 返回新 token（旧 refresh 立即失效） |
| `GET /overview` | 管理员服务 token | 15 人进度总览 JSON |
| `GET/PUT /profile` | 老师 access token | 问卷结果与 interests 回写 |
| `POST /events` | 老师 access token | **仅 event_type='ask'**（MCP record_ask 用；view/complete 走专用通道） |
| `POST /plans` | 老师 access token | 创建清单；响应返回整单 `/t/:token` 链接（token 绑 plan_id） |
| `GET /plans` `GET /plans/:id` | 老师 access token | 列出/查看 |
| `POST /plans/:id/link` | 老师 access token | 补签/重发整单 `/t/` 链接（issue_link 对齐 plan 粒度） |
| `POST /items/:id/complete` | 老师 access token | 对话通道完成（MCP mark_complete），同单调守卫 |
| `GET /progress` | 老师 access token | 个人汇总 |

**顶级路径（不在 training 前缀下）**：

| 端点 | 鉴权 | 说明 |
|---|---|---|
| `GET /t/:token` | /t/ token（typ=plan_link，绑 plan_id，TTL 默认 7 天） | 落地页 HTML；渲染事务记 view 事件 |
| `POST /t/:token/seen` | 同上 | beacon 确认 → 置 viewed 投影 |
| `POST /t/:token/complete` | 同上 | body {item_id}，服务端校验 item ∈ 该 plan |
| `GET /media/:media_id` | 签名 URL（HMAC, exp ≤12h） | Range 流式；按 ID 查 media_assets serve |

**凭证模型（三层，JWT 均带 `typ` 字段互不通用，`require_auth` 增加 typ 校验）**：
- `typ=access/refresh`：老师与服务账号凭证，仅 MCP server / CLI 进程持有。**refresh 为一次性旋转**（实测 auth.rs 事务内废旧发新），持有方必须持久化每次新 token；丢失 → 重 /bind（轮换语义）/ 重置服务账号
- `typ=plan_link`：落地页 token，一链一清单，TTL 7 天（未成年人影像短期化）；到期经 `/plans/:id/link` 重发
- `/media` 签名：落地页渲染时按 media_id 现签，`<video>` 与 Range 天然可用
- **管理员服务 token**：`TRAINING__ADMIN_TOKEN` 环境变量（32 字节随机 hex），axum middleware 常数时间比较（`subtle`），护 /media-assets、/bind、/overview。不复用 ADMIN_USERNAMES（那是 user 级白名单，仓库无全局 user role，实测确认）

**鉴权矩阵**（测试基准）：老师 token 可调 training 老师端点；plan_link token 只能 /t/ 三端点（拿它调 API → 拒）；签名 URL 只能 GET 对应 media_id；admin token 只能三个管理端点；交叉全拒。

### 4.3 落地页 `/t/:token`
- mobile-first（企微双内核真机调试：iOS WKWebView / 安卓 X5）
- media 项：`<video>/<audio>` + chapters 跳转 + transcript 阅读 + 摘要页侧栏；wiki_page 项只读渲染
- 加载 = view 事件（渲染事务）；beacon = seen；"标记完成"按钮 = `/t/:token/complete`
- token 过期 → 提示回企微（MCP issue_link 兜底）

### 4.4 时间戳检索口径（search 零改动的边界）
search 保持零改动：snippet 是命中锚点 ±80 字符（实测 `build_snippet`），`[mm:ss]` 不保证入窗。**时间戳定位在消费侧解析**：MCP server / 落地页拿命中 transcript 页全文，向前查找最近的 `[mm:ss]` 得到片段起点。M4 可选做 snippet 增强（命中窗口内补时间戳），非验收依赖。

### 4.5 team 拓扑
- 独立 "LT 师训" team + LT 项目；15 位老师仅 Member；svc-transcriber 为该 team Admin；管理员个人 team 物理隔离（files 对 Member 读写开放，实测确认）
- 回归测试：老师凭证访问个人 team 资源 → 403

## 5. 子项目 P2：Hermes 通道层

### 5.1 teacher-tutor MCP server（扩展现有包）
Hermes 的 skill 是纯指令文档（SKILL.md），自定义工具走 MCP。**不新建包：扩展现有 `mcp-server/`（llm-wiki-mcp-server）**，新增 training 工具组，复用其 api-client 与鉴权模式；测试随旧包 node --test 惯例：

```
kb_search(query) / get_profile / upsert_profile
create_plan(title, items) / list_plans
mark_complete(item_id)      -- POST /items/:id/complete
issue_link(plan_id)         -- POST /plans/:id/link
get_progress / record_ask   -- POST /events(ask)
```

**凭证持有**：MCP server 进程内维护 wecom_userid → (access, refresh) 加密映射，按会话注入，**每次刷新持久化新 refresh token**；`/bind` 由 MCP server 调用（管理员服务 token 只在其配置中）；凭证零进 LLM 上下文。

### 5.2 SKILL.md 对话编排（prompt，非状态机）
- 新用户（onboarding_state=pending）→ 问卷 3-4 问 → upsert_profile(surveyed) → 首个清单
- 答疑：kb_search 多查询 + record_ask → LLM 带引用回答 + 片段时间戳链接（§4.4 消费侧解析）
- 清单生成：profile + 当次问题 + 图谱邻居 → 挑 3-5 项 → create_plan → 回复整单链接
- 完成确认：对齐 list_plans → mark_complete

### 5.3 推荐信号与周报
- 冷启动：问卷画像；行为累积：ask 主题与 complete 内容类型为主（seen 弱信号）→ 回写 interests；图谱邻居；已完成与历史清单降权
- 周报 cron 每周五 09:00：逐老师无头编排 → `POST /plans(origin=weekly, period_key)` 幂等 → 推送含上周摘要。逐老师失败隔离；补跑语义已核实（醒来补跑一次，不 burst）

### 5.4 安全收敛（配置项，M2 定型）
- 企微频道经 gateway `profile_routing` 路由到独立 profile（独立 HERMES_HOME），该 profile 工具集只启用 MCP 工具 + 消息收发，shell/文件系统/web 不注册
- 企微验签依赖 gateway 现有三重校验（SHA1 + AES-CBC + corp_id，防 XXE/64KB 上限/MsgId 去重），设计侧仅要求 wecom 凭证保密

## 6. 网络暴露与部署安全

现状实测风险：src-server 监听 0.0.0.0:8080 明文 HTTP；`/auth/register` 无鉴权开放；docker-compose 把 Postgres(5433)/Redis(6380) 发布到所有网卡且无 restart 策略；dev JWT secret 已提交进 git 且能通过启动校验。

| 项 | 措施 | 里程碑 |
|---|---|---|
| 公网入口 | cloudflared tunnel 两条 hostname：api → src-server、cb → hermes 回调（8645，GET 验证握手同隧道）；自动 TLS，不开入站端口 | M2 |
| 监听收敛 | src-server host 改 127.0.0.1；hermes callback 显式绑 127.0.0.1（默认全接口） | M1 |
| 密钥轮换 | 新 JWT secret 经 `JWT__SECRET` 注入（config.rs 实测支持 `__` 分隔）；dev secret 失效化，视为已泄露 | M1 |
| 数据库 | compose 端口绑 127.0.0.1；全部容器 `restart: unless-stopped` | M1 |
| 注册关闭 | `auth.registration_enabled` 配置默认 false；**svc-transcriber 账号在关闭前创建**；之后 /bind 是唯一建号通道 | M1 |
| 常驻保活 | launchd KeepAlive：cloudflared、hermes gateway、src-server；Docker Desktop 自启 | M2 |
| 日志脱敏 | logging middleware 对 `/t/`、`/media` 路径与 query 脱敏（现状写全量 URI，实测确认） | M2 |
| 遗留鉴权缺口 | `/ingest/jobs/:id` 无鉴权（UUID 不可猜但纳入收敛）：加 admin token 或绑定项目鉴权 | M2 |

## 7. 错误处理

| 故障点 | 处理 |
|---|---|
| 单文件转写失败 | 重试 2 次 → 标 failed 不阻塞；可单独重跑 |
| 批处理中断 | JSONL 断点续跑；窗口结束自动暂停次日续 |
| 磁盘水位 | 低于 20GB 暂停并告警 |
| /t/ token 过期 | 页面提示回企微；issue_link 重发 |
| 老师/服务账号 refresh 丢失 | 检测 401 → 静默 refresh；refresh 也失效 → 老师：重 /bind（轮换）；CLI：管理员重置服务账号后重配 |
| hermes/src-server/隧道挂 | launchd KeepAlive；容器 restart 策略 |
| Mac 重启 | 全链路重启演练列 M3 验收 |
| 事件/投影漂移 | rebuild_projection(user_id) 对账 |

## 8. 测试策略

- **转写 CLI（vitest）**：分桶规则/去重/包装/断点状态机/refresh 持久化单测；1 个真实媒体端到端冒烟（命名遵循仓库 `*.real-llm.test.ts` 惯例）；M0 对账脚本确定性测试
- **src-server（cargo test，参照 auth_tests.rs 模式）**：training API CRUD；§4.2 **鉴权矩阵全交叉**（含 typ 混用、伪造 item_id、签名 URL 过期、个人 team → 403、/media 无路径直传、target_ref 绝对路径被拒）；投影单调守卫；period_key 幂等；**/media Range 请求单测**（206/断点/越界）；beacon 语义（view 不改投影、seen 才置 viewed）
- **MCP server（node --test，随旧包）**：工具单测（mock HTTP）+ 凭证注入测试（token 不出现在工具返回值/日志）
- **SKILL.md dry-run**：mock 工具返回的对话脚本验证编排
- **E2E**：管理员作第 16 人全流程——问卷 → 问答（ask 落库）→ 清单 → 点击（view+seen 落库、预取不产生 seen）→ 播放（Range + 时间戳）→ 完成（按钮与对话双通道）→ overview → 周报（period_key 去重）
- **企微真机**：iOS + 安卓双内核落地页调试

## 9. 里程碑（4.5 周）

| 里程碑 | 内容 | 验收标准 |
|---|---|---|
| **M0（0.5 天）** | 对账脚本 + 权威 manifest | 两目录全量 ffprobe（两桶分类/时长/重叠）；首批排产与总时长区间定值 |
| **M1（1 周）** | whisper.cpp 管线 + 首批专栏三路写入 + **media_assets 表 + /media/:id 签名 URL + /bind 最小版（含 TRAINING__ADMIN_TOKEN 机制与幂等）+ svc-transcriber 账号 + 安全基线（§6 中 M1 行）** | search 命中 transcript 页且 snippet 出自命中段落（时间戳由消费侧解析，§4.4）；企微浏览器 Range 播放 + 章节跳转；注册关闭后 /bind 可建测试账号；无对外明文端口 |
| **M2（1.5 周）** | 其余四表 + plans/events/complete API + /t/ 落地页（view/seen/complete 三端点 + beacon）+ MCP server 扩展（training 工具 + 凭证持有）+ SKILL.md 最小版 + 隧道 + 白名单 profile + 日志脱敏 + /ingest 鉴权收敛 | 企微端到端全流程（E2E 脚本）；鉴权矩阵全绿；落地页真机双内核；AGENTS.md/docs 同步 |
| **M3（1.5 周）** | 问卷编排、/overview、周报 cron（period_key、逐人隔离）、launchd 保活 | 3-5 人灰度一周；全链路重启演练（重启 Mac → 三服务+DB 自动恢复 → 老师无感）；AGENTS.md/docs 同步 |
| **M4（持续）** | 全量夜间窗口批处理（含桶 B 转码副本）+ 推荐迭代 + 15 人全员上线 | manifest 100% 转写；周报完成率可观测；可选 snippet 时间戳增强 |

## 10. 明确不做（YAGNI）

- 不做企微 OAuth（/bind 足够）
- 不做播放埋点与防作弊（seen/complete 双通道即可；beacon 是防预取污染而非埋点体系）
- 不做管理后台 UI（/overview 出 JSON）
- 不做多租户 / 权限层级（单一 LT 师训 team）
- 老师不能上传内容；不改造 Tauri 桌面端
- 不做独立推荐算法服务（编排归 Hermes LLM）
- 不自建企微验签（gateway 已有三重校验）
- 不改 search 服务端（时间戳消费侧解析；M4 可选增强）

## 11. 与仓库现状的对齐说明

| 设计声明 | 实测现状 | 处理 |
|---|---|---|
| 摘要页"零改动"走 ingest | ingest 经 storage.read_bytes 只吃项目内源文件 | transcript 源文件先落 storage 再触发 ingest |
| transcript 页可检索可嵌入 | 嵌入只在 ingest worker 与 pages CRUD 维护（pages.rs 实测 POST 即 embed） | 走 POST /pages，不直写 DB |
| search 零改动 | snippet = 命中锚点 ±80 字符，[mm:ss] 不保证入窗 | 验收降级 + §4.4 消费侧解析 |
| chat 零改动（v1 曾有 kb_answer） | /chat/stream 裸 LLM 直通；chat_sessions 才有 RAG，但面向前端多轮会话管理 | 不复用 chat_sessions（老师问答是无会话单轮，kb_search + LLM 编排更轻、引用可控） |
| 现有 API 直接给老师用 | 全部经 team_members JOIN，无记录 403 | /bind 写 team_members；team 拓扑明确 |
| /media 按路径 + Authorization | `<video>` 无法带 header；路径直传 = 任意文件读取 | media_id + 签名 URL；路径只进 media_assets |
| admin 鉴权复用 | require_admin 仅 ADMIN_USERNAMES 白名单（/logs 专用），无全局 user role | 新增 TRAINING__ADMIN_TOKEN 服务 token（常数时间比较） |

## 12. 修订记录

### v2 → v3（本轮，评审 10 项 ≥80 全部落实；5 项代码声明复核属实）
1. CLI 写入通道补全：三路 REST（storage 源文件 + POST /pages + media-assets 端点），svc-transcriber 服务账号，不直写 DB（嵌入与 ingest 边界实测确认）
2. 编码分桶改两桶：浏览器可播（H.264+AAC/MP4）vs 一律转码（hevc/VOB/MPEG-2/mkv 等全部），修复 v2 的 VOB 回归
3. search 零改动与 [mm:ss] 验收矛盾：验收降级为"命中 transcript 页"，时间戳改消费侧解析（§4.4）
4. 里程碑依赖重排：media_assets + /media + /bind 最小版 + 注册关闭提前进 M1
5. API/MCP 闭合：恢复受限 POST /events(仅 ask)；/plans/:id/link（plan 粒度）；新增 /items/:id/complete（对话通道）；/t/、/media 标注顶级路径
6. refresh 一次性旋转写明：持有方持久化新 token、丢失重 /bind；/bind 幂等 = 轮换 refresh
7. 时长改区间估计（约 250-360h，3-5 夜间窗口），M0 定权威
8. 企微预取防污染：view（渲染）/seen（beacon）分离，投影只认 seen；interests 以 complete/ask 为主
9. 管理员服务 token 承载机制：TRAINING__ADMIN_TOKEN + 常数时间比较 middleware
10. MCP 归属：扩展现有 mcp-server/（node --test），不新建包
11. 低于 80 分项一并落：/ingest/jobs/:id 鉴权收敛（M2）、Range 单测/auth_tests 参照/skill dry-run 恢复（§8）、测试命名遵循 *.real-llm.test.ts、里程碑加 AGENTS.md/docs 同步、§11 补不复用 chat_sessions 理由、typ 校验列实现项（§8 矩阵已含）

### v1 → v2（上一轮，22 项）
四条链路断点（落地页凭证/媒体鉴权/转写保理/team_members）、两条高危安全链（任意文件读取/个人库暴露）、网络暴露章（§6）、五处事实修正（whisper 20231117 无 turbo、去重 0 对、HEVC 纳入、首批专栏、__MACOSX）、凭证三层隔离、period_key 幂等、onboarding_state、投影单调守卫、时间线 4.5 周。

### 对历次评审的复测修正记录
- v2 轮：老师 token TTL 实为 access 300s / refresh 7d（评审架构 agent 报 3600s 有误，本轮评审已自纠）；首批专栏 36 个（评审称 44）；HEVC 独有 439 个（评审称约 258，归一化口径差异）
