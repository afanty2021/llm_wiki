# 实施计划最大强度评审：视频学习任务（主管对话式分享 → 指定教师 → 回执进周报）

评审对象：`docs/superpowers/plans/2026-09-12-video-share.md`（commit 40a2df1e，89 行）
评审日期：2026-09-15 · 评审方式：requesting-code-review 流程，独立评审 subagent，max 级八项 pass 全跑；只读源码核查（llm_wiki 全仓 + Hermes-agent 仓只读轻探，未碰 live PG，未跑任何写库/构建/部署）。

## 结论

这份计划的差距识别能力和「复用既有件」的架构直觉是真实可信的：§0 地基断言七条中六条经源码逐条核实属实，G1 对 identity.ts 硬闸的阻断点判断精确到行。但计划有**两处核心流程断裂**：其一，§2.1/§2.3 指定的 `period_key=share-<yyyymmdd>` 幂等键形态，在「同教师同日分享**不同**视频」时会**静默吞掉第二个视频**（幂等冲突返回旧计划且不追加 items，200 OK 无任何错误信号）——这是主管流最自然的日常用法，按计划实施必产生数据丢失；其二，§2.3 第 2 步「说人名→对名册 wecom_userid」没有任何工具支撑，lt-tutor MCP 面上不存在教师名册检索，而 supervisor override 放行后凭证层会对任意拼错的 userid **自动 bind 建档**，缺口会被放大成脏数据。两处都指向计划文本本身需要修订，不是实施时能自行消化的。

**verdict：REVISE**（骨架健康，修订幅度集中在 §2.1/§2.3/§2.5 三处，修完可快速复审）

## 做得好的

- **§0 地基六条实测属实，且断言精度高**：
  - `media_assets.transcript_page_path` 列存在（`src-server/migrations/013_training_core.sql:11`），且与 `wiki_pages.path` 同构可直接等值 JOIN——这不是纸上推断，`t_page.rs:792-813` 已在生产代码里用同款等值匹配装载转录页正文（`wiki_paths.extend(media_rows.iter().filter_map(|r| r.4.clone()))` → `WHERE path = ANY($2)`）；
  - `/s/:code` → 303 → 现签 7d token → `/t/:token` 链路逐字属实（`src-server/src/routes/t_page.rs:624-655`，短码永活、plan 归属+active 门禁齐全）；
  - 教师点链接免登录（capability URL 信任模型）与「点开时现签」机制属实（`t_page.rs:843-861`，每次落地现签带 fp 绑定的媒体票据）；
  - `plan_create` 支持 `wecom_userid`（system/cron）+ `items[].kind="media"`（014 CHECK + MCP schema `mcp-server/src/training.ts:333`）+ 返回 `/s/` link（`src-server/src/routes/training.rs:1165-1177`）；
  - complete 事件确实进周报读取的同一数据面：`projection.rs:35-47` 每次 complete 写 `learning_events('complete')` + 单调投影，`get_progress`（`training.rs:718-749`）的 plans 计数与 recent_events（排除 play_progress、保留 complete）就是周报 `teacher_tutor_progress` 的数据源；
  - 「教师会话身份被 identity.ts 锁定」的 G1 判断精确：`mcp-server/src/identity.ts:73-79` mismatch 硬拒「no override, no retry」，确实是主管流唯一阻断点。
