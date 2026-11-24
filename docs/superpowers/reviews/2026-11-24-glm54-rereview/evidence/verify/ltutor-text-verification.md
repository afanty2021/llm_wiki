# 核验轮账目（W1 技能文本面：未核验项 5/6/7）· 2026-11-24 12:10–12:50

> 接续 coordinator-verification.md；替代未产出的 V-W1.md。纪律同前：仓内零改动；MCP 注册表从 /tmp 拷贝的构建产物里直接调用两个纯函数 `srcServerToolDefinitions()` / `trainingToolDefinitions()` 导出（不起服务、不连 API、不读凭证库）。

## 注册表事实（mcp-server 构建产物导出，18 工具）

| 工具 | 必填 | 参数 |
|---|---|---|
| llm_wiki_search | query | wecom_userid, query, limit |
| llm_wiki_read_file | path | wecom_userid, path |
| teacher_tutor_profile_get | — | wecom_userid |
| teacher_tutor_profile_put | — | wecom_userid, display_name, subject, grade_levels, goals, interests, onboarding_state |
| teacher_tutor_record_ask | — | wecom_userid, payload |
| teacher_tutor_plan_create | title, origin, items | wecom_userid, title, reason, origin, period_key, items |
| teacher_tutor_plan_list | — | wecom_userid, status |
| teacher_tutor_item_complete | item_id | wecom_userid, item_id |
| teacher_tutor_plan_link | plan_id | wecom_userid, plan_id |
| teacher_tutor_progress | — | wecom_userid |
| teacher_tutor_listening_audio | dialogue | wecom_userid, dialogue, speed, title |
| teacher_tutor_mindmap | title, root | wecom_userid, title, root |
| teacher_tutor_worksheet | title, sections | wecom_userid, title, subtitle, theme, footer, sections |
| teacher_tutor_pptx | title, slides | wecom_userid, title, subtitle, theme, slides, audio_path |
| teacher_tutor_media_extract | media_path | wecom_userid, media_path, want |
| teacher_tutor_web_clip | url | url |
| teacher_tutor_video_search | q | q, limit |
| teacher_tutor_roster_search | q | q, limit |

## W1-5 Hermes 客户端熔断参数

- `tools/mcp_tool.py:517` `_CIRCUIT_BREAKER_THRESHOLD, _CIRCUIT_BREAKER_COOLDOWN_SEC = 3, 60.0` → 「3 次 / ~60s」**属实**。
- 但本 fork 对**应用级 MCP 错误不烧 strike**：`tools/mcp_tool_handlers.py:750-757`（`_on_failure` 遇 JSON-RPC 错误响应即 `_reset_server_error`，排除客户端自合成的 408/-32001/-32000，见 `mcp_tool.py:557-598`）与 `:273-279`（`_record_call_outcome`：任何完成的 RPC——成功或错误载荷——一律复位）。只有传输层失败（连接拒绝、超时、协议解析）才累计。
- 推论：mcp-server 里十余处「抛 -32602 / 抛错会被 Hermes 熔断器计入」（`training.ts:810-835/844-855/871-872`、`api-client.ts:215`、`pptx.ts:15-17` 等）描述的是上游行为；自 2026-08-24 fork 修复后本机已不是这个机制。**结论**：参数属实、动机过时。防御写法（返回教师可读文本）无害且体验更好，建议保留；live 技能里「同回合连续 409 → 改用 video_search、勿无限重试」作为绕开故障端点的手段仍有效，但其防熔断理由已不成立——回仓时按 W1 的建议改归因措辞即可一并修正（W1·Minor）。

## W1-6 references 与 SKILL.md / 注册表对账

对仓源技能目录（15 份 md）+ live 技能目录（15 份，含 live 独有 `parent-communication.md`）全量机械对账：

| 检查 | 数量 | 不符 |
|---|---|---|
| 工具名提及（`teacher_tutor_*` / `llm_wiki_*`） | 115 处 | **0** |
| 单行 `tool {json}` 期望调用的参数 ⊆ 注册表参数、必填齐备 | 22 处 | **0** |
| 跨行 JSON 调用示例（花括号配平解析） | 15 处 | **0** |
| 技能文件路径引用 | 89 处 | **0 真失效**（10 条是同目录兄弟文件的头注提及与 dry-run:472 的行文简称，文件都在） |
| 反引号参数名与邻近工具（启发式） | 216 处 | 20 条提示**全部为假阳**（逐条看过：档案字段 `goals`/`interests`/`grade_levels`、返回字段 `status`、worksheet 块字段 `items`、「不传 wecom_userid」的提醒） |

