# 多源累积合并 + 教材摄取流水线 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 摄取管线同路径页面从"后写者覆盖"改为"多源累积合并"（LLM 合并 + sources 并集），并以 MinerU 桥接流水线摄取首批英文教材（LT 一本试点）。

**Architecture:** server 侧在 `run_ingest_job` 页写入循环加碰撞检测（Replace/Merge 分流，merge 走新增 step4 LLM 调用，失败/截断整页回退 Replace）；step2 注入既有 concepts/entities 清单促进跨源 slug 收敛。tools/books 三脚本（拆章→MinerU 双协议解析→断言式上传摄取）复用现有 web 摄取 API。

**Tech Stack:** Rust (axum/sqlx, src-server)、TypeScript (tsx, tools/books)、Python (pypdf, 拆章)、MinerU（本地 docker 或云）。

**Spec:** `docs/superpowers/specs/2026-08-23-multi-source-merge-and-book-ingestion-design.md`（r2，评审修订版，随本计划一起阅读）

## Global Constraints

- 分支：`feat/multi-source-merge-book-ingestion`（spec 已在其上，c2231ef4）；完成后 `--no-ff` 合并 main，**须用户放行**
- 测试卫生：`cargo test --lib` 零 DB；集成测试统一 **t8_ 前缀**并并入 SWEEPS（Task 5）；**绝不**用 rev-* 标签模式
- 部署时序：批次 4 ingest job 终态前**不重启 src-server**（Task 10 有守卫步骤）
- 提交纪律：只 `git add` 具体文件，禁 `git add -A`（仓库有 7 个 June 未跟踪路径）
- prompt 正文英文 + `{{LANGUAGE_RULE}}` 占位符；代码注释中文（仓库惯例）
- LLM 调用输出一律过 `strip_thinking`（omlx 已知坑）
- MinerU 先决检查结果须先报用户确认再部署服务（spec §3）

---

### Task 1: 碰撞判定与 sources 并集纯函数

**Files:**
- Modify: `src-server/src/services/ingest_pipeline.rs`（`#[cfg(test)] mod tests` 内加测试，实现在文件主体）
- Test: 同文件 `mod tests`

**Interfaces:**
- Produces: `enum CollisionMode { Replace, Merge }`、`fn collision_mode(existing_sources: &serde_json::Value, incoming_sources: &serde_json::Value, current_source: &str) -> CollisionMode`、`fn union_sources(existing: &serde_json::Value, incoming: &serde_json::Value, current_source: &str) -> serde_json::Value`（均 pub(crate)，Task 3 消费）

- [ ] **Step 1: 写失败测试**（加到 mod tests，与 chunk_document 测试同区）

```rust
// —— 多源累积合并 §1：碰撞判定（评审 I2 收紧 + A-M3 set 语义）——
#[test]
fn collision_mode_single_current_source_equal_replaces() {
    assert_eq!(
        collision_mode(&serde_json::json!(["raw/a.md"]), &serde_json::json!(["raw/a.md"]), "raw/a.md"),
        CollisionMode::Replace
    );
}

#[test]
fn collision_mode_duplicate_elements_set_semantics() {
    // 畸变重复元素：set 语义判 Replace
    assert_eq!(
        collision_mode(&serde_json::json!(["raw/a.md"]), &serde_json::json!(["raw/a.md", "raw/a.md"]), "raw/a.md"),
        CollisionMode::Replace
    );
}

#[test]
fn collision_mode_multi_element_equal_set_merges() {
    // 多元素巧合相等不得静默覆盖多源累积页（评审 I2）
    assert_eq!(
        collision_mode(&serde_json::json!(["raw/a.md", "raw/b.md"]), &serde_json::json!(["raw/b.md", "raw/a.md"]), "raw/a.md"),
        CollisionMode::Merge
    );
}

#[test]
fn collision_mode_disjoint_or_null_merges() {
    assert_eq!(
        collision_mode(&serde_json::json!(["raw/a.md"]), &serde_json::json!(["raw/b.md"]), "raw/b.md"),
        CollisionMode::Merge
    );
    assert_eq!(
        collision_mode(&serde_json::Value::Null, &serde_json::json!(["raw/b.md"]), "raw/b.md"),
        CollisionMode::Merge
    );
}

// —— union_sources：去重保序 + 当前 sp 尾插（评审 A-M4）——
#[test]
fn union_sources_dedup_order_tail_append_current() {
    let u = union_sources(&serde_json::json!(["a.md"]), &serde_json::json!(["b.md", "a.md"]), "c.md");
    assert_eq!(u, serde_json::json!(["a.md", "b.md", "c.md"]));
}

#[test]
fn union_sources_malformed_tolerated() {
    let u = union_sources(&serde_json::Value::Null, &serde_json::json!(["b.md", 42]), "c.md");
    assert_eq!(u, serde_json::json!(["b.md", "c.md"]));
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src-server && cargo test --lib collision_mode union_sources 2>&1 | tail -5`
Expected: 编译错误（函数未定义）

- [ ] **Step 3: 实现**（放 `merge_analyses` 附近，纯函数区）

```rust
/// 同路径碰撞的处置模式（spec §1 多源累积合并）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CollisionMode {
    /// 同源重生成：整页覆盖（现状语义），零 LLM 调用。
    Replace,
    /// 跨源碰撞：LLM 合并 + sources 并集。
    Merge,
}

/// sources JSONB → 去重集合（字符串数组语义；畸变元素忽略、重复元素去重）。
fn sources_set(v: &serde_json::Value) -> std::collections::BTreeSet<String> {
    v.as_array()
        .map(|arr| arr.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default()
}

/// 碰撞判定（评审 I2 收紧）：仅「集合相等 且 incoming 恰为 {当前源}」判 Replace；
/// 多元素巧合相等（LLM 自由引用）走 Merge——最坏同内容融合，不丢数据。
fn collision_mode(
    existing_sources: &serde_json::Value,
    incoming_sources: &serde_json::Value,
    current_source: &str,
) -> CollisionMode {
    let existing = sources_set(existing_sources);
    let incoming = sources_set(incoming_sources);
    let only_current = incoming.len() == 1 && incoming.contains(current_source);
    if existing == incoming && only_current {
        CollisionMode::Replace
    } else {
        CollisionMode::Merge
    }
}

/// sources 并集：existing 序在前、去重保序、当前 sp 强制尾插（评审 A-M4）。
fn union_sources(
    existing: &serde_json::Value,
    incoming: &serde_json::Value,
    current_source: &str,
) -> serde_json::Value {
    let mut out: Vec<String> = Vec::new();
    for src in [existing, incoming] {
        if let Some(arr) = src.as_array() {
            for x in arr {
                if let Some(s) = x.as_str() {
                    if !out.iter().any(|o| o == s) {
                        out.push(s.to_string());
                    }
                }
            }
        }
    }
    if !out.iter().any(|o| o == current_source) {
        out.push(current_source.to_string());
    }
    serde_json::json!(out)
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src-server && cargo test --lib collision_mode union_sources 2>&1 | tail -3`
Expected: 6 passed（4 collision + 2 union；无存量同名测试）

- [ ] **Step 5: Commit**

```bash
git add src-server/src/services/ingest_pipeline.rs
git commit -m "feat(ingest): collision_mode/union_sources 纯函数——多源累积合并判定基础"
```

---

### Task 2: step4 合并 prompt + merge_pages_via（含截断防线）

