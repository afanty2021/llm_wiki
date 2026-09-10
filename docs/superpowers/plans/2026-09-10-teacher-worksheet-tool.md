# 教师学案海报生成工具（teacher_tutor_worksheet）实施方案

- **日期**：2026-09-10
- **路线**：混合路径——确定性 HTML/CSS 版式 + 精确文本 + emoji/CSS 装饰 → headless Chrome 截图 → 现成 MEDIA: 企微投递链
- **状态**：方案评审可开工（有条件）已收口——C-1+I-1..I-8 修订已并入本体（报告 .superpowers/worksheet-plan-review-2026-09-10/），本版为实施定稿
- **复用**：mindmap 全套基础设施（chromeScreenshotRunner / isCompletePng / 临时名 rename / MEDIA 链 / caps→文本引导纪律）

## 一、背景与目标

教师需要学案/练习海报类材料（样例 `~/Github/Sample-mindmap.jpg`：竹框卡片、填空、勾选、课表、插画）。纯图像生成路线被否：中文正文不可靠（样例中 "Mare" 乱码即图像模型瑕疵）。混合路径分工：**版式与文字由 CSS 排（100% 准确），装饰由 emoji + CSS 主题承担（零外部依赖），图像生成 API 不进管线**（可选后期增强，见 §八）。

## 二、探针实证（2026-09-10，已归档 assets/worksheet-probe/）

纯 CSS + emoji 复刻样例结构成功（1500×1100@2x → 3000×2200 PNG）：暖纸底纹、金框、圆角卡片、虚线填空线、虚框填空盒、勾选框、课程表、emoji 角标全部成立；中英双语混排正常。两个实施细节：
1. 部分 emoji 在 headless 截图中回落文本呈现（单色细线）——渲染器对 emoji 统一补 `U+FE0F` 变体选择符强制彩色形态；
2. 内容不满画布时底部留白——真实学案内容密度下可接受，模板用网格自适应。

## 三、架构与数据流

```
教师企微「出一份 XX 主题的学案/练习海报」
  → lt-tutor 回合：teacher_tutor_search + read_file（库内真实课文，不编造）
  → 构造 worksheet JSON 作为工具入参
  → mcp-server：校验/caps → 确定性渲染 HTML（全量 esc）→ 复用 chromeScreenshotRunner
  → IEND 判据 + 临时名 rename → ~/.hermes/cache/ltutor-worksheet/worksheet-<sha1_12>.png
  → MEDIA: 行 → allowlist → 企微原生图片消息
```

**核心纪律沿袭 mindmap：LLM 只产 JSON 结构、永不产 HTML/CSS**——语法错误类失败与注入面同时消灭。与 markmap 的 base64 内联不同，worksheet 的内容必须以可读文本进 HTML，因此**每一个文本字段过统一 `esc()`（& < > " '）**，模板本身零 script 元素（纯静态页，无脚本需要）。

## 四、改动清单

### 1. mcp-server/src/worksheet.ts（新，~350 行）

- **入参 schema（C-1 定稿：判别联合，无递归、无 I2 口子，比 mindmap 更严）**：
  - 顶层与 section 层 `additionalProperties:false`；**`wecom_userid` 标准首参**（可选声明形态，描述逐字对齐既有 teacher_tutor 工具——cron 回合 emit 通道）；
  - `blocks.items = anyOf[六变体]`：每变体以 `type` 常量判别（`enum:["text"]` 形态）、各设 required（text→`[type,text]`；fill/boxfill/checklist/numbered→`[type,items]`；table→`[type,headers,rows]`）+ `additionalProperties:false`；
  - `theme`（可选，`enum:["nature"]`，缺省即 nature——C-1 矛盾消解：入参保留并落进 schema，传其他值回落 nature）。
  ```jsonc
  {
    "wecom_userid": "（标准可选首参，见上）",
    "title": "string ≤40（必填）",
    "subtitle": "string ≤60（可选）",
    "theme": "nature（可选，v1 唯一值）",
    "footer": "string ≤60（可选，如 Name/交作业提示）",
    "sections": [                       // 2-4 个卡片（min 2 在 handler caps 强制，先例=不设 minItems）
      {
        "heading": "string 1-30（必填）",
        "icon": "string ≤8 码位（可选，emoji 角标）",
        "blocks": [                     // 1-4 块，anyOf 六变体（type 判别）
          { "type": "text",     "text": "1-120 字符" },
          { "type": "fill",     "items": [ { "before": "1-60", "after": "≤60" } ] },   // 虚线填空行
          { "type": "boxfill",  "items": [ { "before": "1-60", "after": "≤60" } ] },   // 虚框填空
          { "type": "checklist","items": [ "1-30" ] },                                 // 勾选 ≤6
          { "type": "numbered", "items": [ { "before": "1-60" } ] },                  // 编号+空线
          { "type": "table",    "headers": [ "1-12" ], "rows": [ [ "≤12" ] ] }        // ≤5 列 × ≤4 行
        ]
      }
    ]
  }
  ```