- **G2 前提正确**：media_assets 无 title 列（013 全表无 title），标题在转录页（`wiki_pages.title VARCHAR(255)`，001:97）；「视频优先」「media_slug 从转录页 frontmatter 取」的既有链路在 SKILL.md §5 已有先例。
- **白名单收口方向正确且与现状结构匹配**：13 个工具 handler 第一行全部是 `resolveIdentity`（`training.ts:730-1002`），只对 plan_create/plan_list/video_search 开 override 的窄面（「其余 8 个 src-server 工具」数得出来：profile_get/put、record_ask、item_complete、plan_link、progress、search、read_file）与 item_complete/plan_link 不开放的保守取向都合理。
- **§3 边界诚实**：「迁移零」核实成立——role 查询读 team_members（001:30-36），media search 读既有表，确无新表；「不改 admin MCP」核实成立——admin MCP 走 `TRAINING__ADMIN_TOKEN` 静态令牌（`mcp-server/src/admin.ts:11`），与 team_members.role 完全无关，提升校长不影响它。
- **Q4 看板拼法可行**：`get_overview`（`training.rs:471-506`）逐教师含 `items_7d.completed` 计数，admin 侧拼完成度确实够用。
- **Q5 的结论侥幸正确**（虽然口径有漂移，见 Minor-1）：「点开时现签」机制真实存在，学期级任务时效无忧。

## Issues

### Critical (Must Fix)

**C1 · `period_key=share-<yyyymmdd>` 幂等键形态在核心用例下静默丢失新视频**
- 位置：计划 §2.1 第 4 条（「period_key 幂等键建议 `share-<yyyymmdd>` 形态；重复分享同视频→幂等返回既有计划（天然防重）」）+ §2.3 第 3 步（「period_key=`share-<日期>`」）；对应源码 `src-server/migrations/014_learning.sql:12`（`UNIQUE INDEX (user_id, origin, period_key) WHERE period_key IS NOT NULL`）与 `src-server/src/routes/training.rs:1066-1162`。
- 问题：幂等键是 `(user_id, origin, period_key)` 三元组，**不含视频内容**。冲突分支的行为是「同事务回查既有 plan，原样返回（200）」——`training.rs:1140-1162`，返回的是**旧计划的旧 items 和旧 link，新 items 被丢弃，没有任何告警信号**。压测四种形态：
  - 同教师同日分享**不同**视频（主管流最日常的用法：上午推听力第二讲、下午推课堂管理）→ 第二次调用命中幂等冲突，返回第一个计划 → **第二个视频静默消失**。模型按 SKILL 流程把返回的 link 转告校长「已分享」，校长无从察觉 items 里没有新视频；教师永远看不到第二个视频，周报考核段也永远不含它。数据丢失 + 三方无感知。
  - 同视频同日重复分享 → 幂等返回旧计划（计划声称的「天然防重」，成立）。
  - 同视频不同日 → 新计划（语义合理，但主管流无防重指引会重复推）。
  - 多视频一次分享 → `items` 多条支持（`PLAN_ITEMS_MAX=50`，`training.rs:1028-1035`），成立。
- 为什么要紧：计划把「天然防重」当作设计优点写入 §2.1，并把它固化为 SKILL 指令（§2.3 第 3 步）。按计划实施后，这个缺陷会以正确行为的外貌存在于生产对话流中。另外它还与 SKILL 现状惯例**正面冲突**：`SKILL.md` §5 流程 3 第 2 步与 §7 流程 5 第 4 步均明确「**不传 period_key**（周报才按周幂等，服务端自算，不要自己推算周串）」——chat 回合的既有约定就是无幂等、防重靠 SKILL 第 0 步查重。计划引入 period_key 反而破坏了这个已经想清楚了的约定。
- 怎么改：主管流对齐现状惯例——`origin:"chat"` **不传 period_key**（幂等与重复推送风险交由 SKILL 主管流程的查重步骤处理，复用 §5 流程 3 第 0 步同款「先 plan_list 查近 7 天已推条目」），或在 20 字符上限内构造含 slug 的键（如 `sh-0915-<slug尾5>`，脆弱不推荐）。同时 §2.3 补防重步骤。计划 §2.1 第 4 条整条改写。

### Important (Should Fix)

