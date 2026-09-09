# 教师思维导图 PNG 工具（teacher_tutor_mindmap）实施方案

- **日期**：2026-09-09
- **路线裁定**：**graphviz 本地渲染**（mermaid.ink 作对比落选，理由见 §二，含本机实测）
- **模板**：`teacher_tutor_listening_audio` 全链复制（mcp-server 工具 → `MEDIA:` 行 → 网关自动追加 → wecom 原生发送）
- **状态**：方案定稿，待实施

## 一、背景与目标

教师在企微向 lt-tutor 提出「生成思维导图」类请求。现状：模型只能给文本大纲（企微 markdown 缩进列表），无法出图；前端 mermaid 渲染只存在于 web/desktop，企微客户端不渲染。本方案新增一个教师工具面工具：LLM 基于库内真实课文（search/read_file）构造结构化大纲，工具确定性渲染为 PNG，经既有 `MEDIA:` 投递链以企微原生图片消息送达。

## 二、路线裁定：graphviz vs mermaid.ink（本机实测 2026-09-09）

| 维度 | graphviz（本地） | mermaid.ink（远程） | 胜者 |
|------|-----------------|--------------------|------|
| 渲染延迟（热） | **0.08s**（实测，Apple M 系 brew bottle） | **5.25s**（实测单次往返；真实导图更大更慢） | graphviz |
| 可用性 | 本地进程，无外部依赖 | 免费公益服务，无 SLA；课堂演示时段宕机=功能当场死亡 | graphviz |
| 内容面 | 大纲不出机 | 大纲 base64 进 URL（GET），经公网/中间代理可被记录 | graphviz |
| 中文渲染 | **PingFang SC 实测完美**（见 §八探针） | 服务端自带 CJK 字体，正常 | 平手 |
| 视觉质量 | 圆角填充节点+深度配色，成品级可用（探针图目检通过） | mermaid mindmap 原生样式更「可爱」 | mermaid.ink |
| 部署 | `brew install graphviz`（**探针阶段已装好**，16.0.0） | 零安装 | mermaid.ink |

**裁定**：课堂关键路径上「可用性+延迟」权重远大于「样式可爱度」；graphviz 胜出。视觉差距用样式补齐（§五 DOT 模板）。**架构留缝**：LLM 产物是 JSON 大纲（不是 DOT/mermaid 语法），渲染器是独立函数——未来若要并附加渲染路线（如本地 mermaid）只动渲染层。

## 三、架构与数据流

```
教师企微消息「帮我出一张一般过去时的思维导图」
  → lt-tutor 回合：teacher_tutor_search + teacher_tutor_read_file（库内真实课文）
  → 构造 outline JSON 作为工具入参调用 teacher_tutor_mindmap
  → mcp-server：校验/caps → 确定性编译 DOT → execFile dot -Tpng（超时 15s）
  → 写 ~/.hermes/cache/ltutor-mindmap/mindmap-<sha1_12>.png
  → 返回文本含 `MEDIA:<path>` 行
  → 网关 _collect_auto_append_media_tags（工具在 allowlist → 自动追加附件）
  → wecom 适配器 _upload_media_bytes（type=image）→ 原生图片消息送达
```

**核心设计决策：LLM 只产 JSON 大纲，永不产图语法。** mermaid/DOT 语法错误是这类工具的头号失败源；JSON schema 校验 + 确定性编译把这一类失败整体消灭，两条渲染路线共享同一入参契约。

## 四、改动清单

### 1. mcp-server/src/mindmap.ts（新文件，~150 行）

对齐 `listening-audio.ts` 的结构与测试注入形态（deps.execFile 可注入）：

- **入参 schema**（training.ts 内声明）：
  ```jsonc
  {
    "title": "string，必填，1..60 字符",
    "root": {                       // 根节点 label 即 title，root 只挂 children
      "children": [                 // 递归，最多 4 层（root=0 层）
        { "label": "string，1..40 字符", "children": [ /* … */ ] }
      ]
    }
  }
  ```