**Files:**
- Create: `src-server/src/services/prompts/step4_merge.txt`
- Modify: `src-server/src/services/ingest_pipeline.rs`

**Interfaces:**
- Consumes: `ScriptedProvider`（ingest_pipeline.rs:1497）、`render_prompt`（:60）、`strip_thinking`（research/synthesize.rs:10，pub）
- Produces: `pub(crate) fn merge_prompt(language: Option<&str>) -> String`、`async fn merge_pages_via(provider: &dyn StreamChatProvider, language: Option<&str>, source_path: &str, existing_content: &str, incoming_content: &str) -> Result<String, AppError>`（Task 3 消费）

- [ ] **Step 1: 创建 prompt 文件**

```
Merge two versions of the same wiki page into one consolidated version.

Rules:
- Preserve all key facts from BOTH versions. Never drop content that only one side has.
- Deduplicate aggressively: repeated statements become one; overlapping sections merge.
- Keep the output compact: it must never be significantly longer than the longer input.
- When the two versions state the same concept differently, prefer the clearer
  formulation; for genuinely conflicting claims, present both and attribute them by
  source type: a path starting with `transcripts/` is a video lesson, a path starting
  with `raw/sources/` is an uploaded document or book chapter.
- Keep the union of all [[wikilinks]] from both versions.
- Output ONLY the merged page body as Markdown. No frontmatter, no FILE blocks,
  no explanations, no preamble.

{{LANGUAGE_RULE}}
```

- [ ] **Step 2: 写失败测试**（mod tests 内）

```rust
#[tokio::test]
async fn merge_pages_via_injects_framing_source_and_language() {
    let provider = ScriptedProvider::new(vec![Ok(vec![
        TokenDelta::Text("融合正文".into()),
        TokenDelta::Usage { prompt_tokens: 10, completion_tokens: 100 },
        TokenDelta::Done,
    ])]);
    let out = merge_pages_via(&provider, Some("简体中文"), "raw/sources/bk/Ch01.md", "旧版", "新版")
        .await
        .unwrap();
    assert_eq!(out, "融合正文");
    let content = provider.user_message_content(0);
    assert!(content.contains("<existing>\n旧版\n</existing>"), "{content}");
    assert!(content.contains("<incoming>\n新版\n</incoming>"), "{content}");
    assert!(content.contains("raw/sources/bk/Ch01.md"), "{content}");
    assert!(content.contains("MUST be in 简体中文"), "{content}");
}

#[tokio::test]
async fn merge_pages_via_rejects_truncated_output() {
    // 评审 C1：completion >= max_tokens 视为失败（调用方走整页回退）
    let provider = ScriptedProvider::new(vec![Ok(vec![
        TokenDelta::Text("half".into()),
        TokenDelta::Usage { prompt_tokens: 10, completion_tokens: 8000 },
        TokenDelta::Done,
    ])]);
    let err = merge_pages_via(&provider, None, "raw/a.md", "old", "new").await.unwrap_err();
    assert!(err.to_string().contains("truncated"), "{err}");
}

#[tokio::test]
async fn merge_pages_via_rejects_empty_after_strip_thinking() {
    let provider = ScriptedProvider::new(vec![Ok(vec![
        TokenDelta::Text("<think>reasoning</think>".into()),
        TokenDelta::Done,
    ])]);
    let err = merge_pages_via(&provider, None, "raw/a.md", "old", "new").await.unwrap_err();
    assert!(err.to_string().contains("empty"), "{err}");
}

#[test]
fn merge_prompt_renders_language_rule_no_placeholder_left() {
    let p = merge_prompt(Some("简体中文"));
    assert!(p.contains("MUST be in 简体中文"), "{p}");
    assert!(!p.contains("{{"), "{p}");
    let e = merge_prompt(None);
    assert!(!e.contains("{{") && !e.contains("LANGUAGE RULE"), "{e}");
}
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd src-server && cargo test --lib merge_pages_via merge_prompt 2>&1 | tail -5`
Expected: 编译错误（merge_pages_via 未定义）

- [ ] **Step 4: 实现**（放 step2_generate_via 之后）

```rust
/// step4 merge prompt（含占位符渲染）。抽为独立函数供 prompt 注入单测。
pub(crate) fn merge_prompt(language: Option<&str>) -> String {
    render_prompt(include_str!("prompts/step4_merge.txt"), language)
}

/// 页面合并 LLM 调用（provider 注入，同 step2_generate_via 模式）。
/// 截断防线（评审 C1）：completion_tokens >= max_tokens → Err，调用方走整页回退
/// Replace——截断半截 markdown 落库后，下轮 merge 会把残页当 existing，
/// 累积内容不可恢复丢失。空输出（strip_thinking 后）同样 Err。
async fn merge_pages_via(
    provider: &dyn StreamChatProvider,
    language: Option<&str>,
    source_path: &str,
    existing_content: &str,
    incoming_content: &str,
) -> Result<String, AppError> {
    const MERGE_MAX_TOKENS: u32 = 8000;
    let prompt = merge_prompt(language);
    let system = "You merge two versions of a wiki page into one consolidated version.";
    let user = format!(
        "{prompt}\n\nIncoming source: {source_path}\n\n\
         <existing>\n{existing_content}\n</existing>\n\n\
         <incoming>\n{incoming_content}\n</incoming>"
    );
    let messages = vec![ChatMessage { role: "user".into(), content: user }];
    let opts = ChatOpts {
        model: provider.model_name().into(),
        temperature: 0.3,
        max_tokens: MERGE_MAX_TOKENS,
        system_prompt: Some(system.into()),
        timeout_secs: None,
    };
    let (response, usage) = provider
        .chat_to_string(messages, opts)
        .await
        .map_err(|e| AppError::LlmApiError(format!("merge page: {}", e)))?;
    if let Some((_, ct)) = usage {
        if ct >= MERGE_MAX_TOKENS {
            return Err(AppError::LlmApiError(format!(
                "merge output likely truncated (completion {} >= max {})",
                ct, MERGE_MAX_TOKENS
            )));
        }
    }
    let cleaned = crate::services::research::synthesize::strip_thinking(&response);
    if cleaned.trim().is_empty() {
        return Err(AppError::LlmApiError("merge output empty after strip_thinking".into()));
    }
    Ok(cleaned)
}
```

注：`ChatMessage`/`ChatOpts`/`StreamChatProvider` 用文件内既有 use（step2_generate_via 同款裸名）。若 `services::research` 不可见，在 services/research/mod.rs 确认 `pub mod synthesize;`（现有 `pub fn strip_thinking` 即可达）。

- [ ] **Step 5: 跑测试确认通过**

Run: `cd src-server && cargo test --lib merge 2>&1 | tail -3`
Expected: 7 passed（4 新增 + 3 存量同名滤中：merged_step1_result_nonobject / merge_analyses_single / merge_analyses_dedup）

- [ ] **Step 6: Commit**

```bash
git add src-server/src/services/prompts/step4_merge.txt src-server/src/services/ingest_pipeline.rs
git commit -m "feat(ingest): step4_merge prompt + merge_pages_via（截断防线/空输出防线/strip_thinking）"
```

---

### Task 3: 页写入循环改造 + merged_pages 观测字段

**Files:**
- Modify: `src-server/src/services/ingest_pipeline.rs:952-974`（页循环）、`:903-909`（result 初始化）
- Modify: `src-server/src/services/ingest_queue.rs:71-76`（IngestJobResult）
- Modify: `src-server/src/services/ingest_worker.rs:95-121`（完成日志）
- Modify: `src-server/tests/integration/ingest_queue_test.rs:115`（IngestJobResult 结构体字面量构造——加字段即编译错；`--lib` 不编译 tests/，不补则 Task 5 才爆）

