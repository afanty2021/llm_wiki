← [设计文档索引](../)

# src-server Layer 4 (多用户/权限) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpaths:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 src-server 把 `team_members.role`（owner/admin/member）enforce 到 project/team 操作，并把 `llm_providers` 升 team 维度 + 加 provider CRUD（Admin）。

**Architecture:** 新增 `RequiredRole` enum + `role_meets` 纯函数 + `check_project_access_with_role` / `check_team_access_with_role`（集中 role 检查）；现有 `check_project_access` 委托 `Member`（既有调用点零改动）；写/删 handler 声明更高 role。`llm_providers` 经 migration 010 从 project 维度迁到 team 维度（`DISTINCT ON ... is_enabled DESC` 去重），`get_llm_config` SQL 改 JOIN `projects.team_id`（入参仍 project_id，worker 无痛）。

**Tech Stack:** Rust + axum 0.7（冒号路由 `:id`）+ sqlx 0.7（PostgreSQL，`is_unique_violation()` 判 409）+ `utils::crypto::{encrypt,decrypt}_api_key`（JWT secret 派生 key）。

**Spec:** `docs/superpowers/specs/2026-06-22-src-server-layer4-permissions-design.md`

---

## 范围与 Phase C 分工

本 plan **自包含、不依赖 Phase C**：
- **Layer 4 实现**：migration 010、enforce 模型、`get_llm_config` JOIN、`llm_providers` team-scoped CRUD、project 侧 enforce（删页/删文件/删 project）、team 侧 enforce（add/remove member 收紧 + helper 统一）。
- **归 Phase C plan（Task 8 amend）**：`search_providers` 的 team 维度（schema `009` 用 spec §4 team 版）+ search-provider CRUD（team-scoped + Admin）。Phase C 未实施，Layer 4 不假设 `web_search.rs` 存在。

---

## 全局约定（每个 Task 都遵守）

1. **cargo 命令**：src-server 被根 workspace `exclude`，**必须 `cd src-server` 后跑、且不带 `-p`**。
   - 纯函数单测：`cargo test --lib middleware::project_guard`
   - 集成测试：`cargo test --test integration permissions_test::<name>`（target 名 `integration`）
   - 全量：`cargo test --lib && cargo test --test integration`
   - clippy：`cargo clippy --all-targets -- -D warnings`
2. **测试 DB**：`PGPASSWORD=test123 psql -h localhost -p 5433 -U llmwiki -d llmwiki`（migration 手动 `-f` 应用）。
3. **AppError 可用变体**（`src/error.rs`）：`PermissionDenied`（403，无字段）、`BadRequest(String)`、`ResourceNotFound(String)`、`Conflict(String)`、`ValidationError(String)`、`DatabaseError(#[from] sqlx::Error)`、`EncryptionError(String)`。
4. **AppState**（`src/lib.rs`）：`db: DbPool`、`redis`、`config: Arc<AppConfig>`、`http`。
5. **git 规则**：未经用户明确批准不得 commit/push。Task 末尾 commit 在 subagent-driven 执行框架内由 implementer 完成。
6. **工作语言**：简体中文（注释/commit）。
7. **现有契约**（已核实 verbatim）：
   - `middleware/auth.rs::require_auth(state, headers) -> Result<Claims, AppError>`（`Claims.sub` = 字符串 user_id）。
   - `middleware/project_guard.rs::check_project_access(state, headers, project_id) -> Result<(i32,i32), AppError>`（现状 JOIN 取 role 但不用，非成员 403）—— 本 plan Task 2 改其内部 + 加新函数。
   - `services/llm.rs::{get_llm_config(pool, project_id) -> Result<LlmConfig,AppError>、decrypt_api_key(&str,&AppConfig)}`；`utils::crypto::{encrypt_api_key, decrypt_api_key}(&str,&[u8;32])`。
   - `routes/mod.rs::create_router`：`.nest("/api/v1/teams", teams::team_routes())` + 各 `.merge(...)` + `.with_state(state)`。
   - 测试 helper（`tests/integration/mod.rs`）：`setup_test_app() -> (Router, AppState)`、`register_user(server, username, email, password) -> token`。

---

## File Structure

| 文件 | 职责 | 新/改 |
|------|------|-------|
| `migrations/010_llm_providers_team_scope.sql` | project_id→team_id 迁移 + DISTINCT ON 去重 + UNIQUE | 新 |
| `src/middleware/project_guard.rs` | `RequiredRole` + `role_meets` + `check_project_access_with_role` + `check_team_access_with_role` + `check_project_access` 委托 | 改 |
| `src/services/llm.rs` | `get_llm_config` SQL 改 JOIN team | 改 |
| `src/routes/llm_providers.rs` | team-scoped provider CRUD（Admin 写/Member 读）+ `llm_provider_routes()` | 新 |
| `src/routes/mod.rs` | `mod llm_providers;` + create_router merge | 改 |
| `src/routes/pages.rs` | `delete_page` → Admin | 改 |
| `src/routes/files.rs` | `delete_file` → Admin（保留 team_id） | 改 |
| `src/routes/projects.rs` | `delete_project` → Owner（改调 with_role） | 改 |
| `src/routes/teams.rs` | add/remove member 收紧 Owner；全文件用 `check_team_access_with_role` 替代 `check_membership`/`require_*` | 改 |
| `tests/integration/permissions_test.rs` | role 矩阵 / provider CRUD / 共享 / 成员管理收紧 | 新 |
| `tests/integration/mod.rs` | `mod permissions_test;` | 改 |

---

## Task 1: migration 010（llm_providers team 维度）

**Files:**
- Create: `migrations/010_llm_providers_team_scope.sql`

- [ ] **Step 1: 写 migration**

