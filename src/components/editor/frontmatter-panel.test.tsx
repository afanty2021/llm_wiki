// @vitest-environment happy-dom
// #4(web)：frontmatter related chips 与正文 wikilink 同款虚拟根兜底——
// project.path 恒空（ProjectPicker 只带 id）时 chips 仍可解析、可点击。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, cleanup, screen } from "@testing-library/react"

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) =>
      opts?.defaultValue ?? key,
  }),
}))
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
}))

import { useWikiStore } from "@/stores/wiki-store"
import { FrontmatterPanel } from "./frontmatter-panel"

// happy-dom 无 Tauri 全局 → caps.platform === "web"。
describe("FrontmatterPanel(web) related chips 兜底", () => {
  beforeEach(() => {
    useWikiStore.setState({ project: { id: "7", path: "", name: "p" } })
    useWikiStore.getState().setProjectPathIndexFromPaths(["concepts/motivation.md"])
  })

  afterEach(() => {
    cleanup()
    useWikiStore.setState({ project: null })
  })

  it("web 虚拟根下 related 命中索引 → chip 可点（title=Open …）", () => {
    render(
      <FrontmatterPanel
        data={{
          title: "Learner Differences",
          type: "concept",
          related: ["motivation"],
        }}
      />,
    )

    expect(screen.getByTitle("Open motivation")).toBeTruthy()
  })

  it("索引缺失的目标渲染为不可点（不误报可跳）", () => {
    render(
      <FrontmatterPanel
        data={{ title: "T", type: "concept", related: ["nonexistent-page"] }}
      />,
    )

    expect(
      screen.getByTitle("Related page not found: nonexistent-page"),
    ).toBeTruthy()
  })
})
