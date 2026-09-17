# 教师课件 PPT v2：多素材输入（teacher_tutor_media_extract + pptx 嵌入）实施方案

- **日期**：2026-09-17
- **设计基线**：`docs/superpowers/specs/2026-09-17-ltutor-pptx-v2-design.md`（main=89cdd5a）——max 设计评审 3C/4I/4M 全并入 + 闭环复查 R1/N3 勘误后**干净 Yes**；D1-D9 裁定与 §五-§十一 为本计划的规范来源，冲突时以设计文档为准
- **路线**：新增第 15 个 teacher_tutor 工具 `teacher_tutor_media_extract`（服务端 spawn ffmpeg/whisper-cli）+ `teacher_tutor_pptx` v2 扩展（图片页/封面音频嵌入 + zip 后处理）+ SKILL/flow v2 重写
- **复用**：v1 pptx.ts 全套纪律（caps/sha1/严格清单断言/路径剥除）、transcriber 四个纯函数（幻觉过滤）、vision_analyze 代理视觉、MEDIA 投递链（零网关改动，评审已证 auto-append 按工具名门控）
- **状态**：实施计划待评审；评审通过后 SDD 分支开发（v1 惯例）

## 一、SDD 任务分解

| # | 任务 | 内容 | 主要落点 |
|---|------|------|---------|
| Task 1 | 依赖 + 提取引擎 | jszip devDep→dep；`media-extract.ts`（二进制探测/允许根/分段管线/保留策略/互斥）+ 单测 | mcp-server/src/media-extract.ts + test |
| Task 2 | pptx v2 渲染扩展 | image/audio_path 字段、addImage/addMedia、zip 后处理（只改 slide XML）、媒体 sha1 进规范形 + 测试（含变异证真） | pptx.ts + test |
| Task 3 | 注册与反转 | `teacher_tutor_media_extract` 注册（17 号工具面）；pptx description 边界反转 + schema 字段说明；计数三处钉 16→17 + handler 测试 | training.ts + 三个 test |
| Task 4 | SKILL/flow v2 | description/快速路径/白名单 18→19/§12 桩；flow-pptx.md v2 重写（输入矩阵+busy 话术） | SKILL.md + flow-pptx.md |
| Task 5 | 部署 | build → 网关重启（避周日窗+查在飞）→ SKILL 双份 cp + md5 → 握手验 17 → config 注释 16→17 | 运维 |
| Task 6 | 真发验收 | 五场景矩阵（含⑤提取中补发图片）——用户手动 | 企微 |

## 二、Task 1：media-extract.ts（~400 行）

### 1. 依赖与二进制解析

- `jszip` 从 devDependencies **升 dependencies**（评审 I-5，Task 2 运行时用；此处先动 package.json）。
- 二进制探测：`ffmpeg`/`ffprobe`/`whisper-cli` 各配候选路径表（`/opt/homebrew/bin`、`/usr/local/bin`、`/usr/bin`、PATH 解析）+ env 覆盖 `LTUTOR_MEDIA__FFMPEG/FFPROBE/WHISPER_CLI`（评审 M-10 三名齐全）；缺件返回友好文案（graphviz ENOENT 先例），**不进熔断器**。
- 模型路径：`LTUTOR_MEDIA__WHISPER_MODEL` 缺省 = mcp-server 目录向上一级 `tools/transcriber/models/ggml-large-v3-turbo.bin`（import.meta.url 相对解析）。**唯一模型即 turbo**（设计 §三-1：~/.cache/whisper 是 Python .pt，勿读）。

### 2. 入参与安全

- schema：`{ wecom_userid（标准可选首参）, media_path（必填 string）, want（enum auto/transcript_only，缺省 auto）}`，顶层 `additionalProperties:false`。
- **允许根校验（D6）**：`path.resolve` 后必须以 `~/.hermes/cache/` 前缀（覆盖 images/documents/audio/video 入站缓存与自家 ltutor-media）；`..`/符号链接 resolve 后仍须在根内；越界 → PptxFormatError 同型 `MediaPathError` → ToolArgumentError。execFile 全程 argv 数组无 shell。
- **sha12 = 源媒体字节 sha1 前 12**（流式哈希；评审 M-11 钉死）。

### 3. 分段管线（评审 C1+N2 权威表，段级共享 deadline）

| 段 | 段预算（共享 deadline，非每调用各给） | 步骤 |
|----|------------|------|
| probe | 20s | ffprobe 时长/流；>900s（`MEDIA_MAX_DURATION_S`）→ 文本引导截片段/入库 |
| ffmpeg 组 | 60s（**组内 2-3 个 execFile 共享此 deadline**——剩余预算作各调用 timeout） | 16k mono wav（transcriber `audioArgs("extract")` 同参）→ whisper 用毕**即删 wav**；mp3（libmp3lame -qscale 4）；视频且 want=auto：contact sheet `fps=1/<interval>,scale=480:-1,tile=3x3` 单帧 jpg |
| whisper | 200s | `whisper-cli -m <model> -f <wav> -l auto -mc 0 -oj -of <out>`（`whisperArgs` 同参）→ `parseWhisperJson` strip 幻觉 |
| **和** | **280s ≤ 300s** | |

