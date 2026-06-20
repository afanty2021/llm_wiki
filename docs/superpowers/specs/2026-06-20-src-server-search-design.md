# src-server 搜索 API 设计（Layer 2b）

> **状态**：设计确认（2026-06-20，已并入 review 反馈）| **依赖**：Layer 2a（embedding 管线——`vector_search` 已有页级向量、`embed_query` 已有）、Layer 1（wiki 数据层）
>
> **范围**：移植桌面端多阶段搜索到 src-server——统一单入口 hybrid 搜索（keyword + vector + RRF 融合）；关键词打分对齐桌面 `score_file` 多信号加权；产出后端 `camelCase` 响应与桌面前端契约一致。本 spec 只做搜索 API，不含图谱/insights（后续 2c/2d）。向量存储/生成是 2a 的范围。

---

## 1. 背景与目标

桌面端 `src-tauri/src/commands/search.rs` 实现了成熟的多阶段搜索（keyword + vector + RRF hybrid 融合），前端 `src/lib/search.ts` 消费其 `ProjectSearchResponse`（camelCase）contract。但 src-server 目前只有基础 keyword ILIKE（`search.rs`）+ 独立向量端点（`/search/vector`），无融合、无多信号加权、contract 不匹配。

本层的目标：

- **统一单入口 hybrid 搜索**：`GET /api/v1/search?project_id=&query=&limit=`，自动 keyword/vector/hybrid 三态
- **关键词打分对齐桌面**：移植多信号加权（文件名精确/短语标题/短语正文/标题 token/正文 token），命中精确度与桌面无差异
- **RRF 融合**：`k=60` Reciprocal Rank Fusion，移植桌面常量与单测
- **contract 与桌面一致**：响应 shape（`mode`/`results`/`tokenHits`/`vectorHits` + camelCase + `score`/`vectorScore`）

### 桌面参考（已查证）

