// src/services/research/synthesize.rs — 综合阶段：纯函数 + 状态机（Task 5 补 run_research_job）。
use crate::services::retrieval::RetrievalResult;
use crate::services::web_search::WebSearchResult;

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
