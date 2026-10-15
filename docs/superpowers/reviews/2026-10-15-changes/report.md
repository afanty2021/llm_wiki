# LT 师训语料库 10-15 QC 收官战役评审报告（max 强度）

> **评审元数据**
> - 评审日期：2026-10-16 02:25（定时任务 `automation-f0586011`，用户 10-15 交办）
> - 评审范围：`84585b4..58b1257`（2026-10-15 全部工作，8 提交，11 文件，+695/-198）+ 当时的未提交工作区状态
> - 评审方式：requesting-code-review 技能 → 独立评审子代理（general-purpose），逐文件通读全部代码 diff、数据 JSON 用 jq 结构化核验、允许范围内单测实跑（whisper 34/34、transcriber 221/221 全绿）；live PG 未触碰、未运行任何写库脚本
> - 评审结论：**With fixes**（无 Critical，3 Important，8 Minor）

范围 `84585b4..58b1257`（8 提交，11 文件，+695/-198）。代码 diff 全量通读；数据文件 jq 核验；whisper/transcriber 单测实跑（34/34、221/221 全绿）；live PG 未触碰、未运行任何写库脚本。

## Strengths

- **media-rebuild 配对根修实现与声明一致**（`tools/transcriber/scripts/media-rebuild.ts:113-146`）：md 章头为真值（章数+floor(起点)+标题逐字节），cuts 与机械回落各按原始/剥除双数组（`parseWhisperJson(rawJson, {strip:false})` / 默认 strip）推导取吻合，无一吻合计 problem **不静默回落**（v1 的 `loadCuts`→null→机械回落确系病灶，根修方向正确）。`--check` 零写入 / `--execute` / `--only` 三态分离，审计双落盘 `~/kb-dumps/20261015-media-rebuild-batch2/`（items.json/problems.json 实证存在）。
- **919/919 在 eec73d6 提交版本实证成立**：`git show eec73d6:...media-rebuild-report.json` → targets 919 / ready 919 / problems 0 / mediaImported 919 / pages 919（created 842 + skipped 77，与「批2 余下 842 + 批1 77」完全对账）。
- **724ae9a「14 定点重跑页面零改动」实证**：HEAD 报告 targets=14、pages 14 全 skipped、chapters semantic 14——sha-skip 幂等通道（`tools/transcriber/src/api-client.ts:306-334`，409→GET 比 sha→skipped/If-Match PUT）真实生效。
- **水印变体治本落在解析层且有真行为测试**：`tools/transcriber/src/whisper.ts` 规则①（纯 订阅/转发/栏目 ≥3 词元段丢弃）+ 规则②（剥基础词后余烬纯变体词元丢弃）+ 残余忽略标点；token 表「明镜与点点」列于「明镜与点」前（剥词按序消费，实现与注释一致）；`__tests__/whisper.test.ts:63-87` 四个新 it 覆盖变体命中/无水印兜住/混合段保留/真段零误杀——实跑 34/34 通过。
- **purgeMd 余烬链式回落是真修**（`tools/transcriber/scripts/purge-hallucinations.ts:56-77`）：变体行先过 `variantLine`，产物再串行过基础 `HALLUCINATION_SEQ`，修掉了首版短路逃逸。
- **服务端双层守卫职责划分干净**：解析层 `normalize_namespace_typo`（`src-server/src/services/ingest_pipeline.rs:155-160`）用 `strip_prefix`，边界正确——`entities/`、`entityy/`、`notes/` 均不误伤（测试 `:2819-2840` 钉死）；写层白名单 `is_llm_writable_namespace`（`:1451-1455`）与 prompt 契约（`src-server/src/services/prompts/step2_generate.txt:17` 三前缀）一致，GuardSkipped 计账与 transcripts/ 守卫同款（`:1815-1819`，紧随 transcripts 守卫之后、fetch_existing 之前）；归一化只作用于 step2 LLM 输出（`parse_file_blocks` 唯一调用点 `:2201`），无误伤面。
- **live 部署声明可验证**：pid 70747 存活、binary 构建于 10-15 23:22（=提交时点）、`strings` 命中两条守卫串 2/2。
- **去重可恢复性充分**（本机）：`~/kb-dumps/20261015-dedupe-81/` 含 7 张 bk-*.csv（pages/embeddings/ingested/media/review/learning/content3）+ `storage-losers.tar.gz` + `state.jsonl.before` + `plan.tsv`/`health.json`/`pairs.json`；裁决证据真实——health.json 每对含 `n_sigs/u_sigs`（whisper json 签数）与 `n_ref`（引用数），78 对 = 74 health + 4 ref，「引用者胜/健康侧裁决」有工件支撑；state.jsonl 78 行 `"deduped"` + error 字段指路 plan.tsv。
- **防复活在常规操作下确实成立**：cli.ts:252 `lineEligible` 对 deduped 返回 false → 落入 exhaustedRetries 跳过；media-rebuild.ts:62 / rechapter.ts:76 / punctuate-backfill.ts:67 / restore-sources.ts:31 均 `status === "done"` 过滤。
- **无凭据落盘**：SVC_PASSWORD 走 env；`out/bootstrap.env`、`out/auth.json` 已 gitignore（.gitignore:72,74）；systemone-eval 的 key 从 `~/.omlx/settings.json` 读取。
- **--ratio 向后兼容**：缺参/NaN/越界回落默认 0.15（abstract-backfill.ts:22-24），与旧常量一致；punct 快照同步复用同一 `insertAbstract(text)` 保持三工件锁步（abstract-backfill.ts:70-76）。
- **title-backfill 四写齐全**：页 upsert（自动重嵌+刷 title）→ 源 md → punct 快照同 `replaceTitle` → index 链接文本统一刷（title-backfill.ts:113-137），dry-run 零 LLM，`hit !== 1` 拒写防 frontmatter 异常。

