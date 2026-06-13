// Error types will be implemented in Task 1.3

use thiserror::Error;

#[derive(Error, Debug)]
pub enum AppError {
    #[error("Database error: {0}")]
    Database(#[from] sqlx::Error),

    #[error("Redis error: {0}")]
    Redis(#[from] redis::RedisError),

    #[error("Authentication error: {0}")]
    Auth(String),

    #[error("Not found: {0}")]
    NotFound(String),
}

pub trait IntoAppError<T> {
    fn into_app_error(self) -> Result<T, AppError>;
}

impl<T, E: Into<AppError>> IntoAppError<T> for Result<T, E> {
    fn into_app_error(self) -> Result<T, AppError> {
        self.map_err(Into::into)
    }
}
