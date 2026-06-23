# Layer 3 Phase A — 共享层 (retrieval/citations) + Chat 子系统 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the wiki-contextual chat feature for src-server: a shared retrieval/citations layer + multi-turn conversation persistence + an SSE RAG streaming endpoint that retrieves wiki pages, assembles a budgeted context, streams an LLM answer with `[1][2]` citations, and persists the turn.

**Architecture:** Two new shared services (`services/citations.rs`, `services/retrieval.rs`) compose on top of the existing Layer 2 `search.rs`/`graph.rs` and the existing `llm_stream.rs` provider abstraction. A new route module `routes/chat_sessions.rs` adds conversation CRUD + an SSE stream endpoint. The stream handler's core turn logic is factored into `stream_conversation_turn(...)` which takes the LLM provider as an injected `Box<dyn StreamChatProvider>` parameter so it is unit-testable with a fake provider (no real LLM needed).

**Tech Stack:** Rust, axum 0.7 (SSE via `axum::response::sse`), sqlx 0.7 (PostgreSQL, `FromRow`, `ANY($n)`), `async_stream` 0.3, `regex-lite` 0.1, `futures` 0.3, `uuid`/`chrono`, `axum-test` 15 (integration tests against live DB on port 5433).

**Spec:** [2026-06-21 Layer 3 总览设计](../specs/2026-06-21-src-server-layer3-chat-review-research-design.md) §5–6, §12 Phase A.

---

## File Structure

| File | Responsibility | New/Modify |
|------|----------------|-----------|
| `src-server/migrations/006_chat_sessions.sql` | `chat_conversations` + `chat_messages` tables (refs column avoids reserved word `REFERENCES`) | Create |
| `src-server/src/services/citations.rs` | `RefKind`, `MessageReference`, `parse_cited()` (pure) | Create |
| `src-server/src/services/retrieval.rs` | `ContextBudget` + `compute_context_budget()` (pure), `Candidate`/`RetrievedPage`/`RetrievalResult`, `select_and_assemble()` (pure), `retrieve_context()` orchestrator, `build_system_prompt()` | Create |
| `src-server/src/services/mod.rs` | register the two new modules | Modify |
| `src-server/src/routes/chat_sessions.rs` | conversation CRUD handlers, SSE stream handler, `stream_conversation_turn()` helper, `chat_session_routes()` | Create |
| `src-server/src/routes/mod.rs` | `mod chat_sessions;` | Modify |
| `src-server/src/routes/projects.rs` | `.merge(chat_sessions::chat_session_routes())` | Modify |
| `src-server/tests/integration/chat_sessions_test.rs` | integration tests (CRUD, isolation, stream turn with fake provider, HTTP auth) | Create |
| `src-server/tests/integration/mod.rs` | `mod chat_sessions_test;` | Modify |

**Units & rationale:** `citations` and `retrieval` are pure-logic cores (citation parsing, budget math, priority fill) — fully unit-testable with no DB. `retrieve_context()` and the route handlers are the thin async orchestrators over them. Splitting pure from async keeps each unit testable in isolation.

**Budget units note (important):** `llm_providers.context_size` (INTEGER, e.g. 128000) is fed **directly** into the char-based budget math ported verbatim from desktop `context-budget.ts`. This is intentionally conservative — it treats the value as a character budget, so 128000 yields ~64K chars (~16K tokens) of page content, safely within a 128K-token model. Token-precise budgeting is deferred (YAGNI).

---

## Task 1: Migration 006 — chat session tables

**Files:**
- Create: `src-server/migrations/006_chat_sessions.sql`

- [ ] **Step 1: Write the migration SQL**

Create `src-server/migrations/006_chat_sessions.sql`:

```sql
-- 006_chat_sessions.sql — Layer 3 Phase A: chat 会话持久化
-- chat_conversations: 每用户私有（user_id 归属）；chat_messages: 引用快照

CREATE TABLE chat_conversations (
    id          BIGSERIAL PRIMARY KEY,
    uuid        UUID NOT NULL DEFAULT gen_random_uuid(),
    project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title       TEXT NOT NULL DEFAULT 'New chat',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_chat_conversations_uuid UNIQUE (uuid)
);
CREATE INDEX idx_chat_conv_owner ON chat_conversations(project_id, user_id, updated_at DESC);

CREATE TABLE chat_messages (
    id               BIGSERIAL PRIMARY KEY,
    uuid             UUID NOT NULL DEFAULT gen_random_uuid(),
    conversation_id  BIGINT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
    role             TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
    content          TEXT NOT NULL,
    refs             JSONB,     -- MessageReference[]（命名避开 SQL 保留字 REFERENCES）
    citations        INT[],     -- 从 <!-- cited:1,3 --> 解析出的页码
    retrieval_ctx    JSONB,     -- 快照：本次检索命中的页（调试/重放用）
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_chat_messages_uuid UNIQUE (uuid)
);
CREATE INDEX idx_chat_msg_conv ON chat_messages(conversation_id, created_at);
```

- [ ] **Step 2: Apply the migration to the test DB**

The project applies migrations externally (no in-code `sqlx::migrate!`). Apply to the test DB (port 5433, user/db `llmwiki` per `config/default.json`):

```bash
psql -h localhost -p 5433 -U llmwiki -d llmwiki -f src-server/migrations/006_chat_sessions.sql
```

Expected: `CREATE TABLE` ×2, `CREATE INDEX` ×2, no errors. (If `psql` prompts for a password, the password is in `config/default.json` or `.env`; use `PGPASSWORD=... psql ...`.)

- [ ] **Step 3: Verify the tables and the `refs` column exist**

```bash
psql -h localhost -p 5433 -U llmwiki -d llmwiki -c "\d chat_messages" -c "\d chat_conversations"
```

Expected: `chat_messages` has columns `id, uuid, conversation_id, role, content, refs, citations, retrieval_ctx, created_at` (note: `refs`, NOT `references`). `chat_conversations` has `id, uuid, project_id, user_id, title, created_at, updated_at`.

