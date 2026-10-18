# clip-to-teacher-kb 实现评审报告（MAX 彻底度）

评审日期：2026-10-18 · 评审对象：`816549b..c3bd3a5`（feature commits e0ca99d→8d2c0c1 + merge）· 对照 plan.md §3-§5/§9/§10/§11 与 report.md 8 Important 原始表述 · 方法：全量 diff 逐行 + src-server 契约核验（pages.rs/files.rs/ingest.rs 只读）+ undici 6.29.1 源码级钉 IP 取证 + 独立数学验证（exotic IP 形态实测）+ `npm --prefix mcp-server test`（318/318 绿）+ `tsc --noEmit`（0 错）+ live 只读核验（SKILL 双份/manifest/进程/存储/PG 含向量层）。

---

### 一、总评

这是一次罕见的把方案评审 8 条 Important 阻断项**全部在行为级兑现**的实现。改动面严格收敛在 mcp-server + SKILL.md（零 Rust 改动，与 plan §3 一致），SSRF 门采用「默认拒绝、仅公网单播」姿态且数学实现经独立验证正确（含 URL 层十六进制/十进制/八进制 IP 归一、mapped-IPv6、NAT64、6to4/Teredo 抠段、边界址逐一验算），undici 钉 IP 在 6.29.1 源码级证实落在真实连接路径上（connect.js 的 `...options` 透传 `net.connect`/`tls.connect`）。判重三件套（归一化→稳定字节→恒 enqueue）闭环成立，错误码→教师文案映射 11 枚全覆盖且防 Hermes 熔断设计自觉。R8 勘误（直写 clips/ 页 + 服务端页写自动嵌向量）与 src-server pages.rs 实现逐点对上。测试 318 全绿、类型零错、live 部署态四层零残留（存储/wiki_pages/ingested_files/embeddings）全部证实。

未发现 Critical。1 条 Important（安全核心性质缺自动化回归护栏——生产 fetch 接线零测试触达 + undici 浮动 semver）。其余为记档级 Minor。上一轮 SDD 终审 MERGE_READY 的结论我独立复核后予以维持。

---

### 二、8 阻断项落地核查表