**I1 · 主管流第 2 步「说人名→对名册 wecom_userid」无工具支撑，且与自动 bind 建档机制耦合会放大误建档**
- 位置：计划 §2.3 第 2 步；对应源码 `mcp-server/src/training.ts:141-151`（`refreshOrBind`：凭证 miss → `trainingBind(userid, adminToken)` 幂等建档）与 `trainingToolDefinitions()`（11 个工具全量核对，无任何名册/教师列表工具）。
- 问题：校长说「分享给王老师」，模型没有任何途径拿到王老师的 wecom_userid。数据在 `get_overview`（含 wecom_userid + display_name）里，但那是 **admin MCP**（`llm-wiki-admin`）的工具面，与 `llm-wiki-training` 是两个 server、两个挂载面。更糟的是：supervisor override 放行后，`callWithAccess(deps, 目标userid, ...)` 走 `store.getAccess` → 凭证 miss 即 `trainingBind` —— 模型**猜**出来的任何 userid（哪怕拼错）都会被自动 bind 成新教师档案（合成账号 + team_members 行）。名册缺口 + 自动建档 = 一个对话口误就落一行脏数据。
- 为什么要紧：这是主管五步流程的第 2 步，缺了它整条流程走不通；且它是 G1–G6 差距清单**漏项**——计划自称差距清单是「要新建的全部东西」，这一项必须补。
- 怎么改：T2 增加一个只读 `teacher_tutor_roster_search`（admin token 调 `/api/v1/training/overview` 或更窄的仅返回 `{wecom_userid, display_name}` 端点），SKILL 主管流程强制「userid 只能来自名册工具返回，名册查无此人→停并告知校长」，禁止猜 userid。

**I2 · §2.1 role 查询端点设计有三处口径漂移**
- 位置：计划 §2.1 第 1 条；对应源码 `src-server/src/routes/training.rs:149-167`（`require_training_admin` 读 `x-training-admin-token` header）、`training.rs:262-274`（username 合成规则）、`src-server/src/middleware/project_guard.rs:62-81`（role 查询是 team 维度）。
- 问题：(a) 计划写「Bearer=TRAINING__ADMIN_TOKEN」——现行 admin 鉴权是 **`x-training-admin-token` header**（bind/overview/media-assets 全走这个，`mcp-server/src/api-client.ts:532` 同款），不是 Bearer；(b) 计划用 `?username=wecom_XXX` 查询——bind 合成的 username 在 wecom_userid 超长（+6 > 50 chars）时是 `wecom_<前30字符>_<sha256前8hex>` 截断形态（`training.rs:266-271`），从 wecom_userid **拼不出** username，查询参数应直接收 `wecom_userid` 并 JOIN `teacher_profiles → users → team_members`；(c) team_members 的键是 `(team_id, user_id)`（001:30-36），role 是 team 维度属性，端点应先取 `TRAINING__PROJECT_ID → projects.team_id` 再查（bind 已有同款两跳先例 `training.rs:208-212`），`/projects/:id/members/role` 这个 URL 命名空间在现有路由树里也不存在。
- 为什么要紧：按计划字面实现端点会做出一个查不到人的接口（b 项）+ 与全仓鉴权惯例不一致的接口（a 项），实施者要么返工要么引入第二种 admin 鉴权形态。
- 怎么改：端点改为 `GET /api/v1/training/member-role?wecom_userid=…`（training 域已有 bind/overview 同款 admin-token 先例），内部 `teacher_profiles WHERE lower(wecom_userid)=lower($1)` → `team_members WHERE team_id=<training project's team>`；返回 `{role}`；鉴权沿用 `require_training_admin`。

