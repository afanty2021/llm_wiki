use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;
use thiserror::Error;

pub const ERR_AUTH_INVALID: &str = "AUTH_INVALID";
pub const ERR_AUTH_EXPIRED: &str = "AUTH_EXPIRED";
pub const ERR_PERMISSION_DENIED: &str = "PERMISSION_DENIED";
pub const ERR_RESOURCE_NOT_FOUND: &str = "RESOURCE_NOT_FOUND";
pub const ERR_VALIDATION_FAILED: &str = "VALIDATION_FAILED";
pub const ERR_DATABASE_ERROR: &str = "DATABASE_ERROR";
pub const ERR_FILE_UPLOAD_FAILED: &str = "FILE_UPLOAD_FAILED";
pub const ERR_LLM_API_ERROR: &str = "LLM_API_ERROR";
pub const ERR_INTERNAL_ERROR: &str = "INTERNAL_ERROR";

#[derive(Error, Debug)]
pub enum AppError {
    #[error("Authentication failed: {0}")]
    AuthInvalid(String),

    #[error("Authentication expired")]
    AuthExpired,

    #[error("Bad request: {0}")]
    BadRequest(String),

    #[error("Permission denied")]
    PermissionDenied,

    #[error("Resource not found: {0}")]
    ResourceNotFound(String),

    #[error("Validation failed: {0}")]
    ValidationError(String),

    #[error("Database error: {0}")]
    DatabaseError(#[from] sqlx::Error),

    #[error("Redis error: {0}")]
    RedisError(#[from] deadpool_redis::PoolError),

    #[error("IO error: {0}")]
    IoError(#[from] std::io::Error),

    #[error("JWT error: {0}")]
    JwtError(#[from] jsonwebtoken::errors::Error),

    #[error("Encryption error: {0}")]
    EncryptionError(String),

    #[error("Internal error: {0}")]
    InternalError(String),

    #[error("File upload failed")]
    FileUploadFailed,

    #[error("LLM API error: {0}")]
    LlmApiError(String),
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, code, message) = match &self {
            AppError::AuthInvalid(msg) => (
                StatusCode::UNAUTHORIZED,
                ERR_AUTH_INVALID,
                msg.clone(),
            ),
            AppError::AuthExpired => (
                StatusCode::UNAUTHORIZED,
                ERR_AUTH_EXPIRED,
                "Authentication expired".to_string(),
            ),
            AppError::PermissionDenied => (
                StatusCode::FORBIDDEN,
                ERR_PERMISSION_DENIED,
                "Permission denied".to_string(),
            ),
            AppError::ResourceNotFound(msg) => (
                StatusCode::NOT_FOUND,
                ERR_RESOURCE_NOT_FOUND,
                msg.clone(),
            ),
            AppError::BadRequest(msg) => (
                StatusCode::BAD_REQUEST,
                ERR_VALIDATION_FAILED,
                msg.clone(),
            ),
            AppError::ValidationError(msg) => (
                StatusCode::BAD_REQUEST,
                ERR_VALIDATION_FAILED,
                msg.clone(),
            ),
            AppError::DatabaseError(_) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                ERR_DATABASE_ERROR,
                "Database error".to_string(),
            ),
            AppError::RedisError(_) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                ERR_DATABASE_ERROR,
                "Cache error".to_string(),
            ),
            AppError::JwtError(_) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                ERR_INTERNAL_ERROR,
                "Token processing error".to_string(),
            ),
            AppError::EncryptionError(msg) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                ERR_INTERNAL_ERROR,
                msg.clone(),
            ),
            AppError::IoError(_) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                ERR_INTERNAL_ERROR,
                "IO error".to_string(),
            ),
            AppError::InternalError(msg) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                ERR_INTERNAL_ERROR,
                msg.clone(),
            ),
            AppError::FileUploadFailed => (
                StatusCode::INTERNAL_SERVER_ERROR,
                ERR_FILE_UPLOAD_FAILED,
                "File upload failed".to_string(),
            ),
            AppError::LlmApiError(msg) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                ERR_LLM_API_ERROR,
                msg.clone(),
            ),
        };

        let body = Json(json!({
            "error": {
                "code": code,
                "message": message,
            }
        }));

        (status, body).into_response()
    }
}

// ParseIntError 转换（用于 claims.sub.parse::<i32>()）
impl From<std::num::ParseIntError> for AppError {
    fn from(err: std::num::ParseIntError) -> Self {
        AppError::AuthInvalid(format!("Invalid user ID: {}", err))
    }
}

// reqwest 错误转换（LLM API 调用 + embedding API 调用）
impl From<reqwest::Error> for AppError {
    fn from(err: reqwest::Error) -> Self {
        AppError::LlmApiError(format!("HTTP request failed: {}", err))
    }
}

impl From<reqwest::header::ToStrError> for AppError {
    fn from(err: reqwest::header::ToStrError) -> Self {
        AppError::InternalError(format!("Header conversion error: {}", err))
    }
}

// anyhow::Error 转换（用于 utils 函数的 anyhow::Result）
impl From<anyhow::Error> for AppError {
    fn from(err: anyhow::Error) -> Self {
        AppError::InternalError(err.to_string())
    }
}

pub trait IntoAppError<T> {
    fn into_app_error(self) -> Result<T, AppError>;
}

impl<T, E> IntoAppError<T> for Result<T, E>
where
    E: Into<AppError>,
{
    fn into_app_error(self) -> Result<T, AppError> {
        self.map_err(|e| e.into())
    }
}
