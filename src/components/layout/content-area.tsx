import { useEffect, useState } from "react"
import { useWikiStore } from "@/stores/wiki-store"
import { ChatPanel } from "@/components/chat/chat-panel"
import { SettingsView } from "@/components/settings/settings-view"
import { SkillsSection } from "@/components/settings/sections/skills-section"
import { SourcesView } from "@/components/sources/sources-view"
import { ReviewView } from "@/components/review/review-view"
import { LintView } from "@/components/lint/lint-view"
import { SearchView } from "@/components/search/search-view"
import { GraphView } from "@/components/graph/graph-view"
import { WebIngestPanel } from "@/components/web/web-ingest-panel"
import { CURRENT_PROJECT_ID } from "@/lib/file-url"
import { caps } from "@/lib/capabilities"
import { PreviewPanel } from "./preview-panel"

export function ContentArea() {
  const activeView = useWikiStore((s) => s.activeView)

  // web 下:sources 桌面是文件夹监控(本地 fs),改用 WebIngestPanel(upload→trigger→poll);
  // lint 依赖桌面 fs 读 wiki 文件,不可用(占位提示);其余视图 wiki/search/graph/review 走
  // HTTP API,web 可用。chat 派发也有平台门控(useBackendAgent 仅 tauri,web 落回
  // streamChat→src-server 代理,见 chat-panel.tsx)。
  const isWeb = caps.platform === "web"

  // Keep SourcesView mounted after its first visit. Opening a source uses the
  // full-width wiki preview, and unmounting the source tree here would discard
  // its scroll position, expanded folders, and incremental row limit. Hiding
  // the mounted view makes closing the preview a true return operation.
  const [hasMountedSources, setHasMountedSources] = useState(activeView === "sources")

  useEffect(() => {
    if (activeView === "sources") setHasMountedSources(true)
  }, [activeView])

  // web 走纯 switch 分发(无本地 sources 树可保活),不进 keep-mounted 分支。
  if (isWeb) return <ActiveContent activeView={activeView} />

  // Include the current view directly so the first navigation to Sources does
  // not wait for the effect above and briefly render an empty content area.
  if (hasMountedSources || activeView === "sources") {
    return (
      <>
        <div className={activeView === "sources" ? "h-full" : "hidden"}>
          <SourcesView />
        </div>
        {activeView !== "sources" && <ActiveContent activeView={activeView} />}
      </>
    )
  }

  return <ActiveContent activeView={activeView} />
}

function ActiveContent({
  activeView,
}: {
  activeView: ReturnType<typeof useWikiStore.getState>["activeView"]
}) {
  switch (activeView) {
    case "chat":
      return <ChatPanel />
    case "wiki":
      return <PreviewPanel />
    case "settings":
      return <SettingsView />
    case "skills":
      return <SkillsView />
    case "sources":
      // 桌面:keep-mounted 分支已渲染 SourcesView,此处返回 null;
      // web:文件夹监控不可用,改走上传摄取面板。
      return caps.platform === "web" ? (
        <WebIngestPanel projectId={CURRENT_PROJECT_ID() ?? 0} />
      ) : null
    case "review":
      return <ReviewView />
    case "lint":
      return caps.platform === "web" ? (
        <WebUnavailableView feature="lint" />
      ) : (
        <LintView />
      )
    case "search":
      return <SearchView />
    case "graph":
      return <GraphView />
    default:
      return <PreviewPanel />
  }
}

/** web 下不可用的桌面专属功能占位提示(依赖本地文件系统)。 */
function WebUnavailableView({ feature }: { feature: string }) {
  return (
    <div className="flex h-full items-center justify-center text-muted-foreground">
      <p className="text-sm">web 版暂不支持「{feature}」(依赖本地文件系统)</p>
    </div>
  )
}

function SkillsView() {
  return (
    <div className="h-full overflow-y-auto px-8 py-6">
      <div className="mx-auto max-w-3xl">
        <SkillsSection />
      </div>
    </div>
  )
}
