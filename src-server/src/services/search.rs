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

pub fn tokenize_query(query: &str) -> Vec<String> {
    let raw = query
        .to_lowercase()
        .split(is_query_separator)
        .filter(|t| t.chars().count() > 1)
        .filter(|t| !is_stop_word(t))
        .map(String::from)
        .collect::<Vec<_>>();
    let mut out = Vec::new();
    for token in raw {
        let chars: Vec<char> = token.chars().collect();
        // CJK 统一表意 + Ext A，对齐桌面 [一-鿿㐀-䶿]（精确两段，排除卦符号等非汉字区块）
        let has_cjk = chars.iter().any(|c|
            ('\u{4e00}'..='\u{9fff}').contains(c) || ('\u{3400}'..='\u{4dbf}').contains(c)
        );
        if has_cjk && chars.len() > 2 {
            for pair in chars.windows(2) {
                out.push(pair.iter().collect());
            }
            for ch in &chars {
                let s = ch.to_string();
                if !is_stop_word(&s) {
                    out.push(s);
                }
            }
            out.push(token);
        } else {
            out.push(token);
        }
    }
    out.into_iter().collect::<BTreeSet<_>>().into_iter().collect()
}

fn is_query_separator(c: char) -> bool {
    c.is_whitespace()
        || c.is_ascii_punctuation()
        || matches!(
            c,
            '，' | '。' | '！' | '？' | '、' | '；' | '：' | '\u{201c}' | '\u{201d}' | '\u{2018}' | '\u{2019}' | '（' | '）' | '·' | '～' | '…'
        )
}

fn is_stop_word(token: &str) -> bool {
    matches!(
        token,
        "的" | "是" | "了" | "什么" | "在" | "有" | "和" | "与" | "对" | "从"
            | "the" | "is" | "a" | "an" | "what" | "how" | "are" | "was" | "were"
            | "do" | "does" | "did" | "be" | "been" | "being" | "have" | "has" | "had"
            | "it" | "its" | "in" | "on" | "at" | "to" | "for" | "of" | "with" | "by"
            | "this" | "that" | "these" | "those"
    )
}

#[allow(dead_code)]
fn trim_query_punctuation(value: &str) -> String {
    value.trim_matches(is_query_separator).to_string()
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

    #[test]
    fn tokenize_cjk_bigrams_chars_and_full() {
        let tokens = tokenize_query("默会知识");
        // bigram: 默会 会知 知识 ; 单字: 默 会 知 识 ; 全词: 默会知识 → 共 8 个去重
        for expect in ["默会", "会知", "知识", "默", "会", "知", "识", "默会知识"] {
            assert!(tokens.contains(&expect.to_string()), "missing token {expect}: {:?}", tokens);
        }
        assert_eq!(tokens.len(), 8, "expected 8 unique tokens: {:?}", tokens);
    }

    #[test]
    fn tokenize_drops_short_and_stopwords() {
        let tokens = tokenize_query("the is a 注意力");
        assert!(!tokens.contains(&"the".to_string()));
        assert!(tokens.contains(&"注意力".to_string()));
    }
}
