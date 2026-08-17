# LT 师训系统 M1 转写管线与服务端基线 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 打通 M1：whisper.cpp 转写首批专栏（48 个：44 个 HEVC mp4 + 4 个伪扩展名救援视频，23.88h）三路写入 wiki、src-server training 基础（migration 013 + media-assets 注册 + /media 签名流式 + /bind）、安全基线落地，全部按 spec §9 M1 验收标准闭环。

**Architecture:** 三块——① `tools/transcriber/`（TS CLI）扩展为五步写入管线（storage 源文件 → POST /pages → media-assets 注册 → 触发 ingest → hash 对账），whisper.cpp 为转写引擎；② `src-server` 新增 `/api/v1/training` 路由组与顶级 `/media/:media_id`（HMAC 签名 + Range 流式）；③ 安全基线（注册开关/监听收敛/密钥轮换/DB 绑定 127.0.0.1 + restart）。

**Tech Stack:** Rust（axum 0.7 + sqlx 0.7 + bcrypt + 新增 hmac/subtle/tokio-util）、TypeScript（tsx + vitest）、whisper.cpp（brew，ggml-large-v3-turbo）、ffmpeg。

**Spec:** `docs/superpowers/specs/2026-08-17-teacher-training-design.md`（v5 §3.2/§4.1/§4.2/§6/§9-M1 行）

## Global Constraints

- **分支**：`feat/Training-System`（当前分支，直接提交）；每任务一个 commit
- **M1 的 /media 签名不含 plan_link 指纹**（M2 才有 /t/）：HMAC 消息 = `{media_id}:{exp}`，M2 加指纹时升级
- 密钥四件套经环境变量注入、不入 git：`JWT__SECRET`、`TRAINING__ADMIN_TOKEN`、`TRAINING__PROJECT_ID`、`MEDIA__SIGNING_KEY`；**旧 dev secret `test_secret_for_development_32bytes!` 加入 config 黑名单**（视为已泄露）
- 注册开关：`AUTH__REGISTRATION_ENABLED`（config 结构默认 **false**，`config/default.json` 显式 true 供开发/测试；生产 launchd/compose 环境置 false）
- src-server 监听 `127.0.0.1`；docker-compose 端口绑 `127.0.0.1:`、全部服务 `restart: unless-stopped`
- 转写参数：whisper.cpp + `ggml-large-v3-turbo`、`-l zh`、`--prompt` LT 域词表；16kHz mono wav；`--window 23:00-08:00`；JSONL 断点续跑；单文件重试 2 次
- transcript 页 path 一律 `transcripts/<slug>.md`；slug = 净化 basename + `-` + sha256(relPath) 前 8 hex（确定性，幂等）
- **不改 search/ingest/pages 既有端点行为**；新代码全部新增（routes/training.rs、routes/media.rs、utils/media_sign.rs、migrations/013）
- 集成测试需要 5433 活库：先 `sqlx migrate run`；测试基建参照 `src-server/tests/integration/mod.rs`（register_user 助手 + TestServer）
- TS 侧仓库根 `"type": "module"`：禁 `__dirname`，路径用 `fileURLToPath(new URL(...))`
- 新增 gitignore：`tools/transcriber/out/auth.json`、`tools/transcriber/out/audio/`、`tools/transcriber/out/playback/`、`tools/transcriber/out/transcripts/`

## File Structure

```
src-server/
  migrations/013_training_core.sql          # media_assets + teacher_profiles
  src/config.rs                             # AuthConfig/TrainingConfig/MediaConfig + 黑名单
  src/routes/mod.rs                         # 挂载 training + media
  src/routes/training.rs                    # POST /media-assets、POST /bind
  src/routes/media.rs                       # GET /media/:media_id（顶级）
  src/utils/media_sign.rs                   # HMAC 签名/验签
  src/routes/auth.rs                        # 注册 gate（3 行）
  tests/integration/{training_test,media_test,registration_gate_test}.rs
  config/default.json                       # host/新 secret/auth.training.media 段
  docker-compose.yml                        # 127.0.0.1 绑定 + restart
  Cargo.toml                                # +hmac +subtle +tokio-util
tools/transcriber/
  scripts/bootstrap.sh                      # 一次性建号/团队/项目（注册关闭前）
  src/manifest.ts                           # error→null（收敛项）
  src/audio.ts                              # 抽音频/桶B转码/SHA-256 去重
  src/whisper.ts                            # whisper-cli runner + JSONL 状态机 + 窗口
  src/transcript.ts                         # [mm:ss] 包装 + chapters（纯函数）
  src/api-client.ts                         # svc 登录/refresh 持久化 + 写入客户端五步
  src/slug.ts                               # slug 派生
  src/cli.ts                                # + transcribe/sign-media 子命令
  __tests__/{audio,whisper,transcript,api-client,slug}.test.ts
  out/                                      # 运行产物（部分 gitignore，manifest-summary.json 仍提交）
```

---

### Task 1: 转写器收敛（最终评审遗留项；error→null 已由 M0 复审修复波 51a5532c 完成——本任务补齐剩余三项）

**Files:**
- Modify: `tools/transcriber/src/manifest.ts`、`tools/transcriber/src/scan.ts`
- Test: `tools/transcriber/__tests__/manifest.test.ts`、`tools/transcriber/__tests__/bucket.test.ts`

**Interfaces:**
- Consumes: M0 全部模块
- Produces: `ManifestEntry.bucket: Bucket | null`（error 行现在为 **null**）；`scan.ts` 删除不可达 `._` 分支（行为不变——`.` 前缀过滤已覆盖）

- [ ] **Step 1: 失败测试先行**

`__tests__/manifest.test.ts` 的"probe 失败行"用例中加断言（原有用例已断言 error 行进 probeFailures；现加桶断言）：

```typescript
it("probe 失败行 bucket 为 null（不再保守落 B）", () => {
  const rows: ManifestRow[] = [
    { file: { absPath: "/x", relPath: "bad.mp4", source: "main", category: "video", ext: ".mp4" }, probe: null, error: "ffprobe timeout" },
  ];
  const { entries, summary } = buildManifest(rows, [], "x");
  expect(entries[0].bucket).toBeNull();
  expect(summary.byBucket["A_playable"].files).toBe(0);
  expect(summary.byBucket["B_transcode"].files).toBe(0);
  expect(summary.probeFailures).toBe(1);
});
```

`__tests__/bucket.test.ts` 加 isMp4Family 假分支：

```typescript
it("桶B：.mp4 扩展名但容器非 MP4 家族（错标文件）", () => {
  expect(classifyBucket(f("mp4", "video"), p("matroska", "h264", "aac"))).toBe("B_transcode");
});
```

- [ ] **Step 2: 确认失败**

Run: `npx vitest run tools/transcriber`
Expected: 新增 2 用例 FAIL（error 行仍为 "B_transcode"；假分支断言会 PASS 因为 ext 守卫先返回——若 PASS 则保留作回归）

- [ ] **Step 3: 最小实现**

`manifest.ts` 映射处：`bucket: error ? null : classifyBucket(file, effective),`（并更新 ManifestEntry.bucket 注释：error 行 null）。`scan.ts` 删除 `if (entry.name.startsWith("._")) continue;` 行（`.` 过滤已覆盖，附一行注释说明）。

- [ ] **Step 4: 跑通 + 重跑对账**

Run: `npx vitest run tools/transcriber && npx tsc -p tools/transcriber`
然后重跑：`npx tsx tools/transcriber/src/cli.ts audit` → 确认 summary 不变（error 行本就被桶统计排除）→ `git add tools/transcriber/out/manifest-summary.json`（时间戳字段会变，属正常）

- [ ] **Step 5: .m4a ALAC 抽查（记录，不改代码）**

```bash
for f in $(find "/Users/berton/Github/L T师训 2024-2025" -iname "*.m4a" | head -5); do
  echo "== $f"; ffprobe -v error -select_streams a:0 -show_entries stream=codec_name -of csv=p=0 "$f"
done
```

把输出记入本任务 commit message body（若发现 alac → 在 spec §3.1 分桶规则加一条备注，否则只记录）。

- [ ] **Step 6: 提交**

```bash
git add tools/transcriber src-server 2>/dev/null; git add tools/transcriber
git commit -m "fix(transcriber): error行bucket→null+isMp4Family假分支测试+删scan死代码（最终评审遗留）；重跑对账；m4a编码抽查见body"
```

