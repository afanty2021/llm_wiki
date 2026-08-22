// services/ingest_pipeline.rs — ingest 编排 pipeline

// ── Task 2 主流程 imports ──
use crate::{AppError, AppState};
use crate::services::ingest_queue::{self, IngestJob, IngestJobResult};
use crate::services::llm_stream::{self, ChatMessage, ChatOpts};
use sqlx::Row;

// ── 共用模型 ──

#[derive(Debug, Clone)]
struct ParsedBlock {
    path: String, title: Option<String>, content: String,
    frontmatter: serde_json::Value, page_type: String,
    sources: serde_json::Value, images: serde_json::Value,
}

#[derive(Debug, Clone)]
pub(crate) struct WikiPageInsert {
    pub(crate) path: String,
    pub(crate) title: Option<String>,
    pub(crate) content: String,
    pub(crate) frontmatter: serde_json::Value,
    pub(crate) page_type: String,
    pub(crate) sources: serde_json::Value,
    pub(crate) images: serde_json::Value,
}

/// process_source_path 的产出：解析出的 pages + 用于 mark_file_ingested 的元数据。
/// 元数据上浮到 run_ingest_job，确保只在 wiki_pages 成功落库后才标记文件已摄入
/// （避免 mark 成功但 upsert 失败 → 下次因 hash 命中被永久跳过的漏页问题）。
struct ProcessedSource {
    pages: Vec<WikiPageInsert>,
    reviews: Vec<crate::services::review::ParsedReview>,
    content_hash: String,
    file_size: i64,
    file_type: String,
}

// ── 纯函数 ──

/// 估算 token 数（粗糙：字符数 / 4，对齐桌面端 simple token estimator）。
fn estimate_tokens(text: &str) -> usize { text.chars().count() / 4 }

// ── W3（m3-impl-review）：ingest 语言规则提为 project 级配置 ──
// zh-batch（32b7395a）把「输出简体中文」硬编码进共享 prompt 与 reserved 三模板，
// 本 server 所有项目的摄取都被迫中文。现改为：projects.ingest_language（迁移 017，
// NULL = 不注入语言指令 = 原英文中性行为）驱动 prompt 注入 + reserved 模板分流。

/// LANGUAGE RULE 注入文本。Some(language) → 指令段（语言值原样内插，路径/frontmatter
/// 键/type 枚举保持英文）；None → 空串（{{LANGUAGE_RULE}} 占位符抹除）。
pub(crate) fn language_rule_text(language: Option<&str>) -> String {
    match language {
        None => String::new(),
        Some(language) => format!(
            "LANGUAGE RULE (mandatory): All human-readable output text \
             (titles, descriptions, body, review text) MUST be in {language}. \
             Keep paths/frontmatter keys/type enums in English. Proper nouns, brand \
             names, and well-known acronyms (e.g. TKT, TBLT, IELTS) may stay in \
             their original form."
        ),
    }
}

/// 把 prompt 模板里的 {{LANGUAGE_RULE}} 占位符替换为注入文本（None → 空串）。
/// 占位符必须被替换而非残留（测试断言无 `{{` 残留）。
pub(crate) fn render_prompt(template: &str, language: Option<&str>) -> String {
    template.replace("{{LANGUAGE_RULE}}", &language_rule_text(language))
}

/// step1 prompt（含占位符渲染）。抽为独立函数供 prompt 注入单测。
pub(crate) fn step1_prompt(language: Option<&str>) -> String {
    render_prompt(include_str!("prompts/step1_analyze.txt"), language)
}

/// step2 prompt（含占位符渲染 + 始终注入的 W2 path slug 约束段——后者写在 .txt 模板
/// 本体，非语言规则，普适生效）。
pub(crate) fn step2_prompt(language: Option<&str>) -> String {
    render_prompt(include_str!("prompts/step2_generate.txt"), language)
}

/// reserved 三模板的语言分流：language 含「中文/Chinese/zh」（大小写不敏感）→ 中文
/// 文案（现行为）；None 或其他语言 → 英文文案（zh-batch 前的原文恢复为代码内常量）。
fn is_chinese_language(language: Option<&str>) -> bool {
    match language {
        None => false,
        Some(language) => {
            let lower = language.to_lowercase();
            lower.contains("中文") || lower.contains("chinese") || lower.contains("zh")
        }
    }
}

/// 双语文案分流：中文语言 → zh，否则（None/英文/其他）→ en。
fn localized<'a>(language: Option<&str>, zh: &'a str, en: &'a str) -> &'a str {
    if is_chinese_language(language) { zh } else { en }
}
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

/// W2（m3-impl-review 次级收编）：step2 生成的 FILE block path 确定性校验。
/// 合法形态 = ASCII slug：仅 `[a-z0-9]` 与 `-` `_` `/` `.`（拒绝中文/空格/大写等）。
/// 违规 path → 该页按解析失败处理（不入 blocks，warn 留痕）。transcripts/ 前缀路径
/// 本就是 ASCII slug 形态，照常通过——run_ingest_job 的 transcripts/ 对账守卫
/// （is_llm_generated_path）与计账逻辑不受影响。允许集全 ASCII，按字节判定即可
/// （UTF-8 多字节序列的每个字节都非允许集，必被拒绝）。
fn is_valid_wiki_path(path: &str) -> bool {
    !path.is_empty()
        && path
            .bytes()
            .all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'/' | b'.'))
}

