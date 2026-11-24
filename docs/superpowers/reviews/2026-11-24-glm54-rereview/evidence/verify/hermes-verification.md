# 核验轮账目（Hermes 仓 H1/H2 部分）· 2026-11-24 10:42–12:10

> 接续 coordinator-verification.md（该文件由两个子代理代做的 V-H 部分因 5 小时用量上限失败、未产出，本文件是协调者亲做的替代）。
> 纪律：两仓 git 层面零改动（全程 `GIT_NO_LAZY_FETCH=1` 只读 git；协调者自己起的 pytest/python 一律带 `PYTHONDONTWRITEBYTECODE=1` 与 `-p no:cacheprovider`；脚本与日志全在 /tmp/review-verify/）；不 import 仓内代码做 SDK 解析（解析器只加载已装 SDK）；零网络；零服务重启；密钥零读取。
> 留痕如实记录（均在 gitignore 内、与 live 网关自己会写的字节码等价，未清理）：① rooms/groups 测试运行期间（10:52–11:01）live checkout 里有 40 个 `.pyc` 被重写（gateway 34 / hermes_cli 4 / agent 2）——测试用例自起的子进程未继承环境变量所致；② `fork_gate.sh` 自带的 pytest 不带 `no:cacheprovider`，在非 live worktree `hermes-merge-20261104` 里更新了既有的 `.pytest_cache/v/cache/nodeids`。
> 环境：live env `hermes-3.11` = mcp 2.0.0 / mcp-types 2.0.0 / anthropic 0.87.0 / openai 2.24.0 / pillow-heif 1.6.0（importlib.metadata 实测，与 pyproject/uv.lock 一致）。

## 一、H1 未核验项逐条

| # | 未核验项 | 做法 | 结果 | 结论 |
|---|---|---|---|---|
| 3 | `fork_gate.sh` F821 段在 9ce27798f4 | `fork_gate.sh <worktree hermes-merge-20261104>` | **①F821 九热区绿**（ruff 0.15.10，isolated+py311）；脚本整体 exit 1 的唯一原因 = 清单第 12 项 `test_mcp_oauth_issuers_match_pinned.py` 是 11-08 才加的文件、在该提交不存在（`ERROR: file or directory not found`），非真红 | **成立**；11-04 报告的「F821×9 绿」复核为真 |
| 3′ | 同提交的 pytest 段 | 只跑该提交存在的 11 个目标 | **259 passed / 2 skipped**（18.30s），与 11-04 报告的 259p/2s 逐数吻合；268 = 259 + issuers 钉测试 9 例 | **成立** |
| 1 | rooms/groups 抽测「39 passed」 | 前轮 4 文件临时清单未落盘不可复原 → 改跑**全家族**：文件名含 room/group 的 132 个测试文件 | **1088 passed / 2 failed**（492s）。两败全在 `tests/tui_gateway/`（`test_groups_capabilities_reason.py::test_approvals_off_…`、`test_hosted_room_peer_progress.py::test_peer_poll_uses_…`） | **强于原声明**：fork 侧承载干净；两败与 fork 无关（见下） |
| 2 | 259p/2s 量级 | 同 3′ | 实测即 259p/2s | 非预期量级，是精确值 |
| 4 | SDK 深层调用参数未逐一签名比对 | **全树 AST 扫描**（10,947 个 py 文件）+ 钉版真实现解析，见 §三 | import 232 条：裸露失败 **0**；模块属性链 114 条：失败 **0**；SDK 资源方法调用 110 处（含测试）：kwargs/位置实参不符 **0**；`**变量` 展开 26 处的静态键集合不符 **0**（仅内部标记 `_moa_prepared_request`，调用前被 pop/由 MoA facade 消费） | **成立且加强**：全树范围无「第四颗钉版雷」 |
| 6 | mcp 1.x 裸 import 炸点形态 | 本机恰有 1.x 环境：conda base 1.21.2 / rdagent4qlib 1.25.0 / `~/.hermes/profiles/zops/venv` 1.26.0。逐条试 non-test 的 32 种 mcp import | 三版本一致：**裸露失败 3 处**（`tools/mcp_tool_events.py:100` `MCPError`、`tools/mcp_oauth_device.py:109` 与 `tools/mcp_oauth_manager.py:233` 的 `mcp.client.auth.oauth2 :: OAuthRegistrationError[, check_registration_usable]`），报错形态 `ImportError: cannot import name 'MCPError' from 'mcp.shared.exceptions'`；均为函数内惰性 import → 调用期才炸 | **H1-M3 成立，但举例需勘正**：H1 举的第二例 `mcp_tool_errors.py:162`（`from mcp.client.auth import OAuthRegistrationError`）在 1.21.2–2.0.0 **全部可解析**，不是炸点；真正的另外两处 H1 没点到 |
| 7 | 48fd4fb495 对 issuers 测试注释的勘正 | 读全 diff（+6/−1 行）+ 内存变异实跑（不改仓）+ mcp 2.3.0 真函数对照 | 「rstrip 翻转 8 例中仅 path+slash 一例」= 真（无脑 rstrip 变异恰翻转 1 例）；「strava 例 rstrip 本就保持不等」= 真；「strava 例拦根折叠类简化」= 真（根折叠变异**只**被 strava 例杀死，前缀匹配/origin 相等变异被 path+slash 与 strava 共同杀死）；mcp 2.3.0 真 `issuers_match` 对同 8 例 **0 不符** | **注释逐字为真**；升 SDK 后该钉子变 no-op、不会假红 |
| 5 | partial clone 限制 | 全程零 fetch（`GIT_NO_LAZY_FETCH=1` 下所有 diff/log/ls-tree 均成功） | 无缺对象 | 不构成限制 |
| 1′ | 前轮「当时运维取证」 | — | 时点性证据（config 备份 cmp、symlink 装载链、日志时间线）本质不可重放 | 保持「无法验证（性质使然）」 |

