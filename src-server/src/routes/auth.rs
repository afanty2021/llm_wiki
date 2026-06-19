use axum::{extract::State, http::StatusCode, response::IntoResponse, Json, Router};
use chrono::Duration as ChronoDuration;
use sqlx::Row;
use crate::{
    AppError, AppState,
    models::{AuthResponse, LoginRequest, RefreshTokenRequest, RegisterRequest, UserResponse},
    utils,
};

pub fn auth_routes() -> Router<AppState> {
    Router::new()
        .route("/register", axum::routing::post(register))
        .route("/login", axum::routing::post(login))
        .route("/logout", axum::routing::post(logout))
        .route("/refresh", axum::routing::post(refresh))
}

/// Generate access + refresh tokens and persist the refresh token hash.
/// Returns (AuthResponse, refresh_ttl_secs, token_hash, expires_at) for caller use.
async fn generate_and_persist_tokens(
    state: &AppState,
    user_id: i32,
    username: &str,
    user_response: UserResponse,
) -> Result<AuthResponse, AppError> {
    let secret = state.config.jwt_secret();
    let access_ttl_secs = state.config.jwt_access_token_ttl().as_secs();
    let refresh_ttl_secs = state.config.jwt_refresh_token_ttl().as_secs();

    let access_token = utils::generate_access_token(
        user_id,
        username,
        secret,
        ChronoDuration::seconds(access_ttl_secs as i64),
    )?;

    let (refresh_token, _jti) = utils::generate_refresh_token(
        user_id,
        secret,
        ChronoDuration::seconds(refresh_ttl_secs as i64),
    )?;

    let token_hash = utils::hash_refresh_token(&refresh_token);
    let expires_at = chrono::Utc::now() + ChronoDuration::seconds(refresh_ttl_secs as i64);

    sqlx::query(
        "INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)"
    )
    .bind(user_id)
    .bind(&token_hash)
    .bind(expires_at)
    .execute(&state.db)
    .await
    .map_err(AppError::from)?;

    Ok(AuthResponse {
        access_token,
        refresh_token,
        expires_in: access_ttl_secs,
        user: user_response,
    })
}

/// POST /auth/register
///
/// Validates input, checks for duplicate username/email, hashes password,
/// inserts user into database, generates tokens, stores refresh token hash,
/// and returns AuthResponse with user data.
async fn register(
    State(state): State<AppState>,
    Json(req): Json<RegisterRequest>,
) -> Result<impl IntoResponse, AppError> {
    // Validate required fields
    if req.username.trim().is_empty() {
        return Err(AppError::ValidationError("Username is required".to_string()));
    }
    if req.email.trim().is_empty() {
        return Err(AppError::ValidationError("Email is required".to_string()));
    }
    if req.password.is_empty() {
        return Err(AppError::ValidationError("Password is required".to_string()));
    }
    if req.password.len() < 8 {
        return Err(AppError::ValidationError("Password must be at least 8 characters".to_string()));
    }

    let username = req.username.trim();
    let email = req.email.trim().to_lowercase();

    // Check if username already exists
    let username_exists = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM users WHERE username = $1)"
    )
    .bind(username)
    .fetch_one(&state.db)
    .await
    .map_err(AppError::from)?;

    if username_exists {
        return Err(AppError::BadRequest("Username already taken".to_string()));
    }

    // Check if email already exists
    let email_exists = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM users WHERE email = $1)"
    )
    .bind(&email)
    .fetch_one(&state.db)
    .await
    .map_err(AppError::from)?;

    if email_exists {
        return Err(AppError::BadRequest("Email already registered".to_string()));
    }

    // Hash password
    let password_hash = utils::hash_password(&req.password)?;

    // Insert user
    let full_name = req.full_name.as_deref().unwrap_or("").trim();
    let full_name_db = if full_name.is_empty() { None } else { Some(full_name) };

    let row = sqlx::query(
        "INSERT INTO users (username, email, password_hash, full_name) VALUES ($1, $2, $3, $4) RETURNING id, username, email, full_name, created_at, updated_at"
    )
    .bind(username)
    .bind(&email)
    .bind(&password_hash)
    .bind(full_name_db)
    .fetch_one(&state.db)
    .await
    .map_err(AppError::from)?;

    let user_id: i32 = row.get("id");

    // —— 建 personal team（owner=self），事务内（避免第二个 INSERT 失败留 orphan team）——
    let mut tx = state.db.begin().await.map_err(AppError::from)?;
    let team_row = sqlx::query(
        "INSERT INTO teams (name, created_by) VALUES ($1, $2) RETURNING id",
    )
    .bind(format!("{}'s team", username))
    .bind(user_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(AppError::from)?;
    let team_id: i32 = team_row.get("id");
    sqlx::query(
        "INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'owner')",
    )
    .bind(team_id)
    .bind(user_id)
    .execute(&mut *tx)
    .await
    .map_err(AppError::from)?;
    tx.commit().await.map_err(AppError::from)?;

    // Build UserResponse from the row
    let user_response = UserResponse {
        id: row.get("id"),
        username: row.get("username"),
        email: row.get("email"),
        full_name: row.get("full_name"),
        created_at: row.get("created_at"),
    };

    let auth_response = generate_and_persist_tokens(&state, user_id, username, user_response).await?;

    Ok((StatusCode::CREATED, Json(auth_response)))
}

