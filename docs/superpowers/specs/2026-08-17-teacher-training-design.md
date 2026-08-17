# LT 教师培训系统改造设计（llm_wiki × Hermes × 企业微信）

**日期**: 2026-08-17
**版本**: v4（v3 评审修订：seen 粒度、project_id 来源、read_page 闭合、表拆分重排、409/覆盖防护等 9 项 + 7 项低分，见 §12）
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
| 进度判定 | 落地页 beacon 确认 view（页面级/项级双粒度）+ 对话/按钮确认完成 |
| 架构方案 | 数据底座在 src-server，智能编排在 Hermes 的 LLM |
| Agent 运行时 | Hermes；自定义工具经扩展既有 mcp-server 包提供（skill 本体是纯指令文档） |

## 2. 总体架构

```
┌─ 内容侧（管理员 + 夜间批处理）────────────────────────────┐
│ 两目录(LT主库 + HEVC) → M0对账脚本(权威manifest,          │
│   ffprobe逐个分桶: 浏览器可播 vs 一律转码[含wma])           │
│   → 转写CLI(凭证=svc-transcriber服务账号,                  │
│     PROJECT_ID=TRAINING__PROJECT_ID):                      │
│     ffmpeg抽音频/按桶转码 → whisper.cpp批转写               │
│     (23:00-08:00窗口, SHA-256增量, JSONL断点续跑)           │
│   产物: ①transcript源文件落storage ②POST /pages直存         │
│         transcripts/<slug>.md页(自动嵌入)                   │
│         ③media-assets注册(含chapters) ④ingest生成摘要页     │
│         ⑤transcripts/前缀页hash对账(防LLM生成页覆写)        │
└─────────────────────────────────────────────────────────┘
┌─ 知识服务 src-server（本机 Postgres，绑定 127.0.0.1）─────┐
│ 现有: search/graph/pages/files API（零改动，team guard 生效）│
│ 新增: training 域(5表+API)、/t/:token 落地页(顶级路径)      │
│       /media/:media_id 签名URL(顶级路径, HMAC, 无路径直传)   │
└─────────────────────────────────────────────────────────┘
┌─ 通道侧 Hermes gateway（已接企微，验签在网关层完成）───────┐
│ 独立 profile(企微频道路由) + teacher-tutor MCP server:     │
│   持有 wecom_userid→refresh token 映射(凭证不进LLM上下文)   │
│   工具: kb_search/read_page/档案/清单/进度/issue_link/      │
│         record_ask; 刷新single-flight                      │
│ SKILL.md 指令编排: 问卷/答疑/清单/确认; 周报cron             │
└─────────────────────────────────────────────────────────┘
┌─ 网络层（cloudflared tunnel，自动 TLS）───────────────────┐
│ api.xxx → 127.0.0.1:8080 (src-server)                     │
│ cb.xxx  → 127.0.0.1:8645 (hermes 企微回调, GET验签握手同源) │
└─────────────────────────────────────────────────────────┘
┌─ 老师侧（手机企微，零安装）──────────────────────────────┐
│ 问答 → 清单(带 /t/ 链接, 一链一清单) → 企微浏览器打开落地页  │
│ → beacon(页面级→清单打开; 项级→该项viewed) → 播放/跳时间戳   │
│ → 按钮或对话确认完成                                        │
└─────────────────────────────────────────────────────────┘
```

**职责边界**：转写 CLI = 独立批处理，经现有 REST API 写入，不直连 DB；src-server = 结构化数据 + CRUD + 内容分发；MCP server = 凭证持有 + API 封装；Hermes LLM = 全部对话智能。**单项目假设**：全部内容与检索固定在一个 LT 项目内，`TRAINING__PROJECT_ID` 环境变量统一供给（search 的 project_id 必填、pages/落地页渲染、CLI 写入共用，实测 search.rs 确认必填）。

**典型数据流**：
1. 老师提问 → MCP 按会话注入老师凭证，kb_search（带 PROJECT_ID）+ record_ask → LLM 带引用回答（read_page 取全文做时间戳解析）→ 选 3-5 项 → create_plan → 回复整单 `/t/` 链接
2. 老师点链接 → 落地页渲染（记 view 事件）→ 页面级 beacon（清单已打开）→ 点进某项 → 项级 beacon（该项 viewed）→ 签名 URL 播放
3. 完成双通道：按钮 `POST /t/:token/complete` / 对话 mark_complete → `POST /items/:id/complete`，单调守卫
4. 周五 cron：逐老师生成清单（period_key 幂等，plan_created 随创建事务写入）→ 推送

