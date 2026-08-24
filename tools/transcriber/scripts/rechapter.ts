// tools/transcriber/scripts/rechapter.ts
// 视频章节语义重切：以 whisper segments 为输入，LLM（zai coding 通道）按话题/教学环节
// 划分章节边界（吸附到 segment 起点）+ 生成中文标题；重写 transcript 页正文的
// `## [mm:ss] 标题` 小节头（章内保留 ~300s 窗口的 [mm:ss] 行粒度），并覆写
// media_assets.chapters（POST /training/media-assets ON CONFLICT 覆写语义）。
//
// 安全设计：
//  - 预检门（--check / 试点与全量自动先跑）：以旧 300s 窗口重建 md，与 DB 页逐字节比对；
//    不相等（页面被事后编辑过）即跳过该视频，绝不盲写。
//  - LLM 产出守门：首章必须 start_idx=0、严格递增、全覆盖；章节数或跨度异常
//    （≥10min 视频仅 1 章 / 单章 >45min）→ 保留旧切分（记 fallback）。
//  - 页面回写走 ApiClient.upsertTranscriptPage（POST→409→GET→If-Match PUT 幂等链）。
//
// 用法：
//   npx tsx tools/transcriber/scripts/rechapter.ts --check              # 零写入预检
//   npx tsx tools/transcriber/scripts/rechapter.ts --only slug1,slug2   # 试点
//   npx tsx tools/transcriber/scripts/rechapter.ts --all                # 全量 239
//   可选：--model glm-5.1 --dry-run --concurrency 3
// 凭证：ZAI_API_KEY 环境变量，缺省从 ~/.hermes/.env 读取（不打印）。
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { join, dirname, basename } from "node:path"
import { fileURLToPath } from "node:url"
import { ApiClient } from "../src/api-client"
import { parseWhisperJson, type Segment } from "../src/whisper"
import { mmss, CHAPTER_WINDOW_S, LABEL_MAX } from "../src/transcript"

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, "../out")

const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:8080"
const ZAI_BASE = "https://open.bigmodel.cn/api/coding/paas/v4" // China Coding Plan（订阅计费通道）
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

const titleOf = (absPath: string): string => basename(absPath).replace(/\.[A-Za-z0-9]{1,6}$/, "")

// ── 凭证：ZAI_API_KEY（env 优先，回落 ~/.hermes/.env）──
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
const ZAI_KEY = loadZaiKey()
if (!ZAI_KEY && MODE !== "check") {
  console.error("缺 ZAI_API_KEY（env 或 ~/.hermes/.env）")
  process.exit(1)
}

// ── 输入装配 ──
interface MediaRow {
  slug: string; media_ref: string; playback_path: string | null
  duration_s: number; codec: string | null; kind: string
  transcript_page_path: string | null; source_path: string | null
}
const mediaRows: MediaRow[] = JSON.parse(readFileSync(join(outDir, "rechapter-media.json"), "utf-8"))
const mediaBySlug = new Map(mediaRows.map((r) => [r.slug, r]))

const stateLines = readFileSync(join(outDir, "state.jsonl"), "utf-8")
  .trim().split("\n").map((l) => JSON.parse(l) as { slug: string; status: string; relPath: string })
const doneAll = stateLines.filter((l) => l.status === "done")

let targets = doneAll
if (MODE === "only") {
  const want = new Set(opt("--only", "").split(",").map((s) => s.trim()).filter(Boolean))
  targets = doneAll.filter((l) => want.has(l.slug))
  if (targets.length === 0) { console.error(`--only 未命中任何 slug（state done 共 ${doneAll.length} 个）`); process.exit(1) }
}
{
  const ex = new Set(opt("--exclude", "").split(",").map((s) => s.trim()).filter(Boolean))
  if (ex.size) targets = targets.filter((l) => !ex.has(l.slug))
}
console.log(`模式=${MODE} 目标=${targets.length} model=${MODEL} concurrency=${CONCURRENCY}${DRY ? " DRY-RUN" : ""}`)

