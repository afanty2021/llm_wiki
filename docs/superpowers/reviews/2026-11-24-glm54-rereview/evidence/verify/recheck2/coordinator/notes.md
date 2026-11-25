# 协调者亲验笔记（2026-11-25 第二轮复审）

工作区 `/tmp/glm54-recheck-20261125/C/`；脚本在 `scripts/`，原始输出在 `raw/`。live 检出与 `~/.hermes` 全程只读。

## R1（N-2 结构性根治 `e9738730` + 回归钉 `src/lib/build-form.test.ts`）

- 副本 = `git archive cb78ed06` + `cp -cR` live `node_modules`；7 个关键文件与 live 同字节。
- 原钉 4 例：R1 报的 6 个存活变异体全绿（钉实例不钉不变量，R1-I1 属实）；协调者加码的 2 个也存活：X-f1b（`pretypecheck` 钩子重建 mcp）、X-f2b（`--out-dir` kebab 写法）。无 `.git` 时原钉 1 红（M-5 属实）。
- R1 提案（A）：8/8 基线绿、杀 6 个 R1 变异体，但放过 X-f1b、X-f2b——提案自身有洞。
- 加固版（B）：8/8 基线绿、杀 6+2=8 个；只放过 X-env-web-base（相邻不变量：web 构建须同源，要对 `.env.web` 另立断言）。
- 行为：`build:web` → `dist/` web 形态 221/221 同 live；`npm run build` → `dist-desktop/` 221/221 同 live，`dist/` 0/221 变化；`vite build --outDir dist` → `dist/` 被换成桌面形态（57/249 条目变化）；变异体 e + `--mode development` → `dist/` 被桌面形态覆盖（R1 的演示复现）；`--mode web --outDir dist-desktop` → `dist-desktop/` 变 web 形态；`vite preview` 实际预览的是 `dist-desktop/`（M-6 属实）。
- npm 11.20.0：`prebuild` 先于 `build` 执行。`test:mocks` HEAD = 182 文件 / 2592 例全过（12.63s）。
- M-2 / M-3 / M-4 抽查属实（`report.md:49`、`:182`；`mod.rs:57`；`docker-compose.prod.yml:76`；`.dockerignore:15` 只有 `dist`）。
- tauri 端到端（/tmp 副本，`npm run tauri -- build --bundles app -- --offline`，`CARGO_BUILD_JOBS=6`）：rc=0，775s（冷构建）。脚本链 `tauri → build:desktop → build → typecheck && vite build`，全日志零 mcp 构建；前后 `dist` 0/221、`dist-desktop` 0/221（同字节重建）、`mcp-server/dist` 0/31、`mcp-server/node_modules` 四项快照全同；bundle `Resources/mcp-server` 四个抽样文件与检出同字节；release 二进制 64.5 MB，内嵌桌面独有资源名 28/28、web 独有 0/28；`Info.plist` 0.6.13。live 终态未变。

## R2（web-clip undici destroy 崩溃修复 `0f17695f` + note `e8ee2893` + 回归钉 `8887af93`）

- live `mcp-server/dist/src/web-clip.js` :516–517 含 once 监听器 + destroy，sha256 `f3b8562d…`；HEAD 干净构建与 live 同字节；undici 6.29.1。
- 基线 344 例 = 343 过 / 0 败 / 1 跳（生产 node 26.12.1 与本机 26.13.0 双节点一致）；net 文件 8/8。
- 全路径钉（走 `fetchWithGuards` 重定向分支，注入 `lookupAll` + `requestOnce`）：9/9 绿。
- 删监听器：net 文件 7/9，原钉与全路径钉同红（`UND_ERR_ABORTED` / `uncaughtException`）；全量 345 例 = 342 过 / 2 败 / 1 跳。
- 变体「监听器放三处调用点」：typecheck 失败（`GuardedResponse.body` 是 `AsyncIterable`，没有 `once`；TS2339 ×3）——不是可直接替换的替代修法。
- I-1 属实；I-2（技能 note「冷却 2 小时以上再试」无证据）属实：三份副本里都是推测。
- **本段更正（R4 轮，20:27）**：这里原写「两篇老链在 21:42:48 / 21:49:24 就补收成功（距崩溃约 50 分钟）」并当作反证——经会话库取证，落盘的那两篇是主会话用 `execute_code` / `write_file` 写的，不是 `web_clip` 工具收的；工具对这两条链到 21:28:32（距首撞墙 77 分钟）仍返回「这篇提不了正文…」，从未成功过。R2b 席引的同一条反证因此不成立，I-2 的结论（时长无观测支撑）不变。R2b 的 F5「不是经 web_clip 工具补收的」是对的。
- 主 stderr 日志 11-24 致命尾幅 4 条（20:51:19 / 20:51:22 / 20:51:45 / 20:52:07），lt-tutor、zops 两个 profile 为 0；此后 0 条。