**I3 · supervisor override 的安全口径缺失：fail-open/fail-closed 未定、role 查询引入 IO 对 identity.ts 纯函数形态的破坏未做设计决策**
- 位置：计划 §2.1 第 2-3 条；对应源码 `mcp-server/src/identity.ts:54-88`（同步纯函数、无依赖注入、`training.ts` 13 个 handler 第一行同步调用）与 `test/identity.test.ts`（21 个用例，纯函数 + mockFetch 集成两层）。
- 问题：(a) role 查询是网络调用，**端点挂了怎么判**计划只字未提——fail-open 意味着 src-server 故障窗口内任何教师传他人 userid 都被放行（身份硬闸 M3 T2 的全部价值归零），必须明写 **fail-closed（查询失败=照现状拒）**；(b) `resolveIdentity` 现为同步纯函数，supervisor 分支需要异步查角色——把它塞进 identity.ts 会把 HTTP 依赖打进这个仓最干净的可测单元（identity.test.ts 的模式矩阵全部是零 IO 纯断言）；(c) 「白名单硬编码在 identity.ts」与现状结构不匹配：identity.ts 目前**没有工具名概念**，白名单判定天然属于分发层（training.ts 的 handler wrapper）或需要给 resolveIdentity 加 toolName + 可注入 roleChecker 参数。
- 为什么要紧：这三点不写清，T2 实施者各做各的，最可能的结果是 identity.ts 变成带隐式网络依赖的半纯函数、测试形态倒退、fail 语义随手写成 open。
- 怎么改：§2.1 补三条明确决策：① role 查询失败 → IdentityMismatch 照拒（fail-closed），错误文案区分于普通 mismatch；② 查询仅在 mismatch 时发生（正常教师流量零额外延迟，无需缓存）；③ 白名单 + override 判定放 training.ts 分发层（identity.ts 保持纯函数，新增的 `resolveIdentityWithSupervision(meta, args, {toolName, isCallerAdmin})` 之类纯判定 + 注入式异步查角色），identity.test.ts 增补「非 admin 传他人 userid 照拒 + role 查询失败照拒」两组用例。

**I4 · G6「提升即扩权」影响评估缺失：`role='admin'` 在 src-server 还有约 9 处 Admin 门**
- 位置：计划 G6/Q2/Q3（只评估了 identity.ts 白名单收口）；对应源码 `src-server/src/middleware/project_guard.rs:14-19`（`role_meets`：admin 满足 Admin 级）及全部调用点：`routes/files.rs:354`（**删除项目文件**）、`routes/ingest.rs:96,110`（**摄取任务取消/重试**）、`routes/pages.rs:261`（**删除 wiki 页**）、`routes/teams.rs:213`（改团队信息）、`routes/training.rs:74`（media-assets 导入）、`routes/llm_providers.rs:42,91,129` + `routes/search_providers.rs:38,78,105`（provider CRUD ×6）。
- 问题：把真人校长提升为 admin，除了计划讨论的 MCP 三工具白名单，还同时给了他的 JWT（MCP 凭证库 `~/.llm-wiki-mcp/teachers.json` 持有 refresh token，换取的 access 即过 `require_auth` 的 Bearer）**删除知识库页面/文件、操纵摄取管线、改 provider 配置**的完整能力。缓解因素客观存在（合成账号密码不可登录 `training.rs:264-277`、凭证文件 600 权限、校长本是可信人员），但「删 wiki 页/管摄取」与「分享视频」职责不匹配，这个增量权限面计划必须写进 §3/§5 显式接受，或改设计（如 teacher_profiles 加 `is_supervisor` 标志位——那会破坏「迁移零」承诺，需权衡）。
- 为什么要紧：G6 是一条直接改生产库 role 的 ops 动作，影响面评估是计划评审的必答题；漏答会让执行者在不知情下扩大爆破半径。
- 怎么改：§5 Q3 补「提升即扩权」清单（上面 9 处 file:line），明示接受理由（JWT 不出 MCP 主机 + 校长可信 + 可逆）；或 T1 顺手把 role 端点设计成读独立标志位（带一个 1 列迁移，规模评估同步改）。

