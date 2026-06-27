// src/routes/pages.rs
// wiki_pages CRUD（spec §3）。path 用 query param ?path=（避免 %2F 二次 decode）。
//
// Task 2/3/4：WikiPage model + 权限 helper + denormalize helper + 完整 CRUD（list/get/create/update/delete）。
//
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use crate::AppState;
use crate::AppError;
use crate::middleware::project_guard::{check_project_access, check_project_access_with_role, RequiredRole};

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
    /// 全文/标题搜索关键字——list_pages 尚未实现搜索逻辑（Task 5+ 检索阶段接入），
    /// 此处预留并精确 allow，避免整模块 allow(dead_code) 掩盖其他真未用项。
    #[allow(dead_code)]
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

/// POST /api/v1/projects/{pid}/pages —— 创建 page。
/// 用 ON CONFLICT (project_id, path) DO NOTHING + RETURNING：冲突时返回 0 行（fetch_optional None）→ 409。
/// 比 parse sqlx error code 23505 更干净（不依赖驱动特定错误字符串）。
pub async fn create_page(
    State(state): State<AppState>,
    Path(project_id): Path<i32>,
    headers: HeaderMap,
    Json(req): Json<CreatePageRequest>,
) -> Result<(StatusCode, Json<WikiPage>), AppError> {
    check_project_access(&state, &headers, project_id).await?;
    let (title, page_type, sources, images) = denormalize(&req.frontmatter, &req.title);
    // content 在 SQL .bind 处被 move，嵌入块在 SQL 之后——bind 前克隆供后续嵌入使用。
    let content_for_embed = req.content.clone();
    let page: Option<WikiPage> = sqlx::query_as::<_, WikiPage>(
        "INSERT INTO wiki_pages (project_id, path, title, content, frontmatter, page_type, sources, images)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (project_id, path) DO NOTHING
         RETURNING id, project_id, path, title, content, frontmatter, page_type, sources, images, created_at, updated_at",
    )
    .bind(project_id)
    .bind(&req.path)
    .bind(title)
    .bind(req.content)
    .bind(req.frontmatter)
    .bind(page_type)
    .bind(sources)
    .bind(images)
    .fetch_optional(&state.db)
    .await?;
    let page = page.ok_or_else(|| {
        AppError::Conflict("path already exists in this project".to_string())
    })?;
    // 维护 embedding（非致命：失败只 log，不影响页面写入）
    match content_for_embed.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(text) => {
            if let Err(e) = crate::services::embedding::embed_page(
                &*state.vector_store, state.config.embedding.as_ref(), &state.http,
                project_id, &req.path, text,
            ).await {
                tracing::warn!("embed page {} failed (search degraded): {}", req.path, e);
            }
        }
        None => {
            let _ = crate::services::embedding::delete_embedding(&*state.vector_store, project_id, &req.path).await;
        }
    }
    Ok((StatusCode::CREATED, Json(page)))
}

