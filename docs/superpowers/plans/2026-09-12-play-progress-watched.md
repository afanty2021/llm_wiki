# /t/ 播放遥测 + watched 投影实施计划（play_progress 特性）

> 状态：**已评审 · Approve with fixes，修法已全部吸收（2026-09-12）**——评审报告 `.superpowers/play-progress-watched-plan-review-2026-09-12/report.md`（I-1/I-2/I-3 + M-1..M-7 逐条落实于下文标注 [评审I-x]/[评审M-x] 处）。吸收后即可开工。
> 触发：教师看完视频不点「完成」时，后台只能到 `viewed`（卡片进过视口），无法区分「看完」与「扫一眼」——播放器零遥测（t_page.rs 播放器仅 seek+autoplay，无 timeupdate/ended 心跳，服务端无进度类端点）。
> 方案裁定（用户已拍板）：**事件 + watched 状态双轨**——播放器加稀疏心跳 beacon（新事件 `play_progress`），播放至 ≥90% 或 ended 自动投影新状态 `watched`；显式「标记完成」语义保持，completed 永不回退。

---

## 一、现状事实（2026-09-12 双探查实测，行号为当日工作区）

### 事件与状态机
- 状态单向格：`pending < viewed < completed`（projection.rs:9-12）；`complete_item`（:29-56）insert `complete` 事件 + `status='completed', completed_at=NOW()` 单调幂等；`apply_seen`（:66-108）项级 = insert `seen` + `pending→viewed` 单向，页面级仅记事件。
- `rebuild()`（:130-170）：清零全部 → 重放 seen → 重放 complete（completed_at=MIN(事件时间)）——**新增状态必须进重放链，否则重建即丢**。
- live 事件分布：seen 266 / view 88 / ask 34 / plan_created 30 / complete 3。

### beacon 与限流
- 路由：`POST /t/:token/seen`、`POST /t/:token/complete`（t_page.rs:64-70）；鉴权 = plan_link JWT（7 天 capability URL，HS256，claims `{sub: user_id, plid: plan_id, typ:"plan_link"}`，jwt.rs:125-153）+ plan 归属/`status='active'` 门禁（:787-797、:843-853）。
- 限流：seen/complete **共桶 `beacon` 60/min/plan**（key=`{user_id}:{plan_id}`，SEC-8；t_page.rs:781/837）；GET /t/ 独立 30/min；`FixedWindowLimiter`（rate_limit.rs:31-69），cap 经 `PageRateLimits`（:89-96）config/env 可覆盖。
- beacon JS（t_page.rs:456-512）：`fetch` 非 sendBeacon、无 keepalive；页面级 seen 脚本即发；项级 seen = IntersectionObserver threshold 0.4 一次性（unobserve）；complete 按钮 fetch + 本地自更新；播放器 `<video/audio controls preload="metadata">` + `a.ts/a.chap` 点击 seek `currentTime=s` + play()——**无任何播放事件监听**。

### 消费方（新状态/新事件的波及面）
- `learning_events.event_type` CHECK（014:31）原值 `view/seen/complete/ask/plan_created`；`learning_items.status` CHECK（014:22）原值 `pending/viewed/completed`——**双 CHECK 需迁移放宽**。
- `get_progress` recent_events = **全局 LIMIT 20 无类型配额**（training.rs:733-739）——高频心跳事件会挤占 ask/complete 的 LLM 可见性。
- status 读取方：progress/list_plans/OVERVIEW_SQL 四处 `COUNT FILTER (status='viewed'/'completed')`（training.rs:711-712、:1200-1201、:415-425）；t_page 徽标 match（:300-304）+「已完成 N 项」completed-only（:235,:293-295）；**rebuild 清零重放**（:131-139）；无前端 React 消费方（/t/ 页为 Rust 服务端渲染）。
- mcp/SKILL：JSON 原样透传（training.ts:880-884 → jsonResult），无 event_type 文案映射，新类型不炸；周报 prompt 只点名消费 ask 的 `payload.question` 与 plans 计数（SKILL.md:105-114）。
- `POST /events` API 仅收 `ask`（training.rs:640-662）——play_progress 走 /t/ beacon 通道（与 seen/complete 同信任模型），不开公开 API。

