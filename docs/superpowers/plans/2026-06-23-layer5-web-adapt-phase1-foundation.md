# Layer 5 期1: 前端 Web 适配地基 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让前端在纯浏览器跑起来——capabilities 运行时降级、fs.ts/api-client HTTP 通路补全、LLM 流式改 fetch+ReadableStream(含 chat.rs 直通改造)、src-server 同源 ServeDir 托管,使 web 版能登录→选 team/project→浏览(graph/pages/search)→chat。

**Architecture:** 单产物 dist,caps 运行时探测分发(桌面=直连 provider 全能力 / web=服务器代理降级)。web LLM 走 src-server `POST /api/v1/chat/stream`(fetch POST + Authorization header + ReadableStream,**不复用 EventSource**——无法鉴权且端点 POST-only);chat.rs 改直通原始字节(去 axum Event::data 双层包裹),客户端复用桌面版 `parseLines`/`parseStream`。src-server ServeDir 托管 dist + SPA fallback,API 路由优先匹配。

**Tech Stack:** React 19 + TypeScript + vitest(前端);axum 0.7 + tower-http 0.5(ServeDir) + sqlx + reqwest(后端)。

**对应 spec:** `docs/superpowers/specs/2026-06-23-layer5-web-adapt-design.md`(commit b051953)。本期覆盖 spec §4/§5/§6/§10 + §9 最小入口;§7 摄取/§8 桌面降级/raw 端点留期2。

**工作约定:** 简体中文注释;前端测试 `npm test`(vitest);后端测试 `cd src-server && cargo test`(省略 `-p`,参见 [[cargo-p-package-name-gotcha]]);未经用户批准不 commit/push。分支 `feat/layer5-web-adapt`。

---

## File Structure

**新建:**
- `src/lib/capabilities.ts` — caps 运行时探测(桌面 vs web 唯一判断源)
- `.env.web` — web 专属构建环境(`vite build --mode web` 加载,与桌面 production 隔离)

**修改(前端):**
- `src/commands/fs.ts` — `USE_HTTP`→`caps`;stat HTTP 分支;unsupported throw
- `src/lib/api-client.ts` — `||`→`??`;`fetchStream`(fetch-based SSE);补全 stat/upload/review/research/ingest/provider 方法
- `src/lib/api-types.ts` — Layer 3/4 响应类型(Review/Research/IngestJob/LlmProvider/SearchProvider)
- `src/lib/llm-client.ts` — `streamChat` caps 分发 + `streamViaServer`
- `src/main.tsx` / `src/lib/theme.ts` — 散落 `isTauri`→`caps`
- `src/App.tsx` — web 最小入口分支(登录→选 team/project→设 `__currentProjectId`)
- `package.json` — `build:web` 脚本

**修改(后端):**
- `src-server/src/routes/files.rs` — `GET /:project_id/stat/*path` 端点
- `src-server/src/routes/chat.rs` — `chat_stream` 直通原始字节(去 `Event::data`)
- `src-server/src/routes/mod.rs` — ServeDir fallback
- `src-server/src/config.rs` — `FrontendConfig`(dist_dir/index_html)
- `src-server/Cargo.toml` — tower-http `fs` feature

---

## Task 1: capabilities 运行时探测

**Files:**
- Create: `src/lib/capabilities.ts`
- Test: `src/lib/capabilities.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// src/lib/capabilities.test.ts
import { describe, it, expect, vi, afterEach } from "vitest"
import { detect, type Capabilities } from "./capabilities"

describe("capabilities detect", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("returns web when no __TAURI__ marker", () => {
    vi.stubGlobal("window", {})
    vi.stubGlobal("Notification", function Notification() {})
    const c = detect()
    expect(c.platform).toBe("web")
    expect(c.canWatchClipboard).toBe(false)
    expect(c.canAutoStart).toBe(false)
    expect(c.canRunCli).toBe(false)
    expect(c.canWatchFiles).toBe(false)
    expect(c.canPickFiles).toBe(true)
    expect(c.canAccessFs).toBe(true)
    expect(c.canShowNotif).toBe(true)
  })

  it("returns tauri when __TAURI_INTERNALS__ present", () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} })
    const c = detect()
    expect(c.platform).toBe("tauri")
    expect(c.canRunCli).toBe(true)
    expect(c.canWatchClipboard).toBe(true)
  })

  it("canShowNotif=false when Notification undefined", () => {
    vi.stubGlobal("window", {})
    vi.stubGlobal("Notification", undefined)
    const c = detect()
    expect(c.canShowNotif).toBe(false)
  })

  it("caps constant matches detect in current (test=web) env", async () => {
    const { caps } = await import("./capabilities")
    const c: Capabilities = caps
    expect(c.platform).toBe("web")
  })
})
```

- [ ] **Step 2: 验证失败**

Run: `npm test -- capabilities.test`
Expected: FAIL "Cannot find module './capabilities'"

- [ ] **Step 3: 实现**

```ts
// src/lib/capabilities.ts
/**
 * 运行时能力探测:桌面(Tauri 壳) vs web(纯浏览器)的唯一判断源。
 * 取代散落在 main.tsx/theme.ts/fs.ts 的 isTauri/USE_HTTP 判断。
 * 桌面版所有能力开启、行为零变化;web 版按能力降级。
 */
export interface Capabilities {
  platform: "tauri" | "web"
  /** 选文件/目录:桌面=tauri dialog;web=<input type=file>+拖拽(降级可用) */
  canPickFiles: boolean
  /** 文件读写:两者皆 true(web 走 HTTP) */
  canAccessFs: boolean
  /** clip-watcher 轮询本地 clip server:桌面 only */
  canWatchClipboard: boolean
  /** 开机自启:桌面 only */
  canAutoStart: boolean
  /** Claude/Codex CLI 本地进程:桌面 only */
  canRunCli: boolean
  /** file-watcher 本地同步:桌面 only */
  canWatchFiles: boolean
  /** 系统通知:桌面=tauri notif;web=Notification API */
  canShowNotif: boolean
}

export function detect(): Capabilities {
  const isTauri =
    typeof window !== "undefined" &&
    ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)
  if (isTauri) {
    return {
      platform: "tauri",
      canPickFiles: true,
      canAccessFs: true,
      canWatchClipboard: true,
      canAutoStart: true,
      canRunCli: true,
      canWatchFiles: true,
      canShowNotif: true,
    }
  }
  return {
    platform: "web",
    canPickFiles: true,
    canAccessFs: true,
    canWatchClipboard: false,
    canAutoStart: false,
    canRunCli: false,
    canWatchFiles: false,
    canShowNotif: typeof Notification !== "undefined",
  }
}

/** 模块级单例,启动时探测一次。 */
export const caps: Capabilities = detect()
```

- [ ] **Step 4: 验证通过**

Run: `npm test -- capabilities.test`
Expected: PASS(4 tests)

- [ ] **Step 5: 提交**

```bash
git add src/lib/capabilities.ts src/lib/capabilities.test.ts
git commit -m "feat(layer5): capabilities 运行时探测(桌面/web 唯一判断源)"
```

