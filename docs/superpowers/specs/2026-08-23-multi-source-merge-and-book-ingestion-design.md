# 多源累积合并 + 教材摄取流水线 设计方案

- **日期**：2026-08-23（评审修订版 r2）
- **状态**：方案评审 With fixes → 三处必修 + 两处写死已全部并入本文
- **范围**：src-server 摄取管线合并语义改造（B）+ 首批英文教学法教材摄取流水线
- **首发试点**：Learning Teaching 3rd Edition（1 本走通全链验证，通过后推其余 4 本）
- **评审记录**：.superpowers/merge-book-design-review/report.md（判定依据与逐项置信度）

## 背景与问题

LT 师训知识库（src-server，175 视频 / 1769 页）的摄取管线对同路径页面是
**后写者整体覆盖**（`upsert_wiki_page` 的 `ON CONFLICT (project_id, path) DO UPDATE SET
content = EXCLUDED.content, sources = EXCLUDED.sources ...`，
ingest_pipeline.rs:1211-1229）。批次 3 有 54 个跨批次同概念页被覆盖——后源的视频
内容替换了前源积累，同页不累积。

现在要把「教学法知识库配套书籍」5 本英文教材（Learning Teaching 3rd、TKT Course
Module 1-3、TKT CLIL、TKT Young Learners、Essential Teacher Knowledge）摄入库中，
与视频知识融合。若不先改合并语义，书章节会覆盖视频建的概念页（或反向），"书为纲、
视频为证"的融合形态无从谈起。

**已核实的关键机制事实**（设计依据，含评审修正）：

| 事实 | 出处 |
|------|------|
| embedding 刷新 = 每页 DELETE 旧 chunk + INSERT 新 chunk（事务内），content 更新必刷新；embed 失败仅 warning 不阻断 | vector_store.rs:66-97，embedding.rs:109-153 |
| ingest worker 全进程单 worker 串行（BRPOP 循环 inline await）；多 server 副本共享 Redis/PG 时无跨进程互斥（lease 字段存在但未使用）——本部署单进程，前提成立 | ingest_worker.rs:26-126 |
| reserved 三页（wiki/index、log、overview）走独立 `rebuild_reserved_pages`，不经过页写入循环 | ingest_pipeline.rs:1272 起 |
| step2 是全文单请求（`<source>` 包整段原文），无分块、无 context 降档防线、无截断检查——整书单 source 必爆上下文 | ingest_pipeline.rs:763-792 |
| 截断检查全管线只有 step1 有（warn 级）；step2/merge 均无 | ingest_pipeline.rs:454-458 |
| 语言规则：正文中文、paths/frontmatter 键/类型枚举英文、专名缩写（TKT/TBLT/IELTS）保留原文 | ingest_pipeline.rs:52-63 |
| sources 列 = JSONB 字符串数组（LLM 按 step2 prompt 约定写源文件路径，形状无校验） | migrations/003，step2_generate.txt:8 |
| web 摄取入口已有（upload → triggerIngest(paths) → 轮询），server 零改动设计；上传 path 前缀（`raw/sources/`）是**客户端约定**，server 原样拼接不强制 | web-ingest-panel.tsx；files.rs |
| 桌面 PDF 解析 MinerU 优先 / pdfium 兜底；**摄取管线**只有 pdfium 纯文本流（files.rs 文件读取端点另用 pdftotext/poppler 子进程，与本设计无关） | ingest.ts:693-726；llm-wiki-parser；files.rs:217-249 |
| MinerU 双协议：云端 = 建任务→轮询→`full_zip_url` 下载 zip；本地 mineru-api = multipart `POST /tasks`（`response_format_zip=false`、`return_md=true`）→ 轮询 `/tasks/:id` 至 completed → `GET /tasks/:id/result` 取 `results[].md_content`（无 zip；md 可能含 HTML 表格需转换）；轮询上限云端 5min / 本地 60min（模型冷启动） | src/lib/mineru.ts:698-853 |
| 本机桌面 app-state.json 17 键中无任何 MinerU 配置——先决检查大概率落"两者皆无"分支 | 评审只读核实 |
| libpdfium.dylib 已在 /usr/local/lib（server 可用 pdfium 路径） | 本机核实 |
| 集成测试 teardown SWEEPS 只覆盖 t3_/t6_/t7_/t9_ 四前缀族；rev-* 等 M1/M2 域标签**不在清理范围**（每轮净积累，mod.rs:53-56 注释明言） | tests/integration/mod.rs |
| `cargo test --lib` 真零 DB；svc token TTL 14400 三处一致；上传/摄取 API 为 Member 级鉴权（svc-transcriber 可用） | 评审核实 |
| 空/近空提取零门槛：`pages_to_write == 0` 照样 done + mark_ingested | ingest_pipeline.rs:1009-1011 |
| context_size 从 team provider 推导，无配置回退 128k；budget = size - 8000 | ingest_pipeline.rs:1126-1134 |
| transcriber api-client 已有凭证层：login/refresh 轮换 + 401 重登录 | tools/transcriber/src/api-client.ts:178-210 |

