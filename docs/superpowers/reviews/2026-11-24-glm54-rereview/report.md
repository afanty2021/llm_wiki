# glm-5.4 重评报告：两仓近期变更（2026-11-24，含核验轮更新）

> **评审方式**：定时任务自动执行（11-24 01:45 触发，01:47 预检，02:17 收官）。协调者并发派发 6 个独立评审子代理（W1-W4 仓 A / H1-H2 仓 B），每个子代理先独立评审、再逐条核对前轮 glm-5.3 报告的承重声明、最后找前轮漏掉的问题；协调者对全部 7 条 Important 逐条亲手重验（命令实跑或读码对到行）。
> **核验轮**（11-24 07:30–13:00，用户口令「report.md 中未核验清单要进行核验，授权跑真实脚本」）：六份子报告的未核验清单已逐项核验，结果见 §五；新发现 N-1…N-6 并入 §二；证据在 evidence/verify/（[coordinator-verification.md](evidence/verify/coordinator-verification.md)、[hermes-verification.md](evidence/verify/hermes-verification.md)、[ltutor-text-verification.md](evidence/verify/ltutor-text-verification.md)、[integration-verify.md](evidence/verify/integration-verify.md)、raw/）。
> **闭环复审**（11-24 19:30–23:45，用户口令「max 复查评审修复」）：四席独立复查五项处置，裁决、勘误与待裁定项见 §十。
> **基线**：仓 A llm_wiki main=`06a9315c`；仓 B Hermes-agent lt-tutor-vendor-patches=main=origin/main=`48fd4fb495`。评审与核验两轮全程零 git 漂移，两仓零改动（此句仅指评审与核验两轮；11-24 13:00 起的处置轮有提交与部署写，见 §九、§十）。
> **子报告**：同目录 [W1.md](W1.md) [W2.md](W2.md) [W3.md](W3.md) [W4.md](W4.md) [H1.md](H1.md) [H2.md](H2.md)。

---

## 一、各单元裁决表

| 单元 | 范围 | 裁决（核验后） | 凌晨 C/I/M | 核验轮新增 | 核验后 C/I/M |
|---|---|---|---|---|---|
| W1 lt-tutor 教案+CFU | `ccd14303..06a9315c` + live 漂移 | **With fixes**（漂移回仓 + dry-run 11a 判据须先修） | 0/2/9 | +2 Minor（N-5 dry-run mock 陈旧、N-6 防熔断动机过时） | 0/2/11 |
| W2 上游 v0.6.13 合并 | `9f47a652..ccd14303` | **With fixes**（代码可并维持；live web 部署态须修 N-2——已于 11-24 13:07 恢复，见 §九） | 0/1/3 | +1 Important（N-2） | 0/2/3 |
| W3 teacher_tutor_web_clip | `816549bb..9f47a652` | **With fixes → N-1 已修并经真链路验证**（见 §九；闭环复查附几条小修，见 §十） | 0/1/6 | +1 Critical（N-1，功能级） | 1/1/6 |
| W4 10-15 语料质检批（收窄） | `eec73d6f^..816549bb` | **With fixes** | 0/1/6 | 无 | 0/1/6 |
| H1 Hermes 三次上游合并+钉版 | v0.22.5/v0.22.7/v0.23.0 三场 | **Yes** | 0/0/4 | +1 Minor（N-4 分歧红未机械登记）；M-3 举例勘正 | 0/0/5 |
| H2 Hermes fork 增量现状 | `21ae0e1238..48fd4fb495`（86 文件） | **With fixes** | 0/2/8 | +1 Minor（N-3 陈旧文档） | 0/2/9 |
| **合计** | | | **0/7/36** | **+1C / +1I / +4M** | **1/8/40** |

**凌晨的「零 Critical」被核验轮修正。** 凌晨各单元的独立结论（代码面）全部经受住了实跑复核——7 条 Important 零误报、被印证项无一翻车；改变结论的是当时受只读纪律约束没做的真实微信链接冒烟：web_clip 对其主打来源**成功回执但正文几乎为空**（N-1）。

---

## 二、发现汇总

### Important（凌晨 7 条，均经协调者亲验，核验轮再确认无翻车）

- **I-1【W3·安全/提示注入】不可信网页内容无标注进入教师上下文**：`mcp-server/src/web-clip.ts:746` title 无长度上限直入 frontmatter/wiki_pages.title/回执；`:394` 正文原样入库无 untrusted 标注；`training.ts:898-904`+`:1527` 把 `《title》` 直拼进教师面 reply。**核验补证**：用真实微信链接的提取标题套 `training.ts:898-902` 的回执模板，教师会收到 `已收藏《<title>》，稍后整理完成后即可检索`——title 即时送达通道坐实（模板为逐字复刻，未做端到端写库调用）。修法：title 清洗截断 + 回执净化 + 正文 untrusted 标注行，约半小时。 **→ 已随 N-1 一并修完并验证，见 §九；闭环复查补记：search 片段路径仍无 untrusted 标注（约 5 行可补），见 §十 R1-M3。**
- **I-2【W4·可观测性】GuardSkipped 告警不持久化**：`ingest_pipeline.rs:1810-1819` 只 `tracing::warn!` 不进 `result.warnings`，skip 计入 pages_written → 永不重跑，日志轮转后无痕。**核验补证**：服务日志全量检索，守卫自 10-15 部署以来在真实流量下 0 次触发——风险目前是潜伏的。修法：补 `result.warnings.push` + 结构化清单。
- **I-3【W1·资产安全】11-20 live 漂移未回仓**：live SKILL.md 26,355B vs 仓源 25,781B，`references/parent-communication.md` 2,933B 全机唯一副本。例行双份 cp 会静默抹掉。 **→ 已字节一致回仓（`414e4d1e`），见 §九。**
- **I-4【W1·回归网缺口】dry-run 11a 判据放走「漏学生页」**，三处口径互相矛盾。
- **I-5【W2·fork 存量 UX】start_clip_server 双重调用**（`src-tauri/src/lib.rs:645`/`:683`）→ 侧栏每次启动误报 port_conflict。
- **I-6【H2·可用性回退】idle_timeout 60s 默认 + progress 垫片缺口**（`terminal_tool.py:1205-1215` 只改写行首 `git clone` 与 `gh repo clone/fork --clone`）→ 静默活跃命令被提前杀。**核验补证**：真函数实跑 12 条命令坐实缺口；`GIT_PROGRESS=1 gh repo clone` 在 gh 2.103.3 下 0 行进度；60s 是 05-06 该功能落地时的出厂值（提交 `1387266545` 的引入 diff 里即为 60；当时 `tools/CLAUDE.md:187` 也如此记载——该文档已于 11-24 随 N-3 删除，出处锚=提交 `1387266545`），裁定时应知此背景。
- **I-7【H2·凭据安全】clear_zai_cache.py 绕开仓内锁与原子写**（`scripts/clear_zai_cache.py:17-18/:59-61`）。