## Issues

### Critical (Must Fix)

无。

### Important (Should Fix)

1. **`--force` 是 deduped 败者的复活通道，且 `deduped` 不在类型联合里**——`tools/transcriber/src/cli.ts:540`：`if (args.force) lines = lines.map(l => ({ ...l, status: "pending", tries: 0 }))` 无差别重置全部行；`tools/transcriber/src/whisper.ts:259` `TranscribeStatus = "pending" | "running" | "done" | "failed"` 不含 `deduped`，loadState 靠 `as StateLine` 强转放行。当前防复活完全依赖「deduped 不匹配任何分支」这一**隐式**语义——任何未来的全量 `--force` 重跑（wipe 重建场景正是它的设计用途）会把 78 个败者重转写+重摄取+重登记 media，静默撤销整个去重战役。修法：`--force` 的 map 跳过（或显式要求确认）`status === "deduped"` 的行，并把 `"deduped"` 加入 TranscribeStatus 联合、lineEligible 显式处理。
2. **f7142b3 的破坏性主战役无已提交实现，committed 脚本依赖易失的 /tmp 输入**——提交只含 91 行内容修正脚本；「删页+向量+media+ingested+open review」的执行器与「健康侧裁决」判定器均未进仓（grep 全 tools/transcriber 无 `deduped` 处理代码），仅存于 `~/kb-dumps/20261015-dedupe-81/`（持久）与 `/tmp/dedupe-sets.json`（重启即失——脚本 `dedupe-content-fix.ts:22` 读它，丢失后重跑直接 ENOENT 崩溃）。备份齐全故非灾难，但生产数据删除操作的可溯源性与脚本可复现性不应只挂在单机临时文件上。修法：把 sets JSON 与执行器快照归档进 `~/kb-dumps/20261015-dedupe-81/`（已有目录）并把脚本输入路径改指该处；或提交 sets 到 `out/`。
3. **title-backfill / abstract-backfill 多写序列无原子性，且重跑语义使漂移不可自愈**——title-backfill.ts:113-137 四写（页→源→punct→index）无 try/catch 包裹，中步抛错即整脚本崩溃；重跑时 title 已非纯数字（`/^\d+$/.test` 不命中）该 slug 被永久跳过，源 md 与页漂移无告警。**源 md 是下次 wipe-rebuild 的真值来源**（media-rebuild 从 STORAGE_TR 读 md 建页），漂移会在全量重建时复活旧标题。abstract-backfill 同款（有 catch 但重跑按「已有摘要」跳过，`:55`）。窗口小但后果是静默永久漂移。修法：writeSource/punct 失败时至少把 slug 落一份未完成清单（out/ 下 pending 文件），重跑先对账补写。

### Minor (Nice to Have)

