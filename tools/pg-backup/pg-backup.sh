#!/bin/bash
# src-server Postgres 每日备份 —— 2026-10-10 Docker 卷误删事故后设立
# v2（2026-10-11 max 评审 I1-I7 修复）：原子发布 / 互斥锁 / 尺寸护栏确认自愈 /
#   存储镜像去 --delete / /Users/Shared 同机第二副本 / 失败即通知 / 失败路径清理。
#
# 流程：容器内 pg_dump -Fc 落盘 → 容器内 pg_restore --list 校验归档（唯一硬门）
#       → docker cp 取出到 .part → mv 原子发布 → 尺寸护栏（确认自愈）→ 心跳
#       → 轮转 → ~/kb-storage 源镜像（只增不删）→ /Users/Shared 第二副本
#
# 设计约束（勿改破）：
#  - 大导出一律「容器内落盘 + docker cp」，禁 docker exec 管道直传 stdout
#    （psql 大导出经管道 ~600KB 截断陷阱，2026-09 LT 语料批实证）
#  - pg_dump 是 MVCC 一致性快照，摄取/写入进行中照常可备，无需停机
#  - macOS 自带 /bin/bash = 3.2：无 mapfile/关联数组，保持 POSIX 写法
set -eu
# launchd GUI agent 默认 PATH 只有 /usr/bin:/bin——docker 在 /usr/local/bin，必须自补
PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"

CONTAINER="${CONTAINER:-src-server-postgres-1}"
DB_USER="llmwiki"
DB_NAME="llmwiki"
# 沙箱旋钮：PG_* 环境变量把落点重定向到沙箱目录——安全分支（护栏 trip/ack、锁争用）
# 必须能离线实测；「未演练的安全路径=未验证的声明」（评审2 C-1 教训）
BACKUP_DIR="${PG_BACKUP_DIR:-$HOME/kb-dumps/src-server-pg}"
STORAGE_SRC="$HOME/kb-storage"
STORAGE_DST="${PG_STORAGE_DST:-$HOME/kb-dumps/src-server-storage}"
MIRROR_DIR="${PG_MIRROR_DIR:-/Users/Shared/kb-pg-backup-mirror}"   # 同机第二副本：防家目录/备份目录误删，不防盘损
DAILY_KEEP=14
WEEKLY_KEEP=8
LOG="$BACKUP_DIR/backup.log"

mkdir -p "$BACKUP_DIR" "$MIRROR_DIR" 2>/dev/null || true
chmod 700 "$BACKUP_DIR" 2>/dev/null || true
log() { echo "$(date '+%F %T') $*" >> "$LOG"; }
notify() { osascript -e "display notification \"$1\" with title \"PG 备份\"" >/dev/null 2>&1 || true; }
fail() { log "ERROR: $*"; notify "备份失败: $*"; exit 1; }

# 0) 互斥锁：手动跑 vs 排程点火 vs 周日 wake 补火并发（评审 I6/M4）。
#    >30min 的锁视为陈旧（崩溃残留）强夺；新鲜锁则让位。
LOCK="$BACKUP_DIR/.lock"
if mkdir "$LOCK" 2>/dev/null; then
  trap 'rmdir "$LOCK" 2>/dev/null' EXIT
else
  if [ -z "$(find "$LOCK" -maxdepth 0 -mmin -30 2>/dev/null)" ]; then
    rm -rf "$LOCK"; mkdir "$LOCK"
    trap 'rmdir "$LOCK" 2>/dev/null' EXIT
  else
    log "SKIP: 另一备份/演练实例在跑（.lock 新鲜），本轮让位"
    exit 0
  fi
fi

# 1) 等 PG 就绪（launchd 可能早于 Docker Desktop 起来，最多等 5 分钟）
i=0
until docker exec "$CONTAINER" pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; do
  i=$((i+1))
  if [ "$i" -ge 30 ]; then fail "container $CONTAINER not ready after 5min"; fi
  sleep 10
done

STAMP=$(date +%Y%m%d-%H%M%S)
DOW=$(date +%w)                      # 0=周日 … 6=周六；周日份文件名以 -0 结尾
NAME="llmwiki-$STAMP-$DOW.dump"
TMP_IN="/tmp/$NAME"
OUT="$BACKUP_DIR/$NAME"

# 2) 容器内 dump 落盘（绕开 docker exec 管道截断陷阱）
if ! docker exec "$CONTAINER" pg_dump -U "$DB_USER" -d "$DB_NAME" -Fc -f "$TMP_IN"; then
  docker exec "$CONTAINER" rm -f "$TMP_IN" 2>/dev/null || true
  fail "pg_dump failed"
fi

# 3) 归档完整性校验（pg_restore 解析 TOC，坏档在此暴露）——截断/损坏的唯一硬门
if ! docker exec "$CONTAINER" pg_restore --list "$TMP_IN" >/dev/null; then
  docker exec "$CONTAINER" rm -f "$TMP_IN" 2>/dev/null || true
  fail "pg_restore --list: archive invalid ($NAME)"
