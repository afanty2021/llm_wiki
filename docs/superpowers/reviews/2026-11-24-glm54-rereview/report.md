# glm-5.4 重评报告：两仓近期变更（2026-11-24，含核验轮更新）

> **评审方式**：定时任务自动执行（11-24 01:45 触发，01:47 预检，02:17 收官）。协调者并发派发 6 个独立评审子代理（W1-W4 仓 A / H1-H2 仓 B），每个子代理先独立评审、再逐条核对前轮 glm-5.3 报告的承重声明、最后找前轮漏掉的问题；协调者对全部 7 条 Important 逐条亲手重验（命令实跑或读码对到行）。
> **核验轮**（11-24 07:30–13:00，用户口令「report.md 中未核验清单要进行核验，授权跑真实脚本」）：六份子报告的未核验清单已逐项核验，结果见 §五；新发现 N-1…N-6 并入 §二；证据在 evidence/verify/（[coordinator-verification.md](evidence/verify/coordinator-verification.md)、[hermes-verification.md](evidence/verify/hermes-verification.md)、[ltutor-text-verification.md](evidence/verify/ltutor-text-verification.md)、[integration-verify.md](evidence/verify/integration-verify.md)、raw/）。
> **闭环复审**（11-24 19:30–23:45，用户口令「max 复查评审修复」）：四席独立复查五项处置，裁决、勘误与待裁定项见 §十。**第二轮复审**（11-25，用户口令「max 复查近期评审修复」）：四席串行复查其后 8 笔从未被独立评审过的提交，裁决、合并修复清单与勘误见 §十一。
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
  - 修法：`npm run build:web`；发版配方补「`tauri build` 之后必须重跑 `build:web`」。 **→ 13:07 已执行并验证，live 已是同源形态，见 §九；根因（`tauri build` 覆盖 `dist/`）在 11-24 22:50 时仓内尚无成文防线（§十 R4-I3），已于 11-25 三处成文（`300c3771`）并结构性根治（`e9738730`），见 10.7 与 §十一。**
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

> 进度（11-25 更新）：must-fix 1–4 与 cheap wins 的 N-3、N-4 已完成；N-2 的根因防线已办（发版配方补步由产物目录分流取代，见 10.7）；未做：N-5、N-6 措辞，must-fix 5–8 无完成记录（见 §六）。明细见 §九、§十、§十一。

**must-fix（建议顺序）**
1. ~~N-2~~ **已完成**——build:web 已于 11-24 13:07 执行；发版配方补步已由结构性根治取代（桌面产物落 `dist-desktop/`，`e9738730`；三处成文 `300c3771`），见 10.7。
2. **N-1**：web_clip 微信正文提取 + 低于阈值不报成功（与 I-1 同文件一并修，补真实样式夹具）。修好前别向教师推介该工具。
3. ~~W1-I3 漂移回仓~~ **已回仓并推送**（`414e4d1e`，11-24 18:49）；N-6 的两处措辞未随回仓改动，见 10.3 #6。
4. ~~W3-I1~~ **已完成**（随 `cc377bb3`，见 §九）；检索回流残留等小修见 10.3 #4。
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
| N-3 | ✅ 已实删（用户口令「N-3 实删（连 zops 分支一并清）」） | 可以整批删除、无需分流保留。`lt-tutor-vendor-patches` 删除提交 `2da13543a3`；`zops-vendor-patches` 删除提交 `370956b3aa`（架在本地 zops tip 5af434e836 上——该提交早已是 origin/main 的祖先，本次只是首次进入 zops 远端分支；26692c43b9→370956b3aa）。四 ref（两分支×本地/origin）doc 计数均 21→0；`main` / `origin/main` 仍停在 `48fd4fb495`（21 份俱在、无 deselect，未推进）。恢复锚按分支：lt-tutor 用 `git show 48fd4fb495:<path>`（即 `2da13543a3^^`；`2da13543a3^` 是 `084986d85f`，勘误见 §十一），zops 用 `git show 5af434e836:<path>`（即 `370956b3aa^`；其根 `CLAUDE.md` 比 lt-tutor 版少 11-08 那 2 行刷新，其余 20 份相同） | `evidence/verify/raw/n3-stale-docs.txt` |

**N-1 + W3-I1 细节**（`mcp-server/src/web-clip.ts`、`src/training.ts` 与三个测试文件）
- 微信分支：仅当最终 URL 主机名精确等于 `mp.weixin.qq.com` 时，把 `#js_content` 自身的 `visibility: hidden` 揭开（不碰任何子元素），再交给 Readability；正文非空白字符 < 200 抛 `empty_content`，不再回「已收藏」。
- `sanitizeClipTitle`：剥格式字符与变体选择符、控制字符折成空格、折叠空白、按码点截断到 120；提取时与回执拼装时各洗一次。
- 正文入库前加一行 untrusted 提示（`CLIP_UNTRUSTED_NOTICE`）。
- 验证：新增 13 例（合计 343/343，typecheck 0 错）；17 个变异体全部被杀（其中 1 条断言原先因 turndown 转义下划线而恒真，换成不含下划线的标记并加正向对照后才是真钉子）；真实微信 6 篇：修前 21–49 字符的页头碎片 → 修后 2150–8086 字符，署名杂物清零、标题不变；live dist 由仓内正式测试重建，新产物握手 18 工具、schema 未变。闭环复查：17 个变异体经独立重跑全部被杀且死因逐条对题、5 篇存档文章现抓数字与证据逐数相同（见 §十）；「schema 未变」「原断言因下划线转义恒真」两条当时未存对照证据，仅有旁证。
- 已知边界：正文只有一个段落的极短文章，Readability 会选到带页头的外层容器，约 41 字署名混进正文开头（合成夹具口径；闭环复查在真实页骨架上实测杂物 46–61 字，单个块级块的正文字数到约 450 仍会选中外层容器、500 起才精确命中，见 §十 R1-M2）（6 篇真实文章均为多段落、精确命中 `#js_content`）。要彻底消除可改成微信分支直接取 `#js_content` 节点，本轮未做。
- 归档勘误：`before-after.txt` 的 13:55 初版误存了首次运行的报错、缺 5 篇对照表；15:05 已重跑并重写，数字与原汇报逐数一致。
- 生效：16:57 网关重启后，两个 MCP 子进程（16:57:11/12 启动）载入的是 13:50 构建的 dist。（11-24 22:00 复核：子进程已于 20:54:05 / 21:28:15 重新拉起；`mcp-server/dist` 于 21:42:34 被并行会话的崩溃修复 `0f17695f` 重建，在跑的两个进程均早于它启动——当时记「该修复尚未加载，需重启网关」，勘误：这是误判，并行会话 20:53 已现场重建 dist，训练子进程 20:54:05 按需重拉后即已加载，其后对同两条老链的 7 次调用全部优雅返回、零新崩溃，21:42:34 只是又一次等价重建，见 §十一；11-25 05:31 网关重启，见 10.7）

