# Hermes vision 转写事故五方案 max 评审报告

- **日期**: 2026-09-15
- **评审对象**: 事故分析会话提出的五个优化方向（①超时调参 ②同图缓存 ③超时降级阶梯 ④先ACK+proactive投递 ⑤中断park-and-merge）
- **核验基线**: `~/Github/Coding-Agents/Hermes-agent` 工作树 @ `zops-vendor-patches` / `a001d44e4f`（工作树干净；editable 安装 hermes-agent 0.19.0 → 此 checkout；live gateway PID 9542 于 09-15 20:33 启动，death supervisor 指向本仓——即本报告全部行号即 live 行为）
- **日志证据**: `~/.hermes/profiles/lt-tutor/logs/{agent,errors}.log`，事故会话 `20260915_150404_295e271a`（09-15 15:04–15:23）

---

## 总裁定

**五个方向全部有真实价值，但两条事实性错误 + 一个机理误判导致优先级需要重排。**

1. **最高性价比不是①，是上游已有的 `busy_input_mode: steer` 配置**——方案⑤想要的 park-and-merge 语义上游已经实现，lt-tutor 加一行配置即可生效（需重启 gateway）。
2. **①可行但落点错了**：LLM 调用超时没有 `HERMES_VISION_*` env 覆盖，只能改 `auxiliary.vision.timeout`（yaml 热生效，无需重启）。
3. **③的前提不成立**：proactive resize gate 已在首次发送前收过一次分辨率；且日志重估显示瓶颈是**输出生成时长**（转写全文 1500+ 字 @ ~10-17 chars/s），降分辨率救不了它。有效替代是错误文案引导 + region 分段转写。
4. **②有价值但覆盖面被高估**："超时后重试秒回"不成立（超时无结果可缓存）；只有做 single-flight（在跑请求合并）才能救"中断放弃后重发"场景。

---

## 一、事实核验表

| 提案声称 | 核验结果 | 证据 |
|---|---|---|
| 新消息→中断→3s 宽限→`[Tool execution cancelled]`→模型重发 | ✅ 机制属实 | `agent/tool_executor.py:866-893`（放弃段）、`agent/interrupt_control.py:114-117`（reason="user sent a new message"）。行号提案写 867-876，实际 866-893，偏差可接受 |
| 超时线 180s | ✅ 但来源要说清 | 代码默认是 **120s**（`vision_tools.py:850` `_aux_call_kwargs(messages, model, 120.0)`）；180 来自 live 配置 `~/.hermes/profiles/lt-tutor/config.yaml:70` `auxiliary.vision.timeout: 180`（09-06 加的尾延迟保险） |
| `vision_tools.py` 支持 env `HERMES_VISION_*` 覆盖 | ❌ **对 timeout 不成立** | env 只覆盖 `download_timeout`（:76）和 `max_concurrency`（:100）；LLM 调用超时走 `_aux_call_kwargs` → `_cfg_auxiliary("vision")`，**只读 config.yaml，无 env 通道**。照提案设 env 会静默不生效 |
| 3 次 180s 超时是同参数重试 | ✅ 且重试者在模型层 | SDK 内部重试已禁（`auxiliary_client.py:187` `max_retries=0`，修 #54465 的 3× stall）；aux 层瞬态重试 `_is_transient_transport_error`（:3103-3104）只含 connection 错误和 5xx/408，**不含 timeout**。所以每次 180s 都是一次独立工具调用，模型收到错误后原样重发 |
| 注释 "Full-resolution-first was the 120s-timeout root cause" | ✅ 引文准确 | `vision_tools.py:614-616`（`_encode_for_aux_send` docstring）；WeCom 教材照片案例在 :264-274 |
| proactive 通道现成 | ✅ | `gateway/run.py` / `gateway/run_turn_runner.py` 有 proactive 面；busy ack 也现成（`gateway/run_busy.py:596+` `_compose_busy_ack_message`，`busy_steer_ack_enabled` 默认 True `display_config.py:26`） |
| ⑤ park-and-merge 需要上游策略层新机制 | ❌ **半错，这是最大的评审增量** | `gateway/run_config_loaders.py:241-244`：`busy_input_mode` 合法值 `{queue, steer}`，默认 `interrupt`；steer 模式 = `running_agent.steer(text)`（`interrupt_control.py:217-226`："Queue user text for delivery as its own user row after the current tool batch finishes (**no interrupt**)"）。**正是"工具跑完+新消息同轮投递"的 park-and-merge**。lt-tutor config 无任何 busy/gateway 段 → 用了默认 interrupt，事故由此来 |

