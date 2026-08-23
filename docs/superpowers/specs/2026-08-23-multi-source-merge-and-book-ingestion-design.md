# 多源累积合并 + 教材摄取流水线 设计方案

- **日期**：2026-08-23
- **状态**：已逐节评审通过（brainstorming 流程）
- **范围**：src-server 摄取管线合并语义改造（B）+ 首批英文教学法教材摄取流水线
- **首发试点**：Learning Teaching 3rd Edition（1 本走通全链验证，通过后推其余 4 本）

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

**已核实的关键机制事实**（设计依据）：

| 事实 | 出处 |
|------|------|
| embedding 刷新 = 每页 DELETE 旧 chunk + INSERT 新 chunk（事务内），content 更新必刷新 | vector_store.rs:66-97，embedding.rs:109-153 |
| ingest worker 全局单 worker 串行（BRPOP 循环 inline await），同 project 不会并发跑 job | ingest_worker.rs:26-126 |
| reserved 三页（wiki/index、log、overview）走独立 `rebuild_reserved_pages`，不经过页写入循环 | ingest_pipeline.rs:1272 起 |
| step2 是全文单请求（`<source>` 包整段原文），无分块——整书单 source 必爆上下文 | ingest_pipeline.rs:763-792 |
| 语言规则：正文中文、paths/frontmatter 键/类型枚举英文、专名缩写（TKT/TBLT/IELTS）保留原文 | ingest_pipeline.rs:52-63 `language_rule_text` |
| sources 列 = JSONB 字符串数组（LLM 按 step2 prompt 约定写源文件路径） | migrations/003，step2_generate.txt:8 |
| web 摄取入口已有（upload → triggerIngest(paths) → 轮询），server 零改动设计 | web-ingest-panel.tsx |
| 桌面 PDF 解析 MinerU 优先 / pdfium 兜底；server 端只有 pdfium 纯文本流 | ingest.ts:693-726；llm-wiki-parser |
| libpdfium.dylib 已在 /usr/local/lib（server 可用 pdfium 路径） | 本机核实 |

## 复用与新增边界（重复设计修正声明）

GUI 版（桌面 + web）最初的设计已含完整文档摄取。本方案**不另起炉灶**：

- **复用**：摄取入口（web-ingest-panel 同款 API 的批量脚本化）；MinerU 解析能力
  （桌面已验证的服务）；server 两步管线 / 嵌入 / 图谱（零改动）；`llm-wiki-parser`。
- **有界复制**：MinerU HTTP 客户端约 100 行（桌面版 `src/lib/mineru.ts` 依赖 Tauri
  fs 命令与 tauri-fetch，无法在 node 脚本直接复用，按其 API 协议独立实现）。
- **真新增**：§1 合并语义；§2 slug 对齐注入；§3 的拆章 + 桥接脚本。

## §1 写时合并（多源累积）

**触发点**：`run_ingest_job` 页写入循环（ingest_pipeline.rs:952-974）。每页 upsert 前
先 SELECT 既有行（content / sources / title / page_type / frontmatter / images）。

- **无既有行** → 原有 INSERT 路径（`upsert_wiki_page` 不变）。
- **有既有行** → 纯函数 `collision_mode(existing_sources, incoming_sources)` 判定：
  - **sources 集合相等 → Replace**：同源重生成（如视频重转写后重摄），保持现状
    覆盖语义，零 LLM 调用。防止页面自我膨胀。
  - **集合不等 → Merge**：
    - `content` ← 新增 `merge_pages_via(provider, language, existing, incoming)`：
      `<existing>` / `<incoming>` 两段进 prompt，输出融合版正文。**失败回退
      Replace + warning**（不劣于现状，零回退风险）。
    - `sources` ← `union_sources(existing, incoming, 当前 source path)`：字符串数组
      去重保序并集，强制含当前 sp（不信任 LLM 引用的完备性）。
    - `frontmatter` ← 保留 existing，仅 `sources` 键同步为并集（markdown 视图一致）。
    - `title` / `page_type` ← 保留 existing（wikilink / 图谱锚稳定）。
    - 单条 UPDATE 落库；**嵌入收集用 merged content** → 批尾 DELETE+INSERT 自动刷新。

