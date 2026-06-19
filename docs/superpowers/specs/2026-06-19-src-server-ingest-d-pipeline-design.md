# 子系统 D 详细设计 — ingest 编排 (`services/ingest_pipeline.rs`)

> **状态**：详细设计草稿（2026-06-19）| **上级**：[ingest Plan B 总览设计](2026-06-19-src-server-ingest-design.md) §5
>
> 实现 `run_ingest_job(state, job) → IngestJobResult`：解析(A) → 图片路径替换 → 长文档分块 → content-hash 缓存 → 两步 LLM(B → Step1 分析 → Step2 生成 FILE blocks) → 写 wiki_pages → reserved pages 重建(FOR UPDATE)。D 被 C/worker_loop 调用。

---

## 1. 目标与边界

**D 做什么**：
- 一个函数 `run_ingest_job(state, job) → IngestJobResult` 实现源文档到 wiki 页面的全流程
- 协调 A(解析)、B(LLM)、C(进度更新)三个子系统
- 内置 content-hash 缓存、长文档分块、部分故障容忍

**D 不做什么**：
- 不管理队列/redis 触发(那是 C)
- 不管 API 端点(那是 E)
- 不管 LLM provider 选择/解密(那是 B)
- 不管 prompt 的语言/语气设计(prompt 文本移植桌面 ingest.ts——D 只管**调用** prompt)

**边界**：D 是一个**纯异步函数**。被 `worker_loop`(C) 调用。输入 `&AppState` + `&IngestJob`(含 source_paths/project_id)。输出 `Result<IngestJobResult, AppError>`。进度回写通过 C 的 `update_job_stage`/`mark_job_failed`/`mark_job_succeeded` 接口——D 内部只在每步骤切换时调 `update_job_stage`(终态由 worker 调 `mark_job_*`)。

---

## 2. 模块结构

```
src-server/src/services/ingest_pipeline.rs      (~450 行)
 ├── pub fn run_ingest_job(state, job) → Result<IngestJobResult, AppError>
 ├── fn process_source_path(state, project_id, team_id, source_path) → Vec<WikiPageInsert>
 │    └── 单个 source_path 的完整处理：读文件 → 解析 → 替换路径 → 检查重 → 两步 LLM → FILE blocks
 ├── fn chunk_document(text, budget) → Vec<String>
 │    └── 长文档分块：按段落边界拆，每个 chunk < budget tokens
 ├── fn check_ingested_file_cache(state, project_id, path, content_hash, file_size)
 │    └── 查 ingested_files 表 → (file_type, already_ingested: bool)
 ├── fn check_step1_cache(state, content_hash) → Option<Value>
 │    └── redis ingest:cache:{sha256} → 命中返回缓存 JSON
 ├── fn cache_step1_result(state, content_hash, result)
 │    └── redis SET ingest:cache:{sha256} <JSON> + TTL
 ├── fn parse_file_blocks(llm_output) → Vec<ParsedBlock>
 │    └── 移植桌面 parseFileBlocks → 解析 FILE: ... END FILE 块
 ├── async fn rebuild_reserved_pages(tx, project_id) → Result<Vec<String>, AppError>
 │    └── 事务内 SELECT FOR UPDATE → 全量重建 index/log/overview
 └── #[cfg(test)] mod tests
      ├── test_chunk_document    (纯函数)
      ├── test_parse_file_blocks (纯函数)
      └── test_image_path_replace (纯函数)
```

---

## 3. 核心签名