**Interfaces:**
- Consumes: Task 1 `collision_mode`/`union_sources`、Task 2 `merge_pages_via`
- Produces: `IngestJobResult.merged_pages: Vec<String>`（#[serde(default)]）；`ExistingPage`/`fetch_existing_page`/`update_merged_page`（内部）

- [ ] **Step 1: IngestJobResult 加字段**（ingest_queue.rs:71）

```rust
pub struct IngestJobResult {
    pub new_pages: Vec<String>,
    /// 多源累积合并页（只进此列表不进 new_pages，评审 A-M1）。
    #[serde(default)]
    pub merged_pages: Vec<String>,
    pub updated_reserved: Vec<String>,
    pub warnings: Vec<String>,
}
```

（读当前 derives；若含 Deserialize 即如上加 default，Serialize 侧无影响。）

- [ ] **Step 2: 循环上方加懒 provider 与 result 初始化**

`run_ingest_job` 的 result 初始化处加 `merged_pages: vec![]`；`collected` 声明附近加：

```rust
// merge provider 懒获取（评审 A-M6）：首次碰撞才取，失败并入整页回退（I1）
let mut merge_provider: Option<Box<dyn StreamChatProvider>> = None;
```

- [ ] **Step 3: 替换页循环 upsert 段**（952-974 的 for 体，transcripts 守卫保留在最前）

```rust
for page in &processed.pages {
    if is_llm_generated_path(&page.path) {
        tracing::warn!(path = %page.path, source = %sp, "skip LLM page into transcripts/ namespace");
        outcomes.push(PageWriteOutcome::GuardSkipped);
        continue;
    }
    // —— 多源累积合并（spec §1）：碰撞检测 → Replace/Merge 分流 ——
    let existing = match fetch_existing_page(state, job.project_id, &page.path).await {
        Ok(e) => e,
        Err(err) => {
            result.warnings.push(format!("fetch existing {}: {}", page.path, err));
            outcomes.push(PageWriteOutcome::UpsertFailed);
            continue;
        }
    };
    let mode = existing
        .as_ref()
        .map_or(CollisionMode::Replace, |e| collision_mode(&e.sources, &page.sources, sp));
    let merged_write: Option<Result<(String, serde_json::Value), String>> = match (&mode, existing.as_ref()) {
        (CollisionMode::Merge, Some(e)) => {
            if merge_provider.is_none() {
                match llm_stream::provider_for_project(state, job.project_id).await {
                    Ok(p) => merge_provider = Some(p),
                    Err(err) => result.warnings.push(format!("merge provider unavailable: {}", err)),
                }
            }
            match merge_provider.as_ref() {
                Some(p) => match merge_pages_via(&**p, language, sp, &e.content, &page.content).await {
                    Ok(merged_content) => {
                        // 收敛观测（评审 I-4）：超两版之和 80% 记 warning
                        if merged_content.len() > (e.content.len() + page.content.len()) * 4 / 5 {
                            result.warnings.push(format!(
                                "merge {}: output longer than 80% of combined inputs (inflation watch)",
                                page.path
                            ));
                        }
                        Some(Ok((merged_content, union_sources(&e.sources, &page.sources, sp))))
                    }
                    Err(err) => Some(Err(format!("merge {}: {} — fallback replace", page.path, err))),
                },
                None => Some(Err(format!("merge {}: no provider — fallback replace", page.path))),
            }
        }
        _ => None, // Replace 或无既有行 → 原路径
    };
    match merged_write {
        Some(Ok((merged_content, merged_sources))) => match existing.as_ref() {
            Some(e) => {
                match update_merged_page(state, job.project_id, &page.path, &merged_content, &merged_sources, &e.frontmatter).await {
                    Ok(()) => {
                        result.merged_pages.push(page.path.clone());
                        if !merged_content.trim().is_empty() {
                            collected.push((page.path.clone(), merged_content));
                        }
                        outcomes.push(PageWriteOutcome::Upserted);
                    }
                    Err(err) => {
                        result.warnings.push(format!("update merged {}: {}", page.path, err));
                        outcomes.push(PageWriteOutcome::UpsertFailed);
                    }
                }
            }
            None => unreachable!("merge 分支必有 existing"),
        },
        Some(Err(warn)) => {
            // 整页回退（评审 I1 写死）：content/sources/frontmatter 均 incoming，走既有 upsert
            result.warnings.push(warn);
            match upsert_wiki_page(state, job.project_id, page).await {
                Ok(path) => {
                    result.new_pages.push(path.clone());
                    if let Some(text) = page_content_for_embed(page) {
                        collected.push((path, text));
                    }
                    outcomes.push(PageWriteOutcome::Upserted);
                }
                Err(err) => {
                    result.warnings.push(format!("upsert {}: {}", sp, err));
                    outcomes.push(PageWriteOutcome::UpsertFailed);
                }
            }
        }
        None => match upsert_wiki_page(state, job.project_id, page).await {
            Ok(path) => {
                result.new_pages.push(path.clone());
                if let Some(text) = page_content_for_embed(page) {
                    collected.push((path, text));
                }
                outcomes.push(PageWriteOutcome::Upserted);
            }
            Err(err) => {
                result.warnings.push(format!("upsert {}: {}", sp, err));
                outcomes.push(PageWriteOutcome::UpsertFailed);
            }
        },
    }
}
```

- [ ] **Step 4: 三个辅助函数**（放 upsert_wiki_page 附近）

```rust
/// 同路径既有页（合并所需列子集；NULL 列容错为空值——老行可能未写）。
struct ExistingPage {
    content: String,
    sources: serde_json::Value,
    frontmatter: serde_json::Value,
}

async fn fetch_existing_page(
    state: &AppState,
    project_id: i32,
    path: &str,
) -> Result<Option<ExistingPage>, AppError> {
    let row = sqlx::query_as::<_, (String, Option<serde_json::Value>, Option<serde_json::Value>)>(
        "SELECT content, sources, frontmatter FROM wiki_pages WHERE project_id = $1 AND path = $2",
    )
    .bind(project_id)
    .bind(path)
    .fetch_optional(&state.db)
    .await?;
    Ok(row.map(|(content, sources, frontmatter)| ExistingPage {
        content,
        sources: sources.unwrap_or(serde_json::json!([])),
        frontmatter: frontmatter.unwrap_or(serde_json::json!({})),
    }))
}

/// 合并页落库：content/sources 用合并结果；frontmatter 保留 existing 仅同步 sources 键；
/// title/page_type/images 不动（保留 existing，wikilink/图谱锚稳定，spec §1）。
async fn update_merged_page(
    state: &AppState,
    project_id: i32,
    path: &str,
    merged_content: &str,
    merged_sources: &serde_json::Value,
    existing_frontmatter: &serde_json::Value,
) -> Result<(), AppError> {
    let mut fm = existing_frontmatter.clone();
    if let Some(obj) = fm.as_object_mut() {
        obj.insert("sources".into(), merged_sources.clone());
    }
    sqlx::query(
        "UPDATE wiki_pages SET content = $3, sources = $4, frontmatter = $5, updated_at = NOW() \
         WHERE project_id = $1 AND path = $2",
    )
    .bind(project_id)
    .bind(path)
    .bind(merged_content)
    .bind(merged_sources)
    .bind(&fm)
    .execute(&state.db)
    .await?;
    Ok(())
}
```

