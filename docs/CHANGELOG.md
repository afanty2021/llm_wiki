← [CLAUDE.md](../CLAUDE.md)

## 📋变更记录 (Changelog)

### 2026-09-15 - 视频学习任务（主管分享→回执→周报考核）全案收官 + 合并后跟进
- ✅ **全案交付**（计划 max 评审 Ready Yes → SDD T1-T6 → 终审 Ready Yes，feat 8cacd780..6d492596 并 main，终审报告归档 9d956134）：src-server 三读端点 member-role/media/search/roster（全 require_training_admin）；MCP 主管越权门——SUPERVISION_TOOLS 白名单分发层判定（仅 mismatch 查会话者角色、fail-closed 三臂、identity.ts 保持纯函数）+ video_search/roster_search 两工具（roster 反泄漏恰两键契约用断言钉死）+ 检索端点 404 转正常文本防熔断；SKILL §11 主管六步流（userid 只准来自 roster_search、建单不传 period_key 防 C1 同日异视频静默丢、按标题判重）+ §4.8 视频讨论 + 周报学习任务段；案 B pending 提示（plan_list/profile_get 尾 hint，零网关改动）；media/search 相关度排序（LOE 试跑大水漫灌生产修复 f1bee4f4）+ 序断言回归钉（cc5f5c10，评审唯一 Important）；T5 三 admin（Carina/Wendy/HuangZhengBo）+ T6 真人验收（分享→观看→complete→周报段全链）
- ✅ **合并后三跟进**（终审 Rec-2/Rec-3 + Minor 记档，用户指令逐次修掉）：① plan_create 主管 override 前目标 member-role 预查——不在名册即拒（正常文本防熔断+引导回 roster_search）/查询失败 fail-closed 抛错，user/system 路径零往返，根除猜错 userid 被服务端自动 bind 脏档案（4571463e，mcp 179/179 绿+SKILL 双份部署+网关重启）；② t6gate_ 前缀收编 SWEEPS users 扫描——registration_gate_test 注册残留存量 12 行一轮收清归零（b4eac867，training 24/24 绿）；③ 本笔 CHANGELOG 补账 + 终审报告「合并后跟进」处置表（7 条编号 Issue 全落点）
- 🔧 主动通知维持现状（主管转发链接给老师，教师下次使用时见提醒），Hermes Case A push 未实施——用户裁定；另：手动 fire 的 cron 周报结构上不投递（detached 进程无 WeCom 通道，delivery_outcome=failed），真投递以周日 19:00 builtin 班次为准

### 2026-09-15 - /t/ 播放检查点心跳化 + max 评审 fix-forward
- ✅ **心跳化**：早检点（10s 或 5% 时长先到先发、仅 25% 前有效，36a31efb）+ 每 60s 真实播放一条检查点（acc 口径——seek 前跳不触发、暂停不计时）+ ended；25/50/75% 稀疏 marks 撤除（352bc749）——续播粒度 25% → 1 分钟，预算≈时长/60+2 条（/play 独立桶 60/min 实占 ~1/min）；已部署 live 并真机验收。动机：真机验收 13s 短观看无续播点、5 分钟观看只能续到 25%（36a31efb 曾只垫地板检点，用户复核指正未达「加密」本意）
- 🔧 **max 评审（Ready: Yes，0C/1I/5M）fix-forward**：I-1 早检点地板对齐——客户端阈值改 `Math.min(10, Math.max(5, d*0.05))`，与服务端 resume 噪声过滤 `pos >= PLAY_CHECKPOINT_FLOOR_S` 双端共用一常量（此前 ≲90s 短视频早检点取整 <5 落库即被吞、观看 <60s 无心跳=零续播点）；M-3 阈值常量 format! 注入模板+数值断言单测（跨端阈值交互不再只靠形状断言）；M-1 rate_limit /play 注释旧「≤4 beacon」口径更新为心跳化实况；M-5 模块头补 /play 端点与限流条目（M-4 卸载尾段 visibilitychange flush 留档不修）

