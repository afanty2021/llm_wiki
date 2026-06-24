import { create } from "zustand"
import { normalizeReviewTitle } from "@/lib/review-utils"
import { apiClient } from "@/lib/api-client"
import { caps } from "@/lib/capabilities"
import { createLogger } from "@/lib/logger"
import type { ReviewItem as ApiReviewItem } from "@/lib/api-types"

const logger = createLogger("review-store")

export interface ReviewOption {
  label: string
  action: string // identifier for the action
}

export interface ReviewItem {
  id: string
  type: "contradiction" | "duplicate" | "missing-page" | "confirm" | "suggestion"
  title: string
  description: string
  sourcePath?: string
  affectedPages?: string[]
  searchQueries?: string[]
  options: ReviewOption[]
  resolved: boolean
  resolvedAction?: string
  createdAt: number
}

interface ReviewState {
  items: ReviewItem[]
  addItem: (item: Omit<ReviewItem, "id" | "resolved" | "createdAt">) => void
  addItems: (items: Omit<ReviewItem, "id" | "resolved" | "createdAt">[]) => void
  setItems: (items: ReviewItem[]) => void
  resolveItem: (id: string, action: string) => void
  dismissItem: (id: string) => void
  clearResolved: () => void
  /** web:从服务器加载 review(桌面走 loadReviewItems localStorage + addItems)。 */
  loadReviewsFromServer: (projectId: number) => Promise<void>
}

let counter = 0

/** web 映射:服务器 ReviewItem(id number / reviewType / status)→ store ReviewItem(id string / type / resolved)。 */
function mapApiReview(api: ApiReviewItem): ReviewItem {
  return {
    id: String(api.id),
    type: api.reviewType as ReviewItem["type"],
    title: api.title,
    description: api.description,
    sourcePath: api.sourcePath ?? undefined,
    affectedPages: api.affectedPages ?? undefined,
    searchQueries: api.searchQueries ?? undefined,
    options: api.options,
    resolved: api.status === "resolved",
    resolvedAction: api.resolvedAction ?? undefined,
    createdAt: new Date(api.createdAt).getTime(),
  }
}

const currentProjectId = () =>
  Number((typeof window !== "undefined" && (window as any).__currentProjectId) || 0)

export const useReviewStore = create<ReviewState>((set) => ({
  items: [],

  addItem: (item) =>
    set((state) => ({
      items: [
        ...state.items,
        {
          ...item,
          id: `review-${++counter}`,
          resolved: false,
          createdAt: Date.now(),
        },
      ],
    })),

  addItems: (items) =>
    set((state) => {
      // De-dupe against pending items with same type + normalized title (all
      // 5 types — bulk ingest can re-surface the same contradiction/confirm
      // from multiple files).
      // Merge affectedPages / searchQueries / sourcePath instead of duplicating.
      const result = [...state.items]
      const keyFor = (t: string, title: string) => `${t}::${normalizeReviewTitle(title)}`

      // Build index of existing pending items for fast lookup
      const pendingIndex = new Map<string, number>()
      result.forEach((it, idx) => {
        if (!it.resolved) {
          pendingIndex.set(keyFor(it.type, it.title), idx)
        }
      })

      for (const incoming of items) {
        const k = keyFor(incoming.type, incoming.title)
        const existingIdx = pendingIndex.get(k)

        if (existingIdx !== undefined) {
          // Merge into existing
          const old = result[existingIdx]
          const mergedPages = Array.from(new Set([...(old.affectedPages ?? []), ...(incoming.affectedPages ?? [])]))
          const mergedQueries = Array.from(new Set([...(old.searchQueries ?? []), ...(incoming.searchQueries ?? [])]))
          result[existingIdx] = {
            ...old,
            description: incoming.description || old.description, // prefer newer description
            sourcePath: incoming.sourcePath ?? old.sourcePath,
            affectedPages: mergedPages.length > 0 ? mergedPages : undefined,
            searchQueries: mergedQueries.length > 0 ? mergedQueries : undefined,
          }
        } else {
          const newItem = {
            ...incoming,
            id: `review-${++counter}`,
            resolved: false,
            createdAt: Date.now(),
          }
          result.push(newItem)
          pendingIndex.set(k, result.length - 1)
        }
      }

      return { items: result }
    }),

  setItems: (items) => set({ items }),

  // web 从服务器加载 review(桌面走 loadReviewItems localStorage + setItems)。
  loadReviewsFromServer: async (projectId) => {
    try {
      const items = await apiClient.listReviews(projectId)
      set({ items: items.map(mapApiReview) })
    } catch (e) {
      logger.warn("loadReviewsFromServer 失败", { projectId, error: String(e) })
    }
  },

  resolveItem: (id, action) => {
    // 乐观更新本地 state(桌面+web 共用);web 额外异步同步服务器。
    set((state) => ({
      items: state.items.map((item) =>
        item.id === id ? { ...item, resolved: true, resolvedAction: action } : item
      ),
    }))
    if (caps.platform === "web") {
      apiClient
        .resolveReview(currentProjectId(), Number(id), { kind: action })
        .catch((e) => logger.warn("resolveReview 同步失败", { id, error: String(e) }))
    }
  },

  dismissItem: (id) => {
    set((state) => ({
      items: state.items.filter((item) => item.id !== id),
    }))
    if (caps.platform === "web") {
      apiClient
        .dismissReview(currentProjectId(), Number(id))
        .catch((e) => logger.warn("dismissReview 同步失败", { id, error: String(e) }))
    }
  },

  clearResolved: () =>
    set((state) => ({
      items: state.items.filter((item) => !item.resolved),
    })),
}))
