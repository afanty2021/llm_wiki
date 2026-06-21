# Layer 3 Phase B — 审核系统 (Review) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the review system for src-server: ingest-time REVIEW-block generation (step2 prompt + parse + a 3rd-call dedicated stage), a team-shared `review_items` queue, and `resolve` actions (`create_page`/`skip`/`delete`/`open`) — with `deep_research` deferred to Phase C.

**Architecture:** A new `services/review.rs` owns the pure parse logic, storage, the dedicated review stage, and the resolve dispatcher. `routes/reviews.rs` is a thin route layer. The ingest pipeline computes reviews in `process_source_path` (compute-only) and inserts them in `run_ingest_job` only after the page upsert loop succeeds — preserving the deferred-write invariant (no orphan reviews on upsert failure). `create_page` reuses `ingest_pipeline::upsert_wiki_page` + `embedding::embed_page`; `delete` reuses the `delete_page` SQL + `delete_embedding`.

**Tech Stack:** Rust, axum 0.7, sqlx 0.7 (PostgreSQL, `FromRow`, `ANY`/arrays), `serde_json`/`serde_yaml`, `regex`-free state-machine parsing, `async-trait`, `axum-test` 15 (integration tests against live DB on port 5433).

**Spec:** [Phase B 设计](../specs/2026-06-21-src-server-layer3-phase-b-review-design.md).

---

## File Structure

| File | Responsibility | New/Modify |
|------|----------------|-----------|
| `src-server/migrations/007_review_items.sql` | `review_items` table (team-shared) | Create |
| `src-server/src/services/review.rs` | `ReviewOption`/`ParsedReview` types, `parse_review_blocks()` (pure state machine), `normalize_review_type`/`detect_page_type`/`page_type_to_dir`/`slugify`/`count_file_blocks`, `insert_review_items()`, `should_run_dedicated_review_stage()`, `fetch_overview()`/`fetch_index_snippet()`, `run_dedicated_review_stage()` (injected provider), `resolve_review_item()` + action executors, `ResolveAction`/`ResolveOutcome`/`PageSnippet` | Create |
| `src-server/src/services/mod.rs` | `pub mod review;` | Modify |
| `src-server/src/services/prompts/step2_generate.txt` | append REVIEW-block instructions | Modify |
| `src-server/src/services/prompts/step3_review.txt` | dedicated review stage prompt | Create |
| `src-server/src/services/ingest_pipeline.rs` | `ProcessedSource.reviews`; `process_source_path` computes reviews; `run_ingest_job` inserts after upsert; `upsert_wiki_page`/`WikiPageInsert` → `pub(crate)` | Modify |
| `src-server/src/services/graph.rs` | new `pub fn invalidate_project_cache(project_id)` — delete executor clears graph cache (DELETE doesn't bump remaining rows' updated_at) | Modify |
| `src-server/src/routes/reviews.rs` | `list_reviews`/`resolve_review`/`dismiss_review` handlers + `reviews_routes()` | Create |
| `src-server/src/routes/mod.rs` | `pub mod reviews;` | Modify |
| `src-server/src/routes/projects.rs` | `.merge(reviews::reviews_routes())` | Modify |
| `src-server/tests/integration/reviews_test.rs` | parse/store/dedicated/resolve/team-visibility tests | Create |
| `src-server/tests/integration/mod.rs` | `mod reviews_test;` | Modify |

**Why `review.rs` owns everything:** parse is pure (unit-testable), the dedicated stage takes an injected `&dyn StreamChatProvider` (testable with a fake), and resolve executors reuse existing ingest/embedding functions. The ingest pipeline only adds ~10 lines (compute in `process_source_path`, insert in `run_ingest_job`).

**Deferred-write invariant (critical):** `process_source_path` is compute-only and returns `ProcessedSource`; persistence happens in `run_ingest_job` after `all_upserted` (ingest_pipeline.rs:24-26, 374-404). Reviews follow the same rule — computed in `process_source_path`, inserted in `run_ingest_job` inside `if all_upserted` — so an upsert failure leaves no orphan reviews and re-processing won't duplicate them.

---

## Task 1: Migration 007 — review_items table

**Files:**
- Create: `src-server/migrations/007_review_items.sql`

- [ ] **Step 1: Write the migration SQL**

Create `src-server/migrations/007_review_items.sql`:

```sql
-- 007_review_items.sql — Layer 3 Phase B: 审核队列（项目级团队共享）
CREATE TABLE review_items (
    id              BIGSERIAL PRIMARY KEY,
    uuid            UUID UNIQUE NOT NULL DEFAULT gen_random_uuid(),
    project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    source_path     TEXT,
    review_type     TEXT NOT NULL,
    title           TEXT NOT NULL,
    description     TEXT NOT NULL,
    affected_pages  TEXT[],
    search_queries  TEXT[],
    options         JSONB NOT NULL,
    status          TEXT NOT NULL DEFAULT 'open',
    resolved_action TEXT,
    resolved_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    resolved_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_review_open ON review_items(project_id, status, created_at);
```

- [ ] **Step 2: Apply to the test DB**

```bash
psql -h localhost -p 5433 -U llmwiki -d llmwiki -f src-server/migrations/007_review_items.sql
```

Expected: `CREATE TABLE`, `CREATE INDEX`, no errors. (Password in `config/default.json` / `.env`; use `PGPASSWORD=... psql ...` if prompted.)

- [ ] **Step 3: Verify**

```bash
psql -h localhost -p 5433 -U llmwiki -d llmwiki -c "\d review_items"
```

Expected columns: `id, uuid, project_id, source_path, review_type, title, description, affected_pages, search_queries, options, status, resolved_action, resolved_by, resolved_at, created_at`.

- [ ] **Step 4: Commit**

```bash
git add src-server/migrations/007_review_items.sql
git commit -m "feat(src-server): 007 migration — review_items (team-shared review queue)"
```

---

## Task 2: review.rs — parse_review_blocks + pure helpers (TDD)

**Files:**
- Create: `src-server/src/services/review.rs`
- Modify: `src-server/src/services/mod.rs` (add `pub mod review;`)

- [ ] **Step 1: Register the module**

In `src-server/src/services/mod.rs`, append:

```rust
pub mod review;
```

- [ ] **Step 2: Write review.rs with types + pure functions + tests**

Create `src-server/src/services/review.rs`:

