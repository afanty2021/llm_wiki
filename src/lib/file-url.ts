import { convertFileSrc } from "@tauri-apps/api/core"
import { caps } from "@/lib/capabilities"
import { apiClient } from "@/lib/api-client"

/** 当前项目 ID(由 App 层注入 window.__currentProjectId);未设置返回 null。 */
export function CURRENT_PROJECT_ID(): number | null {
  return (globalThis as any).__currentProjectId ?? null
}

/** 同步取 URL:桌面用 convertFileSrc(行为不变);web 同步不可用(blob 需 async fetch)返回 null。 */
export function fileUrlForPath(
  absOrRelPath: string,
  platform: "tauri" | "web" = caps.platform,
): string | null {
  if (platform === "tauri") return convertFileSrc(absOrRelPath)
  return null
}

/** 异步取 blob URL(web 降级):fetch raw(带 Authorization)→ blob → createObjectURL。
 * 调用方在组件卸载时需自行 revokeObjectURL 释放内存。 */
export async function fileBlobUrl(projectId: number, relPath: string): Promise<string> {
  const url = `${apiClient.base}/api/v1/files/${projectId}/raw/${encodeURI(relPath)}`
  const resp = await fetch(url, { headers: apiClient.authHeaders() })
  if (!resp.ok) throw new Error(`raw fetch failed: HTTP ${resp.status}`)
  const blob = await resp.blob()
  return URL.createObjectURL(blob)
}