**I5 · 案 B「零网关改动」断言不实：continuity note 注入点在 Hermes 网关代码里，「加一行」也是改 Hermes 仓 + 网关重启**
- 位置：计划 §2.5 案 B（「identity/profile 层已有 continuity note 注入点，同款机制加一行……零网关改动」）；对应源码（Hermes-agent 仓，只读核实）`gateway/session.py:593-619`（`build_channel_continuity_note`——仅在 Slack/Discord/WeCom 且 **auto-reset 且有活动** 时注入，内容是「上一会话已重置，用 session_search 回看」）与 `gateway/run_turn.py:424-428`（回合上下文拼装点）。
- 问题：该注入点确实存在且有 WeCom fork 先例，但 (a) 它是**条件触发**（reset 才有），不是「每次交互前」；(b) 它在 Hermes 网关 Python 代码里——往那里加「你有 N 个未完成学习任务」就要改 Hermes 仓 + 重启网关（本仓 AGENTS.md 硬约束 #4/#7 的重启协调成本）。所以案 B 按计划写的实现位置**并不零依赖**，T4 调查推迟的安全性前提（「B 兜底真的零依赖」）在现口径下不成立。真正零网关改动的兜底形态是 MCP 侧动作：让 `teacher_tutor_plan_list`/`profile_get` 的返回附带 pending 计划计数 + SKILL 指引「任何教师回合若返回含 pending 提示则顺带告知」——这两处都在本仓可控面内。
- 为什么要紧：G3 是主管流「教师将收到通知」承诺（§2.3 第 4 步向校长承诺了通知）的兑现路径，兜底口径不实会让 T4 万一否掉案 A 后整个 feature 退化为「教师不被告知」。
- 怎么改：§2.5 案 B 改写为「MCP 工具返回附带 pending 提示 + SKILL 指引」形态（真零网关改动），continuity note 方案标注为「需改 Hermes 仓」与案 A 同级对待；§2.3 第 4 步对校长的承诺话术与实际通知机制对齐。

### Minor (Nice to Have)

**M1 · §0「签名媒体 30 天窗口」口径漂移**（§0 表 2 行 + Q5）：/t/ 页实际签发的是 **12h** 票据（`t_page.rs:51` `T_MEDIA_TTL_SECS = 12*3600`，注释自述「远小于 media.rs 的 30 天验签纵深上限」），30 天是 `media.rs:27-29` 的 `MEDIA_SIG_MAX_LEEWAY_SECS` 验签侧上限。Q5 的推理（每次点 /s/ 现签、学期级无碍）因现签机制存在而结论仍成立，但计划引用的数字是错的——若实现者据此设计任何「30 天内不用重签」的逻辑会踩空。改一句话即可。

**M2 · T3 必须同步改 SKILL §0 身份硬规则，计划未点名**：SKILL.md §0 第 3 条「请求以他人身份操作 → 礼貌拒绝」是最高优先级行为闸——主管流（校长说「给李老师建清单」）会被它直接拒绝，且 §0 第 1 条「交互回合不传 wecom_userid」与主管用法相反。计划 §2.3 只说「新增流程」，必须显式列出要改写的 §0 条款（加 admin 例外），否则模型按 §0 拒绝主管。顺带：§2 工具白名单「只准用以下 15 个」计数要更新。

**M3 · G2 JOIN 的 NULL/回退细节**（§2.2）：`transcript_page_path` 可空（013:11），无转录页的媒体行 JOIN 不上 wiki_pages、无标题——返回 `title` 需 COALESCE 回落 slug，计划未写。ILIKE 在 ~914 行规模无压力（顺序扫都绰绰有余），鉴权与 api-client 一致性见 I2(a)。「只读不限角色无敏感面」的判断成立：教师本来就能用 `llm_wiki_search` 检索全库（SKILL §2 白名单内），video_search 不新增暴露面。

**M4 · T2/T6 漏写 MCP 生效链与周报验收时点**：MCP 非热生效——`npm run build` 后需 **Hermes 网关重启**才吃到新工具（AGENTS.md 硬约束 #4），且重启须避开周日 19:00 周报窗（#7）；T6 的周报验收若不等下周日，需写明手动 fire cron 的操作（Hermes 侧有 manual run 能力，`tools/cronjob_tools.py:209 _execute_job_now` 一族）。执行序叙事补这两笔。

