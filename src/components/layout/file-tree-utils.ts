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
 * 纯哈希名转写源文件（`sources/transcripts/<8-hex>.md`，slug 规则中文折叠的存量形态，
 * 39 个）→ 对应衍生 DB 页 `transcripts/<slug>.md` 的路径；其余返回 null。
 * Files 树行用它从 pageTitleByPath 查标题做行内副标签。
 */
export function hashTranscriptDerivedPagePath(node: FileNode): string | null {
  const m = node.name.match(/^([0-9a-f]{8})\.md$/)
  if (!m) return null
  const marker = `sources/transcripts/${node.name}`
  const at = node.path.indexOf(marker)
  if (at === -1) return null
  return `transcripts/${m[1]}.md`
}
