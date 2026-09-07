#!/usr/bin/env python3
r"""admin-tool-guard —— pre_tool_call 守卫：拦截 agent 绕过 training_overview 直查师训管理数据。

背景（2026-09-07）：管理员在企微问「现在有哪些老师 bind」，模型沿用会话里
terminal 直查 /api/v1/training/overview 的旧成功先例（admin 工具诞生前的
217.8s 事故同源），把 UTC 串当本地时间渲染差 8 小时、测试残渣过滤口径
也不对。正规工具 training_overview（llm-wiki-admin MCP）已把时区/过滤/
计数全部内置——本守卫把绕行模式硬拦下，理由里指路。

威胁模型（评审 admin-tool-guard-review-2026-09-07 定调）：**防惯性复发**
（217.8s 型），不是防主动绕行——拼接/编码/分段写文件/pg_dump 等确定性
绕行形态对正则子串墙天然穿透，防主动绕行的承重在 ③ 层
（platform_toolsets 排 terminal，待拍板）。旁路使用会落审计痕迹。

行为（stdin JSON → stdout JSON，协议见 Hermes agent/shell_hooks.py）：
- tool_name != terminal → 静默放行（配置 matcher=terminal 之外的双保险）
- 命令（去前导空白后）以 ADMIN_BYPASS 开头 → 放行 + 落 BYPASS 审计
  （显式开头声明而非任意子串：拦截理由对模型可达，任意子串豁免=理由即
  钥匙；开头声明让豁免只能是运维的显式动作）
- 命中师训管理数据模式（IGNORECASE：裸 SQL 标识符 PG 折叠小写真实有效，
  大写/\copy 变体必须拦）→ block，reason 指路 training_overview + 落审计
- 其余命令 → 静默放行；任何解析异常 → 静默放行（fail-open：守卫坏了
  不能坏 agent；config 侧 fail_closed: false 同义）

模式面：/api/v1/training/ 任一 URL 形态 + 师训域表名（teacher_profiles /
learning_events / learning_plans / learning_items）——psql 直查与
urllib/curl 打 API 两条路都盖住；不碰这些表/URL 的 terminal 用途不受影响。
users 表暂不入拦截面（wiki 主用户表裸名误拦面大，观察项，见评审 M2）。

作用域边界（评审 I2，重要）：守卫**只在主 home（default profile）注册**
——网关卫星 profile 激活时读自己的 config 注册 hooks（gateway/run.py
:17294），lt-tutor/zops config 无 hooks 块即不 dispatch。当前无实害
（两卫星白名单均无 terminal）；**未来给任何卫星 profile 放开 terminal
之前，必须先在其 config 同挂 hooks 块**（或确认该 profile 不需要此守卫
并有替代约束）。

部署（源在 llm_wiki 仓，运行副本在稳定路径防分支错位）：
  cp tools/ltutor/admin-tool-guard.py ~/.hermes/scripts/admin-tool-guard.py
改脚本后 cp 即生效（hooks 每次调用重新 spawn 读文件，无需重启网关）。
主 config hooks 块 + ~/.hermes/shell-hooks-allowlist.json 的 command 串
必须与部署路径逐字一致（allowlist 精确匹配）。
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
# 裸 SQL 标识符在 PG 折叠小写后真实有效（评审 I3 双验）——大小写不敏感。
FLAGS = re.IGNORECASE
BYPASS_PREFIX = "ADMIN_BYPASS"

BLOCK_REASON = (
    "已拦截：师训管理数据（老师 bind/进度/活跃/提问）请直接调用 training_overview 工具"
    "——一跳可答，时区（UTC+8 本地）、测试残渣过滤、真实/测试计数口径都已内置；"
    "terminal 直查 API/数据库的口径错误正是本拦截存在的原因（2026-09-07 时区事故）。"
    "确需底层排障时，把命令最开头改为以 ADMIN_BYPASS 声明后重试（运维显式动作）。"
)


def _audit(event: str, session: object, command: str) -> None:
    """审计一行一事件：多行命令把换行折叠成可见标记（评审 M1）。"""
    try:
        oneline = command.replace("\n", " ⏎ ").replace("\r", " ⏎ ")
        with open(GUARD_LOG, "a", encoding="utf-8") as log:
            log.write(
                f"{datetime.datetime.now().isoformat(timespec='seconds')}"
                f" {event} session={session} cmd={oneline[:200]}\n"
            )
    except Exception:
        pass


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
    if command.lstrip().startswith(BYPASS_PREFIX):
        _audit("BYPASS", payload.get("session_id"), command)
        return
    if not any(re.search(pattern, command, FLAGS) for pattern in PATTERNS):
        return
    _audit("BLOCK", payload.get("session_id"), command)
    print(json.dumps({"decision": "block", "reason": BLOCK_REASON}, ensure_ascii=False))


if __name__ == "__main__":
    main()