### rooms/groups 两败的定性证据
- `git diff --name-only 21ae0e1238 HEAD -- tests/tui_gateway tui_gateway` = **0 文件**：两个测试文件、被测 `tui_gateway/*`、`gateway/hosted_room_peer.py`、配置加载器全部与上游逐字节相同；fork 在 `config_defaults.py` 的唯一增量是 terminal `idle_timeout: 60`，与 approvals 无关。
- 两文件**各自单跑 3/3 全绿**；两文件同进程合跑时必红（顺序依赖）：先跑的 `test_approvals_off_…` 把 `approvals: mode: 'off'` 写进进程级配置缓存，后跑的两例即报 `HostedRoomPeerError: remote room execution requires manual or smart approvals`——这条机制已追到 `gateway/hosted_room_peer.py:281`。
- 全家族合跑失败的是另两例：`test_approvals_off_…` 自己（读到 enabled=True，说明缓存已被更早的用例填成别的策略）与 `test_peer_poll_uses_…`。后者根因未深挖，只确认「单跑绿 + 该路径与上游逐字节相同」。
- `tui_gateway/` 是上游自含 TUI 前端（fork_gate F821 范围明确排除、census 记 3253 条），不在教师面链路上。

### 73 个 import 了 SDK 的测试文件实跑（回归网是否静默失效）
- collect-only：**1954 用例、0 收集错误**（钉版下无「收集即炸」）。
- 实跑：**1936 passed / 2 failed / 16 skipped**（308s）。
- 2 败均与 fork 无关、且都是确定性的（单跑同样败）：
  1. `tests/tools/test_mcp_circuit_breaker.py::test_breaker_opened_by_tool_errors_says_rejected_not_unreachable`——上游 #11113 测试断言上游语义（错误载荷烧 strike），fork 故意改为「完成的 RPC 一律复位」（`_record_call_outcome`，由 fork 的 `tests/test_mcp_circuit_breaker.py` 钉住）。**属设计分歧红**，即 10-25 轮登记的 E-2；但该「永久 deselect」只存在于记忆/报告里——仓内 conftest / pyproject / pytest 配置零机械登记（grep `11113` 无命中），任何宽口径跑测都会再看到它，后来者可能误以为是回归去「修」fork。
  2. `tests/tools/test_transcription_tools.py::…::test_config_device_and_compute_type_passed_to_whisper`——上游代码对 Apple Silicon 强制 CPU/int8（`tools/transcription_local.py:_load_local_whisper_model` 的 `force_cpu` 分支，优先于用户配置），该测试在 arm64 Mac 上必败；fork 在该路径 0 改动。
- 16 跳：10 个 macOS sounddevice、4 个 botocore 未装、1 个 linux-only、**1 个与钉版相关**（`test_mcp_large_sse_event.py:101` max_sse_event_size，即 H1-M4）。读码时看到的另外 4 处按 SDK 版本跳过的 `pytest.skip`（`test_mcp_streamable_http_arity.py:143`、`test_mcp_dynamic_discovery.py:191`、`test_mcp_oauth_metadata.py:91`、`test_mcp_oauth_missing_iss.py:16`）在钉版下**均未触发**。

