# 子系统 E 详细设计 — ingest API 端点 (`routes/ingest.rs`)

> **状态**：详细设计草稿（2026-06-19）| **上级**：[ingest Plan B 总览设计](2026-06-19-src-server-ingest-design.md) §6
>
> 实现 3 个 HTTP 端点：`POST /projects/:id/ingest`（入队）、`GET /ingest/jobs/:id`（查进度）、`GET /projects/:id/ingest/jobs`（列历史）。所有 handler 是薄转发层——鉴权 → 调 C 的 helper → 序列化响应。路由通过 `.merge()` 合入 `project_routes()`，与 pages 一致。

---

## 1. 目标与边界

**E 做什么**：
- 3 个 HTTP handler（每个 <20 行），全部调用子系统 C 的现有 helper
- 路由注册 + 鉴权（`middleware::project_guard::check_project_access`）
- 请求/响应格式序列化

**E 不做什么**：
- 不管队列调度、worker、解析、LLM（那是 A/B/C/D 的事）
- 不管前端 UI（SSE 推送后续加）

**边界**：E 是 3 个纯 handler。被 `src/routes/mod.rs` 通过 `project_routes().merge(ingest::ingest_routes())` 挂载。`GET /ingest/jobs/:id` 不绑项目 → 独立 router。

---

## 2. 模块结构

```
src-server/src/routes/ingest.rs              (~80 行)
 ├── POST /:id/ingest → create_ingest_job    (<20 行)
 ├── GET  /:id/ingest/jobs → list_ingest_jobs (<20 行)
 ├── GET  /ingest/jobs/:id → get_job_status   (<20 行，独立 router)
 └── pub fn ingest_routes() → Router<AppState>
     pub fn global_ingest_routes() → Router<AppState>
```

---

## 3. Handler 签名

```rust
// routes/ingest.rs

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    Json, Router,
};
use uuid::Uuid;
use crate::{AppError, AppState};
use crate::services::ingest_queue;

// ── Request DTOs ──

#[derive(Debug, Deserialize)]
pub struct CreateIngestRequest {
    pub source_paths: Vec<String>,       // 单 job 可多文件（已存在 files API 上传）
}

#[derive(Debug, Deserialize)]
pub struct ListIngestJobsQuery {
    pub status: Option<String>,          // ?status=succeeded 过滤
    pub limit: Option<i64>,              // ?limit=10，默认 20，max 100
}

// ── POST /api/v1/projects/:id/ingest ──

async fn create_ingest_job(
    State(state): State<AppState>,
    Path(project_id): Path<i32>,
    headers: HeaderMap,
    Json(req): Json<CreateIngestRequest>,
) -> Result<(StatusCode, Json<serde_json::Value>), AppError> {
    check_project_access(&state, &headers, project_id).await?;
    let user_id = /* claims.sub.parse() from check_project_access return */ todo!();
    // check_project_access 返回 (user_id, team_id)——目前只用 user_id
    // 简化：check_project_access 后直接 enqueue
    let job_id = ingest_queue::enqueue(&state, project_id, user_id, req.source_paths).await?;
    Ok((StatusCode::CREATED, Json(serde_json::json!({"job_id": job_id.to_string(), "status": "pending"}))))
}

// ── GET /api/v1/projects/:id/ingest/jobs ──

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

// ── GET /api/v1/ingest/jobs/:id（不绑 project）──

async fn get_job_status(
    State(state): State<AppState>,
    Path(job_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, AppError> {
    let job = ingest_queue::job_status(&state, job_id).await?;
    Ok(Json(serde_json::to_value(job)?))
}
```

**鉴权注**：`create_ingest_job` 和 `list_ingest_jobs` 用 `check_project_access(&state, &headers, project_id)`（返回 `(user_id, team_id)`）。`get_job_status` 不绑 project——直接按 `job_id` 查 PG（MVP 不加额外鉴权，job_id UUID 不可猜测。后续可加创建者验证）。

