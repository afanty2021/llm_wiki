# 实施计划：视频学习任务（主管对话式分享 → 指定教师 → 回执进周报）· 2026-09-12

> 用户拍板（2026-09-12）：①视频=媒体库已有视频；②教学校长=提升某企微用户为 admin，走企微对话式分享；③要求回执且进周报考核；④老师看完可与 lt-tutor 讨论内容；⑤手机/平板看 HEVC 即可，无需 h264 副本。
> 修订（2026-09-15）：按 max 评审（[2026-09-15-video-share-plan-max-review.md](2026-09-15-video-share-plan-max-review.md)，verdict REVISE）修订——§2.1 period_key 作废+端点定形+安全三决策（C1/I2/I3）、§2.3 名册工具+查重步骤（I1/C1）、§2.5 案 B 改真零依赖形态（I5）、§5 Q3b 扩权清单（I4），并折叠 M1-M6 口径。评审断言已在本会话对源码逐条复核属实。快速复审（同日，独立评审 subagent，[2026-09-15-video-share-plan-quick-rereview.md](2026-09-15-video-share-plan-quick-rereview.md)）：13/14 核销通过、零 Critical；唯一 Important=roster_search 后端落实断层（I1 残留），已按复审处方补 §2.2 端点设计+限 admin 拍板，并折叠 Minor 三处（plan_list 描述更新、member-role 404 视同非 admin、media/search 无 project 过滤措辞）——按复审口径可进 T1。

## 0. 现状调查结论（本计划的地基，全部已实锺）

| 现成件 | 事实 |
|---|---|
| 视频注册表 | `media_assets`（914 行）：slug、media_ref、playback_path、**transcript_page_path**（视频↔转录页一等关联，讨论闭环锚点） |
| 签名媒体链 | `GET /media/:slug?exp&sig`（MEDIA__SIGNING_KEY，utils/media_sign.rs `sign_media_with_fp`；30 天=验签纵深上限 media.rs，/t/ 页落地**现签 12h 票据** t_page.rs:51）——**教师点链接免登录**，签名即凭证；t_page.rs 已在铸链 |
| 教师移动学习页 | `/s/:code` 永活短链 → 303 → `/t/:token` 计划页：signed media 内嵌 + [mm:ss] 跳转 + **seen/complete 回执投影**（单调幂等）+ 限流 + XSS 防线 |
| 计划创建 | `teacher_tutor_plan_create`：`wecom_userid`（system/cron 回合可指定目标教师）+ `items[].kind="media"`（target_ref=slug）+ period_key 幂等 + 返回 `/s/` link |
| 回执→事件 | `/t/:token/complete` → projection 单调幂等 → progress 事件流（周报读取的同一事件流） |
| 讨论素材 | 转录页在 wiki（`sources/transcripts/…`），llm_wiki_search/read_file 现成 |

**结论：本功能不是从零建，而是给既有计划/回执/移动页体系补「主管对话入口」薄层。**

## 1. 差距清单（要新建的全部东西）

- **G1 主管权限门**：wecom 教师会话身份被 identity.ts 锁定为会话者本人——校长（admin 角色）在**自己的会话里**无法为目标教师传 `wecom_userid`（会被 identity 锁拒绝）。需要：admin 角色调用者可越自我锁、以 args.wecom_userid 指定目标教师。
- **G2 视频检索**：校长说「分享 How to teach listening 第二讲」→ 需按人话标题找 media slug。media_assets 无 title 列；标题在转录页。需 media 模糊检索（slug/转录页标题联查）。
- **G3 主动通知**：plan_create 返回 link 给的是调用者（校长）；教师侧需被通知「校长分享了视频给你」。评审 Pass 6 前置结论：Hermes weixin 适配器有 `send(chat_id, content)` 原语（weixin.py:1072）但**无对外暴露的纯文本推送端点**——案 A 需小改 Hermes 仓，T4 只答「在哪暴露、怎么鉴权」。
- **G7 名册检索（评审 I1 补，原差距清单漏项）**：校长说「分享给王老师」→ 需人名→wecom_userid 检索；lt-tutor MCP 面 13 工具均无名册能力（数据面 src-server overview 一步可达——api-client 已有 `trainingOverview(adminToken)`——但其 payload 为逐教师进度聚合，不适合作名册源，专端点见 §2.2）。且 supervisor 放行后凭证 miss 即自动 bind 建档（training.ts `refreshOrBind`→`trainingBind`）——模型猜错的 userid 会落一行脏教师档案。检索工具 + SKILL 禁猜规则是主管流硬前提。
- **G4 周报考核段**：progress 事件流里已有 complete 事件，但周报内容需显式「学习任务完成度」考核段（SKILL 报告格式层）。
- **G5 讨论指引**：看完与 lt-tutor 讨论——能力已存在（搜索+读转录页），缺 SKILL 指引与 share 确认信息里带转录页路径。
- **G6 身份 ops**：把指定企微用户 `UPDATE team_members SET role='admin'`（部署时执行，待用户点名）。

