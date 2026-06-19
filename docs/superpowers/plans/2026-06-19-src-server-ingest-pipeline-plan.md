# 子系统 D — ingest 编排 Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 `run_ingest_job(state, job) → IngestJobResult`：解析(A)→图片路径替换→长文档分块→content-hash 缓存→两步 LLM(B)→FILE block 解析→写 wiki_pages→reserved pages 重建。A/B 未就绪时留 stub。

**Architecture:** `services/ingest_pipeline.rs`（~450 行单文件）：纯函数(chunk/parse/merge)→缓存层(redis+PG)→主流程(process_source_path+run_ingest_job)。纯函数先提(不依赖 A/B)，集成函数含 A/B stub。Prompt 文本用 `include_str!` 编译期嵌入。

**Tech Stack:** Rust + sqlx + redis + serde_json + serde_yaml(新增) + sha2 + tokio。

**依据 spec:** `docs/superpowers/specs/2026-06-19-src-server-ingest-d-pipeline-design.md`

---

## File Structure

| 文件 | 职责 | 改动 |
|------|------|------|
| `src-server/Cargo.toml` | 加 `serde_yaml = "0.9"` | Modify |
| `src-server/src/services/prompts/step1_analyze.txt` | Step1 分析 prompt（移植桌面） | Create |
| `src-server/src/services/prompts/step2_generate.txt` | Step2 生成 prompt（移植桌面） | Create |
| `src-server/src/services/ingest_pipeline.rs` | 核心编排（~450 行）：纯函数 + 缓存 + 主流程 + 测试 | Create |
| `src-server/src/services/mod.rs` | 加 `pub mod ingest_pipeline;` | Modify |

---

## Task 0: 前置依赖（serde_yaml + prompt 文件 + 模块空壳）

**编译阻断解除**，Task 1-3 依赖。

### Step 1: Cargo.toml 加 serde_yaml

`src-server/Cargo.toml` 的 `[dependencies]` 区域加：

```toml
serde_yaml = "0.9"
```

### Step 2: 创建 prompt 占位文件

`src-server/src/services/prompts/step1_analyze.txt`：

```
You are a knowledge extraction assistant. Analyze the document below and output a JSON object with the following fields:

- entities: list of {name, type, description, properties: {key: value}}
- concepts: list of {name, description, related_entities: [names]}
- connections: list of {from, to, relation, evidence}
- contradictions: list of {statement_a, statement_b, resolution}

Output ONLY the JSON object, no other text.
```

`src-server/src/services/prompts/step2_generate.txt`：

```
You are a wiki page generator. Based on the analysis JSON and source document below, generate wiki pages.

Output each page as a FILE block:
---FILE: concepts/topic-name.md ---
---
title: Title Here
type: concept
sources: ["source.md"]
---
# Title Here

Content in markdown...
---END FILE---

Guidelines:
- Create one page per distinct concept/entity
- Use descriptive paths (concepts/..., entities/..., notes/...)
- Include YAML frontmatter with title, type, sources
- Cross-reference related concepts with [[wikilinks]]
```

### Step 3: 空模块编译验证

`src-server/src/services/mod.rs` 加：

```rust
pub mod ingest_pipeline;
```

`src-server/src/services/ingest_pipeline.rs` 先写空骨架：

```rust
// services/ingest_pipeline.rs — ingest 编排 pipeline
```

```bash
cargo build -p llm_wiki_server
```
Expected：0 error（空模块 + serde_yaml 编译通过）。

### Step 4: commit

```bash
git add src-server/Cargo.toml src-server/Cargo.lock \
        src-server/src/services/prompts/ \
        src-server/src/services/ingest_pipeline.rs \
        src-server/src/services/mod.rs
git commit -m "chore(src-server): serde_yaml + prompt 占位 + ingest_pipeline 空模块（子系统 D 前置）"
```

---

## Task 1: 纯函数（chunk_document + parse_file_blocks + merge_analyses + image_path_replace）+ 单元测试

**Files:**
- Modify: `src-server/src/services/ingest_pipeline.rs`

**目标**：4 个纯函数 + table-driven 测试，零外部依赖。

### Step 1: 写失败测试

替换 `ingest_pipeline.rs` 空骨架为包含测试的版本（先写测试，函数体留 `todo!()`）：

