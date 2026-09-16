# lt-tutor 课件 PPT v2：多素材输入（视频/音频/图片/文本）设计

- **日期**：2026-09-17
- **状态**：设计草案待评审（评审通过后出实施计划，走 plans/）
- **参照**：zcode 会话 sess_a2d5cc10-7ec2-46af-84f0-a2f171daf12a（中秋视频→双语课件——ffmpeg 抽帧/切音频 + whisper 转写 + pptxgenjs 出片 + 音频 zip 后处理嵌入的完整实证链，本设计的工程原型）
- **v1 终态**：feat/ltutor-pptx-tool 四提交（6c2c682 末笔）+ Hermes 26692c43b9，两轮评审收口，live 16 工具；取材仅库内检索 + 图片 vision_analyze，**音视频输入被边界话术明确拒绝**（flow-pptx.md v1 钉死）——v2 把这扇门打开
- **复用**：tools/transcriber 的 whisper.cpp 管线原语（audioArgs/whisperArgs/parseWhisperJson+幻觉过滤，纯函数）、v1 pptx.ts 全套纪律（caps/sha1/清单断言）、vision_analyze 代理视觉、MEDIA 投递链

## 一、v2 语义（一句话）

教师把**视频/音频/图片/文本**素材直接发给 lt-tutor（或指名库内素材）→ 助手提取内容（帧画面 + 转写文本）→ 构造课件 → 出片投递；支持把**素材本身嵌进课件**（图片页、封面音频播放器）。

## 二、素材输入矩阵

| 输入 | 来源 | 内容提取路径 | 素材嵌入 |
|------|------|-------------|---------|
| 视频 | 教师上传（WeCom video ≤10MB / file ≤20MB） | **v2 新增**：ffmpeg 抽帧拼 contact sheet + 音轨 whisper 转写 | 帧图可作图片页；音频可嵌封面；**视频本体不嵌**（体积红线，§十一） |
| 音频 | 教师上传（voice ≤2MB / file ≤20MB） | **v2 新增**：ffmpeg 转 16k wav + whisper 转写 | 音频可嵌封面 |
| 图片 | 教师上传 / 库内 | v1 既有：vision_analyze（整页密集图 region 分块先例） | 可作图片页 |
| 文本 | 教师口述/粘贴 | v1 既有：直接构造 | — |
| 库内素材 | 检索 | v1 既有：search/read_file（视频走带 `[mm:ss]` 锚点的转写页） | — |

## 三、基建事实核查（2026-09-17 逐条实证）

1. **whisper.cpp 在位且快**：`/opt/homebrew/bin/whisper-cli`（Metal 加速，M 系芯片）；transcriber 模型 `tools/transcriber/models/ggml-large-v3-turbo.bin`（另有 silero VAD、~/.cache/whisper 下 base/medium/large-v3 备选）。库管线实测 **15.9x 实时**——15 分钟音频转写约 60s。`-l auto` 自动检测语言（参照会话教训已固化：**勿强制 --language**，英文旁白被强转中文的事故在案）。
2. **幻觉过滤有成熟纯函数**：transcriber whisper.ts 的 `HALLUCINATION_TOKENS` + `stripHallucinationSegments`（字幕组署名/BGM 水印垃圾段零误杀过滤）+ 窗级退化守门——库内 552 页战役验证过，纯函数可直接拷贝复用。
3. **入站媒体通道现成**：WeCom 适配器把教师发的视频/音频/文件缓存为本地文件（`doc_{uuid12}_{原名}` 落 `~/.hermes/cache/` 系目录），agent 消息上下文带注记行 `[video 'xxx.mp4' saved at: /path]`——v1 流程 6 的图片路径就是这么被 vision_analyze 消费的。**缓存 24h 过期清理**（cleanup max_age_hours=24）——中间产物不得跨会话引用。
4. **入站体积上限**：video 消息 10MB / voice 2MB / file 20MB（media.py:29-33）——直接决定素材时长帽（WeCom 压缩视频 10MB ≈ 数分钟低清）。
5. **MCP 工具超时 300s**（mcp_tool_common.py:41 `_DEFAULT_TOOL_TIMEOUT = 300`）——同步单调用预算硬顶；时延预算表见 §五-5。
6. **pptxgenjs 嵌入 API 在位**：`addImage(options)`（types:2637）、`addMedia(options)`（types:2643）。**已知坑**（参照会话实证）：音频经 addMedia 写成 `<a:videoFile>`，需 zip 后处理改 `<a:audioFile r:link>`（rels 指向 audio 类型）——每次 build 后都要重做，故必须固化进 renderPptx 内部而非外挂脚本。
7. **PATH 风险**：网关 launchd 环境的 PATH 未必含 `/opt/homebrew/bin`（node 能解析说明部分在位，但不可依赖）——二进制备探测解析（候选路径表 + 环境变量覆盖），缺件透传友好文案（graphviz ENOENT 文案先例）。

