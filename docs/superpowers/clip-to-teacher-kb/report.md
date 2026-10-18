# clip-to-teacher-kb 方案评审报告（max 评审）

评审日期：2026-10-18 · 评审对象：`docs/superpowers/clip-to-teacher-kb/plan.md`（工作区文档，~123 行）· 对照 HEAD 代码 + live PG（docker :5433，SELECT-only 实查）

---

### 一、总评

方案的事实底座异常扎实：§2 全部八个锚点经代码与 DB 逐条核实**无一虚报**（含 614 页目录计数精确到个位），「src-server 零改动」的核心推论经鉴权链代码验证成立（training/bind 建号即写 `team_members role='member'`，files-write 与 ingest-create 都只要求 Member）。整体架构走「复用既有摄取管线」是正确选择，嵌入对账、Guard 白名单、review 队列全部白得。主要短板集中在三处：SSRF 门的技术完整性（mapped-IPv6/0.0.0.0/DNS-rebinding 时窗）、判重设计与内容哈希的实际交互（frontmatter 时戳改哈希、URL 未归一化致微信链接判重失效）、以及失败路径的用户体验死局（job 失败无通知 + stat 判重拒重摄）。均为方案文本级修补，不动架构。

### 二、锚点核查表

| plan §2 事实 | 判定 | 证据 |
|---|---|---|
| `POST /api/v1/projects/:id/ingest {source_paths:[]}` → Redis 队列 job（status/cancel/retry/stream） | ✓ | `src-server/src/routes/ingest.rs:43-55`（create_ingest_job，:50 enqueue）、路由 `:163-164` + global `:171-174`；入队 `services/ingest_queue.rs:152-197`（PG 落库 + LPUSH `ingest:queue`）。注意 enqueue 对 source_paths **无任何校验** |
| 源文件写端点 `POST /api/v1/files/:id/write`（transcriber 同款在用） | ✓ | `src-server/src/routes/files.rs:327-339`（write_file，body `{path, contents}`，路由实为 `/:project_id/*path`、`write` 为占位段）；transcriber 实证 `tools/transcriber/src/api-client.ts:292-298` |
| LLM 写页白名单 = concepts/+entities/+notes/ 三前缀，其余 GuardSkipped | ✓ | `src-server/src/services/ingest_pipeline.rs:1455-1457`（is_llm_writable_namespace），消费点 `:1815-1818`；transcripts/ 另有专属守卫 `:1812` |
| 614 页目录：concepts 10,738 / entities 6,677 / transcripts 841 / notes 132 / 其他零头 | ✓ | docker psql 实查：`concepts\|10738、entities\|6677、transcripts\|841、notes\|132、examples\|5、resources\|3、wiki\|3`（另有 1 页根级残页 `notes-self-study-learner.md`，历史遗留） |
| notes 命名惯例 `notes/<kebab-slug>.md` | ✓（有重要细节） | 实查 132 页**全部 ASCII 英文 kebab、0 页含 CJK**。成因：slug 由 step2 LLM 生成且 prompt 硬约束 ASCII（`services/prompts/step2_generate.txt`："lowercase ASCII slugs … never translate them"；确定性校验 `ingest_pipeline.rs:136-147` is_valid_wiki_path）——**不是从源文件名派生**，与 §4.3 Phase 0 开放项直接相关 |
| 桌面 Clipper = Readability.js + Turndown.js，扩展侧完成 | ✓ | `docs/features.md:39-45`；`src/lib/clip-watcher.ts:14-47`（app 只轮询 19827 `/clips/pending` 拿文件路径再 enqueue，提取确在扩展侧） |
| 教师工具面 teacher_tutor_* + 复用 training 鉴权链 | ✓ | `mcp-server/src/training.ts:320-760`（15 个 teacher_tutor_* 定义）、`identity.ts:64-98`（三出口硬闸）、TeacherCredentialStore（training.ts:132-245，refresh→bind 回落）。锚点写 index.ts 略粗，实质属实 |
| llm_wiki_files / llm_wiki_rescan_sources 是桌面 API 面工具 | ✓ | `mcp-server/src/index.ts:91`（llm_wiki_files）、`:186`（llm_wiki_rescan_sources），均在 desktopToolDefinitions()，src-server 形态不注册（`buildTools` :220-225） |
| **推论：全命中白名单，零 Rust 可行** | ✓（代码级证实） | 教师身份=项目 team member：`routes/training.rs:260、:310`（bind 事务 `INSERT INTO team_members … 'member'`）；files-write 与 ingest-create 均 `check_project_access`（Member 即过）：`files.rs:333`、`ingest.rs:49` + `middleware/project_guard.rs:14-20、51-59`。**Phase 0 权限验证理论上必过**（仍值得跑一次防环境配错） |
| src-server 现无任何剪藏通道（§1 前置问答） | ✓ | 全仓 `rg clip` 于 src-server/src 无命中；web_search.rs = Tavily 搜索 provider（返回 snippet，非抓页）；research/ 只消费 web_search |

