# glm-5.4 重评报告：两仓近期变更（2026-11-24，含核验轮更新）

> **评审方式**：定时任务自动执行（11-24 01:45 触发，01:47 预检，02:17 收官）。协调者并发派发 6 个独立评审子代理（W1-W4 仓 A / H1-H2 仓 B），每个子代理先独立评审、再逐条核对前轮 glm-5.3 报告的承重声明、最后找前轮漏掉的问题；协调者对全部 7 条 Important 逐条亲手重验（命令实跑或读码对到行）。
> **核验轮**（11-24 07:30–13:00，用户口令「report.md 中未核验清单要进行核验，授权跑真实脚本」）：六份子报告的未核验清单已逐项核验，结果见 §五；新发现 N-1…N-6 并入 §二；证据在 evidence/verify/（[coordinator-verification.md](evidence/verify/coordinator-verification.md)、[hermes-verification.md](evidence/verify/hermes-verification.md)、[ltutor-text-verification.md](evidence/verify/ltutor-text-verification.md)、[integration-verify.md](evidence/verify/integration-verify.md)、raw/）。
> **基线**：仓 A llm_wiki main=`06a9315c`；仓 B Hermes-agent lt-tutor-vendor-patches=main=origin/main=`48fd4fb495`。评审与核验两轮全程零 git 漂移，两仓零改动。
> **子报告**：同目录 [W1.md](W1.md) [W2.md](W2.md) [W3.md](W3.md) [W4.md](W4.md) [H1.md](H1.md) [H2.md](H2.md)。

---

## 一、各单元裁决表

| 单元 | 范围 | 裁决（核验后） | 凌晨 C/I/M | 核验轮新增 | 核验后 C/I/M |
|---|---|---|---|---|---|
| W1 lt-tutor 教案+CFU | `ccd14303..06a9315c` + live 漂移 | **With fixes**（漂移回仓 + dry-run 11a 判据须先修） | 0/2/9 | +2 Minor（N-5 dry-run mock 陈旧、N-6 防熔断动机过时） | 0/2/11 |
| W2 上游 v0.6.13 合并 | `9f47a652..ccd14303` | **With fixes**（代码可并维持；live web 部署态须修 N-2） | 0/1/3 | +1 Important（N-2） | 0/2/3 |
| W3 teacher_tutor_web_clip | `816549bb..9f47a652` | **With fixes → 须先修 N-1**（修好前不宜让教师使用） | 0/1/6 | +1 Critical（N-1，功能级） | 1/1/6 |
| W4 10-15 语料质检批（收窄） | `eec73d6f^..816549bb` | **With fixes** | 0/1/6 | 无 | 0/1/6 |
| H1 Hermes 三次上游合并+钉版 | v0.22.5/v0.22.7/v0.23.0 三场 | **Yes** | 0/0/4 | +1 Minor（N-4 分歧红未机械登记）；M-3 举例勘正 | 0/0/5 |
| H2 Hermes fork 增量现状 | `21ae0e1238..48fd4fb495`（86 文件） | **With fixes** | 0/2/8 | +1 Minor（N-3 陈旧文档） | 0/2/9 |
| **合计** | | | **0/7/36** | **+1C / +1I / +4M** | **1/8/40** |

**凌晨的「零 Critical」被核验轮修正。** 凌晨各单元的独立结论（代码面）全部经受住了实跑复核——7 条 Important 零误报、被印证项无一翻车；改变结论的是当时受只读纪律约束没做的真实微信链接冒烟：web_clip 对其主打来源**成功回执但正文几乎为空**（N-1）。

---

## 二、发现汇总

### Important（凌晨 7 条，均经协调者亲验，核验轮再确认无翻车）