| # | 阻断项 | 判定 | 代码/测试证据 |
|---|--------|------|---------------|
| ① | SSRF 默认拒绝（封禁段补齐） | **✓** | `web-clip.ts:132-147` IPv4 拒绝段 14 条（0.0.0.0/8、10/8、100.64/10 CGNAT、127/8、169.254/16、172.16/12、192.0.0/24、192.0.2/24、192.168/16、198.18/15、198.51.100/24、203.0.113/24、224/4 组播、240/4 保留）；`:150` IPv6 唯一放行 2000::/3，`:153-157` 三段抠除（2001:db8::/32 文档、2002::/16 6to4、2001:0::/32 Teredo）——**比 plan §4.1 更严**（plan 未要求抠 6to4/Teredo）。mapped `::ffff:/96` 在 2000::/3 外默认拒（测试断言 `::ffff:8.8.8.8` 也拒，`web-clip.test.ts:156`）；NAT64 `64:ff9b::` 同理拒（`:157`）。解析器数学：`parseIpv4`（:170-182）严格点分四段拒前导零/越界；`parseIpv6`（:185-227）`::` 至多一次、尾嵌 v4 折叠、%zone 剥离——我独立验算 `::1`/`2001:db8::1`/`::ffff:127.0.0.1`/`1::2:3`/`3fff:ffff...` 等装配均正确。**十进制/十六进制/八进制形态实测**：`new URL("http://0x7f000001/")`/`http://2130706433/`/`http://0177.0.0.1/`/`http://0x7f.1/` 的 hostname 全被 WHATWG URL 归一为 `127.0.0.1` → 字面量路径 `isPublicUnicast` 拒；`[::ffff:127.0.0.1]` 序列化为 `[::ffff:7f00:1]` → mapped 拒。即使非规范形态漏进 DNS 路径，getaddrinfo 归一后同样过门（实测 `dns.lookup("2130706433",{all:true})` → `127.0.0.1`）。负向用例 `web-clip.test.ts:116-221`（含段边界正反双侧）、fetch 层 `web-clip-fetch.test.ts:164-233` |
| ② | DNS-rebinding 连接时钉 IP | **✓**（附 1 条 Important 回归护栏缺口） | `web-clip.ts:499-507` `pinnedLookup` 忽略入参 hostname 恒回已验证地址；`:510-541` 每跳 `new Agent({connect:{timeout, lookup: pinnedLookup(pinned)}})`。**undici 6.29.1 源码独立取证**：`node_modules/undici/lib/core/connect.js:79` `buildConnector({...named, ...opts})` 把 `lookup` 留在 `...opts`，`:103-114`/`:126-132` 以 `{...options, host: hostname}` 透传 `tls.connect`/`net.connect`——socket 目标由钉住 lookup 决定、SNI/Host 头仍取 URL 域名，TOCTOU 时窗真闭合。`resolveAndPin`（:437-467）字面量 IP 直校验 + DNS `all:true` 全址过门（任一不过即拒）+ 钉首址。测试：`pinnedLookup` 双 callback 形态（fetch.test:133-146）+ Agent 构造受纳（:148-153）；commit 012c812 亦记录了同款源码核验。缺口见 Important-1 |
| ③ | charset/GBK 解码链 | **✓** | `sniffCharset`（web-clip.ts:300-313）：Content-Type charset（正则前缀解析、引号/大小写容忍）> BOM（UTF-8/16LE/BE）> meta 双形态扫前 2048 字节 ASCII 小写化 > utf-8；GBK 家族归一 gb18030（:273-277）。`decodeBody`（:319-336）：非法编码标签与 U+FFFD 占比 >2% 双路拒（`undecodable`），乱码不落库。**解码先于 DOM**：`orchestrateClip:764` 先 `decodeBody` 再 `extractArticle`。GBK 夹具：`web-clip.test.ts:261-267` 手写 hex（中/你好世界）+ 端到端 header→sniff→decode；skipLibCheck 环境下 small-icu 会抛→`undecodable` 安全失败（代码 :320-325 catch）。Node 官方构建 full-icu 前提成立（本机实测通过） |
| ④ | URL 归一化进 sha256 前 | **✓** | `normalizeUrl`（web-clip.ts:56-74）：URL 构造器自带 scheme/host 小写；fragment 清空；默认端口剥；追踪参数白名单 `utm_*` + `pass_ticket/scene/from/isfromandroid/src/u_source`（:42）；`mp.weixin.qq.com` 短路径 `/s/[A-Za-z0-9_-]+` 丢全部 query（:45,:67）；剩余参数按名排序（:71，ES2019 稳定排序，重复名保序）；`urlHash8`（:77-79）在归一化后计算。测试 `web-clip.test.ts:28-66`（微信短路径两变体同归一、语义参数保留、大小写/端口/fragment/排序、非法 URL）。编排链 `orchestrateClip:762-766` 判重/路径/provenance 全部吃归一化产物。反例检查：`example.com` vs `example.com./`（尾点）不同 hash——记 Minor-3；其余形态（大小写、IDN punycode、%编码大小写、空 query、默认端口）均收敛 |
| ⑤ | force/时戳-哈希交互（稳定字节） | **✓** | `orchestrateClip:770-788`：判重读 `clips/` 页，存在则 `clipped_at/clipped_by` 取自库内 frontmatter 原样保留（frontmatterValue :729-746，双引号 YAML 走 JSON.parse 吸收转义）、缺落补当前值；`changed = existing===null \|\| content!==sourceMd`，同文零重写零嵌入——content_hash 含 frontmatter 也不变。测试 `web-clip-fetch.test.ts:629-673`（同文重存只 fetch+getPage+enqueue 三步、`clipped_at: "2026-01-01..."` 不 bump、正文变更才 updated+force）。注意：force 参数按 Ruling R12 从 v1 移除（schema 无 force，`identity.test.ts:631-640` 钉桩）——见 Minor-4 的 plan 一致性注记 |
| ⑥ | 重复剪藏恒 enqueue 自愈 | **✓** | `orchestrateClip:799` 无条件 `createIngestJob([sourcePath])`——服务端 `ingested_files` 按 (project, original_path) 唯一键 + 路径/内容哈希短路：成功=近零成本 no-op、失败=自动重试。测试 `web-clip-fetch.test.ts:629-649`（「同文：零写入零嵌入，恒 enqueue」）+ `api-client` 侧 `createIngestJob` 契约（:830-842）。教师话术最终口径：already 回复「已于…收藏过…已顺手再补一次整理」（training.ts clipReplyText）+ jobId 供追问，无误导性「已收藏」（M9 修正落地） |
| ⑦ | 回滚完整性含 SKILL.md 同批 revert+双份 cp | **✓**（文档/流程级） | plan.md §5（L116）：「`git revert` 仓源——**mcp-server 改动与 SKILL.md 同一批 revert**，随后双份 cp 把 live 副本同步回滚（AGENTS.md #5：禁止只回写 live 副本…）；工具注册是增量面，不影响存量工具」——完整落盘，与 AGENTS #5 纪律一致 |
| ⑧ | 微信链接冒烟属 Phase 0 | **✓（落盘）/部分（实跑记录）** | plan.md §3 Phase 0 第 3 项（L39）：真实 `mp.weixin.qq.com` 走通 fetch+正文提取、失败识别与降级话术、「不带病施工」——闸门设计落盘 ✓；§11 记录 Phase 0 实证结论（通用摄取不产 notes、sources 零嵌入→R8 修订）；§10 M6「本批 psql+存储直删」证明 Phase 0/e2e 实跑且手工清理执行。**未核实**：微信真实链接冒烟的显式结果记录不在树内（storage 10:42 建后清的 clips 目录无法回溯 URL 形态），仅间接证据（SKILL/工具描述以微信为主场景措辞 + `web-clip-fetch.test.ts:486-493` 微信 rich_media/js_content 夹具提取通过） |

