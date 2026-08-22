import { invoke } from "@tauri-apps/api/core"
import { invokeTraced } from "@/lib/invoke-traced"
import type { FileNode, WikiProject } from "@/types/wiki"
import { ensureProjectId, upsertProjectInfo } from "@/lib/project-identity"
import { isAbsolutePath } from "@/lib/path-utils"
import { apiClient } from "@/lib/api-client"
import { caps } from "@/lib/capabilities"
import { parseFrontmatter } from "@/lib/frontmatter"
import type { WikiPage } from "@/lib/api-types"
import yaml from "js-yaml"

// 运行时以 caps 为准(env 仅作构建期参考)。web 走 HTTP 降级,桌面直连 Tauri command。
const USE_HTTP = caps.platform === "web"

// ── #1(web):wiki 页面读写与 pages API 对齐 ──
// src-server 摄取只写 wiki_pages 表、不落 storage 文件,files API 对 wiki 页恒 miss。
// readFile 在 stat miss 且路径为 .md 时回落 pages API;writeFile 对已存在的页面
// 走 PUT /page(If-Match 乐观锁),避免把编辑写进存储目录造成 DB/文件内容分叉。

/** 页面 updated_at 缓存(readFile 回落时记录),供随后 writeFile 的 If-Match 复用。 */
const pageUpdatedAt = new Map<string, string>()

/** DB 页路径与消费方路径的双向变体:多数页无 wiki/ 前缀(entities/…),reserved 页带
 *  (wiki/index.md)。知识树/图谱传 DB 原路径,桌面遗留消费方拼 wiki/ 前缀。 */
function pagePathVariants(path: string): string[] {
  const p = path.replace(/^\/+/, "")
  const variants = [p]
  if (p.startsWith("wiki/")) variants.push(p.slice("wiki/".length))
  else variants.push(`wiki/${p}`)
  return variants
}

async function fetchWikiPage(projectId: number, path: string): Promise<WikiPage | null> {
  for (const variant of pagePathVariants(path)) {
    try {
      const page = await apiClient.getPage(projectId, variant)
      pageUpdatedAt.set(`${projectId}:${page.path}`, page.updated_at)
      return page
    } catch {
      // 404(或网络错)→ 试下一变体;全 miss 由调用方按 File not found 语义处理
    }
  }
  return null
}

/** DB 行 → 桌面 .md 文本:content 是纯正文,frontmatter 存 JSON 列,重组 `---\nyaml\n---`。 */
function pageToMarkdownText(page: WikiPage): string {
  const body = page.content ?? ""
  const fm = page.frontmatter
  if (!fm || typeof fm !== "object" || Array.isArray(fm) || Object.keys(fm).length === 0) {
    return body
  }
  return `---\n${yaml.dump(fm, { lineWidth: 120 })}---\n\n${body}`
}

/** 编辑器全文 → PUT body:拆出 frontmatter,余下为 content。 */
function splitMarkdownContents(contents: string): {
  content: string
  frontmatter: Record<string, unknown> | undefined
} {
  const parsed = parseFrontmatter(contents)
  if (!parsed.frontmatter) return { content: contents, frontmatter: undefined }
  return { content: parsed.body, frontmatter: parsed.frontmatter }
}

/** 页面存在则 PUT 更新并返回 true;不存在(404)返回 false 由调用方落回 files API。 */
async function writeWikiPageIfExists(
  projectId: number,
  path: string,
  contents: string,
): Promise<boolean> {
  const page = await fetchWikiPage(projectId, path)
  if (!page) return false
  const { content, frontmatter } = splitMarkdownContents(contents)
  const body = {
    path: page.path,
    title: page.title,
    content,
    frontmatter: frontmatter ?? {},
  }
  const ifMatch = pageUpdatedAt.get(`${projectId}:${page.path}`) ?? page.updated_at
  try {
    await apiClient.updatePage(projectId, page.path, body, ifMatch)
  } catch (err) {
    // 409 stale(读后被并发改):重取 updated_at 重试一次;再冲突则上抛
    if (!/conflict|mismatch/i.test(String(err))) throw err
    const fresh = await apiClient.getPage(projectId, page.path)
    pageUpdatedAt.set(`${projectId}:${fresh.path}`, fresh.updated_at)
    await apiClient.updatePage(projectId, page.path, body, fresh.updated_at)
  }
  return true
}

