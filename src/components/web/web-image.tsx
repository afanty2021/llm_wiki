import { useEffect, useState } from "react"
import { caps } from "@/lib/capabilities"
import { fileBlobUrl, CURRENT_PROJECT_ID } from "@/lib/file-url"

/**
 * web 下异步加载图片(raw 端点 → blob URL)的组件。桌面版不使用此组件
 * (桌面走 convertFileSrc 同步协议,行为零变化)。
 *
 * `relPath` 必须是 `resolveMarkdownImageSrc` 解析后的 project-relative
 * (raw 端点 path 相对 project root)。组件内部用 `fileBlobUrl` 拉取并
 * 持有 `{url, revoke}` 句柄:卸载时调 revoke() 释放 blob 内存,
 * 防长会话重复渲染泄露(createObjectURL 持有 blob 直到 revoke)。
 *
 * 加载完成前渲染占位 div(保留 className 布局尺寸),失败回退空占位。
 */
export function WebImage({
  relPath,
  alt,
  className,
}: {
  relPath: string
  alt?: string
  className?: string
}) {
  const [url, setUrl] = useState<string | null>(null)
  const pid = CURRENT_PROJECT_ID()

  useEffect(() => {
    // 桌面下不该渲染此组件;无 project id 也无法拉 raw —— 直接返回。
    if (caps.platform !== "web" || pid == null) return
    let revoke: (() => void) | null = null
    let cancelled = false
    fileBlobUrl(pid, relPath)
      .then((handle) => {
        // 组件已卸载:立即释放刚拿到的 blob,防泄露。
        if (cancelled) {
          handle.revoke()
          return
        }
        revoke = handle.revoke
        setUrl(handle.url)
      })
      .catch(() => setUrl(null))
    return () => {
      if (revoke) revoke()
      cancelled = true
    }
  }, [relPath, pid])

  if (!url) return <div className={className} aria-label={alt} />
  return <img src={url} alt={alt} className={className} />
}
