# src-server wiki 数据层（CRUD + 导入）Implementation Plan — Plan A

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **项目规则提示：** 每个 commit step 执行前须请示用户批准。

**Goal:** 实现 wiki_pages CRUD API + 注册建 personal team + 一次性导入脚本，激活死表让 English/Invest（586+221 .md）数据进 DB。MVP 数据层（ingest 见 Plan B）。

**Architecture:** src-server（Rust/axum）加 pages route（`/projects/:pid/pages` + `/projects/:pid/page?path=`）+ team 前置（register 建 team）；导入脚本（tsx）读本地 wiki/**/*.md + serde_yaml 解析 frontmatter + INSERT wiki_pages。

**Tech Stack:** Rust + axum + sqlx（PostgreSQL）+ serde_json；导入脚本 tsx + pg + js-yaml。

**依据 spec:** `docs/superpowers/specs/2026-06-19-src-server-wiki-data-layer-design.md`

---

## File Structure

| 文件 | 职责 | 改动 |
|------|------|------|
| `src-server/src/routes/auth.rs` | register 末尾建 personal team + team_members(owner) | Modify register |
| `src-server/src/routes/pages.rs` | wiki_pages CRUD handlers + WikiPage model + 权限 helper | Create |
| `src-server/src/routes/projects.rs` | project_routes() 合并 pages route | Modify |
| `src-server/src/routes/mod.rs` | `mod pages;` | Modify |
| `src-server/tests/integration/pages_test.rs` | CRUD integration test | Create |
| `scripts/import-wiki.mjs` | 一次性导入脚本（连 pg 5433） | Create |

**复用现有：** `AppState`（lib.rs）、`AppError` + 错误常量（error.rs）、auth 中间件（提取 user_id，参考现有 routes 的鉴权模式）、`setup_test_app`（tests/integration/mod.rs）。

**schema 要点**（migration 001/003）：
- `teams(id, name, description, created_by REFERENCES users, created_at)` — **用 created_by 不是 owner_id**
- `team_members(team_id, user_id, role IN(owner/admin/member), joined_at, PK(team_id,user_id))`
- `wiki_pages(id, project_id, path, title, content, frontmatter JSONB, created_at, updated_at, page_type DEFAULT 'concept', images JSONB DEFAULT '[]', sources JSONB DEFAULT '[]', UNIQUE(project_id,path))`

---

## Task 0: 前置基础设施（Cargo.toml + error.rs Conflict variant）

**编译阻断项**，Task 1-5 依赖。Files: `src-server/Cargo.toml`, `src-server/src/error.rs`

- [ ] **Step 1: Cargo.toml — sqlx 加 `"json"` feature（绑 `serde_json::Value` 必需）+ dev-dep axum-test**

```toml
# [dependencies] sqlx 的 features 行追加 "json"：
features = ["runtime-tokio-rustls", "postgres", "chrono", "uuid", "migrate", "json"]
# [dev-dependencies] 追加（Task 3/4 集成测试用）：
axum-test = "15"
```

- [ ] **Step 2: error.rs — 加 `Conflict(String)` variant + IntoResponse 409 映射**

```rust
// AppError enum 加 variant：
#[error("Conflict: {0}")]
Conflict(String),
// error.rs 顶部错误码常量（按现有风格）：
pub const ERR_CONFLICT: &str = "CONFLICT";
// IntoResponse 的 match 加 arm：
AppError::Conflict(msg) => (StatusCode::CONFLICT, Json(json!({"error":{"code":ERR_CONFLICT,"message":msg}}))).into_response(),
```

> **注（审查 #1）：** `AppError::PermissionDenied` 是 **unit variant（无参数）**。Task 2 的 `check_project_access` 查不到 team membership 时，改用 `AppError::ResourceNotFound(String)`（与现有 projects.rs 同模式，语义"项目不存在或非成员"），**不要**用 `PermissionDenied("...")`（编译不过）。

- [ ] **Step 3: cargo build 验证 + commit**

