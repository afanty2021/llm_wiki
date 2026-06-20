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

/// snippet 锚点选择（score_page 与 vector-only 物化共用，保证一致）：
/// 短语命中→query_phrase；否则首个出现在 content 的 token；否则 query_phrase 回退。
fn pick_snippet_anchor(content: &str, tokens: &[String], query_phrase: &str) -> String {
    let content_lower = content.to_lowercase();
    if !query_phrase.is_empty() && content_lower.contains(query_phrase) {
        query_phrase.to_string()
    } else {
        tokens.iter().find(|t| content_lower.contains(t.as_str())).cloned()
            .unwrap_or_else(|| query_phrase.to_string())
    }
}

/// 关键词打分（移植桌面 score_file，服务端：stem 来自 path、title 来自参数）。
/// 五信号全 0 → None（不进 token_rank，避免稀释 RRF）。
fn score_page(
    path: &str,
    title: &str,
    content: &str,
    tokens: &[String],
    query_phrase: &str,
) -> Option<ScoredPage> {
    let last_segment = path.rsplit('/').next().unwrap_or(path); // e.g. "attention.md"
    let stem = last_segment.trim_end_matches(".md").to_lowercase();
    let title_text = format!("{title} {last_segment}");
    let title_lower = title_text.to_lowercase();
    let content_lower = content.to_lowercase();

    let filename_exact = !query_phrase.is_empty() && stem == query_phrase;
    let title_has_phrase = !query_phrase.is_empty() && title_lower.contains(query_phrase);
    let content_phrase_occ = count_occurrences(&content_lower, query_phrase).min(MAX_PHRASE_OCC_COUNTED);
    let title_token_score = token_match_score(&title_text, tokens);
    let content_token_score = token_match_score(content, tokens);

    if !filename_exact && !title_has_phrase && content_phrase_occ == 0
        && title_token_score == 0 && content_token_score == 0
    {
        return None;
    }

    let score = (if filename_exact { FILENAME_EXACT_BONUS } else { 0.0 })
        + (if title_has_phrase { PHRASE_IN_TITLE_BONUS } else { 0.0 })
        + content_phrase_occ as f64 * PHRASE_IN_CONTENT_PER_OCC
        + title_token_score as f64 * TITLE_TOKEN_WEIGHT
        + content_token_score as f64 * CONTENT_TOKEN_WEIGHT;

    let snippet = build_snippet(content, &pick_snippet_anchor(content, tokens, query_phrase));
    let images = extract_image_refs(content);

    Some(ScoredPage {
        path: path.to_string(),
        title: title.to_string(),
        snippet,
        score,
        title_match: title_token_score > 0 || title_has_phrase,
        images,
    })
}

/// RRF 融合：rrf = Σ 1/(RRF_K + rank)。token_rank/vector_rank 的 key 均为**全路径**，
/// rank **1-indexed**（最高分 rank=1）。保留 vector_score。
fn apply_rrf(
    results: &mut [SearchResult],
    token_rank: &HashMap<String, usize>,
    vector_rank: &HashMap<String, usize>,
    vector_score: &HashMap<String, f64>,
) {
    for r in results.iter_mut() {
        let mut rrf = 0.0;
        if let Some(rank) = token_rank.get(&r.path).copied() {
            rrf += 1.0 / (RRF_K + rank as f64);
        }
        if let Some(rank) = vector_rank.get(&r.path).copied() {
            rrf += 1.0 / (RRF_K + rank as f64);
        }
        if let Some(s) = vector_score.get(&r.path).copied() {
            r.vector_score = Some(s);
        }
        r.score = rrf;
    }
}

fn search_mode(token_rank_empty: bool, vector_hits: usize) -> &'static str {
    if vector_hits == 0 {
        "keyword"
    } else if token_rank_empty {
        "vector"
    } else {
        "hybrid"
    }
}