## 四、架构裁定（D1-D9）

- **D1 提取在 MCP 服务端**：新增 `teacher_tutor_media_extract`，服务端 spawn `ffmpeg`/`whisper-cli`（execFile argv 数组，无 shell）。维持「agent 无 shell」红线——参照会话的 agentic 二进制操作全部下沉为工具内部确定性步骤。
- **D2 帧读走 contact sheet**：ffmpeg 单命令把 N 帧拼一张 3×3 网格图（`fps=1/<interval>,scale=480:-1,tile=3x3`），agent 用 **vision_analyze 一次调用**读整张——替代逐帧 N 次调用（参照会话 13 帧逐读的 agentic 形态在 Hermes 侧不成立）。interval = duration/9 自适应，clamp [5s, 60s]。
- **D3 转写用 whisper.cpp turbo + `-l auto`**：15.9x 实时 + 自动语言检测 + transcriber 幻觉过滤原语。质量敏感场景可 env 切 large-v3。
- **D4 同步单调用，不做任务队列**：预算 ≤300s（§五-5），超帽输入拒绝并给引导。busy steer 已保证长工具运行期间教师可继续发消息不打断。
- **D5 音频嵌入=封面播放器 + zip 后处理固化**：mp3 ≤6MB 才嵌（20MB 投递上限留余量），后处理进 renderPptx 内部。视频本体不嵌。
- **D6 路径安全=允许根校验**：入参路径 resolve 后必须落在 `~/.hermes/cache/` 下（入站缓存与自家产物统一根），拒绝其他一切路径；execFile argv 无 shell 注入面。
- **D7 中间产物自包含**：提取产物落 `~/.hermes/cache/ltutor-media/<sha12>/`（帧 sheet、16k wav、mp3、transcript.json）；pptx 渲染时把被嵌媒体**拷贝进渲染流程**（哈希进规范形），不跨会话引用 doc-cache 路径（24h 清理红线）。
- **D8 媒体哈希进规范形**：slides 引用的 image/audio 在 canonicalJson 里以**内容 sha1** 计（同内容不同 uuid 缓存路径 → 同文件名幂等；doc-cache uuid 漂移不破坏幂等）。
- **D9 并发串行**：进程内互斥锁串行化提取（whisper turbo 内存 ~1-2GB，双教师并发提取有内存压力；排队等待计入 300s 预算，超时给「稍后再试」引导）。

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
2. **音频路**：ffmpeg 提 16kHz mono wav（transcriber `audioArgs("extract")` 同参数）→ whisper-cli `-oj -l auto` turbo → `parseWhisperJson`（strip 幻觉）→ segments；同时出 mp3（libmp3lame -qscale:a 4，参照会话参数）。
3. **帧路**（视频且 want=auto）：ffmpeg `fps=1/<interval>,scale=480:-1,tile=3x3` 单帧出 contact sheet jpg（≤9 帧预算）。
4. **返回**：`{ ok, kind, duration_s, sheet_path?, transcript: [{start_s, end_s, text}], audio_mp3_path?, error? }`——**不发 MEDIA: 行**（中间产物不给教师投递，路径仅供 agent 后续消费）。

### 3. caps 与超时

- 时长 ≤15min；transcript 段数返回前截断 ≤400 段（15min 语音约 200-300 段，正常不触）；每 execFile 包 240s 超时并 kill（ffmpeg 探测 30s / 提取 60s / whisper 240s 分段预算）。
- 总预算表（15min 最坏输入）：probe ~2s + 音频提取 ~15s + whisper ~60s + sheet ~8s ≈ **90s**，对 300s 硬顶余量 3x+；排队（D9）时返回等待引导。

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

