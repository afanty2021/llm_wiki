# 教师课件 PPT 生成工具（teacher_tutor_pptx）实施方案

- **日期**：2026-09-16
- **路线**：同构 worksheet 混合路径——LLM 只产 slides JSON → pptxgenjs 确定性渲染 .pptx → 现成 MEDIA: 企微文件投递链（零网关改动）
- **状态**：评审已收口——max 评审 **With fixes**（0C/5I/7M，全部计划文本级）修订已并入本体（报告 `.superpowers/ltutor-pptx-plan-review-2026-09-16/report.md`），本版为实施定稿
- **复用**：worksheet 全套纪律（caps→文本引导 / sha1 文件名 / 身份注入 / MEDIA 回显 / 失败友好透传）；Hermes MEDIA 自动兜底白名单机制

## 一、背景与目标

教师需要把库内教学内容（教材课文、视频转写页）做成**可编辑课件 PPT** 用于课堂投影。参照样本为 zcode 会话 sess_a2d5cc10-7ec2-46af-84f0-a2f171daf12a（中秋视频→7 页双语课件：pptx skill 设计规范 + ffmpeg 抽帧/音频 + whisper 转写 + pptxgenjs 出片 + soffice 渲染 QA）。该会话是 **zcode CLI agentic 形态**（shell + 逐帧看图 + judge 迭代），**不能照搬进 lt-tutor**——wecom 教师回合 toolsets 仅 skills/llm-wiki-training/vision/session_search 四件套、无 shell，SKILL §1 明令不执行命令（教师通道安全设计，与 admin MCP 防绕行同立场）。

**v1 目标语义**：教师说「把 XX 做成课件/PPT」→ 助手从库内真实材料取材 → 一次工具调用产出 16:9 .pptx 课件（封面 + 3-10 页内容页 + 每页可选讲稿备注）→ 企微文件消息送达，教师可下载后用 Office/WPS 编辑。

## 二、可行性事实（2026-09-16 逐项核实）

1. **投递链今天就能送 .pptx，下游零改动**：live 网关 `gateway/platforms/base.py` `MEDIA_DELIVERY_EXTS` 明确含 `.pptx/.ppt/.odp`（注释 presentations→file attachments）；`plugins/platforms/wecom/media.py` 原生 file 发送（image/video/voice/file 四态）带尺寸判定/降级提示。
2. **新输出目录零配置**：`gateway.strict` 缺省 false——非 strict 模式下任何不在拒访清单的现存文件直接放行（base.py:1136-1139；`trust_recent_files` 仅 strict 模式才被咨询，本部署走不到该分支）。`~/.hermes/cache/ltutor-pptx/` 与现行 `ltutor-worksheet/`（同样未被任何 allowlist 引用）同待遇，无需白名单。
3. **取材不需要 whisper**：库内视频已有带 `[mm:ss]` 锚点的转写页，`llm_wiki_search` + `llm_wiki_read_file` 即素材管道。whisper（`~/.local/bin`）/ffmpeg（`/usr/local/bin`）/soffice（`/opt/homebrew/bin`）本机虽在位，**均不进 v1 管线**（教师自传音视频→v2；soffice 渲染 QA→v1 靠确定性模板替代，见 §七）。
4. **pptxgenjs 纯 JS 零原生依赖**：mcp-server 现依赖（MCP SDK/d3/markmap-*）之外仅新增此一个 npm 包，与现有 Node 运行时同进程，无 Chrome/浏览器链路（比 worksheet 更轻）。
5. **继承两个已知坑**：CJK 字体全局钉 **"Microsoft YaHei"**（参照会话 LibreOffice 字体索引教训 + 教师 Windows 机标准字体）；pptxgenjs 音频嵌入会把 `<a:audioFile>` 写成 `<a:videoFile>` 需 zip 后处理（v2 音频页才涉及，记档备查）。

## 三、架构与数据流

