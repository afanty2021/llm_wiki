# Layer 5: 前端 Web 适配 设计

> **状态**: 设计已完成,待 review → writing-plans
> **日期**: 2026-06-23
> **范围**: 让前端脱离 Tauri 桌面壳,在纯浏览器中运行(协作消费场景),src-server 同源托管

---

## 1. 背景与目标

llm_wiki 是 React 19 + Tauri v2 (Rust) 桌面应用,前端长期绑定 Tauri 壳。Layer 1-4 已在 `src-server/`(axum/PostgreSQL/redis)建成完整多用户后端(auth/team/project 权限/chat/review/research/provider team 维度)。Layer 5 让前端在**纯浏览器**中可用,使 Layer 4 的多用户权限产生实际协作价值。

**目标**: 同一份前端代码 → 同一份 `dist/` → 桌面版(Tauri 壳,全能力) + web 版(src-server 托管,降级运行)。

**非目标**: 不做移动端适配;不做离线/PWA;不替换桌面版为本设计的产物。

---

## 2. 现状摸查(关键发现)

### 2.1 已就绪(基础好)

| 能力 | 证据 |
|------|------|
| HTTP 客户端 | `src/lib/api-client.ts` — auth/users/teams/projects/files/search/graph/chat(SSE) + token 自动刷新(401→refresh) |
| 基础文件 HTTP 分支 | `src/commands/fs.ts:8` `USE_HTTP` — readFile/writeFile/listDirectory/deleteFile/createDirectory 5 个 |
| ingest 核心 HTTP 化 | `src/lib/ingest.ts` 走 `fs.ts` + `streamChat`,路径已 HTTP |
| 环境探测 | `src/main.tsx:21`、`src/lib/theme.ts:17` 已有 `isTauri`/`isTauriRuntime` |
| CORS 中间件 | `src-server/src/middleware/cors.rs` — `allow_credentials(true)`(白名单 origins);`*` 时禁用 credentials |
| 向量库 | **pgvector**(非 LanceDB) — `migrations/005`,`embeddings.content VECTOR(1024)` HNSW,无文件锁,多用户并发安全 |
| 文件存储 | 服务器磁盘 `{storage_path}/teams/{team_id}/projects/{project_id}/`,`storage::safe_resolve` 防路径遍历 |
| 上传端点 | `POST /api/v1/files/:project_id/upload`(multipart,100MB 上限)— `routes/files.rs:38` |
| ingest worker | Redis `ingest:queue` + PG `ingest_jobs`,worker `tokio::fs::read(&full_path)` 吃**相对路径** — `ingest_pipeline.rs:485` |

### 2.2 缺口(本层补齐)

- `fs.ts` 另 ~17 个函数仍走 `invoke`(无 HTTP 分支)
- 桌面专属:`dialog`/`convertFileSrc`/`autostart`/clip-watcher/CLI/file-watcher/窗口主题 — web 不可用
- **前端 LLM 通路全走 `@/lib/llm-client` 直连 provider**(10 处:chat-panel/lint/ingest/dedup/vision/enrich/deep-research 等),用 `tauri-fetch`(`@tauri-apps/plugin-http`)绕 CORS;`apiClient.streamChat`(服务器代理)**未被任何代码调用**
- src-server `chat.rs` 是 **OpenAI-compatible 代理**(硬编码 `/chat/completions`、`choices[0]`),不支持 Anthropic/Gemini native 格式
- 无 web 专用构建脚本;`npm run build` 产纯静态 `dist/` 但无 SPA 托管配置
- 无二进制文件端点(`read_file` 对图片走 `read_to_string`,二进制乱码)

### 2.3 web 摄取链路几乎就绪

upload 端点 ✅ → 服务器落盘 ✅ → ingest worker 吃路径 ✅ → pgvector ✅。**web 摄取 = 前端补 UI + 调现有端点,后端零改动**。

---

## 3. 核心决策(已与用户确认)

| 决策 | 选择 | 理由 |
|------|------|------|
| **范围** | 协作消费为主 | 浏览/搜索/图谱/chat/review/research + 上传摄取 + 多用户协作;砍 CLI/file-watcher/clip-watcher/autostart |
| **部署** | 同源:src-server 托管 | ServeDir 挂 dist/ 到 `/`,API 在 `/api/v1/*`,SPA fallback;零 CORS,单进程 |
| **降级模式** | 运行时 capabilities + 单产物 | `caps` 对象统一判断,一套代码一份 dist,桌面零回归 |
| **LLM 通路** | C:服务器代理 + 统一抽象 | web 走 src-server(OpenAI-compatible),`streamChat` 按 caps 分发,调用点零改动 |