- **I-1【W3·安全/提示注入】不可信网页内容无标注进入教师上下文**：`mcp-server/src/web-clip.ts:746` title 无长度上限直入 frontmatter/wiki_pages.title/回执；`:394` 正文原样入库无 untrusted 标注；`training.ts:898-904`+`:1527` 把 `《title》` 直拼进教师面 reply。**核验补证**：用真实微信链接的提取标题套 `training.ts:898-902` 的回执模板，教师会收到 `已收藏《<title>》，稍后整理完成后即可检索`——title 即时送达通道坐实（模板为逐字复刻，未做端到端写库调用）。修法：title 清洗截断 + 回执净化 + 正文 untrusted 标注行，约半小时。 **→ 已随 N-1 一并修完并验证，见 §九。**
- **I-2【W4·可观测性】GuardSkipped 告警不持久化**：`ingest_pipeline.rs:1810-1819` 只 `tracing::warn!` 不进 `result.warnings`，skip 计入 pages_written → 永不重跑，日志轮转后无痕。**核验补证**：服务日志全量检索，守卫自 10-15 部署以来在真实流量下 0 次触发——风险目前是潜伏的。修法：补 `result.warnings.push` + 结构化清单。
- **I-3【W1·资产安全】11-20 live 漂移未回仓**：live SKILL.md 26,355B vs 仓源 25,781B，`references/parent-communication.md` 2,933B 全机唯一副本。例行双份 cp 会静默抹掉。 **→ 已字节一致回仓（`414e4d1e`），见 §九。**
- **I-4【W1·回归网缺口】dry-run 11a 判据放走「漏学生页」**，三处口径互相矛盾。
- **I-5【W2·fork 存量 UX】start_clip_server 双重调用**（`src-tauri/src/lib.rs:645`/`:683`）→ 侧栏每次启动误报 port_conflict。
- **I-6【H2·可用性回退】idle_timeout 60s 默认 + progress 垫片缺口**（`terminal_tool.py:1205-1215` 只改写行首 `git clone` 与 `gh repo clone/fork --clone`）→ 静默活跃命令被提前杀。**核验补证**：真函数实跑 12 条命令坐实缺口；`GIT_PROGRESS=1 gh repo clone` 在 gh 2.103.3 下 0 行进度；60s 是 05-06 该功能落地时的出厂值（提交 `1387266545` 的引入 diff 里即为 60；当时 `tools/CLAUDE.md:187` 也如此记载——该文档属 N-3 待删件，删后以提交为锚），裁定时应知此背景。
- **I-7【H2·凭据安全】clear_zai_cache.py 绕开仓内锁与原子写**（`scripts/clear_zai_cache.py:17-18/:59-61`）。

### 核验轮新增发现

- **N-1【W3·Critical（功能级）】teacher_tutor_web_clip 对微信公众号文章提取不出正文，且报成功**
  - 证据：知识库里被引用过的 6 条真实 `mp.weixin.qq.com/s/…` 链接（5 条可取回，每页约 3.8MB HTML、`#js_content` 齐全；1 条系正则截断的畸形链接，属预期失败）走生产同款 `fetchWithGuards` + `extractArticle`，`#js_content` 真实正文 3,796–8,487 字符，提取结果仅 **25–56 字符**；按回执模板教师会被告知 `已收藏《有老师说，他自己没有天赋，但照样能学好英语。你信吗？》，稍后整理完成后即可检索`——标题对、回执成功、落库正文几乎为空，属**静默丢失**。
  - 根因（已实验确证）：微信以行内样式 `visibility: hidden; opacity: 0;` 下发正文，Readability 0.6.0 丢弃不可见节点后挑中页头。把 `#js_content` 的 `visibility` 改为 `visible` 后立即提取出 8,135 / 3,796 字符，与页面正文逐数相等。（核验中曾假设 class `rich_media_content` 撞 Readability 黑名单，实测证伪。）
  - 为何测试全绿：`mcp-server/test/web-clip-fetch.test.ts:489` 夹具写的是 `style="opacity: 0;"`，缺 `visibility: hidden`。为何线上没炸：25–56 字符高于空内容判定线，且 `clips/` 页为 0——功能上线至今无人用过，**尚无存量损害**。
  - 修法（未实施）：① `extractArticle` 对 `#js_content` 先清 `visibility:hidden`（或微信分支直接取该节点）；② 夹具补真实样式；③ 正文低于阈值（如 <200 字符）按 `empty_content` 处理，不再报「已收藏」。与 I-1 同文件可一并修。 **→ 已与 I-1 一并修完并验证（`cc377bb3`）；16:57 网关重启后已生效，见 §九。**
- **N-2【W2·Important（部署态）】live 的 web dist 是桌面形态，自 10-25 09:03 起**
  - 证据：`curl http://127.0.0.1:8080/` 实际下发的 `assets/api-client-Cpj5Gy3Y.js` 含 `function n(e){return e??\`http://localhost:8080\`}` 且以 `n(void 0)` 调用；`.env.web` 的约定是空串→同源相对请求。当前源码以 `--mode web` 构建到临时目录后与 live dist 比对，221 个文件里唯一真差异就是 api-client（新构建为 `n("")`）。
  - 成因：10-25 打桌面包时 `tauri.conf.json` 的 `beforeBuildCommand: npm run build:desktop` 于 09:03:05 把 `dist/` 整个覆盖，此后无人再跑 `build:web`。影响：只有以 `http://localhost:8080` 打开才正常；用 `127.0.0.1:8080` 打开会跨源（CORS 白名单只有 1420/5173，实测 `Origin: http://127.0.0.1:8080` 的响应不带 ACAO 头），经隧道域名打开则 API 打到访问者自己的 localhost——两种情况 web 端都不可用。**至今零暴露**：请求日志（覆盖 10-16 起）里没有任何一次真实的浏览器加载，`/assets/` 请求只有评审自己的 3 次，11-20 那次孤立的 `GET /` 之后无任何资源或 API 请求，应为探活。属潜伏的部署错误，且违反硬约束 3。凌晨评审没抓到是因为「特征串指纹」分辨不了两种构建。
  - 修法：`npm run build:web`；发版配方补「`tauri build` 之后必须重跑 `build:web`」。 **→ 13:07 已执行并验证，live 已是同源形态，见 §九。**