- **caps 纪律**（对齐 `LISTENING_MAX_*`，超限走正常文本引导、不进熔断器——record_ask/listening 前例）：
  - `MINDMAP_MAX_DEPTH = 4`、`MINDMAP_MAX_NODES = 60`、`MINDMAP_MAX_LABEL_CHARS = 40`、`MINDMAP_MAX_TITLE_CHARS = 60`
  - 超限返回语：`未生成导图：节点 N 个超过上限 60。请拆成多张（按章节），或与教师确认精简后再生成。`
- **DOT 编译器 `compileDot(outline)`**（纯函数，可单测）：
  - 转义：label 内 `\` `"` 换行必须转义（DOT 字符串语法）；`→` 等 Unicode 原样保留（探针已验证）
  - 节点 id `n0/n1/...` 序号生成，杜绝 label 撞名
  - 深度配色：depth0 `#4C6FFF`（白字、fontsize 17）、depth1 `#DCE7FF`、depth2 `#F0F4FF`、depth≥3 `#F7FAFF`（探针样式原样固化）
- **渲染 `renderPng(dotSrc, outPath)`**：`execFile("dot", ["-Tpng", "-o", outPath], { timeout: 15000 })`；输入经 stdin 或临时 .dot 文件（临时文件用完即删）
- **输出落点**：`~/.hermes/cache/ltutor-mindmap/`（对齐 `DEFAULT_LISTENING_OUT_DIR = ~/.hermes/cache/ltutor-tts` 先例；**勿用 /tmp**——重启即清且跨会话可见性差）
- **文件名**：`mindmap-<sha1(normalized outline JSON).slice(0,12)>.png`——同大纲幂等覆盖，不堆积
- **返回形态**（对齐 listening_audio 逐字风格）：
  - 成功：`思维导图已生成（N 个节点 / M 层）。\nMEDIA:<path>\n给教师的最终回复必须原样保留上面 MEDIA: 开头那一行，图片才能送达。`
  - dot 失败/缺失：`思维导图生成失败：<err>。可先给教师文字版大纲（层级列表），或稍后重试。`

### 2. mcp-server/src/training.ts（注册工具，~60 行）

- `teachers/tools` 数组追加 `teacher_tutor_mindmap`（inputSchema 如上；description 写明「用库内内容构造 outline，勿编造课文外内容」）
- handler 对齐 `teacher_tutor_listening_audio`（:663）：`resolveIdentity` + `withIdentitySource` 包裹；deps.render 注入点供测试

### 3. Hermes gateway/run.py（一行）

- `_AUTO_APPEND_MEDIA_TOOL_NAMES`（:2021）追加：
  ```python
  "mcp__llm-wiki-training__teacher_tutor_mindmap",
  ```
  ⚠ 线名必须与实际注册名逐字一致（listening 评审 C1 坑）；server/tool 改名时同步。

### 4. SKILL.md（双份 cp：仓源 + `~/.hermes/profiles/lt-tutor/`）

新增小节：
- 教师要思维导图：先 search/read_file 取真实课文 → 构造 outline → 调工具 → **原样保留 MEDIA: 行**
- 工具失败时回退文字版大纲；**禁止**给教师发 mermaid/graphviz 源码（企微不渲染）
- 上限预告（>60 节点先拆章节）

### 5. 测试