/// PUT /api/v1/projects/{pid}/page?path= —— 更新 page（If-Match 乐观锁）。
/// If-Match 携带 GET/POST 返回的 updated_at（RFC3339），服务端解析为 DateTime<Utc> 作 timestamptz 直接比较，
/// 避开脆弱的 to_char 字符串匹配。WHERE updated_at = $if_match 精确到微秒。
pub async fn update_page(
    State(state): State<AppState>,
    Path(project_id): Path<i32>,
    Query(pq): Query<PathQuery>,
    headers: HeaderMap,
    Json(req): Json<CreatePageRequest>,
) -> Result<Json<WikiPage>, AppError> {
    check_project_access(&state, &headers, project_id).await?;

    // MVP：不支持 path 重命名（rename 是独立功能，需级联处理引用/索引）。
    // PUT 到 ?path=X 的资源，body.path 必须与之一致。
    if req.path != pq.path {
        return Err(AppError::ValidationError(
            "body path must match query path (rename not supported)".to_string(),
        ));
    }

    // If-Match → DateTime<Utc>（headers 同时供 check_project_access 和此处读取，共用一个 HeaderMap 提取器）
    let if_match_str = headers
        .get("if-match")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| AppError::ValidationError("If-Match header required".to_string()))?;
    let if_match: DateTime<Utc> = DateTime::parse_from_rfc3339(if_match_str)
        .map_err(|_| {
            AppError::ValidationError(
                "Invalid If-Match (expected RFC3339 timestamp)".to_string(),
            )
        })?
        .with_timezone(&Utc);

    let (title, page_type, sources, images) = denormalize(&req.frontmatter, &req.title);
    // content 在 SQL .bind 处被 move，嵌入块在 SQL 之后——bind 前克隆供后续嵌入使用。
    let content_for_embed = req.content.clone();
    // 乐观锁：updated_at = $if_match（timestamptz 精确比较，冲突或 not found 都返回 0 行 → 409）
    let page: Option<WikiPage> = sqlx::query_as::<_, WikiPage>(
        "UPDATE wiki_pages SET title=$1, content=$2, frontmatter=$3, page_type=$4, sources=$5, images=$6,
                                path=$7, updated_at=NOW()
         WHERE project_id=$8 AND path=$9 AND updated_at=$10
         RETURNING id, project_id, path, title, content, frontmatter, page_type, sources, images, created_at, updated_at",
    )
    .bind(title)
    .bind(req.content)
    .bind(req.frontmatter)
    .bind(page_type)
    .bind(sources)
    .bind(images)
    .bind(&req.path)
    .bind(project_id)
    .bind(&pq.path)
    .bind(if_match)
    .fetch_optional(&state.db)
    .await?;
    let page = page.ok_or_else(|| {
        AppError::Conflict(
            "updated_at mismatch (stale write or page not found)".to_string(),
        )
    })?;
    // 维护 embedding（非致命：失败只 log，不影响页面写入）
    // 嵌入块在乐观锁 409 检查之后——stale/not-found 走 409 不维护向量。
    match content_for_embed.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(text) => {
            if let Err(e) = crate::services::embedding::embed_page(
                &*state.vector_store, state.config.embedding.as_ref(), &state.http,
                project_id, &pq.path, text,
            ).await {
                tracing::warn!("embed page {} failed (search degraded): {}", pq.path, e);
            }
        }
        None => {
            let _ = crate::services::embedding::delete_embedding(&*state.vector_store, project_id, &pq.path).await;
        }
    }
    Ok(Json(page))
}

/// DELETE /api/v1/projects/{pid}/page?path= —— 删除 page。
/// rows_affected == 0 → 404。
pub async fn delete_page(
    State(state): State<AppState>,
    Path(project_id): Path<i32>,
    Query(pq): Query<PathQuery>,
    headers: HeaderMap,
) -> Result<StatusCode, AppError> {
    check_project_access_with_role(&state, &headers, project_id, RequiredRole::Admin).await?;
    let n = sqlx::query("DELETE FROM wiki_pages WHERE project_id=$1 AND path=$2")
        .bind(project_id)
        .bind(&pq.path)
        .execute(&state.db)
        .await?;
    if n.rows_affected() == 0 {
        return Err(AppError::ResourceNotFound("page".to_string()));
    }
    // 页已删才清向量（404 不维护）。失败忽略（best-effort）。
    let _ = crate::services::embedding::delete_embedding(&*state.vector_store, project_id, &pq.path).await;
    Ok(StatusCode::NO_CONTENT)
}

/// pages 路由（merge 进 project_routes，挂在 /api/v1/projects 下）。
/// 路径参数语法用 :id（matchit 0.7.3 语法，与 files.rs 一致；axum 0.7.9 不转换 {id}）。
pub fn pages_routes() -> axum::Router<AppState> {
    axum::Router::new()
        .route("/:id/pages", axum::routing::get(list_pages).post(create_page))
        .route(
            "/:id/page",
            axum::routing::get(get_page).put(update_page).delete(delete_page),
        )
}
