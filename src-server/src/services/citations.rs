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
    let re = regex_lite::Regex::new(r"<!--\s*cited:\s*([^>]*?)\s*-->").unwrap();
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