```bash
cargo build -p llm_wiki_server
git add src-server/Cargo.toml src-server/Cargo.lock src-server/src/error.rs
git commit -m "chore(src-server): 前置——sqlx json feature + axum-test + Conflict(409) variant"
```

---

## Task 1: 注册建 personal team

**Files:**
- Modify: `src-server/src/routes/auth.rs`（register 函数，user_id 取得后、token 生成前插入）
- Test: `src-server/tests/integration/auth_test.rs`

- [ ] **Step 1: 写失败测试**（追加到 auth_test.rs）

```rust
#[tokio::test]
async fn register_creates_personal_team_with_owner_membership() {
    let (app, state) = setup_test_app();
    let body = r#"{"username":"teamtest","email":"teamtest@t.com","password":"password123"}"#;
    let resp = axum_test::TestClient::new(app)
        .post("/api/v1/auth/register")
        .body(body).header("content-type", "application/json").await;
    assert_eq!(resp.status_code(), 201);

    // 查 teams：应有 1 行 created_by = 新用户
    let team: Option<(i32, String)> = sqlx::query_as(
        "SELECT id, name FROM teams WHERE created_by = (SELECT id FROM users WHERE username='teamtest')"
    ).fetch_optional(&state.db).await.unwrap();
    let (team_id, team_name) = team.expect("personal team should be created");
    assert!(team_name.contains("teamtest"));

    // team_members：owner
    let role: Option<String> = sqlx::query_scalar(
        "SELECT role FROM team_members WHERE team_id = $1"
    ).bind(team_id).fetch_one(&state.db).await.unwrap();
    assert_eq!(role.as_deref(), Some("owner"));
}
```

- [ ] **Step 2: 跑测试验证失败**

Run: `cargo test -p llm_wiki_server --test integration register_creates_personal_team -- --nocapture`
Expected: FAIL — team 查不到（register 当前不建 team）

- [ ] **Step 3: 实现**（auth.rs register，在 `let user_id: i32 = row.get("id");` 之后、token 生成之前插入）

```rust
    // —— P1: 建 personal team（owner=self），事务内（审查 #6：避免第二个 INSERT 失败留 orphan team）——
    let mut tx = state.db.begin().await.map_err(AppError::from)?;
    let team_row = sqlx::query(
        "INSERT INTO teams (name, created_by) VALUES ($1, $2) RETURNING id",
    )
    .bind(format!("{}'s team", username))
    .bind(user_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(AppError::from)?;
    let team_id: i32 = team_row.get("id");
    sqlx::query(
        "INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'owner')",
    )
    .bind(team_id)
    .bind(user_id)
    .execute(&mut *tx)
    .await
    .map_err(AppError::from)?;
    tx.commit().await.map_err(AppError::from)?;
```

- [ ] **Step 4: 跑测试验证通过**

Run: `cargo test -p llm_wiki_server --test integration register_creates_personal_team -- --nocapture`
Expected: PASS

- [ ] **Step 5: 回归 + commit**

Run: `cargo test -p llm_wiki_server --test integration`（现有 auth 测试不破）
```bash
git add src-server/src/routes/auth.rs src-server/tests/integration/auth_test.rs
git commit -m "feat(src-server): register 建 personal team（owner=self）"
```

---

## Task 2: pages 模块骨架 + WikiPage model + 权限 helper

**Files:**
- Create: `src-server/src/routes/pages.rs`
- Modify: `src-server/src/routes/mod.rs`（加 `mod pages;`）
- Modify: `src-server/src/routes/projects.rs`（project_routes 合并 pages_routes）

- [ ] **Step 1: 写 pages.rs**（model + 权限 helper + 空 routes，handler 在 Task 3-4 加）