## 记录疑点（交 R4 席独立核验，协调者结论不进任务书）

- `report.md:218`、`:283` 与归档 `R1.md:45–50` 写「该修复尚未加载」，依据是进程启动 20:54:05 早于 dist 重建 21:42:34。
- 协调者取证（`raw/record-loaded-timeline.txt`）：20:52:07 第 4 次崩溃后 .105 自动重拉；20:54:05.489 训练 MCP 再次启动，此前没有崩溃尾幅（是被主动更换的）；20:54:05.469 网关日志「had already exited when the call was dispatched; respawning and retrying once」；20:54:06.109 与 20:54:13.177 两次 `teacher_tutor_web_clip` 都是 completed（73 字符）而不是崩溃；修复提交 21:35:33（`web-clip.ts` +5 行）、note 21:35:38、回归钉 21:42:45。
- 协调者 19:17 的读法：22:00 时在跑的训练进程（20:54:05 起）已含有效修复，「尚未加载」是只比 dist 最后一次 mtime 得出的误判。20:53 那次构建的 dist 内容已无直接物证（被 21:42:34 的重建覆盖）。
- **定论见 R4 段**：R4 席独立判「成立（约 95%）」，协调者用会话库取证改判为「20:54:05 已加载」。上面第 4 行里的「两次优雅返回」只是线索，承重证据是 R4 段列的 URL 对账。

## 卫生预扫（`raw/hygiene-scan.txt`）

- origin = `afanty2021/llm_wiki`，PUBLIC。未推送 5 笔的新增行 1224 条：零密钥前缀、零邮箱、零手机号、零企微 userid；命中只有 `recheck/R4.md:127` 的特殊用途 anycast 段和 `recheck/R2.md:14` 的 blake2b-128 摘要。
- 评审目录既有文件：`sdk_kwargs2.py` / `sdk_resolve.py` 的 `sk-ant…`(22) / `sk-dum…`(18) 是构造 SDK 客户端探针用的占位串，且早已在 origin。
- 证据目录：git 跟踪 64 个、盘上 75 个，差的 11 个全是被 `.gitignore:44` 的 `*.log` 挡住的日志（10.3-3 仍开放）。
- 归档四席计数复算：I 5（R4-I1..5；R1-I-A 范围外另计）、M 32（9+7+6+10）、C 0，与 10.1 合计一致；10.1 表 R3 行写「0 / 0 / —」，实为 0/0/6。

## R3（03:17 周报巡检 provision 断链修复 `710111b0`）

