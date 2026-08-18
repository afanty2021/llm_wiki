# LT 师训系统 M2 learning 域 + 通道 + 基础设施 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 M2：learning 域三表 + 培训 API + `/t/` 落地页（view/seen 双粒度 beacon）+ teacher-tutor MCP/SKILL 接入 Hermes 企微通道 + 隧道/保活/脱敏基础设施，完成 M2 版 E2E；先收编 M1 评审遗留的前置批次。

**Architecture:** 四阶段——A 前置收敛（ingest max_tokens 根因 + 重转/重跑、防御批次）；B 服务端 learning 域（migration 014/015、JWT typ 隔离、plans/items/events API、落地页三端点、媒体签名升级）；C 通道（mcp-server 扩展凭证持有 + lt-tutor profile 白名单接入本机 Hermes）；D 基础设施（/ingest 鉴权、日志脱敏、launchd、cloudflared、真机确认、E2E 与验收）。

**Tech Stack:** Rust axum/sqlx（既有）、TypeScript mcp-server（node --test）、Hermes 本机部署（profile_routes/mcp_servers/skills）、cloudflared 2026.3.0（已装）、launchd。

**Spec:** `docs/superpowers/specs/2026-08-17-teacher-training-design.md`（v5 §4/§5/§6/§9-M2 行；M0/M1 已交付）

## Global Constraints

- **分支**：`feat/Training-System`（继续）；每任务一个 commit；用户批准式执行下 commit 前等待
- **JWT typ 隔离**（spec §4.2）：`Claims.typ: Option<String>`——`require_auth` 仅接受 `None | Some("access")`；`plan_link` token（typ="plan_link"，绑 plan_id+user_id+exp 7d）只能走 `/t/*` 三端点，交叉全拒；`/bind` 产出的 access 带 `typ="access"`
- **beacon 双粒度**（spec §4.1 写死）：页面级（无 item_id）只记 plan 级 seen 事件不碰投影；项级（带 item_id，校验 ∈ plan）记事件 + 置 viewed 同事务；complete 单调守卫 `WHERE status <> 'completed'`；rebuild_projection 只消费 item 级事件
- **period_key 幂等**：`UNIQUE(user_id, origin, period_key)`；同周重复创建返回既有 plan
- **资源归属**：plan→user、item→plan→user 与 token 用户一致，不一致按 404；collection 只返回本人
- **/media 签名升级**：HMAC 消息 `{media_id}:{exp}:{link_fingerprint}`（fingerprint=plan_link token 的 sha256 前 16 hex）；M1 的两段式 URL 兼容期保留（同一验签函数双格式尝试）——**改签名必须 Rust/TS 两侧同改**（预计算向量锁）
- **凭证持有**（spec §5.1）：老师 refresh token 只存 MCP server 进程侧文件（`~/.llm-wiki-mcp/teachers.json`，600，gitignore 外部目录）；工具首参 `wecom_userid`（标识符可进 LLM 上下文，token 不进）；MCP server 自己调 /bind（管理员 token 经其 env）与 /auth/refresh（single-flight）
- **Hermes 接线**（探查核实）：profile 目录 `~/.hermes/profiles/lt-tutor/`（独立 config.yaml：model 沿用 zai glm-5.2、`platform_toolsets`/toolsets 收敛到 `skills`、`mcp_servers.llm-wiki-training` stdio 指向本包 dist）；主 config 加 `gateway.multiplex_profiles: true` + `profile_routes: [{name: lt-tutor-wecom, platform: wecom, profile: lt-tutor}]`；**改主 config 前备份**（既有 config.yaml.backup* 惯例），改后 `hermes gateway` 重启验证
- mcp-server 默认端口 19828 是错的——env 必须显式 `LLM_WIKI_API_BASE_URL=http://127.0.0.1:8080`
- 日志脱敏只改 logging_middleware 内 URI 处理：`/t/`、`/media/` 的路径与 query 输出为 `/t/[REDACTED]` / `/media/[REDACTED]`
- 不改 search/pages/ingest 既有端点行为（唯一例外：`/ingest/jobs/:id` 加项目鉴权 = spec §6 既定项；ingest max_tokens 是配置值调整）
- 服务端测试沿用"改 config 后 create_app"注入模式 + unique() 隔离；mcp 测试 node --test + injected fetchImpl；SKILL dry-run 用 mock 工具脚本
- E2E 前置：安卓测试机（用户配合）开 `/t/` 链接确认 HEVC 能力；不行则测试件预转 H.264（`--demo-slug` 模式复用）
- 用户辅助节点（不可自动化，plan 内标注 USER）：cloudflared tunnel login（浏览器）、安卓真机确认、Hermes 主 config 变更确认

## File Structure