```rust
//! Layer 3 Phase B — 审核系统：REVIEW 块解析（纯）、存储、dedicated review stage、resolve。
//!
//! 纯函数（parse/helpers）在此文件内单测；async 编排（insert/dedicated/resolve）
//! 由集成测试覆盖。ingest pipeline 调 parse_review_blocks/run_dedicated_review_stage
//! 计算，run_ingest_job 落库（守 deferred-write 不变量）。

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewOption {
    pub label: String,
    pub action: String,
}

#[derive(Debug, Clone)]
pub struct ParsedReview {
    pub review_type: String, // normalized: contradiction|duplicate|missing-page|confirm|suggestion
    pub title: String,
    pub description: String,
    pub source_path: Option<String>,
    pub affected_pages: Option<Vec<String>>,
    pub search_queries: Option<Vec<String>>,
    pub options: Vec<ReviewOption>,
}

/// Normalize the raw REVIEW type tag. Unknown → "confirm".
fn normalize_review_type(raw: &str) -> String {
    match raw.trim().to_lowercase().as_str() {
        "contradiction" | "duplicate" | "missing-page" | "suggestion" => raw.trim().to_lowercase(),
        _ => "confirm".to_string(),
    }
}

/// Parse `---REVIEW: type | Title--- ... ---END REVIEW---` blocks.
/// Line-based state machine, code-fence aware (mirrors parse_file_blocks).
pub fn parse_review_blocks(text: &str, source_path: &str) -> Vec<ParsedReview> {
    let text = text.replace("\r\n", "\n");
    let mut out: Vec<ParsedReview> = Vec::new();
    let mut in_block = false;
    let mut cur_type = String::new();
    let mut cur_title = String::new();
    let mut cur_body = String::new();
    let mut in_fence = false;
    let mut fence_char = ' ';

    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            let ch = trimmed.chars().next().unwrap();
            if !in_fence {
                in_fence = true;
                fence_char = ch;
            } else if ch == fence_char {
                in_fence = false;
            }
        }
        if !in_fence {
            if let Some(rest) = trimmed.strip_prefix("---REVIEW:") {
                if let Some(hdr) = rest.strip_suffix("---") {
                    if in_block {
                        out.push(build_review(&cur_type, &cur_title, &cur_body, source_path));
                        cur_body.clear();
                    }
                    if let Some((t, title)) = hdr.split_once('|') {
                        cur_type = t.trim().to_string();
                        cur_title = title.trim().to_string();
                    } else {
                        cur_type.clear();
                        cur_title = hdr.trim().to_string();
                    }
                    cur_body.clear();
                    in_block = true;
                    continue;
                }
            }
            if trimmed == "---END REVIEW---" && in_block {
                out.push(build_review(&cur_type, &cur_title, &cur_body, source_path));
                in_block = false;
                cur_body.clear();
                cur_type.clear();
                cur_title.clear();
                continue;
            }
        }
        if in_block {
            cur_body.push_str(line);
            cur_body.push('\n');
        }
    }
    if in_block {
        out.push(build_review(&cur_type, &cur_title, &cur_body, source_path));
    }
    out
}

fn build_review(raw_type: &str, title: &str, body: &str, source_path: &str) -> ParsedReview {
    let review_type = normalize_review_type(raw_type);
    let options = parse_options_line(body);
    let affected_pages = parse_list_field(body, "PAGES:", ',');
    let search_queries = parse_list_field(body, "SEARCH:", '|');
    let description: String = body
        .lines()
        .map(|l| l.trim())
        .filter(|l| {
            !l.starts_with("OPTIONS:") && !l.starts_with("PAGES:") && !l.starts_with("SEARCH:")
        })
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string();
    ParsedReview {
        review_type,
        title: title.to_string(),
        description,
        source_path: Some(source_path.to_string()),
        affected_pages,
        search_queries,
        options,
    }
}

fn parse_options_line(body: &str) -> Vec<ReviewOption> {
    for line in body.lines() {
        let l = line.trim();
        if let Some(rest) = l.strip_prefix("OPTIONS:") {
            let opts: Vec<ReviewOption> = rest
                .split('|')
                .map(|o| {
                    let label = o.trim().to_string();
                    ReviewOption { label: label.clone(), action: label }
                })
                .filter(|o| !o.label.is_empty())
                .collect();
            return opts;
        }
    }
    vec![
        ReviewOption { label: "Create Page".into(), action: "Create Page".into() },
        ReviewOption { label: "Skip".into(), action: "Skip".into() },
    ]
}

fn parse_list_field(body: &str, key: &str, sep: char) -> Option<Vec<String>> {
    for line in body.lines() {
        let l = line.trim();
        if let Some(rest) = l.strip_prefix(key) {
            let v: Vec<String> = rest
                .split(sep)
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
            return if v.is_empty() { None } else { Some(v) };
        }
    }
    None
}

/// Singular page_type (frontmatter `type:` + wiki_pages.page_type) from review_type.
pub fn detect_page_type(review_type: &str) -> &'static str {
    match review_type {
        "missing-page" => "concept",
        "contradiction" | "suggestion" => "query",
        _ => "query",
    }
}

/// Plural directory (server convention: plural dir + singular page_type).
pub fn page_type_to_dir(page_type: &str) -> &'static str {
    match page_type {
        "entity" => "entities",
        "concept" => "concepts",
        _ => "queries",
    }
}

/// Lowercase, spaces/dashes → '-' (collapsing consecutive separators), drop other
/// non-alphanumerics, trim leading/trailing '-'.
pub fn slugify(title: &str) -> String {
    let mut out = String::new();
    let mut prev_dash = false;
    for c in title.trim().to_lowercase().chars() {
        if c.is_alphanumeric() {
            out.push(c);
            prev_dash = false;
        } else if (c == ' ' || c == '-') && !prev_dash && !out.is_empty() {
            out.push('-');
            prev_dash = true;
        }
    }
    out.trim_matches('-').to_string()
}

/// Count FILE blocks (by `---END FILE---` markers).
pub fn count_file_blocks(text: &str) -> usize {
    text.lines().filter(|l| l.trim() == "---END FILE---").count()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_single_block_with_all_fields() {
        let text = "---REVIEW: suggestion | Add Rust ownership page---\n\
                    The wiki mentions ownership but has no page.\n\
                    OPTIONS: Create Page | Skip\n\
                    PAGES: wiki/concepts/rust.md, wiki/sources/rust-book.md\n\
                    SEARCH: rust ownership | rust borrowing rules | rust lifetimes\n\
                    ---END REVIEW---";
        let r = parse_review_blocks(text, "src.md");
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].review_type, "suggestion");
        assert_eq!(r[0].title, "Add Rust ownership page");
        assert_eq!(r[0].options.len(), 2);
        assert_eq!(r[0].options[0].label, "Create Page");
        assert_eq!(r[0].options[1].label, "Skip");
        assert_eq!(r[0].affected_pages.as_deref(), Some(&["wiki/concepts/rust.md".to_string(), "wiki/sources/rust-book.md".to_string()][..]));
        assert_eq!(r[0].search_queries.as_deref().unwrap().len(), 3);
        assert!(r[0].description.contains("mentions ownership"));
        assert!(!r[0].description.contains("OPTIONS:"));
        assert_eq!(r[0].source_path.as_deref(), Some("src.md"));
    }

    #[test]
    fn normalizes_unknown_type_to_confirm() {
        let text = "---REVIEW: weirdtype | T---\ndesc\n---END REVIEW---";
        let r = parse_review_blocks(text, "");
        assert_eq!(r[0].review_type, "confirm");
    }

    #[test]
    fn defaults_options_when_missing() {
        let text = "---REVIEW: contradiction | T---\ndesc\n---END REVIEW---";
        let r = parse_review_blocks(text, "");
        assert_eq!(r[0].options.len(), 2);
        assert_eq!(r[0].options[0].label, "Create Page");
        assert_eq!(r[0].options[1].label, "Skip");
    }

    #[test]
    fn parses_multiple_blocks() {
        let text = "---REVIEW: duplicate | A---\nx\n---END REVIEW---\nmid\n---REVIEW: missing-page | B---\ny\n---END REVIEW---";
        let r = parse_review_blocks(text, "");
        assert_eq!(r.len(), 2);
        assert_eq!(r[0].title, "A");
        assert_eq!(r[1].review_type, "missing-page");
    }

    #[test]
    fn ignores_review_marker_inside_code_fence() {
        let text = "```\n---REVIEW: suggestion | fenced---\nx\n---END REVIEW---\n```\n---REVIEW: suggestion | real---\ny\n---END REVIEW---";
        let r = parse_review_blocks(text, "");
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].title, "real");
    }

    #[test]
    fn detect_page_type_and_dir() {
        assert_eq!(detect_page_type("missing-page"), "concept");
        assert_eq!(detect_page_type("contradiction"), "query");
        assert_eq!(detect_page_type("suggestion"), "query");
        assert_eq!(detect_page_type("confirm"), "query");
        assert_eq!(page_type_to_dir("concept"), "concepts");
        assert_eq!(page_type_to_dir("query"), "queries");
        assert_eq!(page_type_to_dir("entity"), "entities");
    }

    #[test]
    fn slugify_basic() {
        assert_eq!(slugify("Rust Ownership!"), "rust-ownership");
        assert_eq!(slugify("  Multi  Word  "), "multi-word");
        assert_eq!(slugify("已有页"), "已有页"); // CJK alphanumeric preserved
        assert_eq!(slugify("---"), "");
    }

    #[test]
    fn count_file_blocks_counts_end_markers() {
        assert_eq!(count_file_blocks("---FILE: a.md ---\nx\n---END FILE---\n---FILE: b.md ---\ny\n---END FILE---"), 2);
        assert_eq!(count_file_blocks("no blocks"), 0);
    }
}
```

- [ ] **Step 3: Run the unit tests**

```bash
cargo test -p llm-wiki-server services::review -- --nocapture
```

Expected: 8 tests PASS.

- [ ] **Step 4: Commit**

```bash
git add src-server/src/services/review.rs src-server/src/services/mod.rs
git commit -m "feat(src-server): review::parse_review_blocks + pure helpers (TDD)"
```

---

## Task 3: insert_review_items + ingest deferred-write hook (step2 reviews)