## 复用与新增边界（重复设计修正声明）

GUI 版（桌面 + web）最初的设计已含完整文档摄取。本方案**不另起炉灶**：

- **复用**：摄取入口（web-ingest-panel 同款 API 的批量脚本化）；MinerU 解析能力
  （桌面已验证的服务与协议）；server 两步管线 / 嵌入 / 图谱（零改动）；
  `llm-wiki-parser`；transcriber api-client 的凭证层（401 重登录链）。
- **有界复制**：MinerU HTTP 客户端约 100-150 行（桌面版 `src/lib/mineru.ts` 依赖
  Tauri fs 命令与 tauri-fetch，无法在 node 脚本直接复用，按其双协议独立实现，
  含 HTML 表格转 markdown）。
- **真新增**：§1 合并语义；§2 slug 对齐注入；§3 的拆章 + 桥接脚本。

## §1 写时合并（多源累积）

**触发点**：`run_ingest_job` 页写入循环（ingest_pipeline.rs:952-974）。每页 upsert 前
先 SELECT 既有行（content / sources / title / page_type / frontmatter / images）。

- **无既有行** → 原有 INSERT 路径（`upsert_wiki_page` 不变）。
- **有既有行** → 纯函数 `collision_mode(existing_sources, incoming_sources, 当前 sp)` 判定：
  - **Replace（收紧条件，评审 I2）**：`sources_set(existing) == sources_set(incoming)`
    **且** `sources_set(incoming) == {当前 sp}`（单元素恰为当前源）——这是"同源重生成"
    的唯一形态。保持现状覆盖语义，零 LLM 调用。多元素集合相等（LLM 自由引用造成
    的巧合相等）一律走 Merge——最坏是同内容融合去重，不丢数据。
  - **Merge**（其余一切情形，含集合不等、畸变输入）：
    - `content` ← 新增 `merge_pages_via(provider, language, source_path, existing, incoming)`：
      `<existing>` / `<incoming>` 两段进 prompt，输出融合版正文。
    - **失败/截断回退 = 整页走既有 `upsert_wiki_page`（评审 I1 写死）**：content、
      sources、frontmatter **均为 incoming 原样**——不是"content 回退、sources 仍
      union"（那会造成页只含 B 内容但 sources=[A,B] 的溯源失真，且 A 旧内容永久
      丢失）。回退必留 warning（含页 path 与原因）。
    - **截断防线（评审 C1，必 Implement）**：merge 调用检查 usage——
      `completion_tokens >= max_tokens` 视为失败 → 走上述整页回退；落库前断言输出
      trim 非空。**理由**：合并页逐轮单调增长必然趋近 8000 上限，截断半截
      markdown 落库后，下轮 merge 把截断版当 existing，累积内容不可恢复丢失。
    - **Provider 获取失败（评审 A-M6）**：并入同一条回退路径（整页 Replace +
      warning），不单独分支。
    - `sources` ← `union_sources(existing, incoming, 当前 sp)`：字符串数组去重保序
      并集（existing 序在前），**当前 sp 强制尾插**（评审 A-M4 写明位置）。
    - `frontmatter` ← 保留 existing，仅 `sources` 键同步为并集（markdown 视图一致）。
    - `title` / `page_type` ← 保留 existing（wikilink / 图谱锚稳定）。
    - 单条 UPDATE 落库；**嵌入收集用 merged content** → 批尾 DELETE+INSERT 自动刷新。

**自再生安全推演**：A 建页（sources=[A]）→ B 撞入 merge（[A,B]，内容含 A+B）→
A 重生成（incoming=[A]，existing=[A,B] 集合不等）→ 仍走 merge（existing 是含 B
的累积版）→ B 的贡献经合并 prompt 存续。仅"纯单源页 + incoming 恰为 {当前 sp}"
的自重生成走 Replace。

**收敛治理（评审 I-4）**：merge prompt 含紧凑指令——合并以去重为先，输出不应
显著长于较长的一版输入；重复表述合并为一条，次要细节可精简。代码侧告警：merged
长度 > existing 与 incoming 之和的 80% 时记 warning（观测页膨胀，供人工介入）。

