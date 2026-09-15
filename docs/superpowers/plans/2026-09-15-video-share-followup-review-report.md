# 评审报告：6d492596..b4eac867（视频学习任务终审后跟进波，4 提交）

**日期**：2026-09-15 · **评审人**：max 深度复审（子代理）
**范围**：4 提交，6 文件，+279/−6。base=6d492596（上一轮终审 HEAD），head=b4eac867。需求来源=终审报告 Issue 1 / Rec-2 / Rec-3（docs/superpowers/plans/2026-09-15-video-share-final-review-report.md）。
**方法**：逐提交读 diff 全文 + 读被改函数完整现状（training.ts 845-1090 / identity.ts 全文 / api-client.ts memberRole / routes/training.rs search_media 591-628 / tests integration mod.rs + training_test.rs + registration_gate_test.rs + routes/auth.rs register）→ 对提交信息每条「已验证」声明独立抽验 → live PG 只读核查 + 一次串行 training 子集实跑 + mcp 全量实跑。
**注**：checkout 实际 HEAD=558add4e（b4eac867 之上多一笔 docs，不在本波范围；归档报告尾部「合并后跟进」表系 558add4e 追加，非 9d956134 内容，本波已核实 9d956134 归档 = 原报告 1-78 行无篡改）。

## 抽验结果（对提交信息「已验证」声明的独立复核）

| 声明（提交） | 抽验 | 结果 |
|---|---|---|
| training 24/24 绿（cc5f5c10 / b4eac867） | `cd src-server && cargo test --test integration training`（live PG，串行一次） | **24 passed / 0 failed**（7.16s）✓ |
| mcp 179/179 绿（4571463e） | `npm --prefix mcp-server test` 全量 | **179/179 pass** ✓ |
| tsc 零错（4571463e） | `npx tsc --noEmit` | exit 0 ✓ |
| 夹具本轮内自删 + 只读 wiki_pages 不写（cc5f5c10） | diff 核实仅 SELECT wiki_pages；跑后直查 live PG `media_assets slug LIKE 't6\_ord%'`=0 | ✓ |
| t6gate_ 收编后残渣归零（b4eac867） | 跑后直查 live PG：`users username/email LIKE 't6gate\_%'`=0、`teacher_profiles LIKE 't6\_%'`=0 | ✓（users/teams 各 69 行 t6\_ 系本评审实跑的 in-flight 行，cutoff 保护待下一轮收，机制按设计） |
| SKILL 双份 cp 部署一致（4571463e） | `diff` 仓源 vs `~/.hermes/profiles/lt-tutor/skills/teacher-tutor/SKILL.md` | 逐字节一致 ✓ |
| dist 重建（4571463e） | grep dist/src/training.js：`targetNotInRosterText`/`queryTargetRole`/「不在名册」均在 | ✓ |
| 「删掉 ORDER BY CASE 分层此断言即红」（cc5f5c10） | live PG 只读仿真（借真实首行 title「116. 如何准备公开课」len=12，F_SLUG key len=23，带/不带 CASE 各排一次） | **不成立**：删 CASE 后 length 次级键仍使 F_TITLE 排前 → 断言仍绿（详见 Important 1）✗ |
| 「7 Minor 记档」（9d956134 提交信息） | 核报告 Minor 节 | 报告实为 6 条 Minor（编号 2-7）+1 Important=7 条编号 Issue，提交信息把总数误写为「7 Minor」✗（信息面笔误） |

## 重点核查结论（对照评审清单）

