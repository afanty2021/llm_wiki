# 方案：网页收藏进教师知识库（clip-to-teacher-kb）

> 状态：**评审通过（修后可开工，0C/8I/12M，8I 已全部折入 2026-10-18 修订稿）——待用户施工许可，未获许可不动工**
> 作者：ZCode 会话 · 初稿 2026-10-18 · 评审修订同日
> 前置问答：桌面版 Clipper=真·合并进库；两版 Deep Research 只落单页报告；src-server 无任何剪藏通道（见对话核查记录）

---

## 1. 目标与非目标

**目标**：教师把自己在微信/浏览器里看到的网页文章发到师训助手对话里，助手把文章收进 614 教师库，走完整两步摄取（笔记页+实体/概念+嵌入），之后可被 `llm_wiki_search` 检索到——补齐「网络资料自动合并进知识库」在教师侧的最后一块。

**非目标（本期不做）**：
- 浏览器扩展直连 src-server（教师无 web 登录态，重的认证/CORS 面，收益低）
- 网页 UI 粘贴框（教师主通道是 WeCom 对话，不是 8080 web）
- Deep Research 结果逐条入库（维持 PR #8 降噪战役的现行为：只落单页报告）

## 2. 现状事实（代码锚点，已核查）

| 事实 | 锚点 |
|---|---|
| 摄取触发端点已存在：`POST /api/v1/projects/:id/ingest {source_paths:[]}` → Redis 队列 job（带 status/cancel/retry/stream） | `src-server/src/routes/ingest.rs:50,163-174` |
| 源文件写端点已存在（transcriber 同款在用）：`POST /api/v1/files/:id/write` | `src-server/src/routes/files.rs:327` |
| 通用摄取的 LLM 写页白名单 = `concepts/`+`entities/`+`notes/` 三前缀，其余 GuardSkipped | `src-server/src/services/ingest_pipeline.rs:1455-1457` |
| 614 现行页目录：concepts 10,738 / entities 6,677 / transcripts 841（transcriber 专属）/ **notes 132** / 其他零头——通用文档摄取产物落 notes/ | DB 实查 2026-10-18 |
| notes 命名惯例 `notes/<kebab-slug>.md` | DB 实查 |
| 桌面版 Clipper 提取引擎 = Readability.js + Turndown.js（扩展侧完成，app 只收 markdown） | `docs/features.md` §5、`src/lib/clip-watcher.ts` |
| 教师工具面惯例：`teacher_tutor_*` 前缀、MCP 客户端复用 training 鉴权链 | `mcp-server/src/index.ts` |
| `llm_wiki_files`/`llm_wiki_rescan_sources` 是**桌面 API 面**工具（走桌面权限），教师部署用不上 | `mcp-server/src/index.ts:91,186` |

**推论**：剪藏源走 `sources/clips/` + 通用摄取 → 产物落 notes/+concepts/+entities/，**全部命中既有白名单，src-server 零改动可行**。

## 3. 方案总览

### Phase 0 — 三个前置验证（半天）

1. **权限验证（已降级为一发确认）**：评审代码级证实——training/bind 建号即 team_members role='member'，而 files-write 与 create ingest 都只要求 Member，理论必过。仍保留一发 curl 实证（transcriber 同款手法），防部署层意外。
2. **管线验证**：手工放一个 `sources/clips/test-<date>.md`（自写样文）触发 ingest，确认产出 `notes/<slug>.md` + 实体/概念 + 嵌入、job 正常收尾。**测试清理走手工**（files delete 端点要 Admin 权能，MCP/教师身份删不动）：DB 删页+向量、storage 删文件、**ingested_files 删行**（防判重 no-op 卡死重跑），transcriber 战役同款流程。
3. **微信链接冒烟（可行性闸门，评审 I8 升级项）**：真实 `mp.weixin.qq.com` 文章走通 fetch+正文提取。教师主通道就是微信文章——此关不过则 v1 核心价值不成立，停下来重拍方向（粘贴正文通道升主通道），**不带病施工**。

### Phase 1 — v1：MCP 工具 `teacher_tutor_web_clip`（主交付，约 1.5 天）

**数据流**：

