# Layer 5 期2: Web 适配完整链路 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 web 版完整可用——web 摄取组件(upload→trigger→poll)、二进制 raw 端点 + 图片/媒体预览降级、桌面专属设置页 gate、完整 App web 入口(team→project 选择器),补齐期1 留下的 spec §7/§8/§9 完整范围。

**Architecture:** 期1 Task 1-5 已交付 caps 运行时探测 + api-client(upload/stat/triggerIngest/listReviews/providers CRUD)。**期2 须在期1 全部 11 tasks 完成后执行**:Task 6(chat.rs 直通)/7(llm-client streamViaServer)/9(ServeDir)/10(build:web)/11(App 入口 caps gate + `__currentProjectId`)是期2 Task 3 WebImage 与 Task 6 App 入口接入的前置。期2 在此基础上:(1) 后端补 `GET /files/:project_id/raw/*path` 二进制端点(复用 check_project_access + safe_resolve);(2) 前端统一 `fileUrl()` helper 取代散落的 `convertFileSrc`,web 下走 fetch raw→blob→URL.createObjectURL;(3) web 摄取走新组件(upload→triggerIngest→轮询 getIngestJob),不复用桌面本地 ingest.ts;(4) App.tsx 按 caps 完整分支:web 走 team→project 选择器。桌面版零回归(所有 caps 在 tauri=true 全开)。

**Tech Stack:** React 19 + TypeScript + vitest(前端);axum 0.7 + tower-http + sqlx(后端)。

**对应 spec:** `docs/superpowers/specs/2026-06-23-layer5-web-adapt-design.md`(期2 覆盖 §7 摄取 / §8 raw 端点 + 桌面降级 gate / §9 完整 App 入口)。期1(§4/§5/§6/§10 + §9 最小入口)在 `2026-06-23-layer5-web-adapt-phase1-foundation.md`。

**前置依赖:** **期1 全部 11 tasks 须先完成并测试通过**——`capabilities.ts`(T1)、`api-client.ts`(T2/T4)、`fs.ts`(T5)、`chat.rs` 直通(T6)、`llm-client.ts` `streamViaServer`(T7)、`main.tsx`/`theme.ts` 收敛(T8)、`ServeDir`(T9)、`build:web`/`.env.web`(T10)、`App.tsx` caps gate + `__currentProjectId`(T11)。期2 Task 3 WebImage 依赖 `__currentProjectId`;Task 6 App 入口依赖 T11 的 caps gate。

**工作约定:** 简体中文注释;前端测试 `npm test`(vitest);后端测试 `cd src-server && cargo test`(省略 `-p`,见 [[cargo-p-package-name-gotcha]]);后端测试用现有 `tests/integration/` 模式(`crate::setup_test_app` + `register_user` + `axum_test::TestServer`,见 `files_test.rs`)。未经用户批准不 commit/push。分支 `feat/layer5-web-adapt`。

---

## File Structure

**新建(后端):**
- 无新文件;`raw` 端点加到 `src-server/src/routes/files.rs`

**新建(前端):**
- `src/lib/file-url.ts` — 统一 `fileUrlForPath`(桌面)/ `fileBlobUrl`(web) helper(取代散落 convertFileSrc;web 下 fetch raw→blob)
- `src/lib/file-url.test.ts`
- `src/components/web/web-image.tsx` — web 异步图片(raw→blob)
- `src/components/web/web-ingest-panel.tsx` — web 摄取组件(input file 多选 + 上传 + 触发 + 轮询)
- `src/components/web/web-ingest-panel.test.tsx`
- `src/components/web/project-picker.tsx` — web 版 team→project 选择器
- `src/components/web/project-picker.test.tsx`

**修改(前端):**
- `src/lib/markdown-image-resolver.ts` — convertFileSrc→fileUrlForPath(桌面不变,web 返回 null 走 WebImage)
- `src/components/editor/file-preview.tsx` — ImagePreview/VideoPreview/AudioPreview 接入 caps(WebImage)
- `src/components/settings/settings-view.tsx` — api-server/source-watch/scheduled-import/mineru section 按 caps gate 隐藏
- `src/components/layout/file-tree.tsx` — openProjectFolder 按钮 gate
- `src/App.tsx` — web 完整入口分支(team→project 选择器)

**修改(后端):**
- `src-server/src/routes/files.rs` — `GET /:project_id/raw/*path` 二进制端点
- `src-server/tests/integration/files_test.rs`(新增测试函数)

---

## Task 1: 后端 raw 二进制端点

web 下 `read_file` 对图片走 `read_to_string` 会乱码(spec §8),需一个返回原始字节的端点。复用 `check_project_access` + `storage::safe_resolve`,与 `stat_file`/`read_file` 同款鉴权。

**Files:**
- Modify: `src-server/src/routes/files.rs`
- Create: `src-server/tests/integration/files_raw_test.rs` + 在 `tests/integration/mod.rs` 加 `pub mod files_raw_test;`

> 测试夹具复用 `files_stat_test.rs` 已验证的 setup 模式(register → 查 team_id → POST /projects → 落盘 fixture),不引入任何不存在的 helper。

- [ ] **Step 1: 写失败测试**

新建 `src-server/tests/integration/files_raw_test.rs`(照 `files_stat_test.rs` 的 setup 模式:register → 查 personal team_id → POST /projects;在 `tests/integration/mod.rs` 加 `pub mod files_raw_test;`):