- [ ] **Step 5: worker 日志加 merged 计数**（ingest_worker.rs 成功分支，找到现有 new_pages 日志处同款加）

```rust
tracing::info!(job_id = %job.id, new_pages = result.new_pages.len(), merged_pages = result.merged_pages.len(), "ingest job succeeded");
```

- [ ] **Step 6: 补 ingest_queue_test.rs:115 的构造**（IngestJobResult 字面量加一行）

```rust
    let result = IngestJobResult {
        new_pages: vec!["concepts/x.md".into()],
        merged_pages: vec![],
        updated_reserved: vec![],
        warnings: vec![],
    };
```

- [ ] **Step 7: 编译 + 全量 lib 测试**

Run: `cd src-server && cargo test --lib 2>&1 | tail -3 && cargo test --test integration --no-run 2>&1 | tail -3`
Expected: lib 全过（原 295+ 新增，零 DB）；integration 编译通过

- [ ] **Step 8: Commit**

```bash
git add src-server/src/services/ingest_pipeline.rs src-server/src/services/ingest_queue.rs src-server/src/services/ingest_worker.rs src-server/tests/integration/ingest_queue_test.rs
git commit -m "feat(ingest): 页写入循环碰撞分流——Merge(合并+并集)/Replace(收紧)/整页回退 + merged_pages 观测"
```

---

### Task 4: §2 slug 对齐清单注入

**Files:**
- Modify: `src-server/src/services/ingest_pipeline.rs`（`run_ingest_job`、`process_source_path`、`step2_generate`、`step2_generate_via:763-792`、既有测试 :2149/:2178）

**Interfaces:**
- Produces: `async fn fetch_concept_entity_paths(state, project_id) -> Vec<String>`、`fn existing_paths_section(paths: &[String]) -> String`；`step2_generate_via` 签名追加 `existing_paths: &[String]`

- [ ] **Step 1: 写失败测试**

```rust
#[test]
fn existing_paths_section_lists_and_notes_truncation() {
    let one = existing_paths_section(&["concepts/a.md".into()]);
    assert!(one.contains("## Existing concept/entity pages"), "{one}");
    assert!(one.contains("- concepts/a.md"), "{one}");
    assert!(!one.contains("truncated"), "{one}");

    let many: Vec<String> = (0..2000).map(|i| format!("concepts/p{}.md", i)).collect();
    let sec = existing_paths_section(&many);
    assert!(sec.contains("list truncated"), "{sec}");

    assert_eq!(existing_paths_section(&[]), "");
}

#[test]
fn existing_paths_cap_links_budget() {
    // 128k → 2500 → clamp 2000；32k → 500；8000 → 0 → clamp 1
    assert_eq!(existing_paths_cap(128_000), 2000);
    assert_eq!(existing_paths_cap(32_000), 500);
    assert_eq!(existing_paths_cap(8_000), 1);
}

#[tokio::test]
async fn step2_prompt_injects_existing_paths_section() {
    let provider = ScriptedProvider::new(vec![Ok(vec![
        TokenDelta::Text("---FILE: concepts/a.md ---\nx\n---END FILE---".into()),
        TokenDelta::Done,
    ])]);
    step2_generate_via(&provider, "sys", &step2_prompt(None), "src",
        &serde_json::json!({"entities": []}), &["concepts/a.md".to_string()]).await.unwrap();
    let content = provider.user_message_content(0);
    assert!(content.contains("REUSE its exact path"), "{content}");
    assert!(content.contains("- concepts/a.md"), "{content}");
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src-server && cargo test --lib existing_paths_section step2_prompt_injects 2>&1 | tail -5`

- [ ] **Step 3: 实现**

```rust
/// §2 清单 cap 与 context 预算联动（评审 I3/I-5）：合算式
/// 清单 ≤ (context_size - 8000) / 4 / 12（path 实测 8-12 token/行），clamp 到 [1, 2000]。
/// 128k → 2500 → 取 2000；32k → 500。
fn existing_paths_cap(context_size: u32) -> i64 {
    (((context_size.saturating_sub(8000)) / 4 / 12) as i64).clamp(1, 2000)
}

/// §2 slug 对齐：既有 concepts/entities 页清单（前缀即白名单，评审 A-M7——
/// 手动建页的任意脏 path 不匹配前缀不入清单）。每 job 查一次；LIMIT 与 budget 联动。
async fn fetch_concept_entity_paths(state: &AppState, project_id: i32, cap: i64) -> Vec<String> {
    let rows: Vec<(String,)> = sqlx::query_as(
        "SELECT path FROM wiki_pages WHERE project_id = $1 \
         AND (path LIKE 'concepts/%' OR path LIKE 'entities/%') ORDER BY path LIMIT $2",
    )
    .bind(project_id)
    .bind(cap)
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();
    rows.into_iter().map(|r| r.0).collect()
}

/// step2 清单注入段（纯函数供单测；空清单 → 空串；触顶 cap → 注明截断，评审 I3）。
fn existing_paths_section(paths: &[String]) -> String {
    if paths.is_empty() {
        return String::new();
    }
    let note = if paths.len() >= existing_paths_cap(u32::MAX) as usize {
        "\n(list truncated — only the first entries are shown)"
    } else {
        ""
    };
    let list = paths.iter().map(|p| format!("- {}", p)).collect::<Vec<_>>().join("\n");
    format!(
        "\n\n## Existing concept/entity pages\n\
         The following wiki pages already exist. When a page you generate describes the \
         same concept as one of them, REUSE its exact path so knowledge accumulates on \
         one page. Only create a new path for genuinely new concepts.\n{}\n{}",
        list, note
    )
}
```

（`existing_paths_cap(u32::MAX)` 恒为 2000——注入段以 2000 行为截断判定，与 SQL 侧 cap 一致或更小；cap < 2000 时清单不会超 cap，同样不误报截断。）

签名链改造（全部加 `existing_paths: &[String]` 并透传）：
- `step2_generate_via(..., step1_json, existing_paths)`：user message 从 `format!("{prompt}\n\n<analysis>...")` 改为 `format!("{prompt}{}\n\n<analysis>...", existing_paths_section(existing_paths))`
- `step2_generate` / `process_source_path` 同步加参透传
- `run_ingest_job` 循环前：

```rust
// §2 清单 + cap 联动（I-5）：context_size 与 process_source_path 内同源逻辑
let context_size = crate::services::llm::get_llm_config(&state.db, job.project_id)
    .await
    .map(|c| c.context_size)
    .unwrap_or(128_000);
let existing_paths =
    fetch_concept_entity_paths(state, job.project_id, existing_paths_cap(context_size)).await;
```

