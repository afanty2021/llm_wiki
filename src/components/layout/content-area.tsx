import { useWikiStore } from "@/stores/wiki-store"
import { ChatPanel } from "@/components/chat/chat-panel"
import { SettingsView } from "@/components/settings/settings-view"
import { SourcesView } from "@/components/sources/sources-view"
import { ReviewView } from "@/components/review/review-view"
import { LintView } from "@/components/lint/lint-view"
import { SearchView } from "@/components/search/search-view"
import { GraphView } from "@/components/graph/graph-view"
import { WebIngestPanel } from "@/components/web/web-ingest-panel"
import { CURRENT_PROJECT_ID } from "@/lib/file-url"
import { caps } from "@/lib/capabilities"

export function ContentArea() {
  const activeView = useWikiStore((s) => s.activeView)

  // web 下:sources 桌面是文件夹监控(本地 fs),改用 WebIngestPanel(upload→trigger→poll);
  // lint 依赖桌面 fs 读 wiki 文件,不可用(占位提示);其余视图 wiki/search/graph/review 走
  // HTTP API,web 可用。chat-panel retrieval 内部另 web gate(见 chat-panel.tsx)。
  switch (activeView) {
    case "settings":
      return <SettingsView />
    case "sources":
      return caps.platform === "web" ? (
        <WebIngestPanel projectId={CURRENT_PROJECT_ID() ?? 0} />
      ) : (
        <SourcesView />
      )
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
      return <ChatPanel />
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