```rust
/// files raw 二进制端点集成测试(Layer 5 期2 Task 1)。
/// 复用 files_stat_test.rs 的 setup 模式(register → 查 team_id → POST /projects → 落盘)。
use axum::http::StatusCode;
use std::sync::atomic::{AtomicU64, Ordering};

static COUNTER: AtomicU64 = AtomicU64::new(0);

async fn setup() -> (axum_test::TestServer, llm_wiki_server::AppState, i32, String) {
    let (app, state) = crate::setup_test_app().await;
    let server = axum_test::TestServer::new(app).unwrap();
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let username = format!("fraw_{}_{}", std::process::id(), n);
    let token = crate::register_user(&server, &username, &format!("{}@t.com", username), "password123").await;

    // register 已建 personal team,查出 team_id
    let team_id: i32 = sqlx::query_scalar(
        "SELECT id FROM teams WHERE created_by = (SELECT id FROM users WHERE username = $1)",
    )
    .bind(&username)
    .fetch_one(&state.db)
    .await
    .unwrap();

    // 建 project
    let resp = server
        .post("/api/v1/projects")
        .add_header("authorization", format!("Bearer {}", token))
        .json(&serde_json::json!({"name": format!("fraw-proj-{}-{}", std::process::id(), n), "team_id": team_id}))
        .await;
    assert_eq!(resp.status_code(), StatusCode::CREATED);
    let pid = resp.json::<serde_json::Value>()["id"].as_i64().unwrap() as i32;
    (server, state, pid, token)
}

/// 写二进制 fixture 到 {storage}/teams/{team}/projects/{pid}/{name}。
async fn write_binary_fixture(state: &llm_wiki_server::AppState, pid: i32, name: &str, bytes: &[u8]) {
    let team_id: i32 = sqlx::query_scalar("SELECT team_id FROM projects WHERE id = $1")
        .bind(pid)
        .fetch_one(&state.db)
        .await
        .unwrap();
    let base = std::path::PathBuf::from(state.config.storage_path())
        .join("teams").join(team_id.to_string())
        .join("projects").join(pid.to_string());
    std::fs::create_dir_all(base.join(name).parent().unwrap()).unwrap();
    std::fs::write(base.join(name), bytes).unwrap();
}

#[tokio::test]
async fn raw_endpoint_serves_binary_bytes() {
    let (server, _state, pid, token) = setup().await;
    // PNG 文件头签名:若走 read_to_string 会乱码,raw 必须返回精确字节
    let png_header: &[u8] = &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
    write_binary_fixture(&_state, pid, "wiki/media/test.png", png_header).await;

    let r = server
        .get(&format!("/api/v1/files/{}/raw/wiki/media/test.png", pid))
        .add_header("authorization", format!("Bearer {}", token))
        .await;
    assert_eq!(r.status_code(), StatusCode::OK);
    assert_eq!(r.as_bytes(), png_header, "raw must return exact bytes, not text");
}

#[tokio::test]
async fn raw_endpoint_rejects_path_traversal() {
    let (server, _state, pid, token) = setup().await;
    let r = server
        .get(&format!("/api/v1/files/{}/raw/..%2F..%2Fetc%2Fpasswd", pid))
        .add_header("authorization", format!("Bearer {}", token))
        .await;
    assert_eq!(r.status_code(), StatusCode::BAD_REQUEST);
}
```

> 路径遍历用例:URL 编码的 `..` 经 axum 解码后传给 `safe_resolve`,后者检测越界返回 `BadRequest`(与 stat_file 同款)。`write_binary_fixture` 落盘而非走 POST /files,因全新项目 storage base 尚不存在、POST /files 的 safe_resolve canonicalize 会 500(pre-existing,见 files_stat_test.rs 同款注释)。

- [ ] **Step 2: 验证失败**

Run: `cd src-server && cargo test --test integration files_raw -- --nocapture`
Expected: FAIL(路由不存在 → 404)

- [ ] **Step 3: 实现 raw 端点**