```
src-server/
  migrations/014_learning.sql                 # learning_plans/items/events + period_key 唯一
  migrations/015_drop_redundant_indexes.sql   # 清理 013 冗余索引
  src/models/auth.rs                          # Claims.typ
  src/utils/jwt.rs                            # typ 校验 + plan_link 签发/验证
  src/routes/training.rs                      # +profile/events/plans/items/link 端点
  src/routes/t_page.rs                        # GET /t/:token + POST seen/complete + 落地页 HTML
  src/routes/media.rs                         # 签名升级（link_fingerprint）
  src/routes/ingest.rs                        # /jobs/:id 项目鉴权
  src/middleware/logging.rs                   # URI 脱敏
  src/services/projection.rs                  # 事件→投影（同事务）+ rebuild_projection
  tests/integration/{learning_api,t_page}_test.rs
mcp-server/
  src/training.ts                             # training 工具组 + 凭证持有 + bind/refresh single-flight
  src/index.ts                                # 注册 training 工具
  test/training.test.ts
tools/transcriber/                            # T4 CLI 健壮批次；T1 重转运行
~/.hermes/profiles/lt-tutor/                  # config.yaml + skills/teacher-tutor/SKILL.md（部署物，不入 git）
~/Library/LaunchAgents/{wiki.src-server,com.cloudflare.cloudflared}.plist
docs/superpowers/specs/m2-acceptance-*.md     # 验收记录
```

---

### Task 1: ingest step1 截断根因修复 + 7 项重跑 + 首批带 prompt 重转

**Files:**
- Modify: `src-server/src/services/ingest_pipeline.rs:245-255`
- 运行产物: `tools/transcriber/out/m1-first-batch-report.json`（覆盖更新，提交）

**Interfaces:**
- Produces: step1 `max_tokens: 32000`；usage 日志 `tracing::info!(project_id, prompt_tokens, completion_tokens, "step1 usage")`；`completion_tokens == max_tokens` 时 `tracing::warn!("step1 likely truncated")`

- [ ] **Step 1: 修改**（RED：现有测试无覆盖则先补一个 ChatOpts 断言测试——若 services 层无既有测试基建，改手动验证 + 记录）

```rust
// ingest_pipeline.rs step1_analyze，ChatOpts 与解构处：
let opts = ChatOpts { model, temperature: 0.3, max_tokens: 32000, system_prompt, timeout_secs: None };
let (response, usage) = provider.chat_to_string(messages, opts).await.map_err(...)?;
if let Some((pt, ct)) = usage {
    tracing::info!(project_id, prompt_tokens = pt, completion_tokens = ct, "ingest step1 usage");
    if ct >= 32000 { tracing::warn!(project_id, "ingest step1 likely truncated (completion>=max_tokens)"); }
}
```

- [ ] **Step 2: `cargo test`（lib+integration 全绿）+ 提交** `fix(server): ingest step1 max_tokens 12000→32000 + usage/截断日志（7 项失败根因）`

- [ ] **Step 3: 7 项重跑**——起服务（若未运行）后对 7 个失败源文件重新触发：

```bash
source tools/transcriber/out/bootstrap.env
# 7 个 slug 的 source_path 从 m1-first-batch-report.json failedSources 映射（psql 可查 media_assets.source_path）
curl -s -X POST "http://127.0.0.1:8080/api/v1/projects/614/ingest" \
  -H "authorization: Bearer $(curl -s -X POST localhost:8080/api/v1/auth/login -H 'content-type: application/json' -d "{\"username\":\"svc-transcriber\",\"password\":\"$SVC_PASSWORD\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')" \
  -H 'content-type: application/json' -d '{"source_paths":[<7 个 sources/transcripts/<slug>.md>]}'
# 轮询 job 至终态；目标 7/7 done（若仍截断，记录并升高/分片——本次 32000 应足够）
```

- [ ] **Step 4: 首批带 prompt 重转**（后台长任务 ≈2h）：

```bash
npx tsx tools/transcriber/src/cli.ts transcribe --window 00:00-23:59 --force
# --force 重置 state 后全量重转（带域词 prompt，M1 终审修复已补）；断点续跑语义保留
```

终态后重跑 ingest 触发（脚本对全部 48 source 重触发——CLI 主流程已含；确认 job 0 failed）。更新 `m1-first-batch-report.json` 并提交：`docs(transcriber): M2 前置——7 项重跑 + 首批带 prompt 重转结果留档`

---

### Task 2: transcripts/ 前缀运行时拒绝

**Files:**
- Modify: `src-server/src/services/ingest_pipeline.rs`（upsert_wiki_page 调用侧或其内部）
- Test: 既有 ingest 测试基建若有则加用例；否则以 services 层纯函数 `is_llm_generated_path` 抽出 + lib 测试