### 核验轮新增发现

- **N-1【W3·Critical（功能级）】teacher_tutor_web_clip 对微信公众号文章提取不出正文，且报成功**
  - 证据：知识库里被引用过的 6 条真实 `mp.weixin.qq.com/s/…` 链接（5 条可取回，每页约 3.8MB HTML、`#js_content` 齐全；1 条系正则截断的畸形链接，属预期失败）走生产同款 `fetchWithGuards` + `extractArticle`，`#js_content` 真实正文 3,796–8,487 字符，提取结果仅 **21–49 个非空白字符**（含空白的 markdown 长度 25–56；闭环复查勘正单位，见 §十）；按回执模板教师会被告知 `已收藏《有老师说，他自己没有天赋，但照样能学好英语。你信吗？》，稍后整理完成后即可检索`——标题对、回执成功、落库正文几乎为空，属**静默丢失**。
  - 根因（已实验确证）：微信以行内样式 `visibility: hidden; opacity: 0;` 下发正文，Readability 0.6.0 丢弃不可见节点后挑中页头。把 `#js_content` 的 `visibility` 改为 `visible` 后立即提取出 8,135 / 3,796 字符，与页面正文逐数相等。（核验中曾假设 class `rich_media_content` 撞 Readability 黑名单，实测证伪。）
  - 为何测试全绿：`mcp-server/test/web-clip-fetch.test.ts:489` 夹具写的是 `style="opacity: 0;"`，缺 `visibility: hidden`。为何线上没炸：这些碎片高于空内容判定线，且当时 `clips/` 页为 0——截至 11-24 13:00 无人用过、**尚无存量损害**（19:06 起已有真实使用，见 §九）。
  - 修法（未实施）：① `extractArticle` 对 `#js_content` 先清 `visibility:hidden`（或微信分支直接取该节点）；② 夹具补真实样式；③ 正文低于阈值（如 <200 字符）按 `empty_content` 处理，不再报「已收藏」。与 I-1 同文件可一并修。 **→ 已与 I-1 一并修完并验证（`cc377bb3`）；16:57 网关重启后已生效，真链路验证通过，见 §九。**
- **N-2【W2·Important（部署态）】live 的 web dist 是桌面形态，自 10-25 09:03 起**
  - 证据：`curl http://127.0.0.1:8080/` 实际下发的 `assets/api-client-Cpj5Gy3Y.js` 含 `function n(e){return e??\`http://localhost:8080\`}` 且以 `n(void 0)` 调用；`.env.web` 的约定是空串→同源相对请求。当前源码以 `--mode web` 构建到临时目录后与 live dist 比对，221 个文件里唯一真差异就是 api-client（新构建为 `n("")`）。
  - 成因：10-25 打桌面包时 `tauri.conf.json` 的 `beforeBuildCommand: npm run build:desktop` 于 09:03:05 把 `dist/` 整个覆盖，此后无人再跑 `build:web`。影响：只有以 `http://localhost:8080` 打开才正常；用 `127.0.0.1:8080` 打开会跨源（CORS 白名单只有 1420/5173，实测 `Origin: http://127.0.0.1:8080` 的响应不带 ACAO 头），经隧道域名打开则 API 打到访问者自己的 localhost——两种情况 web 端都不可用。**至今零暴露**：请求日志（覆盖 10-16 起）里没有任何一次真实的浏览器加载，`/assets/` 请求只有评审自己的 3 次，11-20 那次孤立的 `GET /` 之后无任何资源或 API 请求，应为探活。属潜伏的部署错误，且违反硬约束 3。凌晨评审没抓到是因为「特征串指纹」分辨不了两种构建。
  - 修法：`npm run build:web`；发版配方补「`tauri build` 之后必须重跑 `build:web`」。 **→ 13:07 已执行并验证，live 已是同源形态，见 §九；根因（`tauri build` 覆盖 `dist/`）在仓内尚无成文防线，见 §十 R4-I3。**