```
教师（WeCom）发链接 → lt-tutor 判定意图 → 调 teacher_tutor_web_clip(url)
  mcp-server：
    ① URL 归一化（§4.3）：去 fragment、剥追踪参数白名单、微信短路径优先——
       urlhash8 在归一化后算，否则微信分享链变体直接击穿判重（评审 I4）
    ② SSRF 门（§4.1，默认拒绝 + undici 钉 IP 闭 rebinding 时窗）
    ③ fetch：UA 声明、20s 超时、10MB 帽、重定向逐跳复验
    ④ charset 嗅探链（§4.2）：header > meta > UTF-8；GBK 家族经 gb18030 解码，
       解不出=如实报错，绝不把乱码写进共享库
    ⑤ jsdom + @mozilla/readability 正文提取 → turndown 转 Markdown（表格保留）
       —— 与桌面 Clipper 同引擎同质量
    ⑥ 组源文件 sources/clips/<slug>-<urlhash8>.md，frontmatter provenance：
       title / source_url / clipped_at / clipped_by / via=teacher-tutor
    ⑦ 写与提交（评审 I5/I6 合并机制）：stat 精确路径——
       不存在→写入；存在→保原 clipped_at，正文字节相同则不重写（hash 不变）
       **无论新旧恒 enqueue**：服务端 ingested_files 按路径+内容哈希现成短路
       ——成功过=近零成本 no-op，失败过=自动重试，失败死局不存在
       force:true 仅用于「同文也强制重写重摄」的卡死兜底
    ⑧ files write 落源 → POST ingest {source_paths:[...]} 拿 job_id → 异步返回
  tutor 回复：新收藏「已收藏《标题》，整理完成后即可检索（约 1-2 分钟）」；
              已存在「已于 <clipped_at> 收藏过《标题>，已顺手补一次整理」
```

**工具描述要点**（防滥用，写进 description）：一次一链接；批量抓取/整站入库必须拒绝并提示版权约束（对齐 AGENTS.md 摄取红线：ECE CC BY-NC 禁整库）；只收正文完整的文章页，登录墙/付费墙失败要如实报错。

**改动面（仅 mcp-server + SKILL，零 Rust；评审 Minor 修正注册位置）**：
- `mcp-server/src/web-clip.ts`（新）：归一化/SSRF 门（undici 钉 IP）/charset 嗅探/提取/slug/写与提交策略，纯函数可单测
- `mcp-server/src/training.ts`：注册 `teacher_tutor_web_clip`（**教师工具实际注册在 training.ts，非 index.ts**——实证 15 处 `teacher_tutor_*` 均在此）
- `package.json`：+ `@mozilla/readability`、`turndown`、`jsdom`、`undici`（Agent 钉 IP 用，若 Node 内建 fetch 不足以支撑钩子）四个依赖（jsdom 较重，若介意可换 linkedom——D3 已定 jsdom）
- `docs/superpowers/hermes/lt-tutor/SKILL.md`：工具清单段**增量加一行** `teacher_tutor_web_clip` + 触发口径（「老师发链接=收藏」意图），**双份 cp 部署**（AGENTS.md 条款 5）。注：清单计数口径有分歧——按工具名去重现为 17（teacher_tutor_ 15 + llm_wiki_ 2），评审数得 20；故方案不硬编码 N→N+1，以清单段实际行数为准增量更新

### Phase 2 — 可选后续（本期不排期）

- 粘贴正文收藏（教师直接转发文字而非链接）——需求出现再做
- web :8080 粘贴框（需服务端提取或新端点，动了 Rust 才值得）
- 硬配额/统计面板（v1 先软约束，见 D2）

## 4. 安全设计

### 4.1 SSRF 门（评审 I1/I2 重写：默认拒绝 + 连接时钉 IP）

- **默认拒绝、白名单放行**（评审 I1：黑名单枚举有 `::ffff:` mapped-IPv6 一条 AAAA 即绕过、0.0.0.0/8 与 100.64/10 漏列）——只放行**公网单播**：
  - IPv4：非环回/私网（10/8、172.16/12、192.168/16）/链路本地 169.254/16/0.0.0.0/8/100.64/10（CGNAT）/组播 224/4/保留 240/4/本网络 192.0.0/24/基准测试 198.18/15/文档段 192.0.2/24、198.51.100/24、203.0.113/24
  - IPv6：仅 2000::/3 全球单播；**其余全拒**——含 `::ffff:0:0/96` mapped、`::/128` 未指定、`fe80::/10`、`fc00::/7`、`ff00::/8` 组播、`2001:db8::/32` 文档段、IPv4-compatible `::/96`