**Files:**
- Modify: `src-server/src/services/review.rs` (add `insert_review_items`)
- Modify: `src-server/src/services/prompts/step2_generate.txt` (append REVIEW instructions)
- Modify: `src-server/src/services/ingest_pipeline.rs` (`ProcessedSource.reviews`, `process_source_path` computes, `run_ingest_job` inserts, `pub(crate)` exports)
- Modify: `src-server/tests/integration/mod.rs` (`mod reviews_test;`)
- Create: `src-server/tests/integration/reviews_test.rs` (insert + parse-from-ingest tests)

- [ ] **Step 1: Append `insert_review_items` to review.rs**

Add to `src-server/src/services/review.rs` (after the helpers, before `#[cfg(test)]`):

```rust
use crate::{AppState, AppError};

/// Bulk-insert parsed reviews for a project. Returns count inserted.
pub async fn insert_review_items(
    state: &AppState,
    project_id: i32,
    items: &[ParsedReview],
) -> Result<usize, AppError> {
    if items.is_empty() {
        return Ok(0);
    }
    let mut count = 0usize;
    for r in items {
        let options_json = serde_json::to_value(&r.options).unwrap_or(serde_json::json!([]));
        sqlx::query(
            "INSERT INTO review_items \
             (uuid, project_id, source_path, review_type, title, description, affected_pages, search_queries, options) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
        )
        .bind(uuid::Uuid::new_v4())
        .bind(project_id)
        .bind(r.source_path.as_deref())
        .bind(&r.review_type)
        .bind(&r.title)
        .bind(&r.description)
        .bind(r.affected_pages.as_deref())
        .bind(r.search_queries.as_deref())
        .bind(options_json)
        .execute(&state.db)
        .await?;
        count += 1;
    }
    Ok(count)
}
```

- [ ] **Step 2: Append REVIEW-block instructions to step2_generate.txt**

Append to `src-server/src/services/prompts/step2_generate.txt`:

```text

## Review blocks (optional, after all FILE blocks)

After all FILE blocks, optionally emit REVIEW blocks for anything needing human judgment.

Review types:
- contradiction: analysis found conflicts with existing wiki content
- duplicate: an entity/concept may already exist under a different name
- missing-page: an important concept is referenced but has no dedicated page
- suggestion: ideas for further research or connections worth exploring

Only emit reviews that genuinely need human input. Don't create trivial reviews.

OPTIONS: only use "Create Page" and "Skip" (the system adds a Deep Research action automatically).
For suggestion/missing-page, include a SEARCH line with 2-3 keyword-rich web search queries.

REVIEW block template:
---REVIEW: suggestion | Precise title---
Description of what needs the user's attention.
OPTIONS: Create Page | Skip
PAGES: wiki/page1.md, wiki/page2.md
SEARCH: query 1 | query 2 | query 3
---END REVIEW---
```

- [ ] **Step 3: Make upsert_wiki_page + WikiPageInsert pub(crate)**

In `src-server/src/services/ingest_pipeline.rs`:

Change `struct WikiPageInsert {` (line ~18) to:
```rust
pub(crate) struct WikiPageInsert {
    pub(crate) path: String,
    pub(crate) title: Option<String>,
    pub(crate) content: String,
    pub(crate) frontmatter: serde_json::Value,
    pub(crate) page_type: String,
    pub(crate) sources: serde_json::Value,
    pub(crate) images: serde_json::Value,
}
```

Change `async fn upsert_wiki_page(` (line ~539) to `pub(crate) async fn upsert_wiki_page(`.

- [ ] **Step 4: Add `reviews` to ProcessedSource + compute in process_source_path**

In `src-server/src/services/ingest_pipeline.rs`, change the `ProcessedSource` struct (line ~27) to:
```rust
struct ProcessedSource {
    pages: Vec<WikiPageInsert>,
    reviews: Vec<crate::services::review::ParsedReview>,
    content_hash: String,
    file_size: i64,
    file_type: String,
}
```

In `process_source_path` (line ~512-529), replace:
```rust
    let llm_output = step2_generate(state, project_id, &text, &step1_result).await?;
    let blocks = parse_file_blocks(&llm_output);
    let pages: Vec<WikiPageInsert> = blocks
        .into_iter()
        .map(|b| WikiPageInsert {
            path: b.path,
            title: b.title,
            content: b.content,
            frontmatter: b.frontmatter,
            page_type: b.page_type,
            sources: b.sources,
            images: b.images,
        })
        .collect();

    // 不在此 mark_file_ingested：content_hash/file_size/file_type 上浮给 run_ingest_job，
    // 待 wiki_pages 成功落库后再 mark（避免 mark 成功但 upsert 失败 → 下次因 hash 命中被永久跳过的漏页问题）。
    Ok(Some(ProcessedSource { pages, content_hash, file_size, file_type }))
```
with:
```rust
    let llm_output = step2_generate(state, project_id, &text, &step1_result).await?;
    let blocks = parse_file_blocks(&llm_output);
    let pages: Vec<WikiPageInsert> = blocks
        .into_iter()
        .map(|b| WikiPageInsert {
            path: b.path,
            title: b.title,
            content: b.content,
            frontmatter: b.frontmatter,
            page_type: b.page_type,
            sources: b.sources,
            images: b.images,
        })
        .collect();

    // Phase B: 计算 review（compute-only，无 DB 写）。dedicated stage 由 Task 4 追加。
    let reviews = crate::services::review::parse_review_blocks(&llm_output, source_path);

    // 不在此 mark_file_ingested / insert reviews：元数据 + reviews 上浮给 run_ingest_job，
    // 待 wiki_pages 成功落库后再 mark + insert（守 deferred-write 不变量：upsert 失败 →
    // 不 mark → 下次重处理；不插 review → 无孤儿/重复）。
    Ok(Some(ProcessedSource { pages, reviews, content_hash, file_size, file_type }))
```

- [ ] **Step 5: Insert reviews in run_ingest_job after the upsert loop succeeds**

In `src-server/src/services/ingest_pipeline.rs`, locate the `if all_upserted {` block (line ~391-404):
```rust
                if all_upserted {
                    if let Err(e) = mark_file_ingested(
                        state,
                        job.project_id,
                        sp,
                        &processed.content_hash,
                        processed.file_size,
                        &processed.file_type,
                    )
                    .await
                    {
                        result.warnings.push(format!("mark ingested {}: {}", sp, e));
                    }
                }
```
Add the review insert inside this block, after the `mark_file_ingested` match:
```rust
                if all_upserted {
                    if let Err(e) = mark_file_ingested(
                        state,
                        job.project_id,
                        sp,
                        &processed.content_hash,
                        processed.file_size,
                        &processed.file_type,
                    )
                    .await
                    {
                        result.warnings.push(format!("mark ingested {}: {}", sp, e));
                    }
                    // Phase B: 页落库 + mark 成功后才插 review（守 deferred-write 不变量）
                    if !processed.reviews.is_empty() {
                        if let Err(e) = crate::services::review::insert_review_items(
                            state,
                            job.project_id,
                            &processed.reviews,
                        )
                        .await
                        {
                            result.warnings.push(format!("insert reviews for {}: {}", sp, e));
                        }
                    }
                }
```

- [ ] **Step 6: Build**

```bash
cargo build -p llm-wiki-server 2>&1 | tail -20
```

Expected: clean build. (`ProcessedSource` is private to ingest_pipeline; adding a field is internal.)

- [ ] **Step 7: Register the test module + write insert_review_items test**

In `src-server/tests/integration/mod.rs`, add:
```rust
mod reviews_test;
```

