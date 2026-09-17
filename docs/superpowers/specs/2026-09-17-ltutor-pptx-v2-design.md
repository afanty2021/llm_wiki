# lt-tutor 课件 PPT v2：多素材输入（视频/音频/图片/文本）设计

- **日期**：2026-09-17
- **状态**：max 评审已收口——**With fixes（3C/4I/4M）全部并入本体**（报告 `.superpowers/ltutor-pptx-v2-design-review-2026-09-17/report.md`），可出实施计划
- **参照**：zcode 会话 sess_a2d5cc10-7ec2-46af-84f0-a2f171daf12a（中秋视频→双语课件——ffmpeg 抽帧/切音频 + whisper 转写 + pptxgenjs 出片 + 音频 zip 后处理嵌入的完整实证链，本设计的工程原型）
- **v1 终态**：feat/ltutor-pptx-tool 四提交（6c2c682 末笔）+ Hermes 26692c43b9，两轮评审收口，live 16 工具；取材仅库内检索 + 图片 vision_analyze，**音视频输入被边界话术明确拒绝**（flow-pptx.md v1 钉死）——v2 把这扇门打开
- **复用**：tools/transcriber 的 whisper.cpp 管线原语（audioArgs/whisperArgs/parseWhisperJson+幻觉过滤，纯函数）、v1 pptx.ts 全套纪律（caps/sha1/清单断言）、vision_analyze 代理视觉、MEDIA 投递链

## 一、v2 语义（一句话）

教师把**视频/音频/图片/文本**素材直接发给 lt-tutor（或指名库内素材）→ 助手提取内容（帧画面 + 转写文本）→ 构造课件 → 出片投递；支持把**素材本身嵌进课件**（图片页、封面音频播放器）。

## 二、素材输入矩阵

| 输入 | 来源 | 内容提取路径 | 素材嵌入 |
|------|------|-------------|---------|
| 视频 | 教师上传（视频消息压缩后常 ≤10MB 级 / **文件消息可达 20MB**，§三-4） | **v2 新增**：ffmpeg 抽帧拼 contact sheet + 音轨 whisper 转写 | 帧图可作图片页；音频可嵌封面；**视频本体不嵌**（体积红线，§十一） |
| 音频 | 教师上传（voice ≤2MB / file ≤20MB） | **v2 新增**：ffmpeg 转 16k wav + whisper 转写 | 音频可嵌封面 |
| 图片 | 教师上传 / 库内 | v1 既有：vision_analyze（整页密集图 region 分块先例） | 可作图片页 |
| 文本 | 教师口述/粘贴 | v1 既有：直接构造 | — |
| 库内素材 | 检索 | v1 既有：search/read_file（视频走带 `[mm:ss]` 锚点的转写页） | — |

## 三、基建事实核查（2026-09-17 逐条实证）

1. **whisper.cpp 在位且快**：`/opt/homebrew/bin/whisper-cli`（Metal 加速，M 系芯片）；transcriber 模型 `tools/transcriber/models/ggml-large-v3-turbo.bin`（~1.6GB）+ silero VAD 同目录。库管线实测 **15.9x 实时**——15 分钟音频转写约 60s。`-l auto` 自动检测语言（参照会话教训已固化：**勿强制 --language**）。**⚠ 模型口径（评审 C1 追正）**：`~/.cache/whisper` 下的 base/medium/large-v3 是 **Python whisper 的 .pt 权重，whisper.cpp 用不了**；全盘唯一 ggml 模型就是 turbo——v2 只按 turbo 设计，large-v3 回退**降级为后续可选**（需先落 ~3GB ggml-large-v3.bin，等真有 turbo 质量事故再立项，D3）。
2. **幻觉过滤有成熟纯函数**：transcriber whisper.ts 的 `HALLUCINATION_TOKENS` + `stripHallucinationSegments`（字幕组署名/BGM 水印垃圾段零误杀过滤）+ 窗级退化守门——库内 552 页战役验证过，纯函数可直接拷贝复用。
3. **入站媒体通道现成**：WeCom 适配器把教师发的视频/音频/文件缓存为本地文件（`doc_{uuid12}_{原名}` 落 `~/.hermes/cache/` 系目录），agent 消息上下文带注记行 `[video 'xxx.mp4' saved at: /path]`——v1 流程 6 的图片路径就是这么被 vision_analyze 消费的。**缓存 24h 过期清理**（cleanup max_age_hours=24）——中间产物不得跨会话引用。
4. **入站/出站限额是两套（09-17 追正，勿混淆）**：media.py:29-33 的类型限额表（image 10MB / video 10MB / voice 2MB / file 20MB）镜像企微 API 临时素材经典限额，**只作用于出站**——超类型限额不拒发、自动降级为文件消息，绝对帽 20MB（协议硬顶）。**入站下载帽 = `_inbound_max_bytes` 默认 20MB**（adapter.py:138，`ABSOLUTE_MAX_BYTES`，config `inbound_max_bytes` 旋钮可调，zops patch 0003）；教师侧大视频不受 10MB 约束（企微手机端压缩视频消息常 ≤10MB 级，但**以文件消息发送可到几十 MB**，PC 端文件上限 GB 级）。v2 素材体积预算按 20MB 入站帽计（压缩视频约 3-10 分钟），flow 话术引导「大视频用文件形式发送」。
   **素材大小 ≠ 信息量（09-17 追补，参照会话 272MB 素材对照）**：参照会话的 272MB 原片 = 132 秒 @17.2Mbps 4K 级竖屏（zcode 直读本地文件系统，无通道约束）；**同一内容以视频消息形态发企微会被客户端压缩到 ~10-20MB（132s @0.5-1Mbps），照样过 20MB 入站帽**——提取管线吃的是内容（音轨+画面文字）不吃码率，压缩对课件素材近乎无损。故 v2 的真实约束是**时长（15min whisper 预算）而非体积**；>20MB 的原文件（文件消息不压缩）或 >15min 长素材走入库路（transcriber→带 [mm:ss] 锚点转写页→v1 库内取材），那条链路已存在且是 16,004 页语料的既成管线。
