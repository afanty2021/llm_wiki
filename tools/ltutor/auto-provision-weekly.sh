#!/bin/bash
# auto-provision-weekly.sh — 周报自动开办巡检（launchd 每日 03:17）
#
# 逻辑：surveyed（完成入门问卷）的真实教师 ⇄ lt-tutor-weekly:* 任务清单求差，
# 缺的自动走 provision-teacher-weekly.sh（路由+platforms+任务三合一，幂等）。
#
# 过滤（关键——cargo 集成测试打 live PG 会持续再造测试用户）：
#   - 用户名匹配测试形态（tN_ 前缀/test/smoke/ctrl/restore/纯重复字符）
#   - 机器人主人 HuangZhengBo
# pending 教师不开办（未完成问卷的教师周五只会收到"暂无周报"打扰，问卷完成
# 后下一个巡检周期自动开通）。
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

echo "候选（surveyed、非测试、非主人）：$(echo $TEACHERS | tr '\n' ' ')"

provisioned=0
while IFS= read -r u; do
  [ -z "$u" ] && continue
  id="${u#wecom_}"
  if echo "$EXISTING" | grep -qx "$u"; then
    echo "  已有任务：$id"
  else
    echo "  ▶ 自动开办：$id"
    bash "$PROVISION" "$id"
    provisioned=$((provisioned+1))
  fi
done <<< "$TEACHERS"
echo "── 巡检完成：新开办 $provisioned 个 ──"