**真链路验证（19:04–19:09，用户企微真发）——全链通过 ✅**
- 链路：WeCom 入站（HuangZhengBo 发 `mp.weixin.qq.com/s/eyKga8P5qyIj2eUwsg2J_w`，19:04:58）→ lt-tutor 会话 → `teacher_tutor_web_clip` 返回 **`status: "created"`**（jobId `6f953d4a`）→ 回复 308 字符于 19:06:23 生成（与另一件缺书登记合并成一条回复；库内只记生成时刻，送达时刻无记录）。
- 落库产物：`sources/clips/…-e574c75a.md`——`> ⚠ untrusted` 提示行在、提示行后正文 **2,493** 非空白字符（围栏行另 68；旧 bug 形态是 20–50 的署名碎片）、署名杂物 0、frontmatter 带 `clipped_by/at`；`clips/` wiki 页 2,967 字符（整页口径，含 frontmatter 与围栏行，md5 与盘上文件相同）；embeddings **10** chunks（chunk_index 0–9）；ingest job `succeeded_with_warnings`（warnings 10 条，均为 guard-v2 的「非路径 source 条目迁入概念页 citations」，预期机制），new_pages 10：`concepts/` 9 + `notes/` 1。（勘误：原记 2,544 / 4 chunks 有误，见 §十）
- 行为观察（非缺陷）：模型先调内置 `web_extract`（Tavily）读文摘要、再调 web_clip 收藏——比 SKILL 快速路径的「链接即收藏」多一步；回执里的简介出自 Tavily，库里正文出自 Readability，两源独立。同一回合还有一次 `terminal` 调用是会话既有《杠杆式学习》缺书登记的顺带查重，与本功能无关（既有 'always' 自动批准）。
- 复核插曲如实记：协调者第一轮核验（19:05:58）早于文件落库（19:06:03–05）七秒，一度误判「未落库」——以库内行/盘上文件的 created_at 对时后才翻案，教训同 [[部署声明按证据核验]]。
- 后续真实使用（闭环复查补记）：19:17 起持续有收藏，截至 22:00 共 24 份（均为仓库所有者本人）。协调者通道对前 21 份只读体检——全部带围栏行、正文 1,345–6,663 非空白字符、页头署名污染 0；24 个 ingest job 中 20 个 `succeeded_with_warnings`、4 个 `succeeded`（R4 取证）；每个收藏页 8–25 个向量块。20:51–20:52 两条老式 `__biz` 链接把 MCP 训练进程打崩 4 次（并行会话当场修复，20:54:05 起加载，见 §十一；那两篇最终是经会话内脚本落盘的，不是经 `teacher_tutor_web_clip`）。

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
1. ~~两仓提交与推送~~ **已完成**（用户口令「提交并推送」，11-24 18:48–18:52）：llm_wiki `main` = `cc377bb3`（web_clip 修复）+ `414e4d1e`（漂移回仓）+ 本目录落盘提交；Hermes `lt-tutor-vendor-patches` = `084986d85f`（pyproject deselect）。均已推 origin。（此为 18:52 时点；其后 llm_wiki 另有 `b3af436f`、`f65fb086` 两笔报告更新，Hermes 另有 `2da13543a3`；并行会话于 21:35–21:42 追加 `0f17695f`、`e8ee2893`、`8887af93`，均已推；11-25 另有 5 笔本地提交未推送，见 10.7。）
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
| W1-I3（`414e4d1e`） | R2 | **Yes** | 0 / 0 / 7 | 三轴互证：(a) 现态 live = 仓源工作树 = HEAD，17/17 文件 sha256 相同；(b) `414e4d1e` 的 blob 摘要等于 11-20 live 快照记录的摘要；(c) `parent-communication.md` 的 live / 仓源 / blob 三处同 sha256 |
| N-4 deselect（`084986d85f`） | R3 | **Yes** | 0 / 0 / —（R3 的 6 条 Minor 记在下一行） | 三行结果逐字复现（7 passed 1 deselected / 10 passed / 清空 addopts 仍 1 failed）；全量收集影响恰 −1；理由与代码钉子属实 |
| N-3 删除（`2da13543a3`、`370956b3aa`） | R3 | **Yes** | 0 / 0 / 6 | 路径集合与证据清单程序化相等；42 个 blob 本地可取；两棵树零悬空引用；新推上 origin 的 58 个对象（26 blob + 29 tree + 3 commit）无不该公开的内容 |
| N-2 部署态 + 记录与凭证卫生 | R4 | **承重结论成立；记录需勘误后可信** | 0 / 5 / 10 | 公开仓 59 个入库文件零真凭证；N-2 调用处实参为空模板字面量、与本地 dist 逐字节相同、13:07 后无重建 |
| **合计** | | **五项裁定全部可关账** | **0 / 5 / 32** | 5 条 Important 全在记录与防线层面 |

### 10.2 记录勘误（已落入本文件与三份证据文件；11-25 已提交 `7b6da1d6`，未推送）

1. **真链路段两个承重数字写错**（R4-I1，协调者通道与 R1 三方复算一致）：正文 2,544 → **2,493** 非空白字符（差值 51 疑为计数起点落在围栏行中段）；向量 4 → **10** chunks（该页自 19:06:05 写入起即 10 行，「4」找不到任何口径支撑）；「9 个概念页」补成 new_pages 10（`concepts/` 9 + `notes/` 1）。结论方向不变，数字已改。
2. **单位错标**（R1-M8 / P11）：「25–56」是含空白的 markdown 长度，非空白口径是 21–49。`report.md` §二 N-1 已改；`mcp-server/src/web-clip.ts:764`（现为 `:769`）的注释待随代码小修批一并改，已补进 10.3 #4。
3. **N-4 证据的「旁路面」表述不实**（R3-M2，协调者亲核）：仓内没有任何 workflow 清空 addopts，带 `-m` 的通道只替换 marker 表达式，deselect 照样生效；唯一能复现那条红的口是显式 `-o addopts=""`。已在 `n4-deselect.txt` 追加勘误。另：`--deselect` 是 node id **前缀匹配**。
4. **恢复锚按分支写**（R3-M4 / R4-M1）：lt-tutor 用 `48fd4fb495`，zops 用 `5af434e836`；`n3-stale-docs.txt:81` 的「任一份可用 `3d499d0f6b`」对 4 份取到的不是终版。已改并在该文件追加勘误。
5. **过时与自相矛盾的状态行**（R4-I5）：§八 进度行、「N-3 注意 3」、「仍未做」的提交清单、§九 的生效时序、基线行的「两仓零改动」均已按终态改写。上游 `AGENTS.md` 是 15 份（根 + 14 个目录），不是根 + 13。
6. **访问账目漏记处置轮的写操作**（R4-I4）：原以「零 git 写操作」收尾，与同节的 8 个提交直接矛盾，已补 git 写与部署写清单。
7. **W1-I3 的关账证据是瞬态的**（R2-m3）：原写「工作区 `git status`」，已换成可重放的 sha256 比对结论；N-6 对技能文本「不适用」、409 条款的真实问题是归因（M-4）两处也已改。
8. 「`5af434e836` 此前未推」不准（R4-M3）：它早已是 origin/main 的祖先，本次只是首次进入 zops 远端分支。

未能核验、如实留档的：「schema 未变」「原断言因下划线转义恒真」两条当时未存对照证据，仅有旁证（R4-M10）。

### 10.3 待用户裁定（按价值排序；立项时均未动，11-25 进展见 10.7）

1. **重启网关**（R1-I-A，范围外）：并行会话的崩溃修复 `0f17695f`（微信老式 `__biz` 重定向链接把整个 MCP 进程打崩）已构建——live dist 21:42:34——但在跑的两个 MCP 进程启动于 20:54:05 / 21:28:15，均早于重建，**该修复尚未加载**（§十一勘误：这一判断有误，修复已于 11-24 20:54:05 加载；网关已在 11-25 05:31 重启，见 10.7）。按硬约束 4、7 重启后用 `ps -o lstart` 与 dist mtime 对时。
2. **N-2 根因防线**（R4-I3）：`build:desktop` 末段的 `npm run build` 与 `build:web` 写同一个 `dist/`，而仓内没有任何成文步骤写「`tauri build` 之后必须重跑 `build:web`」——下一次打包就会把 live web 再打回桌面形态。建议：硬约束 3（`CLAUDE.md`）、`docs/development.md` 生产构建节、`docs/superpowers/deploy/` 三处补警示；可选结构性根治（桌面产物落独立 outDir）。连带：`build:desktop` 里的 `npm run mcp:build` 也会在打包时重写 live `mcp-server/dist/`。
3. **11 份 `*.log` 证据没上 origin**（R4-I2）：`.gitignore:46`（立项时在 :44）的 `*.log` 把 F821 门禁、SDK 测试、mcp 1.x 兼容、typecheck 等原始日志挡在 `2eb1448e` 之外，`git status` 也不提示。加否定规则或改后缀后补提交。
4. **web_clip 小修批**（R1，均一行到数行）：search 片段加 untrusted 标注（I-1 的检索回流残留，约 5 行）；阈值计数前剥 `\p{Cf}` / `\u00AD` / 变体选择符（当前 300 个零宽空格即可过阈值）；标题截断后再 trim（幂等的角落反例）；补 `doc.title` 回落测试（变异存活）；`empty_content` 文案补「内容太短或以图片为主」；`CLAUDE.md:33` 用例数 330 → 344。首轮遗留、第二轮补记（R4-I5）：回执层 `prevClippedBy` / `prevClippedAt` 折叠截断与非字符串 `title` 的类型判断（首轮 R1-M5）；`kebabSlug` 按码点截断，免得文件名带孤立代理项（首轮 R1-M9）；`web-clip.ts:769` 注释的单位（10.2 #2）；`docs/CHANGELOG.md` 补一条（可选）。下批可选：微信分支单块正文直接取容器；链接 title 属性里的 `[[…]]` 未转义；行为变更时提升包版本号。
5. **Hermes 小修批**（R3）：在 fork 自有的 `tests/test_mcp_circuit_breaker.py` 里加一个元测试，断言以 deselect 前缀开头的上游用例恰有 1 个（同时防「改名后静默空转」与「同前缀静默扩大」，且自动进 `fork_gate`）；是否把 N-4 移植到 zops 分支；`_retry_once` 的 docstring 仍写上游语义（H2-M1）；`main` / `origin/main` 是否前移到 `2da13543a3`；首轮 R3 的建议 R4：N-3 删掉根 `CLAUDE.md` 的「本地修改」一节后，仓内不再有成文的东西描述 fork 的本地改动，哪怕一份很短的分歧登记表也值得补。
6. **技能文本热修**（R2）：家长会行补 `skill_view` 两步骨架（m1）；409 条款归因改写（m2）；description 登记家长会能力（m4）；补 dry-run 脚本 13（m5）；核心已 27,177B，10-31「再膨胀优先外移快速路径表」的记档被触发两次未动，两条事故沉淀条目适合外移（m6）；`parent-communication.md:20` 的近义词「沟通」在视频检索面是空枪（m7）。`e8ee2893` 新增那行的第 ② 半句要求 tail 日志，教师通道模型没有 terminal 工具，是写给运维看的。
7. **全局技能 `~/.hermes/skills/lt-teacher-tutor/`**（R2-R1，范围外）：另一个技能（`name: lt-teacher-tutor`），与仓源零同文件、目录内无 `.git`，11-24 21:50 仍在被直写——与 W1-I3 同类的「全机唯一副本」风险。是否收编入仓待定。
8. **部署脚本防漂移**（R2-R2）：`lt-tutor-deploy.sh:534` 无条件用仓源覆盖 live，下一次 live 直写仍会静默发生。建议 cp 前加只读对齐检查。
9. **R3 席事故现场**：live 检出内 417 个 `.pyc` 与一个指纹文件（均在 gitignore 内）是否清理，见 10.4。
10. ~~提交推送~~ 首轮勘误与归档已提交（`7b6da1d6`）；连同其后 4 笔共 5 笔未推送（见 10.7），另有第二轮归档 `evidence/verify/recheck2/` 与 §十一 的行内勘误未提交。

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

