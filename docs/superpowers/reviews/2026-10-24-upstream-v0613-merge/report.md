# 上游 v0.6.13 合并评审报告（merge/upstream-v0.6.13）

- **评审对象**：合并提交 `26a3ee71d2d8dbf27e50f04f24100faf572a65a0`
- **Parent 1（fork 侧 = 当前 main）**：`9f47a6520c2cfe08227dde24756bcf180739a45a`
- **Parent 2（上游 v0.6.13）**：`e08cfce65aad8b76b13546a081c1a8d4422b70c3`
- **合并基**：`e8082119649e6a8e1cf85eaf289adcabfdf39d4e`（v0.6.11，2026-08-25）
- **评审方式**：三方逐文件对比（`git diff <parent> 26a3ee71 -- <file>` × 两侧 + 对照合并基），重点面全读，非重点面按「forkΔ 与 merge-vs-upstreamΔ 行数逐文件对账 + 抽样内容核验」覆盖；全部四个门禁本机复跑。
- **评审日期**：2026-10-24

---

## 门禁复跑结果（本机实测，非转述）

| 门禁 | 作者声称 | 本机实测 | 结论 |
|---|---|---|---|
| `npm run test:mocks` | 181 文件 / 2588 用例全绿 | **181 文件 / 2588 用例全绿**（12.5s） | 一致 ✓ |
| `npm --prefix mcp-server test` | 330/330 | **330 pass / 0 fail** | 一致 ✓ |
| 根 cargo workspace（crates/llm-wiki-parser） | 全 ok | **12 passed / 0 failed** | 一致 ✓ |
| `cd src-tauri && cargo test` | （"cargo workspace 全 ok"口径含糊） | **本机无法编译**：`lance-encoding v4.0.0` build script 调 protoc 失败（homebrew protobuf 35.1 链接的 `libabsl_die_if_null.2601.0.0.dylib` 已被 abseil 20260817.0 升级删除——本机环境损坏，非合并引入，见 Important #1） | 待作者确认 |
| `npm run build:web` | ✓ | **✓ built in 2.71s**（typecheck + vite build --mode web 均过） | 一致 ✓ |

---

## Strengths

1. **src-server 零触碰（硬不变量成立）**。`git diff 26a3ee71^1 26a3ee71 -- src-server/` 输出为空（0 行）。独立服务端完全未被本次合并波及。

