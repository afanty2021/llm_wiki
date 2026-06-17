import { invoke } from "@tauri-apps/api/core"
import { invokeTraced } from "@/lib/invoke-traced"
import type { FileNode, WikiProject } from "@/types/wiki"
import { ensureProjectId, upsertProjectInfo } from "@/lib/project-identity"
import { isAbsolutePath } from "@/lib/path-utils"
import { apiClient } from "@/lib/api-client"

const USE_HTTP = import.meta.env.VITE_USE_HTTP_API === "true"

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

export async function listDirectory(path: string): Promise<FileNode[]> {
  if (USE_HTTP) {
    const projectId = getCurrentProjectId()
    const items = await apiClient.listFiles(projectId, path)
    return items as unknown as FileNode[]
  }
  return invokeTraced<FileNode[]>("list_directory", { path })
}

export async function copyFile(
  source: string,
  destination: string,
): Promise<void> {
  return invoke("copy_file", { source, destination })
}

export async function copyDirectory(
  source: string,
  destination: string,
): Promise<string[]> {
  return invoke<string[]>("copy_directory", { source, destination })
}

export async function preprocessFile(path: string): Promise<string> {
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
  return invoke<boolean>("file_exists", { path })
}

export async function getFileModifiedTime(path: string): Promise<number> {
  return invoke<number>("get_file_modified_time", { path })
}

export async function getFileSize(path: string): Promise<number> {
  return invoke<number>("get_file_size", { path })
}

export async function getFileMd5(path: string): Promise<string> {
  return invoke<string>("get_file_md5", { path })
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
