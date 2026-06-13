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
        .route("/{id}", axum::routing::get(get_user_by_id))
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

/// GET /users/:id - Get user by ID (public)
async fn get_user_by_id(
    State(state): State<AppState>,
    Path(id): Path<i32>,
) -> Result<impl IntoResponse, AppError> {
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
