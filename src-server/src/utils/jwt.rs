use anyhow::Result;
use chrono::{Duration, Utc};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use crate::{AppError};
use crate::models::Claims;

const BEARER_PREFIX: &str = "Bearer ";

#[derive(Debug, Serialize, Deserialize)]
struct InternalRefreshClaims {
    sub: String,  // user_id
    exp: i64,
    iat: i64,
    jti: String,  // token ID
}

/// Generate an access token for a user
pub fn generate_access_token(user_id: i32, username: &str, secret: &str, ttl: Duration) -> Result<String> {
    let now = Utc::now();
    let expire = now + ttl;

    let claims = Claims {
        sub: user_id.to_string(),
        username: username.to_string(),
        exp: expire.timestamp() as usize,
        iat: now.timestamp() as usize,
        jti: uuid::Uuid::new_v4().to_string(),
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
pub fn generate_refresh_token(user_id: i32, secret: &str, ttl: Duration) -> Result<(String, String)> {
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