```rust
/// 完整源文档到 wiki 页面的处理。
/// team_id 由外部查 projects 表传入（见总览 spec §5）。
pub async fn run_ingest_job(
    state: &AppState,
    job: &IngestJob,
) -> Result<IngestJobResult, AppError> {
    // 查 team_id（IngestJob 只有 project_id，团队 ID 用于 storage base URL）
    let team_id: i32 = sqlx::query_scalar(
        "SELECT team_id FROM projects WHERE id = $1", job.project_id
    )
    .fetch_optional(&state.db).await?
    .ok_or(AppError::ResourceNotFound("project not found".into()))?;

    let mut result = IngestJobResult {
        new_pages: vec![],
        updated_reserved: vec![],
        warnings: vec![],
    };

    // 串行处理每个 source_path
    for (i, source_path) in job.source_paths.iter().enumerate() {
        update_job_stage(state, job.id, "parsing", (i * 100 / job.source_paths.len()) as i32).await?;

        match process_source_path(state, job.project_id, team_id, source_path).await {
            Ok(pages) => {
                for page in pages {
                    match upsert_wiki_page(state, job.project_id, &page).await {
                        Ok(path) => result.new_pages.push(path),
                        Err(e) => result.warnings.push(format!("{}: {}", source_path, e)),
                    }
                }
            }
            Err(e) => {
                result.warnings.push(format!("{}: {}", source_path, e));
            }
        }

        // 进度递增
        update_job_stage(state, job.id, "generating", ((i + 1) * 100 / job.source_paths.len()) as i32).await?;
    }

    // reserved pages 重建
    update_job_stage(state, job.id, "building_index", 100).await?;
    match rebuild_reserved_pages(state, job.project_id).await {
        Ok(reserved) => result.updated_reserved = reserved,
        Err(e) => result.warnings.push(format!("reserved pages: {}", e)),
    }

    // 全部 source_paths 都失败 → Err（让 worker 调 mark_job_failed）
    // 至少 1 个成功 → Ok(result) (warnings 收集部分失败)
    if result.new_pages.is_empty() && result.updated_reserved.is_empty() {
        return Err(AppError::LlmApiError(
            format!("all source_paths failed: {}", result.warnings.join("; "))
        ));
    }

    Ok(result)
}
```

---

## 4. process_source_path — 单文件全流程

```
读文件 → A::parse_bytes → ③ 存图片到 storage/media/{pid}/ → ③' 替换 text 图片引用路径
       (page3_image1.png → media/{pid}/page3_image1.png，LLM 可见)
  → ④ 内容去重:查 ingested_files 表比对 content_hash+file_size → 无变化跳过
  → ⑤ 查 step1 缓存(redis ingest:cache:{sha256}) → 命中复用分析 JSON
  → [未命中] ⑥ 长文档分块 → ⑦ Step1 分析(B) → ⑧ global digest 合并 → ⑨ 缓存 result
  → ⑩ Step2 生成(B) → ⑪ parseFileBlocks → ⑫ 逐页 upsert_wiki_page
```

图片路径替换：parser 产出 `text` 里含原始相对路径(`page3_image1.png`)→ 替换成 `media/{project_id}/page3_image1.png`（worker 已把图存到 `storage/media/{pid}/`）。

```rust
struct WikiPageInsert {
    path: String,            // concepts/foo.md (POSIX, 相对 wiki root)
    title: Option<String>,
    content: String,
    frontmatter: serde_json::Value,
    page_type: String,
    sources: serde_json::Value,
    images: serde_json::Value,
}

async fn process_source_path(
    state: &AppState,
    project_id: i32,
    team_id: i32,
    source_path: &str,
) -> Result<Vec<WikiPageInsert>, AppError> {
    // ① 读文件
    let storage_base = state.config.storage_path();
    let full_path = format!("{}/{}/{}", storage_base.trim_end_matches('/'), team_id, source_path);
    let bytes = tokio::fs::read(&full_path).await
        .map_err(|e| AppError::IoError(e))?;

    // ② 解析 → A
    let doc = llm_wiki_parser::parse_bytes(source_path, &bytes)
        .map_err(|e| AppError::InternalError(format!("parse {}: {}", source_path, e)))?;

    // ③ 存图片 + 替换 text 里的路径
    let mut text = doc.text;
    for img in &doc.images {
        let media_dir = format!("{}/media/{}", storage_base.trim_end_matches('/'), project_id);
        tokio::fs::create_dir_all(&media_dir).await?;
        tokio::fs::write(format!("{}/{}", media_dir, img.name), &img.data).await?;
        // 替换原始路径→ media 路径
        text = text.replace(&format!("[{}]({})", img.name, img.name),
                            &format!("[{}](media/{}/{})", img.name, project_id, img.name));
    }

    // ④ 内容去重（ingested_files 表）
    let content_hash = sha256::digest(&text);
    let file_size = bytes.len() as i64;
    if let Some(existing) = check_ingested_file(state, project_id, source_path, &content_hash, file_size).await {
        if existing.hash == content_hash && existing.size == file_size {
            return Ok(vec![/* empty: no change */]);
        }
    }

    // ⑤ 检查 step1 缓存（content-hash，跨 project 共用 LLM 分析）
    let step1_result: serde_json::Value = if let Some(cached) = check_step1_cache(state, &content_hash).await {
        cached
    } else {
        // ⑥ 长文档分块 + step1 LLM(B)
        let chunks = chunk_document(&text, MAX_CONTEXT_TOKENS);
        let analyses = if chunks.len() == 1 {
            let analysis = step1_analyze(state, project_id, &text).await?;
            vec![analysis]
        } else {
            let mut analyses = vec![];
            for chunk in &chunks {
                analyses.push(step1_analyze(state, project_id, chunk).await?);
            }
            analyses
        };
        // global digest → 合并成统一分析 JSON
        let merged = merge_analyses(&analyses);
        // 缓存
        cache_step1_result(state, &content_hash, &merged).await?;
        merged
    };

    // ⑦ step2 LLM(B) → 多个 FILE block → 解析
    let pages = step2_generate(state, project_id, &text, &step1_result).await?;
    let blocks = parse_file_blocks(&pages);
    let inserts: Vec<WikiPageInsert> = blocks.into_iter().map(|b| WikiPageInsert {
        path: b.path, title: b.title, content: b.content,
        frontmatter: b.frontmatter.into(), page_type: b.page_type,
        sources: b.sources.into(), images: b.images.into(),
    }).collect();

    // ⑧ 标记文件已摄入
    mark_file_ingested(state, project_id, source_path, &content_hash, file_size, &doc.meta.file_type).await?;

    Ok(inserts)
}
```

