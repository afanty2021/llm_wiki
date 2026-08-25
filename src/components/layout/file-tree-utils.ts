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
 * 判定语义：文件名 stem 无 ASCII 字母 = slug 化造成信息退化 → 显示衍生页
 * 规范标题（标点/全形/60 字符截断都在 slug 化中丢失，副标签恢复）。三类：
 * ① 纯哈希 `<8-hex>.md`（旧规则纯中文视频名净化为空，存量 39）；
 * ② 数字 stem `<digits>-<8-hex>.md`（净化后只剩课号，存量 35）；
 * ③ CJK stem（新规则 fe8f11d5 起的中文 slug，如 `01-提问-<hash>`）——
 *   有意纳入：连字符 slug 可读但有损，真标题更完整。
 * stem 含 ASCII 字母（`5-Improving-reading-speed-<hash>`）= slug 无损，不触发。
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