**4571463e plan_create 预查（生产代码）**
- 触发面正确：预查仅在 `ident.identitySource === "supervisor"`（training.ts:1048）——该标记只可能来自 `resolveIdentityWithSupervision` 的「wecom 会话 + args≠会话 + 会话者角色已验 admin/owner」路径（identity.ts:143-147）。教师自绑（user 模式）与 system 模式零额外往返，专测钉住（identity.test.ts「仅 supervisor 路径」用例断言 member-role 零调用）。
- 复用 `deps.client.memberRole`（与 queryCallerRole 同端点同 token），三臂同构：404→"missing"→正常文本拒（isError=false 防熔断）；非 404 失败（5xx/网络/401/token 缺）→"unavailable"→`supervisionUnavailableError` 抛错 fail-closed。与计划 fail-closed 决策一致。
- 「member-role 查询目标恒为会话身份」不变量的关系：会话者角色查询（queryCallerRole）仍恒查会话身份，未动；新预查查**目标**但是 (a) 仅在会话者已验 admin 之后发生（非 admin 在 resolveIdentityForTool 内先拒，根本到不了预查——非 admin 无探测通道）；(b) 只消费存在性（ok/missing），角色值不外泄；(c) 404 两形态（查无档案/不在 team）在拒绝文案中保持不分（防探测口径延续）。MCP 面新增的是「admin 专属的 userid 存在性 oracle」，而 admin 本就持有 roster_search 全量名册——区分度增益边际，不构成新探测原语。
- TOCTOU：预查通过→plans bind 之间一次 HTTP 往返（~ms 级）窗口，需恰逢该瞬间目标被移出名册/团队。量级可忽略；残面性质同修复前但概率压缩数个量级。知情接受即可。
- 测试验真：4 个新用例全部走真 handler + 真 LlmWikiApiClient，仅在 fetch 边界 mock（正确层级）；404 用例断言「不触达 plans + 凭证零取（seen 空）+ admin header + 文案三要素 + 尾块 supervisor」——钉的是全链行为非 mock 自证。500 fail-closed、member 放行（目标为普通 member 即可，语义正确）、user/system 零往返均有。
- identity.ts 纯函数边界未破：本提交零改动 identity.ts，白名单/查询逻辑全在 training.ts 分发层（决策③维持）。
- SKILL §11 第 2 步新增句与实际行为一致（拒绝→回 roster_search 重查勿硬试）；**plan_create 的 MCP 工具 description 未同步**（见 Minor 2）。
- system 模式带显式 wecom_userid 的 plan_create 仍无预查（cron 可信通道）——提交信息如实声明，与终审已接受的 Minor 6 残面一致，不算新问题，但 Rec-2 的「根除」应读作「supervisor 路径根除」。

**cc5f5c10 序断言**
- 夹具构造正确：F_title 借现有转录页 title（token=title 前 6 字符）→ tier 0 且 slug 不含 token（命中来源单一）；F_slug NULL 转录 + slug 内嵌 token → tier 1。断言 `i_title < i_slug` 是真次序断言，非存在性。本轮内 `DELETE WHERE slug = ANY($1)` 自清 + SWEEPS `t6\_` media 前缀兜底，wiki_pages 只读。live PG 实证 media 残渣 0。
- live 数据依赖：借「id 最小的非空 title 页」，现为「116. 如何准备公开课」（token「116. 如」特异性强，现库仅 1 条生产行命中，LIMIT 5 无挤出风险）。页面被删→fetch_one 失败（响亮）；未来首行换成泛词标题→LIMIT 挤出→panic 带诊断信息（响亮）。可接受的 fail-loud 脆性，但与 Important 1 同源：借行选择策略应一并修。
- **核心缺陷见 Important 1**：对「删 CASE」这一 Issue 1 点名的变异不红。

**b4eac867 t6gate_ 收编**
- LIKE 转义正确（`t6gate\_` 与既有 `t6\_` 族同款反斜杠转义）；users DELETE 中以 OR 并列追加，未改写既有模式。
- 覆盖面核过：register handler（routes/auth.rs:69-134）仅 INSERT users，无 teams/profiles/其他表落点——只收编 users 扫描即完备。username=`t6gate_{pid}`、email=`{uname}@t6.com`（register lowercase 后仍 `t6gate_` 起始），双起始锚定按构造命中；「非锚定无必要」论证成立。
- 误删面：真实用户 username/email 以 `t6gate_` 起始的概率可忽略，且 cutoff 保护在飞行测试；无生产撞名面。
- 存量清偿实证：跑后 live PG t6gate_=0（本波声明 12 行此前已被收清，本轮 sweep 亦零命中，与声明自洽）。

**9d956134 归档**：与终审交付内容一致（78 行 = 原报告全文，verdict/抽验表/Issue 编号无篡改无漏段）；其提交信息「7 Minor」计数笔误（实为 6 Minor + 1 Important）。

**回归面**：三端点、防探测 404 口径、反泄漏两键、三臂文案、SWEEPS 既有 t6\_ 族、G7 禁猜、三臂 fail-closed——逐项核过未破。本波 7 条关键决策锚点无一受损。

## Strengths

