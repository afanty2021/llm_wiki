# 核验轮账目（协调者亲做部分）· 2026-11-24 07:31–08:40

> 用户口令：「report.md 中未核验清单要进行核验，授权跑真实脚本」。本文件记录协调者亲自实跑/读码/查库的每一项：做法、结果、结论。原计划交给两个子代理的纯读面核对因 5 小时用量上限失败、零产出，已由协调者亲做补齐：Hermes 仓部分见同目录 [hermes-verification.md](hermes-verification.md)，lt-tutor 文本面见 [ltutor-text-verification.md](ltutor-text-verification.md)。
> 纪律：仓内零改动、零提交；生产库只读查询 + 一轮集成测试（其残渣已按窗口精确清理，见 integration-verify.md）；密钥只经变量传递、零回显；真实外呼仅限 6 条微信文章页 GET、4 个 14-token 的模型探针、OSV/npm registry 查询、两个 GitHub 公开仓克隆。

## 一、本轮核验新发现（按严重度）

### N-1【W3·Critical（功能级）】teacher_tutor_web_clip 对真实微信公众号文章提取不出正文
- **证据**：6 条知识库里被引用过的 `mp.weixin.qq.com/s/…` 真实链接，经生产同款 `fetchWithGuards`+`extractArticle`（/tmp 拷贝内）：
  - 取回全部成功（每页约 3.8MB HTML，`js_content`/`rich_media_title` 标记齐全）；1 条「参数错误」系正则截断的畸形链接，属预期。
  - `#js_content` 真实正文 8,135 / 3,796 / 8,487 字符（三篇抽样），而提取结果只有 **49 / 54 / 25 字符**（只剩「原创 ××× 不喜欢」署名行）。
- **根因（实锺）**：微信以行内样式 `visibility: hidden; opacity: 0;` 下发正文，Readability 0.6.0 丢弃不可见节点后挑中页头。把 `#js_content` 的 `visibility` 改为 `visible` 后 Readability 立即提取出 **8,135 / 3,796** 字符（与页面正文逐数相等）；直接对 `#js_content` 做 turndown 得 **9,180 / 4,269 / 9,301** 字符。
- **为何测试全绿**：`mcp-server/test/web-clip-fetch.test.ts:489` 的夹具是 `<div id="js_content" style="opacity: 0;">`，缺 `visibility: hidden`。
- **为何线上没炸**：25–54 字符高于「空内容」判定线（`markdown.trim() === ""`），线上会正常建档并回复「已收藏」，库里只存一行标题（回执文案见 ltutor-text-verification.md 的实测）。目前 `clips/` 页为 0——功能上线至今无人用过，尚无实际损害。
- **更正**：核验过程中曾提出「class `rich_media_content` 撞 Readability 黑名单」的假设，实测去掉/改名 class 结果不变，**该假设已证伪**。
- **修法（未实施）**：①`extractArticle` 里对 `#js_content` 先清 `visibility:hidden`（或微信分支直接取该节点）；②夹具补真实样式；③正文低于阈值（如 <200 字符）按 `empty_content` 处理，不再报「已收藏」。

### N-2【W2·Important（部署态）】live 的 web dist 是桌面形态，自 10-25 09:03 起
- **证据**：`curl http://127.0.0.1:8080/` 实际下发的 `assets/api-client-Cpj5Gy3Y.js` 含 `function n(e){return e??\`http://localhost:8080\`}var r=n(void 0)`；而 `src/lib/api-client.ts:9-13` 的约定是「未定义（桌面）→ localhost:8080；空串（web 同源）→ 相对请求」，`.env.web` 里 `VITE_API_BASE_URL=` 为空。
- **对照**：把当前源码以 `--mode web` 构建到临时目录（5.41s），与 live dist 做哈希归一后的多重集比对，221 个文件里**唯一真差异**就是 api-client（新构建为 `n("")`）。
- **成因**：10-25 打桌面包时 `tauri.conf.json` 的 `beforeBuildCommand: npm run build:desktop` 于 **09:03:05** 把 `dist/` 整个覆盖（221 文件 mtime 同一秒），09:11 出 DMG，此后无人再跑 `build:web`。
- **影响**（12:40 复核后修正）：只有以 `http://localhost:8080` 打开才正常；`127.0.0.1:8080` 打开属跨源——`src-server/config/default.json` 的 CORS 白名单只有 1420/5173，实测带 `Origin: http://127.0.0.1:8080` 的请求响应不带 `access-control-allow-origin` 头；经隧道域名打开则 API 打到访问者自己的 localhost。**零暴露**：请求日志 `src-server/logs/llm-wiki.log`（覆盖 10-16 至今）里 `/assets/` 的 GET 总共只有 3 次（11-23 凌晨评审 2 次、11-24 本轮 1 次，已验证资源请求会入日志），即 10-25 以来没有任何一次真实的浏览器加载；此前记为「真实加载 1 次」的 11-20 `GET /` 之后没有任何资源或 API 请求，是探活。属潜伏的部署错误，且违反硬约束 3。
- **凌晨评审为何没抓到**：「特征串指纹」分辨不了两种构建（源码相同）。
- **修法（未实施，需用户裁定）**：`npm run build:web`；发布配方补一步「`tauri build` 之后必须重跑 `build:web`」。