---

## 4. 整体架构

### 4.1 capabilities 抽象(地基)

新增 `src/lib/capabilities.ts` — 桌面 vs web 的**唯一判断源**,取代散落的 `isTauri`/`USE_HTTP`:

```ts
export interface Capabilities {
  platform: 'tauri' | 'web';
  canPickFiles: boolean;      // 选文件:桌面=tauri dialog;web=<input type=file>+拖拽(降级可用)
  canAccessFs: boolean;       // 文件读写:两者皆 true(HTTP)
  canWatchClipboard: boolean; // clip-watcher:桌面 only
  canAutoStart: boolean;      // 开机自启:桌面 only
  canRunCli: boolean;         // Claude/Codex CLI:桌面 only
  canWatchFiles: boolean;     // file-watcher 本地同步:桌面 only
  canShowNotif: boolean;      // 通知:桌面=tauri notif;web=Notification API
}

const isTauri = '__TAURI_INTERNALS__' in window || '__TAURI__' in window;

export const caps: Capabilities = isTauri
  ? { platform:'tauri', canPickFiles:true, canAccessFs:true, canWatchClipboard:true,
      canAutoStart:true, canRunCli:true, canWatchFiles:true, canShowNotif:true }
  : { platform:'web', canPickFiles:true, canAccessFs:true, canWatchClipboard:false,
      canAutoStart:false, canRunCli:false, canWatchFiles:false,
      canShowNotif: typeof Notification !== 'undefined' };
```

**使用**: `if (caps.canWatchClipboard) startClipWatcher()` / `{caps.canRunCli && <CliPanel/>}`

**收敛**: `main.tsx`/`theme.ts`/`fs.ts` 散落的 `isTauri`/`isTauriRuntime`/`USE_HTTP` 统一迁到 `caps`(`USE_HTTP` 保留作构建期默认,运行时以 `caps.platform === 'web'` 为准)。

### 4.2 单产物模型

同一份 `dist/`。桌面版 Tauri 壳加载(`isTauri=true`,全能力);web 版 src-server `ServeDir` 托管(`isTauri=false`,降级)。`@tauri-apps/*` 在浏览器**静态 import 安全**(模块仅定义函数,调用 `invoke` 才 throw);`caps` 保证 web 运行时永不调用它们。

---

## 5. fs.ts 适配层补全

**核心判断**: web 版不跑前端 `ingest.ts` 本地两步摄取(依赖绝对路径 + copy/preprocess),改走 upload→worker(§7)。故 fs.ts 函数按"是否属本地摄取链"二分:

| 函数 | web 处置 |
|------|---------|
| readFile/writeFile/listDirectory/deleteFile/createDirectory/writeFileAtomic | ✅ 已有 HTTP 分支 |
| **fileExists / getFileSize / getFileModifiedTime** | 🔧 补 HTTP(新 **stat** 端点;消费功能如 export 仍需要) |
| getFileMd5/readFileAsBase64/copyFile/copyDirectory/preprocessFile/findRelatedWikiPages/writeFileBase64 | ❌ **unsupported**:web throw `"xxx is desktop-only"`(仅本地摄取链用) |
| openProject | ⚠️ web 不用(项目加载走 `apiClient.listProjects`,§9) |
| openProjectFolder/clipServerStatus/apiServerStatus/apiServerReloadConfig/mcpServerEntryPath | 🚫 `caps` gate 隐藏调用方 UI |

**后端 targeted 改进(1 端点)**:
```
GET /api/v1/files/:project_id/stat/*path → { exists, is_dir, size, modified }
```
复用 `check_project_access` + `storage::safe_resolve`。一次解决 fileExists/getFileSize/getFileModifiedTime 三个(避免 3 个零散端点 + 往返)。

**`USE_HTTP` 统一**: fs.ts `const USE_HTTP = ...` → `caps.platform === 'web'`,所有 `if (USE_HTTP)` 语义不变。

**安全网**: unsupported 函数 web 下显式 throw(不静默),配合 §8 caps gate 隐藏入口,遗漏调用点立即暴露。

---

## 6. LLM 通路架构(本层最关键)

### 6.1 现状鸿沟

| | 桌面版 | src-server |
|---|---|---|
| LLM 通路 | 前端直连 provider(`llm-client` + `tauri-fetch` 绕 CORS) | 服务器代理(`chat.rs`),前端未用 |
| provider 格式 | 多 native(`llm-providers.ts`:OpenAI/Anthropic/Gemini/Azure/custom) | OpenAI-compatible only |
| 调用方 | chat/lint/review/research/ingest/dedup/vision/enrich 等 10 处(前端直连) | chat/chat_sessions 路由 + research/review/ingest worker(`services::llm` + `llm_stream` 多处调用,已验证) |