补充核实（评审过程发现、报告下文引用）：摄取判重跳过条件 = 同 project+path 下 content_hash **且** file_size 均等（`ingest_pipeline.rs:2138-2146`）；页面 upsert 按 LLM 给的 path 幂等，源路径重叠时走 Merge（`collision_mode` :1828-1831、merge 分支 :1832+）；嵌入在 job 尾段自动批处理并带落库对账（`ingest_pipeline.rs:2085-2135`）；md 解析**不剥 frontmatter**、严格 UTF-8（`crates/llm-wiki-parser/src/parser/markdown.rs:4-21`，GBK 字节直接 EncodingError）；job 全败时整 job 报错（:2059-2064），单源失败落 item_states；worker 并发 knob 默认 1、env `INGEST__WORKER_CONCURRENCY` 覆盖（`config.rs:180-196`、`ingest_worker.rs:36-40`）——live 值 2 来自项目记忆，未直连服务进程核实（标注：接受背景事实）。

### 三、优点

1. **事实核查质量罕见地高**。八个锚点全部命中，DB 计数与实查逐位一致（10,738/6,677/841/132）。「零 Rust 改动」不是拍脑袋——鉴权链每一环（bind 建号 → member 角色 → 两端点 Member 门槛）都能在代码里指出行号。
2. **复用摄取管线的收益判断准确**。走 sources/clips/ + 通用 ingest 意味着两步 LLM、三前缀 Guard 白名单（`ingest_pipeline.rs:1455`）、嵌入+落库对账（:2085-2135）、review 队列、恢复语义全部继承，v1 改动面确实收敛在 mcp-server + SKILL。
3. **确定性路径判重方向正确**。urlhash8 进文件名使同 URL 恒映射同一路径，配合 ingested_files 的 (project, original_path) 唯一键，存储层幂等成立；title 不做路径段、hash 段仅 hex，无注入面。
4. **SSRF 有自觉**：逐 IP 全检（防多 A 记录）、重定向不自动跟随逐跳复验、负向用例清单（含十进制 IP、0.0.0.7、169.254.169.254）显示作者懂经典绕过形态。
5. **运维纪律内化**：部署节写明 mcp:build + 网关重启避周日 19:00-20:00 窗、SKILL 双份 cp（AGENTS #5/#7）；Phase 0「未获许可不动工」+ 验毕删测试产物的意识到位。
6. 开放决策点 D1-D5 显式拍板留痕，R1 降级路径预备了窄端点方案，方案可执行性好。

### 四、问题

#### Critical（不修不能开工）

无。经逐项压力测试，未发现会造成安全事故、数据损毁或必然返工级别的设计洞——SSRF 与判重的缺口都是「门有缝」而非「门没装」，修补成本低（见下）。空 Critical 是本次评审的诚实结论，不是放松标准。

#### Important（开工前应修/应补设计）

1. **SSRF 封禁清单不完整 + mapped-IPv6 可绕过**（plan §4.1 L75-78）。
   清单缺：`0.0.0.0/8`（**多数 OS 上 connect 0.0.0.0 = localhost**，负测里有 0.0.0.7 但封禁清单未列段）、`::ffff:0:0/96` IPv4-mapped（攻击者自持 DNS 发一条 AAAA `::ffff:127.0.0.1` 即绕过 v4 检查——dns.lookup 原样返回该 v6 地址，不在 fc00::/7、不等于 ::1，逐 IP 校验放行）、`100.64.0.0/10` CGNAT、组播 `224.0.0.0/4` 与 `255.255.255.255`、`64:ff9b::/96` NAT64、`::/128`。
   为什么重要：这是 v1 唯一新增网络攻击面；mapped 形态是真实可构造的绕过而非理论。
   修法：改为**默认拒绝**姿态——解析地址后先归一（v6 是 mapped 则抽出内嵌 v4），再只放行「IPv4 公网单播 + IPv6 2000::/3 全局单播」，其余一律拒。比枚举黑名单更短更稳。

