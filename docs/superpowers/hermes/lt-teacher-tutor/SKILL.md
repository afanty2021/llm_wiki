---
name: lt-teacher-tutor
description: LT师训MCP：内容生成（导图/学案/听力/计划）硬限制与工作流 + 师训数据问询/简报解读的坑与路径。
---

# LT 教师辅导内容生成（师训 MCP）

## 何时用
教师发来「出一张 XX 时态思维导图」「出学案/练习纸」「生成听力音频」「建学习计划」「查学习进度」，或发来课本照片要求基于课文出学案。

## 工具速查
| 请求 | 工具 |
|---|---|
| 思维导图 | teacher_tutor_mindmap |
| 学案/练习纸/知识海报 | teacher_tutor_worksheet |
| 课件 PPT | teacher_tutor_pptx |
| 听力音频（双人声 A=女 B=男） | teacher_tutor_listening_audio |
| 学习计划 / 短链 | teacher_tutor_plan_create / plan_link / plan_list |
| 进度总览 | teacher_tutor_progress |
| 语料检索 / 读文件 | llm_wiki_search / llm_wiki_read_file |

## 铁律
1. **内容必须取自真实语料**：先 `llm_wiki_search`，再用 `llm_wiki_read_file` 核实原文，禁止编造课文外内容——工具端同样要求并会拒绝。
2. **MEDIA: 行必须原样回显**：mindmap / worksheet / pptx / listening_audio 成功后返回一行 `MEDIA:/path/...png`，最终回复必须原样保留该行（独占一行，勿改写、勿包代码块），否则文件不会送达教师。
3. 回复结构：一句话确认 + 分支/板块摘要（忠实于真实语料）+ MEDIA 行。

## 硬性限制（超限即拒，报错会点名超限项）
**思维导图**：title ≤60 字；整图 ≤5 层（含主题）且 ≤60 节点；**分支 label ≤40 字**（中英合计，47/48 字均被拒）。长例句必须截短或拆行。

**学案**：2-4 个板块、每板块 1-4 块；title 1-40 字且**直接用主题名（不带「学案」等文档类型字样）**；subtitle/footer ≤60 字。
- text 行 ≤120 字；fill/boxfill/numbered 每行 **before ≤60 字**（题干+括号注记合计，最易超）；fill/boxfill/numbered ≤4 行/块。
- checklist ≤6 项 ×30 字；表格 ≤5 列 ×≤4 行，**单元格 ≤12 字**（表格行超过 4、单元格 13-14 字都被拒过）。
- **整版密度 ≤1000px**：3 个精简板块安全；「表格 + 多板块 + 长题干」叠加会超（实测 1086px 被拒）。策略：先按最少内容构造，被拒后逐条精简，不要一次塞满。

**听力**：≤60 行且 ≤3000 字符，单行 ≤600；慢速版 speed=0.85。

## read_file 路径坑
`llm_wiki_read_file` 只接受 search 返回的「确切 path」，但 search 摘要里的 path 可能**缺 `sources/` 前缀**：摘要给 `transcripts/200-Grammar-207c8d3a.md`，实际可读路径是 `sources/transcripts/200-Grammar-207c8d3a.md`。读不到时依次：① 换关键词再 search 拿新 path → ② 尝试加 `sources/` 前缀。

## 图片→学案工作流（教师发课本照片）
1. 先 `vision_analyze` 转录课文；若失败/超时，**重试 1 次后立即降级**到本地 OCR（macOS Vision 框架，见 `scripts/macos_vision_ocr.swift`：`swift <脚本路径> <图片路径>`，整页英文课文约 6 秒，识别质量好）。
2. 从转录稿提取画线句 / 目标语法结构 → 围绕**真实原句**构造填空、时态判断表、过去式变换等练习。
3. 用户发图后要求「根据图片内容生成学案」时，以 OCR 转录的课文为准，不要脱离图片自行发挥。

## 课件配图工作流（pptx 默认无配图）
`teacher_tutor_pptx` 产出**纯文字版式**（每页标题+全宽要点框，无任何图片）——不要交付纯文字版了事，教师会追问配图，主动按下面流程配：
1. matplotlib 生成教学图（时间轴、句式对照、读音卡片等）。中文字体必须 `addfont("/System/Library/Fonts/PingFang.ttc")`；解释器用 conda env **Ai-english-3.11** 的 python（有 pptx；系统 python3 无 matplotlib/pptx）。字体头、配色、版式参数、排版防坑见 `references/pptx-images.md`。
2. **每张图先 `vision_analyze` 校验再嵌入**：问「中文是否正常（无方框乱码）？文字有无重叠溢出？」——生成图的排版缺陷自查不可靠（实测 2/3 张有缺陷全靠 vision 抓出）。超时 ≠ 图有问题：换更简短的问题重试（长问题易超时）。
3. 嵌入用 `scripts/pptx_embed_images.py <课件.pptx> <spec.json>`（spec：页号→图路径；自动缩文字框、右侧置图、回读校验 picture 数）。
4. 嵌入完成以新 MEDIA 行交付新文件。
5. 封面音频 `audio_path` 硬限 ≤6MB：视频原声超限先压缩/截取（`ffmpeg -i 原声.mp3 -t 60 -b:a 64k out.mp3`，实测 7.2MB→469K），再传压缩版。