## 二、设计

### 形态（已拍板）
双轨：**play_progress 事件**（遥测明细）+ **watched 状态**（聚合信号）。理由：事件明细会挤占 recent_events 窗口且周报只看聚合；状态/计数是 tutor 可直接消费的形态；明细事件落库供审计与 rebuild 重放。

### 状态机
```
pending --(IO seen)--> viewed --(播放≥90%/ended)--> watched --(显式标记完成)--> completed
   \-------------------------任何 play_progress beacon 也走 pending→viewed------------------/
completed 永不回退；watched 不覆盖 completed。
```

### 心跳协议（客户端 → POST /t/:token/play）
- body：`{ item_id: i64, phase: "checkpoint"|"ended", position_s: int, percent: int }`。
- 客户端策略（稀疏，≤4 beacon/视频）：`timeupdate` 累加**播放中**的时间 delta（对 seek/暂停鲁棒）；跨 25/50/75% 各发一次 checkpoint（once）；`ended` 事件或 accumulated ≥ 0.9×duration 发一次 ended（once）。
- 服务端投影闸 = **phase=='ended'**（percent 仅入 payload 不作依据——信任模型与 seen/complete 同级：capability URL + 归属校验，不做服务端时长累积）。

### 限流
- 新独立桶 `play` 60/min/plan（`plan_identity_key` 同款）——不与 seen/complete 共桶，心跳不饿死 complete；cap 进 `PageRateLimits` + config/env 可覆盖（`PAGE_RATE_LIMITS__PLAY_PER_MIN`）。

## 三、实施步骤

### 0. 迁移 020（⚠ 已执行——见「已完成与偏差」）
`migrations/020_play_progress_watched.sql`：双 CHECK DROP+ADD（event_type += 'play_progress'；status += 'watched'）。约束名经 pg_constraint 实核（`learning_events_event_type_check` / `learning_items_status_check`）。

### 1. projection.rs
- 新增 `apply_play_progress(tx, plan_id, item_id, phase, position_s, percent, user_id)`：
  - 无条件 INSERT `play_progress` 事件 payload `{"phase","position_s","percent"}`（事件即事实，同 complete 风格）；
  - 任何 phase：pending→viewed（复用 apply_seen 项级守卫与归属校验）；
  - phase='ended'：viewed/pending→watched（`WHERE status IN ('pending','viewed')`，completed 不回退）。
- `rebuild()` 重放链扩展：清零 → seen → **watched（EXISTS phase='ended' play_progress 事件，status IN pending,viewed → watched）** → complete。
- **[评审I-1] checkpoint-only 条目重放保真**：重放链补一步——seen 重放步的 EXISTS 放宽为 `event_type IN ('seen','play_progress')`（一行改动），使只有 checkpoint 心跳、无 item 级 seen 的条目 rebuild 后停在 viewed 而不回退 pending（否则违背「事件即事实、投影可重建」的存在意义；真实触发面：极老 WebView 无 IntersectionObserver / seen beacon 网络抖动 / 滚动后未达 40% 阈值即点播）。
- **[评审M-3]** `RebuildStats` 增 `watched` 字段；rebuild 端点响应（training.rs:1320-1324 手工展开 stats）与测试断言同步。