5. **MCP 工具超时 300s**（mcp_tool_common.py:41 `_DEFAULT_TOOL_TIMEOUT = 300`）——同步单调用预算硬顶；时延预算表见 §五-3。
6. **pptxgenjs 嵌入 API 在位**：`addImage(options)`（types:2637）、`addMedia(options)`（types:2643）。**已知坑**（评审 dist 源码逐行坐实）：音频经 addMedia 在 slide XML 无条件写 `<a:videoFile r:link>`（pptxgen.cjs.js:5605/5623）——需 zip 后处理改 `<a:audioFile r:link>`；**但 rels 一半是好的**（:5761-5767 对 type:'audio' 已正确写 audio/media 双 rel）——**后处理只改 slide XML，rels 无需重写**。固化进 renderPptx 内部而非外挂脚本。
7. **PATH 风险**：网关 launchd 环境的 PATH 未必含 `/opt/homebrew/bin`（node 能解析说明部分在位，但不可依赖）——二进制备探测解析（候选路径表 + 环境变量覆盖），缺件透传友好文案（graphviz ENOENT 文案先例）。

## 四、架构裁定（D1-D9）

- **D1 提取在 MCP 服务端**：新增 `teacher_tutor_media_extract`，服务端 spawn `ffmpeg`/`whisper-cli`（execFile argv 数组，无 shell）。维持「agent 无 shell」红线——参照会话的 agentic 二进制操作全部下沉为工具内部确定性步骤。
- **D2 帧读走 contact sheet**：ffmpeg 单命令把 N 帧拼一张 3×3 网格图（`fps=1/<interval>,scale=480:-1,tile=3x3`），agent 用 **vision_analyze 一次调用**读整张——替代逐帧 N 次调用（参照会话 13 帧逐读的 agentic 形态在 Hermes 侧不成立）。interval = duration/9，**下限 clamp 5s、无上限**（评审 I-6：60s 上限会让 15min 视频后 6 分钟无帧——恰是课件视频常态；15min → 100s 间隔，0-900s 全覆盖）。
- **D3 转写用 whisper.cpp turbo + `-l auto`**：15.9x 实时 + 自动语言检测 + transcriber 幻觉过滤原语。**唯一可用模型即 turbo**（评审 C1）；large-v3 回退=后续可选注记（§三-1），不进 v2 预算。
- **D4 同步单调用，不做任务队列**：预算 ≤280s ≤300s MCP 硬顶（分段表见 §五-3）。**busy 行为按现配置如实陈述（评审 C3 追正）**：主 config `busy_input_mode: interrupt`（:243）——文本类后续消息排队，**媒体类后续消息（教师提取中补发一张照片）会 abort 在飞工具调用**（run_busy.py:731 `_interrupt_running_agent_for_busy_event`），90s 提取被打断重来。缓解=flow 话术「提取期间请稍候，勿补发素材」（§七）+ 验收场景⑤（§九）；备选杠杆（记档不依赖）：`mcp_servers.llm-wiki-training.timeout` per-server 覆盖、或全局 `busy_input_mode: queue`（行为面大，非 v2 前提）。
- **D5 音频嵌入=封面播放器 + zip 后处理固化**：mp3 ≤6MB 才嵌（20MB 投递上限留余量），后处理进 renderPptx 内部。视频本体不嵌。
- **D6 路径安全=允许根校验**：入参路径 resolve 后必须落在 `~/.hermes/cache/` 下（入站缓存与自家产物统一根），拒绝其他一切路径；execFile argv 无 shell 注入面。
- **D7 中间产物自包含 + 保留策略（评审 C2 补）**：提取产物落 `~/.hermes/cache/ltutor-media/<sha12>/`（帧 sheet、mp3、transcript.json；**sha12 = 源媒体字节 sha1 前 12**，评审 M-11）；pptx 渲染时把被嵌媒体**拷贝进渲染流程**（哈希进规范形），不跨会话引用 doc-cache 路径（24h 清理红线）。**磁盘卫生（网关小时清扫只清 9 个具名目录、ltutor-* 不在内——run.py:4515 实证，不能依赖它）**：①wav 是 28MB/次 的大头——**whisper 完成即删**；②提取入口自清扫 >7 天的 `<sha12>` 目录；③目录总量帽 1GB、超帽按 mtime LRU 淘汰。三重防线把 v2 的 30-50MB/次量级压回有界。
- **D8 媒体哈希进规范形**：slides 引用的 image/audio 在 canonicalJson 里以**内容 sha1** 计（同内容不同 uuid 缓存路径 → 同文件名幂等；doc-cache uuid 漂移不破坏幂等）。
- **D9 并发串行、排队深度=1（评审 C1 修正）**：进程内互斥锁串行化提取（whisper turbo 内存 ~1-2GB + 单 training 进程拓扑实证唯一）；**在跑即返回「稍后再试」文本，不入队不等待**——排队等待会击穿 300s 硬顶（第二人排队 + 280s 预算 = 必超时）。