---

## 5. 分块策略

```rust
/// 估算 token 数（粗糙：字符数 / 4，对齐桌面端 simple token estimator）。
fn estimate_tokens(text: &str) -> usize { text.chars().count() / 4 }

const MAX_CONTEXT_TOKENS: usize = 100_000;   // 对齐主流 LLM 上下文窗口

/// 长文档分块：按段落边界（`\n\n`）拆，每 chunk ≤ MAX_CONTEXT_TOKENS。
/// 若某段落 > MAX_CONTEXT_TOKENS，按句子边界（。.）硬拆。
fn chunk_document(text: &str, max_tokens: usize) -> Vec<String> {
    if estimate_tokens(text) <= max_tokens {
        return vec![text.to_string()];
    }
    let paragraphs: Vec<&str> = text.split("\n\n").collect();
    let mut chunks = vec![];
    let mut cur = String::new();
    for p in paragraphs {
        if estimate_tokens(&cur) + estimate_tokens(p) > max_tokens && !cur.is_empty() {
            chunks.push(std::mem::take(&mut cur));
        }
        // 超长段落按句子硬拆
        if estimate_tokens(p) > max_tokens {
            for sent in p.split_inclusive(&['.', '。', '!', '?', '\n'][..]) {
                if estimate_tokens(&cur) + estimate_tokens(sent) > max_tokens && !cur.is_empty() {
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

---

## 6. 两步 LLM 调用

### Step1 — 分析

```rust
async fn step1_analyze(state: &AppState, project_id: i32, text: &str) -> Result<serde_json::Value, AppError> {
    let provider = llm_stream::provider_for_project(state, project_id).await?;
    let prompt = include_str!("prompts/step1_analyze.txt");  // 移植 desktop ingest.ts Step1 prompt
    let system = "You analyze documents into structured knowledge for a personal wiki.";
    let messages = vec![
        ChatMessage { role: "user".into(), content: format!("{}\n\n<document>\n{}\n</document>", prompt, text) },
    ];
    let opts = ChatOpts { model: provider.model_name().into(), temperature: 0.3,
        max_tokens: 4000, system_prompt: Some(system.into()), timeout_secs: None };

    let (response, _usage) = provider.chat_to_string(messages, opts).await
        .map_err(|e| AppError::LlmApiError(format!("step1: {}", e)))?;
    serde_json::from_str(&response)
        .map_err(|e| AppError::LlmApiError(format!("step1 JSON parse: {}", e)))
}
```

**Prompt 策略**：Step1 和 Step2 的 prompt 文本从桌面 `src/lib/ingest.ts` 移植到 `src-server/src/services/prompts/` 目录下的独立 `.txt` 文件。Rust 用 `include_str!` 编译期嵌入（零运行时 IO），参考 spec §5 的移植策略表。Prompt 文本内容不在此设计重复——设计只定接口，内容按桌面端原样搬。

### Step2 — 生成

```rust
async fn step2_generate(state: &AppState, project_id: i32, original_text: &str, step1_json: &serde_json::Value) -> Result<String, AppError> {
    let provider = llm_stream::provider_for_project(state, project_id).await?;
    let prompt = include_str!("prompts/step2_generate.txt");
    let system = "You generate wiki pages. Output each page as a FILE block.";
    let analysis = serde_json::to_string_pretty(step1_json)?;
    let messages = vec![
        ChatMessage { role: "user".into(), content: format!("{}\n\n<analysis>\n{}\n</analysis>\n\n<source>\n{}\n</source>", prompt, analysis, original_text) },
    ];
    let opts = ChatOpts { model: provider.model_name().into(), temperature: 0.5,
        max_tokens: 16000, system_prompt: Some(system.into()), timeout_secs: None };

    let (response, _usage) = provider.chat_to_string(messages, opts).await
        .map_err(|e| AppError::LlmApiError(format!("step2: {}", e)))?;
    Ok(response)
}
```

---

## 7. FILE block 解析

```
桌面 ingest.ts 的 parseFileBlocks 按 ---FILE: path --- ... ---END FILE--- 格式解析。
D 移植此逻辑为 Rust 纯函数——零外部依赖。