`migrations/010_llm_providers_team_scope.sql`：
```sql
-- 010_llm_providers_team_scope.sql — Layer 4: llm_providers 升 team 维度
ALTER TABLE llm_providers ADD COLUMN team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE;
UPDATE llm_providers lp SET team_id = (SELECT team_id FROM projects WHERE id = lp.project_id);
-- create_project 强制 team_id,正常数据均非 NULL;orphan(NULL)属异常,清理
DELETE FROM llm_providers WHERE team_id IS NULL;
ALTER TABLE llm_providers ALTER COLUMN team_id SET NOT NULL;
ALTER TABLE llm_providers DROP COLUMN project_id;
DROP INDEX IF EXISTS idx_llm_providers_project;
DROP INDEX IF EXISTS idx_llm_providers_type;
DROP INDEX IF EXISTS idx_llm_providers_enabled;
-- 迁移前 project 维度,同 team 多 project 可能各配同 provider_type;现状无 DELETE 路由,
-- disabled 行累积。升 team + UNIQUE 前去重:优先保留 enabled(is_enabled DESC),同状态取 id 最小。
-- 否则 MIN(id) 可能留 disabled 行、删 enabled 行,使 team 解析到无可用 provider,且 DELETE 不可逆。
DELETE FROM llm_providers lp
WHERE lp.id NOT IN (
    SELECT DISTINCT ON (team_id, provider_type) id
    FROM llm_providers
    ORDER BY team_id, provider_type, is_enabled DESC, id
);
ALTER TABLE llm_providers ADD CONSTRAINT llm_providers_team_type_unique UNIQUE(team_id, provider_type);
CREATE INDEX idx_llm_providers_team_enabled ON llm_providers(team_id) WHERE is_enabled = TRUE;
```

- [ ] **Step 2: 手动验证去重逻辑（迁移前构造数据 → 跑 → 验证 enabled 保留）**

测试 DB 当前还是 project 维度（未跑 010）。先构造冲突数据验证去重：
```bash
cd src-server
# 取一个已有 project 的 team_id 与 project_id 做样本(若无 llm_providers 行,先插)
PGPASSWORD=test123 psql -h localhost -p 5433 -U llmwiki -d llmwiki -c \
  "INSERT INTO llm_providers (project_id, provider_type, api_key_encrypted, model, is_enabled)
   SELECT id, 'openai', 'enc-disabled', 'gpt-4o', FALSE FROM projects LIMIT 1;
   INSERT INTO llm_providers (project_id, provider_type, api_key_encrypted, model, is_enabled)
   SELECT id, 'openai', 'enc-enabled', 'gpt-4o', TRUE FROM projects LIMIT 1;"
# 跑迁移
PGPASSWORD=test123 psql -h localhost -p 5433 -U llmwiki -d llmwiki -f migrations/010_llm_providers_team_scope.sql
# 验证:同 (team,'openai') 只剩 1 行,且 is_enabled=TRUE(enc-enabled 保留,enc-disabled 删)
PGPASSWORD=test123 psql -h localhost -p 5433 -U llmwiki -d llmwiki -c \
  "SELECT team_id, provider_type, api_key_encrypted, is_enabled FROM llm_providers WHERE provider_type='openai';"
```
Expected: 该 team 的 openai 仅 1 行、`is_enabled=t`、`api_key_encrypted='enc-enabled'`（enabled 优先保留，disabled 行被去重删除）。

> 若测试 DB 无 `projects` 行导致上面 INSERT 选不到，先确认有任意 project（`SELECT id,team_id FROM projects LIMIT 1;`），或用已知 project_id 替换。

- [ ] **Step 3: 验证 schema 状态**

```bash
PGPASSWORD=test123 psql -h localhost -p 5433 -U llmwiki -d llmwiki -c "\d llm_providers"
```
Expected: 有 `team_id INTEGER NOT NULL`，无 `project_id` 列，有 `idx_llm_providers_team_enabled` + `llm_providers_team_type_unique`。

- [ ] **Step 4: Commit**

```bash
git add migrations/010_llm_providers_team_scope.sql
git commit -m "feat(src-server): 010 migration — llm_providers 升 team 维度(enabled 优先去重)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: enforce 模型（RequiredRole + role_meets + check_*_with_role）

**Files:**
- Modify: `src/middleware/project_guard.rs`（全文件重写为下方内容）

- [ ] **Step 1: 写 role_meets 失败测试**

`src/middleware/project_guard.rs` 全文件替换为（含测试）：
```rust
use crate::{AppError, AppState};
use axum::http::HeaderMap;
use crate::middleware::auth::require_auth;
use sqlx::Row;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequiredRole {
    Member,
    Admin,
    Owner,
}

/// 纯：判断 role 是否满足 required 级别。project 版与 team 版共用。
pub fn role_meets(role: &str, required: RequiredRole) -> bool {
    match required {
        RequiredRole::Member => true,
        RequiredRole::Admin => role == "admin" || role == "owner",
        RequiredRole::Owner => role == "owner",
    }
}

/// project-scoped 鉴权 + role 级别。返回 (user_id, team_id, role)。非成员或 role 不够 → 403。
pub async fn check_project_access_with_role(
    state: &AppState,
    headers: &HeaderMap,
    project_id: i32,
    required: RequiredRole,
) -> Result<(i32, i32, String), AppError> {
    let claims = require_auth(state, headers).await?;
    let user_id = claims.sub.parse::<i32>()?;
    let row = sqlx::query(
        "SELECT p.team_id, tm.role FROM projects p \
         JOIN team_members tm ON p.team_id = tm.team_id \
         WHERE p.id = $1 AND tm.user_id = $2",
    )
    .bind(project_id)
    .bind(user_id)
    .fetch_optional(&state.db)
    .await
    .map_err(AppError::DatabaseError)?;
    let row = row.ok_or(AppError::PermissionDenied)?;
    let team_id: i32 = row.get("team_id");
    let role: String = row.get("role");
    if !role_meets(&role, required) {
        return Err(AppError::PermissionDenied);
    }
    Ok((user_id, team_id, role))
}

/// 现有函数保留,委托 Member——所有既有调用点零改动(读 + 现状写都继续工作)。
pub async fn check_project_access(
    state: &AppState,
    headers: &HeaderMap,
    project_id: i32,
) -> Result<(i32, i32), AppError> {
    let (uid, tid, _) =
        check_project_access_with_role(state, headers, project_id, RequiredRole::Member).await?;
    Ok((uid, tid))
}