### 2026-09-15 - ingest_queue 环境红定谳根修：集成测 Redis 钉 DB1
- ✅ **集成测 Redis 隔离根治**：setup_test_app 统一压平 redis_url DB 序号为 /1（pin_test_redis_db 无段追加/带段覆写幂等 + 6 断言守卫单测，c9e7c2c1）——定谳根因=DB0 是 live 队列，launchd src-server 的 ingest/research worker 无限超时 BRPOP `ingest:queue`/`research:queue`，测试入队 job 被抢真跑/断言 LLEN 归零即环境红；ingest_concurrency_test 旧「手工 REDIS_URL=.../1 必守」口径收编进代码不再依赖 env
- 🧪 全量验证绿：ingest_queue 3 连×2 + 全套件 lib 377+集成 127 + ignored ingest_reliability 8 + ingest_concurrency 11 零失败；跑测全程 DB0 LLEN 恒 0 live 无扰；DB1 无消费者，残留条目跨轮无害累积（文档化已知取舍）

### 2026-09-15 - AGENTS.md 收编 + CHANGELOG 补账
- ✅ **AGENTS.md(=CLAUDE.md)**：版本 0.6.10→0.6.11+fork、Last Updated 09-14、CI 门用例数实测刷新（2394+/174 文件）、快速入口补 safe_resolve 现行口径、硬约束新增 #8 摄取 license 红线（ECE CC BY-NC 禁商用不可整库摄取）（09b0f00d）
- 📄 CHANGELOG 补齐 2026-08-23→09-14 缺口（本笔，13 笔战役）

### 2026-09-14 - 降噪+去重防线（PR #8）+ CI 存量红修复（PR #9）+ LT 全库质检收官
- ✅ **降噪+去重防线**：merge inflation watch 搬 merge_stats+阈值收紧 100%/20KB（51a8d06b）+ dedup-skip/零页源结构化计账+全跳过告警（67ba179b）+ 修复性重投 SOP（f32792d6/f6e91717/0fb49a06）+ succeeded_with_warnings 认终态三处齐改（1dff0b4b）——立项源自 1829 条虚增实锺分解（去重仅 999 页/45% 跨批重复）；计划评审三轮（2bfe8b7e/c69ad6cb/d6418bad）后 SDD 实施，PR #8 并 15dfdedc、双半边部署验证生效
- ✅ **CI 存量红两簇修复（PR #9）**：safe_resolve 祖先上溯——缺失中间目录不再 500（85c620ae，base 自 ecb675a0 随项目创建落盘）+ transcriber 标点测试注入 deps.apiKey 破 CI key 门短路；跟进 8e1d7fd8 函数文档对齐两分支实现、ada7bd4e `..`叠缺失段 500→400 BadRequest + 穿越单测真踩上溯分支硬断言
- 🔧 **三轮 launchd 重载均 live 冒烟实证**（手签 JWT 差分探针：list 缺失 /wiki 500→200+[]、DELETE wiki/none.md 500→404、sub/../../x 重载前后 500→400）；CI 含 PG+Redis job 全绿
- ✅ **LT 全库质检+七项修复收官**（live 数据运维）：测试残渣 2123→1397、12 孤儿章闭合（重投先删 ingested_files 行），库终态 16,004 页
- 🧪 safe_resolve 单测×4（缺失中间目录差分/穿越两形态 400 断言）；max 评审全部 Issues/Minors 关闭

### 2026-09-13 - 概念合并清理闭合 + LOE 师训批 + Think 系列收官
- ✅ **概念合并清理专项闭合**：touch-guard 触达守卫通用化——expected_pool 构造固化入工具（466b4b69，触达误报三连根修）
- ✅ **LOE 师训批（21 源）**：240 页/零静默跳过（f3e2a04d）+ 检索别名 loe（223f827c）；Think 教材 2e 09-13 系列收官（剩余项不摄，回访信号=教师检索 miss）
- ✅ /t/ 断点续播：play_progress 回读 data-resume 注入（290a972e）；Tier-2 See-Also 写入方 + P1.5 空页定题批（37b898fc）
- 🔧 Hermes 上游 2948 切换：教师 MCP 工具三层根因全修 + 周报 cron 三关 + blocked_config 收口（跨仓，live 验收）

