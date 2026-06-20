use sqlx::PgPool;
use crate::AppError;
use crate::config::EmbeddingConfig;
use crate::services::llm::LlmConfig;

/// 解析 omlx /v1/embeddings 响应。纯函数，便于单测。
/// 校验每条维度 == expected_dim，不符报错（防模型/配置错配）。
fn parse_embedding_response(body: &serde_json::Value, expected_dim: usize) -> Result<Vec<Vec<f32>>, AppError> {
    let data = body["data"].as_array()
        .ok_or_else(|| AppError::LlmApiError("embedding response missing 'data' array".into()))?;
    let mut out = Vec::with_capacity(data.len());
    for item in data {
        let emb = item["embedding"].as_array()
            .ok_or_else(|| AppError::LlmApiError("embedding item missing 'embedding'".into()))?;
        if emb.len() != expected_dim {
            return Err(AppError::LlmApiError(format!(
                "embedding dim {} != configured {}", emb.len(), expected_dim
            )));
        }
        out.push(emb.iter().map(|v| v.as_f64().unwrap_or(0.0) as f32).collect());
    }
    Ok(out)
}

/// 批量嵌入：一次 HTTP 调 {base_url}/embeddings（bge-m3 支持多文本）。
pub async fn embed_batch(
    cfg: &EmbeddingConfig,
    client: &reqwest::Client,
    texts: &[String],
) -> Result<Vec<Vec<f32>>, AppError> {
    let resp = client
        .post(format!("{}/embeddings", cfg.base_url.trim_end_matches('/')))
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({ "model": cfg.model, "input": texts }))
        .timeout(std::time::Duration::from_secs(cfg.timeout_secs))
        .send()
        .await
        .map_err(|e| AppError::LlmApiError(format!("embed request: {}", e)))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(AppError::LlmApiError(format!("embed HTTP {}: {}", status, body)));
    }
    let body: serde_json::Value = resp.json().await
        .map_err(|e| AppError::LlmApiError(format!("embed body parse: {}", e)))?;
    parse_embedding_response(&body, cfg.dim)
}

/// 批量嵌入 + bulk upsert（ingest 用）。pages: (wiki_page_path, text)。
/// cfg=None → no-op 返回 Ok(0)。
pub async fn embed_and_store(
    pool: &sqlx::PgPool,
    cfg: Option<&EmbeddingConfig>,
    client: &reqwest::Client,
    project_id: i32,
    pages: &[(String, String)],
) -> Result<usize, AppError> {
    let cfg = match cfg {
        Some(c) => c,
        None => return Ok(0),
    };
    if pages.is_empty() {
        return Ok(0);
    }
    let texts: Vec<String> = pages.iter().map(|(_, t)| t.clone()).collect();
    let vectors = embed_batch(cfg, client, &texts).await?;

    let mut qb = sqlx::QueryBuilder::new(
        "INSERT INTO embeddings (project_id, wiki_page_id, content) VALUES ",
    );
    for (i, ((path, _), vec)) in pages.iter().zip(vectors.iter()).enumerate() {
        if i > 0 {
            qb.push(",");
        }
        qb.push("(")
            .push_bind(project_id)
            .push(", ")
            .push_bind(path.clone())
            .push(", ")
            .push_bind(pgvector::Vector::from(vec.clone()))
            .push(")");
    }
    qb.push(" ON CONFLICT (project_id, wiki_page_id) DO UPDATE SET content = EXCLUDED.content");

    let rows = qb.build().execute(pool).await?.rows_affected();
    Ok(rows as usize)
}

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

#[cfg(test)]
mod tests {
    use super::parse_embedding_response;
    use serde_json::json;

    #[test]
    fn parse_valid_response() {
        let body = json!({
            "data": [
                { "embedding": [0.1, 0.2, 0.3] },
                { "embedding": [0.4, 0.5, 0.6] },
            ]
        });
        let out = parse_embedding_response(&body, 3).unwrap();
        assert_eq!(out.len(), 2);
        assert_eq!(out[0], vec![0.1, 0.2, 0.3]);
    }

    #[test]
    fn parse_wrong_dim_errors() {
        let body = json!({ "data": [{ "embedding": [0.1, 0.2] }] });
        let err = parse_embedding_response(&body, 3).unwrap_err();
        assert!(err.to_string().contains("dim"));
    }

    #[test]
    fn parse_missing_data_errors() {
        let body = json!({});
        assert!(parse_embedding_response(&body, 3).is_err());
    }
}
