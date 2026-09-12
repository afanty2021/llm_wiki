# /t/ 断点续播实施计划（play resume——play_progress 事件的读路径消费）

> 状态：**已评审通过**（计划评审 + 实现评审均 Approve with fixes，修法全部吸收，报告见 §四；实现已完成，提交/部署待发话）。
> 触发：play_progress 心跳（0d45d322 已上线）把中途位置写进了 `learning_events.payload.position_s`，但页面渲染是裸 `<video/audio>`（无 currentTime 初始化），中途退出再进来只能从 0 重看——数据已在库，只差回读+注入。
> 方案：**渲染时服务端回读 + data-resume 属性 + 客户端 loadedmetadata 恢复**。零迁移、零新端点、零状态机改动——纯读路径特性。

---

## 一、现状事实（2026-09-12 实读，行号=HEAD 0d45d322 工作区）

### 渲染链路
- GET handler `get_t_page`（t_page.rs:643）：验签（:652-662，JWT claims 取 user_id/plan_id）→ 归属+active 门禁（:672-682）→ **同事务**（:667 begin）依次装 items（:700-706，`SELECT id, kind, target_ref, label, status FROM learning_items WHERE plan_id=$1`）/media_assets（:708-725）/wiki 内容/摘要页 → `render_t_page(...)`。
- 媒体标签渲染（t_page.rs:342-345）：`"<{tag}{inline_attrs} controls preload=\"metadata\" src=\"{}\"></{tag}>"`——media 项循环内（:328-345），`render_t_page` 签名 :228-234（plan/items/media_assets/signed_urls/token 五参）。
- beacon JS `beacon_js(token)`（:458-560）：per-section 绑 `video,audio`（:487）、itemId 取自 `section[data-item]`（:489）；章节/时间戳点击 seek+play（:526-540，唯一现存 seek 路径）。**行内 JS 模板禁出现 `<` 字符**（:507 注释——XSS 结构审计要求全文标签白名单，比较须反向书写）。
- 播放器无 autoplay（章节点击才 play()）；`preload="metadata"`——**loadedmetadata 可能先于 body 尾部脚本执行**（时序竞争，恢复逻辑须双路：readyState≥1 立即 apply，否则挂事件）。

### 数据源
- `learning_events`（migrations/014:27-34）：`user_id INTEGER / item_id INTEGER(可空, ON DELETE SET NULL) / event_type / payload JSONB / created_at`。索引双在位：idx_events_user_time (user_id, created_at DESC)（014:35）+ **idx_events_item（partial，`WHERE item_id IS NOT NULL`，014:36）**——planner 二选一或 BitmapAnd，真实教师 188 事件规模 live EXPLAIN ANALYZE 实测 0.04ms 级，无性能面。⚠️ 勿「补」item_id 索引（已存在，重复索引加在 beacon 高频写路径上=纯写放大）。**`user_id = $1` 必须保留在 WHERE，理由是跨用户安全隔离（非性能）**——即使 planner 走 item 索引，user_id 谓词仍在过滤层兜底。
- play_progress payload 形态（projection.rs:137 json!）：`{"phase": "checkpoint"|"ended", "position_s": i64, "percent": i64}`；position_s 落库 `unwrap_or(0)`（t_page.rs:994）。**`(payload->>'position_s')::bigint` 的 cast 安全依据=单写者不变量**：apply_play_progress 是唯一写者、PlayBody.position_s 经 serde i64 反序列化保证数字形态（live 15 行逐一实测全可 cast）；v1 不加 NULLIF 防御（手工 DBA 脏行不在威胁模型内，留档）。
- `apply_play_progress`（projection.rs:122-）只写不读；watched 投影闸只认 phase='ended'。rebuild 重放只判事件存在（:184-225），不取位置——**resume 不碰投影链**。

## 二、设计

### 读路径（服务端，渲染时）
get_t_page 在 items 装载后（:706 后）、同事务内加**一条**批量查询：

```sql
SELECT DISTINCT ON (item_id) item_id,
       payload->>'phase' AS phase,
       (payload->>'position_s')::bigint AS position_s
FROM learning_events
WHERE user_id = $1 AND item_id = ANY($2) AND event_type = 'play_progress'
ORDER BY item_id, id DESC
```

- `$2` = 该 plan 的 media 项 id 列表（已在内存，items 过滤 kind=='media'）；列表为空跳过查询。
- **latest 口径（id DESC 取最新一条）**：不取 max(position)。论证（评审 Min-2 修订后措辞）：max 的污染源是**任意**前跳 seek（章节跳到 80% 处发的 checkpoint 记 80%，幅度无界）；latest 的污染面仅限「marks 用尽后回退」一隅，且幅度受 25% checkpoint 窗口钳制——latest 的污染显著小于 max，结论取 latest 不变。
- 服务端注入规则：`phase='ended'` → 不注入（看完再进来从头看）；`position_s < 5` → 不注入（误触噪声）。产出 `BTreeMap<i32, i64>`（item_id → resume 秒数）。
- 无时间过期：三周前的中途位置也 resume（v1 从简；resume 键定「本人×本 plan item」，陈旧 resume 只发生在同 item 数周前看一半场景，恰是用户想要的；备选一行 WHERE 留后手）。