- interval = max(5, duration/9) **无上限**（15min→100s，0-900s 全覆盖；回归钉用例，评审 I-6）。
- 幻觉过滤：**只拷 transcriber whisper.ts 四个纯函数**（`HALLUCINATION_TOKENS`/`stripHallucinationSegments`/`parseWhisperJson` 核心/段裁剪）+ 出处注释；**`runDegenerationGate` 非纯勿拷**（env 口子+console.warn 副作用，设计评审 §三-2）。一致性四用例防拷贝走样。

### 4. 保留策略（D7 三重防线）与互斥（D9）

- wav whisper 后即删（28MB 大头）；**提取入口自清扫** `~/.hermes/cache/ltutor-media/` 下 >7 天的 `<sha12>` 目录；**总量帽 1GB** 超帽按 mtime LRU 淘汰（网关清扫名单不含 ltutor-*，run.py:4515 实证，不能依赖）。
- 进程内互斥（单 training 进程拓扑已证）：**在跑即返回「正在处理另一位老师的素材，请稍后再试」正常文本**（不入队不等待，isError=false 不进熔断器）。

### 5. 返回形态（路径呈现显式规则，评审压力点 5）

- 成功：`{ ok, kind, duration_s, sheet_path?, transcript:[{start_s,end_s,text}], audio_mp3_path?, transcript_truncated? }`——**成功载荷保留绝对路径**（agent 后续 vision_analyze/pptx 嵌入要消费）；段数 >400 截断并置 `transcript_truncated:true`。
- 失败：`{ ok:false, error }`——**错误文案剥绝对路径**（v1 正则含 /var/folders+/private）。
- **不发 MEDIA: 行、不进 Hermes 白名单**（评审已证 auto-append 按工具名门控，双保险）。

## 三、Task 2：pptx.ts v2 扩展（~150 行增量）

### 1. schema 增量（向后兼容，全可选）

- 顶层 `audio_path`（mp3 ≤6MB，允许根内）；`slides[].image`（jpg/png ≤5MB，允许根内；有 image 的页 bullets ≥1 即可）。
- caps 增量：image 页 ≤4；**嵌入总量（image 字节和+audio 字节）≤8MB**；路径允许根同 Task 1（覆盖 ltutor-media 产物与教师图片缓存）。超限 → 文本引导（不进熔断器，先例不变）。

### 2. 渲染增量

- `addImage({ path, sizing:{type:"contain", w, h} })` 整幅页（内容区 letterbox）。
- 封面 `addMedia({ type:"audio", path })`；**zip 后处理（jszip，已升 dep）**：writeFile 后重开 zip，把 slide XML 中 `<a:videoFile r:link>` 改 `<a:audioFile r:link>`——**rels 不动**（pptxgenjs 对 type:'audio' 的 rels 本就正确，设计评审 M-9）；v2 无视频嵌入，全量替换安全。后处理固化在 renderPptx 内部。
- 渲染后实测产物 size：<20MB 硬断言（嵌入预算 8MB 下正常 ≤10MB，此为兜底）。

### 3. 幂等口径（D8）

- canonicalJson 增 `audio_sha1` 与每页 `image_sha1`（**文件内容 sha1**，非路径）——doc-cache uuid 漂移不破坏文件名幂等；测试钉「同内容不同路径 → 同文件名」。
- 成功文案：`课件已生成（N 页，含封面[，含 X 张配图][，含音频]）。`——嵌入状态如实呈现，无引擎字样。

## 四、Task 3：training.ts 注册与反转

1. **`teacher_tutor_media_extract` 定义 + handler**（第 15 个 teacher_tutor 工具，工具面 16→17）：身份注入首行；path/时长超帽/互斥忙 → 正常文本；`deps.mediaExtract` 注入点（同 renderPptx 形态）；成功返回无 MEDIA 行。
2. **pptx description 边界反转（评审 I4，不改则 SKILL 与工具面精神分裂）**：training.ts:642 现硬编码「视频/音频转课件当前暂不支持…礼貌说明」→ 改支持口径（≤15 分钟；超帽引导截片段/入库）；schema description 补 `image`/`audio_path` 字段说明与体积帽。
3. **计数三处钉 16→17**：training.ts 头注、`identity.test.ts`（16/14→17/15）、`training.test.ts:653` 注册表（+extract）——评审 I-7 点名「最易漏项」。
4. handler 测试：身份注入/超帽引导不调管线/互斥忙返回/二进制缺失透传/成功无 MEDIA 行（fake 注入，同 v1 套路）。

## 五、Task 4：SKILL.md + flow-pptx.md v2

