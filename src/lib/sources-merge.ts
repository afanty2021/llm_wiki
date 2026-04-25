/**
 * Merge a page's YAML frontmatter `sources:` array with what the LLM
 * just emitted, so re-ingesting a page that already has a history from
 * another source doesn't silently clobber that history.
 *
 * Why this exists: the stage-2 prompt instructs the LLM to emit
 * `sources: ["${sourceFileName}"]` — with JUST the current source — on
 * every FILE block. The stage-2 prompt also doesn't feed existing page
 * bodies into the context, so the LLM can't see the old sources. If
 * the ingest write were naive, each re-ingest would overwrite the
 * sources array with a single-element list, and the downstream
 * source-delete logic would later treat the page as single-sourced and
 * delete it — losing content contributed by the earlier source.
 *
 * The fix: before writing, read the existing file (if any), parse its
 * sources, union with the freshly emitted sources, rewrite the frontmatter.
 */

/**
 * Extract `sources: [...]` from the YAML frontmatter of a wiki page.
 * Returns `[]` when no sources line is found or parsing fails.
 *
 * Handles both single-line form (`sources: ["a.md", "b.md"]`) and the
 * multi-line YAML list form (`sources:\n  - a.md\n  - b.md`). Single
 * and double quotes on items are stripped; bare items are accepted.
 */
export function parseSources(content: string): string[] {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/)
  const fm = fmMatch ? fmMatch[1] : content

  // Multi-line YAML list form: `sources:\n  - "a.md"\n  - "b.md"`
  const multi = fm.match(/^sources:\s*\n((?:[ \t]+-\s+.+\n?)+)/m)
  if (multi) {
    const out: string[] = []
    for (const line of multi[1].split("\n")) {
      const m = line.match(/^\s+-\s+["']?(.+?)["']?\s*$/)
      if (m && m[1]) out.push(m[1].trim())
    }
    return out
  }

  // Inline form: `sources: ["a.md", "b.md"]` or `sources: []`.
  const inline = fm.match(/^sources:\s*\[([^\]]*)\]/m)
  if (!inline) return []
  const body = inline[1].trim()
  if (body === "") return []
  return body
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter((s) => s.length > 0)
}

/**
 * Rewrite the `sources:` field of a markdown page's frontmatter to the
 * provided array. Preserves every other frontmatter line. If no
 * `sources:` line exists (LLM forgot it), one is inserted just before
 * the closing `---`. If no frontmatter exists at all, returns the
 * content unchanged — we don't manufacture frontmatter for pages the
 * LLM didn't frontmatter-prefix, since that almost certainly means
 * the emission was already malformed and the caller should surface it.
 */
export function writeSources(content: string, sources: string[]): string {
  const fmMatch = content.match(/^(---\n)([\s\S]*?)(\n---)/)
  if (!fmMatch) return content

  const [, openDelim, fmBody, closeDelim] = fmMatch
  const serialized = sources.map((s) => `"${s}"`).join(", ")
  const newLine = `sources: [${serialized}]`

  // Prefer replacing an existing inline `sources:` line in-place so
  // field ordering within the frontmatter stays the same as the LLM
  // emitted it — users don't see fields shuffle around on every
  // re-ingest.
  if (/^sources:\s*\[[^\]]*\]/m.test(fmBody)) {
    const rewritten = fmBody.replace(/^sources:\s*\[[^\]]*\]/m, newLine)
    return `${openDelim}${rewritten}${closeDelim}${content.slice(fmMatch[0].length)}`
  }

  // Replace a multi-line YAML list form with an inline form too —
  // consistent shape across pages makes downstream parsing simpler.
  if (/^sources:\s*\n((?:[ \t]+-\s+.+\n?)+)/m.test(fmBody)) {
    const rewritten = fmBody.replace(
      /^sources:\s*\n((?:[ \t]+-\s+.+\n?)+)/m,
      newLine,
    )
    return `${openDelim}${rewritten}${closeDelim}${content.slice(fmMatch[0].length)}`
  }

  // No sources field at all — append one at the end of the frontmatter.
  const rewritten = `${fmBody}\n${newLine}`
  return `${openDelim}${rewritten}${closeDelim}${content.slice(fmMatch[0].length)}`
}

/**
 * Merge two source lists, case-insensitively deduped. Order of existing
 * entries is preserved; new entries not already present are appended
 * in the order they appear in `incoming`.
 *
 * Case handling: if both lists contain the same name but with different
 * casing (e.g. "Test.md" and "test.md"), the first-seen form wins.
 * This keeps the user's original filename casing stable on disk.
 */
export function mergeSourcesLists(
  existing: readonly string[],
  incoming: readonly string[],
): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const s of [...existing, ...incoming]) {
    const key = s.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(s)
  }
  return out
}

/**
 * The main entry point used from ingest: given the content the LLM
 * just emitted for a page (`newContent`), and whatever is currently on
 * disk at that path (`existingContent`, or null if the page is new),
 * return content whose `sources:` field is the union of both.
 *
 * For new pages: returns newContent unchanged.
 * For existing pages with no frontmatter: returns newContent unchanged
 *   (don't corrupt unconventional files).
 * For existing pages with frontmatter: merges sources, rewrites.
 */
export function mergeSourcesIntoContent(
  newContent: string,
  existingContent: string | null,
): string {
  if (!existingContent) return newContent
  const oldSources = parseSources(existingContent)
  if (oldSources.length === 0) return newContent
  const newSources = parseSources(newContent)
  const merged = mergeSourcesLists(oldSources, newSources)
  // Avoid writing a no-op change: if nothing actually needs merging,
  // hand back the original newContent verbatim so hashes / caches stay
  // stable.
  if (
    merged.length === newSources.length &&
    merged.every((s, i) => s === newSources[i])
  ) {
    return newContent
  }
  return writeSources(newContent, merged)
}