/// SQL ILIKE 候选拉取：title/content 命中任一 token；phrase 非空时额外 OR content ILIKE phrase。
/// phrase 为空时不追加（防 ILIKE '%%' 全表扫描）。
async fn fetch_keyword_candidates(
    pool: &PgPool,
    project_id: i32,
    tokens: &[String],
    phrase: &str,
) -> Result<Vec<Candidate>, AppError> {
    use sqlx::Row;
    if tokens.is_empty() && phrase.is_empty() {
        return Ok(Vec::new());
    }
    let mut conditions: Vec<String> = Vec::new();
    for (i, _) in tokens.iter().enumerate() {
        let idx = i + 2; // $1 = project_id, $2.. = tokens
        conditions.push(format!(
            "(title ILIKE '%' || ${idx} || '%' OR content ILIKE '%' || ${idx} || '%')"
        ));
    }
    let mut next_idx = tokens.len() + 2;
    if !phrase.is_empty() {
        conditions.push(format!("(content ILIKE '%' || ${next_idx} || '%')"));
        next_idx += 1;
    }
    let _ = next_idx; // 占位，防 unused（phrase 分支用完）
    let where_clause = conditions.join(" OR ");
    let sql = format!(
        "SELECT path, COALESCE(title,'') AS title, COALESCE(content,'') AS content \
         FROM wiki_pages WHERE project_id = $1 AND ({where_clause}) LIMIT 500",
        where_clause = where_clause,
    );
    let mut q = sqlx::query(&sql).bind(project_id);
    for t in tokens {
        q = q.bind(t);
    }
    if !phrase.is_empty() {
        q = q.bind(phrase);
    }
    let rows = q
        .fetch_all(pool)
        .await
        .map_err(AppError::DatabaseError)?;
    let out = rows
        .into_iter()
        .map(|r| Candidate {
            path: r.get("path"),
            title: r.get("title"),
            content: r.get("content"),
        })
        .collect();
    Ok(out)
}

/// vector-only 物化：按 path 查 title + content（images 由调用方 extract_image_refs 解析）。
async fn fetch_page_title_content(
    pool: &PgPool,
    project_id: i32,
    path: &str,
) -> Result<Option<(String, String)>, AppError> {
    use sqlx::Row;
    let row = sqlx::query(
        "SELECT COALESCE(title,'') AS title, COALESCE(content,'') AS content \
         FROM wiki_pages WHERE project_id = $1 AND path = $2",
    )
    .bind(project_id)
    .bind(path)
    .fetch_optional(pool)
    .await
    .map_err(AppError::DatabaseError)?;
    Ok(row.map(|r| (r.get("title"), r.get("content"))))
}