## 二、事故日志全景（比提案"6 次"更完整）

会话 `20260915_150404_295e271a`，全部 vision_analyze 工具调用共 **8 次**（另有 1 次入口 pre-analyze）：

| # | 开始 | 结局 | 耗时 | 输出 |
|---|---|---|---|---|
| 入口 pre-analyze | 15:04:04 前 | ✅ 成功 | ~13s | 简述（随首条消息注入） |
| 1 | 15:04:32 | 🗑 被新消息中断放弃 | 34.9s | `[Tool execution cancelled]`（82 chars 占位） |
| 2（重发） | 15:05:15 | 🗑 被中断放弃 | 18.0s | 同上 |
| 3 | 15:07:13 | ⏱ 超时 | 180.32s | "Error analyzing image: Request timed out." |
| 4 | 15:10:45 | ⏱ 超时 | 180.33s | 同上 |
| 5 | 15:13:51 | ✅ | 146.09s | 1860 chars |
| 6 | 15:16:22 | ✅ | 82.93s | 1561 chars |
| 7 | 15:17:50 | ⏱ 超时 | 180.70s | — |
| 8 | 15:20:56 | ✅ | 151.84s | 1569 chars |

终态 15:23:42 回复用户，全链 19 分钟。教师 4 条消息全部进同一会话（interrupt 模式逐条打断）。

### 机理重估：瓶颈是输出生成，不是图片大小

- 入口 pre-analyze **同一张图 13s 完成**——因为它只要简短描述。
- 转写全文的输出 1561-1860 chars，按 glm 输出速率 ~10-17 chars/s 推算，生成即需 90-180s。
- 成功样本 83-152s 全部是长输出调用；180s 线正好切在分布尾部，3/6 挂掉符合预期。
- **推论**：降分辨率/降字节（③第一阶梯）压缩的是视觉编码时间，对输出生成时间几乎无影响——③的处方开错了病。同图 09-06 的"379KB 图 6.4s 实锺"（config.yaml:74 注释）是短输出调用，不可比。

## 三、逐方向裁定

### ① 调 vision 超时 — **采纳，修正落点与生效方式**

- 改 `~/.hermes/profiles/lt-tutor/config.yaml` `auxiliary.vision.timeout: 180 → 300`。**不能走 env**（无此通道）。
- `_aux_call_kwargs` 每次调用 `load_config()`（`vision_tools.py:53-59,700-702`）→ **yaml 热生效，无需重启**。
- 300s 安全性：串行工具 deadline 420s/每次调用独立计时（`tool_executor.py:110,773-780`），余量充足；delegate_task 式豁免不涉及。
- 代价：真失败的调用多挂 2 分钟——语音用户异步预期下可接受。
- 残余风险：①不解决模型盲目原样重试（3×180s 的浪费），要配合「错误文案引导」（见③修正案）。

### ② 同图转写缓存 — **方向采纳，设计修正，优先级下调**

提案宣称"被放弃后重发、超时后重试、甚至她重发图，都是秒回"——三只有一：

- ✅ **放弃后重发**：可救，且因为「放弃≠取消」几乎免费——`future.cancel()` 对运行中任务无效，daemon worker 继续跑到自然结束（`tool_executor.py:890-896`），结果只是被丢弃。底层 HTTP 请求**活着**。
- ❌ **超时后重试**：不可救。超时=请求死了，无结果可缓存；缓存失败结果属负缓存反模式，必须在失败时摘除 key 让重试真跑。
- ⚠️ **重发同图**：可救但 `(image_sha1, prompt)` 精确键太脆——模型每次生成 prompt 措辞可能不同即 miss。
- 设计要点：(a) hash 算在 `_prepare_image` 之后的 `resolved.data`（HEIC→JPEG 转换后、WeCom 签名 URL 过期无关）；(b) 做 **single-flight**（同 hash 在跑请求合并等待者），放弃重发场景才真正命中；(c) 只缓存成功、失败即摘除、TTL 当天；(d) 进程级字典即可（gateway pre-analyze 与 agent 工具调用同进程，共享命中）。
- 收益重估：本次事故只省 2 次放弃重发（~53s 计算 + 各一次排队），19 分钟→约 16 分钟。**是②①steer 三者中单项收益最小的**，但它是唯一防"用户重发同图"的，作为上游 PR 中期做。

### ③ 超时后换策略 — **处方修正：降分辨率证据不支持，改走文案引导 + region 分段**

