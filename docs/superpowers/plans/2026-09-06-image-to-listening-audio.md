# 实施计划：教师图片→英语听力音频（对话转写 + 双人声 TTS）

- **日期**：2026-09-06（r2 修订：评审 Approve with fixes 收口）
- **状态**：评审通过，可实施
- **评审**：`.superpowers/image-to-listening-plan-review-2026-09-06/report.md`（max 评审：C1/I1 两处方级修正 + I2-I4/M1-M4/Nit 全收口；本 r2 已逐项采纳，关键主张均经控制器一手抽验复核——C1 白名单常量、I1 缩放双触发条件、R1 rate 正则、R3 构建产物）
- **来源**：ggtms 教师 2026-09-06 18:11 实际请求「能帮我把图片里的英文对话转成英语听力音频吗？」
- **质量要求（用户原话）**：高质量的音频用于听力教学
- **前置依赖**：wecom 入站图片分类修复已上线（Hermes `a2efd297d2`，18:03 重启生效——事件实证图片已正确落 `img_a1eaabc9ff7a.jpg`/图片形态）

---

## 0. 事件实证与根因（评审已复核并补强 live 实验）

### 0.1 18:11 事件全链（日志一手在案）

| 时刻 | 事实 | 证据 |
|---|---|---|
| 18:11:08 | 教师发图+文字请求 | gateway.log inbound `user=ggtms msg='能帮我把图片里的英文对话转成英语听力音频吗？'` |
| 18:11:08 | 适配器修复生效：图片落盘 **`.jpg`**、路由为图片 | agent.log `Image routing: text (mode=text)`；文件 `~/.hermes/cache/images/img_a1eaabc9ff7a.jpg`（670.7 KiB ≈ 687KB，**844×1163 高压缩质量 JPEG**，r2 勘误：非"高分辨率"，尺寸中等、压缩质量低才是特征） |
| 18:11:08 | vision 富化正确走 zai 主通道 | `Vision auto-detect: using main provider zai-coding-cn (glm-5.3-flash)` |
| 18:13:09 | **120s 整超时**，fallback 链耗尽 | `Request timed out`（errors.log:3401-3402）；18:11:08.625→18:13:09.043 ≈ 120.4s |
| 18:13:16 | 教师收到"没看清"类回复 | enrichment 失败分支文案 |

### 0.2 payload 因果链（评审 live 实验三点闭合，r2 替换原"高分辨率"表述）

| base64 payload | 图 | zai 转写结果 |
|---|---|---|
| **916KB** | 原图 687KB/844×1163（18:11 真实事件） | **>120s 超时** |
| 727KB | sips 放大 1568px/545KB | 32.3s ✅ |
| **379KB** | **真实修复输出**（`max_base64_bytes=512KB` 同尺寸 q85 重编码） | **30.8s ✅** |

- **核心前提已验证**：glm-5.3-flash 对该教材对话图以本计划逐行转写提示词实测——成功且质量优秀（A/B 逐行、零改写、无需 ⟨?⟩ 兜底）。
- 代码定位：`tools/vision_tools.py:1570-1576` 全尺寸首发（注释自述）；缩放器 `_resize_image_for_vision`（:893）只在 >20MB（:726）或服务端报错（:750）两条被动路径触发；超时默认 120s（:1625 + config_defaults:1209）。
- **杠杆结论（评审关键实验，r2 采纳）**：缩放函数双触发条件 = `estimated_b64 > max_base64_bytes` 或 `最长边 > max_dimension`。原图 1163px<1568 且 916KB<函数默认 5MB 预算——**只传 `max_dimension=1568` 双重不触发、原样直返（实测 894KB）**；**有效杆是 `max_base64_bytes`**（实测 512KB 预算 → 同尺寸 q85 重编码 379KB，文本清晰度无损）。且 `max_dimension` 语义是上限非目标、走折半循环（2048px 输入落点 1024px，教材小字号受伤），只宜作真大图的次级帽。

### 0.3 现有设施盘点（r2 增补评审探针结论）