- **N-3【H2·Minor，清理价值高】fork 自带「AI 上下文文档」整批陈旧**：根 `CLAUDE.md` + 9 份嵌套 `CLAUDE.md` + `docs/adr/` 11 份，共 **21 份 5,570 行**，全部是 fork 作者 2026-04/05 提交、此后从未实质刷新（根文件 11-08 只改了一行基线），占 fork 增量 86 个文件里的 21 个。上游在同样位置放的是现行的 `AGENTS.md`（根 + 13 个目录），本 fork 一份 `CLAUDE.md` 都不对应。机械体检：反引号路径引用仍存在的比例 `environments/` 0/19、`plugins/` 2/16、`acp_adapter/` 5/15、`cron/` 5/12、`gateway/` 9/23；根目录与 7 个子目录里两套指令文件并存，根 `CLAUDE.md` 还链接进这些嵌套文档与 ADR。按 `CLAUDE.md` 取项目指令的工具会读到 7 个月前的架构描述。建议整批删除（fork-only 文件，上游不碰，零合并冲突）。 **→ 核验结论：可以整批删除、无需分流保留（`evidence/verify/raw/n3-stale-docs.txt`）；未实删，等口令。注意项见 §九。**
- **N-4【H1·Minor】上游 #11113 熔断测试在 fork 上恒红，但「永久 deselect」只存在于记忆里**：`tests/tools/test_mcp_circuit_breaker.py::test_breaker_opened_by_tool_errors_says_rejected_not_unreachable` 断言上游语义（错误载荷烧 strike），fork 故意改为「完成的 RPC 一律复位」——属设计分歧红（10-25 轮登记为 E-2）。仓内 conftest / pyproject / pytest 配置零机械登记，宽口径跑测必现，后来者可能误当回归去「修」fork。建议在 pyproject 的 pytest 配置里 `--deselect` 并写明理由。 **→ 已改并验证（Hermes `084986d85f`），见 §九。**
- **N-5【W1·Minor】dry-run 脚本 1–5 的 mock 返回侧 4 类陈旧**：`record_ask` 真实只回 `{"id":N}`（mock 写成完整事件对象）；错误码真实为 `RESOURCE_NOT_FOUND`/`VALIDATION_FAILED` 且工具层形态是 `LLM Wiki API 404: …` 错误文本（mock 写 `not_found`/`bad_request` 的 JSON body）；`items` 计数缺 `watched`（09-12 新增）；search 文本 mock 与 `formatSearchResults` 实际格式不同。调用侧（工具名/参数/必填）全部正确，脚本判据不依赖这些字段，无教师面风险。
- **N-6【W1·Minor】「防熔断」动机过时**：mcp-server 十余处注释称「抛 -32602 会被 Hermes 熔断器计入、3 次熔断 ~60s」；熔断参数属实（`tools/mcp_tool.py:517` 阈值 3 / 冷却 60s），但本 fork 自 2026-08-24 起对应用级 MCP 错误**不烧 strike**（`tools/mcp_tool_handlers.py:750-757/:273-279`）。防御写法无害、建议保留；live 技能里「连续 409 → 换 video_search、勿无限重试」的防熔断理由已不成立（作为绕开故障端点的手段仍有效），回仓时一并改措辞。

### Minor（凌晨 36 条 + 核验轮 4 条）
逐条见各子报告。凌晨较高价值的几条：W3 M-1 `charset=gb18030` 谎报可绕过 U+FFFD 乱码拒落库门（实测 0 替换符通过，防线仍守住）；W3 M-2 提取阶段无 CPU/时间上限；W4 M-5 media-rebuild `--concurrency` 末位无值→零 worker 静默 exit 0；H2 M-2 TTS 舞台指示正则误删正文括注；H1 M-4 max_sse 降级路径在钉版 2.0.0 上无测试钉住（核验确认该 skip 在钉版下确实触发）。

### 核验轮补充事实（不计严重度）
- **W4 集成测试的存量红会漏数据**：`permissions_test::llm_provider_crud_roundtrip` 在 409 断言处 panic，后续 DELETE 不执行，会留下测试 provider 行（本轮窗口内新增 5 行，跑前 11 → 跑后 16）；`(team_id, provider_type)` 唯一约束确已 drop，断言未同步。本轮跑测试产生的残渣（LT 侧 projects 52 / users 151 / media 26；M1/M2 侧 projects 65 / users 88）已按时间窗事务删除（带行数断言），备份在 `~/kb-dumps/test-residue-verify-20261124/`。
- **库页数勘正**：此前沿用的 18435 含 13 页测试夹具，`wiki_pages` 真实内容页数为 **18422**（测试前即如此）。
- **mcp 1.x 炸点实况**：本机有 1.21.2 / 1.25.0 / 1.26.0 三个环境，fork HEAD 在其下有 3 处函数内裸 import 会炸（`mcp_tool_events.py:100`、`mcp_oauth_device.py:109`、`mcp_oauth_manager.py:233`）；live 主网关跑在 mcp 2.0.0 下，1.26.0 的 venv 只是 zops MCP 服务端的解释器——**当前零暴露**。
- **钉版 CVE 差在 mcp**：mcp 2.0.0 有 5 个 CVE（2.3.0 为 0），openai 2.24.0 / anthropic 0.87.0 / pillow-heif 1.6.0 均 0；live 三入口皆本机 stdio，当前不暴露。mcp-server 全树 `npm audit` 15 条（1 critical / 9 high），点名三包 readability/turndown/jsdom 为 0。