### 2. t_page.rs
- 路由 `POST /t/:token/play` → `post_play`：验签/归属/active 门禁与 seen 完全同款；`PlayBody` 结构体（item_id 必填；phase 枚举校验，非法 400）；调 `apply_play_progress`。
- `limiter.play.check(plan_identity_key(...))` 验签后检查（与现桶同位置同风格）。
- beacon JS 扩展：per media section 绑 `timeupdate`/`ended`；checkpoint 三档 once + ended once；复用现 `beacon()`。watched 后徽标不即时刷新（与 seen 同策略）。
- **[评审I-2]** `beacon()` 的 fetch 加 `keepalive: true`——**play 路径必须**（ended 是 watched 唯一触发，「看完即关页/切回企微」头号场景下页面卸载会取消进行中的 fetch，信号连落库都没有，rebuild 也无从恢复），seen/play 全加（body 均 <64KB keepalive 上限）。
- **[评审M-7]** beacon JS 注释写明口径：`accumulated ≥ 0.9×duration` 是**累计播放时长**阈值（反复重看前半段可触发，非播放位置 ≥90%）；`preload="metadata"` 下 duration 可能短暂 NaN/Infinity，比较前 `isFinite` 守卫。
- **[评审M-1] play 桶接线触点全清单**：rate_limit.rs（新常量 + `PageRateLimits` 加字段 :89-96 + `with_caps` 3→4 参 :100 + `new()` :110）；config.rs（`PageRateLimitConfig` 加字段 + 缺省函数 + `Default` impl :262-264 + 模块文档）；**config/default.json**（page_rate_limits 节显式携带同值——config.rs:519 注明该文件是断言锚点）；lib.rs:81-84 `with_caps` 调用；rate_limit.rs 既有单测（`page_rate_limits_specs`/`with_caps_override`/`t_page_bucket_independent_of_beacon`）同步。

### 3. 消费方
- `training.rs`：recent_events 查询加 `AND event_type <> 'play_progress'`；`ItemCounts` 增 `watched` 字段，get_progress（:711-712）/list_plans（:1200-1201）/OVERVIEW_SQL（:415-425 全期+7d）四处同步；「至少看过」口径注释改 viewed+watched+completed。
- **[评审M-4] 知情项**：OVERVIEW_SQL `ev` 子查询的 `last_active_at`（MAX(created_at) 全类型聚合）会被 play_progress 推进——播放即活跃，语义正确甚至更准，无需排除；这是被新事件改变行为的第二个读取面（第一个是 recent_events），执行者知情即可。
- `t_page.rs` 徽标：`"watched" => "badge-viewed"`（复用配色，文本原样）；「已完成 N 项」保持 completed-only。
- **[评审M-6] 知情项**：伪造 play 可对 wiki_page 项投影 watched（服务端只验 item ∈ plan 不验 kind）——与 seen/complete 完全同信任模型（capability URL 本就可任意伪造 beacon），一致即接受；未来若收紧（kind='media' 校验）属独立加固不阻塞本计划。
- mcp-server/SKILL 零改动。

### 4. 测试（cd src-server；集成直连 live PG 5433——仓内知情惯例）
- `t_page_test.rs`：play 端点矩阵——401（坏签名）/403（过期）/404（归属/归档）/400（伪造 item、非法 phase）/429（独立桶不与 seen 共享计数）/checkpoint 只记事件不投影/ended→watched/completed 重放不回退/payload 形状。
- **[评审M-2d] 429 断言机制**：照现成先例 `t_page_view_rate_limited_429`（t_page_test.rs:1024-1044）——`cfg.page_rate_limits.play_per_min = 2` 直调 create_app；注意 play 桶检查在**验签后**，测试需有效 token + 真实 plan（与 t_page 429 测试用假 token 不同）。
- `learning_api_test.rs`：progress counts 含 watched；recent_events 排除 play_progress（播种混合事件断言窗口内容与顺序）；rebuild 重放 watched；watched 单向性。
- **[评审I-1/M-2c]** rebuild 后 checkpoint-only 条目（只有 play_progress、无 item 级 seen）停在 **viewed**（重放链 EXISTS 放宽的回归锚）。
- **[评审M-2b]** watched 后再 play checkpoint 不回退 viewed（格单调性关键边，显式用例）。
- **[评审M-2a]** `overview_aggregates_plans_items_events_per_teacher`（training_test.rs:839）同步加 watched 计数断言（全期+7d），否则 OVERVIEW_SQL 改动只有回归保护没有行为验证。
- t_page 内嵌单元：beacon_js 形状断言（play 端点、once 标志、90% 阈值常量存在、**keepalive: true 存在**[评审I-2]）。