1. **预查的三臂语义是从 queryCallerRole 正确镜像而非复制走样**：`queryTargetRole`（training.ts:877-888）比原函数少一个「404→non-admin」分支，因为目标 404 的语义是「missing→拒」而非「降级」，这个语义差异处理得干净；「unavailable」臂逐字复用 `supervisionUnavailableError`，文案运维可辨。
2. **拒绝走正常文本而非抛错是对的**：targetNotInRosterText 注释把「 userid 试错会 3 次打爆熔断器 ~60s」的动机写透，与 I-1 的防熔断哲学一脉相承；文案回显目标 userid + 指路 roster_search + 指引未开通教师的开通路径，模型可自纠。
3. **测试层级选得对**：identity.test.ts 新用例在 fetch 边界 mock、真客户端真 handler 跑全链，「凭证零取」（seen 空）与「plans 零触达」两个负向断言把「预查先于一切副作用」钉死——这是最容易在重构中被无声破坏的次序。
4. **最小改动纪律**：4571463e 生产代码 +22 行（1 函数 + 1 文案 + 1 个 if 块）；b4eac867 仅 tests/ 一个 SQL 的 OR 追加 + 注释同步；无一笔顺手重构。
5. **b4eac867 的「起始锚定即可」论证诚实且经核实**：register 路径 email 确为 `{uname}@t6.com`，且 register 不落其他表——注释里把范围边界（M1/M2 域仍域外）继续写明，没有夸大 SWEEPS 的覆盖声明。
6. **夹具卫生模式延续**：cc5f5c10 的 t6_ord 夹具本轮内自删 + SWEEPS 兜底双保险，跑后 live PG 实证归零；「只读 wiki_pages 不写」声明属实。

## Issues

### Critical (Must Fix)

无。生产代码（4571463e）三臂 fail-closed、admin 门序、防探测口径、identity.ts 纯函数边界均核过；无迁移、无 SQL 注入面、无新探测通道。

### Important (Should Fix)

1. **cc5f5c10 的核心验收声明「删掉 ORDER BY CASE 分层此断言即红」在当前 live 数据上不成立——Issue 1 点名的变异（删 CASE）此测试照样绿**
   - 位置：`src-server/tests/integration/training_test.rs:1454-1509`（新用例 doc 注释 :1454-1456 与提交信息同声明）；被钉 SQL：`src-server/src/routes/training.rs:619-620`。
   - 证据（live PG 只读仿真，借真实首行 `wiki_pages` title「116. 如何准备公开课」）：
     - 带 CASE：F_TITLE tier0/len12 → pos1，F_SLUG tier1/len23 → pos2，断言绿 ✓
     - **删 CASE**（仅剩 `length(COALESCE(title,slug)), slug`）：F_TITLE len12 → pos1，F_SLUG len23 → pos2，**断言仍绿** ✗
   - 根因：借来的标题（12 字符）比 F_SLUG 的排序键（slug≈24 字符）短，次级键 `length()` 恰好给出与 CASE 分层相同的相对次序——断言通过的原因与它声称要钉的机制无关。删 CASE 正是终审 Issue 1 担心的「重构中最易被无声破坏」的变异，本测试对此不设防；能抓的是 CASE 臂反转/length 降序等变异，故非无用，但验收声明虚报。
   - 为什么重要：这是终审唯一 Important 的修复交付，其全部价值就在变异检出；按当前数据，LOE 大水漫灌事故的主修复（tier 分层）被整行删除后回归防线仍然全绿。
   - 修复建议（一行级）：把借行条件从 `ORDER BY id LIMIT 1` 改为选**长标题**行，如 `WHERE COALESCE(title,'') <> '' AND length(title) > 26 ORDER BY id LIMIT 1`——使 len(F_TITLE key) > len(F_SLUG key)，删 CASE 后 F_SLUG 跳到 pos1 → 断言红。顺带把 doc 注释与提交信息的「删掉即红」改为与实际检出面一致的表述（或修后成立）。若担心长标题行不存在，可 fallback 断言 length(title)>26 否则显式 fail。

### Minor (Nice to Have)

