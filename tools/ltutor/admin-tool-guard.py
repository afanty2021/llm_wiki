#!/usr/bin/env python3
"""admin-tool-guard —— pre_tool_call 守卫：拦截 agent 绕过 training_overview 直查师训管理数据。

背景（2026-09-07）：管理员在企微问「现在有哪些老师bind」，模型沿用会话里
terminal 直查 /api/v1/training/overview 的旧成功先例（admin 工具诞生前的
217.8s 事故同源），把 UTC 串当本地时间渲染差 8 小时、测试残渣过滤口径
也不对。正规工具 training_overview（llm-wiki-admin MCP）已把时区/过滤/
计数全部内置——本守卫把绕行模式硬拦下，理由里指路。

行为（stdin JSON → stdout JSON，协议见 Hermes agent/shell_hooks.py）：
- tool_name != terminal → 静默放行（配置 matcher=terminal 之外的双保险）
- 命令含 ADMIN_BYPASS 标记 → 放行（确需底层排障的显式豁免口）
- 命中师训管理数据模式 → block，reason 指路 training_overview，落审计日志
- 其余命令 → 静默放行；任何解析异常 → 静默放行（fail-open：守卫坏了
  不能坏 agent；config 侧 fail_closed: false 同义）

模式面：/api/v1/training/ 任一 URL 形态 + 师训域表名（teacher_profiles /
learning_events / learning_plans / learning_items）——psql 直查与
urllib/curl 打 API 两条路都盖住；不碰这些表/URL 的 terminal 用途不受影响。

部署（源在 llm_wiki 仓，运行副本在稳定路径防分支错位）：
  cp tools/ltutor/admin-tool-guard.py ~/.hermes/scripts/admin-tool-guard.py
主 config hooks 块 + ~/.hermes/shell-hooks-allowlist.json 的 command 串
必须与本文件部署路径逐字一致（allowlist 精确匹配）。
"""
import datetime
import json
import os
import re
import sys

GUARD_LOG = os.path.expanduser("~/.hermes/logs/admin-tool-guard.log")

PATTERNS = [
    r"/api/v1/training/",
    r"\bteacher_profiles\b",
    r"\blearning_events\b",
    r"\blearning_plans\b",
    r"\blearning_items\b",
]
BYPASS_MARKERS = ("ADMIN_BYPASS",)

BLOCK_REASON = (
    "已拦截：师训管理数据（老师 bind/进度/活跃/提问）请直接调用 training_overview 工具"
    "——一跳可答，时区（UTC+8 本地）、测试残渣过滤、真实/测试计数口径都已内置；"
    "terminal 直查 API/数据库的口径错误正是本拦截存在的原因（2026-09-07 时区事故）。"
    "如确需底层排障，在命令中包含 ADMIN_BYPASS 标记后重试。"
)


def main() -> None:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return  # fail-open
    if not isinstance(payload, dict) or payload.get("tool_name") != "terminal":
        return
    tool_input = payload.get("tool_input")
    command = str(tool_input.get("command") or "") if isinstance(tool_input, dict) else ""
    if not command:
        return
    if any(marker in command for marker in BYPASS_MARKERS):
        return
    if not any(re.search(pattern, command) for pattern in PATTERNS):
        return
    try:
        with open(GUARD_LOG, "a", encoding="utf-8") as log:
            log.write(
                f"{datetime.datetime.now().isoformat(timespec='seconds')}"
                f" BLOCK session={payload.get('session_id')} cmd={command[:200]}\n"
            )
    except Exception:
        pass
    print(json.dumps({"decision": "block", "reason": BLOCK_REASON}, ensure_ascii=False))


if __name__ == "__main__":
    main()