- **N-3【H2·Minor，清理价值高】fork 自带「AI 上下文文档」整批陈旧**：根 `CLAUDE.md` + 9 份嵌套 `CLAUDE.md` + `docs/adr/` 11 份，共 **21 份 5,570 行**，全部是 fork 作者 2026-04/05 提交、此后从未实质刷新（根文件 11-08 只改了一行基线），占 fork 增量 86 个文件里的 21 个。上游在同样位置放的是现行的 `AGENTS.md`（根 + 14 个目录，共 15 份），本 fork 一份 `CLAUDE.md` 都不对应。机械体检：反引号路径引用仍存在的比例 `environments/` 0/19、`plugins/` 2/16、`acp_adapter/` 5/15、`cron/` 5/12、`gateway/` 9/23；根目录与 7 个子目录里两套指令文件并存，根 `CLAUDE.md` 还链接进这些嵌套文档与 ADR。按 `CLAUDE.md` 取项目指令的工具会读到 7 个月前的架构描述。建议整批删除（fork-only 文件，上游不碰，零合并冲突）。 **→ 核验结论：可以整批删除、无需分流保留（`evidence/verify/raw/n3-stale-docs.txt`）；已实删（两分支，见 §九）。注意项见 §九。**
- **N-4【H1·Minor】上游 #11113 熔断测试在 fork 上恒红，但「永久 deselect」只存在于记忆里**：`tests/tools/test_mcp_circuit_breaker.py::test_breaker_opened_by_tool_errors_says_rejected_not_unreachable` 断言上游语义（错误载荷烧 strike），fork 故意改为「完成的 RPC 一律复位」——属设计分歧红（10-25 轮登记为 E-2）。仓内 conftest / pyproject / pytest 配置零机械登记，宽口径跑测必现，后来者可能误当回归去「修」fork。建议在 pyproject 的 pytest 配置里 `--deselect` 并写明理由。 **→ 已改并验证（Hermes `084986d85f`），见 §九；仅覆盖 `lt-tutor-vendor-patches`，zops 分支未移植，见 §十。**
- **N-5【W1·Minor】dry-run 脚本 1–5 的 mock 返回侧 4 类陈旧**：`record_ask` 真实只回 `{"id":N}`（mock 写成完整事件对象）；错误码真实为 `RESOURCE_NOT_FOUND`/`VALIDATION_FAILED` 且工具层形态是 `LLM Wiki API 404: …` 错误文本（mock 写 `not_found`/`bad_request` 的 JSON body）；`items` 计数缺 `watched`（09-12 新增）；search 文本 mock 与 `formatSearchResults` 实际格式不同。调用侧（工具名/参数/必填）全部正确，脚本判据不依赖这些字段，无教师面风险。
- **N-6【W1·Minor】「防熔断」动机过时**：mcp-server 十余处注释称「抛 -32602 会被 Hermes 熔断器计入、3 次熔断 ~60s」；熔断参数属实（`tools/mcp_tool.py:517` 阈值 3 / 冷却 60s），但本 fork 自 2026-08-24 起对应用级 MCP 错误**不烧 strike**（`tools/mcp_tool_handlers.py:750-757/:273-279`）。防御写法无害、建议保留；live 技能里「连续 409 → 换 video_search、勿无限重试」这一条，其书面理由是「刷屏」而非防熔断——「防熔断动机过时」对技能文本不适用、只对上面的代码注释成立；该条真正的问题是归因偏窄（W1 M-4，见 §十 R2-m2），回仓时未动。

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
2. **N-1**：web_clip 微信正文提取的修法与时机；修好前是否先在技能面下架或加「暂不支持公众号文章」提示。裁定时 0 次使用、无存量损害。 **【裁定：与 I-1 同文件一并修——已修已验，16:57 网关重启后已生效 ✅】**
3. **W1-I3** 漂移回仓：按 cc8dde4c 先例并回仓源——回仓前任何例行双份 cp 都有丢失风险，建议尽快。 **【裁定：回仓——已字节一致回仓并提交（`414e4d1e`）✅】**
4. **W1 M-9**：LOE / Foundations 语料的入库许可依据（无记录在案）与 ECE「禁商用」对幼儿段教案底座用法的口径。
5. **N-3**：是否整批删除 21 份 fork 自带的陈旧 AI 上下文文档（根 + 9 份嵌套 CLAUDE.md + 11 份 ADR）。 **【裁定：实删、连 zops 分支一并清——已完成 ✅】**
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

> 进度（11-24 22:50 终态）：must-fix 1–4 与 cheap wins 的 N-3、N-4 已完成；未做：N-2 的发版配方补步（仓内零处成文，见 §十 R4-I3）、N-5、N-6 措辞。明细见 §九、§十。

**must-fix（建议顺序）**
1. **N-2**：`npm run build:web`（恢复硬约束 3；发版配方补一步）——build:web 已于 11-24 13:07 执行；**发版配方补一步未做**（仓内零处成文，见 §十 R4-I3）。
2. **N-1**：web_clip 微信正文提取 + 低于阈值不报成功（与 I-1 同文件一并修，补真实样式夹具）。修好前别向教师推介该工具。
3. **W1-I3** 漂移回仓（丢失风险窗口敞开着；回仓时顺手处理 N-6 的措辞）。
4. **W3-I1** title 清洗截断 + 回执净化 + 正文 untrusted 标注。
5. **W4-I2** 守卫告警持久化（+ §六-7 裁定连带项）。
6. **H2-I7** clear_zai_cache 锁 + 原子写。
7. **W1-I4** dry-run 11a 判据 + 三处口径对齐。
8. **H2-I6** idle_timeout 默认值与垫片覆盖（先拿 §六-10 裁定）。

**cheap wins（各十分钟级）**：N-3、N-4 已完成（见 §九）；N-5 刷 dry-run mock 未动。

**optional**：W2-I5 clip 双调用；其余 Minor 按各子报告自取。

**信息级**：前轮/凌晨计数勘误 6 条（§三）与 H1-M3 举例勘正已记录在案，无需动作。

---

## 九、处置进展（11-24 13:00 起，用户五项裁定后）

