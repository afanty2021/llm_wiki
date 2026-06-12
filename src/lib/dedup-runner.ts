/**
 * I/O wrapper that connects the pure dedup algorithm in dedup.ts
 * to the project's filesystem + LLM. The UI layer calls these
 * functions; everything below is about read/write/spawn-llm so
 * the algorithm core stays testable without mocks of all that.
 */
import { listDirectory, readFile, writeFile, deleteFile } from "@/commands/fs"
import { streamChat } from "@/lib/llm-client"
import { normalizePath } from "@/lib/path-utils"
import type { LlmConfig } from "@/stores/wiki-store"
import type { FileNode } from "@/types/wiki"

/**
 * Detection emits a bounded JSON list of duplicate groups — a few tens
 * of tokens per group — so a modest cap covers even a very duplicate-
 * heavy wiki. The cap's real job is a safety net: without it, a model
 * that ignores the reasoning-off lever (an unrecognized reasoning model
 * behind a custom endpoint, e.g. a vLLM Nemotron build) could stream
 * chain-of-thought unbounded until the 30-min backstop fires — which
 * surfaces to the user as a bare "request cancelled". Capping turns a
 * 30-min hang into a fast (truncated) response instead.
 */
const DEDUP_DETECTION_MAX_TOKENS = 8_192

/**
 * Merge rewrites a COMPLETE page that gets written to disk, so it needs
 * a generous cap that won't truncate the canonical content. 16K tokens
 * is ~64KB of text — far beyond any realistic merged entity/concept
 * page — while still bounding a runaway short of the 30-min backstop.
 * Kept local (not the ingest generation ladder) so this module doesn't
 * drag in the heavy ingest dependency graph.
 */
const DEDUP_MERGE_MAX_TOKENS = 16_384
import {
  detectDuplicateGroups,
  extractEntitySummary,
  mergeDuplicateGroup,
  rewriteIndexMd,
  type DedupLlmCall,
  type DuplicateGroup,
  type EntitySummary,
  type MergeResult,
} from "./dedup"
import { loadNotDuplicates } from "./dedup-storage"

/**
 * Wrap streamChat into the (system, user, signal) → string shape
 * the dedup module expects. Same pattern page-merge uses — keeps
 * the algorithm modules free of any LlmConfig knowledge.
 *
 * `maxTokens` is required, not defaulted: detection and merge have
 * very different output-size needs (a tiny JSON list vs. a complete
 * rewritten page), and silently sharing one cap risks truncating a
 * merged page on disk. Forcing each caller to state its budget makes
 * that choice explicit.
 */
export function buildDedupLlmCall(
  llmConfig: LlmConfig,
  maxTokens: number,
): DedupLlmCall {
  return async (systemPrompt, userMessage, signal) => {
    let result = ""
    let streamError: Error | null = null
    await new Promise<void>((resolve) => {
      streamChat(
        llmConfig,
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        {
          onToken: (t) => {
            result += t
          },
          onDone: () => resolve(),
          onError: (err) => {
            streamError = err
            resolve()
          },
        },
        signal,
        // Dedup detection + merge want JSON, never chain-of-thought.
        // Like every other structured caller (ingest, connection-tests,
        // vision-caption, anytxt-search), disable thinking AND cap output
        // so a reasoning-capable model (an Ollama thinking model, or an
        // unrecognized reasoning model behind a custom endpoint) doesn't
        // spend its whole budget on reasoning and run the stream to the
        // 30-min backstop — which surfaces as a bare "Request cancelled".
        { temperature: 0.1, reasoning: { mode: "off" }, max_tokens: maxTokens },
      ).catch((err) => {
        streamError = err instanceof Error ? err : new Error(String(err))
        resolve()
      })
    })
    if (streamError) throw streamError
    return result
  }
}

/** Walk a FileNode tree, yielding every .md file under a given prefix. */
function* walkMd(nodes: FileNode[], prefix: string): Generator<FileNode> {
  for (const node of nodes) {
    if (node.is_dir) {
      if (node.children) yield* walkMd(node.children, prefix)
      continue
    }
    if (node.name.endsWith(".md") && node.path.includes(`${prefix}/`)) {
      yield node
    }
  }
}

/** Convert an absolute filesystem path to a wiki-relative one
 *  (`<project>/wiki/entities/foo.md` → `wiki/entities/foo.md`). */
function toWikiRelative(projectPath: string, absPath: string): string {
  const pp = normalizePath(projectPath)
  const norm = normalizePath(absPath)
  if (norm.startsWith(`${pp}/`)) return norm.slice(pp.length + 1)
  return norm
}

/**
 * Walk wiki/entities/ and wiki/concepts/, build summaries.
 * Pages that fail to parse (no frontmatter, etc.) are skipped
 * silently — they can't participate in dedup anyway.
 */
export async function loadAllEntitySummaries(
  projectPath: string,
): Promise<EntitySummary[]> {
  const pp = normalizePath(projectPath)
  const tree = await listDirectory(pp)
  const out: EntitySummary[] = []
  for (const prefix of ["wiki/entities", "wiki/concepts"]) {
    for (const node of walkMd(tree, prefix)) {
      try {
        const content = await readFile(node.path)
        const rel = toWikiRelative(pp, node.path)
        const summary = extractEntitySummary(rel, content)
        if (summary) out.push(summary)
      } catch {
        // best-effort — skip unreadable pages
      }
    }
  }
  return out
}

