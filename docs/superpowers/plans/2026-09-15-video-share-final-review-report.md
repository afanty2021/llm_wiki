# 最终全分支评审报告：feat/supervisor-video-share（8cacd780..6d492596）

**日期**：2026-09-15 · **评审人**：最终全分支 reviewer（单人了全场评审，未派子代理）
**范围**：13 提交，13 文件，+1702/−98。base=8cacd780（merge-base with origin/main），head=6d492596。
**方法**：逐文件读 diff 全文（src-server training.rs、integration 两文件、mcp-server 四文件、SKILL.md、CLAUDE.md、计划文档）→ 逐条对照计划 §2/§4/§5 与六条关键决策锚点 → 对提交信息的每条「已验证」声明抽验。

## 抽验结果（对提交信息「已验证」声明的独立复核）

| 声明 | 抽验 | 结果 |
|---|---|---|
| mcp-server 测试绿（175） | `npm --prefix mcp-server test` 全量 | **175/175 pass** ✓ |
| training 域 23/23 | `cd src-server && cargo test --test integration training`（live PG，串行一次） | **23 passed / 0 failed**（7.91s）✓ |
| integration 全量 134/134 | 未重跑（按硬约束只抽 training 子集）；算术核验：binary 167 测试 = 23 + 144 filtered = 134 + 33 ignored，口径自洽 | ✓（口径核验） |
| 迁移零 | diff 无 migrations 文件；member-role/media/roster 全部既有表既有列 | ✓ |
| SWEEPS「roster 可见面 t6_ 恒 0」 | 测试跑后直查 live PG：`teacher_profiles LIKE 't6\_%'`=0、`users wecom_t6\_`=0、`email %t6\_lw_%`=0 | ✓ 三层防线实证闭环 |
| SKILL 热部署一致 | `diff` 仓源 vs `~/.hermes/profiles/lt-tutor/skills/teacher-tutor/SKILL.md` | **逐字节一致**（mtime 17:33 与 f1bee4f4 声明吻合）✓ |
| 三端点 live | 无 token 冒烟 127.0.0.1:8080 | member-role/media-search/roster 全 **401** ✓ |
| tsc 零错误 | `npx tsc --noEmit` | exit 0 ✓ |

## 关键决策锚点逐条核对

| 锚点 | 落点 | 判定 |
|---|---|---|
| chat 不传 period_key 防 C1 | SKILL §11 第 4 步「**不传 `period_key`**」；MCP plan_create schema period_key 仍可选 | ✓ |
| role 端点定形 member-role?wecom_userid + x-training-admin-token + team 两跳 | training.rs `get_member_role`：require_training_admin + `projects.team_id` 一跳 + `teacher_profiles JOIN team_members` 两跳、SQL lower() 归一、双缺失同 404 | ✓ |
| 安全三决策 fail-closed / 仅 mismatch 查 / 白名单在分发层 | training.ts `queryCallerRole` 三臂（admin/non-admin/unavailable）+ `resolveIdentityForTool` 仅 catch IdentityMismatchError 才查 + `SUPERVISION_TOOLS` 常量在 training.ts、identity.ts 零 IO 零工具名概念 | ✓ |
| G7 roster_search + 禁猜 userid | 工具级 admin 闸（一律先查会话者角色）+ SKILL §11 第 2 步「只准来自 roster_search 返回、绝不猜测」+ 工具描述同句 | ✓ |
| 案 B pending 提示真零网关改动 | plan_list/profile_get 尾部 `pending_hint`（尽力而为、形状意外不附、零值不附）；SKILL 白名单段指引；无任何 Hermes 仓改动 | ✓ |
| role='admin' 解锁 12 处 Admin 门显式接受 | 计划 §5 Q3b 白纸黑字（含 files/ingest/pages/teams/media-assets/provider CRUD 清单与 logs 不波及论证）；T5 提 3 人均已备份可逆 | ✓ |
| 端点 404 转正常文本防熔断（I-1） | 两检索工具 catch ApiNotFoundError → `searchUnavailableText()`（isError=false）；500/网络仍上抛计熔断；3 个新用例钉住 | ✓ |