**新 prompt** `src-server/src/services/prompts/step4_merge.txt`：
- 指令要点：保留双方全部关键事实；去重优先；结构整合；观点/表述冲突并列陈述并
  注明来源倾向；`[[wikilinks]]` 取并集；输出**纯 markdown 正文**（无 frontmatter、
  无 FILE 块）；紧凑性指令（见收敛治理）；含 `{{LANGUAGE_RULE}}` 占位符（中文
  正文、术语保英文）。
- **来源判别**：prompt 注入 incoming 的 source path——`transcripts/` 前缀即视频课、
  `raw/sources/` 前缀即上传文档（书章节），LLM 据此标注来源倾向。
- 调用参数：temperature 0.3 / max_tokens 8000 / system "You merge wiki page
  versions."；输出过 `strip_thinking` 清洗（research/synthesize.rs:10，pub 可直接
  复用；omlx thinking 残留已知坑）。

**Provider 懒获取**：job 内首次碰撞才 `provider_for_project`（provider 每 source
已有三处调用——step1 按 chunk 多调、step2、dedicated review，懒获取增益有限但零
成本），取一次存局部复用。

**不动**：transcripts/ 命名空间守卫；reserved 三页；pages API 手动 PUT 编辑路径。

**观测（评审 A-M1/A-M2）**：`IngestJobResult` 增加 `merged_pages: Vec<String>`
（**merge 页只进 merged_pages，不进 new_pages**——new_pages 保持"新插入"语义，
两列表不重叠）；worker 完成日志同步输出两计数；新字段 `#[serde(default)]`
（派生 Deserialize 兼容旧 result JSON）。

## §2 slug 对齐注入（全量启用）

**问题**：跨源概念对齐依赖 path slug 收敛。视频已建
`concepts/word-attack-skills.md`，书章节若起名 `concepts/guessing-word-meaning.md`
→ 同概念分裂成两页，merge 无从触发（path 不同不碰撞）。

**方案**：`run_ingest_job` 开头查一次
`SELECT path FROM wiki_pages WHERE project_id = $1 AND (path LIKE 'concepts/%' OR path LIKE 'entities/%') ORDER BY path LIMIT 2000`
→ 注入 step2 prompt 附加段：

> 以下概念/实体页已存在。当你生成的概念/实体页与其中某页描述同一概念时，
> **复用其 path**（知识会累积到同一页）；仅当确属新概念时才创建新 path。

- **白名单即过滤（评审 A-M7）**：SQL 的 `LIKE 'concepts/%' OR LIKE 'entities/%'`
  已是 path 白名单——手动建页（pages.rs 无 path 校验）的任意脏 path 不匹配前缀
  即不入清单。
- **cap 与 context 预算联动（评审 I3）**：step2 请求 = prompt + 清单 + step1 分析
  JSON（≤32k token）+ `<source>` 全文（≤ context_budget）+ 输出 16k。合算式：
  `清单 token ≤ context_size - 8000(开销) - 32000(step1) - 16000(输出) - source体量`。
  实测 path 约 8-12 token/行，128k context 下理论可容数千行，仍以 **2000 行硬上限**
  （LIMIT 已含）+ 截断时 prompt 注明"清单已截断"兜底。清单体量按
  `min(2000, budget/4/12)` 行取值，budget 取 provider context_size（无配置回退
  128k，ingest_pipeline.rs:1126-1134 同源逻辑）。
- 每 job 查一次，非每 source。
- 全量启用（视频重摄、书批次、未来批次全部受益）。
- 实现落点：`run_ingest_job` 查清单 → 穿透 `process_source_path` →
  `step2_generate` → `step2_generate_via`（签名增加清单参数；两处既有
  ScriptedProvider 测试调用点同步更新）。

## §3 书籍流水线（MinerU 桥接）

**决策记录**：英文书**不预翻译**——管线是"原文进、中文页出"（`ingest_language=中文`
的语言规则使然），与现有 1769 页同构。术语形态沿用现行规则（正文中文，scaffolding/
TTT/TBLT 等术语保英文）。

**路径**（`tools/books/` 新目录，四步脚本化）：

1. **拆章**（`split_chapters.py`，pypdf）：读书签 outline → 按章页区间拆 →
   ASCII 文件名（`LT-LearningTeaching-3rd/Ch05-ClassroomManagement.pdf`）落暂存目录。
   **拆分预算按 token 不按页数（评审 B-M5）**：密集教材页 350-500 词/页 ≈
   45-65k token/80 页，故目标 ≤ **40k token/章**（按字符/4 估 token），超预算的章
   二分；页数（80）仅作护栏参考。无书签的书用人工页区间表。