---

### 三、部署态核验（只读证据）

| 项 | 结果 | 证据 |
|---|------|------|
| git 状态 | HEAD=`c3bd3a5`（merge commit），工作树干净；**main 领先 origin/main 8 个提交未推送** | `git status` / `git rev-parse` |
| SKILL.md 双份同步 | **一致**（byte-identical） | `diff docs/.../SKILL.md ~/.hermes/profiles/lt-tutor/skills/teacher-tutor/SKILL.md` 零输出；live mtime 2026-10-18 10:36:02 |
| references/ 同步 | 6 个 flow-*.md 全部一致（本次无 references 改动，符合预期） | 逐文件 diff OK |
| manifest 指向 | `teacher-tutor/SKILL.md`，inode `101387256` 与 live 文件一致 ✓；**但快照记录值为部署前旧态**（size 21792 / mtime 2026-09-17；快照文件自身 mtime 09-27） | `.skills_prompt_snapshot.json` 解码 + `stat` |
| 网关进程 | pid 33374 存活（`gateway run --replace`，10:36:54 启动——晚于 SKILL cp 52 秒，重启序正确；进程内索引按启动重建推断已新，**进程内实态未核实**） | `ps -p 33374` |
| 构建产物 | dist 2026-10-18 10:35 构建，含 `dist/src/web-clip.js`、`training.js`（teacher_tutor_web_clip） | dist 只读检查 |
| e2e 零残留（四层） | **全零**：① 存储 `kb-storage/teams/916/projects/614/sources/` 无 clips/（mtime 10:42=建后清）；② `wiki_pages path LIKE 'clips/%'`=0；③ `ingested_files original_path LIKE 'sources/clips%'`=0 且 10-17 后零 ingest；④ `embeddings`（pgvector）clips 相关=0、**全库孤儿向量=0**（清理连向量层都做干净了，超 M6 承诺）。近 3 页更新 wiki/log·index·overview（10:38-10:43）非 clip 产物；`%test-%` ILIKE 命中均为既有教学内容页 | docker psql SELECT-only + 文件系统 |
| 附注 | 快照文件未随部署刷新属 AGENTS 口径内行为（description/索引随下一次会话 prompt 构建刷新，正文每回合现读盘）； plist 检视过程中 env 含密钥，本报告不回显 | — |

---

### 四、优点