在 `src-server/src/routes/files.rs` 的 `file_routes()` 里,`stat` 路由之后、`/*path` 通配符路由之前加(通配符顺序:upload → list → stat → raw → /*path;matchit 0.7 静态段 `raw` 优先于 `*path` 通配符,故 stat→raw→/*path 顺序正确):

```rust
.route("/:project_id/raw/*path", axum::routing::get(raw_file))
```

在文件内(其它 handler 旁)加 handler:

```rust
use axum::response::Response;
use axum::body::Body;

// GET /api/v1/files/:project_id/raw/*path — 二进制原始字节(图片/视频/音频/pdf)
// read_file 用 read_to_string 对图片会乱码,故 raw 端点直接吐字节流。
pub async fn raw_file(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Path((project_id, path)): Path<(i32, String)>,
) -> Result<Response<Body>, AppError> {
    let (_user_id, team_id) = check_project_access(&state, &headers, project_id).await?;
    let base = storage::project_base(&state.config.storage_path(), team_id, project_id);
    let full = storage::safe_resolve(&base, &path)?;
    let bytes = tokio::fs::read(&full)
        .await
        .map_err(|_| AppError::ResourceNotFound("file".into()))?;
    let mime = mime_guess::from_path(&full)
        .first_or_octet_stream()
        .essence_str()
        .to_string();
    Ok(Response::builder()
        .status(StatusCode::OK)
        .header("content-type", mime)
        .header("cache-control", "private, max-age=3600")
        .body(Body::from(bytes))
        .unwrap())
}
```

> `mime_guess`:若未在 Cargo.toml,加 `mime_guess = "2"` 到 `[dependencies]`。`storage::safe_resolve` / `storage::project_base` 已存在(stat_file 用同款)。`AppError::NotFound` routes 通用。

- [ ] **Step 4: 验证通过**

Run: `cd src-server && cargo test --test integration files_raw -- --nocapture`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src-server/src/routes/files.rs src-server/Cargo.toml src-server/tests/integration/files_raw_test.rs src-server/tests/integration/mod.rs
git commit -m "feat(layer5): raw 二进制端点(图片/媒体,web 预览用)"
```

---

## Task 2: fileUrl() 图片/媒体预览降级 helper

散落的 `convertFileSrc`(file-preview.tsx 三处 + markdown-image-resolver.ts)在 web 下不可用(Tauri webview 协议)。统一 helper:桌面走 convertFileSrc(行为不变),web 走 fetch raw→blob→createObjectURL(spec §8)。

**Files:**
- Create: `src/lib/file-url.ts`
- Test: `src/lib/file-url.test.ts`
- Modify: `src/lib/api-client.ts`(补 `base` getter,若缺)

- [ ] **Step 1: 写失败测试**

```ts
// src/lib/file-url.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

describe("file-url", () => {
  beforeEach(() => {
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn((_: Blob) => "blob:mock-123"),
      revokeObjectURL: vi.fn(),
    })
    ;(globalThis as any).__currentProjectId = 42
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    ;(globalThis as any).__currentProjectId = undefined
    vi.restoreAllMocks()
  })

  it("fileBlobUrl web 环境走 fetch raw → blob URL", async () => {
    vi.stubGlobal("window", {})
    const fakeBlob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" })
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, blob: () => Promise.resolve(fakeBlob) })
    vi.stubGlobal("fetch", fetchMock)
    const { fileBlobUrl } = await import("./file-url")
    const url = await fileBlobUrl(42, "wiki/media/a.png")
    expect(url).toBe("blob:mock-123")
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/files/42/raw/wiki/media/a.png"),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: expect.stringContaining("Bearer") }) }),
    )
    expect(URL.createObjectURL).toHaveBeenCalledWith(fakeBlob)
  })

  it("fileBlobUrl 无 token 时后端 401 → reject", async () => {
    vi.stubGlobal("window", {})
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }))
    const { fileBlobUrl } = await import("./file-url")
    await expect(fileBlobUrl(42, "x.png")).rejects.toThrow()
  })

  it("CURRENT_PROJECT_ID 反映 __currentProjectId", async () => {
    const { CURRENT_PROJECT_ID } = await import("./file-url")
    ;(globalThis as any).__currentProjectId = 7
    expect(CURRENT_PROJECT_ID()).toBe(7)
    ;(globalThis as any).__currentProjectId = undefined
    expect(CURRENT_PROJECT_ID()).toBeNull()
  })
})
```

- [ ] **Step 2: 验证失败**

Run: `npm test -- file-url`
Expected: FAIL "Cannot find module './file-url'"

- [ ] **Step 3: 实现**

```ts
// src/lib/file-url.ts
import { convertFileSrc } from "@tauri-apps/api/core"
import { caps } from "@/lib/capabilities"
import { apiClient } from "@/lib/api-client"

export function CURRENT_PROJECT_ID(): number | null {
  return (globalThis as any).__currentProjectId ?? null
}

/** 同步取 URL:桌面用 convertFileSrc;web 同步不可用(blob 需 async fetch)返回 null。 */
export function fileUrlForPath(
  absOrRelPath: string,
  platform: "tauri" | "web" = caps.platform,
): string | null {
  if (platform === "tauri") return convertFileSrc(absOrRelPath)
  return null
}

/** 异步取 blob URL(web):fetch raw(带 Authorization)→ blob → createObjectURL。调用方卸载时 revoke。 */
export async function fileBlobUrl(projectId: number, relPath: string): Promise<string> {
  const url = `${apiClient.base}/api/v1/files/${projectId}/raw/${encodeURI(relPath)}`
  const resp = await fetch(url, { headers: apiClient.authHeaders() })
  if (!resp.ok) throw new Error(`raw fetch failed: HTTP ${resp.status}`)
  const blob = await resp.blob()
  return URL.createObjectURL(blob)
}
```

- [ ] **Step 3b: api-client 暴露 base getter(若缺)**

若 `api-client.ts` 的 `apiClient` 无 `base`,在 class 内加 getter:

```ts
get base(): string {
  return API_BASE
}
```

> `apiClient.base` 在 Task 2 实现与 Task 5/6 调用处统一用属性写法。

- [ ] **Step 4: 验证通过**

Run: `npm test -- file-url`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/lib/file-url.ts src/lib/file-url.test.ts src/lib/api-client.ts
git commit -m "feat(layer5): fileUrl() 图片/媒体预览降级 helper(web 走 raw+blob)"
```

---

## Task 3: markdown-image-resolver + 图片渲染全链路接入 fileUrl

将散落的 `convertFileSrc` 接入 Task 2 的 fileUrl。桌面行为不变,web 走异步 blob(新增 WebImage 组件)。

> **关键**:`resolveMarkdownImageSrc` 在 web 下返回 null 后,所有把它的返回值塞 `<img src>` 的调用方(file-preview / wiki-reader / search-view / chat-message 共 5 处)都必须接 WebImage 的 web 分支,否则 markdown 正文图片全部 src=null 失效——这正是 spec §8 图片降级的核心目标。只改 file-preview 会漏掉 wiki 正文/chat/搜索三处的正文图片。

**Files:**
- Create: `src/components/web/web-image.tsx`
- Modify: `src/lib/markdown-image-resolver.ts` — 内部 convertFileSrc→fileUrlForPath(web 返回 null)
- Modify: `src/components/editor/file-preview.tsx` — ImagePreview 接 WebImage
- Modify: `src/components/editor/wiki-reader.tsx` — react-markdown `img` 组件 web 分支(resolveMarkdownImageSrc 返回 null 时用 WebImage)
- Modify: `src/components/search/search-view.tsx` — 搜索结果缩略图 web 分支(行 352/453)
- Modify: `src/components/chat/chat-message.tsx` — chat 正文图片 web 分支(行 781)
- Test: `src/lib/markdown-image-resolver.test.ts`

- [ ] **Step 1: 写失败测试(回归保护)**

追加到 `src/lib/markdown-image-resolver.test.ts` 现有 describe:

```ts
it("web 平台 resolveMarkdownImageSrc 返回 project-relative(供 WebImage/raw,非 null)", async () => {
  vi.resetModules()
  vi.doMock("@/lib/capabilities", () => ({ caps: { platform: "web" } }))
  const { resolveMarkdownImageSrc } = await import("./markdown-image-resolver")
  // 相对 src 相对 currentFileDir 解析为绝对,再转 project-relative(给 raw 端点 path)
  const r = resolveMarkdownImageSrc("media/a/img.png", "/proj", "/proj/wiki/concepts")
  expect(r).toBe("wiki/concepts/media/a/img.png")
  expect(r).not.toBeNull()
  vi.doUnmock("@/lib/capabilities")
})
```

- [ ] **Step 2: 验证失败**

Run: `npm test -- markdown-image-resolver`
Expected: FAIL(web 下当前桌面分支返回非 null)

- [ ] **Step 3: 实现 WebImage + markdown-image-resolver 接入**

新建 `src/components/web/web-image.tsx`:

```tsx
import { useEffect, useState } from "react"
import { caps } from "@/lib/capabilities"
import { fileBlobUrl, CURRENT_PROJECT_ID } from "@/lib/file-url"

/** web 下异步加载图片(raw→blob),桌面下不使用此组件。 */
export function WebImage({ relPath, alt, className }: { relPath: string; alt?: string; className?: string }) {
  const [url, setUrl] = useState<string | null>(null)
  const pid = CURRENT_PROJECT_ID()
  useEffect(() => {
    if (caps.platform !== "web" || pid == null) return
    let revoke: string | null = null
    let cancelled = false
    fileBlobUrl(pid, relPath).then((u) => {
      if (cancelled) { URL.revokeObjectURL(u); return }
      revoke = u
      setUrl(u)
    }).catch(() => setUrl(null))
    return () => { if (revoke) URL.revokeObjectURL(revoke); cancelled = true }
  }, [relPath, pid])
  if (!url) return <div className={className} aria-label={alt} />
  return <img src={url} alt={alt} className={className} />
}
```

`markdown-image-resolver.ts`:**核心修正(P1-2)——web 下不能返回 null**(会丢失已解析路径,WebImage/raw 拿不到 project-relative → 404)。改为 caps 分支:桌面 `convertFileSrc(abs)`(URL 不变),web 返回 **project-relative**(abs strip projectPath,供 WebImage 传给 raw 端点)。新增内部 helper:

```ts
import { caps } from "@/lib/capabilities"
import { normalizePath } from "@/lib/path-utils" // 本文件已 import

/** 绝对路径 → project-relative(web 给 raw 端点;raw path 相对 project root)。 */
function absoluteToProjectRel(absolute: string, projectPath: string): string {
  const a = normalizePath(absolute).replace(/^\/+/, "").replace(/\\/g, "/")
  const p = normalizePath(projectPath).replace(/^\/+/, "").replace(/\\/g, "/")
  if (a.startsWith(p + "/")) return a.slice(p.length + 1)
  if (a === p) return ""
  return a // 不在 project 内:原样(raw 多半 404,保留诊断)
}

/** 解析后的绝对路径 → 桌面 convertFileSrc URL / web project-relative。 */
function resolvedToSrc(absolute: string, projectPath: string): string {
  return caps.platform === "web" ? absoluteToProjectRel(absolute, projectPath) : convertFileSrc(absolute)
}
```

把现有所有 `return convertFileSrc(absolute)`(absolute 分支 line 119 + 相对 src 分支末尾)改为 `return resolvedToSrc(absolute, pp)`(`pp = normalizePath(projectPath)`)。`resolveMarkdownImageSrc` 仍返回 `string`(桌面 URL 或 web project-rel),**不返回 null**——这样 WebImage 拿到 project-relative 路径传给 raw。PASSTHROUGH_RE(http/blob/data/...)分支不变(直接返回 rawSrc)。

- [ ] **Step 4: 接入 5 个渲染调用方(关键:不只是 file-preview)**

> **P1-2 关键修正**:web 分支 `WebImage` 的 `relPath` 必须是 `resolveMarkdownImageSrc(...)` 解析后的 **project-relative**(Step 3 web 分支返回值),**不是原始 src**。原始 src 相对 md 文件,而 raw 端点 path 相对 project root——传原始 src 会 404。每处 web 分支统一:`<WebImage relPath={resolveMarkdownImageSrc(src, projectPath, currentFileDir)} />`(无 currentFileDir 的用 2 参;`projectPath` 从 wiki-store 获取)。

(1) `file-preview.tsx` 的 ImagePreview(行 87-88):

```tsx
import { caps } from "@/lib/capabilities"
import { WebImage } from "@/components/web/web-image"

function ImagePreview({ filePath, fileName }: { filePath: string; fileName: string }) {
  if (caps.platform === "web") return <WebImage relPath={resolveMarkdownImageSrc(filePath, projectPath) ?? filePath} alt={fileName} />
  const src = convertFileSrc(filePath) // 桌面不变
  return <img src={src} alt={fileName} />
}
```

(2) `wiki-reader.tsx` 的 react-markdown `img` 组件(行 138-139):桌面分支保留 resolveMarkdownImageSrc,web 分支用 WebImage。注意 react-markdown 的 `img` 拿到的是原始 markdown src(相对路径),web 下把它交给 WebImage 异步解析:

```tsx
import { caps } from "@/lib/capabilities"
import { WebImage } from "@/components/web/web-image"
// ...
img: ({ src, alt, ...props }) => {
  if (caps.platform === "web" && typeof src === "string") {
    return <WebImage relPath={resolveMarkdownImageSrc(src, projectPath, currentFileDir)} alt={alt ?? ""} className="max-w-full rounded border border-border/40" />
  }
  return (
    <img
      src={typeof src === "string" ? resolveMarkdownImageSrc(src, projectPath, currentFileDir) : undefined}
      data-mdsrc={typeof src === "string" ? src : undefined}
      alt={alt ?? ""}
      className="max-w-full rounded border border-border/40"
      loading="lazy"
      {...props}
    />
  )
}
```

(3) `chat-message.tsx`(行 781):同样 web 分支用 WebImage:

```tsx
import { caps } from "@/lib/capabilities"
import { WebImage } from "@/components/web/web-image"
// 原: src={typeof src === "string" ? resolveMarkdownImageSrc(src, projectPath) : undefined}
// 改为(在渲染处):
{caps.platform === "web" && typeof src === "string"
  ? <WebImage relPath={resolveMarkdownImageSrc(src, projectPath) ?? src} alt={alt ?? ""} className="..." />
  : <img src={typeof src === "string" ? resolveMarkdownImageSrc(src, projectPath) : undefined} alt={alt ?? ""} />}
```

(4) `search-view.tsx`(行 352、453 两处缩略图):

```tsx
import { caps } from "@/lib/capabilities"
import { WebImage } from "@/components/web/web-image"
// 原: const src = resolveMarkdownImageSrc(hit.url, projectPath) → <img src={src}/>
// 改为: web 分支用 <WebImage relPath={hit.url} />,桌面保留原 src 逻辑
const src = caps.platform === "web" ? null : resolveMarkdownImageSrc(hit.url, projectPath)
// 渲染:
{caps.platform === "web"
  ? <WebImage relPath={resolveMarkdownImageSrc(hit.url, projectPath) ?? hit.url} alt={hit.title} className="..." />
  : <img src={src ?? undefined} alt={hit.title} className="..." />}
```

> VideoPreview/AudioPreview(file-preview.tsx 行 103/121):web 下视频/音频预览非本期重点,保留 convertFileSrc 但加 caps gate——web 下显示占位文本"预览需下载"即可。

- [ ] **Step 5: 验证通过**

Run: `npm test -- markdown-image-resolver file-preview wiki-reader`
Expected: PASS(含 web 分支;桌面既有用例不回归)

- [ ] **Step 6: 提交**

```bash
git add src/components/web/web-image.tsx src/lib/markdown-image-resolver.ts src/components/editor/file-preview.tsx src/components/editor/wiki-reader.tsx src/components/search/search-view.tsx src/components/chat/chat-message.tsx src/lib/markdown-image-resolver.test.ts
git commit -m "feat(layer5): 图片渲染全链路接入 fileUrl(web raw+blob,含 wiki/chat/search 正文图)"
```

---

## Task 4: 设置页桌面专属 section gate

spec §8:api-server section(web 整个隐藏)、source-watch/scheduled-import(canWatchFiles)、mineru(canRunCli)。用 `caps` gate。web-search/llm-provider/embedding 保留(team 维度)。

**Files:**
- Modify: `src/components/settings/settings-view.tsx`
- Modify: `src/components/settings/sections/about-section.tsx`(clip/api 状态行 gate)
- Test: `src/components/settings/settings-view.test.tsx`

- [ ] **Step 1: 写失败测试**

```tsx
// src/components/settings/settings-view.test.tsx
import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"

describe("settings-view caps gate", () => {
  it("web 平台隐藏 api-server / source-watch / scheduled-import / mineru", async () => {
    vi.doMock("@/lib/capabilities", () => ({
      caps: { platform: "web", canWatchFiles: false, canRunCli: false, canAutoStart: false },
    }))
    const { SettingsView } = await import("./settings-view")
    render(<SettingsView draft={{}} setDraft={() => {}} />)
    expect(screen.queryByTestId("section-tab-api-server")).toBeNull()
    expect(screen.queryByTestId("section-tab-source-watch")).toBeNull()
    expect(screen.queryByTestId("section-tab-scheduled-import")).toBeNull()
    expect(screen.queryByTestId("section-tab-mineru")).toBeNull()
    vi.doUnmock("@/lib/capabilities")
  })

  it("tauri 平台保留全部 section", async () => {
    vi.doMock("@/lib/capabilities", () => ({
      caps: { platform: "tauri", canWatchFiles: true, canRunCli: true, canAutoStart: true },
    }))
    const { SettingsView } = await import("./settings-view")
    render(<SettingsView draft={{}} setDraft={() => {}} />)
    expect(screen.queryByTestId("section-tab-api-server")).not.toBeNull()
    vi.doUnmock("@/lib/capabilities")
  })
})
```

- [ ] **Step 2: 验证失败**

Run: `npm test -- settings-view`
Expected: FAIL(web 下 section tab 仍渲染)

- [ ] **Step 3: 实现**

`settings-view.tsx`:`SECTIONS` 数组(行 ~80-95)改为按 caps 过滤,并给 tab 按钮加 `data-testid`:

```tsx
import { caps } from "@/lib/capabilities"

function buildSections() {
  const all = [
    { id: "general", labelKey: "settings.categories.general", icon: Settings, testId: "section-tab-general" },
    { id: "llm-provider", labelKey: "settings.categories.llm", icon: Cpu, testId: "section-tab-llm-provider" },
    { id: "embedding", labelKey: "settings.categories.embedding", icon: Boxes, testId: "section-tab-embedding" },
    { id: "multimodal", labelKey: "settings.categories.multimodal", icon: Eye, testId: "section-tab-multimodal" },
    { id: "web-search", labelKey: "settings.categories.webSearch", icon: Search, testId: "section-tab-web-search" },
    { id: "output", labelKey: "settings.categories.output", icon: FileOutput, testId: "section-tab-output" },
    { id: "interface", labelKey: "settings.categories.interface", icon: Palette, testId: "section-tab-interface" },
    { id: "network", labelKey: "settings.categories.network", icon: Globe, testId: "section-tab-network" },
    { id: "source-watch", labelKey: "settings.categories.sourceWatch", icon: FolderSync, testId: "section-tab-source-watch" },
    { id: "scheduled-import", labelKey: "settings.categories.scheduledImport", icon: CalendarClock, testId: "section-tab-scheduled-import" },
    { id: "mineru", labelKey: "settings.categories.mineru", icon: ScanLine, testId: "section-tab-mineru" },
    { id: "api-server", labelKey: "settings.categories.apiServer", icon: Server, testId: "section-tab-api-server" },
    { id: "logs", labelKey: "settings.categories.logs", icon: ScrollText, testId: "section-tab-logs" },
    { id: "maintenance", labelKey: "settings.categories.maintenance", icon: Wrench, testId: "section-tab-maintenance" },
    { id: "okf-export", labelKey: "settings.categories.okfExport", icon: FileDown, testId: "section-tab-okf-export" },
    { id: "changelog", labelKey: "settings.categories.changelog", icon: History, testId: "section-tab-changelog" },
    { id: "about", labelKey: "settings.categories.about", icon: Info, testId: "section-tab-about" },
  ]
  return all.filter((s) => {
    if (s.id === "api-server") return caps.platform === "tauri"
    if (s.id === "source-watch" || s.id === "scheduled-import") return caps.canWatchFiles
    if (s.id === "mineru") return caps.canRunCli
    return true
  })
}
const SECTIONS = buildSections()
```

> tab 渲染处给按钮加 `data-testid={s.testId}`。`about-section.tsx` 内 clip/api server 状态行按 `caps.canWatchClipboard` / `caps.platform==='tauri'` 包裹(若该 section 引用了 clipServerStatus/apiServerStatus)。

- [ ] **Step 4: 验证通过**

Run: `npm test -- settings-view`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/components/settings/settings-view.tsx src/components/settings/sections/about-section.tsx src/components/settings/settings-view.test.tsx
git commit -m "feat(layer5): 设置页桌面专属 section caps gate"
```

---

## Task 5: web 摄取组件(upload→trigger→poll)

spec §7:web 不复用桌面本地 ingest.ts(依赖绝对路径 + copy/preprocess),走 upload→triggerIngest→轮询 getIngestJob。服务器零改动。

**Files:**
- Create: `src/components/web/web-ingest-panel.tsx`
- Test: `src/components/web/web-ingest-panel.test.tsx`

- [ ] **Step 1: 写失败测试**

```tsx
// src/components/web/web-ingest-panel.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"

const uploadFile = vi.fn()
const triggerIngest = vi.fn()
const getIngestJob = vi.fn()

vi.mock("@/lib/api-client", () => ({
  apiClient: {
    uploadFile: (...a: any[]) => uploadFile(...a),
    triggerIngest: (...a: any[]) => triggerIngest(...a),
    getIngestJob: (...a: any[]) => getIngestJob(...a),
  },
}))

describe("WebIngestPanel", () => {
  beforeEach(() => { uploadFile.mockReset(); triggerIngest.mockReset(); getIngestJob.mockReset() })

  it("上传 → 触发 → 轮询到 done", async () => {
    uploadFile.mockImplementation(async (_pid: number, file: File) => ({
      name: file.name, path: `raw/sources/${file.name}`, size: file.size,
    }))
    triggerIngest.mockResolvedValue({ job_id: "job-1", status: "pending" })
    getIngestJob
      .mockResolvedValueOnce({ id: "job-1", status: "processing", progress: 50, stage: "generating" })
      .mockResolvedValueOnce({ id: "job-1", status: "succeeded", progress: 100, stage: "succeeded" })

    const { WebIngestPanel } = await import("./web-ingest-panel")
    render(<WebIngestPanel projectId={1} onDone={() => {}} />)

    const file = new File(["hello"], "a.md", { type: "text/markdown" })
    fireEvent.change(screen.getByLabelText(/upload/i), { target: { files: [file] } })
    fireEvent.click(screen.getByRole("button", { name: /ingest|摄取/i }))

    await waitFor(() => expect(uploadFile).toHaveBeenCalledWith(1, file, "raw/sources"))
    await waitFor(() => expect(triggerIngest).toHaveBeenCalledWith(1, ["raw/sources/a.md"]))
    await waitFor(() => expect(getIngestJob).toHaveBeenCalledWith("job-1"))
    await waitFor(() => expect(screen.getByText(/完成/)).toBeTruthy())
  })

  it("上传失败显示错误", async () => {
    uploadFile.mockRejectedValue(new Error("upload failed: HTTP 413"))
    const { WebIngestPanel } = await import("./web-ingest-panel")
    render(<WebIngestPanel projectId={1} onDone={() => {}} />)
    fireEvent.change(screen.getByLabelText(/upload/i), { target: { files: [new File(["x"], "b.md")] } })
    fireEvent.click(screen.getByRole("button", { name: /ingest|摄取/i }))
    await waitFor(() => expect(screen.getByText(/upload failed/i)).toBeTruthy())
  })
})
```

- [ ] **Step 2: 验证失败**

Run: `npm test -- web-ingest-panel`
Expected: FAIL "Cannot find module './web-ingest-panel'"

- [ ] **Step 3: 实现**

```tsx
// src/components/web/web-ingest-panel.tsx
import { useState, useRef } from "react"
import { apiClient } from "@/lib/api-client"
import type { IngestJob } from "@/lib/api-types"

interface Props { projectId: number; onDone?: (job: IngestJob) => void }

/** web 摄取:upload → triggerIngest → 轮询 getIngestJob。不复用桌面 ingest.ts(依赖绝对路径)。 */
export function WebIngestPanel({ projectId, onDone }: Props) {
  const [files, setFiles] = useState<File[]>([])
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState("")
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const onSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFiles(Array.from(e.target.files ?? [])); setError(null)
  }

  const run = async () => {
    if (files.length === 0) return
    setBusy(true); setError(null); setStatus("上传中…")
    try {
      const paths: string[] = []
      for (const f of files) {
        const r = await apiClient.uploadFile(projectId, f, "raw/sources")
        paths.push(r.path)
      }
      setStatus("触发摄取…")
      const { job_id } = await apiClient.triggerIngest(projectId, paths)
      setStatus("处理中…")
     let job: IngestJob | undefined
      // 后端 ingest_queue.rs 终态:succeeded(mark_job_succeeded)/failed(mark_job_failed)。
      // 无 done/error;成功=succeeded。轮询上限 150 次(5min),防 worker 卡住死循环。
      for (let i = 0; i < 150; i++) {
        await new Promise((r) => setTimeout(r, 2000))
        job = await apiClient.getIngestJob(job_id)
        if (job.status === "succeeded" || job.status === "failed") break
        setStatus(`处理中… ${job.stage ?? job.status}`)
      }
      if (!job || (job.status !== "succeeded" && job.status !== "failed")) {
        setError("摄取超时(5min 无终态)")
      } else if (job.status === "succeeded") { setStatus("完成"); onDone?.(job) }
      else setError(`摄取失败: ${job.error ?? job.status}`)
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
    } finally { setBusy(false) }
  }

  return (
    <div className="flex flex-col gap-2 p-3 border rounded">
      <input ref={inputRef} type="file" multiple aria-label="upload" className="hidden" onChange={onSelect} />
      <button onClick={() => inputRef.current?.click()} type="button" className="px-3 py-1 border rounded">
        选择文件{files.length > 0 ? ` (${files.length})` : ""}
      </button>
      <button onClick={run} disabled={busy || files.length === 0} type="button"
        className="px-3 py-1 bg-blue-600 text-white rounded disabled:opacity-50">
        {busy ? status : "摄取"}
      </button>
      {error && <p className="text-red-600 text-sm">{error}</p>}
      {!error && status && <p className="text-gray-600 text-sm">{status}</p>}
    </div>
  )
}
```

> `IngestJob.status` 终态值已在 `services/ingest_queue.rs:175,188` 坐实:`succeeded`(mark_job_succeeded)/`failed`(mark_job_failed);无 done/error。轮询 2s x 150 次=5min 上限,防 worker 卡住死循环。

- [ ] **Step 4: 验证通过**

Run: `npm test -- web-ingest-panel`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/components/web/web-ingest-panel.tsx src/components/web/web-ingest-panel.test.tsx
git commit -m "feat(layer5): web 摄取组件(upload→trigger→poll)"
```

