# LT 教师培训系统改造设计（llm_wiki × Hermes × 企业微信）

**日期**: 2026-08-17
**版本**: v2（按四份专项评审 + Hermes 源码核实修订，修订记录见 §12）
**状态**: 待用户审阅
**路径分类**: Architectural（多子系统，M0-M4 五个里程碑，约 4.5 周）

---

## 1. 背景与目标

把 llm_wiki（文档知识库）改造为面向 15 名老师的师训学习系统：

- 内容源：`~/Github/L T师训 2024-2025` + `~/Github/L T师训 2024-2025（HEVC）`（两目录合计约 1500 个媒体文件，含约 440 个仅存在于 HEVC 目录；权威清单由 M0 对账产出）+ 知识库已有 pdf/md 文档
- 通道：Hermes agent（已接通企业微信：上游自带 callback 适配器，强制 SHA1 验签 + AES-CBC 解密 + corp_id 匹配；gateway 本机常驻）
- 老师体验：手机企微里问答 → 收到个性化学习清单 → 点链接看视频/文档 → 系统记录进度 → 定期收到推荐
- 部署：本机 Mac。**公网暴露经 cloudflared 隧道**（见 §6），不开放入站端口

**已确认的关键决策**：

| 决策点 | 结论 |
|---|---|
| 学习形态 | 问答 + 学习清单（无固定课程路径） |
| 转写策略 | 分批：先核心专栏跑通全链路，再夜间窗口扩全量 |
| 教师画像冷启动 | 首次对话 agent 自动问卷（onboarding_state 跟踪），之后行为累积 |
| 进度判定 | 落地页服务端记"已查看" + 对话/按钮确认记"已完成" |
| 架构方案 | 数据底座在 src-server，智能编排在 Hermes 的 LLM |
| Agent 运行时 | Hermes；自定义工具经 MCP server 提供（skill 本体是纯指令文档） |

## 2. 总体架构

```
┌─ 内容侧（管理员 + 夜间批处理）────────────────────────────┐
│ 两目录(LT主库 + HEVC) → M0对账脚本(权威manifest)           │
│   → 转写CLI: ffmpeg抽音频/转码 → whisper.cpp批转写          │
│     (23:00-08:00窗口, SHA-256增量, JSONL断点续跑)           │
│   → ①transcript页直存wiki(保真含[mm:ss])                   │
│     ②现有两步摄取基于transcript生成摘要页(链路不变)          │
│     ③media_assets注册表(仅CLI可写)                         │
└─────────────────────────────────────────────────────────┘
┌─ 知识服务 src-server（本机 Postgres，绑定 127.0.0.1）─────┐
│ 现有: search/graph/pages API（零改动，team guard 生效）     │
│ 新增: training 域(5 表 + API + /t/:token 落地页)            │
│       /media/:media_id 签名URL(无路径直传, 无Authorization)  │
└─────────────────────────────────────────────────────────┘
┌─ 通道侧 Hermes gateway（已接企微，验签在网关层完成）───────┐
│ 独立 profile(企微频道路由) + teacher-tutor MCP server:     │
│   持有 wecom_userid→refresh token 映射(凭证不进LLM上下文)   │
│   工具: kb_search/档案/清单/进度/issue_link                 │
│ SKILL.md 指令编排: 问卷/答疑/清单/确认; 周报cron             │
└─────────────────────────────────────────────────────────┘
┌─ 网络层（cloudflared tunnel，自动 TLS）───────────────────┐
│ api.xxx → 127.0.0.1:8080 (src-server)                     │
│ cb.xxx  → 127.0.0.1:8645 (hermes 企微回调, GET验签握手同源) │
└─────────────────────────────────────────────────────────┘
┌─ 老师侧（手机企微，零安装）──────────────────────────────┐
│ 问答 → 清单(带 /t/ 链接, 一链一清单) → 企微浏览器打开落地页  │
│ → 服务端记view → 播放/跳时间戳 → 按钮"标记完成"或回企微确认  │
└─────────────────────────────────────────────────────────┘
```

**职责边界**：转写 CLI = 独立批处理（产出 wiki 页 + media_assets 行，不进 src-server 进程）；src-server = 结构化数据 + CRUD + 内容分发，不含推荐算法；MCP server = 凭证持有 + API 封装；Hermes LLM = 全部对话智能。单元间只经 REST/DB schema 交互，可独立测试、独立替换。