步骤：
① 归一化 CRLF→LF
② 逐行遍历，找 ---FILE: ... --- 打开块
③ 累积块内容 → ---END FILE--- 关闭
④ 块内解析：frontmatter(---yaml...--- + body)
```

```rust
struct ParsedBlock {
    path: String,
    title: Option<String>,
    content: String,
    frontmatter: serde_json::Value,
    page_type: String,
    sources: serde_json::Value,
    images: serde_json::Value,
}

fn parse_file_blocks(text: &str) -> Vec<ParsedBlock> {
    let text = text.replace("\r\n", "\n");
    let mut blocks = vec![];
    let mut in_block = false;
    let mut cur_path = String::new();
    let mut cur_content = String::new();

    for line in text.lines() {
        let trimmed = line.trim();
        if let Some(path) = trimmed.strip_prefix("---FILE: ").and_then(|s| s.strip_suffix(" ---")) {
            // 若前一块未关，容错：提交当前
            if in_block && !cur_content.is_empty() {
                blocks.push(parse_single_block(&cur_path, &cur_content));
            }
            cur_path = path.trim().to_string();
            cur_content.clear();
            in_block = true;
        } else if trimmed == "---END FILE---" && in_block {
            blocks.push(parse_single_block(&cur_path, &cur_content));
            in_block = false;
            cur_content.clear();
        } else if in_block {
            cur_content.push_str(line);
            cur_content.push('\n');
        }
    }
    // 关掉最后的未完成块
    if in_block && !cur_content.is_empty() {
        blocks.push(parse_single_block(&cur_path, &cur_content));
    }
    blocks
}