- 降分辨率阶梯：**不采纳**。proactive gate（`_needs_proactive_aux_resize`，512KB/2048px）已在首次发送前收过一次；且瓶颈是输出生成（§二），再压分辨率不省时间。
- 切块并行：有效（每块输出短）但实现重，不建议现在做。
- **有效替代（两件，近零成本）**：
  1. **timeout 错误文案加降级引导**（上游一处字符串改动）：现在模型看到的就是 `"Error analyzing image: Request timed out."`（errors.log:4934-4939），无任何引导 → 原样重发 3 次。改为提示"上游超时；可先用 region 分段转写或先回复用户稍候"，模型的 3 次盲目重试至少有 1 次会换策略。
  2. **SKILL 层引导**：`vision_analyze` schema 本来就支持 `region` 参数（`vision_tools.py:915-926`，"re-call with a region to zoom"）。在 `lt-tutor` SKILL 的转写流程加一句"整页手写转写先按区域分段调用"，单次输出变短、天然避开 180s/300s 墙。SKILL 双份 cp 热部署（AGENTS.md 硬约束 5）。

### ④ 长任务先 ACK + proactive 投递 — **大半已被现有机制覆盖，剩余部分缓做**

- busy 时 ack 已存在：steer/queue/interrupt 三模式都有 ack 气泡（`_compose_busy_ack_message`），配 `busy_steer_ack_enabled`（默认开）。
- 配 `busy_input_mode: steer` 后：她 15:05 的第一条补充消息会收到 ack 并被 steer 进当前轮——「收到，转写中，好了发你」的体验基本达成。
- 剩余缺口仅"图刚到、转写尚未出结果时的主动进度告知"——需要新触发判断，且要和 zops 侧 WeCom 330s 投递约束联动。**等 1-3 落地验证后再议**。
- 注：330s 约束在 zops 侧流式消费（`/Users/berton/mnt/zops8`），本次未逐行核验。

### ⑤ 中断策略分级 park-and-merge — **降级为配置先行，上游 PR 缓行**

- **核心裁定：不必先改上游**。`busy_input_mode: steer` 就是配置化的 park-and-merge：工具不打断、文本批次后作为独立用户行投递、模型同轮看到工具结果+新消息（`interrupt_control.py:217-226` + `run_busy.py:475-522`）。
- 语音消息 steer 模式还带 STT 折叠（`_prepare_busy_steer_text`，#58780 修复）；图片附件自动降级 queue 不丢消息；`/stop` 在任何模式下仍可硬停（demoted tail 文案自带提示）。
- 事故反演：若当时是 steer，第一次转写 ~146s 跑完即成功，她的 4 条消息全在结果轮看到——**后续 7 次调用根本不会发生，19 分钟→约 2.5 分钟**。
- 上游侧：把"interrupt 默认对长任务不友好"的事故数据提 upstream issue 是合理的（9/29 multi-user PR 时顺带），但按工具标记/已跑时长动态 park 的策略改动复杂度高、收益已被配置覆盖，**不建议 fork 抢做**。

## 四、重排后行动清单

| 优先 | 动作 | 落点 | 生效 |
|---|---|---|---|
| P0 今天 | `display.busy_input_mode: steer`（确认 busy_ack 默认开） | lt-tutor config.yaml | **需重启 gateway**（`run.py:3476` 启动快照，handlers 不回读；今天非周日窗口可重启） |
| P0 今天 | `auxiliary.vision.timeout: 180 → 300` | lt-tutor config.yaml | **热生效**（每调用 load_config） |
| P1 本周 | SKILL 转写流程加"长图先 region 分段"指引 | 仓源+运行副本双份 cp | 热部署 |
| P1 本周 | vision timeout 错误文案加降级引导（小 PR） | 上游 `vision_tools.py:805-814` 错误模板处 | 随下次合并部署 |
| P2 中期 | ② single-flight 缓存（§三设计要点） | 上游 PR | fork→PR 路径 |
| P3 观察后再议 | ④主动进度告知（联动 zops 330s）、⑤上游策略 PR | — | — |

## 五、核验缺口（如实记录）

- zops 侧 WeCom 330s / Stream age 上限未逐行核验（`/Users/berton/mnt/zops8`），④联动设计前需补。
- 被放弃调用与重发调用是否同 prompt（决定②命中率上限）无法从日志确认（args 不落日志）。
- 事故时 15:13:46 有 "connection error on zai-coding-cn and all fallbacks exhausted"——aux fallback 链形态（fallback_chain + main agent model）未逐段核验，与①预算无冲突但值得知情。
