#!/bin/bash
# 每日看门（评审 I2）：备份停摆自愈 + 告警——「备份静默停摆而所有人以为它在工作」
# 是备份系统唯一不可有的失败模式。
#   1) last-success >26h → 先 kickstart wiki.pg-backup 自愈重试（Mac 补睡醒火错位/
#      瞬时故障；轮询最多 8 分钟），仍陈旧才告警
#   2) /Users/Shared 第二副本缺失或陈旧
#   3) 存储镜像 .mirror-ok >26h（raw 源安全网心跳）
#   4) 最新 dump <10MB（600KB 截断陷阱的粗粒度兜底）
#   5) 每周恢复演练 >8 天未成功（wiki.pg-verify 停摆）
#   6) ltutor 周报巡检存活（wiki.ltutor-weekly-audit 每日 03:17：退出码 / 走没走到「巡检完成」/
#      停发告警 / 新开办数）——与 PG 无关，借这里的告警通道；标题另起「周报巡检看门」
# 告警 = macOS 通知 + 非零退出（launchd.err.log 留痕）。
set -eu
PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"

BACKUP_DIR="${PG_BACKUP_DIR:-$HOME/kb-dumps/src-server-pg}"
MIRROR_DIR="${PG_MIRROR_DIR:-/Users/Shared/kb-pg-backup-mirror}"
STORAGE_DST="${PG_STORAGE_DST:-$HOME/kb-dumps/src-server-storage}"
LABEL="wiki.pg-backup"
LOG="$BACKUP_DIR/watchdog.log"

mkdir -p "$BACKUP_DIR"
log() { echo "$(date '+%F %T') $*" >> "$LOG"; }
alert() {
  log "ALERT: $1"
  osascript -e "display notification \"$1\" with title \"PG 备份看门\" sound name \"Basso\"" >/dev/null 2>&1 || true
}
# 周报巡检的通知另起标题（免得被当成备份告警）；$2 为声音名，留空 = 静默
audit_notify() {
  osascript -e "display notification \"$1\" with title \"周报巡检看门\"${2:+ sound name \"$2\"}" >/dev/null 2>&1 || true
}
age_s() {
  if [ -f "$1" ]; then echo $(( $(date +%s) - $(stat -f%m "$1") )); else echo 999999; fi
}

# 1) 备份新鲜度（自愈优先）
if [ "$(age_s "$BACKUP_DIR/last-success")" -gt $((26 * 3600)) ]; then
  log "last-success 陈旧 → kickstart $LABEL 自愈重试"
  launchctl kickstart "gui/$(id -u)/$LABEL" >> "$LOG" 2>&1 || true
  # backup 启动自身最多等 Docker 5 分钟——固定短睡会误报，轮询最多 8 分钟（评审2 M）
  w=0
  while [ "$w" -lt 16 ]; do
    sleep 30
    if [ "$(age_s "$BACKUP_DIR/last-success")" -le $((26 * 3600)) ]; then break; fi
    w=$((w + 1))
  done
fi
if [ "$(age_s "$BACKUP_DIR/last-success")" -gt $((26 * 3600)) ]; then
  alert "备份已超 26 小时未成功（自愈重试无效）——查 Docker/磁盘/launchd"
  exit 1
fi

# 2) 同机第二副本
MNEWEST=$(ls -t "$MIRROR_DIR"/llmwiki-*.dump 2>/dev/null | head -n 1 || true)
if [ -z "$MNEWEST" ] || [ "$(age_s "$MNEWEST")" -gt $((26 * 3600)) ]; then
  alert "第二副本（${MIRROR_DIR}）缺失或陈旧"   # bash3.2：$VAR 后跟全角字符会把高位字节并入变量名，必须 ${VAR}
  exit 1
fi

# 3) 存储镜像心跳（评审2 N-1：rsync 持续失败=runbook 依赖的 raw 源安全网静默死亡）
if [ "$(age_s "$STORAGE_DST/.mirror-ok")" -gt $((26 * 3600)) ]; then
  alert "存储镜像（~/kb-dumps/src-server-storage）超 26h 未成功——raw 源安全网可能失效"
  exit 1
fi

# 4) 最新 dump 体积下限
NEWEST=$(ls -t "$BACKUP_DIR"/llmwiki-*.dump 2>/dev/null | head -n 1 || true)
if [ -z "$NEWEST" ] || [ "$(stat -f%z "$NEWEST")" -lt $((10 * 1024 * 1024)) ]; then
  alert "最新 dump 缺失或 <10MB：${NEWEST:-无}"
  exit 1
fi

# 5) 每周恢复演练新鲜度
if [ "$(age_s "$BACKUP_DIR/last-verify")" -gt $((8 * 86400)) ]; then
  alert "恢复演练超 8 天未跑——wiki.pg-verify（周日 05:00）没有成功"
  exit 1
fi