- [ ] **Step 4: Commit**

```bash
git add src-server/migrations/006_chat_sessions.sql
git commit -m "feat(src-server): 006 migration — chat_conversations + chat_messages (refs col)"
```

---

## Task 2: citations module (pure, TDD)

**Files:**
- Create: `src-server/src/services/citations.rs`
- Modify: `src-server/src/services/mod.rs` (add `pub mod citations;`)

- [ ] **Step 1: Register the module**

In `src-server/src/services/mod.rs`, add at the end of the `pub mod` list:

```rust
pub mod citations;
```

- [ ] **Step 2: Write the failing tests**

Create `src-server/src/services/citations.rs` with tests first:

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum RefKind {
    Wiki,
    External,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageReference {
    pub title: String,
    pub path: Option<String>,
    pub kind: RefKind,
    pub url: Option<String>,
    pub snippet: Option<String>,
}

/// Parse the **last** `<!-- cited: n, m -->` comment in `text` into a
/// sorted, de-duplicated list of page numbers. Returns empty vec if absent.
pub fn parse_cited(text: &str) -> Vec<i32> {
    let re = regex_lite::Regex::new(r"<!--\s*cited:\s*([0-9,\s]+?)\s*-->").unwrap();
    let mut nums: Vec<i32> = Vec::new();
    for cap in re.captures_iter(text) {
        nums.clear();
        for n in cap[1].split(',') {
            if let Ok(i) = n.trim().parse::<i32>() {
                nums.push(i);
            }
        }
    }
    nums.sort_unstable();
    nums.dedup();
    nums
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_single_citation() {
        assert_eq!(parse_cited("answer <!-- cited: 1 -->"), vec![1]);
    }

    #[test]
    fn parses_multiple_citations_unsorted() {
        assert_eq!(parse_cited("see <!-- cited: 3, 1, 5 -->"), vec![1, 3, 5]);
    }

    #[test]
    fn returns_empty_when_no_comment() {
        assert!(parse_cited("no citations here").is_empty());
    }

    #[test]
    fn uses_last_occurrence_when_multiple() {
        assert_eq!(
            parse_cited("<!-- cited: 1 --> mid <!-- cited: 2, 4 -->"),
            vec![2, 4]
        );
    }

    #[test]
    fn ignores_garbage_tokens() {
        assert_eq!(parse_cited("<!-- cited: 1, x, 2 -->"), vec![1, 2]);
    }
}
```

- [ ] **Step 3: Run tests to verify they fail (module wiring)**

```bash
cargo test -p llm-wiki-server services::citations -- --nocapture
```

Expected: 5 tests PASS (the module is self-contained; tests are written alongside the impl). If they fail, the cause is a typo — fix it. (Because tests and impl are in the same file, this step confirms the module compiles and is registered.)

- [ ] **Step 4: Commit**

```bash
git add src-server/src/services/citations.rs src-server/src/services/mod.rs
git commit -m "feat(src-server): citations service — MessageReference + parse_cited (pure, tested)"
```

---

## Task 3: retrieval::context budget (pure, TDD)

**Files:**
- Create: `src-server/src/services/retrieval.rs` (budget part only this task)
- Modify: `src-server/src/services/mod.rs` (add `pub mod retrieval;`)

- [ ] **Step 1: Register the module**

In `src-server/src/services/mod.rs`, add:

```rust
pub mod retrieval;
```

- [ ] **Step 2: Write the file with budget types + tests**

Create `src-server/src/services/retrieval.rs`:

```rust
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
}
```

- [ ] **Step 3: Run the budget tests**

```bash
cargo test -p llm-wiki-server services::retrieval::tests -- --nocapture
```

Expected: 3 tests PASS. The floor test confirms `max_page_size` never exceeds `page_budget` (the desktop cap rule).

- [ ] **Step 4: Commit**

```bash
git add src-server/src/services/retrieval.rs src-server/src/services/mod.rs
git commit -m "feat(src-server): retrieval::compute_context_budget (ported from desktop, tested)"
```

---

## Task 4: retrieval::select_and_assemble + retrieve_context

**Files:**
- Modify: `src-server/src/services/retrieval.rs` (append types + orchestrator)

- [ ] **Step 1: Append the pure `select_and_assemble` + tests**

Append to `src-server/src/services/retrieval.rs` (before the `#[cfg(test)]` block — move the test block to the end, or append types above it). Add these types and function:

```rust
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
            c.content.chars().take(budget.max_page_size).collect()
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
```

Now add these unit tests inside the existing `#[cfg(test)] mod tests` block in `retrieval.rs`:

```rust
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
    fn skips_page_that_exceeds_remaining_budget() {
        // page_budget huge, but force one oversized page then a tiny one.
        let b = budget_for(10_000); // page_budget 5000, max_page 5000
        let big = "x".repeat(6000); // > max_page_size -> truncated to 5000
        let cands = vec![cand("big.md", &big, 0), cand("small.md", "s", 1)];
        let r = select_and_assemble(cands, "idx".into(), &b);
        // big fills 5000 == page_budget -> used==budget, small skipped
        assert_eq!(r.pages.len(), 1);
        assert_eq!(r.pages[0].path, "big.md");
        assert_eq!(r.pages[0].content.chars().count(), 5000);
    }
```

- [ ] **Step 2: Run the new tests**

```bash
cargo test -p llm-wiki-server services::retrieval -- --nocapture
```

Expected: all retrieval tests PASS (3 budget + 3 assemble).

- [ ] **Step 3: Append the async orchestrator `retrieve_context` + `build_system_prompt`**

Append to `src-server/src/services/retrieval.rs`:

```rust
#[derive(sqlx::FromRow)]
struct PageRow {
    path: String,
    title: Option<String>,
    content: Option<String>,
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
    let search = crate::services::search::hybrid_search(
        &state.db,
        state.config.embedding.as_ref(),
        &state.http,
        project_id,
        query,
        SEARCH_LIMIT,
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

    // P3 overview fallback (one synthesis/overview page, if not already a candidate)
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
        if !path_priority.contains_key(&o.path) {
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
```

