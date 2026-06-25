use crate::AppError;
use crate::config::EmbeddingConfig;
use crate::services::vector_store::VectorStore;

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
    store: &dyn VectorStore,
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
    let page_vecs: Vec<(String, Vec<f32>)> = pages.iter().zip(vectors.into_iter())
        .map(|((path, _), vec)| (path.clone(), vec))
        .collect();
    store.upsert_vectors(project_id, &page_vecs).await
}

/// 单页嵌入（pages CRUD create/update 用，content 非空时）。
pub async fn embed_page(
    store: &dyn VectorStore,
    cfg: Option<&EmbeddingConfig>,
    client: &reqwest::Client,
    project_id: i32,
    path: &str,
    text: &str,
) -> Result<(), AppError> {
    embed_and_store(store, cfg, client, project_id, &[(path.to_string(), text.to_string())])
        .await
        .map(|_| ())
}

/// 单条文本嵌入（hybrid_search 查询侧用）。返回 dim 维向量。
pub async fn embed_query(
    cfg: &EmbeddingConfig,
    client: &reqwest::Client,
    text: &str,
) -> Result<Vec<f32>, AppError> {
    let mut vecs = embed_batch(cfg, client, &[text.to_string()]).await?;
    vecs.pop().ok_or_else(|| AppError::LlmApiError("embed_query: empty response".into()))
}

/// 删页向量。不接收 cfg——纯幂等 SQL DELETE，与 embedding 配置无关、始终生效。
pub async fn delete_embedding(
    store: &dyn VectorStore,
    project_id: i32,
    path: &str,
) -> Result<(), AppError> {
    store.delete_page(project_id, path).await
}

#[derive(serde::Serialize, sqlx::FromRow)]
pub struct VectorSearchResult {
    pub path: String,
    pub title: String,
    pub snippet: String,
    pub score: f64,
}

/// 向量相似度搜索（委托 VectorStore::search，Phase 2 起 chunk 级聚合在实现侧）
pub async fn vector_search(
    store: &dyn VectorStore,
    project_id: i32,
    query_embedding: Vec<f32>,
    limit: i32,
) -> Result<Vec<VectorSearchResult>, AppError> {
    store.search(project_id, query_embedding, limit).await
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