| 能力 | 现状 | 位置 |
|---|---|---|
| Hermes TTS 工具 | `text_to_speech` 存在；edge-tts 默认引擎；**voice 配置级、无调用级参数**；无 azure/say 后端 | `tools/tts_tool.py:211,4773-4827`；`tools/lazy_deps.py:140-142` |
| **edge-tts（评审 live 探针）** | **7.2.7 在位（恰为钉版），合成 11 词句 5.28s/31KB；原生 48kbps mono 24kHz——保留原生编码即可（升 128k 零增益、体积 2.7×）** | 本机实测 |
| agent 发媒体 | `MEDIA:<path>` 标签协议；**网关自动追加有工具名白名单门（见下行），assistant 回显通道无门但是软依赖** | `gateway/run.py:2016-2230,7367-7403` |
| **MEDIA 自动追加白名单** | **`_AUTO_APPEND_MEDIA_TOOL_NAMES` = {text_to_speech, text_to_speech_tool, image_generate}，run.py:2143 按成员门控——新 MCP 工具线名不在册则自动追加永不触发（C1）** | `gateway/run.py:2020-2024,2143`；线名格式 `mcp__<server>__<tool>`（mcp_tool.py:7493） |
| wecom 出站音频 | 语音仅收 AMR；非 AMR 自动降级**文件**发送附一句说明；文件 >20MB 拒绝；30 msg/min/chat | `plugins/platforms/wecom/adapter.py:186,2082-2144` |
| agent shell | lt-tutor 白名单 `[skills, llm-wiki-training]`，无 shell | `~/.hermes/profiles/lt-tutor/config.yaml:31-37` |
| vision 工具集 | 不在 lt-tutor 白名单 | 同上；`tools/vision_tools.py:1937-1945` |
| teacher-tutor SKILL | 109 行无图片/音频流程；仓内源=部署副本，热部署 cp | `docs/superpowers/hermes/lt-tutor/SKILL.md` |
| MCP 工具模式 | 10 工具统一 resolveIdentity + vitest；**运行物是构建产物 `dist/src/index.js`（main 字段）——改动必须 `npm run build`，否则新工具静默缺席（R3）** | `mcp-server/package.json`；`mcp-server/src/training.ts` |
| **MCP 生效时机** | **非热生效——网关启动时拉起长驻，重启才吃到新工具（I3，r2 改述）** | 网关 multiplex 机制 |
| 系统资源 | ffmpeg 在位；Ava (Premium) 高级嗓音 ×1 | 本机 |

---

## 1. 目标 / 非目标

**目标**：教师企微发对话/教材图片 → tutor 转写图内英文对话 → 教师确认 → 收到**可在企微点播的高质量 mp3**（双人声、行间留白、可再生成慢速版）。

**非目标**：不做 AMR 语音气泡（电话音质）；不接付费云 TTS（引擎可插拔留升级位）；不做长文本章节朗读（>3000 字符走分段提示）；不动 wecom 降级文案。

## 2. 架构（r2：五件套）

```
教师发图（对话页照片）
  → 网关图片富化（缩放杠杆修复后成功率↑，富化描述仅作上下文）
  → agent（glm-5.3-flash，放行 vision 工具集）
      ① vision_analyze：逐行转写提示词 → 对话原文（A/B 标注）【zai 实测质量优秀】
      ② 文本回发教师确认/纠错（防 OCR 错误进音频）
      ③ teacher_tutor_listening_audio（mcp-server 新工具）
           dialogue[] → 逐行 edge-tts 合成（A=女声/B=男声，4-6 路有界并发）
           → ffmpeg 拼接（行间 0.7s 静音，24kHz mono 对齐）→ mp3（保留原生 48kbps）
           → 返回 MEDIA:<path>
  → 音频投递双保险：
      ① 网关自动追加（白名单 +新工具线名，Hermes 一行）
      ② SKILL 硬性回显规则（最终答复必须带 MEDIA: 路径）
  → wecom 文件消息送达（点开即播）
```

## 3. 改动清单（五件套）

### 3.1 Hermes 仓：vision 大图主动缩放（前置修复，r2 换杠杆）

- **文件**：`tools/vision_tools.py`
- **改动（r2 处方）**：aux-LLM 发送前新增主动缩放闸——图片 **est-b64 >512KB 或最长边 >2048px** 时调用 `_resize_image_for_vision`：
  - **主杆：`max_base64_bytes=512KB`（闸值字节预算）**——同尺寸 JPEG 质量阶梯重编码（85/70/50），文本清晰度无损（实测 916KB→379KB、zai 30.8s 成功）；
  - **次级帽：仅当最长边 >2048px 时同时传 `max_dimension=1568`**（真照片降维可接受；注意折半循环落点 1024-1500px，教材截图 ≤2048px 时不走此杆、纯字节杆保清晰度）；
  - 既有 20MB 硬顶与服务端报错被动路径不动（防御纵深）；**顺手统一**：既有 fallback 缩放调用（:1650-1668）不带 `max_dimension` 的不一致（Nit）。
- **测试**：pytest——(a) 小图（<512KB 且 ≤2048px）不触发；(b) 687KB/1163px 高压缩 JPEG → 字节杆触发、同尺寸重编码、payload 显著下降；(c) >2048px 照片 → 次级帽生效；(d) 缩放失败不阻断（回落原路径）。
- **收益面**：网关富化与 agent 转写同享。