- [ ] **Step 1: 失败测试**——lib 测试：`llm_generated_page_path("transcripts/xx.md") == true`、`("transcript-note.md") == false`、`("pages/xx.md") == false`
- [ ] **Step 2: 实现**——ingest 生成页写入前：`if page.path.starts_with("transcripts/") { tracing::warn!(path, "skip LLM page into transcripts/ namespace"); continue; }`（在 upsert 循环处，不改 upsert 本身）
- [ ] **Step 3: `cargo test` 全绿 + 提交** `feat(server): ingest 运行时拒绝 LLM 生成页写入 transcripts/ 命名空间（spec §3.2-⑤ 防御）`

---

### Task 3: 服务端防御批次

**Files:**
- Modify: `src-server/src/routes/training.rs`（bind）、`src-server/src/routes/media.rs`、`docker-compose.prod.yml`、`src-server/src/routes/training.rs`（长度校验）
- Create: `src-server/migrations/015_drop_redundant_indexes.sql`

**Interfaces:** 逐项独立小修，每项带测试或验证命令

- [ ] **Step 1: bind 并发竞态**——existing 查询移入事务并 `FOR UPDATE`：

```rust
let existing: Option<i32> = sqlx::query_scalar(
    "SELECT user_id FROM teacher_profiles WHERE wecom_userid = $1 FOR UPDATE")
    .bind(&req.wecom_userid).fetch_optional(&mut *tx).await.map_err(AppError::from)?;
```

（事务 begin 提前到查询前；后续 username SELECT 同事务。）集成测试：并发两个 bind 同 wecom_userid（tokio::join! 两请求）→ 均 200 且同一 user_id。

- [ ] **Step 2: 长度校验 400**——bind：`wecom_userid.chars().count() > 64 || display_name 超长 → BadRequest`；media-assets：`slug.len() > 200 → BadRequest`。各补矩阵断言。

- [ ] **Step 3: /media 签名纵深**——`signing_key.len() < 32 → InternalError("MEDIA__SIGNING_KEY too short")`（启动时 validate 加一条更佳：validate() 中 `cfg.media.signing_key` 非空时校验长度）；`exp - now > 30*86400 → 403`。补测试。

- [ ] **Step 4: compose prod 键名批改**——`docker-compose.prod.yml` 其余键改双下划线映射：`DATABASE__URL/STORAGE__PATH/SERVER__HOST/SERVER__PORT/CORS__ALLOWED_ORIGINS`（容器侧名，宿主插值名不变）；`docker compose -f docker-compose.prod.yml config` 渲染核对。

- [ ] **Step 5: migration 015**：

```sql
DROP INDEX IF EXISTS idx_media_assets_slug;
DROP INDEX IF EXISTS idx_teacher_profiles_wecom;
```

应用 + `cargo test` 全绿。

- [ ] **Step 6: 提交** `fix(server): M2 前置防御——bind FOR UPDATE/长度 400/签名纵深/compose 键名/015 清冗余索引`

---

### Task 4: CLI/mcp 健壮批次

**Files:**
- Modify: `tools/transcriber/src/{cli.ts,api-client.ts}`、`mcp-server/src/index.ts`（VERSION 对齐）

- [ ] **Step 1: waitJob 总超时 + 有界重试**——`waitJob(jobId, {timeoutMs: 4h 默认, retryOn5xx: 3})`：单次非 2xx 重试至 3 次（退避 5s/15s/60s）；超时抛错带 job_id。测试：mock 500×2 → 第 3 次成功；超时路径。
- [ ] **Step 2: 参数校验**——`--window`/`--demo-slug` 末位缺值（下一 token 是 flag 或结尾）→ 报错退出（不再静默默认）；`--window` 格式非法已有 fail-fast，补 CLI 层测试。
- [ ] **Step 3: tryRefresh try/catch**——网络/JSON 异常吞掉返回 false（对齐 tryRelogin），测试补畸形 200 body 用例。
- [ ] **Step 4: parseFrontmatter 直测**——mcp/transcriber 共用形态：直测 T13 形态（type/sources/media_slug/duration_s）+ 退化（无 frontmatter → concept 语义）。
- [ ] **Step 5: mcp VERSION 对齐**——index.ts VERSION="0.4.20" → 从 package.json 读或改 "0.4.23"。
- [ ] **Step 6: 全量验证**（vitest 105+/tsc/两包 build）+ 提交 `fix(transcriber,mcp): M2 前置——waitJob 超时重试/参数校验/tryRefresh 守卫/parseFrontmatter 直测/版本对齐`

---

### Task 5: migration 014（learning 三表）

**Files:**
- Create: `src-server/migrations/014_learning.sql`

- [ ] **Step 1: SQL**（spec §4.1 逐列）