### 2026-09-12 - 概念合并清理 S1/S2 甄别器 + /t/ 播放遥测部署 + 护栏 v2
- ✅ **概念合并清理专项**：charter r2.1+put_page 空 fm 根治（5b6fabad）→ S1 甄别器（title 归组类型无关+双 prompt+plan-builder 桥 07a4ae12，评审跟修 c609785c）→ S2 Tier-1 跨命名空间甄别器（f5eb7360）+ cmd_merge 同形改写守卫（ef3e1c81）
- ✅ **/t/ 播放遥测+watched 投影**：migration 020（4336997b）+ play_progress 事件面——看完/扫一眼可区分（0d45d322），09-12 部署 020 记账齐；计划评审三段 Approve（25e61e28）
- ✅ 护栏 v2：incoming sources 只保路径形态 + citations 出口（801f9869）；relocate_citations 非数组标量 coerce 保原值（50d38c5b）
- 📄 视频学习任务（主管分享）实施计划 40a2df1e 待评审；ECE 两 BookDir 入库随批（检索别名 ece/1000h 041e4de2）

### 2026-09-11 - sources 归因修复大专项（§五~§十一全链）
- ✅ **根因链**：step2 模板示例教出 source.md 占位符（81e81028）→ 写循环 sanitize_sources 兜底（5ce91986/1c4a7619）→ 存量 backfill-sources.py 三 tier 匹配回填（干跑/执行双模 5ae6167d，jsonb null 兼容 1a1cb394，备份批间换行 217ad544）
- ✅ 未决批辅助 enrich-unresolved（rank-2 证据底稿 c4e7baba）+ 出生窗口约束解析器（CJK 感知评分 ccd52240）+ embed-attribution（771cc95a）；§五~§七 行动项收口（da80f45a/3162cc27/6bf05b05）
- ✅ I9 显示名 sources 确定性映射 v1/v2（7e9c72e5/d831850e）+ v3/v4 四族收割（1ef49e33/39f12e0e/48a4a35e）；--verify 诚实分账+假通过洞封堵（11697142/5afc7a65）
- 🔧 MCP read_file 双形态根修——search 返回的 wiki 虚拟路径可读（4cab471a，已部署）；学案/导图渲染 ENOTEMPTY 根修（进程组击杀 e1c77e2b）+ 教材缩写检索别名（7a949c52）
- 📄 方案评审收口：C1/C2 阻断项+I1-I9+M1-M9 全核实并入（7cfa471c）

### 2026-09-10 - 教师工具两件套：思维导图 v2 markmap + 学案海报
- ✅ **teacher_tutor_mindmap**（12 号）：v1 graphviz→v2 markmap 渲染（graphviz 自动回落 1cf7f6eb）+ 两轮评审跟修（d0a09e7a/ca633f70）
- ✅ **teacher_tutor_worksheet 学案海报**（13 号，混合路径 Chrome 截图 3074306b）+ 评审 C-1/I-* 跟修（14d16a91）+ 学案设计参考附件（b0cb0b4c）+ nature 主题视觉升级（e4ca5374）+ 标题/题号确定性清洗（6cd289f6/7ab360cb/cfddb87f）
- 🔧 存量 HEVC 批转收官（教室 Win10 hvc1 事故兜底；全库 hvc1 零 hev1）