### 6.2 web 约束

浏览器**不能**前端直连 LLM provider:① CORS(厂商不允许浏览器带 key fetch)② key 安全(team key 进前端 bundle,成员可见)。→ web 版所有 LLM 必须走 src-server 代理。

### 6.3 方案 C:服务器代理 + 统一抽象

**web 版 LLM 功能 = chat + review + research**(src-server 都有端点/worker)。`lint`/`dedup`/`vision-caption`/`enrich-wikilinks`/`ingest` 内的 LLM 是**摄取增强**,web 摄取走 worker(§7),前端不跑。

**统一 `streamChat` 抽象**(关键): `llm-client.ts` 入口按 `caps` 分发:
```ts
export async function streamChat(config, messages, callbacks, signal?, overrides?) {
  if (caps.platform === 'web') return streamViaServer(config, messages, callbacks, signal, overrides);
  // ...现有桌面直连逻辑
}
```
新增 `streamViaServer`:用 `fetch(POST /api/v1/chat/stream, { Authorization: Bearer <token>, body: JSON })` + `response.body.getReader()` 逐行解析 SSE 喂给 `StreamCallbacks`(onToken/onReasoning/onDone/onError),reasoning 解析复用 `reasoning-detector.ts`。**不复用 `apiClient` 现有 EventSource 实现**——浏览器 EventSource 无法设 Authorization header(`require_auth` 仅认 header,middleware/auth.rs:12-15 → 鉴权失败)且只能 GET(chat 端点 POST,routes/chat.rs:26,EventSource 撞不上);现有 EventSource 实现本就未接通。

⚠️ **chat.rs 双层 SSE 陷阱(需后端配套改造)**: 现状 chat.rs:175-178 把 reqwest 每个原始字节块包进 axum `Event::data(...)`,而 axum 0.7 的 `Event::data` 按 `\n` 拆行逐行加 `data:` 前缀 → 客户端收到双层 `data: data: {"choices":...}`(axum-SSE 包裹原始 OpenAI-SSE),**无法直接套用桌面版单层 `parseLines`+`parseStream`**。**修正:改 chat.rs 直通原始字节**(去 `Event::data` 包裹,response body 直接 = reqwest `bytes_stream()`,`Content-Type: text/event-stream`)→ 客户端收到标准单层 OpenAI SSE → streamViaServer 真正复用 `llm-client.ts` 的 `parseLines`/reader/`parseStream`(桌面版即 fetch+reader,改后同构)。这是 chat 通路可行的必要前置(纯前端两层解帧会因 axum 按 \n 拆分破坏 chunk 边界,不可靠)。

**research `stream_task`(routes/research.rs:128)不同**: 它是 axum 结构化 SSE(自定义 `event: stage`/`data: {json}` 进度事件,非 LLM 流式转发),用标准 SSE 事件解析(按 event 类型),不复用 parseStream。

**10 个调用点零改动**,仅通路内部切换。

**路由已就绪(无需补)**: `reviews`/`chat_sessions`/`pages`/`ingest`/`research` 的 project 嵌套路由(`/:id/...`)已在 `projects.rs::project_routes()`(line 54-58)merge,经 `mod.rs` 的 `/api/v1/projects` nest 挂载。web 可直接调 `/api/v1/projects/:id/reviews`、`/api/v1/projects/:id/ingest`、`/api/v1/projects/:id/research` 等。

**api-client 补全**(新增方法):
- `streamChat` **重写为 fetch-based**(`fetchStream(pid, messages, model, callbacks)`:POST + Authorization header + ReadableStream 解析 SSE → callbacks);现有 EventSource 实现废弃(无法鉴权 + POST-only,本就未接通)
- review: `listReviews(pid)` / `resolveReview(pid,iid,body)` / `dismissReview(pid,iid)`
- research: `enqueueResearch(body)` / `getResearchTask(id)` / `researchStream(id)`(**fetch-based** SSE,GET + Authorization header,非 EventSource)
- `uploadFile(pid, file, dir?)`(multipart) / `statFile(pid, path)`
- `triggerIngest(pid, sourcePaths[])` / `getIngestJob(jobId)`
- llm_providers / search_providers CRUD(Layer 4,settings 页用)

**src-server 既有约束**(非本层引入): LLM 层 OpenAI-compatible(chat/review/research worker 都是)。web 沿用 → team 需配 OpenAI-compatible provider(或厂商兼容端点)。多 native provider 是 src-server 后续增强,不在第 5 层。