### 3.2 lt-tutor 配置：放行 vision 工具集（配置改动，不入仓）

- **文件**：`~/.hermes/profiles/lt-tutor/config.yaml`
- **改动**：`platform_toolsets.wecom` 增 `vision`（cron 不动）；`auxiliary.vision.timeout: 180` 保险——**r2（I4）：落点实现前确认**——config 按 HERMES_HOME 解析，profile yaml 对部分读取面不生效有先例（其自述注释），必要时写主 config `~/.hermes/config.yaml`。
- 不加 tts 工具集：TTS 由 3.3 内部完成。

### 3.3 llm_wiki 仓：mcp-server 新工具 `teacher_tutor_listening_audio`（核心件）

- **文件**：`mcp-server/src/training.ts`（+ 测试）；**改后必须 `npm run build`**（运行物 `dist/src/index.js`，不构建则新工具静默缺席——I2①）
- **接口**（同款 resolveIdentity 身份链）：
  - `wecom_userid`：可选（系统/cron 回合必填，wecom 会话勿传）
  - `dialogue`：`[{speaker: "A"|"B"|null, text}]`（null=旁白/单人）；**每行 text 长度上限（如 ≤600 字符，防怪物行）**
  - `speed`：默认 1.0；慢速 0.85
  - `title`：文件名用；**清洗：白名单 `[A-Za-z0-9\u4e00-\u9fa5_-]`、剥分隔符、≤80 字符（I2②）**
- **管线**（node child_process）：
  1. 校验：≤60 行、总文本 ≤3000 字符、行 text 非空；超限返回可读错误
  2. 逐行合成：`edge-tts --voice <voice> --rate=<rate> --text <line> --write-media <tmp>`；voice：A=`en-US-AriaNeural` / B=`en-US-GuyNeural` / null=Aria；**rate 格式必须是带符号整数百分比（speed 1.0→`+0%`、0.85→`-15%`）——包内校验正则 `^[+-]\d+%$`（edge_tts/data_classes.py:74 实锺），照字面传 0.85 直接被拒（I2③）**
  3. **`--text` 一律 execFile 数组参数、不经 shell（I2④）**
  4. 拼接：ffmpeg concat + 行间 0.7s 静音——**静音段必须 `anullsrc=r=24000:cl=mono`（与 edge-tts 原生 24kHz mono 对齐；anullsrc 默认 44.1kHz 立体声，concat demuxer 默认参数必翻车）**；或全段先归一 24kHz mono wav 再拼、末次 mp3 编码（I2③）
  5. **保留 edge-tts 原生 48kbps mono 24kHz 编码，不升 128k（升码零增益、体积 2.7×）**；输出 `~/.hermes/cache/ltutor-tts/<yyyyMMdd-HHmmss>_<title>.mp3`
  6. 返回文本内嵌 `MEDIA:<绝对路径>` + 引擎、时长、行数摘要
- **性能（M3）**：60 行串行合成 1-3 分钟逼近 MCP 300s 默认超时——**有界并发 4-6 路合成再顺序拼接**；SKILL 给教师「约 1-2 分钟」预期话术。
- **引擎降级**：edge-tts 失败 → 整体降级 `say -v Ava`（Premium 单声）+ ffmpeg 转 mp3；返回值注明引擎与局限（**"备用嗓音为单人声、无行间留白"**——r2 补）。
- **测试**（vitest）：校验分支、title 清洗、rate 格式折算、引擎降级（mock child_process）、MEDIA 标签格式、超限文案、并发拼装顺序正确性。

### 3.4 SKILL.md：新增「流程 6：图片→听力音频」+ 白名单更新 + 回显硬规则

- **文件**：`docs/superpowers/hermes/lt-tutor/SKILL.md`（仓内源）→ cp 热部署（两份 diff -q 一致）
- **要点**：① `vision_analyze` 逐行转写提示词（"逐行提取图内英文对话原文，标注说话人 A/B，不得改写、不得翻译、无法辨认的词用 ⟨?⟩ 标出"）；② 转写文本回发教师确认（**不确认不合成**）；③ 确认后调新工具；④ 慢速版 speed 0.85 再生成；⑤ §2 白名单「只准用以下 10 个」→ 12 个（+vision_analyze、+teacher_tutor_listening_audio）及用途边界；⑥ **硬性回显规则：最终答复必须原样回显 `MEDIA:<路径>` 行（音频投递双保险之二）**（C1 兜底）；⑦ frontmatter description 能力枚举同步（M4）；⑧ **自愈话术：收到"图片/文档"占位但无可用图片路径时，请老师以照片重新发送**（覆盖 wecom 图片分类回归场景，M4）。