- **SKILL.md**：description 补「视频/音频素材转课件（自动提取内容）」；快速路径行改「把这个视频/音频做成课件」→ 流程 10（骨架：`media_extract` 提取 → `vision_analyze` 读帧 sheet → `teacher_tutor_pptx` 出片 → MEDIA 回显）；§2 白名单 18→19 + extract 行（参数形状+「提取中勿补发素材」提示）；§12 桩不变（流程 10 指针已是）。
- **flow-pptx.md v2 重写**：四锚头保留；正文=输入矩阵（视频/音频→先 extract；图片→vision_analyze 直读；文本→直构；库内→search/read_file v1 路）→ 提取启动回复话术含「**素材处理约 1-2 分钟，期间请勿再发图片/视频（会中断处理）**」（C3）→ 帧读（vision_analyze 读 sheet 单次调用）→ 构造（image/audio 嵌入指引：音频嵌封面可选）→ MEDIA 回显 → 失败回退（环境性勿重试刷屏，文字版大纲兜底）。**边界话术**：>15 分钟或 >20MB 引导截片段或入库（库内素材走 v1 转写页路）。
- **N1 精确表述吸收**：flow/SKILL 中关于 busy 的表述只承诺「媒体类补发会中断处理」（承重结论），不展开纯文本排队语义。
- 双份 cp 部署留 Task 5（重启先于 cp，v1 I-4 次序不变）。

## 六、Task 5-6：部署与验收

1. 部署序（v1 定例）：`npm --prefix mcp-server test` 全绿 → `npm run mcp:build` → 网关重启（bootout 完全退出再 bootstrap；**避周日 19:00-20:00 窗**、重启前查在飞教师回合）→ SKILL.md+flow-pptx.md 双份 cp + md5 → stdio 握手验**17 工具**（15 teacher_tutor + 2 llm_wiki）；部署窗顺手更正 profile config 注释 16→17。
2. **真发验收五场景**（用户手动，设计 §九-3）：①≤3 分钟视频→两步工具调用+帧内容进页；②语音→转写驱动；③2-3 张教材照片→图片页；④视频课件+音频嵌封面→PowerPoint 点喇叭可播；⑤**提取运行中补发一张图片→验证 interrupt 实际体验与勿补发话术**。
3. 回滚：git revert 两仓（Hermes 本批零改动，实际仅 llm_wiki）后随常规部署；禁止只回写 live 副本（CLAUDE.md 约束 5）。

## 七、测试总表（mcp-server node --test）

- **media-extract 单测**：interval 自适应（含 15min 全覆盖回归钉）/允许根（越界、`..`、符号链接）/args 构造/保留策略（自清扫+LRU，注入 mtime）/sha12/段级 deadline 分配纯函数。
- **幻觉过滤拷贝件**：与 transcriber 源一致性四用例。
- **pptx v2**：schema/caps（image 页 4 帽、8MB 总量、体积帽）/媒体 sha1 幂等（同内容异路径同文件名）/真渲染嵌入夹具音频→zip 断言 `<a:audioFile>` 形态 + **rels 不动对偶断言** + 图片页 `<a:blip>`/**变异证真：去 zip 后处理 → audioFile 断言必红**。
- **真冒烟（skip-if-missing）**：lavfi testsrc+**sine** 3 秒视频全管线 → sheet 完好、transcript 结构存在（**sine 非语音允许空，勿断言非空**）、mp3 头合法；`whisper-cli` 或模型缺失 → `t.skip`（CI ubuntu runner 无二者；先例 worksheet.test.ts:303 + transcriber describe.skipIf）。
- **handler**：extract 四用例 + pptx 嵌入路径用例；**计数钉 16→17 三处同步**。
- 全绿基线：v1 收官 199 → 本批预计 +35-45 用例。

## 八、风险与预案（设计 §十 全量继承，两处计划级增量）

| 风险 | 预案 |
|------|------|
| 时延预算被段内多调用吃穿 | N2 段级共享 deadline 已钉设计；测试含 deadline 分配纯函数用例 |
| interrupt 打断在飞提取 | flow 勿补发话术 + 场景⑤验收；per-server `mcp_servers.llm-wiki-training.timeout` / `busy_input_mode: queue` 为记档备选（不依赖） |
| ltutor-media 增长 | D7 三重防线（wav 即删/7 天自清扫/1GB LRU） |
| turbo 转写质量 | 幻觉过滤；large-v3=后续可选（立项落 ggml 模型后再切，届时重排分段预算——设计 §十 已改口径） |
| 嵌入后超投递上限 | 8MB 嵌入预算 + 渲染后 <20MB 硬断言 + 超帽拒嵌降级纯文本课件 |
| CI 缺 whisper-cli/模型 | skip-if-missing 守卫（双先例） |
| 幻觉过滤拷贝走样 | 一致性四用例 + 不拷非纯函数 |

## 九、工作量与边界

- 预估：media-extract.ts ~400 行 + pptx.ts 增量 ~150 行 + training.ts ~100 行 + 测试 ~500 行 + SKILL/flow 重写——**1.5-2 个执行会话**（v1 单会话基准 + 提取管线与真冒烟夹具增量）。
- 明确不做（设计 §十一 全量继承）：视频本体嵌 pptx、>15 分钟素材、异步任务队列、extract 产物供 worksheet/mindmap 复用、VAD；**Hermes 仓本批零改动**（白名单不动、无网关改动）。