## 2. 设计

### 2.1 角色越权门（G1，src-server + mcp-server）

- src-server 新端点 `GET /api/v1/training/member-role?wecom_userid=<id>`（评审 I2 定形）：鉴权沿用 `require_training_admin`——**`x-training-admin-token` header**（与 bind/overview/media-assets 同款，training.rs:149-167，**非 Bearer**）；内部 `teacher_profiles WHERE lower(wecom_userid)=lower($1)` → `team_members WHERE team_id = TRAINING__PROJECT_ID→projects.team_id`（bind 同款两跳，training.rs:208-212）；返回 `{role}`，查无此人 404。**不收 username**——超长时合成规则截断（`wecom_<前30>_<sha256前8>`，training.rs:266-271），username 从 wecom_userid 拼不出。
- identity.ts **保持同步纯函数不动**（评审 I3）：新增纯判定入口 `resolveIdentityWithSupervision(meta, args, {toolName, isCallerAdmin})` 只做白名单+admin 标志的纯判定；**异步 role 查询由 training.ts 分发层注入执行**——identity.ts 不引入 HTTP 依赖，identity.test.ts 21 用例的零 IO 形态不倒退。
- **安全三决策（评审 I3，实施必守）**：① **fail-closed**——role 查询失败（网络/5xx/超时）按 IdentityMismatch 照拒，错误文案区分于普通 mismatch（运维可辨，身份硬闸不因 src-server 故障窗口归零）；**404（查无此人=会话者非本 team 成员）视同非 admin 照拒**，文案走「非 admin」语义而非「查询失败」（复审 Minor-2）；② **仅 mismatch 时查询**——正常教师流量零额外延迟，无需缓存；③ **白名单放分发层**——training.ts handler wrapper 判 `toolName ∈ {plan_create, plan_list, video_search}` 才走 supervision，**其余工具不开放 override**（record_ask/search 等仍是教师本人语义）。identity.test.ts 补两组用例：非 admin 传他人 userid 照拒；role 查询失败照拒。
- **plan 语义（评审 C1 改写）**：`origin:"chat"` **不传 period_key**——对齐 SKILL §5 流程 3 既有约定（周报才按周幂等、服务端自算）。防重不靠幂等键，交 §2.3 查重步骤。原 `period_key=share-<yyyymmdd>` 方案**作废**：`(user_id, origin, period_key)` 唯一索引（014:12）不含视频内容，同日分享不同视频会命中幂等冲突→原样返回旧计划、新 items 丢弃、200 无告警（training.rs:1140-1162）——主路径静默数据丢失。

### 2.2 检索工具（G2 视频检索 + G7 名册检索，src-server + mcp-server）

- src-server 新端点 `GET /api/v1/training/media/search?q=<关键词>&limit=5`（`x-training-admin-token`，与 member-role 同域同鉴权；media_assets 为全局表、**无 project 过滤维度**——013 全表无 project_id）：`media_assets LEFT JOIN wiki_pages ON transcript_page_path` 按转录页 title/slug ILIKE 模糊，返回 `[{slug, title, transcript_page_path, duration_s}]`；**title 用 `COALESCE(wiki_pages.title, media_assets.slug)` 回落**（评审 M3：transcript_page_path 可空，无转录页行 JOIN 不上、无标题）。
- MCP 新工具 `teacher_tutor_video_search`（只读，不限角色——搜视频无敏感面）：参数 `q`、可选 `limit`。plan_create 的 media target_ref 由本工具结果提供。
- src-server 新端点 `GET /api/v1/training/roster?q=<关键词>&limit=10`（复审 Important-1 定形）：`x-training-admin-token` 同款鉴权；`teacher_profiles` 按 display_name/wecom_userid ILIKE，**仅返回 `[{wecom_userid, display_name}]`**——不复用 overview（payload 为逐教师进度聚合，training.rs:465-471，透传即向调用会话暴露全员进度）。
- MCP 新工具 `teacher_tutor_roster_search`（**限 admin 会话**）：分发层对该工具一律先注入 role 查询判 isCallerAdmin，非 admin 按 IdentityMismatch 照拒（fail-closed 同款）；低频主管专用，不受 §2.1 决策②「仅 mismatch 才查」约束（该决策针对高频教师工具流量）。本工具**不入 override 白名单**——无 wecom_userid 身份参数，走的是另一道「工具级 admin 闸」。

