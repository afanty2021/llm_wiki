// tools/transcriber/src/chaptering.ts
// 语义切章（摄取链与存量重切共用）：LLM 按话题/教学环节划分章节，边界吸附 segment
// 起点；产出新 md（`## [mm:ss] 标题` 章头 + 章内 ~300s 窗口行，正文行粒度与机械切分
// 完全一致）与 media chapters 数组。
// 失败语义：trySemanticChapters 永不抛出——任何失败（网络/解析/守门）返回 null，
// 调用方回落机械切分，摄取主流程不被阻塞、不消耗 tries。
import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import type { Segment } from "./whisper"
import type { TranscriptInput } from "./transcript"
import { mmss, transcriptFrontmatter, CHAPTER_WINDOW_S } from "./transcript"

export interface ChapterCut { startIdx: number; title: string }
export interface SemanticChapter { start_s: number; end_s: number; label: string }

export interface ChapteringConfig {
  enabled?: boolean
  baseUrl?: string
  model?: string
}
export const DEFAULT_CHAPTERING: Required<ChapteringConfig> = {
  enabled: false,
  baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4", // China Coding Plan（订阅计费通道）
  model: "glm-5.1",
}

const TITLE_MAX = 30            // LLM 侧要求 ≤20 字，防御性放宽截断
const GUARD_MIN_DURATION_S = 600 // ≥10min 视频仅 1 章 → 回落机械切分
const GUARD_MAX_SPAN_S = 2700    // 单章 >45min → 回落机械切分
const GUARD_MAX_CHAPTERS = 50    // 章数上限：幻觉微章（几十上百章）拦截
const LLM_TIMEOUT_MS = 90_000    // undici 默认 300s 兜底太长——慢阻塞会卡住转写主流程

/** ZAI_API_KEY：env 优先，回落 ~/.hermes/.env（不打印、不落 config——密钥卫生）。 */
export function loadZaiKey(): string {
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

const SYS = [
  "你是课程视频的章节编辑。给你一份带时间戳的转写片段序列（编号|时刻|文本），",
  "请按话题与教学环节的内在逻辑划分章节边界，并为每章写一个简洁、信息充分的中文标题（不超过 20 字，说清该章讲什么）。",
  "规则：",
  "1. 边界只能落在给定片段的编号上（吸附）；第一章必须从 0 号开始；各章连续覆盖全部片段，不遗漏、不重叠。",
  "2. 章节数量由内容决定：内容单一的视频可以只有 1-2 章，内容转换多的可以有 8 章以上；不要机械等分。",
  "3. 只输出 JSON，形如 {\"chapters\":[{\"start_idx\":0,\"title\":\"…\"},{\"start_idx\":37,\"title\":\"…\"}]}，不要任何其他文字。",
].join("\n")

/** 校验已构造的切分（首章=0、严格递增、编号域内、章数上限）——parseCuts 与 cuts 快照回读共用。 */
export function validateCuts(cuts: ChapterCut[], nSegs: number): ChapterCut[] | null {
  if (cuts.length === 0 || cuts.length > GUARD_MAX_CHAPTERS) return null
  for (const c of cuts) {
    if (!Number.isInteger(c.startIdx) || c.startIdx < 0 || c.startIdx >= nSegs) return null
    if (typeof c.title !== "string" || !c.title.trim()) return null
  }
  const sorted = [...cuts].sort((a, b) => a.startIdx - b.startIdx)
  if (sorted[0].startIdx !== 0) return null
  for (let i = 1; i < sorted.length; i++) if (sorted[i].startIdx <= sorted[i - 1].startIdx) return null
  return sorted
}

/** 解析 LLM 输出为合法切分（首章=0、严格递增、全覆盖编号域）；任何违规 → null。 */
export function parseCuts(raw: string, nSegs: number): ChapterCut[] | null {
  // 某些模型把 JSON 整体再字符串化一层（content = "\"{\\\"chapters\\\"…}\""）——先解一层
  let text = raw.trim()
  if (text.startsWith('"')) {
    try { text = JSON.parse(text) as string } catch { /* 保留原样走正则 */ }
  }
  const m = /\{[\s\S]*\}/.exec(text)
  if (!m) return null
  let parsed: { chapters?: Array<{ start_idx?: unknown; title?: unknown }> }
  try { parsed = JSON.parse(m[0]) } catch { return null }
  const list = parsed.chapters
  if (!Array.isArray(list) || list.length === 0) return null
  const cuts: ChapterCut[] = []
  for (const c of list) {
    const idx = Number(c.start_idx)
    const title = typeof c.title === "string" ? c.title.trim().replace(/\s+/g, " ").slice(0, TITLE_MAX) : ""
    if (!Number.isInteger(idx) || idx < 0 || idx >= nSegs || !title) return null
    cuts.push({ startIdx: idx, title })
  }
  return validateCuts(cuts, nSegs)
}

export interface LlmChapterDeps {
  fetchImpl?: typeof fetch
  apiKey?: string
  sleepFn?: (ms: number) => Promise<void>
}
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

async function zaiChat(
  userMsg: string,
  cfg: Required<ChapteringConfig>,
  deps: LlmChapterDeps,
  allowThinking = true,
): Promise<string> {
  const doFetch = deps.fetchImpl ?? fetch
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages: [
      { role: "system", content: SYS },
      { role: "user", content: userMsg },
    ],
    temperature: 0.2,
    max_tokens: 2000,
  }
  if (allowThinking) body.thinking = { type: "disabled" }
  const res = await doFetch(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${deps.apiKey ?? loadZaiKey()}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  })
  if (!res.ok) {
    const text = (await res.text()).slice(0, 200)
    // 某些模型/端点不认 thinking 参数：去掉重试一次
    if (allowThinking && res.status === 400 && /thinking/i.test(text)) return zaiChat(userMsg, cfg, deps, false)
    throw new Error(`zai HTTP ${res.status}: ${text}`)
  }
  const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
  return stripThinking(j.choices?.[0]?.message?.content ?? "").trim()
}