## web_clip 文章收藏（用户发微信文章链接）
- **先查库再收藏**：收链接前先 `llm_wiki_search` 文章标题关键词/主题词查重——命中既有概念页或同源原文页即不重收。李陆桂「先学好再教别人」等公众号系列早年已批量导入，概念页早已蒸馏在库（实例：2026-11-23 重收其 3 篇旧文，概念页 four-independent-extracurricular-tasks / shuci-shengyi / scientific-tutoring-methods 均已存在）。
- 判重口径：概念页正文与文章逐句对应 = 同源已导入，勿重收；仅主题相近但角度不同 = 增量，可收。
- **系列文章判重（上/中/下篇）**：同一作者、同公众号、同标题模式但标注不同部分（上/中/下 或 ①②③ 等）的文章属于**系列的不同部分**，即使主题相关也不视为重复。判重时注意：同一系列的不同部分应全部入库；仅当文章标题完全相同（无部分标注差异）或内容逐句与既有概念页对应时，才跳过。实例：李陆桂「国内外名家谈外语教育」上篇（国际名家 9 位）与中篇（国内名家 34 位）为不同部分，均增量。
- 收藏后回复附文章核心观点摘要（用户非教师会话，要点便于日后组教师专题时引用）。
- **正文完整性以 clip 存档为准（2026-11-24 实例）**：判断文章「正文缺失/图片化」前必须 `llm_wiki_read_file` 读 clip 存档原文核实——`web_extract` 预览可能只截到开头一小段（实例：李陆桂课前几分钟一文预览仅得对话片段，误判「其余内容图片排版」，实际 clip 管线已完整抓到全文约 3000 字）。**当 `web_extract` 返回内容 < 200 字时，即使 `error=null` 也视为「预览不可靠」，必须走 clip 存档核实**（2026-11-24 实例：某文 `web_extract` 仅返回标题行，实际 clip 管线已完整捕获全文）。微信正文里的空图位多为插入广告，不是正文配图，勿据此推断缺文。
- **正文手工入库通道（验证码墙无法冷却解除时的终态方案，2026-11-24 实证落地）**：冷却重试无效（验证状态绑 cookie 不绑 IP，服务端管线无法借用）→ 请教师在微信/浏览器打开原文把正文全文复制粘贴发过来 → 正文存 scratch 临时 md → `node scripts/manual-clip.mjs '<标题>' '<原文URL>' <正文.md>`（与 clip 管线同构：normalizeUrl→clipFileName→writeSource→upsertPage→embedPage→createIngestJob，复用 mcp-server dist 编译产物；token 走 TRAINING__ADMIN_TOKEN bind HuangZhengBo 拿 access；embed 405=已嵌入非致命）。入库后必须 `llm_wiki_read_file` 读存档核实全文完整再汇报。入库前先 `llm_wiki_search` 查重。实证：《补遗篇》《实话实说》两篇均已手工入库成功并双验证（存档全文+检索命中）。用户发来的 txt 文件可能是 GB18030/GBK 编码（企微导出常见），read_file 会判 binary——先 `file` + `iconv -f GB18030 -t UTF-8` 转码再入库。
- **`__biz/mid/idx/sn` 老链接两重坑（2026-11-24 实证）**：① 微信对这种非 `/s/短码` 形态（多为文中引用的老文）常触发 IP 级风控验证码墙（`wappoc_appmsgcaptcha` 拖动验证），clip 与 web_extract 均只拿到验证页而非「文章已删」——高频连续收文后更易触发；修复后工具撞墙回「提不了正文」，不要排延时重试空转——改用替代源或请教师粘贴正文，或用户浏览器打开拖一次验证加速解锁；搜狗微信等替代源不可靠勿浪费时间。② 修复前 web-clip 遇这类链接的重定向流会在 `res.body.destroy()` 处崩掉整个进程（UND_ERR_ABORTED unhandled）——已修复（`web-clip.ts` 给 body 挂 noop `error` 监听器消化销毁错误；11-24 20:54:05 起已加载；改 mcp-server 源码后 tsc 重建 + 杀 MCP 进程自动拉起即生效）；若再遇「clip 调用报 stdio subprocess lost 且复现」，先 tail `~/.hermes/logs/mcp-stderr.log` 定位崩溃点再修，勿盲目重试。

