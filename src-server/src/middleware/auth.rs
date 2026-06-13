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

// Integration tests for require_auth will be added after database setup