## 二、H2 未核验项逐条

| # | 未核验项 | 做法 | 结果 | 结论 |
|---|---|---|---|---|
| 6 | 14 份未读纯文档 | provenance + 机械体检（反引号里的路径/点分标识符/裸标识符对 HEAD 树），连同同类未列入的根 `CLAUDE.md`、`tools/`、`tests/CLAUDE.md`、ADR-001/README 一并覆盖 | 见 §四 | **新发现：整批陈旧** |
| 7 | `_should_emit_long_running_notification` 未逐行审 | 读 `gateway/run_shutdown.py:1191-1210` + 两处调用点（`run_turn.py:2088/:2127`）+ fork 测试 `TestLongRunningNotificationOwnership` | 四个停止条件（executor 完成 / `_draining` / `_restart_requested` / 会话槽换主）逻辑自洽；`turn` 是 dataclass 默认工厂字段，无空指针面；调用点在 awaited edit 之后二次校验（#10990）有 fork 测试钉住；`_running_agents` 是 `legacy_dict_property` 别名，fork 测试经它写入真实的 SessionState（非空转通过） | **无缺陷** |
| — | live 是否受 1.x 炸点影响 | 查进程与 plist | 主网关 pid 1019 跑在 `hermes-3.11/bin/python -m hermes_cli.main gateway run --replace`（mcp 2.0.0）；`~/.hermes/profiles/zops/venv`（mcp 1.26.0）只是 **zops MCP 服务端**（`Lan-WinRm/zops-mcp/server.py`、`gui_http.py`）的解释器，不承载 Hermes 客户端代码；该 venv 里 `mcp.types` 解析到 1.26.0 自己的文件、未被 `mcp_types` 2.3.0 遮蔽 | **当前零暴露** |

## 三、SDK 全树调用面扫描方法与残差

方法：`sdk_collect.py` 对全树做 AST 收集（import / 模块别名属性链 / 方法调用的 receiver 链与 kwargs 名）；`sdk_resolve.py` 在 live env 里用已装 SDK 逐条解析——`importlib.import_module` + `hasattr`/`find_spec`、`inspect.signature` 对直接 kwargs 与位置实参数、构造四个不发网络的客户端对象沿 receiver 尾链 getattr 解析方法；`sdk_kwargs2.py` 对 `**变量` 展开收集同函数体内写入该变量的字符串键。

解析到的 SDK 资源方法（全树含测试）：`chat.completions.create` ×84、`responses.create` ×13、`messages.create` ×3、`messages.stream` ×1、`audio.transcriptions.create` ×2、`audio.speech.create` ×1、`audio.speech.with_streaming_response.create` ×1、`images.generate` ×2、`videos.create/retrieve/download_content` 各 ×1、`ClientSession.call_tool/list_tools` 各 ×1。签名事实：同步/异步变体关键字参数集合一致；`responses.create` 含 `context_management`（33 个关键字参数），`chat.completions.create` 39 个、`messages.create/stream` 22 个。

归属校准：`chat.completions.create` 在 anthropic 客户端上只能剥掉 `chat` 后命中旧版 text-completions 资源（消费段数更少），按「消费段数最多」归 openai。7 条未解析的 SDK 形态尾链全部有主：5 条是 Hermes 自己的 MoA facade 方法（`agent/moa_loop.py:1095-1159` 的 `prepare`/`consume_*`/`last_reference_metrics`/`_fold_pending_accounting`），2 条是 Parallel SDK（`plugins/web/parallel/provider.py` 的 `beta.search/extract`）。

残差（静态扫描覆盖不到的）：① 跨函数拼装、动态键的 kwargs 字典只能近似；② 对 SDK 响应对象的运行期属性读取（如 `chunk.choices[0].delta.model_extra`）无类型推断、未校验。这两类目前由 live 网关多周运行兜底。

## 四、新发现：fork 自带「AI 上下文文档」整批陈旧（H2·Minor，清理价值高）

体检数据：raw/doc-audit.md（嵌套 19 份）、raw/doc-audit-root.md（根 CLAUDE.md 对上游 AGENTS.md）。