Create `src-server/tests/integration/reviews_test.rs`:
```rust
use axum::http::StatusCode;
use std::sync::atomic::{AtomicU64, Ordering};

static COUNTER: AtomicU64 = AtomicU64::new(0);

fn unique_prefix(tag: &str) -> String {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    format!("{}_{}_{}", tag, std::process::id(), n)
}

async fn setup_project(tag: &str) -> (axum_test::TestServer, llm_wiki_server::AppState, i32, String) {
    let (app, state) = crate::setup_test_app().await;
    let server = axum_test::TestServer::new(app).unwrap();
    let username = unique_prefix(tag);
    let token = crate::register_user(&server, &username, &format!("{}@t.com", username), "password123").await;
    let team_id: i32 = sqlx::query_scalar(
        "SELECT id FROM teams WHERE created_by = (SELECT id FROM users WHERE username = $1)",
    )
    .bind(&username).fetch_one(&state.db).await.unwrap();
    let resp = server.post("/api/v1/projects")
        .add_header("authorization", format!("Bearer {}", token))
        .json(&serde_json::json!({"name":"test-proj","team_id":team_id})).await;
    assert_eq!(resp.status_code(), StatusCode::CREATED);
    let project_id = resp.json::<serde_json::Value>()["id"].as_i64().unwrap() as i32;
    (server, state, project_id, token)
}

fn auth(token: &str) -> String { format!("Bearer {}", token) }

use llm_wiki_server::services::review::{parse_review_blocks, insert_review_items};

#[tokio::test]
async fn insert_review_items_stores_rows() {
    let (_server, state, pid, _token) = setup_project("rev-insert").await;
    let llm_out = "---REVIEW: suggestion | Add X---\nThe wiki lacks X.\nOPTIONS: Create Page | Skip\nSEARCH: x basics | x tutorial\n---END REVIEW---\n---REVIEW: contradiction | Y vs Z---\nY conflicts with Z.\n---END REVIEW---";
    let parsed = parse_review_blocks(llm_out, "sources/doc.md");
    assert_eq!(parsed.len(), 2);
    let n = insert_review_items(&state, pid, &parsed).await.unwrap();
    assert_eq!(n, 2);

    let rows: Vec<(String, String, Option<String>)> = sqlx::query_as(
        "SELECT review_type, title, source_path FROM review_items WHERE project_id=$1 ORDER BY title",
    )
    .bind(pid).fetch_all(&state.db).await.unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].0, "suggestion");
    assert_eq!(rows[0].1, "Add X");
    assert_eq!(rows[0].2.as_deref(), Some("sources/doc.md"));
    assert_eq!(rows[1].0, "contradiction");
}

#[tokio::test]
async fn parse_handles_realistic_step2_output() {
    // step2 output with FILE blocks + a trailing REVIEW block
    let out = "---FILE: concepts/foo.md ---\n---\ntitle: Foo\ntype: concept\n---\n# Foo\nbody\n---END FILE---\n---REVIEW: missing-page | Add Bar---\nBar referenced but missing.\nOPTIONS: Create Page | Skip\nPAGES: wiki/concepts/bar.md\n---END REVIEW---";
    let r = parse_review_blocks(out, "src.md");
    assert_eq!(r.len(), 1);
    assert_eq!(r[0].review_type, "missing-page");
    assert_eq!(r[0].affected_pages.as_deref().unwrap(), &["wiki/concepts/bar.md"]);
}
```

- [ ] **Step 8: Run the tests**

```bash
cargo test -p llm-wiki-server --test integration reviews_test -- --nocapture
```

Expected: 2 tests PASS.

- [ ] **Step 9: Commit**

```bash
git add src-server/src/services/review.rs src-server/src/services/prompts/step2_generate.txt src-server/src/services/ingest_pipeline.rs src-server/tests/integration/mod.rs src-server/tests/integration/reviews_test.rs
git commit -m "feat(src-server): review generation hook (deferred-write) + step2 REVIEW prompt"
```

---

## Task 4: Dedicated review stage (3rd LLM call)

**Files:**
- Create: `src-server/src/services/prompts/step3_review.txt`
- Modify: `src-server/src/services/review.rs` (`should_run_dedicated_review_stage`, `fetch_overview`, `fetch_index_snippet`, `run_dedicated_review_stage`)
- Modify: `src-server/src/services/ingest_pipeline.rs` (`process_source_path` runs dedicated + dedup)
- Modify: `src-server/tests/integration/reviews_test.rs` (dedicated-stage test with FakeProvider)

- [ ] **Step 1: Create the dedicated-review prompt**

Create `src-server/src/services/prompts/step3_review.txt`:

```text
You are identifying high-value follow-up research items for a personal wiki.
Do not output chain-of-thought, hidden reasoning, or explanatory preamble.

Your job is NOT to generate wiki pages. Generation already happened.
Output only REVIEW blocks for unresolved knowledge gaps that deserve human attention.

Create REVIEW blocks only for genuinely useful follow-up work:
- missing-page: an important entity/concept referenced but lacking a dedicated page
- suggestion: a research question, source type, or comparison that would materially improve the wiki
- contradiction: a conflict or tension requiring user judgment
- duplicate: likely duplicate pages/names needing review

Prefer 1-5 high-signal reviews. If nothing is worth reviewing, output nothing.
For suggestion/missing-page, include a SEARCH line with 2-3 keyword-rich web queries separated by ` | `.
Use only: OPTIONS: Create Page | Skip

REVIEW block template:
---REVIEW: suggestion | Precise title---
Concise description of the gap and why it matters.
OPTIONS: Create Page | Skip
PAGES: wiki/page1.md, wiki/page2.md
SEARCH: query 1 | query 2 | query 3
---END REVIEW---

Return REVIEW blocks only. No FILE blocks. Do not wrap in markdown fences.
```

- [ ] **Step 2: Add dedicated-stage functions to review.rs**

Append to `src-server/src/services/review.rs`:
```rust
use crate::services::llm_stream::{ChatMessage, ChatOpts, StreamChatProvider};

const REVIEW_STAGE_MIN_SIGNAL_CHARS: usize = 10_000;
const REVIEW_STAGE_MIN_FILE_BLOCKS: usize = 4;

pub fn should_run_dedicated_review_stage(generation: &str) -> bool {
    generation.chars().count() >= REVIEW_STAGE_MIN_SIGNAL_CHARS
        || count_file_blocks(generation) >= REVIEW_STAGE_MIN_FILE_BLOCKS
        || generation.contains("---REVIEW:")
}

async fn fetch_overview(state: &AppState, project_id: i32) -> Option<String> {
    sqlx::query_scalar::<_, Option<String>>(
        "SELECT content FROM wiki_pages WHERE project_id = $1 AND path = 'wiki/overview.md'",
    )
    .bind(project_id)
    .fetch_optional(&state.db)
    .await
    .ok()
    .flatten()
    .flatten()
}

async fn fetch_index_snippet(state: &AppState, project_id: i32) -> String {
    sqlx::query_scalar::<_, Option<String>>(
        "SELECT content FROM wiki_pages WHERE project_id = $1 AND path = 'wiki/index.md'",
    )
    .bind(project_id)
    .fetch_optional(&state.db)
    .await
    .ok()
    .flatten()
    .flatten()
    .unwrap_or_default()
}

fn trim_to(s: &str, max: usize) -> String {
    if s.chars().count() > max {
        s.chars().take(max).collect()
    } else {
        s.to_string()
    }
}

/// 3rd-call dedicated review stage. `provider` is injected so tests can use a fake.
/// Returns empty vec if the trigger condition is not met.
pub async fn run_dedicated_review_stage(
    state: &AppState,
    project_id: i32,
    source_path: &str,
    source_text: &str,
    step1_json: &serde_json::Value,
    step2_output: &str,
    provider: &dyn StreamChatProvider,
) -> Result<Vec<ParsedReview>, AppError> {
    if !should_run_dedicated_review_stage(step2_output) {
        return Ok(vec![]);
    }
    let purpose = fetch_overview(state, project_id).await.unwrap_or_default();
    let index = fetch_index_snippet(state, project_id).await;
    let prompt = include_str!("prompts/step3_review.txt");
    let analysis = serde_json::to_string_pretty(step1_json).unwrap_or_default();
    let user = format!(
        "{prompt}\n\n## Wiki Purpose\n{purpose}\n\n## Current Wiki Index\n{index}\n\n## Source\n{src}\n\n## Stage 1 Analysis\n{a}\n\n## Source Context\n{ctx}\n\n## Generated Wiki Output\n{gen}",
        src = source_path,
        a = trim_to(&analysis, 6000),
        ctx = trim_to(source_text, 6000),
        gen = trim_to(step2_output, 6000),
    );
    let messages = vec![ChatMessage { role: "user".into(), content: user }];
    let opts = ChatOpts {
        model: provider.model_name().to_string(),
        temperature: 0.4,
        max_tokens: 8000,
        system_prompt: Some(
            "You identify high-value follow-up review items. Output REVIEW blocks only.".into(),
        ),
        timeout_secs: None,
    };
    let (out, _) = provider
        .chat_to_string(messages, opts)
        .await
        .map_err(|e| AppError::LlmApiError(format!("dedicated review stage: {e}")))?;
    Ok(parse_review_blocks(&out, source_path))
}
```