---

## Task 6: App web 完整入口(team→project 选择器)

spec §9:web 启动 = 登录→选 team→选/建 project→设 __currentProjectId→加载 graph/pages。

**Files:**
- Create: `src/components/web/project-picker.tsx`
- Test: `src/components/web/project-picker.test.tsx`
- Modify: `src/App.tsx`
- Modify: `src/lib/api-client.ts`(补 getUserTeams/listProjects/createProject,若缺)

- [ ] **Step 1: 写失败测试**

```tsx
// src/components/web/project-picker.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"

const getUserTeams = vi.fn(); const listProjects = vi.fn(); const createProject = vi.fn()
vi.mock("@/lib/api-client", () => ({
  apiClient: {
    getUserTeams: (...a: any[]) => getUserTeams(...a),
    listProjects: (...a: any[]) => listProjects(...a),
    createProject: (...a: any[]) => createProject(...a),
  },
}))

describe("ProjectPicker", () => {
  beforeEach(() => { getUserTeams.mockReset(); listProjects.mockReset(); createProject.mockReset() })

  it("选 team → 选 project → onPick", async () => {
    getUserTeams.mockResolvedValue([{ id: 1, name: "Team A" }])
    listProjects.mockResolvedValue({ items: [{ id: 10, name: "Proj1", team_id: 1 }], next_cursor: null, has_more: false })
    const onPick = vi.fn()
    const { ProjectPicker } = await import("./project-picker")
    render(<ProjectPicker onPick={onPick} />)
    await waitFor(() => expect(screen.getByText("Team A")).toBeTruthy())
    fireEvent.click(screen.getByText("Team A"))
    await waitFor(() => expect(screen.getByText("Proj1")).toBeTruthy())
    fireEvent.click(screen.getByText("Proj1"))
    expect(onPick).toHaveBeenCalledWith({ id: 10, name: "Proj1", team_id: 1 })
  })

  it("建 project", async () => {
    getUserTeams.mockResolvedValue([{ id: 1, name: "Team A" }])
    listProjects.mockResolvedValue({ items: [], next_cursor: null, has_more: false })
    createProject.mockResolvedValue({ id: 20, name: "NewP", team_id: 1 })
    const onPick = vi.fn()
    const { ProjectPicker } = await import("./project-picker")
    render(<ProjectPicker onPick={onPick} />)
    await waitFor(() => expect(screen.getByText("Team A")).toBeTruthy())
    fireEvent.click(screen.getByText("Team A"))
    fireEvent.change(screen.getByPlaceholderText(/项目名/i), { target: { value: "NewP" } })
    fireEvent.click(screen.getByRole("button", { name: /新建/i }))
    await waitFor(() => expect(onPick).toHaveBeenCalledWith({ id: 20, name: "NewP", team_id: 1 }))
  })
})
```

