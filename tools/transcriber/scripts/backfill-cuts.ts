// tools/transcriber/scripts/backfill-cuts.ts —— 评审 C1 收尾：为已语义切章的存量视频
// 回填 cuts 快照（out/chapters/<slug>.json），使断点续跑路径可字节级重建、绝不重调 LLM。
// 推导源：media_assets.chapters（rechapter 写入的 start_s/label）→ 反查 segment 下标；
// 每条都做字节对账：按快照重建的 md 必须与 DB 页逐字节一致，否则不落快照并报错。
// 用法：SVC_PASSWORD=... npx tsx tools/transcriber/scripts/backfill-cuts.ts
import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { join, dirname, basename } from "node:path"
import { fileURLToPath } from "node:url"
import { ApiClient } from "../src/api-client"
import { parseWhisperJson } from "../src/whisper"
import { validateCuts, buildSemanticMd, type ChapterCut } from "../src/chaptering"
import type { TranscriptInput } from "../src/transcript"

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, "../out")

const titleOf = (p: string): string => basename(p).replace(/\.[A-Za-z0-9]{1,6}$/, "")

interface MediaChap { slug: string; duration_s: number; chapters: Array<{ start_s: number; end_s: number; label: string }> }
const media: MediaChap[] = JSON.parse(readFileSync(join(outDir, "rechapter-chapters.json"), "utf-8"))
const state = readFileSync(join(outDir, "state.jsonl"), "utf-8")
  .trim().split("\n").map((l) => JSON.parse(l) as { slug: string; status: string; relPath: string })
const relBySlug = new Map(state.map((s) => [s.slug, s.relPath]))

const password = process.env.SVC_PASSWORD
if (!password) { console.error("缺 SVC_PASSWORD"); process.exit(1) }
const api = new ApiClient(process.env.BASE_URL ?? "http://127.0.0.1:8080", {
  projectId: Number(process.env.PROJECT_ID ?? 614),
  authPath: join(outDir, "auth.json"),
})
await api.login(process.env.SVC_USERNAME ?? "svc-transcriber", password)

let ok = 0
const mismatch: string[] = []
const skipped: string[] = []

/** GET 页内容（限流耐受：连续 239 个 GET 会触发突发限流 429——空体/非 2xx 退避重试）。 */
async function getPageContent(pagePath: string): Promise<string | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await api.authedFetch(`/api/v1/projects/${api.projectId}/page?path=${encodeURIComponent(pagePath)}`)
    if (res.ok) {
      const page = (await res.json()) as { content: string | null }
      return page.content ?? null
    }
    if (res.status !== 429 && res.status < 500) return null // 语义性失败不重试
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)))
  }
  return null
}

for (const m of media) {
  const relPath = relBySlug.get(m.slug)
  const jsonPath = join(outDir, "transcripts", `${m.slug}.json`)
  if (!relPath || m.chapters.length === 0) { skipped.push(m.slug); continue }
  const segments = parseWhisperJson(JSON.parse(readFileSync(jsonPath, "utf-8")))
  // 反查：每章 start_s 与 segments[cut.startIdx].startS 是同一次 ms/1000 计算——浮点逐位相等
  // （1e-6 精确容差；宽松容差会把边界前零点几秒的 segment 错吸附，实测翻车）。
  // whisper 偶有同 startS 重复 segment：每边界收集全部精确候选，默认取前章 end_s
  // 锚定后的第一个，字节对账不过再对重复边界做组合枚举兜底（乘积上限 32）。
  const boundaryCandidates: number[][] = []
  let abort = false
  for (let ci = 1; ci < m.chapters.length && !abort; ci++) {
    const ch = m.chapters[ci]
    const prevEnd = m.chapters[ci - 1].end_s
    let p = -1
    for (let i = segments.length - 1; i >= 0; i--) {
      if (Math.abs(segments[i].endS - prevEnd) < 1e-6) { p = i; break }
    }
    const anchored = segments.findIndex((s, i) => i > p && Math.abs(s.startS - ch.start_s) < 1e-6)
    const loose = segments.map((s, i) => (Math.abs(s.startS - ch.start_s) < 1e-6 ? i : -1)).filter((i) => i >= 0)
    const all = [...new Set([anchored, ...loose])].filter((i) => i >= 0).sort((a, b) => a - b)
    if (all.length === 0) { skipped.push(`${m.slug}(章 ${ci + 1} 起点 ${ch.start_s}s 无精确匹配 segment)`); abort = true }
    else boundaryCandidates.push(all)
  }
  if (abort) continue

  const input: TranscriptInput = {
    title: titleOf(relPath), segments,
    sourcePath: `sources/transcripts/${m.slug}.md`, mediaSlug: m.slug, durationS: m.duration_s,
  }
  const pagePath = `transcripts/${m.slug}.md`
  const content = await getPageContent(pagePath)
  if (content === null) { mismatch.push(`${m.slug}: GET 失败/空内容`); continue }

  const buildWith = (pick: (bi: number) => number): string | null => {
    const cuts: ChapterCut[] = [{ startIdx: 0, title: m.chapters[0].label }]
    for (let bi = 0; bi < boundaryCandidates.length; bi++) {
      cuts.push({ startIdx: pick(bi), title: m.chapters[bi + 1].label })
    }
    const valid = validateCuts(cuts, segments.length)
    return valid ? buildSemanticMd(input, valid) : null
  }

  let picked: number[] | null = null
  if (buildWith((bi) => boundaryCandidates[bi][0]) === content) {
    picked = boundaryCandidates.map((c) => c[0])
  } else {
    let combos: number[][] = [[]]
    for (const cands of boundaryCandidates) {
      const next: number[][] = []
      for (const base of combos) for (const c of cands) next.push([...base, c])
      combos = next.slice(0, 32)
    }
    for (const combo of combos) {
      if (buildWith((bi) => combo[bi]) === content) { picked = combo; break }
    }
  }
  if (!picked) { mismatch.push(`${m.slug}: 重建与 DB 页不一致（枚举兜底未命中）`); continue }

  const cutsFinal: ChapterCut[] = [{ startIdx: 0, title: m.chapters[0].label }]
  boundaryCandidates.forEach((_, bi) => cutsFinal.push({ startIdx: picked![bi], title: m.chapters[bi + 1].label }))
  const dir = join(outDir, "chapters")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${m.slug}.json`), JSON.stringify(cutsFinal))
  ok++
  await new Promise((r) => setTimeout(r, 120)) // 节流：留出限流窗口
}
console.log(`cuts 快照回填：ok=${ok} mismatch=${mismatch.length} skipped=${skipped.length}`)
for (const x of mismatch) console.log(`  MISMATCH ${x}`)
for (const x of skipped.slice(0, 5)) console.log(`  SKIP ${x}`)
process.exit(mismatch.length > 0 ? 1 : 0)