### 2026-09-08/09 - 概念图谱红链根治 + /tmp 存储元数据死链根除 + 转写质量批
- ✅ **红链根治**：wiki-cleanup 三批工具（红链回填/实体合并/迷你残渣，干跑+备份纪律 5ab5c542）+ 合并口同降级（557fdf6f）+ LLM 语义甄别 adjudicate-merge（thinking disabled 防截断+断点续跑 5e483074）+ scaffold-purge（95d47b3d）——红链回本底 0.01%，评审复验 Approve
- ✅ **/tmp 存储元数据死链根除**（ecb675a0）：create 路由按 project_base 记录、default.json 指真实根——Mac 重启清 /tmp 事故系列收口；**此后项目 base 随创建即落盘**（files 端点语义前提变更点）
- ✅ 转写：课例中文摘要跨语言检索锚（39ff42dc）+ abstract-backfill 38 页存量回填（b1362c77）+ 守门人工复核出口 TRANSCRIBER_GATE_ALLOW（b6e51322）+ 退化守门循环证据下限（fffa98b8）
- ✅ embed 批次四件套加固（分批双帽+逐页回落+收官对账 aa1fadbe）+ embed-backfill 存量缺向量回填（7b0065be）
- 🔧 bind 身份大小写归一——Wendy/wendy 双档案根修（bd8907bd）；put_page 形参 frontmatter 并集落库（f6bbb59a）

### 2026-09-06/07 - LAN 双路径同 URL 分流 + llm-wiki-admin + 图片→听力音频 + admin-tool-guard
- ✅ **校内直连/校外隧道同 URL 双路径**：dnsmasq 分支 spec（a16f5d43）→ 部署工件+runbook（f8be8bda）→ Caddy 转系统级 LaunchDaemon（特权端口 root 盲点 29f9ee94）→ Phase A/B 评审收口（8676c6a3）→ 真机验证回写（教师手机直连全链+蜂窝回归+延迟 A/B 数据 ae42bd69）+ dnsmasq bogus-priv（21b32931）——09-06 收官零遗留
- ✅ **llm-wiki-admin 管理面 server**：training_overview 一跳答管理问题（7195fac2）+ 过滤器两边界+渲染清洗（727ad125）+ 总览时间戳 Asia/Shanghai 渲染（3317ae69）
- ✅ **teacher_tutor_listening_audio**：图片→听力音频工具 + SKILL 流程 6（4776384d）；计划 r2 Approve with fixes 收口（e760dc18）
- ✅ **admin-tool-guard**：pre_tool_call 守卫拦 terminal 直查师训管理数据（d4ed9f86）+ 评审五项收口（10f47906）
- 🔧 SKILL 会话延续：快速路径 session_search+白名单 13（c18019b9/3d95bce7）；转写窗级退化守门+幻觉清单扩容（a87ac4a9/43808df9）

### 2026-09-05 - 教师周报开办链 + 检索 rerank opt-out
- ✅ **周报开办链**：开办脚本路由/platforms/任务三件事原子幂等（df8482de）+ 自动开办巡检+record_ask 校验（5f523b77）+ 排程周日 19:00（65b46a40）+ 去头尾包装/带名称呼（fd874222）+ display_name 回落 wecom_userid（67409cb3）+ 评审两轮跟修（14f766e1/6e9b7a81）+ 停发名单 N1 运营裁定（bf356afb）
- ✅ search `?rerank=false` opt-out——教师 MCP 搜索砍 6s 延迟税（839b0a34）+ 评审 M1/M2（f658e226）

### 2026-09-02 - 直播回放批两热修
- 🔧 LLM 调用 900s 总超时兜底（e9e6fb8a）+ bigmodel thinking 关闭+step2 零块观测防线（d7378ed4）——直播回放批零页源根修

