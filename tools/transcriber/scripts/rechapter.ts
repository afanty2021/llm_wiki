// tools/transcriber/scripts/rechapter.ts
// 视频章节语义重切（存量迁移工具）：以 whisper segments 为输入，LLM 按话题划分章节
// （吸附 segment 起点）重写 transcript 页/存储源文件/media.chapters，并**同步落 cuts 快照**
// （评审 round2 复活通道收口：无快照的语义页会在续跑时被机械重建复活 C1 症状）。
// 切章/守门/构建逻辑全部 import ../src/chaptering（与摄取链同源，含四项加固）。
//
// 安全设计：
//  - 预检门：以旧机械切分重建 md，与 DB 页逐字节比对；不相等（页面被编辑过/已是语义版）
//    即跳过该视频，绝不盲写。重跑已重切过的库 → 全部 skipped 且**非零退出**（看似成功是坑）。
//  - 守门：src/chaptering guardrailReason（≥10min 仅 1 章/单章>45min/>50 章幻觉微章）→ 保留旧切分。
//  - GET 限流退避：连续批量读页触发服务端 429 时内容读空——重试 + 节流。
//
// 用法：
//   SVC_PASSWORD=... npx tsx tools/transcriber/scripts/rechapter.ts --check     # 零写入预检
//   SVC_PASSWORD=... npx tsx tools/transcriber/scripts/rechapter.ts --only a,b  # 试点
//   SVC_PASSWORD=... npx tsx tools/transcriber/scripts/rechapter.ts --all [--exclude a,b]
//   可选：--model glm-5.1 --dry-run --concurrency 3
// 凭证：ZAI_API_KEY env 或 ~/.hermes/.env（不打印）；SVC_PASSWORD 必填。
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { join, dirname, basename } from "node:path"
import { fileURLToPath } from "node:url"
import { ApiClient } from "../src/api-client"
import { parseWhisperJson, type Segment } from "../src/whisper"
import type { TranscriptInput } from "../src/transcript"
import { buildTranscriptMd } from "../src/transcript"
import {
  DEFAULT_CHAPTERING, llmChapter, guardrailReason, buildSemanticMd, chaptersFor, persistCuts,
  validateCuts, type ChapterCut,
} from "../src/chaptering"

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, "../out")

const args = process.argv.slice(2)
const flag = (n: string) => args.includes(n)
const opt = (n: string, d: string) => {
  const i = args.indexOf(n)
  return i >= 0 ? args[i + 1] : d
}
const MODEL = opt("--model", "glm-5.1")
const CONCURRENCY = Math.max(1, Math.min(6, Number(opt("--concurrency", "3"))))
const DRY = flag("--dry-run")
const MODE = flag("--check") ? "check" : flag("--all") ? "all" : "only"
const chapterCfg = { ...DEFAULT_CHAPTERING, enabled: true, model: MODEL }

const titleOf = (absPath: string): string => basename(absPath).replace(/\.[A-Za-z0-9]{1,6}$/, "")

function loadZaiKey(): string {
  if (process.env.ZAI_API_KEY) return process.env.ZAI_API_KEY
  try {
    const line = readFileSync(`${process.env.HOME}/.hermes/.env`, "utf-8")
      .split("\n")
      .find((l) => /^ZAI_API_KEY=/.test(l))
    return line ? line.split("=").slice(1).join("=").trim() : ""
  } catch {
    return ""
  }
}
const ZAI_KEY = process.env.ZAI_API_KEY || loadZaiKey()
if (!ZAI_KEY && MODE !== "check") {
  console.error("缺 ZAI_API_KEY（env 或 ~/.hermes/.env）")
  process.exit(1)
}

interface MediaRow {
  slug: string; media_ref: string; playback_path: string | null
  duration_s: number; codec: string | null; kind: string
  transcript_page_path: string | null; source_path: string | null
}
const mediaBySlug = new Map(
  (JSON.parse(readFileSync(join(outDir, "rechapter-media.json"), "utf-8")) as MediaRow[]).map((r) => [r.slug, r]),
)

const stateLines = readFileSync(join(outDir, "state.jsonl"), "utf-8")
  .trim().split("\n").map((l) => JSON.parse(l) as { slug: string; status: string; relPath: string })
let targets = stateLines.filter((l) => l.status === "done")
if (MODE === "only") {
  const want = new Set(opt("--only", "").split(",").map((s) => s.trim()).filter(Boolean))
  targets = targets.filter((l) => want.has(l.slug))
  if (targets.length === 0) { console.error(`--only 未命中任何 slug（state done 共 ${targets.length} 个）`); process.exit(1) }
}
{
  const ex = new Set(opt("--exclude", "").split(",").map((s) => s.trim()).filter(Boolean))
  if (ex.size) targets = targets.filter((l) => !ex.has(l.slug))
}
console.log(`模式=${MODE} 目标=${targets.length} model=${MODEL} concurrency=${CONCURRENCY}${DRY ? " DRY-RUN" : ""}`)

const password = process.env.SVC_PASSWORD
if (!password) { console.error("缺 SVC_PASSWORD（source tools/transcriber/out/bootstrap.env）"); process.exit(1) }
const api = new ApiClient(process.env.BASE_URL ?? "http://127.0.0.1:8080", {
  projectId: Number(process.env.PROJECT_ID ?? 614),
  authPath: join(outDir, "auth.json"),
})
await api.login(process.env.SVC_USERNAME ?? "svc-transcriber", password)

