import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"

/**
 * Layer 5 期2 Task 7 回归保护:
 * 桌面专属调用点(openProjectFolder / clip-watcher / autostart)
 * 必须被 caps gate 包裹,web 下不触发桌面 API。
 * 源码字符串断言——防止后续重构意外移除 gate。
 */
describe("桌面专属调用点 caps gate", () => {
  it("file-tree openProjectFolder 被 caps gate 包裹", () => {
    const src = readFileSync("src/components/layout/file-tree.tsx", "utf8")
    // openProjectFolder 按钮(web 无本地文件夹概念,必须隐藏)
    expect(src).toMatch(/caps\.(canRunCli|platform)/)
  })

  it("App.tsx clip-watcher 被 caps.canWatchClipboard gate 包裹", () => {
    const src = readFileSync("src/App.tsx", "utf8")
    expect(src).toMatch(/caps\.canWatchClipboard/)
  })

  it("App.tsx autostart 被 caps.canAutoStart gate 包裹", () => {
    const src = readFileSync("src/App.tsx", "utf8")
    expect(src).toMatch(/caps\.canAutoStart/)
  })
})
