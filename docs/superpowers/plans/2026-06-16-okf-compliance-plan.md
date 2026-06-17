# OKF v0.1 合规改造设计草案

> **状态:草案 v0.5(实施细节定稿,待批准进入 P0a),未实施任何代码改动。**
> 依据:[OKF SPEC v0.1](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)(Apache 2.0)
> 校验工具:`scripts/validate-okf.mjs`(已就绪,诊断已精确化)
> 创建:2026-06-16

---

## 0. Review 响应摘要

| # | 反馈 | 结论 | 处理位置 |
|---|---|---|---|
| 1 | C1 归因不准 | **采纳**。核实确认:非子系统直出,是 deep-research source 经 ingest 产物的**格式缺陷**(前导空行/缺开围栏),且暴露 ingest sanitize 真实 bug。策略从"注入 fm"改为"修复格式" | §2 / §4 |
| 2 | slug→path 模糊 | **采纳**。核实 `fileNameToId` 仅去后缀且 slug 可重复(实测 `concepts/wikilink.md` 与 `entities/wikilink.md` 并存)。方案:导出层独立遍历建 `slug→path[]`,重名不双写 | §5 |
| 3 | timestamp 时区 | **部分采纳**。核实 `currentWikiDate = toISOString().slice(0,10)`,源**本就是 UTC 日期**,故 `→T00:00:00Z` 不引入 -8h 偏移(技术性修正此担忧);但"文档明确时区语义"的建议完全接受 | §4 |
| 4 | log soft 未验证 | **采纳**。明确 normalize 保证 entry 正文非空;补 validator log soft 检查说明 | §7 |
| 5 | Obsidian 兼容缺验收 | **采纳**。补可验证清单 | §1 |
| 6 | timestamp REQUIRED? | **澄清**。SPEC §4.1:type=Required,timestamp=**Recommended**,P2 定位正确;区分 SPEC §9 conformance 与参考实现 `OKFDocument.validate()`(后者更严,非合规判据) | §4 |
| 7 | 实施步骤缺依赖/工作量 | **采纳**。补依赖关系与粗略工作量 | §6 |

### 第二轮(4 条)
| # | 反馈 | 结论 | 处理位置 |
|---|---|---|---|
| R1 | §5.2 链接 `/wiki/` 前缀错 | **采纳**。导出 bundle root=`<out>/`,wiki/ 层剥离;改用 OKF §5.1 推荐的 bundle-relative absolute `/<path>.md`(如 `/concepts/foo.md`)。用户的相对路径方案(§5.2)亦合法但非 OKF 推荐形式 | §4 / §5.2 |
| R2 | missing-fence 补闭合 --- 会重复 | **采纳**。闭合 `---` 仅在末尾确无时补(多数情况已存在,只补开头) | §4 |
| R3 | §2 统计口径变化未注明 | **采纳**。加注说明 C2 双报逻辑 | §2 |
| R4 | §4 三种 concept 缺判断流程 | **采纳**。补判断伪代码(含 truly-none 兜底,实测为 0) | §4 |

### 第三轮(3 条,均为一致性/不阻塞)
| # | 反馈 | 结论 | 处理位置 |
|---|---|---|---|
| T1 | §4 转换表缺 truly-none 行 | **采纳**。补兜底行,与 §4.0 伪代码一致 | §4 |
| T2 | §5.1 slug→path 缺相对基准 | **采纳**。补"相对 bundle root `<out>/`" | §5.1 |
| T3 | §7 空 entry 检测范围+具体用例 | **采纳**。补 English-Teaching `log.md` 测试用例 | §7 |
| — | R1 链接形式澄清 | 无需改动。用户确认 OKF §5.1 bundle-relative absolute 正确,不切相对路径 | §5.2 |

---

## 1. 目标

让本应用产出的 wiki bundle 能声明 **OKF v0.1 conformant**,被 OKF 生态无翻译消费。**不破坏现有 Obsidian 兼容、内部路由、已有数据与测试 fixture。**