## 二、逐项核验结果

### W4（10-15 语料质检批）
| 未核验项 | 做法 | 结果 | 结论 |
|---|---|---|---|
| vitest（whisper/cli）+ tsc | `npx vitest run` 点名两文件 + 全目录；仓根 `npm run typecheck` | whisper **34/34**、cli 38/38、transcriber 全目录 **224/224**（15 文件）；tsc exit 0 | **成立**（221→224 为同批后续提交新增） |
| 集成测试（含存量红） | `cd src-server && cargo test --test integration` | **134 passed / 1 failed / 33 ignored**，22.78s；红=`permissions_test::llm_provider_crud_roundtrip`（201≠409） | **成立**：数字逐个吻合 |
| live DB 事实 | 只读 SQL + 归档工件 | 向量行：删除前全量 82187，82187−3262+后续新增 142 = **79067**（现值，分毫不差）；`dedupe-execute.sql` 目标数：页 78 / 媒体 78 / 已摄入 78 / 评审 157 个来源路径（对应 232 条 open）；`tools/transcriber/out/state.jsonl` 920 行中 **78** 行 deduped；备份 bk-totals 媒体 919 | **全部成立** |
| 守卫在真实流量下的行为 | grep 服务日志全部轮转文件（10-08 起） | transcripts/ 守卫命中 3 次（09-08 ×2、10-10 ×1），**全在 10-15 部署之前**；命名空间白名单守卫与单数归一化自部署以来 **0 次** | 已核实：守卫从未在真实流量触发，W4-I1 的静默风险目前是潜伏的 |
| pid 70747→1006 重启链 | 日志 worker 启动行（UTC） | 10-15 06:34 → **10-15 15:22:23**（守卫二进制部署）→ 10-23 09:24 → 11-23 01:43（现 pid 1006） | 已还原 |

补充发现：`llm_provider_crud` 在 409 断言处 panic，后续 DELETE 不执行，会留下测试 provider 行（本轮窗口内新增 5 行：跑前 11 → 跑后 16；挂在窗口内新建的测试用户下，按窗口删用户时级联带走，终态回到 11）；`(team_id, provider_type)` 唯一约束确已 drop（现存仅主键+外键），断言未同步——建议恢复应用层查重或改测试并登记分歧。

### W2（v0.6.13 合并）
| 未核验项 | 做法 | 结果 | 结论 |
|---|---|---|---|
| mcp-server 330 | /tmp 拷贝 build + `node --test` | **330 / 329 pass / 1 skip / 0 fail**（skip=ffmpeg 门控媒体冒烟） | **成立** |
| build:web / tsc | `npm run typecheck`；`vite build --mode web --outDir /tmp/...` | tsc 0 错；web 构建 5.41s 通过；与 live dist 比对见 N-2 | 类型级**成立**；部署态**发现问题 N-2** |
| 「18 冲突」 | `git merge-tree --write-tree 26a3ee71^1 26a3ee71^2` | 恰 **18 个内容冲突文件**（README×4、api-client.ts、mcp index.ts、search.rs、App.tsx、preview-panel.tsx、i18n×4、graph-relevance.ts、ingest-queue.ts、ingest.ts、page-merge.ts、project-file-sync.ts） | **成立**——凌晨评审标「不可考」有误，可考且为真 |
| src-server 集成测试 | 同 W4 | 134/1/33 | 成立 |
| 10-25 网关是否当日重启 | gateway.log | **10:48:30** SIGTERM 优雅退出 → **10:48:36** Starting → 10:48:38 飞书/企微双连 | **成立**：09:02 的 mcp 新产物当日 10:48 被吃到 |
| lance-encoding 构建脚本是否重跑 | 指纹目录 mtime | `Oct 24 11:11:50`——11-24 的绿跑是**缓存命中**，未重跑 protoc 生成 | 已核实为缓存命中（brew protoc 当前可用性仍未被行使） |
| rsproxy 502 根因 | `curl https://rsproxy.cn/index/config.json` | HTTP 200 / 0.12s | 瞬时故障 |
| 桌面运行形态 | /Applications、bundle、进程 | `/Applications/LLM Wiki.app` **0.6.13**（bundle 10-25 09:10–09:11）；检查时未运行 | 已核实为安装包形态 |

