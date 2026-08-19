use chrono::{Duration, Utc};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use jsonwebtoken::errors::ErrorKind;
use serde::{Deserialize, Serialize};
use crate::{AppError};
use crate::models::{Claims, PlanLinkClaims};

const BEARER_PREFIX: &str = "Bearer ";

/// Token 类型标识（Task 6 隔离）：access = /api 凭证；plan_link = /t/ 落地页凭证。
pub const TOKEN_TYPE_ACCESS: &str = "access";
pub const TOKEN_TYPE_PLAN_LINK: &str = "plan_link";

#[derive(Debug, Serialize, Deserialize)]
struct InternalRefreshClaims {
    sub: String,  // user_id
    exp: i64,
    iat: i64,
    jti: String,  // token ID
}

/// Generate an access token for a user
pub fn generate_access_token(user_id: i32, username: &str, secret: &str, ttl: Duration) -> Result<String, AppError> {
    let now = Utc::now();
    let expire = now + ttl;

    let claims = Claims {
        sub: user_id.to_string(),
        username: username.to_string(),
        exp: expire.timestamp(),
        iat: now.timestamp(),
        jti: String::new(), // Empty string for access tokens (no JTI needed)
        typ: Some(TOKEN_TYPE_ACCESS.to_string()),
    };

    let token = encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_ref()),
    )?;

    Ok(token)
}

/// Generate a refresh token for a user
/// Returns (token, jti) where jti is the unique token ID
pub fn generate_refresh_token(user_id: i32, secret: &str, ttl: Duration) -> Result<(String, String), AppError> {
    let now = Utc::now();
    let expire = now + ttl;
    let jti = uuid::Uuid::new_v4().to_string();

    let claims = InternalRefreshClaims {
        sub: user_id.to_string(),
        exp: expire.timestamp(),
        iat: now.timestamp(),
        jti: jti.clone(),
    };

    let token = encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_ref()),
    )?;

    Ok((token, jti))
}

/// Verify an access token and return the claims
pub fn verify_token(token: &str, secret: &str) -> Result<Claims, AppError> {
    let token = token.trim_start_matches(BEARER_PREFIX);

    let decoded = decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_ref()),
        &Validation::default(),
    ).map_err(|e| AppError::AuthInvalid(format!("Invalid token: {}", e)))?;

    Ok(decoded.claims)
}

/// Verify a refresh token and return (user_id, jti)
pub fn verify_refresh_token(token: &str, secret: &str) -> Result<(i32, String), AppError> {
    let token = token.trim_start_matches(BEARER_PREFIX);

    let decoded = decode::<InternalRefreshClaims>(
        token,
        &DecodingKey::from_secret(secret.as_ref()),
        &Validation::default(),
    ).map_err(|e| AppError::AuthInvalid(format!("Invalid refresh token: {}", e)))?;

    let user_id = decoded.claims.sub.parse::<i32>()
        .map_err(|_| AppError::AuthInvalid("Invalid user ID in token".to_string()))?;

    Ok((user_id, decoded.claims.jti))
}

/// Generate a plan_link token (/t/ 落地页凭证，Task 9 消费)。
/// typ="plan_link"，custom claim `plid` 携带 plan_id；与 access Claims 结构互不兼容。
pub fn generate_plan_link_token(
    user_id: i32,
    plan_id: i32,
    secret: &str,
    ttl: Duration,
) -> Result<String, AppError> {
    let claims = PlanLinkClaims {
        sub: user_id.to_string(),
        plid: plan_id,
        exp: (Utc::now() + ttl).timestamp(),
        typ: TOKEN_TYPE_PLAN_LINK.to_string(),
    };

    let token = encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_ref()),
    )?;

    Ok(token)
}

/// Verify a plan_link token, returning (user_id, plan_id)。
/// 错误语义（brief）：typ 不符/过期 → `PermissionDenied`（403，/t/ 域内拒绝）；
/// 签名无效 → `AuthInvalid`（401，沿用 jwt.rs 惯例）。
/// plan 不存在/不归属 → 404 是路由层（Task 9）的职责，此处不管。
pub fn verify_plan_link_token(token: &str, secret: &str) -> Result<(i32, i32), AppError> {
    let token = token.trim_start_matches(BEARER_PREFIX);

    let decoded = decode::<PlanLinkClaims>(
        token,
        &DecodingKey::from_secret(secret.as_ref()),
        &Validation::default(),
    )
    .map_err(|e| match e.kind() {
        // 签名无效 → 401：凭证不可信（jwt.rs 惯例）
        ErrorKind::InvalidSignature => {
            AppError::AuthInvalid(format!("Invalid plan link token signature: {}", e))
        }
        // 其余 → 403：过期（ExpiredSignature）、claims 形状不符（Json，如拿 access
        // token 来验——即 typ 家族拒绝）、结构垃圾（InvalidToken/Base64），均在
        // /t/ 域内拒绝而非当作凭证无效
        _ => AppError::PermissionDenied,
    })?;

    // decode 后先验 typ，再取 plid（防伪造：字段齐备但 typ 不是 plan_link）
    if decoded.claims.typ != TOKEN_TYPE_PLAN_LINK {
        return Err(AppError::PermissionDenied);
    }

    let user_id = decoded.claims.sub.parse::<i32>()
        .map_err(|_| AppError::AuthInvalid("Invalid user ID in plan link token".to_string()))?;

    Ok((user_id, decoded.claims.plid))
}