## 师训数据问询与简报解读（admin 回合）
- **跨教师查询身份口径（2026-11-16 更新）**：cron/系统回合传 wecom_userid 代查 plan_list/progress/profile_get 已实测成功（返回 identity_source="system"），可作简报核验手段（如核实某教师最新计划标题/建单时点）；WeCom 教师会话仍锁本人身份，教师侧会话传他人 id 必拒。拒绝语义未变时勿重试，换 training_overview 聚合口径。管理面聚合只有时间戳无提问原文，事件明细（payload）仍需 ADMIN_BYPASS 直查库。
- **例外：plan_create 可为他人建计划**（实测）：admin 会话带 wecom_userid 指定目标教师会成功（响应 identity_source="supervisor"）。
- **分享内容给教师工作流（视频或 wiki 资料均可）**：roster_search 拿 wecom_userid（名册只含个人教师，群组/部门名如「教务组」搜不到；同名先 clarify）→ 备料：视频走 video_search 拿 slug，wiki 资料走 llm_wiki_search 拿 concepts/ 路径并 read_file 核实 → plan_create(origin=chat, period_key 幂等, wecom_userid=教师)；items 可混排 kind=media（slug）与 kind=wiki_page（concepts/… 路径），label 写教学化标题，条目顺序即学习路径（问题引入→总纲→方法流程→量表工具→实战课例）→ 返回 /s/ 短链可直接转发。目标教师 id 只取 roster_search 返回，绝不猜。
- **「有没有XX培训资料」检索→交付链**：先 llm_wiki_search 主题关键词，read_file 核实 2-3 个核心概念页，以「概念页清单 + 配套课例视频」表格回复，并主动给出后续选项（推送计划/思维导图/学案海报/Excel）。勿用 video_search 找方法论主题——视频库 slug 按课例内容命名，方法论讲解多藏在课例转录的开场段，主题词通常搜空；命中的课例反而可作计划里的实战条目。用户逐级追加（整理成计划→推给某老师→出量表→Excel 版）时全部复用同一批已核实路径，勿重复检索。
- **教师衍生格式交付（量表/学案要 Excel 版）**：走 xlsx 技能——write_file 写 spec JSON → xlsx_create.py 构建 → xlsx_read.py --csv 回读校验 → MEDIA: 行交付。解释器用 conda env ppt-master-3.11 的 python（有 openpyxl 3.1.5；系统 python3 无）。量表类给判断列加 list 数据校验下拉（如 √/×/?）方便电子填写。
- **转发用链接（目标是群组或用户自行转发）**：不带 wecom_userid 直接 plan_create（计划落到 admin 本人名下，origin=chat + period_key 幂等），把返回的 /s/ 短链交给用户转发。短链永活、点开现签凭证，接收者进度各自独立记录。
- **video_search 用宽关键词**：用户转述的片名与库内 slug 常有出入（「幼儿英语整体启蒙介绍」整句搜返回空，实际 slug 是「幼儿英语启蒙整体介绍」）——用主题关键词（如「启蒙」）+ limit≥10 检索后语义匹配，不要照抄用户原话整句搜。
- **提问原文（ask payload）在 DB**：存 src-server 库 `learning_events.payload`；管理面没有跨教师读事件明细的端点（/progress 是本人 token 才可查），只能 ADMIN_BYPASS 直查数据库。路径/端点/语法见 `references/admin-data-access.md`。crates/ 下无 src-server 代码（只有 llm-wiki-parser），路由在 src-server/src/routes/training.rs。
- **简报解读坑（用户已两次纠正）**：活跃时间聚类 ≠ 集体学习。**LT 平台每周日 19:00 定时发周报**——周日 19:00-19:10 的活跃聚类一律视为周报触达，非自发学习，简报中不得计为「昨日活跃/新档案起跑/回流」。实例：2026-09-13 与 2026-10-04（周日）19:00-19:05 多人「集体学习」均为当天 19:00 周报触达。日常简报 cron prompt 已写入此规则。
- **企微大文件收不到**：>100MB 无法下载；msgtype=file 还可能被网关判空丢弃（gateway.log 出现 "Empty WeCom message skipped"，未落盘）。对策：让用户把视频存到 ~/Downloads 并告知文件名，直接本地读取后 cp 到 `~/.hermes/cache/media_inbox/` 传给 media_extract（它只收白名单路径，但该目录实测放行）。
- **ADMIN_BYPASS 守卫豁免写法**：命令最前面加 `ADMIN_BYPASS=1 `（env 形式）；`ADMIN_BYPASS:` 带冒号会被 bash 当命令名报 command not found。
- **周日 19:00 周报会为每位老师自动新建 origin=weekly 的「本周学习清单」计划（每人 +1 计划、+3~4 条目，最近活跃时间戳即系统 plan_created 事件）**——周一快照里计划数集体 +1 属系统行为，勿计为教师操作；W44 起周清单选题疑似按近期提问个性化（实例：ggtms 10-31 问 TPR/幼儿拼读，当晚生成的 W44 清单即 TPR/低年段观摩主题）。