**典型数据流**：
1. 老师问"怎么设计课堂提问？" → Hermes profile 路由到 teacher-tutor profile → MCP server 按会话 wecom_userid 注入该老师凭证，调 src-server
2. kb_search 检索 → Hermes LLM 组织回答（引用来自检索结果）→ 选 3-5 项 → `POST /training/plans`（响应返回整单 `/t/:token` 链接）→ 回复
3. 老师点链接 → 落地页验 token（同事务记 view + 更新投影）→ 签名媒体 URL 播放（可跳时间戳）
4. 老师点"标记完成"或回企微说"看完了" → `POST /t/:token/complete`（item_id 校验属于该 plan）或 MCP mark_complete → 单调更新投影
5. 周五 09:00 cron（错过的调度醒来立即补跑一次，源码写明，不 burst）：逐老师生成清单（period_key 幂等）→ 推送

## 3. 子项目 P0：转写摄取管线

**新增独立 Node CLI**（放 `tools/transcriber/`，TypeScript，复用仓库 vitest 基建）。

### 3.1 M0 内容对账（先于一切转写）
- 扫描两个目录（含 HEVC 目录——约 440 个文件仅存在于此；**排除 `__MACOSX`**），对每个媒体 ffprobe：存在性、视频编码、时长
- 产出权威 manifest（JSON）：文件清单、编码分类（h264 直用 / hevc 需转码副本 / 纯音频）、总时长、两目录归一化重叠分析
- 少儿影像隐私标注字段（课堂实录类内容，落地页链接生命周期见 §4.2）
- v1 设计中的三处错误据此修正：mp3↔mp4 标题归一化同名对实测 **0 对**（去重只靠音频内容 SHA-256，收益待实测，不预设"省近半"）；HEVC 目录**纳入**范围（其 hevc 编码需转 H.264 播放副本，主库 mp4 实测已是 h264）；首批专栏改为**教学新知班级管理专栏**（36 个 mp4/mp3，v1 误选的"独立教师教学力专栏"仅 16 个）

### 3.2 管线五段式
1. **扫描分类**（以 manifest 为准）：直收音频 mp3/m4a/wma；视频抽音频 mp4/mov/vob/mkv/avi/flv/wmv/m4v；文档 pdf/pptx/docx/md 不走转写
2. **去重**：抽出的 16kHz mono wav 按 SHA-256 内容去重（视频与其音频版若同源则 wav 哈希一致，自动共享转写稿）
3. **音频规范化**：`ffmpeg -ac 1 -ar 16000`；hevc 视频额外产出 H.264 mp4 播放副本
4. **转写**：**whisper.cpp（Metal）+ ggml large-v3-turbo 为主引擎**（实测口径：全量约 253h 音频、14-18× 实时 → 纯计算约 18h，两个夜间窗口可完成）。v1 假设的 openai-whisper large-v3-turbo 不可用（本机为 20231117 版，无 turbo），仅作 fallback。**language 强制 zh**（中文授课夹英文，auto-detect 在 code-switching 不稳），`--prompt` 注入 LT 域词表。作业管理 JSONL（hash/状态/耗时），断点续跑，单文件重试 2 次后标 failed 不阻塞
5. **产物三路**：
   - **transcript 页直存 wiki**：完整转写稿带 `[mm:ss]` 时间戳，`type: transcript`，不经 LLM 改写——解决"两步摄取是 LLM 摘要式生成、sources 来自生成页 frontmatter"导致的保真断裂（ingest_pipeline.rs 实测如此）。transcript 页天然全文可检索、可 embed
   - **摘要页走现有两步摄取**：以 transcript 页为源生成（链路零改动），承担 Karpathy 式策展价值
   - **media_assets 注册**（见 §4.1）：媒体路径只进注册表，绝不进可由用户写入的 `target_ref`

### 3.3 批次与资源
- `--window 23:00-08:00` 夜间窗口（否则连续 1-2 天 GPU 拉满，与老师白天提问撞车）
- 首批：教学新知班级管理专栏；后续批次由 config 顺序排产，M4 完成全量

## 4. 子项目 P1：src-server training 域

### 4.1 数据模型（migration `013_training.sql`）

