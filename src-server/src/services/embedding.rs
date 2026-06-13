use sqlx::PgPool;
use crate::AppError;
use crate::services::search::SearchResult;
use crate::services::llm::LlmConfig;

/// Get embeddings for a query string (stub — Phase 8)
pub async fn get_embeddings(
    _query: &str,
    _config: &LlmConfig,
) -> Result<Vec<f32>, AppError> {
    Err(AppError::BadRequest(
        "Vector search is not yet implemented".into(),
    ))
}

/// Vector similarity search (stub — Phase 8)
pub async fn vector_search(
    _pool: &PgPool,
    _project_id: i32,
    _embedding: Vec<f32>,
    _limit: i32,
) -> Result<Vec<SearchResult>, AppError> {
    Err(AppError::BadRequest(
        "Vector search is not yet implemented".into(),
    ))
}