用户裁定（原话）：「web_clip 的修法和时机。与 I-1（title 清洗）同文件一并修」／「11-20 的 live 技能漂移回仓」／「N-4：给那条熔断测试加机械 deselect。」／「跑 npm run build:web」／「N-3：21 份陈旧文档是否整批删除。」

| 项 | 状态 | 结果 | 证据 |
|---|---|---|---|
| N-2 | ✅ 已部署 | `npm run build:web`（13:07）；:8080 下发的 api-client chunk 调用处实参为空串（同源），与本地 dist 字节相同；`index.html` 带 `cache-control: no-cache` | `evidence/verify/raw/n2-build-web.txt` |
| W1-I3 | ✅ 已回仓已提交（`414e4d1e`） | live → 仓源字节一致：`SKILL.md` +2 行、新增 `references/parent-communication.md`（2,933B，原为全机唯一副本） | 闭环复查落档：live 与仓源 17/17 文件 sha256 逐字节一致（`SKILL.md` 两侧 27,177B、`fe56657a…`；清单见 `evidence/verify/recheck/R2.md`） |
| N-1 + W3-I1 | ✅ 已修已验并已生效+真链路验证通过（提交 `cc377bb3`） | 见下。16:57 网关重启（非本会话发起）后 live 已载入新代码；19:04–19:09 用户企微真发全链通过 | `evidence/verify/raw/webclip-fix/`、`gateway-restart-1657.txt` |
| N-4 | ✅ 已改已验（Hermes 提交 `084986d85f`） | pyproject `addopts` 追加 `--deselect` 并注明理由；上游熔断文件 `1 failed / 7 passed` → `7 passed, 1 deselected`；fork 自有熔断文件 10 passed；清空 addopts 仍是 `1 failed / 7 passed`（分歧原样可复现） | `evidence/verify/raw/n4-deselect.txt` |
| N-3 | ✅ 已实删（用户口令「N-3 实删（连 zops 分支一并清）」） | 可以整批删除、无需分流保留。`lt-tutor-vendor-patches` 删除提交 `2da13543a3`；`zops-vendor-patches` 删除提交 `370956b3aa`（架在本地 zops tip 5af434e836 上——该提交早已是 origin/main 的祖先，本次只是首次进入 zops 远端分支；26692c43b9→370956b3aa）。四 ref（两分支×本地/origin）doc 计数均 21→0；`main` / `origin/main` 仍停在 `48fd4fb495`（21 份俱在、无 deselect，未推进）。恢复锚按分支：lt-tutor 用 `git show 48fd4fb495:<path>`（即 `2da13543a3^`），zops 用 `git show 5af434e836:<path>`（即 `370956b3aa^`；其根 `CLAUDE.md` 比 lt-tutor 版少 11-08 那 2 行刷新，其余 20 份相同） | `evidence/verify/raw/n3-stale-docs.txt` |

**N-1 + W3-I1 细节**（`mcp-server/src/web-clip.ts`、`src/training.ts` 与三个测试文件）
- 微信分支：仅当最终 URL 主机名精确等于 `mp.weixin.qq.com` 时，把 `#js_content` 自身的 `visibility: hidden` 揭开（不碰任何子元素），再交给 Readability；正文非空白字符 < 200 抛 `empty_content`，不再回「已收藏」。
- `sanitizeClipTitle`：剥格式字符与变体选择符、控制字符折成空格、折叠空白、按码点截断到 120；提取时与回执拼装时各洗一次。
- 正文入库前加一行 untrusted 提示（`CLIP_UNTRUSTED_NOTICE`）。
- 验证：新增 13 例（合计 343/343，typecheck 0 错）；17 个变异体全部被杀（其中 1 条断言原先因 turndown 转义下划线而恒真，换成不含下划线的标记并加正向对照后才是真钉子）；真实微信 6 篇：修前 21–49 字符的页头碎片 → 修后 2150–8086 字符，署名杂物清零、标题不变；live dist 由仓内正式测试重建，新产物握手 18 工具、schema 未变。闭环复查：17 个变异体经独立重跑全部被杀且死因逐条对题、5 篇存档文章现抓数字与证据逐数相同（见 §十）；「schema 未变」「原断言因下划线转义恒真」两条当时未存对照证据，仅有旁证。
- 已知边界：正文只有一个段落的极短文章，Readability 会选到带页头的外层容器，约 41 字署名混进正文开头（合成夹具口径；闭环复查在真实页骨架上实测杂物 46–61 字，单个块级块的正文字数到约 450 仍会选中外层容器、500 起才精确命中，见 §十 R1-M2）（6 篇真实文章均为多段落、精确命中 `#js_content`）。要彻底消除可改成微信分支直接取 `#js_content` 节点，本轮未做。
- 归档勘误：`before-after.txt` 的 13:55 初版误存了首次运行的报错、缺 5 篇对照表；15:05 已重跑并重写，数字与原汇报逐数一致。
- 生效：16:57 网关重启后，两个 MCP 子进程（16:57:11/12 启动）载入的是 13:50 构建的 dist。（11-24 22:00 复核：子进程已于 20:54:05 / 21:28:15 重新拉起；`mcp-server/dist` 于 21:42:34 被并行会话的崩溃修复 `0f17695f` 重建，在跑的两个进程均早于它启动——该修复尚未加载，需重启网关，见 §十）

