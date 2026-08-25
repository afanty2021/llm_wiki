// @vitest-environment happy-dom
// #4(web)：projectPathIndex 初始构建提升到 project 打开层——
// buildWebProjectPathIndex 以 pages API 全量 DB 路径 + 存储 raw 清单（递归列举）
// 并入构建索引；存储失败降级纯页面（sources 解析回退 not-found 不阻塞）。
import { describe, it, expect, vi, beforeEach } from "vitest"

const listPages = vi.fn()
const listFiles = vi.fn()

vi.mock("@/lib/api-client", () => ({
  apiClient: {
    listPages: (...a: unknown[]) => listPages(...a),
    listFiles: (...a: unknown[]) => listFiles(...a),
  },
}))

import { useWikiStore } from "@/stores/wiki-store"
import { buildWebProjectPathIndex } from "./web-path-index"

// happy-dom 无 Tauri 全局 → caps.platform === "web"。
describe("buildWebProjectPathIndex", () => {
  beforeEach(() => {
    listPages.mockReset()
    listFiles.mockReset()
    // App.tsx ProjectPicker 形态：path 为空串。
    useWikiStore.setState({ project: { id: "7", path: "", name: "p" } })
    useWikiStore.getState().setProjectPathIndexFromPaths([])
  })

  it("成功后由 DB 页面 + 存储 raw 清单合并构建（页 /wiki 前缀、存储原样路径）", async () => {
    listPages.mockResolvedValue([
      { path: "concepts/motivation.md", title: "学习动机" },
      { path: "wiki/index.md" },
    ])
    listFiles.mockResolvedValue([
      { name: "transcripts", path: "sources/transcripts", is_dir: true, size: 0 },
      { name: "a.md", path: "sources/transcripts/a.md", is_dir: false, size: 5 },
      { name: "Ch01.md", path: "raw/sources/book/Ch01.md", is_dir: false, size: 5 },
    ])

    await buildWebProjectPathIndex("7")

    expect(listFiles).toHaveBeenCalledWith(7, "", 6)
    expect(listPages).toHaveBeenCalledWith(7)
    const index = useWikiStore.getState().projectPathIndex
    expect(index.byPath.has("/wiki/concepts/motivation.md")).toBe(true)
    expect(index.byPath.has("/wiki/index.md")).toBe(true)
    expect(index.byPath.has("/sources/transcripts/a.md")).toBe(true)
    expect(index.byPath.has("/raw/sources/book/Ch01.md")).toBe(true)
    // 目录条目不入索引
    expect(index.byPath.has("/sources/transcripts")).toBe(false)
    // 同一响应填充 path→title（Files 树哈希名副标签），空标题不入表
    const titles = useWikiStore.getState().pageTitleByPath
    expect(titles["concepts/motivation.md"]).toBe("学习动机")
    expect(Object.keys(titles)).toHaveLength(1)
  })

  it("存储清单获取失败 → 降级纯页面索引（不抛出、有 warn）", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    listPages.mockResolvedValue([{ path: "concepts/motivation.md" }])
    listFiles.mockRejectedValue(new Error("HTTP 500"))

    await expect(buildWebProjectPathIndex("7")).resolves.toBeUndefined()

    const index = useWikiStore.getState().projectPathIndex
    expect(index.byPath.has("/wiki/concepts/motivation.md")).toBe(true)
    expect(index.byPath.size).toBe(1)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it("响应在飞期间切了项目：旧清单丢弃，不污染新会话索引", async () => {
    let release: (v: unknown[]) => void = () => {}
    listPages.mockReturnValue(
      new Promise((resolve) => {
        release = resolve
      }),
    )
    listFiles.mockResolvedValue([])
    const pending = buildWebProjectPathIndex("7")
    useWikiStore.setState({ project: { id: "9", path: "", name: "next" } })
    release([{ path: "concepts/stale.md" }])
    await pending

    expect(useWikiStore.getState().projectPathIndex.byPath.size).toBe(0)
  })

  it("listPages 失败不抛出（吞错 + warn），索引保持原状", async () => {
    useWikiStore.getState().setProjectPathIndexFromPaths(["concepts/keep.md"])
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    listPages.mockRejectedValue(new Error("HTTP 500"))
    listFiles.mockResolvedValue([])

    await expect(buildWebProjectPathIndex("7")).resolves.toBeUndefined()

    expect(
      useWikiStore.getState().projectPathIndex.byPath.has("/wiki/concepts/keep.md"),
    ).toBe(true)
    warn.mockRestore()
  })
})