---

## Task 2: api-client `||`→`??` 修正(同源部署前提)

**Files:**
- Modify: `src/lib/api-client.ts:6`
- Test: `src/lib/api-client.test.ts`(新建,若不存在)

- [ ] **Step 1: 写失败测试**

```ts
// src/lib/api-client.test.ts
import { describe, it, expect } from "vitest"

describe("api-client resolveApiBase", () => {
  it("undefined→localhost:8080(桌面无 env 默认连 src-server)", async () => {
    const { resolveApiBase } = await import("./api-client")
    expect(resolveApiBase(undefined)).toBe("http://localhost:8080")
  })
  it("空串→空串(web 同源,?? 不回退 localhost)", async () => {
    const { resolveApiBase } = await import("./api-client")
    expect(resolveApiBase("")).toBe("")
  })
  it("显式值→显式值", async () => {
    const { resolveApiBase } = await import("./api-client")
    expect(resolveApiBase("http://host:9")).toBe("http://host:9")
  })
})
```

- [ ] **Step 2: 验证失败**

Run: `npm test -- api-client.test`
Expected: FAIL "resolveApiBase is not a function"

- [ ] **Step 3: 实现**

修改 `src/lib/api-client.ts`——把第 6 行:
```ts
const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:8080"
```
改为(提取纯函数 `resolveApiBase`,**默认值保留 localhost:8080**,仅 `||`→`??`):
```ts
/** 解析 API base。?? 而非 ||:空串(web 同源)是合法值,|| 会 falsy 回退 localhost 破坏同源。
 *  undefined(桌面无 env)→ 默认 localhost:8080(连 src-server);""(web 同源)→ 相对 fetch。 */
export function resolveApiBase(envValue: string | undefined): string {
  return envValue ?? "http://localhost:8080"
}
export const API_BASE = resolveApiBase(import.meta.env.VITE_API_BASE_URL)
```
> **关键:默认值仍是 localhost:8080**(桌面开发/生产无 env 时连 src-server:8080),只把 `||` 改 `??` 使**显式空串**(web `.env.web` 置空)不再回退。桌面行为零变化,**无需新建 .env.development**。

- [ ] **Step 4: 验证通过**

Run: `npm test -- api-client.test`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/lib/api-client.ts src/lib/api-client.test.ts
git commit -m "fix(layer5): API_BASE ||→?? 保留桌面默认 localhost:8080,空串同源不回退"
```

---

## Task 3: 后端 stat 端点

**Files:**
- Modify: `src-server/src/routes/files.rs`(加 `stat_file` + 挂路由)
- Modify: `src-server/src/routes/files.rs:25-35`(`file_routes` 加 stat 路由)
- Test: `src-server/tests/integration/files_stat_test.rs`(新建,加入 integration test target)

- [ ] **Step 1: 写失败测试**

```rust
// src-server/tests/integration/files_stat_test.rs
/// files stat 端点集成测试(Layer 5 Task 3)。
/// 复用 ingest_test.rs 的 setup 模式(register→personal team→SQL 查 team_id→POST /projects)。
/// 注册:在 tests/integration/mod.rs 加 `pub mod files_stat_test;`。运行 `cargo test --test integration files_stat`。
use axum::http::StatusCode;
use std::sync::atomic::{AtomicU64, Ordering};

static COUNTER: AtomicU64 = AtomicU64::new(0);

async fn setup() -> (axum_test::TestServer, i32, String) {
    let (app, state) = crate::setup_test_app().await;
    let server = axum_test::TestServer::new(app).unwrap();
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let username = format!("fstat_{}_{}", std::process::id(), n);
    let token = crate::register_user(&server, &username, &format!("{}@t.com", username), "password123").await;
    let team_id: i32 = sqlx::query_scalar(
        "SELECT id FROM teams WHERE created_by = (SELECT id FROM users WHERE username = $1)",
    ).bind(&username).fetch_one(&state.db).await.unwrap();
    let resp = server.post("/api/v1/projects")
        .add_header("authorization", format!("Bearer {}", token))
        .json(&serde_json::json!({"name": format!("fproj-{}-{}", std::process::id(), n), "team_id": team_id}))
        .await;
    assert_eq!(resp.status_code(), StatusCode::CREATED);
    let pid = resp.json::<serde_json::Value>()["id"].as_i64().unwrap() as i32;
    (server, pid, token)
}

#[tokio::test]
async fn stat_returns_exists_size_modified() {
    let (server, pid, token) = setup().await;
    // 先写文件(POST /files/:pid/*path)
    let w = server.post(&format!("/api/v1/files/{}/note.md", pid))
        .add_header("authorization", format!("Bearer {}", token))
        .json(&serde_json::json!({"contents": "hello"})).await;
    assert_eq!(w.status_code(), StatusCode::OK);

    let resp = server.get(&format!("/api/v1/files/{}/stat/note.md", pid))
        .add_header("authorization", format!("Bearer {}", token)).await;
    assert_eq!(resp.status_code(), StatusCode::OK);
    let body: serde_json::Value = resp.json();
    assert_eq!(body["exists"], true);
    assert_eq!(body["is_dir"], false);
    assert_eq!(body["size"], 5);
    assert!(body["modified"].as_i64().unwrap() > 0);
}

