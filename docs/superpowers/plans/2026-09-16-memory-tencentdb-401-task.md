# 小任务【已修复+根因定谳】：lt-tutor 档案 memory-tencentdb 401——钥的 .env 域与执行路径不匹配

**日期**：2026-09-16 · **状态**：✅ 已修复并 live 验证（本档案留作根因记录，经用户质询后二次定谳）
**更正史**：初版误判「倾向关插件」→ 一次改写补了 dotenv 回落与钥同步但根因表述不完整 → 用户质询「昨天测通今天为何坏、是不是启动方式不同导致取配置不同」后二次定谳如下。**插件是 09-15 多用户改造的主体功能，必须保留。**

## 精确根因（源码级定谳）

**Hermes 进程的 os.environ 来自「它自己的 home 的 .env」**：`hermes_cli/env_loader.py:366` 启动时 `_load_dotenv_with_fallback(<home>/.env, override=True)`。多路复用网关守护进程的 home=全局（`~/.hermes`），`--profile lt-tutor` 的 CLI 会话进程 home=档案（`~/.hermes/profiles/lt-tutor/`）。**不同启动路径 = 读不同域的 .env = 不同的 os.environ。**

| 层 | 事实 | 证据 |
|---|---|---|
| 服务端 | sidecar（node 9780，09-15 20:35 起）带 `TDAI_GATEWAY_API_KEY`（start-gateway.sh 从 .zshrc/.env 取）→ 对所有请求强制 Bearer | `ps -wwE` count=1；server.ts:512 checkAuth（opt-in，配了就全量强制） |
| 守护进程路径 | daemon（home=全局）启动时把全局 .env 灌进 environ；全局 .env 09-15 07:09 已写入该钥 → **默认档案会话一直有钥，从未 401** | 默认档案 agent.log 全史零 401；05:00 会话 capture 被 sidecar 接受落库 2 条消息 |
| 档案会话路径 | `cron run --profile lt-tutor` 的 CLI 进程读**档案 .env**——里面没有该钥 → 插件（当时只读 os.environ）取空 → 不带 Bearer → 401 | 08:47 fire 四连 401；我的工具 shell 实测 UNSET |
| 时间线 | 「昨天好好的」=昨天测通的是默认档案/shell 路径（钥都在）；「今天坏」=今天第一次出现**lt-tutor 档案带记忆的会话**（周报任务首跑要等周日 09-20，手动 fire 是该档案史上第一次），而档案 .env 从未配过钥 | lt-tutor log 401 全史仅 8 条、全部今日；gateway.out.log 无 08:47 会话 store 建档、有 10:06 会话建档 |

**不是「昨天到今天之间坏了什么」——是 lt-tutor 档案路径此前从未被走过， provisioning 缺口在首次实跑时暴露。** 用户的判断成立：启动方式（全局 home vs 档案 home）决定了取哪个 .env。

## 修复与各改动必要性复盘

1. **钥同步进 lt-tutor 档案 `.env`（09-16，必要且充分）**——多用户设计下各档案凭据本就应各自携带（`build_profile_secret_scope`：全局变量不进档案 scope），这是正路，与 zai 钥多副本惯例同构。
2. **插件 dotenv 回落**（TencentDB-Agent-Memory `6bb69f0`，防御纵深非本次必需）：Hermes 启动已把 .env 灌 environ，本 patch 对「进程启动后才改 .env」的长驻进程（免重启拾取）有真实价值，且与 Hermes 凭证惯例一致；经符号链接提交于源仓。
3. **网关 kickstart 重载**：对 CLI fire 路径非必需（每次 fire 都是新鲜进程），良性。

## 验证（三轮 fire 时间线）

| 轮次 | 结果 | 证据 |
|---|---|---|
| 08:47（补丁前，档案 .env 无钥） | 401 ×4（/recall、/capture、/session/end×2） | agent.log；sidecar 无该会话 store 建档 |
| 10:03（补丁生效、档案 .env 仍未补） | 仍 401——证实「档案 .env 缺钥」是独立第二层 | agent.log |
| 10:06（档案 .env 补齐后） | **零 401**；sidecar 全管线跑通（L0 capture 2 条 → L1 → L2 → L3）+ store 建档 | agent.log + gateway.out.log |

`Ran now: failed` / delivery_outcome=failed = 手动 fire 不投递的常态标记，非故障。

## 遗留

- 钥三副本轮换同步义务：`~/.hermes/.env`（全局，默认档案用）、`~/.zshrc`（shell 手测/侧车启动用）、`~/.hermes/profiles/lt-tutor/.env`（lt-tutor 会话用）。新增**其他档案**要用记忆插件时，同样要把钥配进该档案的 .env。
- 观察点：09-20 周日 19:00-20:00 周报窗实跑后，agent.log 应保持零 401、Gateway 侧应新增各教师会话 store 条目并跑出 L1/L2 管线日志。