```rust
// services/ingest_pipeline.rs — ingest 编排 pipeline

// ── 纯函数 ──

/// 估算 token 数（粗糙：字符数 / 4，对齐桌面端 simple token estimator）。
fn estimate_tokens(text: &str) -> usize { text.chars().count() / 4 }

/// 长文档分块：按段落边界（\n\n）拆，每 chunk ≤ context_budget。
/// context_budget = LlmConfig.context_size - 8000（预留 prompt 开销）。
/// 若某段落 > context_budget，按句子边界（。.!?）硬拆。
fn chunk_document(text: &str, context_budget: usize) -> Vec<String> {
    todo!()
}

/// FILE block 解析。移植桌面 parseFileBlocks，含 CommonMark code fence 感知。
fn parse_file_blocks(text: &str) -> Vec<ParsedBlock> {
    todo!()
}

/// 多 chunk 分析合并。entities 去重 + connections 去重 + contradictions concat。
fn merge_analyses(analyses: &[serde_json::Value]) -> serde_json::Value {
    todo!()
}

/// 替换 text 里的原始图片相对路径为 media/{project_id}/ 前缀。
fn replace_image_paths(text: &str, project_id: i32, images: &[(String, Vec<u8>)]) -> String {
    todo!()
}

// ── 共用模型 ──

#[derive(Debug, Clone)]
struct ParsedBlock {
    path: String, title: Option<String>, content: String,
    frontmatter: serde_json::Value, page_type: String,
    sources: serde_json::Value, images: serde_json::Value,
}

#[derive(Debug, Clone)]
struct WikiPageInsert {
    path: String, title: Option<String>, content: String,
    frontmatter: serde_json::Value, page_type: String,
    sources: serde_json::Value, images: serde_json::Value,
}

// ── 测试 ──

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunk_document_short_no_split() {
        let text = "Hello world.\n\nShort doc.";
        let chunks = chunk_document(text, 1000);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0], text);
    }

    #[test]
    fn chunk_document_splits_by_paragraph_boundary() {
        // 构造长文档：每个段落 > budget/2 但 < budget → 两个独立 chunk
        let para = "A".repeat(200);
        let text = format!("{}\n\n{}", para, para);
        let budget = estimate_tokens(&para) + 10; // 刚好装不下两个段落
        let chunks = chunk_document(&text, budget);
        assert_eq!(chunks.len(), 2);
    }

    #[test]
    fn chunk_document_hard_split_long_paragraph() {
        // 单段落 > budget → 按句子硬拆
        let sentences: Vec<String> = (0..50).map(|i| format!("Sentence {}. ", i)).collect();
        let text = sentences.join("");
        let budget = estimate_tokens(&sentences[..10].join(""));
        let chunks = chunk_document(&text, budget);
        assert!(chunks.len() > 1, "long paragraph should be split");
    }

    #[test]
    fn parse_file_blocks_single_block() {
        let text = "---FILE: concepts/test.md ---\n---\ntitle: Test\ntype: concept\n---\n# Test\nBody text.\n---END FILE---";
        let blocks = parse_file_blocks(text);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].path, "concepts/test.md");
        assert_eq!(blocks[0].title.as_deref(), Some("Test"));
        assert_eq!(blocks[0].frontmatter["type"], "concept");
        assert!(blocks[0].content.contains("Body text."));
    }

    #[test]
    fn parse_file_blocks_multiple_blocks() {
        let text = "---FILE: a.md ---\n---\ntitle: A\n---\nBody A\n---END FILE---\n\n---FILE: b.md ---\n---\ntitle: B\n---\nBody B\n---END FILE---";
        let blocks = parse_file_blocks(text);
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].path, "a.md");
        assert_eq!(blocks[1].path, "b.md");
    }

    #[test]
    fn parse_file_blocks_no_blocks() {
        assert!(parse_file_blocks("Just some text.").is_empty());
    }

    #[test]
    fn parse_file_blocks_code_fence_aware() {
        // ---END FILE--- 在 code fence 内不应误闭块
        let text = "---FILE: code.md ---\n---\ntitle: Code\n---\n```\n---END FILE---\n```\nReal end here.\n---END FILE---";
        let blocks = parse_file_blocks(text);
        assert_eq!(blocks.len(), 1);
        assert!(blocks[0].content.contains("---END FILE---"), "fence content preserved");
        assert!(blocks[0].content.contains("Real end here."));
    }

    #[test]
    fn merge_analyses_single_no_change() {
        let a = serde_json::json!({"entities":[{"name":"E1"}],"connections":[],"contradictions":[]});
        let merged = merge_analyses(&[a.clone()]);
        assert_eq!(merged, a);
    }

    #[test]
    fn merge_analyses_dedup_entities() {
        let a = serde_json::json!({"entities":[{"name":"E1"},{"name":"E2"}],"connections":[],"contradictions":[]});
        let b = serde_json::json!({"entities":[{"name":"E2"},{"name":"E3"}],"connections":[],"contradictions":[]});
        let merged = merge_analyses(&[a, b]);
        let names: Vec<String> = merged["entities"].as_array().unwrap()
            .iter().map(|e| e["name"].as_str().unwrap().to_string()).collect();
        assert_eq!(names, vec!["E1","E2","E3"]);
    }

    #[test]
    fn replace_image_paths_basic() {
        let text = "See ![alt](page3_image1.png) and ![alt2](image2.jpg)";
        let images = vec![("page3_image1.png".into(), vec![]), ("image2.jpg".into(), vec![])];
        let result = replace_image_paths(text, 42, &images);
        assert!(result.contains("media/42/page3_image1.png"));
        assert!(result.contains("media/42/image2.jpg"));
        assert!(!result.contains("page3_image1.png"));
    }
}
```