## 五、新工具 `teacher_tutor_media_extract`（第 15 个 teacher_tutor 工具）

### 1. 入参 schema（v1 纪律沿用：additionalProperties:false、wecom_userid 标准可选首参）

```jsonc
{
  "wecom_userid": "（标准可选首参）",
  "media_path": "string（必填）——入站消息注记行里的本地缓存路径（[video '…' saved at: …]）",
  "want": { "enum": ["auto", "transcript_only"], "description": "缺省 auto：视频=帧sheet+转写、音频=转写；transcript_only 跳过抽帧" }
}
```

### 2. 管线（服务端，四段全确定性）

1. **探测**：ffprobe 时长/流；>15 分钟（`MEDIA_MAX_DURATION_S`）→ 正常文本引导（"素材较长，请截取片段或先入库"）。
2. **音频路**：ffmpeg 提 16kHz mono wav（transcriber `audioArgs("extract")` 同参数）→ whisper-cli `-oj -l auto` turbo → `parseWhisperJson`（strip 幻觉）→ segments；同时出 mp3（libmp3lame -qscale:a 4，参照会话参数）；**wav 用毕即删**（D7）。
3. **帧路**（视频且 want=auto）：ffmpeg `fps=1/<interval>,scale=480:-1,tile=3x3` 单帧出 contact sheet jpg（≤9 帧预算，interval 见 D2）。
4. **返回**：`{ ok, kind, duration_s, sheet_path?, transcript: [{start_s, end_s, text}], audio_mp3_path?, transcript_truncated?, error? }`——**不发 MEDIA: 行**（中间产物不给教师投递，路径仅供 agent 后续消费；路径呈现规则=**错误文案剥路径、成功载荷保留路径**，评审压力点 5 钉成显式规则）。

### 3. caps 与分段超时（评审 C1 重排——单一权威表）

| 段 | 超时（=该段 execFile 上限） | 最坏耗时（15min 素材） |
|----|------------|------|
| ffprobe 探测 | 20s | ~2s |
| ffmpeg 音频提取 + mp3 + sheet | 60s | ~25s |
| whisper-cli 转写 | 200s | ~60s（15.9x） |
| **分段和** | **280s** | **~90s** |