```rust
// src-server/src/routes/pages.rs
// wiki_pages CRUD（spec §3）。path 用 query param ?path=（避免 %2F 二次 decode）。
use axum::extract::{Query, State};
use serde::{Deserialize, Serialize};
use crate::{AppState, AppError};

#[derive(Serialize)]
pub struct WikiPage {
    pub id: i32,
    pub project_id: i32,
    pub path: String,
    pub title: Option<String>,
    pub content: Option<String>,
    pub frontmatter: Option<serde_json::Value>,
    pub page_type: Option<String>,
    pub sources: Option<serde_json::Value>,
    pub images: Option<serde_json::Value>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Deserialize)]
pub struct CreatePageRequest {
    pub path: String,
    pub title: Option<String>,
    pub content: Option<String>,
    pub frontmatter: Option<serde_json::Value>,
}

#[derive(Deserialize)]
pub struct ListQuery {
    #[serde(rename = "type")]
    pub page_type: Option<String>,
    pub q: Option<String>,
}

#[derive(Deserialize)]
pub struct PathQuery {
    pub path: String,
}

/// 校验 user 是 project 的 team member；返回 role。无权限 → PermissionDenied。
/// 调用方须先经 auth 中间件拿 user_id（参考现有 projects.rs 的鉴权模式）。
pub(crate) async fn check_project_access(
    state: &AppState,
    project_id: i32,
    user_id: i32,
) -> Result<String, AppError> {
    let row = sqlx::query!(
        "SELECT tm.role FROM projects p
         JOIN team_members tm ON p.team_id = tm.team_id
         WHERE p.id = $1 AND tm.user_id = $2",
        project_id, user_id
    )
    .fetch_optional(&state.db)
    .await
    .map_err(AppError::from)?
    .ok_or_else(|| AppError::ResourceNotFound("Project not found or you are not a member".to_string()))?;
    Ok(row.role)
}

/// 从 frontmatter 同步填充规范化列（spec §3.4：title/page_type/sources/images）。
/// 返回 (title, page_type, sources, images) 供 INSERT。
pub(crate) fn denormalize(fm: &Option<serde_json::Value>, req_title: &Option<String>) -> (
    Option<String>, String, serde_json::Value, serde_json::Value,
) {
    let fm = fm.as_ref().and_then(|v| v.as_object());
    let title = req_title.clone()
        .or_else(|| fm.and_then(|m| m.get("title")).and_then(|v| v.as_str()).map(String::from));
    let page_type = fm.and_then(|m| m.get("type")).and_then(|v| v.as_str())
        .map(String::from).unwrap_or_else(|| "concept".to_string());
    let sources = fm.and_then(|m| m.get("sources")).cloned().unwrap_or(serde_json::json!([]));
    let images = fm.and_then(|m| m.get("images")).cloned().unwrap_or(serde_json::json!([]));
    (title, page_type, sources, images)
}

pub fn pages_routes() -> axum::Router<AppState> {
    axum::Router::new()
    // Task 3-4 在此注册 route
}
```

- [ ] **Step 2: mod.rs 加模块**

`src-server/src/routes/mod.rs` 顶部 `mod graph;` 后加：
```rust
mod pages;
```

`src-server/src/lib.rs` 加重导出（审查 #9：测试用 `WikiPage` 反序列化需 pub）：
```rust
pub use routes::pages::WikiPage;
```

- [ ] **Step 3: projects.rs 合并 pages_routes**

`src-server/src/routes/projects.rs` 的 `project_routes()` 末尾 `.merge(pages::pages_routes())`（pages route 挂在 `/api/v1/projects` nest 下，故 pages_routes 内 route 用相对路径如 `/:pid/pages`）。加 `use super::pages;`。

- [ ] **Step 4: 编译验证**

Run: `cargo build -p llm_wiki_server`
Expected: 编译通过（pages 模块空 route，无逻辑）

- [ ] **Step 5: commit**

```bash
git add src-server/src/routes/pages.rs src-server/src/routes/mod.rs src-server/src/routes/projects.rs
git commit -m "feat(src-server): pages 模块骨架 + WikiPage model + 权限 helper"
```

---

## Task 3: GET 列表 + GET 单个

**Files:**
- Modify: `src-server/src/routes/pages.rs`（list_pages + get_page handler + route 注册）
- Test: `src-server/tests/integration/pages_test.rs`（新建）

