# 实施计划：概念图谱质量立项（红链提示词级根治 + 全面质检）r2

**日期**：2026-09-08 · **r2**：按评审 F1-F4 修订（报告 .superpowers/concept-graph-plan-review-2026-09-08/report.md）· **状态**：修订待复核 · **性质**：src-server 生成管线改动 + 全库图谱质检

---

## 0. 基线与实测（r2 全节重写；r1 测量作废存档于评审报告 §二.F1）

### 0.1 红链忠实测量（复刻 graph.rs + wiki-graph.ts 双解析语义）

- **label 源语义（r1 测量 bug 的根因，必须永远如此取）**：`extractTitle` 三分支（wiki-graph.ts:90）= frontmatter title → **正文首个 `# ` 一级标题**（全库 label 主源：7898/8724 页走此分支）→ 文件名派生（仅 8 页）。r1 只用了 frontmatter 分支（818 页），致 title 救回误测为 23；三路独立复现（graph.rs 语义 1061 / 服务端语义 1076 / 桌面语义 989）+ 本会话按三分支复刻复测 **993**（14:50 快照 7929 页）收敛，实锺。
- **服务端口径基线（快照 8724 页，2026-09-08 18:19）**：链接实例 35474 / 唯一目标 8071±；title 救回 **1076**；**悬空 3333 实例 / 1593 唯一 = 9.4%**（桌面语义 9.8%）。

### 0.2 悬空形态分类（服务端口径，r1 分类表作废）

| 悬空形态 | 实例 | 占比 |
|---|---|---|
| 自创纯 slug（含 lesson 形 225） | 2018 | 60.5% |
| 带命名空间 path 指向不存在页（`entities/our-dreams-lesson.md` ×23 为最高单项） | 456 | 13.7% |
| 英文裸标题带标点/大小写（`TKT (Teaching Knowledge Test)` ×22） | 416 | 12.5% |
| 中文裸标题且 title 真不存在 | 304 | 9.1% |
| 单词英文裸标题 | 88 | 2.6% |
| title 存在但碰撞组被排除（197 组，9 个 unique） | 33 | 1.0% |
| 退化（`[[wikilink]]` 本身） | 18 | 0.5% |
| sha8 尾 | **0** | 0（两路独立复测一致：模型从不命中真实转写路径） |

### 0.3 生成端现状（已读码，评审实锺维持）

- step2 prompt 已有：路径 ASCII slug 约束、既有页 `[[english-slug|label]]` 别名形式、**宽恕句"[[title]] 由 parser 按 title 解析"（step2_generate.txt:22）——该句本身为真（title 救回 1076），但救回的是"标题恰好真实存在"的链接；宽恕句对"自造标题"零约束，保留但收紧（见 D）**。
- 白名单注入：`fetch_concept_entity_paths`（ingest_pipeline.rs:815）`ORDER BY path LIMIT cap` 字母序截断；cap=`(context_size-8000)/4/12` clamp[1,2000]（:806）。库 7831 页，**白名单覆盖率 25.5%**，a-e 头部偏置 1873 页（评审实锺）。
- `[[wikilinks]]` 无生成后校验（W2 只校验 FILE block path，:130/:145）。
- 无自闭合约束：页 A 可写 `[[concept-x]]` 而本响应无任何块生成它。
- **结构性事实**：lesson 页在 `transcripts/<中文长名>-<sha8>.md`，sha8 模型不可知 → lesson 链接必然自创，只能靠注入真实路径解决。

## 1. 根治设计（提示词级：A/B/C/D + 校验兜底 E）

### A. 白名单注入 v2（ingest_pipeline.rs）

- **格式压缩与容量（F3 修订）**：逗号拼接裸 slug 实测 ~12.5k token/2000 条（slug 均长 25 字符 ≈ **6-7 token，非 ~3**），同预算 2000→**约 4300 条（×2）**。cap 公式改 `cap = (context_size-8000)/4/TOKENS_PER_ENTRY`（压缩格式 ≈7、现格式 ≈11），clamp 上限改绑页面总数（不再硬编码 2000）。
- **命名空间分组（必须）**：裸 slug 有 **155 个 concepts/entities 共享 stem**（accuracy、achievement-test…），无命名空间注入会让模型链错归属。分组格式 `concepts: a, b, c` / `entities: x, y`（比裸拼接仅多 ~24 字符）。
- **相关性选摘（F3 修订：优先零 API 方案）**：step2 时刻源页自身**无向量**（本 job 页面归并段才落库、embed 批在 :1447），embeddings 表不洁（concepts 6147 行 > 页数 5339；entities 1677 < 2492）——KNN 须 join live pages 按页去重，列为备选（K 30-50）。**主方案零 API**：用 step1 分析 JSON 的概念标题列表做 SQL 前缀/精确匹配选摘（同语义、可单测）。
- 注入点 = `process_source_path` 内 step2_generate 调用前：job 级基础表 + 本源 neighbors 合并去重；C 的兄弟源 transcript 路径同点注入（job.source_paths 已知）。

### B. 自闭合规则（step2_generate.txt 模板新增）