2. **合并提交信息中的处置口径逐条与代码对得上，未发现"说了没做"或"做了没说"**。以下每一条都做了代码级验证（细节见各节）：
   - logger 化碰撞四文件（ingest / ingest-queue / page-merge / project-file-sync）+ deep-research / scheduled-import：合并结果 = 上游新逻辑 + 本仓 createLogger 风格。逐文件用「剔除 logger 行后的三方差」验证：这些文件 fork 侧相对合并基的 delta 本来就只有 logger 化，无功能分歧，因此"取上游 + 保留 logger"是无损的（证据：`git diff e8082119 9f47a652 -- src/lib/ingest.ts` 剔除 logger 行后无剩余功能行；`src/lib/page-merge.ts`、`src/lib/project-file-sync.ts` 同法为 0）。
   - ingest-queue 恢复语义：fork 侧 `src/lib/ingest-queue.ts` 相对合并基**确实仅 logger 化**（`git diff e8082119 9f47a652 -- src/lib/ingest-queue.ts` 全部 hunks 均为 console→logger），`restoredPausedTaskIds` 手动恢复是合并基语义而非 fork 功能——随上游移除无功能损失。合并版完整采纳上游 `blockedOnLlmConfig` 自动恢复 + LLM 未配置阻断流（`src/lib/ingest-queue.ts:1015-1030`），且 merge-vs-upstream 差只剩 logger 行。仓内残留的 12 处 `restoredPausedTaskIds` 全部在 `src/lib/dedup-queue.ts`（去重队列，上游与本次合并均 0 改动，两侧一致），不是遗漏。
   - graph-relevance：上游 `TargetResolver` 架构采纳；fork 的中文标题 fallback 以 `buildTargetResolver(nodeIds, titleIndex)` 第二参并入——**id 派生键优先**（`src/lib/graph-relevance.ts:186` `if (!aliases.has(key)) aliases.set(key, id)`，与 fork 旧版"先 id 循环后 titleIndex"的优先序语义等价）、**歧义标题整组排除**（`buildTitleIndex` `src/lib/graph-relevance.ts:211-213` `if (ids.length > 1) continue`，与 fork 旧版逐字一致）。fork 旧三条件 id 匹配（lower / lower==raw.lower / 空格归一）在新 normalizeLinkKey 单键匹配下全部被覆盖（等价性推导见评审过程，已核）。wiki-graph.test 三处调用已同步改 resolver 签名且断言原样保留（`src/lib/wiki-graph.test.ts:90-99`，含"中文裸链可解析 / 碰撞组排除 / dangling 为 null"三断言）。
   - mcp-server：write_page 并入 `desktopToolDefinitions()`（`mcp-server/src/index.ts:215`），**实测计数 desktop=12**（grep `name: "llm_wiki_` = 12）、**src-server=18**（training.ts 内 16×teacher_tutor_* + 2×llm_wiki_*）；`writePage()` 走本仓 `requestObject` 核（`mcp-server/src/api-client.ts:437-457`），上游 `request` 私有方法弃；`MAX_TEXT_BYTES` 复用 training.ts 的 `120_000` 导出（`mcp-server/src/training.ts:94`，与上游本地常量同值同义）；graph 工具的 offset/edgeScope 分页 + `formatGraph(graph)` 新签名完整采纳；计数测试两处同步更新且是**真断言**（`mcp-server/test/training.test.ts`：desktop 11→12 断言、src-server 排除清单 9→10 增补 `llm_wiki_write_page`）。
   - App.tsx（WEB-1）：上游自基以来对 App.tsx 的全部 4 个 hunks（`loadSourceWatchAllProjects` 导入、`globalOutputLang` 回退、allProjects 源监控块、`handleSwitchProject` 加 `stopAllProjectFileSync`）**全部采纳且全部落入门控内**——globalOutputLang 回退在 `caps.platform !== "web"` 块内（`src/App.tsx:530-540`）；allProjects 增强并入 `caps.canWatchFiles` 块（`src/App.tsx:607-645`）；`stopAllProjectFileSync` 为纯 JS（清定时器/置空态，`src/lib/project-file-sync.ts:136-143`），web 直调无害。合并版 App.tsx 中全部 Tauri 调用点逐个核验均有门控（clip-watcher→`canWatchClipboard`、autostart→`canAutoStart`、getLastProject/saveLastProject/getRecentProjects/clip-server→`platform !== "web"`、目录选择器→web 早退回 ProjectPicker）。上游未新增任何未门控 `invoke(` 调用（`git diff e8082119 e08cfce6 -- 'src/**/*.ts(x)'` 中新增 invoke 行数为 0）。
   - search.rs：随上游 `legacy_stem_candidates` 多候选结构（重复 stem 全排除而非任取），fork 仅改措辞的 stem 告警块弃；合并版 vs 上游只剩 `tracing::warn` 化差异（Rust 侧 logger 口径），`page_paths_by_vector_id` + 路径限定 page id + `.md` 大小写不敏感等上游新逻辑完整采纳（`src-tauri/src/commands/search.rs:345-416`）。
   - wiki-graph web 分支 meanIntraDegree 推导：**数学恒等式严格成立**。上游 `wiki-graph-analysis.ts:5-13`：`cohesion = E/(N(N-1)/2)`、`meanIntraDegree = 2E/N`（N≥2），故 `cohesion×(N-1) = 2E/N` 精确相等；两侧 intra 边计数同为**无权重去重边数**（客户端 `wiki-graph-analysis.ts:50-58` 按 key 去重计数；服务端 `src-server/src/services/graph.rs:350-360` `intra as f64 / possible as f64`，`possible = N(N-1)/2`），N≤1 时合并版显式给 0、服务端 n=1 时 possible=1 且 intra=0 → cohesion=0，同样收敛为 0。无近似误差。
   - source-watch 持久化测试：上游测试移植时补钉 `vi.mock("@/lib/capabilities", () => ({ caps: { platform: "tauri" } }))`（`src/lib/project-store-source-watch.test.ts:23-25`），理由注释准确（fork getStore 非 tauri 走 webStore，plugin-store mock 接不上）。同类钉平台手法也用在 `src/lib/__tests__/wiki-graph.test.ts:21-24`（防 vitest 非 tauri 宿主误入 web 聚合分支）——这是上游测试在 fork 双形态下的必要适配，做得对。
   - package.json：npm 11 `allowScripts`（esbuild/msw/fsevents）新增；上游 package.json/Cargo.toml 自基以来只有版本号 0.6.11→0.6.13，合并完整采纳且 fork 依赖（plugin-notification、@testing-library/react、happy-dom、pg、tsx、build:web 脚本）全部保留；**Cargo.lock 相对 fork 侧仅 13 行差异 = 自身版本号字段，零依赖变动**。