/** GET 页内容（限流耐受：429/5xx 退避重试；语义性 4xx 直接 null）。 */
async function getPageContent(pagePath: string): Promise<string | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await api.authedFetch(`/api/v1/projects/${api.projectId}/page?path=${encodeURIComponent(pagePath)}`)
    if (res.ok) {
      const page = (await res.json()) as { content: string | null }
      return page.content ?? null
    }
    if (res.status !== 429 && res.status < 500) return null
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)))
  }
  return null
}

interface Outcome {
  slug: string; status: "ok" | "skipped_stale_page" | "fallback_old_cut" | "error"
  oldChapters?: number; newChapters?: number; titles?: string[]; reason?: string
}
const outcomes: Outcome[] = []

async function processOne(line: { slug: string; relPath: string }): Promise<Outcome> {
  const { slug, relPath } = line
  const media = mediaBySlug.get(slug)
  const jsonPath = join(outDir, "transcripts", `${slug}.json`)
  if (!media || !existsSync(jsonPath)) return { slug, status: "error", reason: media ? "transcript json 缺失" : "media_assets 无该 slug" }
  const pagePath = `transcripts/${slug}.md`
  const sourcePath = `sources/transcripts/${slug}.md`
  const input: TranscriptInput = {
    title: titleOf(relPath), segments: parseWhisperJson(JSON.parse(readFileSync(jsonPath, "utf-8"))),
    sourcePath, mediaSlug: slug, durationS: media.duration_s,
  }
  const segments: Segment[] = input.segments
  if (segments.length === 0) return { slug, status: "error", reason: "segments 空" }

  // 预检门：机械重建须与 DB 页逐字节一致（证明输入同源且未被编辑/未被重切过）
  const content = await getPageContent(pagePath)
  if (content === null) return { slug, status: "error", reason: "GET 页失败/空内容" }
  if (content !== buildTranscriptMd(input).md) {
    return { slug, status: "skipped_stale_page", reason: "DB 页与机械重建不一致（已重切/被编辑过），不动" }
  }
  if (MODE === "check") return { slug, status: "ok" }

  let cuts: ChapterCut[]
  try {
    cuts = await llmChapter(input.title, segments, chapterCfg, { apiKey: ZAI_KEY })
  } catch (e) {
    return { slug, status: "error", reason: `LLM: ${String(e).slice(0, 140)}` }
  }
  if (!validateCuts(cuts, segments.length)) return { slug, status: "error", reason: "LLM 切分非法" }
  const guard = guardrailReason(cuts, segments, input.durationS)
  if (guard) return { slug, status: "fallback_old_cut", reason: guard }

  const newMd = buildSemanticMd(input, cuts)
  const newChapters = chaptersFor(segments, cuts)
  if (DRY) {
    return { slug, status: "ok", oldChapters: segments.length ? undefined : 0, newChapters: cuts.length, titles: cuts.map((c) => c.title) }
  }
  await api.upsertTranscriptPage(pagePath, newMd)
  await api.writeSource(sourcePath, newMd)
  await api.registerMediaAssets([{
    slug, media_ref: media.media_ref, playback_path: media.playback_path,
    duration_s: media.duration_s, codec: media.codec, kind: media.kind as "video",
    chapters: newChapters, transcript_page_path: pagePath, source_path: sourcePath,
  }])
  // 复活通道收口：语义页必须带快照，否则续跑机械重建会复活 C1 症状
  persistCuts(outDir, slug, cuts)
  return { slug, status: "ok", newChapters: cuts.length, titles: cuts.map((c) => c.title) }
}

// 简单工人池（固定并发；check 模式 4 并发——8 并发易触发限流误报）
const queue = [...targets]
const workers = Array.from({ length: MODE === "check" ? 4 : CONCURRENCY }, async () => {
  for (;;) {
    const line = queue.shift()
    if (!line) return
    try {
      outcomes.push(await processOne(line))
      if (outcomes.length % 20 === 0 || outcomes.length === targets.length) console.log(`  ${outcomes.length}/${targets.length}…`)
    } catch (e) {
      outcomes.push({ slug: line.slug, status: "error", reason: String(e).slice(0, 160) })
    }
    await new Promise((r) => setTimeout(r, 120)) // 节流：留出限流窗口
  }
})
await Promise.all(workers)

const by = (s: string) => outcomes.filter((o) => o.status === s).length
console.log(`完成：ok=${by("ok")} skipped_stale_page=${by("skipped_stale_page")} fallback_old_cut=${by("fallback_old_cut")} error=${by("error")}`)
for (const o of outcomes) {
  if (o.status !== "ok") console.log(`  [${o.status}] ${o.slug}: ${o.reason}`)
  else if (o.titles && MODE !== "check") console.log(`  ${o.slug}: →${o.newChapters} 章 | ${o.titles.join(" / ")}`)
}
writeFileSync(join(outDir, "rechapter-report.json"), `${JSON.stringify({ model: MODEL, generatedAt: new Date().toISOString(), outcomes }, null, 2)}\n`)
console.log(`报告：${join(outDir, "rechapter-report.json")}`)
// 退出码：有 error，或一条都没切成（全 skip 的重跑看似成功是坑——评审 round2 三修之一）
process.exit(by("error") > 0 || (by("ok") === 0 && targets.length > 0) ? 1 : 0)
