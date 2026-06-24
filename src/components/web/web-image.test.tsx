// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, cleanup, waitFor } from "@testing-library/react"

const fileBlobUrl = vi.fn()
vi.mock("@/lib/file-url", () => ({
  fileBlobUrl: (...a: any[]) => fileBlobUrl(...a),
  CURRENT_PROJECT_ID: () => 42,
}))
vi.mock("@/lib/capabilities", () => ({ caps: { platform: "web" } }))
vi.mock("@/lib/logger", () => ({
  createLogger: () => ({ warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() }),
}))

describe("WebImage", () => {
  beforeEach(() => {
    fileBlobUrl.mockReset()
    // mock IntersectionObserver:observe 时立即触发 isIntersecting(让 WebImage visible=true)。
    vi.stubGlobal("IntersectionObserver", class {
      cb: any
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      constructor(cb: any) { this.cb = cb }
      observe() { setTimeout(() => this.cb([{ isIntersecting: true }]), 0) }
      disconnect() {}
    })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    cleanup()
  })

  it("passthrough URL(https)直接作 src,不走 raw 端点(fileBlobUrl 不调)", async () => {
    const { WebImage } = await import("./web-image")
    const { container } = render(<WebImage relPath="https://example.com/a.png" alt="ext" />)
    // jsdom 无 IntersectionObserver → WebImage 降级 visible=true → passthrough 短路 setUrl(relPath)。
    await waitFor(() => {
      const img = container.querySelector("img")
      expect(img?.getAttribute("src")).toBe("https://example.com/a.png")
    })
    expect(fileBlobUrl).not.toHaveBeenCalled()
  })

  it("project-rel 路径走 fileBlobUrl(raw 端点)", async () => {
    fileBlobUrl.mockResolvedValue({ url: "blob:mock", revoke: vi.fn() })
    const { WebImage } = await import("./web-image")
    render(<WebImage relPath="wiki/media/a.png" alt="local" />)
    await waitFor(() => expect(fileBlobUrl).toHaveBeenCalledWith(42, "wiki/media/a.png"))
  })
})
