import { useState, useRef, useEffect } from "react"
import { apiClient } from "@/lib/api-client"
import type { IngestJob } from "@/lib/api-types"

interface Props {
  projectId: number
  onDone?: (job: IngestJob) => void
}

// 轮询间隔(ms)。后端 ingest worker 异步执行,前端轮询 getIngestJob 直到终态。
const POLL_INTERVAL_MS = 2000
// 轮询上限,防 worker 卡死导致前端死循环(150 次 × 2s = 5min)。
const POLL_MAX = 150

/**
 * web 摄取面板:upload → triggerIngest → 轮询 getIngestJob。
 * 不复用桌面 ingest.ts(依赖本地绝对路径 + copy/preprocess),web 走上传→触发→轮询,
 * 服务器零改动。
 *
 * 卸载安全:轮询可能长达 5min,组件卸载(切换视图)时用 mountedRef 中断 run(),
 * 停止后续 fetch 并跳过 setState(防卸载后 setState 警告 + 无谓网络请求)。
 */
export function WebIngestPanel({ projectId, onDone }: Props) {
  const [files, setFiles] = useState<File[]>([])
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState("")
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const mountedRef = useRef(true)
  useEffect(() => () => { mountedRef.current = false }, [])

  const onSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFiles(Array.from(e.target.files ?? []))
    setError(null)
  }

  const run = async () => {
    if (files.length === 0) return
    setBusy(true)
    setError(null)
    setStatus("上传中…")
    // 卸载守卫:每次 await 后检查,卸载则中断(停止后续 fetch + 跳过 setState)。
    const alive = () => mountedRef.current
    try {
      const paths: string[] = []
      for (let i = 0; i < files.length; i++) {
        const f = files[i]
        try {
          const r = await apiClient.uploadFile(projectId, f, "raw/sources")
          if (!alive()) return
          paths.push(r.path)
        } catch (e) {
          // fail-fast:一文件失败中断整批(部分文件可能已上传到服务器,重试会覆盖)。
          // 错误信息体现文件序号/名,便于定位(非裸抛 HTTP 错误)。
          throw new Error(`文件 ${i + 1}/${files.length}(${f.name})上传失败: ${e instanceof Error ? e.message : e}`)
        }
      }
      setStatus("触发摄取…")
      // triggerIngest 返回 { job_id }(snake_case),非 IngestJob。
      const { job_id } = await apiClient.triggerIngest(projectId, paths)
      if (!alive()) return
      setStatus("处理中…")
      let job: IngestJob | undefined
      // 终态 succeeded/failed(ingest_queue.rs mark_job_succeeded/mark_job_failed)。
      for (let i = 0; i < POLL_MAX; i++) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
        if (!alive()) return
        // getIngestJob 返回 IngestJob,id 字段为 .id(非 job_id)。
        job = await apiClient.getIngestJob(job_id)
        if (!alive()) return
        if (job.status === "succeeded" || job.status === "failed") break
        setStatus(`处理中… ${job.stage ?? job.status}`)
      }
      if (!job || (job.status !== "succeeded" && job.status !== "failed")) {
        setError("摄取超时(5min 无终态)")
      } else if (job.status === "succeeded") {
        setStatus("完成")
        onDone?.(job)
      } else {
        setError(`摄取失败: ${job.error ?? job.status}`)
      }
    } catch (e) {
      if (alive()) setError(String(e instanceof Error ? e.message : e))
    } finally {
      if (alive()) setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-2 p-3 border rounded">
      <input
        ref={inputRef}
        type="file"
        multiple
        aria-label="upload"
        className="hidden"
        onChange={onSelect}
      />
      <button
        onClick={() => inputRef.current?.click()}
        type="button"
        className="px-3 py-1 border rounded"
      >
        选择文件{files.length > 0 ? ` (${files.length})` : ""}
      </button>
      <button
        onClick={run}
        disabled={busy || files.length === 0}
        type="button"
        className="px-3 py-1 bg-blue-600 text-white rounded disabled:opacity-50"
      >
        {busy ? status : "摄取"}
      </button>
      {error && <p className="text-red-600 text-sm">{error}</p>}
      {!error && status && <p className="text-gray-600 text-sm">{status}</p>}
    </div>
  )
}