1. **8 阻断项无一条停留在「文档意图」级**——每条都有行级实现 + 对应测试钉桩，且 SSRF 门比 plan 更严（6to4/Teredo 整段抠除、`::ffff:` 内嵌公网 v4 也拒）。
2. **钉 IP 方案选型与实证诚实**：commit 012c812 为 R11 降依赖（undici 8/jsdom 30 的 engines 与 node 20 CI 冲突→降 6.29.1/26.1.0）做了 buildConnector 源码级核验并写进提交信息；我独立复核同一文件得出同一结论（connect.js:79/103/126）。
3. **数学实现质量高**：BigInt 位运算 CIDR、严格 IPv4/IPv6 解析器（拒前导零/畸形段/双 `::`），exotic IP 形态靠 WHATWG URL 归一 + getaddrinfo 归一双保险——我构造的绕过尝试全部失败。
4. **API 契约镜像纪律**：`upsertPage` 的 409→GET sha256 预检→If-Match PUT→有界 3 轮重试逐段镜像 transcriber 生产验证过的 `upsertTranscriptPage`；与 src-server `pages.rs` 的 ON CONFLICT DO NOTHING 409、RFC3339 timestamptz If-Match 精确比较（:200-206）严丝合缝。
5. **R8 勘误的正确性**：直写 clips/ 页 + 服务端页写非致命嵌向量（pages.rs:158-171/235-249 实证），`clipApiFace.embedPage=no-op` 的注释把「为什么不能直调」写清楚（桌面专属路由 405 会打断编排）——对管线行为的理解经源码证实准确。
6. **教师体验闭环自觉**：11 枚错误码→人话文案 + 未知 code 兜底（带 code 供排查）、WebClipError 正常返回防 Hermes 熔断（对照 record_ask/read_file 前例）、already 回复带收藏人（M5）、prev 缺落优雅降级不吐 undefined、M9「稍后整理完成」+ jobId。
7. **identity 硬闸零绕开**：handler 走 `resolveIdentityForTool` 统一入口（training.ts:1506），web_clip 不在 SUPERVISION_TOOLS——wecom 会话身份冲突照硬拒、系统回合须显式 wecom_userid（identity.ts 三出口原样适用）；`callWithAccess` 401 整轮重试有幂等性论证。
8. **测试断言真行为**：orchestrate 测试断言调用序 + 精确路径 + sourceMd 字节快照；upsert 409 链测试模拟并发漂移与 stale write；10MB 帽测试验证「撕流后不再供给」；D2 防滥用文案五个要点逐串断言（training.test.ts:1358-1370）。

---

### 五、问题

#### Critical（live 缺陷，须立即处置）

**无。** 经压力测试未发现安全绕过、数据损毁或教师可见破坏：SSRF 门数学与接线双重证实、判重闭环、错误路径有兜底、四层零残留。

#### Important（应尽快修）

1. **undici 钉 IP 的生产接线无任何测试触达，且依赖浮动 semver——安全核心性质缺回归护栏**
   - 位置：`mcp-server/src/web-clip.ts:510-541`（`undiciRequestOnce`，生产唯一真网络路径）；`mcp-server/test/web-clip-fetch.test.ts:133-153`（仅 `pinnedLookup` 纯函数 + Agent 构造受纳，注释自承「零网络」）；`mcp-server/package.json`（`"undici": "^6.29.1"`）。
   - 问题：全部 fetch 层测试经 `FetchGuardsDeps` 注入绕开了真实 undici 接线。钉 IP 成立这一安全性质目前只由「源码人读」保证（我已独立证实 6.29.1 成立），但 `^6` 浮动区间内任何一次 `npm update` 若改变 buildConnector 透传语义，318 个绿灯测试不会有一个变红，SSRF 门静默退化为「查完再 fetch」的 TOCTOU 缝。
   - 修法（二选一，成本约半小时）：① 加一个真网络负向集成测试：本地 `127.0.0.1` 起一次性 HTTP 服务 + `lookupAll` 注入把某假域名指向它 → 断言 `fetchWithGuards` 抛 `ssrf_blocked` 且服务端零连接（这同时测了 DNS 门与真实 socket 接线两层）；② lockfile 锁死 undici 精确版本（`6.29.1` 无 `^`），升级走显式评审。建议 ①+② 都做。