N-2 结构性根治的核验：回归钉 6 个变异体全杀且死因对题；`npm run build` → `dist-desktop/`、`npm run build:web` → `dist/`（221 个文件与基线内容逐一同）；`tauri build` 端到端一趟（release 7m21s，exit 0）前后对 live `dist/`、`mcp-server/dist` 的 sha256 与 mtime 及 `mcp-server/node_modules` 的 inode 与 `.package-lock.json` 四项快照零变化，release 二进制内嵌 28/28 个桌面独有资源名、0/28 个 web 独有资源名；:8080 仍下发 web 形态，MCP 子进程未重启。**未验**：CI 三平台打包、默认 bundles（含 DMG）、桌面包冒烟。打包链不再强制重建之后，桌面包内 MCP 代码有三个事实要记住（2026-11-25 实测，`coordinator/summary-tauri-mcp.txt`）：① bundle 里的 `node_modules` 不再由 lockfile 经 `npm ci` 校验，拷的是检出里现成的那份；② `mcp-server/dist` 的改动会随每次打包重新拷入（改动文件与新增文件都进了包），所以包内代码的新鲜度靠打包前的显式 `npm run mcp:build`（原先由 beforeBuildCommand 强制重建保证，代价是改写线上）；③ `mcp-server/dist` 缺失时构建 8 秒内报错、不会静默出包，但失败的那一趟不清上一趟留下的 `.app`——发布脚本要看退出码。

连带（巡检时撞见，非评审项）：03:17 周报巡检的开办步自 11-06 起日败（勘误见 §十一：巡检任务生于 09-05，开办步在 09-07、09-10 成功过，到 11-25 03:17 共败 20 趟）——hermes-3.11 的 editable 安装是 import-hook 映射，缺根级 `hermes_yaml`，launchd cwd 下 `from cron import jobs` 断链。`710111b0` 已修；存量六教师的周报任务一直在；受损的是这段时间里新完成问卷的教师不会被自动开办（11-26 03:17 起恢复，首跑结果见 §十一 11.9）。任务名判重不分大小写与「该 launchd 任务无监控」两处缺口已于 11-25 修在工作树（未提交，见 §十一 11.9）。

---

## 十一、第二轮复审（11-25，用户口令「max 复查近期评审修复」）

> **对象**：11-24 晚闭环复审之后新增、且从未被独立评审过的 8 笔提交。未推送 5 笔：`7b6da1d6`（首轮勘误与四席归档）、`710111b0`（03:17 周报巡检 provision 断链修复）、`300c3771`（N-2 三处成文）、`e9738730`（N-2 结构性根治）、`cb78ed06`（10.7 与证据）；已推 3 笔：`0f17695f` / `e8ee2893` / `8887af93`（web-clip 崩溃修复、技能 note、回归钉）。
> **方式**：四个互不相见的独立评审席**串行**派出（子智能体并发上限 1），每席只拿任务书与落盘证据；协调者对每席的 Important 与承重数字亲手重验——变异实跑、自写探针、自己的 dry-run、日志与会话库取证。R2 首席 11:47 断线、零产出，18:10 重派为 R2b；首席留在临时目录里的中间产物只当线索，未采信其结论，也未归档。
> **窗口**：R1 10:39–11:08；R2b 18:10–18:37；R3 18:55–19:23；R4 19:31–20:11。窗口内地面未动：HEAD `cb78ed06`、origin/main `8887af93`、live `dist/`（08:48:45）与 `mcp-server/dist`（05:31:03）、三个 MCP 子进程（05:31:42–43）自 10:39 到 20:13 始终未变。
> **归档**：四席原文与协调者证据在 [evidence/verify/recheck2/](evidence/verify/recheck2/)（R1.md–R4.md、coordinator/、r3-raw/、r4-raw/，共 46 个文件；origin 是公开仓，教师企微 id 已脱敏为 TeachA–TeachG，落盘前后各做一遍卫生扫描）。本节的行内改句由 `coordinator/scripts/report-corrections.py` 落实，逐条可复演。

### 11.1 裁决汇总

| 对象 | 席 | 裁决 | C / I / M | 关键证据（席报 + 协调者亲验） |
|---|---|---|---|---|
| N-2 结构性根治（`300c3771` / `e9738730`，账目 `cb78ed06`） | R1 | **属实，补齐后可关账** | 0 / 1 / 6 | 根治本体：四个构建入口的行为、与 live 逐字节比对、6 个变异体、2592 / 182、28 / 28 均独立复现；协调者另跑 `tauri build` 端到端一趟（775s，冷构建），前后 live 零写入。**I-1 回归钉钉的是实例不是不变量**：席报 18 个变异体中 6 个存活，协调者复现并加码 2 个也存活，R4 又加 1 个——合并修法见 11.3-1 |
| web-clip undici 崩溃修复（`0f17695f` / `e8ee2893` / `8887af93`） | R2b | **属实，补齐后可关账** | 0 / 2 / 7 | 基线 344 = 343 过 / 0 败 / 1 跳；协调者自写的全路径钉 9 / 9 绿，删监听器后原钉与全路径钉同红；live dist 与干净构建同字节。I-1 钉在闭包上、不在生产路径；I-2 技能 note「冷却 2 小时以上」没有观测支撑 |
| 03:17 周报巡检 provision 断链修复（`710111b0`） | R3 | **属实，补齐后可关账** | 0 / 2 / 8 | 协调者沙箱探针：不带修复行 `ModuleNotFoundError: No module named 'hermes_yaml'`，栈帧与生产日志逐帧相同；带修复行 import 成功。live `--dry-run` 一次 rc=0。I-1 判重不分大小写；I-2 这个 launchd 任务没有任何监控 |
| 记录与成文防线（`7b6da1d6`、本文件、10.7、`cb78ed06`） | R4 | **属实，补齐后可关账** | 0 / 5 / 10 | 归档自入库起零改动、无改写痕迹（原件已不存在，做不到逐字节比对）；首轮 8 条勘误 7 条准确落实；10.7 每个可复现数字都对上；成文三处的核心事实句属实。5 条 Important 全在「写下来的话」层面 |
| **合计** | | **四个对象全部属实有效，无一需要回退** | **0 / 10 / 31** | 10 条 Important 协调者逐条亲验属实。另：R4 对「崩溃修复尚未加载」的判断被协调者改判（11.4），不改变任何修复的有效性 |

### 11.2 协调者亲验要点（明细见 `coordinator/notes.md`）