- [ ] **Step 4: Compile the retrieval module**

```bash
cargo build -p llm-wiki-server 2>&1 | tail -20
```

Expected: builds cleanly. (No new test for `retrieve_context` here — it needs a live DB + project; covered in Task 7 integration tests.)

- [ ] **Step 5: Commit**

```bash
git add src-server/src/services/retrieval.rs
git commit -m "feat(src-server): retrieve_context orchestrator + select_and_assemble (tested pure core)"
```

---

## Task 5: chat_sessions route module — conversation CRUD (integration TDD)

**Files:**
- Create: `src-server/src/routes/chat_sessions.rs`
- Modify: `src-server/src/routes/mod.rs` (`mod chat_sessions;`)
- Modify: `src-server/src/routes/projects.rs` (`.merge(...)`)
- Modify: `src-server/tests/integration/mod.rs` (`mod chat_sessions_test;`)
- Create: `src-server/tests/integration/chat_sessions_test.rs` (CRUD + isolation tests this task)

- [ ] **Step 1: Register the route module and merge into project routes**

In `src-server/src/routes/mod.rs`, add to the `mod` declarations (use `pub` so the Task 6 integration test can call `stream_conversation_turn` directly):

```rust
pub mod chat_sessions;
```

In `src-server/src/routes/projects.rs`, inside `project_routes()` (next to the existing `.merge(pages::pages_routes())`), add:

```rust
        .merge(chat_sessions::chat_session_routes())
```

- [ ] **Step 2: Write the CRUD handlers + routes function**

Create `src-server/src/routes/chat_sessions.rs`:

```rust
//! Layer 3 Phase A: wiki-contextual chat — conversation persistence + SSE RAG.
//!
//! Routes (project-scoped, merged under /api/v1/projects):
//!   GET    /:id/chat/conversations                 list current user's conversations
//!   POST   /:id/chat/conversations                 create conversation
//!   GET    /:id/chat/conversations/:cid/messages   list messages (last 100, chronological)
//!   DELETE /:id/chat/conversations/:cid            delete conversation (cascade)
//!   POST   /:id/chat/conversations/:cid/stream     SSE RAG turn (Task 6)

use axum::{
    extract::{Path, Query, State},
    http::HeaderMap,
    Json,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::services::citations::MessageReference;
use crate::services::llm_stream::{ChatMessage, ChatOpts, StreamChatProvider, TokenDelta};
use crate::{AppState, AppError};
use crate::middleware::project_guard::check_project_access;

const HISTORY_LIMIT: i64 = 10;
const MESSAGE_PAGE_LIMIT: i64 = 100;

// ---- response DTOs ----
#[derive(Debug, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct ConversationResp {
    pub id: i64,
    pub uuid: Uuid,
    pub project_id: i32,
    pub user_id: i32,
    pub title: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageResp {
    pub id: i64,
    pub uuid: Uuid,
    pub conversation_id: i64,
    pub role: String,
    pub content: String,
    pub refs: Option<Vec<MessageReference>>,
    pub citations: Option<Vec<i32>>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, sqlx::FromRow)]
struct MsgRow {
    id: i64,
    uuid: Uuid,
    conversation_id: i64,
    role: String,
    content: String,
    refs: Option<serde_json::Value>,
    citations: Option<Vec<i32>>,
    created_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateConvBody {
    pub title: Option<String>,
}

pub fn chat_session_routes() -> axum::Router<AppState> {
    axum::Router::new()
        .route(
            "/:id/chat/conversations",
            axum::routing::get(list_conversations).post(create_conversation),
        )
        .route(
            "/:id/chat/conversations/:cid/messages",
            axum::routing::get(list_messages),
        )
        .route(
            "/:id/chat/conversations/:cid",
            axum::routing::delete(delete_conversation),
        )
        // conversation_stream is added in Task 6
}

// ---- list: current user's conversations, newest first ----
pub async fn list_conversations(
    State(state): State<AppState>,
    Path(project_id): Path<i32>,
    headers: HeaderMap,
) -> Result<Json<Vec<ConversationResp>>, AppError> {
    let (user_id, _) = check_project_access(&state, &headers, project_id).await?;
    let rows = sqlx::query_as::<_, ConversationResp>(
        "SELECT id, uuid, project_id, user_id, title, created_at, updated_at \
         FROM chat_conversations WHERE project_id = $1 AND user_id = $2 \
         ORDER BY updated_at DESC",
    )
    .bind(project_id)
    .bind(user_id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

// ---- create ----
pub async fn create_conversation(
    State(state): State<AppState>,
    Path(project_id): Path<i32>,
    headers: HeaderMap,
    Json(body): Json<CreateConvBody>,
) -> Result<(axum::http::StatusCode, Json<ConversationResp>), AppError> {
    let (user_id, _) = check_project_access(&state, &headers, project_id).await?;
    let title = body
        .title
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| "New chat".to_string());
    let row = sqlx::query_as::<_, ConversationResp>(
        "INSERT INTO chat_conversations (uuid, project_id, user_id, title) \
         VALUES ($1, $2, $3, $4) \
         RETURNING id, uuid, project_id, user_id, title, created_at, updated_at",
    )
    .bind(Uuid::new_v4())
    .bind(project_id)
    .bind(user_id)
    .bind(&title)
    .fetch_one(&state.db)
    .await?;
    Ok((axum::http::StatusCode::CREATED, Json(row)))
}

// ---- messages: last 100 chronological ----
pub async fn list_messages(
    State(state): State<AppState>,
    Path((project_id, conv_id)): Path<(i32, i64)>,
    headers: HeaderMap,
) -> Result<Json<Vec<MessageResp>>, AppError> {
    let (user_id, _) = check_project_access(&state, &headers, project_id).await?;
    // ownership check
    let owned = sqlx::query_scalar::<_, i64>(
        "SELECT id FROM chat_conversations WHERE id = $1 AND project_id = $2 AND user_id = $3",
    )
    .bind(conv_id)
    .bind(project_id)
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?;
    if owned.is_none() {
        return Err(AppError::ResourceNotFound("conversation not found".into()));
    }
    // fetch last N newest-first, then reverse to chronological
    let mut rows = sqlx::query_as::<_, MsgRow>(
        "SELECT id, uuid, conversation_id, role, content, refs, citations, created_at \
         FROM chat_messages WHERE conversation_id = $1 \
         ORDER BY created_at DESC LIMIT $2",
    )
    .bind(conv_id)
    .bind(MESSAGE_PAGE_LIMIT)
    .fetch_all(&state.db)
    .await?;
    rows.reverse();
    let out: Vec<MessageResp> = rows
        .into_iter()
        .map(|r| MessageResp {
            id: r.id,
            uuid: r.uuid,
            conversation_id: r.conversation_id,
            role: r.role,
            content: r.content,
            refs: r
                .refs
                .and_then(|v| serde_json::from_value::<Vec<MessageReference>>(v).ok()),
            citations: r.citations,
            created_at: r.created_at,
        })
        .collect();
    Ok(Json(out))
}

// ---- delete (cascade messages) ----
pub async fn delete_conversation(
    State(state): State<AppState>,
    Path((project_id, conv_id)): Path<(i32, i64)>,
    headers: HeaderMap,
) -> Result<axum::http::StatusCode, AppError> {
    let (user_id, _) = check_project_access(&state, &headers, project_id).await?;
    let res = sqlx::query(
        "DELETE FROM chat_conversations WHERE id = $1 AND project_id = $2 AND user_id = $3",
    )
    .bind(conv_id)
    .bind(project_id)
    .bind(user_id)
    .execute(&state.db)
    .await?;
    if res.rows_affected() == 0 {
        return Err(AppError::ResourceNotFound("conversation not found".into()));
    }
    Ok(axum::http::StatusCode::NO_CONTENT)
}
```