// ── 旧窗重建（预检门用）：与 src/transcript.buildTranscriptMd 的窗口化完全同构 ──
function windowsOf(segments: Segment[]): Map<number, Segment[]> {
  const w = new Map<number, Segment[]>()
  for (const seg of [...segments].sort((a, b) => a.startS - b.startS)) {
    const k = Math.floor(seg.startS / CHAPTER_WINDOW_S)
    const b = w.get(k) ?? []
    b.push(seg); w.set(k, b)
  }
  return w
}
function frontmatter(title: string, slug: string, durationS: number, sourcePath: string): string {
  return [
    "---",
    `title: ${JSON.stringify(title)}`,
    "type: transcript",
    `media_slug: ${slug}`,
    `duration_s: ${durationS}`,
    "sources:",
    `  - ${sourcePath}`,
    "---",
  ].join("\n")
}
function buildOldMd(title: string, slug: string, durationS: number, sourcePath: string, segments: Segment[]): string {
  const blocks: string[] = []
  for (const [k, segs] of [...windowsOf(segments).entries()].sort((a, b) => a[0] - b[0])) {
    const startS = segs[0].startS
    const label = segs[0].text.trim().slice(0, LABEL_MAX)
    const stamp = mmss(startS)
    blocks.push(`## ${stamp} ${label}`)
    blocks.push(`${stamp} ${segs.map((s) => s.text).join(" ")}`)
  }
  const fm = frontmatter(title, slug, durationS, sourcePath)
  return blocks.length === 0 ? `${fm}\n` : `${fm}\n\n${blocks.join("\n\n")}\n`
}
// ── 新章重建：语义章 `## [mm:ss] 标题`，章内正文保留 300s 窗口行（粒度与旧版一致）──
interface ChapterCut { startIdx: number; title: string }
function buildNewMd(title: string, slug: string, durationS: number, sourcePath: string, segments: Segment[], cuts: ChapterCut[]): string {
  const fm = frontmatter(title, slug, durationS, sourcePath)
  const bounds = cuts.map((c) => c.startIdx)
  const blocks: string[] = []
  for (let ci = 0; ci < cuts.length; ci++) {
    const from = bounds[ci]
    const to = ci + 1 < cuts.length ? bounds[ci + 1] : segments.length
    const chapSegs = segments.slice(from, to)
    if (chapSegs.length === 0) continue
    blocks.push(`## ${mmss(chapSegs[0].startS)} ${cuts[ci].title}`)
    // 章内按 300s 窗口分段（与旧正文行同粒度），保持长章可读
    for (const [, segs] of [...windowsOf(chapSegs).entries()].sort((a, b) => a[0] - b[0])) {
      blocks.push(`${mmss(segs[0].startS)} ${segs.map((s) => s.text).join(" ")}`)
    }
  }
  return blocks.length === 0 ? `${fm}\n` : `${fm}\n\n${blocks.join("\n\n")}\n`
}
function chaptersFor(segments: Segment[], cuts: ChapterCut[]) {
  const bounds = cuts.map((c) => c.startIdx)
  const out: { start_s: number; end_s: number; label: string }[] = []
  for (let ci = 0; ci < cuts.length; ci++) {
    const from = bounds[ci]
    const to = ci + 1 < cuts.length ? bounds[ci + 1] : segments.length
    const segs = segments.slice(from, to)
    if (segs.length === 0) continue
    out.push({ start_s: segs[0].startS, end_s: segs[segs.length - 1].endS, label: cuts[ci].title })
  }
  return out
}

// ── LLM 切章 ──
const SYS = [
  "你是课程视频的章节编辑。给你一份带时间戳的转写片段序列（编号|时刻|文本），",
  "请按话题与教学环节的内在逻辑划分章节边界，并为每章写一个简洁、信息充分的中文标题（不超过 20 字，说清该章讲什么）。",
  "规则：",
  "1. 边界只能落在给定片段的编号上（吸附）；第一章必须从 0 号开始；各章连续覆盖全部片段，不遗漏、不重叠。",
  "2. 章节数量由内容决定：内容单一的视频可以只有 1-2 章，内容转换多的可以有 8 章以上；不要机械等分。",
  "3. 只输出 JSON，形如 {\"chapters\":[{\"start_idx\":0,\"title\":\"…\"},{\"start_idx\":37,\"title\":\"…\"}]}，不要任何其他文字。",
].join("\n")

async function zaiChat(userMsg: string, allowThinking = true): Promise<string> {
  const body: Record<string, unknown> = {
    model: MODEL,
    messages: [
      { role: "system", content: SYS },
      { role: "user", content: userMsg },
    ],
    temperature: 0.2,
    max_tokens: 2000,
  }
  if (allowThinking) body.thinking = { type: "disabled" }
  const res = await fetch(`${ZAI_BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ZAI_KEY}` },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = (await res.text()).slice(0, 200)
    // 某些模型/端点不认 thinking 参数：去掉重试一次
    if (allowThinking && res.status === 400 && /thinking/i.test(text)) return zaiChat(userMsg, false)
    throw new Error(`zai HTTP ${res.status}: ${text}`)
  }
  const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
  return j.choices?.[0]?.message?.content ?? ""
}

function parseCuts(raw: string, nSegs: number): ChapterCut[] | null {
  const m = /\{[\s\S]*\}/.exec(raw)
  if (!m) return null
  let parsed: { chapters?: Array<{ start_idx?: unknown; title?: unknown }> }
  try { parsed = JSON.parse(m[0]) } catch { return null }
  const list = parsed.chapters
  if (!Array.isArray(list) || list.length === 0) return null
  const cuts: ChapterCut[] = []
  for (const c of list) {
    const idx = Number(c.start_idx)
    const title = typeof c.title === "string" ? c.title.trim().replace(/\s+/g, " ").slice(0, 30) : ""
    if (!Number.isInteger(idx) || idx < 0 || idx >= nSegs || !title) return null
    cuts.push({ startIdx: idx, title })
  }
  cuts.sort((a, b) => a.startIdx - b.startIdx)
  if (cuts[0].startIdx !== 0) return null
  for (let i = 1; i < cuts.length; i++) if (cuts[i].startIdx <= cuts[i - 1].startIdx) return null
  return cuts
}