```sql
CREATE TABLE learning_plans (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR(200) NOT NULL,
  reason TEXT,
  origin VARCHAR(10) NOT NULL CHECK (origin IN ('chat','weekly')),
  period_key VARCHAR(20),
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX idx_plans_period ON learning_plans(user_id, origin, period_key) WHERE period_key IS NOT NULL;

CREATE TABLE learning_items (
  id SERIAL PRIMARY KEY,
  plan_id INTEGER NOT NULL REFERENCES learning_plans(id) ON DELETE CASCADE,
  kind VARCHAR(10) NOT NULL CHECK (kind IN ('wiki_page','media')),
  target_ref TEXT NOT NULL,
  timecode_start_s INTEGER, timecode_end_s INTEGER,
  label VARCHAR(200) NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','viewed','completed')),
  completed_at TIMESTAMPTZ
);
CREATE INDEX idx_items_plan ON learning_items(plan_id);

CREATE TABLE learning_events (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id INTEGER REFERENCES learning_items(id) ON DELETE SET NULL,
  event_type VARCHAR(20) NOT NULL CHECK (event_type IN ('view','seen','complete','ask','plan_created')),
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_events_user_time ON learning_events(user_id, created_at DESC);
CREATE INDEX idx_events_item ON learning_events(item_id) WHERE item_id IS NOT NULL;
```

- [ ] **Step 2: 应用 + psql \d 三表 + `cargo test` 全绿**
- [ ] **Step 3: 提交** `feat(server): migration 014 learning（plans/items/events + period_key 部分唯一索引）`

---

### Task 6: JWT typ 隔离 + plan_link token

**Files:**
- Modify: `src-server/src/models/auth.rs`（Claims）、`src-server/src/utils/jwt.rs`、`src-server/src/middleware/auth.rs`、`src-server/src/routes/training.rs`（bind 产 typ="access"）

**Interfaces:**
- Produces:
  - `Claims { ..., #[serde(default, skip_serializing_if = "Option::is_none")] pub typ: Option<String> }`
  - `generate_access_token(...)` 签名不变，内部 claims.typ = Some("access")
  - `generate_plan_link_token(user_id, plan_id, secret, ttl) -> Result<String>`（typ="plan_link"，custom claim `plid: i32`）
  - `verify_plan_link_token(token, secret) -> Result<(user_id, plan_id)>`（typ 必须为 plan_link）
  - `require_auth`：decode 后 `if let Some(t) = &claims.typ { if t != "access" { return Err(AuthInvalid) } }`（None 兼容存量）

- [ ] **Step 1: 失败测试**（lib 单测，utils 层）：plan_link token 被 `verify_token`/require_auth 语义拒（typ 不符 → AuthInvalid）；access token 过 require_auth；无 typ 旧 token 兼容通过；plan_link 往返 (user_id, plan_id)
- [ ] **Step 2: 实现** + bind 的 access 生成走新路径（自动带 typ）
- [ ] **Step 3: `cargo test` 全绿（含既有 auth 测试不回归——旧 token 无 typ 兼容）+ 集成冒烟**（bind → access 调 search 仍 200）
- [ ] **Step 4: 提交** `feat(server): JWT typ 隔离（access/plan_link 互斥，存量无 typ 兼容）`

---

### Task 7: training API 批 1（profile/events/progress）

**Files:**
- Modify: `src-server/src/routes/training.rs`
- Create: `src-server/tests/integration/learning_api_test.rs`（mod.rs 注册）

**Interfaces:**
- `GET /api/v1/training/profile`（access，本人）→ 404 无档案 或 {wecom_userid, display_name, subject, grade_levels, goals, interests, onboarding_state}
- `PUT /api/v1/training/profile`（access）body 上述可变字段（onboarding_state 允许 pending→surveyed，禁止反向）；跨用户不可达（token 即本人）
- `POST /api/v1/training/events`（access）body {event_type:"ask", payload}——**仅 ask**，其他 400
- `GET /api/v1/training/progress`（access）→ {plans: [{id,title,origin,status,items:{total,viewed,completed}}], recent_events: 最近 20 条}

- [ ] **Step 1: 失败测试**——矩阵：无 token 401；ask 事件落库；非 ask 400；profile 404→PUT→GET 往返；progress 空态/有数据态
- [ ] **Step 2: 实现**（全部经 require_auth + user_id=claims.sub；profile 行按 teacher_profiles.user_id 查）
- [ ] **Step 3: `cargo test` 过 + 提交** `feat(server): training API 批1——profile/events(ask)/progress`

---

### Task 8: training API 批 2（plans/items/link/complete + 投影）

**Files:**
- Modify: `src-server/src/routes/training.rs`
- Create: `src-server/src/services/projection.rs`（mod 声明）
- Modify: `tests/integration/learning_api_test.rs`

