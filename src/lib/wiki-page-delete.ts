/**
 * Cascade delete for wiki pages.
 *
 * Whenever a wiki page is removed from disk we ALSO need to drop its
 * vector chunks from LanceDB; otherwise the chunks become "phantom"
 * search hits — `searchByEmbedding` returns the orphaned `page_id`
 * but `search.ts` then can't find a matching .md file and silently
 * discards the result, wasting topK slots.
 *
 * This helper consolidates that two-step cleanup so every wiki-page
 * delete path (source-delete cascade in sources-view, orphan-page
 * delete in lint-view, cancelled-ingest cleanup in ingest-queue)
 * uses the SAME slug derivation and order of operations. Without
 * this, each call site reinvented the slug regex slightly
 * differently (`getFileName().replace(/\.md$/, "")` vs
 * `getFileStem()`), which would drift over time.
 *
 * Errors are propagated, NOT swallowed — callers wrap in try/catch
 * to apply their own fault-tolerance policy (e.g. continue with the
 * next file in a batch, or surface to the user via toast).
 */
import { deleteFile } from "@/commands/fs"
import { getFileStem, normalizePath } from "@/lib/path-utils"
import { removePageEmbedding } from "@/lib/embedding"

/**
 * Detect whether a wiki page lives under `wiki/sources/`. We treat
 * those as source-summary pages — each owns its source's extracted
 * images at `wiki/media/<slug>/`. Other wiki paths (concepts,
 * entities, queries, …) don't own image directories of their own,
 * so the media cascade is scoped to source pages only.
 *
 * Tolerates both `/` and `\` separators for Windows.
 */
function isSourcePage(pagePath: string): boolean {
  const normalized = normalizePath(pagePath)
  return normalized.includes("/wiki/sources/")
}

/**
 * Delete a wiki page from disk and drop its embedding chunks. If the
 * page is a source-summary (`wiki/sources/<slug>.md`), ALSO removes
 * the corresponding `wiki/media/<slug>/` directory containing the
 * source's extracted images — those are owned by the source and have
 * no other consumer once the source page is gone.
 *
 * `projectPath` is the project root (used to scope the embedding
 * cascade to the right LanceDB instance, and to locate the media
 * directory).
 *
 * `pagePath` may be absolute or relative; only its basename is used
 * for the page-id lookup, so callers don't need to normalize before
 * calling. The disk delete uses the path verbatim — pass an
 * absolute path if your caller has one (most do).
 */
export async function cascadeDeleteWikiPage(
  projectPath: string,
  pagePath: string,
): Promise<void> {
  await deleteFile(pagePath)
  const slug = getFileStem(pagePath)
  if (slug.length > 0) {
    await removePageEmbedding(projectPath, slug)
  }

  // Media cascade: source-summary deletion → drop the source's
  // image directory. Done AFTER the file delete (and after the
  // embedding cascade) so a failure in either of those — already
  // best-effort tolerated by callers — leaves us in a consistent
  // state. Failures here are logged + swallowed because the source
  // page is already gone; an orphaned media directory is a leak,
  // not a correctness problem.
  //
  // Defensive on the slug: must be non-empty AND not start with `.`
  // — a path like `wiki/sources/.md` (pure extension, no name) or
  // `.git`-style hidden entries should NEVER produce a media path
  // that resolves to a hidden directory under `wiki/media/`. The
  // worst case (slug == ".") would target `wiki/media/.` and delete
  // the entire media root.
  if (isSourcePage(pagePath) && slug.length > 0 && !slug.startsWith(".")) {
    const pp = normalizePath(projectPath)
    const mediaDir = `${pp}/wiki/media/${slug}`
    try {
      // delete_file in fs.rs auto-detects directories and uses
      // remove_dir_all under the hood — see fs.rs L989. So a single
      // deleteFile call handles "may or may not be present" + "may
      // or may not be a directory" gracefully.
      await deleteFile(mediaDir)
    } catch {
      // Most common cause: the directory never existed because no
      // images were extracted from this source. Not an error.
    }
  }
}