---

### Task 2: config 扩展（auth/training/media 段 + 旧 secret 入黑名单）

**Files:**
- Modify: `src-server/src/config.rs`（约 :6-44 结构区 + :188 校验区）
- Test: `src-server/src/config.rs` 内嵌 tests（:273-337 既有区）

**Interfaces:**
- Produces（`AppConfig` 新增字段）:
```rust
#[serde(default)] pub auth: AuthConfig,          // AUTH__REGISTRATION_ENABLED（默认 false）
#[serde(default)] pub training: TrainingConfig,  // TRAINING__ADMIN_TOKEN / TRAINING__PROJECT_ID
#[serde(default)] pub media: MediaConfig,        // MEDIA__SIGNING_KEY
```

- [ ] **Step 1: 失败测试**（加进 config.rs 的 `mod tests`）

```rust
#[test]
fn registration_disabled_by_default() {
    let c: AppConfig = serde_json::from_str("{}").unwrap_or_else(|_| AppConfig {
        /* 用 ConfigBuilder 空源构造太重，直接断言 Deserialize 默认 */
        ..serde_json::from_value(serde_json::json!({})).expect("default deserialization")
    });
    assert!(!c.auth.registration_enabled);
    assert_eq!(c.training.admin_token, "");
    assert!(c.training.project_id.is_none());
    assert_eq!(c.media.signing_key, "");
}

#[test]
fn leaked_dev_secret_rejected() {
    // 旧已泄露 dev secret 必须被校验拒绝（黑名单）
    let mut cfg = test_config_with_override(); // 既有测试里构造带 jwt 段的 helper；无则内联构造 JwtConfig
    cfg.jwt.secret = "test_secret_for_development_32bytes!".to_string();
    let err = validate(&cfg).unwrap_err(); // 将校验抽为 fn validate(&AppConfig) -> anyhow::Result<()>
    assert!(err.to_string().contains("JWT_SECRET"));
}
```

（`test_config_with_override` 若不存在：在 tests 里用 `serde_json::from_value(json!({"jwt":{"secret":"x"}}))` 构造最小 AppConfig。）

- [ ] **Step 2: 确认失败**：`cargo test -p llm-wiki-server config::` → 编译失败（字段不存在）

- [ ] **Step 3: 实现**

```rust
#[derive(Debug, Deserialize, Clone, Default)]
pub struct AuthConfig { #[serde(default)] pub registration_enabled: bool }

#[derive(Debug, Deserialize, Clone, Default)]
pub struct TrainingConfig {
    #[serde(default)] pub admin_token: String,
    #[serde(default)] pub project_id: Option<i32>,
}

#[derive(Debug, Deserialize, Clone, Default)]
pub struct MediaConfig { #[serde(default)] pub signing_key: String }
```

AppConfig 加三个 `#[serde(default)]` 字段。把 `from_env` 内联校验抽为 `fn validate(cfg: &AppConfig) -> anyhow::Result<()>`，黑名单改为：

```rust
const LEAKED_SECRETS: &[&str] = &[
    "your-super-secret-key-change-this",
    "test_secret_for_development_32bytes!", // 2026-08 已提交进 git，视为泄露
];
if cfg.jwt.secret.is_empty() || LEAKED_SECRETS.contains(&cfg.jwt.secret.as_str()) {
    anyhow::bail!("JWT_SECRET must be set to a secure value");
}
```

- [ ] **Step 4: 跑通**：`cargo test config::`（含既有 6 个 config 测试不回归）

- [ ] **Step 5: 提交**：`git commit -m "feat(server): config 扩展 auth/training/media 段，旧 dev secret 入黑名单"`

---

### Task 3: 注册开关 gate

**Files:**
- Modify: `src-server/src/routes/auth.rs`（register :69 首行）
- Create: `src-server/tests/integration/registration_gate_test.rs` + 在 `tests/integration/mod.rs` 加 `mod registration_gate_test;`

**Interfaces:**
- Consumes: Task 2 的 `config.auth.registration_enabled`
- Produces: register 关闭时返回 403 `PermissionDenied("registration disabled")`；`config/default.json` 补 `"auth": {"registration_enabled": true}`（开发/测试默认开）

- [ ] **Step 1: 失败测试**

```rust
use axum_test::TestServer;
mod helpers; use helpers::setup_test_app;

#[tokio::test]
async fn register_rejected_when_disabled() {
    // 改 config 后 create_app 模式（本任务首次建立，T6/T8 复用）
    let mut cfg = llm_wiki_server::AppConfig::from_env().unwrap();
    cfg.auth.registration_enabled = false;
    let app = llm_wiki_server::create_app(cfg).await.unwrap();
    let server = TestServer::new(app).unwrap();
    let resp = server.post("/api/v1/auth/register")
        .json(&serde_json::json!({"username":"blocked","email":"b@x.com","password":"secret123"}))
        .await;
    assert_eq!(resp.status_code(), 403);
    assert!(resp.text().contains("registration disabled"));
}
```

（`AppConfig` 需 `Clone`——已有；`create_app(config)` 是 lib 导出，见 tests/integration/mod.rs:24-27 同款调用。）

- [ ] **Step 2: 确认失败**：`cargo test registration_gate` → 断言失败（当前 register 成功 201）

- [ ] **Step 3: 实现**——register 处理器开头：

```rust
if !state.config.auth.registration_enabled {
    tracing::warn!("registration attempt rejected (disabled)");
    return Err(AppError::PermissionDenied); // 无载荷单元变体（error.rs:33），消息走 log
}
```

`config/default.json` 加 `"auth": {"registration_enabled": true}`。

- [ ] **Step 4: 跑通**：`cargo test registration_gate && cargo test --test integration auth`（既有 register 测试不受影响）

- [ ] **Step 5: 提交**：`git commit -m "feat(server): 注册开关 AUTH__REGISTRATION_ENABLED（默认false，default.json dev开）"`

---

### Task 4: 安全基线落地（监听/密钥/DB 绑定）

**Files:**
- Modify: `src-server/config/default.json`、`src-server/docker-compose.yml`

**Interfaces:**
- Produces: server.host=127.0.0.1；default.json 换新随机 dev secret（旧的已入黑名单）；compose 端口绑回环 + restart

- [ ] **Step 1: default.json**

```bash
NEW_SECRET=$(openssl rand -hex 32)
# 编辑 config/default.json：
#   server.host: "127.0.0.1"
#   jwt.secret: "$NEW_SECRET"（粘贴生成值；dev/test 用；生产另用 env 覆盖）
```

- [ ] **Step 2: docker-compose.yml**——ports 段全部加 `127.0.0.1:` 前缀，每个 service 加 restart：

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg16
    ports:
      - "127.0.0.1:5433:5432"
    restart: unless-stopped
    # （卷等既有行保持不变）
  redis:
    image: redis:7
    ports:
      - "127.0.0.1:6380:6379"
    restart: unless-stopped