---

## 三、前轮 glm-5.3 结论核对表

### 被证伪 / 勘正（6 条）
1. W1 前轮自述「SKILL.md 只增不改既有行」（dry-run.md:528）——失实：description 整行重写 + §0 行内追加都在。
2. 11-08 批提交信息 f66b2aa9ce 称「两例」钉版雷——实为 1 例（48fd4fb495 已自我勘正；核验轮用变异实跑确认其勘正注释逐字为真）。
3. W2 前轮/提交信息计数：Cargo.lock「13 行」实 2 行；「55 提交」实 51。
4. W4 前轮「新增 4 单测」——实为 3。
5. 协调者预检怀疑「live src-server 二进制陈旧」（评审前提，非前轮结论）——被证伪，live 无缺口。
6. **（核验轮新增）凌晨评审自己把 W2「18 冲突」标成「不可考」——有误**：`git merge-tree --write-tree` 只读重放，恰 18 个内容冲突文件，可考且为真。同理凌晨把 W1「熔断 3 次/~60s」标为未核验，核验为真。

### 凌晨「无法验证」→ 核验结果

| 单元 | 凌晨无法验证的项 | 核验结果 |
|---|---|---|
| W1 | T7 干跑真模型结果、脚本 4 A/B | 协调者无企微身份不能代跑；改做会话库历史回放（只读）：11a/11b/11c/11d/12a/12b/12c 与回归 1/2、脚本 4 A/B 的历史声明全部成立（as-run 于 10-31）。**当前行为仍需真人重跑** |
| W1 | parent-communication 的 5 个库锚点 | 全部真实（2 视频 38.5/21.0 分钟、3 概念页、[05:03]/[08:14]/[28:28]/[30:01] 逐一对上） |
| W1 | 会话库命中记录 | 家长会路由自 11-20 写入以来零真实教师触发；409 属身份绑定层，波及所有需身份的教师工具，根因已修 |
| W1 | LOE license 依据 | 批次记录与 KB 中 276 页提及 LOE、0 页带 license 字段——**无许可依据在案**（待裁定） |
| W1 | 熔断参数、其余 references、dry-run mock | 参数属实（动机过时，N-6）；文本面与工具面全量对账一致；mock 返回侧 4 类陈旧（N-5） |
| W2 | mcp-server 330 / build:web+tsc / 18 冲突 / 集成测试 / 10-25 网关重启 / lance-encoding / rsproxy / 桌面形态 | 全部核实：330（329 过 1 跳 0 败）；tsc 0 错、web 构建通过（但暴露 N-2）；18 冲突为真；134/1/33；网关 10:48:30→10:48:36 当日重启；lance-encoding 为缓存命中；rsproxy 瞬时故障；桌面=安装包 0.6.13 |
| W3 | 网关截断策略 / ingest 防注入 / additionalProperties / CVE / 代理变量 / 微信冒烟 | 无硬截断（企微 4000 切块）；ingest 提示词零防注入表述；身份闸兜底；CVE 已查；无代理变量；**微信冒烟发现 N-1** |
| W4 | vitest+tsc / 集成测试 / live DB / 守卫真实流量 / 重启链 | whisper 34/34、cli 38/38、transcriber 全目录 224/224、tsc 0 错；134/1/33；向量行 79067、去重目标 78/78/78/78/157、deduped 78 全部逐数吻合；守卫 0 次触发；重启链已还原 |
| H1 | F821@9ce27798f4 / SDK 表面 / 深层调用参数 / issuers 注释 / rooms-groups / 1.x 炸点 | F821 绿 + 259p/2s；SDK 全树扫描 0 裸露失败、0 kwargs 不符——**全树范围无第四颗雷**；注释逐字为真；rooms/groups 全家族 1088/1090（2 败为上游测试缓存串扰，fork 在该路径 0 改动）；1.x 炸点 3 处实复现、live 零暴露 |
| H2 | gh GIT_PROGRESS / 双端点计费 / CVE 差 / HEIC 实况 / 14 份文档 / 长任务通知 | GIT_PROGRESS 对 gh 无效坐实；coding-cn 与标准端点对同一 key 均 200（静默改按 token 计费）；CVE 差在 mcp；67 张图 0 HEIC/AVIF；文档整批陈旧（N-3）；通知门槛函数无缺陷 |