### Step 2: 跑测试验证全部 FAIL

```bash
cargo test -p llm_wiki_server --lib ingest_pipeline::tests -- --nocapture
```
Expected：10 tests FAIL（`todo!()` panic）。

### Step 3: 实现四个纯函数

#### chunk_document

```rust
fn chunk_document(text: &str, context_budget: usize) -> Vec<String> {
    if estimate_tokens(text) <= context_budget {
        return vec![text.to_string()];
    }
    let paragraphs: Vec<&str> = text.split("\n\n").collect();
    let mut chunks = vec![];
    let mut cur = String::new();
    for p in paragraphs {
        if estimate_tokens(&cur) + estimate_tokens(p) > context_budget && !cur.is_empty() {
            chunks.push(std::mem::take(&mut cur));
        }
        // 超长段落按句子硬拆
        if estimate_tokens(p) > context_budget {
            for sent in p.split_inclusive(&['.', '?', '!', '\n', '。'][..]) {
                if estimate_tokens(&cur) + estimate_tokens(sent) > context_budget && !cur.is_empty() {
                    chunks.push(std::mem::take(&mut cur));
                }
                cur.push_str(sent);
            }
        } else {
            cur.push_str(p);
            cur.push_str("\n\n");
        }
    }
    if !cur.is_empty() { chunks.push(cur); }
    chunks
}
```

#### parse_file_blocks

```rust
fn parse_file_blocks(text: &str) -> Vec<ParsedBlock> {
    let text = text.replace("\r\n", "\n");
    let mut blocks = vec![];
    let mut in_block = false;
    let mut cur_path = String::new();
    let mut cur_content = String::new();
    let mut in_fence = false;
    let mut fence_char = ' ';

    for line in text.lines() {
        let trimmed = line.trim();

        // Code fence track
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
            if let Some(path) = trimmed.strip_prefix("---FILE: ")
                .and_then(|s| s.strip_suffix(" ---"))
            {
                if in_block && !cur_content.is_empty() {
                    blocks.push(parse_single_block(&cur_path, &cur_content));
                }
                cur_path = path.trim().to_string();
                cur_content.clear();
                in_block = true;
                continue;
            }
            if trimmed == "---END FILE---" && in_block {
                blocks.push(parse_single_block(&cur_path, &cur_content));
                in_block = false;
                cur_content.clear();
                continue;
            }
        }

        if in_block {
            cur_content.push_str(line);
            cur_content.push('\n');
        }
    }
    if in_block && !cur_content.is_empty() {
        blocks.push(parse_single_block(&cur_path, &cur_content));
    }
    blocks
}

fn parse_single_block(path: &str, content: &str) -> ParsedBlock {
    let (fm, body) = if let Some(pos) = content.find("\n---\n") {
        let fm_text = content[..pos].trim();
        let body = content[pos + 5..].to_string();  // skip \n---\n
        (fm_text, body)
    } else {
        ("", content.to_string())
    };
    let frontmatter: serde_json::Value = serde_yaml::from_str(fm).unwrap_or(serde_json::json!({}));
    let title = frontmatter["title"].as_str().map(String::from)
        .or_else(|| body.lines().next().and_then(|l| l.strip_prefix("# ").map(String::from)));
    let page_type = frontmatter["type"].as_str().unwrap_or("concept").to_string();
    let sources = frontmatter.get("sources").cloned().unwrap_or(serde_json::json!([]));
    let images = frontmatter.get("images").cloned().unwrap_or(serde_json::json!([]));
    ParsedBlock { path: path.into(), title, content: body, frontmatter, page_type, sources, images }
}
```