**Interfaces:**
- `POST /api/v1/training/plans`（access）body {title, reason?, origin:"chat"|"weekly", period_key?, items:[{kind, target_ref, timecode_start_s?, timecode_end_s?, label}]} → 201 {plan, items, link: "/t/<token>"}（事务：plan+items+plan_created 事件；period_key 冲突 → 200 返回既有 plan（幂等）；target_ref 校验：wiki_page → pages 表存在（project 614）或以 transcripts/ 前缀；media → media_assets.slug 存在；绝对路径/非法 kind 400）
- `GET /api/v1/training/plans?status=` / `GET .../plans/:id`（归属 404）
- `POST /api/v1/training/plans/:id/link`（归属）→ {link}（重签 7d）
- `POST /api/v1/training/items/:id/complete`（access；归属链校验 item→plan.user_id）——`projection::complete_item(&mut tx, item_id, user_id)`：记 complete 事件 + `UPDATE learning_items SET status='completed', completed_at=NOW() WHERE id=$1 AND plan 的归属 AND status <> 'completed'`（单调）
- `projection::apply_seen(tx, plan_id, item_id|None, user_id)`：item 级 → viewed 单向（pending→viewed，completed 不回退）；页面级仅事件
- `projection::rebuild(user_id)`（lib 可测：清 items.status 后按 events 重放）——路由挂 `POST /api/v1/training/progress/rebuild`（access，仅本人，M2 调试用）

- [ ] **Step 1: 失败测试**——创建往返+link 可验签；period_key 幂等（二次 200 同 id）；归属（B 的 token 访 A 的 plan → 404；A 完成 B 的 item → 404）；单调（complete 后 seen 不回退、二次 complete 幂等 200）；target_ref 非法 400
- [ ] **Step 2: 实现**（全部事务 + 上述投影函数）
- [ ] **Step 3: `cargo test` 过 + 提交** `feat(server): training API 批2——plans/items/link/complete + 事件投影（单调守卫/幂等/归属）`

---

### Task 9: /t/ 落地页三端点 + 媒体签名升级

**Files:**
- Create: `src-server/src/routes/t_page.rs`（mod.rs `.merge(t_page::t_routes())` 在 fallback 前）
- Modify: `src-server/src/routes/media.rs`（fingerprint 签名）
- Create: `src-server/tests/integration/t_page_test.rs`

**Interfaces:**
- `GET /t/:token`（plan_link）：验签（typ/plan 归属过期 403/404）→ **同事务记 view 事件（payload {ua 简化}}，不改投影）** → 200 HTML
- `POST /t/:token/seen` body {item_id?}——双粒度（页面级：plan 级 seen 事件；项级：item ∈ plan 校验 + apply_seen）
- `POST /t/:token/complete` body {item_id}——校验 ∈ plan → complete_item
- `/media/:media_id` 签名消息升级 `{media_id}:{exp}:{fp}`；`fp` 缺省时回落两段式（M1 兼容期）；`utils/media_sign.rs` 增 `sign_media_with_fp/verify`（**TS 侧 api-client.ts 同步同改 + 新预计算向量**）
- 落地页 HTML（内联 String 模板，无前端框架）：plan 标题/周报摘要、items 列表（media 项：`<video|audio controls>` src=带 fp 签名 URL + chapters 列表（media_assets.chapters，点击 `video.currentTime=start_s`）+ transcript 阅读（wiki 页 content，`## [mm:ss]` 标题转可点击跳转）+ 摘要页链接；wiki_page 项：只读渲染 content）；页面级 beacon `<script>fetch('/t/TOKEN/seen',{method:'POST'})`；项级：进入项容器时带 item_id 发；完成按钮 → POST complete；token 过期态的提示文案（回企微要新链接）。mobile-first `<meta viewport>` + 简洁内联 CSS。

- [ ] **Step 1: 失败测试**——t_page 矩阵：错 typ（access token 调 /t/）403、过期 403、HTML 含 plan 标题与 items、view 事件落库且**不改投影**、seen 页面级（无 item_id：plan 级事件、items 不动）、seen 项级（viewed 投影 + completed 不回退）、complete 伪造 item_id（∉ plan）400、/media 带 fp 签名 206 且旧两段式兼容 206
- [ ] **Step 2: 实现**（HTML 生成为纯函数 `render_t_page(plan, items, media_assets, signed_urls) -> String`，lib 可测：给定 fixture 断言关键标记）
- [ ] **Step 3: TS 侧签名同步**（api-client.ts `signMediaUrl` 支持 fp 参数 + 预计算向量两枚）
- [ ] **Step 4: `cargo test` + vitest 全绿 + 桌面浏览器人工冒烟**（curl 拿 HTML → 本地打开 → 播放/跳章节/完成按钮走通）+ 提交 `feat(server): /t/ 落地页三端点+beacon 双粒度+媒体签名 fingerprint 升级`

---

### Task 10: mcp-server training 工具组 + 凭证持有

**Files:**
- Create: `mcp-server/src/training.ts`、`mcp-server/test/training.test.ts`
- Modify: `mcp-server/src/index.ts`（注册）、`mcp-server/src/api-client.ts`（新增 training 端点方法：profileGet/Put、eventAsk、planCreate/List、itemComplete、planLink、progress、bind、login、refresh）