**自再生安全推演**：A 建页（sources=[A]）→ B 撞入 merge（[A,B]，内容含 A+B）→
A 重生成（incoming=[A] ≠ [A,B]）→ 仍走 merge（existing 是含 B 的累积版）→ B 的
贡献经合并 prompt 存续。仅纯单源页的自重生成（[A] == [A]）走 Replace。

**新 prompt** `src-server/src/services/prompts/step4_merge.txt`：
- 指令要点：保留双方全部事实；去重；结构整合；观点/表述冲突并列陈述并注明来源
  倾向；`[[wikilinks]]` 取并集；输出**纯 markdown 正文**（无 frontmatter、无
  FILE 块）；含 `{{LANGUAGE_RULE}}` 占位符（中文正文、术语保英文）。
- **来源判别**：prompt 注入 incoming 的 source path——`transcripts/` 前缀即视频课、
  `raw/sources/` 前缀即上传文档（书章节），LLM 据此标注来源倾向。
- 调用参数：temperature 0.3 / max_tokens 8000 / system "You merge wiki page
  versions."；输出过 `strip_thinking` 清洗（omlx thinking 残留已知坑，同
  research/synthesize 的防线）。

**Provider 懒获取**：job 内首次碰撞才 `provider_for_project`（无碰撞批次零开销），
取一次存局部复用。

**不动**：transcripts/ 命名空间守卫；reserved 三页；pages API 手动 PUT 编辑路径。

**观测**：`IngestJobResult` 增加 `merged_pages: Vec<String>`（additive，对账用）。

## §2 slug 对齐注入（全量启用）

**问题**：跨源概念对齐依赖 path slug 收敛。视频已建
`concepts/word-attack-skills.md`，书章节若起名 `concepts/guessing-word-meaning.md`
→ 同概念分裂成两页，merge 无从触发（path 不同不碰撞）。

**方案**：`run_ingest_job` 开头查一次
`SELECT path FROM wiki_pages WHERE project_id = $1 AND (path LIKE 'concepts/%' OR path LIKE 'entities/%') ORDER BY path`
→ 注入 step2 prompt 附加段：

> 以下概念/实体页已存在。当你生成的概念/实体页与其中某页描述同一概念时，
> **复用其 path**（知识会累积到同一页）；仅当确属新概念时才创建新 path。

- 清单 cap **2000 行**（超出按 path 序截断并注明"清单已截断"），每行约 25
  token，上限约 50k token，远小于 35B 上下文。
- 每 job 查一次，非每 source。
- 全量启用（视频重摄、书批次、未来批次全部受益）。
- 实现落点：`run_ingest_job` 查清单 → 穿透 `process_source_path` →
  `step2_generate` → `step2_generate_via`（签名增加清单参数）。

## §3 书籍流水线（MinerU 桥接）

**决策记录**：英文书**不预翻译**——管线是"原文进、中文页出"（`ingest_language=中文`
的语言规则使然），与现有 1769 页同构。术语形态沿用现行规则（正文中文，scaffolding/
TTT/TBLT 等术语保英文）。

**路径**（`tools/books/` 新目录，四步脚本化）：

1. **拆章**（`split_chapters.py`，pypdf）：读书签 outline → 按章页区间拆 →
   ASCII 文件名（`LT-LearningTeaching-3rd/Ch05-ClassroomManagement.pdf`）落暂存目录。
   单章超 80 页（约 40k token）二分。无书签的书用人工页区间表。