#### merge_analyses

```rust
fn merge_analyses(analyses: &[serde_json::Value]) -> serde_json::Value {
    if analyses.is_empty() { return serde_json::json!({"entities":[],"connections":[],"contradictions":[]}); }
    if analyses.len() == 1 { return analyses[0].clone(); }

    let mut merged = analyses[0].clone();
    for analysis in &analyses[1..] {
        if let (Some(base), Some(next)) = (merged.as_object_mut(), analysis.as_object()) {
            // entities: by name dedup
            if let (Some(serde_json::Value::Array(b)), Some(serde_json::Value::Array(n))) = (base.get_mut("entities"), next.get("entities")) {
                let existing: std::collections::HashSet<String> = b.iter()
                    .filter_map(|e| e["name"].as_str().map(String::from)).collect();
                for e in n {
                    if let Some(name) = e["name"].as_str() {
                        if !existing.contains(name) { b.push(e.clone()); }
                    }
                }
            }
            // connections: concat (full cross-chunk dedup would need deep compare; MVP skip)
            if let (Some(serde_json::Value::Array(b)), Some(serde_json::Value::Array(n))) = (base.get_mut("connections"), next.get("connections")) {
                b.extend(n.clone());
            }
            // contradictions: concat
            if let (Some(serde_json::Value::Array(b)), Some(serde_json::Value::Array(n))) = (base.get_mut("contradictions"), next.get("contradictions")) {
                b.extend(n.clone());
            }
        }
    }
    merged
}
```

#### replace_image_paths

```rust
fn replace_image_paths(text: &str, project_id: i32, images: &[(String, Vec<u8>)]) -> String {
    let mut result = text.to_string();
    for (name, _data) in images {
        let old = format!("({})", name);
        let new = format!("(media/{}/{})", project_id, name);
        result = result.replace(&old, &new);
    }
    result
}
```

### Step 4: 跑测试验证全部 PASS

```bash
cargo test -p llm_wiki_server --lib ingest_pipeline::tests -- --nocapture
```
Expected：10 passed, 0 failed

### Step 5: commit

```bash
git add src-server/src/services/ingest_pipeline.rs
git commit -m "feat(src-server): 纯函数（chunk/parse/merge/image_path）+ 10 单元测试（子系统 D Task 1）"
```

---

## Task 2: 缓存层（redis + PG ingested_files）+ 主流程骨架

**Files:**
- Modify: `src-server/src/services/ingest_pipeline.rs`

**目标**：check_step1_cache / cache_step1_result（redis）+ check_ingested_file / mark_file_ingested（PG）+ run_ingest_job / process_source_path 骨架（A/B stub）。

### Step 1: 写缓存层实现

在纯函数后追加：

```rust
// ── 缓存层 ──

use crate::{AppError, AppState};
use sqlx::Row;

const CACHE_TTL: u64 = 7 * 24 * 3600;   // 7 天

async fn check_step1_cache(state: &AppState, content_hash: &str) -> Option<serde_json::Value> {
    let mut redis = state.redis.get().await.ok()?;
    let key = format!("ingest:cache:{}", content_hash);
    let cached: Option<String> = redis::cmd("GET").arg(&key)
        .query_async(&mut *redis).await.ok()?;
    cached.and_then(|s| serde_json::from_str(&s).ok())
}

async fn cache_step1_result(state: &AppState, content_hash: &str, result: &serde_json::Value) -> Result<(), AppError> {
    let mut redis = state.redis.get().await.map_err(AppError::from)?;
    let key = format!("ingest:cache:{}", content_hash);
    let json = serde_json::to_string(result)?;
    redis::cmd("SET").arg(&key).arg(&json).arg("EX").arg(CACHE_TTL)
        .query_async(&mut *redis).await.map_err(AppError::from)?;
    Ok(())
}

struct IngestedFileStatus {
    content_hash: String,
    file_size: i64,
}

async fn check_ingested_file(
    state: &AppState, project_id: i32, original_path: &str,
    content_hash: &str, file_size: i64,
) -> Option<IngestedFileStatus> {
    let row = sqlx::query(
        "SELECT content_hash, file_size FROM ingested_files \
         WHERE project_id = $1 AND original_path = $2"
    )
    .bind(project_id).bind(original_path)
    .fetch_optional(&state.db).await.ok()??;
    Some(IngestedFileStatus {
        content_hash: row.get("content_hash"),
        file_size: row.get("file_size"),
    })
}

async fn mark_file_ingested(
    state: &AppState, project_id: i32, original_path: &str,
    content_hash: &str, file_size: i64, file_type: &str,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO ingested_files (project_id, original_path, content_hash, file_type, file_size) \
         VALUES ($1, $2, $3, $4, $5) \
         ON CONFLICT (project_id, original_path) DO UPDATE SET \
           content_hash = EXCLUDED.content_hash, file_type = EXCLUDED.file_type, \
           file_size = EXCLUDED.file_size, ingested_at = NOW()"
    )
    .bind(project_id).bind(original_path).bind(content_hash).bind(file_type).bind(file_size)
    .execute(&state.db).await?;
    Ok(())
}
```