## Strengths

1. **identity.ts 纯函数边界守得干净**。`resolveIdentityWithSupervision`（identity.ts:134-154）catch-提升逻辑正确，且 :144-145 的注释给出「此处 argsUserid 必非空」的可证论证（IdentityMismatchError 在 resolveIdentity:83 仅在 args 非空且 ≠ 会话时抛）。模块零网络 import，白名单常量在 training.ts:56-60，测试（identity.test.ts:277-283）钉桩白名单恰三工具。
2. **fail-closed 三臂语义完整且有测试逐一钉住**：非 admin（member）拒、role 查询 500/503 → unavailable 臂（文案区分 `/temporarily unavailable/` vs `/requires an admin\/owner session/`，identity.test.ts:170-187/259-275）、member-role 404 → 非 admin 语义（:189-207，复审 Minor-2 的处方照做）。决策②「仅 mismatch 才查」有专测（:209-220 断言 member-role 零调用）。
3. **member-role 查询目标恒为会话身份**（training.ts:233 `memberRole(sessionWecomUserid(meta), …)`），从不查 args 指定的他人——MCP 面不存在任意 userid 角色枚举通道。防探测 404（不区分无档案/不在 team）有双分支测试（training_test.rs member_role_404_when_unbound_or_outside_team，含动态取生产库 team 外真教师）。
4. **反泄漏两键契约用「恰两键」断言钉死**（training_test.rs `assert_roster_keys_exact`：keys.len()==2 + 键名断言）——将来任何人往 RosterItem 加 progress/role 字段立即红。这是把契约写成回归钉子的正确姿势。
5. **roster/media 检索测试全部动态取真实行**（不硬编码断言），且 roster wecom_userid 分支用 `display_name IS DISTINCT FROM wecom_userid` 的行隔离出单一命中来源（rhit 测试），消除了「两分支不可分辨」的假阳性。
6. **SWEEPS 修复是证据驱动的最小修复**：FK 13 条逐一 `\d` 实证（11 CASCADE、projects.created_by 由 sweep 顺序化解、activity_logs 零行死表）、LIKE 转义受控实验、cutoff 时间线从 pid 重建。改动仅限 tests/ 两文件；12 处 `cleanup_test_user_by_email` 调用与全部 bind 造数路径一一对应（我逐一核对：tdef/王老师/CJK/c1u+wid2/并发/edge_id/t3×2/周老师/冒烟/角色老师），email 精确键（training.rs:283 合成式，全量 wid 不截断）恰好覆盖 username 无 t6_ 锚点的 CJK 截断分支。本轮实测跑后三项残渣计数全 0。
7. **f1bee4f4 相关度排序是克制且正确的修复**：CASE 标题命中>slug 命中 → `length(COALESCE(title,slug))` → slug 三级确定序；$1 四处复用经 live PG 实跑验证（本轮 23/23 含该查询）；NULL ILIKE 跌落语义正确；配套 SKILL §11.1 钉查询词形与禁 `llm_wiki_search` 冒充，双管齐下。
8. **文档纪律好**：SKILL §11→§12 重编号后全文交叉引用无悬空（grep 核过 §11/§12/流程 9 全部指向正确）；白名单 17 计数与表格行数逐一吻合（15 MCP + vision_analyze + session_search）；「系统/cron 回合不可用」备注与 schema 事实一致；CLAUDE.md 热部署路径纠偏与 live 快照核验口径落档。
9. **台账诚实**：progress.md 不讳言 token 回显失手、main 部署踩掉分支、残渣事故，处置与回滚均有落点。

## Issues

### Critical (Must Fix)

无。鉴权矩阵（三端点同款 ct_eq admin token，无 token/错 token 401 本轮 live 实证）、fail-closed 三臂、反泄漏契约、C1 静默丢数据路径（chat 不传 period_key）、迁移零、SQL 全参数化——均核过，未发现合并阻断项。

### Important (Should Fix)