Also add `should_run_dedicated_review_stage` unit tests inside the existing `#[cfg(test)] mod tests` block in review.rs:
```rust
    #[test]
    fn dedicated_stage_trigger_thresholds() {
        assert!(!should_run_dedicated_review_stage("short"));
        // length threshold
        let long = "x".repeat(10_000);
        assert!(should_run_dedicated_review_stage(&long));
        // file-block threshold
        let many_blocks = "---END FILE---\n".repeat(4);
        assert!(should_run_dedicated_review_stage(&many_blocks));
        // explicit REVIEW marker
        assert!(should_run_dedicated_review_stage("---REVIEW: suggestion | T---\nx\n---END REVIEW---"));
    }
```

- [ ] **Step 3: Wire the dedicated stage into process_source_path (merge + dedup)**

In `src-server/src/services/ingest_pipeline.rs` `process_source_path`, replace the Task-3 line:
```rust
    // Phase B: 计算 review（compute-only，无 DB 写）。dedicated stage 由 Task 4 追加。
    let reviews = crate::services::review::parse_review_blocks(&llm_output, source_path);
```
with:
```rust
    // Phase B: 计算 review（compute-only，无 DB 写）= step2 解析 + 3rd-call dedicated stage。
    let mut reviews = crate::services::review::parse_review_blocks(&llm_output, source_path);
    match crate::services::llm_stream::provider_for_project(state, project_id).await {
        Ok(provider) => {
            match crate::services::review::run_dedicated_review_stage(
                state,
                project_id,
                source_path,
                &text,
                &step1_result,
                &llm_output,
                &*provider,
            )
            .await
            {
                Ok(ded) => reviews.extend(ded),
                Err(e) => tracing::warn!("dedicated review stage failed for {}: {}", source_path, e),
            }
        }
        Err(e) => tracing::warn!("provider for dedicated review stage ({}): {}", source_path, e),
    }
    // 批内按 (review_type, title) 去重，避免 step2 与 dedicated 重复
    let mut seen = std::collections::HashSet::new();
    reviews.retain(|r| seen.insert((r.review_type.clone(), r.title.clone())));
```

- [ ] **Step 4: Build + run review unit tests**

```bash
cargo build -p llm-wiki-server 2>&1 | tail -20
cargo test -p llm-wiki-server services::review -- --nocapture
```

Expected: clean build; the new `dedicated_stage_trigger_thresholds` test passes (9 review tests total).

- [ ] **Step 5: Add a dedicated-stage integration test with a fake provider**

Append to `src-server/tests/integration/reviews_test.rs`:
```rust
use futures::stream::{BoxStream, StreamExt};
use llm_wiki_server::services::llm_stream::{ChatMessage, ChatOpts, LlmError, StreamChatProvider, TokenDelta};
use llm_wiki_server::services::review::{run_dedicated_review_stage, should_run_dedicated_review_stage};

struct FakeReviewProvider { reply: String }
#[async_trait::async_trait]
impl StreamChatProvider for FakeReviewProvider {
    async fn stream_chat(
        &self, _messages: Vec<ChatMessage>, _opts: ChatOpts,
    ) -> Result<BoxStream<'static, Result<TokenDelta, LlmError>>, LlmError> {
        let reply = self.reply.clone();
        let s = async_stream::stream! {
            yield Ok(TokenDelta::Text(reply));
            yield Ok(TokenDelta::Done);
        };
        Ok(Box::pin(s))
    }
    fn provider_type(&self) -> &'static str { "fake" }
    fn model_name(&self) -> &str { "fake" }
}

#[tokio::test]
async fn dedicated_stage_parses_provider_output() {
    let (_server, state, pid, _token) = setup_project("rev-dedicated").await;
    // a step2 output long enough to trigger + containing a REVIEW marker
    let step2 = format!("---REVIEW: suggestion | From Step2---\nx\n---END REVIEW---\n{}", "y".repeat(10_000));
    assert!(should_run_dedicated_review_stage(&step2));

    let provider = FakeReviewProvider {
        reply: "---REVIEW: missing-page | From Dedicated---\nA gap.\nOPTIONS: Create Page | Skip\nSEARCH: gap query\n---END REVIEW---".into(),
    };
    let step1 = serde_json::json!({"entities":[],"connections":[],"contradictions":[]});
    let out = run_dedicated_review_stage(&state, pid, "sources/doc.md", "source text", &step1, &step2, &provider).await.unwrap();
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].review_type, "missing-page");
    assert_eq!(out[0].title, "From Dedicated");
}

#[tokio::test]
async fn dedicated_stage_skips_below_threshold() {
    let (_server, state, pid, _token) = setup_project("rev-skip").await;
    let step2 = "short output, no review"; // below all thresholds
    let provider = FakeReviewProvider { reply: "---REVIEW: suggestion | Should Not Happen---\nx\n---END REVIEW---".into() };
    let step1 = serde_json::json!({});
    let out = run_dedicated_review_stage(&state, pid, "src.md", "t", &step1, step2, &provider).await.unwrap();
    assert!(out.is_empty());
}
```

> Note: `run_dedicated_review_stage` + `should_run_dedicated_review_stage` are `pub` in `services/review.rs` (the dedicated stage lives there, not in `llm_stream`); the test imports them from `services::review` and the `StreamChatProvider`/token types from `services::llm_stream`.

- [ ] **Step 6: Run dedicated-stage tests**

```bash
cargo test -p llm-wiki-server --test integration reviews_test -- --nocapture
```

Expected: all reviews_test tests PASS (insert + parse + 2 dedicated).

- [ ] **Step 7: Commit**

```bash
git add src-server/src/services/prompts/step3_review.txt src-server/src/services/review.rs src-server/src/services/ingest_pipeline.rs src-server/tests/integration/reviews_test.rs
git commit -m "feat(src-server): dedicated review stage (3rd LLM) + merge dedup in ingest"
```

---

## Task 5: reviews routes + resolve_review_item + action executors

**Files:**
- Modify: `src-server/src/services/review.rs` (`ResolveAction`, `ResolveOutcome`, `PageSnippet`, `LoadedItem`, `resolve_review_item`, executors, `mark_resolved`, `load_open_item`)
- Modify: `src-server/src/services/graph.rs` (new `pub fn invalidate_project_cache`)
- Create: `src-server/src/routes/reviews.rs` (`list_reviews`, `resolve_review`, `dismiss_review`, `reviews_routes`)
- Modify: `src-server/src/routes/mod.rs` (`pub mod reviews;`)
- Modify: `src-server/src/routes/projects.rs` (`.merge(reviews::reviews_routes())`)
- Modify: `src-server/tests/integration/reviews_test.rs` (resolve/dismiss/visibility tests)

- [ ] **Step 1: Add resolve types + dispatcher + executors to review.rs**