- [ ] **Step 1: 写失败测试**（新建 pages_test.rs，参考 auth_test.rs 的 setup_test_app + register helper）

> **审查 #11：** 新建 pages_test.rs 后，`src-server/tests/integration/mod.rs` 加 `pub mod pages_test;`（否则编译 unresolved）。

```rust
use axum_test::TestClient;
// 复用 auth_test.rs 的 setup_test_app + register helper（或抽到 mod.rs 共享）

async fn setup_project() -> (axum::Router, AppState, i32 /*project_id*/, String /*access_token*/) {
    let (app, state) = setup_test_app();
    let token = register_and_login(&app, "pagetest", "pagetest@t.com", "password123").await;
    // register 建 team；建 project（POST /api/v1/projects）
    // team_id 不硬编码（审查 #10）：register 建 team 后查出来
    let team_id: i32 = sqlx::query_scalar(
        "SELECT id FROM teams WHERE created_by = (SELECT id FROM users WHERE username='pagetest')"
    ).fetch_one(&state.db).await.unwrap();
    let proj_resp = TestClient::new(app.clone())
        .post("/api/v1/projects").header("authorization", format!("Bearer {}", token))
        .body(format!(r#"{{"name":"test-proj","team_id":{},"storage_path":"/tmp/test"}}"#, team_id)).await;
    let project_id: i32 = serde_json::from_slice::<serde_json::Value>(proj_resp.as_bytes())
        .unwrap().get("id").unwrap().as_i64().unwrap() as i32;
    (app, state, project_id, token)
}

#[tokio::test]
async fn list_pages_empty_then_create_then_list() {
    let (app, _state, pid, token) = setup_project().await;
    let client = TestClient::new(app);
    // 空列表
    let r = client.get(&format!("/api/v1/projects/{}/pages", pid))
        .header("authorization", format!("Bearer {}", token)).await;
    assert_eq!(r.status_code(), 200);
    assert_eq!(serde_json::from_slice::<Vec<WikiPage>>(r.as_bytes()).unwrap().len(), 0);
    // 创建（Task 4 的 POST，这里先 INSERT 一条供 GET 验证）
    sqlx::query("INSERT INTO wiki_pages (project_id, path, title) VALUES ($1, 'concepts/foo.md', 'Foo')")
        .bind(pid).execute(&_state.db).await.unwrap();
    // 列表含
    let r = client.get(&format!("/api/v1/projects/{}/pages", pid))
        .header("authorization", format!("Bearer {}", token)).await;
    let pages: Vec<WikiPage> = serde_json::from_slice(r.as_bytes()).unwrap();
    assert_eq!(pages.len(), 1);
    assert_eq!(pages[0].path, "concepts/foo.md");
}
```

- [ ] **Step 2: 跑测试验证失败**

Run: `cargo test -p llm_wiki_server --test integration list_pages -- --nocapture`
Expected: FAIL（route 不存在）

- [ ] **Step 3: 实现 list_pages + get_page + 注册 route**