- **DNS rebinding 时窗闭合**（评审 I2：查完再 fetch 会二次解析）：不用裸 `fetch(url)`——undici `Agent` 的 lookup 钩子在**连接时**把已验证 IP 钉给 socket（Host 头仍取 URL 原值），约 15 行；多 A/AAAA 记录取首个过门 IP，验证与连接同一个地址
- 重定向**不自动跟随**，逐跳重新过门，最多 3 跳
- 超时 20s、响应体 10MB 帽、Content-Type 限 text/html 与 text/plain
- 负向用例进单测：127.0.0.1/十进制 IP/0.0.0.0/0x7f000001/169.254.169.254/100.64.x/`::ffff:127.0.0.1`/纯 AAAA 内网映射/重定向进内网/短 TTL rebinding（静态模拟 lookup 钉 IP 行为）

### 4.2 内容与许可

- **charset 嗅探链**（评审 I3）：HTTP Content-Type charset > HTML `<meta charset>`/`<meta http-equiv>` > 默认 UTF-8；GBK/GB2313/GB18030 家族经 `TextDecoder('gb18030')` 解码（Node 内建 full-icu，超集兼容）；解码失败或替换率超阈值=**如实报错不落库**——乱码一旦进共享库即被嵌入成永久污染
- 单篇收藏=教师个人研习用途；工具与 SKILL 双处写明**禁批量、禁整库抓取**，红线对齐 AGENTS.md #8
- provenance frontmatter 永久保留出处 URL，便于后续清源
- 剪藏正文=不可信文本进 LLM 摄取——与既有文档上传同一风险类，无新增攻击类；review 面已有审计

### 4.3 路径与判重（D4 已拍板：v1 判重；评审 I4/I5/I6 合并修订）

- **URL 归一化在前**（评审 I4）：scheme/host 小写、去 fragment、去默认端口、**剥追踪参数白名单**（utm_* + 微信 pass_ticket/scene/from/src/isfromandroid/u_source 等——只剥白名单，不剥语义参数防误伤分页/文章 id）；`mp.weixin.qq.com` 同时带短路径 `/s/xxx` 与长参时**取短路径形态**。**urlhash8 = 归一化后 URL 的 sha256 前 8 位**——不归一化则微信分享链变体（同文不同参）会让判重在主场景直接失效
- **确定性路径**：`sources/clips/<标题kebab-slug>-<urlhash8>.md`，同 URL 恒同路径，替代撞名 `-2` 后缀
- **写与提交策略**（评审 I5/I6 修订，原「同内容 no-op」推理有误——content_hash 含 frontmatter，重写时戳必变哈希）：
  - stat 不存在 → 写入 + enqueue
  - stat 存在 → **保原 clipped_at 不无谓 bump**（字节不变则哈希不变）；正文相同跳过重写；**恒 enqueue**——服务端 `ingested_files` 路径+内容哈希现成短路：先前成功=真 no-op，先前失败=自动重试。失败死局（job 失败无通知 + 判重跳过重摄）由此不存在
  - `force:true` = 同文也强制重写重摄的卡死兜底，常规不需要（文章更新时正文自然变、哈希自然变）
- title 不直接进路径中段（防穿越字符）；Phase 0 增验：notes 页路径从源文件名还是标题派生（决定重摄时笔记页是原地 upsert 还是另起新页）

## 5. 测试与部署

- **单测**（`npm --prefix mcp-server test`）：提取（夹具 HTML：正常文章/表格/**GBK 编码页**/登录墙空正文）、**URL 归一化（微信带参变体→同 urlhash8）**、slug 化、SSRF 负向（§4.1 全清单）、写与提交策略（恒 enqueue/保时戳/force 分支）
- **e2e**（live，一次性）：真实 URL → job done → notes/ 页出现 → `llm_wiki_search` 可检中 → 手工清理测试产物（DB 页+向量、storage、ingested_files 行）
- **部署**：`npm run mcp:build` → Hermes 网关重启（kickstart -k，**避开周日 19:00-20:00 周报窗**）→ SKILL 双份 cp → 教师面自然观察一次真用
- **回滚（评审 I7 补全）**：`git revert` 仓源——**mcp-server 改动与 SKILL.md 同一批 revert**，随后双份 cp 把 live 副本同步回滚（AGENTS.md #5：禁止只回写 live 副本，例行双份 cp 会打回）；工具注册是增量面，不影响存量工具

