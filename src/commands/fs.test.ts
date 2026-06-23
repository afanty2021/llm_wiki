import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  // 默认桌面环境,保留既有 path-guard 测试的 Tauri 语义(fs.ts 顶层 USE_HTTP 由 caps 决定)
  caps: { platform: "tauri" as const },
}))

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}))

vi.mock("@/lib/capabilities", () => ({
  caps: mocks.caps,
}))

import { createDirectory, writeFile, writeFileAtomic } from "./fs"

describe("fs command path guards", () => {
  beforeEach(() => {
    mocks.invoke.mockReset()
  })

  it("rejects relative write paths before invoking Tauri", async () => {
    await expect(writeFile("wiki/sources/stray.md", "content")).rejects.toThrow(
      /absolute path/i,
    )

    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it("rejects relative atomic write paths before invoking Tauri", async () => {
    await expect(writeFileAtomic("wiki/sources/stray.md", "content")).rejects.toThrow(
      /absolute path/i,
    )

    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it("rejects relative directory paths before invoking Tauri", async () => {
    await expect(createDirectory("wiki/sources")).rejects.toThrow(/absolute path/i)

    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it("allows absolute write paths", async () => {
    mocks.invoke.mockResolvedValue(undefined)

    await writeFile("/tmp/project/wiki/sources/page.md", "content")

    expect(mocks.invoke).toHaveBeenCalledWith(
      "write_file",
      expect.objectContaining({
        path: "/tmp/project/wiki/sources/page.md",
        contents: "content",
      }),
    )
  })
})

describe("fs.ts web 适配", () => {
  it("fileExists 走 statFile(web)", async () => {
    vi.resetModules()
    const statFile = vi.fn().mockResolvedValue({
      exists: true,
      is_dir: false,
      size: 1,
      modified: 1,
    })
    vi.doMock("@/lib/capabilities", () => ({
      caps: { platform: "web" },
    }))
    vi.doMock("@/lib/api-client", () => ({
      apiClient: { statFile },
    }))
    const fs = await import("./fs")
    expect(await fs.fileExists("x.md")).toBe(true)
    expect(statFile).toHaveBeenCalled()
    vi.doUnmock("@/lib/capabilities")
    vi.doUnmock("@/lib/api-client")
  })

  it("getFileSize/getFileModifiedTime 走 statFile(web)", async () => {
    vi.resetModules()
    const statFile = vi.fn().mockResolvedValue({
      exists: true,
      is_dir: false,
      size: 42,
      modified: 1700000000,
    })
    vi.doMock("@/lib/capabilities", () => ({
      caps: { platform: "web" },
    }))
    vi.doMock("@/lib/api-client", () => ({
      apiClient: { statFile },
    }))
    const fs = await import("./fs")
    expect(await fs.getFileSize("y.md")).toBe(42)
    expect(await fs.getFileModifiedTime("y.md")).toBe(1700000000)
    vi.doUnmock("@/lib/capabilities")
    vi.doUnmock("@/lib/api-client")
  })

  it("copyFile web 下 throw desktop-only", async () => {
    vi.resetModules()
    vi.doMock("@/lib/capabilities", () => ({
      caps: { platform: "web" },
    }))
    const fs = await import("./fs")
    await expect(fs.copyFile("a", "b")).rejects.toThrow(/desktop-only/)
    vi.doUnmock("@/lib/capabilities")
  })

  it("copyDirectory/preprocessFile/getFileMd5/readFileAsBase64/findRelatedWikiPages web 下 throw desktop-only", async () => {
    vi.resetModules()
    vi.doMock("@/lib/capabilities", () => ({
      caps: { platform: "web" },
    }))
    const fs = await import("./fs")
    await expect(fs.copyDirectory("a", "b")).rejects.toThrow(/desktop-only/)
    await expect(fs.preprocessFile("a")).rejects.toThrow(/desktop-only/)
    await expect(fs.getFileMd5("a")).rejects.toThrow(/desktop-only/)
    await expect(fs.readFileAsBase64("a")).rejects.toThrow(/desktop-only/)
    await expect(fs.findRelatedWikiPages("a", "b")).rejects.toThrow(/desktop-only/)
    vi.doUnmock("@/lib/capabilities")
  })

  it("桌面(tauri)下 fileExists 走 invoke(file_exists)", async () => {
    vi.resetModules()
    vi.doMock("@/lib/capabilities", () => ({
      caps: { platform: "tauri" },
    }))
    mocks.invoke.mockResolvedValue(true)
    const fs = await import("./fs")
    expect(await fs.fileExists("/abs/x.md")).toBe(true)
    expect(mocks.invoke).toHaveBeenCalledWith("file_exists", { path: "/abs/x.md" })
    vi.doUnmock("@/lib/capabilities")
  })
})
