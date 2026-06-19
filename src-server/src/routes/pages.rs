// src/routes/pages.rs
// wiki_pages CRUD（spec §3）。path 用 query param ?path=（避免 %2F 二次 decode）。
//
// Task 2：仅骨架——WikiPage model + 权限 helper + denormalize helper + 空 router。
// Task 3/4 在此注册具体 route 并落地 handler 逻辑。
//
// 整个模块的 handler 尚未接入路由，model/request struct/helper 暂无调用方，
// 模块级 allow(dead_code) 避免骨架阶段噪音；Task 3/4 接入后移除。
#![allow(dead_code)]
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use axum::Json;
use crate::AppState;
use crate::AppError;
use crate::middleware::project_guard::check_project_access;

/// wiki_pages 表的 API 视图模型。
/// created_at/updated_at 用 DateTime<Utc>（chrono serde 序列化为 RFC3339），
/// 与 src/models/team.rs 的 Team 模型风格一致。
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
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
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct CreatePageRequest {
    pub path: String,
    pub title: Option<String>,
    pub content: Option<String>,
    pub frontmatter: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
pub struct ListQuery {
    #[serde(rename = "type")]
    pub page_type: Option<String>,
    pub q: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct PathQuery {
    pub path: String,
}

/// 从 frontmatter 同步填充规范化列（title/page_type/sources/images）。
/// 返回 (title, page_type, sources, images) 供 INSERT。
pub(crate) fn denormalize(
    fm: &Option<serde_json::Value>,
    req_title: &Option<String>,
) -> (Option<String>, String, serde_json::Value, serde_json::Value) {
    let fm_obj = fm.as_ref().and_then(|v| v.as_object());
    let title = req_title.clone().or_else(|| {
        fm_obj.and_then(|m| m.get("title")).and_then(|v| v.as_str()).map(String::from)
    });
    let page_type = fm_obj
        .and_then(|m| m.get("type"))
        .and_then(|v| v.as_str())
        .map(String::from)
        .unwrap_or_else(|| "concept".to_string());
    let sources = fm_obj.and_then(|m| m.get("sources")).cloned().unwrap_or(serde_json::json!([]));
    let images = fm_obj.and_then(|m| m.get("images")).cloned().unwrap_or(serde_json::json!([]));
    (title, page_type, sources, images)
}

/// GET /api/v1/projects/{pid}/pages —— 列表（可选 ?type= 过滤）。
/// 权限：project_guard 内部 require_auth + team 成员校验，非成员→403。
pub async fn list_pages(
    State(state): State<AppState>,
    Path(project_id): Path<i32>,
    Query(q): Query<ListQuery>,
    headers: HeaderMap,
) -> Result<Json<Vec<WikiPage>>, AppError> {
    check_project_access(&state, &headers, project_id).await?;
    let pages: Vec<WikiPage> = if let Some(t) = &q.page_type {
        sqlx::query_as::<_, WikiPage>(
            "SELECT id, project_id, path, title, content, frontmatter, page_type, sources, images, created_at, updated_at
             FROM wiki_pages WHERE project_id = $1 AND page_type = $2 ORDER BY title",
        )
        .bind(project_id)
        .bind(t)
        .fetch_all(&state.db)
        .await?
    } else {
        sqlx::query_as::<_, WikiPage>(
            "SELECT id, project_id, path, title, content, frontmatter, page_type, sources, images, created_at, updated_at
             FROM wiki_pages WHERE project_id = $1 ORDER BY title",
        )
        .bind(project_id)
        .fetch_all(&state.db)
        .await?
    };
    Ok(Json(pages))
}

/// GET /api/v1/projects/{pid}/page?path= —— 单个（path 用 query 避免 %2F 二次 decode）。
pub async fn get_page(
    State(state): State<AppState>,
    Path(project_id): Path<i32>,
    Query(pq): Query<PathQuery>,
    headers: HeaderMap,
) -> Result<Json<WikiPage>, AppError> {
    check_project_access(&state, &headers, project_id).await?;
    let page: WikiPage = sqlx::query_as::<_, WikiPage>(
        "SELECT id, project_id, path, title, content, frontmatter, page_type, sources, images, created_at, updated_at
         FROM wiki_pages WHERE project_id = $1 AND path = $2",
    )
    .bind(project_id)
    .bind(&pq.path)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::ResourceNotFound("page".to_string()))?;
    Ok(Json(page))
}

/// pages 路由（merge 进 project_routes，挂在 /api/v1/projects 下）。
/// 路径参数语法用 :id（matchit 0.7.3 语法，与 files.rs 一致；axum 0.7.9 不转换 {id}）。
/// Task 3：list_pages + get_page 已接入；POST/PUT/DELETE 在 Task 4。
pub fn pages_routes() -> axum::Router<AppState> {
    axum::Router::new()
        .route("/:id/pages", axum::routing::get(list_pages))
        .route("/:id/page", axum::routing::get(get_page))
}
