# M3 灰度 Runbook — 3-5 教师一周观察（2026-08-22 起）

> 适用：LT 师训系统 M3 交付后的灰度周（spec §9 M3 行「3-5 人灰度一周」）。
> 前置：M3 T1-T9 已全量验收（见 `docs/superpowers/specs/m3-acceptance-2026-08-22.md`）；live 服务（src-server 8080 / multiplex gateway / mcp-server / cloudflared / omlx）经 T9 重启演练自愈链验证。
> 操作机：本机（llm_wiki 检出 = `/Users/berton/Github/kb-obsidian/llm_wiki`，分支 feat/Training-System）。

---

## 1. 入选标准（3-5 人）

| 维度 | 标准 | 理由 |
|---|---|---|
| 身份 | 真实授课教师（本批以英语教师为主），非内部测试号 | 反馈可信（话术/内容质量只有真教师能判） |
| 意愿 | 知情同意：一周内会收到 1 次首单清单 + 1-2 次周报推送，愿意反馈 | 灰度核心产出是反馈，不是用量 |
| 机型分散 | 尽量覆盖不同手机品牌/系统版本（iOS 企微已验；安卓 HEVC 观察项依赖多机型样本） | HEVC 播放反馈是 M4 转码退役决策的最后确认面（§5.5） |
| 使用频率 | 每周至少打开 1 次清单、有真实学习意图 | overview 打开率/完成率基线需要有效样本 |
| 规模上限 | ≤5 人 | 周报 cron 分钟散列按 15 人容量设计，灰度期刻意留观察余量 |

现 live 已有 2 名教师（`TuoMaSiXueXiGuanGuangGuLanGuangX` 正式 + `test` 测试小号），灰度即在此基础上扩到 3-5 真实教师。

## 2. 加白步骤（每名新教师约 5 分钟）

**加白 = 企微可见范围 + 首触自然建档 + 周报 job 注册，三步，无需手工建库行。**

1. **企微可见范围**：企业微信管理后台 → 自建应用（lt-tutor 所用 wecom 应用）→ 可见范围 → 添加该教师。教师侧即可在企微里搜到应用并发消息。
2. **首触自然建档**：教师向应用发第一条消息（引导话术见 §3）→ gateway `profile_routing` 路由到 lt-tutor profile → SKILL 流程① 问卷（3-4 问）→ `upsert_profile` 建档（`onboarding_state: pending → surveyed`）→ 首个清单自动生成。凭证（`~/.llm-wiki-mcp/teachers.json`）由 MCP bind 自愈首次自动创建——**无需任何手工录入**。
   - 验证建档成功：§4 的 overview 扫一眼，新教师应出现在 `teachers[]` 且 `onboarding_state` 离开 `pending`。
3. **周报 job 注册**（脚本内置 profile home 默认值，直接跑）：
   ```bash
   ./docs/superpowers/deploy/weekly-report-register.sh add <教师企微userid>
   ```
   分钟按 `cksum(uid) % 15` 确定性散列（同 uid 重跑恒同分钟），落在周五 09:00-09:14。现 live job：TuoMaSi → `9 9 * * 5`（09:09）、test → `13 9 * * 5`（09:13），下次发火均为周五。
   - 列表核对：`HERMES_HOME=~/.hermes/profiles/lt-tutor hermes cron list`（CLI 尾部「Gateway is not running」告警为 multiplex 模式误报——gateway 由主 config 以 multiplex_profiles 运行，`launchctl list | grep ai.hermes.gateway` 有输出即正常）。

**注意**：注册脚本只写 lt-tutor profile 的 cron store，不另起任何服务进程（MCP 单实例约束见 §5.1）。

## 3. 引导话术（首次接触模板，操作者企微私发）