- 280s ≤ 300s MCP 硬顶，留 20s 给 Node 开销/磁盘/返回序列化；**每段超时即该段预算值**（不再有「统一 240s」的二义表述）。
- transcript 段数 ≤400，截断时返回 `transcript_truncated: true` 标记（评审 M-11）。
- 总预算表（15min 最坏输入）：上表最坏和 ~90s，对 300s 硬顶余量 3x+；D9 在跑即拒，**不存在排队击穿**。

### 4. 失败面

- 二进制缺失/路径越界/格式不支持 → `{ok:false, error:友好文案}`（不进熔断器，同 worksheet 先例——环境性输入问题）；绝对路径剥除（v1 修复波已含 /var/folders+/private）。
- 无音轨视频（纯画面）→ 正常返回，transcript 为空数组 + sheet 在；反之纯音频无帧路。

## 六、`teacher_tutor_pptx` v2 扩展

### 1. schema 增量（向后兼容，全可选）

```jsonc
{
  ...v1 全保留...,
  "audio_path": "string（可选）——嵌封面音频播放器（mp3 ≤6MB，路径须在允许根内）",
  "slides": [ { ...v1 字段...,
    "image": "string（可选）——本页整幅配图（jpg/png ≤5MB，允许根内路径；有 image 的页 bullets 可为 1 条）" } ]
}
```

### 2. caps 增量

- `image` 页 ≤4 页；`audio_path` 仅封面一处；图片字节 ≤5MB/张、音频 ≤6MB；**嵌入总量 ≤8MB**（投递 20MB 红线留 12MB 余量给文本与 pptx 结构开销）。

### 3. 渲染增量

- `addImage({ path })` 整幅页（16:9 内 letterbox 适配）；封面 `addMedia({ type:"audio", path })` 后接 **zip 后处理**（jszip 只改 slide XML 的 `<a:videoFile>` → `<a:audioFile r:link>`；**rels 无需重写**——pptxgenjs 对 type:'audio' 的 rels 本就正确，评审 M-9）。**jszip 从 devDependencies 升 dependencies**（评审 I-5：renderPptx 运行时要用，v1「测试设施显式化」的 v2 对偶面）。
- canonicalJson 增 `audio_sha1` / 每页 `image_sha1`（D8）；清单断言扩展：嵌入页断言 `<a:blip>` 引用存在、audio 页断言 `<a:audioFile>` 形态（**不是** videoFile——把 v1 评审学到的「形态断言」用在新坑上）。

## 七、SKILL / flow 改动

- **SKILL.md**：description 补「音视频素材转课件」；快速路径行改触发词（"把这个视频/音频做成课件"）；白名单 18→19 加 extract 行；§12 桩更新指针。
- **training.ts pptx 工具 description 边界反转（评审 I4，不修则 SKILL 与工具面精神分裂）**：删「老师发来视频/音频文件要求转课件、或要求 PPT 内嵌音频时：当前暂不支持」硬编码，改为支持口径（≤15 分钟、超帽引导截片段/入库）；schema description 同步补 `image`/`audio_path` 字段说明。
- **flow 话术补 busy 提示（评审 C3）**：提取启动回复中告知「素材处理中约 1-2 分钟，期间请勿再发图片/视频（会中断处理）」。
- **flow-pptx.md v2 重写**：输入矩阵表（§二）→ 取材分四路（库内 v1 路 / 图片 v1 路 / **音视频=先 extract 后构造** / 文本直构）→ 构造（含 image/audio 嵌入话术：音频嵌封面、可关）→ MEDIA 回显 → 失败回退。**v1 边界话术反转**：音视频直转从「礼貌拒绝」改为「支持（≤15 分钟），超帽引导截片段或入库」。
- Hermes `_AUTO_APPEND_MEDIA_TOOL_NAMES`：extract 工具**不进白名单**（不发 MEDIA: 行）；pptx 已在。

## 八、测试策略（mcp-server node --test）