## 3. 子项目 P0：转写摄取管线

**新增独立 Node CLI**（放 `tools/transcriber/`，TypeScript，复用仓库 vitest 基建）。

### 3.1 M0 内容对账（先于一切转写）
- 扫描两目录（含 HEVC 独有约 440 个；排除 `__MACOSX`），ffprobe 逐个：容器/视频编码/音频编码/时长
- **分桶（两桶，含音频维度）**：
  - 桶 A「浏览器可播」：视频 = MP4 + H.264 + AAC；音频 = mp3/m4a → 直用
  - 桶 B「一律转码」：其余全部——hevc、VOB/MPEG-2（60 个）、mkv/avi/flv/wmv 内非 H.264、**wma（16 个，浏览器不可播音频）** → 视频 H.264+AAC mp4 副本，音频转 AAC/MP3 副本
- 权威 manifest：清单/桶归属/播放副本需求/总时长（**约 343-363h** = 主库 ~253h + HEVC 独有 ~90-110h；夜间窗口 4-6 晚）/归一化重叠
- 少儿影像隐私标注（链接生命周期见 §4.2）
- v1 事实修正存档：mp3↔mp4 归一化同名 0 对；HEVC 目录纳入；首批专栏 = 教学新知班级管理专栏（36 个）

### 3.2 管线五段式
1. **扫描分类**（以 manifest 为准）：直收音频；视频抽音频；文档不走转写
2. **去重**：16kHz mono wav SHA-256 内容去重
3. **规范化与转码**：ffmpeg 抽音频；桶 B 产出播放副本
4. **转写**：whisper.cpp（Metal）+ ggml large-v3-turbo 主引擎（PyTorch 20250625 含 turbo 作 fallback）；language 强制 zh；`--prompt` 注入 LT 域词表；JSONL 断点续跑，单文件重试 2 次
5. **产物写入（五步，全经 REST，凭证见 §3.3）**：
   - ① transcript 源文件落项目 storage（现有 ingest 输入边界）
   - ② **transcript 页**：`POST /pages`，path 确定性派生 **`transcripts/<slug>.md`**，type: transcript，含 `[mm:ss]`；创建即嵌入（实测确认）。**409 策略**（POST 对已存在 path 返回 Conflict，实测确认）：续跑先 GET——hash 一致跳过，不一致走 If-Match PUT 更新
   - ③ media-assets 注册：`POST /training/media-assets`，**含 chapters**（由转写时间戳行按 ~5 分钟窗聚合，label 取段首句截断 40 字）
   - ④ 摘要页：storage 源文件触发现有 ingest（零改动）
   - ⑤ **transcripts/ 对账**：摘要页 ingest 完成后校验 `transcripts/` 前缀页 hash 未被 LLM 生成页覆写（ingest upsert 是 ON CONFLICT DO UPDATE，path 由 LLM 输出决定，实测确认撞名即覆盖）；被改则重写并告警；实测撞名频发则 M2 升级为 ingest 运行时拒绝该前缀（列入风险跟踪）

### 3.3 CLI 凭证与批产控制
- **svc-transcriber 服务账号**（LT team Admin，注册关闭前手工创建）：CLI 加密存储其 refresh token 自行刷新（一次性旋转，每次持久化新 token）；media-assets 端点鉴权即 LT team Admin 角色 token，**CLI 不持 TRAINING__ADMIN_TOKEN**
- `TRAINING__PROJECT_ID`：CLI/MCP/落地页共用的单项目 ID
- `--window 23:00-08:00`；首批教学新知班级管理专栏；M4 全量

## 4. 子项目 P1：src-server training 域

### 4.1 数据模型（拆两个 migration）

**`013_training_core.sql`（M1）**：media_assets、teacher_profiles（/bind 依赖，随 M1 落地）

**`014_learning.sql`（M2）**：learning_plans、learning_items、learning_events