Append to `src-server/src/services/review.rs`:
```rust
// (Deserialize is already in scope from Task 2's `use serde::{Deserialize, Serialize};`.)
#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum ResolveAction {
    CreatePage,
    Skip,
    Delete { path: Option<String> },
    Open { path: Option<String> },
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageSnippet {
    pub path: String,
    pub title: String,
    pub content: String,
}

#[derive(Debug, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum ResolveOutcome {
    Resolved { resolved_action: String, created_path: Option<String> },
    Opened { page: PageSnippet },
}

#[derive(sqlx::FromRow)]
struct LoadedItem {
    id: i64,
    review_type: String,
    title: String,
    description: String,
    affected_pages: Option<Vec<String>>,
    #[allow(dead_code)]
    search_queries: Option<Vec<String>>,
    status: String,
}

async fn load_open_item(
    state: &AppState,
    project_id: i32,
    item_id: i64,
) -> Result<LoadedItem, AppError> {
    let row: Option<LoadedItem> = sqlx::query_as(
        "SELECT id, review_type, title, description, affected_pages, search_queries, status \
         FROM review_items WHERE id = $1 AND project_id = $2",
    )
    .bind(item_id)
    .bind(project_id)
    .fetch_optional(&state.db)
    .await?;
    match row {
        None => Err(AppError::ResourceNotFound("review item".into())),
        Some(item) if item.status != "open" => Err(AppError::Conflict("review item not open".into())),
        Some(item) => Ok(item),
    }
}

async fn mark_resolved(
    state: &AppState,
    item_id: i64,
    action: &str,
    user_id: i32,
) -> Result<(), AppError> {
    let n = sqlx::query(
        "UPDATE review_items SET status='resolved', resolved_action=$1, resolved_by=$2, resolved_at=NOW() \
         WHERE id=$3 AND status='open'",
    )
    .bind(action)
    .bind(user_id)
    .bind(item_id)
    .execute(&state.db)
    .await?;
    if n.rows_affected() == 0 {
        return Err(AppError::Conflict("review item not open (race)".into()));
    }
    Ok(())
}

async fn exec_create_page(
    state: &AppState,
    project_id: i32,
    item: &LoadedItem,
) -> Result<String, AppError> {
    let pt = detect_page_type(&item.review_type);
    let dir = page_type_to_dir(pt);
    let slug = {
        let s = slugify(&item.title);
        if s.is_empty() { "untitled".to_string() } else { s }
    };
    // unique path (append -2, -3, ... on collision; avoid overwriting existing pages)
    let mut path = format!("wiki/{}.md", trim_path(dir, &slug));
    let mut n = 2;
    loop {
        let exists: Option<i64> =
            sqlx::query_scalar("SELECT 1 FROM wiki_pages WHERE project_id=$1 AND path=$2")
                .bind(project_id)
                .bind(&path)
                .fetch_optional(&state.db)
                .await?;
        if exists.is_none() {
            break;
        }
        path = format!("wiki/{}-{}.md", trim_path(dir, &slug), n);
        n += 1;
    }
    let frontmatter = serde_json::json!({ "type": pt, "title": &item.title, "sources": [] });
    let content = format!("# {}\n\n{}", item.title, item.description);
    let page = crate::services::ingest_pipeline::WikiPageInsert {
        path: path.clone(),
        title: Some(item.title.clone()),
        content,
        frontmatter,
        page_type: pt.to_string(),
        sources: serde_json::json!([]),
        images: serde_json::json!([]),
    };
    crate::services::ingest_pipeline::upsert_wiki_page(state, project_id, &page).await?;
    // best-effort embedding (failure logged, does not block resolve)
    if let Err(e) = crate::services::embedding::embed_page(
        &state.db,
        state.config.embedding.as_ref(),
        &state.http,
        project_id,
        &path,
        &page.content,
    )
    .await
    {
        tracing::warn!("embed review-created page {}: {}", path, e);
    }
    Ok(path)
}

fn trim_path(dir: &str, slug: &str) -> String {
    format!("{}/{}", dir, slug)
}

async fn exec_delete_page(
    state: &AppState,
    project_id: i32,
    path: &str,
) -> Result<(), AppError> {
    let n = sqlx::query("DELETE FROM wiki_pages WHERE project_id=$1 AND path=$2")
        .bind(project_id)
        .bind(path)
        .execute(&state.db)
        .await?;
    if n.rows_affected() == 0 {
        return Err(AppError::ResourceNotFound("page".into()));
    }
    let _ = crate::services::embedding::delete_embedding(&state.db, project_id, path).await;
    // DELETE doesn't bump remaining rows' updated_at, so the (project_id, MAX(updated_at))
    // graph cache key wouldn't refresh on its own — invalidate explicitly (Step 1b).
    crate::services::graph::invalidate_project_cache(project_id);
    Ok(())
}

async fn fetch_page(
    state: &AppState,
    project_id: i32,
    path: &str,
) -> Result<PageSnippet, AppError> {
    let row: Option<(Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT title, content FROM wiki_pages WHERE project_id=$1 AND path=$2",
    )
    .bind(project_id)
    .bind(path)
    .fetch_optional(&state.db)
    .await?;
    match row {
        Some((title, content)) => Ok(PageSnippet {
            path: path.to_string(),
            title: title.unwrap_or_default(),
            content: content.unwrap_or_default(),
        }),
        None => Err(AppError::ResourceNotFound("page".into())),
    }
}

pub async fn resolve_review_item(
    state: &AppState,
    project_id: i32,
    user_id: i32,
    item_id: i64,
    action: ResolveAction,
) -> Result<ResolveOutcome, AppError> {
    let item = load_open_item(state, project_id, item_id).await?;
    match action {
        ResolveAction::CreatePage => {
            let path = exec_create_page(state, project_id, &item).await?;
            mark_resolved(state, item_id, "create_page", user_id).await?;
            Ok(ResolveOutcome::Resolved { resolved_action: "create_page".into(), created_path: Some(path) })
        }
        ResolveAction::Skip => {
            mark_resolved(state, item_id, "skip", user_id).await?;
            Ok(ResolveOutcome::Resolved { resolved_action: "skip".into(), created_path: None })
        }
        ResolveAction::Delete { path } => {
            let p = path
                .or_else(|| item.affected_pages.clone().and_then(|v| v.into_iter().next()))
                .ok_or_else(|| AppError::ValidationError("delete needs a path".into()))?;
            exec_delete_page(state, project_id, &p).await?;
            mark_resolved(state, item_id, "delete", user_id).await?;
            Ok(ResolveOutcome::Resolved { resolved_action: "delete".into(), created_path: None })
        }
        ResolveAction::Open { path } => {
            let p = path
                .or_else(|| item.affected_pages.clone().and_then(|v| v.into_iter().next()))
                .ok_or_else(|| AppError::ValidationError("open needs a path".into()))?;
            let page = fetch_page(state, project_id, &p).await?;
            Ok(ResolveOutcome::Opened { page })
        }
    }
}
```

- [ ] **Step 1b: Add `graph::invalidate_project_cache` (delete-executor cache cleanup)**

`exec_delete_page` (Step 1) calls `graph::invalidate_project_cache`. `graph.rs::build_graph` caches by `(project_id, MAX(updated_at))`; a DELETE doesn't change remaining rows' `updated_at`, so the cache wouldn't refresh on its own when a non-newest page is deleted (a pre-existing limitation that also affects `routes/pages.rs::delete_page`). Add the invalidator to `src-server/src/services/graph.rs` (mirrors the existing `cache.retain` pattern inside `build_graph` — `GRAPH_CACHE` is the existing `LazyLock<Mutex<HashMap<(i32, i64), WikiGraph>>>` static in that file):

```rust
/// Invalidate the in-memory graph cache for a project. Call after a page DELETE
/// (which doesn't change remaining rows' updated_at, so the (project_id, MAX(updated_at))
/// cache key wouldn't change on its own).
pub fn invalidate_project_cache(project_id: i32) {
    if let Ok(mut cache) = GRAPH_CACHE.lock() {
        cache.retain(|&(pid, _), _| pid != project_id);
    }
}
```

- [ ] **Step 2: Create routes/reviews.rs**

