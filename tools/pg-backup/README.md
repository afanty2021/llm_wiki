# src-server PG 备份方案（wiki.pg-backup / wiki.pg-verify / wiki.pg-watchdog）

> 缘起：2026-10-10 Docker 卷（postgres_data）误删 → 全库重来，1686 语料文件重摄数日、烧掉整段 zai 额度。
> 目标：RPO ≤ 24h、RTO ≈ 10 分钟、恢复路径持续演练验证（没恢复过的备份不算备份）、**停摆必告警**。
> v2（2026-10-11 max 评审 7 Important 全清）：原子发布 / 互斥锁 / 护栏确认自愈 / 存储镜像去 --delete /
> /Users/Shared 同机第二副本 / 看门自愈告警 / 对账扩不可再生状态表。

## 组件

| 文件 | 作用 | 排程（launchd） |
|---|---|---|
| `pg-backup.sh` | 容器内 `pg_dump -Fc` → 归档校验 → 原子发布 → 尺寸护栏 → 轮转 → 存储镜像 → 第二副本 | `wiki.pg-backup` 每日 04:30 |
| `pg-verify.sh` | 最新 dump 真恢复进 scratch 库 `llmwiki_verify`，十表对账后 drop | `wiki.pg-verify` 每周日 05:00 |
| `pg-watchdog.sh` | 停摆自愈+告警（备份 >26h / 第二副本 / 存储镜像心跳 / 体积下限 / 演练 >8d / ltutor 周报巡检存活） | `wiki.pg-watchdog` 每日 09:00 |

- **双份部署**（同 SKILL 双份 cp 纪律）：**仓 `tools/pg-backup/` = 版本化源**；launchd 实跑
  `~/kb-ops/pg-backup/`（仓外稳定路径——本仓有并行会话切分支/git clean 的先例，仓内路径不可作运行时依赖）。
  改脚本后必须 `cp tools/pg-backup/*.sh ~/kb-ops/pg-backup/` 再 bootout+bootstrap。
- 备份落点：`~/kb-dumps/src-server-pg/`；同机第二副本：`/Users/Shared/kb-pg-backup-mirror/`（最新一份）
- 源文件镜像：`~/kb-dumps/src-server-storage/`（**只增不删**——误删不传染）
- 新鲜度一眼可查：`last-success` / `last-verify`；明细 `backup.log` / `verify.log` / `watchdog.log`

## 关键设计