**真链路验证（19:04–19:09，用户企微真发）——全链通过 ✅**
- 链路：WeCom 入站（HuangZhengBo 发 `mp.weixin.qq.com/s/eyKga8P5qyIj2eUwsg2J_w`，19:04:58）→ lt-tutor 会话 → `teacher_tutor_web_clip` 返回 **`status: "created"`**（jobId `6f953d4a`）→ 回复 308 字符于 19:06:23 生成（与另一件缺书登记合并成一条回复；库内只记生成时刻，送达时刻无记录）。
- 落库产物：`sources/clips/…-e574c75a.md`——`> ⚠ untrusted` 提示行在、提示行后正文 **2,493** 非空白字符（围栏行另 68；旧 bug 形态是 20–50 的署名碎片）、署名杂物 0、frontmatter 带 `clipped_by/at`；`clips/` wiki 页 2,967 字符（整页口径，含 frontmatter 与围栏行，md5 与盘上文件相同）；embeddings **10** chunks（chunk_index 0–9）；ingest job `succeeded_with_warnings`（warnings 10 条，均为 guard-v2 的「非路径 source 条目迁入概念页 citations」，预期机制），new_pages 10：`concepts/` 9 + `notes/` 1。（勘误：原记 2,544 / 4 chunks 有误，见 §十）
- 行为观察（非缺陷）：模型先调内置 `web_extract`（Tavily）读文摘要、再调 web_clip 收藏——比 SKILL 快速路径的「链接即收藏」多一步；回执里的简介出自 Tavily，库里正文出自 Readability，两源独立。同一回合还有一次 `terminal` 调用是会话既有《杠杆式学习》缺书登记的顺带查重，与本功能无关（既有 'always' 自动批准）。
- 复核插曲如实记：协调者第一轮核验（19:05:58）早于文件落库（19:06:03–05）七秒，一度误判「未落库」——以库内行/盘上文件的 created_at 对时后才翻案，教训同 [[部署声明按证据核验]]。
- 后续真实使用（闭环复查补记）：19:17 起持续有收藏，截至 22:00 共 24 份（均为仓库所有者本人）。协调者通道对前 21 份只读体检——全部带围栏行、正文 1,345–6,663 非空白字符、页头署名污染 0；24 个 ingest job 中 20 个 `succeeded_with_warnings`、4 个 `succeeded`（R4 取证）；每个收藏页 8–25 个向量块。20:54 前后一条老式 `__biz` 链接曾把 MCP 进程打崩（并行会话已修，见 §十）。

**16:57 网关重启取证（非本会话发起；明细 `evidence/verify/raw/gateway-restart-1657.txt`）**
- 旧进程 16:54:59 收到来自 launchd 的 SIGTERM（外部停机请求，不是崩溃），16:55:23 被关停看门狗强制结束，16:57:05 新实例启动，16:57:16 三平台连上。launchd 显示 `runs = 1 / 从未退出`，是重新 bootstrap 的形态。发起方查不到。
- 网络旁证：16:37–16:38 两个外网主机 SSL 握手超时 5 次，16:55 飞书域名解析失败——重启与网络恢复时间吻合。停机时有一条发往飞书的消息因此未发出（当时无活跃会话、无延迟消息）。
- 重启后健康：17:00 起零 ERROR/CRITICAL。
- 日志卫生侧发现：Lark SDK 以 INFO 级把带 `access_key` 与 `ticket` 的 WebSocket 地址整行写进 `agent.log`（19 行）与 `gateway.log`（80 行）。是短期连接凭证、仅本机文件，但 grep 网关日志会把它们带出来；是否调高该 logger 级别或做脱敏，待裁定。

**N-3 依据与注意项**
- 依据：① 21 份全是 fork-only 新增（上游树同路径零文件，`git diff --name-status upstream...HEAD` 里全为 A），删除零合并冲突，fork 增量 86 → 65 个文件；② 仓内外零功能性引用——仓内 187 处 `CLAUDE.md` 提及全是按文件名泛读的上游机制、测试夹具、文档泛称，无一处点名这 21 个路径，门禁脚本与三个 Hermes cron 库也零命中；③ 内容无独一份之物——ADR 是回溯生成的上游架构描述（索引日期写 2024 年、实际提交于 2026-04-08，反馈表 0 条），fork 专属的两段（zai-coding-cn provider、自适应空闲超时）代码里自带说明；④ 分支已推 origin，删后可从历史原样取回。
- 注意 1：删后只读 `CLAUDE.md` 的工具（如 Claude Code）在该仓就没有自动加载的项目指令了；`AGENTS.md` 仍在，Hermes / Codex / ZCode 照常读。若仍用 Claude Code 在此仓工作，可另留一份一行的根 `CLAUDE.md`（内容 `@AGENTS.md`），可选。
- 注意 2：I-6（H2-I6）的出处锚从 `tools/CLAUDE.md:187` 改为提交 `1387266545`（§二已改）。
- 注意 3（已被上表取代）：zops 分支已于 11-24 以 `370956b3aa` 清除；仍含 21 份的是 `main` / `origin/main`（48fd4fb495，未推进）。
- 现状补充：10 份 CLAUDE.md 里 8 份对 Hermes 自身已被同目录 `AGENTS.md` 遮蔽，只有 `acp_adapter/`、`environments/` 两份会被真的注入；`environments/` 在库文件只剩那份文档。
- 侧发现（不在 21 份内）：根 `CHANGELOG.md` 的 fork 段最新条目停在 2026-04-24（提交 `b26979cc53`），之后的本地改动与三次上游合并均未入册，是否处置另议。

