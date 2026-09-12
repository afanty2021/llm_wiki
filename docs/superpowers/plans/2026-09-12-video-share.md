# 实施计划：视频学习任务（主管对话式分享 → 指定教师 → 回执进周报）· 2026-09-12

> 用户拍板（2026-09-12）：①视频=媒体库已有视频；②教学校长=提升某企微用户为 admin，走企微对话式分享；③要求回执且进周报考核；④老师看完可与 lt-tutor 讨论内容；⑤手机/平板看 HEVC 即可，无需 h264 副本。

## 0. 现状调查结论（本计划的地基，全部已实锺）

| 现成件 | 事实 |
|---|---|
| 视频注册表 | `media_assets`（914 行）：slug、media_ref、playback_path、**transcript_page_path**（视频↔转录页一等关联，讨论闭环锚点） |
| 签名媒体链 | `GET /media/:slug?exp&sig`（MEDIA__SIGNING_KEY，30 天窗口，utils/media_sign.rs `sign_media_with_fp`）——**教师点链接免登录**，签名即凭证；t_page.rs 已在铸链 |
| 教师移动学习页 | `/s/:code` 永活短链 → 303 → `/t/:token` 计划页：signed media 内嵌 + [mm:ss] 跳转 + **seen/complete 回执投影**（单调幂等）+ 限流 + XSS 防线 |
| 计划创建 | `teacher_tutor_plan_create`：`wecom_userid`（system/cron 回合可指定目标教师）+ `items[].kind="media"`（target_ref=slug）+ period_key 幂等 + 返回 `/s/` link |
| 回执→事件 | `/t/:token/complete` → projection 单调幂等 → progress 事件流（周报读取的同一事件流） |
| 讨论素材 | 转录页在 wiki（`sources/transcripts/…`），llm_wiki_search/read_file 现成 |

**结论：本功能不是从零建，而是给既有计划/回执/移动页体系补「主管对话入口」薄层。**

## 1. 差距清单（要新建的全部东西）

- **G1 主管权限门**：wecom 教师会话身份被 identity.ts 锁定为会话者本人——校长（admin 角色）在**自己的会话里**无法为目标教师传 `wecom_userid`（会被 identity 锁拒绝）。需要：admin 角色调用者可越自我锁、以 args.wecom_userid 指定目标教师。
- **G2 视频检索**：校长说「分享 How to teach listening 第二讲」→ 需按人话标题找 media slug。media_assets 无 title 列；标题在转录页。需 media 模糊检索（slug/转录页标题联查）。
- **G3 主动通知**：plan_create 返回 link 给的是调用者（校长）；教师侧需被通知「校长分享了视频给你」。投递通道需 Hermes 侧调查（网关 ticker / 周报巡检 cron 的复用性）。
- **G4 周报考核段**：progress 事件流里已有 complete 事件，但周报内容需显式「学习任务完成度」考核段（SKILL 报告格式层）。
- **G5 讨论指引**：看完与 lt-tutor 讨论——能力已存在（搜索+读转录页），缺 SKILL 指引与 share 确认信息里带转录页路径。
- **G6 身份 ops**：把指定企微用户 `UPDATE team_members SET role='admin'`（部署时执行，待用户点名）。

## 2. 设计

### 2.1 角色越权门（G1，src-server + mcp-server）

- src-server 新端点 `GET /api/v1/projects/:id/members/role?username=wecom_XXX`（Bearer=TRAINING__ADMIN_TOKEN，返回 {role}）——只读一行 team_members，供 MCP 做角色门。
- identity.ts 扩展：`resolveIdentity` 现状=会话身份锁；新增**supervisor override 分支**——当 `args.wecom_userid` 与会话身份不符时，不再一律拒，而是查角色：调用者（会话身份）为 admin → 放行，identity_source 记 `"supervisor"`；非 admin → 现行为不变（照常拒，纵深保留）。
- 作用面：`teacher_tutor_plan_create` / `plan_list`（+ 新 G2 工具）。**其余 8 工具不开放 override**（record_ask/search 等仍是教师本人语义），白名单硬编码在 identity.ts。
- plan 语义不变：`origin:"chat"`、period_key 幂等键建议 `share-<yyyymmdd>` 形态；重复分享同视频→幂等返回既有计划（天然防重）。

### 2.2 视频检索（G2，src-server + mcp-server）

- src-server 新端点 `GET /api/v1/projects/:id/media/search?q=<关键词>&limit=5`（admin token）：`media_assets JOIN wiki_pages ON transcript_page_path` 按转录页 title/slug ILIKE 模糊，返回 `[{slug, title(转录页标题), transcript_page_path, duration_s}]`。
- MCP 新工具 `teacher_tutor_video_search`（只读，不限角色——搜视频无敏感面）：参数 `q`、可选 `limit`。plan_create 的 media target_ref 由本工具结果提供。