### 5. 部署（评审通过后，另行会话或本会话续作）
- 顺序：`cd src-server && cargo build` → ~~迁移 020~~（已应用）→ **[评审I-3] 迁移 020 记账：对 live 跑一次 `cd src-server && sqlx migrate run`**——020 的 DROP+ADD 同名约束可幂等重入（评审已核），毫秒级 ACCESS EXCLUSIVE 锁在 launchd 重启窗内无碍，且以正确 checksum 补入 `_sqlx_migrations`（live 历史表现止步 19）；兜底替代=在 m3-gray-runbook.md 迁移节注记「020 人工直灌未入历史表属已知状态」→ launchd bootout/bootstrap 重启 `wiki.src-server`（**避开周日 19:00 周报窗**；重载前后核 mtime/lstart）。/t/ 页为 Rust 渲染，不涉 dist/npm build。
- 开发在 main（仓惯例）；**实现完成后送独立评审会话，评审通过再部署**。

### 5b. 回滚（[评审M-5]，事实经评审核清）
- 新→旧二进制回退无 DDL 动作；旧代码只写旧事件/状态类型，放宽后的 CHECK 双向兼容。
- play_progress 行残留：旧 recent_events 无排除会漏出该类型（mcp 透传不炸，仅噪声）。
- watched 条目在旧计数口径下落入 total 与 viewed+completed 之间的差值（「至少看过」低估，不丢数据）。
- 旧 rebuild() 会把 watched 打回 pending——事件仍在库，新代码回来可再次投影，无损。
- 开发在 main（仓惯例）；**实现完成后送独立评审会话，评审通过再部署**。

## 四、已完成与偏差（诚实记账）

- **迁移 020 已写入文件并已应用 live PG（5433）**（2026-09-12，本计划落盘前的实现启动阶段）：DDL 仅放宽 CHECK、对旧二进制零影响（旧代码只写旧类型），且集成测试依赖。风险评级：低（ADD CONSTRAINT 纯收紧方向的反向操作=放宽，无数据回填）。
- 其余代码步骤（projection/t_page/training/测试）**尚未开始**——等待本计划评审。

## 五、明确不做（范围边界）

- 企微会话内直发播放（playbackVideo 直发企微）无遥测面，不覆盖——该场景后台仍零感知。
- 服务端不做实时观看时长累积（客户端 accumulated 阈值即可，信任模型与现 beacon 一致）。
- 心跳不做逐秒上报（≤4 beacon/视频，稀疏）。
- 概念合并清理专项（2026-09-12-concept-merge-cleanup.md）不受影响。

## 六、验收标准

1. 看完视频（≥90% 或 ended）不点完成 → 条目 viewed→watched，progress `watched: 1`，周报 tutor 可区分「看完未标完成」。
2. 扫一眼（仅 IO seen）→ 停在 viewed，与看完可区分。
3. 显式完成语义不弱化：completed 只能由标记完成产生；watched/重看不回退 completed。
4. seen/complete 现有限流与测试零回归；rebuild 后 watched 不丢；recent_events 窗口无 play_progress。
5. 全量相关测试绿（t_page/learning_api/training），`cargo build` 无警告级新增。

## 七、评审关注点建议

1. watched 与 completed 的语义边界是否认可（被动证据 vs 主动确认）。
2. 服务端投影闸仅认 phase='ended'（信任客户端 accumulated 阈值）是否可接受——备选是服务端按 position_s/duration 复核，但 duration 需进 payload 且仍有伪造面。
3. play 桶 60/min/plan 的额度（现设计心跳稀疏 ≤4/视频，60 充裕）。
4. recent_events 排除 play_progress 后，tutor 对「看完」的感知完全依赖 plans.watched 计数——是否需要在 progress 响应里另加最近 watched 摘要（本期不做，留观测项）。