**仍未做（需用户口令）**
1. ~~两仓提交与推送~~ **已完成**（用户口令「提交并推送」，11-24 18:48–18:52）：llm_wiki `main` = `cc377bb3`（web_clip 修复）+ `414e4d1e`（漂移回仓）+ 本目录落盘提交；Hermes `lt-tutor-vendor-patches` = `084986d85f`（pyproject deselect）。均已推 origin。（此为 18:52 时点；其后 llm_wiki 另有 `b3af436f`、`f65fb086` 两笔报告更新，Hermes 另有 `2da13543a3`；并行会话于 21:35–21:42 追加 `0f17695f`、`e8ee2893`、`8887af93`。）
2. ~~Hermes 网关重启（硬约束 4）~~——16:57 已由外部重启完成，本项作废；真链路收藏验证已完成（见 N-1 真链路验证段）。
3. ~~N-3 实删~~ **已完成**（用户口令）：21 份从 `lt-tutor-vendor-patches`（`2da13543a3`）与 `zops-vendor-patches`（`370956b3aa`）删净并推 origin；未留根 CLAUDE.md 桩（如需给 Claude Code 用，`@AGENTS.md` 一行桩可随时补）。
4. W1 评审提的两处可选措辞（家长会快速路径行补 `skill_view` 两步骨架；409 那条的归因改写，W1 M-4）未动——回仓保持与 live 字节一致；闭环复查结论：两处均为一行级 Minor，建议随下一次热修批一并改并双份 cp（见 §十 R2-m1/m2）。
5. ~~临时目录 `/tmp/webclip-fix/`~~——真链路验证通过后已清（含修复前 dist 备份，恢复依赖 git 历史与本次验证记录）。

**处置轮外部访问补记（接 §七）**：微信文章页 GET 至少 6 次（5 篇存档 + 1 篇现抓冒烟）；本机 :8080 curl 若干；其余为本地构建、测试与 MCP stdio 握手（起独立 node 进程，不连网关、不读密钥、不调工具）；Hermes 仓 pytest 两次基线 + 三次修后验证（`PYTHONDONTWRITEBYTECODE=1 -p no:cacheprovider`）；18:00 起只读 `~/.hermes/logs` 与 launchctl 状态做重启取证（含凭证的日志行未写入任何文件）。git 写：llm_wiki `cc377bb3` / `414e4d1e` / `2eb1448e` / `b3af436f` / `f65fb086`、Hermes `084986d85f` / `2da13543a3` / `370956b3aa`，均已推 origin；部署写：`npm run build:web` 重写 `dist/`，`npm --prefix mcp-server test` 重建 live `mcp-server/dist`；零服务重启（16:57 那次非本会话发起）、零密钥读取。（勘误：原写「零 git 写操作」，与同节提交记录矛盾，见 §十）

---

## 十、闭环复审（11-24 19:30–23:45，用户口令「max 复查评审修复」）

> **方式**：协调者派发 4 个互不相见的独立评审席——R1 web_clip 修复、R2 技能回仓、R3 Hermes deselect 与文档删除、R4 报告·凭证卫生·N-2 部署态。每席只拿任务书与落盘证据，不带协调者的会话历史；协调者对每席的 Important 与承重数字亲手重验（双通道）。四席报告原文归档在 [evidence/verify/recheck/](evidence/verify/recheck/)（R1.md、R2.md、R3.md、R4.md）。
> **过程约束**：首轮 4 席并发在启动 4–6 分钟后全部停滞（账户级请求频率限速，HTTP 429 / 1302），按用户指示改为 1 席串行；R1 中途被停一次，后续问恢复。评审窗口内另一会话向 main 追加了 `0f17695f`、`e8ee2893`、`8887af93` 三笔提交并重建了 live `mcp-server/dist`，不在本轮评审范围内，只记录事实。

### 10.1 裁决汇总

| 对象 | 席 | 裁决 | C / I / M | 关键证据 |
|---|---|---|---|---|
| N-1 + W3-I1（`cc377bb3`） | R1 | **修复属实有效，可关账**；附 3 件收尾 | 0 / 0 / 9（另 1 条范围外） | 17 个变异体独立重跑全被杀、死因逐条对题；5 篇存档文章现抓修前 21–49 / 修后 3561–8086，与证据逐数相同；13 个非微信页修前修后提取结果逐字节相同；14 种隐藏形态下阈值均 fail-safe |
| W1-I3（`414e4d1e`） | R2 | **Yes** | 0 / 0 / 7 | 三轴互证：现态 live 与仓源 17/17 文件 sha256 相同；`414e4d1e` 的 blob 摘要等于 11-20 live 快照记录的摘要；工作树等于 HEAD |
| N-4 deselect（`084986d85f`） | R3 | **Yes** | 0 / 0 / — | 三行结果逐字复现（7 passed 1 deselected / 10 passed / 清空 addopts 仍 1 failed）；全量收集影响恰 −1；理由与代码钉子属实 |
| N-3 删除（`2da13543a3`、`370956b3aa`） | R3 | **Yes** | 0 / 0 / — | 路径集合与证据清单程序化相等；42 个 blob 本地可取；两棵树零悬空引用；新推上 origin 的 58 个对象无不该公开的内容 |
| N-2 部署态 + 记录与凭证卫生 | R4 | **承重结论成立；记录需勘误后可信** | 0 / 5 / 10 | 公开仓 59 个入库文件零真凭证；N-2 调用处实参为空模板字面量、与本地 dist 逐字节相同、13:07 后无重建 |
| **合计** | | **五项裁定全部可关账** | **0 / 5 / 32** | 5 条 Important 全在记录与防线层面 |

### 10.2 记录勘误（已落入本文件与两份证据文件；11-25 已提交 `7b6da1d6`，未推送）

