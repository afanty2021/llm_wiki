use sqlx::PgPool;
use crate::AppError;
use crate::services::llm::LlmConfig;

#[derive(serde::Serialize, sqlx::FromRow)]
pub struct VectorSearchResult {
    pub path: String,
    pub title: String,
    pub snippet: String,
    pub score: f64,
}

/// 使用 pgvector 进行余弦相似度搜索
pub async fn vector_search(
    pool: &PgPool,
    project_id: i32,
    query_embedding: Vec<f32>,
    limit: i32,
) -> Result<Vec<VectorSearchResult>, AppError> {
    let embedding = pgvector::Vector::from(query_embedding);

    let results = sqlx::query_as::<_, VectorSearchResult>(
        "SELECT
            wp.path,
            wp.title,
            COALESCE(substring(COALESCE(wp.content, '') FROM 1 FOR 200), '') as snippet,
            1.0 - (e.content <=> $1) as score
        FROM embeddings e
        JOIN wiki_pages wp ON e.wiki_page_id = wp.path AND e.project_id = wp.project_id
        WHERE e.project_id = $2
        ORDER BY e.content <=> $1
        LIMIT $3"
    )
    .bind(embedding)
    .bind(project_id)
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(|e| AppError::DatabaseError(e))?;

    Ok(results)
}

/// 获取文本的向量嵌入
/// 使用解密后的 LlmConfig（不是 env var!）
pub async fn get_embeddings(
    text: &str,
    llm: &LlmConfig,
) -> Result<Vec<f32>, AppError> {
    let base_url = llm.base_url.as_deref().unwrap_or("https://api.openai.com/v1");
    let client = reqwest::Client::new();

    let response = client
        .post(format!("{}/embeddings", base_url))
        .header("Authorization", format!("Bearer {}", llm.api_key))
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({
            "model": "text-embedding-ada-002",
            "input": text,
        }))
        .send()
        .await?;  // 使用 From<reqwest::Error> 自动转换

    let body: serde_json::Value = response.json().await?;

    let embedding = body["data"][0]["embedding"]
        .as_array()
        .ok_or_else(|| AppError::LlmApiError("Invalid embedding response".into()))?
        .iter()
        .map(|v| v.as_f64().unwrap_or(0.0) as f32)
        .collect();

    Ok(embedding)
}