#[tokio::test]
async fn stat_missing_file_exists_false() {
    let (server, pid, token) = setup().await;
    let resp = server.get(&format!("/api/v1/files/{}/stat/missing.md", pid))
        .add_header("authorization", format!("Bearer {}", token)).await;
    assert_eq!(resp.status_code(), StatusCode::OK);
    let body: serde_json::Value = resp.json();
    assert_eq!(body["exists"], false);
}
```

- [ ] **Step 2: 验证失败**

Run: `cd src-server && cargo test --test integration files_stat`
Expected: FAIL(404/路由不存在)

- [ ] **Step 3: 实现**

`src-server/src/routes/files.rs` —— 在 `file_routes()` 加路由(注意 `*path` 通配符路由须在末尾,stat 显式路由放在 `/*path` 之前):

```rust
pub fn file_routes() -> axum::Router<AppState> {
    axum::Router::new()
        .route("/:project_id/upload", axum::routing::post(upload_file)
            .layer(DefaultBodyLimit::max(MAX_UPLOAD_SIZE)))
        .route("/:project_id/list", axum::routing::get(list_files))
        // stat 显式路由,必须在 /*path 通配符之前,否则被 read_file 吞掉
        .route("/:project_id/stat/*path", axum::routing::get(stat_file))
        .route("/:project_id/*path", axum::routing::get(read_file))
        .route("/:project_id/*path", axum::routing::post(write_file))
        .route("/:project_id/*path", axum::routing::delete(delete_file))
}

#[derive(serde::Serialize)]
struct StatResp {
    exists: bool,
    is_dir: bool,
    size: u64,
    modified: i64,
}

// GET /api/v1/files/:project_id/stat/*path — 文件元信息(fileExists/getFileSize/getFileModifiedTime 共用)
pub async fn stat_file(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Path((project_id, path)): Path<(i32, String)>,
) -> Result<impl IntoResponse, AppError> {
    let (_user_id, team_id) = check_project_access(&state, &headers, project_id).await?;
    let base = storage::project_base(&state.config.storage_path(), team_id, project_id);
    let file_path = storage::safe_resolve(&base, &path)?;

    let resp = match std::fs::metadata(&file_path) {
        Ok(meta) => StatResp {
            exists: true,
            is_dir: meta.is_dir(),
            size: meta.len(),
            modified: meta.modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0),
        },
        Err(_) => StatResp { exists: false, is_dir: false, size: 0, modified: 0 },
    };
    Ok(Json(serde_json::json!(resp)))
}
```

- [ ] **Step 4: 验证通过**

Run: `cd src-server && cargo test --test integration files_stat && cargo clippy -- -D warnings`(限定 files.rs 相关)
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src-server/src/routes/files.rs src-server/tests/integration/files_stat_test.rs src-server/tests/integration/mod.rs
git commit -m "feat(layer5): files stat 端点(fileExists/size/mtime 共用)"
```

---

## Task 4: api-client 扩展(fetchStream + stat/upload/review/research/ingest/provider)

**Files:**
- Modify: `src/lib/api-types.ts`(加类型)
- Modify: `src/lib/api-client.ts`(加方法)
- Test: `src/lib/api-client.test.ts`(扩展)

- [ ] **Step 1: 写失败测试**

```ts
// 追加到 src/lib/api-client.test.ts
import { describe, it, expect, vi } from "vitest"

describe("ApiClient 新方法", () => {
  it("statFile 发 GET stat", async () => {
    const { apiClient } = await import("./api-client")
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ exists: true, is_dir: false, size: 3, modified: 1 }), { status: 200 }),
    )
    vi.stubGlobal("fetch", mockFetch)
    const r = await apiClient.statFile(7, "a.md")
    expect(r.exists).toBe(true)
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/files/7/stat/a.md"),
      expect.objectContaining({ method: "GET" }),
    )
    vi.unstubAllGlobals()
  })

  it("triggerIngest 发 POST ingest", async () => {
    const { apiClient } = await import("./api-client")
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "job-1", status: "queued" }), { status: 200 }),
    )
    vi.stubGlobal("fetch", mockFetch)
    const r = await apiClient.triggerIngest(5, ["a.md"])
    expect(r.id).toBe("job-1")
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/projects/5/ingest"),
      expect.objectContaining({ method: "POST", body: JSON.stringify({ source_paths: ["a.md"] }) }),
    )
    vi.unstubAllGlobals()
  })
})
```

- [ ] **Step 2: 验证失败**

Run: `npm test -- api-client.test`
Expected: FAIL "apiClient.statFile is not a function"

- [ ] **Step 3a: 加类型到 `src/lib/api-types.ts`**

```ts
// 追加(命名按 Rust serde 实际:reviews camelCase;llm/search_providers snake_case;ingest/research 按 JobResponse/ResearchTask serde——实现时核对 routes)
export interface ReviewItem {
  id: number
  uuid: string
  projectId: number
  sourcePath: string | null
  reviewType: string
  title: string
  description: string
  affectedPages: string[] | null
  searchQueries: string[] | null
  options: Array<{ label: string; action: string }>
  status: string
  resolvedAction: string | null
  resolvedBy: number | null
  resolvedAt: string | null
  createdAt: string
}

export interface ResearchTask {
  id: string
  projectId: number
  topic: string
  searchQueries: string[] | null
  status: string
  stage: string | null
  synthesis: string | null
  savedPath: string | null
  sourceKind: string
  error: string | null
  createdAt: string
}

export interface IngestJob {
  id: string
  projectId: number
  status: string
  stage: string | null
  progress: number
  error: string | null
  createdAt: string
}

export interface LlmProvider {
  id: number
  provider_type: string
  base_url: string | null
  model: string
  context_size: number
  is_enabled: boolean
  has_key: boolean
}

export interface SearchProvider {
  id: number
  provider_type: string
  base_url: string | null
  is_enabled: boolean
  has_key: boolean
}

export interface FileStat {
  exists: boolean
  is_dir: boolean
  size: number
  modified: number
}
```
> **实现核对:** 字段命名(camelCase vs snake_case)严格按对应 Rust 结构体的 `#[serde(rename_all=...)]`:`reviews.rs::ReviewItemResp` = camelCase;`llm_providers.rs/search_providers.rs::ProviderResp` = snake_case;`ingest_queue.rs::JobResponse` / `research::ResearchTask` 实现时核对(默认 snake_case,除非另有 rename)。若与上述不符,以 routes 实际为准调整本文件。

- [ ] **Step 3b: 加方法到 `src/lib/api-client.ts`**

在 `ApiClient` class 内(`streamChat` 之前的位置)追加:

```ts
  // === Files: stat / upload ===
  async statFile(projectId: number, path: string): Promise<FileStat> {
    return this.request("GET", `/api/v1/files/${projectId}/stat/${encodeURI(path)}`)
  }

  /** 当前鉴权头(供 multipart/流式等不走 request<T> 的 fetch 场景复用,避免外部 as any 读 private)。 */
  authHeaders(): Record<string, string> {
    const h: Record<string, string> = {}
    if (this.accessToken) h["Authorization"] = `Bearer ${this.accessToken}`
    return h
  }

  async uploadFile(projectId: number, file: File, dir = ""): Promise<{ name: string; path: string; size: number }> {
    const form = new FormData()
    form.append("path", dir)
    form.append("file", file)
    // multipart 不能设 Content-Type(浏览器自动加 boundary),手动 fetch + 复用 authHeaders
    const resp = await fetch(`${API_BASE}/api/v1/files/${projectId}/upload`, {
      method: "POST",
      headers: this.authHeaders(),
      body: form,
    })
    if (!resp.ok) throw new Error(`upload failed: HTTP ${resp.status}`)
    return resp.json()
  }

  // === Ingest ===
  async triggerIngest(projectId: number, sourcePaths: string[]): Promise<IngestJob> {
    return this.request("POST", `/api/v1/projects/${projectId}/ingest`, { source_paths: sourcePaths })
  }

  async getIngestJob(jobId: string): Promise<IngestJob> {
    return this.request("GET", `/api/v1/ingest/jobs/${jobId}`)
  }

  // === Review ===
  async listReviews(projectId: number): Promise<ReviewItem[]> {
    return this.request("GET", `/api/v1/projects/${projectId}/reviews`)
  }

  async resolveReview(projectId: number, itemId: number, body: { kind: string; path?: string }): Promise<unknown> {
    return this.request("POST", `/api/v1/projects/${projectId}/reviews/${itemId}/resolve`, body)
  }

  async dismissReview(projectId: number, itemId: number): Promise<unknown> {
    return this.request("POST", `/api/v1/projects/${projectId}/reviews/${itemId}/dismiss`, {})
  }

  // === Research ===
  async enqueueResearch(projectId: number, body: { topic: string; search_queries?: string[] }): Promise<ResearchTask> {
    return this.request("POST", `/api/v1/projects/${projectId}/research`, body)
  }

  async getResearchTask(uuid: string): Promise<ResearchTask> {
    return this.request("GET", `/api/v1/research/tasks/${uuid}`)
  }

  // === LLM / Search providers(team 维度)===
  async getLlmProvider(teamId: number): Promise<LlmProvider | null> {
    return this.request("GET", `/api/v1/teams/${teamId}/llm-providers`)
  }

  async upsertLlmProvider(teamId: number, body: { provider_type: string; api_key: string; base_url?: string; model?: string; context_size?: number }): Promise<LlmProvider> {
    return this.request("POST", `/api/v1/teams/${teamId}/llm-providers`, body)
  }

  async listSearchProviders(teamId: number): Promise<SearchProvider[]> {
    return this.request("GET", `/api/v1/teams/${teamId}/search-providers`)
  }
