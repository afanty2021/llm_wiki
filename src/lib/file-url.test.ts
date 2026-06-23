import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

describe("file-url", () => {
  let createObjSpy: ReturnType<typeof vi.spyOn>
  let revokeObjSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    ;(globalThis as any).__currentProjectId = 42
    // 仅 spy 方法,不替换 URL 构造器(替换会破坏 jsdom/vitest 内部依赖)
    createObjSpy = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock-123")
    revokeObjSpy = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {})
  })
  afterEach(() => {
    ;(globalThis as any).__currentProjectId = undefined
    createObjSpy.mockRestore()
    revokeObjSpy.mockRestore()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it("fileBlobUrl web 环境走 fetch raw → blob URL", async () => {
    vi.stubGlobal("window", {})
    const fakeBlob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" })
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, blob: () => Promise.resolve(fakeBlob) })
    vi.stubGlobal("fetch", fetchMock)
    const { fileBlobUrl } = await import("./file-url")
    const url = await fileBlobUrl(42, "wiki/media/a.png")
    expect(url).toBe("blob:mock-123")
    // 核心验证:fetch 拼到 raw URL + createObjectURL 被调用拿到 blob
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/files/42/raw/wiki/media/a.png"),
      expect.any(Object),
    )
    expect(createObjSpy).toHaveBeenCalledWith(fakeBlob)
  })

  it("fileBlobUrl 后端 !ok → reject", async () => {
    vi.stubGlobal("window", {})
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }))
    const { fileBlobUrl } = await import("./file-url")
    await expect(fileBlobUrl(42, "x.png")).rejects.toThrow()
  })

  it("CURRENT_PROJECT_ID 反映 __currentProjectId", async () => {
    const { CURRENT_PROJECT_ID } = await import("./file-url")
    ;(globalThis as any).__currentProjectId = 7
    expect(CURRENT_PROJECT_ID()).toBe(7)
    ;(globalThis as any).__currentProjectId = undefined
    expect(CURRENT_PROJECT_ID()).toBeNull()
  })
})
