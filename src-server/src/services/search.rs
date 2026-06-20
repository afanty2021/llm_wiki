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

pub fn extract_image_refs(content: &str) -> Vec<ImageRef> {
    let mut out = Vec::new();
    let mut seen = BTreeSet::new();
    let mut rest = content;
    while let Some(start) = rest.find("![") {
        rest = &rest[start + 2..];
        let Some(alt_end) = rest.find("](") else { break };
        let alt = rest[..alt_end].to_string();
        rest = &rest[alt_end + 2..];
        let Some(url_end) = rest.find(')') else { break };
        let url = rest[..url_end].to_string();
        if !url.trim().is_empty() && !url.contains(char::is_whitespace) && seen.insert(url.clone()) {
            out.push(ImageRef { url, alt });
        }
        rest = &rest[url_end + 1..];
    }
    out
}

/// 非重叠计数（对齐桌面 countOccurrences：每次匹配后 pos 跳过 needle）。
/// 进 score_page 的短语打分；重叠会致 "haha" in "hahaha" 算 2 而非桌面的 1。
pub fn count_occurrences(haystack: &str, needle: &str) -> usize {
    if needle.is_empty() { return 0; }
    let mut count = 0;
    let mut pos = 0;
    while let Some(off) = haystack[pos..].find(needle) {
        count += 1;
        pos += off + needle.len();
    }
    count
}

fn token_match_score(text: &str, tokens: &[String]) -> usize {
    let lower = text.to_lowercase();
    tokens.iter().filter(|t| lower.contains(t.as_str())).count()
}

pub fn build_snippet(content: &str, query: &str) -> String {
    let lower = content.to_lowercase();
    let q = query.to_lowercase();
    // 未命中时 anchor=0（取开头 ~80+query 字符）；桌面取 2*SNIPPET_CONTEXT(160)。
    // 实际由 pick_snippet_anchor 保证命中某 token/phrase，此兜底极罕见触发，长度差异可接受。
    let idx = lower.find(&q).unwrap_or(0);
    let char_positions: Vec<usize> = content.char_indices().map(|(i, _)| i).collect();
    if char_positions.is_empty() { return String::new(); }
    let match_char = char_positions.iter().position(|&b| b >= idx).unwrap_or(char_positions.len().saturating_sub(1));
    let query_chars = query.chars().count().max(1);
    let start_char = match_char.saturating_sub(SNIPPET_CONTEXT);
    let end_char = (match_char + query_chars + SNIPPET_CONTEXT).min(char_positions.len());
    let start = char_positions[start_char];
    let end = if end_char < char_positions.len() { char_positions[end_char] } else { content.len() };
    let mut snippet = content[start..end].replace('\n', " ");
    if start > 0 { snippet = format!("...{snippet}"); }
    if end < content.len() { snippet.push_str("..."); }
    snippet
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

    #[test]
    fn extract_image_refs_dedups_by_url() {
        // 与桌面行为一致：仅按 url 去重（桌面 extract_image_refs 同此）
        let refs = extract_image_refs("![a](wiki/media/x.png)\n![b](wiki/media/x.png)");
        assert_eq!(refs.len(), 1, "dedup by url: {:?}", refs);
        assert_eq!(refs[0].alt, "a");
        assert_eq!(refs[0].url, "wiki/media/x.png");
    }

    #[test]
    fn extract_image_refs_keeps_empty_alt_when_url_valid() {
        // 桌面对齐：空 alt 但 url 有效 → 仍纳入（桌面不过滤 alt）。锁住此行为防后续误改。
        let refs = extract_image_refs("![](valid.png)");
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].alt, "");
        assert_eq!(refs[0].url, "valid.png");
    }

    #[test]
    fn build_snippet_centers_on_anchor() {
        let content = "aaaa query here bbbb";
        let s = build_snippet(content, "query");
        assert!(s.contains("query"));
    }

    #[test]
    fn count_occurrences_and_token_match() {
        assert_eq!(count_occurrences("a a a", "a"), 3);
        assert_eq!(token_match_score("alice bob", &["alice".into(), "carol".into()]), 1);
    }

    #[test]
    fn build_snippet_handles_cjk_anchor() {
        // CJK 锚点：char_indices 必须正确处理多字节，不 panic
        let content = format!("{}query{}", "中".repeat(100), "中".repeat(100));
        let s = build_snippet(&content, "query");
        assert!(s.contains("query"), "snippet 应含 query: {}", s);
    }
}
