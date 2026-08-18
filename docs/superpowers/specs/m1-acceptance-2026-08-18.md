# M1 验收记录（Task 16）

**日期**: 2026-08-18
**分支**: feat/Training-System（HEAD 7ee858b3）
**验收人**: Task 16 执行（SDD M1 plan）
**结论**: **四项全过**（①-④ 全部断言通过；偏差为记录性，不阻塞）

---

## 0. 验收环境与前置操作

| 项 | 值 |
|---|---|
| DB / Redis | Docker，127.0.0.1:5433（postgres llmwiki）/ 127.0.0.1:6380 |
| 迁移 | 001-013（`_sqlx_migrations`） |
| 数据 | project 614（team 916「LT师训」）：wiki_pages 376 页（transcripts 48 / concepts 216 / entities 108 / wiki 3 / notes 1），embeddings 3791 chunk 覆盖全部 376 页，media_assets 57 行（48 行关联 transcript 页） |
| embedding 服务 | 本机 :8001（bge-m3-mlx-fp16，运行中） |
| 凭据 | `tools/transcriber/out/bootstrap.env`（gitignored） |

**服务重启（验收前置）**：残留实例 PID 3854 经 `ps eww` 检查缺 `TRAINING__ADMIN_TOKEN`（③ 的 /bind fail-closed 会拒绝），故杀掉重启：

- `TRAINING__ADMIN_TOKEN` 尚未生成 → `openssl rand -hex 32` 生成并**追加到 bootstrap.env**（现 6 个键）
- 新 `JWT__SECRET`（openssl rand -hex 32，存 out/jwt-secret-m1.txt，未入 bootstrap.env——bootstrap.sh 脚手架定位为部署时生成）
- 重启命令（cwd=src-server）：

```bash
nohup env \
  TRAINING__PROJECT_ID=614 \
  TRAINING__ADMIN_TOKEN=<bootstrap.env> \
  MEDIA__SIGNING_KEY=<bootstrap.env> \
  AUTH__REGISTRATION_ENABLED=false \
  JWT__SECRET=<新值> \
  ./target/debug/llm-wiki-server >> logs/m1-acceptance-server.log 2>&1 &
```

- **新实例 PID 66615**，env 四项经 `ps eww 66615` 复核齐备；验收后保持运行（见 §5）

---

## ① search 命中 transcript 页 — **通过**

svc-transcriber login（bootstrap.env 的 SVC_PASSWORD）取 token 后：

```bash
curl -s -H "authorization: Bearer $SVC_TOKEN" \
  "http://127.0.0.1:8080/api/v1/search?project_id=614&query=班级管理"
```

| query | mode | vectorHits | tokenHits | 断言 |
|---|---|---|---|---|
| 班级管理 | **hybrid** | **20** | 49 | top5 全部 `transcripts/*.md`，snippet 含「班级管理」✅ |
| 课堂提问 | hybrid | 20 | 51 | 命中 transcripts/142、157 等（见偏差 1-a/1-b） |
| 家校沟通 | hybrid | 20 | 48 | 命中 transcripts/158、151 等（同上） |

「班级管理」top5（snippet 均出自命中段落且含查询词）：

```
transcripts/122-b6a58193.md  0.03227  snippet: "...你的班级管理呀 你跟家长的沟通等等..."
transcripts/157-39a5f806.md  0.03226  snippet: 'title: "157.【班级管理】如何“对付”课堂问题学生"'
transcripts/159-5ea22044.md  0.03202  snippet: 'title: "159. 【班级管理】学学米国小学老师是如何制定班规的"'
transcripts/160-classroom-rules-798336c6.md  0.03101  ...
transcripts/158-9e7bac82.md  0.03016  ...
```

**向量命中抽查：通过**——三次查询 vectorHits 均 20（>0），mode=hybrid（关键词 + 向量双路非空；src-server `search_mode`：vector_hits=0→Keyword、仅向量→Vector、双路→Hybrid）。

**偏差（记录性，spec 允许）**：
- 1-a「课堂提问」在 48 个 transcript 页正文中 **0 次字面出现**（psql LIKE 验证），故无含该词的 snippet——其命中为**语义向量召回**（正是向量层的价值场景）；结果集混入 wiki/index、concepts/class-data-management 等非 transcript 页，系 project 614 本就含 376 页多类型语料（concepts 216 + entities 108），非搜索缺陷。
- 1-b「家校沟通」同理：top 命中为语义相关 transcript 页，snippet 为 frontmatter 摘录形态，未含字面词。

原始响应留档：`tools/transcriber/out/search-班级管理.json`、`search-课堂提问.json`、`search-家校沟通.json`（未提交）。