- 既有两处测试调用（:2149/:2178）补 `&[]` 实参

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src-server && cargo test --lib 2>&1 | tail -3`
Expected: 全过（含既有 step2 断言不回归）

- [ ] **Step 5: Commit**

```bash
git add src-server/src/services/ingest_pipeline.rs
git commit -m "feat(ingest): step2 注入既有 concepts/entities 清单——跨源 slug 收敛（cap 2000 + 截断注明）"
```

---

### Task 5: t8_ 前缀并入 SWEEPS + stub chat 服务器基建

**Files:**
- Modify: `src-server/tests/integration/mod.rs`（SWEEPS 前缀族 + `pub mod merge_ingest_test;`）
- Create: `src-server/tests/integration/merge_ingest_test.rs`（本任务只放基建，Task 6 加用例）

**Interfaces:**
- Produces: `pub(crate) async fn spawn_stub_chat_server(script: Vec<StubResp>) -> (String, JoinHandle<()>)`、`enum StubResp { Text(String), Error(u16) }`、t8_ fixture helpers（Task 6 消费）

- [ ] **Step 1: mod.rs 接线 + SWEEPS 扩族**

在 `pub mod t_page_test;` 后加 `pub mod merge_ingest_test;`。SWEEPS 三条 DELETE **逐条**加 t8 模式（mod.rs:62-81，评审 C-1——漏任何一条都会连环 FK panic）：

```rust
// 1) projects：name LIKE 'LT项目_t8\_%'（与 t3_/t6_/t7_/t9_ 并列）
// 2) users：username LIKE 't8\_%' + email LIKE '%t8\_%'
// 3) media_assets：slug LIKE 't8\_%'
```

并更新函数头注释「四套 unique()」→「五套」+ 注明 t8_ = merge_ingest_test。

- [ ] **Step 2: stub 服务器**（merge_ingest_test.rs 头部）

```rust
//! 多源累积合并集成测试（t8_ 前缀 + SWEEPS；spec §5）。
//! stub chat 服务器覆盖 step1/step2/merge 全成功路径——现有集成测试只测失败路径，
//! 这是本仓库首次在集成层跑通 LLM 成功链（SSE 格式对齐 llm_stream openai 解析：
//! choices[].delta.content + 末尾空 choices 的 usage chunk）。
use axum::{extract::State, routing::post, Router};
use std::sync::{Arc, Mutex};

pub(crate) enum StubResp {
    Text(String),
    Error(u16),
}

/// 进程内 stub：POST {base}/chat/completions 按序弹出脚本化响应；耗尽 → 500。
/// URL 路径以 llm_stream openai provider 的拼接为准（执行时 grep `chat/completions`
/// 确认是 base+`/chat/completions` 还是含 /v1，路由随之对齐）。
pub(crate) async fn spawn_stub_chat_server(script: Vec<StubResp>) -> (String, tokio::task::JoinHandle<()>) {
    let script = Arc::new(Mutex::new(script));
    let app = Router::new()
        .route("/chat/completions", post(|State(script): State<Arc<Mutex<Vec<StubResp>>>>| async move {
            let next = { let mut s = script.lock().unwrap(); if s.is_empty() { None } else { Some(s.remove(0)) } };
            match next {
                Some(StubResp::Error(code)) => {
                    (axum::http::StatusCode::from_u16(code).unwrap(), "stub error")
                }
                Some(StubResp::Text(t)) => {
                    let content_json = serde_json::to_string(&t).unwrap();
                    let sse = format!(
                        "data: {{\"choices\":[{{\"delta\":{{\"content\":{}}}}}]}}\n\n\
                         data: {{\"choices\":[],\"usage\":{{\"prompt_tokens\":10,\"completion_tokens\":100}}}}\n\n\
                         data: [DONE]\n\n",
                        content_json
                    );
                    (
                        [(axum::http::header::CONTENT_TYPE, "text/event-stream")],
                        sse,
                    )
                }
                None => (axum::http::StatusCode::INTERNAL_SERVER_ERROR, "stub exhausted"),
            }
        }))
        .with_state(script);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let handle = tokio::spawn(async move { axum::serve(listener, app).await.unwrap(); });
    (format!("http://{}", addr), handle)
}
```

（axum 在 dev-dependency 树可用——主 crate 依赖 axum；若 tests crate 引用报错，在 Cargo.toml `[dev-dependencies]` 加 `axum` 与主 crate 同版本。）

- [ ] **Step 3: t8_ fixture helper**（同文件；评审 C-1 写死命名——**勿照抄 reviews_test.rs 的项目名**，其固定串 `test-proj` 不匹配 SWEEPS 的 `LT项目_t8\_%` 模式）

```rust
/// t8_ fixture（评审 C-1）：命名必须与 Task 5 Step 1 扩入的 SWEEPS 模式逐字匹配——
/// 项目名 LT项目_t8_{uuid}、username t8_merge_{uuid}、email t8_merge_{uuid}@t8.com。
/// 注册→建队→建项目的 HTTP 序序可参考 reviews_test.rs::setup_project，但三处命名如上。
async fn t8_setup_project(state: &llm_wiki_server::AppState) -> i32 {
    // 以 reviews_test.rs 的 setup 序列为模板（注册用户 / POST /teams / POST /projects），
    // 命名替换为上述 t8_ 形态；返回 project_id。
    todo!("按上述命名落地（模板序序参考 reviews_test.rs，命名不可照抄）")
}
```

（`todo!` 占位仅限本计划文档展示；实现时以 reviews_test.rs 为模板落全。）

- [ ] **Step 4: 编译检查**

Run: `cd src-server && cargo test --test integration --no-run 2>&1 | tail -3`
Expected: 编译通过

- [ ] **Step 5: Commit**

```bash
git add src-server/tests/integration/mod.rs src-server/tests/integration/merge_ingest_test.rs src-server/Cargo.toml
git commit -m "test(integration): t8_ 前缀并入 SWEEPS + stub chat 服务器基建（SSE 对齐 openai 解析）"
```

---

### Task 6: 合并集成测试（e2e 成功 / 回退 / A→B→A / 单源重生成）

**Files:**
- Modify: `src-server/tests/integration/merge_ingest_test.rs`

**Interfaces:**
- Consumes: Task 5 基建、Task 3 生产代码（经 run_ingest_job）

**编排铁律（评审 C-3 写死）**：
- **绝不 HTTP enqueue**——job 会被 LPUSH 进共享 live Redis，launchd 的 live worker 会抢走它对进程内 stub 双跑竞态。照 ingest_reliability_test:198-217 模式：**直接 INSERT ingest_jobs 行 + 直接 `run_ingest_job`，不经 worker**。
- **两 job 模型**：job1（Ch01 建页）与 job2（Ch02 撞入）分别 INSERT 分别跑；断言一律针对 **job2 的 result**（单 job 下 Ch01 建页必进 new_pages，"new_pages 不含"断言只在 job2 成立）。
- **防 step1 缓存错位（评审 C-2）**：`ingest:cache:{content_hash}` 是无 project 维度的全局 Redis 键、TTL 7 天——fixture source 文本**内嵌每次运行唯一 uuid**（如 `A 版正文（视频课视角）[run-{uuid}]`），否则重跑/并行同内容互相污染，症状为"第一次过、重跑挂"。
- **stub step2 输出约束（评审 M-15）**：每响应 **<4 个 FILE 块且 <10000 字符**——否则触发 dedicated review 第三次 LLM 调用（review.rs:267-273 阈值），脚本序列错位。当前各用例脚本恰低于阈值，新增内容时必须守住此上限。
- slug 复用（spec §5 集成清单第 5 条）**不设独立集成用例**：机制层由 Task 4 单测覆盖（prompt 注入清单+复用指令），行为层与 case 1 同构（stub 已脚本化"LLM 选择复用 path"这一步，集成用例无增量信息）。Self-Review 已记录此映射。

**用例与脚本序列**（全部 `#[tokio::test] #[ignore = "requires PG + Redis"]`，跑法 `cargo test --test integration t8_ -- --ignored`；**跑前核对 docker PG/Redis 在**，且批次 4 摄取已终态——避免与 live job 互扰）：

- [ ] **Step 1: t8_merge_success_accumulates**