```
教师企微「把 XX 做成课件 / 出个 PPT」
  → lt-tutor 回合：references/flow-pptx.md → llm_wiki_search + llm_wiki_read_file（库内真实材料）
  → 构造 slides JSON 作为工具入参（一次调用，直接出片，无确认回合——同 worksheet 先例）
  → mcp-server：normalize/校验 → caps（超限→文本引导，不进熔断器）→ pptxgenjs 确定性渲染
  → ~/.hermes/cache/ltutor-pptx/pptx-<sha1(规范形JSON)前12>.pptx → MEDIA: 行
  → 网关 MEDIA 分派（.pptx∈MEDIA_DELIVERY_EXTS）→ 企微原生文件消息
```

**核心纪律沿袭 worksheet：LLM 只产 JSON 结构、永不产 XML/OOXML**——语法错误类失败与注入面同时消灭。与 worksheet 的差异：渲染目标从 HTML→Chrome 截图换为 pptxgenjs 直出 OOXML，文本转义由 pptxgenjs 承担，入口仍统一做**控制字符压空格**（`[\x00-\x1f]`，M1 教训的 pptx 等价物）。

## 四、改动清单

### 1. mcp-server/src/pptx.ts（新，~300-400 行）

- **入参 schema**（顶层与 slide 层 `additionalProperties:false`；`wecom_userid` 标准可选首参，描述逐字对齐既有 teacher_tutor 工具）：
  ```jsonc
  {
    "wecom_userid": "（标准可选首参，见 worksheet）",
    "title": "string ≤40（必填，直接用主题名，勿带「课件」等文档类型字样）",
    "subtitle": "string ≤60（可选，如适用学段/单元）",
    "theme": "warm（可选，v1 唯一值，缺省即 warm）",
    "slides": [                        // 3-10 页（min 3 在 handler caps 强制，先例=不设 minItems）
      {
        "heading": "string 1-30（必填，页标题）",
        "bullets": [ "string 1-80" ],  // 1-6 条要点
        "note": "string ≤120（可选，讲稿备注，进演讲者备注栏，不打上幻灯片）"
      }
    ]
  }
  ```
- **caps 纪律**（`pptxCapsError()` 返回人类可读原因，超限→文本引导不进熔断器，同 worksheet/mindmap 先例）：slides 3-10、bullets/页 ≤6、bullet ≤80 字、heading ≤30、note ≤120。**计数口径（评审 I-1 钉死）**：单页 = `heading + Σbullets` ≤ **550**（字段级全最大合法值 6×80+30=510 必须能过，500 是自相矛盾上限）；总文本 = `title + subtitle + Σ(heading+bullets)` ≤ 2500（对齐 worksheet `totalChars` 计入 title/subtitle 先例；多页满编 5500>2500 的全局挤压同 worksheet 先例 ~2040>1200，有意为之，报错引导精简/拆分）；**note 不进任何面板**（讲稿备注不上幻灯片）。口径 `String.length`，同 worksheet I-5。
- **normalize 兜底（评审 M-6）**：title 剥「课件/PPT」字样——指引在 schema/flow 文字约束，renderer 侧兜底保证规则恒成立（先例 = worksheet normalize 剥「学案」，worksheet.ts:117-120，剥空则拒）；theme 非法回落 warm。
- **模板（v1 单主题 `warm`）**：LAYOUT_WIDE 16:9（13.33×7.5in）；**封面页由渲染器自动生成**（title+subtitle，不算 slides 配额，总页数 = slides+1）；暖纸浅底 + 深蓝标题 + 金色强调（配色实现期钉死，家族感对齐学案 nature）。**字号预算钉死（评审 M-5）**：heading 30pt / bullet 18pt / 行距 1.25——最坏 6 条×80 字 ≈12 行 ≈4.7in（含条间距）≤ 版心可用高 ~5.4in（7.5 − 标题带 − 上下边距），留有余量。**fontFace "Microsoft YaHei"：母版 + 封面与全部幻灯片文本元素**（备注字体由 PowerPoint notes master 缺省决定——`addNotes` 无字体选项，不做无谓尝试，评审 M-4）。
- **讲稿备注**：`slide.addNotes(note)`——进演讲者备注栏（参照会话「每页备注附原文」的教学价值，不占版面）。
- **文本洁癖**：入口统一控制字符压空格；XML 转义信任 pptxgenjs（其 addText 走自身 escape 路径，fixture 测试断言 `<script>` 字面进 `<a:t>` 后被转义为不可执行文本）。
- **文件名 `pptx-<sha1(规范形 JSON)前12>.pptx`**（禁哈希原始入参 JSON——键序漂移破坏幂等；规范形 = normalize 后稳定键序序列化）。**与先例的机制差异系有意选择（评审 M-3）**：worksheet/mindmap 哈希渲染中间产物（HTML/DOT），本工具哈希规范形输入——模板/主题升级**不会**轮换文件名，同内容静默覆盖旧文件（渲染不跳过已存在文件，覆盖无害）；未来模板升级需强制轮换时，在规范形里加模板版本常量即可。
- **输出目录**：`~/.hermes/cache/ltutor-pptx/`（`mkdirSync recursive`，同 worksheet 常量形态 `DEFAULT_PPTX_OUT_DIR`）。
- **结果形态**：`PptxRenderResult { ok, path?, slides?, error? }`；`engine:"pptx"` 只进内部对象不进教师可见文本（M-3'/I-6 先例）。
- **失败文案**：自带最小透传（Node 依赖缺失/磁盘异常等环境性故障透传友好文案），勿 import mindmap 的 friendlyRenderError（graphviz 专属误导，I-7b 先例）。