// 从 store 获取当前 project id
function getCurrentProjectId(): number {
  if (typeof window !== "undefined") {
    return (window as any).__currentProjectId || 0
  }
  return 0
}

/** Raw shape returned by the Rust commands — id is attached client-side. */
interface RawProject {
  name: string
  path: string
}

export async function readFile(
  path: string,
  options?: { extractImages?: boolean },
): Promise<string> {
  if (USE_HTTP) {
    const projectId = getCurrentProjectId()
    // stat 先查:不存在则 throw(模拟 read 缺失语义),避免 HTTP 404 刷 console —— stat 端点
    // 对缺失文件/全新项目 base 返回 exists:false(200)而非 4xx。web 下各 loadX
    // (loadChatHistory/loadLintItems/restoreQueue)首次加载无持久化文件,此守卫消除全新项目
    // 打开时的 read 404 噪声(桌面 invoke 缺失不记 HTTP error,web 需此对齐)。
    const stat = await apiClient.statFile(projectId, path)
    if (stat.exists) {
      const result = await apiClient.readFile(projectId, path)
      return result.content
    }
    // #1(web):wiki 页本体在 DB(wiki_pages)不在存储目录——stat miss 且 .md 时
    // 回落 pages API,重组 frontmatter+正文为桌面 .md 文本。知识树点页、图谱节点
    // 点开、overview 读取都经此回落。
    if (path.endsWith(".md")) {
      const page = await fetchWikiPage(projectId, path)
      if (page) return pageToMarkdownText(page)
    }
    throw new Error("File not found")
  }
  return invokeTraced<string>("read_file", {
    path,
    extractImages: options?.extractImages,
  })
}

export async function writeFile(path: string, contents: string): Promise<void> {
  if (USE_HTTP) {
    const projectId = getCurrentProjectId()
    // #1(web):已存在的 wiki 页写回 DB(PUT /page),防止落存储目录后读取走 files
    // 分支、与 DB 页内容静默分叉。非页面(.json 等运行时文件/新文件)仍走 files API。
    if (path.endsWith(".md") && (await writeWikiPageIfExists(projectId, path, contents))) {
      return
    }
    await apiClient.writeFile(projectId, path, contents)
    return
  }
  assertAbsoluteFsPath("writeFile", path)
  return invokeTraced<void>("write_file", { path, contents })
}

export async function writeFileBase64(path: string, base64: string): Promise<void> {
  if (USE_HTTP) {
    throw new Error("writeFileBase64 is not supported over HTTP")
  }
  assertAbsoluteFsPath("writeFileBase64", path)
  return invoke<void>("write_file_base64", { path, base64 })
}

export async function writeFileAtomic(path: string, contents: string): Promise<void> {
  if (USE_HTTP) {
    return writeFile(path, contents)
  }
  assertAbsoluteFsPath("writeFileAtomic", path)
  return invoke<void>("write_file_atomic", { path, contents })
}

/**
 * List a directory tree. Dot-prefixed entries (`.claude`, `.env`,
 * `.llm-wiki`, …) are hidden by default; pass `includeHidden: true`
 * only for the `raw/sources` content area, where dotfolders are
 * legitimate user-added sources. See `entry_is_visible` in fs.rs.
 */
export interface ListDirectoryOptions {
  includeHidden?: boolean
  maxDepth?: number
}

// In-flight dedupe only: entries are removed when the request settles. Each
// caller receives its own tree copy when a request is actually shared, so
// accidental in-place mutations do not leak across concurrent waiters.
interface PendingListDirectory {
  request: Promise<FileNode[]>
  shared: boolean
}