fn parse_single_block(path: &str, content: &str) -> ParsedBlock {
    let (fm, body) = if let Some(m) = content.match_indices("\n---\n").next() {
        let fm_text = &content[..m.0].trim();
        let body = &content[m.0 + m.1.len()..];
        (fm_text, body.to_string())
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

> **差异 vs 桌面**：桌面版 parseFileBlocks 额外处理了 CommonMark 代码围栏兼容性（---END FILE--- 被围栏包裹时不关闭块）。MVP 移植时将对应逻辑也搬过来（约 30 行），但为精简设计不在此全写。

---

## 8. 缓存

### content-hash 缓存（redis）

```rust
const CACHE_TTL: u64 = 7 * 24 * 3600;   // 7 天，跨 project 复用

async fn check_step1_cache(state: &AppState, content_hash: &str) -> Option<serde_json::Value> {
    let mut redis = state.redis.get().await.ok()?;
    let key = format!("ingest:cache:{}", content_hash);
    let cached: Option<String> = redis::cmd("GET").arg(&key).query_async(&mut *redis).await.ok()?;
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
```

### ingested_files 表去重（PG）

```rust
struct IngestedFileStatus {
    content_hash: String,
    file_size: i64,
}

/// 查 ingested_files 表。若记录存在且哈希+大小完全匹配 → Some（已摄入，跳过）；
/// 若无记录或哈希/大小不同 → None（需要重新摄入）。调用方写记录。
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
    Some(IngestedFileStatus { content_hash: row.get("content_hash"), file_size: row.get("file_size") })
}

async fn mark_file_ingested(
    state: &AppState, project_id: i32, original_path: &str,
    content_hash: &str, file_size: i64, file_type: &str,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO ingested_files (project_id, original_path, content_hash, file_type, file_size) \
         VALUES ($1, $2, $3, $4, $5) \
         ON CONFLICT (project_id, original_path) DO UPDATE SET \
           content_hash = EXCLUDED.content_hash, file_type = EXCLUDED.file_type,
           file_size = EXCLUDED.file_size, ingested_at = NOW()"
    )
    .bind(project_id).bind(original_path).bind(content_hash).bind(file_type).bind(file_size)
    .execute(&state.db).await?;
    Ok(())
}
```

---

## 9. wiki_pages 写入与事务策略

```rust
/// 幂等插入——ON CONFLICT upsert。单个 page 失败不阻断 job。
async fn upsert_wiki_page(state: &AppState, project_id: i32, page: &WikiPageInsert) -> Result<String, AppError> {
    sqlx::query(
        "INSERT INTO wiki_pages (project_id, path, title, content, frontmatter, page_type, sources, images) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) \
         ON CONFLICT (project_id, path) DO UPDATE SET \
           title = EXCLUDED.title, content = EXCLUDED.content,
           frontmatter = EXCLUDED.frontmatter, page_type = EXCLUDED.page_type,
           sources = EXCLUDED.sources, images = EXCLUDED.images, updated_at = NOW()"
    )
    .bind(project_id).bind(&page.path).bind(&page.title).bind(&page.content)
    .bind(&page.frontmatter).bind(&page.page_type).bind(&page.sources).bind(&page.images)
    .execute(&state.db).await?;
    Ok(page.path.clone())
}
```

**事务策略**：普通 page 逐条 upsert(不包大事务)，reserved pages 在同事务内(SELECT FOR UPDATE + 写回)。

---

## 10. reserved pages 重建

```rust
/// 单个 project 事务内全量重建 index.md / log.md / overview.md。
/// SELECT FOR UPDATE 锁住所有 wiki_pages（MVP 读锁防竞态）。
async fn rebuild_reserved_pages(state: &AppState, project_id: i32) -> Result<Vec<String>, AppError> {
    let mut tx = state.db.begin().await?;

    // Index —— 目录页
    let pages: Vec<(String, String)> = sqlx::query_as(
        "SELECT path, title FROM wiki_pages WHERE project_id = $1 AND path NOT IN ('index.md','log.md','overview.md') ORDER BY path"
    )
    .bind(project_id).fetch_all(&mut *tx).await?;

    let mut index = "# Project Index\n\n".to_string();
    for (path, title) in &pages {
        let name = title.as_deref().unwrap_or(path);
        index.push_str(&format!("- [{}]({})\n", name, path));
    }

    // Log —— 摄入日志
    let log_rows: Vec<(String, chrono::DateTime<chrono::Utc>)> = sqlx::query_as(
        "SELECT original_path, ingested_at FROM ingested_files WHERE project_id = $1 ORDER BY ingested_at DESC LIMIT 100"
    )
    .bind(project_id).fetch_all(&mut *tx).await?;
    let mut log = "# Ingestion Log\n\n".to_string();
    for (path, ts) in &log_rows {
        log.push_str(&format!("- {}: {}\n", ts.format("%Y-%m-%d %H:%M"), path));
    }

    // Overview —— 总览（统计摘要）
    let page_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM wiki_pages WHERE project_id = $1 AND path NOT IN ('index.md','log.md','overview.md')"
    )
    .bind(project_id).fetch_one(&mut *tx).await?;
    let type_counts: Vec<(String, i64)> = sqlx::query_as(
        "SELECT page_type, count(*) AS cnt FROM wiki_pages WHERE project_id = $1 \
         AND path NOT IN ('index.md','log.md','overview.md') GROUP BY page_type"
    )
    .bind(project_id).fetch_all(&mut *tx).await?;
    let mut overview = format!("# Overview\n\n**Total pages:** {}\n\n", page_count);
    for (t, c) in &type_counts {
        overview.push_str(&format!("- {}: {:?}\n", t, c));
    }

    // Upsert 三条 reserved pages
    for (path, content) in [
        ("index.md", index),
        ("log.md", log),
        ("overview.md", overview),
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

**关于 SELECT FOR UPDATE**：spec 要求重建前锁住索引页面。因 reserved pages 本有 UNIQUE(project_id,path)——内部 `ON CONFLICT DO NOTHING + check` 可行，但 MVP 重建是 `INSERT ON CONFLICT DO UPDATE`，不锁不影响正确性（冲突即可更新，幂等，但不存在两 worker 竞争时某 writer 会读脏数据而其他 writer 覆盖——但这在 MVP 单 worker 场景不发生。多 worker 后可通过 `SELECT ... FOR UPDATE` 先锁后改，当前不为 MVP 加复杂度）。

---

## 11. 合并分析（多 chunk 场景）

```rust
/// 多 chunk 分析合并为统一 JSON。
/// 策略：取第一个分析的 keys，merge 所有分析的实体/概念列表
fn merge_analyses(analyses: &[serde_json::Value]) -> serde_json::Value {
    if analyses.len() == 1 { return analyses[0].clone(); }
    let mut merged = analyses[0].clone();
    if let (Some(base), Some(next)) = (merged.as_object_mut(), analyses[1].as_object()) {
        for (key, val) in next {
            if let serde_json::Value::Array(existing) = base.entry(key.clone()).or_insert_with(|| serde_json::json!([])) {
                if let serde_json::Value::Array(next_arr) = val {
                    existing.extend(next_arr.clone());
                }
            }
        }
    }
    // 后续 chunks 同
    for analysis in &analyses[2..] {
        if let (Some(base), Some(next)) = (merged.as_object_mut(), analysis.as_object()) {
            for (key, val) in next {
                if let (Some(base_val), Some(next_val)) = (base.get_mut(key), Some(val)) {
                    if let (serde_json::Value::Array(b), serde_json::Value::Array(n)) = (base_val, next_val) {
                        b.extend(n.clone());
                    }
                }
            }
        }
    }
    merged
}
```

---

## 12. 依赖

### Rust crates
| 依赖 | 已有? | 用途 |
|------|-------|------|
| `sha2` | ✅ (0.10) | content-hash 计算 |
| `serde_yaml` | ❌ **需加** | FILE block 内的 frontmatter 解析（block content 是 Markdown + YAML header） |
| `serde_json` | ✅ | 分析 JSON 构造/解析 |
| `tokio` | ✅ | 文件异步读写 |
| `sqlx` | ✅ | wiki_pages 写入 + ingested_files 查/写 |
| `redis` | ✅ | 缓存 SET/GET |
| `llm-wiki-parser`(A) | ❌ **A 未实现** | 解析调用——A 未就绪时留 stub |
| `llm_stream`(B) | ❌ **B 未实现** | LLM 调用——B 未就绪时留 stub |

### A/B stub 策略（同 C 的 D stub）

A 未就绪 → `process_source_path` 内 `llm_wiki_parser::parse_bytes(...)` 调 stub 返回假 `ParsedDoc`(text=file bytes as utf8)。后续 A 就绪替换。

B 未就绪 → `step1_analyze`/`step2_generate` 内部 `llm_stream::provider_for_project(...)` 调 stub 返回假 provider(模拟调用)。后续 B 就绪替换。

**stub 实现**：D 的 plan 阶段含单元测(纯函数 chunk/parse_file_blocks/merge 可测编译过)，集成测试需 A+B 就绪后加。

---

## 13. 测试策略

| 类型 | 内容 | 实现 |
|------|------|------|
| unit: chunk_document | 短文本不分块、长文本按段落边界拆、超长段落按句子硬拆 | table-driven |
| unit: parse_file_blocks | 给定合法/不合法 FILE/END FILE 序列→期望 ParsedBlock 数组 | table-driven |
| unit: merge_analyses | 2/3 段分析 → 合并的 JSON | table-driven |
| unit: image_path_replace | 给定 ParsedDoc(含图片) → 期望 text 里的路径替换 | table-driven |
| unit: check_step1_cache | mock redis → 命中/未命中 | mock |
| integ: 全流程 E2E(小 .md 文件) | 真实 PG+redis+LLM stub → 验证 wiki_pages 写入 | **需 A+B 就绪后加** |

纯函数测试(table-driven)在 D 的 plan 阶段先提(不依赖 A/B)。集成测试推迟到 A+B 就绪。

---

## 14. 文件改动清单

| 文件 | 改动 |
|------|------|
| `src-server/src/services/ingest_pipeline.rs` | **Create** (~450 行) |
| `src-server/src/services/prompts/step1_analyze.txt` | **Create**(移植桌面 prompt) |
| `src-server/src/services/prompts/step2_generate.txt` | **Create**(移植桌面 prompt) |
| `src-server/src/services/mod.rs` | 加 `pub mod ingest_pipeline;` |
| `src-server/Cargo.toml` | 加 `serde_yaml = "0.9"` |