### 2026-08-30 - ingest 并发化全案（设计→实施→终审，已并已部署）
- ✅ **两段分离**：生成段 buffered(N)+channel 并发、归并段按源序串行（6b07a75e）+ Phase1Output/dispatch 去重进度计数不变量纯函数（12423bd5）+ 429/限流归 transient（8aeb1f85）+ 配置面/并发度 clamp（b82a9e7c）
- 🧪 路由 stub 基建+并发正确性/确定性归并/N=1 等价/取消 drain 三用例/resume 隔离/429 瞬态（48575d36/acc4f919/05553b14）；web 摄取面板 stage 中文映射（5046319b）
- 📄 设计 r1/r2 Approve（98a0a195/2b9c745e/b9b78601）+ 计划评审 4I+M-3 收口（12cd3077/de7b323b）；集成测 Redis DB1 隔离裁定（e40be6f9，live worker 共库抢跑实证）

### 2026-08-27~29 - 转写管线强化批 + lt-tutor 问卷收敛
- ✅ 标点/切章管线切 glm-5.3-flash（bf5802a5）+ 并发转写 --concurrency（e1d6c448）+ --dir 目录子串白名单（c3219ad6）+ Whisper 幻觉过滤（转写层+存量净化 ea6684a7）+ 回填 --base-url 绕行 contentFilter（c7b93abc）
- 🔧 评审 Important+Minor 三项收口（467becf2）；lt-tutor 问卷三修：去任教科目题/年级多班问法/grade_levels 三学段枚举（59f169d5/ab46fd05/d80356fa）

### 2026-08-24~26 - 视频语义重切 + web Files/Links 补齐 + 标点管线全链 + v0.6.11 上游合并
- ✅ **语义重切 rechapter**：摄取链接入 LLM 话题切章、失败回落机械 300s 不阻塞（0ad6430a）+ 存量重切脚本（预检门逐字节一致才动 03a032c3）+ 评审两轮收口（cuts 快照持久化堵复活通道/90s 超时/50 章上限 f1a838df/e67c8b07）
- ✅ **web 端 Files/Links 补齐批**：Sources 卡片解析并入存储 raw 清单（9ff5a6af）+ Links 面板可用三修（f85d3bbf/e15aaa02/1875630e）+ Files 树副标签显示衍生页标题（9cbfd68a/d422d72e/42e59c73/db291d09）+ list_dir 排序对齐桌面语义（3887f52d）+ 阅读区键盘滚动/中文首行缩进（8994b290/0e62e7ad）+ 存储源前缀读写同源（be62858d）
- ✅ **标点管线全链**：转写正文标点恢复+语义分段与存量回填（ec3e689d）+ 块级密度门堵偷懒回显（c210a2b8/7e66e11a）+ 偷懒重试预算 2→4→8 枪（408b4efd/d7f133b7）+ 回填三处一致性缺口评审 I1-I5（104f547a/b8a5b914）——239 页回填放行
- ✅ upstream v0.6.11 合并 + release（e8082119）；媒体签名严格三段式验签（M1 兼容回落移除 a6f69489）；embedding 端点 Bearer 鉴权（omlx 08-26 强制 b2d2d1a2）+ Debug 脱敏（5008e42b）；slug 规则中文化 CJK 进文件名（fe8f11d5）；MCP wecom_userid schema 隐去防弱模型抄示例值（d3612e73）