```sql
media_assets        -- 媒体注册表（仅转写 CLI 以管理员身份写入）
  id, slug UNIQUE, media_ref TEXT,      -- 本机绝对路径，只在本表出现
  playback_path TEXT NULL,              -- H.264 副本（hevc 源）
  duration_s INT, codec TEXT, kind 'video'|'audio',
  chapters JSONB,                       -- [{start_s,end_s,label}]，落地页章节跳转
  transcript_page_path TEXT, created_at

teacher_profiles
  id, user_id UNIQUE FK, wecom_userid UNIQUE, display_name,
  subject TEXT, grade_levels JSONB, goals JSONB, interests JSONB,
  onboarding_state 'pending'|'surveyed' NOT NULL DEFAULT 'pending',
  created_at, updated_at

learning_plans
  id, user_id FK, title, reason TEXT, origin 'chat'|'weekly',
  period_key TEXT NULL,                 -- 周报幂等键，如 '2026-W33'；UNIQUE(user_id, origin, period_key)
  status 'active'|'archived', created_at

learning_items
  id, plan_id FK,
  kind 'wiki_page'|'media',
  target_ref TEXT,                      -- wiki 页路径 或 media_assets.slug（校验存在性）
  timecode_start_s INT NULL, timecode_end_s INT NULL,
  label TEXT, sort_order INT,
  status 'pending'|'viewed'|'completed', completed_at

learning_events    -- 事件流（源数据；items.status 为投影，同事务更新）
  id, user_id FK, item_id NULL FK,
  event_type 'view'|'complete'|'ask'|'plan_created',
  payload JSONB, created_at
```

**投影一致性**：view/complete 事件与 `UPDATE learning_items` 同事务；**单调守卫** `UPDATE ... WHERE id=$1 AND status <> 'completed'`（completed 不回退）；提供 `rebuild_projection(user_id)` 从事件流重建（对账用）。

### 4.2 API（`/api/v1/training/*`）

| 端点 | 鉴权 | 说明 |
|---|---|---|
| `POST /bind` | 管理员服务 token（MCP server 持有） | {wecom_userid, display_name} → 合成 email `{wecom_userid}@wecom.local` + 随机不可登录密码 → 建 user + **team_members 写入 LT 师训 team** + 空 profile(onboarding_state=pending) → 返回 refresh token（现网 access TTL 300s/refresh 7d，MCP server 自行刷新，不改全局 TTL） |
| `GET/PUT /profile` | 老师 access token | 问卷结果与 interests 回写 |
| `POST /plans` | 老师 access token | 创建清单；**响应返回整单 `/t/:token` 链接（token 绑 plan_id）** |
| `GET /plans` `GET /plans/:id` | 老师 access token | 列出/查看 |
| `POST /items/:id/link` | 老师 access token | 补签/重发 `/t/` 链接（死链兜底） |
| `POST /t/:token/complete` | **/t/ token 本身** | body {item_id}，服务端校验 item ∈ token 的 plan；不接受任意 item |
| `GET /progress` | 老师 access token | 个人汇总 |
| `GET /overview` | 管理员 token | 15 人总览 JSON |
| `GET /t/:token` | /t/ token | 落地页 HTML；渲染时服务端同事务记 view 事件 |
| `GET /media/:media_id` | 签名 URL（HMAC, exp ≤12h） | Range 流式；**按 ID 查 media_assets serve，无路径参数** |

**凭证模型（三层隔离，JWT 均带 `typ` 字段互不通用）**：
- `typ=access/refresh`：现有老师账号凭证，仅 MCP server 进程持有（§5），不进浏览器、不进 LLM 上下文
- `typ=plan_link`：落地页 token，**绑 plan_id（一链一清单）**，TTL 默认 7 天（课堂录像含未成年人影像，短期化是唯一实质控制；到期经 `/items/:id/link` 重发）。企微聊天记录里滚动积累的是"本周清单"级链接而非逐项死链
- `/media` 签名：落地页渲染时按 media_id 现签（HMAC + exp），`<video>` 播放器和 Range 请求天然可用

**鉴权边界修正（相对 v1）**：v1"落地页 POST /events 带老师 JWT"自相矛盾——老师 JWT 从不进浏览器，落地页唯一持有的是 /t/ token。v2 修正为：view 由渲染事务直记；complete 走 `POST /t/:token/complete`。

