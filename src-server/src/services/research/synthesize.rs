// src/services/research/synthesize.rs — 综合阶段：纯函数 + 状态机（Task 5 补 run_research_job）。
use crate::services::llm_stream::{ChatMessage, ChatOpts, StreamChatProvider};
use crate::services::research::ResearchOutcome;
use crate::services::retrieval::{retrieve_context, RetrievalResult};
use crate::services::web_search::{dedupe_results, WebSearchProvider, WebSearchResult};
use crate::{AppError, AppState};
use uuid::Uuid;

/// 纯：剥 <think>/<thinking>...</> 块；无标签原样返回（trim 首尾空白）。
pub fn strip_thinking(text: &str) -> String {
    let mut out = text.to_string();
    for tag in ["think", "thinking"] {
        let open = format!("<{}>", tag);
        let close = format!("</{}>", tag);
        while let Some(start) = out.find(&open) {
            if let Some(end_rel) = out[start..].find(&close) {
                let end = start + end_rel + close.len();
                out.replace_range(start..end, "");
            } else {
                out.truncate(start); // 无闭合：弃 open 起到结尾
            }
        }
    }
    out.trim().to_string()
}

/// 纯：组 research prompt（sources + index + pages 三段；pages 段在 retrieval.pages 空时省略）。
pub fn assemble_research_prompt(
    topic: &str,
    sources: &[WebSearchResult],
    retrieval: &RetrievalResult,
) -> String {
    let mut s = String::new();
    s.push_str(&format!("# Research brief: {}\n\n", topic));
    s.push_str("## Web sources\n");
    for (i, src) in sources.iter().enumerate() {
        s.push_str(&format!(
            "{}. [{}]({})\n   {}\n",
            i + 1,
            src.title,
            src.url,
            src.snippet
        ));
    }
    s.push_str("\n## Local index\n");
    s.push_str(&retrieval.index_snippet);
    if !retrieval.pages.is_empty() {
        s.push_str("\n\n## Local pages\n");
        for p in &retrieval.pages {
            s.push_str(&format!("### {} ({})\n{}\n\n", p.title, p.path, p.content));
        }
    }
    s.push_str("\n## Task\nSynthesize the above into a single coherent markdown brief for a personal wiki.");
    s
}

// ── 状态机编排（Task 5）──

/// 同步写 status=stage 且 stage=stage（见 spec §4，set_stage 同步两列）。
async fn set_stage(state: &AppState, task_id: Uuid, stage: &str) {
    let _ = sqlx::query(
        "UPDATE research_tasks SET status=$1, stage=$1, updated_at=NOW() WHERE id=$2",
    )
    .bind(stage)
    .bind(task_id)
    .execute(&state.db)
    .await;
}

async fn persist_web_results(state: &AppState, task_id: Uuid, sources: &[WebSearchResult]) {
    let val = serde_json::to_value(sources).unwrap_or(serde_json::Value::Null);
    let _ = sqlx::query("UPDATE research_tasks SET web_results=$1, updated_at=NOW() WHERE id=$2")
        .bind(&val)
        .bind(task_id)
        .execute(&state.db)
        .await;
}

/// 并发跨 query allSettled（单 query 失败只 warning 继续）；返回未去重合集。
async fn collect_sources(web: &dyn WebSearchProvider, queries: &[String]) -> Vec<WebSearchResult> {
    let futs: Vec<_> = queries.iter().map(|q| web.search(q, 5)).collect();
    let results = futures::future::join_all(futs).await;
    let mut out = Vec::new();
    for r in results {
        match r {
            Ok(v) => out.extend(v),
            Err(e) => tracing::warn!("web search query failed (skipped): {}", e),
        }
    }
    out
}