/** 剥离 thinking 块——与 src-server synthesize.rs strip_thinking 同语义（双标签 + 未闭合截断到结尾）。 */
export function stripThinking(text: string): string {
  let out = text
  for (const tag of ["think", "thinking"]) {
    const open = `<${tag}>`
    const close = `</${tag}>`
    for (;;) {
      const start = out.indexOf(open)
      if (start < 0) break
      const endRel = out.indexOf(close, start)
      if (endRel < 0) {
        out = out.slice(0, start) // 无闭合：弃 open 起到结尾（与 Rust 版一致）
        break
      }
      out = out.slice(0, start) + out.slice(endRel + close.length)
    }
  }
  return out
}

/** cuts 快照落盘（评审 C1）：语义切章成功即持久化——断点续跑按快照字节级重建，
 *  绝不重调 LLM（非确定输出必致页/源 hash 漂移）。 */
export function persistCuts(outDir: string, slug: string, cuts: ChapterCut[]): void {
  const dir = join(outDir, "chapters")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${slug}.json`), JSON.stringify(cuts))
}

/** 读取 cuts 快照并整校验（域外下标/乱序/超上限 → null，调用方回落机械重建）。 */
export function loadCuts(outDir: string, slug: string, nSegs: number): ChapterCut[] | null {
  try {
    return validateCuts(JSON.parse(readFileSync(join(outDir, "chapters", `${slug}.json`), "utf-8")) as ChapterCut[], nSegs)
  } catch {
    return null
  }
}

/** LLM 切章：两次尝试（解析失败/网络错重试一次，间隔 3s），全部失败抛出。 */
export async function llmChapter(
  title: string,
  segments: Segment[],
  cfg: Required<ChapteringConfig> = DEFAULT_CHAPTERING,
  deps: LlmChapterDeps = {},
): Promise<ChapterCut[]> {
  const lines = segments.map((s, i) => `${i}|${mmss(s.startS)}|${s.text}`).join("\n")
  const user = `视频标题：${title}\n片段序列（共 ${segments.length} 条）：\n${lines}`
  const sleep = deps.sleepFn ?? defaultSleep
  let lastErr = ""
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await zaiChat(user, cfg, deps)
      const cuts = parseCuts(raw, segments.length)
      if (cuts) return cuts
      lastErr = `unparseable: ${raw.slice(0, 120)}`
    } catch (e) {
      lastErr = String(e).slice(0, 160)
      await sleep(3000)
    }
  }
  throw new Error(lastErr)
}

/** 守门：切分退化（≥10min 仅 1 章 / 单章 >45min / 幻觉微章 >50 章）→ 返回原因，调用方回落。 */
export function guardrailReason(cuts: ChapterCut[], segments: Segment[], durationS: number): string | null {
  if (cuts.length > GUARD_MAX_CHAPTERS) return `守门：${cuts.length} 章超上限 ${GUARD_MAX_CHAPTERS}`
  if (durationS >= GUARD_MIN_DURATION_S && cuts.length < 2) {
    return `守门：${Math.round(durationS / 60)}min 视频仅 ${cuts.length} 章`
  }
  const spans = chaptersFor(segments, cuts)
  const maxSpan = Math.max(...spans.map((c) => c.end_s - c.start_s))
  if (maxSpan > GUARD_MAX_SPAN_S) return `守门：单章 ${Math.round(maxSpan / 60)}min`
  return null
}

/** 切分 → media chapters 数组（start/end 取章内首/末 segment 实际时刻）。 */
export function chaptersFor(segments: Segment[], cuts: ChapterCut[]): SemanticChapter[] {
  const bounds = cuts.map((c) => c.startIdx)
  const out: SemanticChapter[] = []
  for (let ci = 0; ci < cuts.length; ci++) {
    const from = bounds[ci]
    const to = ci + 1 < cuts.length ? bounds[ci + 1] : segments.length
    const segs = segments.slice(from, to)
    if (segs.length === 0) continue
    out.push({ start_s: segs[0].startS, end_s: segs[segs.length - 1].endS, label: cuts[ci].title })
  }
  return out
}

function windowsOf(segments: Segment[]): Map<number, Segment[]> {
  const w = new Map<number, Segment[]>()
  for (const seg of [...segments].sort((a, b) => a.startS - b.startS)) {
    const k = Math.floor(seg.startS / CHAPTER_WINDOW_S)
    const b = w.get(k) ?? []
    b.push(seg)
    w.set(k, b)
  }
  return w
}

/** 语义章 md：frontmatter 与机械切分逐字节同构；正文=章头 `## [mm:ss] 标题` + 章内 300s 窗口行。 */
export function buildSemanticMd(input: TranscriptInput, cuts: ChapterCut[]): string {
  const fm = transcriptFrontmatter(input)
  const bounds = cuts.map((c) => c.startIdx)
  const blocks: string[] = []
  for (let ci = 0; ci < cuts.length; ci++) {
    const from = bounds[ci]
    const to = ci + 1 < cuts.length ? bounds[ci + 1] : input.segments.length
    const chapSegs = input.segments.slice(from, to)
    if (chapSegs.length === 0) continue
    blocks.push(`## ${mmss(chapSegs[0].startS)} ${cuts[ci].title}`)
    // 章内按 300s 窗口分段（与机械切分正文行同粒度），保持长章可读
    for (const [, segs] of [...windowsOf(chapSegs).entries()].sort((a, b) => a[0] - b[0])) {
      blocks.push(`${mmss(segs[0].startS)} ${segs.map((s) => s.text).join(" ")}`)
    }
  }
  return blocks.length === 0 ? `${fm}\n` : `${fm}\n\n${blocks.join("\n\n")}\n`
}

/**
 * 摄取链入口（永不抛出）：enabled + key 齐备 → LLM 切章 → 守门；
 * 任何失败 console.warn 后返回 null（调用方回落机械切分）。
 */
export async function trySemanticChapters(
  input: { title: string; segments: Segment[]; durationS: number },
  cfg: Required<ChapteringConfig>,
  deps: LlmChapterDeps = {},
): Promise<ChapterCut[] | null> {
  if (!cfg.enabled) return null
  // 空转写短路：无 segment 时 LLM 必然产不出合法切分，不白打 2 次调用
  if (input.segments.length === 0) return null
  if (!deps.apiKey && !process.env.ZAI_API_KEY && !loadZaiKey()) {
    console.warn("[chaptering] 缺 ZAI_API_KEY（env 或 ~/.hermes/.env），回落机械切分")
    return null
  }
  try {
    const cuts = await llmChapter(input.title, input.segments, cfg, deps)
    const reason = guardrailReason(cuts, input.segments, input.durationS)
    if (reason) {
      console.warn(`[chaptering] ${input.title}: ${reason}，回落机械切分`)
      return null
    }
    return cuts
  } catch (e) {
    console.warn(`[chaptering] ${input.title}: ${String(e).slice(0, 140)}，回落机械切分`)
    return null
  }
}
