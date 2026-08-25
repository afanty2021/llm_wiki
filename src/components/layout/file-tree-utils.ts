import type { FileNode } from "@/types/wiki"

export interface ReplaceNodeChildrenResult {
  nodes: FileNode[]
  matched: boolean
}

export function replaceNodeChildren(
  nodes: FileNode[],
  path: string,
  children: FileNode[],
): ReplaceNodeChildrenResult {
  let matched = false
  const next = nodes.map((node) => {
    if (node.path === path) {
      matched = true
      return { ...node, children }
    }
    if (node.children) {
      const result = replaceNodeChildren(node.children, path, children)
      if (result.matched) {
        matched = true
        return { ...node, children: result.nodes }
      }
    }
    return node
  })
  return { nodes: matched ? next : nodes, matched }
}

/**
 * 无字面意义的转写源文件 → 对应衍生 DB 页 `transcripts/<slug>.md` 的路径；其余返回 null。
 * Files 树行用它从 pageTitleByPath 查标题做行内副标签。
 *
 * 两种形态（旧 slug 规则中文折叠的退化，共 74 个）：
 * ① 纯哈希 `sources/transcripts/<8-hex>.md`（纯中文视频名净化为空）；
 * ② 无字母 stem + 哈希 `1-2a892ab6.md`（「1. 提问.mp4」净化后只剩数字前缀）。
 * stem 含字母（`5-Improving-reading-speed-<hash>`）= 可读名，不触发。
 */
export function hashTranscriptDerivedPagePath(node: FileNode): string | null {
  let slug: string | null = null
  if (/^[0-9a-f]{8}\.md$/.test(node.name)) {
    slug = node.name.slice(0, -3) // 形态①：纯哈希即 slug
  } else {
    const m = node.name.match(/^(.+)-[0-9a-f]{8}\.md$/)
    if (m?.[1] && !/[a-zA-Z]/.test(m[1])) {
      slug = node.name.slice(0, -3) // 形态②：完整文件名去 .md 即 slug
    }
  }
  if (!slug) return null
  if (!node.path.includes(`sources/transcripts/${node.name}`)) return null
  return `transcripts/${slug}.md`
}