```

并在文件顶部 import 补类型:
```ts
import type {
  ApiError, LoginRequest, RegisterRequest, AuthResponse,
  UserResponse, TeamResponse, ProjectResponse, SearchResponse, GraphData,
  FileStat, ReviewItem, ResearchTask, IngestJob, LlmProvider, SearchProvider,
} from "./api-types"
```

- [ ] **Step 4: 验证通过**

Run: `npm test -- api-client.test`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/lib/api-client.ts src/lib/api-types.ts src/lib/api-client.test.ts
git commit -m "feat(layer5): api-client 补全(stat/upload/ingest/review/research/provider)"
```

---

## Task 5: fs.ts 适配(USE_HTTP→caps + stat/unsupported)

**Files:**
- Modify: `src/commands/fs.ts`
- Test: `src/commands/fs.test.ts`(扩展或新建)

- [ ] **Step 1: 写失败测试**

```ts
// src/commands/fs.test.ts
import { describe, it, expect, vi } from "vitest"

describe("fs.ts web 适配", () => {
  it("fileExists 走 statFile(web)", async () => {
    vi.resetModules()
    vi.doMock("@/lib/capabilities", () => ({ caps: { platform: "web" } }))
    vi.doMock("@/lib/api-client", () => ({
      apiClient: { statFile: vi.fn().mockResolvedValue({ exists: true, is_dir: false, size: 1, modified: 1 }) },
    }))
    const fs = await import("./fs")
    expect(await fs.fileExists("x.md")).toBe(true)
    vi.doUnmock("@/lib/capabilities"); vi.doUnmock("@/lib/api-client")
  })

  it("copyFile web 下 throw desktop-only", async () => {
    vi.resetModules()
    vi.doMock("@/lib/capabilities", () => ({ caps: { platform: "web" } }))
    const fs = await import("./fs")
    await expect(fs.copyFile("a", "b")).rejects.toThrow(/desktop-only/)
  })
})
```

- [ ] **Step 2: 验证失败**

Run: `npm test -- fs.test`
Expected: FAIL(fileExists 未走 statFile / copyFile 未 throw)

- [ ] **Step 3: 实现**

修改 `src/commands/fs.ts`——顶部:
```ts
import { caps } from "@/lib/capabilities"
// 移除原 const USE_HTTP = import.meta.env.VITE_USE_HTTP_API === "true"
const USE_HTTP = caps.platform === "web"
```
(运行时以 caps 为准;env 仅作构建期参考。所有现有 `if (USE_HTTP)` 分支语义不变。)

替换三个消费类函数,加 HTTP 分支:
```ts
export async function fileExists(path: string): Promise<boolean> {
  if (USE_HTTP) {
    const projectId = getCurrentProjectId()
    const stat = await apiClient.statFile(projectId, path)
    return stat.exists
  }
  return invoke<boolean>("file_exists", { path })
}

export async function getFileModifiedTime(path: string): Promise<number> {
  if (USE_HTTP) {
    const projectId = getCurrentProjectId()
    const stat = await apiClient.statFile(projectId, path)
    return stat.modified
  }
  return invoke<number>("get_file_modified_time", { path })
}

export async function getFileSize(path: string): Promise<number> {
  if (USE_HTTP) {
    const projectId = getCurrentProjectId()
    const stat = await apiClient.statFile(projectId, path)
    return stat.size
  }
  return invoke<number>("get_file_size", { path })
}
```

unsupported 函数加 web guard(每个函数体首行):
```ts
export async function copyFile(source: string, destination: string): Promise<void> {
  if (USE_HTTP) throw new Error("copyFile is desktop-only (web 摄取走 upload→worker)")
  return invoke("copy_file", { source, destination })
}
export async function copyDirectory(source: string, destination: string): Promise<string[]> {
  if (USE_HTTP) throw new Error("copyDirectory is desktop-only")
  return invoke<string[]>("copy_directory", { source, destination })
}
export async function preprocessFile(path: string): Promise<string> {
  if (USE_HTTP) throw new Error("preprocessFile is desktop-only (服务器 read 已做 pdf/docx 提取)")
  return invoke<string>("preprocess_file", { path })
}
export async function getFileMd5(path: string): Promise<string> {
  if (USE_HTTP) throw new Error("getFileMd5 is desktop-only (web 摄取去重由 worker 侧处理)")
  return invoke<string>("get_file_md5", { path })
}
export async function readFileAsBase64(path: string): Promise<FileBase64> {
  if (USE_HTTP) throw new Error("readFileAsBase64 is desktop-only (web 图片走 raw 端点,见期2)")
  return invoke<FileBase64>("read_file_as_base64", { path })
}
```
(`writeFileBase64` 已有 HTTP throw,保留;`findRelatedWikiPages` 加同样 guard。)

- [ ] **Step 4: 验证通过**

Run: `npm test -- fs.test`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/commands/fs.ts src/commands/fs.test.ts
git commit -m "feat(layer5): fs.ts caps 适配 + stat HTTP + unsupported throw"
```

---

## Task 6: 后端 chat.rs 直通改造(去双层 SSE)

**Files:**
- Modify: `src-server/src/routes/chat.rs:31-52`(`chat_stream`) + `108-185`(`stream_chat_to_sse`)
- Test: `src-server/tests/integration/chat_stream_test.rs`(新建,加入 integration test target)

- [ ] **Step 1: 写失败测试**

```rust
// src-server/tests/integration/chat_stream_test.rs
/// chat_stream 直通改造集成测试(Layer 5 Task 6)。
/// 不依赖真实 LLM:验证端点鉴权(401 无 token)+ 直通代码路径可达(有 token 无 provider → 5xx,非崩溃)。
/// 注册:tests/integration/mod.rs 加 `pub mod chat_stream_test;`。运行 `cargo test --test integration chat_stream`。
use axum::http::StatusCode;
use std::sync::atomic::{AtomicU64, Ordering};

static COUNTER: AtomicU64 = AtomicU64::new(0);

