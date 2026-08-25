// @vitest-environment happy-dom
// Files 树纯哈希名转写源文件（sources/transcripts/<8-hex>.md，存量 39 个）显示
// 衍生 DB 页标题——pageTitleByPath join（web 填充，桌面空表=不显示行为不变）。
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"

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
})
