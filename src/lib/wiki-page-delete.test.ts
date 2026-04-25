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
})