### 2.3 主管对话流（SKILL，双份热部署）

SKILL.md 新增「视频学习任务（主管）」流程：
1. 校长说分享意图 → `teacher_tutor_video_search` 找视频（≤5 候选让校长挑）；
2. 确认目标教师（说人名→对名册 wecom_userid，可多人=逐人各建一计划）；
3. `teacher_tutor_plan_create`（wecom_userid=目标教师、media items、period_key=`share-<日期>`）；
4. 回执确认 + **告知校长：链接已生成、教师将收到通知；完成情况将在周报可见**；
5. 教师侧追问「我的学习计划」→ `plan_list`（现状已支持）。

### 2.4 教师侧（SKILL + 现有件）

- 观看：点企微链接 → `/s/` → `/t/` 页 → 手机/平板原生播 HEVC（用户⑤拍板，无需转码）；
- 回执：`/t/` 页 complete 按钮 → 投影事件（现成，零开发）；
- 讨论：SKILL「视频讨论」指引——按计划项/转录页路径 `llm_wiki_read_file` 转录页 → 与教师讨论要点/设计迁移到课堂；
- 周报：G4——SKILL 周报格式加「学习任务」段：`plan_list` 的 active 计划 + items 完成计数（complete 投影），未完成列名单。

### 2.5 主动通知（G3，两案并列，实现期调查后定）

- **案 A（优先）**：Hermes 网关侧——查 ticker/投递链是否有「即时向指定 chat_id 推文本」的机制可被 src-server/MCP 触发（周报 cron 是定时批，ad-hoc 推送或需小改网关）。若网关可挂 webhook/队列，MCP plan_create 成功后触发推送「<校长>分享了学习视频《…》，点开学习：<s_link>」。
- **案 B（兜底，零网关改动）**：教师下次与 lt-tutor 任何交互时，回合前注入 pending 计划提示（identity/profile 层已有 continuity note 注入点，同款机制加一行「你有 N 个未完成学习任务」）；周报固定带任务段。
- **本计划先落 A 的调查结论再实施**；B 作为 A 不可行时的兜底且无论如何都做（双保险）。

## 3. 不做/边界

- 不做 h264 副本/转码（用户⑤拍板）；不做观看行为自动打点（回执=教师显式 complete，v2 可加心跳打点）；
- 不改 admin MCP（保持只读 posture）；
- 不做教师 web 登录问题（签名 URL 免登录，信任模型与 /t/ 相同）；
- 存量 plan/回执零迁移。

## 4. 实施切分（评审通过后执行序）

1. **T1 src-server**：role 查询端点 + media 检索端点（+单测）；迁移零（无新表——复用 learning_plans/learning_items/short_links）。
2. **T2 mcp-server**：identity.ts supervisor override（白名单工具面）+ `teacher_tutor_video_search` 工具 + plan_create 描述更新（主管用法）+ 测试；`npm run build`。
3. **T3 SKILL**：主管流程 + 教师讨论/我的计划指引 + 周报考核段（双份 cp 热部署）。
4. **T4 Hermes 调查**：G3 案 A 可行性（读 Hermes 投递链源码，出结论再定 A/B）。
5. **T5 ops**：用户点名校长 → 提升角色（一条 SQL，执行前备份 team_members 该行）。
6. **T6 端到端验收**：校长企微说分享 → 教师收通知（或 B 兜底注入）→ 手机打开看 → complete → 教师与 AI 讨论 → 周报出现完成度。

## 5. 风险与开放问题

- **Q1 通知时效**（G3）：案 A 需动网关则风险上移 Hermes 仓，评审时定夺；案 B 兜底必做。
- **Q2 校长是谁**：G6 待用户点名后执行；提升角色本身立即可逆（role 改回 member）。
- **Q3 越权面**：supervisor override 只白名单 plan_create/plan_list/video_search 三工具；identity.test.ts 补越权用例钉住「非 admin 传他人 userid 照拒」。
- **Q4 重复分享**：period_key 幂等已防重；同视频多人=多计划（每人一条，回执天然隔离），看板需求（校长看全员完成度）v1 用 admin 的 plan/progress 查询端点拼，独立看板页不做。
- **Q5 链接时效**：/s/ 短链永活、媒体签名 30 天窗口——学期级任务无碍；超 30 天未看的任务教师点开时 /t/ 页会现签新媒体链（现状机制，无需改）。

## 6. 规模评估

src-server 两小端点+测试、mcp-server 一工具+identity 扩展+测试、SKILL 三段、Hermes 调查报告一份——**中型偏薄**，无新表、无迁移、不动 admin MCP。