1. **media/search 相关度排序零顺序断言——f1bee4f4 的核心行为无回归保护**
   - 位置：`src-server/tests/integration/training_test.rs:371-455`（media_search_hits_slug_title_and_null_transcript_fallback）
   - 问题：三个命中用例全部用 `arr.iter().find(|it| it["slug"] == …)` 断言命中**存在**，不断言**次序**。把 training.rs:search_media 的 `ORDER BY CASE WHEN wp.title ILIKE $1 … END, length(…), ma.slug` 整行删掉或改写，全部测试照样绿。
   - 为什么重要：这段 ORDER BY 正是 T6 试跑 LOE 大水漫灌生产事故的修复主体（泛词命中把最具体的行挤出 LIMIT 5）。SQL ORDER BY 在重构中最易被无声破坏；本分支自己的 fix wave 标准（I-1 修复配 3 个新用例）在此未兑现。scoped 复审记录了「既有测试零顺序断言」但未升格为待办。
   - 修复建议：造 t6_/t3_ 前缀 media_assets + wiki_pages 行（一标题命中行、一仅 slug 命中行、标题更长的一行），断言三者相对次序后按既有模式清理；或最低成本——对既有生产两行断言「标题命中行索引 < 仅 slug 命中行索引」。

### Minor (Nice to Have)

2. **计划 §2.3 第 3 步文本未随 I-2 修订回改**：`docs/superpowers/plans/2026-09-12-video-share.md:50` 仍写「看近 7 天已推**条目**」——plan_list 实际只有计划级 ItemCounts 无条目明细，SKILL §11 第 3 步已按事实改「按计划标题判断 + 标题含视频名」。实现与 SKILL 是正确的修订对，计划文本滞后。
3. **`searchUnavailableText` export 无外部消费者**（training.ts:725）：6b36f15c 对同状态的 `pendingHintText` 做了去 export，此处未同案处理——测试断言的是字面字符串，不 import 该函数。
4. **`memberRole` 对畸形 200 响应静默降级**（api-client.ts memberRole：`typeof json.role === "string" ? json.role : ""`）：role 缺失/非字符串 → "" → 走「非 admin」臂而非「查询失败」臂。fail-closed 方向正确，但与「查询失败文案运维可辨」的三臂设计初衷略有出入；建议畸形响应改 throw（落入 unavailable 臂）。
5. **T1 遗留 deferred minors 三件原样在册**：测试 doc 注释「三种形态」实为两形态（training_test.rs member_role_returns… 注释 vs `[wid, to_uppercase]` 循环）；ILIKE q 未转义 %/_（admin 门内、brief 字面 mandate）；limit=0 clamp 成 1（码内注释已声明）。均为已裁定的知情取舍，本分支未清，维持记档。
6. **SKILL「系统/cron 回合不可用」是 schema+模型遵从层面的保证，非服务端硬闸**：system 回合若显式传 undeclared `wecom_userid`（training.ts 两个检索工具 schema 未声明该键），`resolveIdentity` 系统模式照常放行。现状无可利用面（cron prompt 是操作员配置的可信通道；glm-5.3-flash 严格守 schema 是本仓实测结论），仅作防御纵深备注。
7. **本分支未给 docs/CHANGELOG.md 增补视频学习任务条目**：merge 带入的是 main 侧 /t/ 播放检查点的 4 行补账；本功能的 src-server 三端点 + MCP 两工具 + SKILL 主管流零 CHANGELOG 记录。main 侧有明确的 CHANGELOG 补账惯例（8cacd780 提交信息 M-2）。

## Recommendations

1. 合并后尽早在 training 域补相关度排序的确定性序断言（Issue 1）——这是本分支唯一值得当成「随合并跟进」的事项。
2. 主管流服务端加固的可选下一步：分发层 plan_create override 前对**目标** userid 预查 member-role，404 即拒——可在服务端根除「猜错 userid 被自动 bind 成脏档案」（当前由 SKILL 禁猜规则 + roster 只含真实档案缓解，计划 G7 已接受该残面）。
3. t6gate_ ×10 行域外残留（F6 六前缀族之外）与 M1/M2 域积累，维持 task-6-sweeps-report 的建议：后续单独立项收编 SWEEPS。
4. process 正反馈：本分支「计划评审→brief→报告→scoped 复审→fix wave→终审」的链路加上 progress.md 的证据式台账，是拦截住 C1 静默丢数据、I1 猜 userid、I-1 熔断连锁这三个高危点直接原因，值得延续。

