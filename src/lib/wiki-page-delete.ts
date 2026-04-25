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
import { getFileStem } from "@/lib/path-utils"
import { removePageEmbedding } from "@/lib/embedding"

/**
 * Delete a wiki page from disk and drop its embedding chunks.
 *
 * `projectPath` is the project root (used to scope the embedding
 * cascade to the right LanceDB instance).
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
}