> 【学习助手开通】X 老师好，给您开通了咱们英语教研组的学习助手。直接在企微里给我发消息就能用：它会先问您几个教学上的问题（2 分钟），然后给您推一份专属的短视频学习清单，手机点开就能看、能标记"已完成"。以后每周五上午会汇总一份本周推荐。有任何不好用的地方直接跟我说就行，本周是试运行，您的反馈会直接改进它。

要点：不提"AI/测试/灰度"等内部词；明示"给我发消息"（首触是建档触发器）；预告周五推送（避免周报被当垃圾消息）；留反馈钩子（§4.3 通道）。

## 4. 每日 5 分钟观察项（固定三项）

### 4.1 overview 扫一眼（管理总览）

```bash
TOKEN=$(/usr/libexec/PlistBuddy -c 'Print :EnvironmentVariables:TRAINING__ADMIN_TOKEN' \
        ~/Library/LaunchAgents/wiki.src-server.plist)
curl -s -H "x-training-admin-token: $TOKEN" \
  http://127.0.0.1:8080/api/v1/training/overview | python3 -m json.tool
```

看四件事：① 每位灰度教师都在 `teachers[]` 里（缺人 = 建档/绑定失败）；② `onboarding_state` 在推进（新加白 2 天内应离开 pending）；③ `items.viewed/completed` 相对昨日有增量（有人真在用）；④ `items_7d` 与周报语义一致（周五后应出现本周新单）。admin token 读自 launchd plist（live 注入源），勿写进脚本仓库或聊天记录。

### 4.2 gateway 错误日志

```bash
tail -100 ~/.hermes/logs/gateway.log | grep -iE "error|unreachable"
```

- 常态：偶发单条 warn 可放过（网络抖动/上游 5xx 重试）。
- 需处置：`MCP server 'llm-wiki-training' is unreachable after 3 consecutive failures`（熔断，§5.2）；`[identity] rejected` **成串出现**（身份类异常，§7 退出判据；单条属正常拒冒名）；`delivered ... failed`（周报/推送投递失败）。
- 辅助：`tail -50 ~/.hermes/logs/gateway.error.log`；src-server 侧 `log show`/`~/.local/share/llm-wiki`（日志脱敏后仅前缀级，无凭证泄漏面）。

### 4.3 教师反馈通道

操作者企微私聊直接收集（灰度期唯一正式通道，按教师记名归档）；三类问题当场判级：播放不了（→§5.5 HEVC 观察表）、链接打不开（→§5.4）、话术/内容不对（→ SKILL 文案修订，走 §6.1 回滚通道）。

## 5. 重点观察清单

### 5.1 MCP 单实例约束（部署纪律，违者现场事故）

**勿并发起第二个 mcp-server 实例（或第二个 gateway）。** llm-wiki-training MCP 由 multiplex gateway 主进程单实例持有；多实例并发 = 教师 access 缓存/refresh 与 bind 轮换乒乓（互踢），教师侧表现为随机 401。自检：

```bash
pgrep -fl "mcp-server/dist/src/index.js"   # 应恰 1 个 node 进程（+1 个 watchdog 包装）
launchctl list | grep ai.hermes.gateway     # 应恰 1 行（exit code 0 列）
```

任何「直接 `node mcp-server/dist/src/index.js` 调试」「第二个检出再跑 gateway」的操作都违反此约束——调试用协议级探针（stdio JSON-RPC）或 `hermes cron fire`，不起第二实例。

### 5.2 熔断告警

T8 已修 read_file 404 误计熔断（990eac2b：应用级未找到改正常返回，不进 Hermes 熔断计数）；服务级故障（5xx/网络）仍会熔断 ~60s 属预期自保护。灰度期若日志再现 `unreachable after 3 consecutive failures`：记录触发前的工具名与错误原文 → 若为新 4xx 误计类，按 990eac2b 同法分流；若是真 5xx，查 src-server 健康（`curl -s localhost:8080/health`）。

### 5.3 周报周五 09:00-09:14 到达情况