- [ ] **Step 2: 验证失败**

Run: `npm test -- project-picker`
Expected: FAIL "Cannot find module './project-picker'"

- [ ] **Step 3: 实现 ProjectPicker**

```tsx
// src/components/web/project-picker.tsx
import { useEffect, useState } from "react"
import { apiClient } from "@/lib/api-client"

interface Team { id: number; name: string }
interface Proj { id: number; name: string; team_id: number }

/** web 版 team→project 选择器(桌面版走 openProject 本地路径,不复用)。 */
export function ProjectPicker({ onPick }: { onPick: (p: Proj) => void }) {
  const [teams, setTeams] = useState<Team[]>([])
  const [teamId, setTeamId] = useState<number | null>(null)
  const [projects, setProjects] = useState<Proj[]>([])
  const [newName, setNewName] = useState("")
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => { apiClient.getUserTeams().then(setTeams).catch((e) => setErr(String(e))) }, [])
  useEffect(() => {
    if (teamId == null) return
    setProjects([])
    apiClient.listProjects(teamId).then((r) => setProjects(r.items)).catch((e) => setErr(String(e)))
  }, [teamId])

  const create = async () => {
    if (!newName.trim() || teamId == null) return
    try { onPick(await apiClient.createProject(newName.trim(), teamId)) }
    catch (e) { setErr(String(e)) }
  }

  return (
    <div className="flex flex-col gap-4 p-6 max-w-md mx-auto">
      <h2 className="text-xl">选择工作空间</h2>
      {err && <p className="text-red-600 text-sm">{err}</p>}
      {!teamId && teams.map((t) => (
        <button key={t.id} onClick={() => setTeamId(t.id)} className="px-4 py-2 border rounded hover:bg-gray-50">{t.name}</button>
      ))}
      {teamId != null && (
        <>
          {projects.map((p) => (
            <button key={p.id} onClick={() => onPick(p)} className="px-4 py-2 border rounded hover:bg-gray-50">{p.name}</button>
          ))}
          <div className="flex gap-2">
            <input placeholder="项目名" value={newName} onChange={(e) => setNewName(e.target.value)} className="flex-1 px-2 py-1 border rounded" />
            <button onClick={create} className="px-3 py-1 bg-blue-600 text-white rounded">新建</button>
          </div>
          <button onClick={() => setTeamId(null)} className="text-sm text-gray-500">← 返回 team</button>
        </>
      )}
    </div>
  )
}
```