2. **DNS rebinding TOCTOU 只做了「静态全检」**（plan §4.1 L78「DNS 再绑定时窗——至少静态全检」）。
   `dns.lookup` 校验后 `fetch(hostname)` 会在连接时**二次解析**，攻击者在该窗口换记录即命中内网。方案明示接受了这个缝。
   严重度评估（诚实版）：mcp-server 跑在 macOS 本机（launchd 生态），内网面 = localhost 上带鉴权的 :8080、docker 绑 127.0.0.1 的 :5433/:6380，实际增益有限——所以不定 Critical；但标准修法便宜：undici `new Agent({ connect: { lookup } })` 用自校验 lookup 钩子在**连接时**复检并钉住已过检 IP（约 15 行），或对已检 IP 直连 + 手动 Host 头。应写进方案而不是留缝。

3. **charset/GBK 解码完全未提，中文生态是主用户面**（plan §4.1 L77、§3 数据流 ②）。
   现实链路：GBK 页 → 按 UTF-8 解出替换符/mojibake → turndown 产出合法 UTF-8 垃圾 → md parser 放行（只拒非法 UTF-8 字节）→ **乱码永久进 notes/ 页 + embeddings + 共享检索面**，且 614 是全员共享库。
   修法：Node 20 官方构建带 full-icu，`TextDecoder('gbk')` 现成可用；从 Content-Type charset 与 `<meta charset>` 取编码（HTTP 头优先），解码后再喂 jsdom。必须进 §4.1 与测试清单（夹具加一篇 GBK 页）。

4. **URL 归一化缺失，urlhash8 判重在主场景（微信）会失效**（plan §4.3 L88）。
   http/https、尾斜杠、query 顺序、`utm_*`、微信分享链的 `scene/subscene/from/isappinstalled/pass_ticket/chksm` 变体 → 同一篇文章生成不同 urlhash8 → 不同源文件 + 各自全量摄取 → **重复笔记页进共享检索**。微信文章 URL 带参变体恰恰是教师转发最常见的形态。
   修法：sha256 前先归一——scheme/host 小写、去 fragment、剥追踪参数白名单（含上述微信参数）、剩余参数排序；`mp.weixin.qq.com` 特例：身份取 `/s/<token>` 路径。归一化纯函数进 `web-clip.ts` 单测。

5. **force:true / 重写与内容哈希的交互想反了**（plan §4.3 L88-90）。
   服务端 content_hash 是**整文件解析文本**（含 frontmatter，`ingest_pipeline.rs:2138`）的 sha256。「force:true 强制重存」会写入新 `clipped_at` → 哈希必变 → 「内容没变=自动 no-op」**不成立**，等同内容也会触发完整两步 LLM 重摄 + 可能另起一个 slug 不同的笔记页（LLM 重选 slug 非确定）。§4.3 的判重承诺只在「字节完全不变」时为真。
   修法（写进方案）：重剪同 URL 且正文未变时**沿用原 clipped_at/clipped_by 字节**（只在正文 diff 时更新时戳）；force:true 语义收窄为「修复失败后强制重摄」。另注意并发双教师首剪同 URL 的 last-write 差一字节会触发双摄取——罕见且良性，记档即可。

6. **失败路径是死局：job 失败无通知 + stat 判重拒重摄**（plan §3 L52-54、§4.3 L90）。
   工具返回 job_id 即返回；job 可整单失败（`ingest_pipeline.rs:2059-2064` all-failed → Err）或单源 failed（item_states），教师永远不知道；更糟的是下次重发同 URL 会命中「已于…收藏过」**连重试摄取都被跳过**——文章被静默搁浅，force 参数教师不会知道也不会用。
   修法（优雅且近零成本）：**重复剪藏时照样 enqueue ingest**——内容未变时 `process_source_path` 在 LLM 之前就 hash 短路跳过（:2141-2146，一次文件读+比对的开销），而若上次失败（未 mark ingested）则自然重试。回复话术保留「已收藏过」+ 幂等重投即可自愈；可选加工具内有界轮询（30-60s）把快速失败当场报给教师。

