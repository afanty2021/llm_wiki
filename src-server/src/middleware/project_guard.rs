use crate::{AppState, AppError};
use axum::http::HeaderMap;
use crate::middleware::auth::require_auth;
use sqlx::Row;

/// 验证当前用户是否可以访问指定项目
/// 返回 (user_id, team_id)，供后续 handler 使用
pub async fn check_project_access(
    state: &AppState,
    headers: &HeaderMap,
    project_id: i32,
) -> Result<(i32, i32), AppError> {
    let claims = require_auth(state, headers).await?;
    let user_id = claims.sub.parse::<i32>()?;

    let row = sqlx::query(
        "SELECT p.team_id, tm.role as member_role
         FROM projects p
         JOIN team_members tm ON p.team_id = tm.team_id
         WHERE p.id = $1 AND tm.user_id = $2",
    )
    .bind(project_id)
    .bind(user_id)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| AppError::DatabaseError(e))?;

    match row {
        Some(r) => {
            let team_id: i32 = r.get("team_id");
            Ok((user_id, team_id))
        }
        None => Err(AppError::PermissionDenied),
    }
}