async function llmChapter(title: string, segments: Segment[]): Promise<ChapterCut[]> {
  const lines = segments.map((s, i) => `${i}|${mmss(s.startS)}|${s.text}`).join("\n")
  const user = `视频标题：${title}\n片段序列（共 ${segments.length} 条）：\n${lines}`
  let lastErr = ""
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await zaiChat(user)
      const cuts = parseCuts(raw, segments.length)
      if (cuts) return cuts
      lastErr = `unparseable: ${raw.slice(0, 120)}`
    } catch (e) {
      lastErr = String(e).slice(0, 160)
      await new Promise((r) => setTimeout(r, 3000))
    }
  }
  throw new Error(lastErr)
}

// ── 主流程 ──
const api = new ApiClient(BASE_URL, { projectId: Number(process.env.PROJECT_ID ?? 614), authPath: join(outDir, "auth.json") })
await api.login(process.env.SVC_USERNAME ?? "svc-transcriber", (() => {
  const p = process.env.SVC_PASSWORD
  if (!p) { console.error("缺 SVC_PASSWORD"); process.exit(1) }
  return p
})())

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
  const title = titleOf(relPath)
  const durationS = media.duration_s
  const segments = parseWhisperJson(JSON.parse(readFileSync(jsonPath, "utf-8")))
  if (segments.length === 0) return { slug, status: "error", reason: "segments 空" }

  // 预检门：旧窗重建须与 DB 页逐字节一致（证明 title/duration/segments 与当年上传同源）
  const cur = await api.authedFetch(`/api/v1/projects/${api.projectId}/page?path=${encodeURIComponent(pagePath)}`)
  if (!cur.ok) return { slug, status: "error", reason: `GET page HTTP ${cur.status}` }
  const page = (await cur.json()) as { content: string | null }
  const expect = buildOldMd(title, slug, durationS, sourcePath, segments)
  if (page.content !== expect) return { slug, status: "skipped_stale_page", reason: "DB 页与旧窗重建不一致（页面被编辑过），不动" }
  if (MODE === "check") return { slug, status: "ok" }

  let cuts: ChapterCut[]
  try {
    cuts = await llmChapter(title, segments)
  } catch (e) {
    return { slug, status: "error", reason: `LLM: ${String(e).slice(0, 140)}` }
  }
  // 守门：≥10min 视频仅 1 章、或单章 >45min → 保留旧切分
  const chapterSpans = chaptersFor(segments, cuts)
  const maxSpan = Math.max(...chapterSpans.map((c) => c.end_s - c.start_s))
  if ((durationS >= 600 && cuts.length < 2) || maxSpan > 2700) {
    return { slug, status: "fallback_old_cut", reason: `守门（${cuts.length} 章 / 最大章 ${Math.round(maxSpan / 60)}min）` }
  }

  const newMd = buildNewMd(title, slug, durationS, sourcePath, segments, cuts)
  if (DRY) {
    return { slug, status: "ok", oldChapters: [...windowsOf(segments).keys()].length, newChapters: cuts.length, titles: cuts.map((c) => c.title) }
  }
  await api.upsertTranscriptPage(pagePath, newMd)
  await api.writeSource(sourcePath, newMd)
  await api.registerMediaAssets([{
    slug, media_ref: media.media_ref, playback_path: media.playback_path,
    duration_s: durationS, codec: media.codec, kind: media.kind as "video",
    chapters: chapterSpans, transcript_page_path: pagePath, source_path: sourcePath,
  }])
  return { slug, status: "ok", oldChapters: [...windowsOf(segments).keys()].length, newChapters: cuts.length, titles: cuts.map((c) => c.title) }
}

// 简单工人池（固定并发，顺序消费）
const queue = [...targets]
const workers = Array.from({ length: MODE === "check" ? 8 : CONCURRENCY }, async () => {
  for (;;) {
    const line = queue.shift()
    if (!line) return
    try {
      const o = await processOne(line)
      outcomes.push(o)
      const done = outcomes.length
      if (done % 20 === 0 || done === targets.length) console.log(`  ${done}/${targets.length}…`)
    } catch (e) {
      outcomes.push({ slug: line.slug, status: "error", reason: String(e).slice(0, 160) })
    }
  }
})
await Promise.all(workers)

const by = (s: string) => outcomes.filter((o) => o.status === s).length
console.log(`完成：ok=${by("ok")} skipped_stale_page=${by("skipped_stale_page")} fallback_old_cut=${by("fallback_old_cut")} error=${by("error")}`)
for (const o of outcomes) {
  if (o.status !== "ok") console.log(`  [${o.status}] ${o.slug}: ${o.reason}`)
  else if (o.titles && MODE !== "check") console.log(`  ${o.slug}: ${o.oldChapters}→${o.newChapters} 章 | ${o.titles.join(" / ")}`)
}
writeFileSync(join(outDir, "rechapter-report.json"), `${JSON.stringify({ model: MODEL, generatedAt: new Date().toISOString(), outcomes }, null, 2)}\n`)
console.log(`报告：${join(outDir, "rechapter-report.json")}`)
process.exit(by("error") > 0 ? 1 : 0)