/// parse_file_blocks 的落块口：path 过 W2 确定性校验才入 blocks，否则该页按
/// 解析失败处理（丢弃 + warn）。
fn push_validated_block(blocks: &mut Vec<ParsedBlock>, path: &str, content: &str) {
    if is_valid_wiki_path(path) {
        blocks.push(parse_single_block(path, content));
    } else {
        tracing::warn!(
            path = %path,
            "step2 FILE block path is not an ASCII slug (W2), treating page as parse failure"
        );
    }
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
                    push_validated_block(&mut blocks, &cur_path, &cur_content);
                }
                cur_path = path.trim().to_string();
                cur_content.clear();
                in_block = true;
                continue;
            }
            if trimmed == "---END FILE---" && in_block {
                push_validated_block(&mut blocks, &cur_path, &cur_content);
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
        push_validated_block(&mut blocks, &cur_path, &cur_content);
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

/// R10（m3-impl-review 次级收编）：step1 merged 结果形状守卫——非对象直接报错
/// （走解析失败路径），不再放行进 step2。Task 6 r3 时仅跳过缓存写但仍流向 step2：
/// 非对象分析（"[]"/"null"/标量）进 step2 会基于空分析产出无效 wiki 页；宁可本次
/// source 失败（item_state=failed，由 resume/重试自愈），也不产出坏页。
fn merged_step1_result(
    project_id: i32,
    merged: serde_json::Value,
) -> Result<serde_json::Value, AppError> {
    if merged.is_object() {
        Ok(merged)
    } else {
        tracing::warn!(
            project_id,
            shape = type_of_value(&merged),
            "step1 merged result is not an object, failing this source (no step2)"
        );
        Err(AppError::LlmApiError(format!(
            "step1 merged result is not a JSON object (got {}), refusing to feed step2",
            type_of_value(&merged)
        )))
    }
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

/// 命中缓存返回 step1 分析 JSON；miss / redis 故障 / **缓存值为非对象**（Task 6 r3：
/// 旧版本可能已把 "[]"/"null" 形态写进缓存——非对象视同 miss，重跑真实分析）→ None。
async fn check_step1_cache(state: &AppState, content_hash: &str) -> Option<serde_json::Value> {
    let mut redis = state.redis.get().await.ok()?;
    let key = format!("ingest:cache:{}", content_hash);
    let cached: Option<String> = redis::cmd("GET")
        .arg(&key)
        .query_async(&mut *redis)
        .await
        .ok()?;
    cached
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .filter(|v| v.is_object())
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

/// step1 max_tokens 档位。原 12000 是首批 ingest 7/48 失败的根因（step1 JSON 截断）。
const STEP1_MAX_TOKENS: u32 = 32000;
/// 上下文超限时的降档档位（prompt+completion 超模型窗口 → 降 max_tokens 重试一次，不做无界重试）。
const STEP1_FALLBACK_MAX_TOKENS: u32 = 16000;

/// 判定 LlmError 是否为上下文超限（prompt+completion 超出模型窗口）。
/// 只匹配 LlmError::ApiError（HTTP 错误体）——主流 provider 的 context 超限均以
/// API 错误文案报告，例如：
///   - OpenAI/vLLM: "This model's maximum context length is 32768 tokens. However, ..."
///   - Anthropic:   "prompt is too long: 156213 tokens > 200000 maximum"
/// 大小写不敏感子串匹配："context"（覆盖 "maximum context length" / "context_length_exceeded"）、
/// "too long"、"max tokens"、"max_tokens"（OpenAI 兼容网关的下划线变体，如
/// "max_tokens is too large for this model"）。误报代价仅为一次无害的
/// 16000 降档重试，故取宽匹配。
fn is_context_limit_error(e: &crate::services::llm_stream::LlmError) -> bool {
    match e {
        crate::services::llm_stream::LlmError::ApiError { body, .. } => {
            let lower = body.to_lowercase();
            lower.contains("context")
                || lower.contains("too long")
                || lower.contains("max tokens")
                || lower.contains("max_tokens")
        }
        _ => false,
    }
}

/// step1 单次 LLM 调用封装：构造 messages/ChatOpts（max_tokens=STEP1_MAX_TOKENS），
/// 上下文超限时降档 STEP1_FALLBACK_MAX_TOKENS 重试一次（不做无界重试）。
/// 返回 (响应文本, usage, 实际生效的 max_tokens)——生效档位供调用方按真实上限判截断。
/// 抽为独立函数（provider 注入）以便对 ChatOpts / 重试语义做单元测试。
async fn step1_chat(
    provider: &dyn crate::services::llm_stream::StreamChatProvider,
    project_id: i32,
    system: &str,
    prompt: &str,
    text: &str,
) -> Result<(String, Option<(u32, u32)>, u32), AppError> {
    use crate::services::llm_stream::{ChatMessage, ChatOpts};
    let messages = vec![ChatMessage {
        role: "user".into(),
        content: format!("{}\n\n<document>\n{}\n</document>", prompt, text),
    }];
    let opts = ChatOpts {
        model: provider.model_name().into(),
        temperature: 0.3,
        max_tokens: STEP1_MAX_TOKENS,
        system_prompt: Some(system.into()),
        timeout_secs: None,
    };
    match provider.chat_to_string(messages.clone(), opts.clone()).await {
        Ok((response, usage)) => Ok((response, usage, STEP1_MAX_TOKENS)),
        Err(e) if is_context_limit_error(&e) => {
            tracing::warn!(project_id, "ingest step1 context limit, retry with max_tokens 16000");
            let mut retry_opts = opts;
            retry_opts.max_tokens = STEP1_FALLBACK_MAX_TOKENS;
            provider
                .chat_to_string(messages, retry_opts)
                .await
                .map(|(response, usage)| (response, usage, STEP1_FALLBACK_MAX_TOKENS))
                .map_err(|e| AppError::LlmApiError(format!("step1: {}", e)))
        }
        Err(e) => Err(AppError::LlmApiError(format!("step1: {}", e))),
    }
}

/// Step 1：分析单个 chunk → 结构化 JSON（entities / concepts / connections / contradictions）。
/// W3：`language` 来自 projects.ingest_language（None → prompt 不注入语言指令）。
async fn step1_analyze(
    state: &AppState,
    project_id: i32,
    text: &str,
    language: Option<&str>,
) -> Result<serde_json::Value, AppError> {
    let provider = crate::services::llm_stream::provider_for_project(state, project_id).await?;
    let prompt = step1_prompt(language);
    let system = "You analyze documents into structured knowledge for a personal wiki.";
    step1_analyze_via(&*provider, project_id, system, &prompt, text).await
}

/// step1 的 LLM 调用 + 宽容解析（provider 注入，便于对重试语义做单元测试——同 step1_chat 模式）。
/// 两次解析（直接 + fuzzy）均失败时自动重试一次完整 LLM 调用（瞬态模型输出兜底：
/// 本地 omlx 内存压力下可能提前 EOS 输出半截 JSON 且 finish_reason=stop，重发同样请求即恢复）。
/// 仅针对解析失败重试；LLM 传输错误沿用 step1_chat 既有语义（立即失败）。
async fn step1_analyze_via(
    provider: &dyn crate::services::llm_stream::StreamChatProvider,
    project_id: i32,
    system: &str,
    prompt: &str,
    text: &str,
) -> Result<serde_json::Value, AppError> {
    let (mut response, mut usage, mut effective_max_tokens) =
        step1_chat(provider, project_id, system, prompt, text).await?;
    for attempt in 1..=2 {
        if attempt > 1 {
            tracing::warn!(project_id, "step1 parse failed, retrying once (transient model output)");
            let (r, u, m) = step1_chat(provider, project_id, system, prompt, text).await?;
            response = r;
            usage = u;
            effective_max_tokens = m;
        }
        if let Some((pt, ct)) = usage {
            tracing::info!(project_id, prompt_tokens = pt, completion_tokens = ct, "ingest step1 usage");
            if ct >= effective_max_tokens {
                tracing::warn!(project_id, "ingest step1 likely truncated (completion>=max_tokens)");
            }
        }
        // 宽容解析：先直接 from_str；失败则抠最外层 {...}（兼容 Qwen3 thinking 残留、
        // markdown fence、前导文字）。与 llm_stream 的 enable_thinking=false 双保险。
        // **形状校验（Task 6 r3）**：合法 JSON 但非对象（"[]"/"null"/标量——serde 能
        // 解析的形态）与解析失败同路径：不返回、走重试；绝不放行非对象进 step2 /
        // step1 缓存（一次放行 = 同 content-hash 永久污染）。
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&response) {
            if v.is_object() {
                return Ok(v);
            }
            tracing::warn!(
                project_id,
                "step1 JSON is not an object (got {}), treating as parse failure",
                type_of_value(&v)
            );
        } else if let Some(v) = extract_json_object(&response) {
            tracing::warn!("step1: 直接 JSON 解析失败，fuzzy 提取兜底成功");
            return Ok(v); // extract_json_object 只产出最外层 {...}，必为对象
        }
    }
    let head: String = response.chars().take(80).collect();
    Err(AppError::LlmApiError(format!(
        "step1 JSON parse failed（无有效 JSON 对象，retried once）| head: {:?}",
        head
    )))
}

/// serde_json::Value 的形状名（日志用：非对象拒绝时说明拿到的是 array/null/标量）。
fn type_of_value(v: &serde_json::Value) -> &'static str {
    match v {
        serde_json::Value::Null => "null",
        serde_json::Value::Bool(_) => "bool",
        serde_json::Value::Number(_) => "number",
        serde_json::Value::String(_) => "string",
        serde_json::Value::Array(_) => "array",
        serde_json::Value::Object(_) => "object",
    }
}

/// 从文本抠出最外层 `{...}` 并解析。处理 Qwen3 thinking 链、```json fence、前导文字。
fn extract_json_object(s: &str) -> Option<serde_json::Value> {
    let bytes = s.as_bytes();
    let start = bytes.iter().position(|&b| b == b'{')?;
    let mut depth = 0i32;
    let mut in_str = false;
    let mut esc = false;
    for (i, &b) in bytes.iter().enumerate().skip(start) {
        if esc {
            esc = false;
            continue;
        }
        if b == b'\\' {
            esc = true;
            continue;
        }
        if b == b'"' {
            in_str = !in_str;
            continue;
        }
        if in_str {
            continue;
        }
        if b == b'{' {
            depth += 1;
        } else if b == b'}' {
            depth -= 1;
            if depth == 0 {
                return serde_json::from_str(&s[start..=i]).ok();
            }
        }
    }
    None
}

/// Step 2：基于 step1 分析 JSON + 原文，生成 FILE blocks 形式的 wiki 页面。
/// W3：`language` 来自 projects.ingest_language（None → prompt 不注入语言指令，
/// path slug 约束等普适段始终在模板本体）。
async fn step2_generate(
    state: &AppState,
    project_id: i32,
    original_text: &str,
    step1_json: &serde_json::Value,
    language: Option<&str>,
) -> Result<String, AppError> {
    let provider = llm_stream::provider_for_project(state, project_id).await?;
    let prompt = step2_prompt(language);
    let system = "You generate wiki pages. Output each page as a FILE block.";
    step2_generate_via(&*provider, system, &prompt, original_text, step1_json).await
}

/// step2 的 LLM 调用（provider 注入，与 step1_analyze_via 同模式——prompt 注入单测
/// 用 ScriptedProvider 捕获实际收到的 prompt 文本）。
async fn step2_generate_via(
    provider: &dyn llm_stream::StreamChatProvider,
    system: &str,
    prompt: &str,
    original_text: &str,
    step1_json: &serde_json::Value,
) -> Result<String, AppError> {
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

/// LLM 生成页路径守卫（Task 2 / spec §3.2-⑤ 防御）：path 是否落入 transcripts/ 命名空间。
/// transcripts/ 前缀页由 transcriber CLI 写入（创建即嵌入），ingest step2 的 LLM 生成页
/// 禁止写入该前缀——upsert 是 ON CONFLICT DO UPDATE，LLM 输出撞名即覆写 CLI 转写页。
fn is_llm_generated_path(path: &str) -> bool {
    path.starts_with("transcripts/")
}

/// upsert 循环单页写入结果——run_ingest_job 的计账模型（fold_page_write_outcomes 的输入）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PageWriteOutcome {
    /// transcripts/ 命名空间守卫跳过（spec §3.2-⑤）：未写入，计账上视为已处理。
    GuardSkipped,
    /// upsert 成功落库。
    Upserted,
    /// upsert 失败。
    UpsertFailed,
}

/// 折叠单页写入结果 → (pages_written, all_upserted)。纯函数抽出，供单测覆盖计账联动。
/// item 失败条件是 `pages_written == 0 && pages_to_write > 0`——守卫跳过必须计入
/// pages_written，否则"唯一生成页撞 transcripts/ 前缀"的源会被误标 failed；
/// 同时守卫跳过不算 upsert 失败（all_upserted 保持 true → mark_file_ingested /
/// review 插入照常：source 已处理，resume 不必重跑 LLM）。
fn fold_page_write_outcomes(outcomes: &[PageWriteOutcome]) -> (usize, bool) {
    let pages_written = outcomes.iter().filter(|o| **o != PageWriteOutcome::UpsertFailed).count();
    let all_upserted = !outcomes.iter().any(|o| *o == PageWriteOutcome::UpsertFailed);
    (pages_written, all_upserted)
}

/// W3：加载 project 行的 ingest 上下文（team_id + ingest_language，单查询）。
/// ingest_language 语义（迁移 017）：NULL → 不注入语言指令（原英文中性行为）；
/// 有值 → prompt 注入 LANGUAGE RULE + reserved 三模板语言分流。
/// pub 供集成测试验证装配链（SQL 设值 → Some；默认 NULL → None）。
pub async fn load_project_ingest_context(
    state: &AppState,
    project_id: i32,
) -> Result<(i32, Option<String>), AppError> {
    sqlx::query_as("SELECT team_id, ingest_language FROM projects WHERE id = $1")
        .bind(project_id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| AppError::ResourceNotFound("project not found".into()))
}

/// ingest job 核心入口。A/B 未就绪前处理 .md 文件为纯文本（无 LLM）。
pub async fn run_ingest_job(
    state: &AppState,
    job: &IngestJob,
) -> Result<IngestJobResult, AppError> {
    let (team_id, ingest_language) = load_project_ingest_context(state, job.project_id).await?;
    let language = ingest_language.as_deref();

    let mut result = IngestJobResult {
        new_pages: vec![],
        updated_reserved: vec![],
        warnings: vec![],
    };

    // 收集所有成功落库页的 (path, content) 供批量嵌入（覆盖 source 页 + reserved 页）。
    let mut collected: Vec<(String, String)> = Vec::new();

    // 本次 run 中成功（done）的 source 计数 —— 用于 all-failed 判定。
    // 注意：不能用 job.item_states 快照（不含本次 run 的写入，会误判 all-failed）。
    let mut done_this_run = 0usize;

    let total = job.source_paths.len();
    for (i, sp) in job.source_paths.iter().enumerate() {
        // 取消检查点（每 source 前）
        if let Err(e) = ingest_queue::check_cancel(state, job.id).await {
            return Err(e); // AppError::Cancelled，已 mark_cancelled
        }
        // 部分续传：item_states 中该 source 已 done → 跳过（省 LLM/embedding）
        let already_done = job
            .item_states
            .as_array()
            .map(|arr| {
                arr.iter().any(|v| {
                    v.get("path").and_then(|p| p.as_str()) == Some(sp.as_str())
                        && v.get("status").and_then(|s| s.as_str()) == Some("done")
                })
            })
            .unwrap_or(false);
        if already_done {
            // 已完成的 source 计入 done_this_run——避免 resume 时「剩余 source 全失败」误判 all-failed
            // （prior-done 代表历史成功，不应让本次剩余全失败把整个 job 标 failed；只停不清，数据已在）
            done_this_run += 1;
            continue;
        }

        let _ = ingest_queue::update_job_stage(state, job.id, "parsing", (i * 100 / total.max(1)) as i32)
            .await;

        match process_source_path(state, job.project_id, team_id, sp, language).await {
            Ok(None) => {
                // 内容未变，视为 done
                let _ =
                    ingest_queue::update_item_state(state, job.id, sp, "done", None).await;
                done_this_run += 1;
            } // 内容未变，已跳过
            Ok(Some(processed)) => {
                let pages_to_write = processed.pages.len();
                let mut outcomes: Vec<PageWriteOutcome> = Vec::with_capacity(pages_to_write);
                for page in &processed.pages {
                    // transcripts/ 命名空间守卫（spec §3.2-⑤ 防御）：该前缀页由 transcriber
                    // CLI 写入（创建即嵌入），LLM 生成页禁止覆写。跳过计入 pages_written
                    // （计账联动，见 fold_page_write_outcomes）→ 唯一页撞前缀仍判 done。
                    if is_llm_generated_path(&page.path) {
                        tracing::warn!(path = %page.path, source = %sp, "skip LLM page into transcripts/ namespace");
                        outcomes.push(PageWriteOutcome::GuardSkipped);
                        continue;
                    }
                    match upsert_wiki_page(state, job.project_id, page).await {
                        Ok(path) => {
                            result.new_pages.push(path.clone());
                            if let Some(text) = page_content_for_embed(page) {
                                collected.push((path, text));
                            }
                            outcomes.push(PageWriteOutcome::Upserted);
                        }
                        Err(e) => {
                            result.warnings.push(format!("upsert {}: {}", sp, e));
                            outcomes.push(PageWriteOutcome::UpsertFailed);
                        }
                    }
                }
                let (pages_written, all_upserted) = fold_page_write_outcomes(&outcomes);
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
                    // Phase B: 页落库 + mark 成功后才插 review（守 deferred-write 不变量）
                    if !processed.reviews.is_empty() {
                        if let Err(e) = crate::services::review::insert_review_items(
                            state,
                            job.project_id,
                            &processed.reviews,
                        )
                        .await
                        {
                            result.warnings.push(format!("insert reviews for {}: {}", sp, e));
                        }
                    }
                }
                // #1 修正（code-review all-failed 回归）：仅当本次写了页面（或本就无页面可写）才计 done。
                // 所有 upsert 失败（pages_to_write>0 但 pages_written==0）→ 标 failed、不计 done_this_run，
                // 让 all-failed 守卫（done_this_run==0）正确触发 + resume 重试该 source（避免静默 succeeded_with_warnings）。
                // Task 2 计账联动：transcripts/ 守卫跳过已计入 pages_written（fold_page_write_outcomes），
                // "唯一生成页撞前缀"的源判 done 非 failed（跳过即已处理，非失败）。
                if pages_written > 0 || pages_to_write == 0 {
                    let _ = ingest_queue::update_item_state(state, job.id, sp, "done", None).await;
                    done_this_run += 1;
                } else {
                    let _ = ingest_queue::update_item_state(
                        state,
                        job.id,
                        sp,
                        "failed",
                        Some("all page upserts failed"),
                    )
                    .await;
                }
            }
            Err(e) => {
                result.warnings.push(format!("process {}: {}", sp, e));
                let _ =
                    ingest_queue::update_item_state(state, job.id, sp, "failed", Some(&e.to_string()))
                        .await;
            }
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
    if let Err(e) = ingest_queue::check_cancel(state, job.id).await {
        return Err(e);
    }
    let _ = ingest_queue::update_job_stage(state, job.id, "building_index", 100).await;
    match rebuild_reserved_pages(state, job.project_id, language).await {
        Ok(reserved) => {
            result.updated_reserved = reserved.iter().map(|(p, _)| p.clone()).collect();
            collected.extend(reserved);  // reserved 页也纳入嵌入
        }
        Err(e) => result.warnings.push(format!("reserved pages: {}", e)),
    }

    // all-failed 判定（修正既存 bug：现行 updated_reserved.is_empty() 恒假）
    // 本次 run 中所有 source 都失败（done_this_run==0）且有 warnings → Err（落入 worker 的 mark_job_failed）
    // CRITICAL: 用 LOCAL done_this_run，不用 job.item_states 快照（不含本次 run 写入，会误判）。
    let total_sources = job.source_paths.len();
    if total_sources > 0 && done_this_run == 0 && !result.warnings.is_empty() {
        return Err(AppError::InternalError(format!(
            "all {} source(s) failed: {}",
            total_sources,
            result.warnings.join("; ")
        )));
    }

    // 批量嵌入（rebuild 之后，覆盖 source + reserved）
    if let Err(e) = ingest_queue::check_cancel(state, job.id).await {
        return Err(e);
    }
    if !collected.is_empty() {
        if let Err(e) = crate::services::embedding::embed_and_store(
            &*state.vector_store,
            state.config.embedding.as_ref(),
            &state.http,
            job.project_id,
            &collected,
        )
        .await
        {
            result.warnings.push(format!("embed batch: {}", e));
        }
    }

    Ok(result)
}

/// 单 source_path 处理：A（llm-wiki-parser 全格式解析）+ B（两步 LLM 生成 wiki pages）。
/// 返回 Some(ProcessedSource) 表示需落库；返回 None 表示内容未变已跳过（不再重复 mark）。
/// W3：`language` 来自 projects.ingest_language，穿透到 step1/step2/dedicated review 三处 prompt。
async fn process_source_path(
    state: &AppState,
    project_id: i32,
    team_id: i32,
    source_path: &str,
    language: Option<&str>,
) -> Result<Option<ProcessedSource>, AppError> {
    // 经 StorageBackend trait 读字节（Phase 1 抽象收敛：与 files.rs docx/xlsx 分支一致，S3 就绪）
    let bytes = state.storage.read_bytes(team_id, project_id, source_path).await?;

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
        // context_budget 从 team provider 的 context_size 推导，适配不同模型
        // (如 Qwen3.6-35B-A3B 可能非 128k)；无 provider 配置时回退 128k（与原
        // 硬编码一致，不引入回归）；.max(8000) 保留下限防止 context_size<8000 下溢。
        let context_size = crate::services::llm::get_llm_config(&state.db, project_id)
            .await
            .map(|c| c.context_size)
            .unwrap_or(128_000);
        let context_budget = ((context_size - 8000).max(8000)) as usize;
        let chunks = chunk_document(&text, context_budget);
        let analyses: Vec<serde_json::Value> = if chunks.len() == 1 {
            vec![step1_analyze(state, project_id, &chunks[0], language).await?]
        } else {
            let mut v = vec![];
            for chunk in &chunks {
                v.push(step1_analyze(state, project_id, chunk, language).await?);
            }
            v
        };
        let merged = merge_analyses(&analyses);
        // 形状守卫（评审 R10）：非对象 merged → 直接报错走解析失败路径（本次 source
        // failed，resume 可重试），不再「仅跳过缓存仍流向 step2」。is_object 才入
        // 缓存（Task 6 r3 belt-and-braces）——守卫通过后此处 merged 必为对象。
        let merged = merged_step1_result(project_id, merged)?;
        cache_step1_result(state, &content_hash, &merged).await?;
        merged
    };

    let llm_output = step2_generate(state, project_id, &text, &step1_result, language).await?;
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

    // Phase B: 计算 review（compute-only，无 DB 写）= step2 解析 + 3rd-call dedicated stage。
    let mut reviews = crate::services::review::parse_review_blocks(&llm_output, source_path);
    match crate::services::llm_stream::provider_for_project(state, project_id).await {
        Ok(provider) => {
            match crate::services::review::run_dedicated_review_stage(
                state,
                project_id,
                source_path,
                &text,
                &step1_result,
                &llm_output,
                &*provider,
                language,
            )
            .await
            {
                Ok(ded) => reviews.extend(ded),
                Err(e) => tracing::warn!("dedicated review stage failed for {}: {}", source_path, e),
            }
        }
        Err(e) => tracing::warn!("provider for dedicated review stage ({}): {}", source_path, e),
    }
    // 批内按 (review_type, title) 去重，避免 step2 与 dedicated 重复
    let mut seen = std::collections::HashSet::new();
    reviews.retain(|r| seen.insert((r.review_type.clone(), r.title.clone())));

    // 不在此 mark_file_ingested / insert reviews：元数据 + reviews 上浮给 run_ingest_job，
    // 待 wiki_pages 成功落库后再 mark + insert（守 deferred-write 不变量：upsert 失败 →
    // 不 mark → 下次重处理；不插 review → 无孤儿/重复）。
    Ok(Some(ProcessedSource { pages, reviews, content_hash, file_size, file_type }))
}

/// 取页面用于嵌入的文本（content 非空时）；None 表示不适合嵌入。
fn page_content_for_embed(page: &WikiPageInsert) -> Option<String> {
    let t = page.content.trim();
    if t.is_empty() { None } else { Some(t.to_string()) }
}

/// upsert wiki_pages 记录（UNIQUE(project_id, path)）。
pub(crate) async fn upsert_wiki_page(
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

/// reserved 三模板的纯渲染（W3：按 language 分流中英文案）。
/// zh 文案 = zh-batch（32b7395a）现行中文；en 文案 = zh-batch 前英文原文恢复为代码内
/// 常量（`# Project Index` / `# Ingestion Log` / `# Overview / **Total pages:**`）。
/// 抽为纯函数供语言分流单测（无 DB 依赖）。
fn render_reserved_pages(
    language: Option<&str>,
    pages: &[(String, Option<String>)],
    log_rows: &[(String, chrono::DateTime<chrono::Utc>)],
    page_count: i64,
    type_counts: &[(String, i64)],
) -> Vec<(String, String)> {
    let mut index = format!("# {}\n\n", localized(language, "页面索引", "Project Index"));
    for (path, title) in pages {
        let name = title.as_deref().unwrap_or(path);
        index.push_str(&format!("- [{}]({})\n", name, path));
    }

    let mut log = format!("# {}\n\n", localized(language, "摄入日志", "Ingestion Log"));
    for (path, ts) in log_rows {
        log.push_str(&format!("- {}: {}\n", ts.format("%Y-%m-%d %H:%M"), path));
    }

    let overview_header = localized(language, "总览", "Overview");
    let pages_label = localized(language, "**页面总数：**", "**Total pages:**");
    let mut overview = format!("# {}\n\n{} {}\n\n", overview_header, pages_label, page_count);
    for (t, c) in type_counts {
        overview.push_str(&format!("- {}: {}\n", t, c));
    }

    vec![
        ("wiki/index.md".to_string(), index),
        ("wiki/log.md".to_string(), log),
        ("wiki/overview.md".to_string(), overview),
    ]
}

/// 事务内全量重建 wiki/index.md / wiki/log.md / wiki/overview.md（路径必须带 wiki/ 前缀）。
/// MVP: log.md 取最近 100 条。
/// 返回 (path, content) 元组，供调用方批量嵌入（内容本就在函数体内构造，零额外查询）。
/// W3：`language` 驱动三模板中英文案分流（NULL/非中文 → 英文）。
async fn rebuild_reserved_pages(
    state: &AppState,
    project_id: i32,
    language: Option<&str>,
) -> Result<Vec<(String, String)>, AppError> {
    let mut tx = state.db.begin().await?;

    // index.md——列出所有非 reserved 页面
    let pages: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT path, title FROM wiki_pages WHERE project_id = $1 \
         AND path NOT IN ('wiki/index.md','wiki/log.md','wiki/overview.md') ORDER BY path",
    )
    .bind(project_id)
    .fetch_all(&mut *tx)
    .await?;

    // log.md——最近 100 条摄入记录
    let log_rows: Vec<(String, chrono::DateTime<chrono::Utc>)> = sqlx::query_as(
        "SELECT original_path, ingested_at FROM ingested_files WHERE project_id = $1 \
         ORDER BY ingested_at DESC LIMIT 100",
    )
    .bind(project_id)
    .fetch_all(&mut *tx)
    .await?;

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

    // 组装 reserved（path, content）——纯渲染（语言分流）+ 零额外查询
    let reserved = render_reserved_pages(language, &pages, &log_rows, page_count, &type_counts);
    // Upsert 三条 reserved（按引用，保留 reserved 供返回）
    for (path, content) in &reserved {
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
    Ok(reserved)
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

    // ── W2：step2 FILE block path 确定性校验（m3-impl-review 次级收编）──

    #[test]
    fn parse_file_blocks_drops_non_slug_paths() {
        // 中文 / 空格 / 大写 → 该页按解析失败处理（不入 blocks）
        let text = "---FILE: 概念/机器学习.md ---\n# A\nBody\n---END FILE---\n\
                    ---FILE: concepts/My Page.md ---\n# B\nBody\n---END FILE---";
        let blocks = parse_file_blocks(text);
        assert!(
            blocks.is_empty(),
            "non-slug paths must be dropped, got {:?}",
            blocks.iter().map(|b| b.path.as_str()).collect::<Vec<_>>()
        );
    }

    #[test]
    fn parse_file_blocks_keeps_slug_paths_incl_transcripts() {
        // 合法 ASCII slug 形态照常解析；transcripts/ 前缀路径本就是 slug 形态，
        // 照常通过——run_ingest_job 的 transcripts/ 对账守卫（is_llm_generated_path）不受影响
        let text = "---FILE: concepts/my-page_v2.0.md ---\n# A\nBody\n---END FILE---\n\
                    ---FILE: transcripts/t9-sess-1.md ---\n# T\nBody\n---END FILE---";
        let blocks = parse_file_blocks(text);
        let paths: Vec<&str> = blocks.iter().map(|b| b.path.as_str()).collect();
        assert_eq!(paths, vec!["concepts/my-page_v2.0.md", "transcripts/t9-sess-1.md"]);
    }

    #[test]
    fn parse_file_blocks_invalid_path_between_valid_blocks() {
        // 中间页 path 违规被丢弃，不吞前后合法页
        let text = "---FILE: a.md ---\n# A\nBody\n---END FILE---\n\
                    ---FILE: 概念/B页.md ---\n# B\nBody\n---END FILE---\n\
                    ---FILE: c.md ---\n# C\nBody\n---END FILE---";
        let blocks = parse_file_blocks(text);
        let paths: Vec<&str> = blocks.iter().map(|b| b.path.as_str()).collect();
        assert_eq!(paths, vec!["a.md", "c.md"]);
    }

    #[test]
    fn merged_step1_result_nonobject_fails_not_flows_to_step2() {
        // R10：非对象 merged → Err（解析失败路径，process_source_path 即失败，不再流入
        // step2）。Task 6 r3 时仅跳过缓存写但仍放行——非对象分析进 step2 会产出无效
        // wiki 页，宁可本次失败由队列重试。
        for bad in [
            serde_json::json!([]),
            serde_json::json!(null),
            serde_json::json!("not-an-object"),
            serde_json::json!(42),
            serde_json::Value::Bool(true),
        ] {
            let err = merged_step1_result(614, bad).unwrap_err();
            let msg = err.to_string();
            assert!(msg.contains("not a JSON object"), "err must name shape: {msg}");
        }
        // 对象照常放行（缓存写 + step2 均不受影响）
        let ok = merged_step1_result(614, serde_json::json!({"entities": []})).unwrap();
        assert!(ok.is_object());
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

    // ── step1_chat（ChatOpts 构造 / 上下文降档重试）──

    use crate::services::llm_stream::{ChatOpts, LlmError, TokenDelta};
    use async_trait::async_trait;
    use futures::stream::{BoxStream, StreamExt};

    /// 脚本化 mock provider：按 script 依次返回（Err = stream_chat 立即失败；
    /// Ok = 按序 yield TokenDelta 流），并记录每次收到的 ChatOpts **与 messages**
    /// （W3/W2 测试捕获实际发给 LLM 的 prompt 文本）供断言。
    /// script 耗尽后再被调用会 panic（用于断言"无多余重试"）。
    struct ScriptedProvider {
        calls: std::sync::Mutex<Vec<ChatOpts>>,
        messages: std::sync::Mutex<Vec<Vec<crate::services::llm_stream::ChatMessage>>>,
        script: std::sync::Mutex<
            std::collections::VecDeque<Result<Vec<TokenDelta>, LlmError>>,
        >,
    }

    impl ScriptedProvider {
        fn new(script: Vec<Result<Vec<TokenDelta>, LlmError>>) -> Self {
            Self {
                calls: std::sync::Mutex::new(vec![]),
                messages: std::sync::Mutex::new(vec![]),
                script: std::sync::Mutex::new(script.into()),
            }
        }

        /// 第 `call` 次 LLM 调用的 user message 全文（prompt 注入断言入口）。
        fn user_message_content(&self, call: usize) -> String {
            self.messages.lock().unwrap()[call]
                .iter()
                .find(|m| m.role == "user")
                .map(|m| m.content.clone())
                .expect("scripted call must have a user message")
        }
    }

    #[async_trait]
    impl crate::services::llm_stream::StreamChatProvider for ScriptedProvider {
        async fn stream_chat(
            &self,
            messages: Vec<crate::services::llm_stream::ChatMessage>,
            opts: ChatOpts,
        ) -> Result<BoxStream<'static, Result<TokenDelta, LlmError>>, LlmError> {
            self.calls.lock().unwrap().push(opts);
            self.messages.lock().unwrap().push(messages);
            let next = self
                .script
                .lock()
                .unwrap()
                .pop_front()
                .expect("scripted provider got more stream_chat calls than scripted");
            match next {
                Err(e) => Err(e),
                Ok(deltas) => Ok(futures::stream::iter(deltas.into_iter().map(Ok::<_, LlmError>)).boxed()),
            }
        }
        fn provider_type(&self) -> &'static str { "openai" }
        fn model_name(&self) -> &str { "test-model" }
    }

    #[tokio::test]
    async fn step1_chat_uses_max_tokens_32000() {
        let provider = ScriptedProvider::new(vec![Ok(vec![
            TokenDelta::Text("{\"entities\":[]}".into()),
            TokenDelta::Usage { prompt_tokens: 10, completion_tokens: 5 },
            TokenDelta::Done,
        ])]);
        let (text, usage, effective_max) =
            step1_chat(&provider, 614, "sys", "prompt", "doc text").await.unwrap();
        assert_eq!(text, "{\"entities\":[]}");
        assert_eq!(usage, Some((10, 5)));
        assert_eq!(effective_max, 32000);
        let calls = provider.calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].max_tokens, 32000, "step1 ChatOpts.max_tokens must be 32000");
        assert_eq!(calls[0].temperature, 0.3);
        assert_eq!(calls[0].model, "test-model");
        assert_eq!(calls[0].system_prompt.as_deref(), Some("sys"));
        assert_eq!(calls[0].timeout_secs, None);
    }

    #[tokio::test]
    async fn step1_chat_no_retry_on_other_errors() {
        // 非上下文类错误（限流）必须直接失败，不触发降档重试。
        let provider = ScriptedProvider::new(vec![Err(LlmError::RateLimited)]);
        let err = step1_chat(&provider, 614, "sys", "prompt", "doc").await.unwrap_err();
        assert!(matches!(err, AppError::LlmApiError(_)));
        assert_eq!(provider.calls.lock().unwrap().len(), 1, "non-context error must not retry");
    }

    #[tokio::test]
    async fn step1_chat_retries_once_at_16000_on_context_limit() {
        // OpenAI/vLLM 风格的 context 超限错误体 → 恰好一次降档重试。
        let provider = ScriptedProvider::new(vec![
            Err(LlmError::ApiError {
                status: 400,
                body: "{\"error\":{\"message\":\"This model's maximum context length is 32768 tokens. However, you requested 34124 tokens\",\"type\":\"invalid_request_error\"}}".into(),
            }),
            Ok(vec![
                TokenDelta::Text("{\"entities\":[]}".into()),
                TokenDelta::Usage { prompt_tokens: 9000, completion_tokens: 800 },
                TokenDelta::Done,
            ]),
        ]);
        let (_text, usage, effective_max) =
            step1_chat(&provider, 614, "sys", "prompt", "doc").await.unwrap();
        assert_eq!(usage, Some((9000, 800)));
        assert_eq!(effective_max, 16000);
        let calls = provider.calls.lock().unwrap();
        assert_eq!(calls.len(), 2, "context limit should trigger exactly one retry");
        assert_eq!(calls[0].max_tokens, 32000);
        assert_eq!(calls[1].max_tokens, 16000);
        // 重试复用原请求（同 system_prompt / temperature）
        assert_eq!(calls[1].system_prompt.as_deref(), Some("sys"));
        assert_eq!(calls[1].temperature, 0.3);
    }

    #[tokio::test]
    async fn step1_chat_no_unbounded_retry() {
        // 降档重试仍失败（context 超限在 16000 下依旧不可满足）→ 直接失败，不再重试。
        // script 只给 2 项：若实现错误地发起第 3 次调用，ScriptedProvider 会 panic 使测试失败。
        let provider = ScriptedProvider::new(vec![
            Err(LlmError::ApiError {
                status: 400,
                body: "prompt is too long: 156213 tokens > 200000 maximum".into(),
            }),
            Err(LlmError::ApiError {
                status: 400,
                body: "prompt is too long: 156213 tokens > 200000 maximum".into(),
            }),
        ]);
        let err = step1_chat(&provider, 614, "sys", "prompt", "doc").await.unwrap_err();
        assert!(matches!(err, AppError::LlmApiError(_)));
        assert_eq!(provider.calls.lock().unwrap().len(), 2, "exactly one retry, no more");
    }

    // ── step1 解析失败自动重试一次（瞬态模型输出兜底）──

    /// 提前 EOS 的半截 JSON：合法前缀、在字符串值内部截断（无闭合 `}`）。
    /// 直接 from_str 与 extract_json_object fuzzy 均无法恢复——复现 2026-08-18
    /// 夜间 5/48 失败样本的形态（本地 omlx 内存压力 → finish_reason=stop 但内容不全）。
    const PARTIAL_JSON: &str =
        "{\"entities\":[{\"name\":\"Karpathy\",\"summary\":\"partial summary cut mid-stri";

    #[tokio::test]
    async fn step1_analyze_parse_retry_recovers_transient_partial_json() {
        // 第一次：半截 JSON（解析失败）；第二次：完整合法 JSON → 成功。
        // script 恰好 2 项：若实现不重试（1 次调用后直接报错）或重试超过一次（第 3 次调用 panic），测试都会失败。
        let provider = ScriptedProvider::new(vec![
            Ok(vec![
                TokenDelta::Text(PARTIAL_JSON.into()),
                TokenDelta::Usage { prompt_tokens: 100, completion_tokens: 40 },
                TokenDelta::Done,
            ]),
            Ok(vec![
                TokenDelta::Text(
                    "{\"entities\":[{\"name\":\"E1\"}],\"connections\":[],\"contradictions\":[]}".into(),
                ),
                TokenDelta::Usage { prompt_tokens: 100, completion_tokens: 50 },
                TokenDelta::Done,
            ]),
        ]);
        let v = step1_analyze_via(&provider, 614, "sys", "prompt", "doc").await.unwrap();
        assert_eq!(v["entities"][0]["name"], "E1", "retry 响应必须是最终解析结果");
        assert_eq!(
            provider.calls.lock().unwrap().len(),
            2,
            "解析失败必须恰好重试一次 LLM 调用"
        );
        // 重试是全新的 step1_chat（同入参）：system_prompt / temperature / max_tokens 保持一致
        let calls = provider.calls.lock().unwrap();
        assert_eq!(calls[0].system_prompt, calls[1].system_prompt);
        assert_eq!(calls[0].temperature, calls[1].temperature);
        assert_eq!(calls[0].max_tokens, calls[1].max_tokens);
    }

    #[tokio::test]
    async fn step1_analyze_parse_retry_gives_up_after_one_retry() {
        // 两次都是半截 JSON → 失败；错误信息须提及 retried once；恰好 2 次调用（无第三次）。
        let provider = ScriptedProvider::new(vec![
            Ok(vec![
                TokenDelta::Text(PARTIAL_JSON.into()),
                TokenDelta::Usage { prompt_tokens: 100, completion_tokens: 40 },
                TokenDelta::Done,
            ]),
            Ok(vec![
                TokenDelta::Text(PARTIAL_JSON.into()),
                TokenDelta::Usage { prompt_tokens: 100, completion_tokens: 40 },
                TokenDelta::Done,
            ]),
        ]);
        let err = step1_analyze_via(&provider, 614, "sys", "prompt", "doc").await.unwrap_err();
        match err {
            AppError::LlmApiError(msg) => assert!(
                msg.contains("retried once"),
                "错误信息必须注明已重试一次，实际: {msg}"
            ),
            other => panic!("expected LlmApiError, got {:?}", other),
        }
        assert_eq!(
            provider.calls.lock().unwrap().len(),
            2,
            "重试失败后不得有第三次调用"
        );
    }

    // ── step1 非对象 JSON（"[]"/"null"/标量）不缓存、不返回（Task 6 r3 收编）──
    // serde_json 能解析非对象合法 JSON（数组/null/数字）：一旦放行会被写入 step1
    // 缓存并永久污染同 content-hash 的后续 run（step2 拿到畸形 analysis）。要求：
    // 非对象与解析失败同路径——重试一次真实 LLM 调用，恢复对象则用重试结果；
    // 两次均非对象 → 报错；任何情况下不返回、不缓存非对象。

    #[tokio::test]
    async fn step1_analyze_nonobject_json_retries_and_recovers() {
        // 第一次 "[]"（合法 JSON 数组但非对象）→ 按解析失败重试；第二次合法对象 → 成功。
        let provider = ScriptedProvider::new(vec![
            Ok(vec![
                TokenDelta::Text("[]".into()),
                TokenDelta::Usage { prompt_tokens: 100, completion_tokens: 5 },
                TokenDelta::Done,
            ]),
            Ok(vec![
                TokenDelta::Text(
                    "{\"entities\":[{\"name\":\"E1\"}],\"connections\":[],\"contradictions\":[]}".into(),
                ),
                TokenDelta::Usage { prompt_tokens: 100, completion_tokens: 50 },
                TokenDelta::Done,
            ]),
        ]);
        let v = step1_analyze_via(&provider, 614, "sys", "prompt", "doc").await.unwrap();
        assert!(v.is_object(), "must never return a non-object step1 result");
        assert_eq!(v["entities"][0]["name"], "E1", "retry 响应必须是最终结果");
        assert_eq!(
            provider.calls.lock().unwrap().len(),
            2,
            "非对象必须触发恰好一次真实重试（不得静默放行）"
        );
    }

    #[tokio::test]
    async fn step1_analyze_nonobject_json_all_variants_rejected() {
        // "[]" / "null" / "42" / "\"text\""：两轮全非对象 → 报错（与解析失败同路径，
        // 错误含 retried once）；恰好 2 次调用；绝不返回非对象。
        for bad in ["[]", "null", "42", "\"text\""] {
            let provider = ScriptedProvider::new(vec![
                Ok(vec![
                    TokenDelta::Text(bad.into()),
                    TokenDelta::Usage { prompt_tokens: 100, completion_tokens: 5 },
                    TokenDelta::Done,
                ]),
                Ok(vec![
                    TokenDelta::Text(bad.into()),
                    TokenDelta::Usage { prompt_tokens: 100, completion_tokens: 5 },
                    TokenDelta::Done,
                ]),
            ]);
            let err = step1_analyze_via(&provider, 614, "sys", "prompt", "doc")
                .await
                .unwrap_err();
            match err {
                AppError::LlmApiError(msg) => assert!(
                    msg.contains("retried once"),
                    "非对象两轮失败须与解析失败同路径报错（{bad}）: {msg}"
                ),
                other => panic!("expected LlmApiError for {bad}, got {:?}", other),
            }
            assert_eq!(
                provider.calls.lock().unwrap().len(),
                2,
                "非对象 {bad} 恰好一次重试，无第三次"
            );
        }
    }

    #[test]
    fn is_context_limit_error_matches_provider_bodies() {
        // OpenAI / vLLM 文案（含 JSON 转义后的 error body）
        assert!(is_context_limit_error(&LlmError::ApiError {
            status: 400,
            body: "{\"error\":{\"message\":\"This model's maximum context length is 32768 tokens. However, you requested 34124 tokens\",\"type\":\"invalid_request_error\",\"code\":\"context_length_exceeded\"}}".into(),
        }));
        // Anthropic 文案
        assert!(is_context_limit_error(&LlmError::ApiError {
            status: 400,
            body: "{\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"prompt is too long: 156213 tokens > 200000 maximum\"}}".into(),
        }));
        // 大小写不敏感
        assert!(is_context_limit_error(&LlmError::ApiError {
            status: 400,
            body: "Maximum Context Length exceeded".into(),
        }));
        // 下划线变体（评审 #2）：OpenAI 兼容网关报 "max_tokens is too large for
        // this model"——不含空格版 "max tokens" 也不含 "context"，必须单独命中
        assert!(is_context_limit_error(&LlmError::ApiError {
            status: 400,
            body: "{\"error\":{\"message\":\"max_tokens is too large for this model\",\"type\":\"invalid_request_error\"}}".into(),
        }));
    }

    #[test]
    fn is_context_limit_error_rejects_others() {
        // 与 context 无关的 API 错误体
        assert!(!is_context_limit_error(&LlmError::ApiError {
            status: 400,
            body: "{\"error\":{\"message\":\"Invalid value for 'temperature'\"}}".into(),
        }));
        // 非 ApiError 变体（限流 / 超时 / 连接失败等）
        assert!(!is_context_limit_error(&LlmError::RateLimited));
        assert!(!is_context_limit_error(&LlmError::Timeout(120)));
        assert!(!is_context_limit_error(&LlmError::ConnectionFailed("reset by peer".into())));
    }

    // ── transcripts/ 命名空间守卫（Task 2 / spec §3.2-⑤ 防御）──

    #[test]
    fn llm_generated_page_path() {
        assert!(is_llm_generated_path("transcripts/xx.md"), "transcripts/ 前缀页必须命中守卫");
        assert!(!is_llm_generated_path("transcript-note.md"), "形似前缀但不带 transcripts/ 路径前缀，不命中");
        assert!(!is_llm_generated_path("pages/xx.md"), "普通 LLM 生成页路径不命中");
    }

    #[test]
    fn transcripts_guard_only_page_item_done_not_failed() {
        // 边界（计账联动）：唯一生成页撞 transcripts/ 前缀 → 守卫跳过计入 pages_written
        // → item 判 done 非 failed（item 失败条件 pages_written==0 && pages_to_write>0）。
        let pages_to_write = 1usize;
        let (pages_written, all_upserted) =
            fold_page_write_outcomes(&[PageWriteOutcome::GuardSkipped]);
        assert_eq!(pages_written, 1, "guard skip must count toward pages_written");
        assert!(all_upserted, "guard skip is not an upsert failure (mark_file_ingested 仍执行)");
        assert!(
            pages_written > 0 || pages_to_write == 0,
            "唯一页撞前缀必须 done 非 failed"
        );
        // 对照锚（既有语义回归）：唯一页真实 upsert 失败 → 计 0 → failed
        let (w0, up0) = fold_page_write_outcomes(&[PageWriteOutcome::UpsertFailed]);
        assert_eq!(w0, 0);
        assert!(!up0);
        assert!(!(w0 > 0 || pages_to_write == 0), "upsert 全失败仍须 failed");
        // 混合：守卫跳过 + upsert 失败 → 计账上视为部分成功（与既有部分成功语义一致）
        let (wm, upm) =
            fold_page_write_outcomes(&[PageWriteOutcome::GuardSkipped, PageWriteOutcome::UpsertFailed]);
        assert_eq!(wm, 1);
        assert!(!upm);
    }

    // ── W3（批 C）：语言规则提为 project 级配置——prompt 注入 + reserved 模板分流 ──

    /// W2 跟进（批 C）：step2 prompt 的 path slug 约束锚文本。
    const SLUG_CONSTRAINT_ANCHOR: &str = "lowercase ASCII slugs";

    #[test]
    fn language_rule_text_none_empty_some_injects() {
        // None → 空串（不注入任何语言指令）
        assert_eq!(language_rule_text(None), "");
        // Some → 指令段：语言值原样内插 + 路径/frontmatter 键/type 枚举保持英文
        let rule = language_rule_text(Some("简体中文"));
        assert!(rule.contains("LANGUAGE RULE"), "有值必须携带标记: {rule}");
        assert!(rule.contains("MUST be in 简体中文"), "语言值原样内插: {rule}");
        assert!(
            rule.contains("Keep paths/frontmatter keys/type enums in English"),
            "{rule}"
        );
    }

    #[test]
    fn render_prompt_replaces_placeholder() {
        // None → 占位符抹除（不残留 {{）；Some → 指令注入
        let none = render_prompt("head\n{{LANGUAGE_RULE}}\ntail", None);
        assert_eq!(none, "head\n\ntail");
        let some = render_prompt("head\n{{LANGUAGE_RULE}}\ntail", Some("简体中文"));
        assert!(some.contains("MUST be in 简体中文"));
        assert!(!some.contains("{{"));
    }

    #[tokio::test]
    async fn step1_prompt_without_language_omits_language_rule() {
        // project 无 language（ingest_language=NULL）→ LLM 实际收到的 prompt 不含
        // 语言指令（原英文中性行为），模板主体完好、占位符无残留。
        let provider = ScriptedProvider::new(vec![Ok(vec![
            TokenDelta::Text("{\"entities\":[]}".into()),
            TokenDelta::Usage { prompt_tokens: 10, completion_tokens: 5 },
            TokenDelta::Done,
        ])]);
        step1_analyze_via(&provider, 614, "sys", &step1_prompt(None), "doc")
            .await
            .unwrap();
        let content = provider.user_message_content(0);
        assert!(
            !content.contains("LANGUAGE RULE"),
            "无 language 不得注入语言指令: {content}"
        );
        assert!(!content.contains("简体中文"), "{content}");
        assert!(!content.contains("{{"), "占位符必须被替换: {content}");
        assert!(content.contains("entities"), "模板主体必须在: {content}");
        assert!(content.contains("<document>"), "{content}");
    }

    #[tokio::test]
    async fn step1_prompt_with_language_injects_rule() {
        // language='简体中文' → prompt 含指令（语言值原样内插）
        let provider = ScriptedProvider::new(vec![Ok(vec![
            TokenDelta::Text("{\"entities\":[]}".into()),
            TokenDelta::Usage { prompt_tokens: 10, completion_tokens: 5 },
            TokenDelta::Done,
        ])]);
        step1_analyze_via(&provider, 614, "sys", &step1_prompt(Some("简体中文")), "doc")
            .await
            .unwrap();
        let content = provider.user_message_content(0);
        assert!(content.contains("LANGUAGE RULE"), "{content}");
        assert!(content.contains("MUST be in 简体中文"), "{content}");
        assert!(!content.contains("{{"), "{content}");
    }

    #[tokio::test]
    async fn step2_prompt_with_language_injects_rule_and_slug_constraint() {
        // Some → 语言指令 + W2 path slug 约束段都在（slug 约束普适始终注入）
        let provider = ScriptedProvider::new(vec![Ok(vec![
            TokenDelta::Text("---FILE: concepts/a.md ---\nx\n---END FILE---".into()),
            TokenDelta::Usage { prompt_tokens: 10, completion_tokens: 5 },
            TokenDelta::Done,
        ])]);
        step2_generate_via(
            &provider,
            "sys",
            &step2_prompt(Some("简体中文")),
            "src text",
            &serde_json::json!({"entities":[]}),
        )
        .await
        .unwrap();
        let content = provider.user_message_content(0);
        assert!(content.contains("MUST be in 简体中文"), "{content}");
        assert!(content.contains(SLUG_CONSTRAINT_ANCHOR), "W2 slug 约束必须在: {content}");
        assert!(
            content.contains("Never use spaces, uppercase, parentheses"),
            "{content}"
        );
        // step2 组装结构回归：analysis + source 段照常拼入
        assert!(content.contains("<analysis>"), "{content}");
        assert!(content.contains("<source>"), "{content}");
    }

    #[tokio::test]
    async fn step2_prompt_without_language_keeps_slug_constraint() {
        // None → 无语言指令；W2 slug 约束仍在（确定性约束与语言无关）
        let provider = ScriptedProvider::new(vec![Ok(vec![
            TokenDelta::Text("---FILE: concepts/a.md ---\nx\n---END FILE---".into()),
            TokenDelta::Usage { prompt_tokens: 10, completion_tokens: 5 },
            TokenDelta::Done,
        ])]);
        step2_generate_via(
            &provider,
            "sys",
            &step2_prompt(None),
            "src text",
            &serde_json::json!({"entities":[]}),
        )
        .await
        .unwrap();
        let content = provider.user_message_content(0);
        assert!(!content.contains("LANGUAGE RULE"), "{content}");
        assert!(content.contains(SLUG_CONSTRAINT_ANCHOR), "{content}");
        assert!(!content.contains("{{"), "{content}");
    }

    #[test]
    fn localized_picks_by_language() {
        assert_eq!(localized(Some("简体中文"), "中文文案", "en text"), "中文文案");
        assert_eq!(localized(Some("Chinese"), "zh", "en"), "zh");
        assert_eq!(localized(Some("ZH-CN"), "zh", "en"), "zh", "大小写不敏感");
        assert_eq!(localized(Some("English"), "zh", "en"), "en", "非中文语言 → 英文");
        assert_eq!(localized(None, "zh", "en"), "en", "NULL → 英文（原中性行为）");
    }

    #[test]
    fn render_reserved_pages_language_split() {
        let pages = vec![("concepts/a.md".to_string(), Some("A".to_string()))];
        let log_rows = vec![(
            "raw/a.md".to_string(),
            chrono::DateTime::<chrono::Utc>::from_timestamp(0, 0).unwrap(),
        )];
        let counts = vec![("concept".to_string(), 1i64)];

        // 无 language → 英文文案（zh-batch 前的原文恢复）
        let en = render_reserved_pages(None, &pages, &log_rows, 1, &counts);
        assert!(en[0].1.starts_with("# Project Index\n"), "{:?}", en[0].1);
        assert!(en[1].1.starts_with("# Ingestion Log\n"), "{:?}", en[1].1);
        assert!(en[2].1.starts_with("# Overview\n"), "{:?}", en[2].1);
        assert!(en[2].1.contains("**Total pages:** 1"), "{:?}", en[2].1);

        // 简体中文 → 现中文文案（zh-batch 行为保持）
        let zh = render_reserved_pages(Some("简体中文"), &pages, &log_rows, 1, &counts);
        assert!(zh[0].1.starts_with("# 页面索引\n"), "{:?}", zh[0].1);
        assert!(zh[1].1.starts_with("# 摄入日志\n"), "{:?}", zh[1].1);
        assert!(zh[2].1.starts_with("# 总览\n"), "{:?}", zh[2].1);
        assert!(zh[2].1.contains("**页面总数：** 1"), "{:?}", zh[2].1);

        // 条目行语言无关（页名/路径原样）
        assert!(zh[0].1.contains("- [A](concepts/a.md)"));
        assert!(zh[1].1.contains("- 1970-01-01 00:00: raw/a.md"), "{:?}", zh[1].1);
        // 路径固定带 wiki/ 前缀
        assert_eq!(zh[0].0, "wiki/index.md");
        assert_eq!(zh[1].0, "wiki/log.md");
        assert_eq!(zh[2].0, "wiki/overview.md");
    }
}
