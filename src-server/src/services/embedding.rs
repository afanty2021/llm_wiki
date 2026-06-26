use crate::AppError;
use crate::config::EmbeddingConfig;
use crate::services::chunking::chunk_for_embedding;
use crate::services::vector_store::{ChunkHit, PageChunk, VectorStore};

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

/// 指数退避：base 1s × 2^attempt，上限 30s。
pub fn backoff_delay(attempt: u32) -> std::time::Duration {
    let secs = 1u64.checked_shl(attempt).unwrap_or(1u64 << 30).min(30);
    std::time::Duration::from_secs(secs)
}

/// 瞬态错误判定：网络/连接/超时/5xx 视为可重试；非瞬态（4xx 内容违规等）不重试。
pub fn is_transient_embed_err(e: &reqwest::Error) -> bool {
    if e.is_connect() || e.is_timeout() || e.is_request() {
        return true;
    }
    e.status().map(|s| s.is_server_error()).unwrap_or(false)
}

/// 批量嵌入：一次 HTTP 调 {base_url}/embeddings（bge-m3 支持多文本）。
/// 瞬态失败（网络/超时/5xx）按指数退避重试 `max_retries` 次；非瞬态（4xx）直接返回。
pub async fn embed_batch(
    cfg: &EmbeddingConfig,
    client: &reqwest::Client,
    texts: &[String],
) -> Result<Vec<Vec<f32>>, AppError> {
    let max_retries = cfg.max_retries;
    let mut last_err: Option<AppError> = None;
    for attempt in 0..=max_retries {
        let res = client
            .post(format!("{}/embeddings", cfg.base_url.trim_end_matches('/')))
            .header("Content-Type", "application/json")
            .json(&serde_json::json!({ "model": cfg.model, "input": texts }))
            .timeout(std::time::Duration::from_secs(cfg.timeout_secs))
            .send()
            .await;
        match res {
            Ok(resp) if resp.status().is_success() => {
                let body: serde_json::Value = resp.json().await
                    .map_err(|e| AppError::LlmApiError(format!("embed body parse: {}", e)))?;
                return parse_embedding_response(&body, cfg.dim);
            }
            Ok(resp) => {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                let api_err = AppError::LlmApiError(format!("embed HTTP {}: {}", status, body));
                if status.is_server_error() && attempt < max_retries {
                    tracing::warn!("embed HTTP {} (attempt {}), retrying", status, attempt);
                    last_err = Some(api_err);
                } else {
                    return Err(api_err);
                }
            }
            Err(e) => {
                if is_transient_embed_err(&e) && attempt < max_retries {
                    tracing::warn!("embed request err (attempt {}): {}, retrying", attempt, e);
                    last_err = Some(AppError::LlmApiError(format!("embed request: {}", e)));
                } else {
                    return Err(AppError::LlmApiError(format!("embed request: {}", e)));
                }
            }
        }
        if attempt < max_retries {
            tokio::time::sleep(backoff_delay(attempt)).await;
        }
    }
    Err(last_err.unwrap_or_else(|| AppError::LlmApiError("embed retries exhausted".into())))
}

/// 批量嵌入 + chunk 级 upsert（ingest 用）。pages: (wiki_page_path, text)。
/// cfg=None 或空 pages → no-op。**所有 page 的 chunk 拍平到一次 embed_batch 调用**（bge-m3 接受数组），
/// 再按 page 切回逐页 upsert_page_chunks（DELETE+INSERT）。保持「bulk ingest 单 HTTP 请求」语义。
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
    // 1. 切分所有 page → all_texts；记录每 page 的 chunk 范围 (path, start, count)
    let mut all_texts: Vec<String> = Vec::new();
    let mut page_spans: Vec<(String, usize, usize)> = Vec::new();
    for (path, text) in pages {
        let pieces = chunk_for_embedding(text, cfg.chunk_size, cfg.overlap);
        let start = all_texts.len();
        all_texts.extend(pieces);
        page_spans.push((path.clone(), start, all_texts.len() - start));
    }
    // 2. 一次性嵌入全部 chunk（单 HTTP 请求）
    let all_vecs = if all_texts.is_empty() {
        Vec::new()
    } else {
        embed_batch(cfg, client, &all_texts).await?
    };
    // 3. 按 page_span 切回，逐页 upsert_page_chunks（空 chunk → 仅 DELETE，清空该页）
    let mut page_count = 0usize;
    for (path, start, count) in page_spans {
        let chunks: Vec<PageChunk> = (0..count)
            .map(|i| PageChunk {
                chunk_index: i as i32,
                chunk_text: all_texts[start + i].clone(),
                heading_path: None, // Phase 2 不做 markdown heading 抽取；列已建，留 NULL
                vector: all_vecs[start + i].clone(),
            })
            .collect();
        store.upsert_page_chunks(project_id, &path, chunks).await?;
        page_count += 1;
    }
    Ok(page_count)
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

/// 向量检索（hybrid_search 用）：chunk 级检索 + page 聚合，返回 page 级 VectorSearchResult。
/// top_k_chunks 拉宽候选（默认 40），top_n_pages = limit。
pub async fn vector_search(
    store: &dyn VectorStore,
    project_id: i32,
    query_embedding: Vec<f32>,
    limit: i32,
) -> Result<Vec<VectorSearchResult>, AppError> {
    let top_k_chunks = (limit.max(20) as usize) * 4; // 拉宽候选供去重与（T6）rerank
    let top_n_pages = limit.max(1) as usize;
    let hits: Vec<ChunkHit> = store
        .search_chunks(project_id, query_embedding, top_k_chunks, top_n_pages)
        .await?;
    Ok(hits.into_iter().map(|h| VectorSearchResult {
        path: h.page_id,
        title: h.title,
        snippet: h.snippet,
        score: h.score,
    }).collect())
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

    use super::backoff_delay;
    use std::time::Duration;

    #[test]
    fn backoff_delay_grows_exponentially() {
        // base 1s × 2^attempt：attempt 0→1s, 1→2s, 2→4s（上限 30s 防失控）
        assert_eq!(backoff_delay(0), Duration::from_secs(1));
        assert_eq!(backoff_delay(1), Duration::from_secs(2));
        assert_eq!(backoff_delay(2), Duration::from_secs(4));
        assert!(backoff_delay(10) <= Duration::from_secs(30), "上限 30s");
    }
}