/// 单入口 hybrid 搜索（keyword + vector + RRF）。
/// embedding 未配/失败 → 退化为 keyword。返回 camelCase SearchResponse。
pub async fn hybrid_search(
    pool: &PgPool,
    emb_cfg: Option<&EmbeddingConfig>,
    client: &reqwest::Client,
    project_id: i32,
    query: &str,
    limit: usize,
) -> Result<SearchResponse, AppError> {
    let limit = limit.clamp(1, MAX_RESULTS);
    let tokens = tokenize_query(query);
    let effective_tokens = if tokens.is_empty() {
        vec![query.trim().to_lowercase()]
    } else {
        tokens
    };
    let query_phrase = trim_query_punctuation(&query.to_lowercase());

    // 1. keyword：候选 → 打分 → token_rank(1-indexed) → 转 SearchResult(vector_score=None)
    let candidates = fetch_keyword_candidates(pool, project_id, &effective_tokens, &query_phrase).await?;
    let mut scored: Vec<ScoredPage> = candidates
        .iter()
        .filter_map(|c| score_page(&c.path, &c.title, &c.content, &effective_tokens, &query_phrase))
        .collect();
    scored.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.path.cmp(&b.path))
    });
    let token_rank: HashMap<String, usize> = scored
        .iter()
        .enumerate()
        .map(|(i, s)| (s.path.clone(), i + 1))
        .collect();
    let mut results: Vec<SearchResult> = scored
        .into_iter()
        .map(|s| SearchResult {
            path: s.path,
            title: s.title,
            snippet: s.snippet,
            title_match: s.title_match,
            score: s.score,
            vector_score: None,
            images: s.images,
        })
        .collect();
    let token_hits = token_rank.len();

    // 2. vector：embed_query → vector_search → vector_rank(全路径, 1-indexed) + 物化 vector-only
    let mut vector_rank: HashMap<String, usize> = HashMap::new();
    let mut vector_score_map: HashMap<String, f64> = HashMap::new();
    let mut vector_hits = 0usize;
    if let Some(cfg) = emb_cfg {
        let qvec = match embedding::embed_query(cfg, client, query).await {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!("hybrid_search embed_query failed: {}", e);
                Vec::new()
            }
        };
        if !qvec.is_empty() {
            match embedding::vector_search(pool, project_id, qvec, (limit.max(10)) as i32).await {
                Ok(vres) => {
                    vector_hits = vres.len();
                    for (i, vr) in vres.iter().enumerate() {
                        vector_rank.insert(vr.path.clone(), i + 1);
                        vector_score_map.insert(vr.path.clone(), vr.score as f64);
                    }
                    // vector-only 物化：重取全量 content（vector_search 的 snippet 是前 200 字符截断、
                    // 不含锚点上下文），用 pick_snippet_anchor + build_snippet 产出对齐 keyword 侧的片段。
                    let known: HashSet<String> = results.iter().map(|r| r.path.clone()).collect();
                    for vr in &vres {
                        if known.contains(&vr.path) {
                            continue;
                        }
                        if let Some((title, content)) =
                            fetch_page_title_content(pool, project_id, &vr.path).await?
                        {
                            let anchor =
                                pick_snippet_anchor(&content, &effective_tokens, &query_phrase);
                            results.push(SearchResult {
                                path: vr.path.clone(),
                                title,
                                snippet: build_snippet(&content, &anchor),
                                title_match: false,
                                score: 0.0,
                                vector_score: Some(vr.score as f64),
                                images: extract_image_refs(&content),
                            });
                        }
                    }
                }
                Err(e) => tracing::warn!("hybrid_search vector_search failed: {}", e),
            }
        }
    }

    // 3. RRF + mode + sort + truncate（snippet 不重建）
    if vector_hits > 0 {
        apply_rrf(&mut results, &token_rank, &vector_rank, &vector_score_map);
    }
    results.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.path.cmp(&b.path))
    });
    results.truncate(limit);
    let mode = search_mode(token_rank.is_empty(), vector_hits);

    Ok(SearchResponse {
        mode: mode.to_string(),
        results,
        token_hits,
        vector_hits,
    })
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

    #[test]
    fn score_page_filename_exact_beats_content_only() {
        let tokens = vec!["attention".to_string()];
        let phrase = "attention";
        let exact = score_page("wiki/concepts/attention.md", "Attention", "body about attention", &tokens, phrase).unwrap();
        let content_only = score_page("wiki/concepts/random.md", "Random", "attention is mentioned briefly", &tokens, phrase).unwrap();
        assert!(exact.score > content_only.score, "exact {} should > content-only {}", exact.score, content_only.score);
        assert!(exact.score >= FILENAME_EXACT_BONUS);
        assert!(exact.title_match);
    }

    #[test]
    fn score_page_phrase_in_content_beats_scattered_tokens() {
        let tokens = vec!["vector".to_string(), "database".to_string()];
        let phrase = "vector database";
        let together = score_page("wiki/p/phrase.md", "Phrase", "The phrase vector database appears together.", &tokens, phrase).unwrap();
        let scattered = score_page("wiki/p/scattered.md", "Scattered", "vector appears here. database appears later.", &tokens, phrase).unwrap();
        assert!(together.score > scattered.score);
    }

    #[test]
    fn score_page_no_signal_returns_none() {
        assert!(score_page("wiki/x.md", "X", "nothing relevant", &["zzz".into()], "zzz").is_none());
    }

    #[test]
    fn apply_rrf_uses_full_path_keys_and_1_indexed_rank() {
        let mut results = vec![
            SearchResult { path: "wiki/both.md".into(), title: "B".into(), snippet: "".into(), title_match: false, score: 0.0, vector_score: None, images: vec![] },
            SearchResult { path: "wiki/token-only.md".into(), title: "T".into(), snippet: "".into(), title_match: false, score: 0.0, vector_score: None, images: vec![] },
            SearchResult { path: "wiki/vector-only.md".into(), title: "V".into(), snippet: "".into(), title_match: false, score: 0.0, vector_score: None, images: vec![] },
        ];
        let token_rank = HashMap::from([
            ("wiki/both.md".to_string(), 1),
            ("wiki/token-only.md".to_string(), 2),
        ]);
        // 全路径 key（不是 stem）——关键差异点
        let vector_rank = HashMap::from([
            ("wiki/both.md".to_string(), 1),
            ("wiki/vector-only.md".to_string(), 2),
        ]);
        let vector_score = HashMap::from([
            ("wiki/both.md".to_string(), 0.95),
            ("wiki/vector-only.md".to_string(), 0.8),
        ]);
        apply_rrf(&mut results, &token_rank, &vector_rank, &vector_score);
        results.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap());
        // both 双命中 → 最高；rrf = 1/61 + 1/61
        assert_eq!(results[0].path, "wiki/both.md");
        assert!((results[0].score - (1.0 / 61.0 + 1.0 / 61.0)).abs() < 1e-6, "got {}", results[0].score);
        assert_eq!(results[0].vector_score, Some(0.95));
        // token-only / vector-only 各单命中 rank=2 → 1/62
        assert!((results[1].score - 1.0 / 62.0).abs() < 1e-6);
        assert!((results[2].score - 1.0 / 62.0).abs() < 1e-6);
    }

    #[test]
    fn search_mode_three_states() {
        assert_eq!(search_mode(false, 0), "keyword");
        assert_eq!(search_mode(true, 3), "vector");
        assert_eq!(search_mode(false, 3), "hybrid");
    }
}