### 核验后仍无法验证
1. W1 T7 的**当前**行为：设计上须真人以测试教师在企微重发脚本。
2. W2 brew protoc 当前可用性：绿跑命中缓存，强制重跑代价大于价值。
3. H1 前轮的时点性运维取证（config 备份 cmp、symlink 装载链、日志时间线）：性质上不可重放。
4. SDK 的运行期属性读取与跨函数动态拼装的 kwargs：静态扫描覆盖不到，由 live 网关多周运行兜底。

### 被印证（要点）
- **W1**：T4 课标逐字逐字符一致；description 55 字窗按 Hermes 源码算法复算吻合；上轮 3I+3M 九项 HEAD 终态零失守。
- **W2**：58 真冲突零整取、两翼零丢失；page_embedding 三参修复在场并经编译实证；四条白名单门禁全绿。
- **W3**：SSRF 三层防线经 14 例对抗 + 2 例变异零绕过；undici 6.29.1 精确钉版。
- **W4**：守卫已部署；--force 复活通道堵死；919/919；pending 账本与 bk-totals 勘误属实。
- **H1**：三场合并冲突恰 17/5/1、逐 hunk 重演全部为正确并集；fork 语义重放点位 HEAD 全存活；钉版四方一致；fork_gate 268p/2s + verify_patches 双 exit 0。
- **H2**：钉版 mcp 2.0.0 下四处机制实测有效；stale_recovery 全链路含真 SQLite 回归钉；23 测试文件 794 用例全绿。

---

## 四、重跑验证账目（汇总）

| 执行者 | 命令/动作 | 结果 |
|---|---|---|
| W2 | 仓根 `npm run test:mocks` | 2588/181 全绿 |
| W2 | 根 `cargo test --workspace` / `src-tauri cargo test` / `src-server cargo test --lib` | 根 12 绿；src-tauri 476/0/2 绿；lib 382/0 绿 |
| W3 | /tmp 拷贝内 mcp-server build + node --test；14 例 SSRF 对抗 + 2 例变异 | 防线零绕过；变异即红 |
| H1 / H2 | 合并 detached worktree 逐 hunk 重演；fork_gate + verify_patches；23 测试文件 | 全绿；临时 worktree 已清理 |
| 协调者（凌晨） | 7 条 Important 逐条亲验 | 全部成立，零误报；两处引用路径勘正 |
| **协调者（核验轮）** | `cd src-server && cargo test --test integration`（连 live PG，知情） | **134 过 / 1 存量红 / 33 忽略**；残渣按窗口清理回基线 |
| | vitest whisper/cli + transcriber 全目录；仓根 typecheck | 34/34、38/38、224/224；tsc 0 错 |
| | `git merge-tree --write-tree` 只读重放；`vite build --mode web --outDir /tmp/…` | 恰 18 冲突；web 构建 5.41s 通过，比对暴露 N-2 |
| | /tmp 拷贝内 mcp-server build + `node --test` | 330 / 329 过 / 1 跳 / 0 败 |
| | 真实微信链接冒烟 ×8（不写库不入队） | **发现 N-1**；回执模板实测 |
| | Hermes：`fork_gate.sh` 于 9ce27798f4；rooms/groups 全家族 132 文件；73 个 SDK 测试文件 | F821 绿 + 259p/2s；1088/2；1936/2/16（2 败与 fork 无关） |
| | Hermes：全树 AST 扫描（10,947 文件）+ 钉版 SDK 解析 | import 232 条 0 裸露失败；属性链 114 条 0 失败；SDK 调用 110 处 0 不符 |
| | issuers 测试内存变异 ×5 + mcp 2.3.0 真函数对照 | 三条注释声明全真；真函数对同 8 例 0 不符 |
| | mcp 1.x 兼容（3 个本机 1.x 环境）；文档机械体检（21 份）；技能文本对账（仓源+live 30 份） | 3 处裸 import 炸；文档整批陈旧（N-3）；文本面一致 |
| | OSV / npm audit / 14-token 模型探针 ×4 / gh 进度对照 | 结果并入 §二 |

---

## 五、未核验清单核验结果

六份子报告的未核验清单逐条清点共 **41 条**（W1 7 / W2 8 / W3 7 / W4 5 / H1 7 / H2 7）。**37 条声明为真或被更强验证，2 条直接查出缺陷，2 条性质上不可重放。**