3. **上游六大主题完整落地**（merge-vs-upstream 差剔除 logger/门控后为空的文件即"上游全量采纳"）：MinerU 4 V1 API（`src/lib/mineru.ts` merge-vs-upstream 仅 logger 两行：uploads/complete 会话、redirect 手工跟随、V1 tier 映射全量在）、摄取输出边界（`llm-client.ts` 的 `StreamCompletion`/finish_reason/`isTokenLimitFinishReason` 截断检测 + `ingest.ts` 三处 `onDone: (completion) => { ...truncated }` 消费）、write_page（Rust 端点 + api_server.rs body_limit 适配 + MCP 工具全链）、断点续传（`ingest-queue.ts` blockedOnLlmConfig + `cbd1717b` 恢复中断生成）、图谱扩展性（api_server.rs graph offset/edgeScope/hasMore、wiki-graph-analysis O(E) intra 计数、graph-relevance 16 并发读 + 双图 LRU 缓存、`clampUserConcurrency` 64 上限）、源监控（allProjects 扫描 + statCache 快路径 scheduled-import）。

4. **i18n 四语言零漂移**：en/zh/it/ru 各 1103 键、键集完全相等；上游新增 10 键全部在合并版、上游删除键无残留。fork 专属键（logs/okf-export 等）未丢。

5. **README 无 fork 资产损失**：fork 的 README 四语改动（pdfium-render 措辞、Azure/MiniMax provider 清单、搜索评分描述）在合并版保留（`README.md:326,372,390,393`）；fork 从未在 README 中记载 src-server/web/mcp 形态（fork parent README 中 src-server 引用数为 0），fork 专属文档在 AGENTS.md/docs/（上游不可见），上游 README 重写无覆盖损失。

6. **fork 高风险面全部存活**（按 forkΔ 行数逐文件对账：每个表面文件 merge-vs-upstreamΔ 行数与 forkΔ 行数严格相等，且抽样内容核验一致）：wiki-page-resolver 的 `buildProjectPathIndexFromPagePaths/FromStoragePaths`（web 路径索引）、wiki-store 的 `pageTitleByPath`/`setProjectPathIndexFromPaths`、settings-view 的桌面专属 section 门控、preview-panel 的 saveError 持久错误条、fs.rs 的 trace_id `#[instrument]` 链、lib.rs 的 send_log/get_log_files/clear_logs 日志命令、api-client 的 ApiForm/ApiNotFoundError/ApiHttpError/upsertPage If-Match 重试链、chat-panel 的 WEB-1 终审 round3 门控（`useBackendAgent = caps.platform === "tauri" && ...`，`src/components/chat/chat-panel.tsx:785-788`）。

---

## Issues

### Critical (Must Fix)

**无。** 全部 fork 不变量验证通过，未发现静默丢弃任一侧语义的冲突解决。

### Important (Should Fix)