### 2. mcp-server/src/training.ts（注册，14 号工具）

- `teacher_tutor_pptx` 定义 + handler（`resolveIdentityForTool`/`withIdentitySource`/caps 文本引导，对齐 worksheet handler 现形态；`deps.renderPptx` 注入点）。成功文案：`课件已生成（N 页）。` + `MEDIA:<path>` + 原样保留提示——无引擎字样。
- 工具 description 强调三件事（对齐 worksheet 描述纪律）：①内容必须基于 search/read_file 真实材料构造，勿编造；②返回含 MEDIA: 行必须原样回显，文件才会送达教师；③适合"做课件/出 PPT/幻灯片"类请求；**老师发来视频/音频文件要求转课件 → v1 暂不支持，礼貌说明**（转写管线未接入，见 §八边界）。

### 3. Hermes（一行 + 测试）

- `gateway/run.py` `_AUTO_APPEND_MEDIA_TOOL_NAMES` 追加 `mcp__llm_wiki_training__teacher_tutor_pptx`（**下划线净化形态**——C1 教训，连字符形态永不匹配）；注释行同步补「课件 pptx 产物经 MEDIA: 标签投递」。
- `tests/gateway/test_media_extraction.py::TestAutoAppendWhitelistMembership` 补 membership + 行为级收集用例。

### 4. SKILL.md + references/flow-pptx.md（双份 cp 部署）