**Interfaces:**
- `TeacherCredentialStore`：文件 `~/.llm-wiki-mcp/teachers.json`（600；`{wecom_userid: {refreshToken, userId}}`）；`getAccess(wecom_userid)`——内存 access 缓存（提前 60s 过期）→ 不可用则 `refreshToken` 调 /auth/refresh（**single-flight**：并发同 userid 只发一次）；refresh 失败 → 调 /bind（env `TRAINING__ADMIN_TOKEN`）重建档案并轮换
- 工具（全部首参 `wecom_userid: string`，token 由 store 注入，**不出现在工具返回值**）：
  - `teacher_tutor_profile_get/put`、`teacher_tutor_record_ask {payload}`
  - `teacher_tutor_plan_create {title, reason?, origin, period_key?, items[]}`（返回含 /t/ 完整链接——env `PUBLIC_T_BASE` 拼 `https://<tunnel-host>` 或 `http://127.0.0.1:8080`）
  - `teacher_tutor_plan_list`、`teacher_tutor_item_complete {item_id}`、`teacher_tutor_plan_link {plan_id}`
  - `teacher_tutor_progress`；`llm_wiki_read_file` 复用（read_page 即它，SKILL 直接用）
- 注册进 ListTools/CallTool（沿用 index.ts 模式）；`LLM_WIKI_API_BASE_URL` 必须显式 env

- [ ] **Step 1: 失败测试**（node --test + injected fetchImpl + tmpdir credential store）：store 600 权限、refresh single-flight（并发 3 请求 → 1 次 refresh 调用）、refresh 失败回落 bind、工具透传形状、plan_create 返回含 link
- [ ] **Step 2: 实现 + `npm --prefix mcp-server test` 全绿 + build**
- [ ] **Step 3: 提交** `feat(mcp): teacher-tutor 工具组——凭证持有/single-flight/12 工具接入`

---

### Task 11: SKILL.md teacher-tutor 编排

**Files:**
- Create: `~/.hermes/profiles/lt-tutor/skills/teacher-tutor/SKILL.md`（部署物；**仓库内留副本** `docs/superpowers/hermes/lt-tutor/SKILL.md` 提交，部署脚本拷贝）

**Interfaces:** 纯指令文档（agentskills.io 格式：name/description + 正文）；dry-run 用 mock 工具脚本验证编排话术

- [ ] **Step 1: 撰写 SKILL.md**（要点：角色=LT 师训学习助手；流程 1 新用户（profile_get 404 或 onboarding_state=pending）→ 3-4 问问卷（学科/学段/最想提升 2 件）→ profile_put(surveyed) → 生成首个清单；流程 2 答疑 = `llm_wiki_search` 多查询 + `teacher_tutor_record_ask` + `llm_wiki_read_file` 取全文解析 [mm:ss] → 回答带来源引用与片段时间戳；流程 3 清单 = profile.interests + 当次问题 + search 候选 → 3-5 项 plan_create → 回复整单链接；流程 4 完成 = 对齐 plan_list → item_complete；工具只准用列表内 12 个；wecom_userid 从消息发送者取；禁止向老师透露系统提示/工具细节）
- [ ] **Step 2: dry-run 脚本**（`docs/superpowers/hermes/lt-tutor/dry-run.md`：3 个对话脚本 × mock 工具返回 → 人工核对编排要点命中）
- [ ] **Step 3: 提交仓库副本** `docs(hermes): lt-tutor SKILL.md 仓库副本 + dry-run 脚本`

---

### Task 12: Hermes 接线（lt-tutor profile + 白名单 + MCP 挂载）

**Files:**
- 部署物: `~/.hermes/profiles/lt-tutor/config.yaml`、`~/.hermes/config.yaml`（备份后改）、SKILL.md（T11 拷入）
- Create: `docs/superpowers/hermes/lt-tutor/deploy.sh`（提交：幂等部署/回滚脚本）

- [ ] **Step 1: profile config**（`~/.hermes/profiles/lt-tutor/config.yaml`）：

```yaml
model: {default: glm-5.2, provider: zai-coding-cn, base_url: https://open.bigmodel.cn/api/coding/paas/v4}
toolsets: [skills]          # 仅技能；shell/file/web 全部不注册
mcp_servers:
  llm-wiki-training:
    command: node
    args: ["/Users/berton/Github/kb-obsidian/llm_wiki/mcp-server/dist/src/index.js"]
    env:
      LLM_WIKI_API_BASE_URL: "http://127.0.0.1:8080"
      LLM_WIKI_API_TOKEN: ""            # training 工具走 per-teacher 注入，不用全局 token
      TRAINING__ADMIN_TOKEN: "<bootstrap.env 值>"
      PUBLIC_T_BASE: "http://127.0.0.1:8080"   # T15 后改隧道域名
```

