// @vitest-environment happy-dom
// #4(web)：wikilink 点击无跳转——knowledge-tree web 分支加载 pages 后须把
// DB 路径清单喂给 projectPathIndex（桌面由 setFileTree 提供，web 无文件树）。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, waitFor, cleanup } from "@testing-library/react"

const listPages = vi.fn()
const listDirectory = vi.fn()

vi.mock("@/lib/api-client", () => ({
  apiClient: {
    listPages: (...a: unknown[]) => listPages(...a),
  },
}))
vi.mock("@/commands/fs", () => ({
  readFile: vi.fn(),
  listDirectory: (...a: unknown[]) => listDirectory(...a),
}))
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) =>
      opts?.defaultValue ?? key,
  }),
}))
// base-ui ScrollArea 在 happy-dom 缺 Element.getAnimations，渲染即抛错——
// 用透传 div 替身（本测试只关 store 副作用，不测滚动 UI）。
vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
}))

import { useWikiStore } from "@/stores/wiki-store"
import { KnowledgeTree } from "./knowledge-tree"

// happy-dom 无 Tauri 全局 → caps.platform === "web"，组件自然走 web 分支。
describe("KnowledgeTree(web) projectPathIndex 补建", () => {
  beforeEach(() => {
    listPages.mockReset()
    listDirectory.mockReset()
    listDirectory.mockResolvedValue([])
    // App.tsx ProjectPicker 形态：path 为空串。
    useWikiStore.setState({ project: { id: "7", path: "", name: "p" } })
    useWikiStore.getState().setFileTree([])
  })

  afterEach(() => {
    cleanup()
    useWikiStore.setState({ project: null })
  })

  it("listPages 成功后由全量 DB 清单构建 /wiki/… 索引（含被显示层过滤的 reserved 页）", async () => {
    listPages.mockResolvedValue([
      { path: "concepts/motivation.md", title: "Motivation", page_type: "concept", frontmatter: {}, sources: null },
      // index/log 不进左侧列表，但 [[index]] 是合法 wikilink 目标，须进索引。
      { path: "wiki/index.md", title: "Index", page_type: "overview", frontmatter: {}, sources: null },
    ])

    render(<KnowledgeTree />)

    await waitFor(() => {
      expect(useWikiStore.getState().projectPathIndex.byPath.has("/wiki/concepts/motivation.md")).toBe(true)
    })
    expect(useWikiStore.getState().projectPathIndex.byPath.has("/wiki/index.md")).toBe(true)
    expect(listPages).toHaveBeenCalledWith(7)
  })

  it("listPages 失败时索引保持空（不残留半份数据）", async () => {
    listPages.mockRejectedValue(new Error("HTTP 500"))

    render(<KnowledgeTree />)

    await waitFor(() => expect(listPages).toHaveBeenCalled())
    expect(useWikiStore.getState().projectPathIndex.byPath.size).toBe(0)
  })
})