/// 状态机编排。参数注入（web+llm+context_size+date_ymd）→ 端到端可测。
pub async fn run_research_job(
    state: &AppState,
    task: &crate::services::research::ResearchTask,
    date_ymd: &str,
    context_size: i32,
    web: &dyn WebSearchProvider,
    llm: &dyn StreamChatProvider,
) -> Result<ResearchOutcome, AppError> {
    // ① searching
    set_stage(state, task.id, "searching").await;
    let queries = task
        .search_queries
        .clone()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| crate::services::research::derive_queries(&task.topic));
    let raw = collect_sources(web, &queries).await;
    let sources = dedupe_results(raw, 20);
    if sources.is_empty() {
        return Err(AppError::LlmApiError("no web sources".into()));
    }
    persist_web_results(state, task.id, &sources).await;

    // ② synthesizing
    set_stage(state, task.id, "synthesizing").await;
    let retrieval = retrieve_context(state, task.project_id, &task.topic, context_size).await?;
    let prompt = assemble_research_prompt(&task.topic, &sources, &retrieval);
    let (raw_out, _) = llm
        .chat_to_string(
            vec![ChatMessage {
                role: "user".into(),
                content: prompt,
            }],
            ChatOpts {
                model: llm.model_name().into(),
                temperature: 0.3,
                max_tokens: 8000,
                system_prompt: Some(
                    "You synthesize a research brief for a personal wiki. Output a single markdown document.".into(),
                ),
                timeout_secs: None,
            },
        )
        .await
        .map_err(|e| AppError::LlmApiError(format!("synthesize: {e}")))?;
    let synthesis = strip_thinking(&raw_out);
    if synthesis.trim().is_empty() {
        return Err(AppError::LlmApiError("empty synthesis".into()));
    }

    // ③ saving
    set_stage(state, task.id, "saving").await;
    let path = save_research_page(
        state,
        task.project_id,
        &task.topic,
        &synthesis,
        date_ymd,
        &sources,
    )
    .await?;
    if let Err(e) = crate::services::embedding::embed_page(
        &state.db,
        state.config.embedding.as_ref(),
        &state.http,
        task.project_id,
        &path,
        &synthesis,
    )
    .await
    {
        tracing::warn!("embed research page {}: {}", path, e);
    }
    Ok(ResearchOutcome { path, synthesis })
}

async fn save_research_page(
    state: &AppState,
    project_id: i32,
    topic: &str,
    synthesis: &str,
    date_ymd: &str,
    sources: &[WebSearchResult],
) -> Result<String, AppError> {
    let slug = crate::services::research::slugify_topic(topic);
    let path = format!("wiki/queries/research-{}-{}.md", slug, date_ymd);
    let source_urls: Vec<&str> = sources.iter().map(|s| s.url.as_str()).collect();
    let frontmatter = serde_json::json!({
        "type": "query",
        "title": topic,
        "sources": source_urls,
        "origin": "deep-research"
    });
    let content = format!("# {}\n\n{}", topic, synthesis);
    let page = crate::services::ingest_pipeline::WikiPageInsert {
        path: path.clone(),
        title: Some(topic.into()),
        content,
        frontmatter,
        page_type: "query".into(),
        sources: serde_json::json!(source_urls),
        images: serde_json::json!([]),
    };
    crate::services::ingest_pipeline::upsert_wiki_page(state, project_id, &page).await?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::retrieval::RetrievedPage;
    use std::collections::HashMap;

    fn empty_retrieval() -> RetrievalResult {
        RetrievalResult {
            pages: vec![],
            assembled_context: String::new(),
            index_snippet: "idx".into(),
            ref_map: HashMap::new(),
        }
    }
    fn src(url: &str, title: &str) -> WebSearchResult {
        WebSearchResult {
            url: url.into(),
            title: title.into(),
            snippet: "snip".into(),
            source: "t".into(),
        }
    }
    #[test]
    fn strip_thinking_removes_blocks() {
        assert_eq!(strip_thinking("<think>hidden</think>visible"), "visible");
        assert_eq!(strip_thinking("<thinking>x</thinking>ok"), "ok");
        assert_eq!(strip_thinking("plain text"), "plain text");
    }
    #[test]
    fn assemble_prompt_omits_pages_when_empty() {
        let p = assemble_research_prompt("topic", &[src("u", "T")], &empty_retrieval());
        assert!(p.contains("## Web sources"));
        assert!(p.contains("## Local index"));
        assert!(!p.contains("## Local pages"));
        assert!(p.contains("[T](u)"));
    }
    #[test]
    fn assemble_prompt_includes_pages_when_present() {
        let mut r = empty_retrieval();
        r.pages.push(RetrievedPage {
            number: 1,
            path: "p".into(),
            title: "P".into(),
            content: "c".into(),
            priority: 1,
        });
        let p = assemble_research_prompt("topic", &[src("u", "T")], &r);
        assert!(p.contains("## Local pages"));
        assert!(p.contains("(p)"));
    }
}
