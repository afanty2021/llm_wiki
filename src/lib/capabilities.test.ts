import { describe, it, expect, vi, afterEach } from "vitest"
import { detect, type Capabilities } from "./capabilities"

describe("capabilities detect", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("returns web when no __TAURI__ marker", () => {
    vi.stubGlobal("window", {})
    vi.stubGlobal("Notification", function Notification() {})
    const c = detect()
    expect(c.platform).toBe("web")
    expect(c.canWatchClipboard).toBe(false)
    expect(c.canAutoStart).toBe(false)
    expect(c.canRunCli).toBe(false)
    expect(c.canWatchFiles).toBe(false)
    expect(c.canPickFiles).toBe(true)
    expect(c.canAccessFs).toBe(true)
    expect(c.canShowNotif).toBe(true)
  })

  it("returns tauri when __TAURI_INTERNALS__ present", () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} })
    const c = detect()
    expect(c.platform).toBe("tauri")
    expect(c.canRunCli).toBe(true)
    expect(c.canWatchClipboard).toBe(true)
  })

  it("canShowNotif=false when Notification undefined", () => {
    vi.stubGlobal("window", {})
    vi.stubGlobal("Notification", undefined)
    const c = detect()
    expect(c.canShowNotif).toBe(false)
  })

  it("caps constant matches detect in current (test=web) env", async () => {
    const { caps } = await import("./capabilities")
    const c: Capabilities = caps
    expect(c.platform).toBe("web")
  })
})
