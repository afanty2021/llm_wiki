import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"

describe("theme isTauriRuntime 收敛到 caps", () => {
  it("不再定义本地 isTauriRuntime(改用 caps)", () => {
    const src = readFileSync("src/lib/theme.ts", "utf8")
    expect(src).not.toContain("isTauriRuntime")
  })
})
