//! LLM 二次精排：给 query + N 候选（title+代表文本），让 LLM 输出按相关性排序的 page_id + 0-10 分。
//! 失败/超时 → 调用方 fallback RRF，不阻断搜索。

use std::collections::HashSet;
use crate::AppError;
use crate::services::llm_stream::{StreamChatProvider, ChatMessage, ChatOpts};

pub struct RerankCandidate {
    pub page_id: String,
    pub title: String,
    pub text: String,
}

pub struct RerankedPage {
    pub page_id: String,
    pub score: f64,
}

/// 解析 LLM rerank 响应：每行 `<page_id> <score>` 或 `1. page_id`。
/// 只保留 valid_ids 内的 page_id；按 score 降序；失败 → 空 Vec（触发 fallback）。
pub fn parse_rerank_response(raw: &str, valid_ids: &HashSet<String>) -> Vec<RerankedPage> {
    let mut out: Vec<RerankedPage> = Vec::new();
    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let body = line.trim_start_matches(|c: char| c.is_ascii_digit() || c == '.' || c == '-' || c == '*' || c == ' ');
        let mut parts = body.split_whitespace();
        let pid = match parts.next() {
            Some(p) => p.trim_matches(|c: char| c == '(' || c == ')' || c == ','),
            None => continue,
        };
        if !valid_ids.contains(pid) {
            continue;
        }
        let score = parts.next()
            .and_then(|s| s.trim_matches(|c: char| c == '(' || c == ')').parse::<f64>().ok())
            .unwrap_or(0.0);
        out.push(RerankedPage { page_id: pid.to_string(), score });
    }
    out.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    out.dedup_by(|a, b| a.page_id == b.page_id);
    out
}

pub async fn rerank_pages(
    provider: &dyn StreamChatProvider,
    query: &str,
    candidates: Vec<RerankCandidate>,
) -> Result<Vec<RerankedPage>, AppError> {
    if candidates.is_empty() {
        return Ok(Vec::new());
    }
    let valid: HashSet<String> = candidates.iter().map(|c| c.page_id.clone()).collect();
    let mut prompt = format!(
        "你是检索重排器。按与查询的相关性给下列每个候选页打 0-10 分，输出每行 `<page_id> <score>`，不要其它内容。\n查询：{}\n候选：\n",
        query.trim()
    );
    for c in &candidates {
        let head: String = c.text.chars().take(300).collect();
        prompt.push_str(&format!("{}\t{}\t{}\n", c.page_id, c.title, head));
    }
    let msgs = vec![ChatMessage { role: "user".to_string(), content: prompt }];
    let opts = ChatOpts {
        model: provider.model_name().to_string(),
        temperature: 0.0,
        max_tokens: 1024,
        system_prompt: None,
        timeout_secs: Some(60),
    };
    let (raw, _usage) = provider.chat_to_string(msgs, opts).await
        .map_err(|e| AppError::LlmApiError(format!("rerank llm: {}", e)))?;
    let parsed = parse_rerank_response(&raw, &valid);
    if parsed.is_empty() {
        return Err(AppError::LlmApiError("rerank produced no valid ids".into()));
    }
    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_lines_with_scores() {
        let mut ids = HashSet::new();
        ids.insert("a.md".to_string());
        ids.insert("b.md".to_string());
        ids.insert("c.md".to_string());
        let out = parse_rerank_response("b.md 9.5\na.md 8.0\nc.md 2.0", &ids);
        assert_eq!(out.len(), 3);
        assert_eq!(out[0].page_id, "b.md");
        assert!(out[0].score > out[1].score);
    }

    #[test]
    fn parse_filters_unknown_ids() {
        let mut ids = HashSet::new();
        ids.insert("a.md".to_string());
        let out = parse_rerank_response("a.md 9\nunknown.md 5\nx 3", &ids);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].page_id, "a.md");
    }

    #[test]
    fn parse_empty_or_garbage_returns_empty() {
        let ids = HashSet::<String>::new();
        assert!(parse_rerank_response("", &ids).is_empty());
        assert!(parse_rerank_response("no parseable lines here", &ids).is_empty());
    }

    #[test]
    fn parse_ranked_numbered_format() {
        let mut ids = HashSet::new();
        ids.insert("x.md".to_string());
        ids.insert("y.md".to_string());
        let out = parse_rerank_response("1. x.md\n2. y.md", &ids);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].page_id, "x.md");
    }
}