```sql
media_assets        -- 仅转写 CLI 经 LT team Admin 角色写入
  id, slug UNIQUE, media_ref TEXT,      -- 本机绝对路径，只在本表出现
  playback_path TEXT NULL, duration_s INT, codec TEXT,
  kind 'video'|'audio', chapters JSONB,
  transcript_page_path TEXT, source_path TEXT, created_at

teacher_profiles
  id, user_id UNIQUE FK, wecom_userid UNIQUE, display_name,
  subject TEXT, grade_levels JSONB, goals JSONB, interests JSONB,
  onboarding_state 'pending'|'surveyed' NOT NULL DEFAULT 'pending',
  created_at, updated_at

learning_plans
  id, user_id FK, title, reason TEXT, origin 'chat'|'weekly',
  period_key TEXT NULL,                 -- UNIQUE(user_id, origin, period_key)
  status 'active'|'archived', created_at

learning_items
  id, plan_id FK, kind 'wiki_page'|'media',
  target_ref TEXT,                      -- wiki 页路径 或 media_assets.slug（拒绝绝对路径）
  timecode_start_s INT NULL, timecode_end_s INT NULL,
  label TEXT, sort_order INT,
  status 'pending'|'viewed'|'completed', completed_at

learning_events
  id, user_id FK, item_id NULL FK,
  event_type 'view'|'seen'|'complete'|'ask'|'plan_created',
  payload JSONB, created_at
  -- plan_created 由 POST /plans 创建事务写入；view=渲染(含预取噪声)
```

**beacon 双粒度规则（写死）**：
- **页面级 beacon**（body 无 item_id）：记 plan 级 seen 事件（item_id NULL），**不改任何 item 投影**——语义是"清单被真实打开"（企微预取无 JS，不产生）
- **项级 beacon**（body 带 item_id，校验 ∈ 该 plan）：置该项 viewed（同事务单调更新）
- interests 归因只认 item 级事件（seen/complete）与 ask；rebuild_projection 只消费 item 级事件
- complete：与 `UPDATE ... WHERE id=$1 AND status <> 'completed'` 同事务（单调守卫）

### 4.2 API

**training 前缀（`/api/v1/training/*`，服务端统一注入 TRAINING__PROJECT_ID 对应项目上下文）**：

| 端点 | 鉴权 | 说明 |
|---|---|---|
| `POST /media-assets` | LT team Admin 角色（svc-transcriber） | CLI 批量 upsert（by slug） |
| `POST /bind` | 管理员服务 token | {wecom_userid, display_name} → 合成 email + 随机密码 → user + team_members（LT team；**不建 personal team**，与 register 行为分叉，有意为之）+ 空 profile(pending) → (access, refresh)。**幂等**：已存在 → 轮换 refresh 返回新 token |
| `GET /overview` | 管理员服务 token | 15 人进度总览 JSON |
| `GET/PUT /profile` | 老师 access token | 问卷与 interests 回写 |
| `POST /events` | 老师 access token | 仅 event_type='ask' |
| `POST /plans` | 老师 access token | 创建清单（事务内写 plan_created 事件）；响应返回整单 `/t/:token` 链接 |
| `GET /plans` `GET /plans/:id` | 老师 access token | **资源归属校验：plan.user_id == token 用户，否则 404** |
| `POST /plans/:id/link` | 老师 access token | 补签整单链接（同归属校验） |
| `POST /items/:id/complete` | 老师 access token | **归属链校验：item→plan.user_id == token 用户**（mark_complete 由 LLM 产出裸 id，防跨用户完成）；单调守卫 |
| `GET /progress` | 老师 access token | 个人汇总 |

**顶级路径**：

| 端点 | 鉴权 | 说明 |
|---|---|---|
| `GET /t/:token` | plan_link token（绑 plan_id，TTL 7 天） | 落地页 HTML；渲染事务记 view 事件 |
| `POST /t/:token/seen` | 同上 | beacon：body 可选 item_id（双粒度规则见 §4.1） |
| `POST /t/:token/complete` | 同上 | body {item_id}，校验 ∈ 该 plan |
| `GET /media/:media_id` | 签名 URL（HMAC, exp ≤12h） | Range 流式；按 ID 查 media_assets |

**资源归属规则（正文统一陈述）**：一切资源级端点强制 owner 链校验（plan→user、item→plan→user 与 token 用户一致），不一致按 404 处理；入 §8 鉴权矩阵测试。

