import { apiClient } from "@/lib/api-client"
import { caps } from "@/lib/capabilities"
import { useWikiStore } from "@/stores/wiki-store"

// #4(web)：projectPathIndex 的权威数据源是 pages API（DB 全量路径，含 reserved）。
// 初始构建挂在 project 打开层而非 KnowledgeTree——侧栏折叠（leftCollapsed 跨会话
// 持久）时组件不渲染，索引仍须建立；组件自身加载时以同一清单重建，双入口同源。
export async function buildWebProjectPathIndex(projectId: string | number): Promise<void> {
  if (caps.platform !== "web") return
  // 静默失败会让 wikilink 无声 no-op（评审 Minor #1），至少留一条排查线索。
  try {
    const pages = await apiClient.listPages(Number(projectId))
    // 切项目竞态：响应在飞期间项目已换则丢弃，避免旧路径落进新会话索引。
    if (useWikiStore.getState().project?.id !== String(projectId)) return
    useWikiStore.getState().setProjectPathIndexFromPaths(pages.map((p) => p.path))
  } catch (err) {
    console.warn("[web-path-index] listPages 路径清单构建失败:", err)
  }
}