fixture：`LT项目_t8_{uuid}` 项目 + storage 预写 `raw/sources/t8-book/Ch01.md`、`Ch02.md`（内容各内嵌 `[run-{uuid}]`；写入方式看 storage.rs 的 write 方法签名，或走 upload HTTP）→ team provider base_url 指向 stub。

job1 脚本（INSERT + run_ingest_job）：
1. step1(Ch01)→`{"entities":[],"connections":[],"contradictions":[]}`（shape 以 step1_analyze.txt 为准，执行时核对）
2. step2(Ch01)→`---FILE: concepts/t8-demo.md ---\n---\ntitle: A\nsources: ["raw/sources/t8-book/Ch01.md"]\n---\nA 版正文（视频课视角）[run-{uuid}]\n---END FILE---`（格式对齐 parse_single_block 的 FILE 块解析；单 FILE 块，低于 review 阈值）

job2 脚本（新 INSERT + run_ingest_job，source=Ch02）：
3. step1(Ch02)→同上最小 JSON
4. step2(Ch02)→同 path FILE 块，`sources: ["raw/sources/t8-book/Ch02.md"]`，B 版正文（内嵌 run-uuid）
5. merge→`A+B 融合正文（含两版关键内容）`

断言（**对 job2 的 result 与 DB**）：DB 行 `concepts/t8-demo.md` 的 sources == `["raw/sources/t8-book/Ch01.md","raw/sources/t8-book/Ch02.md"]`（并集序）；content 含 A 与 B 关键词；job2 `result.merged_pages` 含 path 且 `new_pages` **不含**；`updated_at > created_at`；job2 warnings 不含 `"fallback replace"`。

- [ ] **Step 2: t8_merge_fallback_replaces_wholesale**

job1 同上（step1/step2 建页）；job2 脚本：step1、step2（同上），merge 调用返回 `StubResp::Error(500)`。
断言：页 content == B 版正文（incoming 原样，非融合）、sources == `["raw/sources/t8-book/Ch02.md"]`（**非并集**，评审 I1）、merged_pages 空、job2 warnings 含 "fallback replace"。

- [ ] **Step 3: t8_single_source_regeneration_replaces**

job1（Ch01 v1）建页后，重写 storage 的 Ch01.md 内容（含新 `[run-{uuid}]`，hash 变）；job2 = 同一 source path 再 INSERT 再跑。
脚本：step1(v2)、step2(v2)（同 path、sources 仍 [Ch01]）——stub 只给这 4 个响应（含 job1 的 2 个）。
断言：content == v2 原样（走了 Replace 非自 merge）；merged_pages 空；**job2 warnings 不含 `"fallback replace"`**（评审 I-6——stub 耗尽返回 500 会触发 fallback，终态与正确 Replace 完全一致，必须靠 warnings 区分，"天然断言"不成立）。

- [ ] **Step 4: t8_sequence_a_b_a2_preserves_b**

三个 job：A 建页 → B 撞入（merge A+B）→ A 内容改写重摄（merge A2+AB）。
脚本：step1(A)、step2(A)、step1(B)、step2(B)、merge(A+B)、step1(A2)、step2(A2)、merge(A2+AB)。
断言：最终 content 含 B 关键词（B 存续）且长度 < A2+AB 之和（无逐字膨胀）；sources == 两源并集。

- [ ] **Step 5: 跑全部 t8_ 用例**

Run: `cd src-server && cargo test --test integration t8_ -- --ignored 2>&1 | tail -5`
Expected: 4 passed（live PG/Redis；**跑前确认批次 4 终态**）

- [ ] **Step 6: Commit**

```bash
git add src-server/tests/integration/merge_ingest_test.rs
git commit -m "test(integration): 合并四用例——成功累积/整页回退/单源重生成/A→B→A 存续"
```

---

### Task 7: MinerU 先决检查 + 拆章脚本

**Files:**
- Create: `tools/books/split_chapters.py`
- Create: `tools/books/README.md`（流水线用法与先决检查记录）

**Interfaces:**
- Produces: `<out_dir>/<book_slug>/ChNN-<slug>[-pN].pdf` + `<out_dir>/<book_slug>/manifest.json`（Task 8/9 消费：chapters 数组含 file/from_page/to_page/est_tokens）

- [ ] **Step 1: 先决检查（非代码，结果报用户）**

```bash
lsof -i :8000 -sTCP:LISTEN          # 本地 mineru-api 在跑？
curl -s http://127.0.0.1:8000/docs | head -3
grep -ri mineru ~/Library/Application\ Support/com.llmwiki.app/app-state.json 2>/dev/null
```
已核实桌面无配置（评审）。若两者皆无 → 停下向用户确认：本地 docker（mineru-api 镜像）还是云端 token。**结论写入 tools/books/README.md。**

- [ ] **Step 2: 拆章脚本**（完整实现）

```python
#!/usr/bin/env python3
"""按书签 outline 拆章（spec §3）：目标 ≤40k token/章（pypdf 提取字符/4 估算），
超预算二分；无书签用 --ranges 人工页区间表。产出 ChNN-<slug>.pdf + manifest.json。
用法：python3 tools/books/split_chapters.py <book.pdf> <out_dir> <book_slug> \
        [--ranges ranges.json] [--top-level-only]
（书签嵌套时 --top-level-only 只取顶层章；默认全展开）"""
import argparse, json, re, sys
from pathlib import Path
from pypdf import PdfReader, PdfWriter

TOKEN_BUDGET = 40_000

def page_chars(reader, i):
    try:
        return len((reader.pages[i].extract_text() or "").strip())
    except Exception:
        return 0

def outline_entries(reader, top_only=False):
    out = []
    def walk(items, depth=0):
        for it in items:
            if isinstance(it, list):
                if not top_only:
                    walk(it, depth + 1)
            else:
                try:
                    out.append((it.title, reader.get_destination_page_number(it)))
                except Exception:
                    pass
    try:
        walk(reader.outline)
    except Exception:
        pass
    return out

def slugify(t):
    s = re.sub(r"[^A-Za-z0-9]+", "-", t).strip("-").lower()
    return s[:60] or "untitled"

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf"); ap.add_argument("out_dir"); ap.add_argument("slug")
    ap.add_argument("--ranges"); ap.add_argument("--top-level-only", action="store_true")
    a = ap.parse_args()
    reader = PdfReader(a.pdf)
    n = len(reader.pages)
    if a.ranges:
        chapters = [(r["title"], r["from"] - 1, r["to"] - 1) for r in json.loads(Path(a.ranges).read_text())]
    else:
        entries = outline_entries(reader, a.top_level_only)
        if not entries:
            sys.exit("无书签且未给 --ranges；请人工页区间表")
        chapters = []
        for i, (title, start) in enumerate(entries):
            end = (entries[i + 1][1] - 1) if i + 1 < len(entries) else n - 1
            if end >= start:
                chapters.append((title, start, end))
    book_dir = Path(a.out_dir) / a.slug
    book_dir.mkdir(parents=True, exist_ok=True)
    manifest = {"book": a.slug, "total_pages": n, "chapters": []}
    idx = 0
    for title, start, end in chapters:
        queue = [(start, end, None)]
        while queue:
            s, e, part = queue.pop(0)
            est = sum(page_chars(reader, p) for p in range(s, e + 1)) / 4
            if est > TOKEN_BUDGET and s < e:
                mid = (s + e) // 2
                queue = [(s, mid, part or 1), (mid + 1, e, (part or 1) + 1)] + queue
                continue
            idx += 1
            name = f"Ch{idx:02d}-{slugify(title)}" + (f"-p{part}" if part else "") + ".pdf"
            w = PdfWriter()
            for p in range(s, e + 1):
                w.add_page(reader.pages[p])
            w.write(book_dir / name)
            manifest["chapters"].append({
                "file": name, "title": title, "from_page": s + 1, "to_page": e + 1,
                "est_tokens": int(est),
            })
            print(f"[{idx}] {name}: pp.{s+1}-{e+1} ~{int(est)} tok")
    (book_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
    print(f"manifest: {book_dir / 'manifest.json'}")

if __name__ == "__main__":
    main()
```