**凭证模型（三层，JWT 带 `typ`，`require_auth` 增加 typ 校验）**：
- access/refresh（300s/7d，refresh 一次性旋转）：老师与服务账号持有，MCP/CLI 持久化每次新 refresh；MCP 并发刷新 **single-flight**（合并为单次，防旋转竞态丢 token）
- plan_link：一链一清单，TTL 7 天；到期 /plans/:id/link 重发
- /media 签名：渲染时现签，`<video>` 与 Range 天然可用
- 管理员服务 token：`TRAINING__ADMIN_TOKEN`（32B hex，常数时间比较），**仅护 /bind 与 /overview**

### 4.3 落地页 `/t/:token`（M2 交付）
- mobile-first（企微双内核真机调试）；media 项：播放器 + chapters 跳转 + transcript 阅读 + 摘要侧栏（wiki 正文/摘要均经 PROJECT_ID + pages API 读取）；wiki_page 项只读渲染
- 页面级 beacon（加载即发）+ 项级 beacon（进入项时发）；"标记完成"按钮
- token 过期 → 回企微提示（issue_link 兜底）

### 4.4 时间戳检索口径（search 零改动）
snippet = 命中锚点 ±80 字符，`[mm:ss]` 不保证入窗（实测）。**消费侧解析**：MCP `read_page(path)`（封装 `GET /projects/{pid}/page?path=`，实测返回全文）取 transcript 页全文，向前找最近 `[mm:ss]`。M4 可选 snippet 增强。

### 4.5 team 拓扑
独立 "LT 师训" team + LT 项目（即 TRAINING__PROJECT_ID 指向的项目）；15 位老师仅 Member；svc-transcriber 为该 team Admin；管理员个人 team 物理隔离（files 对 Member 读写开放，实测确认）。回归：老师凭证访问个人 team → 403。

## 5. 子项目 P2：Hermes 通道层

### 5.1 teacher-tutor MCP server（扩展现有 `mcp-server/` 包，node --test）
```
kb_search(query) / read_page(path)      -- search + GET page（时间戳解析用）
get_profile / upsert_profile
create_plan(title, items) / list_plans
mark_complete(item_id) / issue_link(plan_id)
get_progress / record_ask
```
凭证持有：wecom_userid → (access, refresh) 加密映射，按会话注入；**刷新 single-flight**；/bind 与管理员服务 token 只在 MCP 配置；凭证零进 LLM 上下文。

### 5.2 SKILL.md 对话编排（prompt，非状态机）
新用户（pending）→ 问卷 3-4 问 → upsert_profile(surveyed) → 首个清单；答疑 = kb_search 多查询 + record_ask + read_page 时间戳定位 → 带引用回答；清单生成 = profile + 问题 + 图谱邻居 → create_plan → 整单链接；完成确认 = 对齐 list_plans → mark_complete。

### 5.3 推荐信号与周报
冷启动问卷画像；行为累积 = ask 主题 + item 级 complete 内容（seen 弱信号）→ 回写 interests；图谱邻居；已完成/历史清单降权。周报周五 09:00 cron：逐人无头编排 → period_key 幂等 → 推送；逐人失败隔离；补跑语义已核实。

### 5.4 安全收敛（配置项，M2 定型）
企微频道经 `profile_routing` 路由到独立 profile（独立 HERMES_HOME），该 profile 只启用 MCP 工具 + 消息收发；验签依赖 gateway 现有三重校验，仅需 wecom 凭证保密。

## 6. 网络暴露与部署安全

| 项 | 措施 | 里程碑 |
|---|---|---|
| 公网入口 | cloudflared tunnel：api → src-server、cb → hermes 回调（8645，GET 验证握手同隧道）；自动 TLS，不开入站端口 | M2 |
| 监听收敛 | src-server host 改 127.0.0.1；hermes callback 显式绑 127.0.0.1 | M1 |
| 密钥轮换 | 新 JWT secret 经 `JWT__SECRET` 注入；dev secret 失效化，视为已泄露 | M1 |
| 数据库 | compose 端口绑 127.0.0.1；容器 `restart: unless-stopped` | M1 |
| 注册关闭 | `auth.registration_enabled` 默认 false；svc-transcriber 关闭前创建；此后 /bind 唯一建号 | M1 |
| 常驻保活 | launchd KeepAlive：cloudflared、hermes gateway、src-server；Docker Desktop 自启 | M2 |
| 日志脱敏 | /t/、/media 路径与 query 脱敏（现状写全量 URI） | M2 |
| 遗留鉴权缺口 | /ingest/jobs/:id 加鉴权（admin token 或项目绑定） | M2 |

