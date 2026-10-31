# 2026-10-31 · lt-tutor 教案生成 + 当堂检测（CFU）技能适配方案

> 分支 `feat/ltutor-lesson-plan-cfu` · 状态：**评审收口完成**（max 评审 0C/3I/若干 Minor，3I+Minor 已全处置——收口记录见本节末）· 待施工口令
> 源仓：anthropics/k12-teacher-skills @ 2994762（v0.10.0，Apache-2.0；本地 `~/github/english/cn-k12-teacher-skills`，ghfast 代理 clone，push 指向官方——**不推**）

## 0. 背景与目标

Anthropic 官方 k12-teacher-skills 近两个提交新增了 **English (EFL, China)** 学科分支，锚定《义务教育英语课程标准（2022 年版）》。本方案把其中两个技能适配进 lt-tutor 企微通道：

| 源技能 | 能力 | lt-tutor 现状 |
|---|---|---|
| k12-lesson-plan-creation | 课标锚定教案 + 学生材料 + 观察模板，单回合产出 | 空缺（现有学案海报/思维导图/PPT 均非教学设计文档） |
| k12-check-for-understanding（CFU） | 1–3 题形成性检测，干扰项来自有记录的 Chinese EFL 学习者错误模式 + 教师判读指南 | 空缺 |

**底座替换**：原设计的 Learning Commons KG connector（美国课标图谱，本环境不存在）→ **llm-wiki MCP**（`llm_wiki_search` / `llm_wiki_read_file`，师训库 18k+ 页）。注意原设计 China EFL 路径本就写了「没有 KG，锚本文件」——课标结构化知识由技能参考文件自带，wiki 补位**教研增强层**（王蔷方法论、Think/Look 教师用书、师训视频转写、ECE/LOE 幼儿语料）。

**目标**：
1. 教师说「帮我设计一节课 / 出个教案」→ 课标锚定、活动观组织的分段教案（WeCom 文本交付），可选学生页（复用 worksheet 出图）
2. 教师说「出个当堂检测」→ 焦点确认 → 学生卷 PNG + 教师判读指南（聊天文本）
3. **零新增 MCP 工具、零网关代码改动**——纯技能文件交付
4. 版权合规：Apache-2.0 attribution + 教材语料红线

**非目标（v1 明确不做）**：
- docx / 可编辑文档输出（lesson.json + 渲染脚本机制不移植——无执行环境；`teacher_tutor_docx` 列为 v2 候选）
- 听课观察模板（教研组场景，WeCom 单教师优先级低，v2 候选）
- 分层教学（k12-lesson-differentiation）、备课伙伴（k12-lesson-prep）——按需另案
- 高中学段（LT 档案学段仅幼儿/小学/初中；2020 修订版高中课标不在参考文件范围）

## 1. 源物料与适配面盘点

### 1.1 源技能文件 → 去留判定