- [ ] **Step 4: 验证通过(Picker 单测)**

Run: `npm test -- project-picker`
Expected: PASS

- [ ] **Step 5: 复用期1 api-client(已有正确方法)+ App.tsx 接入**

期1 `api-client.ts` **已实现**这三个方法(正确端点,Task 4 落地):`getUserTeams()`(GET `/api/v1/users/me/teams`)、`listProjects(teamId?)`(GET `/api/v1/projects?team_id=`,返回**分页** `{items, next_cursor, has_more}`)、`createProject(name, teamId)`(POST `/api/v1/projects`)。**复用,不重写**——`routes/projects.rs` 无 `/teams/:id/projects`。ProjectPicker 解 `.items`(见 Step 3)。

`src/App.tsx`:在 `if (!isAuthenticated)` 块之后插入 web project 选择分支(期1 的 openProject caps gate 保留):

```tsx
import { caps } from "@/lib/capabilities"
import { ProjectPicker } from "@/components/web/project-picker"
// ... 在 if (!isAuthenticated) {...} 之后:
if (caps.platform === "web" && (window as any).__currentProjectId == null) {
  return <ProjectPicker onPick={async (p) => {
    const proj = { id: p.id, path: "", name: p.name } as WikiProject
    ;(window as any).__currentProjectId = p.id
    await handleProjectOpened(proj)
  }} />
}
```