- [ ] **Step 3: 在 LT 书上实跑验证**

Run: `python3 tools/books/split_chapters.py "/Users/berton/Github/L T师训 2024-2025（HEVC）/【2024-2025】LT年度师训会员（高年级版）/LT会员资料新_20230722_010856/LT会员资料/LT师训会员专属资料夹（持续更新）/教学法知识库配套书籍/Learning Teaching 3rd Edition 2.pdf" /tmp/books LT-LearningTeaching-3rd`
Expected: 章节列表打印、manifest 落盘；书签异常（空/无）→ 按报错走 --ranges 人工表并记录区间于 README

- [ ] **Step 4: Commit**

```bash
git add tools/books/split_chapters.py tools/books/README.md
git commit -m "feat(books): 拆章脚本——书签 outline + 40k token 预算二分 + manifest"
```

---

### Task 8: MinerU 双协议解析 + 清洗 + 质量闸

**Files:**
- Create: `tools/books/mineru_parse.ts`
- Create: `tools/books/books.example.json`（配置模板；真实 books.json 不入 git）

**Interfaces:**
- Consumes: Task 7 manifest.json
- Produces: `<out_dir>/<slug>/staged/ChNN-*.md`（清洗后、带上源头的章节 markdown）+ `parse-report.json`（每章 status: ok|gate_blocked|failed + chars/pages）；Task 9 消费 staged/*.md

- [ ] **Step 1: 配置模板**

```json
{
  "mode": "local",
  "local": { "baseUrl": "http://127.0.0.1:8000", "token": "" },
  "cloud": { "token": "" },
  "gate": { "minCharsPerPage": 200 }
}
```

- [ ] **Step 2: 实现**（结构骨架 + 关键实现点；HTML 表格转换从 mineru.ts 移植同名函数）

```ts
// tools/books/mineru_parse.ts —— MinerU 桥接（spec §3 双协议，参 src/lib/mineru.ts:698-853）
// 用法：npx tsx tools/books/mineru_parse.ts --book <slug> --dir /tmp/books [--only Ch01]
// 产出 staged/*.md + parse-report.json（量化闸：<200 字符/页 → gate_blocked 不进 staged）
// --only：只解析文件名含该子串的章（单章实测/调试用；Step 3 会用到）
import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { parseArgs } from "node:util"

const LOCAL_POLL_TIMEOUT_MS = 3_600_000
const CLOUD_POLL_TIMEOUT_MS = 300_000

// —— 本地协议：multipart POST /tasks → 轮询 /tasks/:id → /tasks/:id/result 取 md_content ——
async function parseLocal(pdf: Buffer, name: string, cfg: LocalCfg): Promise<string> {
  const form = new FormData()
  form.append("files", new Blob([pdf], { type: "application/pdf" }), name)
  form.append("backend", "hybrid-engine"); form.append("effort", "medium")  // backend 默认=hybrid-engine（mineru.ts:711），非 auto
  form.append("parse_method", "auto"); form.append("lang_list", "en")
  form.append("formula_enable", "true"); form.append("table_enable", "true")
  form.append("return_md", "true"); form.append("return_images", "false")
  form.append("response_format_zip", "false")
  const submit = await fetch(`${cfg.baseUrl}/tasks`, { method: "POST", body: form, headers: cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {} })
  if (!submit.ok) throw new Error(`local submit HTTP ${submit.status}: ${await submit.text()}`)
  const { task_id: tid } = await submit.json() as { task_id: string }
  if (!tid) throw new Error("local MinerU returned no task ID")
  const start = Date.now()
  while (Date.now() - start < LOCAL_POLL_TIMEOUT_MS) {
    await new Promise(r => setTimeout(r, 3000))
    const st = await (await fetch(`${cfg.baseUrl}/tasks/${encodeURIComponent(tid)}`, { headers: cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {} })).json()
    if (st.status === "completed") {
      const result = await (await fetch(`${cfg.baseUrl}/tasks/${encodeURIComponent(tid)}/result`, { headers: cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {} })).json() as { results?: Record<string, { md_content?: string }> }
      const md = Object.values(result.results ?? {})[0]?.md_content
      if (!md?.trim()) throw new Error("local MinerU returned empty md_content")
      return convertHtmlTablesToMarkdown(md)
    }
    if (st.status === "failed") throw new Error(`local task failed: ${JSON.stringify(st).slice(0, 200)}`)
  }
  throw new Error("local MinerU poll timeout (60min)")
}

// —— 云端协议（条件任务，评审 I-8：仅先决检查选云 token 时实现）——
// 锚点：src/lib/mineru.ts:429-571（云端分支完整实现）
// 要点：POST https://mineru.net/api/v4/extract/task 带 Bearer token → 轮询 task/batch
// 状态 → full_zip_url 下载 zip（jszip，root node_modules 已有）→ 解出 .md。
// 若先决选本地 docker，本分支保持 TODO 注释即可（骨架不展开）。

// —— convertHtmlTablesToMarkdown：从 src/lib/mineru.ts 移植（grep 函数体整段复制，
//     去掉 Tauri 依赖——该函数应为纯字符串处理；若含依赖则按逻辑重写） ——

// —— 清洗 + 质量闸 ——
function clean(md: string, book: string, file: string): string {
  const noImages = md.replace(/!\[[^\]]*\]\([^)]*\)/g, "")            // 剥图片引用
  const header = `> 来源：${book} · ${file.replace(/\.pdf$/, "")}\n\n`
  return header + noImages.trim() + "\n"
}
function gate(md: string, pages: number, minPerPage: number): boolean {
  return md.replace(/\s/g, "").length / pages >= minPerPage
}
```

main 流程：读 manifest → 逐章 parseLocal/parseCloud（串行，本地单任务冷启动）→ clean → gate（pages = to_page - from_page + 1）→ ok 落 staged/、gate_blocked/failed 记 parse-report.json。

- [ ] **Step 3: LT 第一章单章实测**

Run: `npx tsx tools/books/mineru_parse.ts --book LT-LearningTeaching-3rd --dir /tmp/books --only Ch01`
Expected: staged/Ch01-*.md 产出；肉眼抽查 md 质量（栏序/表格）；报告含 chars/pages 比值

- [ ] **Step 4: Commit**

```bash
git add tools/books/mineru_parse.ts tools/books/books.example.json
git commit -m "feat(books): MinerU 双协议桥接——本地 md_content/云端 zip + HTML 表转换 + 清洗 + 量化闸"
```

---

### Task 9: 上传 + 摄取（凭证续期 + 断言）

**Files:**
- Create: `tools/books/upload_and_ingest.ts`

**Interfaces:**
- Consumes: Task 8 staged/*.md + parse-report.json；transcriber api-client 凭证层模式（api-client.ts:178-210：login → token/refresh，401 → 重登录重放）
- Produces: `ingest-report.json`（每批 job_id/终态/new_pages/merged_pages/warnings）

**关键实现点**：
- 凭证层照抄 transcriber（svc 账号从 books.json 或环境变量，勿硬编码）
- **断言（spec 写死项 9）**：上传前逐文件 assert `path.endsWith(".md")` 且 `path.startsWith(\`raw/sources/${slug}/\`)`——违者中止
- 分批 4-6 章 → `POST /api/v1/projects/:pid/ingest`（source_paths）→ 轮询 getIngestJob 至 succeeded/failed（轮询上限 30min/批，超时记 report 不中断后续批）
- 摄取语言确认：目标 project 的 ingest_language 已是"中文"（live LT 项目即如此；测试项目须设置）

- [ ] **Step 1: 实现**（按上述要点；HTTP 层直接 fetch，路径/api 约定对齐 tools/transcriber/src/api-client.ts）
- [ ] **Step 2: 干跑**（--dry-run：只打印将上传的 path 列表与断言结果，不调 API）
- [ ] **Step 3: Commit**

```bash
git add tools/books/upload_and_ingest.ts
git commit -m "feat(books): 断言式上传摄取——凭证续期 + raw/sources 前缀断言 + 分批轮询报告"
```

---

### Task 10: 部署（批次 4 终态守卫）

**Files:** 无代码；运维步骤

- [ ] **Step 0: 提前告知用户部署窗口**（spec §4 B-M3 落实——重启期间 15 位教师的 web 访问瞬断，选低峰并预告）

- [ ] **Step 1: 守卫——确认无 running/pending ingest job**

Run: `docker exec src-server-postgres-1 psql -U llmwiki -d llmwiki -t -A -c "SELECT count(*) FROM ingest_jobs WHERE status IN ('pending','running');"`
Expected: 0（非 0 → 等批次 4 完成后再来；预计 ~23:00）

- [ ] **Step 2: 全量测试兜底**

Run: `cd src-server && cargo test --lib 2>&1 | tail -3 && cargo test --test integration t8_ -- --ignored 2>&1 | tail -3`
Expected: 全过

- [ ] **Step 3: 重建 + 重启**

```bash
cd src-server && cargo build --release 2>&1 | tail -2
launchctl kickstart -k gui/$(id -u)/<src-server-label>   # label 以 launchctl list | grep 确认
```

- [ ] **Step 4: 验证**

```bash
curl -s http://127.0.0.1:8080/health                  # 健康路径是顶层 /health（routes/mod.rs:37），非 /api/v1/health
tail -20 src-server/logs/llm-wiki.log                 # 无 panic/error
```
重摄一个 hash 未变 source（挑一个已摄入的 source 路径直接 INSERT job 再跑）→ job succeeded 且该 source 走 `check_ingested_file` 的 content-hash 命中分支（`Ok(None)` 跳过，ingest_pipeline.rs:1110-1116）→ 确认零回归。

- [ ] **Step 5: 部署记录 Commit**（若有配置/文档跟随变更；否则无 commit）

---

### Task 11: LT 试点执行 + 对账 + 验收

**Files:**
- Create: `.superpowers/books-pilot/report.md`（评审/执行分会话约定；gitignored）

- [ ] **Step 0: 前置确认**——Task 10 已部署（live 跑的是含 merge 的 release）；/tmp/books 产物在（缺失则重跑 Task 7/8 对应步骤——拆章与解析产物不落 git，丢失需重建）

- [ ] **Step 1: 全链执行**（Task 7 产物已就绪）

```bash
python3 tools/books/split_chapters.py <LT书> /tmp/books LT-LearningTeaching-3rd   # Task 7 已跑
npx tsx tools/books/mineru_parse.ts --book LT-LearningTeaching-3rd --dir /tmp/books
npx tsx tools/books/upload_and_ingest.ts --book LT-LearningTeaching-3rd --dir /tmp/books --project <LT项目id>
```

- [ ] **Step 2: 对账 SQL**（docker psql）

```sql
-- 书批次新增/合并页
SELECT count(*) FROM wiki_pages WHERE created_at >= '<试点开始>';
SELECT count(*) FROM wiki_pages WHERE updated_at >= '<试点开始>' AND created_at < '<试点开始>';
-- merged_pages 全量清单（试点期全量人工过审，评审 A-I6）
-- 从各 job result JSON 的 merged_pages 聚合；或按 updated_at+sources 含 raw/sources/LT- 检索
-- 污染扫描
SELECT count(*) FROM wiki_pages WHERE updated_at >= '<试点开始>' AND (content ILIKE '%thinking process%' OR content ILIKE '%<think>%' OR content ILIKE '%待补充%');
-- 页数下限（评审 B-M4）：每章派生页 ≥1
```

- [ ] **Step 3: 验收五条**（spec §5）：中文+术语英文（抽 ≥5 章）；merged_pages>0 且**全量人工过审**；污染 0；页数下限核对；闸命中清单复核。报告落 `.superpowers/books-pilot/report.md` 附外部访问账目。

**全量过审操作定义（评审 I-7）**：
- 聚合 SQL（选定 wiki_pages 检索式）：`SELECT path FROM wiki_pages WHERE updated_at >= '<试点开始>' AND sources::text LIKE '%raw/sources/LT-%' ORDER BY path;`
- 判据 checklist（每页过四问）：① 双源共存——书定义与视频实例都在；② 无重复膨胀——无逐字重复段；③ 术语正确——中英形态符合现行规则；④ 无污染——无 thinking 痕迹/占位符。
- 不通过处置（二选一，记入报告）：a) 人工修页（web PUT 编辑，If-Match）；b) 删该 source 的 `ingested_files` 行触发重摄（走新版 merge 重算）。

- [ ] **Step 4: 记忆更新 + 向用户汇报验收结果**（含其余 4 本推进建议）

---

## Self-Review 记录（r2 评审后修订）

- **Spec 覆盖**：§1→Task 1/2/3；§2→Task 4（**含 cap 与 context 联动**：`existing_paths_cap` 纯函数 + LIMIT 绑参 + 单测，评审 I-5 落实）；§3→Task 7/8/9；§4→Task 10（含 Step 0 用户告知）；§5→Task 5/6（单测+集成）+Task 11（试点验收）。
- **slug 复用映射（评审 I-4 降级记录）**：spec §5 集成清单第 5 条不设独立集成用例——机制层由 Task 4 单测覆盖（prompt 注入清单+复用指令），行为层与 Task 6 case 1 同构（stub 脚本化了"LLM 复用 path"，集成用例无增量断言面）。
- **评审 r2 三 Critical 落实**：C-1 t8 命名与 SWEEPS 逐字匹配（Task 5 Step 1/3）；C-2 fixture 内嵌 run-uuid 防 step1 全局缓存错位（Task 6 编排铁律）；C-3 直接 INSERT + 绝不 HTTP enqueue + 断言针对 job2（Task 6 编排铁律）。
- **占位符**：Task 5 Step 3 的 `todo!` 是文档展示（计划内已注明以 reviews_test.rs 序列为模板、命名不可照抄）；其余步骤均含实际代码/命令。
- **类型一致**：collision_mode/union_sources/merge_pages_via/fetch_concept_entity_paths(含 cap 参)/existing_paths_cap/existing_paths_section 的签名在 Task 1/2/4 定义、Task 3/6 消费一致；IngestJobResult.merged_pages 全计划统一命名。