## 7. 错误处理

| 故障点 | 处理 |
|---|---|
| 单文件转写失败 | 重试 2 次 → 标 failed 不阻塞；可重跑 |
| 批处理中断 | JSONL 断点续跑；窗口结束暂停次日续 |
| 磁盘水位 | 低于 20GB 暂停告警 |
| /t/ token 过期 | 回企微提示；issue_link 重发 |
| refresh 丢失 | 老师：重 /bind（轮换）；CLI：管理员重置服务账号 |
| POST /pages 409 | 确定性 path + GET 预检（hash 一致跳过 / If-Match 更新），见 §3.2-② |
| transcripts/ 页被覆写 | 事后 hash 对账重写 + 告警；频发则 M2 ingest 运行时拒绝该前缀 |
| embed 静默失败 | M1 验收含向量命中抽查（embed 失败仅 warn，防 keyword-only 退化不自知） |
| 服务挂/重启 | launchd KeepAlive + 容器 restart；重启演练 M3 验收 |
| 事件/投影漂移 | rebuild_projection（只消费 item 级事件） |

## 8. 测试策略

- **转写 CLI（vitest）**：分桶/去重/包装/断点状态机/refresh 持久化/409 预检策略单测；真实媒体端到端冒烟（`*.real-llm.test.ts` 惯例）；M0 对账确定性测试
- **src-server（cargo test，参照 auth_tests.rs）**：CRUD；**鉴权矩阵全交叉**（typ 混用、伪造 item_id、**跨用户资源归属（A 完成 B 的 item → 404）**、签名 URL 过期、个人 team → 403、/media 无路径直传、target_ref 绝对路径拒绝）；投影单调守卫；period_key 幂等；/media Range 单测（206/断点/越界）；**beacon 双粒度**（页面级不碰投影、项级置 viewed、预取无 seen）
- **MCP server（node --test）**：工具单测 + 凭证注入（token 不出现在返回值/日志）+ 刷新 single-flight 并发测试
- **SKILL.md dry-run**：mock 工具对话脚本
- **E2E 分层**：
  - **M2 版**（预置 surveyed profile）：问答 → 清单 → 点击（页面级/项级 beacon）→ 播放（Range+时间戳）→ 完成（按钮与对话双通道）→ progress 正确
  - **M3 版全量**：加问卷建档 → overview 汇总 → 周报（period_key 去重）→ 重启演练
- **企微真机**：iOS + 安卓双内核

## 9. 里程碑（4.5 周）

| 里程碑 | 内容 | 验收标准 |
|---|---|---|
| **M0（0.5 天）** | 对账脚本 + manifest | 两桶分类/时长（约 343-363h 定值）/重叠；首批排产 |
| **M1（1 周）** | whisper.cpp 管线 + 首批专栏五步写入 + **migration 013（media_assets + teacher_profiles）+ /media/:id 签名 URL + /bind 完整版 + svc-transcriber + 安全基线（§6 M1 行）** | search 命中 transcript 页（snippet 出自命中段落）+ **向量命中抽查**；**临时调试页/手工签 URL 演示 Range 播放**（落地页 M2 才有，章节跳转验收挪 M2）；注册关闭后 /bind 可建测试账号；无对外明文端口 |
| **M2（1.5 周）** | migration 014 + plans/events/complete API + /t/ 落地页（view/seen 双粒度/complete）+ MCP 扩展（含 read_page）+ SKILL.md 最小版 + 隧道 + 白名单 + 日志脱敏 + /ingest 收敛 | **M2 版 E2E** 全流程；鉴权矩阵全绿（含跨用户归属）；落地页真机双内核含章节跳转；AGENTS.md/docs 同步 |
| **M3（1.5 周）** | 问卷编排、/overview、周报 cron、launchd 保活 | 3-5 人灰度一周；**M3 版 E2E 全量**；重启演练；AGENTS.md/docs 同步 |
| **M4（持续）** | 全量夜间批处理（桶 B 转码副本）+ 推荐迭代 + 15 人上线 | manifest 100% 转写；周报完成率可观测；可选 snippet 增强 |

## 10. 明确不做（YAGNI）

不做企微 OAuth；不做播放埋点防作弊（beacon 是防预取污染）；不做管理 UI；不做多租户；老师不上传内容；不改造 Tauri 桌面端；不做独立推荐服务；不自建企微验签；不改 search 服务端（时间戳消费侧解析）。

