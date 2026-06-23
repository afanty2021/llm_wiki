import { describe, it, expect } from "vitest"

describe("api-client resolveApiBase", () => {
  it("undefined→localhost:8080(桌面无 env 默认连 src-server)", async () => {
    const { resolveApiBase } = await import("./api-client")
    expect(resolveApiBase(undefined)).toBe("http://localhost:8080")
  })
  it("空串→空串(web 同源,?? 不回退 localhost)", async () => {
    const { resolveApiBase } = await import("./api-client")
    expect(resolveApiBase("")).toBe("")
  })
  it("显式值→显式值", async () => {
    const { resolveApiBase } = await import("./api-client")
    expect(resolveApiBase("http://host:9")).toBe("http://host:9")
  })
})
