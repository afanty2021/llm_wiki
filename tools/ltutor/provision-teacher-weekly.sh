#!/bin/bash
# provision-teacher-weekly.sh — 为新教师开办周报任务（三件事原子完成）
#
# 用法: bash provision-teacher-weekly.sh <教师企微id> [--dry-run]
#   示例: bash provision-teacher-weekly.sh WendyTest123
#
# 三件事（全部幂等，重复跑无害）：
#   ① 主 config profile_routes 补目标精确路由（cron 投递解析只认带 chat_id
#      的路由；catch-all 只管入站。缺路由=周报生成正常、投递静默失败）
#   ② lt-tutor profile 的 platforms.wecom 启用块确认（投递闸门查卫星自身
#      platforms 配置；无凭据=卫星形态，传输仍走主网关）
#   ③ lt-tutor cron 建周报任务（钉 provider/model，绕开 drift_skip 守卫）
#
# 路由即时生效（_primary_profile_routes_for_current_home 每次 tick 现读磁盘，
# 无需重启网关）；platforms 块若为本次新增才需要重启网关。
# 前提：教师已通过 bind 建档（首条消息触发）——未建档时周报按 prompt 约定
# 输出"尚未完成入门问卷"，无害。

set -euo pipefail

USERID="${1:-}"
DRY_RUN="${2:-}"
HERMES_PY="/opt/homebrew/Caskroom/miniconda/base/envs/hermes-3.11/bin/python"
MAIN_CFG="$HOME/.hermes/config.yaml"
PROFILE_CFG="$HOME/.hermes/profiles/lt-tutor/config.yaml"
PROFILE_HOME="$HOME/.hermes/profiles/lt-tutor"

if [ -z "$USERID" ]; then
  echo "用法: $0 <教师企微id> [--dry-run]" >&2; exit 1
fi
if [ "$DRY_RUN" = "--dry-run" ]; then
  echo "=== DRY RUN（不落盘） ==="
fi

$HERMES_PY - "$USERID" "$DRY_RUN" <<'PYEOF'
import json, os, re, shutil, sys, tempfile
from datetime import datetime

userid, dry_run = sys.argv[1], sys.argv[2] == "--dry-run"
main_cfg = os.path.expanduser("~/.hermes/config.yaml")
profile_cfg = os.path.expanduser("~/.hermes/profiles/lt-tutor/config.yaml")
profile_home = os.path.expanduser("~/.hermes/profiles/lt-tutor")
ts = datetime.now().strftime("%Y%m%d-%H%M%S")

def backup(path):
    if not dry_run:
        shutil.copy2(path, f"{path}.bak-{ts}")

# ── ① 主 config 精确路由（幂等：查 chat_id 是否已在某条 lt-tutor 路由上）──
src = open(main_cfg).read()
route_exists = re.search(
    rf"platform:\s*wecom\s*\n\s*chat_id:\s*{re.escape(userid)}\s*\n\s*profile:\s*lt-tutor", src)
platforms_block_added = False
if route_exists:
    print(f"[1/3] 精确路由已存在（chat_id={userid}）——跳过")
else:
    route_yaml = (
        f"    - name: lt-tutor-wecom-{userid.lower()}\n"
        f"      platform: wecom\n"
        f"      chat_id: {userid}\n"
        f"      profile: lt-tutor\n"
        f"      enabled: true\n"
    )
    anchor = "    - name: lt-tutor-wecom\n      platform: wecom\n      profile: lt-tutor\n      enabled: true\n"
    if anchor not in src:
        print("[1/3] ✗ 找不到 lt-tutor-wecom catch-all 锚点——主 config 结构变了，手工检查", file=sys.stderr)
        sys.exit(1)
    if dry_run:
        print(f"[1/3] 将新增精确路由 lt-tutor-wecom-{userid.lower()}（chat_id={userid}）")
    else:
        backup(main_cfg)
        open(main_cfg, "w").write(src.replace(anchor, anchor + route_yaml))
        print(f"[1/3] ✓ 精确路由已补（备份 {main_cfg}.bak-{ts}；即时生效无需重启）")

# ── ② lt-tutor platforms.wecom 启用块（幂等）──
psrc = open(profile_cfg).read()
if re.search(r"platforms:\s*\n\s*wecom:\s*\n\s*enabled:\s*true", psrc):
    print("[2/3] platforms.wecom 启用块已存在——跳过")
else:
    block = (
        "# cron 投递闸门需逻辑平台启用；无凭据=#101113 卫星形态，传输走主网关\n"
        "platforms:\n  wecom:\n    enabled: true\n"
    )
    if dry_run:
        print("[2/3] 将新增 platforms.wecom 启用块（新增后需重启网关生效）")
        platforms_block_added = True
    else:
        backup(profile_cfg)
        open(profile_cfg, "w").write(psrc.rstrip() + "\n\n" + block)
        print(f"[2/3] ✓ platforms.wecom 启用块已补（备份 {profile_cfg}.bak-{ts}）⚠ 需重启网关")
        platforms_block_added = True

# ── ③ 周报 cron 任务（幂等：按 name 查重）──
os.environ["HERMES_HOME"] = profile_home
from cron import jobs as cron_jobs

job_name = f"lt-tutor-weekly:{userid}"
existing = cron_jobs.resolve_job_ref(job_name)
if existing:
    print(f"[3/3] 周报任务已存在（{job_name}）——跳过")
else:
    prompt = f"""【周报任务】目标教师 wecom_userid: {userid}

请按 teacher-tutor 技能 §7 流程 5（周报生成 · cron 系统回合）为该教师生成本周学习周报。要点：
- 本回合为系统模式：每次工具调用都必须显式携带 wecom_userid: {userid}（prompt 未提供的身份一律不得使用）。
- teacher_tutor_plan_create 的 origin 固定 "weekly"；不传 period_key（服务端自算当周并按周幂等，禁止自行推算 ISO 周串）。
- 教师未建档（档案 404）时不建清单，只输出一句"该教师尚未完成入门问卷，本期暂无周报"。
- 开头称呼："<display_name>老师好"（display_name 取自 teacher_tutor_profile_get；为空时退"老师好"，勿编造名字）。
- 正文直达教师本人：不得出现"周报任务"、job_id、cron、"系统"等任何后台痕迹；也不要附停止/管理任务的说明。
周报短文由系统送达该教师本人。"""
    if dry_run:
        print(f"[3/3] 将创建周报任务 {job_name}（周日 19:00，deliver wecom:{userid}，钉 5.3-flash）")
    else:
        job = cron_jobs.create_job(
            prompt=prompt,
            schedule="0 19 * * 0",
            name=job_name,
            deliver=f"wecom:{userid}",
            skills=["teacher-tutor"],
            provider="zai-coding-cn",
            model="glm-5.3-flash",
        )
        print(f"[3/3] ✓ 周报任务已建：{job_name}（id={job['id']}，next={job.get('next_run_at')}）")

print("=== 完成 ===")
if platforms_block_added and not dry_run:
    print("⚠ 本次新增了 platforms 块——重启网关后投递闸门才认：")
    print("  launchctl bootout gui/$(id -u)/ai.hermes.gateway && launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.hermes.gateway.plist")
PYEOF
