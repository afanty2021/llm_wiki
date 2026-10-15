// tools/transcriber/scripts/media-rebuild.ts
// 10-10 wipe 后 media_assets + transcripts 页全量确定性重建（批2：余下 842 slug；
// 含批1 77 行的 chapters 回填）。
//
// 关键事实（勘误批1「章节真丢」结论）：LLM 语义切章产物并未丢——
//  - 存储转写源正文（含 `## [mm:ss]` 语义章头+标点+课例摘要）盘上幸存；
//  - out/chapters/<slug>.json cuts 快照（919 份 = 全部 done）盘上幸存；
//  - out/transcripts/<slug>.json whisper segments 盘上幸存。
// 因此 chapters 走 buildTranscriptForReuse 同款路径确定性重建（loadCuts→chaptersFor，
// 与误删前字节一致），**绝不调 LLM**。重跑 rechapter 既无必要也必然全 skip——其预检门
// 要求 DB 页 = 机械重建版，而我们的页是语义终版。无快照/快照非法 → 机械 300s 窗章
// （buildTranscriptMd().chapters，与摄取链回落语义一致）。
//
// 写入通道 = 摄取链同款：upsertTranscriptPage（POST→409→sha 比→PUT 幂等；页写入
// 服务端内联 embed）+ registerMediaAssets（ON CONFLICT slug：chapters 全覆盖，
// playback_path COALESCE 保人工值）。批1（77 引用行，2026-10-15）同通道已验证。
// duration/codec 取 out/manifest.json 行（原行同源：原值即 scan 产物）。kind 镜像
// cli.ts:723 恒 "video"（manifest category 出现 audio 则计问题防口径漂移）。
// playback_path 恒 None：MEDIA__ALLOWED_ROOTS 只含 HEVC 根，out/playback 演示件
// （116-3f89a942）词法越界必 400 整批——回落 media_ref=HEVC 原件（批1 已实证可播），
// 演示转码覆盖记为已知残留（不为 1 个文件改根集+重启）。
//
// 用法：
//   SVC_PASSWORD=... npx tsx tools/transcriber/scripts/media-rebuild.ts --check     # 零写入
//   SVC_PASSWORD=... npx tsx tools/transcriber/scripts/media-rebuild.ts --execute [--concurrency 3]
// 审计落 ~/kb-dumps/20261015-media-rebuild-batch2/；报告落 out/media-rebuild-report.json。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs"
import { join, dirname, basename } from "node:path"
import { fileURLToPath } from "node:url"
import { ApiClient, type MediaAssetItem } from "../src/api-client"
import { parseWhisperJson } from "../src/whisper"
import { buildTranscriptMd, type TranscriptInput } from "../src/transcript"
import { loadCuts, chaptersFor } from "../src/chaptering"

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, "../out")
const STORAGE_TR = process.env.KB_STORAGE_TR ?? "/Users/berton/kb-storage/teams/916/projects/614/sources/transcripts"

const args = process.argv.slice(2)
const flag = (n: string) => args.includes(n)
const opt = (n: string, d: string) => {
  const i = args.indexOf(n)
  return i >= 0 ? args[i + 1] : d
}
const EXECUTE = flag("--execute")
const CONCURRENCY = Math.max(1, Math.min(6, Number(opt("--concurrency", "3"))))

const titleOf = (relPath: string): string => basename(relPath).replace(/\.[A-Za-z0-9]{1,6}$/, "")

interface ManifestRow {
  relPath: string; category: string; durationS: number; videoCodec?: string | null
}
const manifest = JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf-8")) as { baseDir: { hevc: string }; rows: ManifestRow[] }
const byRel = new Map(manifest.rows.map((r) => [r.relPath, r]))

const stateLines = readFileSync(join(outDir, "state.jsonl"), "utf-8")
  .trim().split("\n").map((l) => JSON.parse(l) as { slug: string; status: string; relPath: string })
const targets = stateLines.filter((l) => l.status === "done")
console.log(`模式=${EXECUTE ? "EXECUTE" : "check"} 目标=${targets.length}（state done）并发=${CONCURRENCY}`)

interface Problem { slug: string; reason: string }
const problems: Problem[] = []
const items: MediaAssetItem[] = []
let semantic = 0, mechanical = 0, emptyChapters = 0, mdHeadingFallback = 0

