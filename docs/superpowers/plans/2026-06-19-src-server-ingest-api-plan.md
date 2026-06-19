# 子系统 E — ingest API 端点 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 3 个 HTTP 端点：`POST /projects/:id/ingest`（入队）、`GET /ingest/jobs/:id`（查进度）、`GET /projects/:id/ingest/jobs`（列历史）。每个 handler 调子系统 C 的 helper 即可。

**Architecture:** `routes/ingest.rs`（~80 行）：3 个 handler（每个 <20 行）+ project-scoped `.merge()` 到 `project_routes()` + global router 独立挂载。与 pages 完全一致。

**Tech Stack:** Rust + axum 0.7 + serde + sqlx（C 层已处理）。

**依据 spec:** `docs/superpowers/specs/2026-06-19-src-server-ingest-e-api-design.md`

---

## File Structure

| 文件 | 职责 | 改动 |
|------|------|------|
| `src-server/src/routes/ingest.rs` | 3 handler + 2 router 函数（~80 行） | Create |
| `src-server/src/routes/mod.rs` | 加 `mod ingest;` + `.merge(ingest::global_ingest_routes())` | Modify |
| `src-server/src/routes/projects.rs` | `project_routes()` 末尾加 `.merge(ingest::ingest_routes())` + `use super::ingest;` | Modify |
| `src-server/tests/integration/ingest_test.rs` | 4 个集成测试 | Create |
| `src-server/tests/integration/mod.rs` | 加 `pub mod ingest_test;` | Modify |

---

## Task 0: ingest.rs 模块 + 路由挂载（handler + router）

**前置条件**：子系统 C 已完成（`ingest_queue` helper 可用）。E 不依赖 A/B/D。

### Step 1: 创建 `src-server/src/routes/ingest.rs`

```rust
// routes/ingest.rs
// ingest API 端点：入队 + 查进度 + 列历史。全部 handler 调子系统 C 的 helper。
// project-scoped 路由通过 .merge() 合入 project_routes()。
// global route 独立挂载在 create_router。

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use crate::{AppError, AppState};
use crate::middleware::project_guard::check_project_access;
use crate::services::ingest_queue;

// ── Request DTO ──

#[derive(Debug, Deserialize)]
pub struct CreateIngestRequest {
    pub source_paths: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct ListIngestJobsQuery {
    pub status: Option<String>,
    pub limit: Option<i64>,
}

// ── Handlers ──

/// POST /api/v1/projects/:id/ingest
/// 鉴权 → enqueue → 返 201 { job_id, status }。
async fn create_ingest_job(
    State(state): State<AppState>,
    Path(project_id): Path<i32>,
    headers: HeaderMap,
    Json(req): Json<CreateIngestRequest>,
) -> Result<(StatusCode, Json<serde_json::Value>), AppError> {
    let (user_id, _team_id) = check_project_access(&state, &headers, project_id).await?;
    let job_id = ingest_queue::enqueue(&state, project_id, user_id, req.source_paths).await?;
    Ok((
        StatusCode::CREATED,
        Json(serde_json::json!({"job_id": job_id.to_string(), "status": "pending"})),
    ))
}

/// GET /api/v1/projects/:id/ingest/jobs
/// 鉴权 → 列历史（支持 ?status= + ?limit=）。
async fn list_ingest_jobs(
    State(state): State<AppState>,
    Path(project_id): Path<i32>,
    Query(q): Query<ListIngestJobsQuery>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, AppError> {
    check_project_access(&state, &headers, project_id).await?;
    let items = ingest_queue::list_jobs(&state, project_id, q.status.as_deref(), q.limit).await?;
    Ok(Json(serde_json::json!({"items": items, "count": items.len()})))
}

/// GET /api/v1/ingest/jobs/:id
/// 不绑 project——直接按 job_id UUID 查。MVP 不加鉴权。
async fn get_job_status(
    State(state): State<AppState>,
    Path(job_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, AppError> {
    let job = ingest_queue::job_status(&state, job_id).await?;
    Ok(Json(serde_json::json!(job)))
}

// ── Routers ──

/// project-scoped：通过 .merge() 合入 project_routes()（与 pages_routes 一致）。
pub fn ingest_routes() -> Router<AppState> {
    Router::new()
        .route("/:id/ingest",      axum::routing::post(create_ingest_job))
        .route("/:id/ingest/jobs", axum::routing::get(list_ingest_jobs))
}

/// global：GET /ingest/jobs/:id。独立挂载到 create_router。
pub fn global_ingest_routes() -> Router<AppState> {
    Router::new()
        .route("/api/v1/ingest/jobs/:id", axum::routing::get(get_job_status))
}
```