### 4.3 落地页 `/t/:token`
- mobile-first（企微双内核真机调试：iOS WKWebView / 安卓 X5）
- media 项：`<video>/<audio>` + chapters 章节列表（点击跳 timecode）+ transcript 页阅读 + 摘要页侧栏
- wiki_page 项：只读渲染 wiki 正文
- 页面加载 = view 事件（服务端事务）；"标记完成"按钮 = `POST /t/:token/complete`
- token 过期 → 提示回企微要新链接（MCP issue_link 兜底）

### 4.4 team 拓扑（安全，相对 v1 新增明确约束）
- **独立 "LT 师训" team + 独立 LT 项目**；15 位老师仅为该 team Member
- 管理员个人 team / 个人项目与培训项目物理隔离；现有 files 读写对 Member 开放（实测），若共用 team 则老师可读管理员全部私人笔记并可写污染 wiki
- 回归测试：老师凭证访问个人 team 资源 → 403（§9）

## 5. 子项目 P2：Hermes 通道层

### 5.1 teacher-tutor MCP server（工具层）
Hermes 的 skill 是纯指令文档（agentskills.io SKILL.md），自定义工具的正道是 MCP server（config.yaml `mcp_servers`）。新写一个 MCP server，暴露：

```
kb_search(query)                    -- 调 search API（现有 /chat/stream 是裸 LLM 直通无检索，
                                    --  v1 的 kb_answer 撤销：回答由 Hermes LLM 基于 kb_search 结果编排）
get_profile / upsert_profile
create_plan(title, items) / list_plans
mark_complete(item_id) / get_progress
issue_link(plan_id)                 -- 调 /items/:id/link 重发
```

**凭证持有（防线前移）**：MCP server 进程内维护 wecom_userid → refresh token 映射（加密存储），工具调用按当前会话的 wecom_userid 注入 access token；`/bind` 由 MCP server 调用，管理员服务 token 同样只在 MCP server 配置里。**JWT 与服务 token 均不进 LLM 上下文、不进 agent 记忆**。

### 5.2 SKILL.md 对话编排（prompt，非状态机）
- 新用户（onboarding_state=pending）→ 问卷 3-4 问 → upsert_profile(state=surveyed) → 首个清单
- 答疑：kb_search 多查询 → LLM 带引用回答 + 片段时间戳链接
- 清单生成：profile + 当次问题 + 图谱邻居 → 挑 3-5 项 → create_plan → 回复整单链接
- 完成确认：对齐 list_plans → mark_complete

### 5.3 推荐信号与周报
- 冷启动：问卷画像；行为累积：ask 事件主题与 view/complete 内容类型 → 回写 interests；图谱邻居（search/graph API 四信号）；已完成与历史清单降权
- 周报 cron 每周五 09:00：逐老师无头编排 → `POST /plans(origin=weekly, period_key)` 幂等 → 推送含上周完成摘要。**逐老师失败隔离**（一人失败不中断整批）；cron 补跑语义已核实（错过不 burst、醒来补跑一次）

### 5.4 安全收敛（能力已核实为配置项，非开发项）
- 企微频道经 gateway `profile_routing` 路由到独立 profile（独立 HERMES_HOME：config/.env/skills/cron），**工具集按该 profile 配置只启用 MCP 工具 + 消息收发**（toolsets 开关），shell/文件系统/web 工具不注册
- ~~"若能力不足跑专用实例"fallback 删除~~（能力确认存在）
- 企微验签依赖 gateway 现有三重校验（SHA1 验签 + AES-CBC + corp_id，解密前防 XXE/限 64KB/MsgId 去重），设计侧仅要求 token/aes_key/corp_secret 保密
- v1 将白名单验证列 M3 末——降级为 M2 配置项（部署形态在 M2 定型，越晚返工越大）

## 6. 网络暴露与部署安全（v2 新增章，M1 基线 + M2 定型）

现状实测风险：src-server 监听 0.0.0.0:8080 明文 HTTP；`/auth/register` 无鉴权开放；docker-compose 把 Postgres(5433)/Redis(6380) 发布到所有网卡且**无 restart 策略**；dev JWT secret 已提交进 git 且能通过启动校验（黑名单不含它）。

