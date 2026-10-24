import { beforeEach, describe, expect, it, vi } from "vitest"

const storage = vi.hoisted(() => new Map<string, unknown>())
const save = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({
    get: async <T>(key: string) => storage.get(key) as T | undefined,
    set: async (key: string, value: unknown) => {
      storage.set(key, value)
    },
    save,
  })),
}))
// 本测试验证 plugin-store 持久化路径；fork 的 getStore 在非 tauri 平台会改走
// webStore(localStorage)，钉 tauri 让 mock 的 plugin-store 真正被消费（上游测试
// 无 web 形态，未考虑此分支）。
vi.mock("@/lib/capabilities", () => ({ caps: { platform: "tauri" } }))

describe("source watch all-projects persistence", () => {
  beforeEach(() => {
    storage.clear()
    save.mockClear()
  })

  it("defaults off and round-trips the global option", async () => {
    const {
      loadSourceWatchAllProjects,
      saveSourceWatchAllProjects,
    } = await import("./project-store")

    expect(await loadSourceWatchAllProjects()).toBe(false)
    await saveSourceWatchAllProjects(true)
    expect(await loadSourceWatchAllProjects()).toBe(true)
    expect(save).toHaveBeenCalledTimes(1)

    await saveSourceWatchAllProjects(false)
    expect(await loadSourceWatchAllProjects()).toBe(false)
  })
})