- **R1（N-2）**
  - 原钉 4 例基线绿。席报的 6 个存活体全部复现为 4 / 4 绿：mode 判据翻转、macOS 平台 conf 覆盖 `frontendDist`、Windows 平台 conf 串回 mcp、`prebuild` 钩子重建 mcp、桌面构建带 `--outDir dist`、web 构建带 `--outDir dist-desktop`。协调者加码的两个也存活：`pretypecheck` 钩子（挂在链上内层脚本）、kebab 写法 `--out-dir`。席报给的四段加固断言能杀前 6 个、放过后 2 个。
  - 行为：副本里 `build:web` → `dist/` 221 / 221 与 live 同字节；`npm run build` → `dist-desktop/` 221 / 221，`dist/` 0 / 221 变化；裸 `vite build --outDir dist` 会把 `dist/` 换成桌面形态（249 个条目里 57 个变化）；`vite preview` 预览的是 `dist-desktop/`（M-6 属实）。`test:mocks` 182 文件 / 2592 例全绿。
  - `npm run tauri -- build --bundles app -- --offline` 端到端：rc=0，775s；脚本链 `tauri → build:desktop → build → typecheck && vite build`，全日志零 mcp 构建；前后 live `dist` 0 / 221、`dist-desktop` 0 / 221、`mcp-server/dist` 0 / 31、`mcp-server/node_modules` 四项快照全同；bundle 内 `mcp-server` 四个抽样文件与检出同字节，二进制内嵌桌面独有资源名 28 / 28、web 独有 0 / 28。R1-M1 指出原作者对「一趟打包对 live 零写入」只留了手写摘要，这一趟补上了原件（`coordinator/summary-tauri.txt`）。
  - 仍未验：CI 三平台打包、默认 bundles（含 DMG）、桌面包冒烟。
- **R2b（web-clip）**
  - live `mcp-server/dist/src/web-clip.js` :516–517 含一次性监听器与 destroy，sha256 `f3b8562d…`，与 HEAD 干净构建同字节；undici 6.29.1。基线 344 例在生产 node 26.12.1 与本机 26.13.0 上一致。
  - 全路径钉（经 `fetchWithGuards` 的重定向分支，注入 `lookupAll` 与生产 `undiciRequestOnce`）9 / 9 绿；删监听器后两枚钉同红（`UND_ERR_ABORTED` / `uncaughtException`），全量 345 例 = 342 过 / 2 败 / 1 跳。
  - 「把监听器放到三处调用点」这个看起来等价的替代修法过不了 typecheck（`GuardedResponse.body` 是 `AsyncIterable`，没有 `once`，TS2339 ×3）——不是可替换的写法。所以现钉的问题是钉得不够（生产路径不在覆盖内），外加一处过头（`body.destroyed` 断言会把不崩的「排空代替销毁」判红）。
  - I-2 的结论属实（三份副本里的时长都没有观测支撑），但席报引的反证不成立，见 11.4。
- **R3（03:17 巡检）**
  - I-1 属实：`auto-provision-weekly.sh:46` 原样输出任务名后缀，`:63` 与 `:70` 用区分大小写的 `grep -qx` 比对；库里的用户名与既有任务名只差首字母大小写，于是每晚都走一遍开办脚本。I-2 属实：该 launchd 标签只出现在脚本自身与一份 runbook 里，`launchctl print` 显示它上一次退出码是 1 而无人知晓；`ai.hermes.gateway.monitor` 未加载。
  - 承重数字全部复现：巡检日志 19400 字节 / 380 行 / 20 趟 / 0 趟「巡检完成」，日志文件生于 11-06 03:17:05，launchd 任务生于 09-05 10:28:17；03:17 时刻的主 config 备份 3 个（09-07、09-10 ×2），根下 `.bak-*` 26 个；六个任务的创建时刻、finder 的 mtime 与 23 项映射、检出根可 import 顶层名 99（85 个 py + 14 个包）。
  - 席报 C7「网关 cwd = 检出」不属实：网关 plist 的 `WorkingDirectory` 是 `~/.hermes`，检出根是 `hermes_cli/main.py:44-46` 插到 `sys.path[0]` 的。
  - 沙箱探针（HOME 指向假目录、审计钩子拒绝沙箱外写入 / 子进程 / 联网）：不带修复行的报错栈帧 `<string> → cron/__init__.py:13 → cron/jobs.py:49 → utils.py:20`，与生产日志逐帧相同；带修复行 import 成功、只有 `hermes_yaml` 需要补路径。
  - live `--dry-run` 恰好一次（19:38:57）：rc=0，0.12s，输出与席报逐行相同，三步全跳过。
- **R4（记录与成文防线）**
  - I-1 属实：本文件六处现在为假或过时未标（`:49` / `:179` / `:182` / `:184` / `:185` / `:242`）。I-2 属实：`2da13543a3^` 是 `084986d85f`，`48fd4fb495` 是 `2da13543a3^^`；错误括注的源头是首轮归档 `R4.md:211` 的建议句，当时未核验即采纳。I-4 属实：live `mcp-server/dist` 31 个文件 mtime 全是 05:31:03、`dist/index.html` 是 08:48:45，这两次写在账目里都没有。I-5 属实：首轮至少 5 条席位条目既未处置、也不在 10.3。
  - I-3 属实（变异实跑）：R4 的「`build:desktop = npm run build -- --mode web`」原钉 4 / 4 绿存活——`expand()` 丢掉了 `--` 之后的透传参数；协调者上一轮的加固版也放过它和 4 个同族写法。再加固版 19 个变异体全杀，见 11.3-1。
  - M-4「58 个对象未能复现」是席报的复现命令口径不对：`git log --objects` 只列各提交 diff 引入的对象（17），首轮 R3 的 58 是可达对象 `git rev-list --objects`；协调者复算 = 58 = 26 blob + 29 tree + 3 commit，与首轮归档的拆分逐项相同。首轮 R3 的数字成立。
- R4-M7 说 10.7 的「一处取舍」对后果的描述不完整，其中一条与 R1 的读码结论相反、两席都没实跑：`mcp-server/dist` 缺失时 `tauri build` 是报错还是静默出包。协调者在 target 已暖的副本里连打三趟（`coordinator/summary-tauri-mcp.txt`）：① 不改动再打一次，445s——每次打包都会重新生成前端产物并重编应用 crate，没有「很快的暖构建」；② 改 `mcp-server/dist/src/admin.js` 并新增一个文件后再打，暂存目录与 `.app` 里都带上了改动与新文件——资源每次重新拷贝，新鲜度有保障；③ 把 `mcp-server/dist` 挪走后再打，**8 秒失败**（`failed to run tauri build script: resource path ../mcp-server/dist doesn't exist`）——R1 的读码结论对，R4 的「照常成功、无任何报警」不成立。要补的只有一条：失败的那一趟不会清掉上一趟留下的 `.app`，发布脚本若不看退出码会拿到旧包。

### 11.3 合并修复清单（按价值排序；立项时代码与文档均未动，11-25 开工后的处置进展见 11.9）

1. **回归钉加固**（R1-I1 + R4-I3，一处改动关掉两条 Important）。用 `evidence/verify/recheck2/coordinator/nail-hardened-C.test.ts` 整体替换 `src/lib/build-form.test.ts`。相对现钉多八处：`expand()` 带回 `npm run x -- <透传参数>`；除 web 外任何 mode 都不写 `dist/`；任何平台的 tauri conf 不得覆盖 build 段；三条构建链展开后不得带 `--outDir` / `--out-dir` / `--config` / `-c`；桌面链里的 `vite build` 不得 `--mode web`；链上每个脚本（递归）的 pre / post 钩子不得碰 mcp；`.env.web` 的 `VITE_API_BASE_URL` 必须为空；`git check-ignore` 带 `cwd: ROOT`（R1-M5）。协调者变异实跑（`coordinator/summary-r4.txt`，三版钉子同表对照）：原钉放过 19 个中的 15 个，协调者上一轮的加固版放过 7 个，这一版全杀，10 例基线绿。做完这一条，`CLAUDE.md:43`「上游合并吞掉分流即红」与 `docs/development.md:57` 才名副其实。
2. **web-clip 小修批**（R2-I1 / I-2 / M-1 / M-2 / M-4 + 首轮 10.3 #4）。
   - 回归钉并入全路径用例（R2b 试写在 `r2b/raw/60-Q8-fullpath-pin.diff`，协调者的写法在 `coordinator/scripts/r2-verify.py`），改正 `mcp-server/test/web-clip-net.test.ts:214-216` 注释里「做不到全路径钉」的理由；`web-clip.ts:595-637` 的 `undiciRequestOnce` 在返回响应时挂一个永久 noop 监听器，把「头到了、socket 出错、无人消费」这类契约层隐患关掉。
   - 技能 note 三处副本（仓源、lt-tutor 运行副本、全局 `~/.hermes/skills/lt-teacher-tutor/`）按事实改写：去掉「冷却 2 小时以上」（没有观测）；日志落点写清是主网关的 `~/.hermes/logs/mcp-stderr.log`；补一句「修复后工具对这类老链返回『提不了正文』，不要让它空转重试，改用替代源或请教师粘贴正文」。走仓源 + 双份 cp（硬约束 5），全局副本另行同步。
   - 首轮 10.3 #4 的六项，加本轮补记的三项（回执层字段、`kebabSlug` 按码点截断、`web-clip.ts:769` 注释）。