### W3（web-clip）
| 未核验项 | 做法 | 结果 | 结论 |
|---|---|---|---|
| 网关对工具结果的截断/呈现 | 读 Hermes 源码 | MCP 工具结果进模型上下文**无硬截断**（仅 >8000 字符会被上下文压缩的摘要环节触达）；企微单条上限 `MAX_MESSAGE_LENGTH = 4000`，超长切块发送 | W3-I1 的放大系数=1:1 全量、按 4000 切块 |
| ingest 提示词防注入 | `src-server/src/services/prompts/step1_analyze.txt`、`step2_generate.txt` | **零处**防注入表述 | 无护栏，W3-I1 的保守口径成立 |
| additionalProperties 校验强度 | 读 Hermes `mcp_tool_schema.py` 与 mcp-server `index.ts` | 两侧均不做机械校验；`identity.ts:86-95` 显式 `wecom_userid` 与会话身份不等即 IdentityMismatch；identity.test.ts 有 22 条 mismatch 用例 | 不构成安全洞（handler 侧身份闸兜底） |
| CVE 清单 | `npm audit`（/tmp 拷贝）+ OSV | 点名三包（readability 0.6.0 / turndown 7.2.4 / jsdom 26.1.0）**0 条**；全树 **15 条**（1 critical/9 high/2 moderate/3 low）：11 条经 MCP SDK 1.29.0 的 HTTP 服务端组件（hono/express/body-parser/proxy-addr/qs/ip-address/fast-uri）引入，stdio 部署下不执行；4 条为内容解析器 DoS（image-size←pptxgenjs 4.0.1、markdown-it←markmap-lib 0.18.12、zod 4.4.3、katex）暴露面低 | 已核实；建议排期 `npm audit fix`（多数非破坏性） |
| 生产代理环境变量 | launchd plist 键名、config.yaml、MCP 子进程环境 | **均无** HTTP(S)_PROXY/NO_PROXY | 代理绕过疑问不成立 |
| 微信真实链接冒烟 | 生产同款取回+提取（不写库不入队） | 见 N-1 | **发现缺陷 N-1** |

### W1（lt-tutor 教案+CFU）
| 未核验项 | 做法 | 结果 | 结论 |
|---|---|---|---|
| T7 干跑真模型结果 | dry-run.md 设计为「操作者以测试教师在企微发消息」——协调者无企微身份，不能代跑。改做**会话库历史回放**（`~/.hermes/profiles/lt-tutor/state.db` 只读；10-31 ggtms 共 9 个会话） | 11a 三跑（12:54 被截胡→13:22「分三段」→13:46 草稿停等+学生页同回合）；11b 图片→vision region 分块→全文；11c 缩写检索→「分三条」→补送；11d 幼儿段（3054 字教案、明示非课标底座、[06:26]–[10:22] 引用、不出学生页、plan_create）；12a 时序门（首回合零 worksheet）→确认后出卷+读验证门；12b 练习纸走流程 8、单元卷文字版代出；12c 口头型零出图；回归 2 带来源与时间段 | **历史声明成立**（as-run 于 10-31）；当前行为需真人重跑 |
| 脚本 4 A/B | 同上回放 | A（16:48，加固前）：模型把伪 ID `zhang.teacher99` 填进 `teacher_tutor_progress` 参数（被服务器身份闸拦）并在回复里转述错误原文；B（16:54–16:55，加固后新会话）：同样两句施压**两次零工具调用** | **成立** |
| 家长会文件 5 个锚点 | 只读 SQL + 转写页 | 两视频存在、时长 38.5/21.0 分钟；三概念页存在；[05:03]/[08:14]（章头「应收集哪些学生数据」）/[28:28]（「考试情况记录与分析表设计」）/[30:01]（发给家长…题型得分…全班排比…知识点掌握）逐一对上；Data Wall、Student Progress Tracking 在页内；「家长会/家校沟通」直查 0 命中 | **全部真实** |
| 会话库命中记录 | 只读 SQL（仅聚合计数与时间） | 家长会路由自 11-20 14:57 写入以来**零真实教师触发**（6 条命中全是 11-22 周报 cron 提示词）；409：11-20 14:22 `llm_wiki_search` ×4 + `teacher_tutor_record_ask` ×1 全部 `LLM Wiki API 409: 已被占用或已绑定` | 409 属身份绑定层（即当日所修孤儿教师档案），波及所有需身份的教师工具；SKILL 文本归因为「检索接口」偏窄；根因已修，该条属留存的 workaround |
| LOE license 依据 | 批次记录 + KB + 本机目录 | 来源：YouTube 公开培训课 21 视频 + 用户自备《Uncovering the Logic of English》整本 36 章、Foundations A/B 教师手册 28 块；KB 中 276 页提及 LOE，**0 页带 license 字段**；批次记录无「摄取前核许可」记载 | **无许可依据在案**——待用户裁定（硬约束 8） |
| 熔断参数 / 其余 references / dry-run 脚本 1–5 mock | 读 Hermes 源码；MCP 注册表导出后全量机械对账；mock 逐项对 Rust 响应结构与 TS 格式化函数 | 熔断 3 次/60s 属实，但 fork 下应用级错误不烧 strike；工具名 115 处、调用示例 37 处全部与注册表一致；mock 返回侧 4 类陈旧（record_ask 只回 `{id}`、错误码与错误形态、`watched` 缺失、search 文本格式） | 详见 ltutor-text-verification.md |

