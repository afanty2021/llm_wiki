use axum::{
    extract::{Path, State},
    http::HeaderMap,
    Json,
    response::IntoResponse,
};
use serde::Deserialize;
use sqlx::Row;
use crate::{
    middleware::require_auth, AppError, AppState,
    models::{TeamResponse, UserResponse},
};

#[derive(Debug, Deserialize)]
pub struct UpdateUserRequest {
    pub full_name: Option<String>,
}

pub fn user_routes() -> axum::Router<AppState> {
    axum::Router::new()
        .route("/me", axum::routing::get(get_current_user))
        .route("/me", axum::routing::put(update_current_user))
        .route("/me/teams", axum::routing::get(get_user_teams))
        // SEC-1：`/{id}` 在 axum 0.7 是**字面量**（路径参数语法是 `:id`，0.8 才改
        // `{id}`）——GET /users/1 从未进过 handler，一直落到 SPA fallback 200。
        // 改为真参数路由 + require_auth，端点从"死的 public"变为"活的 authenticated"。
        .route("/:id", axum::routing::get(get_user_by_id))
}

/// GET /users/me - Get current user profile (authenticated)
async fn get_current_user(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, AppError> {
    let claims = require_auth(&state, &headers).await?;
    let user_id: i32 = claims.sub.parse()?;

    let row = sqlx::query(
        "SELECT id, username, email, full_name, created_at FROM users WHERE id = $1"
    )
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::ResourceNotFound("User not found".to_string()))?;

    let user_response = UserResponse {
        id: row.get("id"),
        username: row.get("username"),
        email: row.get("email"),
        full_name: row.get("full_name"),
        created_at: row.get("created_at"),
    };

    Ok(Json(user_response))
}

/// PUT /users/me - Update current user's full_name (authenticated)
async fn update_current_user(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<UpdateUserRequest>,
) -> Result<impl IntoResponse, AppError> {
    let claims = require_auth(&state, &headers).await?;
    let user_id: i32 = claims.sub.parse()?;

    let row = sqlx::query(
        "UPDATE users SET full_name = $1, updated_at = NOW() WHERE id = $2 RETURNING id, username, email, full_name, created_at"
    )
    .bind(&req.full_name)
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::ResourceNotFound("User not found".to_string()))?;

    let user_response = UserResponse {
        id: row.get("id"),
        username: row.get("username"),
        email: row.get("email"),
        full_name: row.get("full_name"),
        created_at: row.get("created_at"),
    };

    Ok(Json(user_response))
}

/// GET /users/me/teams - Get teams the current user belongs to (authenticated)
async fn get_user_teams(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, AppError> {
    let claims = require_auth(&state, &headers).await?;
    let user_id: i32 = claims.sub.parse()?;

    let teams = sqlx::query_as::<_, TeamResponse>(
        "SELECT t.id, t.name, t.description, t.created_by, t.created_at, \
         COUNT(tm.user_id) as member_count \
         FROM teams t \
         INNER JOIN team_members tm ON t.id = tm.team_id \
         WHERE t.id IN (SELECT team_id FROM team_members WHERE user_id = $1) \
         GROUP BY t.id"
    )
    .bind(user_id)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(teams))
}

/// GET /users/:id - Get user by ID (self / admin only)
///
/// SEC-1（终审必修）：曾为 public——公网遍历 id 即拉全部教师 PII
/// （username/email/full_name）。加 require_auth（同文件 /me 同款 JWT 模式）。
/// M4 前置收窄：require_auth 后任意登录用户仍可查任意人——再收为「本人或
/// ADMIN_USERNAMES 白名单」。sub 为签发时 user id 字符串；解析失败（非本域
/// 签发形态）视作非本人走 admin 判定。
/// 调用方核查（2026-08-22）：桌面端走自有 API（src/lib/api-client.ts 仅
/// /users/me*），transcriber/mcp 只用 /training/*——无跨用户查询依赖，直接收紧。
async fn get_user_by_id(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i32>,
) -> Result<impl IntoResponse, AppError> {
    let claims = require_auth(&state, &headers).await?;
    let is_self = claims.sub.parse::<i32>().is_ok_and(|sid| sid == id);
    if !is_self && !crate::middleware::is_admin(&claims.username, &state.config.admin_usernames()) {
        return Err(AppError::PermissionDenied);
    }
    let row = sqlx::query(
        "SELECT id, username, email, full_name, created_at FROM users WHERE id = $1"
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::ResourceNotFound("User not found".to_string()))?;

    let user_response = UserResponse {
        id: row.get("id"),
        username: row.get("username"),
        email: row.get("email"),
        full_name: row.get("full_name"),
        created_at: row.get("created_at"),
    };

    Ok(Json(user_response))
}
