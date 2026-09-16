# lt-tutor SKILL 渐进披露拆分计划（references/ 外移）· r2

**日期**：2026-09-16 · **状态**：计划评审通过（Yes after fixes，本 r2 已吸收全部 7 Important + 6 Minor）；评审报告 `.superpowers/reviews/2026-09-16-skill-split-plan/report.md`
**目标**：把低频/上下文特化的流程从 SKILL.md 正文外移到 `references/`（Hermes skill_view 内建 linked_files 机制），核心文件只保留热路径与安全线；降低常驻上下文体积与指令稀释，**零内容删除**。

---

## 1. 机制实证（r2 修订：吸收评审 I2/I3 与 Minor 1/4）

1. **系统提示只进索引**：`prompt_builder.py:1207` `build_skills_system_prompt` → `_render_skills_index`（:1291-1341）只渲染 name+description；`agent/system_prompt.py:299-308` 同样只走索引（focus 模式仅降为 names-only）；SOUL.md 是独立 identity 槽（load_soul_md:1452），无正文内联通道。**27.6KB 正文只在 skill_view 后驻留会话，不在 system prompt。**（评审源码级复核通过）
2. **正文按需加载**：`tools/skills_tool.py:520` `skill_view` 首调返回 SKILL.md 全文 + `linked_files` dict + usage_hint；file_path 双重路径安全（`has_traversal_component` 字面预检 + `validate_within_dir` resolve 越界判定，`tools/path_security.py:7-18`）。
3. **references/ 是正牌 support 目录**：`SKILL_SUPPORT_DIRS=("references","templates","assets","scripts")`；`_LINKED_FILE_SPECS`（skills_tool.py:361-365）references 下 `*.md` **非递归**自动列入 linked_files；索引/manifest walk 双双排除支持目录（不生成幽灵技能）。**技能根目录散置 .md（worksheet-lesson-notes.md）不在 linked_files**——它由 `_serve_skill_file`（skills_tool_plugin.py:68-102）通配服务，属另一条通道；今后详情文件一律放 references/（严格更优）。
4. **工具面就绪**：config.yaml wecom 与 cron 两 platform_toolsets 均含 `skills`；cron 会话经 `_resolve_turn_toolsets`（gateway/run_turn.py:2135-2158）走同一路径——cron 回合能走 skill_view→references。
5. **压缩行为（r2 改写，评审 I2）**：`_SKILL_VIEW_PRUNE_MIN_CHARS=5000`（chars 非 bytes）只是「剪枝后是否附 reload 标记」的阈值；Pass-2 对超 `_PRUNE_MIN_CHARS=200` 的工具结果**一律降为单行摘要**（`[skill_view] name=teacher-tutor (N chars)`，**不含 file_path**），lean-tail 模式另有 1,500 chars 降级线。即：核心与引用文件陈旧后都会被降级，引用文件降级后**无 reload 标记**。恢复路径是两跳：核心带 `[SKILL_PRUNED]` 标记重注入 → 重读核心 → 桩/快速路径再指路重读引用。**「多步流中途被压缩」是显式场景，靠指针链自愈。**
6. **去重安全网**：skill_view 去重桩按 (name, file_path, mtime+size) 键控；压缩时 `reset_skill_view_dedup` 被真实调用（conversation_compression.py:3053-3054）——压缩后重读不会被去重桩挡住。
7. **快照 manifest 不含 references**（评审 I3）：`_build_skills_manifest` 只收 SKILL.md/DESCRIPTION.md（prompt_builder.py:1112）——manifest 仅作索引缓存失效用；references 就位的唯一判据是 harness `linked_files` 实测。

## 2. 现状盘点（r2 刷新）