**M5 · T5 提升 SQL 缺定位步骤**：`UPDATE team_members SET role='admin'` 需要 `team_id`——正确入口是 `TRAINING__PROJECT_ID → projects.team_id`（bind 同款两跳 `training.rs:208-212`），再按 `teacher_profiles WHERE lower(wecom_userid)=…` 取 user_id。计划只写「一条 SQL」，建议补完整定位链（备份该行 ✓ 已写）。

**M6 · T1「+单测」在本仓的形态是连 live PG 的集成测试**（AGENTS.md 硬约束 #2）：role 查询与 media search 均为只读 SELECT，风险低，但执行者须知情标注；mcp-server 侧测试（identity 越权用例）零网络，无碍。

**M7 · 数据面断言未复核**：media_assets「914 行」为数据断言，本次评审遵循「能不碰库就不碰」未查 live PG；该数字不影响任何设计结论（ILIKE 的规模余量是数量级级的），采信计划值。

## 八项 pass 执行记录

**Pass 1 — §0 事实核查**：逐条验证六组地基断言。media_assets schema（013）✓；transcript_page_path↔wiki_pages.path 同构可 JOIN（t_page.rs:792-813 生产先例）✓；/s/→303→/t/ 与免登录（t_page.rs:624-655）✓；plan_create 的 wecom_userid/items/origin/link（training.ts:317-347、src training.rs:1001-1178）✓；complete 进同一事件流（projection.rs:35-47 → get_progress training.rs:718-749）✓；转录页在 wiki、search/read_file 现成 ✓。唯一口径漂移：媒体签名「30 天窗口」实为 12h 签发 + 30 天验签上限（M1），核心机制（现签）属实不构成假地基。**结论：地基扎实，无 Critical 级失实。**

**Pass 2 — 幂等与边界**：018 只是补普通 btree（`idx_learning_plans_user`），真正的幂等索引在 014:12 `(user_id, origin, period_key)` partial unique。create_plan 冲突分支 `training.rs:1140-1162` 确认「原样返回既有 plan、不追加 items、200 OK」。四形态压测结论见 C1：同日不同视频=静默丢失（Critical），多视频一次=支持，同视频同日=防重成立，同视频隔日=重复计划（主管流无防重指引，Minor 性质并入 C1 修复建议）。**结论：发现 Critical 缺陷 C1。**

**Pass 3 — G6 权限爆破半径**：grep `team_members.role` 全部判用处——src-server `project_guard.rs`（project/team 双入口）+ 9 处 Admin 门调用点（files 删除/ingest 取消重试/pages 删除/teams 更新/training media-assets/llm_providers×3/search_providers×3，见 I4 清单）；web 前端无 role 判定（`src/` grep 无命中）；mcp-server 无 role 判定（仅 chat message role）；admin MCP 走静态 token 与 role 无关（admin.ts:11）；SKILL 无 role 概念。bind 确认教师建档即 team_members role='member'（training.rs:252/302），G6 的 UPDATE 前提成立。**结论：G6 可执行，但「提升即扩权」面 ~9 处 Admin 门必须补评估（I4）。**

**Pass 4 — G1 设计可实现性**：identity.ts 88 行全读——三出口判定结构清晰，但 resolveIdentity 是同步纯函数且无工具名维度，supervisor override 需异步 IO + 白名单维度，塞进 identity.ts 会破坏其纯函数测试形态（identity.test.ts 21 用例全零 IO）；mismatch 才查角色意味着正常流量零延迟成本（缓存可省）；fail 语义未写是安全缺口。**结论：可实现，但需 I3 的三条设计决策，否则 T2 实施形态不可控。**

**Pass 5 — G2 检索设计**：JOIN 与真实 schema 对得上（wiki_pages.title VARCHAR(255)、path 同构、t_page.rs:797 有 `path = ANY` 先例）；ILIKE 914 行无压力；鉴权方式计划写 Bearer 与现行 x-training-admin-token 漂移（I2a）；「只读不限角色」敏感面判断成立（教师本可全库 search）。NULL 转录页回退细节缺失（M3）。**结论：设计方向对，鉴权口径与端点形状需按 I2 修。**

