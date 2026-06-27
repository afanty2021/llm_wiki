//! Shared wiki-retrieval layer for Layer 3 (chat + research).
//!
//! Pure parts (budget math, priority fill) are unit-tested inline.
//! `retrieve_context()` is the async orchestrator over `search` + `graph`.

use std::collections::{HashMap, HashSet};
use serde::Serialize;
use crate::{AppState, AppError};
use crate::services::citations::{MessageReference, RefKind};

// ---- budget fractions (ported verbatim from desktop context-budget.ts) ----
const DEFAULT_MAX_CTX: usize = 204_800;
const RESPONSE_RESERVE_FRAC: f64 = 0.15;
const INDEX_BUDGET_FRAC: f64 = 0.05;
const PAGE_BUDGET_FRAC: f64 = 0.5;
const PER_PAGE_FRAC: f64 = 0.3;
const PER_PAGE_FLOOR: usize = 5_000;

// ---- retrieval tuning ----
const SEARCH_LIMIT: usize = 10;
const GRAPH_EXPAND_LIMIT: usize = 3;
const GRAPH_RELEVANCE_THRESHOLD: f64 = 2.0;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextBudget {
    pub max_ctx: usize,
    pub response_reserve: usize,
    pub index_budget: usize,
    pub page_budget: usize,
    pub max_page_size: usize,
}

/// Character budgets from the model's context window. `context_size <= 0`
/// falls back to the 200K-char default (matches desktop).
pub fn compute_context_budget(context_size: i32) -> ContextBudget {
    let max_ctx = if context_size > 0 {
        context_size as usize
    } else {
        DEFAULT_MAX_CTX
    };
    let response_reserve = (max_ctx as f64 * RESPONSE_RESERVE_FRAC).floor() as usize;
    let index_budget = (max_ctx as f64 * INDEX_BUDGET_FRAC).floor() as usize;
    let page_budget = (max_ctx as f64 * PAGE_BUDGET_FRAC).floor() as usize;
    // Per-page cap: floor 5K, ceiling = page_budget, else 30% of page_budget.
    let max_page_size = std::cmp::min(
        page_budget,
        std::cmp::max(
            PER_PAGE_FLOOR,
            (page_budget as f64 * PER_PAGE_FRAC).floor() as usize,
        ),
    );
    ContextBudget {
        max_ctx,
        response_reserve,
        index_budget,
        page_budget,
        max_page_size,
    }
}

// ============ candidate / result types ============

