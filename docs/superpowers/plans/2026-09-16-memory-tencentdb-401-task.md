# 小任务【已修复】：lt-tutor 档案 memory-tencentdb 401——客户端钥未进服务进程

**日期**：2026-09-16 · **状态**：✅ 已修复并 live 验证（本档案留作根因记录）
**更正说明**：本档案初版曾误判为「插件配置缺口、倾向关插件」——错误。memory-tencentdb 是 2026-09-15 刚完成多用户改造的主体功能（多用户 stores、provider identity chain、api-key enforcement，源仓 /Users/berton/Github/AI-Infra/TencentDB-Agent-Memory），401 的真实根因是**客户端钥没有进到服务进程的取钥路径**，修复方向=补齐取钥链，插件必须保留。

## 根因（三层叠加）

1. **Gateway 侧**：09-15 多用户改造落地了 api-key enforcement（服务端要求 Bearer，缺失即 401 `missing Bearer token`）——这是新行为，之前无鉴权所以从未暴露。
2. **插件侧缺陷（主因）**：`_resolve_gateway_api_key()` 只读 `os.environ`，**无视 Hermes 凭证惯例的 `~/.hermes/.env`**（Hermes 其他凭证全走 `get_env_prefer_dotenv` 会查 .env）。而 launchd 网关与 cron CLI 会话进程都不经 shell，`.zshrc` 的 export 进不去。
3. **钥副本缺口**：钥当时只落在 `~/.hermes/.env`（全局）与 `~/.zshrc`——shell 里手工测试通过（.zshrc 生效）掩盖了缺口；lt-tutor 档案 `.env`（profile 会话的取钥文件）里没有。

典型的「客户端钥多副本轮换要同步」陷阱的变体：这次不是漏同步某一份，而是**消费代码不读 .env**，同步了也白搭。

## 修复（两件，均已落地）

1. **插件补 dotenv 回落**（源仓 TencentDB-Agent-Memory commit `6bb69f0`，main 分支）：os.environ 未命中时回落 `agent.credential_pool.get_env_prefer_dotenv`（查 .env + 1P scope，不查 environ——与上面循环互补不重复）。Hermes-agent 的 `plugins/memory/memory_tencentdb` 是指向源仓的**符号链接**，改源即改 live 代码。
2. **钥同步进 lt-tutor 档案 `.env`**：`TDAI_GATEWAY_API_KEY` 从全局 `.env` 程序化复制（2026-09-16）。此后三份钥落点（全局 .env / .zshrc / lt-tutor .env）轮换时需同步。
3. 网关 `launchctl kickstart -k` 重载新代码（10:02:56，新 PID 91853）。

## 验证（三轮 fire 时间线，同一 ggtms 任务）

| 轮次 | 状态 | 证据 |
|---|---|---|
| 08:47 | 401 ×4（/capture、/session/end） | agent.log；Gateway 无该会话 store 条目 |
| 10:03（补丁生效、档案 .env 未补） | 仍 401（/recall、/capture、/session/end）——暴露第二层缺口（profile .env 缺钥） | agent.log |
| 10:06（档案 .env 补齐后） | **全程零 401**；Gateway `gateway.out.log` 持久化状态出现该会话 store 条目（`cron_ca270c3a5a58_20260916_100632`）——服务端接受建档，端到端通 | agent.log + gateway.out.log |

`Ran now: failed` 与 delivery_outcome=failed 均为手动 fire 不投递的常态标记，非故障。

## 遗留

- 钥三副本轮换同步义务（全局 .env / .zshrc / lt-tutor .env）——下次轮换时执行。
- 观察点：周日 19:00-20:00 周报窗实跑后，agent.log 应保持零 401；Gateway 侧应新增各教师会话 store 条目。