/// team-scoped 鉴权 + role 级别(provider CRUD / 成员管理用)。返回 (user_id, role)。不够 → 403。
pub async fn check_team_access_with_role(
    state: &AppState,
    headers: &HeaderMap,
    team_id: i32,
    required: RequiredRole,
) -> Result<(i32, String), AppError> {
    let claims = require_auth(state, headers).await?;
    let user_id = claims.sub.parse::<i32>()?;
    let role: Option<String> =
        sqlx::query_scalar("SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2")
            .bind(team_id)
            .bind(user_id)
            .fetch_optional(&state.db)
            .await?;
    let role = role.ok_or(AppError::PermissionDenied)?;
    if !role_meets(&role, required) {
        return Err(AppError::PermissionDenied);
    }
    Ok((user_id, role))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn role_meets_matrix() {
        assert!(role_meets("member", RequiredRole::Member));
        assert!(!role_meets("member", RequiredRole::Admin));
        assert!(role_meets("admin", RequiredRole::Admin));
        assert!(role_meets("owner", RequiredRole::Admin));
        assert!(!role_meets("admin", RequiredRole::Owner));
        assert!(role_meets("owner", RequiredRole::Owner));
    }
}
```

- [ ] **Step 2: 跑 role_meets 测试（先确认编译 + 纯函数通过）**

```bash
cd src-server
cargo test --lib middleware::project_guard 2>&1 | tail -8
```
Expected: `role_meets_matrix` PASS。

- [ ] **Step 3: 确认既有调用点零回归（check_project_access 委托 Member，行为不变）**

```bash
cargo build 2>&1 | tail -5
cargo test --test integration 2>&1 | tail -8
```
Expected: 编译通过；既有集成测试不回归（`check_project_access` 语义不变：任何 team 成员放行）。

- [ ] **Step 4: clippy**

```bash
cargo clippy --lib -- -D warnings 2>&1 | grep -E "project_guard|error" | head
```
Expected: 无 project_guard 相关 warning。

- [ ] **Step 5: Commit**

```bash
git add src/middleware/project_guard.rs
git commit -m "feat(src-server): RequiredRole + check_*_access_with_role 集中 role 检查

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: get_llm_config 改 JOIN team

**Files:**
- Modify: `src/services/llm.rs:38-46`（`get_llm_config` 的 SQL）

- [ ] **Step 1: 改 SQL**

`src/services/llm.rs` 的 `get_llm_config`，把 query 字符串从 `WHERE project_id = $1` 改为 JOIN team：
```rust
pub async fn get_llm_config(pool: &PgPool, project_id: i32) -> Result<LlmConfig, AppError> {
    let row = sqlx::query_as::<_, LlmProviderRow>(
        "SELECT lp.provider_type, lp.api_key_encrypted, lp.base_url, lp.model, lp.context_size
         FROM llm_providers lp
         JOIN projects p ON lp.team_id = p.team_id
         WHERE p.id = $1 AND lp.is_enabled = TRUE
         ORDER BY lp.id LIMIT 1",
    )
    .bind(project_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| AppError::DatabaseError(e))?;
    // —— 下方 match row { ... } 不变 ——
```
（仅替换 query 字符串 + 别名 `lp`/`p`；`LlmProviderRow` 字段名不变，`match row` 分支原样保留。）

- [ ] **Step 2: 编译 + 既有测试不回归**

```bash
cd src-server
cargo build 2>&1 | tail -3
cargo test --lib 2>&1 | tail -5
cargo test --test integration 2>&1 | tail -5
```
Expected: 编译通过；既有测试不回归（`get_llm_config` 行为：取 project 所属 team 的第一个 enabled provider，与 project 维度时等价或更宽——team 下任何 project 都能取到 team 的 provider）。

- [ ] **Step 3: Commit**

```bash
git add src/services/llm.rs
git commit -m "feat(src-server): get_llm_config 改 JOIN projects.team_id(team 维度)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: routes/llm_providers.rs（team-scoped CRUD）+ 接线

**Files:**
- Create: `src/routes/llm_providers.rs`
- Modify: `src/routes/mod.rs`（`mod llm_providers;` + create_router merge）

- [ ] **Step 1: 写 routes/llm_providers.rs**

`src/routes/llm_providers.rs`：
```rust
// routes/llm_providers.rs — team-scoped LLM provider CRUD（Admin 写 / Member 读，GET 不回传 key）。
use crate::middleware::project_guard::{check_team_access_with_role, RequiredRole};
use crate::{AppError, AppState};
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde::{Deserialize, Serialize};

fn derive_key(config: &crate::AppConfig) -> [u8; 32] {
    let secret = config.jwt_secret();
    let mut key = [0u8; 32];
    let len = secret.len().min(32);
    key[..len].copy_from_slice(&secret.as_bytes()[..len]);
    key
}

pub fn llm_provider_routes() -> axum::Router<AppState> {
    axum::Router::new()
        .route("/api/v1/teams/:id/llm-providers", axum::routing::post(create_provider))
        .route("/api/v1/teams/:id/llm-providers", axum::routing::get(get_provider))
        .route("/api/v1/teams/:id/llm-providers/:sid", axum::routing::put(update_provider))
        .route("/api/v1/teams/:id/llm-providers/:sid", axum::routing::delete(delete_provider))
}

#[derive(Deserialize)]
pub struct CreateBody {
    pub provider_type: String,
    pub api_key: String,
    pub base_url: Option<String>,
    pub model: Option<String>,
    pub context_size: Option<i32>,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]  // Layer 4 §7 契约 snake_case;CreateBody/UpdateBody 同(项目惯例 + 与 models.rs 一致)
pub struct ProviderResp {
    pub id: i32,
    pub provider_type: String,
    pub base_url: Option<String>,
    pub model: String,
    pub context_size: i32,
    pub is_enabled: bool,
    pub has_key: bool,
}

