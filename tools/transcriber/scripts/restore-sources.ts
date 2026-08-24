// tools/transcriber/scripts/restore-sources.ts
// /tmp 存储清空事故（2026-08-24）恢复：从 DB transcript 页回灌 sources/transcripts/*.md 到服务器存储。
// 依据：cli.ts 上传时 writeSource 与 upsertTranscriptPage 用同一 md 字符串，DB 页内容即
// 存储源文件的原始字节（verifyTranscriptIntact 机制保证 LLM 不改写 transcript 页）——
// 逐字节回灌使 ingested_files 的 content_hash 保持命中，未来任何重摄取仍会 hash-skip。
// 404/空页兜底：报错列出（whisper JSON 仍在 out/transcripts/，可走 buildTranscriptMd 重建）。
// 用法：SVC_PASSWORD=... npx tsx tools/transcriber/scripts/restore-sources.ts [--dry-run]
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { ApiClient } from "../src/api-client"

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, "../out")

const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:8080"
const PROJECT_ID = Number(process.env.PROJECT_ID ?? 614)
const dryRun = process.argv.includes("--dry-run")

const username = process.env.SVC_USERNAME ?? "svc-transcriber"
const password = process.env.SVC_PASSWORD
if (!password) {
  console.error("缺 SVC_PASSWORD 环境变量（source tools/transcriber/out/bootstrap.env）")
  process.exit(1)
}

const lines = readFileSync(join(outDir, "state.jsonl"), "utf-8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l) as { slug: string; status: string; relPath?: string })
const targets = lines.filter((l) => l.status === "done")
console.log(`state.jsonl ${lines.length} 行，done ${targets.length} 个 → ${dryRun ? "DRY-RUN" : "写回"} ${BASE_URL} project=${PROJECT_ID}`)

const api = new ApiClient(BASE_URL, { projectId: PROJECT_ID, authPath: join(outDir, "auth.json") })
await api.login(username, password)

let created = 0
let failed = 0
const failures: string[] = []
for (const [i, t] of targets.entries()) {
  const pagePath = `transcripts/${t.slug}.md`
  const sourcePath = `sources/transcripts/${t.slug}.md`
  try {
    const res = await api.authedFetch(
      `/api/v1/projects/${PROJECT_ID}/page?path=${encodeURIComponent(pagePath)}`,
    )
    if (!res.ok) throw new Error(`GET page HTTP ${res.status}`)
    const page = (await res.json()) as { content: string | null }
    if (!page.content) throw new Error("page content 空")
    if (!dryRun) await api.writeSource(sourcePath, page.content)
    created++
    if ((i + 1) % 25 === 0) console.log(`  ${i + 1}/${targets.length}…`)
  } catch (e) {
    failed++
    failures.push(`${t.slug}: ${String(e).slice(0, 120)}`)
  }
}
console.log(`回灌结束：ok=${created} failed=${failed}${dryRun ? "（dry-run 未写）" : ""}`)
for (const f of failures) console.log(`  FAIL ${f}`)
process.exit(failed > 0 ? 1 : 0)