| 结果 | 条数 | 项 |
|---|---|---|
| ✅ 为真且无新问题 | 32 | W2 的 330、18 冲突、集成测试、网关重启、lance-encoding、rsproxy、桌面形态；W4 的 vitest+tsc、守卫真实流量、重启链；H1 的 F821、259p 量级、SDK 全树、issuers 注释、partial clone、1.x 炸点；H2 的 GIT_PROGRESS、双端点、CVE 差、HEIC、长任务通知；W1 的家长会锚点、会话库命中、LOE 依据（结论：无记录在案）、references 对账；W3 的截断策略、ingest 提示词、参数校验、CVE、代理变量、集成测试 |
| ⚠️ 为真但带出新发现 | 5 | W2「build:web」→ **N-2**；W1「熔断参数」→ **N-6**；W1「dry-run mock」→ **N-5**；W4「集成测试」→ 存量红会留测试 provider 行；W4「live DB」→ 页数勘正 18435→18422 |
| ❌ 直接查出缺陷 | 2 | W3「微信真实链接冒烟」→ **N-1（Critical）**；H2「14 份文档」→ **N-3** |
| ⛔ 性质上不可重放 | 2 | H1 前轮时点性运维取证；W1 T7 当前行为（需真人在企微重发；历史回放已做） |

另：N-4（上游熔断测试的分歧红未机械登记）不在任何未核验清单里，是核验轮加跑 73 个 SDK 测试文件时发现的。明细见上节「凌晨无法验证 → 核验结果」与三份 evidence/verify 账目。

说明：原计划派给两个子代理做的 Hermes 与 lt-tutor 文本面核对，因 5 小时用量上限失败、零产出，已全部由协调者亲做补齐，无遗留。

---

## 六、待用户裁定

1. **N-2（一条命令即可）**：是否现在跑 `npm run build:web` 恢复同源形态。这是部署动作，我没有执行。 **【裁定：跑——13:07 已执行并验证 ✅】**
2. **N-1**：web_clip 微信正文提取的修法与时机；修好前是否先在技能面下架或加「暂不支持公众号文章」提示。目前 0 次使用，无存量损害。 **【裁定：与 I-1 同文件一并修——已修已验，16:57 网关重启后已生效 ✅】**
3. **W1-I3** 漂移回仓：按 cc8dde4c 先例并回仓源——回仓前任何例行双份 cp 都有丢失风险，建议尽快。 **【裁定：回仓——已字节一致回仓并提交（`414e4d1e`）✅】**
4. **W1 M-9**：LOE / Foundations 语料的入库许可依据（无记录在案）与 ECE「禁商用」对幼儿段教案底座用法的口径。
5. **N-3**：是否整批删除 21 份 fork 自带的陈旧 AI 上下文文档（根 + 9 份嵌套 CLAUDE.md + 11 份 ADR）。 **【结论：可以整批删除；未实删，等口令】**
6. **N-4**：是否给上游 #11113 熔断测试做机械 deselect。 **【裁定：做——已改已验并提交（Hermes `084986d85f`）✅】**
7. **W4-I2 连带项**：transcripts/ 守卫是否一并补持久化。
8. **W4 补充**：`llm_provider_crud_roundtrip` 存量红（会留测试 provider 行）——恢复应用层查重还是改测试并登记分歧。
9. **W2-I5**：删 `lib.rs:683` 或加防重入守卫。
10. **H2-I6**：idle_timeout 默认 60s 是否抬到 ≥300s。
11. **H2-I7**：clear_zai_cache.py 改标准 API 或废弃。
12. **排期项**：Hermes 的 mcp 钉版升到 ≥2.3.0（消 5 个 CVE、撤两颗雷的垫片）；mcp-server `npm audit fix`（15 条，多数非破坏性）。

---

## 七、外部访问账目（只读；敏感文件只记存在不记值）

**凌晨评审轮**
- W1：读 live 技能目录；W2/W4：读仓内 `target/` 二进制；W3：/tmp 拷贝内构建与测试，零外网；H1/H2：读并实跑 Lan-WinRm 的 fork_gate/verify_patches.sh，conda envs 只读 inspect，live 网关 pid 查看，`~/.hermes/auth.json` 仅确认存在；自建 detached worktree 全部清理。
- 全程零：git 写操作、服务重启、数据库/Redis 写、密钥读取、企微/飞书消息。

**核验轮**
- 生产库：只读查询 + 一轮集成测试（其残渣已按时间窗精确清理，备份 `~/kb-dumps/test-residue-verify-20261124/`）。
- 真实外呼：微信文章页 GET 共 8 次；14-token 模型探针 4 次（密钥经变量、零回显）；OSV API 与 npm registry 查询；GitHub 公开仓克隆 2 个；rsproxy.cn 1 次。
- Hermes：pytest 在 live checkout 与非 live worktree `hermes-merge-20261104` 运行（git 层面零改动；留痕为 gitignore 内的 40 个 `.pyc` 与一个 `.pytest_cache` 索引，详见 hermes-verification.md 头注）；`hermes-3.11` 只加载已装 SDK 做签名解析；`Quant-3.11`、zops venv、conda base、rdagent4qlib 解释器只读执行 import 检查；读 zops profile 的 config.yaml 仅取含 venv/command 的行（长 token 已掩码）。
- 全程零：git 写操作、提交、服务重启、企微/飞书消息、密钥值读取或回显。