**Pass 6 — G3 通知可行性轻探**（Hermes-agent 仓只读）：投递链核实——weixin 适配器有 `send(chat_id, content)` 原语（`gateway/platforms/weixin.py:1072`）但**无对外暴露的纯文本推送端点**；api_server 有 `POST /v1/runs`（`gateway/platforms/api_server.py:81`，带 delivery target 的完整 agent run，跑 LLM 回合非纯推送）；cron 是定时批（`tools/cronjob_tools.py` + delivery.py target 路由成熟）。**案 A 预期结论：无现成机制，小改可成但要动 Hermes 仓**（给 api_server 或新端点加直推路由复用 adapter.send）。案 B 的 continuity note 注入点存在（session.py:593）但在网关代码内且条件触发——「零网关改动」断言不实（I5）。**结论：T4 推迟调查本身可接受，但兜底口径必须先修成真零依赖（I5），否则推迟不安全。**

**Pass 7 — 测试与验收 adequacy**：identity.test.ts 现有覆盖（模式矩阵①-⑦、对抗补遗、零请求断言集成、13 工具 schema、SDK 链路两则）为计划要补的越权用例提供了完整基建，mockFetch + META fixture 直接可扩展——Q3 的测试计划可行且够。T1 单测形态是 live PG 集成测试（M6）。T6 验收链五步角色清晰，唯周报一步的操作时点/手动触发缺交代（M4）。rollback 叙事：Q2 角色可逆 + 各步可独立回退（端点/SKILL 双份 cp/角色改回），此规模下可接受。**结论：测试面 adequacy 良好，缺 M4/M6 两处操作叙事。**

**Pass 8 — 完整性与规模复核**：§3 边界与「迁移零」诚实（I4 若改标志位设计则要重算）；§6「中型偏薄」略低估——漏算了名册工具（I1）、案 B 网关改动成本（I5）、Hermes 重启协调（M4），修正后仍是中型但不再「薄」。五拍板 implications：⑤ HEVC 有硬背书（`t_page.rs:337-340` playsinline 三连 + 2026-08-19 真机实证；media.rs:83 `COALESCE(playback_path, media_ref)` 优先服务转码副本）——计划没写但也不需写，属既有能力；①②③④落点全部验证过。T1→T2 依赖（role 端点先于 override）✓、T5 依赖 T2 部署生效（隐含成立但未显写）、T6 依赖 T4 结论 ✓。**结论：切分顺序成立，规模评估修三处后诚实。**

## 建议

1. **修订顺序**：先改 §2.1（period_key 指引删除/改写 + I2 端点形状 + I3 三条安全决策），再改 §2.3（第 2 步名册工具 + 第 3 步 period_key + 防重步骤），再改 §2.5（案 B 形态）与 §5（I4 扩权清单、Q1/Q3 补口径）。这四处改完即可复审，其余 Minor 可在 T1/T3 执行时顺带。
2. **把 T2 的产出物清单写细**：identity 层保持纯函数 + 注入式 role checker 的结构建议直接写进计划（否则最容易在实施时被做坏）。
3. **T4 调查的前置结论可以省一次往返**：本次评审已给出「案 A 无现成机制、需小改网关（复用 weixin adapter.send 加暴露端点）」的轻探结论，T4 可直接从「在哪里暴露、怎么鉴权」开始，不必从零调查。
4. **执行序补两笔运维**：T2 后的网关重启（避周报窗）与 T6 周报手动 fire 方法。

## 裁定

**verdict：REVISE**

技术理由：地基核查六条属实、差距识别与复用设计整体健康，但 §2.1 的 period_key 键形态经 `(user_id, origin, period_key)` 唯一索引与冲突返回语义实测存在「同日异视频静默丢失」的数据丢失缺陷（C1），§2.3 第 2 步的名册支撑是差距清单漏项且与自动 bind 建档耦合（I1）——两处均位于主管对话流的主路径上，按计划文本实施必然返工，须先修订计划再进 T1。