桌面搜索算法在 `src-tauri/src/commands/search.rs`（1420 行）。核心结构见 [附件 A](#附件-a-桌面搜索核心结构速览)。

---

## 2. 关键决策（已与用户确认 + review 修订）

| 决策 | 选择 | 理由 |
|------|------|------|
| API 形态 | **统一单入口 `/search` hybrid** | 与桌面 contract 一致；embedding 未配→keyword 退化；移除 `/search/vector`（无前端消费方）|
| 融合策略 | **RRF k=60**（直接移植桌面） | rank-based、对不同打分尺度鲁棒；桌面已有单测验证 |
| 关键词打分 | **SQL 过滤候选 + Rust 侧完整 `score_page`**（移植桌面 `score_file`） | 质量对齐桌面；SQL 简单；wiki 规模够用 |
| 向量侧 | **沿用 2a 页级 `vector_search`**（一页一向量，无 chunk 聚合） | 2a 已产出；wiki 聚焦短页，页级粒度够用 |
| 常量 | **全部沿用桌面值**（200/50/20/5/1/60/80） | 保证搜索体验与桌面无差异；桌面 search.scenarios.test.ts 已有覆盖 |
| `/search/vector` | **删除** | 单入口 contract 已覆盖向量能力（自动 hybrid）；独立端点无前端消费者 |

---

## 3. 桌面 → 服务端移植差异（review 重点）

这是移植中唯一结构性差异——桌面**扫 `.md` 文件系统**，服务端**查 `wiki_pages` 表**。以下差异必须在实现中严守（否则如 RRF join 对不上、vector-only 页遗漏）：

### 3.1 RRF join key

| | 桌面 | 服务端 |
|---|------|--------|
| token_rank key | `normalize_path(result.path)` | `wiki_pages.path`（全路径，如 `entities/alice.md`）|
| vector_rank key | `file_stem(result.path)`（桌面 vectorstore page_id 存 stem）| **同上：全路径**——2a `vector_search` 的 JOIN `e.wiki_page_id = wp.path`，`wiki_page_id` 存的也是全路径 |
| RRF join | 双 key 不一致（`normalize_path` vs `file_stem`）| **双 key 一致：都是全路径**——直接用 path 做 key、无 file_stem |

> 实现时若照搬桌面 `file_stem` 做 vector join，将与服务端全路径 key 错配，RRF 永远对不上。必须统一用全路径。

### 3.2 文件名精确命中（FILENAME_EXACT_BONUS）

桌面用文件系统 `file_stem`（`attention.md`→`attention`）。服务端没有文件名，但有 `wiki_pages.path`：
- **stem** = path 最后一个 `/` 之后、`.md` 之前的部分，小写（如 `entities/alice.md` → `alice`）
- `filename_exact = query_phrase == stem`
- title_token_score 的拼接用 path 最后一段（含 `.md`）：`format!("{title} {last_path_segment}")`（桌面原版是 `format!("{title} {file_name}")`，等价移植）

### 3.3 token_rank / title 来源

桌面 `extract_title(content, file_name)` 需解析 frontmatter/H1/fallback。服务端 `wiki_pages.title` 列**已经存好 title**——直接使用，无需 `extract_title`。这是一处有价值的简化。

### 3.4 vector-only 结果物化

桌面 `materialize_vector_only_results`：遍历 vector results→不在 keyword 结果的页→由 `page_paths_by_stem` 拿到文件路径→`fs::read_to_string`→`extract_title`/`extract_image_refs`。

服务端改为：对 vector results 中 **不在 keyword 结果集**的页→**用 path（即 `wiki_page_id`）查 `wiki_pages` 表**→取 `title, content, images` 列→用 content 通过 `build_snippet` 生成 snippet→构建结果项。**无文件 I/O。**

### 3.5 search_mode 签名

桌面实际签名（review 指正）：
```rust
fn search_mode(token_rank_empty: bool, vector_hits: usize) -> &'static str
```
两个参数分别是 **"token rank 是否为空"** 和 **"向量命中数"**，而非两个 rank map。服务端照此移植。

---

## 4. 数据流

```
GET /api/v1/search?project_id=&query=&limit=
  1. tokenize_query(query)              纯函数，零外部依赖
  2. SQL ILIKE 候选拉取(wiki_pages)       WHERE (title/content ILIKE any token) OR (content ILIKE phrase)
     → Vec<Candidate> { path, title, content }
  3. score_page 逐候选打分               Rust 侧完整移植，无 SQL 复杂逻辑
     → Vec<ScoredPage> + token_rank {path→rank}
  4. [若 embedding 已配] embed_query(query)
     → vector_search(pgvector)           (2a 已有，返回 Vec<VectorSearchResult>)
     → vector_rank {path→rank} + vector_score {path→score}
  5. [若 vector] materialize_vector_only：vector-only 页查 wiki_pages 补全 title/content/images
  6. apply_rrf(results, token_rank, vector_rank, vector_score)    RRF k=60，key 均为全路径
  7. search_mode(token_rank.is_empty(), vector_hits)              → "keyword"|"vector"|"hybrid"
  8. 排序(rrf score desc) + truncate(limit)        （snippet 各结果物化时已有，此步不重建）
  → SearchResponse { mode, results: Vec<SearchResult>, token_hits, vector_hits }
```

**退化**：向量失败/未配 → 跳步骤 4-6，`mode=keyword`，`vector_hits=0`，结果由 token score 直接排序。

---

## 5. 组件改动

### 5.1 `services/search.rs`（重写）

现有 keyword ILIKE 替换为完整 hybrid 搜索 + 移植的桌面纯函数。新模块结构：

```rust
// ── 常量（桌面原值）──
const DEFAULT_RESULTS: usize = 20;
const MAX_RESULTS: usize = 50;
const RRF_K: f64 = 60.0;
const FILENAME_EXACT_BONUS: f64 = 200.0;
const PHRASE_IN_TITLE_BONUS: f64 = 50.0;
const PHRASE_IN_CONTENT_PER_OCC: f64 = 20.0;
const MAX_PHRASE_OCC_COUNTED: usize = 10;
const TITLE_TOKEN_WEIGHT: f64 = 5.0;
const CONTENT_TOKEN_WEIGHT: f64 = 1.0;
const SNIPPET_CONTEXT: usize = 80;

// ── 纯函数（移植桌面，无 IO）──
pub fn tokenize_query(query: &str) -> Vec<String>;
pub fn extract_image_refs(content: &str) -> Vec<ImageRef>;
pub fn build_snippet(content: &str, query: &str) -> String;
fn score_page(path: &str, title: &str, content: &str, tokens: &[String], query_phrase: &str) -> Option<ScoredPage>;
fn apply_rrf(results: &mut [SearchResult], token_rank: &HashMap<String,usize>, vector_rank: &HashMap<String,usize>, vector_score: &HashMap<String,f64>);
fn search_mode(token_rank_empty: bool, vector_hits: usize) -> &'static str;
fn trim_query_punctuation(value: &str) -> String;
fn count_occurrences(haystack: &str, needle: &str) -> usize;
fn token_match_score(text: &str, tokens: &[String]) -> usize;

// ── 中间类型 ──
struct Candidate {                          // SQL 候选拉取产出
    path: String, title: String, content: String,
}
struct ScoredPage {                         // score_page 产出（snippet 内部算好，不存 content）
    path: String, title: String, snippet: String,
    score: f64, title_match: bool, images: Vec<ImageRef>,
}

// ── score_page 打分公式（与桌面逐字一致）──
//   stem            = path 最后一个 '/' 之后、".md" 之前，小写
//   filename_exact  = !query_phrase.is_empty() && stem == query_phrase
//   title_has_phrase= !query_phrase.is_empty() && format!("{title} {last_path_segment}").to_lowercase().contains(query_phrase)
//                    （query_phrase 已由 trim_query_punctuation(&query.to_lowercase()) 预小写；title 侧再 to_lowercase 保大小写不敏感）
//   content_phrase_occ = count_occurrences(content_lower, query_phrase).min(MAX_PHRASE_OCC_COUNTED=10)
//   title_token_match  = token_match_score("{title} {last_path_segment}", tokens)
//   content_token_match= token_match_score(content, tokens)
//   score = (filename_exact? FILENAME_EXACT_BONUS : 0)
//         + (title_has_phrase? PHRASE_IN_TITLE_BONUS : 0)
//         + content_phrase_occ as f64 * PHRASE_IN_CONTENT_PER_OCC
//         + title_token_match as f64 * TITLE_TOKEN_WEIGHT
//         + content_token_match as f64 * CONTENT_TOKEN_WEIGHT
//   **五信号全 0 → 返回 None**：该页不进 token_rank，避免零分页稀释 RRF。
//
// ── apply_rrf：rrf = Σ 1/(RRF_K + rank)，rank **1-indexed**（最高分 rank=1 = idx+1）──
//   0-indexed 会让分值偏高 ~1.6% 且对不上桌面 rrf_combines 单测的精确数值。

// ── DB 编排 ──
pub async fn hybrid_search(
    pool: &PgPool,
    emb_cfg: Option<&EmbeddingConfig>,
    client: &reqwest::Client,
    project_id: i32,
    query: &str,
    limit: usize,
) -> Result<SearchResponse, AppError>;
```

**hybrid_search 实现要点**（对应 §4 数据流 8 步）：
- 候选 SQL：`WHERE project_id=$1 AND ((title ILIKE '%' || tok || '%' OR content ILIKE '%' || tok || '%') ... )`（每 token 一组 OR）；**仅当 `phrase` 非空时**才追加 `OR content ILIKE '%' || phrase || '%'`——phrase 为空时 `ILIKE '%%'` 会匹配全表（纯标点查询场景），必须 guard。返回 `(path, title, content)`。
- 关键词打分后构建 `token_rank: HashMap<String, usize>`（key=全 path），并把每个 `ScoredPage` **转换成 `SearchResult`**（`vector_score = None`，由 RRF 回填）→ 合并进 `results: Vec<SearchResult>`。
- 向量分支调用 `embedding::embed_query` + `embedding::vector_search` → 构建 `vector_rank: HashMap<String, usize>` + `vector_score: HashMap<String, f64>`，**key 均为全 path**（`VectorSearchResult.path`）。
- **vector-only 物化**：对 `vector_rank.keys()` 不在 keyword 结果 path 集中的条目 → `SELECT title, content FROM wiki_pages WHERE project_id=$1 AND path=$2` → 构建结果项 push（初始 score=0、RRF 后更新）。**images 用 `extract_image_refs(&content)` 运行时解析**（**不用** `wiki_pages.images` 列——那是 ingest 写入的 frontmatter images，语义不同；与桌面"从正文实时解析"一致）。**snippet 用 smart anchor**（见下）调 `build_snippet`。
- **snippet 锚点选择（移植桌面，关键）**：keyword 结果的 snippet 由 `score_page` 内部产出——anchor = `query_phrase`（content 短语命中时）/ 第一个出现在 content 的 token / raw query（回退），再 `build_snippet(content, anchor)`。vector-only 结果用同一 anchor 逻辑。**不要直接拿 raw query 当 anchor**——多 token 查询若 content 只含部分词，`build_snippet` 搜不到→回退位置 0→片段恒为开头。**apply_rrf 之后不再重建 snippet**，各结果物化时已有。
- 最后 `apply_rrf`（rank 1-indexed）→ `search_mode` → sort + truncate（snippet 不在此步重建）。

### 5.2 `routes/search.rs`（合并）

- `search_handler` 改为调 `hybrid_search`→返回 `SearchResponse`。
- **删除** `vector_search_handler` + `/search/vector` 路由。
- 路由只剩 `Router::new().route("/", get(search_handler))`。

### 5.3 `services/embedding.rs`

`vector_search` + `embed_query` 沿用 2a 实现（已就绪）。

### 5.4 数据模型

按桌面 `ProjectSearchResponse` 对齐，加 `#[serde(rename_all="camelCase")]`：

```rust
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub path: String,
    pub title: String,
    pub snippet: String,
    pub title_match: bool,
    pub score: f64,
    pub vector_score: Option<f64>,
    pub images: Vec<ImageRef>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResponse {
    pub mode: String,              // "keyword" | "vector" | "hybrid"
    pub results: Vec<SearchResult>,
    pub token_hits: usize,         // keyword 命中页数 = token_rank.len()
    pub vector_hits: usize,        // 向量检索返回结果数 = vector_rank.len()
}
```

`ImageRef { url: String, alt: String }`。

---

## 6. 错误处理与退化

- **embedding 未配置**（`AppConfig.embedding == None`）→ `vector_hits=0`、`mode=keyword`。
- **向量失败**（omlx 挂/embed_query 报错/vector_search 报错）→ warn 日志、`vector_hits=0`、`mode=keyword`，不抛错给调用方。与桌面 `resolve_query_embedding` 失败即禁用向量一致。
- **空 query** → `Err(ValidationError)` → 400。
- **候选为空 + 无向量** → 空结果（`mode=keyword`）。
- **候选 SQL 拉全 content**：候选页可能数十上百条，每条的 content 字段通过网络传输——wiki 数百页量级可接受，不做预截断。

---

## 7. 测试策略

**单元（CI 可跑）——移植桌面已有纯函数单测**：

| 测试 | 源（桌面）| 服务端适配 |
|------|---------|-----------|
| `tokenize_query` CJK bigram + 单字 | `tokenizes_cjk_bigrams_and_chars` | 原样移植 |
| `score_page` 文件名精确命中 200 分 | `keyword_search_prefers_filename_exact_match` | 改成 DB content 输入（非文件）|
| 短语共现 > 散落 token | `keyword_search_phrase_in_content_beats_scattered_tokens` | 同上 |
| `apply_rrf` 融合 + 保留 vector_score | `rrf_combines_token_and_vector_ranks` | **key 统一用全路径**（非 file_stem），重写测试 |
| `search_mode` 三态 | `search_mode_distinguishes_keyword_vector_and_hybrid` | 原样移植 |
| `extract_image_refs` 去重 | `extracts_image_refs_without_duplicates` | 原样移植 |

**集成（`#[ignore]`，PG + omlx，沿用 pdfium/2a 的 `--ignored` 模式）**：
- ingest 后 `GET /search?query=Alice&project_id=249` → `mode=hybrid`、`alice.md` 在 top3、`tokenHits>0`、`vectorHits>0`、`score` 正常（RRF 分值，非零）。

---

## 8. 已知限制 / 范围边界

1. **向量页级、无 chunk**：不做桌面 chunk 聚合/blending（2a 一页一向量）。整页粒度对 wiki 聚焦短页够用。
2. **候选过滤有极边缘漏召回**：SQL ILIKE 候选过滤 vs 桌面全扫。已在 SQL OR 中同时含 phrase，把"仅短语命中、token 被停用词筛掉"的极端情况覆盖住；wiki 规模下残余差异可忽略。
3. **不做查询建议/拼写纠错**等高级特性（YAGNI）。
4. **extract_image_refs 只解析 `![alt](url)`** 标准 Markdown 语法，不处理 Obsidian wikilink 图片（`![[image.png]]`），与桌面行为一致。
5. **title 直接用 `wiki_pages.title` 列**，不做 `extract_title` 解析（列值由 ingest 写入时已由 LLM 输出 frontmatter 填好）。桌面需要从文件解析是因为它不写 DB。

---

## 9. 验收标准

- [ ] `tokenize_query("默会知识")` 产出 **8 个**去重 token：bigram {默会,会知,知识} + 单字 {默,会,知,识} + 全词 {默会知识}（与桌面 `tokenizes_cjk_bigrams_and_chars` 一致；**不是 6 个**——漏 `识`/`默会知识` 会让移植单测挂）
- [ ] query="attention" → `attention.md` 的 score > `random.md` 的 score（文件名精确 > 内容命中）
- [ ] RRF 融合后 `both.md`（双命中）rank > 单命中页
- [ ] 向量未配/失败 → 返回 `mode=keyword`，200 OK，非 500
- [ ] `GET /search?query=Alice&project_id=249` → `mode=hybrid`、`results[0].path` 含 alice、`tokenHits>0`、`vectorHits>0`
- [ ] 响应 camelCase 字段与桌面 `ProjectSearchResponse` 一致

---

## 10. 与前后层的关系

- **2a（embedding 管线）**：消费者——`embed_query` + `vector_search`。依赖 2a 先实现。
- **1a（wiki 数据层 + pages CRUD）**：提供 `wiki_pages` 表数据（候选拉取 + vector-only 物化）。
- **2c/2d（graph/insights）**：不依赖搜索，可并行设计。

---

## 附件 A：桌面搜索核心结构速览

```
桌面 search_project:
  tokenize_query → score_file(每 .md 文件) [多信号加权] → token_rank{path→rank}
  → vector_search(embedding) [LanceDB chunk, 按页聚合] → vector_rank{stem→rank}, vector_score{stem→score}
  → materialize_vector_only_results (补 vector-only 页, 读文件)
  → apply_rrf (RRF k=60)
  → search_mode → sort → truncate → {mode, results, token_hits, vector_hits}
```

服务器移植：文件→DB、stem→全路径、chunk→页级、读文件→查表。

---

## 附件 B：review 反馈落实记录（2026-06-20）

| # | review 问题 | 落实 |
|---|------------|------|
| 1 | RRF join key：桌面 token path vs vector stem，服务端必须统一 path | §3.1 明确双 key 均为全路径，无 file_stem |
| 2 | FILENAME_EXACT_BONUS 语义不明：服务端无文件名 | §3.2 定义 stem=最后/后.md前；title_text 用 last_path_segment |
| 3 | vector-only 物化路径未描述 | §3.4 描述改成查 wiki_pages 表（非读文件）；§5.1 hybrid_search 要点含此步骤 |
| 4 | search_mode 签名写错 | §3.5 更正为 `(token_rank_empty: bool, vector_hits: usize)` |
| 5 | title 来源简化 | §3.3 说明直接用 wiki_pages.title 列；§8 加限制 #5 |
| 6 | tokenHits/vectorHits 未定义 | §5.4 注释 `token_hits=token_rank.len()`, `vector_hits=vector_rank.len()` |
| 7 | 候选 SQL 拉全 content 网络开销 | §6 加说明 wiki 量级可接受 |
| 8 | §7 补 Obsidian wikilink 图片限制 | §8 #4 |
| Q | /search/vector 删还是保留？ | 删除（§5.2）|
| Q | 常量值沿用？ | 全部沿用（§2、§5.1）|
| Q | §7 加限制？ | 加第 5 条 title 来源简化 + 图片限制（§8 #4/#5）|

### round 2（2026-06-20）

| # | 复查问题 | 落实 |
|---|---------|------|
| 9 | tokenize_query("默会知识") 预期写 6 个，桌面实际 8 个 | §9 更正为 8 个（补 `识` + 全词 `默会知识`）|
| 10 | score_page 公式 + "五信号全零→None"未写 | §5.1 补完整公式与 None 条件（防零分页稀释 RRF）|
| 11 | `phrase` 为空时 `ILIKE '%%'` 匹配全表 | §5.1 候选 SQL 加 "phrase 非空才追加 OR" guard |
| 12 | ScoredPage / Candidate 字段未定义 | §5.1 补中间类型定义（ScoredPage 含 content 供 snippet）|

### round 3（2026-06-20）

| # | 复查问题 | 落实 |
|---|---------|------|
| 13 | snippet anchor 未描述，raw query 当 anchor→片段恒为开头 | §5.1 补 smart anchor 选择逻辑（phrase/token/query 回退）+ apply_rrf 不重建 snippet |
| 14 | title_has_phrase 大小写未声明 | §5.1 公式显式 `.to_lowercase()` + 注明 query_phrase 预小写 |
| 15 | token_rank 0 vs 1-indexed 未提 | §5.1 apply_rrf 注明 **1-indexed**（对齐桌面单测精确数值）|
| 16 | vector-only images 来源未明（column vs 解析）| §5.1 明确 keyword+vector-only 均 `extract_image_refs(content)` 运行时解析，不用 `wiki_pages.images` 列 |

### round 4（2026-06-20）

| # | 复查问题 | 落实 |
|---|---------|------|
| 17 | ScoredPage 缺 snippet 字段（score_page 产 snippet 却无处放）| §5.1 ScoredPage 改 `{path,title,snippet,score,title_match,images}`（去 content）|
| 18 | §4 step 8 build_snippet 与 §5.1"不重建 snippet"矛盾 | §4 step 8 删 build_snippet |
| 19 | ScoredPage→SearchResult 转换步骤缺失 | §5.1 keyword 要点补转换（vector_score=None，RRF 回填）|
