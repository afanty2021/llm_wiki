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
    ensure_access_typ(&claims)?;

    Ok(claims)
}

/// typ 隔离（Task 6）：claims.typ 存在且 != "access" → AuthInvalid（401——对 /api
/// 而言它就是不合规凭证，如拿 plan_link token 调 /api）；None → 存量兼容
/// （M1 旧 token 无 typ，视作 access 放行）。
fn ensure_access_typ(claims: &Claims) -> Result<(), AppError> {
    if let Some(t) = &claims.typ {
        if t != "access" {
            return Err(AppError::AuthInvalid(format!(
                "Wrong token type: expected 'access', got '{}'",
                t
            )));
        }
    }
    Ok(())
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

/// 纯函数：username 是否在 admin 白名单（空白名单 → 全拒）。
/// pub（M4 前置收窄）：users/:id 的 self/admin 判定复用（/logs 的 require_admin
/// 同源——admin 语义全仓一致走 ADMIN_USERNAMES 白名单）。
pub fn is_admin(username: &str, admins: &[String]) -> bool {
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

    // ============ Task 6：require_auth 的 typ 隔离规则 ============

    use crate::models::Claims;

    fn claims_with_typ(typ: Option<&str>) -> Claims {
        Claims {
            sub: "1".to_string(),
            username: "u".to_string(),
            exp: chrono::Utc::now().timestamp() + 3600,
            iat: chrono::Utc::now().timestamp(),
            jti: String::new(),
            typ: typ.map(|s| s.to_string()),
        }
    }

    /// 存量兼容：旧 token 无 typ（None）→ require_auth 放行。
    #[test]
    fn ensure_access_typ_none_passes() {
        assert!(ensure_access_typ(&claims_with_typ(None)).is_ok());
    }

    /// 新 access token（typ="access"）→ 放行。
    #[test]
    fn ensure_access_typ_access_passes() {
        assert!(ensure_access_typ(&claims_with_typ(Some("access"))).is_ok());
    }

    /// plan_link token 打 /api → AuthInvalid（401：对 API 而言它就是不合规凭证）。
    #[test]
    fn ensure_access_typ_plan_link_rejected_auth_invalid() {
        let err = ensure_access_typ(&claims_with_typ(Some("plan_link"))).unwrap_err();
        assert!(matches!(err, crate::AppError::AuthInvalid(_)), "got: {:?}", err);
    }

    /// 任何其他 typ 值同样拒绝（不白名单枚举之外放行）。
    #[test]
    fn ensure_access_typ_other_rejected_auth_invalid() {
        let err = ensure_access_typ(&claims_with_typ(Some("refresh"))).unwrap_err();
        assert!(matches!(err, crate::AppError::AuthInvalid(_)), "got: {:?}", err);
    }
}

// Integration tests for require_auth will be added after database setup