| 项 | 措施 | 里程碑 |
|---|---|---|
| 公网入口 | cloudflared tunnel 两条 hostname：api → src-server、cb → hermes 回调（8645，企微 GET 验证握手走同一隧道）；自动 TLS，路由器不开入站端口 | M2 |
| 监听收敛 | src-server host 改 127.0.0.1（config 覆盖）；hermes callback 适配器显式绑 127.0.0.1（其默认全接口监听） | M1 |
| 密钥轮换 | 生成新 JWT secret 经环境变量注入（config.rs 支持 `JWT__SECRET`）；config/default.json 中的 dev secret 失效化；**已入库的 dev secret 视为泄露处理** | M1 |
| 数据库 | compose 端口绑 `127.0.0.1:5433:5432` / `127.0.0.1:6380:6379`；全部容器 `restart: unless-stopped` | M1 |
| 注册关闭 | 新增 `auth.registration_enabled` 配置（默认 false，true 时方可注册）；/bind 是唯一建账号通道 | M1 |
| 常驻保活 | launchd KeepAlive：cloudflared、hermes gateway、src-server；Docker Desktop 开机自启 | M2 |
| 日志脱敏 | logging middleware 对 `/t/`、`/media` 的路径与 query 脱敏（token/签名不落日志；实测现状写全量 URI） | M2 |

## 7. 错误处理

| 故障点 | 处理 |
|---|---|
| 单文件转写失败 | 重试 2 次 → 标 failed 不阻塞；可单独重跑 |
| 批处理中断 | JSONL 断点续跑（文件粒度）；窗口结束自动暂停次日续 |
| 磁盘水位 | 低于 20GB 暂停批处理并告警 |
| /t/ token 过期 | 页面提示回企微；MCP issue_link 重发 |
| 老师 token 失效 | MCP server 检测 401 → 静默 refresh → 失效则重 /bind |
| hermes/src-server/隧道挂 | launchd KeepAlive 三者；Postgres/Redis restart 策略 |
| Mac 重启 | 全链路重启演练列入 M3 验收（最高频生产故障） |
| 周报 cron 与关机冲突 | hermes 补跑语义（醒来补跑一次），无需额外设计 |
| 事件/投影漂移 | rebuild_projection(user_id) 对账 |

## 8. 测试策略

- **转写 CLI（vitest）**：分类/去重/包装/断点状态机单测；1 个真实媒体端到端冒烟（slow 标记）；M0 对账脚本对样例目录的确定性测试
- **src-server（cargo test）**：training API CRUD；鉴权矩阵——老师 token / 管理员 token / /t/ token / 签名 URL 四类凭证的**交叉越权**（含：伪造 item_id 的 complete 被拒、`typ` 混用 token 被拒、typ=plan_link 不能调 API、签名 URL 过期 403、**个人 team 资源 → 403 回归**、`/media` 无路径直传、`target_ref` 传绝对路径被拒）；投影单调守卫（complete→view 不回退）；period_key 幂等（同周重复创建被合并）
- **MCP server**：工具单测（mock HTTP）+ 凭证注入测试（token 不出现在任何工具返回值/日志）
- **E2E**：管理员作第 16 人全流程——问卷 → 问答 → 清单 → 点击（view 落库）→ 播放（Range + 时间戳）→ 完成（按钮与对话双通道）→ overview 可见 → 收到周报（period_key 去重）
- **企微真机**：iOS + 安卓双内核落地页调试

## 9. 里程碑（4.5 周）

| 里程碑 | 内容 | 验收标准 |
|---|---|---|
| **M0（0.5 天）** | 对账脚本 + 权威 manifest | 两目录全量 ffprobe 清单（存在性/编码/时长/重叠）；首批排产确认 |
| **M1（1 周）** | whisper.cpp 管线 + 首批专栏（教学新知班级管理，36 个）transcript 页直存 + media_assets + `/media/:id` 签名 URL + **安全基线**（§6 中 M1 行：监听收敛/密钥轮换/DB 绑定+restart/注册关闭） | search 命中转写全文并返回 `[mm:ss]` 片段；企微浏览器内 Range 流式播放 + 时间戳跳转；nmap 本机无对外明文端口 |
| **M2（1.5 周）** | training 五表 + API + /bind（team_members + 合成 email）+ /t/ 落地页（含服务端 view 事务）+ MCP server（凭证持有）+ SKILL.md 最小版 + 隧道 + 白名单 profile + 日志脱敏 | 企微端到端全流程（E2E 脚本）；越权矩阵全绿；落地页真机双内核通过 |
| **M3（1.5 周）** | 问卷编排、/overview、周报 cron（period_key、逐人隔离）、launchd 保活 | 3-5 人灰度试用一周；**全链路重启演练**（重启 Mac → 三服务+DB 自动恢复 → 老师无感） |
| **M4（持续）** | 全量夜间窗口批处理（含 HEVC→H.264 副本）+ 推荐迭代 + 15 人全员上线 | manifest 100% 转写；周报完成率可观测 |