3. **03:17 巡检**（R3）。
   - `tools/ltutor/auto-provision-weekly.sh:63`、`:70` 的 `grep -qx` 改 `grep -qix`（一行两处，I-1）。不紧急：今晚起对那位教师是零写入的空转——开办脚本内部三步各自幂等（路由按 `chat_id` 命中、platforms 块已在、`resolve_job_ref` 不分大小写命中既有任务），只是日志每天报「▶ 自动开办」「新开办 1 个」。
   - 给 `wiki.ltutor-weekly-audit` 加监控（I-2）：`pg-watchdog` 里加「最近一次退出码 / 最近 30 小时内有无『巡检完成』/ 停发名单告警 / 新开办数」四查。
   - 脚本收尾：`provision-teacher-weekly.sh:42` 注释「与网关 cwd=检出 同语义」不对（网关 cwd 是 `~/.hermes`，靠 `hermes_cli/main.py:44-46` 把检出根插到 `sys.path[0]`）；检出路径由 `hermes_cli.__file__` 推导或断言存在（M-2）；import 提到两次写之前（M-3）；`--dry-run` 做到零写入（M-4）；校验第二个参数（M-5）；主 config 原子写（M-6）；成文验收判据与 `m3-gray-runbook.md:32` 的陈旧排程（M-7）；单个教师失败不拖垮整轮（M-8）。
4. **账目与成文收口**（R4）。11.4 列的行内勘误协调者已在本文件与 `n3-stale-docs.txt` 落实（未提交）。仍待办：
   - 补 11-25 处置轮的访问账目（I-4）：05:31 live `mcp-server/dist` 重建、05:31 `kickstart -k`、08:48 `build:web` 重写 live `dist/`、10:04–10:11 `tauri build`。那一轮不是评审会话做的，协调者只能记下时刻与产物，发起方与当时的前后快照须由当事会话补。
   - 旧世界残留（M-8）：`src-server/src/routes/mod.rs:57` 注释、`CLAUDE.md:33` 用例数 330 → 344、`.github/workflows/ci.yml:132/158/167` 注释里的 2239 / 164 / 65、两份 06 月 spec / plan 的「同一份 `dist/`」说法（历史稿，加一句现状指引即可）。
   - `.dockerignore` 补 `dist-desktop/`（R1-M4）；CI 加一条 `npm run build:web`，顺带对 api-client chunk 的调用处实参做形态断言（R1 建议 3）。
   - 「实锺」若非有意用字，应为「实锤」（`CLAUDE.md:43`、`development.md`、`launchd-notes.md:108`、`build-form.test.ts:14`）——由所有者定。
5. **10.7「一处取舍」的补全**（R4-M7）：把 10.7 那句补成三条事实：包内 `node_modules` 不再经 `npm ci` 按 lockfile 校验，拷的是检出里现成的那份；`mcp-server/dist` 的改动会随每次打包重新拷入（已实测，改动文件与新增文件都进了包）；`mcp-server/dist` 缺失时构建报错、不会静默出包（已实测），但失败后上一趟的 `.app` 仍在原处——发布脚本要看退出码。

### 11.4 记录勘误（协调者认定；行内改动已落入本文件与一份证据文件，均未提交）

| 位置 | 原话（摘） | 现在的事实 | 处置 |
|---|---|---|---|
| `:49`、`:182`、`:179` | 「仓内尚无成文防线」「仓内零处成文」「11-24 22:50 终态」 | `300c3771`（11-25 08:38）三处成文、`e9738730`（10:23）结构性根治，10.7 已记 | 加时点与指引（R4-I1） |
| `:184`、`:185` | must-fix 3「丢失风险窗口敞开着」；must-fix 4 无完成标记 | `414e4d1e` 于 11-24 18:49 回仓并推送；`cc377bb3` 于 18:49 完成 title 清洗 | 划掉并标完成（R4-I1） |
| `:242`、10.3 #10 | 提交清单止于 `8887af93`；「尚未提交」 | 其后 5 笔本地提交未推送；首轮勘误与归档已提交 `7b6da1d6` | 已补（R4-I1） |
| `:209`、`n3-stale-docs.txt` 追加段 | 「`48fd4fb495`（即 `2da13543a3^`）」 | `2da13543a3^` 是 `084986d85f`；`48fd4fb495` 是 `2da13543a3^^`。`084986d85f` 只动 `pyproject.toml`，按哪个锚恢复结果相同 | 已改；证据文件追加勘误 ③；归档 `R4.md:211` 不动（R4-I2） |
| **`:218`、`:283`、首轮归档 `R1.md` I-A** | 「该修复尚未加载，需重启网关」 | **误判。修复在 11-24 20:54:05 已加载**，证据见下 | 已改；归档不动 |
| `:225` | 「20:54 前后一条老式 `__biz` 链接曾把 MCP 进程打崩」 | 两条链接、四次崩溃（20:51:19 / 20:51:22 / 20:51:45 / 20:52:07）；20:54:05 是修复后的按需重拉，不是崩溃 | 已改（R4-M5） |
| 10.1 R3 两行、R2 行 | `0 / 0 / —`；第三轴写成「工作树等于 HEAD」 | R3 自报 6 条 Minor，合计 0 / 5 / 32 本就计入了它们；R2 的第三轴是 `parent-communication.md` 三处同 sha256 | 已改（R4-M1 / M-3） |
| 10.2 标题、10.3 #10 | 「两份证据文件」 | `7b6da1d6` 动了三份（另有 `coordinator-verification.md` +4 行） | 已改（R4-M2） |
| 10.7 末段（`:329`） | 「自 11-06 首跑起日败」「零生产损害」 | 巡检任务生于 09-05，开办步在 09-07、09-10 成功过；11-06 起到 11-25 03:17 共败 20 趟。受损面是这段时间里新完成问卷的教师不会被自动开办 | 已改（R3-C2） |
| 10.7（`:327`） | 「四项快照」 | 三处文本所指不一；证据文件的定义是两目录的 sha256 + mtime、node_modules 的 inode + `.package-lock.json` | 按证据定义改写（R1-M1 / R4-M6） |
| 10.3 #4、#5 | 漏了首轮 R1-M5、R1-M9 的 `kebabSlug`、R1-M7 的 CHANGELOG、R4-M5、R3 的建议 R4 | 都在归档里，清单没有 | 已补（R4-I5） |
| 10.3 #3 | `.gitignore:44` | `e9738730` 之后在第 46 行 | 已改 |

**「尚未加载」为什么是误判。** 首轮 R1 与本轮 R4 都只比对了两个时刻——训练进程启动于 20:54:05、dist 最后一次重建于 21:42:34——据此认定进程早于重建。它们漏了 20:53–20:54 的现场重建。协调者的证据（`coordinator/q4-loaded-evidence.txt`，取证脚本 `q4-evidence.py` 与 `q4-session-probe.py`）：

1. 主网关会话库（`state.db`，`mode=ro&immutable=1` 只读）里，11-24 20:50–22:00 的 `teacher_tutor_web_clip` 调用共 13 次，**打的全是同样两条老式 `__biz` 链**：20:51:18 ×2、20:51:45、20:52:06 是崩前的四次；20:54:05、20:54:12 是修复后的头两次；21:11:10 ×2、21:28:10 ×2、21:28:32 ×2、21:30:16 是补收任务里的六次和主会话的一次。
2. 崩前四次各杀进程一次（`mcp-stderr.log` 四条尾幅、`agent.log` 四条 `lost its stdio subprocess`）。20:54:05 起全部优雅返回——工具回执是「这篇提不了正文（可能已删除、需登录或付费墙）…」，73 / 75 字符——此后零尾幅。21:11:10 与 21:28:10 的四次是 `-32602: wecom_userid is required for system calls`（补收任务没带身份，没走到取回层）。
3. 服务这些调用的训练进程就是 20:54:05 那次重拉：`agent.log` 显示 20:53:44.598 `tool patch completed` → 三条 terminal → 20:54:05.469「had already exited when the call was dispatched; respawning and retrying once」；`mcp-stderr.log` 里 20:52:07 之后到 11-25 05:31:42 训练进程再没有启动过。
4. 崩溃对「重定向 + 未读 body」是确定性的（R2b 的 12 / 12、协调者删监听器即红），未修复的进程过不了 7 次老链调用。
5. 修复提交 `0f17695f` 的正文自述「dist 已于 11-24 现场重建并随网关按需重拉生效」。

仍然证明不了的只有两样：20:54:05 时盘上 dist 的字节（已被 21:42:34 与 05:31:03 两次重建覆盖），以及那三条 terminal 的命令文本（`agent.log` 不记参数）。协调者的置信度约 99%。11-25 05:31 的重启因此不是为加载这条修复所必需——无害，且加载的是 21:42:34 的等价重建。