- `addImage({ path })` 整幅页（16:9 内 letterbox 适配）；封面 `addMedia({ type:"audio", path })` 后接 **zip 后处理**（jszip 改 `<a:videoFile>` → `<a:audioFile r:link>` + rels audio 类型——参照会话实证修法，固化在 renderPptx 内部每次重做）。
- canonicalJson 增 `audio_sha1` / 每页 `image_sha1`（D8）；清单断言扩展：嵌入页断言 `<a:blip>` 引用存在、audio 页断言 `<a:audioFile>` 形态（**不是** videoFile——把 v1 评审学到的「形态断言」用在新坑上）。

## 七、SKILL / flow 改动

- **SKILL.md**：description 补「音视频素材转课件」；快速路径行改触发词（"把这个视频/音频做成课件"）；白名单 18→19 加 extract 行；§12 桩更新指针。
- **flow-pptx.md v2 重写**：输入矩阵表（§二）→ 取材分四路（库内 v1 路 / 图片 v1 路 / **音视频=先 extract 后构造** / 文本直构）→ 构造（含 image/audio 嵌入话术：音频嵌封面、可关）→ MEDIA 回显 → 失败回退。**v1 边界话术反转**：音视频直转从「礼貌拒绝」改为「支持（≤15 分钟），超帽引导截片段或入库」。
- Hermes `_AUTO_APPEND_MEDIA_TOOL_NAMES`：extract 工具**不进白名单**（不发 MEDIA: 行）；pptx 已在。

## 八、测试策略（mcp-server node --test）

- 纯函数：audioArgs/whisperArgs/interval 自适应/允许根校验（越界拒、`..` 拒、符号链接 resolve 后仍须在根内）；
- 幻觉过滤拷贝件与 transcriber 源行为一致性四用例（防拷贝走样）；
- handler：身份注入、超帽引导、二进制缺失透传、成功返回无 MEDIA 行；
- **真冒烟（测试内自产夹具）**：ffmpeg lavfi 合成 3 秒测试视频（testsrc+sine）→ 全管线真跑 → 断言 sheet 存在/jpg 完好、transcript 非空、mp3 头合法；pptx 嵌入夹具音频 → zip 断言 `<a:audioFile>` 形态 + rels + 嵌入页 `<a:blip>`；
- 变异证真（v1 修复波纪律）：去掉 zip 后处理 → audioFile 断言必须红。

## 九、部署与验收

1. 部署序沿 v1：mcp-server build → Hermes（若有改动）→ 网关重启（避周日 19:00-20:00 窗，查在飞）→ SKILL/flow 双份 cp + md5；
2. 工具面 16→17（SKILL 白名单 18→19），握手逐名验证；
3. **真发验收矩阵**（用户手动，四场景）：①发一段 ≤3 分钟视频「做成课件」→ 两步工具调用 + 文件到达 + 帧内容进页；②发一段语音 → 转写驱动课件；③发 2-3 张教材照片 → 图片页课件；④复现参照会话形态——视频课件 + 音频嵌封面，下载后 PowerPoint 点封面喇叭可播。

## 十、风险与预案

| 风险 | 预案 |
|------|------|
| whisper 幻觉污染课件内容 | transcriber 过滤原语 + `-l auto`；turbo 质量不足时 env 切 large-v3（慢 3-4x，预算仍够） |
| 竖屏视频 contact sheet 可读性 | scale=480 宽度下 3×3 竖屏 tile 可读（9:16 帧高 ~853px）；真发目检不达 → 改 2×2 四帧 |
| 嵌入后 pptx 超 20MB 投递上限 | 嵌入总量帽 8MB + 渲染后实测文件 size 断言超帽即拒嵌并降级出纯文本课件 + 提示 |
| 网关 PATH 缺 /opt/homebrew/bin | 启动探测候选表 + `LTUTOR_MEDIA__FFMPEG/WHISPER_CLI` env 覆盖；缺件友好文案 |
| 双教师并发提取内存压力 | D9 进程内串行互斥 |
| doc-cache 24h 清理 vs 教师隔天追问 | 课件已自包含（D7）；隔天重做=重发素材，flow 话术说明 |
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