const pendingListDirectory = new Map<string, PendingListDirectory>()

function cloneFileNodes(nodes: FileNode[]): FileNode[] {
  return nodes.map((node) => ({
    ...node,
    children: node.children ? cloneFileNodes(node.children) : node.children,
  }))
}

export async function listDirectory(
  path: string,
  includeHiddenOrOptions: boolean | ListDirectoryOptions = false,
): Promise<FileNode[]> {
  const options =
    typeof includeHiddenOrOptions === "boolean"
      ? { includeHidden: includeHiddenOrOptions }
      : includeHiddenOrOptions
  const includeHidden = options.includeHidden ?? false
  const maxDepth = options.maxDepth
  if (USE_HTTP) {
    // web 降级:HTTP listFiles 不支持 hidden/depth 过滤,返回完整树。
    const projectId = getCurrentProjectId()
    const items = await apiClient.listFiles(projectId, path)
    return items as unknown as FileNode[]
  }
  const requestKey = JSON.stringify([path, includeHidden, maxDepth ?? null])
  const pending = pendingListDirectory.get(requestKey)
  if (pending) {
    pending.shared = true
    return pending.request.then(cloneFileNodes)
  }

  const request = invokeTraced<FileNode[]>("list_directory", {
    path,
    includeHidden,
    maxDepth,
  }).finally(() => {
    pendingListDirectory.delete(requestKey)
  })
  const entry: PendingListDirectory = { request, shared: false }
  pendingListDirectory.set(requestKey, entry)
  return request.then((nodes) => (entry.shared ? cloneFileNodes(nodes) : nodes))
}

export async function copyFile(
  source: string,
  destination: string,
): Promise<void> {
  if (USE_HTTP) {
    throw new Error("copyFile is desktop-only (web 摄取走 upload→worker)")
  }
  return invoke("copy_file", { source, destination })
}

export async function copyDirectory(
  source: string,
  destination: string,
): Promise<string[]> {
  if (USE_HTTP) {
    throw new Error("copyDirectory is desktop-only")
  }
  return invoke<string[]>("copy_directory", { source, destination })
}

export async function preprocessFile(path: string): Promise<string> {
  if (USE_HTTP) {
    throw new Error(
      "preprocessFile is desktop-only (服务器 read 已做 pdf/docx 提取)",
    )
  }
  return invoke<string>("preprocess_file", { path })
}

export async function deleteFile(path: string): Promise<void> {
  if (USE_HTTP) {
    const projectId = getCurrentProjectId()
    await apiClient.deleteFile(projectId, path)
    return
  }
  return invokeTraced<void>("delete_file", { path })
}

export async function findRelatedWikiPages(
  projectPath: string,
  sourceName: string,
): Promise<string[]> {
  if (USE_HTTP) {
    throw new Error("findRelatedWikiPages is desktop-only")
  }
  return invoke<string[]>("find_related_wiki_pages", { projectPath, sourceName })
}

export async function createDirectory(path: string): Promise<void> {
  if (USE_HTTP) {
    // HTTP files API uses POST write for directory creation
    const projectId = getCurrentProjectId()
    await apiClient.writeFile(projectId, path, "")
    return
  }
  assertAbsoluteFsPath("createDirectory", path)
  return invoke<void>("create_directory", { path })
}

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

export async function getFileMd5(path: string): Promise<string> {
  if (USE_HTTP) {
    throw new Error(
      "getFileMd5 is desktop-only (web 摄取去重由 worker 侧处理)",
    )
  }
  return invoke<string>("get_file_md5", { path })
}

export interface FileHistoryEntry {
  id: string
  path: string
  timestamp: number
  author: string
  tool: string
  content: string
}

export interface FileHistoryStats {
  bytes: number
  files: number
  entries: number
}

export interface FileHistorySettings {
  enabled: boolean
  maxVersionsPerFile: number
}