/// A wiki page candidate for context, with its fill priority.
/// 0 = title match, 1 = content match, 2 = graph expansion, 3 = overview fallback.
#[derive(Clone)]
pub struct Candidate {
    pub path: String,
    pub title: String,
    pub content: String,
    pub priority: u8,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetrievedPage {
    pub number: i32,
    pub path: String,
    pub title: String,
    pub content: String,
    pub priority: u8,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetrievalResult {
    pub pages: Vec<RetrievedPage>,
    pub assembled_context: String,
    pub index_snippet: String,
    pub ref_map: HashMap<i32, MessageReference>,
}

/// Pure: order candidates by priority, dedupe by path, truncate each page to
/// `max_page_size`, greedily fill until `page_budget` is exhausted (a page that
/// does not fit is skipped, matching desktop `tryAddPage`), number them, and
/// assemble the `### [n] Title\nPath: ..\n\n{content}` blocks.
pub fn select_and_assemble(
    candidates: Vec<Candidate>,
    index_snippet: String,
    budget: &ContextBudget,
) -> RetrievalResult {
    let mut sorted = candidates;
    sorted.sort_by_key(|c| c.priority);

    // 截断标记：长度计入预算（对齐桌面 chat-panel.tsx::tryAddPage —— 标记也占字符，避免
    // 超预算后静默丢尾部内容而不告知模型）。
    const TRUNCATION_MARKER: &str = "\n\n[...truncated...]";

    let mut pages: Vec<RetrievedPage> = Vec::new();
    let mut ref_map: HashMap<i32, MessageReference> = HashMap::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut used: usize = 0;
    let mut number: i32 = 1;

    for c in sorted {
        if used >= budget.page_budget {
            break;
        }
        if !seen.insert(c.path.clone()) {
            continue;
        }
        let content: String = if c.content.chars().count() > budget.max_page_size {
            // 截断到 max_page_size 字符并追加标记（标记长度计入 added/used 记账，与桌面一致）。
            let head: String = c.content.chars().take(budget.max_page_size).collect();
            format!("{head}{TRUNCATION_MARKER}")
        } else {
            c.content.clone()
        };
        let added = content.chars().count();
        if used + added > budget.page_budget {
            continue; // doesn't fit; skip (desktop tryAddPage semantics)
        }
        ref_map.insert(
            number,
            MessageReference {
                title: c.title.clone(),
                path: Some(c.path.clone()),
                kind: RefKind::Wiki,
                url: None,
                snippet: None,
            },
        );
        pages.push(RetrievedPage {
            number,
            path: c.path.clone(),
            title: c.title.clone(),
            content: content.clone(),
            priority: c.priority,
        });
        used += added;
        number += 1;
    }

    let assembled_context = pages
        .iter()
        .map(|p| format!("### [{}] {}\nPath: {}\n\n{}", p.number, p.title, p.path, p.content))
        .collect::<Vec<_>>()
        .join("\n\n---\n\n");

    RetrievalResult {
        pages,
        assembled_context,
        index_snippet,
        ref_map,
    }
}

// ============ FromRow structs for retrieve_context ============

#[derive(sqlx::FromRow)]
struct PageRow {
    path: String,
    title: Option<String>,
    content: Option<String>,
    // Selected so the FromRow column set matches the SQL projection, but
    // not consumed by the assembler.
    #[allow(dead_code)]
    page_type: Option<String>,
}

#[derive(sqlx::FromRow)]
struct IndexRow {
    path: String,
    title: Option<String>,
    page_type: Option<String>,
}

/// Phase 1 (hybrid search) → Phase 2 (graph expansion) → fetch content →
/// Phase 3/4 (budget fill + numbered assembly). Returns the assembled context,
/// the wiki index snippet, and a number→reference map for citation resolution.
pub async fn retrieve_context(
    state: &AppState,
    project_id: i32,
    query: &str,
    context_size: i32,
) -> Result<RetrievalResult, AppError> {
    let budget = compute_context_budget(context_size);

    // Phase 1: keyword/vector hybrid search
    let provider_box =
        crate::services::llm_stream::provider_for_project(state, project_id).await.ok();
    let provider_ref: Option<&dyn crate::services::llm_stream::StreamChatProvider> =
        provider_box.as_deref();
    let search = crate::services::search::hybrid_search(
        &state.db,
        &*state.vector_store,
        &state.config.search,
        state.config.embedding.as_ref(),
        &state.http,
        project_id,
        query,
        SEARCH_LIMIT,
        provider_ref,
    )
    .await?;

    // Phase 2: graph expansion (2-hop related nodes above relevance threshold)
    let graph = crate::services::graph::build_graph(&state.db, project_id).await?;
    let mut graph_paths: HashSet<String> = HashSet::new();
    for r in &search.results {
        for rn in crate::services::graph::related_nodes(&graph, &r.path, GRAPH_EXPAND_LIMIT) {
            if rn.relevance >= GRAPH_RELEVANCE_THRESHOLD {
                graph_paths.insert(rn.path);
            }
        }
    }

    // priority per path: title match (0) < content match (1) < graph (2)
    let mut path_priority: HashMap<String, u8> = HashMap::new();
    for r in &search.results {
        let pri = if r.title_match { 0u8 } else { 1u8 };
        path_priority
            .entry(r.path.clone())
            .and_modify(|p| *p = (*p).min(pri))
            .or_insert(pri);
    }
    for p in &graph_paths {
        path_priority.entry(p.clone()).or_insert(2u8);
    }

    // fetch content for all candidate paths in one query
    let paths: Vec<String> = path_priority.keys().cloned().collect();
    let rows: Vec<PageRow> = if paths.is_empty() {
        Vec::new()
    } else {
        sqlx::query_as::<_, PageRow>(
            "SELECT path, title, content, page_type FROM wiki_pages \
             WHERE project_id = $1 AND path = ANY($2)",
        )
        .bind(project_id)
        .bind(&paths)
        .fetch_all(&state.db)
        .await?
    };
    let mut candidates: Vec<Candidate> = rows
        .into_iter()
        .map(|r| Candidate {
            title: r.title.clone().unwrap_or_else(|| r.path.clone()),
            content: r.content.unwrap_or_default(),
            priority: path_priority.get(&r.path).copied().unwrap_or(9),
            path: r.path,
        })
        .collect();

    // P3 overview fallback: ONLY when no relevant pages were found — a last-resort
    // "兜底" so the model has something to ground on. Matches desktop chat-panel
    // semantics (don't pad good matches with the synthesis page). Query is skipped
    // entirely when candidates already exist.
    if candidates.is_empty() {
        let overview: Option<PageRow> = sqlx::query_as::<_, PageRow>(
            "SELECT path, title, content, page_type FROM wiki_pages \
             WHERE project_id = $1 \
               AND (page_type IN ('synthesis','overview') OR path ILIKE '%overview%') \
             ORDER BY updated_at DESC LIMIT 1",
        )
        .bind(project_id)
        .fetch_optional(&state.db)
        .await?;
        if let Some(o) = overview {
            candidates.push(Candidate {
                title: o.title.unwrap_or_default(),
                content: o.content.unwrap_or_default(),
                priority: 3,
                path: o.path,
            });
        }
    }

    // wiki index snippet (all page titles), trimmed to index_budget chars
    let index_rows: Vec<IndexRow> = sqlx::query_as::<_, IndexRow>(
        "SELECT path, title, page_type FROM wiki_pages WHERE project_id = $1 ORDER BY title",
    )
    .bind(project_id)
    .fetch_all(&state.db)
    .await?;
    let mut index_snippet = index_rows
        .into_iter()
        .map(|r| {
            format!(
                "- {} ({}) [{}]",
                r.title.unwrap_or_else(|| r.path.clone()),
                r.page_type.unwrap_or_else(|| "page".into()),
                r.path
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    if index_snippet.chars().count() > budget.index_budget {
        index_snippet = index_snippet.chars().take(budget.index_budget).collect();
    }

    Ok(select_and_assemble(candidates, index_snippet, &budget))
}

/// Build the system prompt embedding the index + numbered pages + citation rules.
pub fn build_system_prompt(retrieval: &RetrievalResult) -> String {
    format!(
"You are a knowledgeable assistant answering questions about a wiki. Use ONLY the wiki pages provided below. When you use information from a page, cite it as [1], [2], etc. matching the page numbers in the headers. If the answer is not in the pages, say you don't know. After your answer, on a new line, append exactly one comment listing every page number you cited, in this format: <!-- cited: n, m --> Answer in the same language as the user's question.

== Wiki Index ==
{index}

== Wiki Pages ==
{pages}",
        index = retrieval.index_snippet,
        pages = retrieval.assembled_context,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn falls_back_to_default_when_zero_or_negative() {
        let b = compute_context_budget(0);
        assert_eq!(b.max_ctx, DEFAULT_MAX_CTX);
        assert_eq!(b.response_reserve, 30_720); // 204800 * 0.15
        assert_eq!(b.index_budget, 10_240);     // 204800 * 0.05
        assert_eq!(b.page_budget, 102_400);     // 204800 * 0.5
        assert_eq!(b.max_page_size, 30_720);    // 102400 * 0.3
    }

    #[test]
    fn respects_explicit_context_size() {
        let b = compute_context_budget(100_000);
        assert_eq!(b.max_ctx, 100_000);
        assert_eq!(b.page_budget, 50_000);
        assert_eq!(b.max_page_size, 15_000); // 50000 * 0.3
    }

    #[test]
    fn per_page_floor_kicks_in_for_tiny_context() {
        // page_budget = 1000 -> 30% = 300, but floor 5000 wins, capped at page_budget.
        let b = compute_context_budget(2_000);
        assert_eq!(b.page_budget, 1_000);
        assert_eq!(b.max_page_size, 1_000); // min(page_budget=1000, max(5000, 300)) = 1000
    }

    fn budget_for(ctx: i32) -> ContextBudget {
        compute_context_budget(ctx)
    }

    fn cand(path: &str, content: &str, priority: u8) -> Candidate {
        Candidate {
            path: path.into(),
            title: format!("Title {}", path),
            content: content.into(),
            priority,
        }
    }

    #[test]
    fn assembles_in_priority_order_with_numbers() {
        let b = budget_for(100_000); // page_budget 50000, max_page 15000
        let cands = vec![
            cand("graph.md", "g", 2),
            cand("title.md", "t", 0),
            cand("content.md", "c", 1),
        ];
        let r = select_and_assemble(cands, "idx".into(), &b);
        assert_eq!(r.pages.len(), 3);
        // priority order: title(0), content(1), graph(2)
        assert_eq!(r.pages[0].path, "title.md");
        assert_eq!(r.pages[0].number, 1);
        assert_eq!(r.pages[1].path, "content.md");
        assert_eq!(r.pages[1].number, 2);
        assert_eq!(r.pages[2].path, "graph.md");
        assert_eq!(r.pages[2].number, 3);
        assert!(r.assembled_context.contains("### [1] Title title.md"));
        assert!(r.assembled_context.contains("### [3] Title graph.md"));
        assert_eq!(r.ref_map.get(&2).unwrap().path.as_deref(), Some("content.md"));
    }

    #[test]
    fn dedupes_same_path_keeping_highest_priority() {
        let b = budget_for(100_000);
        let cands = vec![
            cand("dup.md", "first", 1),
            cand("dup.md", "second", 0),
        ];
        let r = select_and_assemble(cands, "idx".into(), &b);
        assert_eq!(r.pages.len(), 1);
        // priority 0 sorts first, so "second" wins
        assert_eq!(r.pages[0].content, "second");
    }

    #[test]
    fn truncates_long_page_and_appends_marker() {
        // 对齐桌面 tryAddPage：超 max_page_size 的页被截断并追加 "[...truncated...]"，
        // 标记长度计入预算记账（截断后 content = max_page_size + 标记字数）。
        let b = budget_for(100_000); // page_budget 50000, max_page 15000
        let long = "x".repeat(20_000); // > max_page_size 15000
        let r = select_and_assemble(vec![cand("long.md", &long, 0)], "idx".into(), &b);
        assert_eq!(r.pages.len(), 1);
        let marker = "\n\n[...truncated...]";
        assert_eq!(
            r.pages[0].content.chars().count(),
            15_000 + marker.chars().count()
        );
        assert!(
            r.pages[0].content.ends_with("[...truncated...]"),
            "truncated page must carry the marker"
        );
    }

    #[test]
    fn skips_page_that_exceeds_remaining_budget() {
        // 截断后的页（含标记）若超出剩余 page_budget 则跳过，给更小的页让位
        // （对齐桌面 tryAddPage：usedChars + truncated.length > PAGE_BUDGET → 跳过）。
        let b = budget_for(10_000); // page_budget 5000, max_page 5000
        let big = "x".repeat(6000); // 截断后 = 5000 + marker(19) = 5019 > page_budget 5000
        let cands = vec![cand("big.md", &big, 0), cand("small.md", "s", 1)];
        let r = select_and_assemble(cands, "idx".into(), &b);
        // big 截断后仍超预算被跳过；small 1 字符 fits
        assert_eq!(r.pages.len(), 1);
        assert_eq!(r.pages[0].path, "small.md");
    }
}
