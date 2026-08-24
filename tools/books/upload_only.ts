// tools/books/upload_only.ts —— /tmp 存储清空事故（2026-08-24）回灌专用：
// 把 staged 章节 .md 写回服务器存储 raw/sources/<slug>/，**不触发摄取**（内容已在 DB，
// 重摄取会因重解析字节变化引发不必要的 LLM 重处理）。复用 transcriber 的 ApiClient
// （writeSource=POST /files/:pid/write，与 multipart upload 同落 storage.write_bytes）。
// 评审 round2 加固：现有同内容 → 跳过；现有异内容 → 默认拒写（--force 才覆写）；
// 写后回读比对（round-trip）。--dry-run 列清单零写入。
// 用法：SVC_PASSWORD=... npx tsx tools/books/upload_only.ts --book <slug> [--dir /Users/berton/kb-books] [--dry-run] [--force]
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
const DRY = args.includes("--dry-run")
const FORCE = args.includes("--force")
if (!book) { console.error("缺 --book <slug>"); process.exit(1) }

const bookDir = join(dir, book)
const stagedDir = join(bookDir, "staged")
if (!existsSync(stagedDir)) { console.error(`缺 staged 目录：${stagedDir}（先跑 mineru_parse）`); process.exit(1) }

const files = readdirSync(stagedDir).filter((f) => f.endsWith(".md")).sort()
console.log(`book=${book} staged=${files.length} 章 → 只上传不摄取${DRY ? "（DRY-RUN）" : ""}${FORCE ? "（--force 允许覆写异内容）" : ""}`)

const password = process.env.SVC_PASSWORD
if (!password) { console.error("缺 SVC_PASSWORD（source tools/transcriber/out/bootstrap.env）"); process.exit(1) }
const api = new ApiClient(process.env.BASE_URL ?? "http://127.0.0.1:8080", {
  projectId: Number(process.env.PROJECT_ID ?? 614),
  authPath: join(here, "../transcriber/out/auth.json"),
})
await api.login(process.env.SVC_USERNAME ?? "svc-transcriber", password)

/** 读现有存储文件内容；不存在返回 null（404），瞬时错误重试一次。 */
async function readExisting(rel: string): Promise<string | null | "error"> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await api.authedFetch(`/api/v1/files/${api.projectId}/raw/${rel}`)
    if (res.ok) return await res.text()
    if (res.status === 404) return null
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 1500))
      continue
    }
    return "error"
  }
  return "error"
}

let ok = 0, skippedSame = 0
const failures: string[] = []
for (const f of files) {
  const rel = `raw/sources/${book}/${f}`
  const local = readFileSync(join(stagedDir, f), "utf-8")
  try {
    const existing = await readExisting(rel)
    if (existing === "error") { failures.push(`${f}: 读现有内容失败`); continue }
    if (existing === local) { skippedSame++; continue }
    if (existing !== null && !FORCE) {
      failures.push(`${f}: 存储已有异内容（${existing.length} vs staged ${local.length} 字节），拒写——确认后 --force`)
      continue
    }
    if (DRY) { ok++; continue }
    await api.writeSource(rel, local)
    const back = await readExisting(rel)
    if (back !== local) { failures.push(`${f}: 写后回读不一致`); continue }
    ok++
  } catch (e) {
    failures.push(`${f}: ${String(e).slice(0, 120)}`)
  }
}
console.log(`上传完成：ok=${ok} 已存在相同跳过=${skippedSame} refused/failed=${failures.length}`)
for (const x of failures) console.log(`  ✗ ${x}`)
process.exit(failures.length > 0 ? 1 : 0)
