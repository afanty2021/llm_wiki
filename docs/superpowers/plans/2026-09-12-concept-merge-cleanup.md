# 概念合并清理立项 charter（r2.1，2026-09-12）

> 触发：王蔷荐书批（09-12）全量质检 §6 同 title 重复 → 全库盘点升级为存量专项。
> **r2.1 修订**：r2 按立项评审 Approve with fixes 完成五处数字勘误、工具面三修、十二项风险补录、P1 政策精修（评审报告 §一-七）；r2.1 再吸收复核评审十条修订（同报告 §2.1-2.4）——含 **第四修（S4 硬前置）：put_page 空 fm 根治**，已实现于 tools/wiki-cleanup.py。r1/r2 作废。
> 性质：live 数据修复专项（project 614）。**评审/执行分会话**；r2 修订完毕即进 S3 评审门。

## 一、背景

- 09-08/09-09 曾清偿「concepts 同 title 碰撞 58 组」（wiki-cleanup 5ab5c542 → adjudicate 5e483074 → 95d47b3d 收口；r1 误写 08-28）。该轮机制状态定性为「**跑通一轮 + 48h 内连环四修**」（0d75a6e7 sha-skip 绕过、f6bbb59a 并集从未落库 I1、95d47b3d loser 正文改写闭包），非「成熟」——两条教训转为本专项风险清单必选项（§五-②⑤）。
- 09-12 批质检：批内 8 组；全库盘点远超批内——本专项一次收口。

## 二、全库现状盘点（r2 口径钉死，2026-09-12 双方独立实测一致）

**口径基准**：project 614（**14211 页**；不加过滤的 14435 多出的 224 页散布于 6978-6981（仅 16 页）等数十个小/测试项目，禁用）。title 比较一律 **lower+trim（大小写折叠）**。

| 类别 | 口径 | 组/对数 | 处置 |
|---|---|---|---|
| A. 同 namespace 同 title | lower+trim 分组、双命名空间内 | **26 组/57 页**（entities 23 + concepts 3） | **P0**：LLM same_entity 甄别 → 人工复核 → merge。r1 漏 `Unit 11: Breaking News` 大小写变体对；Mary 组实为 4 页 |
| B. 跨命名空间同基名 | slug 同基名严格 1:1（大小写敏感同值） | **156 对**，其中 **title 全同 51 对** / 其余 105 对 | **P1-hybrid 精修版**（§五）：Tier-1=51 对 title 全同；Tier-2=105 对 keep+See-Also。r1 的「63」任何自然口径不可复现，作废 |
| 两命名空间同 title 碰撞全集 | lower+trim | 87 组 | A∪B(Tier-1) 及多成员组的并集口径，仅作总量参照 |
| C. 纯转写噪声标题组 | VTS_0x_1 ×5-6、纯数字标题等 | 20 组/79 页 | **排除**，另案「转写页标题规范化」 |
| D. 空 title 页 | title NULL/空串 | **67 页**（2026-09-12 午后复测；r1 时点 68 含事故中被冲的 skehan；本批净实修 2 页，余 65）；执行日以当日复测为准 | **P1.5**：读内容定 title + 碰撞门 |

> r1 数字勘误存档：A25（漏大小写变体）、B63（口径不可复现）、总触达 117（自身表内算术 25+63+20=108 不成立）、库总 14435（漏 project 过滤）。

## 三、工具面（S1/S2 开工前置条件，三修）