### Step 2: 写主流程骨架（A/B stub）

```rust
// ── 主流程（A/B stub 版）──

use crate::services::ingest_queue::{IngestJob, IngestJobResult};

/// 核心入口。A/B 未就绪前处理 .md 文件为纯文本（无 LLM）。
/// A 就绪 → 替换 parse_bytes stub。B 就绪 → 替换 step1/step2 stub。
pub async fn run_ingest_job(
    state: &AppState,
    job: &IngestJob,
) -> Result<IngestJobResult, AppError> {
    let team_id: i32 = sqlx::query_scalar(
        "SELECT team_id FROM projects WHERE id = $1", job.project_id
    )
    .fetch_optional(&state.db).await?
    .ok_or_else(|| AppError::ResourceNotFound("project not found".into()))?;

    let mut result = IngestJobResult {
        new_pages: vec![], updated_reserved: vec![], warnings: vec![],
    };

    let total = job.source_paths.len();
    for (i, sp) in job.source_paths.iter().enumerate() {
        ingest_queue::update_job_stage(state, job.id, "parsing",
            (i * 100 / total.max(1)) as i32).await?;

        match process_source_path(state, job.project_id, team_id, sp).await {
            Ok(pages) => {
                for page in &pages {
                    match upsert_wiki_page(state, job.project_id, page).await {
                        Ok(path) => result.new_pages.push(path),
                        Err(e) => result.warnings.push(format!("upsert {}: {}", sp, e)),
                    }
                }
            }
            Err(e) => result.warnings.push(format!("process {}: {}", sp, e)),
        }

        ingest_queue::update_job_stage(state, job.id, "generating",
            ((i + 1) * 100 / total.max(1)) as i32).await?;
    }

    // reserved 重建
    ingest_queue::update_job_stage(state, job.id, "building_index", 100).await?;
    match rebuild_reserved_pages(state, job.project_id).await {
        Ok(reserved) => result.updated_reserved = reserved,
        Err(e) => result.warnings.push(format!("reserved pages: {}", e)),
    }

    // 全部失败 → Err
    if result.new_pages.is_empty() && result.updated_reserved.is_empty() && !result.warnings.is_empty() {
        return Err(AppError::LlmApiError(
            format!("all source_paths failed: {}", result.warnings.join("; "))
        ));
    }

    Ok(result)
}

/// 单 source_path 处理（A/B stub 版——.md 纯文本直接当 page 写）。
async fn process_source_path(
    state: &AppState, project_id: i32, team_id: i32, source_path: &str,
) -> Result<Vec<WikiPageInsert>, AppError> {
    let storage_base = state.config.storage_path();
    let full_path = format!("{}/{}/{}", storage_base.trim_end_matches('/'), team_id, source_path);
    let bytes = tokio::fs::read(&full_path).await
        .map_err(|e| AppError::IoError(e))?;

    // —— A stub: 当 .md 文件为纯文本 ——
    // TODO: A 就绪后替换为 llm_wiki_parser::parse_bytes(source_path, &bytes)
    let text = String::from_utf8(bytes).map_err(|e| AppError::IoError(std::io::Error::new(std::io::ErrorKind::InvalidData, e)))?;

    // 内容去重
    use sha2::{Sha256, Digest};
    let content_hash = format!("{:x}", Sha256::digest(text.as_bytes()));
    let file_size = text.len() as i64;
    if let Some(existing) = check_ingested_file(state, project_id, source_path, &content_hash, file_size).await {
        if existing.content_hash == content_hash && existing.file_size == file_size {
            return Ok(vec![]);
        }
    }

    // —— B stub: 直接当纯文本 page，不做 LLM ——
    // TODO: B 就绪后替换为 step1_cache → step1_analyze → step2_generate → parse_file_blocks
    let path = source_path
        .trim_start_matches(&format!("{}/{}/", storage_base.trim_end_matches('/'), team_id))
        .to_string();
    let title = text.lines().next().and_then(|l| l.strip_prefix("# ").map(String::from));
    let page = WikiPageInsert {
        path: if path.ends_with(".md") { path.clone() } else { format!("{}.md", path) },
        title, content: text,
        frontmatter: serde_json::json!({}), page_type: "concept".into(),
        sources: serde_json::json!([]), images: serde_json::json!([]),
    };

    mark_file_ingested(state, project_id, source_path, &content_hash, file_size, "md").await?;
    Ok(vec![page])
}

async fn upsert_wiki_page(state: &AppState, project_id: i32, page: &WikiPageInsert) -> Result<String, AppError> {
    sqlx::query(
        "INSERT INTO wiki_pages (project_id, path, title, content, frontmatter, page_type, sources, images) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) \
         ON CONFLICT (project_id, path) DO UPDATE SET \
           title = EXCLUDED.title, content = EXCLUDED.content, \
           frontmatter = EXCLUDED.frontmatter, page_type = EXCLUDED.page_type, \
           sources = EXCLUDED.sources, images = EXCLUDED.images, updated_at = NOW()"
    )
    .bind(project_id).bind(&page.path).bind(&page.title).bind(&page.content)
    .bind(&page.frontmatter).bind(&page.page_type).bind(&page.sources).bind(&page.images)
    .execute(&state.db).await?;
    Ok(page.path.clone())
}
```