### 2026-08-22 - LT 师训系统 M3（身份会话级绑定 + overview + 周报 cron + 技术债收敛）
- ✅ **身份会话级绑定（结构性根治 prompt 注入冒用）**：Hermes `_meta` 身份戳（tools/call 注入会话身份，agent 线程捕获 + strict 读取）+ mcp-server `resolveIdentity` 三态硬闸（用户模式/系统模式/两类硬拒 fail-closed，10 工具接闸，wecom_userid schema 放开可选）——三层 live 证实（meta 实弹/SKILL 4 拒/协议探针 S1-S3）
- ✅ **GET /api/v1/training/overview**：管理总览（require_training_admin 常量时间比较、三预聚合子查询、items_7d 周报口径）+ weekly `period_key` 服务端自算（ISO 周收口，杜绝 LLM 手算；400 含 expected_period_key 改口重试）
- ✅ **周五周报 cron**：SKILL 流程⑤（系统模式编排）+ per-teacher job（分钟 cksum(uid)%15 散列错峰 09:00-09:14，deliver wecom 单聊直推）+ `weekly-report-register.sh`（add/list/remove/fire）；幂等 live 三证；T9 实测 cron catch-up 单次补跑——补跑双通道语义回写 spec §5.3
- ✅ **技术债两批（r3 收编）**：items cap/409 文案/归档事件闸/非对象不缓存/beacon+/s/ 限流 429/registration fail-closed/withinWindow 含端/healthSrc 降级链路/重试收窄/PUBLIC_T_BASE 必填/回滚原子化/teardown SWEEPS
- 🔧 **T8 E2E 三热修**：SKILL 清单视频优先硬规则（39e42b69）/章节小数秒解析（0f7b542b）/read_file 404 改正常返回防 Hermes 熔断误伤（990eac2b）——安卓 OPPO PHJ110/Android 13 HEVC 原件直播成功（M4 转码退役依据）
- ✅ **计划外：wiki 中文化批次**（止血→577 页翻译 v2/v3→2 页污染根因修复（关 thinking）→全量审计 LLM 保真 4.87/流利 4.92→标题收口（英文 title 25 全为品牌）→23 页非 slug 收编，图 650→633）+ 恢复工具/收编工具 105 测试
- ✅ **计划外：upstream v0.6.10 试合并草稿**（merge-upstream-trial 05ac9031：40 冲突全解 + 8 处语义破损修复，三套测试绿，待正式合并）
- ✅ **T9 重启演练**：自愈链 9/9（reboot→容器 47s→launchd 全起→隧道/omlx/iogpu→inbound 15.5s 回复）+ cron catch-up 实测（停机盖过触发→起后 5s 自动补跑）
- 📄 **灰度 runbook**（`docs/superpowers/deploy/m3-gray-runbook.md`：3-5 教师加白/每日 5 分钟观察/一周退出判据/异常处置）
- 🧪 src-server lib 269 + integration 107/107 · mcp 54/54 · transcriber 130 · E2E v3 live 全绿（冷启动/对抗三连/鉴权矩阵/周报三连 fire）
- 📈 验收：`docs/superpowers/specs/m3-acceptance-2026-08-22.md`（计划外中文化与 upstream 试合并单列切割；偏差与遗留逐项披露）

### 2026-08-20 - LT 师训系统 M2（learning 域 + 企微通道 + 基础设施）
- ✅ **服务端 learning 域**：migration 014（plans/items/events + period_key 部分唯一）、JWT typ 隔离（access/plan_link 互斥）、training API（profile/events/progress/plans/link/complete + 事件投影：单调守卫/幂等/归属 404）
- ✅ **/t/ 教师落地页**：view 事件同事务、seen 双粒度 beacon（Option\<Json\> 空 body 兼容）、XSS 五字符转义先转义后 linkify、媒体签名 fingerprint 三段式（Rust/TS 双锁向量）、`playsinline` 三连（iOS 企微 WebView 必需）、**/s/ 短链**（303 现签跳转，根治 LLM 转发截断）
- ✅ **MCP teacher-tutor 工具组**：src-server 形态 10 工具、TeacherCredentialStore（600/原子写/single-flight/bind 自愈）、BASE_URL fail-fast
- ✅ **Hermes 企微通道**：lt-tutor profile（platform_toolsets 白名单）、owner keep-route 路由防劫持、SKILL.md 四流程 + 身份硬规则 + 对抗 dry-run、deploy.sh 四态（含字节级回滚）
- ✅ **基础设施**：/ingest 项目鉴权 + /t,/media,/s 日志脱敏、launchd 保活（src-server/cloudflared/omlx-8001/iogpu-42GB）、重启自愈链（Docker 登录项 + unless-stopped）
- ✅ **前置收编**：step1 max_tokens 32000 + usage/截断日志 + 解析失败自动重试（瞬态兜底）、transcripts/ 命名空间守卫、bind advisory lock、compose prod 真实可启动（try_parsing/with_list_parse_key）、夜窗重转 48/48 + ingest 48/48（首批全量）
- 🧪 cargo lib 242 + integration 98 · vitest 123 · mcp node --test 27 · E2E live 全链（iPhone 真机播放/完成投影/白名单拒绝/鉴权矩阵）
- 📈 验收：`docs/superpowers/specs/m2-acceptance-2026-08-20.md`（偏差与残余风险逐项披露）