1. **src-tauri workspace 测试在评审机无法运行，作者声称的"cargo workspace 全 ok"无法在本机复核——需作者确认 src-tauri 侧测试确实跑过且在合并提交上通过**。
   - 现象：`cd src-tauri && cargo test` 在 `lance-encoding v4.0.0` build script 处失败——protoc(35.1) 动态链接的 `libabsl_die_if_null.2601.0.0.dylib` 随 homebrew abseil 升级（20260817.0）消失。**这是本机工具链损坏，不是合并问题**：`git diff 9f47a65 26a3ee71 -- src-tauri/Cargo.lock` 仅 13 行（llm-wiki 自身版本号 0.6.11→0.6.13），依赖集零变动——同样的失败会在 fork parent 上复现。
   - 为什么仍要提：本次合并的 Rust 表面（search.rs / api_server.rs / fs.rs / lib.rs / vectorstore.rs / claude_cli.rs / codex_cli.rs / file_sync.rs）改动虽以 logging 为主，但含 `vectorstore::search` 新参数、api_server.rs 新端点等接口面变化，TS 编译器管不到 Rust；若作者当时也被此环境问题挡住而只跑了根 workspace（根 Cargo.toml `exclude = ["src-tauri"]`，根 workspace 只含 crates/llm-wiki-parser，12 个测试——"cargo workspace 全 ok"若指根 workspace 则完全没覆盖 src-tauri），则 src-tauri 侧自合并基以来的上游 Rust 改动（约 5000 行）实际无测试验证。
   - 修复：合并前在 protoc 环境正常的机器（或 `brew reinstall protobuf` 后）跑 `cd src-tauri && cargo test` 确认；同时建议把 AGENTS.md 的 cargo 门禁口径写明确（根 workspace 与 src-tauri 是两个需分别跑的 workspace）。

### Minor (Nice to Have)

1. **import 语句位于使用行之后（两处）**：`src/lib/mineru.ts:8-9` 与 `src/lib/deep-research.ts:16-17` 均为
   ```ts
   const logger = createLogger("mineru")
   import { createLogger } from "@/lib/logger"
   ```
   ESM import 提升语义下运行时正确、tsc 也接受，但违反 import 置顶惯例；一旦未来开 eslint `import/first` 会挂。顺手把 import 挪到文件头即可。

2. **web 分支 streamViaServer 不上报 StreamCompletion（finishReason/truncated）**：`src/lib/llm-client.ts` web 通路（约 :666、:669）调用 `onDone()` 不带 completion 对象，而桌面通路已带 `{ finishReason, truncated }`。当前无实际影响——`truncated` 的唯一消费方是 ingest.ts（web 摄取走服务端不经此路径），chat-panel 不消费该字段；但若日后 chat UI 想显示"输出被截断"提示，web 会永远沉默。可留 TODO 或在 web 通路补 `streamFinishReason` 解析。

3. **提交信息中"54 文件冲突面 / 18 冲突"计数与实测有出入（记录性）**：merge 与双亲均不同的文件交集实测 61 个（`comm -12` 双向 diff 文件名）；"18 冲突"无法在不重做合并的情况下独立复核（重做会改工作树，评审未执行）。对合并正确性无影响，仅口径记录差异——若后续有人按提交信息复盘，注意以此为准。

4. **任务/文档中"根 cargo workspace = src-tauri + crates"的描述与实际不符**：根 `Cargo.toml` `members = ["crates/llm-wiki-parser"]`、`exclude = ["src-tauri", "src-server"]`。非本次合并问题，但会误导后续评审/CI 设计（见 Important #1 的关联建议）。

---

## Recommendations

1. **合并前必做**：在 protoc 正常的环境跑一次 `cd src-tauri && cargo test`（Important #1）。这是唯一未闭环的验证面；通过后即可合入。
2. 顺手修两处 import 位置（Minor #1）——一行改动，避免 lint 后账。
3. 建议在 AGENTS.md 把 cargo 门禁写成两行：「根 workspace（crates/llm-wiki-parser）`cargo test --workspace`」+「Tauri 应用 `cd src-tauri && cargo test`」，消除歧义。
4. 可选：给 streamViaServer 补 finishReason 解析或在代码注释中记明"web 通路暂不上报 truncated"的消费方前提（Minor #2），防止未来 chat 截断提示上线时踩坑。
5. 无需重跑其余门禁——本机已复跑且与声称完全一致（2588/330/12/build:web ✓）。

