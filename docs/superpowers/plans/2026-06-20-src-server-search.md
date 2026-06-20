# src-server 搜索 API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把桌面多阶段搜索移植到 src-server——统一单入口 `/search` hybrid（keyword + vector + RRF 融合），关键词打分对齐桌面 `score_file`，响应 camelCase 对齐桌面 contract。

**Architecture:** `services/search.rs` 重写：移植桌面纯函数（tokenize/score/rrf/mode/snippet）+ DB 编排 `hybrid_search`（SQL 候选过滤→Rust 打分→向量→RRF）；`routes/search.rs` 合并为单端点、删 `/search/vector`。数据来自 `wiki_pages` 表（非文件系统）。

**Tech Stack:** Rust + Axum + SQLx + pgvector + reqwest（omlx bge-m3）

**Spec:** `docs/superpowers/specs/2026-06-20-src-server-search-design.md`（经 4 轮 review）

---

## 前置条件

- **2a（embedding 管线）已实现**：`embedding::embed_query(cfg, client, text)`、`embedding::vector_search(pool, project_id, qvec, limit) -> Vec<VectorSearchResult{path,title,snippet,score}>`、`AppState.http: reqwest::Client`、`AppConfig.embedding: Option<EmbeddingConfig>` 均就绪。本 plan 引用这些，若 2a 未完成则 Task 7 编译失败。
- PG（docker `src-server-postgres-1` @ 5433）、omlx（@ 8001 bge-m3）在跑。
- 集成测试需 `#[ignore]` + `cargo test -- --ignored`（沿用 2a 模式）。
- 现状：`services/search.rs` 有 `search_wiki`（keyword ILIKE）+ 旧 `SearchResult`；`routes/search.rs` 有 `search_handler` + `vector_search_handler`（`/search` + `/search/vector`）。本 plan 重写两者。

## 文件结构

| 文件 | 责任 | 动作 |
|------|------|------|
| `src-server/src/services/search.rs` | 纯函数 + `hybrid_search` 编排 + 类型 | Rewrite |
| `src-server/src/routes/search.rs` | 单端点 `/search` → `hybrid_search`；删 `/search/vector` | Modify |
| `src-server/tests/search_integration.rs` | 端到端 `#[ignore]` 测试 | Create |

---

## Task 1: 常量 + 类型定义

**Files:**
- Modify: `src-server/src/services/search.rs`（顶部清空旧 `search_wiki`/旧 `SearchResult`，重立）

- [ ] **Step 1: 写 camelCase 序列化失败测试**

把 `src/services/search.rs` 整个文件内容**替换**为：

```rust
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
```

- [ ] **Step 2: 编译 + 跑测试确认通过**

```bash
cd src-server && cargo test --lib search::tests:: 2>&1 | tail -5
```
Expected: `test result: ok`（1 passed）。

> 注：此时 `routes/search.rs` 仍引用旧的 `search::search_wiki`/`SearchResult`，全工程 `cargo check` 会报错——正常，Task 8 修复。本 task 只保证 `search` 模块单测通过。

- [ ] **Step 3: Commit**

```bash
git add src-server/src/services/search.rs
git commit -m "feat(src-server): search 常量 + camelCase 类型(SearchResult/SearchResponse/ImageRef)"
```

---

## Task 2: tokenize_query + 分隔符/停用词/标点辅助

**Files:**
- Modify: `src-server/src/services/search.rs`（在 `ScoredPage` 之后追加纯函数）

- [ ] **Step 1: 写 CJK tokenize 失败测试（期望 8 个 token）**

在 `search.rs` 的 `mod tests` 追加：

```rust
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
```

- [ ] **Step 2: 跑确认失败**

```bash
cd src-server && cargo test --lib search::tests::tokenize_ 2>&1 | tail -3
```
Expected: 编译失败（`cannot find tokenize_query`）。

- [ ] **Step 3: 实现 tokenize_query + 辅助**

在 `ScoredPage` 定义之后追加：

```rust
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
        let has_cjk = chars.iter().any(|c| ('\u{3400}'..='\u{9fff}').contains(c));
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
            '，' | '。' | '！' | '？' | '、' | '；' | '：' | '“' | '”' | '‘' | '’' | '（' | '）' | '·' | '～' | '…'
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
```

