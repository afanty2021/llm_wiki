// src/services/web_search.rs — web 搜索 provider 抽象 + Tavily 实现 + 去重。
use crate::{AppError, AppState};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
pub struct WebSearchResult {
    pub title: String,
    pub url: String,
    pub snippet: String,
    pub source: String, // provider 标签，如 "tavily"
}

#[derive(Debug, thiserror::Error)]
pub enum WebSearchError {
    #[error("http error: {0}")]
    Http(String),
    #[error("invalid response: {0}")]
    Invalid(String),
}

#[async_trait]
pub trait WebSearchProvider: Send + Sync {
    async fn search(
        &self,
        query: &str,
        max_results: u8,
    ) -> Result<Vec<WebSearchResult>, WebSearchError>;
    fn provider_type(&self) -> &'static str;
}

pub struct TavilyProvider {
    client: reqwest::Client,
    api_key: String,
    base_url: String,
}

impl TavilyProvider {
    pub fn new(client: reqwest::Client, api_key: String, base_url: String) -> Self {
        Self {
            client,
            api_key,
            base_url,
        }
    }
}

#[derive(Deserialize)]
struct TavilyResponse {
    results: Vec<TavilyItem>,
}
#[derive(Deserialize)]
struct TavilyItem {
    title: Option<String>,
    url: Option<String>,
    content: Option<String>,
}

#[async_trait]
impl WebSearchProvider for TavilyProvider {
    async fn search(
        &self,
        query: &str,
        max_results: u8,
    ) -> Result<Vec<WebSearchResult>, WebSearchError> {
        let body = serde_json::json!({
            "api_key": self.api_key,
            "query": query,
            "max_results": max_results,
            "search_depth": "basic",
        });
        let resp = self
            .client
            .post(&self.base_url)
            .json(&body)
            .send()
            .await
            .map_err(|e| WebSearchError::Http(e.to_string()))?;
        let parsed: TavilyResponse = resp
            .json()
            .await
            .map_err(|e| WebSearchError::Invalid(e.to_string()))?;
        Ok(parsed
            .results
            .into_iter()
            .map(|it| WebSearchResult {
                title: it.title.unwrap_or_default(),
                url: it.url.unwrap_or_default(),
                snippet: it.content.unwrap_or_default(),
                source: "tavily".into(),
            })
            .collect())
    }
    fn provider_type(&self) -> &'static str {
        "tavily"
    }
}

/// 从 search_providers 表构造 enabled provider（team 维度 JOIN，复用 llm::decrypt_api_key）。
pub async fn provider_for_project(
    state: &AppState,
    project_id: i32,
) -> Result<Box<dyn WebSearchProvider>, AppError> {
    let row: Option<(i64, String, Option<String>, String)> = sqlx::query_as(
        "SELECT sp.id, sp.api_key_encrypted, sp.base_url, sp.provider_type FROM search_providers sp \
         JOIN projects p ON sp.team_id = p.team_id \
         WHERE p.id=$1 AND sp.is_enabled=TRUE ORDER BY sp.id LIMIT 1",
    )
    .bind(project_id)
    .fetch_optional(&state.db)
    .await?;
    let (_, key_enc, base_url, ptype) = row.ok_or_else(|| {
        AppError::BadRequest("no enabled search_provider for project".into())
    })?;
    let api_key = crate::services::llm::decrypt_api_key(&key_enc, &state.config)?;
    let base_url = base_url.unwrap_or_else(|| "https://api.tavily.com/search".into());
    match ptype.as_str() {
        "tavily" => Ok(Box::new(TavilyProvider::new(
            state.http.clone(),
            api_key,
            base_url,
        ))),
        other => Err(AppError::BadRequest(format!(
            "unsupported search provider: {other}"
        ))),
    }
}

/// 纯：按 url 去重（url 空时退化 title|source|snippet 键）+ max cap。
pub fn dedupe_results(raw: Vec<WebSearchResult>, max: usize) -> Vec<WebSearchResult> {
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut out = Vec::new();
    for r in raw {
        let key = if r.url.is_empty() {
            format!("{}|{}|{}", r.title, r.source, r.snippet)
        } else {
            r.url.clone()
        };
        if seen.insert(key) {
            out.push(r);
            if out.len() >= max {
                break;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    fn r(url: &str, title: &str) -> WebSearchResult {
        WebSearchResult {
            url: url.into(),
            title: title.into(),
            snippet: "s".into(),
            source: "t".into(),
        }
    }
    #[test]
    fn dedupe_by_url_keeps_first() {
        let out = dedupe_results(vec![r("a", "1"), r("a", "dup"), r("b", "2")], 20);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].title, "1");
        assert_eq!(out[1].title, "2");
    }
    #[test]
    fn dedupe_caps_at_max() {
        let out = dedupe_results(
            vec![r("a", "1"), r("b", "2"), r("c", "3"), r("d", "4")],
            2,
        );
        assert_eq!(out.len(), 2);
    }
    #[test]
    fn dedupe_empty_url_falls_back_to_title_key() {
        let out = dedupe_results(vec![r("", "1"), r("", "1"), r("", "2")], 20);
        assert_eq!(out.len(), 2); // title "1" 去重，title "2" 留
    }
}