```

- [ ] **Step 3: 验证**

```bash
cd src-server && docker compose config -q && docker compose up -d
cargo test config::           # 新 secret 通过、旧 secret 拒绝
lsof -nP -iTCP:8080 -sTCP:LISTEN  # 起服务后应显示 127.0.0.1:8080（或暂不起服务，M1 验收时验）
```

- [ ] **Step 4: 提交**：`git commit -m "feat(server): 安全基线——监听127.0.0.1/新dev secret/compose回环绑定+restart"`

---

### Task 5: migration 013（media_assets + teacher_profiles）

**Files:**
- Create: `src-server/migrations/013_training_core.sql`

**Interfaces:**
- Produces（后续任务的 SQL 契约）: 两表列名与 spec §4.1 完全一致

- [ ] **Step 1: 写 SQL**

```sql
-- 013_training_core.sql — M1：媒体注册表 + 教师档案（spec §4.1）
CREATE TABLE media_assets (
  id SERIAL PRIMARY KEY,
  slug VARCHAR(255) UNIQUE NOT NULL,
  media_ref TEXT NOT NULL,               -- 本机绝对路径，只在本表出现
  playback_path TEXT,                    -- 桶B转码副本（hevc/VOB 等）
  duration_s INTEGER NOT NULL DEFAULT 0,
  codec TEXT,
  kind VARCHAR(10) NOT NULL CHECK (kind IN ('video','audio')),
  chapters JSONB NOT NULL DEFAULT '[]',
  transcript_page_path TEXT,
  source_path TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE teacher_profiles (
  id SERIAL PRIMARY KEY,
  user_id INTEGER UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wecom_userid VARCHAR(100) UNIQUE NOT NULL,
  display_name VARCHAR(100),
  subject VARCHAR(100),
  grade_levels JSONB NOT NULL DEFAULT '[]',
  goals JSONB NOT NULL DEFAULT '[]',
  interests JSONB NOT NULL DEFAULT '[]',
  onboarding_state VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (onboarding_state IN ('pending','surveyed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_media_assets_slug ON media_assets(slug);
CREATE INDEX idx_teacher_profiles_wecom ON teacher_profiles(wecom_userid);
```

- [ ] **Step 2: 应用并验证**

```bash
cd src-server
export DATABASE_URL=postgres://llmwiki:test123@localhost:5433/llmwiki
sqlx migrate run          # sqlx-cli 缺则: cargo install sqlx-cli --version ^0.7 --no-default-features --features postgres
psql "$DATABASE_URL" -c "\d media_assets" -c "\d teacher_profiles"
```

- [ ] **Step 3: 全量回归**：`cargo test`（tests 依赖已迁移库；确保 013 不破坏既有）

- [ ] **Step 4: 提交**：`git commit -m "feat(server): migration 013 training_core（media_assets+teacher_profiles）"`

---

### Task 6: POST /api/v1/training/media-assets（批量 upsert）

**Files:**
- Create: `src-server/src/routes/training.rs`（本任务只做 media-assets；/bind 在 Task 8）
- Modify: `src-server/src/routes/mod.rs`（`mod training;` + `.nest("/api/v1/training", training::training_routes())`）
- Create: `src-server/tests/integration/training_test.rs`（mod.rs 注册）

**Interfaces:**
- Produces: `training_routes() -> Router<AppState>`；`POST /api/v1/training/media-assets` body:

```json
{"items": [{"slug","media_ref","playback_path?","duration_s","codec?","kind","chapters":[],"transcript_page_path?","source_path?"}]}
```

响应 `{"imported": N}`；鉴权 = TRAINING__PROJECT_ID 项目的 `RequiredRole::Admin`（svc-transcriber）

- [ ] **Step 1: 失败测试**（`training_test.rs`，DB 依赖照既有模式；测试自建 owner+team+project+admin/member 两用户）

```rust
// 助手：建 owner→team→project→第二用户(admin)→第三用户(member)，返回 (server, admin_token, member_token, project_id)
async fn training_fixture() -> (TestServer, String, String, i32) {
    let app = setup_test_app().await.0;
    let server = TestServer::new(app).unwrap();
    let owner = register_user(&server, "t_owner1", "t_owner1@x.com", "secret123").await;
    let team = server.post("/api/v1/teams").add_header("authorization", bearer(&owner))
        .json(&json!({"name":"LT测试team"})).await;
    let team_id = team["id"].as_i64().unwrap();
    let proj = server.post("/api/v1/projects").add_header("authorization", bearer(&owner))
        .json(&json!({"name":"LT项目","team_id":team_id})).await;
    let project_id = proj["id"].as_i64().unwrap() as i32;
    let admin_tok = register_user(&server, "t_admin1", "t_admin1@x.com", "secret123").await;
    server.post(&format!("/api/v1/teams/{team_id}/members")).add_header("authorization", bearer(&owner))
        .json(&json!({"user_id": user_id_of(&server, &admin_tok), "role":"admin"})).await.assert_status(201);
    let member_tok = register_user(&server, "t_member1", "t_member1@x.com", "secret123").await;
    // member 加入 team 略——用 add_member role member
    (server, admin_tok, member_tok, project_id)
}
```

（`user_id_of` 用 `GET /api/v1/users/me` 或 register 响应的 `user.id`；`bearer(t)` = `format!("Bearer {t}")`。测试进程环境需设 `TRAINING__PROJECT_ID`——在测试里 `std::env::set_var("TRAINING__PROJECT_ID", &project_id.to_string())` 不可行（config 已加载）。**替代**：training.rs 鉴权从 `state.config.training.project_id` 读；测试用 Task 3 同款"改 config 后 create_app"模式，把 project_id 注入 config。）

```rust
#[tokio::test]
async fn media_assets_matrix() {
    let (server, admin, member, project_id) = training_fixture_with_config_project().await;
    let body = json!({"items":[{"slug":"s1","media_ref":"/tmp/x.mp4","duration_s":100,"kind":"video","chapters":[]}]});
    // 无 token → 401
    server.post("/api/v1/training/media-assets").json(&body).await.assert_status(401);
    // Member → 403
    server.post("/api/v1/training/media-assets").add_header("authorization", bearer(&member)).json(&body).await.assert_status(403);
    // Admin → 200 且 upsert 幂等
    let r = server.post("/api/v1/training/media-assets").add_header("authorization", bearer(&admin)).json(&body).await;
    r.assert_status(200); assert_eq!(r["imported"], 1);
    let body2 = json!({"items":[{"slug":"s1","media_ref":"/tmp/x2.mp4","duration_s":120,"kind":"video","chapters":[]}]});
    let r2 = server.post("/api/v1/training/media-assets").add_header("authorization", bearer(&admin)).json(&body2).await;
    r2.assert_status(200);
    // 查询验证走 Task 7 的 /media 或 psql；此处断言二次导入 imported=1
}
```

- [ ] **Step 2: 确认失败**：`cargo test training_test` → 404（路由不存在）

- [ ] **Step 3: 实现**（training.rs 核心；upsert 一条 SQL）

```rust
pub fn training_routes() -> Router<AppState> {
    Router::new().route("/media-assets", axum::routing::post(import_media_assets))
}

#[derive(Deserialize)]
pub struct MediaAssetItem {
    pub slug: String, pub media_ref: String, pub playback_path: Option<String>,
    pub duration_s: i32, pub codec: Option<String>, pub kind: String,
    pub chapters: serde_json::Value, pub transcript_page_path: Option<String>,
    pub source_path: Option<String>,
}
#[derive(Deserialize)] pub struct ImportRequest { pub items: Vec<MediaAssetItem> }

async fn import_media_assets(State(state): State<AppState>, headers: HeaderMap, Json(req): Json<ImportRequest>) -> Result<Json<serde_json::Value>, AppError> {
    let project_id = state.config.training.project_id
        .ok_or_else(|| AppError::InternalError("TRAINING__PROJECT_ID not configured".into()))?;
    let (_uid, _tid, _role) = crate::middleware::check_project_access_with_role(&state, &headers, project_id, crate::middleware::RequiredRole::Admin).await?;
    if req.items.is_empty() { return Err(AppError::BadRequest("items is empty".into())); }
    let mut tx = state.db.begin().await.map_err(AppError::from)?; // 批量原子：部分失败不落半批
    for it in &req.items {
        if !(it.kind == "video" || it.kind == "audio") { return Err(AppError::BadRequest(format!("bad kind: {}", it.kind))); }
        sqlx::query(
            "INSERT INTO media_assets (slug, media_ref, playback_path, duration_s, codec, kind, chapters, transcript_page_path, source_path) \
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) \
             ON CONFLICT (slug) DO UPDATE SET media_ref=EXCLUDED.media_ref, playback_path=EXCLUDED.playback_path, \
               duration_s=EXCLUDED.duration_s, codec=EXCLUDED.codec, kind=EXCLUDED.kind, chapters=EXCLUDED.chapters, \
               transcript_page_path=EXCLUDED.transcript_page_path, source_path=EXCLUDED.source_path, updated_at=NOW()"
        )
        .bind(&it.slug).bind(&it.media_ref).bind(&it.playback_path).bind(it.duration_s)
        .bind(&it.codec).bind(&it.kind).bind(&it.chapters)
        .bind(&it.transcript_page_path).bind(&it.source_path)
        .execute(&mut *tx).await.map_err(AppError::from)?;
    }
    tx.commit().await.map_err(AppError::from)?;
    Ok(Json(serde_json::json!({ "imported": req.items.len() })))
}
```

（AppError 变体按 `src-server/src/error.rs` 实际名对齐：`BadRequest`/`InternalError`/`from` 已存在，见 files.rs 用法。）

- [ ] **Step 4: 跑通**：`cargo test training_test`

- [ ] **Step 5: 提交**：`git commit -m "feat(server): POST /training/media-assets 批量 upsert（LT Admin 鉴权）"`

---

### Task 7: GET /media/:media_id（HMAC 签名 + Range 流式）

**Files:**
- Create: `src-server/src/utils/media_sign.rs`（`pub mod media_sign;` 加入 utils/mod.rs）
- Create: `src-server/src/routes/media.rs`（顶级路由，mod.rs `.merge(media::media_routes())`）
- Modify: `src-server/Cargo.toml`（`hmac = "0.12"`、`subtle = "2"`、`tokio-util = { version = "0.7", features = ["io"] }`）
- Create: `src-server/tests/integration/media_test.rs`

**Interfaces:**
- Produces:
  - `sign_media(key, media_id, exp_unix) -> hex String`；`verify_media_sig(...) -> bool`（常数时间）
  - `GET /media/:media_id?exp=<unix>&sig=<hex>`：验签+过期 → 文件查找（playback_path ?? media_ref）→ Range 流式
  - CLI 对齐（Task 12 复用同算法）：`sig = HMAC-SHA256(key, "{media_id}:{exp}")` hex

- [ ] **Step 1: 失败测试**（media_test.rs；fixture 写真实临时文件 + 直接 sqlx 插 media_assets 行——AppState 在 setup 返回，可 `sqlx::query(...).execute(&state.db)`）

```rust
#[tokio::test]
async fn media_signing_and_range() {
    let (server, state) = setup_test_app().await;
    let key = "test_media_key_32bytes______________";
    // 测试专用 config 注入 MEDIA__SIGNING_KEY（Task 3 同款改 config 再 create_app 模式）
    // 写一个 4096 字节临时 mp4 + 插行：
    let path = std::env::temp_dir().join("m1_media_test.mp4");
    std::fs::write(&path, vec![0u8; 4096]).unwrap();
    sqlx::query("INSERT INTO media_assets (slug, media_ref, duration_s, kind, chapters) VALUES ('s1',$1,10,'video','[]')")
        .bind(path.to_str().unwrap()).execute(&state.db).await.unwrap();

    let exp = chrono::Utc::now().timestamp() + 3600;
    let good = llm_wiki_server::utils::media_sign::sign_media(key, "s1", exp);
    // 无参 → 403
    server.get("/media/s1").await.assert_status(403);
    // 错签 → 403
    server.get(&format!("/media/s1?exp={exp}&sig=deadbeef")).await.assert_status(403);
    // 过期 → 403（exp 用过去时间 + 新签名）
    let old_exp = chrono::Utc::now().timestamp() - 10;
    let old_sig = llm_wiki_server::utils::media_sign::sign_media(key, "s1", old_exp);
    server.get(&format!("/media/s1?exp={old_exp}&sig={old_sig}")).await.assert_status(403);
    // 未知 slug → 404
    let sig404 = llm_wiki_server::utils::media_sign::sign_media(key, "nope", exp);
    server.get(&format!("/media/nope?exp={exp}&sig={sig404}")).await.assert_status(404);
    // 全量 200
    let r = server.get(&format!("/media/s1?exp={exp}&sig={good}")).await;
    r.assert_status(200);
    // Range 0-1023 → 206 + body 1024
    let rr = server.get(&format!("/media/s1?exp={exp}&sig={good}"))
        .add_header("range", "bytes=0-1023").await;
    rr.assert_status(206);
    assert_eq!(rr.as_bytes().len(), 1024);
    // 越界 start → 416
    let r416 = server.get(&format!("/media/s1?exp={exp}&sig={good}"))
        .add_header("range", "bytes=99999-").await;
    r416.assert_status(416);
}
```

- [ ] **Step 2: 确认失败**：`cargo test media_test` → 编译失败（模块不存在）

- [ ] **Step 3: 实现**

`utils/media_sign.rs`：

```rust
use hmac::{Hmac, Mac};
use sha2::Sha256;

pub fn sign_media(key: &str, media_id: &str, exp: i64) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(key.as_bytes()).expect("hmac key");
    mac.update(format!("{media_id}:{exp}").as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

pub fn verify_media_sig(key: &str, media_id: &str, exp: i64, sig: &str) -> bool {
    let expect = sign_media(key, media_id, exp);
    subtle::ConstantTimeEq::ct_eq(expect.as_bytes(), sig.as_bytes()).into()
}
```

`routes/media.rs`：

```rust
use axum::{extract::{Path, Query, State}, http::{header, StatusCode}, response::{IntoResponse, Response}, Router};
use tokio::io::{AsyncReadExt, AsyncSeekExt, SeekFrom};
use crate::{AppError, AppState};

#[derive(serde::Deserialize)]
pub struct MediaQuery { pub exp: i64, pub sig: String }

pub fn media_routes() -> Router<AppState> {
    Router::new().route("/media/:media_id", axum::routing::get(get_media))
}

/// "bytes=a-b" | "bytes=a-" → Some((start, end_inclusive))；total=0 / 无法解析 / 后缀式 "bytes=-n" → None（按全量 200）
/// 畸形头（start>end 或 start≥total）→ Some((total, total-1)) 哨兵，调用方判 416。total=0 已早退，哨兵不构造失败。
pub fn parse_range(h: Option<&str>, total: u64) -> Option<(u64, u64)> {
    if total == 0 { return None; }
    let h = h?.strip_prefix("bytes=")?;
    let (a, b) = h.split_once('-')?;
    let start: u64 = a.parse().ok()?;                       // 后缀式 a 为空 → parse 失败 → None
    let end = if b.is_empty() { total - 1 } else { b.parse::<u64>().ok()?.min(total - 1) };
    if start >= total || start > end { return Some((total, total - 1)); } // 哨兵 → 416
    Some((start, end))
}

async fn get_media(State(state): State<AppState>, headers: HeaderMap, Path(media_id): Path<String>, Query(q): Query<MediaQuery>) -> Result<Response, AppError> {
    let key = &state.config.media.signing_key;
    if key.is_empty() { return Err(AppError::InternalError("MEDIA__SIGNING_KEY not configured".into())); }
    if q.exp <= chrono::Utc::now().timestamp() || !crate::utils::media_sign::verify_media_sig(key, &media_id, q.exp, &q.sig) {
        tracing::warn!(media_id = %media_id, "media request rejected: invalid or expired signature");
        return Err(AppError::PermissionDenied);
    }
    let row = sqlx::query("SELECT COALESCE(playback_path, media_ref) AS p, kind FROM media_assets WHERE slug = $1")
        .bind(&media_id).fetch_optional(&state.db).await.map_err(AppError::from)?;
    let (path, _kind): (String, String) = row.map(|r| (r.get("p"), r.get("kind")))
        .ok_or_else(|| AppError::ResourceNotFound("media".into()))?;
    let file = tokio::fs::File::open(&path).await.map_err(|_| AppError::ResourceNotFound("media file".into()))?;
    let total = file.metadata().await.map_err(|_| AppError::InternalError("stat".into()))?.len();
    let mime = match std::path::Path::new(&path).extension().and_then(|e| e.to_str()) {
        Some("mp4") | Some("m4v") => "video/mp4", Some("mp3") => "audio/mpeg",
        Some("m4a") | Some("aac") => "audio/aac", _ => "application/octet-stream",
    };
    let range_hdr = headers.get(header::RANGE).and_then(|v| v.to_str().ok());
    match parse_range(range_hdr, total) {
        Some((s, e)) if s >= total => {
            Ok((StatusCode::RANGE_NOT_SATISFIABLE, [(header::CONTENT_RANGE, format!("bytes */{total}"))]).into_response())
        }
        Some((s, e)) => {
            let mut f = file; f.seek(SeekFrom::Start(s)).await.map_err(|_| AppError::InternalError("seek".into()))?;
            let len = e - s + 1;
            let stream = tokio_util::io::ReaderStream::with_capacity(f.take(len), 64 * 1024);
            Ok(Response::builder().status(206)
                .header(header::CONTENT_TYPE, mime)
                .header(header::CONTENT_LENGTH, len.to_string())
                .header(header::CONTENT_RANGE, format!("bytes {s}-{e}/{total}"))
                .header(header::ACCEPT_RANGES, "bytes")
                .body(axum::body::Body::from_stream(stream)).unwrap())
        }
        None => {
            let stream = tokio_util::io::ReaderStream::with_capacity(file, 64 * 1024);
            Ok(Response::builder().status(200)
                .header(header::CONTENT_TYPE, mime)
                .header(header::CONTENT_LENGTH, total.to_string())
                .header(header::ACCEPT_RANGES, "bytes")
                .body(axum::body::Body::from_stream(stream)).unwrap())
        }
    }
}
```

（`headers` 已是提取器参数；`file.take(len)` 需要 `use tokio::io::AsyncReadExt` 已引入；`AppError::PermissionDenied` 为无载荷单元变体，拒绝原因走 tracing log。）

- [ ] **Step 4: 跑通**：`cargo test media_test && cargo test`（全量）

- [ ] **Step 5: 提交**：`git commit -m "feat(server): /media/:media_id HMAC签名+Range流式（206/416/403/404 矩阵）"`

---

### Task 8: POST /api/v1/training/bind（幂等建号 + refresh 轮换）

**Files:**
- Modify: `src-server/src/routes/training.rs`（追加）
- Modify: `tests/integration/training_test.rs`（追加）

**Interfaces:**
- Consumes: Task 5 表、Task 2 config；bcrypt `utils::hash_password`、`utils::generate_access_token/generate_refresh_token/hash_refresh_token`
- Produces: `POST /api/v1/training/bind`，header `X-Training-Admin-Token`；body `{wecom_userid, display_name}`；响应 = 既有 `AuthResponse`（access_token/refresh_token/expires_in/user）

- [ ] **Step 1: 失败测试**

```rust
#[tokio::test]
async fn bind_lifecycle() {
    // fixture 同 Task 6，另注入 config.training.{admin_token="tok123", project_id}
    // 无 token → 401
    server.post("/api/v1/training/bind").json(&json!({"wecom_userid":"t01","display_name":"王老师"})).await.assert_status(401);
    // 错 token → 401
    server.post("/api/v1/training/bind").add_header("x-training-admin-token","wrong")
        .json(&json!({"wecom_userid":"t01","display_name":"王老师"})).await.assert_status(401);
    // 正确 token → 200，含 token 与 user
    let r = server.post("/api/v1/training/bind").add_header("x-training-admin-token","tok123")
        .json(&json!({"wecom_userid":"t01","display_name":"王老师"})).await;
    r.assert_status(200);
    let refresh1 = r["refresh_token"].as_str().unwrap().to_string();
    let access1 = r["access_token"].as_str().unwrap().to_string();
    // 该 access 能通过项目鉴权（team_members 已写入）：GET search
    let s = server.get(&format!("/api/v1/search?project_id={pid}&query=x")).add_header("authorization", format!("Bearer {access1}")).await;
    assert_eq!(s.status_code(), 200);
    // 不建 personal team：用户 team 列表只含 LT team（GET /api/v1/teams）
    let teams = server.get("/api/v1/teams").add_header("authorization", format!("Bearer {access1}")).await;
    let n = teams["items"].as_array().map(|a| a.len()).or_else(|| teams.as_array().map(|a| a.len())).unwrap();
    assert_eq!(n, 1);
    // 幂等：再 bind 同一 wecom_userid → 200 新 refresh；旧 refresh 立即失效
    let r2 = server.post("/api/v1/training/bind").add_header("x-training-admin-token","tok123")
        .json(&json!({"wecom_userid":"t01","display_name":"王老师"})).await;
    r2.assert_status(200);
    let refresh2 = r2["refresh_token"].as_str().unwrap().to_string();
    assert_ne!(refresh1, refresh2);
    let old = server.post("/api/v1/auth/refresh").json(&json!({"refresh_token": refresh1})).await;
    assert_eq!(old.status_code(), 401);
}
```

- [ ] **Step 2: 确认失败**：`cargo test bind_lifecycle` → 404

- [ ] **Step 3: 实现**（training.rs 追加）

```rust
#[derive(Deserialize)]
pub struct BindRequest { pub wecom_userid: String, pub display_name: Option<String> }

fn require_training_admin(state: &AppState, headers: &HeaderMap) -> Result<(), AppError> {
    let expect = &state.config.training.admin_token;
    if expect.is_empty() { return Err(AppError::InternalError("TRAINING__ADMIN_TOKEN not configured".into())); }
    let got = headers.get("x-training-admin-token").and_then(|v| v.to_str().ok()).unwrap_or("");
    if subtle::ConstantTimeEq::ct_eq(expect.as_bytes(), got.as_bytes()).into() { Ok(()) }
    else { tracing::warn!("bind rejected: invalid training admin token"); Err(AppError::PermissionDenied) }
}

async fn bind(State(state): State<AppState>, headers: HeaderMap, Json(req): Json<BindRequest>) -> Result<Json<crate::models::AuthResponse>, AppError> {
    require_training_admin(&state, &headers)?;
    if req.wecom_userid.trim().is_empty() { return Err(AppError::BadRequest("wecom_userid is empty".into())); }
    let project_id = state.config.training.project_id
        .ok_or_else(|| AppError::InternalError("TRAINING__PROJECT_ID not configured".into()))?;
    let team_id: i32 = sqlx::query_scalar("SELECT team_id FROM projects WHERE id = $1")
        .bind(project_id).fetch_one(&state.db).await.map_err(AppError::from)?;
    // 多表写入全部走同一事务：中途失败不留半账号，重 bind 幂等自愈
    let mut tx = state.db.begin().await.map_err(AppError::from)?;

    let existing: Option<i32> = sqlx::query_scalar(
        "SELECT user_id FROM teacher_profiles WHERE wecom_userid = $1")
        .bind(&req.wecom_userid).fetch_optional(&state.db).await.map_err(AppError::from)?;

    let (user_id, username) = if let Some(uid) = existing {
        let uname: String = sqlx::query_scalar("SELECT username FROM users WHERE id=$1").bind(uid).fetch_one(&state.db).await.map_err(AppError::from)?;
        // 轮换：废全部活跃 refresh（heal：team_members 若曾被中断则补写）
        sqlx::query("UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id=$1 AND revoked_at IS NULL")
            .bind(uid).execute(&mut *tx).await.map_err(AppError::from)?;
        sqlx::query("INSERT INTO team_members (team_id, user_id, role) VALUES ($1,$2,'member') ON CONFLICT DO NOTHING")
            .bind(team_id).bind(uid).execute(&mut *tx).await.map_err(AppError::from)?;
        (uid, uname)
    } else {
        // 合成唯一 username（chars 截断防 UTF-8 边界 panic）+ 随机不可登录密码（64 hex，永不外发）
        let digest = &hex::encode(sha2::Sha256::digest(req.wecom_userid.as_bytes()))[..8];
        let username = if req.wecom_userid.chars().count() + 6 > 50 {
            format!("wecom_{}_{}", req.wecom_userid.chars().take(30).collect::<String>(), digest)
        } else {
            format!("wecom_{}", req.wecom_userid)
        };
        let email = format!("{}@wecom.local", req.wecom_userid);
        let password = hex::encode(rand::random::<[u8; 32]>());
        let hash = crate::utils::hash_password(&password)?;
        let row = sqlx::query_scalar::<_, i32>(
            "INSERT INTO users (username, email, password_hash, full_name) VALUES ($1,$2,$3,$4) RETURNING id")
            .bind(&username).bind(&email).bind(&hash).bind(&req.display_name)
            .fetch_one(&mut *tx).await.map_err(AppError::from)?;
        sqlx::query("INSERT INTO team_members (team_id, user_id, role) VALUES ($1,$2,'member') ON CONFLICT DO NOTHING")
            .bind(team_id).bind(row).execute(&mut *tx).await.map_err(AppError::from)?;
        sqlx::query("INSERT INTO teacher_profiles (user_id, wecom_userid, display_name) VALUES ($1,$2,$3)")
            .bind(row).bind(&req.wecom_userid).bind(&req.display_name)
            .execute(&mut *tx).await.map_err(AppError::from)?;
        (row, username)
    };

    // 发 token（同 auth.rs generate_and_persist_tokens 模式）
    let secret = &state.config.jwt.secret;
    let access = crate::utils::generate_access_token(user_id, &username, secret,
        chrono::Duration::seconds(state.config.jwt.access_token_ttl as i64))?;
    let (refresh, _jti) = crate::utils::generate_refresh_token(user_id, secret,
        chrono::Duration::seconds(state.config.jwt.refresh_token_ttl as i64))?;
    let token_hash = crate::utils::hash_refresh_token(&refresh);
    let expires = chrono::Utc::now() + chrono::Duration::seconds(state.config.jwt.refresh_token_ttl as i64);
    sqlx::query("INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1,$2,$3)")
        .bind(user_id).bind(&token_hash).bind(expires).execute(&mut *tx).await.map_err(AppError::from)?;
    tx.commit().await.map_err(AppError::from)?;

    let user = sqlx::query_as::<_, sqlx::postgres::PgRow>( // 按实际 UserResponse 组装（SELECT id,username,email,full_name,created_at）
        "SELECT id, username, email, full_name, created_at FROM users WHERE id=$1")
        .bind(user_id).fetch_one(&state.db).await.map_err(AppError::from)?;
    Ok(Json(crate::models::AuthResponse {
        access_token: access, refresh_token: refresh,
        expires_in: state.config.jwt.access_token_ttl,
        user: crate::models::UserResponse { /* 从 row 映射五个字段 */ ..Default::default() },
    }))
}
```

（后续 user SELECT 读库可在 commit 后进行；`UserResponse` 逐字段 `row.get(...)` 组装，无 Default 则显式构造；`team_members` 列名/唯一约束按 migration 001 对齐。）

- [ ] **Step 4: 跑通**：`cargo test training_test`

- [ ] **Step 5: 提交**：`git commit -m "feat(server): POST /training/bind——合成号+team_members+profile、幂等轮换refresh、常数时间管理token"`

---

### Task 9: bootstrap 脚本（一次性建 LT team/project/svc 账号）

**Files:**
- Create: `tools/transcriber/scripts/bootstrap.sh`（可执行）

**Interfaces:**
- Produces: 在注册仍开放的 dev server 上跑一次；打印生产环境变量块（TRAINING__PROJECT_ID、提示生成其余三项）

- [ ] **Step 1: 写脚本**

```bash
#!/usr/bin/env bash
# 一次性引导：LT team/project + svc-transcriber（须在 AUTH__REGISTRATION_ENABLED=true 时运行）
set -euo pipefail
BASE="${BASE:-http://127.0.0.1:8080}"
J() { python3 -c "import sys,json;print(json.load(sys.stdin)$1)"; }
ADMIN_PW=$(openssl rand -hex 16); SVC_PW=$(openssl rand -hex 16)
ATOK=$(curl -sS -X POST "$BASE/api/v1/auth/register" -H 'content-type: application/json' \
  -d "{\"username\":\"training-admin\",\"email\":\"training-admin@local\",\"password\":\"$ADMIN_PW\"}" | J "['access_token']")
TEAM_ID=$(curl -sS -X POST "$BASE/api/v1/teams" -H "authorization: Bearer $ATOK" -H 'content-type: application/json' \
  -d '{"name":"LT师训"}' | J "['id']")
PROJ_ID=$(curl -sS -X POST "$BASE/api/v1/projects" -H "authorization: Bearer $ATOK" -H 'content-type: application/json' \
  -d "{\"name\":\"LT师训知识库\",\"team_id\":$TEAM_ID}" | J "['id']")
SVC_REG=$(curl -sS -X POST "$BASE/api/v1/auth/register" -H 'content-type: application/json' \
  -d "{\"username\":\"svc-transcriber\",\"email\":\"svc-transcriber@wecom.local\",\"password\":\"$SVC_PW\"}")
SVC_ID=$(echo "$SVC_REG" | J "['user']['id']"); SVC_TOK=$(echo "$SVC_REG" | J "['access_token']")
curl -sS -X POST "$BASE/api/v1/teams/$TEAM_ID/members" -H "authorization: Bearer $ATOK" -H 'content-type: application/json' \
  -d "{\"user_id\":$SVC_ID,\"role\":\"admin\"}" >/dev/null
cat <<EOF
✅ bootstrap 完成。生产环境变量（勿入库）：
TRAINING__PROJECT_ID=$PROJ_ID
JWT__SECRET=<openssl rand -hex 32>
TRAINING__ADMIN_TOKEN=<openssl rand -hex 32>
MEDIA__SIGNING_KEY=<openssl rand -hex 32>
AUTH__REGISTRATION_ENABLED=false
SVC_USERNAME=svc-transcriber
SVC_PASSWORD=$SVC_PW   # 仅供 CLI 登录（out/auth.json 会存 refresh token）
EOF
```

- [ ] **Step 2: 执行验证**（dev server 起着、注册开着）：

```bash
chmod +x tools/transcriber/scripts/bootstrap.sh
tools/transcriber/scripts/bootstrap.sh   # 记录输出；重复跑会因 username 冲突 400 —— 幂等由"已存在则跳过"处理：
```

脚本加幂等：curl 前 `GET /api/v1/auth/login` 试登录，成功则复用（在实现时补 10 行：login 失败才 register；team/project 用 GET 列表查同名复用）。

- [ ] **Step 3: 提交**：`git commit -m "feat(transcriber): bootstrap.sh——LT team/project/svc-transcriber 一次性引导"`

---

### Task 10: whisper.cpp 安装 + 模型 + 冒烟

**Files:**
- Create: `tools/transcriber/models/`（gitignore 整目录）

**Interfaces:**
- Produces: `whisper-cli` 在 PATH；`tools/transcriber/models/ggml-large-v3-turbo.bin`

- [ ] **Step 1: 安装**

```bash
brew install whisper-cpp && whisper-cli --help >/dev/null && echo OK
```

- [ ] **Step 2: 模型下载**（HF 直连慢则加 HF_ENDPOINT=https://hf-mirror.com 前缀重试）

```bash
mkdir -p tools/transcriber/models
curl -L -o tools/transcriber/models/ggml-large-v3-turbo.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin
ls -lh tools/transcriber/models/   # ≈1.6GB
echo "tools/transcriber/models/" >> .gitignore
```

- [ ] **Step 3: 冒烟**——从首批截 60s 样本转写，人工确认中文 + 英文术语正确率：

```bash
SRC="/Users/berton/Github/L T师训 2024-2025（HEVC）/【2024-2025】LT年度师训会员（高年级版）/教学新知班级管理专栏"
SAMPLE=$(find "$SRC" -iname "*.mp4" | head -1)
ffmpeg -y -v error -t 60 -i "$SAMPLE" -ac 1 -ar 16000 /tmp/m1-smoke.wav
time whisper-cli -m tools/transcriber/models/ggml-large-v3-turbo.bin -f /tmp/m1-smoke.wav \
  -l zh --prompt "LT英语师训 课堂教学 班级管理 自然拼读 独立教师 双减 师训" -oj -of /tmp/m1-smoke
python3 -c "import json;d=json.load(open('/tmp/m1-smoke.json'));print('\n'.join(s['text'] for s in d['transcription'][:8]))"
```

Expected: 60s 音频 < 30s 转完（Metal ≥2× 实时）；文本为中文、含英文教学术语。把实测速率记入 commit body（用于 M4 排产校准）。

- [ ] **Step 4: 提交**（只提交 .gitignore 行与冒烟记录）：`git commit -m "feat(transcriber): whisper.cpp+large-v3-turbo 冒烟（速率实测见body）"`

---

### Task 11: CLI 音频层（抽取/转码/去重 + slug）

**Files:**
- Create: `tools/transcriber/src/slug.ts`、`tools/transcriber/src/audio.ts`
- Test: `__tests__/{slug,audio}.test.ts`

**Interfaces:**
- Produces:
  - `slugFor(relPath: string): string`（净化 basename + `-` + sha256(relPath) 前 8 hex；[a-zA-Z0-9] 保留、其余 `-`）
  - `extractAudio(absPath, wavOut): Promise<void>`（ffmpeg `-ac 1 -ar 16000`）
  - `transcodePlayback(absPath, mp4Out): Promise<void>`（桶 B：macOS 硬编 `-c:v h264_videotoolbox -c:a aac`（23.88h 内容约 0.5-1.5h）；软编 fallback `-c:v libx264 -preset veryfast -crf 23` 约 6-12h——若被迫软编则加 `--no-transcode` 惰性转码、验收只需 1 个可播副本；`-vn` 音频源转 m4a：本任务实现 `transcodeAudioPlayback`）
  - `sha256File(p): Promise<string>`；wav 去重键 = sha256(wav)

- [ ] **Step 1: 失败测试**（纯函数 + 命令构造；真实 ffmpeg 集成一个用例标 `#real` 后缀跳过 mock run）

```typescript
// slug.test.ts
import { describe, it, expect } from "vitest";
import { slugFor } from "../src/slug";
describe("slugFor", () => {
  it("确定性：同路径同 slug；不同目录同名文件不同 slug", () => {
    expect(slugFor("专栏/01.提问.mp4")).toBe(slugFor("专栏/01.提问.mp4"));
    expect(slugFor("专栏/01.提问.mp4")).not.toBe("专栏2/01.提问.mp4" && slugFor("专栏2/01.提问.mp4"));
    expect(slugFor("专栏/01.提问.mp4")).toMatch(/^[a-zA-Z0-9-]+$/);
  });
});
// audio.test.ts：extractAudio/transcodePlayback 用 spawnStub? 简化：导出 buildArgs 纯函数测参数序列
import { audioArgs } from "../src/audio";
it("audioArgs: 16k mono wav", () => {
  expect(audioArgs("extract", "/a/b.mp4", "/o/b.wav")).toEqual(
    expect.arrayContaining(["-ac", "1", "-ar", "16000"]));
});
it("audioArgs: 桶B视频转 H.264+AAC", () => {
  expect(audioArgs("playbackVideo", "/a/b.mp4", "/o/b.mp4")).toEqual(
    expect.arrayContaining(["-c:v", "h264_videotoolbox", "-c:a", "aac"]));
});
```

- [ ] **Step 2: 确认失败** → **Step 3: 实现**（`execFile("ffmpeg", args)`；`audioArgs` 纯函数返回完整参数数组；wav 落 `out/audio/<sha8>.wav`、副本落 `out/playback/<slug>.mp4|.m4a`）→ **Step 4: 跑通**（含一个真实 ffmpeg 冒烟：对 Task 10 样本跑 extractAudio，断言 wav 存在且 ffprobe 16000/mono）

- [ ] **Step 5: 提交**：`git commit -m "feat(transcriber): 音频层——16k抽取/桶B转码/SHA-256去重/slug派生"`

---

### Task 12: whisper runner（JSONL 状态机 + 窗口）

**Files:**
- Create: `tools/transcriber/src/whisper.ts`
- Test: `__tests__/whisper.test.ts`

**Interfaces:**
- Produces:
  - `parseWhisperJson(raw: unknown): Segment[]`，`Segment = { startS: number; endS: number; text: string }`（whisper.cpp `-oj` 的 `transcription[].offsets.from/to` 毫秒 → 秒）
  - `withinWindow(now: Date, windowStr: string): boolean`（`"23:00-08:00"` 跨午夜）
  - `runTranscribe(opts: { wavPath; modelPath; prompt; outJsonPath }): Promise<Segment[]>`（spawn whisper-cli `-l zh -oj -of`）
  - `loadState(jlPath) / saveState / nextPending`：JSONL 每行 `{slug, wavSha, status: pending|running|done|failed, tries, error?}`；断点续跑 = 跳过 done；failed 且 tries<2 可重试；`--force` 重置

- [ ] **Step 1: 失败测试**

```typescript
import { describe, it, expect } from "vitest";
import { parseWhisperJson, withinWindow } from "../src/whisper";
const fixture = { transcription: [
  { offsets: { from: 30720, to: 33000 }, text: " 大家好" },
  { offsets: { from: 33000, to: 35500 }, text: " 今天我们讲课堂提问" } ] };
describe("parseWhisperJson", () => {
  it("毫秒 offset → 秒，text 保留", () => {
    expect(parseWhisperJson(fixture)).toEqual([
      { startS: 30.72, endS: 33, text: "大家好" },  // 实现里 strip 首空格
      { startS: 33, endS: 35.5, text: "今天我们讲课堂提问" },
    ]);
  });
  it("空 transcription 容错", () => { expect(parseWhisperJson({ transcription: [] })).toEqual([]); });
});
describe("withinWindow", () => {
  it("跨午夜窗口", () => {
    expect(withinWindow(new Date("2026-08-18T23:30:00"), "23:00-08:00")).toBe(true);
    expect(withinWindow(new Date("2026-08-18T06:00:00"), "23:00-08:00")).toBe(true);
    expect(withinWindow(new Date("2026-08-18T12:00:00"), "23:00-08:00")).toBe(false);
  });
});
```

- [ ] **Step 2: 确认失败** → **Step 3: 实现**（spawn 模式复用 probe.ts 的 execFileAsync；状态机纯函数 + 文件 IO 分离；window 每个文件处理前检查，窗口外打印"窗口结束，明日续跑"并 exit 0）→ **Step 4: 跑通**（`npx vitest run tools/transcriber/__tests__/whisper.test.ts`；真实转写留 Task 15）

- [ ] **Step 5: 提交**：`git commit -m "feat(transcriber): whisper runner——JSONL断点状态机/跨午夜窗口/segments解析"`

---

### Task 13: transcript 包装 + chapters（纯函数）

**Files:**
- Create: `tools/transcriber/src/transcript.ts`
- Test: `__tests__/transcript.test.ts`

**Interfaces:**
- Produces:
  - `buildTranscriptMd(input: { title; segments: Segment[]; sourcePath; mediaSlug; durationS }): { md: string; chapters: Chapter[] }`
  - `Chapter = { start_s: number; end_s: number; label: string }`；~300s 聚合窗；label = 窗内首句去空白截 40 字
  - md = frontmatter（title/type: transcript/sources: [sourcePath]）+ 每窗段落 `[mm:ss] 起始 + 该窗文本行`

- [ ] **Step 1: 失败测试**

```typescript
import { describe, it, expect } from "vitest";
import { buildTranscriptMd } from "../src/transcript";
describe("buildTranscriptMd", () => {
  const segs = Array.from({ length: 130 }, (_, i) => ({ startS: i * 5, endS: i * 5 + 5, text: `句${i}` }));
  const { md, chapters } = buildTranscriptMd({ title: "提问的艺术", segments: segs, sourcePath: "sources/t1.md", mediaSlug: "t1", durationS: 650 });
  it("frontmatter 含 type/sources/media slug 经 sources 反规范化", () => {
    expect(md).toMatch(/^---\n/);
    expect(md).toContain("type: transcript");
    expect(md).toContain("sources:");
    expect(md).toContain("sources/t1.md");
  });
  it("章节 ~300s：650s → 3 章，label 取首句截断", () => {
    expect(chapters.length).toBe(3);
    expect(chapters[0]).toEqual({ start_s: 0, end_s: expect.any(Number), label: "句0" });
    expect(chapters[0].end_s).toBeGreaterThan(280);
  });
  it("正文时间戳 [mm:ss] 单调", () => {
    const stamps = [...md.matchAll(/\[(\d{2}):(\d{2})\]/g)].map(m => +m[1] * 60 + +m[2]);
    expect(stamps.length).toBeGreaterThanOrEqual(3);
    expect([...stamps].sort((a, b) => a - b)).toEqual(stamps);
  });
});
```

- [ ] **Step 2: 确认失败** → **Step 3: 实现** → **Step 4: 跑通** → **Step 5: 提交** `git commit -m "feat(transcriber): transcript包装——[mm:ss]章节化+chapters聚合"`

---

### Task 14: 写入客户端（五步 + 409 策略 + 凭证持久化）

**Files:**
- Create: `tools/transcriber/src/api-client.ts`
- Test: `__tests__/api-client.test.ts`（mock fetch，不打真实服务）

**Interfaces:**
- Consumes: Task 11 slug、Task 13 md/chapters；服务端 Task 6/7/8 + 既有 files/pages/ingest
- Produces:
  - `ApiClient(baseUrl)`：`login(username,password)`→存 `out/auth.json`（access+refresh）；`authedFetch`（401→`POST /auth/refresh` 轮换并**持久化新 refresh**，再失效则重新 login）
  - `writeSource(sourcePath, contents)`→`POST /api/v1/files/{pid}/*path`（JSON {path,contents}）
  - `upsertTranscriptPage(pagePath, md)`→`POST /api/v1/projects/{pid}/pages`；**409 → GET 该页，内容 hash 一致跳过，不一致 If-Match PUT**（If-Match 值 = GET 响应 updated_at）
  - `registerMediaAssets(items)`→Task 6 端点
  - `triggerIngest(sourcePaths)`→`POST /api/v1/projects/{pid}/ingest` 返回 job_id；`waitJob(jobId)`→轮询 `GET /api/v1/ingest/jobs/:id` 至终态（succeeded/succeeded_with_warnings/failed/cancelled）
  - `verifyTranscriptIntact(pagePath, expectedHash)`→GET 页比对 content hash（对账）

- [ ] **Step 1: 失败测试**（vi.stubGlobal fetch；关键分支：409-skip / 409-update / 401-refresh-rotate / job 轮询终态）

```typescript
import { describe, it, expect, vi, afterEach } from "vitest";
import { ApiClient } from "../src/api-client";
afterEach(() => vi.unstubAllGlobals());
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("upsertTranscriptPage 409 策略", () => {
  it("409 且内容一致 → 跳过（不 PUT）", async () => {
    const md = "---\ntitle: t\n---\nbody";
    const puts: unknown[][] = [];
    let once = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/pages") && init?.method === "POST") return json(409, { error: "ERR_CONFLICT" });
      if (once++ === 0) return json(200, { path: "transcripts/t.md", content: md, updated_at: "2026-08-17T00:00:00Z" });
      puts.push([url, init]); return json(200, {});
    }));
    const c = new ApiClient("http://x", { accessToken: "a", projectId: 1, refreshToken: "r", authPath: "/dev/null" });
    expect(await c.upsertTranscriptPage("transcripts/t.md", md)).toBe("skipped");
    expect(puts).toHaveLength(0);
  });
});
```

（同构补三个用例：409 不一致 → PUT 带 If-Match；401 → refresh 轮换后重放（第二次 mock 返回新 token 且断言 auth.json 写入）；waitJob 在 succeeded 停止。）

- [ ] **Step 2: 确认失败** → **Step 3: 实现**（fetch 包装 + 上述分支；auth.json 读写用 node:fs；hash 用 node:crypto sha256 of content）→ **Step 4: 跑通** → **Step 5: 提交** `git commit -m "feat(transcriber): 写入客户端——五步/409预检/refresh轮换持久化/job轮询/hash对账"`

---

### Task 15: `transcribe` 子命令 + 首批真实运行

**Files:**
- Modify: `tools/transcriber/src/cli.ts`（+ `transcribe` 与 `sign-media` 子命令）
- Create（运行产物）: `tools/transcriber/out/m1-first-batch-report.json`（提交留档）

**Interfaces:**
- Consumes: Task 11-14 全部；manifest（筛选 `inFirstBatch && !error && category==='video'`，48 个）
- Produces: `npx tsx tools/transcriber/src/cli.ts transcribe [--window 23:00-08:00] [--limit N]`；`sign-media <slug> [--hours 12]`（TS 端 HMAC 与 Task 7 同算法，输出 `http://127.0.0.1:8080/media/<slug>?exp=..&sig=..`）

- [ ] **Step 1: 实现 transcribe 主循环**

```
读 manifest.json → 过滤首批视频 48 个 →
对每个（受 window/limit 控制）：
  slug = slugFor(relPath)；wav = out/audio/<sha8>.wav（不存在则 extractAudio，sha 去重命中则跳过抽取）
  桶B → transcodePlayback 至 out/playback/<slug>.mp4
  state 行 pending → runTranscribe → segments
  { md, chapters } = buildTranscriptMd(...)
  api.writeSource(`sources/transcripts/<slug>.md`, md)
  api.upsertTranscriptPage(`transcripts/<slug>.md`, md)   // 409 策略内建
  api.registerMediaAssets([{slug, media_ref: absPath, playback_path: 副本|undefined, duration_s, codec, kind:'video', chapters, transcript_page_path, source_path}])
  state → done
全部完成后：对每页 verifyTranscriptIntact（触发摘要页 ingest 前记录 hash）
ingest 触发：api.triggerIngest(全部 source_path) → waitJob → job 终态后再对账一轮（hash 被 LLM 页覆写则重写+告警）
写 out/m1-first-batch-report.json：{files, transcribed, skipped, failed, jobStatus, durationMinutes}
```

- [ ] **Step 2: 首批真实运行**（预计 videotoolbox 转码 0.5-1.5h + whisper 转写 1.5-2.5h @ ≥8× 实时，两项合计 ~2-4h；白天直接跑可临时 `--window 00:00-23:59`。若硬编不可用退软编（6-12h）则改 `--no-transcode` 惰性转码，全量副本挪 M4）

```bash
# 服务端带全套 env 起着（Task 9 输出的变量 + docker compose up -d + sqlx migrate run 已做）
npx tsx tools/transcriber/src/cli.ts transcribe --window 00:00-23:59
```

Expected: 48 done、failed=0（2 个损坏文件不在首批）；job 终态 succeeded(_with_warnings)；对账无覆写告警。

- [ ] **Step 3: 提交**：`git commit -m "feat(transcriber): transcribe子命令+首批48个端到端运行（report留档）"`

---

### Task 16: M1 验收执行

**Files:**
- Create: `docs/superpowers/specs/m1-acceptance-2026-08-17.md`（验收记录，提交）

- [ ] **Step 1: 四项验收逐一执行并记录**

```bash
# ① search 命中 transcript 页 + snippet 出自命中段落（挑转写文本里的实词，如"班级管理”）
curl -s -H "authorization: Bearer $SVC_TOKEN" \
  "http://127.0.0.1:8080/api/v1/search?project_id=$TRAINING__PROJECT_ID&query=班级管理" | python3 -m json.tool | head -30
# 断言：results[].path 以 transcripts/ 开头且 snippet 含查询词；vector_hits>0 一次（向量命中抽查，若 embedding 服务未配则记 keyword 模式并标注）

# ② Range 播放演示（手工签 URL）——M1 在**桌面浏览器**演示（服务已绑回环、隧道 M2 才有，手机不可达；真机验证随 M2）
URL=$(npx tsx tools/transcriber/src/cli.ts sign-media <某slug> --hours 12)
curl -s -o /dev/null -D - -H "Range: bytes=0-1023" "$URL"    # 期待 206 + Content-Range
# 桌面浏览器打开 out/media-demo.html（<video src="$URL" controls>）可播、可拖动

# ③ 注册关闭后 /bind 建测试账号
# 服务端以 AUTH__REGISTRATION_ENABLED=false 重启后：
curl -s -X POST http://127.0.0.1:8080/api/v1/auth/register -d '{...}'   # 403
curl -s -X POST http://127.0.0.1:8080/api/v1/training/bind -H "x-training-admin-token: $TRAINING__ADMIN_TOKEN" \
  -H 'content-type: application/json' -d '{"wecom_userid":"test01","display_name":"验收账号"}'   # 200 + tokens

# ④ 无对外明文端口（只查本系统三端口，避免被无关本机服务误报）
lsof -nP -iTCP:8080 -iTCP:5433 -iTCP:6380 -sTCP:LISTEN   # 三个端口的绑定地址应全为 127.0.0.1（或 [::1]）
```

- [ ] **Step 2: 写验收记录**（四项结果 + 偏差说明）并提交：`git commit -m "docs(specs): M1 验收记录——四项全过/偏差留档"`

---

## Self-Review 记录

- **Spec 覆盖**（§9 M1 行逐项）：whisper.cpp 管线（T10-15）、首批五步写入（T15）、migration 013（T5）、/media/:id 签名（T7）、/bind 完整版（T8）、svc-transcriber（T9）、安全基线四行（T4 + T2/T3）；验收四条（T16）。§3.2 的 ①-⑤ 五步 = T14/T15；`--window`（T12）；chapters 生产（T13）；409 策略（T14）；对账（T14/T15）
- **遗留项闭环**：error→null+重跑（T1）、isMp4Family 假分支（T1）、删死代码（T1）、.m4a ALAC 抽查（T1 Step 5）
- **M1 边界**：/media 签名无 plan_link 指纹（M2 升级，Global Constraints 声明）；launchd 归 M2；日志脱敏归 M2
- **占位符扫描**：v2 已清零——Task 8 原三处示意（username 字节切片/变体误用/md5 注释）与 Task 7 headers 占位均已改为可直接编译的写法（PermissionDenied 为无载荷单元变体，拒绝原因走 tracing）
- **类型一致性**：`Segment`（T12 定义、T13/T15 消费）、`Chapter`（T13 产、T15 注册消费）、slug 规则 T11/T15 一致、HMAC 消息格式 T7/T15 一致（`{media_id}:{exp}` hex）
- **风险声明**：T3/T6/T8 的集成测试需要"改 config 后 create_app"模式（仓库无 per-test config 注入基建，Task 3 首次建立该模式后复用）；embedding 服务未运行时向量验收降级为记录偏差