fi

# 4) 尺寸护栏（评审 I3）：归档校验已是硬门，尺寸是启发式。合法缩库（清理/重摄波动）
#    会连续小尺寸——拦一次留 ack 标记，次日仍小且 ≥10MB、与 ack ±25% 内即自愈放行；
#    随机截断不复现（或 <10MB 现形）则持续拦截并告警，绝不永久锁死。
SIZE=$(docker exec "$CONTAINER" stat -c%s "$TMP_IN")
PREV=$(ls -t "$BACKUP_DIR"/llmwiki-*.dump 2>/dev/null | head -n 1)
ACK="$BACKUP_DIR/.size-acked"
TRIP=0
if [ -n "$PREV" ]; then
  PREV_SIZE=$(stat -f%z "$PREV")
  if [ "$SIZE" -lt $((PREV_SIZE / 2)) ]; then
    if [ -f "$ACK" ]; then
      A=$(cat "$ACK")   # ack 内容=首拦尺寸数字；stat 取的是文件自身字节数（C-1 死代码根因，勿改回）
      if [ "$SIZE" -ge $((10 * 1024 * 1024)) ] \
         && [ "$SIZE" -ge $((A * 3 / 4)) ] && [ "$SIZE" -le $((A * 5 / 4)) ]; then
        log "WARN→OK: 合法缩库确认（连续小尺寸），放行 ${SIZE}（旧基线 ${PREV_SIZE}）"   # bash3.2：$VAR 后跟全角字符会把高位字节并入变量名，必须 ${VAR}
        rm -f "$ACK"
      else
        TRIP=1
      fi
    else
      printf '%s\n' "$SIZE" > "$ACK.tmp" && mv "$ACK.tmp" "$ACK"
      TRIP=1
    fi
  else
    rm -f "$ACK" 2>/dev/null || true
  fi
fi
if [ "$TRIP" = "1" ]; then
  docker exec "$CONTAINER" rm -f "$TMP_IN" 2>/dev/null || true
  fail "size guard: new=$SIZE < 50% of prev=${PREV_SIZE:-?} ($NAME)——已拦截；若属合法缩库，明日同量级自动放行"
fi

# 5) 原子发布（评审 I6）：先 .part 再同卷 mv，半拷贝永不占用正式名
docker cp "$CONTAINER:$TMP_IN" "$OUT.part" || {
  docker exec "$CONTAINER" rm -f "$TMP_IN" 2>/dev/null || true
  fail "docker cp failed"
}
chmod 600 "$OUT.part"
mv "$OUT.part" "$OUT"
docker exec "$CONTAINER" rm -f "$TMP_IN"

# 6) 心跳（tmp+mv 原子写，防中间被杀留空 marker，评审 M3）
printf '%s\n' "$(date '+%F %T')" > "$BACKUP_DIR/.last-success.tmp"
mv "$BACKUP_DIR/.last-success.tmp" "$BACKUP_DIR/last-success"
log "OK $NAME size=$SIZE"

# 7) 轮转：非周日（-[1-6]）留 DAILY_KEEP 份；周日（-0）留 WEEKLY_KEEP 份
ls -t "$BACKUP_DIR"/llmwiki-*-[1-6].dump 2>/dev/null | tail -n +$((DAILY_KEEP + 1)) | while IFS= read -r f; do
  rm -f "$f"; log "pruned daily: $(basename "$f")"
done
ls -t "$BACKUP_DIR"/llmwiki-*-0.dump 2>/dev/null | tail -n +$((WEEKLY_KEEP + 1)) | while IFS= read -r f; do
  rm -f "$f"; log "pruned weekly: $(basename "$f")"
done

# 8) 源文件镜像——只增不删（评审 I5：--delete 会把源目录误删在次日传染进安全网）
if [ -d "$STORAGE_SRC" ]; then
  mkdir -p "$STORAGE_DST"
  if rsync -a "$STORAGE_SRC/" "$STORAGE_DST/" >> "$LOG" 2>&1; then
    printf '%s\n' "$(date '+%F %T')" > "$STORAGE_DST/.mirror-ok.tmp"
    mv "$STORAGE_DST/.mirror-ok.tmp" "$STORAGE_DST/.mirror-ok"
    log "OK storage mirror -> $STORAGE_DST"
  else
    log "WARN: storage mirror rsync failed（非致命，下日重试）"
  fi
fi

# 9) 同机第二副本（评审 I1）：最新一份 dump 到 /Users/Shared——家目录或备份目录
#    被 rm -rf 时兜底（同盘，不防盘损；跨盘/跨机副本见 README 头号开放风险）
if cp -f "$OUT" "$MIRROR_DIR/" 2>/dev/null; then
  ls -t "$MIRROR_DIR"/llmwiki-*.dump 2>/dev/null | tail -n +2 | while IFS= read -r f; do
    rm -f "$f"
  done
  log "OK mirror copy -> $MIRROR_DIR"
else
  log "WARN: mirror copy failed（非致命，看门会盯）"
fi