- **SKILL.md**：frontmatter description 能力追加「课件 PPT 生成（检索真实材料后排版出片）」；快速路径表加一行（触发词「做个课件 / 出个 PPT / 幻灯片」→ 走**流程 10**：① `skill_view`("teacher-tutor", file_path="references/flow-pptx.md") ② 骨架：`llm_wiki_search`+`llm_wiki_read_file` 取材 → `teacher_tutor_pptx` 出片 → 回显 `MEDIA:` 行）；§2 标题与白名单 **17→18** 加行（参数形状 + 返回 `MEDIA:` 行 + 超限精简引导 + 环境性失败改发文字大纲勿重试刷屏）；§11 之后插「流程 10」一行桩（§7-11 外移先例），**§12 通用回复规范顺移 §13**（`§12` 交叉引用评审实测 SKILL.md + references/ + 根目录笔记全仓零命中，无需扫——记档免后人重查）。
- **references/flow-pptx.md**（头部映射行对齐其余流程文件四锚格式：身份=§0、输出硬规则=§1、工具白名单=§2、构造手法=本文件）：
  1. **取材**：`llm_wiki_search` + `llm_wiki_read_file` 读库内真实材料（教材课文/转写页，视频页按 `[mm:ss]` 锚点定位段落）——不编造材料外内容；检索无果 → 如实告知暂缺材料（老师口述内容可整理文字大纲并注明非库内材料）。
  2. **构造结构**：`title`（≤40 字符，主题名直书不带「课件」字样）、`subtitle`（可选）、`slides` 3-10 页（典型 5-8 页即可，每页 `heading` + `bullets` 2-5 条为宜 + 可选 `note` 讲稿备注）；**页间结构服务教学**：导入页→要点页→操练/讨论页→小结页的常见走向，勿把全部材料塞进少数页（每页过密会被拒）。
  3. **MEDIA 回显**（核心 §1 硬规则）。
  4. **失败回退**：环境性失败勿反复重试刷屏——改发文字版课件大纲（逐页标题+要点），说明课件稍后可再生成。话术预告：.pptx 为文件消息，需点击下载后用 Office/WPS 打开编辑。
- **边界话术**（flow 内钉死）：老师发来视频/音频文件要求转课件、或要求 PPT 内嵌音频 → v1 礼貌说明暂不支持，可先出**文字版课件大纲**或引导把材料入库后再出。

### 5. 明确不动项（防过度工程）

- lt-tutor `config.yaml` **零改动**（llm-wiki-training 已在 wecom/cron 两侧 toolsets，新工具随 MCP server 自动出现；`tool_search` 仍 off，**工具面 15→16 个**在可见数组内无压力）。
- 网关媒体投递配置零改动（§二-2）；src-server/仓内其他模块零改动。

## 五、测试（mcp-server node --test + Hermes pytest）

- **normalize/校验**：theme 缺省/非法回落 warm；title 剥「课件/PPT」+ 剥空拒；控制字符压空格；`<script>` 字面保留（转义交给渲染器，fixture 断言 OOXML 内为转义形态）。
- **caps**：slides<3 / >10、bullets>6、各长度帽、单页/总文本超限——每维超限文案 + 恰好边界通过 + **全字段取最大合法值合成用例**（6×80+30=510 ≤ 550 必须过——评审 I-1 的防回归钉）。
- **文件名幂等**：同内容两次渲染同 sha1 名（键序漂移用例：原始入参键序打乱 → 规范形不变）。
- **真渲染**：fixture 课件（对齐 `test/worksheet-fixture.ts` 一处两用先例）真 pptxgenjs 出片 → zip 解包断言（**设施钉死（评审 I-5）：jszip 进 devDependencies**——pptxgenjs 传递依赖虽已在 node_modules，直接 import 未声明依赖是幻影依赖；显式声明使 import 合法化且与渲染器同库零额外体积）：slide 数 = slides+1、`Microsoft YaHei` 存在于 slide XML、CJK 文本在 `<a:t>` 完好、note 在 notesSlide、zip CRC 校验过（结构有效性）。**不断言字节级确定性**（评审 M-7：pptxgenjs 在 docProps 写时间戳，两次产物字节必不同——幂等契约在文件名，不在字节）。
- **handler**：身份注入、caps→文本引导（不抛 ToolError、不进熔断器）、渲染失败透传友好文案、成功文案无引擎字样 + MEDIA 行格式（fake render 注入，同 worksheet 套路）。
- **Hermes**：TestAutoAppendWhitelistMembership 补 pptx 线名 membership + 行为级收集。

## 六、部署与验收

