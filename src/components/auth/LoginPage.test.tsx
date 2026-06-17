// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import { LoginPage } from "./LoginPage"

// vitest 未启用 globals，@testing-library 的 auto-cleanup（依赖全局 afterEach）会
// 静默失效，导致测试间 DOM 泄漏（getByText 命中上一个用例的节点）。手动清理保证隔离。
afterEach(() => {
  cleanup()
})

describe("LoginPage", () => {
  it("renders login form", () => {
    render(<LoginPage onNavigate={() => {}} />)
    expect(screen.getByPlaceholderText("用户名")).toBeDefined()
    expect(screen.getByPlaceholderText("密码")).toBeDefined()
    expect(screen.getByRole("button", { name: /登录/ })).toBeDefined()
  })

  it("has link to register page", () => {
    render(<LoginPage onNavigate={() => {}} />)
    expect(screen.getByText("注册")).toBeDefined()
  })
})