### 注入与恢复（客户端）
- 媒体标签追加属性（:343 format 内）：有 resume 值时 ` data-resume="{pos}"`（整数插值 + html_escape 双保险；无值不加属性）。**注入写在 signed_urls 命中分支内（媒体标签 format 处）**——未配置签名密钥分支无媒体标签、属性自然缺席，勿写在 `Some(asset)` 层（会产生孤儿属性）。
- beacon_js per-section 块（:487 找到 player 后）新增恢复段：
  - 读 `data-resume`；`readyState >= 1`（HAVE_METADATA）→ 立即 apply，否则挂 `loadedmetadata` apply（双路覆盖 preload 竞争：脚本在 body 尾，metadata 可能已就绪）；
  - apply 为一次性 best-effort（进函数即置标志）；守卫三连的**无 `<` 具体形态（评审专项钉死，`<`/`<=` 均违禁）**：`isFinite(d) && d > 0` / `!(resumeS > d * 0.9)` / `player.currentTime === 0` / `player.readyState >= 1`（`>=` 合法）；
  - `currentTime = resume`，**不 autoplay**（保持现交互：播放仍手动）。
  - **marks 交互注记（评审 Min-1，裁定接受不预置）**：resume 落点 ≥25% 时恢复后首个播放 tick 会一次性补发已达阈值的 checkpoint（resume@50% → 补发 25%+50%）——marks 每 session 一次性，整 session 仍恰 ≤4 beacon/视频，补发条 phase=checkpoint 不触投影、watched 不受影响；percent 字段与 mark 阈值错位仅审计字段无消费方。可选优化（marks 按 resume percent 预置）留档不做。

### 明确不碰
状态机 / rebuild / 限流 / 鉴权 / 迁移 / MCP——零改动。resume 是 play_progress 事件的第二个读消费方，与 recent_events 排除（training.rs:748）、rebuild 重放（projection.rs:184-225）互不相干。

## 三、实施步骤

### 1. get_t_page（t_page.rs）
- media 项 id 列表（复用 :700-706 的 items）非空时执行 §二 批量查询（同 tx）；按 §二 规则过滤成 `BTreeMap<i32, i64>`。
- 新查询绑定 (i32, Vec<i32>)——SQL 文本全仓唯一，无同文本异绑定冲突面（sqlx 缓存陷阱自查，惯例）。

### 2. render_t_page（t_page.rs）
- 签名加第六参 `resume: &BTreeMap<i32, i64>`；媒体标签 format 按 map.contains_key 注入 data-resume。**调用点共 4 处**（生产 :822 + 测试 :1099/:1166/:1195），编译器强制全同步。

### 3. beacon_js（t_page.rs）
- per-section 恢复段（§二 客户端逻辑，含无 `<` 具体形态与 marks 注记）。

### 4. 测试（cd src-server）
- render 单测：有 map → `data-resume="42"` 在位；无 → 属性缺席；敌意 fixture 测试（:1057）零回归。
- beacon_js 形状断言（现成模式 :1046-1053 追加）：data-resume 读取 / loadedmetadata / `readyState >= 1` / `=== 0` 守卫 / **`assert!(!js.contains('<'))` 全文无 `<` 断言**（现输出基线已无 `<`，零成本加入）。
- 集成（tests/integration/t_page_test.rs，播种走真实 POST /t/:token/play，先例 :1106）：
  - checkpoint → GET 含 `data-resume="期望值"`；ended → 不含；仅播他人（别的 user_id）事件 → 不含；position_s=0 → 不含；**边界 4→缺席 / 5→注入（Min-5a）**；media 项 plan 无事件 → 不含。
  - **latest 口径钉死（Imp-2a）**：同 item 先发高位置后发低位置两条 checkpoint（POST 顺序保证 id 序），断言 data-resume=**后发**低值——若有人把 ORDER BY 改成 position_s DESC（max 口径）或 id ASC（最旧）此用例即红。
  - **多项混合相位（Imp-2b）**：同 plan 三 media 项 A=checkpoint（注入）/B=ended（缺席）/C=checkpoint（注入），一并覆盖多 media 项各自 resume。
  - 429/鉴权用例零回归。
- learning_api / rebuild 测试零新增（无状态变化），跑全量确认不回归。