- **caps 纪律**（超限→文本引导不进熔断器）：sections≤4、blocks/卡≤4、fill/boxfill/numbered≤4、checklist≤6、table≤5×4、各级文本长度帽、总文本字符 ≤1200。`worksheetCapsError()` 返回人类可读原因（同 mindmap）。
- **块渲染器**：六种 type 各一纯函数 → HTML 片段；填空线用 CSS border-bottom（不写字面下划线）。
- **`esc()`（I-2 三句）**：①`& < > " '` 五件套 + 控制字符 `[\x00-\x1f]` 压空格（M1 教训）；②**输入文本只进文本节点、HTML 属性值一律模板常量**（属性上下文整类消灭）；③icon 经 esc 进 `<span class="emoji">` 文本节点。
- **emoji `\uFE0F`（I-3 钉死）**：按字素簇（`Intl.Segmenter`）处理——**仅「单码位且含 Extended_Pictographic」的簇补 FE0F**；多码位簇（旗 🇨🇳/ZWJ 序列 👨‍👩‍👧/已带 FE0F/FE0E/20E3 变体者）一律不动（比「簇含 EP 即补」更严：旗与 ZWJ 结构性不可破坏）。四用例钉：🌱→补、🎨\uFE0F→不动、🇨🇳→不动、👨‍👩‍👧→不动、CJK 文本→不动。
- **模板**：单主题 `nature`（探针样式固化：暖纸斜纹底、金框、圆角卡、虚线分隔）；`theme` 字段入参留缝（v1 只接受 "nature"，传别的回落）。
- **渲染**：复用 mindmap-markmap 导出的 `chromeScreenshotRunner` + `isCompletePng`；runner 加可选 `width/height`（缺省现值向后兼容，消除 MARKMAP 画布硬编码耦合，I-7a）。HTML 落 tmp → 截图 tmp 名 → IEND 过 → renameSync 终名。
- **文件名 `worksheet-<sha1(渲染 HTML)前12>.png`（I-4）**：与 mindmap.ts:205 既有纪律对齐（禁哈希 JSON——键序漂移破坏幂等）；HTML 含 theme 自动覆盖主题维度。
- **失败文案（I-7b）**：worksheet 自带最小透传错误文案，**勿 import mindmap 的 friendlyRenderError**（其 ENOENT 文案是 graphviz/brew 专属，Chrome 场景误导）；runner 自抛「Chrome/Chromium 未找到」已是友好文案，透传即可。
- **结果**：独立 `WorksheetRenderResult { ok, path?, sections?, blocks?, error? }`（M-5，不含 engine 联合）；`engine:"worksheet"` 只进内部对象不进教师可见文本（M-3'/I-6）。
- **fixture（M-6/I-8b 一处两用）**：样张 JSON 入仓 `test/worksheet-fixture.ts`，真冒烟与文字准确性断言共用。
- **结果形态**：同 mindmap `{ ok, path, engine:"worksheet", sections, blocks, error? }`。

### 2. mcp-server/src/training.ts（注册，13 号工具）