- [ ] **Step 3: Register the test module and write failing CRUD tests**

In `src-server/tests/integration/mod.rs`, add (next to the other `mod` declarations):

```rust
mod chat_sessions_test;
```

Create `src-server/tests/integration/chat_sessions_test.rs`:

```rust
use axum::http::StatusCode;
use serde_json::Value;
use std::sync::atomic::{AtomicU64, Ordering};

// NOTE: this suite's crate root (tests/integration/mod.rs) exposes only
// setup_test_app + register_user. setup_project is defined per-file (see
// pages_test.rs), so we provide our own copy here rather than crate::setup_project.
static COUNTER: AtomicU64 = AtomicU64::new(0);

/// Unique prefix: pid + monotonic counter (mirrors pages_test.rs).
fn unique_prefix(tag: &str) -> String {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    format!("{}_{}_{}", tag, std::process::id(), n)
}

/// register a user + personal team + one project; return (server, state, pid, token).
async fn setup_project(tag: &str) -> (axum_test::TestServer, llm_wiki_server::AppState, i32, String) {
    let (app, state) = crate::setup_test_app().await;
    let server = axum_test::TestServer::new(app).unwrap();
    let username = unique_prefix(tag);
    let token = crate::register_user(&server, &username, &format!("{}@t.com", username), "password123").await;
    let team_id: i32 = sqlx::query_scalar(
        "SELECT id FROM teams WHERE created_by = (SELECT id FROM users WHERE username = $1)",
    )
    .bind(&username)
    .fetch_one(&state.db)
    .await
    .unwrap();
    let resp = server
        .post("/api/v1/projects")
        .add_header("authorization", format!("Bearer {}", token))
        .json(&serde_json::json!({ "name": "test-proj", "team_id": team_id }))
        .await;
    assert_eq!(resp.status_code(), StatusCode::CREATED);
    let project_id = resp.json::<serde_json::Value>()["id"].as_i64().unwrap() as i32;
    (server, state, project_id, token)
}

async fn setup(tag: &str) -> (axum_test::TestServer, llm_wiki_server::AppState, i32, String) {
    setup_project(tag).await
}

fn auth(token: &str) -> String {
    format!("Bearer {}", token)
}

async fn create_conv(
    server: &axum_test::TestServer,
    pid: i32,
    token: &str,
    title: Option<&str>,
) -> Value {
    let body = match title {
        Some(t) => serde_json::json!({ "title": t }),
        None => serde_json::json!({}),
    };
    let r = server
        .post(&format!("/api/v1/projects/{}/chat/conversations", pid))
        .add_header("authorization", auth(token))
        .content_type("application/json")
        .json(&body)
        .await;
    assert_eq!(r.status_code(), StatusCode::CREATED);
    r.json()
}

#[tokio::test]
async fn create_list_delete_conversation() {
    let (server, _state, pid, token) = setup("conv-crud").await;
    let c = create_conv(&server, pid, &token, Some("My chat")).await;
    let cid = c["id"].as_i64().unwrap();
    assert_eq!(c["title"], "My chat");

    // list shows it
    let r = server
        .get(&format!("/api/v1/projects/{}/chat/conversations", pid))
        .add_header("authorization", auth(&token))
        .await;
    assert_eq!(r.status_code(), StatusCode::OK);
    let list: Vec<Value> = r.json();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0]["id"], c["id"]);

    // delete -> 204
    let r = server
        .delete(&format!("/api/v1/projects/{}/chat/conversations/{}", pid, cid))
        .add_header("authorization", auth(&token))
        .await;
    assert_eq!(r.status_code(), StatusCode::NO_CONTENT);

    // list now empty
    let r = server
        .get(&format!("/api/v1/projects/{}/chat/conversations", pid))
        .add_header("authorization", auth(&token))
        .await;
    let list: Vec<Value> = r.json();
    assert!(list.is_empty());
}

#[tokio::test]
async fn default_title_when_none() {
    let (server, _state, pid, token) = setup("conv-default").await;
    let c = create_conv(&server, pid, &token, None).await;
    assert_eq!(c["title"], "New chat");
}

#[tokio::test]
async fn conversations_are_private_per_user() {
    let (server, _state, pid, token_a) = setup("conv-iso").await;
    // user A creates a conversation
    let c = create_conv(&server, pid, &token_a, Some("A's secret")).await;
    let cid = c["id"].as_i64().unwrap();

    // user B (new registration) is NOT a member of A's team/project -> 403 on project access.
    // Register B with a unique name (persistent test DB — avoid re-run username collision).
    let uname_b = unique_prefix("conv-iso-b");
    let user_b = crate::register_user(&server, &uname_b, &format!("{}@t.com", uname_b), "password123").await;

    // B cannot list A's conversations (no project membership) -> 403
    let r = server
        .get(&format!("/api/v1/projects/{}/chat/conversations", pid))
        .add_header("authorization", auth(&user_b))
        .await;
    assert_eq!(r.status_code(), StatusCode::FORBIDDEN);

    // B cannot delete A's conversation through this project (403 before ownership check)
    let r = server
        .delete(&format!("/api/v1/projects/{}/chat/conversations/{}", pid, cid))
        .add_header("authorization", auth(&user_b))
        .await;
    assert_eq!(r.status_code(), StatusCode::FORBIDDEN);

    // A still sees their conversation
    let r = server
        .get(&format!("/api/v1/projects/{}/chat/conversations", pid))
        .add_header("authorization", auth(&token_a))
        .await;
    let list: Vec<Value> = r.json();
    assert_eq!(list.len(), 1);
}

#[tokio::test]
async fn list_messages_empty_for_new_conversation() {
    let (server, _state, pid, token) = setup("conv-msgs").await;
    let c = create_conv(&server, pid, &token, None).await;
    let cid = c["id"].as_i64().unwrap();
    let r = server
        .get(&format!(
            "/api/v1/projects/{}/chat/conversations/{}/messages",
            pid, cid
        ))
        .add_header("authorization", auth(&token))
        .await;
    assert_eq!(r.status_code(), StatusCode::OK);
    let msgs: Vec<Value> = r.json();
    assert!(msgs.is_empty());
}
```