- **mcp-server（vitest）**：
  - compileDot：嵌套结构→节点/边数、转义钉（含 `"` `\` 换行的 label）、撞名 label 生成独立 id、深度配色
  - caps：超深度/超节点/超 label/title → 引导文案精确匹配
  - 成功形态：MEDIA: 行存在且路径在 ltutor-mindmap 目录、文件名 hash 幂等
  - 失败形态：render 抛错 → 引导文案、无 MEDIA: 行
- **Hermes（单文件实跑，禁全量）**：allowlist 现有测试组补 `teacher_tutor_mindmap` 线名用例（照 listening 用例模板）

### 6. 无改动面（明确不动）

- 网关 `_TOOL_MEDIA_RE` 白名单：`png` 已在列（run.py:2089）
- wecom 适配器：`_upload_media_bytes` type=image + `_send_media_message` 现成（听力 mp3 同链每日实证）
- src-server / Rust / DB：零改动（渲染纯本地，内容读取走既有 search/read_file）

## 五、DOT 模板（探针样式固化）

```
digraph mindmap {
  rankdir=LR;
  graph  [dpi=144, bgcolor="white", pad=0.4, fontname="PingFang SC"];
  node   [shape=box, style="rounded,filled", fontname="PingFang SC",
          fontsize=13, margin="0.18,0.1", penwidth=0];
  edge   [arrowhead=none, color="#B0B7C3", penwidth=1.4];
  // root: fillcolor=#4C6FFF fontcolor=white fontsize=17
  // depth1/2/3+: #DCE7FF / #F0F4FF / #F7FAFF
}
```

## 六、实施与部署步骤（顺序）

1. **环境**：graphviz 16.0.0 **已装**（2026-09-09 探针，/opt/homebrew/bin/dot）。新装机需 `brew install graphviz`（缺装时工具走失败引导文案，不炸回合）。
2. mcp-server：mindmap.ts + training.ts 注册 + vitest → `npm --prefix mcp-server test` → **`npm run mcp:build`（硬约束：非热生效）**
3. Hermes：run.py allowlist 一行 + 单文件测试实跑（editable install，重启即生效，无需 build）
4. SKILL.md 双份 cp（热生效）
5. **网关重启**（吃 mcp dist + run.py）：避开周日 19:00 周报窗 + 避开教师日间课堂高峰（选晚间）；重启后核 `ps lstart` + mcp 子进程拉起
6. E2E：企微真发「请给我出一张 XX 知识点的思维导图」→ 验收：①图片原样送达（中文无豆腐块）②工具失败路径回退文字大纲 ③超限请求得引导文案
7. git：llm_wiki（mcp-server + SKILL + 本方案）与 Hermes（run.py+测试）两仓分别提交；`git add` 禁 `-A`，提交前核 `git branch --show-current`

## 七、风险与预案

| 风险 | 预案 |
|------|------|
| 大纲质量差（LLM 编造课文外节点） | SKILL 强制先 read_file；工具 description 声明「勿编造」；后续可加「引用页数」字段回显来源 |
| 大 PNG（60 节点全展开） | dpi=144 实测 62KB/1308px 量级；wecom 图消息上限富余；超宽由 caps 拆分引导兜底 |
| dot 在 launchd PATH 解析失败 | 网关 PATH 实测含 `/opt/homebrew/bin`（edge-tts 同位每日实证）；仍失败→失败引导文案不炸回合 |
| 教师期望「PPT 级」美观 | SKILL 预告能力边界（结构导图非设计图）；美化属后续迭代（配色/图标） |
| 并发生成堆积 | 单机 dot 0.08s/张，文件名 hash 幂等；无排队问题 |

## 八、探针记录（2026-09-09，一手实测）

1. `brew install graphviz` → 16.0.0，`/opt/homebrew/bin/dot` 就位。
2. 中文渲染探针（§五样式 + 「一般过去时」十节点样例）：PNG 1308×619 @144dpi / 62KB，**中文全部正常无豆腐块**，层级配色与圆角成品级，目检通过。
3. 延迟：冷启 3.3s（fontconfig 首建缓存）、**热运行 0.08s×3 稳定**。
4. mermaid.ink：HTTP 200 可达，单次 **5.25s**，返回 140×174 小图（真实导图更大更慢）；内容进 GET URL。
5. 网关进程 PATH 实测含 `/opt/homebrew/bin` 与 `/usr/local/bin`（`ps eww` 直读）——`dot`、`edge-tts`、`ffmpeg` 同位解析。
6. 输出目录先例：`listening-audio.ts:33` `~/.hermes/cache/ltutor-tts`。