```rust
// pages.rs 加 handler
use axum::extract::Path;
use axum::Json;

pub async fn list_pages(
    State(state): State<AppState>,
    Path(project_id): Path<i32>,
    Query(q): Query<ListQuery>,
    // user_id 从 auth 中间件 extension 提取（参考现有 projects.rs 模式）
) -> Result<Json<Vec<WikiPage>>, AppError> {
    // user_id 提取后：check_project_access(&state, project_id, user_id).await?;
    // （此处用占位 user_id=1 假设鉴权已提取；实际按项目 auth 中间件模式接入）
    let rows = if let Some(t) = &q.page_type {
        sqlx::query_as!(
            WikiPage,
            "SELECT id, project_id, path, title, content, frontmatter,
                    page_type, sources::text as sources_json, images::text as images_json,
                    to_char(created_at,'YYYY-MM-DD\"T\"HH24:MI:SSOF') as created_at,
                    to_char(updated_at,'YYYY-MM-DD\"T\"HH24:MI:SSOF') as updated_at
             FROM wiki_pages WHERE project_id=$1 AND page_type=$2
             ORDER BY title", project_id, t
        ).fetch_all(&state.db).await.map_err(AppError::from)?
    } else {
        sqlx::query_as!(WikiPage,
            "SELECT ... FROM wiki_pages WHERE project_id=$1 ORDER BY title", project_id
        ).fetch_all(&state.db).await.map_err(AppError::from)?
    };
    // 注：sqlx::query_as! 的 JSONB 列需 ::text 后 serde_json 解析；或用 query + 手动 row.get
    Ok(Json(rows))
}

pub async fn get_page(
    State(state): State<AppState>,
    Path(project_id): Path<i32>,
    Query(pq): Query<PathQuery>,
) -> Result<Json<WikiPage>, AppError> {
    // check_project_access...
    let row = sqlx::query_as!(WikiPage,
        "SELECT ... FROM wiki_pages WHERE project_id=$1 AND path=$2",
        project_id, pq.path
    ).fetch_optional(&state.db).await.map_err(AppError::from)?
     .ok_or_else(|| AppError::NotFound("page".to_string()))?;
    Ok(Json(row))
}

// pages_routes() 内注册：
pub fn pages_routes() -> axum::Router<AppState> {
    axum::Router::new()
        .route("/:pid/pages", axum::routing::get(list_pages))
        .route("/:pid/page", axum::routing::get(get_page))
}
```

> **实现注：** sqlx::query_as! 对 JSONB 列的处理：sqlx 对 PG jsonb 默认映射到 `serde_json::Value`（需 `json` feature）。若 query_as! 宏报 JSONB 映射错，改用 `sqlx::query(...)` + `row.get::<_, serde_json::Value>("frontmatter")` 手动提取。 WikiPage 的 sources/images/created_at/updated_at 字段类型按实际 sqlx 映射调整（timestamp → DateTime 或 to_char 字符串）。**执行者按编译错误迭代调整。**

- [ ] **Step 4: 跑测试验证通过**

Run: `cargo test -p llm_wiki_server --test integration list_pages -- --nocapture`
Expected: PASS

- [ ] **Step 5: commit**

```bash
git add src-server/src/routes/pages.rs src-server/tests/integration/pages_test.rs
git commit -m "feat(src-server): wiki_pages GET 列表 + GET 单个"
```

---

## Task 4: POST 创建 + PUT 更新 + DELETE

**Files:**
- Modify: `src-server/src/routes/pages.rs`（create_page + update_page + delete_page + route）
- Test: `src-server/tests/integration/pages_test.rs`

- [ ] **Step 1: 写失败测试**

```rust
#[tokio::test]
async fn crud_create_update_delete_page() {
    let (app, _state, pid, token) = setup_project().await;
    let client = TestClient::new(app);
    let auth = ("authorization", format!("Bearer {}", token));

    // POST 创建
    let r = client.post(&format!("/api/v1/projects/{}/pages", pid))
        .header(auth.0, &auth.1)
        .body(r#"{"path":"concepts/bar.md","title":"Bar","content":"body","frontmatter":{"type":"concept","sources":["a.md"]}}"#).await;
    assert_eq!(r.status_code(), 201);

    // 重复 path → 409
    let r = client.post(&format!("/api/v1/projects/{}/pages", pid)).header(auth.0,&auth.1)
        .body(r#"{"path":"concepts/bar.md"}"#).await;
    assert_eq!(r.status_code(), 409);

    // PUT 更新（替换语义 + 乐观锁 If-Match）
    let created: serde_json::Value = serde_json::from_slice(
        client.get(&format!("/api/v1/projects/{}/page?path=concepts/bar.md", pid)).header(auth.0,&auth.1).await.as_bytes()
    ).unwrap();
    let updated_at = created["updated_at"].as_str().unwrap();
    let r = client.put(&format!("/api/v1/projects/{}/page?path=concepts/bar.md", pid))
        .header(auth.0,&auth.1).header("if-match", updated_at)
        .body(r#"{"path":"concepts/bar.md","title":"Bar2","content":"new"}"#).await;
    assert_eq!(r.status_code(), 200);

    // DELETE
    let r = client.delete(&format!("/api/v1/projects/{}/page?path=concepts/bar.md", pid))
        .header(auth.0,&auth.1).await;
    assert_eq!(r.status_code(), 204);
}
```