- [ ] **Step 4: 跑确认通过**

```bash
cd src-server && cargo test --lib search::tests::tokenize_ 2>&1 | tail -3
```
Expected: 2 passed。

- [ ] **Step 5: Commit**

```bash
git add src-server/src/services/search.rs
git commit -m "feat(src-server): tokenize_query(CJK bigram+单字+全词) + 停用词/分隔符"
```

---

## Task 3: extract_image_refs + count_occurrences + token_match_score + build_snippet

**Files:**
- Modify: `src-server/src/services/search.rs`

- [ ] **Step 1: 写失败测试**

在 `mod tests` 追加：

```rust
    #[test]
    fn extract_image_refs_dedups_and_parses() {
        let refs = extract_image_refs("![a](wiki/media/x.png)\n![b](wiki/media/x.png)\n![](empty.png)");
        assert_eq!(refs.len(), 1, "dedup by url + skip empty alt: {:?}", refs);
        assert_eq!(refs[0].alt, "a");
        assert_eq!(refs[0].url, "wiki/media/x.png");
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
```

- [ ] **Step 2: 跑确认失败**

```bash
cd src-server && cargo test --lib search::tests:: 2>&1 | tail -3
```
Expected: 编译失败（4 个新函数未定义）。

- [ ] **Step 3: 实现四个函数**

在 `trim_query_punctuation` 之后追加：

```rust
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

pub fn count_occurrences(haystack: &str, needle: &str) -> usize {
    if needle.is_empty() { 0 } else { haystack.match_indices(needle).count() }
}

fn token_match_score(text: &str, tokens: &[String]) -> usize {
    let lower = text.to_lowercase();
    tokens.iter().filter(|t| lower.contains(t.as_str())).count()
}

pub fn build_snippet(content: &str, query: &str) -> String {
    let lower = content.to_lowercase();
    let q = query.to_lowercase();
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
```

- [ ] **Step 4: 跑确认通过**

```bash
cd src-server && cargo test --lib search::tests:: 2>&1 | tail -3
```
Expected: 全部 search 单测 passed。

- [ ] **Step 5: Commit**

```bash
git add src-server/src/services/search.rs
git commit -m "feat(src-server): extract_image_refs/count_occurrences/token_match_score/build_snippet"
```

---

## Task 4: score_page（关键词多信号打分）

**Files:**
- Modify: `src-server/src/services/search.rs`

- [ ] **Step 1: 写失败测试（文件名精确高分 + 短语共现胜散落）**

在 `mod tests` 追加：

```rust
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
```

- [ ] **Step 2: 跑确认失败**

```bash
cd src-server && cargo test --lib search::tests::score_page_ 2>&1 | tail -3
```
Expected: 编译失败（`score_page` 未定义）。

- [ ] **Step 3: 实现 score_page**

在 `build_snippet` 之后追加：

```rust
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

    // snippet anchor：短语命中→query_phrase；否则首个出现在 content 的 token；否则 query_phrase 回退
    let anchor = if content_phrase_occ > 0 {
        query_phrase.to_string()
    } else {
        tokens.iter().find(|t| content_lower.contains(t.as_str())).cloned()
            .unwrap_or_else(|| query_phrase.to_string())
    };
    let snippet = build_snippet(content, &anchor);
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
```

- [ ] **Step 4: 跑确认通过**

```bash
cd src-server && cargo test --lib search::tests::score_page_ 2>&1 | tail -3
```
Expected: 3 passed。

- [ ] **Step 5: Commit**

```bash
git add src-server/src/services/search.rs
git commit -m "feat(src-server): score_page 多信号打分(文件名/短语标题/短语正文/token 权重)"
```

---

## Task 5: apply_rrf + search_mode

**Files:**
- Modify: `src-server/src/services/search.rs`

- [ ] **Step 1: 写失败测试（RRF 全路径 key + 1-indexed + vector_score 保留；mode 三态）**

在 `mod tests` 追加：

```rust
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
```

- [ ] **Step 2: 跑确认失败**

```bash
cd src-server && cargo test --lib search::tests::apply_rrf_ search::tests::search_mode_ 2>&1 | tail -3
```
Expected: 编译失败（`apply_rrf`/`search_mode` 未定义）。