- 纯函数：audioArgs/whisperArgs/interval 自适应（含 15min 无帧覆盖缺口回归钉）/允许根校验（越界拒、`..` 拒、符号链接 resolve 后仍须在根内）；
- 幻觉过滤拷贝件与 transcriber 源行为一致性四用例（防拷贝走样；**`runDegenerationGate` 非纯函数勿拷**——有 `TRANSCRIBER_GATE_ALLOW` env 口子+console.warn 副作用，评审 §三-2，只拷四个纯函数）；
- handler：身份注入、超帽引导、二进制缺失透传、成功返回无 MEDIA 行、D9 在跑即拒；
- **真冒烟（测试内自产夹具，评审 I-7 三修）**：ffmpeg lavfi 合成 3 秒测试视频（testsrc+**sine**）→ 全管线真跑 → 断言 **sheet 存在/jpg 完好、transcript 字段结构存在（sine 非语音，segments 允许为空——不断言「转写非空」防 flaky）**、mp3 头合法；**skip-if-missing 守卫**：whisper-cli 或模型缺失则 `t.skip`（CI ubuntu runner 无二者；双先例=worksheet.test.ts:303 无 Chrome skip + transcriber describe.skipIf）；
- pptx 嵌入夹具音频 → zip 断言 `<a:audioFile>` 形态 + **rels 不动**（评审 M-9 对偶断言）+ 嵌入页 `<a:blip>`；
- **training.test.ts:653 计数钉 16→17 同步更新**（评审 I-7，最易漏项）；
- 变异证真（v1 修复波纪律）：去掉 zip 后处理 → audioFile 断言必须红。

## 九、部署与验收

1. 部署序沿 v1：mcp-server build → Hermes（若有改动）→ 网关重启（避周日 19:00-20:00 窗，查在飞）→ SKILL/flow 双份 cp + md5；
2. 工具面 16→17（SKILL 白名单 18→19），握手逐名验证；
3. **真发验收矩阵**（用户手动，五场景）：①发一段 ≤3 分钟视频「做成课件」→ 两步工具调用 + 文件到达 + 帧内容进页；②发一段语音 → 转写驱动课件；③发 2-3 张教材照片 → 图片页课件；④复现参照会话形态——视频课件 + 音频嵌封面，下载后 PowerPoint 点封面喇叭可播；**⑤提取运行中教师补发一张图片（评审 C3）→ 验证 interrupt 行为与「勿补发」话术的实际体验**。

## 十、风险与预案

| 风险 | 预案 |
|------|------|
| whisper 幻觉污染课件内容 | transcriber 过滤原语 + `-l auto`；turbo 质量不足时立项落 ggml-large-v3.bin 后再切换（后续可选，§三-1；届时需重排分段预算） |
| 竖屏视频 contact sheet 可读性 | scale=480 宽度下 3×3 竖屏 tile 可读（9:16 帧高 ~853px）；真发目检不达 → 改 2×2 四帧 |
| 嵌入后 pptx 超 20MB 投递上限 | 嵌入总量帽 8MB + 渲染后实测文件 size 断言超帽即拒嵌并降级出纯文本课件 + 提示 |
| 网关 PATH 缺 /opt/homebrew/bin | 启动探测候选表 + `LTUTOR_MEDIA__FFMPEG/FFPROBE/WHISPER_CLI` env 覆盖（评审 M-10 补 FFPROBE）；缺件友好文案 |
| 双教师并发提取内存压力 | D9 进程内串行 + 排队深度=1（在跑即拒，评审 C1） |
| doc-cache 24h 清理 vs 教师隔天追问 | 课件已自包含（D7）；隔天重做=重发素材，flow 话术说明 |
| ltutor-media 无限增长 | D7 三重防线：wav 即删 + 入口 7 天自清扫 + 1GB LRU（网关清扫名单不含 ltutor-*，评审 C2 实证） |
| 提取中教师补发素材打断处理 | 现配置 interrupt 行为如实陈述（D4）+ flow 勿补发话术 + 场景⑤验收；备选杠杆=per-server timeout / busy_input_mode: queue（记档不依赖） |
| 音频 zip 后处理坑复发 | 固化 renderPptx 内部 + audioFile 形态断言 + 变异证真（§八） |

## 十一、明确不做（v2 边界）

- **视频本体嵌 pptx**（体积/兼容双红线，参照会话也只嵌了音频）；
- >15 分钟长素材（引导截片段或走入库摄取管线——那是 transcriber 的领地，不与之耦合）；
- 异步任务队列/任务 id 轮询（300s 预算内同步收口；真出现常态超时再立项）；
- extract 产物入知识库/供 worksheet、mindmap 复用（先聚焦课件；工具返回形状天然可复用，后续一纸流程改动即可）；
- VAD 切分（教师短片段用不上；silero 模型在位备选）。

## 十二、工作量预估

- mcp-server：media-extract.ts（~350-450 行，含拷贝原语）+ pptx.ts 扩展（~150 行）+ handler/注册（~80 行）+ 测试（~450 行，含真冒烟夹具）；
- SKILL/flow 重写（~1 小时）；Hermes 零改动（白名单不动）；
- 预计 1.5-2 个执行会话（v1 一个会话收口的基准上，提取管线 + 真冒烟夹具增量）。