## Assessment

**Ready to merge? Yes**

**Reasoning**: 实现与计划定稿及六条关键决策锚点逐条吻合，无迁移、鉴权与防泄漏面核过且 live 抽验全过（175/175、23/23、残渣归零、SKILL 副本逐字节一致、三端点 401），提交信息全部「已验证」声明抽验无一虚报。唯一 Important 是修复行为的测试保护缺口（序断言），不影响运行时正确性，可作为合并后第一跟进项；7 条 Minor 均为记档级。

## 合并后跟进（2026-09-15 同日收口）

全部 7 条编号 Issue 与 Recommendations 2/3 逐项处置（用户指令「逐次修掉」）：

| 项 | 处置 | 落点 |
|---|---|---|
| Issue 1（Important）media/search 零顺序断言 | ✅ 真闭环（跟进评审证伪后修复） | cc5f5c10 的「删掉 ORDER BY 即红」声明被跟进评审证伪（借行标题 len12 < slug 键，删 CASE 后 length() 次级键同序、断言仍绿）；0f34b247 改借全库最长标题（104 字符）+ 前提自检断言，变异实跑：删 CASE→红、恢复→24/24 绿。详见 followup 评审报告处置表 |
| Rec-2 plan_create override 前目标预查 | ✅ 已实施 | 4571463e：supervisor 路径建单前经 member-role 预查目标存在性——404（查无档案/不在 team）→ 正常文本拒（isError=false 防熔断，回显目标 userid + 引导回 roster_search）；查询失败 → unavailable 臂 fail-closed 抛错；user/system 路径零额外往返。mcp 179/179 绿（+4 新用例钉 404 拒全链/在册放行/500 fail-closed/零往返）；SKILL §11 第 2 步补机器侧兜底说明，双份 cp 部署 diff 一致；网关 kickstart 重启（PID 5534，lstart 20:02:48）+ dist 标志串实证 |
| Rec-3 t6gate_ 域外残留收编 SWEEPS | ✅ 已实施 | b4eac867：users 扫描补 `t6gate\_` 起始锚定（username+email，registration_gate_test 注册残留按构造两者均以该前缀起始）；存量 12 行（08-30→09-15 积累，无 profile 不进 roster）经 training 套件起始 sweep 一轮收清，live PG 复核 count=0；training 24/24 绿 |
| Minor 2 计划 §2.3 第 3 步文本滞后 | 知情接受（记档） | SKILL §11 第 3 步已是事实正确版；计划文档为历史评审锚不改写 |
| Minor 3 searchUnavailableText 无外部消费者 | 知情接受（记档） | 后续触碰 training.ts 时可顺手同 pendingHintText 案去 export |
| Minor 4 memberRole 畸形 200 静默降级 | 知情接受（记档） | fail-closed 方向未破（"" 落非 admin 臂）；改 throw 需另配测试，收益边际 |
| Minor 5 T1 deferred minors 三件 | 知情接受（记档） | 已裁定知情取舍维持原判 |
| Minor 6 「系统/cron 回合不可用」非服务端硬闸 | 知情接受（记档） | 无可利用面（cron prompt 可信通道 + glm-5.3-flash 严守 schema 实测）；防御纵深备注 |
| Minor 7 CHANGELOG 零记录 | ✅ 本笔闭环 | docs/CHANGELOG.md 2026-09-15「视频学习任务全案收官 + 合并后跟进」条目 |

**主动通知裁定**：维持现状（主管转发链接，教师下次使用助手时见 pending 提醒、完成情况周报可见）——Case A Hermes push 不实施，用户 09-15 裁定。另实证：手动 fire 的周报 cron 结构上不投递（detached 进程单-WS 约束无 WeCom 发送通道，executions.delivery_outcome=failed 而 status=completed；gateway 日志窗口零行），真投递以周日 19:00 builtin 班次为准（09-06/09-13 两轮教师实收）。
