use axum::http::HeaderMap;
use crate::{AppState, AppError};
use crate::models::Claims;
use crate::utils::verify_token;

/// 认证辅助函数（普通函数，非Axum extractor）
/// 从请求头中提取并验证 JWT token
pub async fn require_auth(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<Claims, AppError> {
    let auth_header = headers
        .get("authorization")
        .and_then(|h| h.to_str().ok())
        .ok_or(AppError::AuthInvalid("Missing authorization header".to_string()))?;

    let secret = &state.config.jwt_secret();
    let claims = verify_token(auth_header, secret)?;

    Ok(claims)
}

/// 管理员鉴权：require_auth + username ∈ ADMIN_USERNAMES 白名单（/logs 用）。
/// 白名单为空时拒绝所有（安全默认：未配置 admin 则 /logs 全 403）。
pub async fn require_admin(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<Claims, AppError> {
    let claims = require_auth(state, headers).await?;
    if !is_admin(&claims.username, &state.config.admin_usernames()) {
        return Err(AppError::PermissionDenied);
    }
    Ok(claims)
}

/// 纯函数：username 是否在 admin 白名单（空白名单 → 全拒）
fn is_admin(username: &str, admins: &[String]) -> bool {
    !admins.is_empty() && admins.iter().any(|a| a == username)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_admin_empty_whitelist_denies_all() {
        assert!(!is_admin("anyone", &[]));
        assert!(!is_admin("", &[]));
    }

    #[test]
    fn is_admin_match_allows() {
        assert!(is_admin("admin", &["admin".to_string()]));
    }

    #[test]
    fn is_admin_no_match_denies() {
        assert!(!is_admin("user", &["admin".to_string()]));
    }

    #[test]
    fn is_admin_multiple_admins() {
        let admins = vec!["alice".to_string(), "bob".to_string()];
        assert!(is_admin("alice", &admins));
        assert!(is_admin("bob", &admins));
        assert!(!is_admin("carol", &admins));
    }
}

// Integration tests for require_auth will be added after database setup