1. **真链路段两个承重数字写错**（R4-I1，协调者通道与 R1 三方复算一致）：正文 2,544 → **2,493** 非空白字符（差值 51 疑为计数起点落在围栏行中段）；向量 4 → **10** chunks（该页自 19:06:05 写入起即 10 行，「4」找不到任何口径支撑）；「9 个概念页」补成 new_pages 10（`concepts/` 9 + `notes/` 1）。结论方向不变，数字已改。
2. **单位错标**（R1-M8 / P11）：「25–56」是含空白的 markdown 长度，非空白口径是 21–49。`report.md` §二 N-1 已改；`mcp-server/src/web-clip.ts:764` 的注释待随代码小修批一并改。
3. **N-4 证据的「旁路面」表述不实**（R3-M2，协调者亲核）：仓内没有任何 workflow 清空 addopts，带 `-m` 的通道只替换 marker 表达式，deselect 照样生效；唯一能复现那条红的口是显式 `-o addopts=""`。已在 `n4-deselect.txt` 追加勘误。另：`--deselect` 是 node id **前缀匹配**。
4. **恢复锚按分支写**（R3-M4 / R4-M1）：lt-tutor 用 `48fd4fb495`，zops 用 `5af434e836`；`n3-stale-docs.txt:81` 的「任一份可用 `3d499d0f6b`」对 4 份取到的不是终版。已改并在该文件追加勘误。
5. **过时与自相矛盾的状态行**（R4-I5）：§八 进度行、「N-3 注意 3」、「仍未做」的提交清单、§九 的生效时序、基线行的「两仓零改动」均已按终态改写。上游 `AGENTS.md` 是 15 份（根 + 14 个目录），不是根 + 13。
6. **访问账目漏记处置轮的写操作**（R4-I4）：原以「零 git 写操作」收尾，与同节的 8 个提交直接矛盾，已补 git 写与部署写清单。
7. **W1-I3 的关账证据是瞬态的**（R2-m3）：原写「工作区 `git status`」，已换成可重放的 sha256 比对结论；N-6 对技能文本「不适用」、409 条款的真实问题是归因（M-4）两处也已改。
8. 「`5af434e836` 此前未推」不准（R4-M3）：它早已是 origin/main 的祖先，本次只是首次进入 zops 远端分支。

未能核验、如实留档的：「schema 未变」「原断言因下划线转义恒真」两条当时未存对照证据，仅有旁证（R4-M10）。

### 10.3 待用户裁定（按价值排序；立项时均未动，11-25 进展见 10.7）

1. **重启网关**（R1-I-A，范围外）：并行会话的崩溃修复 `0f17695f`（微信老式 `__biz` 重定向链接把整个 MCP 进程打崩）已构建——live dist 21:42:34——但在跑的两个 MCP 进程启动于 20:54:05 / 21:28:15，均早于重建，**该修复尚未加载**。按硬约束 4、7 重启后用 `ps -o lstart` 与 dist mtime 对时。
2. **N-2 根因防线**（R4-I3）：`build:desktop` 末段的 `npm run build` 与 `build:web` 写同一个 `dist/`，而仓内没有任何成文步骤写「`tauri build` 之后必须重跑 `build:web`」——下一次打包就会把 live web 再打回桌面形态。建议：硬约束 3（`CLAUDE.md`）、`docs/development.md` 生产构建节、`docs/superpowers/deploy/` 三处补警示；可选结构性根治（桌面产物落独立 outDir）。连带：`build:desktop` 里的 `npm run mcp:build` 也会在打包时重写 live `mcp-server/dist/`。
3. **11 份 `*.log` 证据没上 origin**（R4-I2）：`.gitignore:44` 的 `*.log` 把 F821 门禁、SDK 测试、mcp 1.x 兼容、typecheck 等原始日志挡在 `2eb1448e` 之外，`git status` 也不提示。加否定规则或改后缀后补提交。
4. **web_clip 小修批**（R1，均一行到数行）：search 片段加 untrusted 标注（I-1 的检索回流残留，约 5 行）；阈值计数前剥 `\p{Cf}` / `\u00AD` / 变体选择符（当前 300 个零宽空格即可过阈值）；标题截断后再 trim（幂等的角落反例）；补 `doc.title` 回落测试（变异存活）；`empty_content` 文案补「内容太短或以图片为主」；`CLAUDE.md:33` 用例数 330 → 344。下批可选：微信分支单块正文直接取容器；链接 title 属性里的 `[[…]]` 未转义；行为变更时提升包版本号。
5. **Hermes 小修批**（R3）：在 fork 自有的 `tests/test_mcp_circuit_breaker.py` 里加一个元测试，断言以 deselect 前缀开头的上游用例恰有 1 个（同时防「改名后静默空转」与「同前缀静默扩大」，且自动进 `fork_gate`）；是否把 N-4 移植到 zops 分支；`_retry_once` 的 docstring 仍写上游语义（H2-M1）；`main` / `origin/main` 是否前移到 `2da13543a3`。
6. **技能文本热修**（R2）：家长会行补 `skill_view` 两步骨架（m1）；409 条款归因改写（m2）；description 登记家长会能力（m4）；补 dry-run 脚本 13（m5）；核心已 27,177B，10-31「再膨胀优先外移快速路径表」的记档被触发两次未动，两条事故沉淀条目适合外移（m6）；`parent-communication.md:20` 的近义词「沟通」在视频检索面是空枪（m7）。`e8ee2893` 新增那行的第 ② 半句要求 tail 日志，教师通道模型没有 terminal 工具，是写给运维看的。
7. **全局技能 `~/.hermes/skills/lt-teacher-tutor/`**（R2-R1，范围外）：另一个技能（`name: lt-teacher-tutor`），与仓源零同文件、目录内无 `.git`，11-24 21:50 仍在被直写——与 W1-I3 同类的「全机唯一副本」风险。是否收编入仓待定。
8. **部署脚本防漂移**（R2-R2）：`lt-tutor-deploy.sh:534` 无条件用仓源覆盖 live，下一次 live 直写仍会静默发生。建议 cp 前加只读对齐检查。
9. **R3 席事故现场**：live 检出内 417 个 `.pyc` 与一个指纹文件（均在 gitignore 内）是否清理，见 10.4。
10. **提交推送**：本轮勘误（`report.md` + 两份证据文件）与归档目录 `evidence/verify/recheck/`（4 份）尚未提交。