/** Read every .md under wiki/ as { path, content }. The path is
 *  the wiki-relative form callers downstream use. */
export async function loadAllWikiPages(
  projectPath: string,
): Promise<{ path: string; content: string }[]> {
  const pp = normalizePath(projectPath)
  const tree = await listDirectory(pp)
  const out: { path: string; content: string }[] = []
  for (const node of walkMd(tree, "wiki")) {
    try {
      const content = await readFile(node.path)
      out.push({ path: toWikiRelative(pp, node.path), content })
    } catch {
      // ignore
    }
  }
  return out
}

/**
 * Stage 1 + 2 from the user's perspective: scan the project for
 * duplicate-candidate groups. Reads notDuplicates whitelist from
 * disk so previously-confirmed false-positives don't reappear.
 */
export async function runDuplicateDetection(
  projectPath: string,
  llmConfig: LlmConfig,
  options: { signal?: AbortSignal } = {},
): Promise<DuplicateGroup[]> {
  const summaries = await loadAllEntitySummaries(projectPath)
  if (summaries.length < 2) return []
  const notDup = await loadNotDuplicates(projectPath)
  const llm = buildDedupLlmCall(llmConfig, DEDUP_DETECTION_MAX_TOKENS)
  return detectDuplicateGroups(summaries, llm, {
    signal: options.signal,
    notDuplicates: notDup,
  })
}

/**
 * Stage 3 + persistence: execute one user-confirmed merge.
 *
 * Steps:
 *   1. Load each group page's full content + every other wiki page
 *   2. Run mergeDuplicateGroup (LLM body merge + frontmatter
 *      union + cross-reference rewrites)
 *   3. Snapshot every touched file to .llm-wiki/page-history/
 *      dedup-<timestamp>/
 *   4. Write canonical content
 *   5. Apply cross-reference rewrites
 *   6. Delete merged-away files
 *   7. Apply index.md rewrite (separate pass — index isn't in
 *      otherWikiPages because removing references is a different
 *      operation than slug-rewriting them)
 */
export async function executeMerge(
  projectPath: string,
  group: DuplicateGroup,
  canonicalSlug: string,
  llmConfig: LlmConfig,
  options: { signal?: AbortSignal } = {},
): Promise<MergeResult> {
  const pp = normalizePath(projectPath)

  // 1. Resolve each group slug to its actual on-disk path + content
  const allPages = await loadAllWikiPages(pp)
  const pathBySlug = new Map<string, string>()
  for (const p of allPages) {
    const base = p.path.split("/").pop() ?? ""
    if (base.endsWith(".md")) {
      pathBySlug.set(base.slice(0, -3), p.path)
    }
  }
  const groupPages: { slug: string; path: string; content: string }[] = []
  for (const slug of group.slugs) {
    const relPath = pathBySlug.get(slug)
    if (!relPath) {
      throw new Error(
        `Slug "${slug}" not found on disk — was the page deleted between detection and merge?`,
      )
    }
    const page = allPages.find((p) => p.path === relPath)
    if (!page) {
      throw new Error(`Internal: page lookup miss for ${relPath}`)
    }
    groupPages.push({ slug, path: relPath, content: page.content })
  }

  const groupPaths = new Set(groupPages.map((p) => p.path))
  const otherPages = allPages.filter((p) => !groupPaths.has(p.path))

  // Merge rewrites a COMPLETE page that gets written to disk, so it gets
  // the generous merge budget — never the small detection cap, which
  // would truncate the canonical content.
  const llm = buildDedupLlmCall(llmConfig, DEDUP_MERGE_MAX_TOKENS)
  const result = await mergeDuplicateGroup(
    {
      group: groupPages,
      canonicalSlug,
      otherWikiPages: otherPages,
    },
    llm,
    { signal: options.signal },
  )

  // 2. Snapshot backup before any writes. If a write fails partway
  //    through, the user has the pre-merge state intact in
  //    .llm-wiki/page-history/.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const backupDir = `${pp}/.llm-wiki/page-history/dedup-${stamp}`
  for (const b of result.backup) {
    const sanitized = b.path.replace(/[/\\]/g, "_")
    await writeFile(`${backupDir}/${sanitized}`, b.content)
  }

  // 3. Write canonical
  await writeFile(`${pp}/${result.canonicalPath}`, result.canonicalContent)

  // 4. Apply rewrites
  for (const r of result.rewrites) {
    await writeFile(`${pp}/${r.path}`, r.newContent)
  }

  // 5. Delete merged-away pages
  for (const dead of result.pagesToDelete) {
    try {
      await deleteFile(`${pp}/${dead}`)
    } catch (err) {
      // Surface as a warning — backup is still safe.
      console.warn(`[dedup] failed to delete ${dead}: ${err}`)
    }
  }

  // 6. Rewrite index.md to drop merged-away entries.
  const indexPath = `${pp}/wiki/index.md`
  const indexEntry = allPages.find((p) => p.path === "wiki/index.md")
  if (indexEntry) {
    const removed = new Set(
      group.slugs.filter((s) => s !== canonicalSlug),
    )
    const rewritten = rewriteIndexMd(indexEntry.content, removed)
    if (rewritten !== indexEntry.content) {
      await writeFile(indexPath, rewritten)
    }
  }

  return result
}