**对评审席报告的更正**（归档原文不动，以本节为准）：

- R4 的 Q4 判「成立（约 95%）」，改判如上。R4 承重清单第 1 条的命令自身有瑕疵：模式「丢失风险窗口敞着」对不上原文「敞开着」，漏了 `:184`、误中 `:31`；六处原文协调者逐行核过。
- R4 的 M-4「58 个对象未能复现」不成立，是命令口径问题（11.2）。R4-M7 给「一处取舍」补的三条里，有一条不成立：`mcp-server/dist` 缺失时 `tauri build` 并不会「照常成功」，而是报错——R1 的读码结论才对，协调者已实跑分清，见 11.3-5。
- R2b 的 I-2 引了一条不成立的反证：它把 21:42:48 / 21:49:24 落盘的两篇当作「老链补收成功、距撞墙约 50 分钟」。实际那两篇是主会话用 `execute_code` / `write_file` 直写的，21:28:33 之后到 22:00 没有任何 `teacher_tutor_web_clip` 调用（R2b 自己在 F5 里说对了）。真实情况是：修复后工具对这两条链到 21:28:32（距首撞墙 77 分钟）仍返回「提不了正文」，从未成功过。I-2 的结论（时长没有观测支撑）不变。
- R3 的 C2 把「11-06 首跑」「从未成功过」写进了部分属实的一侧，实际开办步成功过两次；R3 的 Q10-8 写根下备份「20 个」，实测 26。
- **协调者自己的两处更正**：其一，R2 轮亲验笔记里引用了同一条「21:42 / 21:49 补收成功」反证，已在 `coordinator/notes.md` 更正；其二，亲验 R3 时先用 `mode=ro` 打开 WAL 库，在 live 的 `cron/` 目录短暂生成了 `-wal` / `-shm`（见 11.7）。

### 11.5 相邻发现（评审范围外，建议所有者过目）

1. **11-22（周日）六位教师的周报全部没有生成。** lt-tutor 的 `executions.db`（只读）显示六个周报任务当天都是 `failed`、`delivery_outcome=suppressed`，报错同为 `HTTP 429: 已达到 5 小时的使用上限。您的限额将在 2026-11-22 20:03:46 重置`；`cron_incidents` 里六条 `rate_limit` 停在 `detected`，`alerted_at` 全空，此后没有补跑。10-04 / 10-11 / 10-18 与 11-08 / 11-15 五周都是 `completed + delivered`。下一次是 11-29（周日）19:00–19:05——**要不要补发、要不要赶在那天前确认额度或加失败重试，需要所有者定**。
2. **10-25 与 11-01 两周的周报生成了但没送达**：`completed` 而 `delivery_outcome=failed`，原因是 `WeCom startup failed: WECOM_BOT_ID and WECOM_SECRET are required`，11-08 起恢复。同样没有告警记录。
3. **11-26 03:17 是巡检修复后第一次真实运行。** 名册里若有 11-06 之后才完成问卷的教师，会在这一晚一次性开办（设计内行为）；建议次日上午看一眼 `~/Library/Logs/ltutor-weekly-audit.log` 的末尾是否出现「巡检完成」。（11-26 实跑结果见 11.9：候选 6 人全部「已有任务」，出现了「巡检完成」，exit=0。）
4. 那位任务名大小写不一致的教师，投递一直是正常的：profile 的 `agent.log` 里有 8 条 `delivered` 记录（09-13 到 11-15 的每个周日）。R3「未能核验 4」到此可关；改名属于卫生，不影响功能。
5. 11-24 那两篇老链文章的入库路径绕过了工具：主会话用 `execute_code` / `write_file` 直接往收藏目录写文件，与「收藏只走 MCP 通道」的设计相悖；页内有没有 untrusted 围栏行未核（协调者没读正文）。工具侧对这类老链至今提取不出正文。
6. `llm-wiki-admin` 子进程在 11-24 21:28:15 之前退出过一次，无尾幅，原因未查（R2b-M6）。训练进程 20:54:05 那次退出已查明，是修复会话重建后主动换的进程。
7. 11-24 的回归钉变异验证是在 live 运行时检出里做的（`8887af93`「dist 复核无残渣」）。那次没出事——变异期间没有进程重拉——以后应在临时副本里做（R2b-M5）。
8. 首轮 10.4 记的 `.pyc` 现场从 417 个涨到了 1668 个，未清理（R4 Q7 #9）。
9. `mcp-server/src/api-client.ts` 的 `fetch` 没有超时（R2b Q14，可选）。

### 11.6 证据索引（`evidence/verify/recheck2/`）

| 件 | 内容 |
|---|---|
| `R1.md`–`R4.md` | 四席评审报告原文（各带一行归档头注；R2.md 是重派席 R2b 的原文） |
| `coordinator/notes.md` | 协调者亲验笔记：每席亲验了什么、数字是多少、哪里更正过 |
| `coordinator/summary-*.txt` | 协调者各轮验证脚本的汇总输出（R1 变异矩阵、构建行为与 `test:mocks`、tauri 端到端、R2、R3、R4 回归钉矩阵、暖构建实验） |
| `coordinator/nail-hardened-C.test.ts` | 再加固的回归钉全文（未入仓，待裁定） |
| `coordinator/q4-loaded-evidence.txt`、`record-loaded-timeline.txt` | 「崩溃修复何时加载」的日志与会话库取证（只留时间戳、工具名、链接实参与回执字符数） |
| `coordinator/scripts/` | 协调者验证、取证、归档、改句脚本，按运行原样归档（路径写死为本机；两个脚本里的教师 id 已脱敏） |
| `coordinator/served-8080.txt`、`r3-*.txt`、`r3-raw/`、`r4-raw/` | :8080 取证、R3 的沙箱探针与 live dry-run、R4 的回归钉变异与日志窗口（协调者一份、评审席一份） |
| `coordinator/hygiene-scan.txt` | 推送前卫生扫描（命中只留掩码） |
| `fix/` | 11.3 处置轮（11-25 晚 + 11-26 定时续做）的证据：沙箱脚本与输出、回归钉变异、web-clip 变异矩阵、CI 同款构建与测试输出；`fix/README.txt` 记来源、哈希与归档副本的脱敏处 |

原件在 `/tmp/glm54-recheck-20261125/`（易失）；没有收录的中间产物不承重。归档件一律不用 `.log` 后缀——`.gitignore` 的 `*.log` 会静默挡掉文件而 `git status` 不提示（首轮 10.3 #3 的坑，本轮归档脚本已加「落盘后核对被 ignore 的文件数」）。

### 11.7 本轮外部访问账目

- **git 写**：零。两仓无 add / commit / fetch / push；`git init` 只发生在 `/tmp` 副本里。
- **服务操作**：零。无重启、无 launchctl 变更、无 kill。
- **工作区写入**（均未提交）：新增未跟踪目录 `evidence/verify/recheck2/`（46 个文件）；`report.md` 22 行行内改句与 `evidence/verify/raw/n3-stale-docs.txt` 追加 2 行勘误。
- **构建与测试**（全部在 `/tmp/glm54-recheck-20261125/` 的副本里）：回归钉变异矩阵约 150 次单文件 vitest；前端构建 8 次、`vite preview` 1 次；`test:mocks` 全量 1 次（2592 例）；mcp-server 构建 5 次与 `node --test` 7 次（两个 node 版本）；`tauri build --bundles app --offline` 共 4 趟。
- **`~/.hermes`（只读）**：`logs/mcp-stderr.log` 与主网关 `logs/agent.log`（先滤凭证，不抄消息正文）、lt-tutor 的 `logs/agent.log`（只取 `delivered` 行）；lt-tutor 的 `cron/jobs.json`、`executions.db`、`deliveries.db`；主网关 `state.db` 两次（`immutable=1`，库文件与 `-wal` / `-shm` 的 mtime、大小前后相同）；`launchctl print` 3 次（巡检任务、网关 monitor、`pg-watchdog`，只读查询）；主 `config.yaml` 只数过一次某个 `chat_id` 行的出现次数，未出值。
- **两处副作用**：① 亲验 R3 时先用 `mode=ro` 打开 WAL 库 `executions.db`，在 live 的 `cron/` 目录短暂生成了 `-wal` / `-shm` 并刷新目录 ctime（19:35:19）；三分钟后已不在，库文件的 mtime 与大小未变，协调者没有做任何删除；之后改用 `immutable=1`。② **live `--dry-run` 一次**：19:38:57 以 `--dry-run` 运行 `auto-provision-weekly.sh <教师>`（cwd=/，干净环境），rc=0、三步全跳过；脚本开头的目录权限检查刷新了 `cron/` 与 `cron/output/` 两个目录的 ctime，`jobs.json` 与两份 config 的 sha、mtime、大小不变。这是本轮唯一一次在 live 上执行仓库脚本。
- **外呼**：除本机回环 `127.0.0.1:8080`（约 8 次）外零外网；`tauri build` 带 `--offline`，npm / vitest 没有安装任何包。
- **生产库**：零访问（未用 docker / psql）。**密钥**：零读取、零回显。
- **评审席自报**：R1 越出 git 白名单一次（`git branch --show-current`，只读），全仓搜索脚本读到了副本 `.env.web` 的一行注释，`curl :8080` 3 次。R2b 对 8 个日志文件做关键词扫描，对两份技能副本取哈希，用生产的 node 可执行文件跑测试，读了首席遗留的 4 个脚本与 5 份骨架输出（只作线索），可能在 `~/.npm/_logs` 留有一条日志。R3 的原始文件里进过 `launchctl default environment` 输出中的 `SSH_AUTH_SOCK` 与 `PATH`（已删，不是凭证），它自己的 `--dry-run` 刷新过同两个目录的 ctime。R4：`git branch --show-current` 与 `git remote get-url origin` 各一次、对 `mcp-stderr.log` 做了超出两个窗口的全文件模式计数、`ps` 3 次、列过 `.env*` 的文件名（未读内容）。
- **并行会话**：本轮窗口内未见地面移动。