7. **回滚声明不完整，违反 AGENTS #5 的回滚纪律**（plan §5 L98）。
   「去掉注册重新 build 即回滚」只覆盖 MCP 面；SKILL.md 同步改了工具清单+触发口径，若不回滚 SKILL，教师侧 tutor 仍会尝试调用已注销的工具（MethodNotFound 直接打进对话）。且按 AGENTS #5：**回滚必须 git revert 仓源后随常规部署，禁止只回写 live 副本**（并行会话的例行双份 cp 会打回只回写 live 的操作——收口评审 I1 的既有教训）。§5 回滚节需补：「SKILL.md 走 git revert + 双份 cp 重新部署，mcp-server 去注册 rebuild + 网关重启，二者同批」。

8. **微信链接可行性应升为 Phase 0 必验项**（plan §6 R3 L104）。
   教师主通道就是微信文章；mp.weixin.qq.com 的反爬（UA/cookie/环境校验）若大面积失败，v1 核心价值不成立。现在 R3 写「首验必测」但时点含糊（可被读成上线后首验）。修法：Phase 0 加第 3 项——真实微信文章链接抓取冒烟（含带参变体、加密页 `wx.qq.com` 跳转形态），定义失败识别（验证页特征/正文空）与「请复制正文发我」的降级话术；若微信成功率低，先落 Phase 2 粘贴通道再上 v1。

#### Minor（记档顺修）

1. **SKILL 工具计数错误**（plan §3 L63「工具清单 13→14」）：现行 `docs/superpowers/hermes/lt-tutor/SKILL.md` §2 明写「只准用以下 **20** 个」（15 teacher_tutor_* + llm_wiki_search/read_file + 3 系统工具）。应改 20→21（或注明 15→16 个 teacher_tutor_*）。照 13→14 改会把 SKILL 的自我声明改错。
2. **注册位置不精确**（plan §3 L61「index.ts：注册」）：实际模式 = `training.ts` 的 trainingToolDefinitions() + `createSrcServerHandlers` 内 `handlers.set(...)`；index.ts 因 `buildTools` 展开（index.ts:220-225）**无需改动**。照 plan 写 index.ts 会走错文件。
3. **Phase 0 开放项的提法可提前定案**（plan §4.3 L91）：代码+prompt 已给出答案——笔记页路径由 step2 LLM 生成英文 ASCII slug（非源文件名、非标题直译），存量页清单注入促成收敛（step2_generate.txt 链接规则 + `fetch_concept_entity_pairs`）。重摄「原地 upsert」是概率性而非保证：slug 重选一致则 Merge 原地合并（sources 重叠触发 collision_mode Merge），不一致则另起新页、旧页滞留。管线有 duplicate REVIEW 类型兜底可观测。延后到 Phase 0 验证可接受，但方案应写明这个预期与旧页滞留的处置口径。
4. **CJK 标题的源文件名 slug 规则未定**（§4.3 L88）：kebab-slug 若剥 CJK 会退化成 `-ab12cd34.md`（可存但难看、列表排序全撞 `-` 前缀）。建议明确：文件名保留 CJK（safe_resolve 对 unicode 无限制，受限的只是 LLM 页路径 ASCII 约束），或拼音/首词兜底。
5. **「已于 <clipped_at> 收藏过」措辞在共享库语境有歧义**（§4.3 L90）：可能是**另一位老师**收藏的；回复应带 clipped_by（“王老师已于…收藏”）。
6. **Phase 0 清理需要 Admin 权能**：files delete 端点要求 Admin 角色（`files.rs:354`），教师 token 是 member 删不了；测试产物的清理（文件+ingested_files 行+笔记页）要走开发者手工（psql/存储直删）。方案应写明清理路径，防止“验完删不干净”留下判重残行。
7. **Content-Type 与重定向实现细节待钉**：接受 `application/xhtml+xml`、charset 参数按前缀解析不整串比对；相对 Location 按 RFC 相对当前 URL 解析；https→http 降级是否放行需一句话定策；10MB 帽用流式截断+abort 而非先缓冲。均应进单测清单（§5 已有骨架，补这三类）。
8. **frontmatter 会原文进 LLM 输入**：md parser 不剥 frontmatter（markdown.rs:4-21），step1 会看到 `clipped_by/source_url` YAML——大概率无害，偶发把「teacher-tutor」之类抽成实体；provenance 键保持英文短键可减噪。记档接受即可。
9. **“1-2 分钟”话术偏乐观**：ingest 是 Redis BRPOP FIFO、worker 并发默认 1（live 2），大批量任务在队时剪藏会排队；tutor 话术宜改「稍后整理完成」。工具返回值可带 job_id 供追问。
10. **NodeNext 互操作先行确认**：三个新依赖 npm 实查均为 CJS（readability 0.6.0 `main:index.js`、turndown 7.2.4 `.cjs.js`、jsdom 30.1.3 `type:commonjs`），esModuleInterop 下 default import 可用，风险低于 pptxgenjs 前例（`mcp-server/src/pptx.ts:41` 的互操作坑注释）；另注意 jsdom 默认不加载外部资源，构造时勿开 `resources`，顺带收窄图片 SSRF 面。
11. **内容风险面的一句话补正**（§4.2）：「与既有文档上传同一风险类」基本成立，但 clip 把**共享检索语料的写入者从管理员扩到全体教师**（检索结果会回流进 tutor prompt，携带网页注入指令的攻击面同比扩大）；SKILL 已有防试探条款，风险接受但值得在 §4.2 写明这一 actor-set 变化。
12. **图片热链会腐烂**：微信图床（mmbiz.qpic.cn）有 Referer 校验，turndown 保留的 `<img>` 链接大概率失效；v1 接受（md 源的 images 管线本就「暂不处理」，`ingest_pipeline.rs:2132`），记档。