2. **MinerU 解析**（`mineru_parse.ts`）——**双协议分支（评审 I-1 必修）**，先决检查
   后二选一，配置显式声明走哪支：
   - **云端**：mineru.net token → 建任务 → 轮询（5min 上限）→ `full_zip_url`
     下载 zip → 解出 .md。
   - **本地 mineru-api**：multipart `POST {base}/tasks`（`response_format_zip=false`、
     `return_md=true`、`backend`/`effort`/`parse_method` 用桌面默认：
     hybrid-engine/medium/auto，`table_enable=true`）→ 轮询 `GET /tasks/:id` 至
     `status=completed`（60min 上限，模型冷启动）→ `GET /tasks/:id/result` 取
     `results[].md_content`（**无 zip**）。
     本地返回的 md 可能含 HTML 表格 → 桥接脚本实现 `convertHtmlTablesToMarkdown`
     同款转换（协议与转换均参 mineru.ts:698-853）。
3. **清洗 + 质量闸**：
   - 剥离图片引用（server 端 `parsed.images` 暂不消费，死链不如不留）；
   - 章首加来源头（书名/章节/原 PDF 路径）供 step2 引用与溯源；
   - **扫描版量化闸（评审 I-2，写死）**：`md_content 字符数 / PDF 页数 < 200` →
     该章标记不可用、**不上传**，落进报告。这是后 4 本从"试点级验收"降级到
     "复用级流水线"的守门条件（server 端对空提取零门槛——`pages_to_write==0`
     照样 done+mark，不能依赖 server 兜底）。
4. **上传 + 摄取**（`upload_and_ingest.ts`）：
   - **上传工件写死（评审上调项 9）**：上传的是**清洗后 .md 文件**；multipart
     path 字段 = `raw/sources/<书slug>/ChNN-Slug.md`。脚本内断言扩展名 .md 与
     前缀正确——server 对 path 原样拼接不校验，误传 PDF 会静默走 pdfium 纯文本
     流，MinerU 桥接白做且无报错；§1 的来源判别（`raw/sources/`=书）也全靠此
     约定成立。
   - **凭证续期（评审 I-8）**：移植 transcriber api-client 凭证层（login/refresh
     轮换 + 401 重登录，api-client.ts:178-210 已验证模式）——单本全链（解析等待）
     可能超 svc token 4h TTL，裸 token 会中途 401 断链。
   - 摄取每 job 4-6 章（短任务可 resume）。

**先决检查（实施第一步）**：MinerU 可用性——本机 8000 端口 mineru-api，或云端
mineru.net token。**已核实桌面从未持久化过任何 MinerU 配置**（app-state.json 17 键
无 mineruConfig），大概率落"两者皆无"分支 → 起本地 mineru-api（docker）或注册云
token，**先向用户确认再动**。

**发布节奏**：Learning Teaching 3rd 一本先行走通全链（拆章 → 桥接 → 摄取 →
对账 → 验收），通过后其余 4 本复用流水线。后 4 本的守门条件 = 量化闸全过 +
merged_pages 对账（人工抽验降为可选）。

## §4 部署时序（硬约束）

- **批次 4（英语教师语言学习专栏 64 视频）摄取预计 ~23:00 终态，期间不重启
  src-server**（kickstart 会杀 running job；虽有 recover_pending 重投 + 幂等 upsert
  仍浪费重算）。
- 部署窗口选 web 低使用时段并提前告知用户（评审 B-M3：重启期间 15 位教师的
  web 访问会瞬断）。
- 开发/测试先行：`cargo test --lib` 零 DB；集成测试用 **t8_ 新前缀并入 SWEEPS**
  （见 §5 测试卫生），不碰 t3_/t6_/t7_/t9_ 既有族，避免污染 live 库。
- 批次 4 终态后：release 重建 + kickstart + 验证（/logs 无异常；重摄一个 hash 未变
  source 确认 skip 正常；后续任务 result 出现 `merged_pages` 字段）。
- 可选后续（另开票，不在本任务内）：删除指定 source 的 `ingested_files` 记录触发
  重摄取，让批次 3 被覆盖的 54 页重新累积。

## §5 测试与验收

**测试卫生（评审 I-4 必修）**：新集成测试统一 **t8_ 前缀**（用户名/项目名/页 path
fixture），并把 t8_ 并入 `teardown_test_data` 的 SWEEPS 前缀族（mod.rs 内四前缀
扩为五）。**不照抄 reviews_test.rs 的 rev-* 标签模式**——那族不在 SWEEPS 内，
每轮净积累（mod.rs:53-56 注释明言的已知取舍）。

