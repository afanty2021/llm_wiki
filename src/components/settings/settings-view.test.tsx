// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest"
import { cleanup } from "@testing-library/react"

// vitest 未启用 globals,@testing-library 的 auto-cleanup 失效,手动清理保证用例隔离。
afterEach(() => {
  cleanup()
  // 动态 import + doMock 会跨用例累积模块缓存,重置以让每个用例的 caps mock 生效。
  vi.resetModules()
  vi.doUnmock("@/lib/capabilities")
})

// caps mock 通过 doMock + 动态 import 注入:每个用例独立 mock,避免模块缓存污染。
// 注意 ESM 下 doMock 必须在动态 import 之前调用才能命中缓存。
async function importSettingsView() {
  return await import("./settings-view")
}

describe("settings-view caps gate", () => {
  it("web 平台隐藏 api-server / source-watch / scheduled-import / mineru section tab", async () => {
    vi.doMock("@/lib/capabilities", () => ({
      caps: {
        platform: "web",
        canPickFiles: true,
        canAccessFs: true,
        canWatchClipboard: false,
        canAutoStart: false,
        canRunCli: false,
        canWatchFiles: false,
        canShowNotif: false,
      },
    }))
    const { render, screen } = await import("@testing-library/react")
    const { SettingsView } = await importSettingsView()

    render(<SettingsView />)

    // 4 个桌面专属 section 在 web 下应不渲染对应 tab 按钮。
    expect(screen.queryByTestId("section-tab-api-server")).toBeNull()
    expect(screen.queryByTestId("section-tab-source-watch")).toBeNull()
    expect(screen.queryByTestId("section-tab-scheduled-import")).toBeNull()
    expect(screen.queryByTestId("section-tab-mineru")).toBeNull()
  })

  it("tauri 平台保留全部 section tab(含 4 个桌面专属)", async () => {
    vi.doMock("@/lib/capabilities", () => ({
      caps: {
        platform: "tauri",
        canPickFiles: true,
        canAccessFs: true,
        canWatchClipboard: true,
        canAutoStart: true,
        canRunCli: true,
        canWatchFiles: true,
        canShowNotif: true,
      },
    }))
    const { render, screen } = await import("@testing-library/react")
    const { SettingsView } = await importSettingsView()

    render(<SettingsView />)

    // 桌面零回归:4 个桌面专属 section 全部保留。
    expect(screen.queryByTestId("section-tab-api-server")).not.toBeNull()
    expect(screen.queryByTestId("section-tab-source-watch")).not.toBeNull()
    expect(screen.queryByTestId("section-tab-scheduled-import")).not.toBeNull()
    expect(screen.queryByTestId("section-tab-mineru")).not.toBeNull()
  })

  it("web 平台保留 team 维度 section(web-search / llm / embedding)", async () => {
    vi.doMock("@/lib/capabilities", () => ({
      caps: {
        platform: "web",
        canPickFiles: true,
        canAccessFs: true,
        canWatchClipboard: false,
        canAutoStart: false,
        canRunCli: false,
        canWatchFiles: false,
        canShowNotif: false,
      },
    }))
    const { render, screen } = await import("@testing-library/react")
    const { SettingsView } = await importSettingsView()

    render(<SettingsView />)

    // team 维度 section 在 web 下仍可用。
    expect(screen.queryByTestId("section-tab-web-search")).not.toBeNull()
    expect(screen.queryByTestId("section-tab-llm")).not.toBeNull()
    expect(screen.queryByTestId("section-tab-embedding")).not.toBeNull()
  })
})