> Every `[[wikilink]]` you write MUST resolve to (a) a path in the existing-pages list, (b) a FILE block you generate in this same response, or **(c) a page title confirmed in the live page index**（r2 增：与 E 同一现查索引，保住跨源 title 复用边——title 形解析占已解析边 3.4%；自造标题仍死）. If neither, write the term as plain text.

### C. lesson 链接白名单化（模板新增）

> Lesson/video pages live under `transcripts/` with content-hashed paths you cannot guess. Link a lesson ONLY via its exact path when provided in the source context; otherwise refer to it by plain text.

### D. 裸标题链接收紧（模板修订，r2 措辞修正）

r1"删除宽恕句"作废——宽恕句的 title 解析真实救回 1076 条。修订为：**裸标题（尤其中文）仅当该标题确实存在于既有页标题时使用；新概念一律落到本响应 FILE block 的 slug 并以别名形式链接**。自造标题没有页、永远不会被解析——这正是悬空分类里 9.1% 中文裸标题与 12.5% 英文裸标题的来源。

### E. 生成后链接校验 backstop（r2 按 F2 重写：现查 DB 双索引）

- 落块口（parse 后、embed 批 :1447 前——落块天然满足；未来任何 job 末端 pass 也必须在嵌批前）逐页收集链接，**现查一次 DB**：`SELECT path,title FROM wiki_pages WHERE project_id=$1` 建双索引（path stem 表 + title 表含碰撞排除），毫秒级/每响应。
- **禁用 job 起始白名单作解析集**：白名单仅覆盖 25.5%，会把**白名单外正当目标 21988 实例（69%）**误降级——同 job 兄弟源互链（源并发 1..=8、step2 每源一调 :1534、白名单每 job 一次 :1182，兄弟源互相不可见）是**期望图边**（存量口径 8497 / 流量口径 9958 实例）。现查 DB 可见所有已 upsert 兄弟源；仅 ≤7 在途并发兄弟盲区，记 warning 承认。
- 不可解析链接降级纯文本（`[[x|label]]`→`label`），计数进 job warnings；不 fail、不建占位页。归并段 `upsert_wiki_page`（直写）与 pages.rs HTTP auto-embed 两条机制互不影响本顺序（已核实）。

## 2. 全库概念图谱质检（170 批已收官 2026-09-08 07:33，质检项现已可启动）

1. **红链复测**：忠实解析器全库重跑（服务端/桌面双表面都报），验收线 **<3%** 维持（9.4% 基线下 B/C/D 理论杀 ~85%+，留模型违令容忍）。**分母口径写死：链接实例、只测新摄取源**。
2. **忠实性抽验**：概念/实体页 vs 源转写人工 grep 对照（不叠自动复核工具）；分层抽样 20 页（170 新批 10 + 存量 10）。
3. **实体分裂检测**：同人多名/近名页对全库扫（Steven/Stephen 已实锺 1 例），产出合并建议清单（合并动作用户拍板，本立项不自动执行）。
4. **迷你页定性**：口径写死「content 字符数 <300」；基线 **1227（concepts+entities）/ 509（concepts-only）**（r1 的 1043 与任何现行口径不符，作废）。分层抽样 20 页定性。
5. **污染页清理**：已实锺 2 页（`表格复述策略`/`english-medium-moral-education`，含非 YoYo 循环族串）+ 同因扫描扩展；04/06 源已治愈实锺（06 128757B→27261B 零 YoYo），派生页随重 ingest 或定向重生成刷新。

## 3. 测量工具与验收

- **测量脚本版本化入仓 ✅（r2 已落地）**：`tools/redlink-audit.py`（`--golden` 内嵌用例自测全过；评审 8724 页快照复现 server 悬空 3333/9.4%、分类表七类与迷你页/白名单口径逐项一致）——双解析语义、label 三分支、碰撞排除全部固化。
- 单测：白名单分组格式与 TOKENS_PER_ENTRY cap 公式（改造 `existing_paths_cap_links_budget`）、零 API 选摘合并去重、E 的现查双索引降级逻辑（含 title 碰撞排除同语义）。
- 集成：stub prompt 结构锚同步新模板段（`--test-threads=1`、直调 run_ingest_job 惯例不变）。
- 验收流程：试点重 ingest ≤10 源 → 双表面红链率 <3%（口径：新摄取源、链接实例分母）。

## 4. 部署与回滚（F4 修订）

- 部署约束：**部署时无 in-flight ingest job 即可**（170 批 04a1a3ef 已于 09-08 07:33 收官，评审时点无 running job；后续批次排期与部署错开即可）。src-server release build + launchd bootout/bootstrap；web 侧无改动。
- 回滚：单提交链 revert（模板 + 注入逻辑 + 校验器三处同 revert）；校验只降级链接为纯文本，页面产物无删除。

## 5. 明确不做（本立项范围外）

- 存量悬空目标批量回填/重生成（待质检报告分类占比后另行拍板；「title 碰撞误伤 33 实例」的归属随该轮一并裁定）。
- 实体合并的自动执行（只出建议清单）。
- 前端解析器改动（title 碰撞排除语义正确，r1 决定维持）。
