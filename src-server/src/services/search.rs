use std::collections::{BTreeSet, HashMap, HashSet};
use serde::Serialize;
use sqlx::PgPool;
use crate::{AppError, config::EmbeddingConfig};
use crate::services::embedding;

// ── 常量（桌面原值，照搬）──
pub const DEFAULT_RESULTS: usize = 20;
pub const MAX_RESULTS: usize = 50;
pub const RRF_K: f64 = 60.0;
const FILENAME_EXACT_BONUS: f64 = 200.0;
const PHRASE_IN_TITLE_BONUS: f64 = 50.0;
const PHRASE_IN_CONTENT_PER_OCC: f64 = 20.0;
const MAX_PHRASE_OCC_COUNTED: usize = 10;
const TITLE_TOKEN_WEIGHT: f64 = 5.0;
const CONTENT_TOKEN_WEIGHT: f64 = 1.0;
const SNIPPET_CONTEXT: usize = 80;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageRef {
    pub url: String,
    pub alt: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub path: String,
    pub title: String,
    pub snippet: String,
    pub title_match: bool,
    pub score: f64,
    pub vector_score: Option<f64>,
    pub images: Vec<ImageRef>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResponse {
    pub mode: String,
    pub results: Vec<SearchResult>,
    pub token_hits: usize,
    pub vector_hits: usize,
}

// ── 内部中间类型 ──
struct Candidate {
    path: String,
    title: String,
    content: String,
}

struct ScoredPage {
    path: String,
    title: String,
    snippet: String,
    score: f64,
    title_match: bool,
    images: Vec<ImageRef>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn search_response_serializes_camel_case() {
        let resp = SearchResponse {
            mode: "hybrid".into(),
            results: vec![SearchResult {
                path: "entities/alice.md".into(),
                title: "Alice".into(),
                snippet: "...".into(),
                title_match: true,
                score: 0.03,
                vector_score: Some(0.9),
                images: vec![ImageRef { url: "u".into(), alt: "a".into() }],
            }],
            token_hits: 1,
            vector_hits: 2,
        };
        let json = serde_json::to_string(&resp).unwrap();
        assert!(json.contains("\"titleMatch\""));
        assert!(json.contains("\"vectorScore\""));
        assert!(json.contains("\"tokenHits\""));
        assert!(!json.contains("\"title_match\""));
    }
}