- [ ] **Step 3: 实现 apply_rrf + search_mode**

在 `score_page` 之后追加：

```rust
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
```

- [ ] **Step 4: 跑确认通过**

```bash
cd src-server && cargo test --lib search::tests::apply_rrf_ search::tests::search_mode_ 2>&1 | tail -3
```
Expected: 2 passed。

- [ ] **Step 5: Commit**

```bash
git add src-server/src/services/search.rs
git commit -m "feat(src-server): apply_rrf(全路径 key, 1-indexed) + search_mode 三态"
```

---

## Task 6: DB 辅助（候选拉取 + vector-only 物化查表）

**Files:**
- Modify: `src-server/src/services/search.rs`

- [ ] **Step 1: 实现 fetch_keyword_candidates（phrase 非空 guard）**

在 `search_mode` 之后追加：

```rust
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
        conditions.push(format!("(title ILIKE '%' || ${idx} || '%' OR content ILIKE '%' || ${idx} || '%')"));
    }
    let mut next_idx = tokens.len() + 2;
    if !phrase.is_empty() {
        conditions.push(format!("(content ILIKE '%' || ${next_idx} || '%')"));
        next_idx += 1;
    }
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
    let rows = q.fetch_all(pool).await.map_err(AppError::DatabaseError)?;
    let out = rows.into_iter().map(|r| Candidate {
        path: r.get("path"),
        title: r.get("title"),
        content: r.get("content"),
    }).collect();
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
    .bind(project_id).bind(path)
    .fetch_optional(pool).await.map_err(AppError::DatabaseError)?;
    Ok(row.map(|r| (r.get("title"), r.get("content"))))
}
```

> 注意：`AppError::DatabaseError` 接收 `sqlx::Error`（`From`/`#[from]`，`map_err` 也可）。`Row::get` 需 `use sqlx::Row`。

- [ ] **Step 2: 编译确认**

```bash
cd src-server && cargo check -p llm-wiki-server 2>&1 | tail -5 || (cd src-server && cargo check 2>&1 | tail -5)
```
Expected: `Finished`（warning 可忽略；routes/search.rs 仍引用旧 search_wiki → 可能有 error，但那在 Task 8 修；若报错仅来自 routes 引用旧符号，跳过，Task 8 解决）。若 search 模块自身有 error 则修正。

- [ ] **Step 3: Commit**

```bash
git add src-server/src/services/search.rs
git commit -m "feat(src-server): fetch_keyword_candidates(phrase guard) + fetch_page_title_content"
```

---

## Task 7: hybrid_search 编排 + 集成测试

**Files:**
- Modify: `src-server/src/services/search.rs`
- Create: `src-server/tests/search_integration.rs`

- [ ] **Step 1: 写 #[ignore] 集成测试**

`src/tests/search_integration.rs`：

```rust
// 需 PG(249 已 ingest) + omlx bge-m3。cargo test --test search_integration -- --ignored
#![cfg(test)]
use llm_wiki_server::config::AppConfig;
use llm_wiki_server::services::{embedding, search};

async fn setup() -> (sqlx::PgPool, AppConfig, reqwest::Client) {
    let cfg = AppConfig::from_env().expect("from_env");
    let pool = sqlx::postgres::PgPoolOptions::new().max_connections(2).connect(cfg.database_url()).await.unwrap();
    (pool, cfg, reqwest::Client::new())
}

#[tokio::test]
#[ignore = "requires PG(project 249 ingested) + omlx"]
async fn hybrid_search_finds_alice() {
    let (pool, cfg, client) = setup().await;
    let emb_cfg = cfg.embedding.as_ref().expect("embedding configured");
    let cnt: i64 = sqlx::query_scalar("SELECT count(*) FROM embeddings WHERE project_id=249")
        .fetch_one(&pool).await.unwrap();
    assert!(cnt > 0, "project 249 无向量——先 ingest（POST /projects/249/ingest sources/test.md）");

    let resp = search::hybrid_search(&pool, Some(emb_cfg), &client, 249, "Alice", 10).await.unwrap();
    assert!(matches!(resp.mode.as_str(), "hybrid" | "keyword" | "vector"));
    assert!(resp.token_hits + resp.vector_hits > 0, "应至少有 keyword 或 vector 命中");
    assert!(resp.results.iter().any(|r| r.path.contains("alice")), "alice.md 应在结果中: {:?}", resp.results.iter().map(|r| &r.path).collect::<Vec<_>>());
}
```