Create `src-server/src/routes/reviews.rs`:
```rust
//! Layer 3 Phase B — review queue routes (project-scoped, team-shared).

use axum::{
    extract::{Path, Query, State},
    http::HeaderMap,
    Json,
};
use serde::{Deserialize, Serialize};

use crate::services::review::{self, ResolveAction, ResolveOutcome, ReviewOption};
use crate::{AppState, AppError};
use crate::middleware::project_guard::check_project_access;

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StatusFilter {
    Open,
    Resolved,
    Dismissed,
    All,
}

impl Default for StatusFilter {
    fn default() -> Self {
        StatusFilter::Open
    }
}

#[derive(Deserialize)]
pub struct ListQuery {
    pub status: Option<StatusFilter>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewItemResp {
    pub id: i64,
    pub uuid: uuid::Uuid,
    pub project_id: i32,
    pub source_path: Option<String>,
    pub review_type: String,
    pub title: String,
    pub description: String,
    pub affected_pages: Option<Vec<String>>,
    pub search_queries: Option<Vec<String>>,
    pub options: Vec<ReviewOption>,
    pub status: String,
    pub resolved_action: Option<String>,
    pub resolved_by: Option<i32>,
    pub resolved_at: Option<chrono::DateTime<chrono::Utc>>,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

#[derive(sqlx::FromRow)]
struct ReviewItemRow {
    id: i64,
    uuid: uuid::Uuid,
    project_id: i32,
    source_path: Option<String>,
    review_type: String,
    title: String,
    description: String,
    affected_pages: Option<Vec<String>>,
    search_queries: Option<Vec<String>>,
    options: serde_json::Value,
    status: String,
    resolved_action: Option<String>,
    resolved_by: Option<i32>,
    resolved_at: Option<chrono::DateTime<chrono::Utc>>,
    created_at: chrono::DateTime<chrono::Utc>,
}

pub fn reviews_routes() -> axum::Router<AppState> {
    axum::Router::new()
        .route("/:id/reviews", axum::routing::get(list_reviews))
        .route("/:id/reviews/:iid/resolve", axum::routing::post(resolve_review))
        .route("/:id/reviews/:iid/dismiss", axum::routing::post(dismiss_review))
}

pub async fn list_reviews(
    State(state): State<AppState>,
    Path(project_id): Path<i32>,
    Query(q): Query<ListQuery>,
    headers: HeaderMap,
) -> Result<Json<Vec<ReviewItemResp>>, AppError> {
    check_project_access(&state, &headers, project_id).await?;
    let filter = q.status.unwrap_or_default();
    let rows: Vec<ReviewItemRow> = match filter {
        StatusFilter::All => sqlx::query_as::<_, ReviewItemRow>(
            "SELECT id, uuid, project_id, source_path, review_type, title, description, \
                    affected_pages, search_queries, options, status, resolved_action, resolved_by, resolved_at, created_at \
             FROM review_items WHERE project_id=$1 ORDER BY created_at DESC",
        ),
        StatusFilter::Resolved => sqlx::query_as::<_, ReviewItemRow>(
            "SELECT id, uuid, project_id, source_path, review_type, title, description, \
                    affected_pages, search_queries, options, status, resolved_action, resolved_by, resolved_at, created_at \
             FROM review_items WHERE project_id=$1 AND status='resolved' ORDER BY created_at DESC",
        ),
        StatusFilter::Dismissed => sqlx::query_as::<_, ReviewItemRow>(
            "SELECT id, uuid, project_id, source_path, review_type, title, description, \
                    affected_pages, search_queries, options, status, resolved_action, resolved_by, resolved_at, created_at \
             FROM review_items WHERE project_id=$1 AND status='dismissed' ORDER BY created_at DESC",
        ),
        StatusFilter::Open => sqlx::query_as::<_, ReviewItemRow>(
            "SELECT id, uuid, project_id, source_path, review_type, title, description, \
                    affected_pages, search_queries, options, status, resolved_action, resolved_by, resolved_at, created_at \
             FROM review_items WHERE project_id=$1 AND status='open' ORDER BY created_at DESC",
        ),
    }
    .bind(project_id)
    .fetch_all(&state.db)
    .await?;

    let out: Vec<ReviewItemResp> = rows
        .into_iter()
        .map(|r| ReviewItemResp {
            options: serde_json::from_value::<Vec<ReviewOption>>(r.options).unwrap_or_default(),
            id: r.id,
            uuid: r.uuid,
            project_id: r.project_id,
            source_path: r.source_path,
            review_type: r.review_type,
            title: r.title,
            description: r.description,
            affected_pages: r.affected_pages,
            search_queries: r.search_queries,
            status: r.status,
            resolved_action: r.resolved_action,
            resolved_by: r.resolved_by,
            resolved_at: r.resolved_at,
            created_at: r.created_at,
        })
        .collect();
    Ok(Json(out))
}

pub async fn resolve_review(
    State(state): State<AppState>,
    Path((project_id, item_id)): Path<(i32, i64)>,
    headers: HeaderMap,
    Json(body): Json<ResolveAction>,
) -> Result<Json<ResolveOutcome>, AppError> {
    let (user_id, _) = check_project_access(&state, &headers, project_id).await?;
    let outcome = review::resolve_review_item(state, project_id, user_id, item_id, body).await?;
    Ok(Json(outcome))
}

pub async fn dismiss_review(
    State(state): State<AppState>,
    Path((project_id, item_id)): Path<(i32, i64)>,
    headers: HeaderMap,
) -> Result<axum::http::StatusCode, AppError> {
    let (user_id, _) = check_project_access(&state, &headers, project_id).await?;
    let n = sqlx::query(
        "UPDATE review_items SET status='dismissed', resolved_by=$1, resolved_at=NOW() \
         WHERE id=$2 AND project_id=$3 AND status='open'",
    )
    .bind(user_id)
    .bind(item_id)
    .bind(project_id)
    .execute(&state.db)
    .await?;
    if n.rows_affected() == 0 {
        return Err(AppError::Conflict("review item not open".into()));
    }
    Ok(axum::http::StatusCode::OK)
}
```

- [ ] **Step 3: Register + merge the routes**

In `src-server/src/routes/mod.rs`, add to the `mod` declarations:
```rust
pub mod reviews;
```

In `src-server/src/routes/projects.rs` `project_routes()`, add (next to `.merge(pages::pages_routes())`):
```rust
        .merge(reviews::reviews_routes())
```

- [ ] **Step 4: Build**

```bash
cargo build -p llm-wiki-server 2>&1 | tail -25
```

Expected: clean build.

- [ ] **Step 5: Add resolve / dismiss / team-visibility integration tests**