- `teacher_tutor_worksheet` 定义 + handler（resolveIdentity/withIdentitySource/caps 文本引导，对齐 **M3' 修复后**的 mindmap handler 现形态；deps.renderWorksheet 注入点）。成功文案模板（I-6）：`学案海报已生成（N 个板块 / M 个内容块）。` + MEDIA 行 + 原样保留提示——无引擎字样。
- 工具 description 强调：内容必须来自 search/read_file 真实课文；适合"出一份学案/练习纸/知识海报"类请求。

### 3. Hermes（一行 + 测试）

- `_AUTO_APPEND_MEDIA_TOOL_NAMES` 追加 `mcp__llm_wiki_training__teacher_tutor_worksheet`（**下划线净化形态**——C1 教训已入 [[fix-completeness-traps]] 陷阱 24）；TestAutoAppendWhitelistMembership 补 membership + 行为级收集用例。

### 4. SKILL.md（双份 cp）

- frontmatter 触发词补学案/练习纸/知识海报；快速路径行 + 括号参数清单；工具表 15 个（行带参数形状）；流程 8 新增，通用回复规范顺移 §11、全文交叉引用同步（M-1）；
- 流程 8：检索取材 → 构造 JSON → MEDIA 回显（M-2：多张=每张一行 MEDIA，网关 finditer 全收+逐张投递已实证，零网关改动）→ **失败回退（I-7b）：环境性故障勿重试刷屏，改发文字版学案** → 检索无果不编造；话术预告「屏幕比例海报，非 A4 打印版」（M-4）。

## 五、测试（mcp-server node --test）

- 六种块渲染器：HTML 形状、esc（`<script>`/`<!--`/引号/`&` 全量）、emoji `\uFE0F`；
- caps：各维度超限文案 + 恰好边界通过；
- 组装：sections→卡片数、table 表头/行、footer；
- 渲染：fake screenshot 成功/半截/异常三形态（fake 须产合法 PNG 字节）；资产预检（worksheet 无外部资产→仅 Chrome 缺失路径）；
- 真冒烟：真 Chrome 渲染样张 JSON → IEND 过 → 目检；
- Hermes：allowlist membership + 行为级收集（worksheet 线名）。

## 六、部署与验收

1. `npm --prefix mcp-server test` → `npm run mcp:build`；
2. SKILL 双份 cp；Hermes 提交（run.py+测试）；
3. 网关重启（避周日 19:00 与教师课堂高峰）+ stdio 握手验 13 工具；
4. 真发验收：企微实发「出一份 XX 的学案」→ 目检版式/投递 errcode=0。**文字准确性判定降为 HTML 层确定性（I-8b）**：fixture JSON 的 esc 后文本逐字存在于 page.html（函数级断言），PNG 目检只对成图观感。
5. **兜底验证（I-8a）**：真发无法强制模型漏发 MEDIA——改为网关日志核对 + 行为级测试扩 worksheet 线名（形态同 TestAutoAppendWhitelistMembership 现用例）。

## 七、风险与预案

| 风险 | 预案 |
|------|------|
| 内容超版式（卡片溢出） | caps 收口 + 网格自适应；溢出观感问题由真发反馈迭代 |
| 主题单一 | theme 字段留缝；装饰升级=往 assets 目录加 CSS/PNG（内容工作非管线工作） |
| emoji 文本呈现回落 | 渲染器统一 `\uFE0F`（探针发现的细节） |
| 图像生成 API 依赖 | 明确不进 v1 管线；主题装饰走 CSS+emoji+手工素材目录 |
| 线名坑复发 | 下划线净化形态 + 行为级测试（C1/I4 已有测试模板） |

## 八、工作量与边界

- 预估（M-3 修正）：worksheet.ts **450-550 行** + 测试 ~400 行 + training.ts/SKILL/Hermes 小改；比 mindmap v1 大（模板+块系统），比 markmap v2 小（无新渲染器，全套复用）。
- 明确不做（v1）：A4 竖版/多主题/图片插槽/教师上传素材/图像生成 API；drawbox（画画框）留 v2。