pub async fn create_provider(
    State(state): State<AppState>, Path(team_id): Path<i32>, headers: HeaderMap, Json(body): Json<CreateBody>,
) -> Result<(StatusCode, Json<ProviderResp>), AppError> {
    check_team_access_with_role(&state, &headers, team_id, RequiredRole::Admin).await?;
    let key = derive_key(&state.config);
    let enc = crate::utils::crypto::encrypt_api_key(&body.api_key, &key)?;
    let model = body.model.clone().unwrap_or_else(|| "gpt-4o".into());
    let context_size = body.context_size.unwrap_or(128000);
    let row: Result<(i32,), sqlx::Error> = sqlx::query_as(
        "INSERT INTO llm_providers (team_id, provider_type, api_key_encrypted, base_url, model, context_size) \
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id")
        .bind(team_id).bind(&body.provider_type).bind(&enc).bind(&body.base_url)
        .bind(&model).bind(context_size)
        .fetch_one(&state.db).await;
    let (id,) = match row {
        Ok(r) => r,
        Err(sqlx::Error::Database(e)) if e.is_unique_violation() => {
            return Err(AppError::Conflict("provider_type already exists for team".into()));
        }
        Err(e) => return Err(AppError::DatabaseError(e)),
    };
    Ok((StatusCode::CREATED, Json(ProviderResp {
        id, provider_type: body.provider_type, base_url: body.base_url,
        model, context_size, is_enabled: true, has_key: true,
    })))
}

pub async fn get_provider(
    State(state): State<AppState>, Path(team_id): Path<i32>, headers: HeaderMap,
) -> Result<Json<Option<ProviderResp>>, AppError> {
    check_team_access_with_role(&state, &headers, team_id, RequiredRole::Member).await?;
    let row: Option<(i32, String, Option<String>, String, i32, bool)> = sqlx::query_as(
        "SELECT id, provider_type, base_url, model, context_size, is_enabled \
         FROM llm_providers WHERE team_id=$1 AND is_enabled=TRUE ORDER BY id LIMIT 1")
        .bind(team_id).fetch_optional(&state.db).await?;
    Ok(Json(row.map(|(id, t, b, m, c, e)| ProviderResp {
        id, provider_type: t, base_url: b, model: m, context_size: c, is_enabled: e, has_key: true,
    })))
}

#[derive(Deserialize)]
pub struct UpdateBody {
    pub api_key: Option<String>,
    pub base_url: Option<String>,
    pub model: Option<String>,
    pub context_size: Option<i32>,
    pub is_enabled: Option<bool>,
}

pub async fn update_provider(
    State(state): State<AppState>, Path((team_id, sid)): Path<(i32, i32)>, headers: HeaderMap, Json(body): Json<UpdateBody>,
) -> Result<Json<ProviderResp>, AppError> {
    check_team_access_with_role(&state, &headers, team_id, RequiredRole::Admin).await?;
    if let Some(plain) = body.api_key.as_deref() {
        let key = derive_key(&state.config);
        let enc = crate::utils::crypto::encrypt_api_key(plain, &key)?;
        sqlx::query("UPDATE llm_providers SET api_key_encrypted=$1 WHERE id=$2 AND team_id=$3")
            .bind(&enc).bind(sid).bind(team_id).execute(&state.db).await?;
    }
    if let Some(b) = body.base_url.as_deref() {
        sqlx::query("UPDATE llm_providers SET base_url=$1 WHERE id=$2 AND team_id=$3")
            .bind(b).bind(sid).bind(team_id).execute(&state.db).await?;
    }
    if let Some(m) = body.model.as_deref() {
        sqlx::query("UPDATE llm_providers SET model=$1 WHERE id=$2 AND team_id=$3")
            .bind(m).bind(sid).bind(team_id).execute(&state.db).await?;
    }
    if let Some(c) = body.context_size {
        sqlx::query("UPDATE llm_providers SET context_size=$1 WHERE id=$2 AND team_id=$3")
            .bind(c).bind(sid).bind(team_id).execute(&state.db).await?;
    }
    if let Some(e) = body.is_enabled {
        sqlx::query("UPDATE llm_providers SET is_enabled=$1 WHERE id=$2 AND team_id=$3")
            .bind(e).bind(sid).bind(team_id).execute(&state.db).await?;
    }
    let row: (i32, String, Option<String>, String, i32, bool) = sqlx::query_as(
        "SELECT id, provider_type, base_url, model, context_size, is_enabled FROM llm_providers WHERE id=$1 AND team_id=$2")
        .bind(sid).bind(team_id).fetch_one(&state.db).await
        .map_err(|_| AppError::ResourceNotFound("llm_provider".into()))?;
    Ok(Json(ProviderResp {
        id: row.0, provider_type: row.1, base_url: row.2, model: row.3,
        context_size: row.4, is_enabled: row.5, has_key: true,
    }))
}

pub async fn delete_provider(
    State(state): State<AppState>, Path((team_id, sid)): Path<(i32, i32)>, headers: HeaderMap,
) -> Result<StatusCode, AppError> {
    check_team_access_with_role(&state, &headers, team_id, RequiredRole::Admin).await?;
    let n = sqlx::query("DELETE FROM llm_providers WHERE id=$1 AND team_id=$2")
        .bind(sid).bind(team_id).execute(&state.db).await?;
    if n.rows_affected() == 0 {
        return Err(AppError::ResourceNotFound("llm_provider".into()));
    }
    Ok(StatusCode::OK)
}
```

- [ ] **Step 2: routes/mod.rs 加 mod + create_router merge**

`src/routes/mod.rs`：
- mod 声明区加 `mod llm_providers;`（与 `mod teams;` 同段）。
- `create_router` 在 `.merge(ingest::global_ingest_routes())` **之后、`.with_state(state)` 之前**加：
```rust
        .merge(llm_providers::llm_provider_routes())