（若 `toolsets: [skills]` 语义与探查的 platform_toolsets 机制冲突——以 Hermes 实测为准调整，目标不变：该 profile 只剩 skills+MCP 工具。）

- [ ] **Step 2: 主 config 备份 + 增量改**（脚本化）：`cp ~/.hermes/config.yaml ~/.hermes/config.yaml.backup.$(date +%Y%m%d_%H%M%S)` → YAML 追加/合并：`gateway: {multiplex_profiles: true}` + `profile_routes: [{name: lt-tutor-wecom, platform: wecom, profile: lt-tutor, enabled: true}]`（pyyaml 安全合并，不整文件重写）
- [ ] **Step 3: 重启 gateway + 验证**（launchctl kickstart 或 hermes CLI）：自测企微账号发消息 → 命中 lt-tutor profile（日志确认路由）→ 问卷触发 → 工具白名单验证（诱导"执行 ls"必须被拒/无工具可调——人工+日志确认）；**本步骤动到用户在用的 gateway，执行前 USER 确认**
- [ ] **Step 4: deploy.sh 提交**（含回滚：恢复备份 config + 删 profile 目录 + 重启）`feat(hermes): lt-tutor 部署脚本（profile/白名单/路由/回滚）`

---

### Task 13: /ingest 鉴权收敛 + 日志脱敏

**Files:**
- Modify: `src-server/src/routes/ingest.rs:70-77`、`src-server/src/middleware/logging.rs`

- [ ] **Step 1: /jobs/:id 鉴权**——加 `headers: HeaderMap` + `SELECT project_id FROM ingest_jobs WHERE id=$1` → `check_project_access`（Member）；**CLI waitJob 已带 svc token 不受影响**（回归跑 transcriber api-client 测试）；404 未知 job 保持。集成测试：无 token 401 / 成员 200 / 未知 id 404。
- [ ] **Step 2: 脱敏**——logging_middleware 内调用纯函数（lib 可测）：

```rust
/// /t/<token> 与 /media/<id> 的路径与 query 整体脱敏（token/签名不落日志）
pub fn redact_uri(uri: &axum::http::Uri) -> String {
    let path = uri.path();
    if path.starts_with("/t/") || path.starts_with("/media/") {
        let prefix = path.split('/').nth(1).unwrap_or("");
        format!("/{}[REDACTED]", prefix) // "/t/[REDACTED]" / "/media/[REDACTED]"
    } else {
        uri.to_string()
    }
}
```

（middleware/logging.rs 两处 `uri` 使用改 `redact_uri(&uri)`；lib 测试 3 例：/t/x?sig=1 → "/t/[REDACTED]"、/media/y?exp=2 → "/media/[REDACTED]"、/api/v1/health 原样。）
- [ ] **Step 3: `cargo test` + 提交** `feat(server): /ingest/jobs 项目鉴权 + /t、/media 日志脱敏`

---

### Task 14: launchd 保活（src-server + cloudflared）

**Files:**
- Create: `~/Library/LaunchAgents/wiki.src-server.plist`、`~/Library/LaunchAgents/com.cloudflare.cloudflared.plist`（仿 `ai.hermes.gateway.plist` 结构：RunAtLoad/KeepAlive/ThrottleInterval 30/日志路径）；仓库留模板 `docs/superpowers/deploy/`（占位 env）

- [ ] **Step 1: src-server plist**——ProgramArguments: `cargo run --release --manifest-path .../src-server/Cargo.toml`（或先 debug 二进制路径，与现状一致用 debug）；EnvironmentVariables：bootstrap.env 全量（JWT__SECRET/TRAINING__ADMIN_TOKEN/TRAINING__PROJECT_ID/MEDIA__SIGNING_KEY/AUTH__REGISTRATION_ENABLED=false/JWT__SECRET 已含）；WorkingDirectory src-server（config/default 相对路径）
- [ ] **Step 2: cloudflared plist**——`cloudflared tunnel run lt-training`（T15 建好后生效；plist 先就位）
- [ ] **Step 3: 加载 + 演练**——`launchctl load` 两 plist；kill src-server 进程 → 30s 内自愈（ThrottleInterval）；hermes 已有 KeepAlive 不动；记录三服务自愈实测到 deploy 文档
- [ ] **Step 4: 模板提交** `feat(deploy): launchd 保活模板与演练记录（src-server/cloudflared）`

---

### Task 15: cloudflared 隧道（USER 协作）

**Files:**
- 部署物: `~/.cloudflared/{cert.pem,config.yml,<tunnel 凭据>}`（不入 git）；仓库留 `docs/superpowers/deploy/tunnel.md` 操作记录

- [ ] **Step 1: USER**——`cloudflared tunnel login`（浏览器选 Cloudflare 账号/域名）
- [ ] **Step 2: 建隧道与路由**：

