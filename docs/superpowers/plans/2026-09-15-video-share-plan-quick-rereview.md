# 快速复审：2026-09-12-video-share.md（max 评审修订版）

复审日期：2026-09-15 · 方式：requesting-code-review 流程，独立评审 subagent；通读 max 评审报告（[2026-09-15-video-share-plan-max-review.md](2026-09-15-video-share-plan-max-review.md)）+ `git diff`（HEAD=40a2df1e 修订增量）+ 修订版全部技术断言源码抽查（src-server / mcp-server / SKILL.md，只读；Hermes 仓断言按约定采信 Pass 6）。

## 结论

**verdict：REVISE（轻量、单点）**——13/14 条核销通过且修订质量高（C1/I2/I3/I4 经源码逐项抽查全部属实；Q3b 的 12 处 Admin 门清单 grep 逐字命中 12/12，比评审原文「约 9 处」更精确），无 Critical 残留。唯一拦路项是 **I1 的 roster_search 只修了流程层、后端落实断层**（见下），按复审自述「补上这一小节（3-5 行）即可进 T1」。修订已按处方当场落盘（见「修订落地」）。

## 核销表

| 编号 | 判定 | 关键证据 |
|---|---|---|
| C1 | 已修 ✓ | 计划 36/48/90 三处一致改「不传 period_key + 查重步骤」；`014_learning.sql:12`、`training.rs:1140-1162` 逐行属实；「天然防重/share-」零残留（仅存于作废说明） |
| I1 | 修了但有问题 | 流程层三条全落实（G7/禁猜/工具），但后端数据来源、返回裁剪、角色口径三决策缺位 → Important-1 |
| I2 | 已修 ✓ | 端点定形逐项吻合 `training.rs:149-167/208-212/266-274`；`api-client.ts:532` 证 header 惯例 |
| I3 | 已修 ✓ | 三决策完整；`identity.ts:54-88` 确为同步纯函数；分发层闭环与「仅 mismatch 查」自洽 |
| I4 | 已修 ✓ | Q3b 12 处 `RequiredRole::Admin` 逐字命中；超要求补核 `require_admin` 走 `ADMIN_USERNAMES`（`auth.rs:39-41` 属实） |
| I5 | 已修 ✓ | 案 B 改 MCP pending 计数（真零网关改动）、continuity note 降级标注；§2.3 第 5 步话术对齐 |
| M1-M6 | 已修 ✓ | 12h 票据（`t_page.rs:49-51`）、SKILL §0 改写+15→17 实数核对、COALESCE、网关重启避周报窗、T5 定位链、live PG 集成测试标注——全部与源码吻合 |
| M7 | 采信 | 数据断言，按约定不核销 |

## Issues（复审新增）

### Important-1 · roster_search 后端落实断层（I1 修复残留）+ 角色口径缺位
- T1 端点清单（原行 77）只有 member-role + media/search，roster_search 只有工具名与 SKILL 禁猜规则：数据来源（复用 overview vs 窄端点）、返回裁剪（overview payload 含逐教师进度聚合 `training.rs:465-471`，原样透传=向调用会话暴露全员进度）、角色口径（video_search 明写不限角色，roster 无任何声明）三项全部缺位。
- 且 G7 原表述「名册数据跨 server 不可用」已与现状相悖：`api-client.ts:517-521` 的 `trainingOverview(adminToken)` + admin token（`training.ts:107`）对 training MCP 一步可达——工具面不可用、数据面可用。
- 复审处方：§2 补窄端点设计（`GET /api/v1/training/roster?q=` 仅返回 `{wecom_userid, display_name}`、admin-token、ILIKE、上限 10 条）+ T1 清单加一行 + 对「是否限 admin」拍板 + 修 G7 表述。

### Minor（三条）
1. **plan_list 的 schema 描述未列入 T2 更新**：`training.ts:354`「会话勿传 wecom_userid」与主管流第 3 步直接冲突，模型受 schema+SKILL 双重信号牵引。
2. **member-role 404 语义未点名**：404=非本 team 成员=非 admin，应按「非 admin」拒而非「查询失败」拒（fail-closed 不破，运维语义不同）。
3. **media/search「project 归属自 TRAINING__PROJECT_ID 解析」措辞误导**：media_assets 无 project 维度（013 全表无 project_id）。

## 修订落地（同会话按处方执行，8 处编辑）

1. §2.2 扩为「检索工具（G2+G7）」：新增 `training/roster` 端点设计（窄返回、不复用 overview 及理由）+ roster_search **限 admin 会话**拍板（工具级 admin 闸、不入 override 白名单、不受「仅 mismatch 才查」约束并写明理由）。
2. T1 清单加 `training/roster` 端点 + member-role 404 分支测试；§6 规模改「三端点」。
3. G7 表述修正（工具面不可用、数据面一步可达、overview payload 不适合作名册源）。
4. §2.1 决策①补「404 视同非 admin 照拒」（Minor-2）；media/search 去 project 过滤措辞（Minor-3）；T2 补「工具描述批量更新」（plan_create + plan_list，Minor-1）；Q3 补 roster_search 闸口径与白名单三处一致性。
5. ⚠ 本会话拍板（复审仅要求「给一句拍板」，方向自定）：**roster_search 限 admin 会话**——理由：主管流是唯一消费方；教师无枚举同僚名册的正当需求；关死复审点名的「普通教师互查名册/进度」暴露面；与计划 fail-closed 保守姿态一致。如用户否决，改动面仅 §2.2/Q3 两处括号。

## Assessment

按复审自身口径：Important-1 补齐即达 APPROVED 门槛，无需再动任何已修段落。修订补丁本身（8 处、全部按复审处方+Minor 原文落盘）已做增量点查（同日，独立评审 subagent）：「修订落地」5 项规格忠实落盘 ✓；补丁新增断言全部源码属实（关键一项：`teacher_profiles` 确有 `display_name`/`wecom_userid` 两列，013:20-21——roster 端点可按字面实现）；override 白名单三处一致、两道闸未混写；工具计数 13/15→17 实数吻合；快速复审已核销段落抽查未被破坏；Critical/Important/Minor 零新增——**点查 verdict APPROVED，计划定稿，可进 T1**。