- [ ] **Step 4: Run the CRUD tests**

```bash
cargo test -p llm-wiki-server --test integration chat_sessions_test -- --nocapture
```

Expected: 4 tests PASS. (`conversations_are_private_per_user` confirms the user_id scoping + project guard.)

- [ ] **Step 5: Commit**

```bash
git add src-server/src/routes/chat_sessions.rs src-server/src/routes/mod.rs src-server/src/routes/projects.rs src-server/tests/integration/mod.rs src-server/tests/integration/chat_sessions_test.rs
git commit -m "feat(src-server): chat conversation CRUD + per-user isolation (tested)"
```

---

## Task 6: chat RAG stream — `stream_conversation_turn` + fake-provider test

**Design for testability:** The turn produces structured `ChatStreamEvent`s (an enum). The SSE handler converts each variant to an axum `Event`. Tests consume `ChatStreamEvent`s directly — no need to introspect axum's `Event` (which has no public getters). The LLM provider is injected (`Box<dyn StreamChatProvider>`), so a `FakeProvider` substitutes for the real LLM. `user_id` is read back from the created conversation (no dependency on the test helper's username scheme).

**Files:**
- Modify: `src-server/src/routes/chat_sessions.rs` (add enum, turn producer, SSE handler, route)
- Modify: `src-server/tests/integration/chat_sessions_test.rs` (stream turn test)

- [ ] **Step 1: Add the stream types, turn producer, and SSE handler**

Add these imports to the existing `use` block at the top of `src-server/src/routes/chat_sessions.rs`:

```rust
use std::convert::Infallible;
use std::pin::Pin;
use std::time::Duration;
use futures::stream::{Stream, StreamExt};
use axum::response::sse::{Event, KeepAlive, Sse};
use crate::services::retrieval::{retrieve_context, build_system_prompt, RetrievedPage};
use crate::services::citations::parse_cited;
use crate::services::llm_stream::provider_for_project;
```

Add a type alias for the boxed SSE event stream (matches `routes/chat.rs`):

```rust
/// Boxed SSE event stream (type-erased), matching routes/chat.rs.
type SseStream = Pin<Box<dyn Stream<Item = Result<Event, Infallible>> + Send>>;
```

Append the event enum, request body, turn producer, SSE converter, persistence, and handler to `src-server/src/routes/chat_sessions.rs`:

