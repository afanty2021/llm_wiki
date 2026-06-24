// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest"

// web 平台:review-store 从服务器 HTTP 加载 + resolve/dismiss 同步
vi.mock("@/lib/capabilities", () => ({ caps: { platform: "web" } }))
const listReviewsMock = vi.fn()
const resolveReviewMock = vi.fn()
const dismissReviewMock = vi.fn()
vi.mock("@/lib/api-client", () => ({
  apiClient: {
    listReviews: (...a: unknown[]) => listReviewsMock(...a),
    resolveReview: (...a: unknown[]) => resolveReviewMock(...a),
    dismissReview: (...a: unknown[]) => dismissReviewMock(...a),
  },
}))

const API_REVIEW = {
  id: 5,
  uuid: "u1",
  projectId: 42,
  sourcePath: "wiki/a.md",
  reviewType: "duplicate",
  title: "Dup Title",
  description: "desc",
  affectedPages: ["wiki/a.md"],
  searchQueries: null,
  options: [{ label: "Keep", action: "keep" }],
  status: "pending",
  resolvedAction: null,
  resolvedBy: null,
  resolvedAt: null,
  createdAt: "2026-06-24T00:00:00Z",
}

describe("review-store web", () => {
  beforeEach(() => {
    ;(globalThis as { __currentProjectId?: number }).__currentProjectId = 42
    listReviewsMock.mockReset()
    resolveReviewMock.mockReset()
    dismissReviewMock.mockReset()
  })

  it("loadReviewsFromServer 映射服务器 ReviewItem → store ReviewItem(id string/type/resolved)", async () => {
    listReviewsMock.mockResolvedValue([API_REVIEW])
    const { useReviewStore } = await import("./review-store")
    useReviewStore.getState().setItems([])
    await useReviewStore.getState().loadReviewsFromServer(42)
    const items = useReviewStore.getState().items
    expect(items).toHaveLength(1)
    expect(items[0].id).toBe("5") // String(api.id)
    expect(items[0].type).toBe("duplicate") // reviewType → type
    expect(items[0].resolved).toBe(false) // status !== "resolved"
    expect(items[0].affectedPages).toEqual(["wiki/a.md"])
    expect(listReviewsMock).toHaveBeenCalledWith(42)
  })

  it("resolveItem web 乐观更新本地 + 同步 apiClient.resolveReview(Number(id), {kind:action})", async () => {
    listReviewsMock.mockResolvedValue([API_REVIEW])
    resolveReviewMock.mockResolvedValue(undefined)
    const { useReviewStore } = await import("./review-store")
    useReviewStore.getState().setItems([])
    await useReviewStore.getState().loadReviewsFromServer(42)

    useReviewStore.getState().resolveItem("5", "keep")
    // 乐观:本地立即 resolved
    expect(useReviewStore.getState().items[0].resolved).toBe(true)
    expect(useReviewStore.getState().items[0].resolvedAction).toBe("keep")
    // 同步服务器:Number(id) 5,action → kind
    expect(resolveReviewMock).toHaveBeenCalledWith(42, 5, { kind: "keep" })
  })

  it("dismissItem web 移除本地 + 同步 apiClient.dismissReview(Number(id))", async () => {
    listReviewsMock.mockResolvedValue([API_REVIEW])
    dismissReviewMock.mockResolvedValue(undefined)
    const { useReviewStore } = await import("./review-store")
    useReviewStore.getState().setItems([])
    await useReviewStore.getState().loadReviewsFromServer(42)

    useReviewStore.getState().dismissItem("5")
    expect(useReviewStore.getState().items).toHaveLength(0)
    expect(dismissReviewMock).toHaveBeenCalledWith(42, 5)
  })
})