#### Minor（记档顺修）

2. **超时为分段预算而非 plan 单一 20s**：`dnsLookup` 无显式超时（web-clip.ts:550，靠 OS resolver 默认可达 30s+）；connect/headers/body-idle 各 20s（:392,:519-521）且 3 跳无总 deadline；undici `bodyTimeout` 是 chunk 间隔型——慢滴响应理论上可拖长单次 MCP 调用。建议加 AbortSignal 总帽（如 60s）。
3. **归一化残留缝隙**：`normalizeUrl` 不剥 userinfo（`https://user:token@site/` 的凭证原样进共享可检索的 frontmatter source_url + LLM 输入）、不归一尾点 host（`example.com.` ≠ `example.com` → 同文双份收藏）。userinfo 剥除无语义损失，建议下批加；签名参数（X-Amz-Signature 类）难判定，记档接受。
4. **plan 与实现的 force 偏差未回写 plan**：plan §3/§4.3 仍写「force:true 留强制重存口」，实现按 Ruling R12 无 force（schema 钉桩 identity.test.ts:631-640）——R12 只存在于 commit ca3da0e 与代码注释，plan.md 未记录。由此存在一个理论死角：`clips/` 页在且内容相同、但 sources 文件被手工删（如清理过猛）→ `changed=false` 不重写源文件 → enqueue 对缺失文件永败且无 force 兜底，需手工补文件。频率极低（仅人工误删触发），记档；建议 plan 补 R12 段落并把该死角写进处置口径。
5. **kebabSlug 仅保留 Han**（web-clip.ts:93 `[\p{Script=Han}a-z0-9]`）：假名/谚文/带音符拉丁标题全剥→回落 `clip-<hash8>.md`（日韩文章、`Café`→`caf`）。R10 只按中文场景拍板，教师场景可接受，记档。
6. **`@types/jsdom@27` 配 `jsdom@26`** major 错位（当前 tsc 零错，纯记档防将来类型漂移误读）。
7. **钉首址无 family 偏好**：AAAA 排前且本机 v6 不通时直接 `fetch_failed`（无 happy-eyeballs 回落）——安全优先的正确权衡，可用性记档。
8. **already 回复的可读性依赖 userid 形态**：actor=`ident.wecomUserid`，若 userid 是工号/拼音串，「王老师 已于…」话术打折（M5 意图假设人读名）。
9. **GBK 夹具为字节级**（decodeBody 层手写 hex），缺一篇整页 GBK HTML 走 sniff→decode→extract 的端到端夹具（plan §5 夹具清单字面是整页）。
10. **yamlQuote 不转义换行**（web-clip.ts:369-371）：多行 title 产出 YAML 折叠标量（服务端重解析时 newline→space，标题值轻微变形）；content 列存原文、判重字节比对不受影响，纯记档。

---

### 六、建议

1. **优先落 Important-1**（真网络回归测试 + 版本锁定）——这是唯一护住「SSRF 门不随依赖漂移而退化」的自动化手段。
2. 下批顺手项：normalizeUrl 剥 userinfo、AbortSignal 总帽、plan 补 R12 勘误段落（与 §11 R8 同款格式）。
3. 观测按 plan §11 四条执行（sources/clips 增速、clips 页检索命中占比、clipped_by 维度、ingest 失败率）；本轮已证实 embeddings 在 PG（pgvector，非 LanceDB）——观测 SQL 面可直接用 `wiki_pages`/`embeddings` join。
4. `main ahead 8`：尽快 push origin 建立远程备份（live 构建产物来自本地仓，回滚依赖本地仓库完好）。

---

### 七、结论

**放行判定？** **维持放行**。

**理由：** 8 条方案评审阻断项全部在行为级落地且经独立验证（含 undici 源码级钉 IP 取证与 exotic IP 实测），live 部署态四层零残留、SKILL 双份一致、318 测试全绿；唯一 Important 是回归护栏缺口而非现行缺陷，按记档节奏补上即可，不动摇已部署行为。
