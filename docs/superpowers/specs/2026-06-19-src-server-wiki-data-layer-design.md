# src-server wiki 数据层（wiki_pages CRUD + ingest + 导入）设计

> **状态：设计定稿（brainstorming 批准），待写实施 plan。**
> 依据：src-server 现状调研（auth/files/projects/teams 完整；chat/search/graph stub；wiki_pages 死表）+ 桌面功能（ingest.ts/wiki-graph/search）
> 创建：2026-06-19

---

## 1. 目标

web 版（多用户远程）的 wiki 数据层：激活 src-server 的 `wiki_pages` 死表，让数据进 DB，解锁后续 search/graph/chat。三件事：
1. **wiki_pages CRUD API**（数据层基础）
2. **服务端 ingest**（摄取源文档 → wiki_pages）
3. **一次性导入脚本**（迁移桌面 English/Invest 现有 wiki）

## 2. 架构概览

```
浏览器 web 前端（复用桌面 src/lib 算法 + React UI）
  ↓ HTTP API
src-server（Rust）
  ├─ wiki_pages CRUD（Section 1）
  ├─ ingest（Section 2：上传 → redis 队列 → worker → wiki_pages）
  └─ DB（pg 5433：wiki_pages）+ redis（6380：队列）+ storage（源文档）
```

ingest **服务端全套**（Rust 重写摄取，key 集中 llm_providers，无 CORS）；源文档**上传 storage**；**异步队列**（redis）。

---

## 3. Section 1：数据层

### 3.1 前置（team/project）

注册自动建 personal team（owner=self），解决"注册后无 team"（导入/ingest 需 project_id → team_id）。
- `POST /auth/register` 流程末尾：`INSERT team`（name="personal"）+ `team_members`（user_id, role=owner）。

project 属 team（现有 schema：`projects.team_id`）。

### 3.2 wiki_pages CRUD API

REST，权限 = project 的 team member（`team_members` 校验）。**path 用 query param `?path=`**（不用 URL path segment——避免 `%2F` 被代理/框架二次 decode 导致路由失败）：
```
GET    /projects/:pid/pages              列表（?type=concept&?q=标题/路径模糊）
GET    /projects/:pid/page?path=xxx      单个
POST   /projects/:pid/pages              {path, title, content, frontmatter} → 201
PUT    /projects/:pid/page?path=xxx      替换语义（整体替换）+ 乐观锁（If-Match: <updated_at>，冲突 409）
DELETE /projects/:pid/page?path=xxx      删除
```
- path 查询/更新/删除按 `?path=`：`/` 在 query string 合法无需 encode；path 值（`concepts/foo.md`）不含 `?&#=` 等特殊字符故无需编解码。若未来 path 含特殊字符，前后端 `encodeURIComponent`。
- POST/PUT：`UNIQUE(project_id, path)` 冲突 → 409。
- **PUT 替换语义**（非合并）；乐观锁防并发覆盖：`If-Match: <updated_at>` 用 **RFC 3339**（ISO 8601 子集），服务端取 DB `updated_at`（TIMESTAMPTZ）格式化为 RFC 3339 做字符串精确比对（避免时区/精度差异）。单用户 MVP 够用，合并编辑后续。

### 3.3 path 语义

相对 **wiki root**（`concepts/foo.md`），**不含 `wiki/` 前缀**。
- 对齐 OKF 导出（bundle-relative path）+ `wiki-graph.fileNameToId`（basename）。
- reserved：`index.md` / `log.md` / `overview.md`（相对 wiki root）。

### 3.4 frontmatter 存储

**JSONB 解析后**（不是原始字符串）：
```json
{ "type": "concept", "title": "Foo", "sources": [...], "related": [...], "tags": [...], "timestamp": "2026-05-19", "created": "...", "updated": "..." }
```
- `title` 冗余到 `title` 列（列表查询/排序）。
- **`sources`/`images` 列同步**：migration 003 加了 `sources`/`images` JSONB 列。frontmatter JSONB 存完整解析结果；`sources`/`images` 列作规范化列，**写入（POST/PUT/ingest/导入）时从 frontmatter 同步填充**；**读取（GET/列表）统一从分列取**（不查 frontmatter JSONB）——这正是分列的意义（查询/过滤用规范化列）。
- **`page_type` 列同步**：migration 003 加了 `page_type VARCHAR(50)`。写入时从 `frontmatter.type` 同步填充；若 type 缺失取列默认值 `'concept'`（migration 003 DEFAULT）。GET `?type=concept` 查询用 `page_type` 列过滤。
- 丢失原始格式（注释/顺序/空行）——权衡：查询便利 > 格式保真（wiki_pages 是结构化存储，非文件镜像）。

---

## 4. Section 2：ingest（服务端全套 + 异步队列）

### 4.1 流程