1. **候选网放宽**：`adjudicate-merge.py` 现按 `page_type=='entity'` 过滤（:69），A 类 26 组仅 19 过筛，FAIL 七组 = Deci（成员 typed `researchers`）+ MI（`concept`）+ TPR (Total Physical Response)（`teaching-method`）+ 3 个 concepts 组（全 concept 型）+ unit-11 对（双 concept 型）→ S1 改为 **按 title 归组、类型无关**。
2. **新 prompt + plan-builder 桥**：现 prompt 语义为「同一现实世界实体」，仅 P0 的 **entities 组**沿用；P0 的 3 个 concepts 组与 P1 Tier-1 同用新 same-topic prompt 形态；甄别输出（平铺 results）与 merge 计划输入（`groups:[{key,keep_path,losers}]`）之间补 plan-builder。
3. **产物落 `.superpowers/concept-merge-cleanup/`**：results/plan/dump 一律不落 /tmp（08-24 重启清空灭失前科；S1-S3 之间隔人工复核，必须可回溯）。
4. **第四修（S4 硬前置，已实现）**：`put_page` 空 fm 根治——fm 形参 None/{} 且服务端 fm 亦空时，以服务端规范化列（title/type/sources/images）构造全量 fm，堵死 denormalize 空回落冲空面（tools/wiki-cleanup.py 单点修复，覆盖 :216/:403/:407 全部调用点及未来调用者）；merge-keep 另补键完整性（keep 原 title/type/images，:407）。危险面实测：fm NULL/`{}` 页现存 **53**（有 title 39、title+wikilink 31=入链改写候选、有 sources 8；**B 对内 2 页**：entities/cefr.md fm=null、concepts/logical-mathematical-intelligence.md）。S4 开工前对这 53 页做行级备份+fm 补全迁移（或 I8 服务端保留式硬化，09-11 已提未做，作备选）。
5. **page_type 归一无机制（并入第四修边界）**：merge-keep 现只写 `fm['sources']`——幸存页归一 concept 须为执行显式步（写 `fm['type']` 并记变更账），不随 merge 自动发生（concepts/mary.md type=entity 为漂移实证）。

## 四、机制真相（评审实测，本专项风险面）

- **embeddings.wiki_page_id（存 path）无 FK**：005 注释 CASCADE 指 project_id；loser 向量删除为 best-effort（`let _ = delete_embedding`，失败静默）→ S5 必须做**按 path 孤儿向量对账**（现库孤儿=0，执行后须仍为 0）。
- **API PUT 无 sources 净化**：sanitize_sources 只在 ingest 管线（pages.rs 计数=0）→ 工具侧并集前**自净化占位符**（09-11 陷阱同款）+ **并集落库后验**（merge 后校验 keep 页 sources 确含并集——f6bbb59a I1 教训）。
- **keep 页 PUT 自动重嵌 ✓**（pages.rs:239），但失败静默吞、行覆盖判据看不出 stale：覆盖率判据改为「row 覆盖 + 抽样 chunk_text 与现内容一致」；存量 69 页 stale 噪声地板（直写 SQL 回填所致）先处置或明示容忍。
- **④ 本批实证新陷阱（已根治入册）**：wiki-cleanup `put_page(fm=None/{})` 触发服务端 denormalize（pages.rs:63-73）**空回落，把 title 连同 sources/images 一并冲掉**（skehan 页 01:40 实锺；恢复=**sources 自备份逐字恢复；title 为重定**——备份时 title 本为 NULL）。**空 `{}` 同样致死**。工具根治见 §三.4；残余脆弱性（fm 至今 NULL 的页在任何不带全量 fm 的 PUT 下原样重演）由 S4 前置迁移收口。
- graph.rs:276 stem first-wins 无 ORDER BY：156 共享 stem 裸链解析现状不可复现——执行前后红链审计不直接可比，判据按「执行后 server 面」单侧计。

## 五、P1 政策（已拍板：hybrid 精修版，锚定 title 同一性、不锚 basename）

- **Tier-1 merge = 51 对跨命名空间 title 全同对**（先验最强，样例 exit-ticket/mothers-day/4Cs/CCQ 均同一事物写两遍）：same-topic prompt 甄别 → 人工复核 → merge；**keep 方向 = 组内实测内容更丰富侧**（例证：UbD entity 侧 1399 字 vs concept 侧 829 字；三组实测 2/3 为 concept 侧更富，「富侧常在 entity」不成立——方向一律按组内实测，不按 namespace 推断），幸存页 page_type 归一 concept（显式步，见 §三.5）。
- **Tier-2 keep + 互加 See-Also = 其余 105 对**（basename 配对被样本证伪：organization=写作评估维度 vs 整理行为、toefl=听力子集 vs 整个考试等）；仅「title 真同义且双侧非 stub」小名单升级走人工门。
- 合并翻 type 动 type_affinity（entity-concept 1.2 ↔ concept-concept 0.8）改图排序与前端过滤——幸存页归一时记录变更账。
- **P1.5 定 title 碰撞门**：新 title 撞键会被 server title index 整键排除；定 title 后 [[title]] 悬链复活会动红链率——执行后按 server 面复测。

## 六、缺失风险清单（r1 §四并 r2 补录，共十二项）

