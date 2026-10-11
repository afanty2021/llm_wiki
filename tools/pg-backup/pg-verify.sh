#!/bin/bash
# 周恢复演练：最新 dump → 容器内 scratch 库 llmwiki_verify → 计数对账 → drop
# v2（2026-10-11 max 评审修复）：WITH (FORCE) / 互斥锁 / 对账扩到不可再生状态表 /
#   marker 原子写 / 失败即通知。
#
# 判据：
#  - pg_restore --exit-on-error 零错
#  - 状态表（users/teams/team_members/teacher_profiles/llm_providers/projects）
#    逐表**精确相等**——dump→verify 间隔内它们几乎不变，静默丢行必须现形（评审 I7）
#  - 再生/增长表（wiki_pages/embeddings/ingested_files/review_items）
#    ≥ live 同表 90% 且 >0（dump 快照早于 live 增长，ver ≤ live 为常态）
# 没有恢复过的备份不算备份——本脚本是「备份可用」的唯一持续证据。
set -eu
# launchd GUI agent 默认 PATH 只有 /usr/bin:/bin——docker 在 /usr/local/bin，必须自补
PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"

CONTAINER="${CONTAINER:-src-server-postgres-1}"
DB_USER="llmwiki"
DB_NAME="llmwiki"
VERIFY_DB="llmwiki_verify"
BACKUP_DIR="${PG_BACKUP_DIR:-$HOME/kb-dumps/src-server-pg}"
LOG="$BACKUP_DIR/verify.log"

mkdir -p "$BACKUP_DIR"
log() { echo "$(date '+%F %T') $*" >> "$LOG"; }
notify() { osascript -e "display notification \"$1\" with title \"PG 恢复演练\"" >/dev/null 2>&1 || true; }
fail() { log "ERROR: $*"; notify "恢复演练失败: $*"; exit 1; }

# 互斥锁（与 pg-backup 共用；新鲜锁=备份正在跑，本周让位下周再来）
LOCK="$BACKUP_DIR/.lock"
if mkdir "$LOCK" 2>/dev/null; then
  trap 'rmdir "$LOCK" 2>/dev/null' EXIT
else
  if [ -z "$(find "$LOCK" -maxdepth 0 -mmin -30 2>/dev/null)" ]; then
    rm -rf "$LOCK"; mkdir "$LOCK"
    trap 'rmdir "$LOCK" 2>/dev/null' EXIT
  else
    log "SKIP: 另一实例在跑（.lock 新鲜），本周让位"
    exit 0
  fi
fi

LATEST=$(ls -t "$BACKUP_DIR"/llmwiki-*.dump 2>/dev/null | head -n 1)
if [ -z "$LATEST" ]; then fail "no dump in $BACKUP_DIR"; fi

i=0
until docker exec "$CONTAINER" pg_isready -U "$DB_USER" >/dev/null 2>&1; do
  i=$((i+1))
  if [ "$i" -ge 30 ]; then fail "container not ready after 5min"; fi
  sleep 10
done

log "verify start: $(basename "$LATEST")"
TMP_IN="/tmp/verify-$(basename "$LATEST")"

cleanup_db() {
  docker exec "$CONTAINER" psql -U "$DB_USER" -d postgres -c "DROP DATABASE IF EXISTS $VERIFY_DB WITH (FORCE)" >/dev/null 2>&1 || true
  docker exec "$CONTAINER" rm -f "$TMP_IN" 2>/dev/null || true
}

# PG16 WITH (FORCE)：孤儿 pg_restore 残留连接不再卡死每周演练（评审 M1）；
# NOTICE 重定向进 verify.log，launchd err 日志保持空=健康信号
docker exec "$CONTAINER" psql -U "$DB_USER" -d postgres -c "DROP DATABASE IF EXISTS $VERIFY_DB WITH (FORCE)" >/dev/null 2>> "$LOG"
docker exec "$CONTAINER" psql -U "$DB_USER" -d postgres -c "CREATE DATABASE $VERIFY_DB OWNER $DB_USER" >/dev/null 2>> "$LOG"
docker cp "$LATEST" "$CONTAINER:$TMP_IN" || { cleanup_db; fail "docker cp failed"; }

RESTORE_OK=1
docker exec "$CONTAINER" pg_restore -U "$DB_USER" -d "$VERIFY_DB" --no-owner --exit-on-error -j2 "$TMP_IN" || RESTORE_OK=0
if [ "$RESTORE_OK" = "0" ]; then
  cleanup_db
  fail "pg_restore --exit-on-error 报错: $(basename "$LATEST")"
fi

# 十表计数：前 6 状态表精确相等，后 4 再生表 ≥90% 且 >0
COUNTS_SQL="SELECT (SELECT count(*) FROM users)||','||(SELECT count(*) FROM teams)||','||(SELECT count(*) FROM team_members)||','||(SELECT count(*) FROM teacher_profiles)||','||(SELECT count(*) FROM llm_providers)||','||(SELECT count(*) FROM projects)||','||(SELECT count(*) FROM wiki_pages)||','||(SELECT count(*) FROM embeddings)||','||(SELECT count(*) FROM ingested_files)||','||(SELECT count(*) FROM review_items)"
LIVE=$(docker exec "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tA -c "$COUNTS_SQL")
VER=$(docker exec "$CONTAINER" psql -U "$DB_USER" -d "$VERIFY_DB" -tA -c "$COUNTS_SQL")
log "live=[$LIVE] verify=[$VER]"

# bash 3.2：老式逗号游标，无数组。前 6 个状态表全等，后 4 个再生表过下限。
cmp_all() {
  L="$1"; V="$2"
  n=0
  while [ "$n" -lt 6 ]; do
    lv=${L%%,*}; vv=${V%%,*}
    [ "$lv" = "$vv" ] || return 1
    L="${L#*,}"; V="${V#*,}"
    n=$((n + 1))
  done
  n=0
  while [ "$n" -lt 4 ]; do
    lv=${L%%,*}; vv=${V%%,*}
    if [ "$lv" -gt 0 ]; then [ "$vv" -gt 0 ] || return 1; fi   # 空表(0行)不判假失败（评审2：再生表全空的库）
    [ "$vv" -ge $((lv * 9 / 10)) ] || return 1
    if [ "$n" -eq 3 ]; then return 0; fi
    L="${L#*,}"; V="${V#*,}"
    n=$((n + 1))
  done
  return 0
}
if ! cmp_all "$LIVE" "$VER"; then
  cleanup_db
  fail "计数对账未过（状态表须精确相等，再生表须 ≥90% 且 >0）: live=[$LIVE] verify=[$VER]"
fi

cleanup_db
printf '%s\n' "$(date '+%F %T')" > "$BACKUP_DIR/.last-verify.tmp"
mv "$BACKUP_DIR/.last-verify.tmp" "$BACKUP_DIR/last-verify"
log "OK verify passed"
