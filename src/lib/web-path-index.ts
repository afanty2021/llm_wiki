import { apiClient } from "@/lib/api-client"
import { caps } from "@/lib/capabilities"
import { useWikiStore } from "@/stores/wiki-store"

// 存储清单递归深度：sources/transcripts（2 层）与 raw/sources/<书>/<章>（3-4 层）
// 都覆盖；留裕量防未来更深布局（服务端另有 5000 条硬顶）。
const STORAGE_LIST_DEPTH = 6

/**
 * 存储 raw 清单（文件相对路径，不含目录）：一次 `max_depth` 递归列举替代逐目录 N+1。
 * 失败抛出由调用方决定降级——sources 卡片解析缺它只是回退 not-found，不该阻塞索引。
 */
export async function fetchStoragePaths(projectId: string | number): Promise<string[]> {
  const entries = await apiClient.listFiles(Number(projectId), "", STORAGE_LIST_DEPTH)
  return entries.filter((e) => !e.is_dir).map((e) => e.path)
}

// #4(web)：projectPathIndex 的权威数据源是 pages API（DB 全量路径，含 reserved）；
// 存储 raw 清单并入（sources 卡片解析依赖）。初始构建挂在 project 打开层而非
// KnowledgeTree——侧栏折叠（leftCollapsed 跨会话持久）时组件不渲染，索引仍须建立；
// 组件自身加载时以同一数据源重建，双入口同源。
export async function buildWebProjectPathIndex(projectId: string | number): Promise<void> {
  if (caps.platform !== "web") return
  // 静默失败会让 wikilink 无声 no-op（评审 Minor #1），至少留一条排查线索。
  try {
    const [pages, storagePaths] = await Promise.all([
      apiClient.listPages(Number(projectId)),
      fetchStoragePaths(projectId).catch((err) => {
        console.warn("[web-path-index] 存储清单获取失败，sources 解析降级 not-found:", err)
        return [] as string[]
      }),
    ])
    // 切项目竞态：响应在飞期间项目已换则丢弃，避免旧路径落进新会话索引。
    if (useWikiStore.getState().project?.id !== String(projectId)) return
    useWikiStore.getState().setProjectPathIndexFromPaths(pages.map((p) => p.path), storagePaths)
  } catch (err) {
    console.warn("[web-path-index] listPages 路径清单构建失败:", err)
  }
}