---

## 八、一次一件处置清单

> 进度（11-24 15:20）：must-fix 1–4 与 cheap wins 的 N-4 已完成；N-3 结论已出、等口令。明细见 §九。

**must-fix（建议顺序）**
1. **N-2**：`npm run build:web`（恢复硬约束 3；发版配方补一步）。
2. **N-1**：web_clip 微信正文提取 + 低于阈值不报成功（与 I-1 同文件一并修，补真实样式夹具）。修好前别向教师推介该工具。
3. **W1-I3** 漂移回仓（丢失风险窗口敞开着；回仓时顺手处理 N-6 的措辞）。
4. **W3-I1** title 清洗截断 + 回执净化 + 正文 untrusted 标注。
5. **W4-I2** 守卫告警持久化（+ §六-7 裁定连带项）。
6. **H2-I7** clear_zai_cache 锁 + 原子写。
7. **W1-I4** dry-run 11a 判据 + 三处口径对齐。
8. **H2-I6** idle_timeout 默认值与垫片覆盖（先拿 §六-10 裁定）。

**cheap wins（各十分钟级）**：N-3 删陈旧文档；N-4 机械 deselect；N-5 刷 dry-run mock。

**optional**：W2-I5 clip 双调用；其余 Minor 按各子报告自取。

**信息级**：前轮/凌晨计数勘误 6 条（§三）与 H1-M3 举例勘正已记录在案，无需动作。

---

## 九、处置进展（11-24 13:00 起，用户五项裁定后）

用户裁定（原话）：「web_clip 的修法和时机。与 I-1（title 清洗）同文件一并修」／「11-20 的 live 技能漂移回仓」／「N-4：给那条熔断测试加机械 deselect。」／「跑 npm run build:web」／「N-3：21 份陈旧文档是否整批删除。」

| 项 | 状态 | 结果 | 证据 |
|---|---|---|---|
| N-2 | ✅ 已部署 | `npm run build:web`（13:07）；:8080 下发的 api-client chunk 调用处实参为空串（同源），与本地 dist 字节相同；`index.html` 带 `cache-control: no-cache` | `evidence/verify/raw/n2-build-web.txt` |
| W1-I3 | ✅ 已回仓已提交（`414e4d1e`） | live → 仓源字节一致：`SKILL.md` +2 行、新增 `references/parent-communication.md`（2,933B，原为全机唯一副本） | 工作区 `git status` |
| N-1 + W3-I1 | ✅ 已修已验并已生效（提交 `cc377bb3`） | 见下。16:57 网关重启（非本会话发起）后 live 已载入新代码 | `evidence/verify/raw/webclip-fix/`、`gateway-restart-1657.txt` |
| N-4 | ✅ 已改已验（Hermes 提交 `084986d85f`） | pyproject `addopts` 追加 `--deselect` 并注明理由；上游熔断文件 `1 failed / 7 passed` → `7 passed, 1 deselected`；fork 自有熔断文件 10 passed；清空 addopts 仍是 `1 failed / 7 passed`（分歧原样可复现） | `evidence/verify/raw/n4-deselect.txt` |
| N-3 | 📋 结论已出，等口令 | **可以整批删除，无需分流保留** | `evidence/verify/raw/n3-stale-docs.txt` |

**N-1 + W3-I1 细节**（`mcp-server/src/web-clip.ts`、`src/training.ts` 与三个测试文件）
- 微信分支：仅当最终 URL 主机名精确等于 `mp.weixin.qq.com` 时，把 `#js_content` 自身的 `visibility: hidden` 揭开（不碰任何子元素），再交给 Readability；正文非空白字符 < 200 抛 `empty_content`，不再回「已收藏」。
- `sanitizeClipTitle`：剥格式字符与变体选择符、控制字符折成空格、折叠空白、按码点截断到 120；提取时与回执拼装时各洗一次。
- 正文入库前加一行 untrusted 提示（`CLIP_UNTRUSTED_NOTICE`）。
- 验证：新增 13 例（合计 343/343，typecheck 0 错）；17 个变异体全部被杀（其中 1 条断言原先因 turndown 转义下划线而恒真，换成不含下划线的标记并加正向对照后才是真钉子）；真实微信 6 篇：修前 21–49 字符的页头碎片 → 修后 2150–8086 字符，署名杂物清零、标题不变；live dist 由仓内正式测试重建，新产物握手 18 工具、schema 未变。
- 已知边界：正文只有一个段落的极短文章，Readability 会选到带页头的外层容器，约 41 字署名混进正文开头（6 篇真实文章均为多段落、精确命中 `#js_content`）。要彻底消除可改成微信分支直接取 `#js_content` 节点，本轮未做。
- 归档勘误：`before-after.txt` 的 13:55 初版误存了首次运行的报错、缺 5 篇对照表；15:05 已重跑并重写，数字与原汇报逐数一致。
- 生效：16:57 网关重启后，两个 MCP 子进程（16:57:11/12 启动）载入的是 13:50 构建的 dist——按启动时间与 dist 内容判定，未做经网关的真链路收藏。