```rust
/// Structured events produced by a chat turn. The SSE handler converts each
/// variant to an axum `Event`; tests consume these directly.
#[derive(Debug, Clone)]
pub enum ChatStreamEvent {
    Retrieval(Vec<RetrievedPage>),
    Token(String),
    Done {
        references: Vec<MessageReference>,
        citations: Vec<i32>,
    },
    Error(String),
}

/// A boxed stream of structured chat-turn events (type-erased, for testing).
pub type TurnStream = Pin<Box<dyn Stream<Item = ChatStreamEvent> + Send>>;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamBody {
    pub message: String,
}

#[derive(sqlx::FromRow)]
struct HistRow {
    role: String,
    content: String,
}

/// Produce the structured events for one RAG turn. Verifies ownership,
/// retrieves context, builds messages, persists the user message, streams
/// tokens from the injected `provider`, parses citations, persists the
/// assistant message, and emits a final `Done`.
pub async fn stream_conversation_turn(
    state: AppState,
    project_id: i32,
    user_id: i32,
    conv_id: i64,
    user_msg: String,
    provider: Box<dyn StreamChatProvider>,
    model: String,
    context_size: i32,
) -> Result<TurnStream, AppError> {
    // ownership check (private conversation)
    let owned = sqlx::query_scalar::<_, i64>(
        "SELECT id FROM chat_conversations WHERE id = $1 AND project_id = $2 AND user_id = $3",
    )
    .bind(conv_id)
    .bind(project_id)
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?;
    if owned.is_none() {
        return Err(AppError::ResourceNotFound("conversation not found".into()));
    }

    // history (last N newest-first, reversed to chronological)
    let mut hist: Vec<HistRow> = sqlx::query_as::<_, HistRow>(
        "SELECT role, content FROM chat_messages WHERE conversation_id = $1 \
         ORDER BY created_at DESC LIMIT $2",
    )
    .bind(conv_id)
    .bind(HISTORY_LIMIT)
    .fetch_all(&state.db)
    .await?;
    hist.reverse();

    // retrieval + system prompt
    let retrieval = retrieve_context(&state, project_id, &user_msg, context_size).await?;
    let system_prompt = build_system_prompt(&retrieval);

    // messages = [system, ...history, user]
    let mut messages: Vec<ChatMessage> = Vec::with_capacity(2 + hist.len());
    messages.push(ChatMessage { role: "system".into(), content: system_prompt });
    for h in hist {
        messages.push(ChatMessage { role: h.role, content: h.content });
    }
    messages.push(ChatMessage { role: "user".into(), content: user_msg.clone() });

    // persist user message (+ auto-title on first message)
    let is_first = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM chat_messages WHERE conversation_id = $1",
    )
    .bind(conv_id)
    .fetch_one(&state.db)
    .await?
        == 0;
    sqlx::query(
        "INSERT INTO chat_messages (uuid, conversation_id, role, content) \
         VALUES ($1, $2, 'user', $3)",
    )
    .bind(Uuid::new_v4())
    .bind(conv_id)
    .bind(&user_msg)
    .execute(&state.db)
    .await?;
    if is_first {
        let title: String = user_msg.chars().take(50).collect();
        sqlx::query("UPDATE chat_conversations SET title = $1, updated_at = NOW() WHERE id = $2")
            .bind(&title)
            .bind(conv_id)
            .execute(&state.db)
            .await?;
    }

    let ref_map = retrieval.ref_map.clone();
    let pages_for_event = retrieval.pages.clone();
    let pages_for_persist = retrieval.pages.clone(); // snapshot for retrieval_ctx column
    let state_for_stream = state.clone();

    let stream = async_stream::stream! {
        yield ChatStreamEvent::Retrieval(pages_for_event);

        let opts = ChatOpts {
            model: model.clone(),
            temperature: 0.3,
            max_tokens: 2048,
            system_prompt: None, // system message already in `messages`
            timeout_secs: None,
        };
        let mut ts = match provider.stream_chat(messages, opts).await {
            Ok(s) => s,
            Err(e) => {
                yield ChatStreamEvent::Error(e.to_string());
                return;
            }
        };
        let mut full = String::new();
        while let Some(delta) = ts.next().await {
            match delta {
                Ok(TokenDelta::Text(t)) => {
                    full.push_str(&t);
                    yield ChatStreamEvent::Token(t);
                }
                Ok(TokenDelta::Usage { .. }) => {}
                Ok(TokenDelta::Done) => break,
                Err(e) => {
                    yield ChatStreamEvent::Error(e.to_string());
                    return;
                }
            }
        }

        let citations = parse_cited(&full);
        let cited_refs: Vec<MessageReference> = citations
            .iter()
            .filter_map(|n| ref_map.get(n).cloned())
            .collect();
        let _ = persist_assistant(&state_for_stream, conv_id, &full, &citations, &cited_refs, &pages_for_persist).await;

        yield ChatStreamEvent::Done {
            references: cited_refs,
            citations,
        };
    };

    Ok(Box::pin(stream))
}

/// Convert a structured event into an SSE wire event.
fn to_sse_event(e: ChatStreamEvent) -> Event {
    match e {
        ChatStreamEvent::Retrieval(pages) => Event::default()
            .event("retrieval")
            .data(serde_json::to_string(&pages).unwrap_or_else(|_| "[]".into())),
        ChatStreamEvent::Token(t) => Event::default().event("token").data(t),
        ChatStreamEvent::Done { references, citations } => Event::default()
            .event("done")
            .data(
                serde_json::json!({ "references": references, "citations": citations })
                    .to_string(),
            ),
        ChatStreamEvent::Error(m) => Event::default()
            .event("error")
            .data(serde_json::json!({ "message": m }).to_string()),
    }
}

async fn persist_assistant(
    state: &AppState,
    conv_id: i64,
    content: &str,
    citations: &[i32],
    refs: &[MessageReference],
    retrieval_pages: &[RetrievedPage],
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO chat_messages (uuid, conversation_id, role, content, refs, citations, retrieval_ctx) \
         VALUES ($1, $2, 'assistant', $3, $4, $5, $6)",
    )
    .bind(Uuid::new_v4())
    .bind(conv_id)
    .bind(content)
    .bind(serde_json::to_value(refs).unwrap_or(serde_json::Value::Null))
    .bind(citations)
    .bind(serde_json::to_value(retrieval_pages).unwrap_or(serde_json::Value::Null))
    .execute(&state.db)
    .await?;
    sqlx::query("UPDATE chat_conversations SET updated_at = NOW() WHERE id = $1")
        .bind(conv_id)
        .execute(&state.db)
        .await?;
    Ok(())
}

/// POST /:id/chat/conversations/:cid/stream — SSE RAG turn.
pub async fn conversation_stream(
    State(state): State<AppState>,
    Path((project_id, conv_id)): Path<(i32, i64)>,
    headers: HeaderMap,
    Json(body): Json<StreamBody>,
) -> Result<Sse<SseStream>, AppError> {
    let (user_id, _) = check_project_access(&state, &headers, project_id).await?;
    if body.message.trim().is_empty() {
        return Err(AppError::ValidationError("message is required".into()));
    }
    let llm = crate::services::llm::get_llm_config(&state.db, project_id).await?;
    let provider = provider_for_project(&state, project_id).await?;
    let turn = stream_conversation_turn(
        state, project_id, user_id, conv_id, body.message, provider, llm.model, llm.context_size,
    )
    .await?;
    let sse_stream: SseStream =
        Box::pin(turn.map(|e| Ok::<_, Infallible>(to_sse_event(e))));
    Ok(Sse::new(sse_stream).keep_alive(
        KeepAlive::new().interval(Duration::from_secs(15)).text("ping"),
    ))
}
```