### 1.1 Obsidian 兼容验收清单(#5)
导出层为**只读转换**(写入独立目录,源 wiki 不动),故兼容性风险极低。进入实施前补齐以下可验证项:
- [ ] 导出后**源** vault 的所有 `[[wikilink]]` 解析行为不变(导出不写源)
- [ ] 现有 `npm run test:mocks` 全套 fixture 通过(导出层为新增模块,不改 ingest/wiki-graph)
- [ ] `type: index` 内部路由不受影响(`isListingPath` 用路径判断,见 `ingest.ts:1209`,不依赖 fm;导出不改源)
- [ ] 导出产物用 `validate-okf.mjs` 校验退出码 0

## 2. 实证现状(修正后)

`validate-okf.mjs` 扫真实 bundle(诊断已精确化):

| Bundle | concept | 硬性违规 | 分类 |
|---|---|---|---|
| English-Teaching | 584 | **95** | C1 leading-blank×37 + C1 missing-fence×13 + C2(双报)×13 + C3a×1 + C3b×31 |
| Invest | 219 | **5** | C1 leading-blank×2 + C3a×1 + C3b×2 |

> **统计口径注(#R3)**:v0.2 起违规总数采用**逐规则计数**——13 个 missing-fence 文件因缺开头 `---` 致 type 无法提取,**同时触犯 C1(位置)与 C2(type)**,故计 2 次。与 v0.1"逐文件不双报"(82)不可直接比较;逐规则计数信息更精确,利于定位修复点。C3a/C3b 各计每次出现。

### 2.1 C1 根因(修正 #1)——三个层级的事实

1. **没有"真无 frontmatter"的文件**(truly-none = 0)。全部 50 个 C1 都是**格式缺陷**:
   - **leading-blank(37)**:文件前有 1–2 个空行才出现 `---`,frontmatter 内容完整。违 §4.1 "at the start of the file"。
   - **missing-fence(13)**:直接以 `type: source` 等字段开头,**缺开头 `---` 围栏**。
2. **来源可追踪,非子系统直出**:这些文件的 `sources:` 字段指向 `research-this-page-has-no-wikilink-...md`、`research-think-*.md`,即 **deep-research 生成的 source 文件经 ingest 二次生成的 concept 页面**。首轮文档归因到 lint/graph-insights 子系统是**错误的**——核实确认:`lint.ts` 只输出报告不写 .md、`graph-insights.ts` 纯计算不写文件、`deep-research.ts` 写 `wiki/queries/` 且 fm 正确;这六个文件名在源码中不存在。
3. **根因是 ingest sanitize 的 bug**:LLM 输出偶发带前导空行/漏开围栏,而 `sanitizeIngestedFileContent`(`ingest.ts:1517`)未覆盖这两种形态,导致 ~8.5%(50/584)页面 fm 格式损坏落盘。

> **影响策略**:导出层从"注入最小 frontmatter"(首轮,错误)改为"**修复 frontmatter 格式**"(strip 前导空行 + 补开头 `---`)。根治应在 ingest sanitize 层补两条规则;导出层兜底。

### 2.2 C3a / C3b(不变)
- **C3a**:`index.md` 带 frontmatter(违 §6)。
- **C3b**:`log.md` 系统性用 `## [YYYY-MM-DD] action | detail`(`ingest.ts:1804` 设计如此),信息有价。

## 3. 设计哲学:路径 A(导出层)——不变

内部 vault 保持现状,新增"导出为 conformant OKF bundle"能力,转换后写独立目录。契合 OKF producer/consumer 独立原则,零破坏可逆。路径 B(原生改 ingest)风险高,暂不采纳。

## 4. 转换规则(修正 #1/#3/#6)

新增 `src/lib/okf-export.ts`(纯 TS)。输入 `<project>/wiki`,输出 `<out>/`。

**Bundle 结构(关键,#R1)**:`<out>/` **即 OKF bundle root**(OKF Appendix A:root 直接是 index.md + 子目录,无中间层)。源 `<project>/wiki/<path>.md`(如 `wiki/concepts/foo.md`)导出为 `<out>/<path>.md`(即 `<out>/concepts/foo.md`)——**`wiki/` 层剥离**。故页面间链接用 OKF §5.1 bundle-relative absolute `/<path>.md`(如 `/concepts/foo.md`),**不含 wiki/ 前缀**。

| 目标 | 转换规则 | spec |
|---|---|---|
| `index.md`(root) | 剥离原 fm;重写为仅 `okf_version: "0.1"` + 原 body | §6/§11 |
| `index.md`(子目录) | 剥离全部 fm,仅留 body | §6 |
| `overview.md` | OKF 非保留名→concept;保留 `type: overview`,补 `timestamp` | §4.1 |
| `log.md` | normalize:`## [2026-05-19] delete \| x` → `## 2026-05-19` + 下行 `- **Delete**: x`(action/detail 移入正文,**保证 entry 正文非空**) | §7 |
| concept(leading-blank) | **strip 前导空行**,使 fm 回到文件起始(**修复格式,非注入**) | §4.1 |
| concept(missing-fence) | **补开头 `---`**(**修复格式**);闭合 `---` **仅在末尾确无时补**(多数情况已存在,只补开头,避免双 `---`) | §4.1 |
| concept(正常) | 补 `timestamp`(见 §4.1) | §4.1 |
| concept(truly-none,兜底) | 注入最小 fm:`{ type: concept, title(取 H1), timestamp(取 mtime) }`;实测为 0,纯防御,与 §4.0 伪代码一致 | §4.1/§9 |
| `sources[]`/`related[]` | **保留**(§4.1 Extensions 允许) | §4.1 |

### 4.0 concept 格式判断流程(#R4,实施无歧义)
与 `validate-okf.mjs` 的 `parseFrontmatter` defect 分类严格对应:
```
if (content 不以 --- 开头) {
  if (首行匹配 key: value) → missing-fence : 补开头 ---;闭合 --- 仅在末尾无时补
  else                      → truly-none(兜底): 注入最小 fm(type: concept + title 取 H1 + timestamp 取 mtime)
} else if (--- 前有空行)    → leading-blank : strip 前导空白
else                        → 正常          : 仅补 timestamp
// 实测 English-Teaching/Invest 的 truly-none = 0,兜底为防御性
```

### 4.1 timestamp——时区语义与定位(#3/#6)

**时区语义(核实)**:`created/updated` 由 `currentWikiDate() = new Date().toISOString().slice(0,10)` 生成(`ingest.ts:1441`),即 **UTC 日期**。故派生 `2026-05-30 → 2026-05-30T00:00:00Z` **语义一致,不引入 -8h 偏移**(首轮担忧"若代表北京时间"的前提不成立)。

**已定(A):保留日期精度** → `timestamp: 2026-05-30`。理由:源数据精度是日期,产物不应比源更精确;`T00:00:00Z` 虚构了源中不存在的午夜零时。ISO 8601(§4.1.2)明确允许仅日期表示,validator 接受,无合规风险。

**注(既有行为,非本次引入)**:`toISOString` 取 UTC,北京时间凌晨(UTC 前一天)会记"昨天"。属项目既有设计,不在本次范围,但文档注明。

**定位(#6)**:SPEC §4.1 明确——`type` = **Required**;`title/description/resource/tags/timestamp` = **Recommended (in priority order)**。故 timestamp 为 **P2** 正确。注意区分:SPEC §9 conformance **只要 type**;参考实现 `OKFDocument.validate()`(`test_document.py`)把 `description`+`timestamp` 当必需属**更严格的自校验,非合规判据**。

## 5. P1 — wikilink 双写(修正 #2)

OKF consumer 从标准 markdown link 抽关系边(§5.3);`[[wikilink]]` 被忽略 → 关系图传不出去。

### 5.1 slug→path 映射(明确方案)
核实:`wiki-graph.ts:155` `fileNameToId` 仅 `fileName.replace(/\.md$/,"")`,**丢失子目录**;且 **slug 可重复**(实测 `concepts/wikilink.md` 与 `entities/wikilink.md` 并存)。故不能靠 slug 反推 path。

方案:**导出层独立遍历文件树**,构建 `slug → path[]`(数组):
- 遍历 `<bundle>/**/*.md`(排除 reserved),记录 `slug(=basename 去.md) → [完整相对路径(**相对 bundle root `<out>/`,如 `concepts/foo.md`)]`
- 不依赖 wiki-graph.ts(避免耦合 + 避开 fileNameToId 的信息丢失)

### 5.2 双写规则
- `[[slug]]` 映射**唯一** path → 追加 `[Title](/<path>.md)`(**OKF §5.1 bundle-relative absolute**,`<path>` 相对 bundle root `<out>/`,如 `/concepts/foo.md`;**不含 wiki/ 前缀**,见 §4 Bundle 结构。Title 取目标文件 fm.title 或 slug)
- `[[slug]]` 映射**多个** path(重名)→ **不双写**,保留 `[[wikilink]]`,在导出日志记录歧义。**不回退相对路径**——根源是作者意图不明而非链接形式,选任一目标都是猜;**宁可丢边,不造错边**(实测重名低频,仅 1 例 `wikilink.md`)
- `[[slug]]` 无映射(悬空)→ 不追加(§5.3 consumer 本就容忍断链,但不主动制造)
- 保留原 `[[wikilink]]` 不删(Obsidian 兼容)

## 6. 实施步骤(修正 #7,标依赖+工作量)

> 待批准,分阶段。每阶段结束跑 `validate-okf.mjs` 验证。

| 阶段 | 内容 | 依赖 | 工作量 |
|---|---|---|---|
| **P0a** | `okf-export.ts` 骨架 + 硬性转换(strip 前导空行/补围栏/index 剥 fm/log normalize/timestamp 派生) | — | ~1 天 |
| **P0b** | Tauri 命令 + 前端"导出 OKF"入口;对 English-Teaching/Invest 导出,validator 退出码 0 | P0a | ~半天 |
| **P1** | slug→path[] 索引 + wikilink 双写;validator `--soft` §5 link warn 清零 | P0a | ~1 天 |
| **P2** | (可选)description 派生(body 首段)、resource(资源类) | P0a | ~半天 |
| **Test** | 单元测试:leading-blank/missing-fence 修复、log normalize、悬空/重名 wikilink;复用 fixture 作样本 | P0a/P1 | ~半天 |
| **Docs** | README "OKF 导出"章节 + okf_version 说明 | P0b | ~1 小时 |

> **并行机会**:P0a 的"ingest sanitize 根治"(补 strip-leading-blank + ensure-opening-fence 到 `sanitizeIngestedFileContent`)可与导出层并行——根治后新摄入页面原生合规,导出层仅兜底历史数据。建议作为独立小任务。

## 7. 验证方法(修正 #4)

- **硬性合规**:`node scripts/validate-okf.mjs <导出目录>` → 退出码 0
- **软性质量**:`--soft` → §5 link warn = 0
- **log soft 补充(#4)**:normalize 后须保证每个 log entry 正文非空(已纳入 §4 规则)。当前 validator 仅硬性 C3b 检查;可扩展 `--soft` 增"空 entry"检测作为额外防线(可选)。
- **log 测试用例(#T3)**:Test 阶段取 English-Teaching 的 `log.md` 作输入,断言 normalize 后每个 `## YYYY-MM-DD` 条目正文均为非空字符串(非仅空白字符)——验证 §4 normalize 不产生空 entry。
- **真实抽样**:导出产物丢 OKF 官方 visualizer(`enrichment_agent visualize`),确认关系图正常、节点非孤立
- **回归**:`npm run test:mocks` 全过(导出层零侵入)

## 8. 风险与回滚
- **风险低**:导出层只读转换,源无损;最坏=导出产物不合规,重跑即可。
- **slug→path 重名**:不双写 + 日志标记,避免错误链接(§5.2)。
- **log normalize 信息**:action/detail 移入正文(§7 entries 是 prose),§7 允许。
- **timestamp 时区**:选(A)日期精度最稳妥,不涉时区争议。
- **回滚**:导出层独立模块 + 命令,删除即回滚;零侵入主流程。

## 9. 附:OKF v0.1 硬性合规判定(已实现在 validate-okf.mjs)
```
C1  非保留 .md 的 frontmatter 在文件起始(§4.1 at start)——诊断区分 leading-blank/missing-fence/none-at-all
C2  frontmatter 含非空 type
C3a index.md 不含 fm(仅 bundle-root 可 okf_version)
C3b log.md ## 标题为纯 YYYY-MM-DD
—— 全过 = CONFORMANT;consumer 对其余一切 MUST NOT 拒绝
```