另核 `SKILL.md:69` 对 web_clip 返回的描述（`status`/`title`/`jobId`/`reply`/`prevClippedBy`/`prevClippedAt`）与实现一致（`web-clip.ts:780-787/875-878` + `training.ts:1527`；`sourcePath`/`pagePath` 未写进文档，无害）。

**结论**：文本面与工具面一致，W1 对「其余 references 不在本变更 diff 内」的处理没有漏下硬伤。语义级的逐段重读未做（前两轮已覆盖，本轮机械对账未见回退）。

## W1-7 dry-run 脚本 1–5 mock 值 vs src-server / mcp-server

| mock | 对照实现 | 结果 |
|---|---|---|
| `profile_get` / `profile_put` 返回 | `routes/training.rs:690-699` `TeacherProfileResponse` | 7 字段逐一相同 ✓ |
| `plan_create` 返回（`plan` + `items[]` + `link`） | `PlanResponse :939-947`、`ItemResponse :954-965`、link 由 `training.ts:1268-1272` 拼成完整 URL | 字段逐一相同 ✓；`items[].kind/target_ref/label/timecode_*` 与 `PlanItemInput :971-977` 一致 ✓ |
| `item_complete` 返回 | `ItemResponse` | ✓ |
| `progress` 返回（`plans[].items{total,viewed,completed}` + `recent_events`） | `ProgressResponse :850-853`、`ItemCounts :868-874` | 结构 ✓；**缺 `watched`**（播放进度功能 09-12 新增，dry-run 写于 08-18） |
| `plan_list` 返回 | `PlanListItem :1365-1370`（flatten + items） | ✓；同样缺 `watched` |
| `period_key mismatch` 400 文案 | `training.rs:1227-1231` | 逐字相同 ✓ |
| **`record_ask` 返回** | `create_event :825-847` 返回 `json!({ "id": id })` | **不符**：mock 写成完整事件对象 `{id,event_type,payload,created_at}`，真实只回 `{"id":N}` |
| **错误 mock 的 `code`** | `error.rs:9-20` 常量为 `RESOURCE_NOT_FOUND` / `VALIDATION_FAILED` | **不符**：mock 写 `not_found` / `bad_request` |
| **错误 mock 的形态** | `api-client.ts:766` 把 API 错误转成抛出的 `LLM Wiki API <status>: <message>`（McpError） | **不符**：真实工具层返回的是错误文本（如 `LLM Wiki API 404: Teacher profile not found`），不是 API 的 JSON body；mock 的 message 还小写了首字母 |
| `llm_wiki_search` 文本 mock | `formatSearchResults training.ts:1591-1608` | **形态不同**：真实输出是 `# Search results for "<query>"` + `## N. <title>` / `Path:` / `Score:`（6 位小数）/ `Snippet:` 分行结构，mock 是 `1. 标题 (path: …, score 0.91)` 紧凑行 |
| `llm_wiki_read_file` 文本 mock | `formatWikiPageRead :821-827` | ✓（真实多一行可选的类型/来源元信息） |
| 所有真实返回的尾块 | `withIdentitySource :939-943` 追加独立文本块 `identity_source: "…"` | 只有脚本 5 写了，脚本 1–4 的 mock 未提 |

**结论**：W1「mock 形状沿用旧册、风险低」的判断成立——调用侧（工具名/参数/必填）全部正确；返回侧有 4 类陈旧（record_ask 形状、错误码与错误形态、`watched` 缺失、search 文本格式）。影响面：人工 dry-run 时操作者按 mock 注入的返回与真实不同，但脚本的通过判据都不依赖这些字段；无教师面风险。记 W1·Minor，建议下次动 dry-run.md 时顺手刷。

## N-1 用户可见症状补证（真实微信链接，2 条）

生产同款 `extractArticle` + 回执模板（`training.ts:898-902` 逐字复刻）：

| 链接 | 取回 | Readability 标题 | 提取正文 | 按回执模板教师会收到（模板逐字复刻自 training.ts:898-902，未做端到端写库调用） |
|---|---|---|---|---|
| …/s/8-3hXT… | 3,852,075 字节 | 有老师说，他自己没有天赋，但照样能学好英语。你信吗？ | **56 字符** | 已收藏《有老师说，他自己没有天赋，但照样能学好英语。你信吗？》，稍后整理完成后即可检索 |
| …/s/dgAJIz… | 3,851,765 字节 | 活动多≠有效学习！如何才能真正做到＂有效学习＂？ | **54 字符** | 已收藏《活动多≠有效学习！…》，稍后整理完成后即可检索 |

标题正确、回执成功、正文几乎为空——教师会以为全文已入库，之后检索不到内容。取证范围说明：取回与提取是生产同款代码真跑，回执文案是模板套真实标题，未实际调工具写库。这把 N-1 的性质从「提取失败」明确为「**成功回执 + 空正文的静默丢失**」。
