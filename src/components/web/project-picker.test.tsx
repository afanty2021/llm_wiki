// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react"

const getUserTeams = vi.fn()
const listProjects = vi.fn()
const createProject = vi.fn()
vi.mock("@/lib/api-client", () => ({
  apiClient: {
    getUserTeams: (...a: unknown[]) => getUserTeams(...a),
    listProjects: (...a: unknown[]) => listProjects(...a),
    createProject: (...a: unknown[]) => createProject(...a),
  },
}))

describe("ProjectPicker", () => {
  beforeEach(() => {
    getUserTeams.mockReset()
    listProjects.mockReset()
    createProject.mockReset()
  })
  afterEach(() => cleanup())

  it("选 team → 选 project → onPick", async () => {
    getUserTeams.mockResolvedValue([{ id: 1, name: "Team A" }])
    listProjects.mockResolvedValue({
      items: [{ id: 10, name: "Proj1", team_id: 1 }],
      next_cursor: null,
      has_more: false,
    })
    const onPick = vi.fn()
    const { ProjectPicker } = await import("./project-picker")
    render(<ProjectPicker onPick={onPick} />)
    await waitFor(() => expect(screen.getByText("Team A")).toBeTruthy())
    fireEvent.click(screen.getByText("Team A"))
    await waitFor(() => expect(screen.getByText("Proj1")).toBeTruthy())
    fireEvent.click(screen.getByText("Proj1"))
    expect(onPick).toHaveBeenCalledWith({ id: 10, name: "Proj1", team_id: 1 })
  })

  it("建 project", async () => {
    getUserTeams.mockResolvedValue([{ id: 1, name: "Team A" }])
    listProjects.mockResolvedValue({ items: [], next_cursor: null, has_more: false })
    createProject.mockResolvedValue({ id: 20, name: "NewP", team_id: 1 })
    const onPick = vi.fn()
    const { ProjectPicker } = await import("./project-picker")
    render(<ProjectPicker onPick={onPick} />)
    await waitFor(() => expect(screen.getByText("Team A")).toBeTruthy())
    fireEvent.click(screen.getByText("Team A"))
    fireEvent.change(screen.getByPlaceholderText(/项目名/i), {
      target: { value: "NewP" },
    })
    fireEvent.click(screen.getByRole("button", { name: /新建/i }))
    await waitFor(() =>
      expect(onPick).toHaveBeenCalledWith({ id: 20, name: "NewP", team_id: 1 })
    )
  })

  it("listProjects 分页:循环拉全部页(>20 project 都可见)", async () => {
    getUserTeams.mockResolvedValue([{ id: 1, name: "Team A" }])
    listProjects
      .mockResolvedValueOnce({
        items: Array.from({ length: 20 }, (_, i) => ({ id: 100 + i, name: `P${i}`, team_id: 1 })),
        next_cursor: "cur2",
        has_more: true,
      })
      .mockResolvedValueOnce({
        items: [{ id: 200, name: "Page2Proj", team_id: 1 }],
        next_cursor: null,
        has_more: false,
      })
    const onPick = vi.fn()
    const { ProjectPicker } = await import("./project-picker")
    render(<ProjectPicker onPick={onPick} />)
    await waitFor(() => expect(screen.getByText("Team A")).toBeTruthy())
    fireEvent.click(screen.getByText("Team A"))
    // 循环跟随 cursor:第二页的 Page2Proj 也应可见(否则 >20 project 不可选)
    await waitFor(() => expect(screen.getByText("Page2Proj")).toBeTruthy())
    expect(screen.getByText("P0")).toBeTruthy() // 第一页也在
  })
})
