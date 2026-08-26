// @vitest-environment happy-dom
// Files 树纯哈希名转写源文件（sources/transcripts/<8-hex>.md，存量 39 个）显示
// 衍生 DB 页标题——pageTitleByPath join（web 填充，桌面空表=不显示行为不变）。
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react"

vi.mock("@tauri-apps/plugin-dialog", () => ({ message: vi.fn() }))
vi.mock("@/commands/fs", () => ({
  listDirectory: vi.fn(),
  openProjectFolder: vi.fn(),
}))
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
  }),
}))
vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}))

import { useWikiStore } from "@/stores/wiki-store"
import { FileTree } from "./file-tree"
import { hashTranscriptDerivedPagePath } from "./file-tree-utils"
import type { FileNode } from "@/types/wiki"

const node = (name: string, path: string, isDir = false): FileNode =>
  ({ name, path, is_dir: isDir, children: isDir ? [] : undefined }) as FileNode

describe("hashTranscriptDerivedPagePath", () => {
  it("哈希名 transcripts 源 → 衍生页路径；其他形态 null", () => {
    expect(hashTranscriptDerivedPagePath(node("06ad7ef1.md", "/sources/transcripts/06ad7ef1.md")))
      .toBe("transcripts/06ad7ef1.md")
    expect(hashTranscriptDerivedPagePath(node("06ad7ef1.md", "sources/transcripts/06ad7ef1.md")))
      .toBe("transcripts/06ad7ef1.md")
    // 非哈希名 / 非 transcripts 路径 / 目录
    expect(hashTranscriptDerivedPagePath(node("How-to-teach-reading-1-c8c63fde.md", "/sources/transcripts/How-to-teach-reading-1-c8c63fde.md"))).toBeNull()
    expect(hashTranscriptDerivedPagePath(node("06ad7ef1.md", "/raw/sources/06ad7ef1.md"))).toBeNull()
    expect(hashTranscriptDerivedPagePath(node("06ad7ef1", "/sources/transcripts/06ad7ef1"))).toBeNull()
  })
  it("形态②：无字母数字 stem + 哈希（1-2a892ab6）也触发；含字母 stem 不触发", () => {
    expect(hashTranscriptDerivedPagePath(node("1-2a892ab6.md", "/sources/transcripts/1-2a892ab6.md")))
      .toBe("transcripts/1-2a892ab6.md")
    expect(hashTranscriptDerivedPagePath(node("116-3f89a942.md", "/sources/transcripts/116-3f89a942.md")))
      .toBe("transcripts/116-3f89a942.md")
    // stem 含字母 = 可读名
    expect(hashTranscriptDerivedPagePath(node("5-Improving-reading-speed-c05108cd.md", "/sources/transcripts/5-Improving-reading-speed-c05108cd.md"))).toBeNull()
    expect(hashTranscriptDerivedPagePath(node("123-LT-607820ef.md", "/sources/transcripts/123-LT-607820ef.md"))).toBeNull()
  })
  it("形态③：CJK stem（新规则中文 slug）有意纳入——slug 化有损，真标题更完整", () => {
    expect(hashTranscriptDerivedPagePath(node("01-提问-ab12cd34.md", "/sources/transcripts/01-提问-ab12cd34.md")))
      .toBe("transcripts/01-提问-ab12cd34.md")
    expect(hashTranscriptDerivedPagePath(node("当我们教词汇的时候-我们都在教什么-二阶段-ab12cd34.md", "/sources/transcripts/当我们教词汇的时候-我们都在教什么-二阶段-ab12cd34.md")))
      .toBe("transcripts/当我们教词汇的时候-我们都在教什么-二阶段-ab12cd34.md")
    // 混合：stem 含 ASCII 字母部分则不触发（slug 已含可读英文段）
    expect(hashTranscriptDerivedPagePath(node("137-IBL-Inquiry-based-learning-ab12cd34.md", "/sources/transcripts/137-IBL-Inquiry-based-learning-ab12cd34.md"))).toBeNull()
  })
})

describe("FileTree 哈希名标题副标签", () => {
  beforeEach(() => {
    cleanup()
    useWikiStore.getState().setProject({ id: 1, name: "p", path: "/tmp/p" } as never)
  })

  it("pageTitleByPath 命中 → 行内显示衍生页标题 + tooltip", () => {
    useWikiStore.getState().setPageTitles([
      { path: "transcripts/06ad7ef1.md", title: "当我们教词汇的时候，我们都在教什么？（二阶段）" },
    ])
    // transcripts 目录作根节点（depth<1 默认展开）挂文件，绕过懒加载
    const root = node("transcripts", "/sources/transcripts", true)
    root.children = [node("06ad7ef1.md", "/sources/transcripts/06ad7ef1.md")]
    useWikiStore.getState().setFileTree([root], { syncPathIndex: false })

    render(<FileTree />)
    expect(screen.getByText("当我们教词汇的时候，我们都在教什么？（二阶段）")).toBeTruthy()
    const row = screen.getByText("06ad7ef1.md").closest("button")
    expect(row?.getAttribute("title")).toBe("当我们教词汇的时候，我们都在教什么？（二阶段）")
  })

  it("标题缺失（桌面空表/衍生页无标题）→ 只显示文件名，无副标签", () => {
    const root = node("transcripts", "/sources/transcripts", true)
    root.children = [node("06ad7ef1.md", "/sources/transcripts/06ad7ef1.md")]
    useWikiStore.getState().setPageTitles([])
    useWikiStore.getState().setFileTree([root], { syncPathIndex: false })
    const { container } = render(<FileTree />)
    expect(screen.getByText("06ad7ef1.md")).toBeTruthy()
    expect(container.textContent).not.toContain("当我们教词汇")
  })

  it("未加载子节点的目录单击一次即加载展开（「要点两次才展开」回归）", async () => {
    const { listDirectory } = await import("@/commands/fs")
    vi.mocked(listDirectory).mockReset()
    // depth 0 目录初始 expanded 但 children 未加载（web 存储目录形态）——
    // 视觉上是收起态，第一次点击必须加载并展开，而不是收起空展开态
    const root = { name: "raw", path: "/raw", is_dir: true } as FileNode
    useWikiStore.getState().setFileTree([root], { syncPathIndex: false })
    vi.mocked(listDirectory).mockResolvedValue([node("sources", "/raw/sources", true)])

    render(<FileTree />)
    const btn = screen.getByText("raw").closest("button")!
    fireEvent.click(btn)
    await waitFor(() => expect(screen.getByText("sources")).toBeTruthy())
    expect(listDirectory).toHaveBeenCalledTimes(1)
    // 已展开且有子节点 → 再点一次是收起（不重复加载）
    fireEvent.click(screen.getByText("raw").closest("button")!)
    await waitFor(() => expect(screen.queryByText("sources")).toBeNull())
    expect(listDirectory).toHaveBeenCalledTimes(1)
  })
})