```

- [ ] **Step 3: 编译确认**

```bash
cd src-server
cargo build 2>&1 | tail -5
```
Expected: 编译通过。

- [ ] **Step 4: 写集成测试（CRUD 往返 + 加密 + GET 不回传 key + 409）**

在 `tests/integration/permissions_test.rs`（新建）写 helper + CRUD 测试。先建文件含 helper：
```rust
use axum::http::StatusCode;
use std::sync::atomic::{AtomicU64, Ordering};

static COUNTER: AtomicU64 = AtomicU64::new(0);
fn unique_prefix(tag: &str) -> String {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    format!("{}_{}_{}", tag, std::process::id(), n)
}
fn auth(token: &str) -> String { format!("Bearer {}", token) }

/// 注册 owner → 其 personal team；再注册 admin/member 并以 SQL 直加进 team。返回各 token + team_id。
async fn setup_team_with_roles(
    tag: &str,
) -> (axum_test::TestServer, llm_wiki_server::AppState, i32, String, String, String) {
    let (app, state) = crate::setup_test_app().await;
    let server = axum_test::TestServer::new(app).unwrap();
    let owner = unique_prefix(&format!("{}-owner", tag));
    let owner_token = crate::register_user(&server, &owner, &format!("{}@t.com", owner), "password123").await;
    let team_id: i32 = sqlx::query_scalar(
        "SELECT id FROM teams WHERE created_by = (SELECT id FROM users WHERE username = $1)")
        .bind(&owner).fetch_one(&state.db).await.unwrap();
    let admin = unique_prefix(&format!("{}-admin", tag));
    let member = unique_prefix(&format!("{}-member", tag));
    let admin_token = crate::register_user(&server, &admin, &format!("{}@t.com", admin), "password123").await;
    let member_token = crate::register_user(&server, &member, &format!("{}@t.com", member), "password123").await;
    sqlx::query("INSERT INTO team_members (team_id, user_id, role) VALUES ($1, (SELECT id FROM users WHERE username=$2), 'admin')")
        .bind(team_id).bind(&admin).execute(&state.db).await.unwrap();
    sqlx::query("INSERT INTO team_members (team_id, user_id, role) VALUES ($1, (SELECT id FROM users WHERE username=$2), 'member')")
        .bind(team_id).bind(&member).execute(&state.db).await.unwrap();
    (server, state, team_id, owner_token, admin_token, member_token)
}

#[tokio::test]
async fn llm_provider_crud_roundtrip() {
    let (server, state, team_id, _owner, admin_token, _member_token) = setup_team_with_roles("prov-crud").await;
    // CREATE (admin)
    let r = server.post(&format!("/api/v1/teams/{}/llm-providers", team_id))
        .add_header("authorization", auth(&admin_token))
        .json(&serde_json::json!({"provider_type":"openai","api_key":"secret-xyz","model":"gpt-4o"})).await;
    assert_eq!(r.status_code(), StatusCode::CREATED);
    let body: serde_json::Value = r.json();
    assert_eq!(body["provider_type"], "openai");
    assert_eq!(body["has_key"], true);
    assert!(body.get("api_key").is_none(), "GET 响应不得回传 api_key");
    let sid = body["id"].as_i64().unwrap() as i32;
    // 加密往返：DB 存密文，decrypt 还原
    let enc: String = sqlx::query_scalar("SELECT api_key_encrypted FROM llm_providers WHERE id=$1")
        .bind(sid).fetch_one(&state.db).await.unwrap();
    assert_ne!(enc, "secret-xyz");
    assert_eq!(llm_wiki_server::services::llm::decrypt_api_key(&enc, &state.config).unwrap(), "secret-xyz");
    // 同 team 重复 provider_type → 409
    let dup = server.post(&format!("/api/v1/teams/{}/llm-providers", team_id))
        .add_header("authorization", auth(&admin_token))
        .json(&serde_json::json!({"provider_type":"openai","api_key":"k2"})).await;
    assert_eq!(dup.status_code(), StatusCode::CONFLICT);
    // DELETE
    let d = server.delete(&format!("/api/v1/teams/{}/llm-providers/{}", team_id, sid))
        .add_header("authorization", auth(&admin_token)).await;
    assert_eq!(d.status_code(), StatusCode::OK);
}
```

- [ ] **Step 5: tests/integration/mod.rs 加模块声明**

`tests/integration/mod.rs` mod 声明区加：
```rust
mod permissions_test;
```

- [ ] **Step 6: 跑测试**

```bash
cd src-server
cargo test --test integration llm_provider_crud_roundtrip -- --nocapture 2>&1 | tail -8
```
Expected: PASS（CREATE 201 / 加密往返 / 409 / DELETE 200）。

- [ ] **Step 7: Commit**

```bash
git add src/routes/llm_providers.rs src/routes/mod.rs tests/integration/permissions_test.rs tests/integration/mod.rs
git commit -m "feat(src-server): llm_providers team-scoped CRUD(Admin,加密往返,GET 不回传 key)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: project 侧 enforce（删页/删文件 → Admin；删 project → Owner）

**Files:**
- Modify: `src/routes/pages.rs:261`（delete_page）
- Modify: `src/routes/files.rs:246`（delete_file）
- Modify: `src/routes/projects.rs:335-356`（delete_project）

- [ ] **Step 1: pages.rs delete_page → Admin**

`src/routes/pages.rs`：
- 确认/补 use 段含 `use crate::middleware::project_guard::{check_project_access_with_role, RequiredRole};`（若现有 `use ...check_project_access`，改为这行；其它读 handler 仍用 `check_project_access`——它是 `pub` 的，需保留引入。最终 use 应同时含 `check_project_access` 与 `check_project_access_with_role` + `RequiredRole`，例如：
```rust
use crate::middleware::project_guard::{check_project_access, check_project_access_with_role, RequiredRole};
```
- `delete_page`（约 line 261）那行：
```rust
// old:
    check_project_access(&state, &headers, project_id).await?;
// new:
    check_project_access_with_role(&state, &headers, project_id, RequiredRole::Admin).await?;
```
（其余 4 个 handler list/get/create/update 保持 `check_project_access` 不变。）

