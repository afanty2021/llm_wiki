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

export interface BlobUrlHandle {
  url: string
  /** 释放 blob 内存(revokeObjectURL 封装)。组件卸载 cleanup 必调,防泄露。 */
  revoke: () => void
}

/** 异步取 blob URL(web 降级):fetch raw(带 Authorization)→ blob → createObjectURL。
 * 返回 {url, revoke} 句柄:调用方在组件卸载 effect cleanup 调 revoke() 释放 blob 内存
 * (createObjectURL 持有 blob 直到 revoke/页面卸载,长会话重复渲染不释放会泄露)。
 * encodeURI 不编码 ? # /(与 statFile 同款),含这些字符的文件名会断 path/query/fragment,
 * 属已知局限;如需支持须按段 encodeURIComponent(超本 helper 范围)。 */
export async function fileBlobUrl(projectId: number, relPath: string): Promise<BlobUrlHandle> {
  const rawUrl = `${apiClient.base}/api/v1/files/${projectId}/raw/${encodeURI(relPath)}`
  const resp = await fetch(rawUrl, { headers: apiClient.authHeaders() })
  if (!resp.ok) throw new Error(`raw fetch failed: HTTP ${resp.status} for ${relPath} (project ${projectId})`)
  const blob = await resp.blob()
  const objectUrl = URL.createObjectURL(blob)
  return { url: objectUrl, revoke: () => URL.revokeObjectURL(objectUrl) }
}
