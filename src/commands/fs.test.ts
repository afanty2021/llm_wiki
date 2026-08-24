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

import { createDirectory, listDirectory, writeFile, writeFileAtomic } from "./fs"
// #6：fs.ts 按 ApiRequestError.isNotFound/isConflict 分支——mock 工厂必须回传真类
import { ApiRequestError } from "@/lib/api-client"

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
  // 上游 dedupe 测试并入本 describe 后沿用其前置:每个用例重置 invoke 计数。
  beforeEach(() => {
    mocks.invoke.mockReset()
  })

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

  // ── #1(web):wiki 页面读写与 pages API 对齐 ──

  const notFound = () => new ApiRequestError("not found", 404, "RESOURCE_NOT_FOUND")

  function webFsMocks(overrides: Partial<Record<"statFile" | "readFile" | "getPage" | "updatePage" | "createPage" | "writeFile", ReturnType<typeof vi.fn>>>) {
    return {
      statFile: overrides.statFile ?? vi.fn().mockResolvedValue({ exists: false, is_dir: false, size: 0, modified: 0 }),
      readFile: overrides.readFile ?? vi.fn(),
      getPage: overrides.getPage ?? vi.fn().mockRejectedValue(notFound()),
      updatePage: overrides.updatePage ?? vi.fn(),
      createPage: overrides.createPage ?? vi.fn(),
      writeFile: overrides.writeFile ?? vi.fn().mockResolvedValue(undefined),
    }
  }

  const samplePage = {
    id: 1,
    project_id: 7,
    path: "entities/kwl-chart.md",
    title: "KWL 图表",
    content: "# KWL 图表\n\n正文",
    frontmatter: { type: "entity", title: "KWL 图表", images: [], sources: ["source.md"] },
    page_type: "entity",
    sources: null,
    images: null,
    created_at: "2026-08-22T00:00:00Z",
    updated_at: "2026-08-22T01:00:00Z",
  }

  it("readFile(web) stat miss + .md → pages API 回落,重组 frontmatter 文本", async () => {
    vi.resetModules()
    const api = webFsMocks({ getPage: vi.fn().mockResolvedValue(samplePage) })
    vi.doMock("@/lib/capabilities", () => ({ caps: { platform: "web" } }))
    vi.doMock("@/lib/api-client", () => ({ apiClient: api, ApiRequestError }))
    ;(globalThis as Record<string, unknown>).window = globalThis
    ;(globalThis as any).__currentProjectId = 7
    const fs = await import("./fs")
    const text = await fs.readFile("entities/kwl-chart.md")
    expect(api.getPage).toHaveBeenCalledWith(7, "entities/kwl-chart.md")
    expect(text.startsWith("---\n")).toBe(true)
    expect(text).toContain("type: entity")
    expect(text).toContain('sources:\n  - source.md')
    expect(text).toContain("---\n\n# KWL 图表")
    // 桌面格式:frontmatter 块可被 parseFrontmatter 解回
    const { parseFrontmatter } = await import("@/lib/frontmatter")
    const parsed = parseFrontmatter(text)
    expect(parsed.frontmatter?.type).toBe("entity")
    expect(parsed.body.startsWith("# KWL 图表")).toBe(true)
    vi.doUnmock("@/lib/capabilities")
    vi.doUnmock("@/lib/api-client")
    delete (globalThis as any).__currentProjectId
    delete (globalThis as Record<string, unknown>).window
  })

  it("readFile(web) wiki/ 前缀消费方 → 去前缀变体命中 DB 页", async () => {
    vi.resetModules()
    const api = webFsMocks({
      getPage: vi.fn()
        .mockRejectedValueOnce(notFound()) // 带前缀变体 miss
        .mockResolvedValueOnce(samplePage),            // 去前缀变体命中
    })
    vi.doMock("@/lib/capabilities", () => ({ caps: { platform: "web" } }))
    vi.doMock("@/lib/api-client", () => ({ apiClient: api, ApiRequestError }))
    ;(globalThis as Record<string, unknown>).window = globalThis
    ;(globalThis as any).__currentProjectId = 7
    const fs = await import("./fs")
    await fs.readFile("wiki/entities/kwl-chart.md")
    // 第一变体带前缀 404,第二变体去前缀命中
    expect(api.getPage).toHaveBeenNthCalledWith(1, 7, "wiki/entities/kwl-chart.md")
    expect(api.getPage).toHaveBeenNthCalledWith(2, 7, "entities/kwl-chart.md")
    vi.doUnmock("@/lib/capabilities")
    vi.doUnmock("@/lib/api-client")
    delete (globalThis as any).__currentProjectId
    delete (globalThis as Record<string, unknown>).window
  })

  it("readFile(web) stat miss 非 .md / 页面也 miss → File not found", async () => {
    vi.resetModules()
    const api = webFsMocks({})
    vi.doMock("@/lib/capabilities", () => ({ caps: { platform: "web" } }))
    vi.doMock("@/lib/api-client", () => ({ apiClient: api, ApiRequestError }))
    ;(globalThis as Record<string, unknown>).window = globalThis
    ;(globalThis as any).__currentProjectId = 7
    const fs = await import("./fs")
    // 非 .md:不查 pages API
    await expect(fs.readFile("wiki/chat.json")).rejects.toThrow("File not found")
    expect(api.getPage).not.toHaveBeenCalled()
    // .md 但页面不存在:两变体都 404 → File not found
    await expect(fs.readFile("entities/ghost.md")).rejects.toThrow("File not found")
    expect(api.getPage).toHaveBeenCalledTimes(2)
    vi.doUnmock("@/lib/capabilities")
    vi.doUnmock("@/lib/api-client")
    delete (globalThis as any).__currentProjectId
    delete (globalThis as Record<string, unknown>).window
  })

  it("readFile(web) stat 命中存储文件 → 走 files API 不查 pages", async () => {
    vi.resetModules()
    const api = webFsMocks({
      statFile: vi.fn().mockResolvedValue({ exists: true, is_dir: false, size: 10, modified: 1 }),
      readFile: vi.fn().mockResolvedValue({ path: "wiki/chat.json", content: "{}" }),
    })
    vi.doMock("@/lib/capabilities", () => ({ caps: { platform: "web" } }))
    vi.doMock("@/lib/api-client", () => ({ apiClient: api, ApiRequestError }))
    ;(globalThis as Record<string, unknown>).window = globalThis
    ;(globalThis as any).__currentProjectId = 7
    const fs = await import("./fs")
    await expect(fs.readFile("wiki/chat.json")).resolves.toBe("{}")
    expect(api.getPage).not.toHaveBeenCalled()
    vi.doUnmock("@/lib/capabilities")
    vi.doUnmock("@/lib/api-client")
    delete (globalThis as any).__currentProjectId
    delete (globalThis as Record<string, unknown>).window
  })

  it("writeFile(web) 已存在页面 → PUT /page(If-Match),不写存储目录", async () => {
    vi.resetModules()
    const api = webFsMocks({ getPage: vi.fn().mockResolvedValue(samplePage) })
    vi.doMock("@/lib/capabilities", () => ({ caps: { platform: "web" } }))
    vi.doMock("@/lib/api-client", () => ({ apiClient: api, ApiRequestError }))
    ;(globalThis as Record<string, unknown>).window = globalThis
    ;(globalThis as any).__currentProjectId = 7
    const fs = await import("./fs")
    const edited = "---\ntype: entity\ntitle: KWL 图表\nsources:\n  - source.md\n---\n\n# KWL 图表\n\n改后正文"
    await fs.writeFile("entities/kwl-chart.md", edited)
    expect(api.updatePage).toHaveBeenCalledWith(
      7,
      "entities/kwl-chart.md",
      expect.objectContaining({ path: "entities/kwl-chart.md", content: "# KWL 图表\n\n改后正文" }),
      samplePage.updated_at,
    )
    expect(api.writeFile).not.toHaveBeenCalled()
    vi.doUnmock("@/lib/capabilities")
    vi.doUnmock("@/lib/api-client")
    delete (globalThis as any).__currentProjectId
    delete (globalThis as Record<string, unknown>).window
  })

  it("writeFile(web) 非 .md / 非页面 → 落回 files API 写存储", async () => {
    vi.resetModules()
    const api = webFsMocks({})
    vi.doMock("@/lib/capabilities", () => ({ caps: { platform: "web" } }))
    vi.doMock("@/lib/api-client", () => ({ apiClient: api, ApiRequestError }))
    ;(globalThis as Record<string, unknown>).window = globalThis
    ;(globalThis as any).__currentProjectId = 7
    const fs = await import("./fs")
    await fs.writeFile("wiki/chat.json", "{}")
    expect(api.updatePage).not.toHaveBeenCalled()
    expect(api.writeFile).toHaveBeenCalledWith(7, "wiki/chat.json", "{}")
    vi.doUnmock("@/lib/capabilities")
    vi.doUnmock("@/lib/api-client")
    delete (globalThis as any).__currentProjectId
    delete (globalThis as Record<string, unknown>).window
  })

  it("writeFile(web) 409 stale → 重取 updated_at 重试一次", async () => {
    vi.resetModules()
    const freshPage = { ...samplePage, updated_at: "2026-08-22T02:00:00Z" }
    const api = webFsMocks({
      getPage: vi.fn()
        .mockResolvedValueOnce(samplePage) // write 前存在性检查
        .mockResolvedValueOnce(freshPage), // 409 后重取
      updatePage: vi.fn()
        .mockRejectedValueOnce(new Error("updated_at mismatch (stale write or page not found)"))
        .mockResolvedValueOnce(freshPage),
    })
    vi.doMock("@/lib/capabilities", () => ({ caps: { platform: "web" } }))
    vi.doMock("@/lib/api-client", () => ({ apiClient: api, ApiRequestError }))
    ;(globalThis as Record<string, unknown>).window = globalThis
    ;(globalThis as any).__currentProjectId = 7
    const fs = await import("./fs")
    await fs.writeFile("entities/kwl-chart.md", "# 新正文")
    expect(api.updatePage).toHaveBeenCalledTimes(2)
    expect(api.updatePage).toHaveBeenLastCalledWith(
      7,
      "entities/kwl-chart.md",
      expect.anything(),
      "2026-08-22T02:00:00Z",
    )
    vi.doUnmock("@/lib/capabilities")
    vi.doUnmock("@/lib/api-client")
    delete (globalThis as any).__currentProjectId
    delete (globalThis as Record<string, unknown>).window
  })

  it("deduplicates matching in-flight listDirectory requests only while pending", async () => {
    const tree = [{
      name: "wiki",
      path: "/tmp/project/wiki",
      is_dir: true,
      children: [{ name: "page.md", path: "/tmp/project/wiki/page.md", is_dir: false }],
    }]
    let resolveTree: (value: typeof tree) => void = () => {}
    mocks.invoke.mockImplementationOnce(
      () => new Promise<typeof tree>((resolve) => {
        resolveTree = resolve
      }),
    )

    const first = listDirectory("/tmp/project", { maxDepth: 2 })
    const second = listDirectory("/tmp/project", { maxDepth: 2 })

    expect(mocks.invoke).toHaveBeenCalledTimes(1)
    // invokeTraced 注入 traceId(我方 tracing 模式),断言用 objectContaining 放行该键。
    expect(mocks.invoke).toHaveBeenCalledWith("list_directory", expect.objectContaining({
      path: "/tmp/project",
      includeHidden: false,
      maxDepth: 2,
    }))

    resolveTree(tree)
    const [firstTree, secondTree] = await Promise.all([first, second])
    expect(firstTree).toEqual(tree)
    expect(secondTree).toEqual(tree)
    expect(firstTree).not.toBe(secondTree)
    expect(firstTree[0]).not.toBe(secondTree[0])
    expect(firstTree[0].children?.[0]).not.toBe(secondTree[0].children?.[0])
    secondTree[0].name = "mutated"
    secondTree[0].children![0].name = "mutated-child.md"
    expect(firstTree[0].name).toBe("wiki")
    expect(firstTree[0].children?.[0]?.name).toBe("page.md")

    mocks.invoke.mockResolvedValueOnce([])
    await listDirectory("/tmp/project", { maxDepth: 2 })

    expect(mocks.invoke).toHaveBeenCalledTimes(2)
  })

  it("does not clone single-caller listDirectory results", async () => {
    const tree = [{ name: "wiki", path: "/tmp/project/wiki", is_dir: true }]
    mocks.invoke.mockResolvedValueOnce(tree)

    await expect(listDirectory("/tmp/project")).resolves.toBe(tree)
  })

  it("does not deduplicate listDirectory requests with different options", async () => {
    mocks.invoke.mockResolvedValue([])

    await Promise.all([
      listDirectory("/tmp/project", { maxDepth: 2 }),
      listDirectory("/tmp/project", { maxDepth: 3 }),
    ])

    expect(mocks.invoke).toHaveBeenCalledTimes(2)
  })

  it("does not deduplicate listDirectory requests with different paths", async () => {
    mocks.invoke
      .mockResolvedValueOnce([{ name: "a", path: "/tmp/a", is_dir: true }])
      .mockResolvedValueOnce([{ name: "b", path: "/tmp/b", is_dir: true }])

    const [first, second] = await Promise.all([
      listDirectory("/tmp/a"),
      listDirectory("/tmp/b"),
    ])

    expect(mocks.invoke).toHaveBeenCalledTimes(2)
    expect(first).not.toBe(second)
    expect(first).toEqual([{ name: "a", path: "/tmp/a", is_dir: true }])
    expect(second).toEqual([{ name: "b", path: "/tmp/b", is_dir: true }])
  })

  it("does not deduplicate listDirectory requests with different hidden-entry options", async () => {
    mocks.invoke.mockResolvedValue([])

    await Promise.all([
      listDirectory("/tmp/project", false),
      listDirectory("/tmp/project", true),
    ])

    expect(mocks.invoke).toHaveBeenCalledTimes(2)
  })

  it("deduplicates boolean and object includeHidden overloads with the same value", async () => {
    mocks.invoke.mockResolvedValue([])

    await Promise.all([
      listDirectory("/tmp/project", true),
      listDirectory("/tmp/project", { includeHidden: true }),
    ])

    expect(mocks.invoke).toHaveBeenCalledTimes(1)
  })

  it("deduplicates default and explicit false includeHidden options", async () => {
    mocks.invoke.mockResolvedValue([])

    await Promise.all([
      listDirectory("/tmp/project"),
      listDirectory("/tmp/project", { includeHidden: false }),
    ])

    expect(mocks.invoke).toHaveBeenCalledTimes(1)
  })

  it("clears rejected in-flight listDirectory requests so later calls can retry", async () => {
    let rejectTree: (reason: Error) => void = () => {}
    mocks.invoke.mockImplementationOnce(
      () => new Promise((_, reject) => {
        rejectTree = reject
      }),
    )

    const first = listDirectory("/tmp/project")
    const second = listDirectory("/tmp/project")

    expect(mocks.invoke).toHaveBeenCalledTimes(1)

    rejectTree(new Error("scan failed"))

    const settled = await Promise.allSettled([first, second])
    expect(settled).toEqual([
      expect.objectContaining({ status: "rejected" }),
      expect.objectContaining({ status: "rejected" }),
    ])

    mocks.invoke.mockResolvedValueOnce([])
    await expect(listDirectory("/tmp/project")).resolves.toEqual([])

    expect(mocks.invoke).toHaveBeenCalledTimes(2)
  })

  // ── #6/FS-1：失败类型化 —— 非 404 不再当 miss ──

  it("fetchWikiPage 瞬时 500 → 上抛而非静默落 files(防永久分叉)", async () => {
    vi.resetModules()
    const api = webFsMocks({
      getPage: vi.fn().mockRejectedValue(new ApiRequestError("Database error", 500, "DATABASE_ERROR")),
    })
    vi.doMock("@/lib/capabilities", () => ({ caps: { platform: "web" } }))
    vi.doMock("@/lib/api-client", () => ({ apiClient: api, ApiRequestError }))
    ;(globalThis as Record<string, unknown>).window = globalThis
    ;(globalThis as any).__currentProjectId = 7
    const fs = await import("./fs")
    // 读路径:500 上抛(File not found 语义只在真 404 时)
    await expect(fs.readFile("entities/x.md")).rejects.toThrow("Database error")
    // 写路径:同样上抛,不得静默落回 files API 写存储目录
    await expect(fs.writeFile("entities/x.md", "# y")).rejects.toThrow("Database error")
    expect(api.writeFile).not.toHaveBeenCalled()
    vi.doUnmock("@/lib/capabilities")
    vi.doUnmock("@/lib/api-client")
    delete (globalThis as any).__currentProjectId
    delete (globalThis as Record<string, unknown>).window
  })

  it("writeFile(web) PUT body 不含 title(frontmatter.title 驱动 denormalize)", async () => {
    vi.resetModules()
    const api = webFsMocks({ getPage: vi.fn().mockResolvedValue(samplePage) })
    vi.doMock("@/lib/capabilities", () => ({ caps: { platform: "web" } }))
    vi.doMock("@/lib/api-client", () => ({ apiClient: api, ApiRequestError }))
    ;(globalThis as Record<string, unknown>).window = globalThis
    ;(globalThis as any).__currentProjectId = 7
    const fs = await import("./fs")
    await fs.writeFile("entities/kwl-chart.md", "---\ntype: entity\ntitle: 新标题\n---\n\n正文")
    expect(api.updatePage).toHaveBeenCalledTimes(1)
    const body = api.updatePage.mock.calls[0][2]
    expect(body).not.toHaveProperty("title")
    expect(body.frontmatter).toMatchObject({ title: "新标题" })
    vi.doUnmock("@/lib/capabilities")
    vi.doUnmock("@/lib/api-client")
    delete (globalThis as any).__currentProjectId
    delete (globalThis as Record<string, unknown>).window
  })

  // ── #7：web 下新 .md = 建 wiki 页 ──

  it("writeFile(web) 不存在的 .md → POST /pages 建页,不写存储目录", async () => {
    vi.resetModules()
    const created = { ...samplePage, path: "wiki/queries/q-120000.md", updated_at: "2026-08-23T00:00:00Z" }
    const api = webFsMocks({ createPage: vi.fn().mockResolvedValue(created) })
    vi.doMock("@/lib/capabilities", () => ({ caps: { platform: "web" } }))
    vi.doMock("@/lib/api-client", () => ({ apiClient: api, ApiRequestError }))
    ;(globalThis as Record<string, unknown>).window = globalThis
    ;(globalThis as any).__currentProjectId = 7
    const fs = await import("./fs")
    await fs.writeFile("wiki/queries/q-120000.md", "---\ntype: query\ntitle: Q\n---\n\n答案")
    expect(api.createPage).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ path: "wiki/queries/q-120000.md", content: "答案" }),
    )
    expect(api.createPage.mock.calls[0][1]).not.toHaveProperty("title")
    expect(api.writeFile).not.toHaveBeenCalled()
    vi.doUnmock("@/lib/capabilities")
    vi.doUnmock("@/lib/api-client")
    delete (globalThis as any).__currentProjectId
    delete (globalThis as Record<string, unknown>).window
  })

  it("writeFile(web) 建页 409 竞态 → 转 PUT 更新", async () => {
    vi.resetModules()
    const api = webFsMocks({
      createPage: vi.fn().mockRejectedValue(new ApiRequestError("path already exists", 409, "CONFLICT")),
      getPage: vi.fn()
        .mockRejectedValueOnce(notFound())          // 首查变体1 miss
        .mockRejectedValueOnce(notFound())          // 首查变体2 miss → 走建页
        .mockResolvedValueOnce(samplePage),         // 409 后转 PUT 的存在性重查命中
    })
    vi.doMock("@/lib/capabilities", () => ({ caps: { platform: "web" } }))
    vi.doMock("@/lib/api-client", () => ({ apiClient: api, ApiRequestError }))
    ;(globalThis as Record<string, unknown>).window = globalThis
    ;(globalThis as any).__currentProjectId = 7
    const fs = await import("./fs")
    await fs.writeFile("entities/kwl-chart.md", "# 改")
    expect(api.createPage).toHaveBeenCalledTimes(1)
    expect(api.updatePage).toHaveBeenCalledTimes(1)
    expect(api.writeFile).not.toHaveBeenCalled()
    vi.doUnmock("@/lib/capabilities")
    vi.doUnmock("@/lib/api-client")
    delete (globalThis as any).__currentProjectId
    delete (globalThis as Record<string, unknown>).window
  })

  it("writeFile(web) 裸 HTTP 409(网关剥 body)也触发 stale 重试", async () => {
    vi.resetModules()
    const fresh = { ...samplePage, updated_at: "2026-08-23T03:00:00Z" }
    const api = webFsMocks({
      getPage: vi.fn().mockResolvedValueOnce(samplePage).mockResolvedValueOnce(fresh),
      updatePage: vi.fn()
        .mockRejectedValueOnce(new Error("HTTP 409"))
        .mockResolvedValueOnce(fresh),
    })
    vi.doMock("@/lib/capabilities", () => ({ caps: { platform: "web" } }))
    vi.doMock("@/lib/api-client", () => ({ apiClient: api, ApiRequestError }))
    ;(globalThis as Record<string, unknown>).window = globalThis
    ;(globalThis as any).__currentProjectId = 7
    const fs = await import("./fs")
    await fs.writeFile("entities/kwl-chart.md", "# 新")
    expect(api.updatePage).toHaveBeenCalledTimes(2)
    expect(api.updatePage).toHaveBeenLastCalledWith(7, "entities/kwl-chart.md", expect.anything(), "2026-08-23T03:00:00Z")
    vi.doUnmock("@/lib/capabilities")
    vi.doUnmock("@/lib/api-client")
    delete (globalThis as any).__currentProjectId
    delete (globalThis as Record<string, unknown>).window
  })

  // ── 存储源前缀(sources-card follow-up):sources/transcripts/** 与 raw/sources/**
  //    在 DB 无同名页(衍生页在 transcripts/ 等),读写必须同源直走 files API。
  //    走页面语义 = 404→POST 幽灵页,编辑静默丢失(读取 stat 恒命中存储旧文件)。 ──

  it("writeFile(web) sources/transcripts/** → 直写 files API,零页面调用(防幽灵页)", async () => {
    vi.resetModules()
    const api = webFsMocks({})
    vi.doMock("@/lib/capabilities", () => ({ caps: { platform: "web" } }))
    vi.doMock("@/lib/api-client", () => ({ apiClient: api, ApiRequestError }))
    ;(globalThis as Record<string, unknown>).window = globalThis
    ;(globalThis as any).__currentProjectId = 7
    const fs = await import("./fs")
    await fs.writeFile("sources/transcripts/44a4fa7f.md", "# 编辑后的转写源")
    expect(api.writeFile).toHaveBeenCalledWith(7, "sources/transcripts/44a4fa7f.md", "# 编辑后的转写源")
    expect(api.getPage).not.toHaveBeenCalled()
    expect(api.createPage).not.toHaveBeenCalled()
    expect(api.updatePage).not.toHaveBeenCalled()
    vi.doUnmock("@/lib/capabilities")
    vi.doUnmock("@/lib/api-client")
    delete (globalThis as any).__currentProjectId
    delete (globalThis as Record<string, unknown>).window
  })

  it("writeFile(web) raw/sources/**(含前导斜杠变体)同款直写 files API", async () => {
    vi.resetModules()
    const api = webFsMocks({})
    vi.doMock("@/lib/capabilities", () => ({ caps: { platform: "web" } }))
    vi.doMock("@/lib/api-client", () => ({ apiClient: api, ApiRequestError }))
    ;(globalThis as Record<string, unknown>).window = globalThis
    ;(globalThis as any).__currentProjectId = 7
    const fs = await import("./fs")
    await fs.writeFile("/raw/sources/LT-LearningTeaching-3rd/Ch05-chapter-4-who-are-the-learners.md", "# 章节")
    expect(api.writeFile).toHaveBeenCalledWith(7, "/raw/sources/LT-LearningTeaching-3rd/Ch05-chapter-4-who-are-the-learners.md", "# 章节")
    expect(api.createPage).not.toHaveBeenCalled()
    vi.doUnmock("@/lib/capabilities")
    vi.doUnmock("@/lib/api-client")
    delete (globalThis as any).__currentProjectId
    delete (globalThis as Record<string, unknown>).window
  })

  it("writeFile(web) 非 .md 存储路径不受影响;前缀外 .md 仍走页面语义", async () => {
    vi.resetModules()
    const api = webFsMocks({ getPage: vi.fn().mockResolvedValue(samplePage) })
    vi.doMock("@/lib/capabilities", () => ({ caps: { platform: "web" } }))
    vi.doMock("@/lib/api-client", () => ({ apiClient: api, ApiRequestError }))
    ;(globalThis as Record<string, unknown>).window = globalThis
    ;(globalThis as any).__currentProjectId = 7
    const fs = await import("./fs")
    // sources/raw 顶层非 transcripts/sources 子路径(如未来 sources/notes.md)不误伤:
    // isStorageSourcePath 只匹配完整前缀,页面语义照常
    await fs.writeFile("sources/notes.md", "# n")
    expect(api.updatePage).toHaveBeenCalledTimes(1)
    expect(api.writeFile).not.toHaveBeenCalled()
    vi.doUnmock("@/lib/capabilities")
    vi.doUnmock("@/lib/api-client")
    delete (globalThis as any).__currentProjectId
    delete (globalThis as Record<string, unknown>).window
  })

  it("readFile(web) 存储源 stat miss → File not found,不走 pages 回落(幽灵页不可见)", async () => {
    vi.resetModules()
    const api = webFsMocks({})
    vi.doMock("@/lib/capabilities", () => ({ caps: { platform: "web" } }))
    vi.doMock("@/lib/api-client", () => ({ apiClient: api, ApiRequestError }))
    ;(globalThis as Record<string, unknown>).window = globalThis
    ;(globalThis as any).__currentProjectId = 7
    const fs = await import("./fs")
    await expect(fs.readFile("sources/transcripts/gone.md")).rejects.toThrow("File not found")
    expect(api.getPage).not.toHaveBeenCalled()
    expect(api.readFile).not.toHaveBeenCalled()
    vi.doUnmock("@/lib/capabilities")
    vi.doUnmock("@/lib/api-client")
    delete (globalThis as any).__currentProjectId
    delete (globalThis as Record<string, unknown>).window
  })
})
