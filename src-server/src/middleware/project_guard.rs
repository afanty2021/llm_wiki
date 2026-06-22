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