- [ ] **Step 2: 跑确认失败**

```bash
cd src-server && cargo test --test search_integration -- --ignored 2>&1 | tail -3
```
Expected: 编译失败（`hybrid_search` 未定义）。

- [ ] **Step 3: 实现 hybrid_search**

在 `fetch_page_title_content` 之后追加：

```rust
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
    let mut scored: Vec<ScoredPage> = candidates.iter()
        .filter_map(|c| score_page(&c.path, &c.title, &c.content, &effective_tokens, &query_phrase))
        .collect();
    scored.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal).then_with(|| a.path.cmp(&b.path)));
    let token_rank: HashMap<String, usize> = scored.iter().enumerate().map(|(i, s)| (s.path.clone(), i + 1)).collect();
    let mut results: Vec<SearchResult> = scored.into_iter().map(|s| SearchResult {
        path: s.path, title: s.title, snippet: s.snippet,
        title_match: s.title_match, score: s.score, vector_score: None, images: s.images,
    }).collect();
    let token_hits = token_rank.len();

    // 2. vector：embed_query → vector_search → vector_rank(全路径, 1-indexed) + 物化 vector-only
    let mut vector_rank: HashMap<String, usize> = HashMap::new();
    let mut vector_score_map: HashMap<String, f64> = HashMap::new();
    let mut vector_hits = 0usize;
    if let Some(cfg) = emb_cfg {
        let qvec = match embedding::embed_query(cfg, client, query).await {
            Ok(v) => v,
            Err(e) => { tracing::warn!("hybrid_search embed_query failed: {}", e); Vec::new() }
        };
        if !qvec.is_empty() {
            match embedding::vector_search(pool, project_id, qvec, (limit.max(10)) as i32).await {
                Ok(vres) => {
                    vector_hits = vres.len();
                    for (i, vr) in vres.iter().enumerate() {
                        vector_rank.insert(vr.path.clone(), i + 1);
                        vector_score_map.insert(vr.path.clone(), vr.score as f64);
                    }
                    // vector-only 物化
                    let known: HashSet<String> = results.iter().map(|r| r.path.clone()).collect();
                    for vr in &vres {
                        if known.contains(&vr.path) { continue; }
                        if let Some((title, content)) = fetch_page_title_content(pool, project_id, &vr.path).await? {
                            let anchor = if query_phrase.is_empty() { query.to_string() } else { query_phrase.clone() };
                            results.push(SearchResult {
                                path: vr.path.clone(), title, snippet: build_snippet(&content, &anchor),
                                title_match: false, score: 0.0, vector_score: Some(vr.score as f64),
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
    results.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal).then_with(|| a.path.cmp(&b.path)));
    results.truncate(limit);
    let mode = search_mode(token_rank.is_empty(), vector_hits);

    Ok(SearchResponse {
        mode: mode.to_string(),
        results,
        token_hits,
        vector_hits,
    })
}
```

- [ ] **Step 4: 跑 --ignored 确认通过**

```bash
cd src-server && cargo test --test search_integration -- --ignored 2>&1 | tail -6
```
Expected: `hybrid_search_finds_alice` passed（前提 project 249 已 ingest + omlx 在跑）。

- [ ] **Step 5: Commit**

```bash
git add src-server/src/services/search.rs src-server/tests/search_integration.rs
git commit -m "feat(src-server): hybrid_search 编排(keyword+vector+RRF) + 集成测试"
```

---

## Task 8: routes/search.rs 接线 + 删 /search/vector + 手动验证

**Files:**
- Modify: `src-server/src/routes/search.rs`

- [ ] **Step 1: 整文件替换为单端点**

把 `src/routes/search.rs` 整个内容替换为：

