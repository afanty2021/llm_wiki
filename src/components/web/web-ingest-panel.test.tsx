// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react"

const uploadFile = vi.fn()
const triggerIngest = vi.fn()
const getIngestJob = vi.fn()

vi.mock("@/lib/api-client", () => ({
  apiClient: {
    uploadFile: (...a: any[]) => uploadFile(...a),
    triggerIngest: (...a: any[]) => triggerIngest(...a),
    getIngestJob: (...a: any[]) => getIngestJob(...a),
  },
}))

describe("WebIngestPanel", () => {
  beforeEach(() => {
    uploadFile.mockReset()
    triggerIngest.mockReset()
    getIngestJob.mockReset()
    vi.useRealTimers()
  })

  afterEach(() => {
    cleanup()
  })

  it("上传 → 触发 → 轮询到 succeeded", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    uploadFile.mockImplementation(async (_pid: number, file: File) => ({
      name: file.name,
      path: `raw/sources/${file.name}`,
      size: file.size,
    }))
    triggerIngest.mockResolvedValue({ job_id: "job-1", status: "pending" })
    getIngestJob
      .mockResolvedValueOnce({ id: "job-1", status: "processing", progress: 50, stage: "generating" })
      .mockResolvedValueOnce({ id: "job-1", status: "succeeded", progress: 100, stage: "succeeded" })

    const { WebIngestPanel } = await import("./web-ingest-panel")
    render(<WebIngestPanel projectId={1} onDone={() => {}} />)

    const file = new File(["hello"], "a.md", { type: "text/markdown" })
    fireEvent.change(screen.getByLabelText(/upload/i), { target: { files: [file] } })
    fireEvent.click(screen.getByRole("button", { name: /ingest|摄取/i }))

    // upload/triggerIngest 是同步 await(无 timer),先 flush microtask。
    await vi.advanceTimersByTimeAsync(0)
    await waitFor(() => expect(uploadFile).toHaveBeenCalledWith(1, file, "raw/sources"))
    await waitFor(() => expect(triggerIngest).toHaveBeenCalledWith(1, ["raw/sources/a.md"]))

    // 推进两次轮询(每次 2s),命中 processing → succeeded。
    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(2000)

    await waitFor(() => expect(getIngestJob).toHaveBeenCalledWith("job-1"))
    await waitFor(() => expect(screen.getByText(/完成/)).toBeTruthy())
  })

  it("上传失败显示错误", async () => {
    uploadFile.mockRejectedValue(new Error("upload failed: HTTP 413"))
    const { WebIngestPanel } = await import("./web-ingest-panel")
    render(<WebIngestPanel projectId={1} onDone={() => {}} />)
    fireEvent.change(screen.getByLabelText(/upload/i), {
      target: { files: [new File(["x"], "b.md")] },
    })
    fireEvent.click(screen.getByRole("button", { name: /ingest|摄取/i }))
    await waitFor(() => expect(screen.getByText(/upload failed/i)).toBeTruthy())
  })

  it("轮询到 failed 终态显示摄取失败 + error", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    uploadFile.mockImplementation(async (_pid: number, file: File) => ({
      name: file.name,
      path: `raw/sources/${file.name}`,
      size: file.size,
    }))
    triggerIngest.mockResolvedValue({ job_id: "job-2", status: "pending" })
    getIngestJob
      .mockResolvedValueOnce({ id: "job-2", status: "processing", progress: 10, stage: "parsing" })
      .mockResolvedValueOnce({ id: "job-2", status: "failed", progress: 0, stage: "failed", error: "boom" })

    const { WebIngestPanel } = await import("./web-ingest-panel")
    render(<WebIngestPanel projectId={1} onDone={() => {}} />)

    const file = new File(["hi"], "c.md", { type: "text/markdown" })
    fireEvent.change(screen.getByLabelText(/upload/i), { target: { files: [file] } })
    fireEvent.click(screen.getByRole("button", { name: /ingest|摄取/i }))

    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(2000)

    await waitFor(() => expect(screen.getByText(/摄取失败/)).toBeTruthy())
    await waitFor(() => expect(screen.getByText(/boom/)).toBeTruthy())
  })

  it("stage 中文映射：processing → 处理中（新枚举）且未知 stage 裸透传", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    uploadFile.mockImplementation(async (_pid: number, file: File) => ({
      name: file.name,
      path: `raw/sources/${file.name}`,
      size: file.size,
    }))
    triggerIngest.mockResolvedValue({ job_id: "job-3", status: "pending" })
    getIngestJob
      .mockResolvedValueOnce({ id: "job-3", status: "running", progress: 10, stage: "processing" })
      .mockResolvedValueOnce({ id: "job-3", status: "running", progress: 60, stage: "weird" })
      .mockResolvedValueOnce({ id: "job-3", status: "succeeded", progress: 100, stage: "succeeded" })

    const { WebIngestPanel } = await import("./web-ingest-panel")
    render(<WebIngestPanel projectId={1} onDone={() => {}} />)
    fireEvent.change(screen.getByLabelText(/upload/i), {
      target: { files: [new File(["x"], "d.md")] },
    })
    fireEvent.click(screen.getByRole("button", { name: /ingest|摄取/i }))

    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(2000)
    await waitFor(() => expect(screen.getAllByText(/处理中… 处理中/)).toBeTruthy())
    // 未知 stage 裸透传：STAGE_LABELS 无 "weird" 映射 → 原样拼进状态文本。
    await vi.advanceTimersByTimeAsync(2000)
    await waitFor(() => expect(screen.getAllByText(/处理中… weird/)).toBeTruthy())
    await vi.advanceTimersByTimeAsync(2000)
    await waitFor(() => expect(screen.getByText(/完成/)).toBeTruthy())
  })
})
