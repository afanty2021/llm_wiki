// @vitest-environment happy-dom
// #4(web)：projectPathIndex 初始构建提升到 project 打开层——
// buildWebProjectPathIndex 以 pages API 全量 DB 路径建索引，
// 不依赖 KnowledgeTree（可折叠）挂载。
import { describe, it, expect, vi, beforeEach } from "vitest"

const listPages = vi.fn()

vi.mock("@/lib/api-client", () => ({
  apiClient: {
    listPages: (...a: unknown[]) => listPages(...a),
  },
}))

import { useWikiStore } from "@/stores/wiki-store"
import { buildWebProjectPathIndex } from "./web-path-index"

// happy-dom 无 Tauri 全局 → caps.platform === "web"。
describe("buildWebProjectPathIndex", () => {
  beforeEach(() => {
    listPages.mockReset()
    // App.tsx ProjectPicker 形态：path 为空串。
    useWikiStore.setState({ project: { id: "7", path: "", name: "p" } })
    useWikiStore.getState().setProjectPathIndexFromPaths([])
  })

  it("成功后由 DB 全量路径构建 /wiki/… 索引（含 reserved 页）", async () => {
    listPages.mockResolvedValue([
      { path: "concepts/motivation.md" },
      { path: "wiki/index.md" },
    ])

    await buildWebProjectPathIndex("7")

    expect(listPages).toHaveBeenCalledWith(7)
    expect(
      useWikiStore.getState().projectPathIndex.byPath.has("/wiki/concepts/motivation.md"),
    ).toBe(true)
    expect(useWikiStore.getState().projectPathIndex.byPath.has("/wiki/index.md")).toBe(true)
  })

  it("响应在飞期间切了项目：旧清单丢弃，不污染新会话索引", async () => {
    let release: (pages: unknown[]) => void = () => {}
    listPages.mockReturnValue(
      new Promise((resolve) => {
        release = resolve
      }),
    )

    const pending = buildWebProjectPathIndex("7")
    useWikiStore.setState({ project: { id: "9", path: "", name: "next" } })
    release([{ path: "concepts/stale.md" }])
    await pending

    expect(useWikiStore.getState().projectPathIndex.byPath.size).toBe(0)
  })

  it("listPages 失败不抛出，索引保持原状", async () => {
    useWikiStore.getState().setProjectPathIndexFromPaths(["concepts/keep.md"])
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    listPages.mockRejectedValue(new Error("HTTP 500"))

    await expect(buildWebProjectPathIndex("7")).resolves.toBeUndefined()

    expect(
      useWikiStore.getState().projectPathIndex.byPath.has("/wiki/concepts/keep.md"),
    ).toBe(true)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