**单测（零 DB）**：
- `union_sources`：去重/保序/existing 序在前/强制含 sp 且尾插/畸容忍（非数组、
  非字符串元素、重复元素 `["A","A"]`）。
- `collision_mode`：单元素恰为当前 sp 且集合相等 → Replace；多元素集合相等 →
  Merge；无交/部分交 → Merge；重复元素畸变 `["A","A"]` vs `["A"]` → set 语义
  判 Replace（评审 A-M3）。
- prompt 渲染：`merge_prompt` 与 step2 清单注入段均无 `{{` 残留、语言规则注入、
  截断注明行为。

**ScriptedProvider 注入断言（tokio，零 DB）**：
- `merge_pages_via`：prompt 含 `<existing>`/`<incoming>` 框架 + 来源 path +
  中文语言规则。
- **merge 截断防线**：script 返回 `TokenDelta::Usage { completion_tokens:
  max_tokens }` → 函数返回 Err（回退路径由调用方测试覆盖）。
- **merge 失败回退**：script 返回 Err → 调用方走整页 `upsert_wiki_page`，
  content/sources 均为 incoming（评审测试缺口 1）。
- step2 清单注入：prompt 含既有 path 清单与复用指令；既有两处 step2 测试不回归。

**集成测试**（t8_ 前缀 + SWEEPS，live DB 安全模式）：
- 两个 source 撞同 path → 断言 sources 并集、内容双源共存、`merged_pages` 计数、
  且该页**不在** new_pages。
- 单源重摄走 Replace 回归：同 sp 重跑 → 整页替换不膨胀（评审测试缺口 3）。
- 多轮 merge 序列 A→B→A 重生成：断言 B 内容存续且无逐字膨胀（测试缺口 4）。
- merged content 嵌入刷新：断言该页 embeddings 行数变化（或 mock VectorStore
  跳过策略，二选一在实现时定）（测试缺口 5）。
- 已有 `concepts/foo.md` 时 step2 复用 path 不另建。
- §2 清单 cap 截断行为（>2000 行时注明截断）（测试缺口 7）。

**LT 试点验收标准**：
1. 每章产出中文摘要/概念页，术语英文保留（抽样比对，样本 ≥5 章）。
2. `merged_pages > 0`（书撞视频概念页——B 首秀实证）；**试点期 merged_pages
   全量人工过审**（false merge 不可回滚，评审 A-I6），通过后收窄为抽验。
3. 污染扫描 0（thinking 痕迹/占位符，沿用既有输出闸）。
4. **页数下限核对（评审 B-M4）**：每章派生页数 ≥ 1（防 step2 16k 截断静默少页），
   低于下限的章列入报告。
5. 零章被量化闸误杀（闸值 200 字符/页的命中清单人工复核）。

## 风险与回退

| 风险 | 缓解 |
|------|------|
| merge LLM 失败/截断 | 整页回退 Replace（content+sources+frontmatter 均 incoming，= 现状行为），warning 留痕；截断检测 completion_tokens >= max_tokens |
| 合并输出质量差 | prompt 约束 + temperature 0.3 + strip_thinking + 污染扫描 + 试点全量过审 |
| 多轮 merge 页膨胀 | 紧凑指令 + merged 长度 > (existing+incoming) 80% 告警 |
| merge 调用成本放大（评审 B-M2） | 整本 LT 撞 1769 页存量可能触发数百次 merge 调用，单 worker 串行拉长 job——试点实测单章耗时后再定批次大小；本地 omlx 免费仅耗时 |
| MinerU 不可用 | 先决检查前置；docker 本地起或云 token，需用户确认 |
| 书章节仍超上下文 | 拆章 40k token 预算 + 二分规则 |
| 批次 4 期间误重启 | 部署时序硬约束 + 部署前核对 ingest_jobs 终态 |
| 部署窗口 web 瞬断（评审 B-M3） | 低峰部署 + 提前告知用户 |
| 误传 PDF 绕过 MinerU | 脚本断言 .md 扩展名 + raw/sources/ 前缀 |

## 已知限制（留档，不在本任务内）

- crash 恢复窗口（merge 落库后、item_state done 前）可能导致多源页的同源重跑
  自 merge、同源双版本并列（评审 A-I4）——彻底修法是 item_state 记已 merge 的
  (path, sp)，量级不成比例，留档。
- 多 server 副本共享 Redis/PG 时跨进程无互斥（lease 未启用）——本部署单进程，
  前提成立；扩副本前需补（评审事实表补充）。