1. **先装包再测试（评审 I-2）**：test script 内含 `npm run build`（package.json:14），tsc 编译期就需包在位——`npm --prefix mcp-server i pptxgenjs`（jszip 进 devDependencies 同步声明，§五）→ `npm --prefix mcp-server test` 全绿 → `npm run mcp:build`；
2. Hermes 仓提交（run.py + 测试）；
3. **网关重启先于 SKILL cp（评审 I-4）**：MCP 子进程是长驻 stdio，重启才吃新 dist——工具先上线、技能后指路；反向次序会在窗口内让教师触发流程 10 撞 tool-not-found。常规 `gateway run --replace`（**避开周日 19:00-20:00 教师周报窗与课堂高峰**）；
4. SKILL.md + references/flow-pptx.md 双份 cp（仓源 + `~/.hermes/profiles/lt-tutor/skills/teacher-tutor/`），md5 双端核对；
5. stdio 握手验工具面 **16** 个 / 白名单 18 行对齐（评审 I-3：现 15 = src-server 2 + teacher_tutor 13，`index.ts:221`；profile config 里「仅 10 个」是 09-04 陈旧注释——按旧口径验收会把正常部署误判成故障。部署窗可顺手更正该注释，非功能改动）；
6. 真发验收：企微实发「把一般过去时做成课件」→ 目检：文件消息到达、errcode=0、下载后 PowerPoint/WPS 可开、字体中文完好、页数与要点对版、备注栏在位；
7. **兜底验证**（I-8a 先例）：真发无法强制模型漏发 MEDIA——网关日志核对 + 行为级测试已扩 pptx 线名。
8. **回滚预案**：git revert mcp-server/Hermes 两仓改动后随常规部署；**禁止只回写 live 副本**（CLAUDE.md 约束 5，并行会话例行双份 cp 会把 live-only 回滚打回）。

## 七、风险与预案

| 风险 | 预案 |
|------|------|
| 要点过长溢出版面（pptxgenjs 无 autofit 保证） | caps 收口 + 字号预算钉死（heading 30pt / bullet 18pt / 行距 1.25，最坏 6×80 字 ≈12 行 ≈4.7in ≤ 版心可用 ~5.4in，§四-1）；溢出观感由真发反馈迭代（同 worksheet 溢出预案） |
| 教师 Windows 之外设备打开字体回落 | fontFace 钉 Microsoft YaHei（Win 标准字体）；Mac/iOS 回落系统黑体可接受，不内嵌字体文件（体积换兼容） |
| 模型一次产 10 页 JSON 延迟/超限 | 典型 5-8 页引导写进 flow；caps 拒超限并给拆分引导（先例文案形态） |
| 教师期待「视频转 PPT」（whisper 语义） | flow 边界话术钉死 v1 不支持；引导入库后取转写页做课件；v2 再评估直转管线 |
| 熔断器误伤（caps 类应用级输入） | caps→正常文本引导不进熔断器（mindmap/worksheet 双先例，handler 测试钉） |
| LibreOffice 渲染 QA 缺位 | v1 靠确定性模板 + 结构断言（zip 解包）替代；真发目检兜底；后续可加 soffice 转 PDF 冒烟（工具已在位）为可选增强 |

## 八、工作量与边界

- **预估**：pptx.ts ~300-400 行 + 测试 ~350 行 + training.ts 注册 ~50 行 + SKILL/flow 文件 + Hermes 一行一测——**小于 worksheet v1**（无 HTML/CSS 模板系统、无 Chrome 链路）；一次执行会话可收。
- **明确不做（v1）**：音频/视频嵌入（`<a:videoFile>`→`<a:audioFile>` 后处理坑随 v2 带走）、图片页/图片插槽、教师自传素材直转（whisper/ffmpeg 管线）、soffice 渲染 QA 自动化、多主题、A4 讲义版式导出、确认回合（直接出片，先例同 worksheet；真发若现浪费再加「大纲确认」轻回合）。