- [ ] **Step 2: 跑测试验证失败**

Run: `cargo test -p llm_wiki_server --test integration crud_create -- --nocapture`
Expected: FAIL（POST/PUT/DELETE route 不存在）

- [ ] **Step 3: 实现 create/update/delete**

```rust
use axum::http::{HeaderMap, StatusCode};

pub async fn create_page(
    State(state): State<AppState>,
    Path(project_id): Path<i32>,
    Json(req): Json<CreatePageRequest>,
) -> Result<(StatusCode, Json<WikiPage>), AppError> {
    // check_project_access...
    let (title, page_type, sources, images) = denormalize(&req.frontmatter, &req.title);
    let row = sqlx::query!(
        "INSERT INTO wiki_pages (project_id, path, title, content, frontmatter, page_type, sources, images)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING id",
        project_id, req.path, title, req.content, req.frontmatter, page_type, sources, images
    ).fetch_one(&state.db).await
     .map_err(|e| if let sqlx::Error::Database(d) = &e {
         if d.code().as_deref() == Some("23505") { AppError::Conflict("path exists".into()) }
         else { AppError::from(e) }
     } else { AppError::from(e) })?;
    // 重新 query 返回完整 WikiPage（row 只有 id）...或 RETURNING * + map
    let full = sqlx::query_as!(WikiPage, "SELECT ... FROM wiki_pages WHERE id=$1", row.id)
        .fetch_one(&state.db).await.map_err(AppError::from)?;
    Ok((StatusCode::CREATED, Json(full)))
}

pub async fn update_page(
    State(state): State<AppState>,
    Path(project_id): Path<i32>,
    Query(pq): Query<PathQuery>,
    headers: HeaderMap,
    Json(req): Json<CreatePageRequest>,
) -> Result<Json<WikiPage>, AppError> {
    // check_project_access...
    let if_match = headers.get("if-match").and_then(|v| v.to_str().ok())
        .ok_or_else(|| AppError::ValidationError("If-Match required".into()))?;
    let (title, page_type, sources, images) = denormalize(&req.frontmatter, &req.title);
    let row = sqlx::query!(
        "UPDATE wiki_pages SET title=$1, content=$2, frontmatter=$3, page_type=$4, sources=$5, images=$6,
                                updated_at=NOW(), path=$7
         WHERE project_id=$8 AND path=$9 AND to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS+00:00')=$10
         RETURNING id",
        title, req.content, req.frontmatter, page_type, sources, images, req.path,
        project_id, pq.path, if_match
    ).fetch_optional(&state.db).await.map_err(AppError::from)?
     .ok_or_else(|| AppError::Conflict("updated_at mismatch (stale write)".into()))?;
    let full = sqlx::query_as!(WikiPage, "SELECT ... FROM wiki_pages WHERE id=$1", row.id)
        .fetch_one(&state.db).await.map_err(AppError::from)?;
    Ok(Json(full))
}

pub async fn delete_page(
    State(state): State<AppState>,
    Path(project_id): Path<i32>,
    Query(pq): Query<PathQuery>,
) -> Result<StatusCode, AppError> {
    // check_project_access...
    let n = sqlx::query!("DELETE FROM wiki_pages WHERE project_id=$1 AND path=$2", project_id, pq.path)
        .execute(&state.db).await.map_err(AppError::from)?;
    if n.rows_affected() == 0 { return Err(AppError::NotFound("page".into())); }
    Ok(StatusCode::NO_CONTENT)
}

// pages_routes() 加：
//     .route("/:pid/pages", axum::routing::post(create_page))
//     .route("/:pid/page", axum::routing::put(update_page).delete(delete_page))
```

