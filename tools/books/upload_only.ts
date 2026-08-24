// tools/books/upload_only.ts —— /tmp 存储清空事故（2026-08-24）回灌专用：
// 把 staged 章节 .md 写回服务器存储 raw/sources/<slug>/，**不触发摄取**（内容已在 DB，
// 重摄取会因重解析字节变化引发不必要的 LLM 重处理）。复用 transcriber 的 ApiClient
// （writeSource=POST /files/:pid/write，与 multipart upload 同落 storage.write_bytes）。
// 用法：SVC_PASSWORD=... npx tsx tools/books/upload_only.ts --book <slug> [--dir /Users/berton/kb-books]
import { readdirSync, readFileSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { ApiClient } from "../transcriber/src/api-client"

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const opt = (n: string, d: string) => {
  const i = args.indexOf(n)
  return i >= 0 ? args[i + 1] : d
}
const book = opt("--book", "")
const dir = opt("--dir", "/Users/berton/kb-books")
if (!book) { console.error("缺 --book <slug>"); process.exit(1) }

const bookDir = join(dir, book)
const stagedDir = join(bookDir, "staged")
if (!existsSync(stagedDir)) { console.error(`缺 staged 目录：${stagedDir}（先跑 mineru_parse）`); process.exit(1) }

const files = readdirSync(stagedDir).filter((f) => f.endsWith(".md")).sort()
console.log(`book=${book} staged=${files.length} 章 → 只上传不摄取`)

const password = process.env.SVC_PASSWORD
if (!password) { console.error("缺 SVC_PASSWORD（source tools/transcriber/out/bootstrap.env）"); process.exit(1) }
const api = new ApiClient(process.env.BASE_URL ?? "http://127.0.0.1:8080", {
  projectId: Number(process.env.PROJECT_ID ?? 614),
  authPath: join(here, "../transcriber/out/auth.json"),
})
await api.login(process.env.SVC_USERNAME ?? "svc-transcriber", password)

let ok = 0
const failures: string[] = []
for (const f of files) {
  const rel = `raw/sources/${book}/${f}`
  try {
    await api.writeSource(rel, readFileSync(join(stagedDir, f), "utf-8"))
    ok++
  } catch (e) {
    failures.push(`${f}: ${String(e).slice(0, 120)}`)
  }
}
console.log(`上传完成：ok=${ok} failed=${failures.length}`)
for (const x of failures) console.log(`  FAIL ${x}`)
process.exit(failures.length > 0 ? 1 : 0)