### Step 2: routes/mod.rs 加模块 + global router

`src-server/src/routes/mod.rs` 顶部加：

```rust
mod ingest;
```

`create_router` 函数末尾（所有 `.nest()` 之后）加：

```rust
        .merge(ingest::global_ingest_routes())
```

### Step 3: projects.rs 加 merge

`src-server/src/routes/projects.rs` 顶部加：

```rust
use super::ingest;
```

`project_routes()` 函数末尾（`.merge(pages::pages_routes())` 之后）加：

```rust
        .merge(ingest::ingest_routes())
```

### Step 4: 编译验证

```bash
cargo build -p llm_wiki_server
```
Expected：0 error。3 handler 调用 C 的 `enqueue`/`job_status`/`list_jobs`（均已定义）。路由冲突 0 错误。

### Step 5: commit

```bash
git add src-server/src/routes/ingest.rs src-server/src/routes/mod.rs src-server/src/routes/projects.rs
git commit -m "feat(src-server): ingest API 端点（E）— 3 handler + 路由挂载"
```

---

## Task 1: 集成测试（4 用例）

**前置条件**：C 子系统已完成（`ingest_queue` helper 可用）。

### Step 1: 写失败测试

`src-server/tests/integration/ingest_test.rs`：

```rust
use axum::http::StatusCode;

async fn setup() -> (axum_test::TestServer, llm_wiki_server::AppState, i32, String) {
    let (app, state) = crate::setup_test_app().await;
    let server = axum_test::TestServer::new(app).unwrap();
    let username = format!("etest_{}", std::process::id());
    let token = crate::register_user(&server, &username, &format!("{}@t.com", username), "password123").await;
    let team_id: i32 = sqlx::query_scalar(
        "SELECT id FROM teams WHERE created_by = (SELECT id FROM users WHERE username = $1)"
    ).bind(&username).fetch_one(&state.db).await.unwrap();
    let resp = server.post("/api/v1/projects")
        .add_header("authorization", format!("Bearer {}", token))
        .json(&serde_json::json!({"name": format!("eproj-{}", std::process::id()), "team_id": team_id}))
        .await;
    let pid = resp.json::<serde_json::Value>()["id"].as_i64().unwrap() as i32;
    (server, state, pid, token)
}

#[tokio::test]
async fn create_ingest_job_returns_201() {
    let (server, _state, pid, token) = setup().await;
    let resp = server.post(&format!("/api/v1/projects/{}/ingest", pid))
        .add_header("authorization", format!("Bearer {}", token))
        .json(&serde_json::json!({"source_paths": ["test/foo.md"]}))
        .await;
    assert_eq!(resp.status_code(), StatusCode::CREATED);
    let body: serde_json::Value = resp.json();
    assert!(body["job_id"].as_str().is_some());
    assert_eq!(body["status"], "pending");
}

#[tokio::test]
async fn get_job_status_returns_200() {
    let (server, _state, pid, token) = setup().await;
    let resp = server.post(&format!("/api/v1/projects/{}/ingest", pid))
        .add_header("authorization", format!("Bearer {}", token))
        .json(&serde_json::json!({"source_paths": ["test/bar.md"]}))
        .await;
    let job_id = resp.json::<serde_json::Value>()["job_id"].as_str().unwrap().to_string();

    let resp = server.get(&format!("/api/v1/ingest/jobs/{}", job_id)).await;
    assert_eq!(resp.status_code(), StatusCode::OK);
    let job: serde_json::Value = resp.json();
    assert_eq!(job["status"], "pending");
    assert_eq!(job["progress"], 0);
}

#[tokio::test]
async fn list_ingest_jobs_returns_items() {
    let (server, _state, pid, token) = setup().await;
    // 建 2 个 job
    for path in &["a.md", "b.md"] {
        server.post(&format!("/api/v1/projects/{}/ingest", pid))
            .add_header("authorization", format!("Bearer {}", token))
            .json(&serde_json::json!({"source_paths": [path]}))
            .await;
    }

    let resp = server.get(&format!("/api/v1/projects/{}/ingest/jobs", pid))
        .add_header("authorization", format!("Bearer {}", token))
        .await;
    assert_eq!(resp.status_code(), StatusCode::OK);
    let body: serde_json::Value = resp.json();
    let items = body["items"].as_array().unwrap();
    assert!(items.len() >= 2);
}

#[tokio::test]
async fn create_ingest_job_unauthorized_returns_401() {
    let (server, _state, pid, _token) = setup().await;
    let resp = server.post(&format!("/api/v1/projects/{}/ingest", pid))
        .json(&serde_json::json!({"source_paths": ["test/x.md"]}))
        .await;
    assert_eq!(resp.status_code(), StatusCode::UNAUTHORIZED);
}
```