## 6. 降级项与风险

- **风险 R1**（评审后降级为理论项）：MCP 身份无 files write/ingest 权限——评审代码级证实必过；万一部署层意外 → 降级路径 A：src-server 加窄端点 `POST /:id/clip {markdown,title,url}`（鉴权同训练面、内部 safe write+enqueue，Rust 改动约 +0.5 天）
- **风险 R2**：jsdom 体积/冷启动——mcp-server 是常驻进程，无碍；真介意换 linkedom
- **风险 R3**：微信反爬/需 cookie——已升 **Phase 0 第 3 项可行性闸门**（不过则重拍方向再施工）

## 7. 开放决策点（请拍板）

| # | 决策 | 建议 |
|---|---|---|
| D1 | v1 只做 MCP 通道？ | **已拍板（2026-10-18）：是**——教师主通道=对话；扩展/web 留 Phase 2 |
| D2 | 配额：v1 软约束（工具描述+SKILL 口径）还是硬限额 | **已拍板（2026-10-18）：软约束先行**=两层文字层约束零代码——①工具 description 写「单次一条、日建议 N 篇内、批量/整站一律拒绝并说明版权约束」；②SKILL.md 意图口径「一个链接=收藏、批量甩链接=拒绝建议逐篇」。无计数器无代码级拒绝；滥用靠 SKILL 当场可见拒绝+review/巡检观测，出现绕过再上 v2 硬计数（provenance clipped_by 可支撑） |
| D3 | DOM 引擎 jsdom 还是 linkedom | jsdom（与扩展同引擎、成熟；体积非问题） |
| D4 | 同 URL 判重 | **已拍板（2026-10-18）：v1 判重**——确定性路径（urlhash8 进文件名）+写前单次 stat，吃 ingested_files 现成判重；`force:true` 留强制重存口。见 §4.3 |
| D5 | 是否走方案评审会话 | **已闭环（2026-10-18）**：max 评审=修后可开工，0 Critical / 8 Important / 12 Minor；8I 全部折入本稿（见 §9），无架构变更。**剩余唯一闸门=用户施工许可** |

## 8. 工作量估计（评审后重估）

Phase 0：0.5 天 · Phase 1：**2-2.5 天**（原估 1.5 天偏乐观——归一化+钉 IP fetch+charset 链+恒 enqueue 策略均为新增实现面，含测试+部署+SKILL）· 合计 **约 3 天**；若触发 R1 降级 +0.5 天。

## 9. 评审记录（2026-10-18 max 评审）

**结论：修后可开工（0 Critical / 8 Important / 12 Minor）**。评审员对照 HEAD+live PG 只读核验：§2 八事实锚点全属实、DB 计数逐位对上、「零 Rust 改动」在鉴权链代码级证实（training/bind→member，files-write/ingest 仅要求 Member）。

8 Important 处置（全部接受、已折入本稿）：
| # | 项 | 折入 |
|---|---|---|
| I1 | SSRF 黑名单可绕过（::ffff:/0.0.0.0/8/100.64 漏列） | §4.1 改默认拒绝白名单 |
| I2 | DNS rebinding 时窗 | §4.1 undici lookup 钉 IP |
| I3 | charset/GBK | §4.2 嗅探链+gb18030+拒落乱码 |
| I4 | URL 未归一化击穿判重 | §4.3 归一化+归一化后哈希 |
| I5 | 时戳 bump 致哈希必变、「no-op」不成立 | §4.3 保原 clipped_at+字节相同不重写 |
| I6 | 失败死局（判重跳过重试+无失败通知） | §4.3 恒 enqueue 吃服务端 hash 短路 |
| I7 | 回滚漏 SKILL.md | §5 revert 仓源同批+双份 cp |
| I8 | 微信冒烟应升 Phase 0 | §3 Phase 0 第 3 项（闸门） |

Minor 已折入 3 条：工具注册实际在 training.ts（§3 改动面）；SKILL 清单计数口径分歧（去重 17 vs 评审 20）→ 改为计数无关的增量更新指令（§3）；Phase 0 清理走手工（Admin 权能，§3）。其余 9 Minor 以评审报告为准（报告未落盘，施工批随行核对）。

---

**本方案未获明确许可前不写任何生产代码。**
