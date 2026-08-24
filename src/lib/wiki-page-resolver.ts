import type { FileNode } from "@/types/wiki"

export interface ProjectPathIndexEntry {
  name: string
  path: string
}

export interface ProjectPathIndex {
  byPath: ReadonlyMap<string, ProjectPathIndexEntry>
  filesByName: ReadonlyMap<string, readonly ProjectPathIndexEntry[]>
}

export function createEmptyProjectPathIndex(): ProjectPathIndex {
  return { byPath: new Map(), filesByName: new Map() }
}

export function buildProjectPathIndexFromTree(tree: FileNode[]): ProjectPathIndex {
  const byPath = new Map<string, ProjectPathIndexEntry>()
  const filesByName = new Map<string, ProjectPathIndexEntry[]>()

  function walk(nodes: FileNode[]) {
    for (const node of nodes) {
      // Callers may pass overlapping trees (e.g. the full project
      // scan plus a hidden `raw/sources` rescan share the visible
      // source files). Index each path once so `filesByName` buckets
      // don't accumulate duplicate entries.
      if (!byPath.has(node.path)) {
        const entry: ProjectPathIndexEntry = {
          name: node.name,
          path: node.path,
        }
        byPath.set(node.path, entry)
        if (!node.is_dir) {
          const bucket = filesByName.get(node.name)
          if (bucket) bucket.push(entry)
          else filesByName.set(node.name, [entry])
        }
      }
      if (node.is_dir && node.children) walk(node.children)
    }
  }

  walk(tree)
  return { byPath, filesByName }
}

/** web：由 pages API 的 DB 页路径清单构建 path 索引（无文件树可用）。
 *  DB path 形态：内容页无 wiki/ 前缀（concepts/foo.md），reserved 页带（wiki/index.md）；
 *  桌面树形态：<projectRoot>/wiki/<dbPath> 与 <projectRoot>/<dbPath>(reserved)——
 *  与 fs.readFile web 分支的 pagePathVariants（issue #1）同一映射语义。
 *  projectRoot 取 normalizePath(project.path)（web 下为空串 → 条目呈 "/wiki/…"，
 *  与 wiki-reader 的虚拟 wikiRoot "/wiki" 对齐，name 匹配才能命中）。 */
export function buildProjectPathIndexFromPagePaths(
  paths: readonly string[],
  projectRoot: string,
): ProjectPathIndex {
  const byPath = new Map<string, ProjectPathIndexEntry>()
  const filesByName = new Map<string, ProjectPathIndexEntry[]>()
  const root = projectRoot.replace(/\/+$/, "")

  for (const p of paths) {
    const trimmed = p.replace(/^\/+/, "")
    if (!trimmed) continue
    const entryPath = trimmed.startsWith("wiki/")
      ? `${root}/${trimmed}`
      : `${root}/wiki/${trimmed}`
    // 与 buildProjectPathIndexFromTree 相同的按 path 去重语义：
    // 重复清单不得累积 filesByName 桶。
    if (byPath.has(entryPath)) continue
    const name = entryPath.slice(entryPath.lastIndexOf("/") + 1)
    const entry: ProjectPathIndexEntry = { name, path: entryPath }
    byPath.set(entryPath, entry)
    const bucket = filesByName.get(name)
    if (bucket) bucket.push(entry)
    else filesByName.set(name, [entry])
  }

  return { byPath, filesByName }
}

/**
 * Storage 路径（sources/transcripts/…、raw/sources/…）构建索引：与页面构建器同构，
 * 但不加 /wiki 前缀——存储路径本就是项目相对全路径，web 虚拟根下条目为 `/${path}`。
 * 供 web 的 sources 卡片解析（resolveSourceName 的候选 `${projectRoot}/${ref}` 命中）。
 */
export function buildProjectPathIndexFromStoragePaths(
  paths: readonly string[],
  projectRoot: string,
): ProjectPathIndex {
  const byPath = new Map<string, ProjectPathIndexEntry>()
  const filesByName = new Map<string, ProjectPathIndexEntry[]>()
  const root = projectRoot.replace(/\/+$/, "")
  for (const p of paths) {
    const trimmed = p.replace(/^\/+/, "")
    if (!trimmed) continue
    const entryPath = `${root}/${trimmed}`
    if (byPath.has(entryPath)) continue
    const name = entryPath.slice(entryPath.lastIndexOf("/") + 1)
    const entry: ProjectPathIndexEntry = { name, path: entryPath }
    byPath.set(entryPath, entry)
    const bucket = filesByName.get(name)
    if (bucket) bucket.push(entry)
    else filesByName.set(name, [entry])
  }
  return { byPath, filesByName }
}

/**
 * Strip Obsidian-style `[[target]]` or `[[target|alias]]` wrapping
 * from a value, returning `{ slug, label }`. Frontmatter authors
 * (humans and the LLM) sometimes write related entries as
 * wikilinks instead of bare slugs; we want to display the alias
 * (or target) without the bracket noise and look up by target.
 *
 * Non-wikilink input is returned with `slug === label === input`.
 */