- [ ] **Step 2: files.rs delete_file → Admin（保留 team_id）**

`src/routes/files.rs`：
- use 段补 `use crate::middleware::project_guard::{check_project_access, check_project_access_with_role, RequiredRole};`（同上，保留 `check_project_access` 供其它 handler）。
- `delete_file`（约 line 246）那行（需保留 `team_id` 供 `storage::project_base`）：
```rust
// old:
    let (_user_id, team_id) = check_project_access(&state, &headers, project_id).await?;
// new:
    let (_user_id, team_id, _) = check_project_access_with_role(&state, &headers, project_id, RequiredRole::Admin).await?;
```
（upload/list/read/write 保持 `check_project_access` 不变。）

- [ ] **Step 3: projects.rs delete_project → Owner（改调 with_role，去掉自己 JOIN）**

`src/routes/projects.rs`：
- use 段补 `use crate::middleware::project_guard::check_project_access_with_role;` + `RequiredRole`（若与现有 import 同模块，合并）。注意 `require_auth` 仍被 `create_project` 用，保留。
- `delete_project` 函数体（约 line 335-356），把开头的 `require_auth` + 自 JOIN 那段替换为 `check_project_access_with_role(Owner)`：
```rust
async fn delete_project(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<i32>,
) -> Result<impl IntoResponse, AppError> {
    // old(删除): require_auth + user_id parse + SELECT ... JOIN team_members 验 membership
    // new:
    check_project_access_with_role(&state, &headers, project_id, RequiredRole::Owner).await?;

    // 下方事务删 wiki_pages / ingested_files / projects 原样保留:
    let mut tx = state.db.begin().await?;
    // ... (DELETE FROM wiki_pages / ingested_files / projects 不变)
```
（事务体 + `tx.commit()` + 返回不变。删掉原来的 `let _project = sqlx::query_as::<_, Project>(...)` 整段与 `let claims = require_auth(...)` / `let user_id = ...` 两行——with_role 内部已 require_auth + 验 owner。）

- [ ] **Step 4: 编译确认**

```bash
cd src-server
cargo build 2>&1 | tail -5
```
Expected: 编译通过（注意 projects.rs 若 `require_auth`/`Project`/`user_id` 在 delete_project 之外无其它使用，可能产生 unused import 警告——若 clippy -D warnings 报，保留 `require_auth`（create_project 用），按需调整）。

- [ ] **Step 5: 写集成测试（role 矩阵：删页/删 project）**

在 `tests/integration/permissions_test.rs` 追加：
```rust
/// 在 team 下建一个 project（owner 直建），返回 project_id。
async fn seed_project_in_team(state: &llm_wiki_server::AppState, team_id: i32) -> i32 {
    let owner_id: i32 = sqlx::query_scalar("SELECT created_by FROM teams WHERE id=$1")
        .bind(team_id).fetch_one(&state.db).await.unwrap();
    let row = sqlx::query(
        "INSERT INTO projects (team_id, name, storage_path, created_by) VALUES ($1,$2,$3,$4) RETURNING id")
        .bind(team_id).bind(format!("p-{}", team_id))
        .bind(format!("/tmp/{}", uuid::Uuid::new_v4())).bind(owner_id)
        .fetch_one(&state.db).await.unwrap();
    sqlx::Row::get::<i32, _>(&row, "id")
}

#[tokio::test]
async fn role_matrix_delete_page() {
    let (server, state, team_id, _owner, admin_token, member_token) = setup_team_with_roles("perm-page").await;
    let pid = seed_project_in_team(&state, team_id).await;
    // seed 一页
    sqlx::query("INSERT INTO wiki_pages (project_id, path, title, content, page_type) VALUES ($1,'wiki/x.md','X','c','concept') ON CONFLICT DO NOTHING")
        .bind(pid).execute(&state.db).await.unwrap();
    // member 删页 → 403
    let m = server.delete(&format!("/api/v1/projects/{}/page?path=wiki/x.md", pid))
        .add_header("authorization", auth(&member_token)).await;
    assert_eq!(m.status_code(), StatusCode::FORBIDDEN);
    // admin 删页 → 204
    let a = server.delete(&format!("/api/v1/projects/{}/page?path=wiki/x.md", pid))
        .add_header("authorization", auth(&admin_token)).await;
    assert_eq!(a.status_code(), StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn role_matrix_delete_project() {
    // member 403 / admin 403 / owner 200(各用独立 project,owner 删的那个真删)
    let (server, state, team_id, owner_token, admin_token, member_token) = setup_team_with_roles("perm-delproj").await;
    let pid_m = seed_project_in_team(&state, team_id).await;
    let m = server.delete(&format!("/api/v1/projects/{}", pid_m))
        .add_header("authorization", auth(&member_token)).await;
    assert_eq!(m.status_code(), StatusCode::FORBIDDEN);
    let pid_a = seed_project_in_team(&state, team_id).await;
    let a = server.delete(&format!("/api/v1/projects/{}", pid_a))
        .add_header("authorization", auth(&admin_token)).await;
    assert_eq!(a.status_code(), StatusCode::FORBIDDEN);
    let pid_o = seed_project_in_team(&state, team_id).await;
    let o = server.delete(&format!("/api/v1/projects/{}", pid_o))
        .add_header("authorization", auth(&owner_token)).await;
    assert_eq!(o.status_code(), StatusCode::OK);
}
```

- [ ] **Step 6: 跑测试**

```bash
cd src-server
cargo test --test integration role_matrix_delete_page role_matrix_delete_project -- --nocapture 2>&1 | tail -8
```
Expected: 2 passed。

- [ ] **Step 7: Commit**