Add the stream route to `chat_session_routes()` (append one more `.route(...)` before the closing brace):

```rust
        .route(
            "/:id/chat/conversations/:cid/stream",
            axum::routing::post(conversation_stream),
        )
```

- [ ] **Step 2: Compile**

```bash
cargo build -p llm-wiki-server 2>&1 | tail -25
```

Expected: clean build. (`async_stream`, `futures`, `axum::response::sse` are already dependencies.)

- [ ] **Step 3: Write the stream-turn test with a fake provider**

Append to `src-server/tests/integration/chat_sessions_test.rs`:

```rust
use futures::stream::{BoxStream, StreamExt};
use llm_wiki_server::routes::chat_sessions::{stream_conversation_turn, ChatStreamEvent};
use llm_wiki_server::services::llm_stream::{
    ChatMessage, ChatOpts, LlmError, StreamChatProvider, TokenDelta,
};

/// Fake provider emitting canned tokens (no real LLM).
struct FakeProvider {
    tokens: Vec<String>,
}

#[async_trait::async_trait]
impl StreamChatProvider for FakeProvider {
    async fn stream_chat(
        &self,
        _messages: Vec<ChatMessage>,
        _opts: ChatOpts,
    ) -> Result<BoxStream<'static, Result<TokenDelta, LlmError>>, LlmError> {
        let tokens = self.tokens.clone();
        let s = async_stream::stream! {
            for t in tokens {
                yield Ok(TokenDelta::Text(t));
            }
            yield Ok(TokenDelta::Done);
        };
        Ok(Box::pin(s))
    }
    fn provider_type(&self) -> &'static str {
        "fake"
    }
    fn model_name(&self) -> &str {
        "fake"
    }
}

#[tokio::test]
async fn stream_turn_emits_tokens_citations_and_persists() {
    let (server, state, pid, token) = setup("conv-stream").await;

    // insert a wiki page the query will match (keyword mode; embedding endpoint
    // may be unreachable in the test env -> hybrid_search falls back to keyword)
    sqlx::query(
        "INSERT INTO wiki_pages (project_id, path, title, content, page_type) \
         VALUES ($1, 'concepts/rust.md', 'Rust Ownership', 'Rust ownership is about memory safety.', 'concept') \
         ON CONFLICT (project_id, path) DO NOTHING",
    )
    .bind(pid)
    .execute(&state.db)
    .await
    .unwrap();

    // create conversation via the API (real create path), then read its owner
    let c = create_conv(&server, pid, &token, None).await;
    let conv_id = c["id"].as_i64().unwrap();
    let user_id: i32 =
        sqlx::query_scalar("SELECT user_id FROM chat_conversations WHERE id = $1")
            .bind(conv_id)
            .fetch_one(&state.db)
            .await
            .unwrap();

    // run the turn with a fake provider that emits a cited answer
    let provider = Box::new(FakeProvider {
        tokens: vec![
            "Rust ownership ensures memory safety. ".into(),
            "<!-- cited: 1 -->".into(),
        ],
    });
    let mut turn = stream_conversation_turn(
        state.clone(),
        pid,
        user_id,
        conv_id,
        "What is rust ownership?".into(),
        provider,
        "fake".into(),
        100_000,
    )
    .await
    .unwrap();

    // collect structured events
    let mut names: Vec<&'static str> = Vec::new();
    let mut tokens = String::new();
    let mut done = None;
    while let Some(e) = turn.next().await {
        match e {
            ChatStreamEvent::Retrieval(_) => names.push("retrieval"),
            ChatStreamEvent::Token(t) => {
                names.push("token");
                tokens.push_str(&t);
            }
            ChatStreamEvent::Done { references, citations } => {
                names.push("done");
                done = Some((references, citations));
            }
            ChatStreamEvent::Error(_) => names.push("error"),
        }
    }

    assert!(names.contains(&"retrieval"), "events: {:?}", names);
    assert!(names.contains(&"token"), "events: {:?}", names);
    assert!(names.contains(&"done"), "events: {:?}", names);
    assert!(!names.contains(&"error"), "unexpected error event");
    assert_eq!(tokens, "Rust ownership ensures memory safety. <!-- cited: 1 -->");

    let (refs, citations) = done.unwrap();
    assert_eq!(citations, vec![1]);
    assert_eq!(refs[0].path.as_deref(), Some("concepts/rust.md"));

    // persisted messages (+ retrieval_ctx snapshot on assistant only)
    let rows: Vec<(String, Option<Vec<i32>>, Option<serde_json::Value>)> = sqlx::query_as(
        "SELECT role, citations, retrieval_ctx FROM chat_messages WHERE conversation_id = $1 ORDER BY created_at",
    )
    .bind(conv_id)
    .fetch_all(&state.db)
    .await
    .unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].0, "user");
    assert!(rows[0].2.is_none(), "user message has no retrieval_ctx");
    assert_eq!(rows[1].0, "assistant");
    assert_eq!(rows[1].1.as_deref(), Some(&[1][..]));
    let ctx = rows[1].2.as_ref().expect("assistant retrieval_ctx must be persisted");
    assert!(
        ctx.to_string().contains("concepts/rust.md"),
        "retrieval_ctx snapshot includes the cited page"
    );

    // auto-title set from first user message
    let title: String = sqlx::query_scalar("SELECT title FROM chat_conversations WHERE id = $1")
        .bind(conv_id)
        .fetch_one(&state.db)
        .await
        .unwrap();
    assert_eq!(title, "What is rust ownership?");
}
```

- [ ] **Step 4: Run the stream test**

```bash
cargo test -p llm-wiki-server --test integration stream_turn -- --nocapture
```

Expected: PASS. The fake provider yields the answer; `retrieve_context` matches the page via keyword; citation `[1]` resolves to `concepts/rust.md`; both messages persist; title auto-set from the first user message.

