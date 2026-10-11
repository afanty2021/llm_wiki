#!/bin/bash
# 每日看门（评审 I2）：备份停摆自愈 + 告警——「备份静默停摆而所有人以为它在工作」
# 是备份系统唯一不可有的失败模式。
#   1) last-success >26h → 先 kickstart wiki.pg-backup 自愈重试（Mac 补睡醒火错位/
#      瞬时故障；轮询最多 8 分钟），仍陈旧才告警
#   2) /Users/Shared 第二副本缺失或陈旧
#   3) 存储镜像 .mirror-ok >26h（raw 源安全网心跳）
#   4) 最新 dump <10MB（600KB 截断陷阱的粗粒度兜底）
#   5) 每周恢复演练 >8 天未成功（wiki.pg-verify 停摆）
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

log "OK: backup fresh, mirror fresh, size ok, verify fresh"
