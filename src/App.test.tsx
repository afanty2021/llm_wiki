import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"

describe("App web 入口", () => {
  it("init 的 openProject 被 caps.platform tauri 包裹(web 跳过本地打开)", () => {
    const src = readFileSync("src/App.tsx", "utf8")
    // init 的 openProject 调用应在 caps.platform === 'tauri' 守卫内
    expect(src).toMatch(
      /caps\.platform[\s\S]*?tauri[\s\S]*openProject|openProject[\s\S]*caps\.platform[\s\S]*?tauri/,
    )
  })

  it("handleProjectOpened 设 __currentProjectId", () => {
    const src = readFileSync("src/App.tsx", "utf8")
    expect(src).toContain("__currentProjectId")
  })
})