> **实现注：** AppError 需有 `Conflict`/`NotFound` variant（检查 error.rs；若名不同按实际调）。`to_char(updated_at, RFC3339)` 格式串执行者按 DB 实际验证（确保与 If-Match 值精确字符串匹配）。RETURNING 后重查 full row 可合并（RETURNING * + sqlx map）。

- [ ] **Step 4: 跑测试验证通过 + 回归**

Run: `cargo test -p llm_wiki_server --test integration`
Expected: PASS（含 Task 1/3 + 本任务）

- [ ] **Step 5: commit**

```bash
git add src-server/src/routes/pages.rs src-server/tests/integration/pages_test.rs
git commit -m "feat(src-server): wiki_pages POST/PUT(乐观锁)/DELETE"
```

---

## Task 5: 一次性导入脚本（迁移 English/Invest）

**Files:**
- Create: `scripts/import-wiki.mjs`（Node ESM，连 pg + js-yaml）

- [ ] **Step 1: 写脚本**

```javascript
// scripts/import-wiki.mjs
// 用法: node scripts/import-wiki.mjs <wiki_dir> <project_name> <user_id>
// 例: node scripts/import-wiki.mjs ~/Documents/English-Teaching English-Teaching 3
import pg from "pg";
import yaml from "js-yaml";   // 需 npm i -D js-yaml（或用项目已有）
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const [,, WIKI_DIR, PROJECT_NAME, USER_ID_S] = process.argv;
if (!WIKI_DIR || !PROJECT_NAME || !USER_ID_S) {
  console.error("用法: node scripts/import-wiki.mjs <wiki_dir> <project_name> <user_id>");
  process.exit(1);
}
const USER_ID = Number(USER_ID_S);
const CONN = "postgres://llmwiki:test123@localhost:5433/llmwiki";

const client = new pg.Client({ connectionString: CONN });
await client.connect();

// ① 建 project（user 的 personal team）
let team = await client.query("SELECT id FROM teams WHERE created_by=$1", [USER_ID]);
const team_id = team.rows[0].id;
let proj = await client.query(
  "INSERT INTO projects (team_id, name, storage_path, created_by) VALUES ($1,$2,$3,$4) RETURNING id",
  [team_id, PROJECT_NAME, WIKI_DIR, USER_ID]
);
const project_id = proj.rows[0].id;
console.log(`project ${PROJECT_NAME} (id=${project_id}) created`);

// ② 遍历 <wiki_dir>/wiki/**/*.md
async function walk(dir) {
  const out = [];
  for (const name of await readdir(dir)) {
    if (name.startsWith(".") || name === "node_modules") continue;
    const full = join(dir, name);
    const s = await stat(full);
    if (s.isDirectory()) out.push(...await walk(full));
    else if (name.endsWith(".md")) out.push(full);
  }
  return out;
}
const wikiRoot = join(WIKI_DIR, "wiki");
const files = await walk(wikiRoot);

// ③ 解析 frontmatter（js-yaml 完整解析，含 wikilink-list）+ INSERT
let count = 0;
for (const abs of files) {
  const raw = await readFile(abs, "utf8").then(s => s.replace(/^﻿/, ""));
  let frontmatter = {};
  let body = raw;
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (m) {
    try { frontmatter = yaml.load(m[1]) || {}; } catch (e) { console.warn(`YAML parse fail ${path}: ${e}`); frontmatter = {}; }
    body = raw.slice(m[0].length);
  }
  // path 相对 wikiRoot，POSIX（去 wiki/ 前缀，spec §3.3）
  const path = relative(wikiRoot, abs).split(sep).join("/");
  const title = frontmatter.title || body.match(/^#\s+(.+?)\s*$/m)?.[1] || path.replace(/\.md$/i, "");
  const page_type = frontmatter.type || "concept";
  const sources = JSON.stringify(frontmatter.sources || []);
  const images = JSON.stringify(frontmatter.images || []);
  await client.query(
    `INSERT INTO wiki_pages (project_id, path, title, content, frontmatter, page_type, sources, images)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (project_id, path) DO UPDATE SET
       title=EXCLUDED.title, content=EXCLUDED.content, frontmatter=EXCLUDED.frontmatter,
       page_type=EXCLUDED.page_type, sources=EXCLUDED.sources, images=EXCLUDED.images, updated_at=NOW()`,
    [project_id, path, title, body, frontmatter, page_type, sources, images]
  );
  count++;
}
console.log(`imported ${count} pages into ${PROJECT_NAME}`);
await client.end();
```