## 10. 明确不做（YAGNI）

- 不做企微 OAuth（/bind 足够）
- 不做播放埋点与防作弊（view/complete 双通道即可）
- 不做管理后台 UI（/overview 出 JSON）
- 不做多租户 / 权限层级（单一 LT 师训 team + 管理员）
- 老师不能上传内容（单向消费）
- 不改造 Tauri 桌面端
- 不做独立推荐算法服务（编排归 Hermes LLM）
- 不自建企微验签（gateway 已有三重校验）

## 11. 与仓库现状的对齐说明（v2 修正的"零改动"声明）

| v1 声明 | 实测现状 | v2 处理 |
|---|---|---|
| 两步摄取零改动、media_ref 随 sources 入库 | sources 取自 LLM 生成页自身 frontmatter（ingest_pipeline.rs），转写全文与时间戳无保真指令；search 仅 80 字符页级摘要 | transcript 页直存 + 摘要页仍走原管线；chapters 入 media_assets |
| search/chat/graph/pages 零改动 | 全部经 project_guard 的 team_members JOIN，无记录一律 403 | /bind 写 team_members；team 拓扑明确 |
| "现有 API 零改动"含 chat | /chat/stream 是裸 LLM 直通（无检索无引用） | 撤销 kb_answer；RAG = kb_search + Hermes LLM 编排 |
| /media 按路径 + Authorization | `<video>` 无法带 header；路径直传 = 任意本机文件读取（safe_resolve 锚定 STORAGE_PATH 帮不上） | 按 media_id + 签名 URL；路径只进 media_assets |

## 12. 评审修订记录（v1 → v2）

**已核实并修复**：
1. 落地页凭证矛盾 → 渲染事务记 view + `POST /t/:token/complete`
2. /media 鉴权与播放器不兼容 → media_id + HMAC 签名 URL
3. 转写内容进不了检索层 → transcript 页直存 + media_assets
4. /bind 缺 team_members / users NOT NULL → 补写 + 合成 email
5. 任意文件读取面 → media_assets 注册表，target_ref 校验
6. 个人库暴露 → 独立 team 拓扑 + 403 回归
7. 网络暴露层缺失 → §6 全章（隧道/密钥/端口/注册/保活/脱敏）
8. whisper 事实 → whisper.cpp 主引擎（本机 openai-whisper 20231117 无 turbo，实测）
9. 去重事实 → 标题匹配 0 对（实测），改内容哈希，不预设收益
10. HEVC 目录 → 纳入范围，转码对象改为 hevc 源（实测编码）
11. 首批专栏 → 教学新知班级管理专栏（实测 36 个 mp4/mp3）
12. 文件口径 → M0 权威对账，扫描排除 __MACOSX（实测 30 个垃圾）
13. Postgres 无 restart 策略 → unless-stopped + 重启演练进 M3 验收
14. 批处理窗口 → --window 23:00-08:00
15. 凭证生命周期 → typ 隔离、plan 级 /t/ 链接、TTL 7 天、日志脱敏
16. kb_answer 错端点 → 撤销，kb_search + LLM 编排
17. 投影一致性 → 同事务 + 单调守卫 + rebuild
18. 周报幂等 → period_key + 逐人失败隔离
19. 冷启动问卷被 /bind 杀死 → onboarding_state
20. 工具白名单 → 配置项（profile_routing + toolsets 已核实），fallback 删除，M2 定型
21. JWT 暴露面 → MCP server 持有，/bind 与服务 token 不进 LLM 上下文
22. 时间线 → 4.5 周（M0 对账 + M2 放宽 + M3 灰度与重启演练）

**对评审的三处修正（复测）**：
- 老师 token TTL：实际 access 300s / refresh 7d（评审称 3600s）；结论不变，MCP server 持 refresh 自刷
- 首批专栏数量：教学新知班级管理专栏实测 36 个 mp4/mp3（评审称 44，口径差异留 M0 对账定论）
- 仅存于 HEVC 目录文件数：实测 439（按本人归一化规则；评审称约 258）——方向一致、精确值由 M0 manifest 定
