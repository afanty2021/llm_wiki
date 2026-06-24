// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest"

// web 平台:searchWiki 走 apiClient.search(非桌面 invoke search_project)
vi.mock("@/lib/capabilities", () => ({ caps: { platform: "web" } }))
const searchMock = vi.fn()
vi.mock("@/lib/api-client", () => ({
  apiClient: { search: (...a: unknown[]) => searchMock(...a) },
}))

describe("searchWiki web", () => {
  it("web 走 apiClient.search(非 invoke),result.path 保持 project-relative(不拼 pp)", async () => {
    ;(globalThis as { __currentProjectId?: number }).__currentProjectId = 42
    searchMock.mockResolvedValue({
      mode: "hybrid",
      tokenHits: 1,
      vectorHits: 0,
      results: [
        {
          path: "wiki/concepts/a.md",
          title: "A",
          snippet: "snip",
          titleMatch: true,
          score: 1.5,
          images: [],
        },
      ],
    })

    const { searchWiki } = await import("./search")
    // web projectPath=""(真实运行时值),验证不短路、走 HTTP、path 不拼 pp
    const r = await searchWiki("", "test")
    expect(searchMock).toHaveBeenCalledWith(42, "test")
    expect(r).toHaveLength(1)
    expect(r[0].path).toBe("wiki/concepts/a.md") // project-relative,供 web readFile HTTP

    ;(globalThis as { __currentProjectId?: number }).__currentProjectId = undefined
  })
})