async fn setup() -> (axum_test::TestServer, i32, String) {
    let (app, state) = crate::setup_test_app().await;
    let server = axum_test::TestServer::new(app).unwrap();
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let username = format!("cstream_{}_{}", std::process::id(), n);
    let token = crate::register_user(&server, &username, &format!("{}@t.com", username), "password123").await;
    let team_id: i32 = sqlx::query_scalar(
        "SELECT id FROM teams WHERE created_by = (SELECT id FROM users WHERE username = $1)",
    ).bind(&username).fetch_one(&state.db).await.unwrap();
    let resp = server.post("/api/v1/projects")
        .add_header("authorization", format!("Bearer {}", token))
        .json(&serde_json::json!({"name": format!("cproj-{}-{}", std::process::id(), n), "team_id": team_id})).await;
    assert_eq!(resp.status_code(), StatusCode::CREATED);
    let pid = resp.json::<serde_json::Value>()["id"].as_i64().unwrap() as i32;
    (server, pid, token)
}

#[tokio::test]
async fn chat_stream_requires_auth() {
    let (server, pid, _token) = setup().await;
    let resp = server.post("/api/v1/chat/stream")
        .json(&serde_json::json!({"project_id": pid, "messages": [{"role":"user","content":"hi"}]})).await;
    assert_eq!(resp.status_code(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn chat_stream_reachable_without_provider() {
    let (server, pid, token) = setup().await;
    // 无 LLM provider 配置 → get_llm_config 报错 → 5xx(端点可达,直通逻辑未崩,无双层 SSE 异常)
    let resp = server.post("/api/v1/chat/stream")
        .add_header("authorization", format!("Bearer {}", token))
        .json(&serde_json::json!({"project_id": pid, "messages": [{"role":"user","content":"hi"}]})).await;
    assert!(resp.status_code().is_server_error(), "无 provider 应 5xx,得 {}", resp.status_code());
}
```
> 直通改造的"无双层 `data: data:`"需真实 LLM 流,集成测试不依赖外部 API,留**期1 收尾手动 e2e 烟测**(配真实 provider,断言 content-type=text/event-stream 且 body 无 `data: data:`)。

- [ ] **Step 2: 验证失败**

Run: `cd src-server && cargo test --test integration chat_stream`
Expected: FAIL(现状双层包裹 → `data: data:` 断言失败,或 content-type 非 text/event-stream)

- [ ] **Step 3: 实现**

改 `src-server/src/routes/chat.rs`——`chat_stream` 返回类型从 `Sse<SseStream>` 改为 `axum::response::Response`,`stream_chat_to_sse` 改名 `stream_chat_raw` 返回直通 Response:

```rust
use axum::response::IntoResponse;

/// POST /api/v1/chat/stream — 直通上游 LLM 的原始 SSE 字节流
pub async fn chat_stream(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> Result<axum::response::Response, AppError> {
    let project_id = body.get("project_id").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
    let _user_id = check_project_access(&state, &headers, project_id).await?.0;
    let messages: Vec<ChatMessage> = body.get("messages")
        .and_then(|m| serde_json::from_value(m.clone()).ok())
        .unwrap_or_default();
    let model_override = body.get("model").and_then(|m| m.as_str().map(String::from));
    stream_chat_raw(&state, project_id, &messages, model_override).await
}

/// 直通:把 reqwest bytes_stream 作为响应 body,Content-Type text/event-stream。
/// 客户端收到标准单层 OpenAI SSE,可复用桌面版 parseLines/parseStream。
/// 不再用 axum Event::data(它按 \n 拆行加 data: 前缀,造成双层 data: data:)。
async fn stream_chat_raw(
    state: &AppState,
    project_id: i32,
    messages: &[ChatMessage],
    model_override: Option<String>,
) -> Result<axum::response::Response, AppError> {
    let llm_config = crate::services::llm::get_llm_config(&state.db, project_id).await?;
    let api_key = crate::services::llm::decrypt_api_key(&llm_config.api_key, &state.config)?;
    let base_url = llm_config.base_url.as_deref().unwrap_or("https://api.openai.com/v1");
    let model = model_override.unwrap_or(llm_config.model);

    let openai_messages: Vec<serde_json::Value> = std::iter::once(
        serde_json::json!({"role":"system","content":"You are a helpful knowledge assistant."}),
    ).chain(messages.iter().map(|m| serde_json::json!({"role":m.role,"content":m.content}))).collect();

    let client = reqwest::Client::new();
    let upstream = client
        .post(format!("{}/chat/completions", base_url))
        .header("Authorization", format!("Bearer {}", api_key))
        .json(&serde_json::json!({"model":model,"messages":openai_messages,"stream":true}))
        .send().await?;

    if !upstream.status().is_success() {
        let status = upstream.status();
        let text = upstream.text().await.unwrap_or_default();
        return Err(AppError::InternalError(format!("LLM upstream {}: {}", status, text)));
    }

    // 直通原始字节流;axum Body::from_stream 把 reqwest Stream 转为响应 body
    let stream = upstream.bytes_stream();
    Ok((
        [(axum::http::header::CONTENT_TYPE, "text/event-stream")],
        axum::body::Body::from_stream(stream),
    ).into_response())
}
```
删除旧的 `stream_chat_to_sse` 与 `SseStream` type alias(若 `chat_message` 仍用则保留;`use` 清理:`Sse`/`futures::stream`/`SseStream` 相关 import 若不再用则移除,clippy 零 warning)。

> **keep-alive 权衡(部署)**:原 `stream_chat_to_sse` 用 axum `KeepAlive` 每 15s 发 `: ping`;直通(`Body::from_stream`)不再注入心跳。若部署在反代(nginx 默认 `proxy_read_timeout 60s`)后 + 慢 reasoning 模型(首 token 前长无数据),代理可能在上游响应前断开。期1 采用**部署层调大 `proxy_read_timeout`(如 600s)+ `proxy_buffering off`**(SSE 需关闭缓冲)缓解;stream 包装 idle 注入 SSE 注释(`: ping`)留作后续(直通模式下需在 bytes_stream 上叠 `async_stream` select 计时器,复杂度较高)。

- [ ] **Step 4: 验证通过**

Run: `cd src-server && cargo test --test integration chat_stream && cargo clippy -- -D warnings`
Expected: PASS(无双层 data:、content-type text/event-stream)

- [ ] **Step 5: 提交**

```bash
git add src-server/src/routes/chat.rs src-server/tests/integration/chat_stream_test.rs src-server/tests/integration/mod.rs
git commit -m "fix(layer5): chat_stream 直通原始 SSE 字节(去 axum Event::data 双层包裹)"
```

---

## Task 7: llm-client streamChat caps 分发 + streamViaServer

**Files:**
- Modify: `src/lib/llm-client.ts`(入口分发 + 新增 streamViaServer)
- Test: `src/lib/llm-client.test.ts`(扩展)

- [ ] **Step 1: 写失败测试**

```ts
// 追加到 src/lib/llm-client.test.ts(或新建)
import { describe, it, expect, vi } from "vitest"
import type { StreamCallbacks } from "./llm-client"

describe("streamChat web 分发", () => {
  it("web 走 streamViaServer(POST /chat/stream + Authorization)", async () => {
    vi.resetModules()
    vi.doMock("@/lib/capabilities", () => ({ caps: { platform: "web" } }))
    vi.doMock("@/lib/api-client", () => ({ API_BASE: "", apiClient: { isAuthenticated: true, authHeaders: () => ({ Authorization: "Bearer tok" }) } }))

    const encoder = new TextEncoder()
    const sseBody = `data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: [DONE]\n\n`
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(encoder.encode(sseBody), { status: 200, headers: { "content-type": "text/event-stream" } }),
    )
    vi.stubGlobal("fetch", mockFetch)
    vi.stubGlobal("window", { __currentProjectId: 9 })

    const { streamChat } = await import("./llm-client")
    const tokens: string[] = []
    const cb: StreamCallbacks = { onToken: (t) => tokens.push(t), onDone: () => {}, onError: (e) => { throw e } }
    await streamChat({ provider: "openai", apiKey: "x", model: "gpt-4o" } as any, [{ role: "user", content: "hi" }], cb)

    expect(mockFetch).toHaveBeenCalled()
    const [url, init] = mockFetch.mock.calls[0]
    expect(url).toContain("/api/v1/chat/stream")
    expect((init as RequestInit).method).toBe("POST")
    expect(((init as RequestInit).headers as Record<string,string>)["Authorization"]).toBe("Bearer tok")
    expect(tokens.join("")).toBe("Hi")

    vi.unstubAllGlobals()
  })
})
```

- [ ] **Step 2: 验证失败**

Run: `npm test -- llm-client.test`
Expected: FAIL(streamChat 未分发到 web 路径)

- [ ] **Step 3: 实现**

`src/lib/llm-client.ts` 顶部加 import:
```ts
import { caps } from "@/lib/capabilities"
import { API_BASE } from "@/lib/api-client"
```
在 `streamChat` 函数体最开头(`const { onToken, ... }` 之前)加分发:
```ts
  if (caps.platform === "web") {
    return streamViaServer(config, messages, callbacks, signal)
  }
```
并新增 `streamViaServer`(复用本文件已有的 `parseLines` + `DECODER` + reasoning 记录逻辑;调服务器端点,服务器自取 team provider):

```ts
/** web 通路:fetch POST /api/v1/chat/stream + Authorization + ReadableStream 解析。
 *  服务器按 project_id 查 team provider(见 chat.rs stream_chat_raw),前端不持 key。
 *  复用桌面版的逐行解析与 reasoning 检测;provider 格式恒为 OpenAI-compatible(服务器侧约束)。 */
async function streamViaServer(
  _config: LlmConfig,
  messages: import("./llm-providers").ChatMessage[],
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
): Promise<void> {
  const { onToken, onDone, onError } = callbacks
  const projectId = (typeof window !== "undefined" && (window as any).__currentProjectId) || 0
  const { apiClient } = await import("@/lib/api-client")
  const headers: Record<string, string> = { "Content-Type": "application/json", ...apiClient.authHeaders() }

  let response: Response
  try {
    response = await fetch(`${API_BASE}/api/v1/chat/stream`, {
      method: "POST",
      headers,
      body: JSON.stringify({ project_id: projectId, messages }),
      signal,
    })
  } catch (err) {
    if (signal?.aborted) { onDone(); return }
    onError(err instanceof Error ? err : new Error(String(err))); return
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    onError(new Error(`chat upstream HTTP ${response.status}: ${detail}`)); return
  }
  if (!response.body) { onError(new Error("chat stream body null")); return }

  // 逐行解析复用桌面版 OpenAI-compatible 通路 + reasoning 检测(DeepSeek-R1 等思考模型)。
  // 服务器直通标准 OpenAI SSE,用 openai provider parseStream;reasoning 复用本文件已 import 的
  // countReasoningCharsInLine/extractReasoningTextFromLine(与桌面版 streamChat 同逻辑,DRY)。
  const { getProviderConfig } = await import("./llm-providers")
  const providerConfig = getProviderConfig({ provider: "openai", apiKey: "", model: "" } as LlmConfig)
  const reader = response.body.getReader()
  let lineBuffer = ""
  let contentChars = 0
  let reasoningChars = 0
  const REASONING_DIAGNOSTIC_THRESHOLD = 200
  const recordToken = (t: string) => { contentChars += t.length; onToken(t) }
  const recordReasoning = (line: string) => {
    reasoningChars += countReasoningCharsInLine(line)
    for (const part of extractReasoningTextFromLine(line)) callbacks.onReasoningToken?.(part)
  }
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        if (lineBuffer.trim()) {
          recordReasoning(lineBuffer.trim())
          const tk = providerConfig.parseStream(lineBuffer.trim()); if (tk) recordToken(tk)
        }
        break
      }
      const [lines, remaining] = parseLines(value, lineBuffer)
      lineBuffer = remaining
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        recordReasoning(trimmed)
        const tk = providerConfig.parseStream(trimmed)
        if (tk) recordToken(tk)
      }
    }
    // 只思考无答案的诊断(与桌面版 streamChat 一致,避免退化为泛化"空内容"错误)
    if (contentChars === 0 && reasoningChars >= REASONING_DIAGNOSTIC_THRESHOLD) {
      onError(new Error(`Model produced ${reasoningChars.toLocaleString()} chars of reasoning but no content. Try shorter input, increase max_tokens, or switch model.`))
    } else if (contentChars === 0) {
      onError(new Error("chat 返回空内容(provider 可能未配或报错)"))
    } else {
      onDone()
    }
  } catch (err) {
    if (signal?.aborted) { onDone(); return }
    onError(err instanceof Error ? err : new Error(String(err)))
  } finally {
    reader.releaseLock()
  }
}
```
> 注:`getProviderConfig({provider:"openai",...})` 复用 openai 的 `parseStream`(parseOpenAiLine)做单层解析——服务器直通后就是标准 OpenAI SSE,正好匹配。`parseLines` 已存在于本文件(行 43)。

- [ ] **Step 4: 验证通过**

Run: `npm test -- llm-client.test`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/lib/llm-client.ts src/lib/llm-client.test.ts
git commit -m "feat(layer5): streamChat caps 分发 + streamViaServer(fetch POST+ReadableStream)"
```