> **依赖（审查 #7）：** `npm i -D pg js-yaml`（项目当前无 pg，必须装）。frontmatter 用 js-yaml（对齐桌面 frontmatter.ts），**不用** okf-convert 简单遍历（丢多行 YAML 块）。

- [ ] **Step 2: 跑脚本导入 English-Teaching**

Run: `node scripts/import-wiki.mjs ~/Documents/English-Teaching English-Teaching <user_id>`
Expected: `imported 586 pages into English-Teaching`

- [ ] **Step 3: 验证 DB + API**

```bash
psql 'postgres://llmwiki:test123@localhost:5433/llmwiki' -c "SELECT count(*) FROM wiki_pages WHERE project_id=(SELECT id FROM projects WHERE name='English-Teaching');"
# 期望 586
# API：curl 'localhost:8080/api/v1/projects/<pid>/pages' -H 'Authorization: Bearer <token>'
```
Expected: 586 行；API 返回页面列表

- [ ] **Step 4: 导入 Invest + 验证**

Run: `node scripts/import-wiki.mjs ~/Documents/Invest/Invest Invest <user_id>`
Expected: `imported 221 pages`

- [ ] **Step 5: commit**

```bash
git add scripts/import-wiki.mjs
git commit -m "feat: import-wiki.mjs 一次性导入脚本（serde_yaml/js-yaml + 幂等 upsert）"
```

---

## Self-Review

**1. Spec 覆盖（Plan A 范围 = Section 1 数据层 + Section 3 导入）：**
- §3.1 注册建 team → Task 1 ✅
- §3.2 CRUD（GET 列表/单个、POST、PUT 乐观锁、DELETE、?path= query、UNIQUE 409）→ Task 3/4 ✅
- §3.3 path 相对 wiki root → Task 5 脚本（relative wikiRoot）✅
- §3.4 frontmatter JSONB + sources/images/page_type 列同步 + 读取从分列 → Task 2 denormalize + Task 3 SELECT 分列 ✅
- §5 导入脚本（serde_yaml + 幂等 + reserved 含）→ Task 5 ✅
- §3.2 PUT 替换 + If-Match RFC 3339 → Task 4 ✅

**Section 2（ingest）不在 Plan A** → Plan B（队列/worker/LLM Rust/解析 crate）。spec §7 MVP 顺序 1→3 先。

**2. 占位符扫描：** handler 的 user_id 提取注明"按项目 auth 中间件模式接入"——这是因 auth 中间件的具体 extension 提取方式需执行者按现有 projects.rs 实际模式对齐（非空泛占位，有明确锚点）。sqlx JSONB/timestamp 映射注明"按编译错误迭代"——sqlx query_as! 宏对 JSONB/DateTime 的映射因 feature 配置而异，执行者按实际编译调整。

**3. 类型一致：** WikiPage（Task 2 定义）→ Task 3/4 query_as! 返回 + 测试反序列化一致；CreatePageRequest 一致；denormalize 返回 (title, page_type, sources, images) 在 create/update 一致使用。

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-19-src-server-wiki-data-layer-plan.md`. Two execution options:

**1. Subagent-Driven（推荐）** — 每 task 派发独立 subagent + 两轮 review
**2. Inline Execution** — 本会话批量执行 + checkpoint

Which approach?