- 席报：属实补齐后可关账，0C/2I/8M。
- I-1 属实：`auto-provision-weekly.sh:46` 原样输出任务名后缀（`wecom_teachf`），`:70` `grep -qx` 区分大小写比对 `wecom_TeachF`；live 任务 `lt-tutor-weekly:teachf` 建于 2026-09-05T10:28:09，巡检 plist 生于 09-05 10:28:17。最小修法：`:63`、`:70` 改 `grep -qix`。
- I-2 属实：标签 `wiki.ltutor-weekly-audit` 只出现在脚本自身与 `m3-gray-runbook.md`，`~/kb-ops` 零提及；`launchctl print` 该任务 `last exit code = 1`；`ai.hermes.gateway.monitor` 未加载（rc=113）。
- 承重数字全部复现：日志 19400 字节 / 380 行 / 20 趟 / 0 趟「巡检完成」/ ≤11-24 共 19 趟；日志文件生于 11-06 03:17:05；03:17 时刻的 config 备份 3 个（09-07、09-10×2），根下 `.bak-*` 26 个；任务创建 TeachA 08-21、teachf 09-05T10:28:09、TeachC 09-07T03:17:01、TeachB/TeachD/TeachE 09-10T03:17:05–06；finder mtime 2026-07-24 11:48:37、MAPPING 23 项、无 hermes_yaml；检出根可 import 顶层名 99（85 py + 14 pkg），在映射 22、不在映射 77；根名 ∩ stdlib 空。
- C7「网关 cwd=检出」不属实：网关 plist `WorkingDirectory=/Users/berton/.hermes`；`hermes_cli/main.py:44–46` 把检出根插到 `sys.path[0]`。
- 沙箱探针（HOME=假目录、HERMES_HOME=沙箱、cwd=/、-I -B，审计钩子拒绝沙箱外写入/子进程/联网/读真 `~/.hermes`）：不带修复行 `ModuleNotFoundError: No module named 'hermes_yaml'`，栈帧 `<string> → cron/__init__.py:13 → cron/jobs.py:49 → utils.py:20`，与生产日志逐帧相同；带修复行 import 成功，cron / utils / hermes_yaml 都从检出解析，从检出载入的顶层名 7 个（只有 hermes_yaml 不在映射），审计事件 0；`resolve_job_ref` 对 `…:TeachF`、`…:TEACHF` 都命中 `…:teachf`，对不存在的名字返回 False，合成 jobs.json 哈希不变。
- live dry-run 恰好一次（19:38:57，cwd=/，HOME / PATH / PYTHONDONTWRITEBYTECODE 干净环境）：rc=0，0.12s，三步全跳过，输出与席报逐行相同；前后只有 `cron/` 与 `cron/output/` 两个目录的 ctime 变化，Hermes 检出零新文件。
- 相邻发现核实并加细（immutable 只读）：六个周报任务 10-04 / 10-11 / 10-18 与 11-08 / 11-15 都是 completed + delivered；10-25、11-01 两周 completed 但 `delivery_outcome=failed`（`WeCom startup failed: WECOM_BOT_ID and WECOM_SECRET are required`，11-08 起恢复）；11-22 六个全部 failed（`HTTP 429: 已达到 5 小时的使用上限`）、`delivery_outcome=suppressed`，`cron_incidents` 六条 rate_limit 停在 detected、`alerted_at` 全空，此后无补跑。
- 席报「未能核验 4」（那位教师的周报是否送达）已解：profile `agent.log` 有 8 条 `delivered to wecom:teachf`（09-13 带 message_id；09-20、09-27、10-04、10-11、10-18、11-08、11-15），任务名大小写差异不影响投递。
- 席报内部小不一致：Q10-8 写根下备份「20 个」，终态表与实测都是 26。
- 协调者副作用：首轮用 `mode=ro` 打开 WAL 库 `executions.db`，在 live `cron/` 目录短暂生成 `-wal` / `-shm` 并刷新目录 ctime；三分钟后已不在（清单与开工快照一致），库文件 mtime / 大小未变；未做任何删除。此后改用 `immutable=1`。
- 协调者脚本已知瑕疵：`MAPPING 目标不存在的` 一行是假标记（模块目标不带 `.py`，与席报登记的同类瑕疵相同）；`根名 ∩ site-packages 顶层` 里的 `hermes_agent` 来自 dist-info 目录名的切分，不是可 import 名。

## R4（记录 `7b6da1d6` + `report.md` 权威账目 + 10.7 + 成文防线 `300c3771` / `e9738730`）