### Step 3: 实现 reserved 重建

```rust
/// 事务内全量重建 index.md / log.md / overview.md。
/// MVP: 最近 100 条摄入日志（后续按时间窗口扩展，spec §5）。
async fn rebuild_reserved_pages(state: &AppState, project_id: i32) -> Result<Vec<String>, AppError> {
    let mut tx = state.db.begin().await?;

    // index.md
    let pages: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT path, title FROM wiki_pages WHERE project_id = $1 \
         AND path NOT IN ('index.md','log.md','overview.md') ORDER BY path"
    )
    .bind(project_id).fetch_all(&mut *tx).await?;
    let mut index = "# Project Index\n\n".to_string();
    for (path, title) in &pages {
        let name = title.as_deref().unwrap_or(path);
        index.push_str(&format!("- [{}]({})\n", name, path));
    }

    // log.md——最近 100 条
    let log_rows: Vec<(String, chrono::DateTime<chrono::Utc>)> = sqlx::query_as(
        "SELECT original_path, ingested_at FROM ingested_files WHERE project_id = $1 \
         ORDER BY ingested_at DESC LIMIT 100"
    )
    .bind(project_id).fetch_all(&mut *tx).await?;
    let mut log = "# Ingestion Log\n\n".to_string();
    for (path, ts) in &log_rows {
        log.push_str(&format!("- {}: {}\n", ts.format("%Y-%m-%d %H:%M"), path));
    }

    // overview.md
    let page_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM wiki_pages WHERE project_id = $1 \
         AND path NOT IN ('index.md','log.md','overview.md')"
    )
    .bind(project_id).fetch_one(&mut *tx).await?;
    let type_counts: Vec<(String, i64)> = sqlx::query_as(
        "SELECT page_type, count(*) AS cnt FROM wiki_pages WHERE project_id = $1 \
         AND path NOT IN ('index.md','log.md','overview.md') GROUP BY page_type"
    )
    .bind(project_id).fetch_all(&mut *tx).await?;
    let mut overview = format!("# Overview\n\n**Total pages:** {}\n\n", page_count);
    for (t, c) in &type_counts {
        overview.push_str(&format!("- {}: {}\n", t, c));
    }

    // Upsert 三条
    for (path, content) in [
        ("index.md", index), ("log.md", log), ("overview.md", overview),
    ] {
        sqlx::query(
            "INSERT INTO wiki_pages (project_id, path, title, content, page_type) \
             VALUES ($1, $2, $3, $4, 'system') \
             ON CONFLICT (project_id, path) DO UPDATE SET title=$3, content=$4, updated_at=NOW()"
        )
        .bind(project_id).bind(path).bind(path).bind(content)
        .execute(&mut *tx).await?;
    }

    tx.commit().await?;
    Ok(vec!["index.md".into(), "log.md".into(), "overview.md".into()])
}
```