```
① 上传源文档 → POST /files/:pid/upload（现有 files API，写 storage）
② POST /projects/:pid/ingest {source_paths[]} → 入 redis 队列，返回 {job_id}
③ Worker（Rust 后台 task，消费 redis 队列）：
   - 读 storage 源文档（source_paths）
   - 解析（**pdf/docx/xlsx/pptx → 文本**，覆盖主流格式，对齐 §4.3；抽桌面 src-tauri 解析逻辑成 crate 复用；.doc/odt/ods 按需后续）
   - **图片提取（MVP）**：PDF → 提取图片存 storage/media/（对齐桌面 `extractAndSaveSourceImages`）；多模态 caption（image-caption-pipeline）后续补
   - **缓存**：源文档分析结果按 content hash 缓存（可跨 project 复用，避免重复 LLM 烧 token，对齐桌面 `ingest-cache`）。存 redis（`ingest:cache:{content_hash}` → Step 1 分析 JSON，TTL 按需）；`ingested_files` 表（migration 001，UNIQUE project_id+original_path）记录摄取历史供去重
   - **长文档分块**：> context budget 时拆 chunk 分批分析 → global digest → 合并（对齐桌面 ingest；具体 prompt 见实施 plan）
   - LLM 两步（调 llm_providers 配置的 provider；Rust HTTP+SSE，等价桌面 streamChat）
     · Step 1 分析：源 → 结构化分析（实体/概念/连接/矛盾）
     · Step 2 生成：分析 → wiki 页面（concept/entity + frontmatter）
     · （**MVP 暂不含 review stage**——桌面 ingest 在 Step 2 后有 LLM 一致性 review，多用户 web 更有价值但 MVP 先跳过，后续补）
   - 写 wiki_pages（新 concept/entity）+ 更新 index.md/log.md/overview.md（reserved pages）
④ 进度写 redis（job_id → {status, stage, progress, error}），前端 GET /ingest/jobs/:id 轮询
```

### 4.2 LLM

- src-server Rust 调 provider，**MVP 只支持 OpenAI + Anthropic**（覆盖 ~90% 场景，降协议对齐风险；Google/Ollama/Azure/CLI 后续迭代）。
- 多 provider SSE 协议差异需 `StreamChatProvider` trait + per-provider impl（OpenAI 标准 SSE / Anthropic `event:` content block delta 需 state machine 重建 token / Google 非 SSE）。**MVP 只做 OpenAI + Anthropic** 降低首版风险。
- key/endpoint 从 `llm_providers` 表（**per-project**——`002_add_llm_providers.sql`：`project_id REFERENCES projects`，无 user_id/team_id；多 project 各自配 provider）。
- `api_key_encrypted` 解密：复用现有 src-server `llm.rs`（JWT secret 派生 32 字节 key + AES-256-GCM）。
- 无 CORS（服务端调）。

### 4.3 文档解析

- pdf/docx/xlsx/pptx Rust 解析——抽桌面 `src-tauri/src/commands/fs.rs` 的解析逻辑（pdf-extract/docx-rs/calamine）成独立 crate，src-server 依赖复用。
- `.md` 直接读（无需解析）。

### 4.4 产出

- 新 wiki_pages（concept/entity，path=`concepts/foo.md`/`entities/bar.md`）。
- 更新 reserved pages：`index.md`（目录）、`log.md`（摄取日志）、`overview.md`（总览）——也作 wiki_pages（path=`index.md` 等）。**从 scratch 重建**（对齐桌面 `updateReservedPages`）：index.md 遍历 wiki_pages 生成目录、log.md 重建所有摄取条目（按 created_at 排序）、overview.md 重建总览。reserved pages per-project（`UNIQUE(project_id, path)` 隐含），不同 project 互不影响。
- **reserved pages 并发锁**：多用户/多 worker 并发 ingest 更新同一 log.md/index.md 竞态 → **读写 reserved pages 时 `SELECT ... FOR UPDATE` 行锁**（读取即加锁，同一事务内写回，避免读-改-写覆盖；即使 MVP 单 worker 也应加，为多 worker 预留）。

### 4.5 异步队列

- redis 队列（list，LPUSH/BRPOP），job_id（UUID）。
- worker **串行**处理（对齐桌面 ingest-queue 串行 + 崩溃恢复）。**失败不自动重试（MVP）**：worker panic / LLM 超时 → job 标记 failed（人类介入）；下次启动 BRPOP 取回重试（幂等：分析结果已缓存则复用）。后续多 worker 引入 retryCount。
- 进度：redis hash（job_id → status/stage/progress）。
- 前端：`GET /ingest/jobs/:id` 轮询（SSE 后续）。

---

## 5. Section 3：导入脚本（一次性，迁移 English/Invest）

### 5.1 流程

