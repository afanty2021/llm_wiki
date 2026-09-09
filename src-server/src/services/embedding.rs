use crate::AppError;
use crate::config::EmbeddingConfig;
use crate::services::chunking::chunk_for_embedding;
use crate::services::vector_store::{ChunkHit, PageChunk, VectorStore};

/// 解析 omlx /v1/embeddings 响应。纯函数，便于单测。
/// 校验：向量数 == expected_count（防部分响应致下游越界 panic）、每条维度 == expected_dim。
fn parse_embedding_response(body: &serde_json::Value, expected_dim: usize, expected_count: usize) -> Result<Vec<Vec<f32>>, AppError> {
    let data = body["data"].as_array()
        .ok_or_else(|| AppError::LlmApiError("embedding response missing 'data' array".into()))?;
    if data.len() != expected_count {
        return Err(AppError::LlmApiError(format!(
            "embed returned {} vectors, expected {}", data.len(), expected_count
        )));
    }
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
        let mut req = client
            .post(format!("{}/embeddings", cfg.base_url.trim_end_matches('/')))
            .header("Content-Type", "application/json")
            .json(&serde_json::json!({ "model": cfg.model, "input": texts }))
            .timeout(std::time::Duration::from_secs(cfg.timeout_secs));
        // omlx 2026-08-26 起强制 Bearer 鉴权（无钥 401）；无鉴权端点不带头照旧兼容
        if let Some(key) = cfg.api_key.as_deref().filter(|k| !k.is_empty()) {
            req = req.bearer_auth(key);
        }
        let res = req.send().await;
        match res {
            Ok(resp) if resp.status().is_success() => {
                // 200 但 body 解析失败/向量数不足/维度错 = 瞬态（proxy 截断/部分响应），纳入重试
                let body_res: Result<serde_json::Value, AppError> = resp.json().await
                    .map_err(|e| AppError::LlmApiError(format!("embed body parse: {}", e)));
                let parsed = match body_res {
                    Ok(b) => parse_embedding_response(&b, cfg.dim, texts.len()),
                    Err(e) => Err(e),
                };
                match parsed {
                    Ok(vecs) => return Ok(vecs),
                    Err(e) if attempt < max_retries => {
                        tracing::warn!("embed success-branch err (attempt {}): {}, retrying", attempt, e);
                        last_err = Some(e);
                    }
                    Err(e) => return Err(e),
                }
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

/// 单请求批量上限（P1 评审②，2026-09-09）：整 job 拍平单请求曾把 ~6700 chunk 塞进
/// 一次 HTTP（响应 ~700 万浮点），解码失败即整 job 无向量且无隔离——一颗坏 chunk
/// 连坐全批（Unlock 批 611 页沉淀 + 170 批同款实证）。页保持原子（同页 chunk 不跨请求），
/// 页数/chunk 数双帽；单页超帽独占一组。
const EMBED_REQ_MAX_PAGES: usize = 16;
const EMBED_REQ_MAX_CHUNKS: usize = 96;

/// 嵌入结果：stored=成功 upsert 的页数；failures=逐页回落仍失败的页
/// （毒性页隔离，不拖垮其余；DB upsert 错误仍走 Result::Err=系统性故障）。
#[derive(Debug, Default)]
pub struct EmbedOutcome {
    pub stored: usize,
    pub failures: Vec<(String, String)>,
}

/// 按页原子分组（纯函数，单测钉边界）：累计 chunk ≤ max_chunks 且页数 ≤ max_pages；
/// 单页超 max_chunks 独占一组。零 chunk 页（空白内容）不占 chunk 预算、随组走
/// （upsert=清空语义，行为与旧实现一致）。
fn group_pages_for_embed(chunk_counts: &[usize], max_pages: usize, max_chunks: usize) -> Vec<Vec<usize>> {
    let mut groups: Vec<Vec<usize>> = Vec::new();
    let mut cur: Vec<usize> = Vec::new();
    let mut cur_chunks = 0usize;
    for (i, &c) in chunk_counts.iter().enumerate() {
        let alone = c > max_chunks;
        if !cur.is_empty() && (alone || cur.len() >= max_pages || cur_chunks + c > max_chunks) {
            groups.push(std::mem::take(&mut cur));
            cur_chunks = 0;
        }
        cur.push(i);
        cur_chunks += c;
        if alone {
            groups.push(std::mem::take(&mut cur));
            cur_chunks = 0;
        }
    }
    if !cur.is_empty() {
        groups.push(cur);
    }
    groups
}

/// 批量嵌入 + chunk 级 upsert（ingest 用）。pages: (wiki_page_path, text)。
/// cfg=None 或空 pages → no-op。分批嵌入（EMBED_REQ_MAX_PAGES/CHUNKS 双帽），
/// 批失败回落逐页嵌入（毒性页隔离进 failures，不拖垮其余批次）；
/// 逐页 upsert_page_chunks（DELETE+INSERT）。
pub async fn embed_and_store(
    store: &dyn VectorStore,
    cfg: Option<&EmbeddingConfig>,
    client: &reqwest::Client,
    project_id: i32,
    pages: &[(String, String)],
) -> Result<EmbedOutcome, AppError> {
    let mut outcome = EmbedOutcome::default();
    let cfg = match cfg {
        Some(c) => c,
        None => return Ok(outcome),
    };
    if pages.is_empty() {
        return Ok(outcome);
    }
    // 1. 每页先行 chunk（页原子），按 chunk 数分组
    let page_pieces: Vec<Vec<String>> = pages
        .iter()
        .map(|(_, text)| chunk_for_embedding(text, cfg.chunk_size, cfg.overlap))
        .collect();
    let chunk_counts: Vec<usize> = page_pieces.iter().map(|p| p.len()).collect();
    // 2. 分批：批内一次 embed_batch → 逐页切回 upsert；批失败 → 逐页回落
    for group in group_pages_for_embed(&chunk_counts, EMBED_REQ_MAX_PAGES, EMBED_REQ_MAX_CHUNKS) {
        let mut all_texts: Vec<String> = Vec::new();
        let mut spans: Vec<(usize, usize, usize)> = Vec::new(); // (组内页序, start, count)
        for (seq, &pi) in group.iter().enumerate() {
            let start = all_texts.len();
            all_texts.extend(page_pieces[pi].iter().cloned());
            spans.push((seq, start, page_pieces[pi].len()));
        }
        let all_vecs = if all_texts.is_empty() {
            Ok(Vec::new())
        } else {
            embed_batch(cfg, client, &all_texts).await
        };
        let all_vecs = match all_vecs {
            Ok(v) => v,
            Err(batch_err) => {
                tracing::warn!(
                    "embed batch ({} pages, {} chunks) failed: {} — falling back to per-page isolation",
                    group.len(), all_texts.len(), batch_err
                );
                for &pi in &group {
                    match embed_page_pieces(store, cfg, client, project_id, &pages[pi].0, &page_pieces[pi]).await {
                        Ok(()) => outcome.stored += 1,
                        Err(e) => outcome.failures.push((pages[pi].0.clone(), e.to_string())),
                    }
                }
                continue;
            }
        };
        for (seq, start, count) in spans {
            let path = &pages[group[seq]].0;
            let chunks: Vec<PageChunk> = (0..count)
                .map(|i| PageChunk {
                    chunk_index: i as i32,
                    chunk_text: all_texts[start + i].clone(),
                    heading_path: None, // Phase 2 不做 markdown heading 抽取；列已建，留 NULL
                    vector: all_vecs[start + i].clone(),
                })
                .collect();
            store.upsert_page_chunks(project_id, path, chunks).await?;
            outcome.stored += 1;
        }
    }
    Ok(outcome)
}

/// 单页嵌入（已有 chunk 切片，批失败回落用——不重切）：embed + upsert。
async fn embed_page_pieces(
    store: &dyn VectorStore,
    cfg: &EmbeddingConfig,
    client: &reqwest::Client,
    project_id: i32,
    path: &str,
    pieces: &[String],
) -> Result<(), AppError> {
    let all_vecs = if pieces.is_empty() {
        Vec::new()
    } else {
        embed_batch(cfg, client, pieces).await?
    };
    let chunks: Vec<PageChunk> = pieces
        .iter()
        .enumerate()
        .map(|(i, text)| PageChunk {
            chunk_index: i as i32,
            chunk_text: text.clone(),
            heading_path: None,
            vector: all_vecs[i].clone(),
        })
        .collect();
    store.upsert_page_chunks(project_id, path, chunks).await
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
    let outcome = embed_and_store(store, cfg, client, project_id, &[(path.to_string(), text.to_string())])
        .await?;
    match outcome.failures.into_iter().next() {
        Some((p, e)) => Err(AppError::LlmApiError(format!("embed page {} failed: {}", p, e))),
        None => Ok(()),
    }
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
    pub rerank_text: String,
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
        rerank_text: h.rerank_text,
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
        let out = parse_embedding_response(&body, 3, 2).unwrap();
        assert_eq!(out.len(), 2);
        assert_eq!(out[0], vec![0.1, 0.2, 0.3]);
    }

    #[test]
    fn parse_wrong_dim_errors() {
        let body = json!({ "data": [{ "embedding": [0.1, 0.2] }] });
        let err = parse_embedding_response(&body, 3, 1).unwrap_err();
        assert!(err.to_string().contains("dim"));
    }

    #[test]
    fn parse_missing_data_errors() {
        let body = json!({});
        assert!(parse_embedding_response(&body, 3, 1).is_err());
    }

    #[test]
    fn parse_count_mismatch_errors() {
        // P1 防回归：向量数 != 输入数（部分响应）→ 报错而非让下游越界 panic
        let body = json!({ "data": [{ "embedding": [0.1, 0.2, 0.3] }] }); // 1 条
        let err = parse_embedding_response(&body, 3, 2).unwrap_err(); // 期望 2 条
        assert!(err.to_string().contains("expected 2"), "got {}", err);
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

    use super::group_pages_for_embed;

    #[test]
    fn group_empty_input() {
        assert!(group_pages_for_embed(&[], 16, 96).is_empty());
    }

    #[test]
    fn group_accumulates_within_caps() {
        // 5 页 × 2 chunk 远低于双帽 → 一组
        assert_eq!(group_pages_for_embed(&[2, 2, 2, 2, 2], 16, 96), vec![vec![0, 1, 2, 3, 4]]);
    }

    #[test]
    fn group_respects_page_cap() {
        // 20 页 × 1 chunk，页帽 16 → [16 页, 4 页]
        let counts = [1usize; 20];
        let groups = group_pages_for_embed(&counts, 16, 96);
        assert_eq!(groups, vec![vec![0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], vec![16, 17, 18, 19]]);
    }

    #[test]
    fn group_respects_chunk_cap() {
        // 3 页 × 50 chunk，chunk 帽 96：50+50=100 超帽 → 每页一组
        assert_eq!(group_pages_for_embed(&[50, 50, 50], 16, 96), vec![vec![0], vec![1], vec![2]]);
        // 帽 110：50+50=100 ≤110 → [0,1] 一组，页帽 16 未触
        assert_eq!(group_pages_for_embed(&[50, 50, 50], 16, 110), vec![vec![0, 1], vec![2]]);
    }

    #[test]
    fn group_oversized_page_alone() {
        // 单页 150 chunk 超帽 → 独占一组，且不与邻居合并
        assert_eq!(group_pages_for_embed(&[2, 150, 2], 16, 96), vec![vec![0], vec![1], vec![2]]);
    }

    #[test]
    fn group_zero_chunk_pages_ride_along() {
        // 零 chunk 页不占预算，随组走（upsert=清空语义）
        assert_eq!(group_pages_for_embed(&[0, 2, 0, 2], 16, 96), vec![vec![0, 1, 2, 3]]);
    }
}