2. **plan_create 的 MCP 工具 description 未同步预查行为**（`mcp-server/src/training.ts:346-349`）：schema 里 wecom_userid 只说「非 admin 会话传他人 id 会被拒」，未提「目标不在名册会被拒并引导 roster_search」。SKILL 已覆盖网关模型，但拒绝文案自身可自纠、故仅记档；建议下次触碰 training.ts 时在 description 补半句。
3. **序断言测试对 live 首行数据的双重依赖**（training_test.rs:1459-1464）：借 `ORDER BY id LIMIT 1` 的行——该页被删/改名→fetch_one 失败（响亮可接受）；首行换成泛词短标题→token 泛化后 LIMIT 5 可能挤出夹具（panic 带诊断，响亮）。与 Important 1 同一修复点（选长标题行）可一并收敛，不单独计工。
4. **9d956134 提交信息「7 Minor 记档」计数笔误**：报告 Minor 节实为 6 条（编号 2-7）+1 条 Important=7 条编号 Issue。docs 信息面笔误，报告正文本身无误，不值改写历史，仅记档。
5. **TOCTOU 窗口（记录性）**：预查通过到 plans bind 之间 ~一次 HTTP 往返的窗口内目标若被移出，仍会产生一次脏 bind。概率可忽略（需并发移除操作恰好落入窗口），量级已由预查压缩数个量级，知情接受；如未来要闭合，需服务端 plan_create 侧原子校验（bind 前同事务查 teacher_profiles JOIN team_members）。

## Recommendations

1. Important 1 的修复是本波唯一应尽快跟进项——一行 WHERE 条件 + 断言后，建议把「删 CASE 即红」的声明用同样的只读仿真法复核一次再落档。
2. 服务端加固可选下一步（终审 Rec-2 的完全体）：把「目标存在性」校验下沉到 src-server plan_create 端点 bind 前同事务执行，同时闭合 MCP 预查的 TOCTOU 与 system 通道残面；当前 MCP 面修复已覆盖主要流量（主管 chat 流），下沉非急迫。
3. `teardown_test_data` 的 users 扫描模式族已扩到 13 个 LIKE 分支，建议后续立一个「前缀族常量」单点（函数内拼 SQL 或注释表格化），避免下一笔收编时漏改 username/email 两处之一。

## Assessment

**Ready to merge? With fixes**

**Reasoning**: 4 提交全部「已验证」声明中三条半属实（24/24、179/179、tsc、残渣归零、部署一致均独立复核通过），4571463e 生产改动质量过硬无新风险；唯一实质问题是 cc5f5c10 的序断言对其声称要防的变异（删 CASE 分层）实际不红——测试代码本身无害且合并无阻断，但其验收声明虚报，应按 Important 1 修复并复核后再算 Issue 1 真正闭环。

## 处置表（2026-09-15 同日收口，执行会话）

| 项 | 处置 | 落点 |
|---|---|---|
| Important 1 序断言对「删 CASE」变异假绿 | ✅ 已修复 + 变异复核 | **0f34b247**：借行选择改 `ORDER BY length(title) DESC, id LIMIT 1`（全库最长 104 字符 LOE 页；token「06. Re」数字前缀特异性强、live 仅 1 行命中无 LIMIT 挤出）+ 结构性前提自检（title 键长 ≤ slug 键长即显式失败）。变异实证：临时删 CASE → 单测 0 passed 1 failed（**红**，Issue 1 点名变异被抓住）；恢复 → 单测绿 + training 24/24 绿；training.rs 零残留（git diff 空）。doc 注释同步真实检出机理，「删掉即红」声明修后成立 |
| Minor 2 plan_create description 未同步 | 记档 | 下次触碰 training.ts 时在 description 补半句（本轮零生产代码改动，不为此单独重建/重启网关） |
| Minor 3 序断言对 live 首行双重依赖 | ✅ 与 Important 1 同点收敛 | 0f34b247：最长行（length DESC）比 id 首行稳定；前提自检把「未来首行换泛词短标题→假绿」转成响亮失败 |
| Minor 4 「7 Minor」计数笔误 | 记档 | 9d956134 已 push 不改写历史；报告正文编号（2-7=Minor、1=Important）无误 |
| Minor 5 TOCTOU 窗口 | 知情接受（记档） | 完全体=服务端 plan_create bind 前同事务校验（评审 Rec 2 完全体），概率已压缩数个量级，非急迫 |
| Rec 3 users 扫描 13 LIKE 分支前缀族单点化 | 记档 | 下笔收编新前缀时立「前缀族常量」单点（函数内拼 SQL 或注释表格化），防 username/email 两处漏改其一 |

验收证据：借行标题 len=12（评审主张复核实锚）、全库 2078 行 >26 字符、最长 104；变异跑 `cargo test --test integration media_search_orders` 删 CASE=FAILED / 恢复=ok；`cargo test --test integration training` 24/24（7.52s）。

**Assessment 更新**：With fixes 的唯一 fix 已交付并实证，Issue 1（终审）至此真闭环。