1. **容器内落盘 + docker cp**：`docker exec` 管道直传 stdout 有 ~600KB 截断陷阱（2026-09 LT 语料批实证），大导出一律容器内 `-f` 落盘再 cp 出来。
2. **MVCC 快照**：`pg_dump` 一致性快照，摄取/教师写入进行中照常备份，无需停机（评审期间摄取实锤强化：写入中备份照常完成）。
3. **双校验，硬门唯一**：每次 dump 后容器内 `pg_restore --list` 解析 TOC 是**唯一硬门**（截断/坏档当场暴露）；尺寸 <50% 是启发式——拦一次留 `.size-acked` 标记并通知，**次日仍小且 ≥10MB、±25% 内即确认合法缩库自愈放行**；随机截断不复现则持续拦截。绝不因合法缩库永久锁死。
4. **原子发布 + 互斥锁**：dump 先落 `.part` 再同卷 `mv`（半拷贝永不占用正式名）；backup/verify 共用 `.lock`（>30min 视为崩溃残留强夺），周日 wake 补火并发不可能互相踩。
5. **每周真恢复 + 十表对账**：`--exit-on-error` 恢复进容器内独立 DB `llmwiki_verify`（不碰 llmwiki）。**状态表**（users / teams / team_members / teacher_profiles / llm_providers / projects——不可再生）逐表精确相等；**再生表**（wiki_pages / embeddings / ingested_files / review_items）≥90% 且 >0。DROP 全部 `WITH (FORCE)`，孤儿连接不卡演练。
6. **停摆自愈+告警**：看门每日 09:00 盯六个信号（备份新鲜度 / 第二副本 / 存储镜像心跳 / dump 体积下限 / 恢复演练新鲜度 / ltutor 周报巡检存活）；备份陈旧先 kickstart 自愈重试一次再告警；所有失败路径（脚本内 fail()）即时 macOS 通知。告警通道 = 本机通知（无外部依赖）。
7. **Redis 不备（有意排除）**：内容仅 ingest 队列等瞬态（评审实测 1184 键全为 `ingest:cache:*`）；恢复后空队列 + `recover_pending` 从 PG 自愈重建才是正确状态。
8. **bash 3.2 兼容**：macOS 自带 `/bin/bash` 无 mapfile/关联数组，脚本保持 POSIX 写法；`set -eu` 无 pipefail 为刻意（轮转 `ls|tail` 空匹配本就该忽略，记档）。
9. **第 6 查：ltutor 周报巡检存活（2026-11-26 起）**：`wiki.ltutor-weekly-audit` 每日 03:17 跑 `tools/ltutor/auto-provision-weekly.sh`（会写主 config 与 cron 任务），产物只有一份日志——2026-11-06 到 11-25 连败 20 趟无人知道。看门**只读、不 kickstart**（巡检不该由看门代跑）：查 launchd 的最近退出码、日志最后一趟走没走到「巡检完成」、日志记的退出码、有无「停发-告警」、日志新鲜度。新鲜度阈值 26h 的来由：03:17 → 09:00 只隔 5h43m，漏跑一趟时上一份日志已有 29h43m，26h 当天上午就报。睡醒补火时巡检若还在跑，最多等 2 分钟。新开办数 >0 另发一次静默通知（标题「周报巡检看门」，凭 `watchdog.log` 里的 `NOTIFY:` 行对同一趟去重）。旋钮：`LTUTOR_AUDIT_LABEL`（默认 `wiki.ltutor-weekly-audit`）、`LTUTOR_AUDIT_LOG`（默认 `~/Library/Logs/ltutor-weekly-audit.log`）。

## 恢复 runbook（真实事故时照抄）

```bash
# 分支 A：卷没了/换机（全新卷，POSTGRES_DB=llmwiki 自动建空库）
cd ~/Github/kb-obsidian/llm_wiki/src-server && docker compose up -d postgres
LATEST=$(ls -t ~/kb-dumps/src-server-pg/llmwiki-*.dump | head -1)
docker cp "$LATEST" src-server-postgres-1:/tmp/restore.dump
docker exec src-server-postgres-1 pg_restore -U llmwiki -d llmwiki --no-owner --exit-on-error -j2 /tmp/restore.dump
docker exec src-server-postgres-1 rm -f /tmp/restore.dump

# 分支 B：卷在但库损坏——先重建库再恢复（不能直接 restore 进损坏库）
docker exec src-server-postgres-1 psql -U llmwiki -d postgres \
  -c "DROP DATABASE IF EXISTS llmwiki WITH (FORCE)" -c "CREATE DATABASE llmwiki OWNER llmwiki"
# 然后同分支 A 的 docker cp + pg_restore

# 收尾（两分支同）：
#   1) raw 源如受损：~/kb-dumps/src-server-storage/ 就是 ~/kb-storage 的镜像，可整体拷回
#   2) 重启应用层（避开周日 19:00-19:59 教师周报窗）
launchctl kickstart -k gui/$(id -u)/wiki.src-server
#   3) 抽查
docker exec src-server-postgres-1 psql -U llmwiki -d llmwiki \
  -c "SELECT count(*) FROM wiki_pages" -c "SELECT count(*) FROM embeddings"
```

注：`pgvector` 扩展二进制在 `pgvector/pgvector:pg16` 镜像内，dump 自带 `CREATE EXTENSION`，同镜像恢复即用；PG 密码走 compose env（`DB_PASSWORD`），不落任何文件。

## 运维操作