2. **MinerU 解析**（`mineru_parse.ts`）：每章 PDF → MinerU 任务 → 轮询 → 下载 zip
   → 取 .md。独立 HTTP 客户端（协议同 `src/lib/mineru.ts`：建任务/轮询/zip 下载，
   含本地端点 60min 与云端 5min 两档轮询超时）。
3. **清洗**：剥离图片引用（server 端 `parsed.images` 暂不消费，死链不如不留）；
   章首加来源头（书名/章节/原 PDF 路径）供 step2 引用与溯源。
4. **上传 + 摄取**（`upload_and_ingest.sh` 或 ts）：svc token（TTL 14400）走
   **现有 API**（`POST /files/:pid/upload` → `POST /projects/:pid/ingest`
   source_paths），每 job 4-6 章（短任务可 resume）。

**先决检查（实施第一步）**：MinerU 可用性——本机 8000 端口 mineru-api，或云端
mineru.net token（桌面设置里配过哪种）。两者皆无 → 起本地 mineru-api（docker）或
注册云 token，**先向用户确认再动**。

**发布节奏**：Learning Teaching 3rd 一本先行走通全链（拆章 → 桥接 → 摄取 →
对账 → 抽样人工验收），通过后其余 4 本复用流水线。扫描版（MinerU 也无法提取）
标记不可用。

## §4 部署时序（硬约束）

- **批次 4（英语教师语言学习专栏 64 视频）摄取预计 ~23:00 终态，期间不重启
  src-server**（kickstart 会杀 running job；虽有 recover_pending 重投 + 幂等 upsert
  仍浪费重算）。
- 开发/测试先行：`cargo test --lib` 零 DB；集成测试走唯一前缀 + teardown 安全模式
  （照 reviews_test.rs），避免污染 live 库。
- 批次 4 终态后：release 重建 + kickstart + 验证（/logs 无异常；重摄一个 hash 未变
  source 确认 skip 正常；后续任务 result 出现 `merged_pages` 字段）。
- 可选后续（另开票，不在本任务内）：删除指定 source 的 `ingested_files` 记录触发
  重摄取，让批次 3 被覆盖的 54 页重新累积。

## §5 测试与验收

**单测（零 DB）**：
- `union_sources`：去重/保序/强制含 sp/畸形容错（非数组、非字符串元素）。
- `collision_mode`：集合相等 → Replace；无交/部分交 → Merge。
- prompt 渲染：`merge_prompt` 与 step2 清单注入段均无 `{{` 残留、语言规则注入。

**ScriptedProvider 注入断言（tokio，零 DB）**：
- `merge_pages_via`：prompt 含 `<existing>`/`<incoming>` 框架 + 中文语言规则。
- step2 清单注入：prompt 含既有 path 清单与复用指令。

**集成测试 1 个**（唯一前缀 + teardown）：两个 source 撞同 path → 断言 sources
并集、内容双源共存、`merged_pages` 计数；已有 `concepts/foo.md` 时 step2 复用
path 不另建。

**LT 试点验收标准**：
1. 每章产出中文摘要/概念页，术语英文保留（抽样比对）。
2. `merged_pages > 0`（书撞视频概念页——B 首秀实证）。
3. 污染扫描 0（thinking 痕迹/占位符，沿用既有输出闸）。
4. 抽 3 个合并页人工评审：书定义 + 视频实例共存，无信息丢失。

## 风险与回退

| 风险 | 缓解 |
|------|------|
| merge LLM 失败 | 回退 Replace（= 现状行为），warning 留痕 |
| 合并输出质量差 | prompt 约束 + temperature 0.3 + strip_thinking + 污染扫描 + 试点人工抽验 |
| MinerU 不可用 | 先决检查前置；docker 本地起或云 token，需用户确认 |
| 书章节仍超上下文 | 拆章 80 页上限 + 二分规则 |
| 批次 4 期间误重启 | 部署时序硬约束 + 部署前核对 ingest_jobs 终态 |