- **事实**：H2 标「未读」的文档全部是 fork 作者 2026-04-08 / 04-14 / 05-06 提交的（`3d499d0f6b`「add comprehensive AI context documentation and ADR system」、`ba32f9f265`、`1387266545`），加上同批但未列入清单的根 `CLAUDE.md`、`tools/CLAUDE.md`、`tests/CLAUDE.md`、`docs/adr/001`、`docs/adr/README.md`，共 **21 份 5,570 行**：根 `CLAUDE.md`（701 行）+ 9 份嵌套 `CLAUDE.md`（gateway/agent/hermes_cli/plugins/acp_adapter/cron/environments/tools/tests）+ `docs/adr/` 11 份（001–008、CHANGELOG、FEEDBACK、README）。此后上游从 v0.13.0 演进到 v0.23.0+616（三次合并数万提交），它们**一次没实质刷新**（根 `CLAUDE.md` 最近一次实质同步是 05-08 的 `acd93d315d`，11-08 只改了基线一行）。
- **占 fork 增量的比重**：`git diff 21ae0e1238 HEAD` 共 86 文件，这批文档占 **21 个（24%）**。上游在相同位置只有 `AGENTS.md`（根 + 13 个目录），没有任何 `CLAUDE.md` 或 `docs/adr/`。
- **陈旧度实测**（反引号路径引用仍存在的比例）：`environments/` **0/19**、`plugins/` 2/16、`acp_adapter/` 5/15、`cron/` 5/12、`gateway/` 9/23、`hermes_cli/` 17/23、`tools/` 19/23、`agent/` 27/29。失效样例：`gateway/platforms/{telegram,discord,slack,…}.py`（上游早已迁到 `plugins/platforms/`）、`cron/{executor,persistence,parser,notifier}.py`、整个 `environments/` RL 训练框架、`plugins/memory/{mem0,honcho,holographic}`、`hermes_cli/cli.py`、环境变量 `HERMES_CRON_ENABLED`、`ACPServer`、`HermesBaseEnv` 等。
- **并存冲突**：根目录与 7 个子目录（agent/cron/gateway/hermes_cli/plugins/tests/tools）同时有上游现行的 `AGENTS.md`（根 `AGENTS.md` 163 行、11-06 更新）与过时的 fork `CLAUDE.md`；根 `CLAUDE.md` 还主动链接到这些嵌套文档与 ADR 导航图。按 `CLAUDE.md` 取项目指令的工具会读到 7 个月前的架构描述，而看不到上游的现行规则。
- **对 H2 两条 Important 的旁证**：`tools/CLAUDE.md:181-214` 把「空闲超时默认 60 秒」「`GIT_PROGRESS=1 gh repo clone` 输出进度」写成既定设计——前者说明 60s 是 05-06 的有意选择（H2-I6 的裁定依据），后者与本轮实测相反（gh 2.103.3 下 0 行进度，H2-I1）。
- **建议**（未实施，待用户裁定）：整批删除（fork-only 文件，上游不碰，删除零合并冲突、fork 增量 86→65 文件），或至少删与上游 `AGENTS.md` 并存的根/嵌套 `CLAUDE.md`。删除前无需备份（全在 git 历史里）。若想保留 ADR 里仍有价值的设计取舍，应改写到现行文档体系里而不是原样留着。

## 五、勘正记录

1. H1-M3 第二例（`mcp_tool_errors.py:162`）不是 1.x 炸点；真炸点是 `mcp_oauth_device.py:109` 与 `mcp_oauth_manager.py:233`。
2. W1 / 本轮前序把「熔断 3 次 ~60s」当作 mcp-server 防熔断设计的依据成立；但 fork 的 Hermes 对**应用级 MCP 错误不烧 strike**（`_on_failure` 遇 JSON-RPC 错误响应即复位，`_record_call_outcome` 对任何完成的 RPC 复位；`tools/mcp_tool_handlers.py:273-279/:750-757`）。mcp-server 注释里「抛 -32602 会被计入熔断」（`training.ts:810-835/855/871`、`api-client.ts:215`、`pptx.ts:15-17` 等十余处）描述的是上游行为，自 2026-08-24 fork 修复后已不是本机机制。防御性写法（返回教师可读文本而非抛错）本身无害且体验更好，继续保留；但注释理由已过时，live 技能里「连续 409 → 换 video_search、勿无限重试」的防熔断动机同样已不成立（作为绕开故障端点的手段仍有效）。

## 六、仍无法核验
1. H1 #1：前轮时点性运维取证（性质使然）。
2. 14 份文档的「语义正确性」只做了引用级体检，未逐段对上游现行设计做内容审读（结论「整批陈旧」不依赖逐段审读）。