---

## 7. web 摄取流程(upload → trigger → poll)

桌面版跑前端 `ingest.ts`(本地两步,绝对路径)。web 不复用,走**服务器 worker**:

1. **选文件**: `<input type=file multiple>` + 拖拽(`canPickFiles` 降级);web 不支持选目录,按文件上传
2. **上传**: 逐个 `apiClient.uploadFile(projectId, file, dir)` → 服务器落盘
3. **触发**: `apiClient.triggerIngest(projectId, sourcePaths[])`(相对路径喂 worker)
4. **轮询**: `apiClient.getIngestJob(jobId)` 轮询状态(SSE 或轮询),UI 显示进度

**服务器零改动**。**路径模型**: web 全程相对项目根路径,不碰桌面绝对路径。桌面版 `ingest.ts` 保留(本地),web 用新组件,`caps` 选入口。

**落地核对**: `triggerIngest`/`getIngestJob` 端点签名对照 `routes/ingest.rs` 实际定义。

---

## 8. 桌面专属功能降级

| 功能 | 调用点 | web 降级 |
|------|--------|---------|
| `dialog` 文件选择 | App.tsx(导入)、摄取 | `canPickFiles`: `<input type=file multiple>` + 拖拽;不支持选目录 |
| `convertFileSrc`(图片预览) | markdown-image-resolver、file-preview | 统一 `fileUrl()` helper:桌面 convertFileSrc;web = fetch `raw` 端点 → blob → `URL.createObjectURL` |
| clip-watcher + clip project fetch | App.tsx(127.0.0.1:19827) | `canWatchClipboard` gate:不启动 |
| autostart | settings-view、App.tsx | `canAutoStart` gate:设置项隐藏 |
| openProjectFolder | file-tree.tsx | gate:按钮隐藏 |
| 主题同步 | theme.ts | 已有 guard(迁 caps) |

**设置页分级**:
- `about-section`(clip/api server status):web 隐藏状态部分
- `api-server-section`(本地 api server 进程管理):**web 整个隐藏**
- `llm-provider-section`:**web 保留**,改走 `apiClient` 管 team `llm_providers`(Layer 4),不复用桌面本地 plugin-store

**后端 targeted 改进(1 端点)**: 补二进制端点(`read_file` 对图片 `read_to_string` 会乱码):
```
GET /api/v1/files/:project_id/raw/*path → 二进制 Response(带 project auth)
```
web 图片/pdf 预览:fetch(Authorization header)→ blob → `<img>`/预览。复用 `check_project_access` + `safe_resolve`。

---

## 9. App 入口 / auth / 项目加载 / provider 模型

桌面版: `openProject(本地路径)` → `ensureProjectId` → 加载。web 完全不同:

**web 启动流程**(`App.tsx` 按 `caps` 分支):
1. `apiClient.loadTokens()` → 无 token 跳**登录页**(`login`/`register`)
2. `getMe` + `getUserTeams` → 选 team
3. `listProjects(teamId)` → 选/建 project(`createProject(name, teamId)`)
4. 选中后设 `window.__currentProjectId`(fs.ts HTTP 分支依赖)+ 拉取 graph/pages
5. 无"本地路径"概念 — `WikiProject.path` 在 web 用服务器相对根或留空

**provider 配置模型差异**:
- 桌面版: 用户级,本地 plugin-store(`llm-providers.ts`)
- web 版: **team 级**,服务器 `llm_providers` 表(Layer 4)
- → web `llm-provider-section` = "管理 team provider"(Admin),与桌面"个人 provider"两套数据源,`caps` 切换

**`ensureProjectId`/`upsertProjectInfo`**(桌面本地 project identity): web 不用 — project id 来自服务器 DB,直接持有。

---

## 10. 部署与构建配置

**src-server 托管静态资源**:
- `Cargo.toml`: `tower-http` 加 `"fs"` feature(现 cors+trace)
- `lib.rs` `create_router` 末尾: `.fallback_service(ServeDir::new(dist_dir).not_found_service(ServeFile::new(index_html)))`
- API(`/api/*`、`/health`)优先匹配,ServeDir 兜底;未命中静态路径 → `index.html`(SPA history fallback)
- `dist_dir`/`index_html` 进 `AppConfig`(默认 `../dist`,可 env 覆盖)

