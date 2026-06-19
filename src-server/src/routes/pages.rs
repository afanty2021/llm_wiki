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
use crate::{AppError, AppState};

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

/// 校验 user 是 project 的 team member；返回 role。无权限 → ResourceNotFound。
/// 调用方须先经 require_auth 提取 user_id。
pub(crate) async fn check_project_access(
    state: &AppState,
    project_id: i32,
    user_id: i32,
) -> Result<String, AppError> {
    // 运行时查询（非宏），JOIN projects↔team_members 取 role
    let role: Option<String> = sqlx::query_scalar(
        "SELECT tm.role FROM projects p \
         JOIN team_members tm ON p.team_id = tm.team_id \
         WHERE p.id = $1 AND tm.user_id = $2",
    )
    .bind(project_id)
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?;
    role.ok_or_else(|| AppError::ResourceNotFound(
        "Project not found or you are not a member".to_string()
    ))
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

/// pages 路由（merge 进 project_routes，挂在 /api/v1/projects 下）。
/// Task 3-4 在此注册具体 route。当前为空骨架，merge 合法。
pub fn pages_routes() -> axum::Router<AppState> {
    axum::Router::new()
}