在文件头加必要的 use：

```rust
use crate::services::{self, ingest_queue};
```

### Step 4: 编译 + 全集成测试回归

```bash
cargo build -p llm_wiki_server
cargo test -p llm_wiki_server --lib ingest_pipeline::tests -- --nocapture
cargo test -p llm_wiki_server --test integration
```
Expected：编译 0 error。10 unit tests PASS。全 integration 测试 — Task 1 register + Task 3/4 pages + Task C ingest_queue tests 全 PASS。新 pipeline 函数虽有 A/B stub 但编译通过——stub 逻辑实际可对 .md 文件跑端到端（无需 LLM 即可写 wiki_pages）。

### Step 5: commit

```bash
git add src-server/src/services/ingest_pipeline.rs
git commit -m "feat(src-server): ingest pipeline 主流程 + 缓存 + reserved 重建（A/B stub 版，子系统 D Task 2）"
```

> **注**：主流程中用了 `use sha2::{Sha256, Digest};`——`sha2 = "0.10"` 已在 Cargo.toml deps。若编译报未找到，排查 Cargo.toml 确认 sha2 存在（当前 deps 有 `sha2 = "0.10"`，已验证）。

---

## Task 3: Step1/Step2 LLM 接入 + prompt 真实文本

**Files:**
- Modify: `src-server/src/services/ingest_pipeline.rs`（替换 B stub）
- Modify: `src-server/src/services/prompts/step1_analyze.txt` + `step2_generate.txt`（真实内容）

**前置条件**：子系统 B（llm_stream）已完成——`provider_for_project` + `StreamChatProvider` 可用。若 B 未就绪，本 task 先跳过，A/B stub 版(Task 2)可先合并。

### Step 1: 填充 prompt 真实文本（移植桌面 ingest.ts）

- step1_analyze.txt:从桌面 `src/lib/ingest.ts` 的 Step1 prompt 移植到 Rust static string。
- step2_generate.txt:同上，Step2 prompt 移植。

内容不在此重复（与桌面同步，保持一致性）。

### Step 2: 实现 step1_analyze / step2_generate（替换 stub）

在缓存层后、process_source_path 之前追加：

```rust
// ── 两步 LLM 调用（B 就绪后激活）──

async fn step1_analyze(state: &AppState, project_id: i32, text: &str) -> Result<serde_json::Value, AppError> {
    use crate::services::llm_stream::{self, ChatMessage, ChatOpts};
    let provider = llm_stream::provider_for_project(state, project_id).await?;
    let prompt = include_str!("prompts/step1_analyze.txt");
    let system = "You analyze documents into structured knowledge for a personal wiki.";
    let messages = vec![
        ChatMessage { role: "user".into(), content: format!("{}\n\n<document>\n{}\n</document>", prompt, text) },
    ];
    let opts = ChatOpts { model: provider.model_name().into(), temperature: 0.3,
        max_tokens: 4000, system_prompt: Some(system.into()), timeout_secs: None };
    let (response, _) = provider.chat_to_string(messages, opts).await
        .map_err(|e| AppError::LlmApiError(format!("step1: {}", e)))?;
    serde_json::from_str(&response)
        .map_err(|e| AppError::LlmApiError(format!("step1 JSON parse: {}", e)))
}

async fn step2_generate(state: &AppState, project_id: i32, original_text: &str, step1_json: &serde_json::Value) -> Result<String, AppError> {
    use crate::services::llm_stream::{self, ChatMessage, ChatOpts};
    let provider = llm_stream::provider_for_project(state, project_id).await?;
    let prompt = include_str!("prompts/step2_generate.txt");
    let system = "You generate wiki pages. Output each page as a FILE block.";
    let analysis = serde_json::to_string_pretty(step1_json)?;
    let messages = vec![
        ChatMessage { role: "user".into(), content: format!("{}\n\n<analysis>\n{}\n</analysis>\n\n<source>\n{}\n</source>", prompt, analysis, original_text) },
    ];
    let opts = ChatOpts { model: provider.model_name().into(), temperature: 0.5,
        max_tokens: 16000, system_prompt: Some(system.into()), timeout_secs: None };
    let (response, _) = provider.chat_to_string(messages, opts).await
        .map_err(|e| AppError::LlmApiError(format!("step2: {}", e)))?;
    Ok(response)
}
```