**16:57 网关重启取证（非本会话发起；明细 `evidence/verify/raw/gateway-restart-1657.txt`）**
- 旧进程 16:54:59 收到来自 launchd 的 SIGTERM（外部停机请求，不是崩溃），16:55:23 被关停看门狗强制结束，16:57:05 新实例启动，16:57:16 三平台连上。launchd 显示 `runs = 1 / 从未退出`，是重新 bootstrap 的形态。发起方查不到。
- 网络旁证：16:37–16:38 两个外网主机 SSL 握手超时 5 次，16:55 飞书域名解析失败——重启与网络恢复时间吻合。停机时有一条发往飞书的消息因此未发出（当时无活跃会话、无延迟消息）。
- 重启后健康：17:00 起零 ERROR/CRITICAL。
- 日志卫生侧发现：Lark SDK 以 INFO 级把带 `access_key` 与 `ticket` 的 WebSocket 地址整行写进 `agent.log`（19 行）与 `gateway.log`（80 行）。是短期连接凭证、仅本机文件，但 grep 网关日志会把它们带出来；是否调高该 logger 级别或做脱敏，待裁定。

**N-3 依据与注意项**
- 依据：① 21 份全是 fork-only 新增（上游树同路径零文件，`git diff --name-status upstream...HEAD` 里全为 A），删除零合并冲突，fork 增量 86 → 65 个文件；② 仓内外零功能性引用——仓内 187 处 `CLAUDE.md` 提及全是按文件名泛读的上游机制、测试夹具、文档泛称，无一处点名这 21 个路径，门禁脚本与三个 Hermes cron 库也零命中；③ 内容无独一份之物——ADR 是回溯生成的上游架构描述（索引日期写 2024 年、实际提交于 2026-04-08，反馈表 0 条），fork 专属的两段（zai-coding-cn provider、自适应空闲超时）代码里自带说明；④ 分支已推 origin，删后可从历史原样取回。
- 注意 1：删后只读 `CLAUDE.md` 的工具（如 Claude Code）在该仓就没有自动加载的项目指令了；`AGENTS.md` 仍在，Hermes / Codex / ZCode 照常读。若仍用 Claude Code 在此仓工作，可另留一份一行的根 `CLAUDE.md`（内容 `@AGENTS.md`），可选。
- 注意 2：I-6（H2-I6）的出处锚从 `tools/CLAUDE.md:187` 改为提交 `1387266545`（§二已改）。
- 注意 3：`origin/zops-vendor-patches`（26692c43b9）上同样 21 份俱在，本轮只核了 `lt-tutor-vendor-patches`；要一并清需在 zops 分支单独 cherry-pick 删除提交。
- 现状补充：10 份 CLAUDE.md 里 8 份对 Hermes 自身已被同目录 `AGENTS.md` 遮蔽，只有 `acp_adapter/`、`environments/` 两份会被真的注入；`environments/` 在库文件只剩那份文档。
- 侧发现（不在 21 份内）：根 `CHANGELOG.md` 的 fork 段最新条目停在 2026-04-24（提交 `b26979cc53`），之后的本地改动与三次上游合并均未入册，是否处置另议。

**仍未做（需用户口令）**
1. ~~两仓提交与推送~~ **已完成**（用户口令「提交并推送」，11-24 18:48–18:52）：llm_wiki `main` = `cc377bb3`（web_clip 修复）+ `414e4d1e`（漂移回仓）+ 本目录落盘提交；Hermes `lt-tutor-vendor-patches` = `084986d85f`（pyproject deselect）。均已推 origin。
2. ~~Hermes 网关重启（硬约束 4）~~——16:57 已由外部重启完成，本项作废；经网关的一次真链路收藏验证仍未做。
3. N-3 实删。
4. W1 评审提的两处可选措辞（家长会快速路径行补 `skill_view` 两步骨架；409 那条的动机改写为凭证/检索链路）未动——回仓保持与 live 字节一致。
5. 临时目录 `/tmp/webclip-fix/` 仍保留（内有修复前 live dist 备份）；真链路收藏验证过后可清。

**处置轮外部访问补记（接 §七）**：微信文章页 GET 至少 6 次（5 篇存档 + 1 篇现抓冒烟）；本机 :8080 curl 若干；其余为本地构建、测试与 MCP stdio 握手（起独立 node 进程，不连网关、不读密钥、不调工具）；Hermes 仓 pytest 两次基线 + 三次修后验证（`PYTHONDONTWRITEBYTECODE=1 -p no:cacheprovider`）；18:00 起只读 `~/.hermes/logs` 与 launchctl 状态做重启取证（含凭证的日志行未写入任何文件）。零 git 写操作、零服务重启、零密钥读取。