for (const { slug, relPath } of targets) {
  const pagePath = `transcripts/${slug}.md`
  const sourcePath = `sources/transcripts/${slug}.md`
  const row = byRel.get(relPath)
  if (!row) { problems.push({ slug, reason: "manifest 无此 relPath" }); continue }
  if (row.category === "audio") { problems.push({ slug, reason: "manifest category=audio（预期全 video）" }); continue }
  const mediaRef = join(manifest.baseDir.hevc, relPath)
  if (!existsSync(mediaRef)) { problems.push({ slug, reason: `媒体文件缺失: ${relPath.slice(0, 60)}` }); continue }
  if (!existsSync(join(STORAGE_TR, `${slug}.md`))) { problems.push({ slug, reason: "存储转写源缺失" }); continue }
  const jsonPath = join(outDir, "transcripts", `${slug}.json`)
  if (!existsSync(jsonPath)) {
    // 回填路径（全库仅 1 例 04-…-953eec43）：whisper json 缺失但 md 章头与 cuts 快照俱在——
    // `## [mm:ss] 标题` 本就渲染自章首 segment 实际时刻，起点精确；end 取下一章起点
    // （末章=duration），跨静默段有近似。章数与快照不符则计问题不猜。
    const mdDisk = readFileSync(join(STORAGE_TR, `${slug}.md`), "utf-8")
    const heads = [...mdDisk.matchAll(/^## \[(\d+):(\d+)\] (.+)$/gm)]
      .map((m) => ({ start_s: Number(m[1]) * 60 + Number(m[2]), label: m[3] }))
    let snapN = -1
    try { snapN = (JSON.parse(readFileSync(join(outDir, "chapters", `${slug}.json`), "utf-8")) as unknown[]).length } catch { /* 无快照 */ }
    if (snapN > 0 && heads.length === snapN) {
      mdHeadingFallback++
      items.push({
        slug, media_ref: mediaRef, playback_path: null,
        duration_s: row.durationS, codec: row.videoCodec ?? null, kind: "video",
        chapters: heads.map((h, i) => ({
          start_s: h.start_s,
          end_s: i + 1 < heads.length ? heads[i + 1].start_s : row.durationS,
          label: h.label,
        })),
        transcript_page_path: pagePath, source_path: sourcePath,
      })
      continue
    }
    problems.push({ slug, reason: `whisper json 缺失且 md 章头(${heads.length})≠快照(${snapN})` }); continue
  }

  const segments = parseWhisperJson(JSON.parse(readFileSync(jsonPath, "utf-8")))
  const input: TranscriptInput = {
    title: titleOf(relPath), segments, sourcePath, mediaSlug: slug, durationS: row.durationS,
  }
  // cuts 快照 → 语义章（与误删前一致）；无/非法快照 → 机械窗章（摄取链回落语义）
  const cuts = loadCuts(outDir, slug, segments.length)
  const chapters = cuts ? chaptersFor(segments, cuts) : buildTranscriptMd(input).chapters
  if (cuts) semantic++; else if (chapters.length > 0) mechanical++; else emptyChapters++

  items.push({
    slug, media_ref: mediaRef, playback_path: null,
    duration_s: row.durationS, codec: row.videoCodec ?? null, kind: "video",
    chapters, transcript_page_path: pagePath, source_path: sourcePath,
  })
}

const ch = items.filter((i) => Array.isArray(i.chapters) && (i.chapters as unknown[]).length > 0).length
console.log(`就绪 ${items.length} / 问题 ${problems.length}；chapters：语义 ${semantic} + 机械 ${mechanical} + md章头回填 ${mdHeadingFallback} + 空 ${emptyChapters} = 非空 ${ch}`)
for (const p of problems) console.log(`  [MISS] ${p.slug}: ${p.reason}`)
for (const it of items.slice(0, 3)) {
  const c0 = (it.chapters as Array<{ start_s: number; label: string }>)[0]
  console.log(`  ${it.slug}: ${it.duration_s}s ${it.codec} 章${(it.chapters as unknown[]).length}${c0 ? ` 首章[${c0.start_s}s] ${c0.label.slice(0, 18)}` : ""}`)
}
if (!EXECUTE) {
  console.log("check 完成（零写入）")
  process.exit(problems.length > 0 ? 1 : 0)
}

// —— 审计留档 ——
const auditDir = join(process.env.HOME ?? "", "kb-dumps/20261015-media-rebuild-batch2")
mkdirSync(auditDir, { recursive: true })
writeFileSync(join(auditDir, "items.json"), JSON.stringify(items, null, 1))
if (problems.length) writeFileSync(join(auditDir, "problems.json"), JSON.stringify(problems, null, 1))

const password = process.env.SVC_PASSWORD
if (!password) { console.error("缺 SVC_PASSWORD（source tools/transcriber/out/bootstrap.env）"); process.exit(1) }
const api = new ApiClient(process.env.BASE_URL ?? "http://127.0.0.1:8080", {
  projectId: Number(process.env.PROJECT_ID ?? 614),
  authPath: join(outDir, "auth.json"),
})
await api.login(process.env.SVC_USERNAME ?? "svc-transcriber", password)

// a) media_assets 批量 upsert（50/批）
let imported = 0
for (let i = 0; i < items.length; i += 50) {
  imported += await api.registerMediaAssets(items.slice(i, i + 50))
  console.log(`media-assets: ${Math.min(i + 50, items.length)}/${items.length}（累计 imported=${imported}）`)
}

// b) transcripts 页 upsert（worker 池，幂等：existing 77 行 sha 相等自动 skipped）
type Upsert = "created" | "updated" | "skipped"
const pageOutcomes = new Map<string, Upsert | "failed">()
const queue = [...items]
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  for (;;) {
    const it = queue.shift()
    if (!it) return
    const md = readFileSync(join(STORAGE_TR, `${it.slug}.md`), "utf-8")
    try {
      pageOutcomes.set(it.slug, await api.upsertTranscriptPage(it.transcript_page_path as string, md))
    } catch (e) {
      pageOutcomes.set(it.slug, "failed")
      console.error(`  [FAIL] ${it.slug}: ${String(e).slice(0, 180)}`)
    }
    await new Promise((r) => setTimeout(r, 120)) // 节流：留出限流窗口
  }
}))
const by = (s: string) => [...pageOutcomes.values()].filter((v) => v === s).length
console.log(`transcript 页：created=${by("created")} updated=${by("updated")} skipped=${by("skipped")} failed=${by("failed")}`)

writeFileSync(join(outDir, "media-rebuild-report.json"), JSON.stringify({
  generatedAt: new Date().toISOString(),
  targets: targets.length, ready: items.length, problems,
  chapters: { semantic, mechanical, mdHeadingFallback, emptyChapters },
  mediaImported: imported,
  pages: Object.fromEntries(pageOutcomes),
}, null, 2))
console.log(`报告：${join(outDir, "media-rebuild-report.json")}`)
process.exit(problems.length > 0 || by("failed") > 0 ? 1 : 0)