```bash
git add src/routes/pages.rs src/routes/files.rs src/routes/projects.rs tests/integration/permissions_test.rs
git commit -m "feat(src-server): project 侧 role enforce(删页/删文件→Admin,删 project→Owner)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 6: team 侧 enforce（teams.rs add/remove member 收紧 Owner + helper 统一）

**Files:**
- Modify: `src/routes/teams.rs`（删 `check_membership`/`require_owner`/`require_owner_or_admin`；8 handler 鉴权改 `check_team_access_with_role`）

- [ ] **Step 1: use 段 + 删除旧 helper**

`src/routes/teams.rs`：
- use 段把 `use crate::{middleware::require_auth, ...}` 调整为同时引入 project_guard（`require_auth` 仍被 create_team/list_teams 用，保留）：
```rust
use crate::middleware::project_guard::{check_team_access_with_role, RequiredRole};
use crate::middleware::require_auth;
```
（与现有其它 use 合并；`require_auth` 原在 `crate::{middleware::require_auth, AppError, AppState, ...}` 内，拆出来或保留全路径均可，确保编译。）
- **删除**三个函数：`check_membership`、`require_owner`、`require_owner_or_admin`（整段删除）。

- [ ] **Step 2: 6 个 member/team handler 改调 check_team_access_with_role**

逐个 handler 替换开头的"require_auth + user_id parse + check_membership + require_*"为单行 `check_team_access_with_role`（内部已 require_auth）。create_team / list_teams 保持原样（它们用 require_auth + user_id 做 creator / 过滤，不查 membership）。

`get_team`：
```rust
// old:
    let claims = require_auth(&state, &headers).await?;
    let user_id: i32 = claims.sub.parse()?;
    check_membership(&state, team_id, user_id).await?;
// new:
    check_team_access_with_role(&state, &headers, team_id, RequiredRole::Member).await?;
```

`update_team`：
```rust
// old:
    let claims = require_auth(&state, &headers).await?;
    let user_id: i32 = claims.sub.parse()?;
    let role = check_membership(&state, team_id, user_id).await?;
    require_owner_or_admin(&role)?;
// new:
    check_team_access_with_role(&state, &headers, team_id, RequiredRole::Admin).await?;
```

`delete_team`：
```rust
// old:
    let claims = require_auth(&state, &headers).await?;
    let user_id: i32 = claims.sub.parse()?;
    let role = check_membership(&state, team_id, user_id).await?;
    require_owner(&role)?;
// new:
    check_team_access_with_role(&state, &headers, team_id, RequiredRole::Owner).await?;
```

`add_member`（**收紧 owner only**——原 `require_owner_or_admin` → `Owner`）：
```rust
// old:
    let claims = require_auth(&state, &headers).await?;
    let user_id: i32 = claims.sub.parse()?;
    let role = check_membership(&state, team_id, user_id).await?;
    require_owner_or_admin(&role)?;
// new:
    check_team_access_with_role(&state, &headers, team_id, RequiredRole::Owner).await?;
```
（函数体其余——role 校验、user 存在性、INSERT team_members ON CONFLICT、返回 TeamMemberResponse——不变。）

`remove_member`（**收紧 owner only** + 保留 `user_id` 做 "cannot remove self" 检查）：
```rust
// old:
    let claims = require_auth(&state, &headers).await?;
    let user_id: i32 = claims.sub.parse()?;
    let role = check_membership(&state, team_id, user_id).await?;
    require_owner_or_admin(&role)?;
// new:
    let (user_id, _) = check_team_access_with_role(&state, &headers, team_id, RequiredRole::Owner).await?;
```
（函数体其余——`target_user_id == user_id` 自移除检查、target_role 取值、"Cannot remove the team owner" 检查、DELETE——不变。）

`get_team_members`：
```rust
// old:
    let claims = require_auth(&state, &headers).await?;
    let user_id: i32 = claims.sub.parse()?;
    check_membership(&state, team_id, user_id).await?;
// new:
    check_team_access_with_role(&state, &headers, team_id, RequiredRole::Member).await?;
```

- [ ] **Step 3: 编译确认（删除 helper 后无残留引用）**

```bash
cd src-server
cargo build 2>&1 | tail -6
```
Expected: 编译通过（无 `check_membership`/`require_owner`/`require_owner_or_admin` 未定义引用；`create_team`/`list_teams` 的 `require_auth` 仍工作）。

- [ ] **Step 4: 写集成测试（add/remove member 收紧 owner only）**

在 `tests/integration/permissions_test.rs` 追加：
```rust
#[tokio::test]
async fn member_mgmt_owner_only() {
    let (server, state, team_id, owner_token, admin_token, _member_token) = setup_team_with_roles("perm-mgmt").await;
    // 注册一个新 user 作为待加入成员
    let newu = unique_prefix("perm-mgmt-new");
    let _ = crate::register_user(&server, &newu, &format!("{}@t.com", newu), "password123").await;
    let new_id: i32 = sqlx::query_scalar("SELECT id FROM users WHERE username=$1")
        .bind(&newu).fetch_one(&state.db).await.unwrap();
    // admin add member → 403(收紧后 owner only)
    let a = server.post(&format!("/api/v1/teams/{}/members", team_id))
        .add_header("authorization", auth(&admin_token))
        .json(&serde_json::json!({"user_id":new_id,"role":"member"})).await;
    assert_eq!(a.status_code(), StatusCode::FORBIDDEN);
    // owner add member → 201
    let o = server.post(&format!("/api/v1/teams/{}/members", team_id))
        .add_header("authorization", auth(&owner_token))
        .json(&serde_json::json!({"user_id":new_id,"role":"member"})).await;
    assert_eq!(o.status_code(), StatusCode::CREATED);
}

#[tokio::test]
async fn role_matrix_provider_write() {
    // member POST llm-providers → 403;admin → 201(已在 llm_provider_crud_roundtrip 覆盖 admin 201,
    // 这里补 member 403)
    let (server, _state, team_id, _owner, _admin, member_token) = setup_team_with_roles("perm-prov").await;
    let m = server.post(&format!("/api/v1/teams/{}/llm-providers", team_id))
        .add_header("authorization", auth(&member_token))
        .json(&serde_json::json!({"provider_type":"openai","api_key":"k"})).await;
    assert_eq!(m.status_code(), StatusCode::FORBIDDEN);
}
```

- [ ] **Step 5: 跑测试**

```bash
cd src-server
cargo test --test integration member_mgmt_owner_only role_matrix_provider_write -- --nocapture 2>&1 | tail -8
```
Expected: 2 passed。

- [ ] **Step 6: Commit**

```bash
git add src/routes/teams.rs tests/integration/permissions_test.rs
git commit -m "feat(src-server): team 侧 role enforce(add/remove member 收紧 owner,helper 统一)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 7: team 维度共享测试 + 全量回归 + clippy