## 11. 与仓库现状的对齐说明

| 设计声明 | 实测现状 | 处理 |
|---|---|---|
| 摘要页零改动走 ingest | ingest 经 storage.read_bytes 只吃项目内源文件 | transcript 源文件先落 storage |
| transcript 页可检索可嵌入 | POST /pages 创建即 embed（失败仅 warn） | 走 POST /pages；M1 验收加向量命中抽查 |
| search 零改动 | project_id 必填；snippet ±80 字符 | TRAINING__PROJECT_ID 单项目假设；时间戳消费侧解析 |
| ingest 零改动 | upsert ON CONFLICT DO UPDATE，path 由 LLM 决定 | transcripts/ 前缀 + 事后 hash 对账；频发则 M2 运行时拒绝 |
| chat 零改动 | /chat/stream 裸直通；chat_sessions 有 RAG 但面向前端多轮会话 | 不复用；kb_search + read_page + LLM 编排 |
| 现有 API 给老师用 | 全部 team_members JOIN | /bind 写 team_members；bind 用户不建 personal team |
| /media 按路径 + Authorization | `<video>` 无法带 header；路径直传 = 任意读 | media_id + 签名 URL |
| admin 鉴权 | require_admin 仅 ADMIN_USERNAMES（/logs 专用） | TRAINING__ADMIN_TOKEN（仅 /bind、/overview）；media-assets 走 LT Admin 角色 |

## 12. 修订记录

### v3 → v4（本轮 9 项 ≥80 + 7 项低分全落）
1. **beacon 双粒度规则写死**：页面级（无 item_id）只记 plan 级 seen 不碰投影；项级（带 item_id）置 viewed；interests/rebuild 只认 item 级事件
2. **project_id 来源**：单项目假设 + TRAINING__PROJECT_ID（search 必填实测确认；CLI/MCP/落地页共用）
3. **read_page(path) 工具补全**：时间戳消费侧解析的取全文环节闭合（GET page 全文实测确认）
4. **chapters 生产方 + M1 承载物**：chapters 由转写时间戳行聚合（§3.2-③）；M1 播放验收改临时调试页/手工签 URL，章节跳转挪 M2
5. **migration 拆分重排**：013（M1）= media_assets + teacher_profiles；014（M2）= plans/items/events——/bind 不再跨里程碑依赖
6. **E2E 分层**：M2 版（预置 profile 的核心链路）与 M3 版（问卷/overview/周报全量）
7. **资源归属校验入正文**：owner 链（plan→user、item→plan→user）不一致按 404；防 LLM 裸 item_id 跨用户完成
8. **POST /pages 409 策略**：确定性 path + GET 预检（hash 同跳过 / If-Match 更新）
9. **transcripts/ 覆写防护**：专用前缀 + 事后 hash 对账；频发升级运行时拒绝（风险跟踪）
10. 低分项：分桶补 wma；plan_created 写入方（创建事务）；时长区间修正 343-363h；MCP 刷新 single-flight；media-assets 鉴权改 LT Admin 角色（CLI 不持 admin token）；/bind 不建 personal team 注明；embed 静默失败入 M1 验收抽查

### v2 → v3（10 项）
CLI 写入三路 REST/svc-transcriber、编码两桶、search 零改动验收降级、里程碑重排、API 闭合（ask 事件/plan 级 link/items complete）、refresh 旋转语义、时长区间、view/seen 分离、TRAINING__ADMIN_TOKEN、MCP 扩展现有包。

### v1 → v2（22 项）
四条链路断点（落地页凭证/媒体鉴权/转写保真/team_members）、两条高危安全链（任意文件读/个人库暴露）、网络暴露章、五处事实修正、凭证三层隔离、period_key、onboarding_state、单调守卫、时间线 4.5 周。

### 对历次评审的复测修正记录
v2 轮：token TTL 实为 300s/7d（评审自纠）；首批专栏 36 个（评审称 44）；HEVC 独有 439（评审称约 258）。v3 轮：五项代码声明复核属实（POST /pages 即 embed、ingest 只吃 storage、snippet 锚点、refresh 旋转、ADMIN_USERNAMES/mcp-server 现状）。v4 轮：三项复核属实（search project_id 必填、GET page 返回全文、ingest ON CONFLICT 覆盖）。