---

## Assessment

**Ready to merge?** With fixes

**Reasoning:** 18 处冲突处置与提交信息口径逐条对得上，全部 fork 硬不变量（src-server 零触碰、WEB-1 门控、mcp-server 12/18 工具、中文标题 fallback、meanIntraDegree 恒等推导）经代码级与数学级验证成立，四个门禁中三个加 build:web 本机复跑全绿；唯一未闭环项是 src-tauri workspace 的 cargo test 因评审机 protoc/abseil 环境损坏无法复核（依赖零变动证明非合并引入），合并前在正常环境补跑确认即可。

---

## 收口附录（2026-10-24 同日，协调会话执行）

### Important #1 复核 → 升级为 Critical，已修复闭环

补跑方式：评审机 protoc 失配系 homebrew protobuf 35.1 链接旧 abseil dylib（2601.0.0）而 abseil 已升 20260817.0（2608.0.0）——brew 包失配、非合并问题。绕过：下载 protobuf 官方静态二进制 protoc 35.1 至 /tmp，`PROTOC=/tmp/protoc-351/bin/protoc cargo test`（零系统侵入；机器根治待 `brew upgrade protobuf`）。

**补跑即抓到真实 Critical**：`llm-wiki` (lib) 编译失败——

- `src-tauri/src/commands/page_embedding.rs:320`（合并版）按上游旧签名 2 参调用 `vectorstore::vector_delete_page`，而合并版 `vectorstore.rs:692` 是 fork 侧 8463d2dd 加的 3 参签名（`trace_id: String`，纯日志关联用途）。
- **定性：git 自动合并的跨文件语义冲突，非冲突解决失误**。page_embedding.rs fork 侧自合并基以来 Δ=0（`git diff e8082119 9f47a652 -- …/page_embedding.rs` 为空），该文件从未进入冲突清单；上游 v0.6.13 重写它（`ensure_unique_page_stem` 拒绝同 stem → `vector_page_id` 路径限定 id + `remove_legacy_vector_id_if_safe` legacy 清理，属上游自家设计演进、无 fork 资产丢失），文本层干净合入，类型层与 fork 改过的 vectorstore.rs 签名炸裂。rustc 是此类断裂的唯一门卫，而根 workspace `exclude = ["src-tauri"]`，当时「cargo workspace 全 ok」从未编译过 src-tauri。
- **修复**（d86b93ef）：调用点补 `format!("page_embedding:{page_id}")` 第三参。最小改动，`eprintln!` 保留上游原样（该文件非冲突文件，不适用 logger 化口径；记 Minor 级观感项）。

### 补跑结果（修复后全量）

`cd src-tauri && PROTOC=/tmp/protoc-351/bin/protoc cargo test`：**476 passed / 0 failed / 2 ignored**，EXIT=0。编译器全程扫描无第二处类型级断裂。

### 「整取一侧」型隐性冲突系统扫描（新增验证）

对 58 个真冲突文件（基→fork 与 基→upstream 双侧都改过）逐个检测合并结果是否与某一单侧逐字节相同（= 静默整取、从冲突面清单隐身）：**零命中**。全部为合成解决，均在正文的冲突面覆盖内。

### 存量噪音记档（非合并引入）

- `src-tauri/src/logging/mod.rs:10` unused imports 警告（`LogDisplayEntry`/`LogLevel`）：logging/ 目录合并零触碰，fork 存量噪音。
- AGENTS.md「根 workspace = src-tauri + crates」描述与实际（members 仅 crates/llm-wiki-parser，exclude src-tauri/src-server）不符——建议改为两行分列口径（正文 Minor #4 维持）。

### 更新后结论

**Ready to merge? Yes（d86b93ef 收口后）**

**Reasoning:** 评审全部发现在 d86b93ef 收口：唯一 Critical（src-tauri 编译断裂）已修复且 476/0/2 全绿，Minor 4 项均为记档级。并 main 后按既定约束执行 `npm run mcp:build` + Hermes 网关重启。