- 基线：**main @ 5504e79，工作树 clean**——07:53 评审 Minor 回补波已全部落库（3d04436 SKILL、dede178 CLAUDE.md、61b42b6 provision 错峰、5504e79 rename 脚本）；live SKILL.md = 仓源逐字节一致（md5 dcbf239e，27,590B）。
- frontmatter+标题实测 801B（非旧稿 ~590B）。
- 消费方清单（r2 补全，评审 I4）：快速路径表、§0、cron **已烤 prompt**——jobs.json 6 个 `lt-tutor-weekly:*` prompt 与 provision-teacher-weekly.sh:104 模板均**字面引用「技能 §7 流程 5」**（路标桩必须保 §7 编号）；历史评审报告引用 §8-§11。
- 协调风险已消：工作树 clean，无未提交编辑方。

各节字节数（实测）：frontmatter+标题 801 ｜ ⚡快速路径 3,038 ｜ §0=2,025 ｜ §1=1,415 ｜ §2=4,675 ｜ §3=1,262 ｜ §4=2,125 ｜ §5=1,890 ｜ §6=819 ｜ §7=1,763 ｜ §8=1,617 ｜ §9=1,255 ｜ §10=2,108 ｜ §11=2,397 ｜ §12=387。

## 3. 设计原则

1. **热路径内联**：答疑/清单/完成/进度/引导与全部安全线（§0/§1/§2）留正文。
2. **特化上下文外移**：cron 专用（§7）、校长专用（§11）、多步生产流（§8-§10）。
3. **引用文件自包含（r2 加固）**：头部四要素——触发条件、身份要点一行复述、输出硬规则一行复述、**核心节映射行**（指向主文件对应 §，主文件不在上下文先 skill_view 重载）；正文内跨文件悬空引用（「同 §8」「同流程 3」）一律内联实质要点。
4. **快速路径行 = 指针 + 承重骨架**（r2 修订）：骨架**不砍**（放弃 −400B 目标，评审 I1/I5），但必须内嵌事故线索级承重短语——听力行带「整页密集图先 region 分块再转写」（09-15 视觉超时事故 hot-fix，e3b8be49）、主管行带「仅系统识别的校长会话」门与「roster_search 唯一合法来源」。**承重短语白名单**：安全门前置+§0-3 拒绝、userid 唯一合法来源=roster_search、MEDIA 原样回显、链接一字不差、整页图先分块。
5. **零删除**：外移内容原样搬运（含行内要点内联增补）；只允许改写——快速路径行路由词、§2 repoint、§0-4 指针、桩。

## 4. references/ 文件规格（5 个新文件）

目录：仓源 `docs/superpowers/hermes/lt-tutor/references/`；live `~/.hermes/profiles/lt-tutor/skills/teacher-tutor/references/`。

| 文件 | 搬运内容 | 头部四要素 + 内容内联修补（评审 I6） |
|---|---|---|
| flow-weekly-report.md | §7 全文 | 触发=仅 cron（`identity_source:"system"`）；**必须显式带 userid** 复述；链接硬规则一行；映射行（流程 3=主文件 §5）。内联：「做法同流程 2」→ 实质（2-3 个不同措辞查询、limit 5）；「要求同流程 3（含视频优先硬规则）」→ 实质（media 视频项为主体 ≥2 且占多数、wiki_page ≤1 仅延伸、严禁概念页凑数、宁少勿凑） |
| flow-listening-audio.md | §8 全文 | 触发=老师发图要求转听力；交互不带 userid 复述；MEDIA 一行；region 分块与 ⟨?⟩ 占位已在正文，头部再强调 |
| flow-mindmap.md | §9 全文 | 触发=导图；MEDIA 一行；多张每张一行 |
| flow-worksheet.md | §10 全文 | 触发=学案/海报/据图出学案；MEDIA 一行；`worksheet-lesson-notes.md` 在技能根目录（`skill_view` file_path 读取，非 references）。内联：「同 §8」→ 实质（整页图先 region 分块 2-4 次再拼接，整页一次转写会撞上游视觉超时） |
| flow-supervisor-video.md | §11 全文 | 触发=**仅系统识别校长会话**，普通教师按 §0-3 拒（复述）；roster_search 禁猜 + plan_create 名册预查拒绝兜底强调；回执如实。内联：「防重复手法同流程 3 第 0 步」→ 保留并附实质（先查目标近 7 天已推计划，重复先确认再决定） |

