// services/ingest_pipeline.rs — ingest 编排 pipeline

// ── Task 2 主流程 imports ──
use crate::{AppError, AppState};
use crate::services::ingest_queue::{self, IngestJob, IngestJobResult};
use sqlx::Row;

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

/// process_source_path 的产出：解析出的 pages + 用于 mark_file_ingested 的元数据。
/// 元数据上浮到 run_ingest_job，确保只在 wiki_pages 成功落库后才标记文件已摄入
/// （避免 mark 成功但 upsert 失败 → 下次因 hash 命中被永久跳过的漏页问题）。
struct ProcessedSource {
    pages: Vec<WikiPageInsert>,
    content_hash: String,
    file_size: i64,
    file_type: String,
}

// ── 纯函数 ──

/// 估算 token 数（粗糙：字符数 / 4，对齐桌面端 simple token estimator）。
fn estimate_tokens(text: &str) -> usize { text.chars().count() / 4 }

/// 长文档分块：按段落边界（\n\n）拆，每 chunk ≤ context_budget。
/// context_budget = LlmConfig.context_size - 8000（预留 prompt 开销）。
/// 若某段落 > context_budget，按句子边界（。.!?）硬拆。
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
        // 超长段落按句子硬拆（分隔符 . ? ! 。 ，不含 \n）
        if estimate_tokens(p) > context_budget {
            for sent in p.split_inclusive(['.', '?', '!', '。']) {
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

/// FILE block 解析。移植桌面 parseFileBlocks，含 CommonMark code fence 感知。
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

/// 多 chunk 分析合并。entities 去重 + connections concat + contradictions concat。
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
            // connections: concat
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

/// 替换 text 里的原始图片相对路径为 media/{project_id}/ 前缀。
fn replace_image_paths(text: &str, project_id: i32, images: &[(String, Vec<u8>)]) -> String {
    let mut result = text.to_string();
    for (name, _data) in images {
        let old = format!("({})", name);
        let new = format!("(media/{}/{})", project_id, name);
        result = result.replace(&old, &new);
    }
    result
}

// ── 缓存层（redis step1 结果缓存 + PG ingested_files 内容 hash 去重）──

const CACHE_TTL: u64 = 7 * 24 * 3600;   // 7 天

/// 命中缓存返回 step1 分析 JSON；miss / redis 故障 → None（容错，不致命）。
async fn check_step1_cache(state: &AppState, content_hash: &str) -> Option<serde_json::Value> {
    let mut redis = state.redis.get().await.ok()?;
    let key = format!("ingest:cache:{}", content_hash);
    let cached: Option<String> = redis::cmd("GET")
        .arg(&key)
        .query_async(&mut *redis)
        .await
        .ok()?;
    cached.and_then(|s| serde_json::from_str(&s).ok())
}

/// 把 step1 分析结果序列化后写 redis，TTL 7 天。
/// 注意：AppError 无 From<serde_json::Error>，必须 map_err；
/// AppError 无 From<redis::RedisError>（只有 From<deadpool_redis::PoolError>），
/// query_async 错误也必须 map_err 到 InternalError。
async fn cache_step1_result(
    state: &AppState,
    content_hash: &str,
    result: &serde_json::Value,
) -> Result<(), AppError> {
    let mut redis = state.redis.get().await.map_err(AppError::from)?;
    let key = format!("ingest:cache:{}", content_hash);
    let json = serde_json::to_string(result)
        .map_err(|e| AppError::InternalError(format!("serialize cache: {}", e)))?;
    let _: () = redis::cmd("SET")
        .arg(&key)
        .arg(&json)
        .arg("EX")
        .arg(CACHE_TTL)
        .query_async(&mut *redis)
        .await
        .map_err(|e| AppError::InternalError(format!("redis SET: {}", e)))?;
    Ok(())
}

// ── 两步 LLM 调用（子系统 B provider 已就绪）──

/// Step 1：分析单个 chunk → 结构化 JSON（entities / concepts / connections / contradictions）。
async fn step1_analyze(
    state: &AppState,
    project_id: i32,
    text: &str,
) -> Result<serde_json::Value, AppError> {
    use crate::services::llm_stream::{self, ChatMessage, ChatOpts};
    let provider = llm_stream::provider_for_project(state, project_id).await?;
    let prompt = include_str!("prompts/step1_analyze.txt");
    let system = "You analyze documents into structured knowledge for a personal wiki.";
    let messages = vec![ChatMessage {
        role: "user".into(),
        content: format!("{}\n\n<document>\n{}\n</document>", prompt, text),
    }];
    let opts = ChatOpts {
        model: provider.model_name().into(),
        temperature: 0.3,
        max_tokens: 12000,
        system_prompt: Some(system.into()),
        timeout_secs: None,
    };
    let (response, _) = provider
        .chat_to_string(messages, opts)
        .await
        .map_err(|e| AppError::LlmApiError(format!("step1: {}", e)))?;
    serde_json::from_str(&response)
        .map_err(|e| AppError::LlmApiError(format!("step1 JSON parse: {}", e)))
}

/// Step 2：基于 step1 分析 JSON + 原文，生成 FILE blocks 形式的 wiki 页面。
async fn step2_generate(
    state: &AppState,
    project_id: i32,
    original_text: &str,
    step1_json: &serde_json::Value,
) -> Result<String, AppError> {
    use crate::services::llm_stream::{self, ChatMessage, ChatOpts};
    let provider = llm_stream::provider_for_project(state, project_id).await?;
    let prompt = include_str!("prompts/step2_generate.txt");
    let system = "You generate wiki pages. Output each page as a FILE block.";
    // 【编译陷阱】AppError 无 From<serde_json::Error>，必须 map_err。
    let analysis = serde_json::to_string_pretty(step1_json)
        .map_err(|e| AppError::InternalError(format!("serialize step1: {}", e)))?;
    let messages = vec![ChatMessage {
        role: "user".into(),
        content: format!(
            "{}\n\n<analysis>\n{}\n</analysis>\n\n<source>\n{}\n</source>",
            prompt, analysis, original_text
        ),
    }];
    let opts = ChatOpts {
        model: provider.model_name().into(),
        temperature: 0.5,
        max_tokens: 16000,
        system_prompt: Some(system.into()),
        timeout_secs: None,
    };
    let (response, _) = provider
        .chat_to_string(messages, opts)
        .await
        .map_err(|e| AppError::LlmApiError(format!("step2: {}", e)))?;
    Ok(response)
}

struct IngestedFileStatus {
    content_hash: String,
    file_size: i64,
}

/// 查询文件是否已摄入。返回 None 表示未摄入或 DB 错误（容错，按未摄入处理）。
async fn check_ingested_file(
    state: &AppState,
    project_id: i32,
    original_path: &str,
    _content_hash: &str,
    _file_size: i64,
) -> Option<IngestedFileStatus> {
    let row = sqlx::query(
        "SELECT content_hash, file_size FROM ingested_files \
         WHERE project_id = $1 AND original_path = $2",
    )
    .bind(project_id)
    .bind(original_path)
    .fetch_optional(&state.db)
    .await
    .ok()??;
    Some(IngestedFileStatus {
        content_hash: row.get("content_hash"),
        file_size: row.get("file_size"),
    })
}

/// upsert ingested_files 记录（UNIQUE(project_id, original_path)）。
async fn mark_file_ingested(
    state: &AppState,
    project_id: i32,
    original_path: &str,
    content_hash: &str,
    file_size: i64,
    file_type: &str,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO ingested_files (project_id, original_path, content_hash, file_type, file_size) \
         VALUES ($1, $2, $3, $4, $5) \
         ON CONFLICT (project_id, original_path) DO UPDATE SET \
           content_hash = EXCLUDED.content_hash, file_type = EXCLUDED.file_type, \
           file_size = EXCLUDED.file_size, ingested_at = NOW()",
    )
    .bind(project_id)
    .bind(original_path)
    .bind(content_hash)
    .bind(file_type)
    .bind(file_size)
    .execute(&state.db)
    .await?;
    Ok(())
}

// ── 主流程（A/B stub 版）──

/// ingest job 核心入口。A/B 未就绪前处理 .md 文件为纯文本（无 LLM）。
pub async fn run_ingest_job(
    state: &AppState,
    job: &IngestJob,
) -> Result<IngestJobResult, AppError> {
    let team_id: i32 = sqlx::query_scalar("SELECT team_id FROM projects WHERE id = $1")
        .bind(job.project_id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| AppError::ResourceNotFound("project not found".into()))?;

    let mut result = IngestJobResult {
        new_pages: vec![],
        updated_reserved: vec![],
        warnings: vec![],
    };

    let total = job.source_paths.len();
    for (i, sp) in job.source_paths.iter().enumerate() {
        let _ = ingest_queue::update_job_stage(state, job.id, "parsing", (i * 100 / total.max(1)) as i32)
            .await;

        match process_source_path(state, job.project_id, team_id, sp).await {
            Ok(None) => {} // 内容未变，已跳过
            Ok(Some(processed)) => {
                let mut all_upserted = true;
                for page in &processed.pages {
                    match upsert_wiki_page(state, job.project_id, page).await {
                        Ok(path) => result.new_pages.push(path),
                        Err(e) => {
                            result.warnings.push(format!("upsert {}: {}", sp, e));
                            all_upserted = false;
                        }
                    }
                }
                // 仅在 wiki_pages 全部成功落库后才 mark_file_ingested（修复漏页问题：
                // 若先 mark 后 upsert 失败，下次因 hash 命中会跳过，造成永久漏页）。
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
            }
            Err(e) => result.warnings.push(format!("process {}: {}", sp, e)),
        }

        let _ = ingest_queue::update_job_stage(
            state,
            job.id,
            "generating",
            ((i + 1) * 100 / total.max(1)) as i32,
        )
        .await;
    }

    // reserved 重建
    let _ = ingest_queue::update_job_stage(state, job.id, "building_index", 100).await;
    match rebuild_reserved_pages(state, job.project_id).await {
        Ok(reserved) => result.updated_reserved = reserved,
        Err(e) => result.warnings.push(format!("reserved pages: {}", e)),
    }

    // 全部失败 → Err
    if result.new_pages.is_empty()
        && result.updated_reserved.is_empty()
        && !result.warnings.is_empty()
    {
        return Err(AppError::InternalError(format!(
            "all source_paths failed: {}",
            result.warnings.join("; ")
        )));
    }

    Ok(result)
}

/// 单 source_path 处理：A（llm-wiki-parser 全格式解析）+ B（两步 LLM 生成 wiki pages）。
/// 返回 Some(ProcessedSource) 表示需落库；返回 None 表示内容未变已跳过（不再重复 mark）。
async fn process_source_path(
    state: &AppState,
    project_id: i32,
    team_id: i32,
    source_path: &str,
) -> Result<Option<ProcessedSource>, AppError> {
    let storage_base = state.config.storage_path();
    let full_path = crate::services::storage::project_base(storage_base, team_id, project_id)
        .join(source_path);
    let bytes = tokio::fs::read(&full_path).await.map_err(AppError::IoError)?;

    // —— A: 用 llm-wiki-parser 解析文档（按扩展名 dispatch pdf/docx/xlsx/pptx/.md）——
    let parsed = llm_wiki_parser::parse_bytes(source_path, &bytes)
        .map_err(|e| AppError::InternalError(format!("parse {}: {}", source_path, e)))?;
    let file_type = parsed.meta.file_type.clone();
    let text = parsed.text;
    // parsed.images 暂不处理（保留后续扩展）

    // 内容 hash 去重
    use sha2::{Digest, Sha256};
    let content_hash = format!("{:x}", Sha256::digest(text.as_bytes()));
    let file_size = text.len() as i64;
    if let Some(existing) =
        check_ingested_file(state, project_id, source_path, &content_hash, file_size).await
    {
        if existing.content_hash == content_hash && existing.file_size == file_size {
            return Ok(None); // 已摄入且内容未变，跳过（不再重复 mark）
        }
    }

    // —— B: 两步 LLM 流程 ——
    // 查 step1 缓存（content-hash，跨 project 复用）
    let step1_result: serde_json::Value = if let Some(cached) =
        check_step1_cache(state, &content_hash).await
    {
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
}

/// upsert wiki_pages 记录（UNIQUE(project_id, path)）。
async fn upsert_wiki_page(
    state: &AppState,
    project_id: i32,
    page: &WikiPageInsert,
) -> Result<String, AppError> {
    sqlx::query(
        "INSERT INTO wiki_pages (project_id, path, title, content, frontmatter, page_type, sources, images) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) \
         ON CONFLICT (project_id, path) DO UPDATE SET \
           title = EXCLUDED.title, content = EXCLUDED.content, \
           frontmatter = EXCLUDED.frontmatter, page_type = EXCLUDED.page_type, \
           sources = EXCLUDED.sources, images = EXCLUDED.images, updated_at = NOW()",
    )
    .bind(project_id)
    .bind(&page.path)
    .bind(&page.title)
    .bind(&page.content)
    .bind(&page.frontmatter)
    .bind(&page.page_type)
    .bind(&page.sources)
    .bind(&page.images)
    .execute(&state.db)
    .await?;
    Ok(page.path.clone())
}

/// 事务内全量重建 wiki/index.md / wiki/log.md / wiki/overview.md（路径必须带 wiki/ 前缀）。
/// MVP: log.md 取最近 100 条。
async fn rebuild_reserved_pages(
    state: &AppState,
    project_id: i32,
) -> Result<Vec<String>, AppError> {
    let mut tx = state.db.begin().await?;

    // index.md——列出所有非 reserved 页面
    let pages: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT path, title FROM wiki_pages WHERE project_id = $1 \
         AND path NOT IN ('wiki/index.md','wiki/log.md','wiki/overview.md') ORDER BY path",
    )
    .bind(project_id)
    .fetch_all(&mut *tx)
    .await?;
    let mut index = "# Project Index\n\n".to_string();
    for (path, title) in &pages {
        let name = title.as_deref().unwrap_or(path);
        index.push_str(&format!("- [{}]({})\n", name, path));
    }

    // log.md——最近 100 条摄入记录
    let log_rows: Vec<(String, chrono::DateTime<chrono::Utc>)> = sqlx::query_as(
        "SELECT original_path, ingested_at FROM ingested_files WHERE project_id = $1 \
         ORDER BY ingested_at DESC LIMIT 100",
    )
    .bind(project_id)
    .fetch_all(&mut *tx)
    .await?;
    let mut log = "# Ingestion Log\n\n".to_string();
    for (path, ts) in &log_rows {
        log.push_str(&format!("- {}: {}\n", ts.format("%Y-%m-%d %H:%M"), path));
    }

    // overview.md——统计页数与类型分布
    let page_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM wiki_pages WHERE project_id = $1 \
         AND path NOT IN ('wiki/index.md','wiki/log.md','wiki/overview.md')",
    )
    .bind(project_id)
    .fetch_one(&mut *tx)
    .await?;
    let type_counts: Vec<(String, i64)> = sqlx::query_as(
        "SELECT page_type, count(*) AS cnt FROM wiki_pages WHERE project_id = $1 \
         AND path NOT IN ('wiki/index.md','wiki/log.md','wiki/overview.md') GROUP BY page_type",
    )
    .bind(project_id)
    .fetch_all(&mut *tx)
    .await?;
    let mut overview = format!("# Overview\n\n**Total pages:** {}\n\n", page_count);
    for (t, c) in &type_counts {
        overview.push_str(&format!("- {}: {}\n", t, c));
    }

    // Upsert 三条 reserved
    for (path, content) in [
        ("wiki/index.md", index),
        ("wiki/log.md", log),
        ("wiki/overview.md", overview),
    ] {
        sqlx::query(
            "INSERT INTO wiki_pages (project_id, path, title, content, page_type) \
             VALUES ($1, $2, $3, $4, 'system') \
             ON CONFLICT (project_id, path) DO UPDATE SET title=$3, content=$4, updated_at=NOW()",
        )
        .bind(project_id)
        .bind(path)
        .bind(path)
        .bind(content)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;
    Ok(vec![
        "wiki/index.md".into(),
        "wiki/log.md".into(),
        "wiki/overview.md".into(),
    ])
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
        let para = "A".repeat(200);
        let text = format!("{}\n\n{}", para, para);
        let budget = estimate_tokens(&para) + 10;
        let chunks = chunk_document(&text, budget);
        assert_eq!(chunks.len(), 2);
    }

    #[test]
    fn chunk_document_hard_split_long_paragraph() {
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
        // 原始 (name) 形式应被替换；name 作为新前缀子串存在属正常。
        assert!(!result.contains("(page3_image1.png)"));
        assert!(!result.contains("(image2.jpg)"));
    }
}