---

## Task 8: 收敛散落 isTauri → caps

**Files:**
- Modify: `src/main.tsx:21-22`
- Modify: `src/lib/theme.ts:17-22`
- Test: 既有测试不回归即可

- [ ] **Step 1: 写失败测试(回归保护)**

```ts
// src/lib/theme.test.ts(若已有则追加,否则新建一个最小回归测)
import { describe, it, expect } from "vitest"
describe("theme isTauriRuntime 收敛", () => {
  it("不再定义本地 isTauriRuntime(改用 caps)", async () => {
    const src = await import("fs").then((fs) => fs.readFileSync("src/lib/theme.ts", "utf8"))
    expect(src).not.toContain("isTauriRuntime")
  })
})
```

- [ ] **Step 2: 验证失败**

Run: `npm test -- theme.test`
Expected: FAIL(theme.ts 仍含 isTauriRuntime)

- [ ] **Step 3: 实现**

`src/lib/theme.ts`:删除本地 `isTauriRuntime` 函数(行 17-22),改 import 并用 caps:
```ts
import { caps } from "@/lib/capabilities"
// 原 if (!isTauriRuntime()) return  →
if (caps.platform !== "tauri") return
```

`src/main.tsx`:行 21-22 的 `const isTauri = "__TAURI_INTERNALS__" in window || "__TAURI__" in window;` 改为:
```ts
import { caps } from "@/lib/capabilities"
// 删除本地 isTauri 判断,改用 caps.platform === "tauri"
// 原 if (isTauri && navigator.userAgent.includes("Mac OS X"))  →
if (caps.platform === "tauri" && navigator.userAgent.includes("Mac OS X"))
```