## 5. 核心 SKILL.md 改动明细

### 5.1 快速路径表（4 行改路由词，骨架保留并带承重线索；注脚改指向）

- **听力行**：`走**流程 6**：① skill_view("teacher-tutor", file_path="references/flow-listening-audio.md") ② 按其执行——骨架：vision_analyze 转写（**整页密集图先 region 分块再转写**）→ 老师确认 → teacher_tutor_listening_audio 合成 → 回显 MEDIA: 行（§1）`
- **导图行/海报行**同构（指针 + 原骨架保留）。
- **主管行**：安全门前置与 §0-3 拒绝指引**原样保留在行内**；指针 + 骨架（video_search 报候选 → roster_search 取 userid（**人名→userid 唯一合法来源**）→ plan_list 按标题查重 → plan_create（标题含视频名）→ 如实回执）。
- **周报注脚**：「§7 周报是 cron 系统回合专用流程——教师交互回合直接忽略它」→「周报流程（原 §7）是 cron 系统回合专用——教师交互回合直接忽略；cron 回合先读 references/flow-weekly-report.md 再执行」。
- 「§3-§11 流程执行」句 →「§3-§6 流程执行；媒体/主管/周报流程见 references/（各指针在快速路径行内）」。

### 5.2 §0 身份硬规则（1 处小改）

- §0-4「（见流程 5）」→「（流程详见 references/flow-weekly-report.md）」。其余五条**一字不动**。

### 5.3 §2 工具白名单（4 处 repoint + 豁免单点收口）

- 三媒体工具行与 vision_analyze 行的「参数见 §8/§9/§10」→「参数与全流程见 references/flow-*.md」。
- 调用纪律「白名单外工具一律不调用」→「**教师任务工具**白名单外一律不调用（`skill_view` 读本技能 references/ 文件除外，不计入白名单）」——单点收口，标题不动。

### 5.4 §7-§11 原位替换为路标桩（评审确认承重：jobs.json 6 个已烤 prompt 字面引用「§7 流程 5」）

每节一行桩，例：`## 7. 流程 5：周报生成（cron 系统回合）——已外移：先读 references/flow-weekly-report.md（§0-4 与 cron prompt 指路）。` §11 桩额外带「§0-1 主管例外与安全门前置仍以核心为准」。

### 5.5 体积预期（r2 修正算术，评审 I1；单位口径：bytes，复审后补记）

核心实测 **20,250 bytes**（-26.6%；全口径核算 27,590 − 9,140 + 桩 1,011 + 快速路径 +494 + §2 +254 + §0 +36，逐项闭合）。验收线 **≤20,480 bytes（20 KiB）**——实测 19.78 KiB 线内通过；decimal 读法 20.25 KB 超线 1.2%，实施后复审裁定可接受（削桩负收益）。**本文与后续文档体积一律用 bytes 表述或标注 KiB。**质量收益：多数回合（答疑/清单/完成）不驮 9.1KB 无关流程；§11/§7 只在对应上下文出现；压缩后两跳指针链自愈（§1.5）。

## 6. 部署与验证