/// POST /auth/login
///
/// Validates credentials, generates access and refresh tokens,
/// stores refresh token hash, and returns AuthResponse with user data.
async fn login(
    State(state): State<AppState>,
    Json(req): Json<LoginRequest>,
) -> Result<impl IntoResponse, AppError> {
    // Validate input
    if req.username.trim().is_empty() || req.password.is_empty() {
        return Err(AppError::ValidationError("Username and password are required".to_string()));
    }

    let username = req.username.trim();

    // Look up user
    let row = sqlx::query(
        "SELECT id, username, email, password_hash, full_name, created_at, updated_at FROM users WHERE username = $1"
    )
    .bind(username)
    .fetch_optional(&state.db)
    .await
    .map_err(AppError::from)?
    .ok_or_else(|| AppError::AuthInvalid("Invalid username or password".to_string()))?;

    let password_hash: String = row.get("password_hash");

    // Verify password
    let valid = utils::verify_password(&req.password, &password_hash)?;
    if !valid {
        return Err(AppError::AuthInvalid("Invalid username or password".to_string()));
    }

    let user_id: i32 = row.get("id");

    let user_response = UserResponse {
        id: row.get("id"),
        username: row.get("username"),
        email: row.get("email"),
        full_name: row.get("full_name"),
        created_at: row.get("created_at"),
    };

    let auth_response = generate_and_persist_tokens(&state, user_id, username, user_response).await?;

    Ok(Json(auth_response))
}

/// POST /auth/logout
///
/// Revokes the refresh token by marking it as revoked in the database.
/// If the token is invalid or already revoked, the request still succeeds
/// (idempotent logout).
async fn logout(
    State(state): State<AppState>,
    Json(req): Json<RefreshTokenRequest>,
) -> Result<impl IntoResponse, AppError> {
    // Hash the refresh token to look it up in the database
    let token_hash = utils::hash_refresh_token(&req.refresh_token);

    // Revoke the token (mark revoked_at). If token doesn't exist, silently succeed.
    let result = sqlx::query(
        "UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = $1 AND revoked_at IS NULL"
    )
    .bind(&token_hash)
    .execute(&state.db)
    .await;

    // Silently succeed even if the token doesn't exist (already revoked or invalid)
    if let Err(e) = result {
        tracing::warn!("Failed to revoke refresh token: {}", e);
    }

    Ok(Json(serde_json::json!({"message": "Logged out successfully"})))
}

/// POST /auth/refresh
///
/// Verifies the refresh token (JWT signature + database check), revokes the old
/// token, generates new access and refresh tokens, stores the new refresh token
/// hash, and returns a fresh AuthResponse.
/// All mutations run inside a single database transaction so that a crash
/// between revocation and new-token insertion does not leave the user with
/// no valid refresh token.
async fn refresh(
    State(state): State<AppState>,
    Json(req): Json<RefreshTokenRequest>,
) -> Result<impl IntoResponse, AppError> {
    // Step 1: Verify the JWT signature of the refresh token
    let secret = state.config.jwt_secret();
    let (user_id, _jti) = utils::verify_refresh_token(&req.refresh_token, secret)?;

    // Step 2: Check if the token exists in the database and is not revoked/expired
    let token_hash = utils::hash_refresh_token(&req.refresh_token);

    let db_row = sqlx::query(
        "SELECT revoked_at, expires_at FROM refresh_tokens WHERE token_hash = $1"
    )
    .bind(&token_hash)
    .fetch_optional(&state.db)
    .await
    .map_err(AppError::from)?
    .ok_or_else(|| AppError::AuthInvalid("Refresh token not found".to_string()))?;

    let revoked_at: Option<chrono::DateTime<chrono::Utc>> = db_row.get("revoked_at");
    if revoked_at.is_some() {
        return Err(AppError::AuthInvalid("Refresh token has been revoked".to_string()));
    }

    let expires_at: chrono::DateTime<chrono::Utc> = db_row.get("expires_at");
    if chrono::Utc::now() > expires_at {
        return Err(AppError::AuthExpired);
    }

    // Step 3: Look up user
    let user_row = sqlx::query(
        "SELECT id, username, email, full_name, created_at, updated_at FROM users WHERE id = $1"
    )
    .bind(user_id)
    .fetch_optional(&state.db)
    .await
    .map_err(AppError::from)?
    .ok_or_else(|| AppError::ResourceNotFound("User not found".to_string()))?;

    let username: String = user_row.get("username");
    let user_response = UserResponse {
        id: user_row.get("id"),
        username: username.clone(),
        email: user_row.get("email"),
        full_name: user_row.get("full_name"),
        created_at: user_row.get("created_at"),
    };

    // Step 4: Inside a transaction, revoke the old token and insert the new one
    let mut tx = state.db.begin().await.map_err(AppError::from)?;

    sqlx::query(
        "UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = $1"
    )
    .bind(&token_hash)
    .execute(&mut *tx)
    .await
    .map_err(AppError::from)?;

    let access_ttl_secs = state.config.jwt_access_token_ttl().as_secs();
    let refresh_ttl_secs = state.config.jwt_refresh_token_ttl().as_secs();

    let new_access_token = utils::generate_access_token(
        user_id,
        &username,
        secret,
        ChronoDuration::seconds(access_ttl_secs as i64),
    )?;

    let (new_refresh_token, _new_jti) = utils::generate_refresh_token(
        user_id,
        secret,
        ChronoDuration::seconds(refresh_ttl_secs as i64),
    )?;

    let new_token_hash = utils::hash_refresh_token(&new_refresh_token);
    let new_expires_at = chrono::Utc::now() + ChronoDuration::seconds(refresh_ttl_secs as i64);

    sqlx::query(
        "INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)"
    )
    .bind(user_id)
    .bind(&new_token_hash)
    .bind(new_expires_at)
    .execute(&mut *tx)
    .await
    .map_err(AppError::from)?;

    tx.commit().await.map_err(AppError::from)?;

    Ok(Json(AuthResponse {
        access_token: new_access_token,
        refresh_token: new_refresh_token,
        expires_in: access_ttl_secs,
        user: user_response,
    }))
}