export async function getFileHistorySettings(projectPath: string): Promise<FileHistorySettings> {
  return invoke<FileHistorySettings>("get_file_history_settings", { projectPath })
}

export async function setFileHistorySettings(
  projectPath: string,
  settings: FileHistorySettings,
): Promise<FileHistorySettings> {
  return invoke<FileHistorySettings>("set_file_history_settings", { projectPath, settings })
}

export async function getFileHistoryStats(projectPath: string): Promise<FileHistoryStats> {
  return invoke<FileHistoryStats>("get_file_history_stats", { projectPath })
}

export async function clearFileHistory(projectPath: string): Promise<void> {
  return invoke<void>("clear_file_history", { projectPath })
}

export async function listFileHistory(projectPath: string, filePath: string): Promise<FileHistoryEntry[]> {
  return invoke<FileHistoryEntry[]>("list_file_history", { projectPath, filePath })
}

export async function restoreFileHistory(projectPath: string, filePath: string, entryId: string): Promise<string> {
  return invoke<string>("restore_file_history", { projectPath, filePath, entryId })
}

export async function applyTextSelectionEdit(input: {
  projectPath: string
  filePath: string
  prefix: string
  selectedText: string
  suffix: string
  replacement: string
}): Promise<string> {
  return invoke<string>("apply_text_selection_edit", input)
}

export interface PageLinkEntry {
  title: string
  path?: string
  snippet?: string
}

export interface PageLinksResponse {
  outgoing: PageLinkEntry[]
  backlinks: PageLinkEntry[]
  missing: PageLinkEntry[]
}

export async function getPageLinks(projectPath: string, filePath: string): Promise<PageLinksResponse> {
  return invoke<PageLinksResponse>("get_page_links", { projectPath, filePath })
}

export async function createMissingWikiPage(
  projectPath: string,
  title: string,
  content?: string,
): Promise<string> {
  return invoke<string>("create_missing_wiki_page", { projectPath, title, content })
}

function assertAbsoluteFsPath(operation: string, path: string): void {
  if (!isAbsolutePath(path)) {
    throw new Error(`${operation} requires an absolute path: ${path}`)
  }
}

export interface FileBase64 {
  base64: string
  mimeType: string
}

/**
 * Read any file off disk as base64 + a guessed mime type.
 */
export async function readFileAsBase64(path: string): Promise<FileBase64> {
  if (USE_HTTP) {
    throw new Error(
      "readFileAsBase64 is desktop-only (web 图片走 raw 端点,见期2)",
    )
  }
  return invoke<FileBase64>("read_file_as_base64", { path })
}

export async function createProject(
  name: string,
  path: string,
): Promise<WikiProject> {
  const raw = await invoke<RawProject>("create_project", { name, path })
  const id = await ensureProjectId(raw.path)
  await upsertProjectInfo(id, raw.path, raw.name)
  return { id, name: raw.name, path: raw.path }
}

export async function openProject(path: string): Promise<WikiProject> {
  const raw = await invoke<RawProject>("open_project", { path })
  const id = await ensureProjectId(raw.path)
  await upsertProjectInfo(id, raw.path, raw.name)
  return { id, name: raw.name, path: raw.path }
}

export async function openProjectFolder(path: string): Promise<void> {
  return invoke<void>("open_project_folder", { path })
}

export async function openPathInProject(projectPath: string, targetPath: string): Promise<void> {
  return invoke<void>("open_path_in_project", { projectPath, targetPath })
}

export async function clipServerStatus(): Promise<string> {
  return invoke<string>("clip_server_status")
}

export async function apiServerStatus(): Promise<string> {
  return invoke<string>("api_server_status")
}

export async function apiServerReloadConfig(): Promise<string> {
  return invoke<string>("api_server_reload_config")
}

export async function mcpServerEntryPath(): Promise<string> {
  return invoke<string>("mcp_server_entry_path")
}