export function unwrapWikilink(s: string): { slug: string; label: string } {
  const m = s.match(/^\[\[([^\]|]+)(?:\|([^\]]*))?\]\]$/)
  if (!m) return { slug: s, label: s }
  const target = m[1].trim()
  const alias = m[2]?.trim()
  return { slug: target, label: alias && alias.length > 0 ? alias : target }
}

export type SourceReferenceResolution =
  | { kind: "external"; url: string }
  | { kind: "local"; path: string }
  | { kind: "missing" }

export function resolveSourceReference(
  index: ProjectPathIndex,
  ref: string,
  sourcesRoot: string | null,
): SourceReferenceResolution {
  const trimmedRef = ref.trim()
  const externalUrl = normalizeHttpUrl(trimmedRef)
  if (externalUrl) return { kind: "external", url: externalUrl }
  if (!sourcesRoot) return { kind: "missing" }

  const path = resolveSourceName(index, trimmedRef, sourcesRoot)
  return path ? { kind: "local", path } : { kind: "missing" }
}

/**
 * Return the absolute path of the first indexed file whose basename
 * matches `targetName` and whose path contains `pathContains`.
 * Returns null when nothing matches.
 *
 * Used by the frontmatter panel to resolve `related: [slug]` to a
 * concrete `wiki/.../<slug>.md` path so a chip can navigate, and
 * `sources: [name.pdf]` to a `raw/sources/.../name.pdf` path so a
 * card can open the raw file. We intentionally take the first
 * match in the original FileNode DFS order — duplicate basenames
 * across subfolders are a wiki-author collision the user sees in
 * the file tree anyway, and resolving arbitrarily is no worse than
 * the prior text-only display.
 */
export function findInTreeByName(
  index: ProjectPathIndex,
  targetName: string,
  pathContains: string,
): string | null {
  for (const entry of index.filesByName.get(targetName) ?? []) {
    if (entry.path.includes(pathContains)) return entry.path
  }
  return null
}

/**
 * Resolve a `related:` reference to an absolute wiki page path.
 * Accepts three shapes the wiki has historically written:
 *   1. project-relative path:  `wiki/entities/dpao.md`
 *   2. bare filename with .md: `dpao.md`
 *   3. bare slug:              `dpao`
 * Returns the absolute path of an existing file, or null if none
 * matches. Always restricts the lookup to `wiki/` to avoid pulling
 * in a same-named file from `raw/sources/`.
 */
export function resolveRelatedSlug(
  index: ProjectPathIndex,
  ref: string,
  wikiRoot: string,
): string | null {
  // Path-like → resolve relative to project root (one segment up
  // from wikiRoot).
  if (ref.includes("/")) {
    const projectRoot = wikiRoot.replace(/\/wiki$/, "")
    const target = `${projectRoot}/${ref}`
    const found = findInTreeByPath(index, target)
    return found && found.includes(`${wikiRoot}/`) ? found : null
  }

  const filename = ref.endsWith(".md") ? ref : `${ref}.md`
  return findInTreeByName(index, filename, `${wikiRoot}/`)
}

/**
 * Resolve a `sources:` reference. Accepts:
 *   1. project-relative path:  `wiki/sources/foo.md` or
 *                              `raw/sources/year-2025/q1.pdf`
 *   2. bare filename with ext: `q1.pdf`
 *   3. wiki source-summary:    `foo.md` (in wiki/sources/)
 * Tries wiki/sources/ first when the ref is a bare .md filename
 * (the ingest pipeline writes summary pages there), then falls
 * back to raw/sources/. Returns null if nothing matches.
 */
export function resolveSourceName(
  index: ProjectPathIndex,
  ref: string,
  sourcesRoot: string,
): string | null {
  // sourcesRoot is `<project>/raw/sources` — derive project root
  // and wiki/ root from it.
  const projectRoot = sourcesRoot.replace(/\/raw\/sources$/, "")
  const wikiSources = `${projectRoot}/wiki/sources`

  if (ref.includes("/")) {
    const normalizedRef = ref.replace(/\\/g, "/").replace(/^\/+/, "")
    const candidates = normalizedRef.startsWith("raw/sources/") ||
      normalizedRef.startsWith("wiki/")
      ? [`${projectRoot}/${normalizedRef}`]
      : [
          `${sourcesRoot}/${normalizedRef}`,
          `${projectRoot}/${normalizedRef}`,
        ]

    for (const target of candidates) {
      const found = findInTreeByPath(index, target)
      if (found) return found
    }
    return null
  }

  // Bare .md filename → look in wiki/sources/ first (ingest's
  // canonical home for source-summary pages).
  if (ref.endsWith(".md")) {
    const inWiki = findInTreeByName(index, ref, `${wikiSources}/`)
    if (inWiki) return inWiki
  }

  // Otherwise, search raw/sources/.
  return findInTreeByName(index, ref, `${sourcesRoot}/`)
}

function findInTreeByPath(index: ProjectPathIndex, targetPath: string): string | null {
  const found = index.byPath.get(targetPath)
  return found?.path ?? null
}

function normalizeHttpUrl(ref: string): string | null {
  if (/[\u0000-\u001f\u007f]/u.test(ref)) return null
  try {
    const url = new URL(ref)
    if (url.protocol !== "http:" && url.protocol !== "https:") return null
    if (!url.hostname || url.username || url.password) return null
    return url.href
  } catch {
    return null
  }
}