### 2.3 主管对话流（SKILL，双份热部署）

SKILL.md 新增「视频学习任务（主管）」流程（评审 I1/C1/M2 修订后）：
1. 校长说分享意图 → `teacher_tutor_video_search` 找视频（≤5 候选让校长挑）；
2. 确认目标教师（可多人=逐人各建一计划）：**人名→wecom_userid 只准来自 `teacher_tutor_roster_search`（新 G7 工具）的返回**；名册查无此人 → 停、向校长说明，**绝不猜 userid**（猜错即被凭证层自动 bind 成脏档案，评审 I1）；
3. **查重**：对目标教师 `plan_list` 看近 7 天已推条目（同 SKILL §5 流程 3 第 0 步「防重复」同款），同视频已推 → 告知校长并确认是否重推（评审 C1：chat 计划无幂等键，防重靠此步）；
4. `teacher_tutor_plan_create`（wecom_userid=目标教师、media items、**不传 period_key**）；
5. 回执确认 + 告知校长：链接已生成；**通知话术按 §2.5 落定的通道如实表述**——案 A 未落地前不说「教师将收到通知」，改说「教师下次使用助手时会看到提醒；完成情况将在周报可见」；
6. 教师侧追问「我的学习计划」→ `plan_list`（现状已支持）。

**T3 必须同步改写 SKILL §0（评审 M2，否则 §0 直接拒绝主管流）**：§0 第 1 条「交互回合不传 wecom_userid」与第 3 条「以他人身份操作→礼貌拒绝」需加**主管例外**——会话身份为校长（admin）且工具在白名单时，允许并要求 args.wecom_userid 指定目标教师；§2 工具白名单计数同步更新（15→17：+video_search、+roster_search）。

### 2.4 教师侧（SKILL + 现有件）

- 观看：点企微链接 → `/s/` → `/t/` 页 → 手机/平板原生播 HEVC（用户⑤拍板，无需转码）；
- 回执：`/t/` 页 complete 按钮 → 投影事件（现成，零开发）；
- 讨论：SKILL「视频讨论」指引——按计划项/转录页路径 `llm_wiki_read_file` 转录页 → 与教师讨论要点/设计迁移到课堂；
- 周报：G4——SKILL 周报格式加「学习任务」段：`plan_list` 的 active 计划 + items 完成计数（complete 投影），未完成列名单。

### 2.5 主动通知（G3，两案并列，实现期调查后定）

- **案 A（优先）**：Hermes 网关侧——查 ticker/投递链是否有「即时向指定 chat_id 推文本」的机制可被 src-server/MCP 触发（周报 cron 是定时批，ad-hoc 推送或需小改网关）。若网关可挂 webhook/队列，MCP plan_create 成功后触发推送「<校长>分享了学习视频《…》，点开学习：<s_link>」。
- **案 B（兜底，真·零网关改动——评审 I5 改写）**：MCP 侧动作，全在本仓可控面——`teacher_tutor_plan_list` / `teacher_tutor_profile_get` 返回附带 pending 计划计数提示 + SKILL 指引「教师回合返回含 pending 提示 → 顺带告知有 N 个待学任务」；周报固定带任务段。原「identity/profile 层 continuity note 注入」方案**降级为需改 Hermes 仓**：注入点在网关 `session.py::build_channel_continuity_note`（仅 auto-reset 且有活动时触发，run_turn.py 拼装）——加提示 = 改 Hermes 仓 + 重启网关，与案 A 同级对待，不作为零依赖兜底。
- **本计划先落 A 的调查结论再实施**；B 作为 A 不可行时的兜底且无论如何都做（双保险）。

## 3. 不做/边界

- 不做 h264 副本/转码（用户⑤拍板）；不做观看行为自动打点（回执=教师显式 complete，v2 可加心跳打点）；
- 不改 admin MCP（保持只读 posture）；
- 不做教师 web 登录问题（签名 URL 免登录，信任模型与 /t/ 相同）；
- 存量 plan/回执零迁移。

## 4. 实施切分（评审通过后执行序）

