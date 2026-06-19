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

REST，权限 = project 的 team member（`team_members` 校验）：
```
GET    /projects/:pid/pages            列表（?type=concept&?q=标题/路径模糊）
GET    /projects/:pid/pages/:path      单个（path URL-encoded，如 concepts%2Ffoo.md）
POST   /projects/:pid/pages            {path, title, content, frontmatter} → 201
PUT    /projects/:pid/pages/:path      更新 content/frontmatter
DELETE /projects/:pid/pages/:path      删除
```
- `:path` 含 `/`，需 URL-encoded。
- `UNIQUE(project_id, path)` 冲突 → POST 409。

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
- 丢失原始格式（注释/顺序/空行）——权衡：查询便利 > 格式保真（wiki_pages 是结构化存储，非文件镜像）。

---

## 4. Section 2：ingest（服务端全套 + 异步队列）

### 4.1 流程

```
① 上传源文档 → POST /files/:pid/upload（现有 files API，写 storage）
② POST /projects/:pid/ingest {source_paths[]} → 入 redis 队列，返回 {job_id}
③ Worker（Rust 后台 task，消费 redis 队列）：
   - 读 storage 源文档（source_paths）
   - 解析（pdf/docx/xlsx → 文本；抽桌面 src-tauri 解析逻辑成 crate 复用）
   - LLM 两步（调 llm_providers 配置的 provider；Rust HTTP+SSE，等价桌面 streamChat）
     · Step 1 分析：源 → 结构化分析（实体/概念/连接/矛盾）
     · Step 2 生成：分析 → wiki 页面（concept/entity + frontmatter）
   - 写 wiki_pages（新 concept/entity）+ 更新 index.md/log.md/overview.md（reserved pages）
④ 进度写 redis（job_id → {status, stage, progress, error}），前端 GET /ingest/jobs/:id 轮询
```

### 4.2 LLM

- src-server Rust 调 provider（OpenAI/Anthropic/Google/Ollama 等，HTTP+SSE 流式）。
- key/endpoint 从 `llm_providers` 表（per-user/team，现有 schema）。
- 无 CORS（服务端调）。

### 4.3 文档解析

- pdf/docx/xlsx/pptx Rust 解析——抽桌面 `src-tauri/src/commands/fs.rs` 的解析逻辑（pdf-extract/docx-rs/calamine）成独立 crate，src-server 依赖复用。
- `.md` 直接读（无需解析）。

### 4.4 产出

- 新 wiki_pages（concept/entity，path=`concepts/foo.md`/`entities/bar.md`）。
- 更新 reserved pages：`index.md`（目录）、`log.md`（摄取日志）、`overview.md`（总览）——也作 wiki_pages（path=`index.md` 等）。

### 4.5 异步队列

- redis 队列（list，LPUSH/BRPOP），job_id（UUID）。
- worker **串行**处理（对齐桌面 ingest-queue 串行 + 崩溃恢复）。
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
   - 解析 frontmatter（YAML-ish，复用桌面 okf-convert parseFields 思路）+ body
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

- **文档解析抽 crate**：桌面 src-tauri 解析逻辑可能耦合 Tauri/FS，抽 crate 需解耦。评估工作量。
- **LLM Rust 客户端**：桌面 streamChat 是 TS（fetch+SSE），Rust 重写 LLM 流式（reqwest + eventsource）需对齐 provider 协议（OpenAI/Anthropic SSE 格式差异）。
- **ingest-queue 持久化**：桌面用文件持久化队列，src-server 用 redis（需 redis 持久化配置 / AOF，避免重启丢队列）。
- **frontmatter 解析一致性**：桌面 YAML-ish 解析（不引 YAML 库），脚本/服务端需一致（抽共用 parser）。
- **多用户并发 ingest**：单 worker 串行 → 多用户排队。后续多 worker + 项目级锁。