脚本（Rust binary `import-wiki`，或 tsx 脚本，连 pg 5433）：
```
① 参数：<wiki_dir> <project_name> <user_id>
② 建 project 记录（name, team_id=user 的 team, storage_path=<wiki_dir>）
③ 遍历 <wiki_dir>/wiki/**/*.md（English 586 / Invest 221）
④ 每文件：
   - path = 相对 <wiki_dir>/wiki（去 wiki/ 前缀，如 concepts/foo.md）
   - 解析 frontmatter（**serde_yaml 完整解析**，对齐桌面 `src/lib/frontmatter.ts` 的 js-yaml + wikilink-list repair；**不用** okf-convert 的简单行遍历——后者丢多行 YAML 块如 `sources:` 列表）+ body
   - title = frontmatter.title 或 H1 或 basename
   - INSERT wiki_pages（project_id, path, title, content=body, frontmatter JSONB）
   - ON CONFLICT (project_id, path) DO UPDATE（幂等，重跑可）
⑤ reserved（index.md/log.md/overview.md）也导入（path 相对 wiki）——它们是 wiki 内容
```

### 5.2 输出

- wiki_pages 填充（English 586 + Invest 221）。
- 可 `GET /projects/:pid/pages` 查询。
- 后续 search/graph 有数据可用。

---

## 6. 决策记录

| # | 决策 | 选择 | 理由 |
|---|------|------|------|
| 1 | path 语义 | 相对 wiki root（无 `wiki/` 前缀） | 对齐 OKF 导出 + wiki-graph |
| 2 | frontmatter | JSONB 解析后 | 查询便利 > 格式保真 |
| 3 | reserved 导入 | 含 index.md/log.md | 它们是 wiki 内容 |
| 4 | 注册 team | 自动建 personal team | 解决"注册后无 team" |
| 5 | ingest LLM | 服务端全套（Rust） | 无 CORS + key 集中 + 多用户 |
| 6 | ingest 源 | 上传 storage | web 标准 |
| 7 | ingest 异步 | redis 队列 | 长任务 + 多用户 + 复用 redis |
| 8 | 导入 | 一次性脚本 | 迁移现有最快 |

---

## 7. 依赖与顺序

- **Section 1**（CRUD + team 前置）是基础。
- **Section 3**（导入脚本）用 Section 1 schema 直接 INSERT——MVP 立刻能在 src-server 看到数据。
- **Section 2**（ingest）写 Section 1 的 wiki_pages——工作量最大，最后。

**MVP 顺序**：1 → 3（导入现有，立刻见效）→ 2（新摄取）。

---

## 8. 风险

### 8.1 文档解析抽 crate（两块独立）

- **crate 编写（~2-3 天）**：`fs.rs` 的 `extract_pdf_text`/`extract_office_text`/`extract_spreadsheet`/`extract_pptx_markdown` 等是**纯同步函数**（操作 `&str`/`Path`/`Vec<u8>`，不依赖 Tauri），抽 crate 本身不难。需内置：① **pdfium 线程安全**（桌面用 `std::sync::Mutex` 全局 `PDFIUM_LOCK` 串行化，PDFium C 库不支持跨线程并发；crate 内置锁，不留 src-server 侧）；② **缓存解耦**（桌面 `read_cache`/`write_cache` 与 Tauri FS 绑定，crate 只暴露纯解析接口，缓存由调用方实现）；③ **office_oxide（.doc）**：API 无状态可直接用，或砍掉（docx-rs+calamine 已覆盖，如不需 .doc 遗留格式）。
- **部署分发（额外 ~1-2 天）**：pdfium 动态库（libpdfium.dylib/pdfium.dll）桌面嵌 Tauri bundle，src-server 需替代——系统安装（`apt install libpdfium-dev`）或 Docker 镜像捆绑。增加 Dockerfile + CI 复杂度。
- **总计 ~4-5 天**，crate 与部署是两个独立问题。

### 8.2 LLM Rust 流式客户端

- **协议对齐（核心难度）**：多 provider SSE 格式差异（OpenAI `data:` / Anthropic `event:` content block delta 需 state machine 重建 token / Google 非 SSE 单 `\n` 分隔 / Ollama 类 OpenAI / Azure +api-version / CLI 子进程 stdout）。Rust 需 `StreamChatProvider` trait + per-provider impl，否则代码臃肿。**MVP 只做 OpenAI + Anthropic**（§4.2）降首版风险。
- **api_key_encrypted 解密**：复用 src-server `llm.rs`（JWT secret 派生 + AES-256-GCM）。

### 8.3 其他

- **ingest-queue 持久化**：桌面文件持久化，src-server 用 redis（需 AOF/RDB 持久化配置，避免重启丢队列）。
- **多用户并发 ingest**：单 worker 串行 → 排队；reserved pages 行锁（§4.4）；后续多 worker + 项目级锁。