- 到达核对（周五 09:20 前后）：① 教师/测试小号企微收到推送；② overview `items_7d` 出现本周单；③ `learning_plans` 该教师 `origin='weekly'` 且 `period_key` = 当周（幂等：重复 fire 不新建，话术自动改口"本周清单已生成"）。
- 分钟散列核对：`echo -n "<uid>" | cksum | awk '{print $1 % 15}'` 应等于 job schedule 的分钟数（现役：TuoMaSi=9、test=13）。
- 未到达处置：先 `hermes cron list` 看 job 是否 active → `weekly-report-register.sh fire <uid>` 手动兜底（一次性 job 走与正式触发完全相同的 gateway ticker + live 投递路径）→ 仍失败按 §4.2 日志定位。
- 补跑语义（T9 实测锚定）：gateway 停机盖过触发时刻时，起动后自动补跑**单次**（错过的当期拾起，非累计队列）；手动 fire 是另一条兜底通道，二者并集覆盖（spec §5.3 已回写）。

### 5.4 /s/ 链接过期投诉

- 设计事实：`/s/` 短码**不过期**；点开时现签 7 天有效的 `/t/` token；plan 被归档（status='archived'）即整体吊销（/s/、/t/、事件写入一律 404）。
- 教师报"链接打不开"排查序：① 是否 >7 天未点开（再点 /s/ 会重新现签，通常自愈——让教师从企微历史消息重点原 /s/ 链接即可）；② plan 是否被误归档（overview 看不到该单了 → 找 agent 重建或手动建单）；③ 隧道（`curl -s -o /dev/null -w "%{http_code}" https://api.xiaoluedu.top/health` 应 200）。
- 灰度期除非吊销需求，勿归档教师 active plan（归档=吊销是不可逆操作面）。

### 5.5 HEVC 播放反馈（多机型收集，M4 决策最后确认面）

已验证：iPhone 8 Plus（M2，playsinline 修复后）与 OPPO PHJ110/Android 13（M3 T8）均 HEVC 原件直播成功——M4「按需转码缓存」的退役依据已具备，但样本仅两款机型。灰度周每拿到一款新机型反馈就记一行：

| 日期 | 教师 | 机型/系统 | HEVC 能否播/能拖 | H.264 | 备注 |
|---|---|---|---|---|---|
| 2026-08-22 | test | OPPO PHJ110 / Android 13 | ✅（T8 E2E） | ✅ | — |
| （M2 已验） | — | iPhone 8 Plus / iOS WKWebView | ✅（playsinline 修复后） | ✅ | 原判定"不支持 HEVC"被推翻 |

任一机型 HEVC 播放失败 → 记录机型与现象（黑屏/转圈/报错），M4 决策保留按需转码；连续 3+ 机型全绿 → M4 转码缓存确认退役。

## 6. 异常处置路径（快捷回滚）

### 6.1 回滚 SKILL（话术/编排出问题，最常用）

```bash
# 需回到某历史版本时先取版本：git -C /Users/berton/Github/kb-obsidian/llm_wiki \
#   checkout <commit> -- docs/superpowers/hermes/lt-tutor/SKILL.md
cp /Users/berton/Github/kb-obsidian/llm_wiki/docs/superpowers/hermes/lt-tutor/SKILL.md \
   ~/.hermes/profiles/lt-tutor/skills/teacher-tutor/SKILL.md
diff /Users/berton/Github/kb-obsidian/llm_wiki/docs/superpowers/hermes/lt-tutor/SKILL.md \
     ~/.hermes/profiles/lt-tutor/skills/teacher-tutor/SKILL.md   # 必须为空
```

SKILL 是 prompt 层，**替换即生效**（新会话），无需重启任何服务。版本锚点：当前 live = 990eac2b 版（含 read_file path 纪律）；39e42b69 = 视频优先硬规则版。

### 6.2 停某教师的周报 job

```bash
./docs/superpowers/deploy/weekly-report-register.sh remove <教师企微userid>
```

