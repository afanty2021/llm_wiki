# 师训 MCP 工具限制速查（实测拒收记录）

## teacher_tutor_mindmap
- title：1-60 字，同时作为根节点标签。
- 层级 ≤5（含主题）、节点 ≤60（24-28 节点/3 层为舒适区）。
- 分支 label：1-40 字。实测拒收：「root.children[2].children[1] 的标签 48 字符超过上限 40 字符」——中英文合计计数，含标点。
- 成功返回：`思维导图已生成（引擎 markmap；N 个节点 / M 层）` + MEDIA 行。

## teacher_tutor_worksheet
- sections：2-4 个（1 个或 5 个都会拒）；每板块 blocks 1-4。
- title：1-40 字，用主题名，勿带「学案」字样；subtitle/footer ≤60 字。
- 各块型上限：
  - text：≤120 字/行
  - fill / boxfill / numbered：≤4 行，每行 before ≤60 字（after ≤60 可省）
  - checklist：≤6 项 ×30 字
  - table：表头 ≤5 列 ×12 字，数据行 ≤4，单元格 ≤12 字
- 实测拒收：
  - 「items[0] 短语超过上限 60 字符」→ numbered 题干含课文原句时必超，截短+括号注记（如 `She 【】 (work) in music since she 【】 (win) at 12.`）
  - 「单元格 14 字符超过上限 12」→ 表格首列只放动词短语（`been working`），不放完整句
  - 「表格 5 行超过上限 4 行」
  - 「内容过密：预估排版高度 1086px 超出版心 1000px」→ 密度按全部块累计，精简到 3 板块以内、表格只留 1 个
- 安全模板：① 读中探究（numbered 3-4 题）② Grammar Focus（4 行表格）③ 练习（boxfill 3-4 行）。三者同上 = 约 1000px 边缘，优先砍题干长度。
- 成功返回：`学案海报已生成（N 个板块 / M 个内容块）` + MEDIA 行。

## teacher_tutor_listening_audio
- ≤60 行且 ≤3000 字符，单行 ≤600；speaker A/B 双人声，省略=旁白（女声）；慢速听力 speed=0.85。
- 返回含 MEDIA 行，最终回复必须原样回显。

## llm_wiki_read_file
- 只接受 search 返回的 path；search 摘要 path 可能缺 `sources/` 前缀（`transcripts/x.md` → 实际 `sources/transcripts/x.md`）。报错固定为「未找到文件：…（本工具只接受 search 返回的确切 path）」。

## teacher_tutor_pptx
- slides：3-10 个内容页（封面自动生成，总页数=内容页+1，典型 5-8 页）；每页 heading 1-30 字、bullets 1-6 条 ×1-80 字、note ≤120 字（进演讲者备注栏，不上幻灯片）。
- title 1-40 字且直接用主题名（勿带「课件」等文档类型字样）；subtitle ≤60 可选；theme 仅 warm。
- 成功返回：`课件已生成（N 页，含封面）` + MEDIA 行。
- 产物为**纯文字版式、无配图**；配图流程见 SKILL.md「课件配图工作流」与 `references/pptx-images.md`。
- **audio_path ≤6MB**（封面音频）：超限用 `ffmpeg -t 60 -b:a 64k -i in.mp3 out_60s.mp3` 截 60 秒压缩（实测 7.2MB→469K 即过）。
- **内容页超 10 拒收**（实测 12 页被拒）：视频/长内容按「概览 1 页 + 主体两两合并 + 讨论/作业 1 页」压进限页；10 个地点类内容 7 内容页即可。
- slides 入参格式坑：每页必须独立对象（heading/bullets 同级）；一次 JSON 里混入非法字段会报「slides[N].heading is required」。

## 海报/绘图（260921 实测）
- matplotlib 海报：仓耳今楷字体 `~/.hermes/skills/kami/assets/fonts/TsangerJinKai02-W05.ttf`（书法感，fm.fontManager.addfont 加载）；整数画布坐标，升级分辨率按比例安全替换 pairs 表（漏改一处就错位）。
- 必 vision_analyze 复检；按意见修复后再复检一轮（实测两轮通过：光晕硬边→多层低透明渐隐、落款对比度、兔耳造型、倒影长度）。vision 超时≠图有问题：换更短问题重试。