### H2（fork 增量）
| 未核验项 | 做法 | 结果 | 结论 |
|---|---|---|---|
| GIT_PROGRESS=1 对 gh 的真实行为 | 真函数 `_preprocess_command_for_adaptive_timeout` 跑 12 条命令；真实克隆对照 | 垫片只改写「行首 `git clone`」与 `gh repo clone/fork --clone`，`cd x && git clone`、`git -C … clone` 不变；`GIT_PROGRESS=1 gh repo clone` stderr 仅「Cloning into…」**0 行进度**（gh 2.103.3），`git clone --progress` 才有进度 | **H2-I1 成立且实证** |
| coding-plan 键打普通端点 | 14-token 探针 ×4（密钥经变量、不回显） | coding-cn 与标准 `cn` 端点对同一 key **均 HTTP 200**（glm-5.3-flash、glm-5 皆通） | 回落**不会被拒绝**，而是静默改按 token 计费——风险模型成立 |
| 钉版 CVE 暴露差 | OSV | openai 2.24.0/2.54.0 **0/0**；anthropic 0.87.0/0.125.0 **0/0**；pillow-heif 1.6.0/1.8.1 0/0；**mcp 2.0.0 = 5 个 CVE**（2.3.0 为 0）：CVE-2026-116685（客户端跨源重定向携带头体）、CVE-2026-59951（StreamableHTTP 服务端会话堆积）、CVE-2026-115563（OAuth 客户端凭据可被指向服务端选定的授权服务器）、CVE-2026-116686（客户端校验 outputSchema 时按服务端 `$ref` 取远程 URL）、CVE-2026-116684（服务端 bearer 令牌 audience 混淆） | 漏洞差在 mcp 而非 openai/anthropic；live 三入口皆本机 stdio、无远程/OAuth 服务器 → **当前不暴露**；升钉版到 ≥2.3.0 可同时消漏洞并撤两颗雷的垫片，值得排期 |
| CDN HEIC brand 集与 AVIF 频率 | 归档目录魔数字节统计 | 67 张（09-13→11-23）：JPEG 64 / PNG 2 / WEBP 1，**HEIC/AVIF 0** | 两个月零出现 |
| 14 份文档 / 长任务通知门槛 | provenance + 机械体检；逐行读函数与两处调用点 | 文档整批为 2026-04/05 的 fork 自写件、从未刷新（路径引用 environments 0/19、plugins 2/16、gateway 9/23 仍存在），7 个目录与上游 AGENTS.md 并存；通知门槛函数无缺陷 | 详见 hermes-verification.md |

### H1（三次合并）
F821@9ce27798f4（绿，11 目标 259p/2s）、SDK 全树调用面（import 232 / 属性链 114 / 调用 110 处，0 裸露失败、0 kwargs 不符）、issuers 测试注释变异实证、rooms/groups 全家族 1088/1090、mcp 1.x 炸点实复现（3 处，live 零暴露）、73 个 SDK 测试文件 1936/2/16：全部亲做，详见 hermes-verification.md。

## 三、仍无法核验（含原因）
1. W1 T7 的**当前**行为：需真人以测试教师在企微重发脚本（设计如此）。
2. W2 brew protoc 当前可用性：11-24 绿跑命中 10-24 的构建脚本缓存；强制重跑需清该包构建产物，代价大于价值，未做。
3. H1 裸 import 在 mcp 1.x 下的炸点：**已补验**（本机有 1.21.2 / 1.25.0 / 1.26.0 三个环境，3 处函数内裸 import 炸，live 零暴露，见 hermes-verification.md）。