### 11.8 过程教训

- **回归钉要钉不变量和生产路径，不要钉实现位置。** 三条 Important（R1-I1、R2-I1、R4-I3）是同一个教训的三张面孔：钉住「某个 mode 的产物目录」「某个闭包里的 destroy」，改写一下就绕过去。「删 X 即红」只证明了钉子和 X 绑在一起，没证明钉住了想保的性质——要拿一组「语义等价但文本不同」的改写去试。
- **评审席的「未能复现」先核它的复现命令。** 58 个对象那一条，换成同一个口径立刻对上。
- **评审席给了置信度的结论也会错，协调者必须自己找独立证据。** 「尚未加载」两轮两个席都判成立，靠的是同一组 mtime；翻案靠的是换一种证据（同一输入在崩前崩后的行为对账）。反过来说，协调者自己上一轮的反证也引错了路径——时间戳对得上不等于机制对得上。
- **协调者同样会踩已记在案的坑**：`git rev-parse --short` 带多个参数会报错（记过，又踩）；归档件用 `.log` 后缀被 `.gitignore` 静默挡掉（首轮 10.3 #3 记的就是这件事）；脱敏脚本自带的对照表就是一份真实 id 清单（卫生扫描抓到的）。三个都是「先演练、落盘后回读对数」才拦住的。
- **对 live 库做只读查询用 `mode=ro&immutable=1`。** WAL 库上单给 `mode=ro` 仍会在同目录建 `-wal` / `-shm`。
- **后台评审席会随会话中断而消失。** R2 首席断线零产出；重派时旧席的中间产物只能当线索，不能当证据。

### 11.9 处置进展（11-25 晚开工、11-26 05:10 定时续做；全部在工作树，未提交未推送）

> 用户 2026-11-25 口令「修复清单（11.3）开工」，当晚约 21:40 叫停并指定 11-26 05:10 定时续做（无人值守）。两轮都只在临时副本里构建与测试，没有提交、推送、重启，也没有碰生产库。证据在 `fix/`。

**03:17 巡检首跑（11-26，带修复的第一次真实运行）。** 日志最后一趟 03:17:05 开始，候选 6 人全部「已有任务」——包括任务名大小写不一致的那位（按候选顺序记 T6；11-25 03:17 那趟对同一人是「▶ 自动开办」后 `ModuleNotFoundError`）。收尾两行齐全：「巡检完成：新开办 0 个、失败 0 个」与「巡检结束 exit=0」；`launchctl print` 记 `last exit code = 0`。日志自 11-06 生成以来共 21 趟，这是第 1 趟走到「巡检完成」。这一趟没有触发开办，所以重写后的 `provision-teacher-weekly.sh` 的真实写入路径仍未在生产上走过（只有沙箱 36 项与受护 dry-run）。看门第 6 查的首次排程运行在 11-26 09:00，本轮看不到。

| 11.3 条目 | 状态 | 落点与验证 |
|---|---|---|
| 1 回归钉加固 | 已做（11-25） | `src/lib/build-form.test.ts` 整体换成 `coordinator/nail-hardened-C.test.ts`（同字节）；基线 10 过，19 个变异体全红 |
| 2 web-clip 小修批 | 已做（11-26） | 见下「11.3-2 明细」 |
| 3 巡检 | 已做（11-25） | 见下「11.3-3 明细」 |
| 3c 成文 | 已做（11-26） | `docs/development.md` 新增「定时任务」节（import Hermes 模块先补检出根；巡检存活判据）；`tools/pg-backup/README.md` 改六个信号并补第 6 查说明；`m3-gray-runbook.md` 两处陈旧排程改为现行 6 个任务、分钟 0–5（`:32` 那句顺带去掉了句中的教师 id） |
| 4 账目与成文 | 除一条外已做（11-26） | `.dockerignore` 加 `dist-desktop/`；`src-server/src/routes/mod.rs:57` 注释；`ci.yml` 三处用例数注释；三份六月文档各加一行现状指引（06-13 架构 spec、06-13 实施 plan、06-23 layer5 spec，正文未改）；CI `check` job 加 `npm run build:web` + `scripts/check-web-bundle.mjs`（新文件）；`CLAUDE.md` 用例数改为 2598 / 182 与 353。**未办**：11-25 处置轮的访问账目（须由当事会话补） |
| 5 10.7「一处取舍」 | 已做（11-26） | 10.7 已改成三条事实 |

**11.3-2 明细。**

- 源码 `mcp-server/src/web-clip.ts`：① `undiciRequestOnce` 返回响应前给 body 挂常驻 noop `error` 监听器，destroy 闭包里的 `once` 并入（关 R2b-M1：头已到、无人消费、socket 随后出错）；② `kebabSlug` 按码点截断（R1-M9）；③ `sanitizeClipTitle` 截断后再 trim（幂等）；④ 微信正文阈值先剥不可见字符再数（`\p{C}` 加谚文填充符、盲文空白、组合符连接符、变体选择符），报错文案由 non-whitespace 改为 visible；⑤ `:769` 注释的单位更正；⑥ 新增导出常量 `CLIP_SNIPPET_UNTRUSTED_NOTICE`，围栏行的注释写明它只覆盖读页。
- 源码 `mcp-server/src/training.ts`：`empty_content` 文案补「内容太短、以图片为主」；`clipReplyText` 对 title 与 prev 两字段做类型判断、清洗、折叠、有界截断（收藏人上限 40 码点），日期只认 `YYYY-MM-DD` 开头；`formatSearchResults` 对 path 以 `clips/` 开头的结果在 `Snippet:` 行之前打片段提示。工具描述字符串未动。
- 测试 344 → 353（+9）：网络测试 +3（已收完未读形态、全路径钉、契约层钉），`web-clip.test.ts` +2，`web-clip-fetch.test.ts` +2（不可见填充过不了阈值、`document.title` 回落的中段），`training.test.ts` +2（prev 字段收口、片段提示）。生产 node 26.12.1 与本机 26.13.0 结果一致；网络测试文件连跑 6 遍全绿。
- 变异矩阵（`fix/raw/mutation-matrix.txt`）：该杀的 17 个全杀、0 存活；语义等价的 2 个（常驻监听器换成 `once`、码点截断恒走数组路径）按预期存活；替代修法「排空代替销毁」按设计变红（永不结束的 302 连接不被释放）。两个取值更窄的剥除集（只剥 `\p{Cf}`、只剥 `\p{C}`）都被杀——填充符与变体选择符必须纳入。
- 过程中自己抓到并改掉的两处：契约层钉起初自己挂了 `error` 监听器做阳性对照，等于替生产代码把错接走（删掉生产监听器它照样绿），改成只读 `errored` 属性；四个变异体起初因 `noUnusedLocals` 编译不过，改成保留引用的写法之后才是有效变异。
- 对既有崩溃钉的一处改动（R2b-M2，超出清单字面）：`body.destroyed` 断言换成「destroy 之后在飞连接在窗内被释放」，「已收完未读」的 302 补成独立一例；文件头「钉住四件事」改为六件。
- 技能 note 三份。仓源 `SKILL.md:33` 由 821 B 重写为 795 B：去掉「冷却 2 小时以上再试（可排 cron）」；日志落点写明主网关的 `~/.hermes/logs/mcp-stderr.log`；补「修复后撞墙的工具回『提不了正文』，文案分不清验证码墙与真已删——不要排延时重试空转，改用其他来源或请老师把正文复制发来」。双份 cp 到运行副本（同字节，frontmatter 未动）。全局副本只改第 60 行，改前备份到 `~/kb-ops/skill-backups/lt-teacher-tutor/SKILL.md.bak-20261126`。一处取舍：仓源那行为了不超 822 B 去掉了「请老师在手机浏览器打开拖一次验证加速解锁」，全局副本保留了这句——它没有观测支撑，且与全局副本自己上一行「验证状态绑 cookie、服务端管线借不到」相悖，留所有者定。
- 没做的：`mcp:build` 与 MCP 子进程重拉。live `mcp-server/dist` 仍是 11-25 的构建（`web-clip.js` 里还是 destroy 闭包内 `once` 的旧修法，`empty_content` 也还是旧文案），源码与 live 此刻不一致。