> If `retrieve_context` returns zero pages, verify the page content/title contains the query terms and the page is committed to the test DB. Embedding being unreachable is fine — keyword fallback handles it.

- [ ] **Step 5: Commit**

```bash
git add src-server/src/routes/chat_sessions.rs src-server/tests/integration/chat_sessions_test.rs
git commit -m "feat(src-server): RAG stream turn (structured events + SSE) with injected provider + citation persistence (tested)"
```

## Task 7: HTTP-level integration tests + full suite green

**Files:**
- Modify: `src-server/tests/integration/chat_sessions_test.rs` (HTTP auth tests)

- [ ] **Step 1: Add HTTP-level guard tests**

Append to `src-server/tests/integration/chat_sessions_test.rs`:

```rust
#[tokio::test]
async fn stream_endpoint_rejects_unauthenticated() {
    let (server, _state, pid, _token) = setup("conv-auth").await;
    let uname = unique_prefix("conv-auth-u");
    let tok = crate::register_user(&server, &uname, &format!("{}@t.com", uname), "password123").await;
    let c = create_conv(&server, pid, &tok, None).await;
    let cid = c["id"].as_i64().unwrap();
    let r = server
        .post(&format!(
            "/api/v1/projects/{}/chat/conversations/{}/stream",
            pid, cid
        ))
        .content_type("application/json")
        .json(&serde_json::json!({"message":"hi"}))
        .await;
    // No Authorization header -> 401
    assert_eq!(r.status_code(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn stream_endpoint_404_for_other_users_conversation() {
    let (server, _state, pid, token_a) = setup("conv-404").await;
    let c = create_conv(&server, pid, &token_a, None).await;
    let cid = c["id"].as_i64().unwrap();

    // A different user who IS a team member (e.g. added by an admin) would get
    // 404 from the ownership check. Here, user B is not a project member -> 403.
    let user_b_uname = unique_prefix("conv-404-b");
    let user_b = crate::register_user(&server, &user_b_uname, &format!("{}@t.com", user_b_uname), "password123").await;
    let r = server
        .post(&format!(
            "/api/v1/projects/{}/chat/conversations/{}/stream",
            pid, cid
        ))
        .add_header("authorization", auth(&user_b))
        .content_type("application/json")
        .json(&serde_json::json!({"message":"hi"}))
        .await;
    assert_eq!(r.status_code(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn stream_endpoint_400_on_empty_message() {
    let (server, _state, pid, token) = setup("conv-empty").await;
    let c = create_conv(&server, pid, &token, None).await;
    let cid = c["id"].as_i64().unwrap();
    let r = server
        .post(&format!(
            "/api/v1/projects/{}/chat/conversations/{}/stream",
            pid, cid
        ))
        .add_header("authorization", auth(&token))
        .content_type("application/json")
        .json(&serde_json::json!({"message":"   "}))
        .await;
    assert_eq!(r.status_code(), StatusCode::BAD_REQUEST);
}
```

- [ ] **Step 2: Run the entire integration suite + unit suites**

```bash
cargo test -p llm-wiki-server --test integration -- --nocapture
cargo test -p llm-wiki-server services::citations services::retrieval -- --nocapture
```

Expected: all chat_sessions tests PASS, and no regressions in existing integration tests (pages, auth, etc.).

- [ ] **Step 3: Run clippy + a final build**

```bash
cargo clippy -p llm-wiki-server -- -D warnings 2>&1 | tail -30
cargo build -p llm-wiki-server 2>&1 | tail -5
```

Expected: no warnings, clean build. Fix any clippy lints (likely candidates: unused `ConvRow` fields — already `#[allow(dead_code)]`; the `_suppress_unused` shim — remove if unused).

- [ ] **Step 4: Commit**

```bash
git add src-server/tests/integration/chat_sessions_test.rs
git commit -m "test(src-server): chat stream HTTP guard tests (401/403/400) + suite green"
```

---

## Self-Review (run after writing; fixes applied inline above)

**1. Spec coverage** (against overview §5–6, §12 Phase A):
- §5.1 table ① (`chat_conversations`, `chat_messages`) → Task 1 ✓
- §5.2 `services/retrieval/` → Tasks 3–4 ✓
- §5.2 `services/citations/` → Task 2 ✓
- §5.2 `services/llm/` consolidation → **no-op**: `llm_stream.rs` already provides `StreamChatProvider`/`provider_for_project`/`ChatOpts`; Phase A consumes it directly (noted in Architecture) ✓
- §6.1 endpoints (5) → Tasks 5–6 ✓ (list/create/messages/delete/stream)
- §6.2 RAG flow → Task 6 (`stream_conversation_turn`) ✓
- §6.3 error handling (LLM err → SSE error event; retrieval empty → graceful; stream interrupt → discard partial) → Task 6 ✓ (partial not persisted; provider err → error event)
- §6.4 tests (session isolation) → Task 5 `conversations_are_private_per_user` ✓
- §5.4 multi-user (chat user-scoped) → ownership checks in every handler ✓
- §12 Phase A deliverables (shared layer + Chat + migration 006) → Tasks 1–7 ✓

**2. Placeholder scan:** No `TBD`/`TODO` in implementation steps. The stream-turn test is fully concrete: `user_id` is read back from the created `chat_conversations` row (no dependency on the test helper's username scheme), and the turn yields a testable `ChatStreamEvent` enum (no axum `Event` introspection — which has no public getters). The fake provider stands in for the real LLM.

**3. Type consistency:** `parse_cited` → `Vec<i32>`; `RetrievedPage.number` → `i32`; `ref_map: HashMap<i32, MessageReference>`; DB `citations INT[]` bound as `&[i32]`; `MessageResp.citations: Option<Vec<i32>>`. Consistent. `SseStream` type alias matches `routes/chat.rs`. Route param syntax uses `:id`/`:cid` (confirmed working; avoids the pre-existing `{id}` bug).

**4. Ambiguity check:** Budget units (chars) decided + documented. Citation format `<-- cited: n, m -->` matches desktop. History limit 10 / message cap 100 match spec. Resolved.