### Step 3: 在 process_source_path 中替换 B stub

找到 `// —— B stub: 直接当纯文本 page，不做 LLM ——` 注释及其后的逻辑，替换为：

```rust
    // —— B: 步骤 5-6-7 ——
    // 查 step1 缓存（content-hash，跨 project 复用）
    let step1_result: serde_json::Value = if let Some(cached) = check_step1_cache(state, &content_hash).await {
        cached
    } else {
        let context_budget = 128_000 - 8000; // TODO: 从 get_llm_config 读 context_size 计算
        let chunks = chunk_document(&text, context_budget);
        let analyses: Vec<serde_json::Value> = if chunks.len() == 1 {
            vec![step1_analyze(state, project_id, &chunks[0]).await?]
        } else {
            let mut v = vec![];
            for chunk in &chunks {
                v.push(step1_analyze(state, project_id, chunk).await?);
            }
            v
        };
        let merged = merge_analyses(&analyses);
        cache_step1_result(state, &content_hash, &merged).await?;
        merged
    };

    let llm_output = step2_generate(state, project_id, &text, &step1_result).await?;
    let blocks = parse_file_blocks(&llm_output);
    let inserts: Vec<WikiPageInsert> = blocks.into_iter().map(|b| WikiPageInsert {
        path: b.path, title: b.title, content: b.content,
        frontmatter: b.frontmatter, page_type: b.page_type,
        sources: b.sources, images: b.images,
    }).collect();
```

### Step 4: 编译 + 全量测试回归

```bash
cargo build -p llm_wiki_server
cargo test -p llm_wiki_server --lib ingest_pipeline::tests -- --nocapture
cargo test -p llm_wiki_server --test integration
```
Expected：编译 0 error。10 unit tests PASS。全 integration 测试 PASS。

### Step 5: commit

```bash
git add src-server/src/services/ingest_pipeline.rs src-server/src/services/prompts/
git commit -m "feat(src-server): LLM 两步接入（step1_analyze + step2_generate）+ 真实 prompt（子系统 D Task 3）"
```

---

## 最终验证（所有 task 完成后）

```bash
cargo build -p llm_wiki_server                    # 0 error
cargo test -p llm_wiki_server --lib                # 所有 lib tests PASS
cargo test -p llm_wiki_server --test integration   # 全 integration PASS
```

---

## Self-Review

**1. Spec 覆盖：**
- §3 run_ingest_job 主入口 → Task 2 ✅
- §4 process_source_path 单文件流程 → Task 2 (A/B stub) + Task 3 (B 激活) ✅
- §5 chunk_document 分块 → Task 1 ✅
- §6 step1/step2 LLM → Task 3 ✅
- §7 parse_file_blocks → Task 1 ✅
- §8 缓存(check_step1/cache_step1/check_ingested_file/mark_file_ingested) → Task 2 ✅
- §9 upsert_wiki_page → Task 2 ✅
- §10 rebuild_reserved_pages → Task 2 ✅
- §11 merge_analyses → Task 1 ✅
- §12 依赖(serde_yaml/sha2/include_str!) → Task 0 ✅
- 全部失败→Err 语义 → Task 2 run_ingest_job 末尾 ✅

**2. 占位符扫描：**
- 1 处 `// TODO: A 就绪后替换`（A stub，设计意图）✅
- 1 处 `// TODO: B 就绪后替换`（B stub，设计意图）✅
- 1 处 `// TODO: 从 get_llm_config 读 context_size`（pipeline 需要知道 context_size，需 B 就绪后接入）✅
- 无 TBD/未定义类型 ✅

**3. 类型一致：**
- `IngestJob` / `IngestJobResult` → 从 `ingest_queue` 路径引用 ✅
- `WikiPageInsert` 在 Task 1 定义，Task 2/3 使用 ✅
- `ParsedBlock` 在 Task 1 parse_file_blocks 定义 ✅
- `run_ingest_job` 签名 → `(state: &AppState, job: &IngestJob) -> Result<IngestJobResult, AppError>` 在 Task 2 正确 ✅
- `chunk_document` 签名 → `(text: &str, context_budget: usize) -> Vec<String>` (budget 改名为参数签名) ✅

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-19-src-server-ingest-pipeline-plan.md`. Two execution options:

**1. Subagent-Driven（推荐）** — 每 task 派发独立 subagent + 两轮 review
**2. Inline Execution** — 本会话批量执行 + checkpoint

Which approach?