1. **实施前基线检查**：git status clean + live=仓源 md5 一致 + 重读当前文件。
2. **双备份**：live `SKILL.md.bak-<ts>`（既有惯例）；references 为新增目录。
3. **部署前干验证（不动 live）**：python harness 直调 editable Hermes `_skill_linked_files` 对**仓源技能目录**：linked_files **恰为 5 文件**（不多不少，评审 Minor 2）、逐文件可读、核心含五桩不含外移正文。
4. **部署 = 双份 cp（本次扩展）**：live references/ 为新建（无残留合并问题）；`cp SKILL.md` + `cp references/*.md` 至 live。回滚 = **git revert 仓源拆分提交 + 备份回写 SKILL.md（两处必须同步）**——只回写 live 的话，任何后续会话按约束 5 做例行双份 cp 都会把拆分版静默打回（收口评审 I1）；孤儿 references/ 保留无害（核心不再指向，linked_files 仍广告但不被引用——runbook 明示此态）。
5. **部署后核验**：live harness 复跑（恰 5 文件）；core 字节数 ≤20KB；snapshot manifest 的 SKILL.md 指纹更新（manifest 不含 references——§1.7，非验收项）。
6. **周报 cron 手动 fire（必做，评审 I4 升级）**：首个周日窗（09-20 19:00-20:00）前完成；选一个 `lt-tutor-weekly:*` 任务手动 fire（`--profile lt-tutor`，既证口径：验内容不投递），核验模型走「核心→§7 桩→读 flow-weekly-report.md→执行」全链；观察日志确认引用文件被读取。副作用知情：手动 fire 会幂等创建本周 weekly 计划（period_key 服务端幂等，周日实跑时按 §7-6 改口「已生成」并正常投递）。
7. **AGENTS.md 口径同步**（编辑落点=CLAUDE.md）：dede178 已含缓存语义与 19:00-20:00 窗口径——**仅剩一项**：热部署条款补「references/ 目录一并双份 cp」。
8. **提交**：git add 限定 SKILL.md、references/、CLAUDE.md、本计划文档；普通提交说明（工作树已 clean，无「在场内容落库」问题）。

## 7. 风险与回滚

| 风险 | 缓解 |
|---|---|
| 模型不读引用文件凭骨架自由发挥 | 两步式行内①②；§8 听力行骨架带「先分块」事故线索；桩指路；skill_view 自带 usage_hint；**手动 fire 活体验证**（§6.6） |
| 多步流中途被压缩（r2 新增） | 降级摘要无 file_path→自愈靠两跳指针链：核心 `[SKILL_PRUNED]` 重注入→重读核心→桩/快速路径指路重读引用；去重桩压缩后自动重置（§1.6） |
| 并行会话踩踏 | 工作树已 clean；实施为单笔快速提交 |
| 回滚 | SKILL.md 备份回写即回滚（纯文件操作）；孤儿 references/ 保留无害 |

## 8. 验收清单

- [ ] 核心文件 ≤20KB；含 §0-§6、§12、快速路径、五桩；不含外移节正文。
- [ ] linked_files 实测**恰为 5 文件**（仓源与 live 双端）；逐文件可读。
- [ ] 每个 reference 头部四要素齐全；跨文件引用已内联实质；07:53 回补内容原样在核心。
- [ ] §2 白名单完整 17 工具；豁免单点收口句在位；骨架承重短语五项核对通过。
- [ ] CLAUDE.md 补 references/ 双份 cp 一句。
- [ ] 周报 cron 手动 fire 全链实证（读引用文件），在 09-20 周报窗前完成。

## 9. 收口评审遗留记档（09-16，均为 Minor 记档级）

- 调用纪律豁免句字面只覆盖 `references/`，未覆盖技能根目录的 `worksheet-lesson-notes.md`（§10/flow-worksheet 引导 skill_view 读取它）——下次触碰 §2 时把豁免句改为「读本技能文件（references/ 流程与根目录笔记等）除外」。
- flow-weekly-report 头部映射行只有「清单生成手法=主文件 §5」一条，缺其余四文件都有的 §0/§1/§2 三锚——下次触碰该文件时对齐。
- 插件侧两条：`_resolve_gateway_api_key` 单测四用例（env 优先/dotenv 兜底/缺文件降级/无钥）在下次动该函数前补；轮换陷阱已落插件 docstring（见 401 任务档案）。
