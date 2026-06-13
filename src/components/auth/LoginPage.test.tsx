import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { LoginPage } from "./LoginPage"

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
