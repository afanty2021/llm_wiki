# 小任务：lt-tutor 档案 memory-tencentdb 插件 401 噪音

**日期**：2026-09-16 · **状态**：待办（非急迫——纯日志噪音，无功能性损害）
**来源**：SKILL 拆分实施后复审（.superpowers/reviews/2026-09-16-skill-split-impl/report.md Minor 6）顺带登记。

## 现象

lt-tutor 档案每次会话结束（含 cron fire）时，后台记忆插件向 Hermes Gateway 打 /capture、/session/end，双双 401：

```
WARNING plugins.memory.memory_tencentdb.client: memory-tencentdb Gateway /capture returned 401: {"error":"Unauthorized: missing Bearer token"}
WARNING plugins.memory.memory_tencentdb: memory-tencentdb sync failed: HTTP Error 401: Unauthorized
WARNING plugins.memory.memory_tencentdb.client: memory-tencentdb Gateway /session/end returned 401: {"error":"Unauthorized: missing Bearer token"}
```

随后紧跟 "Gateway is reachable again; restoring provider state" + "recovery succeeded"（可达性探测通过，仅鉴权失败）。

## 背景

- agent.log 同回合可见：`Memory provider(s) ['memory_tencentdb'] configured but the 'memory' toolset is gated off for this session (platform_toolsets / agent.disabled_toolsets) — provider tools and system-prompt block are both withheld.`——lt-tutor 的 platform_toolsets（wecom/cron）本就未开 memory 工具面，但插件后台 sync/capture 链路不受该门控，仍在发起调用。
- 错误语义是「missing Bearer token」：插件配置缺网关凭证，非网关不可达。

## 影响面

教师/周报会话日志持续出现 401 WARNING 噪音（每次会话 2-4 条）；记忆功能在该档案本就被工具面门控关闭，**无数据损失**。危害=日志可读性与告警可信度（真 401 故障会被淹没）。

## 修复方向（二选一，实施时定）

1. **补凭证**：若 lt-tutor 需要后台记忆采集——给插件配置注入 Gateway Bearer token（钥源落点遵循密钥纪律：settings.json/.env，不进仓不回显）。
2. **关插件**：若该档案不需要（当前工具面已关，倾向此项）——在 lt-tutor 档案配置禁用 memory_tencentdb 插件，消除调用与噪音。

## 验收

agent.log 连续两日（含一次周报 cron fire）零 `memory_tencentdb` 401 WARNING；若选补凭证，另验证 /capture 返回 2xx 且 Gateway 侧能收到 capture 数据。