### 五、建议

1. **SSRF 门改默认拒绝 + 连接时钉 IP**（Important 1/2 合并实现）：`web-clip.ts` 内建 `assertPublicUnicast(ip)`（mapped 归一后仅放行公网单播）+ undici Agent 自定义 lookup 钩子连接时复检——两者合计预计 +0.5 天内，建议并入 Phase 1 工作量。
2. **判重三件套一次定案**（Important 4/5/6）：URL 归一化 → 稳定字节写入（正文未变不动时戳）→ 重复剪藏恒 enqueue。三者共同构成 D4 的完整实现，缺一都会在微信场景露馅。
3. Phase 0 扩为三项：权限冒烟（预期过）、管线冒烟（含 frontmatter 容忍观察 + 笔记页 slug 实态记录）、**微信链接冒烟**；并写明清理走 Admin/手工。
4. 工作量重估：按上述增补，Phase 1 从 1.5d 调到 **2-2.5d** 更诚实（SSRF 钉 IP + charset + 归一化各占小半日）；原 2 天总盘子在触发 R1 时必然击穿。
5. 上线后观测点写进方案：`sources/clips/` 增速、notes/ 占比变化对检索质量的影响（降噪战役 PR #8 的延续观察）、clipped_by 维度的量级（为 D2 的 v2 硬配额积累数据）。

### 六、结论

**可否开工？** 修后可开工。

**阻断项清单**（均为方案文本修订，不动架构）：
① §4.1 补齐封禁段（0.0.0.0/8、::ffff:/96 归一、100.64/10、组播/保留段）并改默认拒绝；② §4.1 补 DNS-rebinding 连接时钉 IP 处方；③ 补 charset/GBK 解码设计；④ §4.3 补 URL 归一化（含微信参数特例）；⑤ §4.3 修正 force/时戳与哈希的交互语义；⑥ §3 补「重复剪藏恒 enqueue」自愈设计；⑦ §5 回滚补 SKILL.md 的 git revert + 双份 cp 纪律；⑧ 微信冒烟升为 Phase 0 第 3 项。

**理由**：架构判断（零 Rust 复用既有管线）经代码逐环验证成立、事实锚点零虚报，方向无需返工；但判重与 SSRF 两处按现文施工会在主场景（微信中文文章）交付时即失效或留安全缝，属「开工前应写清楚」而非「推倒重来」级缺陷。