`create_ingest_job` 的 `user_id` 从 `check_project_access` 返回值取——当前签名返回 `(user_id, team_id)`，用 `let (user_id, _) = check_project_access(...).await?;`。

---

## 4. 路由注册

```rust
// routes/ingest.rs

/// project-scoped routes——通过 .merge() 合入 project_routes()（与 pages 一致）。
pub fn ingest_routes() -> Router<AppState> {
    Router::new()
        .route("/:id/ingest",      axum::routing::post(create_ingest_job))
        .route("/:id/ingest/jobs", axum::routing::get(list_ingest_jobs))
}

/// 不绑 project 的 global route——GET /ingest/jobs/:id。
pub fn global_ingest_routes() -> Router<AppState> {
    Router::new()
        .route("/api/v1/ingest/jobs/:id", axum::routing::get(get_job_status))
}

// 挂载到 routes/mod.rs
// project_routes() 里 .merge(ingest::ingest_routes())  —— project-scoped
// create_routerstate 里 .merge(ingest::global_ingest_routes()) —— global
```

与 pages 一致：`project_routes()` 内部 `.merge(pages::pages_routes())`，E 同理 `.merge(ingest::ingest_routes())`。global route 直接在 `create_router` 里加一行 `.merge(ingest::global_ingest_routes())`。

---

## 5. create_ingest_job — user_id 获取细节

`check_project_access` 返回 `(i32, i32)` 即 `(user_id, team_id)`。handler 取第一个 `.0` 即可：

```rust
let (user_id, _team_id) = check_project_access(&state, &headers, project_id).await?;
let job_id = ingest_queue::enqueue(&state, project_id, user_id, req.source_paths).await?;
```

但注意当前 `check_project_access` 签名是 `(&AppState, &HeaderMap, i32) -> Result<(i32,i32), AppError>`——第二个是 `&HeaderMap`，在 handler 里 headers 已经是 `HeaderMap`，传 `&headers` 即可。已验证与 C 的 `enqueue` 签名 (`&AppState, i32, i32, Vec<String>`)一致。

---

## 6. 错误处理

- `source_paths` 为空 → C `enqueue` 层不禁止（空数组可入队，后续无作为成功）。E 不加校验——留给 C 处理自然行为。
- `limit` 超 100 → C `list_jobs` 内部 `limit.unwrap_or(20).min(100)` 边界控制。E 不重复处理。
- job 不存在 → C `job_status` 返 `ResourceNotFound` → 404。E 透传。

---

## 7. 测试策略

| 类型 | 内容 | 实现 |
|------|------|------|
| integ: 入队 + 查进度 | POST /projects/:pid/ingest → 201 + job_id → GET /ingest/jobs/:id → 200 pending | **需 live DB+redis**，加 `pages_test` |
| integ: 列出历史 | 建 2 个 job → GET /projects/:pid/ingest/jobs → items.len() >= 2 | **需 live DB+redis** |
| integ: 401 鉴权 | 无 token POST → 401 | **需 live DB+redis** |

全部集成测试不加 `#[ignore]`。需 `mod.rs` 注册 pub mod ingest_test。

---

## 8. 文件改动清单

| 文件 | 改动 |
|------|------|
| `src-server/src/routes/ingest.rs` | **Create** (~80 行) |
| `src-server/src/routes/mod.rs` | 加 `mod ingest;` + `.merge(ingest::global_ingest_routes())` |
| `src-server/src/routes/projects.rs` | `project_routes()` 末尾加 `.merge(ingest::ingest_routes())` |
| `src-server/tests/integration/ingest_test.rs` | **Create**（集成测试, 4 用例）|
| `src-server/tests/integration/mod.rs` | 加 `pub mod ingest_test;` |

**依赖已满足**：C 子系统已完成（`ingest_queue` helper 全部可用），E 不依赖 A/B/D。