```bash
# 改脚本后的部署（双份 cp，必须做；改 plist 同理 cp 到 ~/Library/LaunchAgents）
~/Github/kb-obsidian/llm_wiki/tools/pg-backup/pg-backup.sh   # 手动跑一次
cp ~/Github/kb-obsidian/llm_wiki/tools/pg-backup/*.sh ~/kb-ops/pg-backup/

# 改 plist 后重载（bootout 完全退出再 bootstrap）
launchctl bootout gui/$(id -u)/wiki.pg-backup
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/wiki.pg-backup.plist

# 停用：plist 改名防自动加载
mv ~/Library/LaunchAgents/wiki.pg-backup.plist{,.disabled}

# 看门手动跑一次（正常 <5s；备份陈旧时会先自愈重试，轮询最多 8 分钟；03:17 巡检还在跑时最多再等 2 分钟）
# 看门的第 6 查在 1–5 查全过时才跑；只读巡检日志与 launchd 状态，不会代跑巡检
~/kb-ops/pg-backup/pg-watchdog.sh

# 沙箱演练（PG_* 旋钮重定向落点，不碰真实备份）——安全分支必须离线实测：
# 例：护栏 trip→ack→自愈放行三态（假 prev 200MB 触发 trip，真 dump 连续小尺寸触发放行）
T=/tmp/pgbak-test && rm -rf $T /tmp/pgbak-mirror /tmp/pgbak-storage && mkdir -p $T
dd if=/dev/zero of=$T/llmwiki-20261010-043000-6.dump bs=1048576 count=200
PG_BACKUP_DIR=$T PG_MIRROR_DIR=/tmp/pgbak-mirror PG_STORAGE_DST=/tmp/pgbak-storage \
  ~/kb-ops/pg-backup/pg-backup.sh   # 第 1 次 exit 1（trip+ack），第 2 次放行 exit 0
rm -rf $T /tmp/pgbak-mirror /tmp/pgbak-storage
```

## 已验证

- 2026-10-11 v1：首备 77MB + 恢复演练三表与 live 全等；演练抓出两坑修入库（`pg_restore -d` 只连不建库须先 CREATE DATABASE；launchd PATH 无 /usr/local/bin）。
- 2026-10-11 v2（评审修复后）：backup / verify / watchdog 三脚本 bash -n + 实跑通过；verify 在 launchd 下 kickstart 首跑 exit 0；十表对账（6 状态表精确相等 + 4 再生表 ≥90%）实跑通过。
- 2026-10-11 v2.1（评审2 C-1 修复后）：护栏 ack 自愈死代码修复（`stat -f%z "$ACK"` 取的是 ack 文件自身字节数→改 `cat`）；ack 分支本体沙箱突变实测通过（trip→ack→放行三态）；N-1 存储镜像心跳入看门；launchd 三任务 kickstart 全 exit 0。**教训：未演练的安全路径=未验证的声明——首版 ack 分支从未被执行过，一行死代码躲过了全部实跑。**

## 头号开放风险（诚实清单）

1. **无跨盘/跨机第二副本**（2026-10-11 实测 `tmutil destinationinfo` 无目标）：原件+22 份 dump+镜像全在 /dev/disk3s5。`/Users/Shared` 副本只防「误删」类事故（10-10 就是这类），**不防盘损**。本周内应配 Time Machine（需目标盘）或云副本（rclone，钥另管）。
2. **RPO ≤ 24h**：事故前最后一次 04:30 备份之后的教师消息/播放遥测真丢（wiki 内容可由源文件重摄兜底）。收紧：plist StartCalendarInterval 改数组 `[04:30, 12:30]`。
3. **kids_vocab_postgres 不在覆盖范围**（另一项目）；需要时照抄本目录模板。
3a. **对账清单口径**：十表之外今日全零的表（教师 chat/learning 等尚未落库）不在对账内——这些表开始有数据时，须把状态表清单扩进 pg-verify.sh 的 COUNTS_SQL。
4. 脚本内容器名 `src-server-postgres-1`、`/Users/Shared` 镜像路径为硬编码；compose 改名须同步。
5. 覆盖口径：plist 无 Nice/LowPriorityIO、日志不轮转（年增几 KB，观感项，记档）。