```rust
use axum::{
    extract::{Query, State},
    Json,
    response::IntoResponse,
};
use serde::Deserialize;
use crate::{AppState, AppError};
use crate::middleware::project_guard::check_project_access;
use crate::services::search::{self, SearchResponse, DEFAULT_RESULTS, MAX_RESULTS};

#[derive(Deserialize)]
pub struct SearchQueryParams {
    pub project_id: i32,
    pub query: String,
    pub limit: Option<usize>,
}

pub fn search_routes() -> axum::Router<AppState> {
    axum::Router::new().route("/", axum::routing::get(search_handler))
}

/// GET /api/v1/search?project_id=&query=&limit=  → 统一 hybrid 搜索（自动 keyword/vector/hybrid）
pub async fn search_handler(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Query(params): Query<SearchQueryParams>,
) -> Result<Json<SearchResponse>, AppError> {
    check_project_access(&state, &headers, params.project_id).await?;
    if params.query.trim().is_empty() {
        return Err(AppError::ValidationError("query is required".into()));
    }
    let limit = params.limit.unwrap_or(DEFAULT_RESULTS).min(MAX_RESULTS);
    let resp = search::hybrid_search(
        &state.db,
        state.config.embedding.as_ref(),
        &state.http,
        params.project_id,
        &params.query,
        limit,
    ).await?;
    Ok(Json(resp))
}
```

> 这删除了 `vector_search_handler` 与 `/search/vector` 路由（单入口 contract）。`check_project_access` 返回 `(user_id, team_id)`，这里只需校验、丢弃。

- [ ] **Step 2: 全工程编译确认（routes 不再引用旧 search_wiki）**

```bash
cd src-server && cargo check 2>&1 | tail -5
```
Expected: `Finished`，无 error（确认全工程通过——search 模块 + routes 都 OK）。

- [ ] **Step 3: 跑全量非 ignore 测试确认无回归**

```bash
cd src-server && cargo test --lib 2>&1 | tail -5
```
Expected: 全 pass（search 纯函数单测 + 其它模块）。

- [ ] **Step 4: 重启 server + 手动验证 hybrid 端点**

```bash
pkill -f 'target/debug/llm-wiki-server'; sleep 2
cd src-server && nohup cargo run > /tmp/llmwiki_server.log 2>&1 &
# 等 listening（curl /health）
TOKEN=$(curl -s -X POST http://localhost:8080/api/v1/auth/login -H "Content-Type: application/json" -d '{"username":"<你的 e2e 用户名>","password":"Pass1234!"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['access_token'])")
curl -s "http://localhost:8080/api/v1/search?project_id=249&query=Alice&limit=5" -H "Authorization: Bearer $TOKEN" | python3 -m json.tool | head -20
# 验证 /search/vector 已删（应 404）
curl -s -o /dev/null -w "vector endpoint HTTP %{http_code}\n" "http://localhost:8080/api/v1/search/vector?project_id=249&query=Alice" -H "Authorization: Bearer $TOKEN"
```
Expected: `/search` 返回 `{"mode":"hybrid",...,"tokenHits":N>0,"vectorHits":N>0,"results":[{"path":"...alice.md",...}]}`，camelCase 字段；`/search/vector` → 404。

- [ ] **Step 5: Commit**

```bash
git add src-server/src/routes/search.rs
git commit -m "feat(src-server): /search 单入口 hybrid 接线; 删除 /search/vector"
```

---

## 验收对照（spec §9）

- [ ] `tokenize_query("默会知识")` 8 个 token（bigram + 单字 + 全词）— Task 2
- [ ] 文件名精确命中 score > 内容命中 — Task 4
- [ ] RRF 融合后 both.md（双命中）rank > 单命中 — Task 5
- [ ] 向量未配/失败 → mode=keyword、200 OK — Task 7（emb_cfg=None / 失败分支）
- [ ] `GET /search?query=Alice&project_id=249` → mode=hybrid、alice 在 top、tokenHits/vectorHits>0 — Task 7/8
- [ ] camelCase 字段对齐桌面 — Task 1（单测）+ Task 8

## 依赖提醒

本 plan 引用 2a 产出的 `embedding::embed_query`、`embedding::vector_search`、`AppState.http`、`AppConfig.embedding`。**若 2a 未实现，Task 6/7/8 无法编译**——请先完成 2a 的实现计划（`docs/superpowers/plans/2026-06-20-src-server-embedding-pipeline.md`）。