# 6) ltutor 周报巡检存活（2026-11-06 起日败 20 趟无人知道：巡检的产物只有一份日志，成功信号只有脚本
#    自己打的标记）。巡检每日 03:17，日志每趟以「巡检开始」起头，正常收尾两行——「巡检完成：新开办 N 个、
#    失败 M 个」与 trap 打的「巡检结束 exit=0」。本查只读、不 kickstart（巡检会写主 config 与 cron 任务，
#    不该由看门代跑）。前五查失败而提前退出的日子本查不跑——那些天看门本身已经在告警。
#    26h 的来由：03:17 → 09:00 只隔 5h43m，漏跑一趟时上一份「巡检完成」已有 29h43m，26h 当天上午就报。
LTUTOR_AUDIT_LABEL="${LTUTOR_AUDIT_LABEL:-wiki.ltutor-weekly-audit}"
LTUTOR_AUDIT_LOG="${LTUTOR_AUDIT_LOG:-$HOME/Library/Logs/ltutor-weekly-audit.log}"
ltutor_problems=""
run_text=""
run_at=""
# 刚睡醒时 launchd 可能把错过的 03:17 那趟与本看门同时补火：巡检还在跑就等它收尾（最多 2 分钟）
w=0
while [ "$(age_s "$LTUTOR_AUDIT_LOG")" -gt $((26 * 3600)) ] && [ "$w" -lt 12 ] && \
      launchctl print "gui/$(id -u)/$LTUTOR_AUDIT_LABEL" 2>/dev/null | grep -q 'state = running'; do
  sleep 10
  w=$((w + 1))
done
audit_info="$(launchctl print "gui/$(id -u)/$LTUTOR_AUDIT_LABEL" 2>/dev/null || true)"
if [ -z "$audit_info" ]; then
  ltutor_problems="${ltutor_problems}巡检任务 ${LTUTOR_AUDIT_LABEL} 未加载；"
else
  audit_rc="$(printf '%s\n' "$audit_info" | sed -n 's/.*last exit code = //p' | tail -n 1)"
  case "$audit_rc" in
    ""|0) ;;
    *) ltutor_problems="${ltutor_problems}巡检最近一趟退出码 ${audit_rc}；" ;;
  esac
fi
if [ -f "$LTUTOR_AUDIT_LOG" ]; then
  # 行号用 bash 自己取（不用 cut：macOS 的 cut 在部分 locale 下遇多字节会报 Illegal byte sequence）
  last_start="$(grep -n '巡检开始' "$LTUTOR_AUDIT_LOG" | tail -n 1)"
  start_ln="${last_start%%:*}"
  if [ -n "$start_ln" ]; then
    run_text="$(tail -n +"$start_ln" "$LTUTOR_AUDIT_LOG")"
    run_at="$(printf '%s\n' "$run_text" | head -n 1 | sed -n 's/^── \([0-9-]* [0-9:]*\) 巡检开始 ──$/\1/p')"
    log_rc="$(printf '%s\n' "$run_text" | sed -n 's/^── 巡检结束 exit=\([0-9]*\) ──$/\1/p' | tail -n 1)"
    done_n="$(printf '%s\n' "$run_text" | grep -c '── 巡检完成：' || true)"
    if [ "$done_n" -eq 0 ]; then
      ltutor_problems="${ltutor_problems}最近一趟（${run_at}）没走到「巡检完成」；"
    fi
    if [ -n "$log_rc" ] && [ "$log_rc" != "0" ]; then
      ltutor_problems="${ltutor_problems}日志记的退出码 ${log_rc}；"
    fi
    if printf '%s\n' "$run_text" | grep -q '\[停发-告警\]'; then
      ltutor_problems="${ltutor_problems}有「停发-告警」（停发名单里的教师任务仍在跑）；"
    fi
  else
    ltutor_problems="${ltutor_problems}日志里没有「巡检开始」；"
  fi
  audit_age="$(age_s "$LTUTOR_AUDIT_LOG")"
  if [ "$audit_age" -gt $((26 * 3600)) ]; then
    ltutor_problems="${ltutor_problems}日志已 $((audit_age / 3600)) 小时没更新（launchd 没触发或机器没开）；"
  fi
else
  ltutor_problems="${ltutor_problems}日志不存在；"
fi
if [ -n "$ltutor_problems" ]; then
  log "ALERT: ltutor 周报巡检：${ltutor_problems}"
  audit_notify "${ltutor_problems}" "Basso"
  exit 1
fi
audit_new="$(printf '%s\n' "$run_text" | sed -n 's/^── 巡检完成：新开办 \([0-9]*\) 个.*/\1/p' | tail -n 1)"
if [ -n "$audit_new" ] && [ "$audit_new" -gt 0 ]; then
  # 同一趟只通知一次：凭本日志里的 NOTIFY 行去重（本日志在首跑前还不存在）
  if [ ! -f "$LOG" ] || ! grep -qF "NOTIFY: ltutor 周报巡检 ${run_at} 新开办 ${audit_new}" "$LOG"; then
    log "NOTIFY: ltutor 周报巡检 ${run_at} 新开办 ${audit_new}"
    audit_notify "周报巡检 ${run_at} 新开办 ${audit_new} 位教师的周报任务"
  fi
fi

log "OK: backup fresh, mirror fresh, size ok, verify fresh, ltutor audit ok"