### 5. 部署（评审通过后另行发话）
`cd src-server && cargo build --release` → launchd bootout/bootstrap 重启 `wiki.src-server`（避开周日 19:00 周报窗；重载前后核 mtime/lstart）。**无迁移**（_sqlx_migrations 不动）、无 dist（Rust 渲染页）。

## 四、已完成与偏差

- 代码零改动（play_progress 计划期「迁移先斩后奏」教训吸取；本特性无 DDL，天然规避该类偏差）。
- **计划评审（2026-09-12，Approve with fixes，报告 .superpowers/play-resume-plan-review-2026-09-12/report.md）修法已全部吸收进本文**：Imp-1 §一 索引事实更正（idx_events_item 在位；user_id 谓词=安全隔离理由）；Imp-2 §三.4 补 latest 钉死+多项混合两用例；Min-1 marks 交互注记 / Min-2 latest 论证措辞降级 / Min-3 调用点记账 4 处 / Min-4 注入分支层级 / Min-5 cast 不变量入文+4/5 边界用例 / Min-6 §七.5 start_s=0 窄窗留档；§七 五裁定全部认可。
- **实现评审（2026-09-12，Approve with fixes，报告 .superpowers/play-resume-impl-review-2026-09-12/report.md；0C/0I/2Minor）**：Minor-1 边界用例下半已补（item D latest=4 时缺席断言，防噪声过滤弱化静默劣化）；Minor-2 本文档头部状态已更新。环境发现：`ingest_queue_test::enqueue_and_job_status_roundtrip` 红为 live worker 停等 BRPOP@DB0 吃测试任务的结构性既有暴露（证据链见报告），与本特性零关联，**另立项**（随批裁定：修法动共享测试基建须独立全量验证）。
- **max 终审（2026-09-13，Ready to merge: Yes，报告 .superpowers/play-resume-max-review-2026-09-13/report.md；0C/0I/1Minor）**：Minor「他人隔离用例对 user_id 谓词同义反复」（teacher2 事件挂自己 item，item_id=ANY 单独即可排除，谓词零守护）已修——直插「他人 uid × 本人 item」play_progress 行（id DESC 下成为 A 最新行），谓词缺席即以 data-resume="999" 漏出断言红。勘误留档：t_page_test 非独立 cargo target，正确命令 `cargo test --test integration t_page`。

## 五、明确不做（范围边界）

- 不加新 HTTP 端点（回读走渲染进程内查询，能力 URL 同源信任模型不变）。
- 不做迁移、不改状态机/rebuild/watched 口径。
- 不自动续播（resume 只定位不 autoplay；是否「定位即播」留真机体验反馈再议）。
- 企微会话内直发播放（playbackVideo）依旧无遥测面、无 resume——不覆盖。
- 不做「从头重看」按钮（ended 后想重看=拖进度条，数据都在，交互后议）。

## 六、验收标准

1. 播至中途退出（25/50/75% checkpoint 已发）再进来 → 播放器元数据就绪后自动落到最近 checkpoint 位置，不自动播放。
2. 看完（ended 已发/watched）再进来 → 从 0 开始。
3. 未播过、仅 IO seen、或 position<5s → 从 0 开始。
4. 他人事件零泄漏；归档 plan 仍 404；限流/鉴权行为零变化；`data-resume` 只出现在本 plan 本用户的 media 项上。
5. 全量相关测试绿（render/beacon_js 形状/t_page 集成），无 `<` 字符断言在位，cargo build 无警告级新增。

## 七、评审关注点建议

1. **latest vs max 位置口径**：本计划选 latest（宁低估勿跳内容）——max 会被章节前跳污染。是否认可。
2. **checkpoint 稀疏性 → resume 位置最多滞后 25% 窗口**（25→50 之间退出，resume 回 25% 重看约 1/4 内容）：接受（densify 违背 ≤4 beacon/视频 心跳设计），还是值得做「退出前最后一次 timeupdate 补发 beacon」（新增写路径，本期不做）。
3. **无时间过期**：三周前的中途位置也 resume。v1 从简是否可接受（备选：created_at 超过 N 天不注入，一行 WHERE）。
4. **双层 90% 守卫冗余度**：服务端 ended-不注入 + 客户端 0.9 守卫。ended beacon 丢失（keepalive 已缓解但非零）时最新 checkpoint ≤75%+，理论到不了 90%——客户端守卫属廉价冗余，保留是否认可。
5. **resume 与章节交互时序**：先点章节（currentTime>0）→ resume 永不抢；反之 resume 先落、章节仍可再跳（评审裁定认可）。唯一微角：start_s=0 首章 + metadata 未就绪窄窗下 resume 可能覆盖首章定位（HAVE_NOTHING 时 currentTime setter 不生效于 getter）——用户再点一次即回，可忽略（Min-6 留档）。