- 席报：属实补齐后可关账，0C/5I/10M。评审窗口 19:31:07–20:11。
- I-1 属实：`:49` / `:179` / `:182` / `:184` / `:185` / `:242` 六处现在为假或过时未标。事实核对：`300c3771`（11-25 08:38:44）、`e9738730`（10:23:40）在位；`414e4d1e`（11-24 18:49:06）与 `cc377bb3`（18:49:00）都是 origin/main 的祖先；`origin/main..HEAD` 恰 5 笔。席报承重清单第 1 条的命令自身有瑕疵：模式「丢失风险窗口敞着」对不上原文「敞开着」，漏了 `:184`、误中 `:31`（I-1 条目里的「title 清洗截断 + 回执净化」）；六处原文协调者逐行看过。
- I-2 属实：`2da13543a3^` = `084986d85f`，`2da13543a3^^` = `48fd4fb495`（= main = origin/main）。错误括注在 `report.md:209` 与 `n3-stale-docs.txt:101`，源头是首轮归档 `R4.md:211`。等价性：`084986d85f` 只动 `pyproject.toml` 一个文件（7+/1−），21 个路径的 blob 不变。
- I-3 属实（变异实跑：`scripts/r4-nail-verify.py`，输出 `raw/summary-r4.txt`）：R4 的 M-g / M-h 与 R1 的 f2 / f4 是同一对；M-k（`build:desktop = npm run build -- --mode web`）原钉 4/4 绿存活；M-l 被原钉杀。协调者上一轮的加固版 B 也放过 M-k 与 4 个同族透传变异体。再加固版 C（`expand` 带回 `npm run x -- <透传参数>`、桌面链禁 `--mode web`、`.env.web` 同源断言，全文在 `nails/build-form.hardened.test.ts`）10 例基线绿，18 个变异体全杀；原钉存活 15/18、B 存活 7/18。副本终态 7 个文件与 live 同字节。
- I-4 属实：`mcp-server/dist` 31 个文件 mtime 全是 05:31:03，`dist/index.html` 是 08:48:45；`report.md` 与 `n2-structural-fix.txt` 都没有记 05:31:03 那次 live dist 重建（grep `05:31|08:48|mcp:build` 只命中 :284 / :323 / :327 与证据文件 :21 / :83）。协调者只能确认时刻与账目缺位，不能确认这两次写的发起方。
- I-5 属实：R1-M5（首轮归档 `R1.md:78`）、R1-M9 的 `kebabSlug`（`:99`）、R1-M7 的 CHANGELOG（`:89`）、R4-M5（`R4.md:91`）、R3 的建议 R4（`R3.md:113`）都在归档里，10.3 没有；10.2 #2 自己写了「`web-clip.ts:764` 注释待随小修批改」，10.3 #4 没列。
- M-4「58 个对象未能复现」——席报的复现命令口径不对：`git log --objects` 只列各提交 diff 引入的对象（17），首轮 R3 的 58 是可达对象 `git rev-list --objects '26692c43b9..370956b3aa' '^upstream/main'`；协调者复算 = 58 = 26 blob + 29 tree + 3 commit，与首轮归档 R3 的拆分逐项相同。首轮 R3 的数字成立。
- M-2 属实：`git show --stat 7b6da1d6` 动了三份证据文件（`coordinator-verification.md` +4、`n3-stale-docs.txt` +5、`n4-deselect.txt` +5）。M-5 / M-8 抽查属实（`mod.rs:57`、`CLAUDE.md:33`「330 用例」、`ci.yml` 2239 / 164 / 65）。
- **Q4「尚未加载」：协调者改判席报结论。** 席报判「成立（约 95%）」，首轮归档 R1 I-A 同判。两席都只比对了「进程启动 20:54:05」与「dist 最后一次重建 21:42:34」，漏了 20:53–20:54 的现场重建。证据（`raw/q4-loaded-evidence.txt`，脚本 `scripts/q4-evidence.py` 与 `scripts/q4-session-probe.py`）：
  1. 会话库（`state.db`，`mode=ro&immutable=1`，库文件 / `-wal` / `-shm` 的 mtime 与大小前后相同）：20:51:18 ×2、20:51:45、20:52:06 四次 `teacher_tutor_web_clip` 调用打的是两条老式 `__biz` 链（mid 2247494605 / 2247494610）；20:54:05、20:54:12 打的是同样两条；21:11:10 ×2、21:28:10 ×2、21:28:32 ×2、21:30:16 又是同两条。
  2. 崩前四次各杀进程一次（四条尾幅、四条 `lost its stdio subprocess`）；20:54:05 起全部优雅返回（`result="这篇提不了正文（可能已删除、需登录或付费墙）…"`，73 / 75 字符），此后零尾幅。21:11:10 与 21:28:10 四次是 `-32602: wecom_userid is required for system calls`（cron 会话没带身份，没到取回层）。
  3. 服务 20:54 之后调用的 training 进程 = 20:54:05 那次无尾幅重拉（20:53:44.598 `tool patch completed` → 三条 terminal → 20:54:05.469「had already exited when the call was dispatched; respawning and retrying once」）；此后到 11-25 05:31:42 training 无再启动。
  4. 崩溃对「重定向 + 未读 body」是确定性的（R2b 的 Q9B 12/12；协调者 R2 轮删监听器即红），未修复的进程过不了 7 次老链调用。
  5. 修复提交 `0f17695f` 正文自述「dist 已于 11-24 现场重建并随网关按需重拉生效」。
  仍无法证明的：20:54:05 时盘上 dist 的字节（已被 21:42:34 与 05:31:03 两次重建覆盖）；三条 terminal 的命令文本（agent.log 不记参数）。协调者置信度约 99%：`0f17695f` 在 11-24 20:54:05 已加载，`report.md:218` / `:283` 与首轮归档 `R1.md` I-A 的「尚未加载」是误判；11-25 05:31 的重启因此不是为加载该修复所必需（无害，且加载的是 21:42:34 的等价重建）。