- [ ] **Step 4: 验证通过 + typecheck**

Run: `npm test -- theme.test && npm run typecheck`
Expected: PASS + typecheck 无错

- [ ] **Step 5: 提交**

```bash
git add src/main.tsx src/lib/theme.ts src/lib/theme.test.ts
git commit -m "refactor(layer5): 散落 isTauri/isTauriRuntime 统一到 caps"
```

---

## Task 9: 后端 ServeDir 同源托管

**Files:**
- Modify: `src-server/Cargo.toml:11`(tower-http 加 fs feature)
- Modify: `src-server/src/config.rs`(加 FrontendConfig)
- Modify: `src-server/src/routes/mod.rs:create_router`(ServeDir fallback)
- Modify: `src-server/config/default.json`(frontend 默认值)
- Test: `src-server/tests/integration/servedir_test.rs`(新建,加入 integration test target)

- [ ] **Step 1: 写失败测试**

```rust
// src-server/tests/integration/servedir_test.rs
/// ServeDir 集成测试(Layer 5 Task 9)。
/// 验证 API 路由优先于 ServeDir fallback。SPA index.html 内容验证需 dist 存在(靠手动/CI build,不强测)。
/// 注册:tests/integration/mod.rs 加 `pub mod servedir_test;`。运行 `cargo test --test integration servedir`。
use axum::http::StatusCode;

#[tokio::test]
async fn health_route_not_swallowed_by_servedir() {
    let (app, _state) = crate::setup_test_app().await;
    let server = axum_test::TestServer::new(app).unwrap();
    let resp = server.get("/health").await;
    assert_eq!(resp.status_code(), StatusCode::OK); // /health 显式路由优先于 fallback_service
}

#[tokio::test]
async fn unknown_path_does_not_500() {
    let (app, _state) = crate::setup_test_app().await;
    let server = axum_test::TestServer::new(app).unwrap();
    let resp = server.get("/some/unknown/spa/route").await;
    // ServeDir fallback:dist 文件不存在→ServeFile 返回 404;存在→200 index.html。绝不 500。
    assert_ne!(resp.status_code(), StatusCode::INTERNAL_SERVER_ERROR);
}
```

- [ ] **Step 2: 验证失败**

Run: `cd src-server && cargo test --test integration servedir`
Expected: FAIL(ServeDir 未集成)

- [ ] **Step 3a: Cargo.toml**

```toml
tower-http = { version = "0.5", features = ["cors", "trace", "fs"] }
```

- [ ] **Step 3b: config.rs 加 FrontendConfig**

```rust
// config.rs
#[derive(Debug, Clone, Deserialize)]
pub struct FrontendConfig {
    pub dist_dir: String,
    pub index_html: String,
}

// AppConfig 加字段
pub struct AppConfig {
    pub server: ServerConfig,
    pub database: DatabaseConfig,
    pub redis_url: String,
    pub jwt: JwtConfig,
    pub storage: StorageConfig,
    pub cors: CorsConfig,
    pub embedding: Option<EmbeddingConfig>,
    #[serde(default = "default_frontend")]
    pub frontend: FrontendConfig,
}
fn default_frontend() -> FrontendConfig {
    FrontendConfig {
        dist_dir: "../dist".to_string(),
        index_html: "../dist/index.html".to_string(),
    }
}
impl AppConfig {
    pub fn dist_dir(&self) -> &str { &self.frontend.dist_dir }
    pub fn index_html(&self) -> &str { &self.frontend.index_html }
}
```
`config/default.json` 加:
```json
"frontend": { "dist_dir": "../dist", "index_html": "../dist/index.html" }
```

- [ ] **Step 3c: mod.rs create_router 加 ServeDir fallback**

```rust
use tower_http::services::{ServeDir, ServeFile};

pub fn create_router(state: AppState) -> Router {
    let dist_dir = state.config.dist_dir().to_string();
    let index_html = state.config.index_html().to_string();
    let spa = ServeDir::new(&dist_dir).fallback(ServeFile::new(&index_html));

    Router::new()
        .route("/health", get(health::health_check))
        .nest("/api/v1/auth", auth::auth_routes())
        .nest("/api/v1/users", users::user_routes())
        .nest("/api/v1/teams", teams::team_routes())
        .nest("/api/v1/projects", projects::project_routes())
        .nest("/api/v1/files", files::file_routes())
        .nest("/api/v1/search", search::search_routes())
        .nest("/api/v1/chat", chat::chat_routes())
        .nest("/api/v1/graph", graph::graph_routes())
        .merge(ingest::global_ingest_routes())
        .merge(research::global_research_routes())
        .merge(llm_providers::llm_provider_routes())
        .merge(search_providers::search_provider_routes())
        .fallback_service(spa)
        .with_state(state)
}
```
> API 路由在 `Router::new()` 内显式声明,优先于 `fallback_service`;未命中 API 的路径 → ServeDir(静态文件,不存在则 fallback `index.html` = SPA history mode)。

- [ ] **Step 4: 验证通过**