### Step 2: 注册模块 + 跑测试看 FAIL（handler 未注册）

`src-server/tests/integration/mod.rs` 加：

```rust
pub mod ingest_test;
```

```bash
cargo test -p llm_wiki_server --test integration create_ingest -- --nocapture
```
Expected：FAIL（404——`POST /api/v1/projects/{pid}/ingest` route 未注册，Task 0 未完成）

### Step 3: 跑测试验证 PASS（Task 0 已完成，E 已注册）

```bash
cargo test -p llm_wiki_server --test integration create_ingest -- --nocapture
cargo test -p llm_wiki_server --test integration get_job_status -- --nocapture
cargo test -p llm_wiki_server --test integration list_ingest_jobs -- --nocapture
cargo test -p llm_wiki_server --test integration create_ingest_job_unauthorized -- --nocapture
```
Expected：4 tests PASS

### Step 4: 全量集成回归

```bash
cargo test -p llm_wiki_server --test integration
```
Expected：所有已有 tests + 4 个新 ingest tests PASS。

### Step 5: commit

```bash
git add src-server/tests/integration/ingest_test.rs src-server/tests/integration/mod.rs
git commit -m "test(src-server): ingest API 集成测试（4 用例，子系统 E Task 1）"
```

---

## 最终验证

```bash
cargo build -p llm_wiki_server                  # 0 error
cargo test -p llm_wiki_server --test integration  # 全 PASS（含 4 ingest tests）
```

---

## Self-Review

**1. Spec 覆盖：**
- create_ingest_job (POST /:id/ingest) → Task 0 handler ✅
- list_ingest_jobs (GET /:id/ingest/jobs) → Task 0 handler ✅
- get_job_status (GET /ingest/jobs/:id) → Task 0 handler ✅
- 路由注册 (ingest_routes + global_ingest_routes) → Task 0 ✅
- 鉴权 (check_project_access) → Task 0 handler 内 ✅
- 4 集成测试 → Task 1 ✅
- projects.rs .merge() → Task 0 ✅

**2. 占位符扫描：** 无 TODO/TBD。handler 代码完整 ✅

**3. 类型一致：**
- `CreateIngestRequest { source_paths: Vec<String> }` 在所有 handler 中一致 ✅
- `ListIngestJobsQuery { status: Option<String>, limit: Option<i64> }` 与 C 的 list_jobs 签名对齐 ✅
- `check_project_access(&state, &headers, pid)` 返回 `(i32,i32)` 在 create_ingest_job 中解构正确 ✅
- `enqueue(state, pid, uid, Vec<String>)` 与 C 签名对齐 ✅
- 路由路径 `:id` 语法与 pages 一致 ✅

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-19-src-server-ingest-api-plan.md`. Two execution options:

**1. Subagent-Driven（推荐）** — 每 task 派发独立 subagent + 两轮 review
**2. Inline Execution** — 本会话批量执行 + checkpoint

Which approach?