- 席报自报：`git branch --show-current` ×1、`git remote get-url origin` ×1、`mcp-stderr.log` 全文件模式计数（超出两个窗口）、`ps` ×3、列 `.env*` 文件名（未读内容）、副本内 `git init`；工具调用 26 次。
- 席报承重清单里协调者未重跑的项：Q8 卫生扫描细目（协调者自己的扫描结论一致：新增行零密钥 / 零邮箱 / 零手机 / 零企微 userid）；「42 个恢复 blob 可读」「上游 AGENTS.md 15 份」首轮 R4 已复算、本轮未重做。

## R3 补记（20:25，读 `provision-teacher-weekly.sh`）

- 巡检对那位任务名大小写不一致的教师会每晚走一遍开办脚本，但脚本内三步各自幂等：① 主 config 精确路由按 `chat_id` 命中（实测 1 处）；② platforms 块已在；③ `resolve_job_ref` 不分大小写命中既有任务。所以是零写入的空转，只是日志每天报「▶ 自动开办」与「新开办 1 个」。要害在于它靠的是内层三道幂等，而不是巡检自己的判重。
- 11-26 03:17 是修复后第一次真实运行；名册里若有人 11-06 之后才完成问卷，会在这一晚一次性开办（设计内行为）。

## 加验与定稿（20:33–20:50）

- **「一处取舍」（R1 Q3-ii 与 R4 M-7-② 说法相反、都没实跑）**：`scripts/tauri-mcp-freshness.py`，输出 `raw/summary-tauri-mcp.txt`。副本 target 已暖，连打三趟：S1 不改动再打 rc=0 / 445s（应用 crate 每次重编，没有「很快的暖构建」）；S2 改 `mcp-server/dist/src/admin.js` 并新增 `PROBE.txt` 再打 rc=0 / 445s，暂存目录与 `.app` 都带上了（32 个文件、新 sha）；S3 把 `mcp-server/dist` 挪走再打 rc=1 / 8s，`failed to run tauri build script: resource path ../mcp-server/dist doesn't exist`，暂存与 `.app` 仍是上一趟的副本。结论：R1 对（缺失即报错），R4 M-7-② 不成立；残余风险是失败后旧的 `.app` 不会被清掉，发布脚本要看退出码。live `mcp-server/dist` 的 sha 前后相同、无探针文件。没有分辨的情形：只新增文件、不改既有文件时是否触发重拷（S2 两件事同时做了）。
- **回归钉矩阵定稿**（`scripts/r4-nail-verify.py`，输出 `raw/summary-r4.txt`；首轮 18 个变异体的结果留在 `raw/summary-r4-run1.txt`）：加入 `cwd: ROOT` 与 `.gitignore` 变异体后共 19 个，原钉存活 15、协调者上一轮的加固版 B 存活 7、再加固版 C 全杀（10 例基线绿）；副本 8 个文件终态与 live 同字节。