### 10.4 评审事故（R3 席自报，协调者亲核）

- **经过**：21:03:48 R3 席在一条 Bash 命令里把反引号包着的 `hermes init` 写进双引号的 echo，zsh 当作命令替换执行了 `~/.local/bin/hermes init`。启动器先 cd 进 live 检出再启动 CLI，且不带 `PYTHONDONTWRITEBYTECODE`；CLI 在参数解析前跑完启动序，随后以「'init' is not a hermes command」退出。任务书的「本机坑」清单漏了这一条，属协调者疏漏。
- **实际影响**（协调者逐项核实）：live 检出写入 417 个 `.pyc`（93 个 `__pycache__`）与 `.bytecode-fingerprint`（21:03:48），全在 gitignore 内，`git status` 仍只有 `?? .zcode/`；触发一轮启动期维护——`state.db` 只读完整性检查通过、配置未迁移、默认 home 的插件目录缓存失效一次（下次访问自动重建）、写了一条 bootstrap 记录；日志窗口 36 行里零外呼、零 WARNING 以上。网关主进程 977 未重启。
- **判断**：无功能损害。那批 `.pyc` 与网关自身启动时写的同质（网关进程环境里没有 `PYTHONDONTWRITEBYTECODE`）。清理属对 live 检出的写操作，留给所有者裁定。此后各席任务书已补该坑。

### 10.5 过程教训

- **并发即限速**：4 席并发全体停滞，2 席 + 主会话连发请求仍撞 1302。限的是账户级请求频率，子智能体并发上限降为 1，主会话在代理运行期间合并命令。
- **任务书必须带全本机坑**：记忆里有、任务书里没有，等于没有。
- **评审飞行中地面会动**：窗口内 main 前进 3 笔、live dist 被重建、MCP 子进程被重新拉起。状态类结论一律以取证时刻为准，R1、R4 都记了两次基线。
- **承重数字必须双通道**：两个错数（2,544、4）和一个不完整（9）都是独立复算才抓出来的，当时的单通道自检没有发现。
- **证据入库后要对数**：`.gitignore` 会静默挡掉文件而 `git status` 不提示，落盘后应核对 `git ls-files` 的计数。
- **评审席的哈希也要核**：R4 报的 SKILL.md 哈希前缀与协调者、R2 实测的不同，报告以两方一致的实测为准。

### 10.6 本轮外部访问账目

- **git 写**：零。两仓仅工作区有未提交改动（`report.md`、两份证据文件）与未跟踪的 `evidence/verify/recheck/`；无提交、无推送、无 fetch。
- **服务操作**：零。无重启、无 launchctl 变更、无 kill。
- **密钥**：零读取、零回显。协调者读 `~/.hermes/logs` 一处做事故取证，命令里带凭证行过滤。
- **外呼**：R1 对 `mp.weixin.qq.com/s/<id>` 文章页 GET 7 次（不带凭证）；R4 本机 `127.0.0.1:8080` curl 4 次、`gh repo view` 1 次；其余零外网。
- **生产库**：协调者、R2、R4 只读 SELECT；会话库只读打开、只出计数与所有者本人那一条回复。
- **构建与测试**：R1 全在 `/tmp` 副本内（tsc ×6、全量 `node --test` ×23）；R3 在 live 检出按指定形态跑 pytest 8 次（每次之后 `git status --short` 仍只有 `?? .zcode/`）。
- **唯一的越界写入**即 10.4 所述事故。

### 10.7 处置进展（11-25，用户逐项口令）

| 10.3 条目 | 状态 | 落点与证据 |
|---|---|---|
| 1 重启网关 | 已办 | 05:31 `kickstart -k`，pid 977 → 47016；MCP 子进程 05:31:42 重拉，`0f17695f` 已加载 |
| 2 N-2 根因防线 | 已办 | 三处成文 `300c3771`；结构性根治 `e9738730`——桌面形态产物落 `dist-desktop/`、`build:desktop` 不再重建 mcp-server、回归钉 `src/lib/build-form.test.ts`。证据 `evidence/verify/raw/n2-structural-fix.txt` |
| 10 提交推送 | 提交已办，未推送 | `7b6da1d6`（勘误 + 归档）、`710111b0`、`300c3771`、`e9738730` 及本节所在的账目提交；推送待口令 |

N-2 结构性根治的核验：回归钉 6 个变异体全杀且死因对题；`npm run build` → `dist-desktop/`、`npm run build:web` → `dist/`（221 个文件与基线内容逐一同）；`tauri build` 端到端一趟（release 7m21s，exit 0）前后 live `dist/`、`mcp-server/dist`、`node_modules` 四项快照零变化，release 二进制内嵌 28/28 个桌面独有资源名、0/28 个 web 独有资源名；:8080 仍下发 web 形态，MCP 子进程未重启。**未验**：CI 三平台打包、默认 bundles（含 DMG）、桌面包冒烟。一处取舍：桌面包内 MCP 代码的新鲜度此后依赖打包前的显式 `npm run mcp:build`（原先由 beforeBuildCommand 强制重建保证，代价是改写线上）。

连带（巡检时撞见，非评审项）：03:17 周报巡检的开办步自 11-06 首跑起日败——hermes-3.11 的 editable 安装是 import-hook 映射，缺根级 `hermes_yaml`，launchd cwd 下 `from cron import jobs` 断链。`710111b0` 已修；存量六教师的周报任务一直在，零生产损害。