### 3.5 Hermes 仓：MEDIA 自动追加白名单加线名（C1 必改，一行）

- **文件**：`gateway/run.py:2020-2024`
- **改动**：`_AUTO_APPEND_MEDIA_TOOL_NAMES` 增 `"mcp__llm-wiki-training__teacher_tutor_listening_audio"`（与 3.1 同仓同船重启生效）。
- **双保险说明**：白名单使网关自动追加生效；SKILL 回显硬规则（3.4⑥）兜底模型不回显的残余风险——两者独立成立，缺白名单则自动追加通道对线名永闭。

## 4. 实施顺序与部署时序（r2 修订）

1. **Step 0（精简——edge-tts/say 已由评审 live 实测通过）**：执行侧仅复核音质主观项（合成一句双人声试听）+ 以本计划 r2 的 rate/拼接参数为准；不再做可达性探针。
2. 3.1 vision 缩放（r2 杠杆）+ pytest；3.5 白名单一行（同仓提交）。
3. 3.3 mcp-server 工具 + vitest + **`npm run build`**。
4. 3.4 SKILL 双份同步；3.2 配置改动（含 I4 timeout 落点确认：先试 profile yaml，无效写主 config）。
5. 提交：llm_wiki（3.3+3.4）与 Hermes（3.1+3.5）各自提交推送。
6. **生效时点（I3 改述）**：**MCP 非热生效（网关启动拉起长驻）——五件套全部随同一次网关重启生效**，时点遵守周报窗口纪律（避开 19:00 前后；当前无在跑任务即可，用户明示立即则立即）。
7. **端到端验证**：重启后由 ggtms 重发对话图片走全链（转写确认 → mp3 文件送达企微 → 点播）；慢速版再走一单。

## 5. 验收标准（r2：主观项换可测代理）

- [ ] 670KB 级教材照片：vision 富化 ≤30s 返回描述；**agent 转写口径 ≤45s**（实测 30.8-32.3s，留余量）
- [ ] agent 能调 vision_analyze 以转写提示词读图；转写经教师确认后才合成
- [ ] mp3 可测代理：**ffprobe 总时长 ≈ Σ行时长 + 0.7s×(行数-1) ±10%；码率 ≤128k（原生 48k 平凡满足）**；作者试听 checklist（双人声可辨、行间留白自然、音质明显优于 AMR）
- [ ] **MEDIA 投递双通道生效**：网关自动追加可观测（日志/送达）且 SKILL 回显规则在最终答复中带出 `MEDIA:` 行；教师企微收到文件消息点开即播
- [ ] speed=0.85 慢速版可生成（rate 折算 `-15%`）
- [ ] edge-tts 不可达时 say 降级可用且返回值注明引擎与局限
- [ ] dialogue 超限返回可读错误而非静默截断；title 清洗生效
- [ ] 60 行级 dialogue 合成+拼接不超 MCP 超时（并发生效）
- [ ] 周报任务不受影响（重启窗口外）
- [ ] Hermes pytest 相关文件全绿；mcp-server vitest 全绿；`npm run build` 通过

## 6. 风险与回滚（r2：M1 成对回滚）

| 风险 | 处置 |
|---|---|
| edge-tts 非官方接口、小概率失效 | say 兜底已内建（注明单人声/无留白局限）；引擎可插拔 |
| 缩放后仍偶发慢 | timeout 180 + 教师确认两步天然重试位 |
| WeCom 文件消息（非语音气泡） | 明确取舍：AMR 电话音质违背质量要求 |
| 转写错误进音频 | 教师确认闸 |
| **回滚（r2）** | **3.2 与 3.4 必须成对回滚**（撤 vision 放行而留 SKILL 引用 → 模型调不存在的工具）；3.1 / 3.3+3.5（SKILL 引用同步撤）/ 3.5 各自独立可 revert |
| 网关重启窗口 | 避开 19:00 前后；重启后按健康基线核验（wecom connected + pyc 编译时间 + 白名单行加载） |

## 7. 给实施与复评的承重点（r2 更新）

1. ~~3.1 阈值杠杆~~ **已由评审实验闭合**（916/727/379KB 三点因果）——实施按 r2 处方（字节杆为主、尺寸杆次级帽）。
2. **3.5 白名单线名拼写**：`mcp__llm-wiki-training__teacher_tutor_listening_audio` 必须与实际注册线名逐字一致（server 名/tool 名改动时同步）。
3. **MEDIA 双通道实测**：一单 E2E 确认自动追加与回显兜底至少其一稳定送达。
4. **并发合成稳定性**（4-6 路）与拼接顺序正确性（并发归并后按行序拼）。
5. **I4 timeout 落点**：实现前确认 profile yaml 是否生效，无效写主 config。
