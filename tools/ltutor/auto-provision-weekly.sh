#!/bin/bash
# auto-provision-weekly.sh — 周报自动开办巡检（launchd 每日 03:17）
#
# 逻辑：surveyed（完成入门问卷）的真实教师 ⇄ lt-tutor-weekly:* 任务清单求差，
# 缺的自动走 provision-teacher-weekly.sh（路由+platforms+任务三合一，幂等）。
#
# 过滤（关键——cargo 集成测试打 live PG 会持续再造测试用户）：
#   - 用户名匹配测试形态（tN_ 前缀/test/smoke/ctrl/restore/纯重复字符）
#   - 机器人主人 HuangZhengBo
# 停发名单（管理员长期停发，2026-09-05 用户裁定——教师侧不提供自行停发路径）：
#   paused-weekly.txt 一行一个企微 userid；名单内教师缺任务不自动开办，
#   名单内但任务仍在则告警。停发 = hermes cron remove + 名单加行。
# pending 教师不开办（未完成问卷的教师周日只会收到"暂无周报"打扰，问卷完成
# 后下一个巡检周期自动开通）。
# 判重不分大小写：provision 脚本按任务名查重本就不分大小写（resolve_job_ref），这里若
# 分大小写，仅大小写不同的教师每晚都会被误判成「缺任务」，空走一遍开办并在日志里假报
# 「新开办 1 个」。单个教师开办失败不中止整轮，末尾汇总并以非零退出。
#
# 存活判据：每趟日志以「巡检开始」起头，正常收尾有两行——「巡检完成：新开办 N 个、失败
# M 个」与 trap 打的「巡检结束 exit=0」（set -e 中途退出的趟同样有这一行）。
# tools/pg-backup/pg-watchdog.sh 每日 09:00 查这两行。
#
# 兼容 macOS bash 3.2（无 mapfile/关联数组），一律 while-read。

set -euo pipefail

PROVISION="$(cd "$(dirname "$0")" && pwd)/provision-teacher-weekly.sh"
LOG="${LOG:-$HOME/Library/Logs/ltutor-weekly-audit.log}"
DOCKER="/opt/homebrew/bin/docker"
PG="src-server-postgres-1"
PY="/opt/homebrew/Caskroom/miniconda/base/envs/hermes-3.11/bin/python"

mkdir -p "$(dirname "$LOG")"
exec >>"$LOG" 2>&1
# 每趟最后记一行退出码（看门据此判断上一趟成败）；$? 在 trap 里就是脚本此刻的退出码
trap 'echo "── 巡检结束 exit=$? ──"' EXIT
echo "── $(date '+%F %T') 巡检开始 ──"

# surveyed 教师清单（DB 侧，过滤测试残渣与主人）
TEACHERS="$($DOCKER exec $PG psql -U llmwiki -d llmwiki -At \
  -c "SELECT u.username FROM teacher_profiles tp JOIN users u ON u.id=tp.user_id \
      WHERE tp.onboarding_state='surveyed' ORDER BY u.username;" \
  | grep -vE '^wecom_(t[0-9]+_|test|smoke|ctrl|restore)' \
  | grep -vE '^wecom_(.)\1+_' \
  | grep -v '^wecom_HuangZhengBo$')"

# 已有任务清单（jobs.json 侧）
EXISTING="$($PY -c "
import json
d = json.load(open('$HOME/.hermes/profiles/lt-tutor/cron/jobs.json'))
jobs = d if isinstance(d, list) else d.get('jobs', [d])
for j in jobs:
    n = j.get('name','')
    if n.startswith('lt-tutor-weekly:') and j.get('enabled', True):
        print('wecom_' + n.split(':',1)[1])
" 2>/dev/null || true)"

# 停发名单（同目录 paused-weekly.txt；精确整行匹配防子串误伤）
PAUSED_FILE="$(cd "$(dirname "$0")" && pwd)/paused-weekly.txt"
PAUSED=""
if [ -f "$PAUSED_FILE" ]; then
  PAUSED="$(grep -vE '^[[:space:]]*($|#)' "$PAUSED_FILE" || true)"
fi

echo "候选（surveyed、非测试、非主人）：$(echo $TEACHERS | tr '\n' ' ')"

provisioned=0
failed=0
while IFS= read -r u; do
  [ -z "$u" ] && continue
  id="${u#wecom_}"
  if [ -n "$PAUSED" ] && echo "$PAUSED" | grep -qx "$id"; then
    if echo "$EXISTING" | grep -qix "$u"; then
      echo "  [停发-告警] 名单内但任务仍在跑：$id —— 长期停发请 hermes cron remove（runbook §6.2）"
    else
      echo "  [停发] $id 不自动开办（恢复=名单删行，次日巡检重建）"
    fi
    continue
  fi
  # EXISTING 的比对不分大小写（见文件头）
  if echo "$EXISTING" | grep -qix "$u"; then
    echo "  已有任务：$id"
  else
    echo "  ▶ 自动开办：$id"
    # 失败只记账，不中止整轮：排在后面的教师照常处理
    rc=0
    bash "$PROVISION" "$id" || rc=$?
    if [ "$rc" -eq 0 ]; then
      provisioned=$((provisioned+1))
    else
      echo "  ✗ 开办失败：$id（exit=$rc）"
      failed=$((failed+1))
    fi
  fi
done <<< "$TEACHERS"
echo "── 巡检完成：新开办 $provisioned 个、失败 $failed 个 ──"
if [ "$failed" -gt 0 ]; then
  exit 1
fi