承重四项：① page_type 漂移破候选网（19/26 实证，§三.1）+ type_affinity 翻转（§五）；② sources 并集 API PUT 无净化 + 并集未落库后验（§四，f6bbb59a I1 教训）；③ keep 方向政策（§五，组内实测富侧）；④ 红链判据点名表面——**server 2/49358=0.004% 为准**（desktop 155/49358=0.31% 系 desktop 侧重解析面，不在判据内）。
其余九项：/tmp 持久性（§三.3）；graph stem 非确定（§四）；stale-embed 盲区+69 页噪声地板（§四）；孤儿向量按 path 对账（§四）；S1/S2 LLM 成本预算（≤2 调用/对、90s 超时）；P1.5 碰撞门+红链率扰动（§五）；桌面 dedup-runner 走 `wiki/` 前缀文件路径、API 合并不随动；loser 正文改写无 code-fence 感知（downgrade_links 有、merge 改写路径没有）；**存量红链借合并还魂（557fdf6f）：合并文本落库前过同一降级**。

## 七、范围边界（诚实记账）

- 本立项只收**同 title 面**。NFKC+标点折叠近重复 **98 簇**：高精度 ~6-10 簇（TPR 三胞胎、UBD 三胞胎、phonics 三胞胎、拼音 slug 三胞胎、archaeologist/archaeologists 等）+ 低精度 token-Jaccard 58 簇（多误报）——**本批不收**，embedding 相似度抓手另批（embed-attribution.py 基建已有）。
- 触发批双摄事实：同文件二投（74b5be6d 空跑零页、4b8eb736 实产 11 页）——merge-on-duplicate 兜住无重复物料化，但 LLM 成本白烧+二跑 slug 漂移风险真实（ingested_files 判重陷阱已在批报告 §三入册）。

## 八、执行计划（S3 评审通过后另会话执行）

| 步骤 | 内容 | 产出 |
|---|---|---|
| S1 | P0 26 组类型无关归组 + same_entity 甄别（≤2 调用/对、90s 超时） | 判定表（.superpowers/concept-merge-cleanup/） |
| S2 | P1 Tier-1 51 对 same-topic 甄别（口径=§二 B，156 对清单先落盘） | Tier-1 判定表 + Tier-2 See-Also 清单 |
| S3 | 人工复核 + 评审门 | Approve/fixes |
| S4 | 干跑 merge（plan-builder 产 groups 计划）+ 行级/embeddings/入链三件套备份 | dry-run 报告 + ~/kb-dumps/ 备份 |
| S5 | 执行 + 回归：server 面红链率、孤儿向量对账、并集落库后验、embed 抽样、检索冒烟 | 执行账目 |
| S6 | 收官报告 .superpowers/concept-merge-cleanup/report.md | 账目+外部访问清单 |

范围声明：**Tier-2 See-Also 落地与 P1.5 定 title 不在 S1-S6 内**（另批/追加步骤，届时同样遵守全量 fm 写入规则）。
成功判据：A 类 + Tier-1 同 namespace/cross title 碰撞清零（以 §二口径复测）；server 红链率 ≤ 0.01%；孤儿向量 0；embeddings row 覆盖零缺口且抽样无 stale；**C 类 20 组/79 页 updated_at 与页数零扰动；幸存页 page_type=concept 且变更账完整**；PG 写入全程有备份与账目。

## 附录：A 类 26 组清单（lower+trim 口径，2026-09-12）

**concepts 内（3）**：TPR（全身反应教学法）｜不纠错引导原则｜附带词汇学习 (Incidental Vocabulary Learning)
**entities 内（23 组/51 页）**：Anna｜Deci and Ryan｜Dubai（迪拜）｜Jack｜Julia｜Learning Vocabulary in Another Language｜LT（×2）｜Maria｜Mary（×3；另有 concepts/mary 1 页走 Tier-1）｜Multiple Intelligence (MI)｜Principles and Practice in Second Language Acquisition｜Teaching English as a Second or Foreign Language (第四版)｜TPR (Total Physical Response)｜Understanding by Design (UbD)（×2；另有 concepts 同名页走 Tier-1）｜Unit 11: Breaking News（大小写变体对，r1 漏）｜Video 9｜Wallace｜专家评课（×5）｜小男孩｜思维导图（thinking map）｜授课教师（×3）｜考古学家｜课堂学生

> 甄别预期：角色/课例组（Mary/授课教师/专家评课/Jack/Julia 等）大半为不同实体（宁缺毋错）；真 dup 集中在书页、拼写、中英双标题、大小写变体形态。