Run: `cd src-server && cargo test --test integration servedir && cargo clippy -- -D warnings`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src-server/Cargo.toml src-server/src/config.rs src-server/src/routes/mod.rs src-server/config/default.json src-server/tests/integration/servedir_test.rs src-server/tests/integration/mod.rs
git commit -m "feat(layer5): src-server ServeDir 同源托管 dist + SPA fallback"
```

---

## Task 10: build:web 脚本 + .env.production

**Files:**
- Modify: `package.json`(scripts)
- Create: `.env.web`
- Test: 手动验证 `npm run build:web` 产 dist

- [ ] **Step 1: 写验证(脚本类无单测,用 build 烟测)**

Run: `npm run build:web`
Expected: 当前 FAIL(脚本未定义)

- [ ] **Step 2: 验证失败**

Expected: `Missing script: "build:web"`

- [ ] **Step 3: 实现**

`package.json` scripts 加(web 专属构建模式,与桌面 `tauri build`→`npm run build` 隔离):
```json
"build:web": "vite build --mode web"
```

`.env.web`(新建,仅 `--mode web` 加载;**不**创建 `.env.production`,避免污染桌面 production 构建):
```bash
# web 同源部署:相对 fetch。VITE_API_BASE_URL 置空 → resolveApiBase ?? 保留空串 → 同源。
# VITE_USE_HTTP_API 不再需要(fs.ts 改用 caps.platform 运行时判断,见 Task 5)。
VITE_API_BASE_URL=
```
> **为何 `--mode web` 而非 `.env.production`**:Vite production 构建加载 `.env.production`;`tauri build` 的 beforeBuildCommand `npm run build` 也走 production 模式会**共享**它。若把空串写进 `.env.production`,桌面生产产物 `API_BASE=""` → Tauri webview(自定义协议源)与 :8080 src-server 跨源 → 桌面鉴权/接口全失效。`--mode web` 只加载 `.env.web`(桌面 production 不加载),两种构建隔离。

- [ ] **Step 4: 验证通过**

Run: `npm run build:web && ls -la dist/index.html`
Expected: dist/index.html 存在;web 产物 API_BASE 解析为空串(相对 fetch)。
> 核对:web 产物(`--mode web` + .env.web `VITE_API_BASE_URL=`)→ `resolveApiBase("")=""` ✓;桌面 production(`npm run build`,无 .env.production)→ `resolveApiBase(undefined)="http://localhost:8080"` ✓。两种构建互不污染。

- [ ] **Step 5: 提交**

```bash
git add package.json .env.web
git commit -m "feat(layer5): build:web --mode web + .env.web(与桌面 production 构建隔离)"
```

---

## Task 11: App.tsx web 最小入口(登录→选 team/project)

**Files:**
- Modify: `src/App.tsx`(init useEffect + handleProjectOpened 加 caps 分支)
- Test: 手动 + 既有测试不回归

> 说明:App.tsx 已有 `useAuthStore`/`isAuthenticated`/`LoginPage`/`RegisterPage`(auth UI 就绪)。期1 仅加 web 分支:init 时不走 `openProject(本地路径)`,改走 token→listTeams→listProjects→设 `__currentProjectId`→加载 graph/pages。完整入口 UX(team/project 选择器组件)留期2。

- [ ] **Step 1: 写失败测试(回归保护)**

```ts
// src/App.test.tsx(若已有则追加;否则最小回归测验证 web 不调 openProject)
import { describe, it, expect, vi } from "vitest"
describe("App web 入口", () => {
  it("web 下不调用 openProject(本地路径)", async () => {
    vi.resetModules()
    vi.doMock("@/lib/capabilities", () => ({ caps: { platform: "web" } }))
    const src = await import("fs").then((fs) => fs.readFileSync("src/App.tsx", "utf8"))
    // openProject 调用应被 caps.platform === 'tauri' 包裹
    expect(src).toMatch(/caps\.platform.*tauri[\s\S]*openProject|openProject[\s\S]*caps\.platform.*tauri/)
  })
})
```

- [ ] **Step 2: 验证失败**

Run: `npm test -- App.test`
Expected: FAIL(openProject 未被 caps 包裹)

- [ ] **Step 3: 实现**

`src/App.tsx` import 加:
```ts
import { caps } from "@/lib/capabilities"
import { apiClient } from "@/lib/api-client"
```

init `useEffect` 的 `openProject(lastProject.path)` 分支用 caps 包裹(web 跳过本地打开):
```ts
// 原:
//   const lastProject = await getLastProject()
//   if (lastProject) { const proj = await openProject(lastProject.path); await handleProjectOpened(proj) }
// 改:
if (caps.platform === "tauri") {
  const lastProject = await getLastProject()
  if (lastProject) {
    const proj = await openProject(lastProject.path)
    await handleProjectOpened(proj)
  }
}
// web 分支:auth 已由现有 isAuthenticated 门控(LoginPage/RegisterPage 就绪);
// 项目选择 UI 留期2,期1 暂用最小占位——若已选过 team/project(localStorage 缓存)则恢复。
```

`handleProjectOpened`(行 ~315)在 `setProject(proj)` 后设 `__currentProjectId`:
```ts
async function handleProjectOpened(proj: WikiProject) {
  // ... 现有逻辑 ...
  ;(window as any).__currentProjectId = proj.id  // fs.ts HTTP 分支 + streamViaServer 依赖
  setProject(proj)
  // ... 现有后续 ...
}
```
> `WikiProject` 类型需有 `id` 字段;若 web 下 project 来自 `apiClient.listProjects`(`ProjectResponse`),在期1 最小入口里先确保 `ProjectResponse.id` 映射到 `WikiProject.id`。完整 web 项目选择器(选 team→选/建 project)是期2 Task,期1 仅打通"已有 token + __currentProjectId 能驱动 fs/llm-client HTTP 分支"。

- [ ] **Step 4: 验证通过 + typecheck**

Run: `npm test -- App.test && npm run typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/App.tsx src/App.test.tsx
git commit -m "feat(layer5): App web 入口分支(caps gate openProject + 设 __currentProjectId)"
```

---

## 期1 收尾验证

- [ ] **全量测试**:`npm test`(前端)+ `cd src-server && cargo test`(后端)全绿(已知 pre-existing flaky `ingest_queue` 隔离通过,非回归)
- [ ] **typecheck**:`npm run typecheck` 无错
- [ ] **clippy**:`cd src-server && cargo clippy -- -D warnings`(Layer5 改动文件零 warning)
- [ ] **端到端烟测(手工)**:`npm run build:web` → src-server `dist_dir=../dist` 启动 → 浏览器访问 → 登录→选 team/project→浏览图谱/搜索→chat 流式输出 → 验证 chat 不双层、token 带上

---

## Self-Review(已做)

**Spec 覆盖(期1 范围)**:
- §4 capabilities → Task 1 ✓
- §5 fs.ts(stat + unsupported)→ Task 3(后端 stat)+ Task 5(前端)✓
- §6.3 LLM fetch 抽象 + chat.rs 直通 → Task 6 + Task 7 ✓
- §6.3 api-client 补全 → Task 4 ✓
- §10 部署 ServeDir + build:web + `||`→`??` → Task 2 + Task 9 + Task 10 ✓
- §9 最小入口(登录/项目 id)→ Task 11 ✓(完整选择器留期2)
- §6.3 收敛 isTauri → Task 8 ✓
- 期2(§7 摄取组件 / §8 raw 端点 + 设置页 gate / §9 完整入口)→ 本 plan 不含,另写期2

**Placeholder/类型一致性**:`api-types.ts` 字段命名已标注"实现时按 routes serde 核对"(reviews camelCase / providers snake_case 混用);`streamViaServer` 复用 `parseLines`(Task 7 引用本文件已有)+ `getProviderConfig`(llm-providers.ts 已有)。**后端测试用现有 `tests/integration/` 模式**(`crate::setup_test_app` + `register_user` + `axum_test::TestServer`,见 `ingest_test.rs`),Cargo.toml `[[test]] name=integration path=tests/integration/mod.rs`;新测试加 `pub mod xxx_test;` 到 `mod.rs`,命令 `cargo test --test integration`。

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-23-layer5-web-adapt-phase1-foundation.md`. Two execution options:

**1. Subagent-Driven (recommended)** — 每个 task 派新 subagent + 两阶段 review(spec 合规 + 代码质量),task 间快迭代
**2. Inline Execution** — 本 session 内 executing-plans 批量执行 + checkpoint

Which approach?