**构建脚本**(`package.json`):
- `"build:web": "VITE_USE_HTTP_API=true vite build"`(纯静态 `dist/`,无 Tauri 壳)
- `.env.production` / build:web 注入: `VITE_USE_HTTP_API=true` + `VITE_API_BASE_URL=`(空 → fetch 相对 `/api/v1/...`,同源)
- ⚠️ **配套修正 `api-client.ts:6`**: 现状 `const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:8080"` 的 `||` 对空串(同源部署)falsy 回退到 `localhost:8080`,破坏同源。改 `??`(nullish coalescing)或默认空串:`import.meta.env.VITE_API_BASE_URL ?? ""`,空值才真正相对 fetch

**部署流程**: `npm run build:web` → `dist/` → src-server `dist_dir` 指向 → 单进程同源(零 CORS)。开发期保留 `vite dev`(1420) + src-server(8080) 跨域 + CORS 白名单 `localhost:1420`。

**静态缓存**: hashed `/assets/*` 长缓存,`index.html` 不缓存。

---

## 11. 测试策略

**前端(vitest)**:
- `capabilities`: detect 在 tauri/web/node 各环境
- `fs.ts` HTTP 分支: stat/upload 走 apiClient;unsupported 函数 web 下 throw
- `streamChat` 统一抽象: caps 分发 + fetch+ReadableStream SSE 解析(mock fetch reader,非 EventSource)
- 降级 UI: caps gate 隐藏(clip/autostart/api-server section)
- App web 入口: 登录→team→project 流程

**src-server(cargo test)**:
- `stat` 端点、`raw` 二进制端点(图片/pdf)
- 路由验证: reviews/chat_sessions/pages/ingest/research 端点实际可访问(已挂载于 projects nest,§6.3)
- ServeDir fallback(SPA index.html,API 不被拦截)

**e2e(手工)**: 浏览器跑 `build:web` + src-server → 登录→建 team/project→上传摄取→浏览/搜索/图谱→chat→review→research 全链路。

---

## 12. 工作量与里程碑

| 工作块 | 侧 | 规模 |
|--------|-----|------|
| capabilities 抽象 + 收敛散落判断 | 前端 | 小 |
| fs.ts HTTP 补全 + stat 端点 | 前+后 | 小 |
| LLM 统一 streamChat 抽象 + streamViaServer + chat.rs 直通改造 | 前+后 | 中 |
| api-client 补全(review/research/upload/stat/ingest/provider) | 前端 | 中 |
| web 摄取组件(upload-trigger-poll) | 前端 | 中 |
| 桌面降级(dialog/图片 raw 端点/设置页 gate) | 前+后 | 中 |
| App web 入口(auth→team→project) | 前端 | 中 |
| 部署(ServeDir + build:web + .env) | 前+后 | 小 |

**建议拆分**: 本层可分两期 —
- **期 1(地基 + 通路)**: capabilities + fs.ts + LLM 抽象(fetch-based 流式) + api-client 补全 + 部署 ServeDir → web 能登录、浏览、chat
- **期 2(摄取 + 降级完整)**: web 摄取组件 + 桌面降级(raw 端点/设置页 gate) + App 入口 → 全链路

---

## 13. 风险与边界

- **OpenAI-compatible 限制**: web chat/review/research 仅支持 OpenAI-compatible provider;team 配 Anthropic/Gemini native 时 web 不可用(需用兼容端点)。文档明确告知。
- **web 不跑的功能**: CLI(file-watcher/clip-watcher/autostart/Claude-Codex CLI)、前端摄取增强(lint/dedup/vision/enrich)。这些在 web 通过 caps gate 隐藏,非 bug。
- **目录选择**: web 无可靠目录选择,摄取按文件上传(批量)。
- **图片鉴权**: web 图片走 fetch+blob(带 token),非直接 `<img src>`(浏览器无法带 Authorization header)。
- **SSE 流式鉴权(关键)**: 浏览器 EventSource 同样无法设 Authorization header(`require_auth` 仅认 header → 鉴权失败),且 chat 端点为 POST(EventSource 只能 GET)。故 web 所有 SSE 流式(chat/research)统一用 **fetch+ReadableStream 手动解析**,**不复用 EventSource**(与图片同类限制,详见 §6.3)。这是 web LLM 通路可行性的前提——按 EventSource 实现会导致 web chat/research 完全不可用。
- **桌面版零回归**: 单产物模型下桌面版行为不变(所有 caps 在 tauri=true 全开);关键是 web 分支不污染桌面路径。

---

## 参考

- 现状证据见各节"证据"列(文件:行号)
- 关联 memory: `layer4-phasec-plan-ready`(Layer 3/4 已 ship main)、`cargo-p-package-name-gotcha`、`axum-routing-syntax-gotcha`
- 后续: writing-plans 基于本 spec 生成实现计划