Append to `src-server/tests/integration/reviews_test.rs`:
```rust
/// Insert one open review item directly and return its id.
/// (parse_review_blocks + insert_review_items already imported at module top in Task 3.)
async fn seed_review(state: &llm_wiki_server::AppState, pid: i32, title: &str, rtype: &str, affected: Option<&[&str]>) -> i64 {
    let mut p = parse_review_blocks(
        &format!("---REVIEW: {} | {}---\nBody.\nOPTIONS: Create Page | Skip\n---END REVIEW---", rtype, title),
        "src.md",
    );
    if let Some(pages) = affected {
        p[0].affected_pages = Some(pages.iter().map(|s| s.to_string()).collect());
    }
    insert_review_items(state, pid, &p).await.unwrap();
    sqlx::query_scalar("SELECT id FROM review_items WHERE project_id=$1 AND title=$2")
        .bind(pid).bind(title).fetch_one(&state.db).await.unwrap()
}

#[tokio::test]
async fn resolve_create_page_builds_and_resolves() {
    let (server, state, pid, token) = setup_project("rev-create").await;
    let iid = seed_review(&state, pid, "Add Foo", "missing-page", None).await;
    let user_id: i32 = sqlx::query_scalar("SELECT created_by FROM projects WHERE id=$1")
        .bind(pid).fetch_one(&state.db).await.unwrap();

    let resp = server
        .post(&format!("/api/v1/projects/{}/reviews/{}/resolve", pid, iid))
        .add_header("authorization", auth(&token))
        .content_type("application/json")
        .json(&serde_json::json!({"kind":"create_page"}))
        .await;
    assert_eq!(resp.status_code(), axum::http::StatusCode::OK);
    let body: serde_json::Value = resp.json();
    assert_eq!(body["kind"], "resolved");
    assert_eq!(body["resolvedAction"], "create_page");
    let created_path = body["createdPath"].as_str().unwrap();
    assert!(created_path.starts_with("wiki/concepts/"));

    let title: String = sqlx::query_scalar("SELECT title FROM wiki_pages WHERE project_id=$1 AND path=$2")
        .bind(pid).bind(created_path).fetch_one(&state.db).await.unwrap();
    assert_eq!(title, "Add Foo");

    let status: String = sqlx::query_scalar("SELECT status FROM review_items WHERE id=$1")
        .bind(iid).fetch_one(&state.db).await.unwrap();
    assert_eq!(status, "resolved");
    let resolved_by: i32 = sqlx::query_scalar("SELECT resolved_by FROM review_items WHERE id=$1")
        .bind(iid).fetch_one(&state.db).await.unwrap();
    assert_eq!(resolved_by, user_id);
}

#[tokio::test]
async fn resolve_delete_removes_page_and_resolves() {
    let (server, state, pid, token) = setup_project("rev-delete").await;
    sqlx::query("INSERT INTO wiki_pages (project_id, path, title, content, page_type) VALUES ($1,'wiki/concepts/doomed.md','Doomed','x','concept') ON CONFLICT DO NOTHING")
        .bind(pid).execute(&state.db).await.unwrap();
    let iid = seed_review(&state, pid, "Remove Doomed", "duplicate", Some(&["wiki/concepts/doomed.md"])).await;

    let resp = server
        .post(&format!("/api/v1/projects/{}/reviews/{}/resolve", pid, iid))
        .add_header("authorization", auth(&token))
        .content_type("application/json")
        .json(&serde_json::json!({"kind":"delete"}))
        .await;
    assert_eq!(resp.status_code(), axum::http::StatusCode::OK);
    let body: serde_json::Value = resp.json();
    assert_eq!(body["resolvedAction"], "delete");

    let exists: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM wiki_pages WHERE project_id=$1 AND path=$2")
        .bind(pid).bind("wiki/concepts/doomed.md").fetch_one(&state.db).await.unwrap();
    assert_eq!(exists, 0);
}

#[tokio::test]
async fn resolve_open_returns_content_without_resolving() {
    let (server, state, pid, token) = setup_project("rev-open").await;
    sqlx::query("INSERT INTO wiki_pages (project_id, path, title, content, page_type) VALUES ($1,'wiki/concepts/peek.md','Peek','secret body','concept') ON CONFLICT DO NOTHING")
        .bind(pid).execute(&state.db).await.unwrap();
    let iid = seed_review(&state, pid, "Look at Peek", "confirm", Some(&["wiki/concepts/peek.md"])).await;

    let resp = server
        .post(&format!("/api/v1/projects/{}/reviews/{}/resolve", pid, iid))
        .add_header("authorization", auth(&token))
        .content_type("application/json")
        .json(&serde_json::json!({"kind":"open"}))
        .await;
    assert_eq!(resp.status_code(), axum::http::StatusCode::OK);
    let body: serde_json::Value = resp.json();
    assert_eq!(body["kind"], "opened");
    assert_eq!(body["page"]["content"], "secret body");

    let status: String = sqlx::query_scalar("SELECT status FROM review_items WHERE id=$1")
        .bind(iid).fetch_one(&state.db).await.unwrap();
    assert_eq!(status, "open");
}

#[tokio::test]
async fn resolve_twice_returns_conflict() {
    let (server, state, pid, token) = setup_project("rev-conflict").await;
    let iid = seed_review(&state, pid, "Skip Me", "suggestion", None).await;
    let r1 = server.post(&format!("/api/v1/projects/{}/reviews/{}/resolve", pid, iid))
        .add_header("authorization", auth(&token)).content_type("application/json")
        .json(&serde_json::json!({"kind":"skip"})).await;
    assert_eq!(r1.status_code(), axum::http::StatusCode::OK);
    let r2 = server.post(&format!("/api/v1/projects/{}/reviews/{}/resolve", pid, iid))
        .add_header("authorization", auth(&token)).content_type("application/json")
        .json(&serde_json::json!({"kind":"skip"})).await;
    assert_eq!(r2.status_code(), axum::http::StatusCode::CONFLICT);
}

#[tokio::test]
async fn dismiss_marks_dismissed() {
    let (server, state, pid, token) = setup_project("rev-dismiss").await;
    let iid = seed_review(&state, pid, "Dismiss Me", "suggestion", None).await;
    let resp = server.post(&format!("/api/v1/projects/{}/reviews/{}/dismiss", pid, iid))
        .add_header("authorization", auth(&token)).await;
    assert_eq!(resp.status_code(), axum::http::StatusCode::OK);
    let status: String = sqlx::query_scalar("SELECT status FROM review_items WHERE id=$1")
        .bind(iid).fetch_one(&state.db).await.unwrap();
    assert_eq!(status, "dismissed");
}

#[tokio::test]
async fn team_shared_visibility() {
    // user A's project; user B is NOT a member -> 403 on list
    let (server, _state, pid, _token_a) = setup_project("rev-vis").await;
    let uname = unique_prefix("rev-vis-b");
    let user_b = crate::register_user(&server, &uname, &format!("{}@t.com", uname), "password123").await;
    let r = server.get(&format!("/api/v1/projects/{}/reviews", pid))
        .add_header("authorization", auth(&user_b)).await;
    assert_eq!(r.status_code(), axum::http::StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn list_filters_by_status() {
    // reuse the server from setup_project (it owns the project); do NOT re-create.
    let (server, state, pid, token) = setup_project("rev-list").await;
    let _open1 = seed_review(&state, pid, "Open One", "suggestion", None).await;
    let open2 = seed_review(&state, pid, "Open Two", "suggestion", None).await;
    // dismiss Open Two
    let _ = server.post(&format!("/api/v1/projects/{}/reviews/{}/dismiss", pid, open2))
        .add_header("authorization", auth(&token)).await;

    let r = server.get(&format!("/api/v1/projects/{}/reviews?status=open", pid))
        .add_header("authorization", auth(&token)).await;
    assert_eq!(r.status_code(), axum::http::StatusCode::OK);
    let list: serde_json::Value = r.json();
    assert_eq!(list.as_array().unwrap().len(), 1);
    assert_eq!(list[0]["title"], "Open One");
}

- [ ] **Step 6: Run all review tests**

```bash
cargo test -p llm-wiki-server --test integration reviews_test -- --nocapture
```

Expected: all PASS. (If `resolve_create_page` embed call fails to reach the embedding endpoint, that's a best-effort warning — the page upsert + resolve still succeed; the test asserts those.)

- [ ] **Step 7: Commit**

```bash
git add src-server/src/services/review.rs src-server/src/services/graph.rs src-server/src/routes/reviews.rs src-server/src/routes/mod.rs src-server/src/routes/projects.rs src-server/tests/integration/reviews_test.rs
git commit -m "feat(src-server): reviews routes + resolve actions (create_page/skip/delete/open) + dismiss + graph cache invalidate"
```

---

## Task 6: Full suite + clippy

**Files:**
- (verification only)

- [ ] **Step 1: Run the whole integration suite + unit suites**

```bash
cargo test -p llm-wiki-server --test integration -- --nocapture
cargo test -p llm-wiki-server services::review -- --nocapture
```

Expected: all review tests PASS, no regressions in existing suites (pages, auth, chat_sessions, etc.).

- [ ] **Step 2: Clippy + build**

```bash
cargo clippy -p llm-wiki-server -- -D warnings 2>&1 | tail -30
cargo build -p llm-wiki-server 2>&1 | tail -5
```

Expected: no warnings, clean build. Likely lint candidates: unused `search_queries` in `LoadedItem` (already `#[allow(dead_code)]`), `trim_path` helper (used). Fix any remaining.

- [ ] **Step 3: Commit (if any clippy fixes)**

```bash
git add -A
git commit -m "chore(src-server): Phase B clippy cleanup"
```
(If nothing changed, skip the commit.)

---

## Self-Review

**1. Spec coverage** (against Phase B spec §2 scope + §4–§11):
- migration 007 (`review_items`) → Task 1 ✓
- `parse_review_blocks` + helpers → Task 2 ✓
- step2 prompt REVIEW instructions → Task 3 Step 2 ✓
- ingest deferred-write hook (compute in `process_source_path`, insert in `run_ingest_job` `if all_upserted`) → Task 3 Steps 4–5 ✓ (respects invariant at ingest_pipeline.rs:24-26/391)
- `insert_review_items` → Task 3 Step 1 ✓
- dedicated review stage (`should_run`/`run_dedicated_review_stage`/`fetch_*`/`step3_review.txt`) → Task 4 ✓
- merge + dedup in `process_source_path` → Task 4 Step 3 ✓
- reviews routes (list/resolve/dismiss) → Task 5 ✓
- `resolve_review_item` + executors (create_page/skip/delete/open) → Task 5 Step 1 ✓
- `deep_research` deferred (not in `ResolveAction`) → confirmed absent ✓
- error handling (404 not-found / 409 not-open / 400 missing path / 403 no access) → Task 5 (load_open_item 404/409, action path validation 400, check_project_access 403) ✓
- create_page unique path + best-effort embed → Task 5 `exec_create_page` ✓

**2. Placeholder scan:** No `TBD`/`TODO` in shipped code. The resolve/dedicated tests use the `setup_project` server directly (not re-created) and import `run_dedicated_review_stage`/`should_run_dedicated_review_stage` from `services::review` (correct module). `seed_review` reuses the module-level `parse_review_blocks`/`insert_review_items` imports from Task 3 (no duplicate `use`).

**3. Type consistency:** `ParsedReview` fields (review_type/title/description/source_path/affected_pages/search_queries/options) used consistently across parse → insert → resolve. `WikiPageInsert` fields (path/title: Option/content/frontmatter/page_type/sources/images) match ingest_pipeline.rs:17-22. `embed_page(pool, cfg, client, project_id, path, text)` matches embedding.rs:89. `delete_embedding(pool, project_id, path)` matches embedding.rs:113. `provider_for_project(state, project_id) -> Box<dyn StreamChatProvider>` + `chat_to_string` reused. `ResolveAction` serde tag `kind` → JSON `{"kind":"create_page"}` / `{"kind":"delete"}` matches test payloads. `mark_resolved`/`load_open_item` rows_affected/status semantics consistent.