### 2026-06-15 - 日志系统阶段 2/3 完成 + 级别持久化
- ✅ **阶段 2 — 请求追踪传播 + Error 桌面通知**
  - 前端 `invokeTraced` 封装（`src/lib/invoke-traced.ts`，自动注入 UUID v4 trace_id，空串防御）
  - 后端核心命令 `#[instrument]`（fs/embedding/vectorstore，spawn_blocking 命令用 `Span::current().enter()` 跨线程传播）
  - Error 通知：`NotifyLayer`（自定义 tracing Layer）捕获所有 ERROR，经 `run_on_main_thread` 调度（macOS 主线程安全），10s 时间窗口去重，设置开关
  - 依赖：`tauri-plugin-notification` + 手写 `Switch` 组件（非 radix）
- ✅ **阶段 3 批次 A — console 迁移 + 采样**
  - 前端 202 处 `console.*` → Logger Facade（46 文件，唯一例外 main.tsx 的 initLogger catch）
  - 时间窗口采样器（`shouldSampleAt` 纯函数 + `shouldSample` 包装，默认 Infinity 关闭，ERROR 免疫）
- ✅ **阶段 3 批次 B — read_log_file 命令 + 应用内查看器**
  - `read_log_file` 命令（分页 JSONL 读取，逻辑反序，级别/关键字/trace_id 后端过滤）
  - `LogsSection` 查看器（设置新章节：级别 toggle chip + 关键字搜索 + trace_id 过滤 + 分页 + ERROR 高亮）
- ✅ **级别持久化**（补齐阶段 2 缺口）：`set_log_level` 写入 app-state.json，`init_logging` 启动恢复（重启不丢失）
- 📊 新增文件：logging/{config,notify_layer}.rs、invoke-traced.ts、error-notification-config.ts、logs-section.tsx、switch.tsx
- 🧪 测试：前端 1415 + 后端 logging 35 个测试全通过
- 📈 设计/计划/验证文档：`docs/superpowers/`（阶段 2 + 阶段 3 批次 A/B）

### 2026-06-14 - 日志系统阶段 1 实施
- ✅ 新增统一日志基础设施（前端 Logger Facade + 后端 tracing Layer）
- 📊 前端：`src/lib/logger.ts` + `logger-types.ts` + `src/commands/logging.ts`
- 📊 后端：`src-tauri/src/logging/`（types/router/manager/mod 四文件）
- 🔧 配置 UI：`logging-config.tsx` 集成在 GeneralSection
- 🔧 已迁移：62 处 `eprintln!` → tracing 宏（保留 fs.rs 测试 7 处）
- 🧪 测试覆盖：11 个自动化测试全通过（前端 7 + 后端 4）
- 📈 新增 `## 关键特性 / 9. 日志系统` 章节

### 2026-04-13 12:30 - 深度补捞完成
- ✅ 完成阶段 C 深度补捞，覆盖率从 95% 提升到 98%
- 📊 深度分析 118 个文件，35 个模块
- 🔧 完善核心算法文档（四信号相关性、Louvain、多阶段检索）
- 🎯 补充架构洞察（数据流、性能优化、错误处理）
- 📈 更新索引到最新状态

### 2026-04-13 - 初始化AI上下文文档
- ✅ 创建完整的 AI 上下文文档体系
- 📊 记录项目架构、技术栈和核心功能
- 🔧 提供开发指南和 AI 使用建议
- 🎯 明确模块职责和文件组织结构

