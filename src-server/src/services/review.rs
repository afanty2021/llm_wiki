//! Layer 3 Phase B — 审核系统：REVIEW 块解析（纯）、存储、dedicated review stage、resolve。
//!
//! 纯函数（parse/helpers）在此文件内单测；async 编排（insert/dedicated/resolve）
//! 由集成测试覆盖。ingest pipeline 调 parse_review_blocks/run_dedicated_review_stage
//! 计算，run_ingest_job 落库（守 deferred-write 不变量）。

use serde::{Deserialize, Serialize};
use crate::{AppState, AppError};

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

/// Bulk-insert parsed reviews for a project. Returns count inserted.
///
/// 守 deferred-write 不变量：只由 run_ingest_job 在 `if all_upserted` 块内、
/// mark_file_ingested 之后调用（页 upsert 全成功 → 文件 mark 成功 → 再插 review，
/// 保证失败时不留孤儿 review、不重复）。
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

// ── resolve actions (Task 5) ──

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
    #[allow(dead_code)]
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
}