1. **T1 src-server**：`member-role` 端点 + `training/media/search` 端点 + `training/roster` 端点 + 测试（含 member-role 404 非成员分支）——**测试形态=连 live PG 的集成测试**（docker 5433 生产库，AGENTS.md 硬约束 #2 / 评审 M6；只读 SELECT 风险低但执行者须知情）；迁移零（无新表——复用 learning_plans/learning_items/short_links）。
2. **T2 mcp-server**：identity 纯判定 `resolveIdentityWithSupervision` + training.ts 分发层白名单与注入式 role 查询 + `teacher_tutor_video_search` + `teacher_tutor_roster_search`（限 admin）工具 + **工具描述批量更新**（plan_create 主管用法 + plan_list 去「会话勿传 wecom_userid」冲突文案——复审 Minor-1）+ identity.test.ts 越权两用例；`npm run build` 后**须 Hermes 网关重启才生效**（硬约束 #4），重启避开周日 19:00 周报窗（硬约束 #7 / 评审 M4）。
3. **T3 SKILL**：主管流程（含 §0 第 1/3 条主管例外改写、白名单计数 15→17）+ 教师讨论/我的计划指引 + 周报考核段（双份 cp 热部署）。
4. **T4 Hermes 调查**：从评审 Pass 6 前置结论起步（`send(chat_id, content)` 原语已在 weixin.py:1072，无暴露端点），只答「在哪暴露（api_server 新路由 or 复用 /v1/runs）、怎么鉴权」，出结论再定 A/B。
5. **T5 ops**：用户点名校长 → 提升角色。定位链（评审 M5）：`TRAINING__PROJECT_ID → projects.team_id` → `teacher_profiles WHERE lower(wecom_userid)=…` 取 user_id → `UPDATE team_members SET role='admin' WHERE team_id=$team AND user_id=$uid`（执行前备份该行 ✓）。
6. **T6 端到端验收**：校长企微说分享 → 教师收通知（或 B 兜底提示）→ 手机打开看 → complete → 教师与 AI 讨论 → 周报出现完成度（不等下周日可手动 fire 周报 cron——Hermes `_execute_job_now` 一族，评审 M4）。

## 5. 风险与开放问题

- **Q1 通知时效**（G3）：案 A 需动网关则风险上移 Hermes 仓，评审时定夺；案 B 兜底必做。
- **Q2 校长是谁**：G6 待用户点名后执行；提升角色本身立即可逆（role 改回 member）。
- **Q3 越权面**：supervisor override 只白名单 plan_create/plan_list/video_search 三工具；fail-closed + 分发层白名单见 §2.1 三决策；identity.test.ts 补越权两用例（非 admin 照拒 + role 查询失败照拒）；roster_search 不入 override 白名单，另设工具级 admin 闸（一律判 isCallerAdmin，见 §2.2）。
- **Q3b 提升即扩权（评审 I4，显式接受）**：`team_members.role='admin'` 经 `role_meets`（project_guard.rs:14-19）同时解锁 src-server 12 处 Admin 门调用点——`files.rs:354` 删项目文件、`ingest.rs:96/110` 摄取取消/重试、`pages.rs:261` 删 wiki 页、`teams.rs:213` 改团队信息、`training.rs:74` media-assets 导入、`llm_providers.rs:42/91/129` + `search_providers.rs:38/78/105` provider CRUD×6。**接受理由**：校长 JWT 不出 MCP 主机（凭证库 `~/.llm-wiki-mcp/teachers.json` 600）、合成账号密码不可登录（training.rs:264-277）、校长可信、role 改回 member 即完全可逆。logs 等端点的 `require_admin` 走 `ADMIN_USERNAMES` 环境白名单、与 team_members.role 无关，不随提升解锁（本会话补核）。备选方案（teacher_profiles 加 `is_supervisor` 标志位，+1 列迁移破坏「迁移零」）不取。
- **Q4 重复分享**：chat 计划**无幂等键**（评审 C1 后语义）——防重=§2.3 第 3 步查重；同视频多人=多计划（每人一条，回执天然隔离），看板需求（校长看全员完成度）v1 用 admin 的 plan/progress 查询端点拼，独立看板页不做。
- **Q5 链接时效**：/s/ 短链永活；/t/ 页落地**现签 12h 媒体票据**（t_page.rs:51；media.rs 30 天仅为验签纵深上限，评审 M1）——学期级任务无碍，每次点开现签（现状机制，无需改）。

## 6. 规模评估

src-server 三端点+测试、mcp-server 两工具+identity 纯判定扩展+分发层+测试、SKILL 三段（含 §0 改写）、Hermes 调查报告一份（从评审 Pass 6 结论起步）、网关重启协调一次——**中型**（评审 Pass 8：原「偏薄」低估，已修正），无新表、无迁移、不动 admin MCP。
