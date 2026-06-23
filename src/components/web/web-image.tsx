import { useEffect, useRef, useState } from "react"
import { caps } from "@/lib/capabilities"
import { fileBlobUrl, CURRENT_PROJECT_ID } from "@/lib/file-url"
import { createLogger } from "@/lib/logger"

const logger = createLogger("web-image")

/**
 * web 下异步加载图片(raw 端点 → blob URL)。桌面走 convertFileSrc,不用此组件。
 *
 * `relPath` 须为 resolveMarkdownImageSrc 解析后的 project-relative(raw path 相对 project root)。
 * 持有 {url, revoke} 句柄:卸载 cleanup revoke() 释放 blob 内存,防长会话重复渲染泄露。
 *
 * 可见性门控(IntersectionObserver):仅图片进入视口(rootMargin 200px 预加载)时触发 raw fetch,
 * 防搜索网格等场景数百图挂载即扇出鉴权 raw 请求(桌面 <img loading="lazy"> 的等价降级)。
 * 失败 logger.warn 记录,防静默掩盖 raw 端点配置/权限/删除文件等问题。
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
  const [visible, setVisible] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const pid = CURRENT_PROJECT_ID()

  // 可见性门控:进入视口才标记 visible 触发下方 fetch effect。
  useEffect(() => {
    if (caps.platform !== "web" || pid == null) return
    const el = ref.current
    // 无 IntersectionObserver(老环境/SSR)或无 ref:降级为立即加载。
    if (!el || typeof IntersectionObserver === "undefined") {
      setVisible(true)
      return
    }
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true)
          obs.disconnect()
        }
      },
      { rootMargin: "200px" },
    )
    obs.observe(el)
    return () => obs.disconnect()
  }, [pid])

  // visible 后才 fetch raw → blob(防视口外图片扇出请求)。
  useEffect(() => {
    if (!visible || pid == null) return
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
      .catch((err) => {
        logger.warn("WebImage raw fetch 失败", { relPath, projectId: pid, error: String(err) })
        setUrl(null)
      })
    return () => {
      if (revoke) revoke()
      cancelled = true
    }
  }, [relPath, pid, visible])

  // 占位 div 保留 className 布局 + minHeight 防 markdown 正文图加载完切换 img 时布局偏移(CLS)。
  // ref 挂占位上供 IntersectionObserver observe(图片未加载时观察占位)。
  if (!url) return <div ref={ref} className={className} style={{ minHeight: 32 }} aria-label={alt} />
  return <img src={url} alt={alt} className={className} loading="lazy" />
}