（add 可确定性重建，同 uid 同分钟，无需备份。）

### 6.3 服务级回滚

- mcp-server / src-server 代码回滚：git revert 目标 commit → 控制器流程 rebuild + kickstart（gateway：`launchctl kickstart -k gui/501/ai.hermes.gateway`；src-server 同法）——灰度期无 planned rebuild，仅事故时。
- profile/部署配置整体回滚：`docs/superpowers/deploy/lt-tutor-deploy.sh rollback`（mkstemp+rename 原子恢复，字节级）。
- **教师数据不回滚**：learning 三表事件即事实，出错单走归档吊销而非删行。

## 7. 一周退出判据（进 15 人放量 / 延长灰度 / 回退，三选一）

| 判据 | 达标线 | 数据源 |
|---|---|---|
| 身份类告警 | **零**（`[identity] rejected` 成串、IdentityMismatch/Unavailable 服务端 warn 突增、任何冒名成功案例） | §4.2 日志周汇总 |
| 周报到达 | **5/5**（全部灰度教师当周五收到；补跑/手动 fire 达到不算失败但要记原因） | §5.3 周五核对 + 教师确认 |
| 清单打开率 | 建立基线：≥60% 灰度教师在周内至少 viewed 1 条目（overview `items.viewed>0` 人数占比） | §4.1 overview 每日快照 |
| 完成率 | 建立基线：周完成条目/周条目数，无固定门槛（首周任何正值即有效信号） | overview `items_7d.completed/items_7d.total` |
| 重大缺陷 | 无阻断级（播放全败/链接全失效/身份事故）；热修 ≤2 次且已复盘归档 | 本 runbook §4-§6 记录 |

全部达标 → 按 spec §9 M4 行放量至 15 人；任一不达标 → 延长一周并针对短板修补；出现身份事故或连续两周五/5 不到 → 回退（§6.2 全员停 job + SKILL 回滚到 M2 版），重新评估后再启动。

## 8. 升级/迁移（schema 变更与新环境部署）

- **① schema 变更对 live 库（本机实际采用 docker exec psql 直灌；`sqlx migrate run` 是 CI（ci.yml）与开发库路径，live 库按此惯例人工执行）**：

  ```bash
  docker exec -i src-server-postgres-1 psql -U llmwiki -d llmwiki \
    < src-server/migrations/<file>.sql
  ```

  （017 即此法应用并经 `information_schema` 验证，见 SDD `task-minor-batch-c-report.md` §1/§5。）
- **② 017 的后置步骤**（迁移保持通用不写死项目值，部署侧显式执行过一次）：

  ```sql
  UPDATE projects SET ingest_language='简体中文' WHERE id=614;
  -- 回退（如需）：UPDATE projects SET ingest_language=NULL WHERE id=614;
  ```
- **③ compose 镜像内 migrations 只拷贝、不自动执行**（`src-server/Dockerfile:29` `COPY src-server/migrations /app/migrations` 仅落盘；`CMD` 只起服务，无 migrate 步骤）——**新环境用 compose 部署后必须人工跑 ①**，否则首启动即撞缺列/缺表。
- **④ 终审必修批（SEC-2）新增必配 env**：`MEDIA__ALLOWED_ROOTS`（逗号分隔绝对路径列表）——/media 服务与 media-assets upsert 的 playback_path 许可根集；`MEDIA__SIGNING_KEY` 非空而此键为空时**启动即拒**（fail-closed）。live 重启前须在 launchd plist（`~/Library/LaunchAgents/wiki.src-server.plist`，模板 `docs/superpowers/deploy/wiki.src-server.plist.template`）注入，至少覆盖媒体实际存放根（如 transcriber out/playback 与课程源目录）。

## 9. 灰度期记录

每日观察结果（三项 + 异常）记入本文件同目录运营日志或 SDD 账本；周五周报核对结果与周一退出判据评估各留一次快照（overview JSON 原文存档）。