**11.3-3 明细（11-25）。**

- `auto-provision-weekly.sh`：判重改 `grep -qix`；单个教师开办失败只记账、不中止整轮，末尾汇总并以非零退出；EXIT trap 打「巡检结束 exit=N」。
- `provision-teacher-weekly.sh` 整体重写：第二个参数只认 `--dry-run`、多余参数即拒；主 config 与 platforms 的写入改为备份 + 原子写；`import cron.jobs` 先于一切写入，检出根从 `hermes_cli.__file__` 推导；落盘前校验 store 在预期根下；dry-run 把 `HERMES_HOME` 指到临时目录、退出时清理。
- `pg-watchdog.sh` 第 6 查：launchd 最近退出码、最后一趟走没走到「巡检完成」、日志记的退出码、有无「停发-告警」、日志新鲜度（26h）；新开办数大于 0 另发一次静默通知，按趟去重。
- 验证：沙箱 36 项全过（巡检脚本）与 14 项全过（看门，含三种 locale）；对 11-25 03:17 那趟的候选只读重放——旧判据判缺 1 人、新判据 0 人；带审计钩子的 live `--dry-run` 一次 rc=0、六项快照前后不变。**未覆盖**：store 不在预期根下那条 guard 分支没有测试。**相邻未修**：候选清单为空时 `pipefail` 让巡检以 1 退出（R3 Q6）。
- 部署：两个巡检脚本由 launchd 直接从工作树执行，改了即生效；`pg-watchdog.sh` 已 cp 到 `~/kb-ops/pg-backup/`（与仓内同字节，plist 未动）。11-25 21:29 用类 launchd 环境真跑一次：前五查过、rc=1，报的是真问题（11-25 03:17 那趟没走到「巡检完成」）。

**CI 新增一步的验证（副本里，`fix/raw/ci-sim-summary.txt`）。** `npx vite build` → `dist-desktop/` 221 个文件；`npm run build:web` → `dist/` 221 个文件，`dist-desktop/` 零变化；断言脚本通过。副本 `dist/` 与 live `dist/` 逐文件哈希 221 / 221 相同。断言脚本的四个输入变异：默认模式、`--mode development`、`.env.web` 去掉 `VITE_API_BASE_URL`，三个都红；裸 `vite build --mode web` 绿（等价入口）。脚本在 node 22.20 / 22.22 / 24.11 / 26.12 / 26.13 上行为一致；**CI 用的 node 20 本机没有，未实跑**。写脚本时拿 live `dist/` 试跑，抓到一个自己的 bug（反引号字面量那一支漏了收尾符，会把合法的 web 产物判红），已修。

**全量测试。** `test:mocks` 2598 例 / 182 文件：2597 过、1 败——败的是 `tools/transcriber/__tests__/audio.real-ffmpeg.test.ts`，原因见下面相邻发现第 1 条，与本轮改动无关。CI frontend-test 同款的 `npm run mcp:test`：353 = 352 过 / 1 跳。

**live 侧发生了什么（两轮合计）。**

- `~/kb-ops/pg-backup/pg-watchdog.sh` 被覆盖（原内容等于 git HEAD）；`~/kb-dumps/src-server-pg/watchdog.log` 多一行 ALERT、弹过一次 macOS 通知（11-25 21:29）。
- 一次受护 live `--dry-run`（rc=0、零写入），外加一次空 id 调用（只打用法、exit 1、零写入）。
- 11-26：`~/.hermes/profiles/lt-tutor/skills/teacher-tutor/SKILL.md` 被仓源覆盖；`~/.hermes/skills/lt-teacher-tutor/SKILL.md` 改了一行（先备份）；新建目录 `~/kb-ops/skill-backups/lt-teacher-tutor/`。
- 没有碰的：`dist/`、`dist-desktop/`、`mcp-server/dist`（31 个文件，最新 mtime 仍是 11-25 05:31:03 那次）、`mcp-server/node_modules`、Hermes 网关与三个 MCP 子进程（pid 与启动时刻前后相同）、launchd 任务。

**相邻发现（本轮新增，均未处置）。**

1. **本机 `ffmpeg` / `ffprobe` 自 2026-11-26 01:13 起起不来。** `/opt/homebrew/opt/ggml` 在 01:12:46 被指到 `ggml 1.0.0`（只提供 `libggml.1.dylib`），而 `ffmpeg-full 9.0.2` 链接的是 `libggml.0.dylib` 与 `libggml-base.0.dylib`，dyld 报 Library not loaded。同一分钟里 Homebrew 升了约 30 个包（`node`、`docker`、`nginx`、`cloudflared`、`gh`、`whisper.cpp`、`llama.cpp`、`rustup` 等；`~/Library/Logs/Homebrew` 下 `multica`、`nginx`、`rustup` 的日志目录时间戳是 01:12–01:13）。交互式 shell 历史里那一小时没有 brew 命令，触发方未查明。`whisper-cli` 本身能启动。按读码推断，受影响的是走 PATH 找 `ffmpeg` 的教师工具：`media-extract.ts` 的视频抽帧与抽音、`listening-audio.ts` 的听力音频合成（两份 Hermes config 里都没有 `LTUTOR_MEDIA__FFMPEG` 覆盖）——教师现在发视频或要听力音频会失败；未做真调用验证。修法大概是 `brew reinstall ffmpeg-full`，属系统级改动，留给所有者。它也是本轮 `test:mocks` 唯一那条红。
2. **公开仓的入库文件里有真实教师企微 id（存量）**：`mcp-server/test/worksheet.test.ts` 的一条测试标题、`mcp-server/test/admin.test.ts` 两处带 `wecom_` 前缀的夹具、`docs/superpowers/deploy/m3-gray-runbook.md` 一处。本轮没动。
3. **检索片段提示只覆盖 `clips/` 路径**：收藏的源文件在 `sources/clips/`，search 若回显它的片段，同样不带围栏行。按清单字面只做了 `clips/`。
4. **`teacher_tutor_web_clip` 的结构化回包仍带原始 `title` 与 `prevClipped*` 字段**：本轮只收口了 `reply` 文案（清单范围）。
5. 「请老师拖一次验证解锁」那句见上，无观测支撑。
6. 记过的两处仍开着：候选为空时 `pipefail` 退出 1；store guard 分支无测试。

**本轮（11-26）外部访问账目。**

- git 写：零。add / commit / stash / reset / 切分支都没有；`git init` 只发生在 `/tmp` 副本里。
- 服务操作：零。无重启、无 launchctl 变更、无 kill。
- live 写入：上面「live 侧发生了什么」所列的两处文件与一个备份目录。
- 只读访问：`~/.hermes` 下的 `cron/jobs.json`（只取任务名与排程，输出一律掩码）、巡检日志（同上）、三份技能副本、`.skills_prompt_snapshot.json` 的路径值、`launchctl print` 一次；`~/.zsh_history` 只做了「那一小时有没有 brew 命令」的匹配（零命中，没有输出命令内容）；Homebrew 的 Cellar 与日志目录的时间戳；`ps` 若干次。没有读任何 config 值，没有读密钥。
- 构建与测试（全部在 `/tmp/glm54-fix-20261126/`）：mcp-server 副本 tsc 构建约 50 次、`node --test` 约 50 次；仓库副本 `test:mocks` 1 次、vite 构建 6 次、`mcp:test` 1 次。
- 外呼：零。生产库：零访问。
- 证据：`evidence/verify/recheck2/fix/`（41 个文件）。归档副本有两类脱敏：`audit-sandbox.py` 一行 docstring 的 3 处 id，四份测试输出里一条测试标题的 id；`/tmp` 原件未动。落盘后复扫：新增行与未跟踪文件 0 命中，0 个被 ignore。

**仍待裁定。** 提交与推送（本地 5 笔加上本轮工作树）；`mcp:build` 与 MCP 子进程重拉；修 `ffmpeg`；「实锺」措辞；11-22 周报全败的处置；全局技能收编；11-25 处置轮的访问账目；上面相邻发现 2–5。