1. **提交信息数字小差**：96919cf 称「新增 4 单测」，`git diff 84585b4..58b1257 -- ...ingest_pipeline.rs | grep '^+    fn '` 实证 **3 个**新测试函数；c027a23 称「transcriber 220/220」，HEAD 实测 **221**（全绿；差 1 无法精确对账，不采信也不反驳）。
2. **media-rebuild.ts:137 `validateCuts` 调用在 try/catch 外**——chaptering.ts:160 的 `loadCuts` 是把 validateCuts 包进 try/catch 的；v2 手工 JSON.parse 后直调，若快照是合法 JSON 但非数组（如 LLM 原始 `{"chapters":[...]}` 形态）会在 `for...of` 抛 TypeError 崩整个批。实测 920/920 快照皆数组，纯理论窗口；加一行 `Array.isArray(cuts)` 即闭合。
3. **abstract-backfill `--ratio=0.30` 等号形式不识别**（`indexOf("--ratio")+1` 取不到值）→ 静默回落 0.15，操作者可能以为阈值已生效。
4. **title-backfill 标题前缀 hardcode `Unlock 4级`**（series 判定只看 relPath 含听说/读写视频，不校验系列归属）——未来其他系列的纯数字标题会被错误冠名；dry-run 清单可人工拦截，建议 series 判定同时要求 relPath 含「Unlock」。
5. **全量 919 报告被 `--only` 14 定点跑覆盖**：HEAD 的 media-rebuild-report.json 是 targets=14 的增量版，919 全量证据只在 eec73d6 历史提交里；724ae9a 的「复验 918/919」为 --check 控制台输出，未归档，无法复核。
6. **purge-hallucinations `variantLine` 对含「明镜与点」的行统一做词元剥除**——含该串的章头行（`## [mm:ss] …`）标题文本会被剥掉（行结构保留）；真实口播含「明镜与点」的段同理。概率≈0，属已文档化的取舍，提及备查。
7. **f7142b3 的删除计数 3262/78/78/78/232 无法从仓内工件独立复核**（bk-totals.txt 六个数字 `18479,919,82187,4834,1686,142` 列语义无标注）——标「无法证实」，非认定有误。
8. **dedupe-content-fix.ts 重跑报「未找到待改内容」exit 1**——幂等但口径不友好（已改过与真异常不分）。

## 未提交部分处置建议

| 项 | 实况（已核验） | 建议 |
|---|---|---|
| `M tools/transcriber/out/manifest-summary.json` | diff 仅 `generatedAt`/`elapsedS` 两行漂移（重跑产物，实证） | **丢弃漂移**（`git checkout -- <file>`）；若想留 10-15 终态口径也可顺手提交，二选一，倾向丢弃——零信息量噪音 |
| `?? tools/systemone-eval/` | 3 源文件（make_samples.py / run_eval.py / sample_pages.sql，**无内嵌凭据**——key 从 `~/.omlx/settings.json` 读）+ `__pycache__`（已被全局 `.gitignore:95` 覆盖，不会进仓）；10-07 历史评估战役 | **移出仓库**到 `~/kb-dumps/`（结论若已落档则无留仓价值）；若要留档则提交 3 个源文件。`__pycache__` 任何情况下不得 `git add -f` |
| `?? tools/transcriber/out/abstract/` | 9 月旧产物 + 58b1257 新写快照；**未被 .gitignore 覆盖**（out/punct/ 有条目、abstract/ 没有） | **加 `.gitignore`**：`tools/transcriber/out/abstract/`——它是管线幂等复用的运行态快照（与 out/punct/、state.jsonl 同性质），不进仓 |
| `?? state.jsonl.bak-20260908-organize / -vad` | 09-08 备份，有恢复价值 | **移出仓库**（如 `~/kb-dumps/20260908-state-backups/`），可选加 `.gitignore` `tools/transcriber/out/state.jsonl.bak*` 防再生噪音 |

## Recommendations

1. 优先落 Important 1（`--force` 跳过 deduped + 类型联合补 `"deduped"`）——一行级改动，堵住唯一的批量复活通道。
2. 把去重战役的执行器/sets 归档路径固化（Important 2），`dedupe-content-fix.ts` 的输入改指 `~/kb-dumps`。
3. title/abstract 回填补一份「未完成写清单」兜底（Important 3），源 md 与页的锁步是重建真值一致性的根。
4. 顺手项：validateCuts 数组判型、`--ratio` 等号形、Unlock 系列校验、下不为例——提交信息数字与实测对账（4→3）。
5. 报告类 JSON 约定：全量跑与 `--only` 定点跑分文件落盘（如 `media-rebuild-report-only.json`），避免全量证据被增量覆盖。

## Assessment

**Ready?** With fixes

**Reasoning:** 八个提交的核心行为声明基本逐条实证成立（919/919、sha-skip 零改动、34/34 与 221/221 单测、守卫双层防与 prompt 契约一致、live strings 2/2、去重备份与裁决工件齐全），无 Critical 缺陷；但 `--force` 对 deduped 的隐式复活通道、破坏性去重实现不留仓（/tmp 依赖）、回填多写无兜底三项属于生产耐久性短板，均为小改可闭合，建议随下一批提交收口后再视为完全收官。