**Files:**
- Modify: `tests/integration/permissions_test.rs`（补 team_scope_shared 测试）

- [ ] **Step 1: 写 team_scope_shared 测试（team 配一次 provider → 两 project 都取到）**

在 `tests/integration/permissions_test.rs` 追加：
```rust
#[tokio::test]
async fn team_scope_provider_shared_across_projects() {
    let (_server, state, team_id, _owner, admin_token, _member) = setup_team_with_roles("perm-shared").await;
    let server = axum_test::TestServer::new(crate::setup_test_app().await.0).unwrap();
    // admin 给 team 配一个 provider
    let r = server.post(&format!("/api/v1/teams/{}/llm-providers", team_id))
        .add_header("authorization", auth(&admin_token))
        .json(&serde_json::json!({"provider_type":"openai","api_key":"team-key","model":"gpt-4o"})).await;
    assert_eq!(r.status_code(), StatusCode::CREATED);
    // 该 team 下建两个 project
    let pid1 = seed_project_in_team(&state, team_id).await;
    let pid2 = seed_project_in_team(&state, team_id).await;
    // 直调 get_llm_config:两 project 都应取到(team 维度共用,worker 同款路径)
    let cfg1 = llm_wiki_server::services::llm::get_llm_config(&state.db, pid1).await.unwrap();
    let cfg2 = llm_wiki_server::services::llm::get_llm_config(&state.db, pid2).await.unwrap();
    assert_eq!(cfg1.provider_type, "openai");
    assert_eq!(cfg2.provider_type, "openai");
    assert_eq!(llm_wiki_server::services::llm::decrypt_api_key(&cfg1.api_key, &state.config).unwrap(), "team-key");
}
```

> 注：`setup_team_with_roles` 返回的 `server` 已可用；上面额外 `crate::setup_test_app().await.0` 重建仅示例——可直接用返回的 `server`。简化为用返回 server：
```rust
    let (server, state, team_id, _owner, admin_token, _member) = setup_team_with_roles("perm-shared").await;
    // ... 用 server 发 POST
```
（去掉多余的 `axum_test::TestServer::new(...)` 行。）

- [ ] **Step 2: 跑该测试**

```bash
cd src-server
cargo test --test integration team_scope_provider_shared_across_projects -- --nocapture 2>&1 | tail -6
```
Expected: PASS（两 project 都取到 team 的 openai provider，key 正确解密）。

- [ ] **Step 3: 全量 lib + 集成测试**

```bash
cargo test --lib 2>&1 | tail -4
cargo test --test integration 2>&1 | tail -12
```
Expected: 全绿。既有测试不回归 + Phase 4 新增（llm_provider_crud_roundtrip / role_matrix_delete_page / role_matrix_delete_project / member_mgmt_owner_only / role_matrix_provider_write / team_scope_provider_shared_across_projects）全过。

- [ ] **Step 4: clippy 全绿**

```bash
cargo clippy --all-targets -- -D warnings 2>&1 | tail -10
```
Expected: 无 warning（重点：projects.rs 删除 delete_project 自 JOIN 后可能的 unused `Project`/`require_auth` import；teams.rs 删除 helper 后的 unused）。

- [ ] **Step 5: 最终 Commit（若 Step 3-4 触发修复）**

```bash
git add -u
git commit -m "test(src-server): Layer 4 team 维度共享测试 + clippy 全绿

Co-Authored-By: Claude <noreply@anthropic.com>"
```
（若无修复，跳过。）

---

## Self-Review（写计划后自检，已执行）

1. **Spec 覆盖**：
   - migration 010 + 去重 → Task 1 ✅
   - RequiredRole + role_meets + check_project/team_access_with_role + 委托 → Task 2 ✅
   - get_llm_config JOIN → Task 3 ✅
   - llm_providers team-scoped CRUD（Admin/Member，加密往返，GET 不回传 key，409）→ Task 4 ✅
   - project 侧 enforce（删页/删文件 Admin、删 project Owner）→ Task 5 ✅
   - team 侧 enforce（add/remove member 收紧 Owner + helper 统一）→ Task 6 ✅
   - team_scope_shared + 全量回归 + clippy → Task 7 ✅
   - search_providers team 维度 → **归 Phase C plan**（范围说明已注明，本 plan 不含）✅
2. **占位符扫描**：无 TBD/TODO/"适当处理"。Task 5/6 的 handler 改动给精确 old→new 代码行（非"Similar to Task N"）。Task 2 的 SQL 已直接写对（`user_id`）。
3. **类型一致性**：`check_project_access_with_role -> Result<(i32,i32,String)>`（Task 2 定义）与 Task 5 的 `let (_user_id, team_id, _) = ...`（delete_file）/ `check_project_access_with_role(...,Owner).await?;`（delete_page/project）一致；`check_team_access_with_role -> Result<(i32,String)>` 与 Task 6 的 `let (user_id, _) = ...`（remove_member）一致；`llm_provider_routes()`（Task 4）与 create_router merge 名一致；`setup_team_with_roles` 返回 `(server, state, team_id, owner, admin, member)` 在 Task 4/5/6/7 调用一致；**`llm_providers.id` 是 `SERIAL`(INT4)→用 `i32`**（codebase 约定：SERIAL→i32 如 teams/projects/users；BIGSERIAL→i64 如 review_items/chat_sessions；sqlx-postgres 严格类型检查，i64 解码 INT4 列会 TypeMismatch）。

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-22-src-server-layer4-permissions.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, two-stage review (spec compliance + code quality) between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
