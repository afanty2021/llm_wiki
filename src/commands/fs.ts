import { invoke } from "@tauri-apps/api/core"
import { invokeTraced } from "@/lib/invoke-traced"
import type { FileNode, WikiProject } from "@/types/wiki"
import { ensureProjectId, upsertProjectInfo } from "@/lib/project-identity"
import { isAbsolutePath } from "@/lib/path-utils"
import { apiClient } from "@/lib/api-client"
import { caps } from "@/lib/capabilities"

// 运行时以 caps 为准(env 仅作构建期参考)。web 走 HTTP 降级,桌面直连 Tauri command。
const USE_HTTP = caps.platform === "web"

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
    if (!stat.exists) {
      throw new Error("File not found")
    }
    const result = await apiClient.readFile(projectId, path)
    return result.content
  }
  return invokeTraced<string>("read_file", {
    path,
    extractImages: options?.extractImages,
  })
}

export async function writeFile(path: string, contents: string): Promise<void> {
  if (USE_HTTP) {
    const projectId = getCurrentProjectId()
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
