use sqlx::PgPool;
use crate::AppError;

#[derive(serde::Serialize, sqlx::FromRow)]
pub struct SearchResult {
    pub path: String,
    pub title: String,
    pub snippet: String,
    pub title_match: bool,
    pub score: f64,
    pub vector_score: Option<f64>,
    pub images: serde_json::Value,
}

/// Tokenize a search query: English words by whitespace/punctuation, CJK bigrams
fn tokenize(query: &str) -> Vec<String> {
    let mut tokens: Vec<String> = Vec::new();
    for part in query.split(|c: char| {
        c.is_whitespace() || c == ',' || c == '\u{FF0C}'  // ，fullwidth comma
            || c == '\u{3002}' || c == '\u{FF01}' || c == '\u{FF1F}'
            || c == '\u{3001}' || c == '\u{FF1B}'
    }) {
        let trimmed = part.trim();
        if trimmed.is_empty() {
            continue;
        }
        let chars: Vec<char> = trimmed.chars().collect();
        let has_cjk = chars.iter().any(|c| {
            ('\u{4E00}'..='\u{9FFF}').contains(c)   // CJK Unified
                || ('\u{3040}'..='\u{309F}').contains(c) // Hiragana
                || ('\u{30A0}'..='\u{30FF}').contains(c) // Katakana
                || ('\u{AC00}'..='\u{D7AF}').contains(c) // Hangul
        });
        if has_cjk {
            for i in 0..chars.len().saturating_sub(1) {
                tokens.push(format!("{}{}", chars[i], chars[i + 1]));
            }
        } else {
            tokens.push(trimmed.to_lowercase());
        }
    }
    tokens
}

pub async fn search_wiki(
    pool: &PgPool,
    project_id: i32,
    query: &str,
    limit: i32,
) -> Result<Vec<SearchResult>, AppError> {
    let tokens = tokenize(query);
    if tokens.is_empty() {
        return Ok(Vec::new());
    }

    // Build ILIKE conditions — one per token
    let conditions: Vec<String> = tokens
        .iter()
        .enumerate()
        .map(|(i, _)| {
            // $1 = project_id, $2.. = tokens, last = limit
            let idx = i + 2;
            format!(
                "(wp.title ILIKE '%' || ${idx} || '%' OR wp.content ILIKE '%' || ${idx} || '%')"
            )
        })
        .collect();
    let where_clause = conditions.join(" OR ");

    // limit is bound after all tokens
    let limit_idx = tokens.len() + 2;

    let sql = format!(
        "SELECT
            wp.path,
            wp.title,
            COALESCE(
                substring(wp.content FROM
                    GREATEST(1, position(lower($2) in lower(COALESCE(wp.content, ''))) - 80)
                    FOR 200
                ),
                substring(COALESCE(wp.content, '') FROM 1 FOR 200)
            ) as snippet,
            CASE WHEN lower(wp.title) LIKE '%' || lower($2) || '%' THEN true ELSE false END as title_match,
            CASE WHEN lower(wp.title) LIKE '%' || lower($2) || '%' THEN 10.0
                 WHEN lower(COALESCE(wp.content, '')) LIKE '%' || lower($2) || '%' THEN 1.0
                 ELSE 0.0
            END as score,
            NULL::double precision as vector_score,
            COALESCE(wp.images, '[]'::jsonb) as images
        FROM wiki_pages wp
        WHERE wp.project_id = $1
        AND ({where})
        ORDER BY score DESC
        LIMIT ${limit_idx}",
        where = where_clause,
        limit_idx = limit_idx,
    );

    let mut q = sqlx::query_as::<_, SearchResult>(&sql).bind(project_id);

    for token in &tokens {
        q = q.bind(token);
    }
    q = q.bind(limit);

    q.fetch_all(pool)
        .await
        .map_err(|e| AppError::DatabaseError(e))
}