```bash
cloudflared tunnel create lt-training
cloudflared tunnel route dns lt-training api.<你的域名>
cloudflared tunnel route dns lt-training cb.<你的域名>
```

- [ ] **Step 3: config.yml**（`~/.cloudflared/config.yml`）：两 ingress——`api.<域名>} → http://127.0.0.1:8080`、`cb.<域名> → http://127.0.0.1:8645`（hermes 企微回调——**需确认 hermes callback 适配器监听 8645 且绑 127.0.0.1**；若当前绑 0.0.0.0，改为 127.0.0.1 属 hermes 侧配置，记录到 tunnel.md）
- [ ] **Step 4: 跑通验证**——`cloudflared tunnel run lt-training`（前台试跑）→ `curl https://api.<域名>/health` 200；企微后台回调 URL 配 `https://cb.<域名>/...`（USER：企微管理后台操作）；`PUBLIC_T_BASE` 更新为 `https://api.<域名>`（mcp env + 重启）
- [ ] **Step 5: 挂 launchd（T14 plist 生效）+ tunnel.md 提交** `feat(deploy): cloudflared 双 hostname 隧道落地记录`

---

### Task 16: 真机确认 + 测试件预转 + M2 E2E + 验收

**Files:**
- Create: `docs/superpowers/specs/m2-acceptance-<date>.md`（提交）

- [ ] **Step 1: 测试件预转**——3 个代表性 media（含 1 个时长>30min）：`transcribe --demo-slug`×3（或直接 ffmpeg 三件）→ media_assets.playback_path 补登（T1 前置批次模式）
- [ ] **Step 2: USER 安卓确认**——安卓测试机企微浏览器开 `/t/` 链接：HEVC 原件可播？不可播 → 确认预转件可播可拖（此结果决定 M4 按需转码缓存优先级）
- [ ] **Step 3: M2 版 E2E 脚本执行**（预置 surveyed profile 测试号）：
  1. 企微自测号发问 → SKILL 答疑（引用+时间戳链接）
  2. 生成清单 → 收到 /t/ 链接
  3. 打开链接：view 事件落库（不改投影）→ 页面级 seen → 点进项 → 项级 seen（viewed 投影）
  4. 播放（Range + 章节跳转）→ 完成按钮 → completed；另一项回企微说"看完了" → item_complete → completed
  5. progress 汇总正确；period_key 幂等（同 weekly key 二次创建返回同 plan）
  6. 鉴权矩阵抽查：plan_link token 调 /api → 403；A 访 B 的 plan → 404；/t/ token 过期 → 403 页面提示
- [ ] **Step 4: 验收记录**（含偏差：iOS/安卓结果、隧道延迟、白名单验证证据）+ AGENTS.md/docs 同步 + 提交 `docs(specs): M2 验收记录——E2E 全流程/真机/隧道留档`

---

## Self-Review 记录

- **Spec 覆盖**（§9 M2 行逐项）：migration 014（T5）、plans/events/complete API（T7/T8）、/t/ 落地页三端点+双粒度（T9）、MCP 扩展含 read_page 复用（T10）、SKILL 最小版（T11）、隧道（T15）、launchd（T14）、白名单 profile（T12）、日志脱敏+ingest 收敛（T13）、真机件预转+HEVC 确认（T16）、M2 E2E+docs 同步（T16）。§4.1 投影/beacon/单调/rebuild（T8/T9）、§4.2 凭证三层 typ/fingerprint/幂等（T6/T8/T9）、§5.1 凭证持有 single-flight（T10）、§5.4 白名单（T12）、§6 表逐行（T13/T14/T15）
- **M1/M2 前置清单收编**：7 项重跑+prompt 重转（T1）、前缀拒绝（T2）、FOR UPDATE/长度/exp 上限/compose 键/冗余索引（T3）、waitJob 超时/参数校验/tryRefresh/parseFrontmatter/版本（T4）
- **占位符扫描**：T14/T15 的 plist/config 值标注"以实测为准"的位置均为部署物模板（env 值来自 bootstrap.env、域名 USER 提供），代码任务无 TBD
- **类型/跨语言一致性**：plan_link custom claim `plid`（T6 签发/T8/T9 校验一致）；fingerprint=sha256(plan_link token) 前 16 hex（T9 Rust/TS 双侧+向量）；mcp 工具名前缀 `teacher_tutor_*`（T10 定义/T11 SKILL 引用一致）；`redact_uri`/`is_llm_generated_path`/`render_t_page` 均为 lib 可测纯函数
- **风险声明**：T12 动用户在用的 hermes 主 config（备份+回滚脚本+USER 确认）；T9 落地页为无框架内联 HTML（YAGNI，M3 若体验不足再引入前端构建）；mcp 默认 19828 端口陷阱已在 Global Constraints 标注
