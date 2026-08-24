// @vitest-environment happy-dom
// web 平台门：clip server 状态指示器是桌面专属（Tauri invoke + 本地 19827 守护），
// web 下不轮询、不渲染——否则恒红点"Clip server error"。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, cleanup, waitFor } from "@testing-library/react"

const mocks = vi.hoisted(() => ({
  platform: "web" as "web" | "tauri",
}))

vi.mock("@/lib/capabilities", () => ({
  caps: {
    get platform() {
      return mocks.platform
    },
  },
}))
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) =>
      opts?.defaultValue ?? key,
  }),
}))
// base-ui Tooltip 在 happy-dom 缺动画 API——透传替身（本测试只看指示器 dot 的有无）。
vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children, ...props }: React.HTMLAttributes<HTMLSpanElement> & { children?: React.ReactNode }) => (
    <span {...props}>{children}</span>
  ),
  TooltipContent: ({ children }: { children?: React.ReactNode }) => (
    <span>{children}</span>
  ),
}))

import { IconSidebar } from "./icon-sidebar"

const dotSelector = "span.h-2\\.5.w-2\\.5"

describe("IconSidebar clip server 指示器平台门", () => {
  beforeEach(() => {
    mocks.platform = "web"
  })
  afterEach(() => {
    cleanup()
  })

  it("web：不渲染指示器 dot（也无轮询）", async () => {
    render(<IconSidebar onSwitchProject={() => {}} />)
    await new Promise((r) => setTimeout(r, 0))
    expect(document.querySelector(dotSelector)).toBeNull()
  })

  it("tauri：指示器渲染（invoke 失败落 error 态也有 dot）", async () => {
    mocks.platform = "tauri"
    render(<IconSidebar onSwitchProject={() => {}} />)
    // happy-dom 无 Tauri IPC → clip_server_status invoke 拒绝 → catch 置 error。
    await waitFor(() => {
      expect(document.querySelector(dotSelector)).not.toBeNull()
    })
  })
})
