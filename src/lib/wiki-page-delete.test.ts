/**
 * Unit tests for cascadeDeleteWikiPage — the one helper that every
 * wiki-page delete flow goes through. By centralizing the cascade
 * here we get test coverage for slug derivation + ordering once,
 * instead of having to test it at every React-component call site.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const mockDeleteFile = vi.fn<(path: string) => Promise<void>>()
const mockRemovePageEmbedding = vi.fn<(projectPath: string, slug: string) => Promise<void>>()

vi.mock("@/commands/fs", () => ({
  deleteFile: (path: string) => mockDeleteFile(path),
  // The other fs functions aren't called by this helper, but the
  // mock factory has to declare them so dynamic imports elsewhere
  // in transitive deps don't break.
  readFile: vi.fn(),
  writeFile: vi.fn(),
  listDirectory: vi.fn(),
}))

vi.mock("@/lib/embedding", () => ({
  removePageEmbedding: (projectPath: string, slug: string) =>
    mockRemovePageEmbedding(projectPath, slug),
}))

import { cascadeDeleteWikiPage } from "./wiki-page-delete"

beforeEach(() => {
  mockDeleteFile.mockReset()
  mockRemovePageEmbedding.mockReset()
  // Default: both succeed silently.
  mockDeleteFile.mockResolvedValue(undefined)
  mockRemovePageEmbedding.mockResolvedValue(undefined)
})

describe("cascadeDeleteWikiPage", () => {
  it("deletes the file, then drops the matching page's embedding chunks", async () => {
    await cascadeDeleteWikiPage("/proj", "/proj/wiki/concepts/rope.md")

    expect(mockDeleteFile).toHaveBeenCalledTimes(1)
    expect(mockDeleteFile).toHaveBeenCalledWith("/proj/wiki/concepts/rope.md")

    expect(mockRemovePageEmbedding).toHaveBeenCalledTimes(1)
    expect(mockRemovePageEmbedding).toHaveBeenCalledWith("/proj", "rope")
  })

  it("calls deleteFile BEFORE removePageEmbedding (file is the source of truth)", async () => {
    // Order matters: if removePageEmbedding ran first and the disk
    // delete then failed, we'd be left with a page on disk with no
    // chunks — every search hit would skip it because vector search
    // returned no chunks for it. Disk delete first means a partial
    // failure leaves stale chunks (acceptable, fixed on next
    // re-index) rather than a stale page (bad UX).
    const order: string[] = []
    mockDeleteFile.mockImplementation(async () => {
      order.push("deleteFile")
    })
    mockRemovePageEmbedding.mockImplementation(async () => {
      order.push("removePageEmbedding")
    })

    await cascadeDeleteWikiPage("/proj", "/proj/wiki/concepts/foo.md")
    expect(order).toEqual(["deleteFile", "removePageEmbedding"])
  })

  it("does NOT call removePageEmbedding when deleteFile throws", async () => {
    // If the file isn't actually gone, dropping its chunks is wrong:
    // the page still exists (e.g. permission-denied) and would lose
    // its searchability while staying on disk.
    mockDeleteFile.mockRejectedValueOnce(new Error("EACCES"))

    await expect(cascadeDeleteWikiPage("/proj", "/proj/wiki/foo.md")).rejects.toThrow("EACCES")

    expect(mockRemovePageEmbedding).not.toHaveBeenCalled()
  })

  it("propagates removePageEmbedding errors to the caller (not silently swallowed)", async () => {
    // Caller decides fault-tolerance policy. Some callers
    // (ingest-queue cleanup, source-delete batches) want to
    // continue past LanceDB hiccups; others (single-page delete
    // from lint view) might want to surface the error.
    mockRemovePageEmbedding.mockRejectedValueOnce(new Error("lancedb table missing"))

    await expect(cascadeDeleteWikiPage("/proj", "/proj/wiki/foo.md")).rejects.toThrow(
      "lancedb table missing",
    )
    // File delete still happened — leaving the cascade half-done
    // is the lesser evil compared to never deleting the file.
    expect(mockDeleteFile).toHaveBeenCalled()
  })

  it("derives slug from the path's basename, ignoring directory segments", async () => {
    await cascadeDeleteWikiPage("/proj", "/proj/wiki/concepts/some-deep/nested/page.md")
    expect(mockRemovePageEmbedding).toHaveBeenCalledWith("/proj", "page")
  })

  it("handles Windows backslash paths (project path normalization happens elsewhere)", async () => {
    // The desktop ingest pipeline can produce backslash-laden paths
    // before path-utils normalizes them. cascadeDeleteWikiPage's
    // slug derivation MUST cope with both separators in one string.
    await cascadeDeleteWikiPage("C:/proj", "C:\\proj\\wiki\\entities\\transformer.md")

    expect(mockDeleteFile).toHaveBeenCalledWith("C:\\proj\\wiki\\entities\\transformer.md")
    expect(mockRemovePageEmbedding).toHaveBeenCalledWith("C:/proj", "transformer")
  })

  it("preserves dotted page names (e.g. foo.bar.md) in the slug", async () => {
    // getFileStem strips only the LAST extension, so "foo.bar.md" → "foo.bar".
    // Pin it: a regression that strips ALL dots would turn this slug
    // into "foo" and orphan the LanceDB chunks for "foo.bar".
    await cascadeDeleteWikiPage("/proj", "/proj/wiki/concepts/foo.bar.md")
    expect(mockRemovePageEmbedding).toHaveBeenCalledWith("/proj", "foo.bar")
  })

  it("skips removePageEmbedding when slug derivation yields empty (defensive)", async () => {
    // Edge case: a path that's just "/" or empty would yield ""
    // slug. Calling removePageEmbedding("") could match every page
    // in some LanceDB filter implementations, which would be
    // catastrophic. The helper guards against this.
    await cascadeDeleteWikiPage("/proj", "/")
    expect(mockDeleteFile).toHaveBeenCalled()
    expect(mockRemovePageEmbedding).not.toHaveBeenCalled()
  })

  // ── Media cascade: source-summary deletion drops images too ──────
  //
  // The image-extraction step writes to wiki/media/<slug>/ keyed by
  // the SOURCE document's slug. The source-summary page at
  // wiki/sources/<slug>.md is the canonical home for those images
  // (we append a markdown section to it post-write). When the
  // source page is deleted (either via source-delete cascade in
  // sources-view, or a manual delete), the matching media directory
  // becomes orphaned — these tests pin that we drop it too.

  it("deleting wiki/sources/<slug>.md also deletes wiki/media/<slug>/", async () => {
    await cascadeDeleteWikiPage("/proj", "/proj/wiki/sources/rope-paper.md")

    expect(mockDeleteFile).toHaveBeenCalledTimes(2)
    expect(mockDeleteFile).toHaveBeenNthCalledWith(1, "/proj/wiki/sources/rope-paper.md")
    expect(mockDeleteFile).toHaveBeenNthCalledWith(2, "/proj/wiki/media/rope-paper")
    expect(mockRemovePageEmbedding).toHaveBeenCalledWith("/proj", "rope-paper")
  })

  it("does NOT cascade media when deleting a non-source page (concept / entity / queries)", async () => {
    // Concept / entity pages don't own a media directory of their own.
    // Multiple pages can reference images from any source's media/.
    // Deleting one concept page must not destroy the source's images.
    await cascadeDeleteWikiPage("/proj", "/proj/wiki/concepts/rope.md")

    expect(mockDeleteFile).toHaveBeenCalledTimes(1)
    expect(mockDeleteFile).toHaveBeenCalledWith("/proj/wiki/concepts/rope.md")

    await cascadeDeleteWikiPage("/proj", "/proj/wiki/entities/transformer.md")
    expect(mockDeleteFile).toHaveBeenCalledTimes(2)
    expect(mockDeleteFile).toHaveBeenLastCalledWith("/proj/wiki/entities/transformer.md")

    await cascadeDeleteWikiPage("/proj", "/proj/wiki/queries/some-query-2026-04-27-150000.md")
    expect(mockDeleteFile).toHaveBeenCalledTimes(3)
  })

  it("media-cascade tolerates a missing media directory (no images were extracted)", async () => {
    // Most wiki/sources/ pages won't have an associated media/<slug>/
    // — only PDF/PPTX/DOCX sources with embedded images do. The
    // delete attempt fails with ENOENT and we swallow it silently.
    mockDeleteFile
      .mockResolvedValueOnce(undefined) // source page delete: OK
      .mockRejectedValueOnce(new Error("ENOENT: no such directory")) // media: doesn't exist

    // Should NOT throw — media absence is normal.
    await expect(
      cascadeDeleteWikiPage("/proj", "/proj/wiki/sources/text-only-source.md"),
    ).resolves.toBeUndefined()
    // Both attempts happened.
    expect(mockDeleteFile).toHaveBeenCalledTimes(2)
    // Embedding cascade still ran in between.
    expect(mockRemovePageEmbedding).toHaveBeenCalledWith("/proj", "text-only-source")
  })

  it("handles Windows backslash paths in the source-page detection", async () => {
    // sources-view in some flows may pass paths that haven't been
    // normalized yet. The detector flips backslashes via
    // normalizePath before matching `/wiki/sources/`.
    await cascadeDeleteWikiPage(
      "C:/proj",
      "C:\\proj\\wiki\\sources\\winsrc.md",
    )

    expect(mockDeleteFile).toHaveBeenCalledTimes(2)
    // Second call is the media dir, normalized to forward slashes
    // because we built it from project path + literal path.
    expect(mockDeleteFile).toHaveBeenNthCalledWith(2, "C:/proj/wiki/media/winsrc")
  })

  it("does not attempt media deletion when slug is empty or hidden (defensive)", async () => {
    // wiki/sources/.md → getFileStem returns ".md" (since lastIndexOf
    // is at position 0, the function falls back to the full name).
    // Without the dot-prefix guard we'd build a media path of
    // `wiki/media/.md`, which is at best a leak and at worst risks
    // touching dotfiles. Both `.md` (slug-from-pure-ext) and `.foo`
    // (hidden-name) must be rejected by the media cascade even though
    // the file delete still happens.
    await cascadeDeleteWikiPage("/proj", "/proj/wiki/sources/.md")
    expect(mockDeleteFile).toHaveBeenCalledTimes(1)
    expect(mockDeleteFile).toHaveBeenCalledWith("/proj/wiki/sources/.md")

    mockDeleteFile.mockClear()
    await cascadeDeleteWikiPage("/proj", "/proj/wiki/sources/.hidden.md")
    expect(mockDeleteFile).toHaveBeenCalledTimes(1)
    expect(mockDeleteFile).toHaveBeenCalledWith("/proj/wiki/sources/.hidden.md")
  })
})
