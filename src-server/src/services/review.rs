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