| 源文件 | 行数 | 去留 | 说明 |
|---|---|---|---|
| lesson-plan SKILL.md | 232 | **改编** → flow-lesson-plan.md | Steps 0–5 编排逻辑保留，输出/交互机制 WeCom 化 |
| lesson-plan references/english.md | 378 | **改编** → lp-standards-english.md | 课标知识全量保留（T1–T4 表、级别分支、section structure） |
| lesson-plan references/lesson-json.md + example_lesson.json | — | **不移植** | 多文档防漂移机制；单通道文本输出改为「一致性硬规则」（见 §4.6） |
| lesson-plan references/output.md | 142 | **精编并入** flow | brevity/everything-matches 硬要求浓缩为交付规则 |
| lesson-plan rendering/*（docx/claude-artifact）+ scripts/ | — | **不移植** | 无渲染执行环境 |
| learning-commons-kg.md ×2 | — | **不移植** | KG 不存在；Step 2 改走 wiki 检索 |
| 学科参考：lesson-plan 侧 math/ela/science/social_studies.md；CFU 侧 math.md | — | **不移植** | LT 全员英语教师，学科路由坍缩为 english 单路（CFU 侧学科参考本就只有 math.md 一份） |
| CFU SKILL.md | 175 | **改编** → flow-cfu.md | Steps 0–7 保留（含焦点确认硬门与双验证门） |
| CFU references/english.md | 146 | **改编** → cfu-english.md | 检测维度 + L1 错误映射 + 题目设计 |
| CFU references/verification.md | ~90 | **保留独立** → references/cfu-verification.md | Gate A/B 是 CFU 质量核心；**不并入 cfu-english.md**——源设计的时序防呆（SKILL.md Step 6 前「Do not open … during Step 4 or 5」，防验证门 checklist 化）原样保留，flow Step 6 才 skill_view 本文件 |
| CFU references/output.md | 251 | **部分并入** | HTML 双文件机制不移植；题面跨卷一致、无来源标注等规则并入 |

### 1.2 已核实的运行环境事实

- `skill_view(name, file_path)` 每次调用**现读盘**（`_serve_skill_file`），`linked_files` 现场扫描（skills_tool.py:653-662）→ 新增 references 文件**热生效**
- SKILL.md 正文每回合现读盘 → 快速路径表新增行热生效
- 仅 description/索引走 LRU+snapshot 缓存，新会话 prompt 构建时刷新（CLAUDE.md 硬约束 5）
- MCP 白名单 21 工具不变：教案/CFU 只用 `llm_wiki_search` / `llm_wiki_read_file` / `teacher_tutor_worksheet` / `vision_analyze`（+ `teacher_tutor_profile_get` / `record_ask`），全部已在白名单
- worksheet 六型 blocks（text/fill/boxfill/checklist/numbered/table）足以承载学生卷与 CFU 卷：选择题 = text 题干 + checklist 选项；姓名日期 = fill 行
- llm_wiki 仓 **GPL-3.0**：Apache-2.0→GPLv3 单向兼容（FSF 认可方向），改编文件保留原版权头 + 改动声明即可（见 §8）

## 2. 关键架构决策

### D1：两个新流程并入 teacher-tutor 技能，不做独立 skill

**理由**：
- 现行渐进披露架构（核心 SKILL.md 快速路径表 + references/ 按需加载）正是为此设计（09-16 拆分战役定型，流程 6–10 同款）
- 三个平行 skill 会有触发词竞争（教案 vs 学案海报 vs 练习卷），单一编排技能由快速路径表统一分流更可控——互斥关系在表内一行写清
- 免新 skill 注册；新增 references 文件热生效（§1.2），部署仅双份 cp

**代价**：核心 SKILL.md 增量 ~800B（见 §7），teacher-tutor 核心每回合全载——已计入预算考量。

### D2：底座三层——课标文件（自带）+ wiki 检索（增强）+ 教师输入（图片/口述）

| 层 | 内容 | 来源 |
|---|---|---|
| 课标锚 | 级别判定、主题范畴 T1、语篇类型 T2、语言知识 T3、学业质量编号 T4、级别分支 arcs + non-negotiables | 技能参考文件（Anthropic China EFL 分支自带，原设计即「锚本文件」） |
| 教研增强 | 王蔷方法论（活动观/单元整体教学/语篇研读实务）、Think/Look 教师用书单元建议、师训视频转写、TKT | `llm_wiki_search` + `read_file`；缩写展开规则复用核心 §2 表（think2e→Think2e-Teaching-Notes 等） |
| 教师输入 | 教材页照片（vision_analyze 转写）、老师口述主题/学情 | 复用 flow-worksheet 的图片取材经验（region 分块转写） |

**幼儿段分支**：2022 课标只覆盖 1–9 年级；幼儿段老师 → 课标不适用，底座改 wiki ECE/LOE 语料（loe→Logic of English 全家桶、ece→ECE-1000-Hours 等既有映射），教案按幼教活动设计（不套课标锚，明示依据为库内方法论语料）。

**降级路径**：wiki 检索无果 → 照常产出，教案尾注「未引用库内材料，按通用教学法设计」，**不编造来源**（与核心 §13 一致）；课标锚不受检索影响（文件自带）。

### D3：输出通道 = WeCom 分段文本 + 复用 worksheet；lesson.json 转译为一致性硬规则

原 lesson.json 是「多文档防漂移」机制（内容注册一次、各文档拉取）。单通道输出下转译为流程内**文字化硬规则**：当堂检测题、句型支架、核心词汇、语篇原文在教案与学生页（及草稿）重复出现处**逐字一致**；修订时先改「基线」再同步全部重复点 + 一致性清扫（无残留旧内容引用）。

### D4：CFU 保留两个质量硬门

1. **焦点确认门**（源 Step 3）：选定唯一 learning component → 一句话说明 + **停下等老师回复**才动工（WeCom 多轮天然支持）；老师改向则按其选择
2. **双验证门**（源 Step 6，交付前内部自检、不外显）：Gate A 每题恰一个可辩护答案（逐选择写最强辩护）；Gate B 每个干扰项是真实学生推理的落点。未过门即修即重写

### D5：来源标注两制——教案带来源、CFU 不带

- 教案流程引用 wiki 材料按核心 §4 答疑规范标注（来源+片段时间戳）
- CFU 沿用源技能 data-use guardrail：学生卷与教师指南**一律不带来源标注**（检测是给学生做的，非阅读材料）；错误模式知识内化为题目设计，不外引

## 3. 触发与分流设计

### 3.1 快速路径表新增两行（核心 SKILL.md）

| 老师说 | 调用序列 |
|---|---|
| "帮我设计一节课 / 出个教案 / 教学设计 / 明天要教 XX 怎么上 / 单元整体教学设计" | 走**流程 11**：① `skill_view`("teacher-tutor", file_path="references/flow-lesson-plan.md") ② 按其执行——骨架：读课标参考文件 → 澄清（年级/主题/教材）+ 草稿提议 → `llm_wiki_search` 教研支撑 → 分段教案（可选 `teacher_tutor_worksheet` 学生页）→ 收尾问询 |
| "出个当堂检测 / 课堂检测 / 出道题看看掌握没 / 小测一下" | 走**流程 12**：① `skill_view`("teacher-tutor", file_path="references/flow-cfu.md") ② 按其执行——骨架：读检测参考文件 → **焦点确认（停下等老师回复）** → `teacher_tutor_worksheet` 学生卷 + 聊天教师指南 |

### 3.2 互斥矩阵

| 老师表述 | 走 | 边界依据 |
|---|---|---|
| 出教案 / 教学设计 / 怎么上这节课 | 流程 11 | teacher-facing 设计文档 |
| 出学案 / 练习纸 / 知识海报 / 操练卷 | 流程 8（不变） | student-facing 操练材料 |
| 当堂检测 / 课堂检测 / 看看掌握没 | 流程 12 | 形成性诊断（1–3 题，干扰项有设计） |
| 出份单元测试卷 / 期中卷 | 不进流程 12 | CFU 非 quiz/test——如实说明只做 1–3 题形成性检测，可建议逐知识点分次做 |
| 做课件 / PPT | 流程 10（不变） | — |
| 教案里自带当堂检测 | 流程 11 内含 1 题 | 源设计同款（CFU description: lesson brings its own exit ticket）；单独要检测才走 12 |

### 3.3 description 增量（frontmatter，触发词进索引）

现行 description 末句「与师训学习无关的请求一律礼貌拒绝」前插入：
「教案生成（课标锚定的课时/单元教学设计，含学生材料）、当堂检测生成（形成性检测学生卷+教师判读指南）、」

## 4. 流程 11 详细设计（flow-lesson-plan.md）

> 外移流程文件，格式对齐 flow-worksheet.md：头部触发/身份/输出硬规则/核心节映射四行注记 + 分步正文。身份规则同核心 §0（交互不传 wecom_userid）。

| 源步骤 | 适配后 | 要点 |
|---|---|---|
| Step 0 Route | 0 触发与预读 | 快速路径表命中进入；**先 `skill_view` references/lp-standards-english.md**（未读先设计=关键失败，保留源纪律）；`teacher_tutor_profile_get` 学段预填级别范围 |
| Step 0 Connector | — | KG 检查删除（不存在） |
| Step 1 Clarify | 1 澄清 + 草稿提议（一轮发完） | 最多 2 问，优先级：①年级 ②主题/话题或语篇 ③教材版本与单元（单元整体教学必问）④课时定位。默认静默：40 分钟（初中 45）、六三学制、2022 课标。**草稿提议**：「直接出完整教案，还是先看个草稿速览？」（完整为默认）。教材信号：人教/外研/译林等；think/look 按核心 §2 缩写展开检索 |
| Step 2 Ground | 2 课标定位 + wiki 增强 | 课标：级别判定 + T1 主题定位 + T3 内容要求要素 + T4 学业质量编号（逐字引用仅一次）。wiki：`llm_wiki_search` 1–2 轮（「英语学习活动观+主题词」/「教材名+单元」/「语篇类型+教学设计」），命中 → `read_file`；引用按核心 §4 规范（来源+时间戳）。幼儿段 → 底座改 ECE/LOE 检索，不套课标锚。顺带 `teacher_tutor_record_ask`（payload.question=老师请求） |
| Step 3 Build | 3 设计构建 | 全量保留源 english.md build：语篇研读三问（What/Why/How）为起点 → 活动观三层活动链 → 教—学—评一体化（每主活动对应评价点）→ 级别分支 arc + non-negotiables → 单元整体教学 5 步结构（单元定位/内容分析/框架图/单元目标/分课时） |
| Step 4 Draft offer | 4 草稿路径 | 选草稿 → 聊天速览：课标锚一行（编号+≤10 词要义）/ ≤3 句概要 / 环节 bullet（名+分钟+一句话）/ 学生任务速览 / 前提知识 / 当堂检测。老师改动在草稿层迭代，go 后出全量 |
| Step 5 Output | 5 交付（D3） | 教案正文 WeCom 分 2–4 条（概览+研读+目标 → 教学过程 → 板书+作业+调整建议）；一致性硬规则（§D3）。学生页（二级/三级非纯听说课）：`teacher_tutor_worksheet` 出图（语篇+读中任务+当堂检测；教材语篇则指示翻书不复制）；预备级/一级听说课明说无学生页。**版权红线**：教材语篇不逐字复现——只写「版本+年级+单元+语篇标题」+ 页码/板块指示；原创语篇在级别词汇语法带内写；不假造教材板块名 |
| Step 5c Close | 6 收尾问询 | 问是否要调整 + 2–3 个具体迭代选项（如「加语言支架 / 换成你教材的单元 / 调难度」）；引用了 ≥2 个可学资源 → 按核心 §4-5 顺手建学习清单 |
| Step 5d Revisions | 7 修订 | 先改基线（检测题/词汇/支架），再同步全部重复点；一致性清扫 |

## 5. 流程 12 详细设计（flow-cfu.md）

| 源步骤 | 适配后 | 要点 |
|---|---|---|
| Step 0 Route | 0 触发与预读 | **先 `skill_view` references/cfu-english.md**（mandatory）；学科路由坍缩（无 math 分支） |
| Step 1 Clarify | 1 澄清 | 最多 1 问：年级（未 stated 且不可推断时）；语言点双义时问哪个 |
| Step 2 Ground | 2 定位 | 课标锚从 cfu-english.md（内容要求要素 + 学业质量编号）；错误模式库自带（L1 迁移映射）；可选 wiki 增强检索（常见错误/教学法），非必须步 |
| Step 3 Focus | 3 **焦点确认（硬门）** | 选最可测的 learning component → 一句话（老师的话，非术语）+ 一行理由 + 一个直接问题 → **停，等回复**。老师改向 → 其选择为锚。WeCom 上一问一答天然支持 |
| Step 4 Build | 4 构建 | 维度判定（语法运用/词汇与拼读/语篇理解/语用得体/混合）→ L1 错误→题干特征映射 → 1–3 题按维度定形式 → 干扰项：一个前提缺口 + 一个同级混淆，无两行同路由 → **asset-based language**（禁 weak/fragile/can't/struggling 等 deficit 措辞，具体化重述）。**data-use guardrail：两卷均不带任何来源标注** |
| Step 5 Output | 5 交付 | 学生卷 → `teacher_tutor_worksheet`（题干 text + 选择 checklist / 答题 fill；首块姓名日期 fill 行；题面跨卷逐字一致）；教师指南 → 聊天文本（每题正确答案 + 每干扰项揭示什么 + 三桶路由：已掌握/需巩固/需再教 → 各自下一步教学动作）。MEDIA 行回显核心 §1。**口头应答型（一级听选图/认读/口头应答）可不出图**——题面+判读全在聊天呈现，如实说明口头施测无纸面 |
| Step 6 Verify | 6 **双验证门（交付前）** | **先 `skill_view` references/cfu-verification.md（时序硬门：Step 6 前禁读本文件，防 checklist 化——源设计原样保留）**；两卷已存在才开始。Gate A：逐选择写最强辩护（内部，不外显），恰一个可辩护 → 过；多个 → 题干补名属性或删选项；零个 → 题重做。Gate B：每干扰项是真实学生推理落点（对应错误映射表），不是「明显错答案」。未过即修即重写，**不带病交付** |
| Step 7 Close | 7 收尾 | 问是否合用 + ≤2 个具体调整（换难度层 / 同焦点加一题 / 改成书面产出题） |

## 6. 参考文件设计（references/ 新增 5 件）

### 6.1 lp-standards-english.md（~350 行，改编自源 english.md）

头部 attribution + 以下内容全量保留改编（中文为主，语言内容留英文）：
- 级别判定（含五四制附注）+ 级别↔年级表（词汇量/核心语法/课外阅读量）
- 表 T1 主题范畴 / T2 语篇类型 / T3 语言知识要点 / T4 学业质量编号（一/二/三级全量逐字）
- 级别分支 arcs + non-negotiables（预备级/一级/二级/三级含 7/8/9 分年级递进）
- 单元整体教学 5 步结构（课标附录 5 案例 1 同款）
- Section structure 8 节（教学概览/语篇研读/目标重难点/学情预设/教学过程/板书设计/作业分层/调整建议）——WeCom 分段交付的节序即此
- 当堂检测 guidance（exit-ticket 等价：一级听选图/认读/口头应答；二级语境选词/句式转换/读图写句；三级语篇推断/语法运用/1–2 句书面产出；三桶）
- 学情预设 L1 迁移知识（汉语无时态变形→漏 -ed、三单漏 -s、冠词遗留、语序直移、语用直译等——具体化表述，非「忘加 ed」式标签）
- **替换**原「Writing lesson.json」节 → 「WeCom 学生页 worksheet 映射」：六型 blocks 如何承载语篇/读中任务/当堂检测；预备级无学生页判定

### 6.2 cfu-english.md（~180 行，改编自源 CFU english.md + output.md 精编；**不含验证门**）

- 检测维度表（component→维度→检测什么→题目形式）
- L1 错误→题干特征映射（documented errors map，构建前必建）
- 好干扰项标准 + 三桶路由框架
- asset-based language 规范 + 学生卷极简原则（只题干+选项/作答区+姓名日期，无 meta/无来源/无 next-step 语言）
- 一级中文题导语许可；口头应答型不出图判定

### 6.2b cfu-verification.md（~60 行，源 verification.md 全文改编，**独立文件**）

- 头部时序注记（源原样）：「两卷已存在、交付前才读全文；Step 4/5 期间禁读本文件——它是成品的闸门不是构建指引，早读会把验证门退化成对预设打勾的清单」；flow Step 6 才 skill_view 本文件
- Gate A（恰一个可辩护答案）：逐选择写最强辩护；四类「第二可辩护答案」复发源——①约定非事实（如因数顺序 a×b=b×a）②等价形式多帽（1/2、0.5、2/4、50%）③**陈述句选项结论对但理由各异**（选项为完整陈述句「对/错，因为…」时多个选项可携正确结论仅理由不同——仅当题干明判理由时成立）④约度/单位/精度未定
- Gate B（每干扰项=真实学生推理落点）：对照错误映射表，非「明显错答案」

### 6.3 flow-lesson-plan.md / flow-cfu.md（§4/§5 的正文，各 ~60-80 行）

格式对齐现有外移流程：头部四行注记（触发/身份/输出硬规则/核心节映射）+ 分步正文 + 失败回退（检索无果降级话术、worksheet 环境性失败改发文字版勿重试刷屏——复用 flow-worksheet 经验）。

## 7. 核心 SKILL.md 增量改动

| 处 | 改动 | 量 |
|---|---|---|
| frontmatter description | §3.3 插入句 | +60B |
| 快速路径表 | +2 行（§3.1） | +540B |
| 流程指针 | 新增 §13 流程 11 / §14 流程 12（一行式，同 §8–§12 惯例）；原 §13 通用回复规范 → §15（正文内无对 §13 的既有引用，重号安全） | +200B |
| 工具白名单 | **不动**（21 个不变；llm_wiki_search 行缩写展开规则被流程 11/12 复用） | 0 |
| dry-run.md | 增补脚本（§11） | — |

合计 ~+1.3KB → ~25.0KB（现 23,678B；快速路径两行含 CJK 三字节字符，评审实测口径）。核心每回合全载，此增量可接受；**记档**：下次核心再膨胀时优先考虑快速路径表外移。

## 8. 版权与合规

1. **Apache-2.0 → GPL-3.0 仓**：单向兼容（FSF 认可）。lp-standards-english.md 与 cfu-english.md 头部保留：
   `Copyright 2026 Anthropic, PBC · Copyright 2026 Learning Commons · SPDX-License-Identifier: Apache-2.0`
   + 改编说明行（源自 anthropics/k12-teacher-skills@2994762，本仓改动：WeCom 流程适配 + lesson.json/渲染机制替换）。两 flow 文件为原创编排（引用参考文件），头注「改编自 …，Apache-2.0」。
2. **目录级 NOTICE + 许可证文本副本**：`docs/superpowers/hermes/lt-tutor/` 下新增 NOTICE 文件记录第三方来源与 Commit（仿源仓先例——源 lesson-plan references/ 自带 NOTICE 文件），并 cp 源仓 LICENSE 全文为 `LICENSES/Apache-2.0.txt`（严格口径下再分发应随附许可证文本；内部部署风险低但成本近零，一并做）。仓级 LICENSE 合并声明留给上游合并时定夺——上游合并项记入 §13 开放问题。
3. **教材语料红线**：源 Copyright guardrail 全文保留改编进 flow 11——不逐字复现教材学生页文本/教师用书注释/活动叙述；不假造教材板块名；think/look 单元语篇只引用（版本+单元+标题+页码指示），原创平行文本替代并告知老师。
4. **课标引用规范**：逐字引用全文仅一次（学业质量描述或内容要求行），余处编号+短释义；教案尾注「课标依据：《义务教育英语课程标准（2022 年版）》」。
5. **ECE 语料**：CC BY-NC（CLAUDE.md 硬约束 8）——幼儿段分支只检索引用既有入库页，不新增摄取。

## 9. 实施任务分解

| # | 任务 | 产出 | 依赖 |
|---|---|---|---|
| T1 | 改编 lp-standards-english.md | references/ 新文件 | — |
| T2 | 改编 cfu-english.md + cfu-verification.md（验证门独立文件，时序防呆入头注） | references/ 2 新文件 | — |
| T3 | 编写 flow-lesson-plan.md | references/ 新文件 | T1 |
| T4 | 编写 flow-cfu.md（Step 6 才 skill_view cfu-verification.md） | references/ 新文件 | T2 |
| T5 | 核心 SKILL.md 增量（description/表 2 行/指针 2 节/§13→§15 重号） | SKILL.md 修改 | T3/T4 |
| T6 | NOTICE 文件 + LICENSES/Apache-2.0.txt 副本 + dry-run.md 增补脚本（11a–d/12a–c + 回归 1/2/4） | 3 文件 | T5 |
| T7 | 本地干跑（mock 注入法，同 dry-run 手册）+ 触发分流变异测试 | 干跑记录 | T6 |
| T8 | 评审收口后部署（§10） | live 生效 | 评审通过 |

## 10. 部署方案

1. **双份 cp**：`SKILL.md` + `references/` 全目录（含 5 新文件）**+ `NOTICE` + `LICENSES/`**（参考文件头注的 `../LICENSES/Apache-2.0.txt` 相对指针靠它落地，漏部署即悬空）→ `~/.hermes/profiles/lt-tutor/skills/teacher-tutor/`
2. **生效面**：新增 references 文件对**新 skill_view 调用**即热生效（现读盘，§1.2 已核实）；但**活跃会话驻留旧版正文与描述**——新流程要经会话轮换自然覆盖（净效果与硬约束 5 一致）；description 触发词增量对新会话 prompt 构建即时生效
3. **网关重启**：非必须；如需立即全量生效（不等会话轮换），低峰 `--replace` 重启（**避开周日 19:00–20:00 周报窗**；10-31 为周六，建议周六/周一执行）
4. **核验**：`~/.hermes/profiles/lt-tutor/.skills_prompt_snapshot.json` manifest 指向 + live 副本与仓源 diff 为空
5. **mcp-server / src-server 零改动**——无 build、无重启

## 11. 验收方案

### 11.1 dry-run 脚本（增补进 dry-run.md，沿用 mock 注入法）

| 脚本 | 输入 | 期望 |
|---|---|---|
| 11a 教案-完整包 | 「帮我设计一节五年级一般过去时的课」 | 调用序列：profile_get → skill_view(flow-lesson-plan) → skill_view(lp-standards) → record_ask → llm_wiki_search ×1–2（含「一般过去时/活动观」类查询）→（命中）read_file → 分段教案含课标锚（二级·语法知识或学业质量 2-x）+ wiki 来源标注 + **内含 1 题当堂检测（三桶判读）**；询问学生页与否或按级别判定 |
| 11b 教案-草稿 + 图片输入 | 发教材页照片 +「按这个单元出教案，先看草稿」 | vision_analyze（region 分块）→ 草稿速览（六要素）→ 等 go → 全量；教材语篇零逐字复现 |
| 11c 教材缩写复用 | 「think2e Level 2 出个单元教案」 | 检索查询含展开后的 Think2e-Teaching-Notes（验证 §2 表复用） |
| 11d 幼儿段分支 | 幼儿段档案老师「设计一节字母 S 发音的课」 | 不套课标锚；检索 ECE/LOE（loe 展开命中 Logic of English）；尾注依据说明 |
| 12a CFU 主路径 | 「出个当堂检测，七年级，第三人称单数」 | skill_view(flow-cfu) → skill_view(cfu-english) → **焦点确认消息后停**（无 worksheet 调用）→ 老师回复 → worksheet 学生卷（题干+checklist 选项+姓名日期）+ 聊天教师指南（三桶路由）；两卷无来源标注；**cfu-verification 的 skill_view 不早于交付步**（时序防呆） |
| 12b CFU 边界 | 「出张练习纸操练一下」「出份单元测试卷」 | 前者走流程 8；后者如实说明 CFU 范围（1–3 题形成性），不硬做 |
| 12c 口头应答型 | 「一年级，出一道听听指令做动作的检测」 | 判定口头应答型 → **不调 worksheet**；题面+判读指南全在聊天，说明口头施测无纸面 |

### 11.2 回归

- dry-run.md 现存脚本 1–5（1 新用户问卷+首单 / 2 答疑带来源时间戳 / 3 完成确认+进度 / 4 身份冒用对抗 / 5 周报 cron）；**学案（流程 8）等媒体流程从无 dry-run 脚本**——抽脚本 1/2/4 复跑（覆盖问卷首单、检索引用、身份硬规则三条主轴；SKILL.md 只增不改既有行，期望零偏差）
- 变异测试：临时把流程 11 表行的触发词改窄 → 「出个教案」应 miss（证分流真的靠表行）；恢复后复绿

### 11.3 观察项（上线后首月）

- 幼儿段分支检索质量（ECE/LOE 命中率）
- worksheet 版式对 CFU 卷的适配（题干+选项密度；过密被拒时按 flow 内精简规则降级）
- 教案分段消息的阅读体验（教师反馈）

## 12. 回滚

git revert 仓源两文件类提交 → 常规双份 cp 重新部署（**禁止只回写 live 副本**，CLAUDE.md 硬约束 5——并行会话例行双份 cp 会打回只回写 live 的回滚）。回滚后 description 含新增触发词的旧快照随新会话自然过期，无需重启。

## 13. 风险与开放问题

| # | 风险/问题 | 处置 |
|---|---|---|
| R1 | 「备课」类模糊表述分流准确性（教案 vs 学案 vs 课件） | 互斥矩阵措辞 + 干跑变异验证； miss 时教案/学案产出物仍可用，非安全事故 |
| R2 | 核心体积增长（23.7KB→~24.5KB） | 可接受；记档下次膨胀优先外移快速路径表 |
| R3 | worksheet 承载 CFU 卷的排版密度 | flow 内精简规则（复用「内容过密会被拒」经验：每卡 2–3 块、checklist 选项 ≤10 字） |
| R4 | T4 学业质量编号表引用逐字准确性 | T1 改编时对照源文件逐表校对（干跑抽查课标锚） |
| O1 | 观察模板 / docx 输出是否值得 v2 | 等教师真实反馈再立案 |
| O2 | 仓级 NOTICE 或 LICENSE 第三方声明段 | 本次目录级 NOTICE 足够；上游合并（AGENTS.md 拓扑）时再评估 |
| O3 | Apache-2.0 文件的快照缓存与 description 同窗问题 | 不存在——参考文件不走缓存（§1.2）；description 新会话自然刷新 |
| O4 | 高中学段请求 | 流程内明确如实告知暂不支持（LT 档案无高中学段） |

---

**评审门槛**：max 评审（跨会话传递约定：报告落 `.superpowers/ltutor-lesson-plan-cfu/report.md` 由用户转交）；Critical/Important 收口 + 施工口令后进 T1。

**收口记录（2026-10-31，评审结论=修后可开工 0C/3I/若干 Minor，续问 agent_40105975）**：§1.2 承重墙事实 6/6 全真。I-1 §11.2 回归脚本勘正（dry-run.md 实存 1–5；答疑=脚本 2 非脚本 3；学案从无 dry-run 脚本——回归改抽 1/2/4）✔；I-2 Gate A 复发源「整数判定」系 "whole statements" 误译，勘正为「陈述句选项结论对但理由各异」（§6.2b ③）✔；I-3 verification.md 不再并入 cfu-english.md，独立 references/cfu-verification.md + flow Step 6 才 skill_view，时序防呆原样保留（§1.1/§5/§6.2b）✔。Minor 全收：§1.1 CFU 侧学科参考勘正为仅 math.md；§7 量估改实测口径 ~+1.3KB→~25.0KB；§8 补 LICENSES/Apache-2.0.txt 许可证文本副本（仿源仓 references/NOTICE 先例）；§10.2 活跃会话措辞勘正（驻留旧版正文，经会话轮换覆盖）；§11.1 补 11a 内含当堂检测断言 + 新增 12c 口头应答型不出图用例。文件面变化：references/ 4→**5 件**，T2/T6 同步。

**T7 记录（2026-10-31）——11a 首跑路由截胡事故与两项环境修复**（c8249633 部署后、T7 复跑前）：

- **现象**：11a（「帮我设计一节五年级一般过去时的课」，reset 新会话，snapshot 已刷新至新版 manifest 25,222B）回复为无课标锚的通用教案。state.db messages tool_calls 实证：skill_view 加载的是**陈旧技能 `lt-teacher-tutor`**（MCP 时代旧版，9-17 建、10-05/10-10 有改），非 teacher-tutor。
- **根因 1（截胡）**：lt-tutor profile config.yaml `skills.external_dirs: [~/.hermes/skills]`（当初为共享 comfyui-image-gen 加的）把默认技能目录整目录泄进教师通道索引；`lt-teacher-tutor` 描述 48 字全显且含「内容生成/计划」，比 teacher-tutor 的截断描述更匹配「设计一节课」。核查：当前 teacher-tutor 仓源/live 对其**零路径依赖**（references/scripts 无引用），cron jobs/config 亦零引用。**修复**：config `skills.platform_disabled.wecom: [lt-teacher-tutor]`（备份 config.yaml.bak-20261031-*；get_disabled_skill_names 走 mtime+size 键控缓存 → 热生效，无需重启；平台级仅限 wecom，不影响默认 profile 自用）。
- **根因 2（触发词不可见）**：Hermes `SKILL_PROMPT_DESC_LIMIT = 60` 且按**最后一个空白**截断（agent/skill_utils.py:842-861，`_LAST_WHITESPACE_RE=\s\S*$`）——中文描述无空格，可见窗仅 23 字（「LT 师训学习助手（企业微信 lt-tutor...」）。description 中段全部触发词（含旧流程的学案/课件/听力）**从未进过路由索引**，旧流程一直靠「师训学习助手」泛匹配 + 无竞争者存活。**修复**：description 开头重排「LT 师训学习助手（企业微信lt-tutor通道专用）：答疑/学案/课件/听力/导图/教案设计/当堂检测/周报 」（尾随空格控制截断点），按源码算法模拟实证可见窗 55 字全触发词命中；尾部原文未动。SKILL.md 25,222→25,288B，双份 cp 已重部署。
- **教训入册**：①外挂目录共享是路由污染面——新增 profile 级 external_dirs 时必须盘点被泄入的技能与描述竞争；②本网关 description 路由窗=60 字符按最后空白截断，中文触发词必须前置排布并用空白锚定截点。
- **复跑**：reset 会话 → 重发 11a → 按 dry-run.md 11a 检查单核验。

**T7 记录（2026-10-31）——11a 第二跑核验 + 4 项偏差加固**（ec66e102 后，ggtms 新会话）：

- **路由与核心机制全命中**：skill_view 序序正确（body→flow-lesson-plan→lp-standards 先于内容）；课标锚四件套全（二级/T1/T3 语法行逐字=T3 表原文/T4 2-10+2-15 编号与文本核对一致/尾注依据）；内含 1 题当堂检测+三桶判读；活动观三层+评价点+分钟加总 40；L1 具体化（汉语无时态变化/疑问不倒装+过度泛化/规则类推）非标签式；版权红线（[建议]原创对话）；收尾 3 具体选项；无 wecom_userid；record_ask payload=请求原话；wiki 真检索真命中（2 search+read_file，来源=库内 entity 页←Teaching Grammar transcript）。
- **4 项偏差（均 Minor，无质量门失守）**：①课标原文逐字引用 3 处（规则=仅 1 处）②wiki 引用缺片段时间戳（transcript 有 [mm:ss] 可引未引）③学生页未随交付——二级非纯听说应同回合调 worksheet，被降级为收尾选项，且教案材料清单写了「学生页学案 1 份/人」自相矛盾 ④澄清+草稿提议未停等，直接出全文（脚本明确两回合）。
- **观察**：回复称「分三段发」实到一条——WeCom 适配器 text batch 合并所致，非 agent 过错；「2–4 条分段交付」检查项端到端不可验，记档。
- **加固（4 处一行级，2 文件）**：flow-lesson-plan Step 2 显式停等句 / Step 3 transcripts 类引用**必须**带 [mm:ss] / Step 6 学生页「与正文同回合交付，不是后续选项」+材料清单写了学案=必须出；lp-standards §4 第 1 节「仅一件带引号逐字引用，其余编号+短释义」。已双份 cp 重部署。
- **复跑**：reset 会话 → 重发 11a。

**T7 记录（2026-10-31）——11a 三跑（两回合全程）核验通过 + 2 处补强**（fd07bc98 后）：

- **两回合形态达成**：第一回合 635 字方向速览+草稿提议（课标以「2-10（用简单语句讲述）」编号+短释义出现，逐字额度未耗）+ 停等 ✓；老师答「直接出」→ 第二回合完整交付 ✓。
- **二跑 4 偏差全收敛**：课标原文恰 1 处逐字（2-10 全文）其余短释义 ✓；wiki 引用为 entity 页→按新规只写来源 ✓；**学生页同回合交付**（worksheet 7 次调用后成功，MEDIA 行独占一行，PNG 830KB/3000×2200 实体核验）✓；停等 ✓。
- **worksheet 7 次调用解剖**：3 次 -32602（text 块误用 items 字段）+3 次工具守卫拒（1332/1032px 超版心 1000px、单 section 5 块超 4 上限——守卫按设计工作）+1 次成功。schema 误用属模型侧形态混淆，密度收敛靠工具守卫反复。非「环境性失败刷屏」——均为可自愈迭代，但耗时 ~70s。
- **新发现 1 处 flakes**：教案尾部固定尾注「课标依据：《义务教育英语课程标准（2022 年版）》」本轮缺失（二跑有、三跑漏——执行不稳定）。
- **补强 2 处（lp-standards）**：§4 第 8 节后固定尾注写死「（不可省）」；§7 补块字段形态速查（text 块无 items / fill·boxfill 用 items / section ≤4 块 / 版心 1000px）防 -32602 反复。已双份 cp。
- **观察记档**：题面只在学生页、教案第 5 节末不复述（两件同回合到达，教师视角完整；教案单独流转时题面缺——接受）；分段交付仍被适配器 text batch 合并（已知基础设施行为）。
- **11a 判定：通过**（核心质量门全绿，残留 2 处补强已落盘待下轮教案类脚本自然复验）。继续 11b。

**T7 记录（2026-10-31）——11b 通过（草稿+终稿两回合全程）+ 2 处小加固**（08bf20c7 后，同会话续跑）：

- **草稿回合**：vision_analyze 整页超时→自动 region 分块重试（共 4 调用，脚本设计形态触发）✓；草稿六要素全（45 分钟九年级标准+主动给 40 重排选项）✓；停等 ✓；课标锚 三级+3-6（T4 逐字属实、短释义形态）✓；版权=版本+单元+语篇标题+1a–1f 板块指示 ✓。
- **终稿回合**：零教材原文段落（复述支架采用教材 1e 工序句=任务功能必需的句级引用，学生页明示不转录课文，记档不判罚）；草稿→终稿环节名为「加细」非改动（读中一层→读中一层·段意配对）、分钟逐字相同、检测方向一致具体化 ✓；学生页同回合交付（worksheet 1 次 schema 错后自愈，MEDIA 行独占，PNG 812KB 实体核验）✓；三层活动观+评价点+L1（汉语被动靠语境不靠形态等 3 条具体化）✓。
- **偏差（2 minor，已加固）**：①两回合均零 wiki 检索（session 复用借口不成立——换课新教案该重查）→ flow Step 3 加「每份新教案必做，会话里查过≠这课查过」；②record_ask 两回合未调 → 同处加「每条新请求都记，图片/换课/续讲不豁免」。
- **归因澄清（尾注缺失）**：本会话 lp-standards 系 13:47 加固前旧读（skill_view 会话内只读了一次），08bf20c7 尾注硬规则模型未见过——非规则失效；新会话自然生效，12 系列验证。
- **11b 判定：通过**。继续 11c（think2e 检索复用，建议新会话）。