## ② 签名 URL Range 播放 — **通过**（M1 桌面浏览器口径）

slug 取自 psql（transcript_page_path 非空的 48 行之一）：`157-39a5f806`（对应 ① 的班级管理 transcript，2509s）。

```bash
npx tsx tools/transcriber/src/cli.ts sign-media 157-39a5f806 --hours 12
# → http://127.0.0.1:8080/media/157-39a5f806?exp=1787080676&sig=1f1e…609d（12h 有效）
curl -s -o /dev/null -D - -H "Range: bytes=0-1023" "$URL"
```

```
HTTP/1.1 206 Partial Content
content-type: video/mp4
content-length: 1024
content-range: bytes 0-1023/65770120
accept-ranges: bytes
```

负向抽查：篡改 sig → **403**；过期 exp（1e9）→ **403**。

演示页已生成：`tools/transcriber/out/media-demo.html`（`<video controls>` + URL + 说明，**留在 out/ 不提交**）。桌面浏览器人工可播/可拖动确认待用户执行（服务绑回环仅本机可达；真机验证随 M2 隧道）。

**记录性偏差**：media_assets.playback_path 全库为空，/media/:id 经 `COALESCE(playback_path, media_ref)` 回落 serve media_ref（源文件直读）——Range/206 行为一致，M2 若引入转码副本再填 playback_path。

## ③ 注册关闭 + /bind 建测试号 — **通过**

服务以 `AUTH__REGISTRATION_ENABLED=false` 运行（PID 66615）：

```bash
curl -s -X POST http://127.0.0.1:8080/api/v1/auth/register -d '{...}'   # → HTTP 403 {"code":"PERMISSION_DENIED"}
curl -s -X POST http://127.0.0.1:8080/api/v1/training/bind \
  -H "x-training-admin-token: $TRAINING__ADMIN_TOKEN" \
  -d '{"wecom_userid":"test01","display_name":"验收账号"}'             # → HTTP 200
curl ... -H "x-training-admin-token: wrong-token" ...                   # → HTTP 401（负向）
```

/bind 200 返回：`access_token` + `refresh_token` + user（id=893，username=`wecom_test01`，full_name=验收账号）。DB 复核：`teacher_profiles`（id=10，onboarding_state=pending）、users 单行（无重复建号）。**重放 /bind → 200 幂等**（refresh 轮换语义，未产生第二账号）。

## ④ 端口绑定 — **通过**

```bash
lsof -nP -iTCP:8080 -iTCP:5433 -iTCP:6380 -sTCP:LISTEN
```

```
llm-wiki- 66615  TCP 127.0.0.1:8080 (LISTEN)   ← src-server
com.docke 62448  TCP 127.0.0.1:5433 (LISTEN)   ← postgres（Docker）
com.docke 62448  TCP 127.0.0.1:6380 (LISTEN)   ← redis（Docker）
```

三端口全部 `127.0.0.1`，无 `0.0.0.0`/外网绑定（awk 非回环扫描零输出）。无对外明文端口 ✅。

---

## 5. 既有记录引用与遗留

- **7 个 ingest 失败项**（验收前已存在，非本任务引入）：job `0892c518-d21a-432e-893f-51bf978a522d` → `succeeded_with_warnings`，48 items 中 41 done / 7 failed，全部同因 `step1 JSON parse failed`；slugs：119-58676fdb、123-3838e579、127-9f1efb27、128-23b35f09、132-63347618、134-65f347ed、140-5aeebd08。仅知识抽取缺失，**transcript 页与 media_assets 完整**（故本验收 ①② 不受影响——48 页均在库且已嵌入）。详见 `.superpowers/sdd/2026-08-17-training-m1-pipeline/task-15-report.md` 与 `tools/transcriber/out/m1-first-batch-report.json`（failedItems 全文 + M2 前重试建议）。
- **向量命中模式**：embedding 服务（:8001 bge-m3-mlx-fp16）全程在线，未出现降级 keyword 模式；376/376 页有嵌入，三次查询 mode 均 hybrid。
- **服务状态（验收后）**：src-server **PID 66615 保持运行**（env 含 TRAINING__PROJECT_ID=614 / AUTH__REGISTRATION_ENABLED=false / TRAINING__ADMIN_TOKEN / 新 JWT__SECRET / MEDIA__SIGNING_KEY）；日志 `src-server/logs/m1-acceptance-server.log`。注意：旧实例（PID 3854）env 中的 JWT__SECRET 为 config default，已被替换轮换——历史 token 全部失效属预期。
- **秘密管理**：TRAINING__ADMIN_TOKEN / 新 JWT__SECRET / 密码均不入库（bootstrap.env gitignored；本档 URL 的 sig 截断展示）。