> `WikiProject.path` web 下留空(spec §9)。`handleProjectOpened` 期1 已设 `__currentProjectId`。

- [ ] **Step 6: 验证通过 + typecheck**

Run: `npm test -- project-picker App && npm run typecheck`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add src/components/web/project-picker.tsx src/components/web/project-picker.test.tsx src/App.tsx src/lib/api-client.ts
git commit -m "feat(layer5): App web 完整入口(team→project 选择器)"
```

---

## Task 7: openProjectFolder / clip / autostart caps gate 收尾

spec §8 剩余桌面专属调用点。逐个 caps gate,确保 web 不调用桌面 API。

**Files:**
- Modify: `src/components/layout/file-tree.tsx`
- Modify: `src/App.tsx`
- Test: `src/lib/web-gates.test.ts`

- [ ] **Step 1: 写失败测试(回归保护)**

```ts
// src/lib/web-gates.test.ts
import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"

describe("桌面专属调用点 caps gate", () => {
  it("file-tree openProjectFolder 被 caps gate 包裹", () => {
    const src = readFileSync("src/components/layout/file-tree.tsx", "utf8")
    expect(src).toMatch(/caps\.(canRunCli|platform)/)
  })
  it("App.tsx clip-watcher / autostart 被 caps gate 包裹", () => {
    const src = readFileSync("src/App.tsx", "utf8")
    expect(src).toMatch(/caps\.canWatchClipboard|caps\.canAutoStart/)
  })
})
```

- [ ] **Step 2: 验证失败**

Run: `npm test -- web-gates`
Expected: FAIL(gate 未加)

- [ ] **Step 3: 实现**

`src/components/layout/file-tree.tsx`(行 ~110 openProjectFolder 按钮):

```tsx
import { caps } from "@/lib/capabilities"
// 原: <button onClick={async () => { await ln(project.path) }}>...</button>
// 改:
{caps.platform === "tauri" && (
  <button onClick={async () => { await ln(project.path) }}>
    {t("fileTree.ln", { defaultValue: "Open project folder" })}
  </button>
)}
```

`src/App.tsx` init() 内 clip-watcher 启动与 autostart sync:

```tsx
import { caps } from "@/lib/capabilities"
// clip-watcher(行 ~127): 包 if (caps.canWatchClipboard) { ...现有逻辑... }
// autostart sync(行 ~270): 包 if (caps.canAutoStart) { ...现有逻辑... }
```

- [ ] **Step 4: 验证通过**

Run: `npm test -- web-gates && npm run typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/components/layout/file-tree.tsx src/App.tsx src/lib/web-gates.test.ts
git commit -m "feat(layer5): openProjectFolder/clip/autostart caps gate 收尾"
```

---

## 期2 收尾验证

- [ ] **全量测试**:`npm test` + `cd src-server && cargo test` 全绿
- [ ] **typecheck**:`npm run typecheck` 无错
- [ ] **clippy**:`cd src-server && cargo clippy -- -D warnings`(期2 改动文件零 warning)
- [ ] **端到端烟测(手工)**:`npm run build:web` → src-server 启动 → 浏览器:登录→选 team→选/建 project→上传摄取(轮询 done)→浏览图谱/搜索→chat 流式→review 列表/resolve→图片预览(raw blob)→设置页(api-server/source-watch 隐藏)→桌面版 `npm run tauri dev` 全能力零回归

---

## Self-Review(已做)

**Spec 覆盖(期2 范围)**:
- §7 web 摄取(upload→trigger→poll)→ Task 5
- §8 raw 二进制端点 → Task 1
- §8 图片预览降级(convertFileSrc→raw+blob)→ Task 2 + Task 3
- §8 设置页 gate(api-server/source-watch/scheduled-import/mineru)→ Task 4
- §8 openProjectFolder/clip/autostart gate → Task 7
- §9 完整 App 入口(team→project)→ Task 6
- §6.3 review/research 端点方法 → 期1 已加;期2 摄取/review UI 用现有方法
- web-search/llm-provider section 保留(team 维度,spec §8)→ Task 4 未排除
- §13 桌面零回归:所有 gate 在 tauri/canXxx=true 全开

**Placeholder/类型一致性**:
- `IngestJob.status` 终态值(succeeded/failed)已在 `services/ingest_queue.rs:175,188` 坐实;轮询 break 条件与之对齐,无 placeholder
- `getUserTeams`/`listProjects`/`createProject`:Task 6 Step 5 明确"若缺则补"+ 端点核对
- `apiClient.base`(getter):Task 2 Step 3b 明确"若缺加",Task 2 实现统一用 `apiClient.base`
- 后端夹具复用 files_stat_test.rs 已验证的 setup 模式(register→查 team_id→POST /projects→落盘),无假对象、无 placeholder
- WebImage 用 `CURRENT_PROJECT_ID()`(Task 2 定义)+ `fileBlobUrl`(Task 2 定义)——类型一致

**后端测试夹具**:raw 测试核心断言(精确字节 + 路径遍历 400)与 files_test.rs stat/read 测试同模式。

**Review 修正记录(P1/P2,2026-06-23)**:
- **P1-0 前置依赖**:Architecture + 前置依赖段改为"期1 全部 11 tasks 须先完成"(原误称 ServeDir/llm-client 已交付;实际期1 仅做到 Task 5)
- **P1-1 Task 6**:删除错误的 `/teams/:id/projects` 端点(routes 无此路由),改复用期1 api-client(getUserTeams / listProjects 分页 / createProject,正确端点 `/projects`);ProjectPicker 解 `listProjects().items`;测试 mock 改分页 `{items,next_cursor,has_more}`
- **P1-2 Task 3**:markdown-image-resolver web 分支**不返回 null**(会丢路径→raw 404),改返回 project-relative(新 `absoluteToProjectRel` + `resolvedToSrc` helper);WebImage `relPath` 用 `resolveMarkdownImageSrc(...)` 解析结果(非原始 src);Step 1 测试改断言 project-rel
- **P2-1 Task 1**:`AppError::NotFound` → `ResourceNotFound`(error.rs:35 实际 variant)
- **P2-2 Task 2**:`require()` → `await import`(ESM)
- **P2-3 Task 5**:getIngestJob mock 字段 `job_id` → `id`(ingest_queue.rs:38 JobResponse.id)

**P3(实施时核对,plan 未硬改)**:Task 1 路径遍历建议补未编码 `../` 用例( `%2F` axum 解码行为待核实);Task 3/4/7 假定行号(file-preview:87-88、wiki-reader:138-139、chat-message:781、search-view:352/453、settings SECTIONS:80-95、App clip:127/autostart:270)实施时验证;Task 4 SettingsView props/SECTIONS 字段名/lucide icon import 核实;Task 5 `IngestJob.status` 终态(succeeded/failed)核实 ingest_queue.rs:175,188。

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-23-layer5-web-adapt-phase2.md`. Two execution options:

1. Subagent-Driven (recommended) — 每个 task 派新 subagent + 两阶段 review(spec 合规 + 代码质量),task 间快迭代
2. Inline Execution — 本 session 内 executing-plans 批量执行 + checkpoint

Which approach?
