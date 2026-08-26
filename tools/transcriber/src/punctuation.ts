// tools/transcriber/src/punctuation.ts
// 转写正文标点恢复 + 语义分段（2026-08-26 阅读体验根治）：Whisper 中文输出空格分词
// 无标点，每窗口行是一大段连排文本。本模块按章（超长再按窗口行切块）送 LLM，
// 一次读取完成两件事：补中文标点 + 按内容逻辑插空行划分自然段（话题转换/设问
// 回答/举例/转折处断段——分段是模型的显式任务，不是机械固定句数兜底）。
// 三重校验门（时间戳标记全保留且有序 / 剥离空白与标点后逐字符一致 / 章头原样）
// 同时兜住两类编辑——标点与空行同属「骨架不可见」字符；任何增删改字都整文件
// 返回 null，调用方回落原文（与 chaptering 同一失败语义：绝不阻塞摄取主流程）。
//
// 幂等（C1 教训同款）：成功即全量快照落盘 out/punct/<slug>.md，断点续跑/复用路径
// 按快照字节级回用，绝不重调 LLM（非确定输出必致页/源 hash 漂移）。
import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { loadZaiKey } from "./chaptering"

export interface PunctuateConfig {
  enabled?: boolean
  baseUrl?: string
  model?: string
}
export const DEFAULT_PUNCTUATE: Required<PunctuateConfig> = {
  enabled: false,
  baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4", // China Coding Plan（订阅计费通道）
  model: "glm-5.1",
}

const CHUNK_MAX_CHARS = 4000   // 单次 LLM 调用正文上限（章内按窗口行边界切块）
const PARA_MIN_LINES = 5       // 段落门：≥ 此行数的块必须至少含一个空行分段（短块/碎片豁免）
const LLM_TIMEOUT_MS = 180_000 // 全文重写比切章慢——放宽到 3 分钟（undici 默认 300s 兜底）

const SYS = [
  "你是逐字复制器。任务：逐字复制输入的转写文本，只允许两类编辑——",
  "① 在字符之间插入中文标点（，。！？；：、“”‘’（）——……）；",
  "② 在语义段落边界插入一个空行（连续两个换行），把正文划分为自然段。",
  "分段必须基于内容逻辑：话题转换、设问与回答、举例、转折、小结处断段；",
  "一个自然段通常 2~10 行；禁止机械地按固定句数或固定行数分段。",
  "段内保持原有换行：每个 [mm:ss] 时间戳行不合并、不拆分、不挪位。",
  "绝对禁止：增字、删字、改字、改大小写、翻译、同义替换、语法润色、输出解释或代码围栏。",
  "[mm:ss] 时间戳原样保留在原行行首，顺序与数量不变；已有标点保持原样。",
  "只输出复制结果。",
].join("\n")

// ── 校验门 ──

const MARKER_RE = /\[\d{1,3}:\d{2}\]/g

/** 提取全部 [mm:ss] 标记（顺序敏感）。 */
export function markersOf(text: string): string[] {
  return text.match(MARKER_RE) ?? []
}

/** 骨架：剥时间戳、空白、一切标点/符号后的纯字符序列——逐字符比对基线。
 *  NFKC 归一 + 小写：容忍 LLM 的英文大小写规范化（okitstoo→OKitstoo，实测唯一
 *  漂移形态；whisper 英文大小写本就任意）与全宽/半宽互转（５０↔50）——中文
 *  表意字符不受两者影响，语义零放松。 */
export function skeletonOf(text: string): string {
  return text
    .replace(MARKER_RE, "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, "")
}

/** 三重校验：标记序列一致 + 骨架逐字符一致（剥空白标点后），即「只加了标点/分段」。 */
export function verifyPunctuated(original: string, punctuated: string): boolean {
  const a = markersOf(original), b = markersOf(punctuated)
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return skeletonOf(original) === skeletonOf(punctuated)
}

// ── md 分章与重组 ──

interface ChapterBlock { header: string; body: string }

/** frontmatter + 章块（`## [mm:ss] 标题` 起到下一章头前）。无章头的裸正文归入伪章。 */
export function splitChapters(md: string): { frontmatter: string; chapters: ChapterBlock[] } {
  const m = /^---\n[\s\S]*?\n---\n/.exec(md)
  const frontmatter = m ? m[0] : ""
  const rest = md.slice(frontmatter.length)
  const chapters: ChapterBlock[] = []
  const re = /^## \[\d{1,3}:\d{2}\].*$/gm
  let head: RegExpExecArray | null
  const heads: { text: string; index: number }[] = []
  while ((head = re.exec(rest)) !== null) heads.push({ text: head[0], index: head.index })
  if (heads.length === 0) {
    return { frontmatter, chapters: rest.trim() ? [{ header: "", body: rest }] : [] }
  }
  if (heads[0].index > 0 && rest.slice(0, heads[0].index).trim()) {
    chapters.push({ header: "", body: rest.slice(0, heads[0].index) })
  }
  for (let i = 0; i < heads.length; i++) {
    const from = heads[i].index + heads[i].text.length
    const to = i + 1 < heads.length ? heads[i + 1].index : rest.length
    chapters.push({ header: heads[i].text, body: rest.slice(from, to) })
  }
  return { frontmatter, chapters }
}

/** 章内按窗口行边界切块（每块 ≤ CHUNK_MAX_CHARS；单行超长独占一块）。 */
export function chunkChapterBody(body: string): string[] {
  const lines = body.split("\n").filter((l) => l.trim())
  const chunks: string[] = []
  let cur: string[] = []
  let curLen = 0
  for (const line of lines) {
    if (curLen > 0 && curLen + line.length > CHUNK_MAX_CHARS) {
      chunks.push(cur.join("\n"))
      cur = []; curLen = 0
    }
    cur.push(line); curLen += line.length
  }
  if (cur.length) chunks.push(cur.join("\n"))
  return chunks
}

// ── LLM 调用 ──

export interface LlmPunctDeps {
  fetchImpl?: typeof fetch
  apiKey?: string
  sleepFn?: (ms: number) => Promise<void>
}
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

async function zaiChatPunct(
  chunk: string,
  cfg: Required<PunctuateConfig>,
  deps: LlmPunctDeps,
  allowThinking = true,
): Promise<string> {
  const doFetch = deps.fetchImpl ?? fetch
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages: [
      { role: "system", content: SYS },
      { role: "user", content: chunk },
    ],
    temperature: 0,
    // 动态上限：输出≈输入+标点，按 2 token/字留裕量（防长块 finish=length 截断）
    max_tokens: Math.max(8000, Math.ceil(chunk.length * 2)),
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
    if (allowThinking && res.status === 400 && /thinking/i.test(text)) return zaiChatPunct(chunk, cfg, deps, false)
    throw new Error(`zai HTTP ${res.status}: ${text}`)
  }
  const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
  const raw = (j.choices?.[0]?.message?.content ?? "").trim()
  // 剥代码围栏（部分模型爱包 ```markdown … ```）
  const fence = /^```[a-z]*\n([\s\S]*?)\n```$/.exec(raw)
  return fence ? fence[1].trim() : raw
}

/**
 * 核心：整份 md 标点恢复。逐章逐块调 LLM，块级校验；任何失败 → null（调用方回落原文）。
 * 章头/frontmatter 原样保留（不送 LLM，杜绝标题被改）。
 */
export async function punctuateMd(
  md: string,
  cfg: Required<PunctuateConfig> = DEFAULT_PUNCTUATE,
  deps: LlmPunctDeps = {},
): Promise<string | null> {
  const { frontmatter, chapters } = splitChapters(md)
  if (chapters.length === 0) return null
  const sleep = deps.sleepFn ?? defaultSleep

  /** 单块标点+分段：LLM×2 → 校验；长块另设段落门（≥PARA_MIN_LINES 行必须含空行
   *  分段——模型偶发偷懒只加标点，未分段再试一次；两次校验通过但都未分段则接受
   *  并告警，不进二分）。校验失败且多行 → 行边界二分递归（小上下文复制保真度高），
   *  单行仍失败 → null（上层整文件回落）。 */
  const lineCount = (t: string) => t.split("\n").filter((l) => l.trim()).length
  const hasPara = (t: string) => /\n[ \t]*\n/.test(t)
  const punctuateChunk = async (text: string): Promise<string | null> => {
    let lastErr = ""
    let unsegmented: string | null = null
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const raw = await zaiChatPunct(text, cfg, deps)
        if (verifyPunctuated(text, raw)) {
          if (lineCount(text) < PARA_MIN_LINES || hasPara(raw)) return raw
          unsegmented = raw
          lastErr = "校验通过但未分段"
        } else {
          lastErr = `verify: ${raw.slice(0, 60)}`
        }
        await sleep(3000)
      } catch (e) {
        lastErr = String(e).slice(0, 120)
        await sleep(3000)
      }
    }
    if (unsegmented !== null) {
      console.warn(`[punctuate] ${lineCount(text)} 行块校验通过但两次都未分段，保留整块（仅标点）`)
      return unsegmented
    }
    const lines = text.split("\n").filter((l) => l.trim())
    if (lines.length > 1) {
      const half = Math.ceil(lines.length / 2)
      const head = await punctuateChunk(lines.slice(0, half).join("\n"))
      if (head === null) return null
      const tail = await punctuateChunk(lines.slice(half).join("\n"))
      if (tail === null) return null
      return `${head}\n${tail}`
    }
    // 单行仍失败 → 字符级二分：whisper 文本以空格分词，取中点最近空格切半递归
    // （只影响边界处断句质量，校验严格性不放松）；<200 字的碎片失败即放弃。
    const line = lines[0] ?? ""
    if (line.length >= 200) {
      const mid = Math.floor(line.length / 2)
      let cut = -1
      for (let d = 0; d <= 120 && cut < 0; d++) {
        if (line[mid - d] === " ") cut = mid - d
        else if (line[mid + d] === " ") cut = mid + d
      }
      if (cut > 0) {
        const head = await punctuateChunk(line.slice(0, cut).trimEnd())
        if (head === null) return null
        const tail = await punctuateChunk(line.slice(cut).trimStart())
        if (tail === null) return null
        return `${head} ${tail}`.replace(/\s*\n\s*/g, "\n")
      }
    }
    console.warn(`[punctuate] 碎片（${line.length}ch）仍校验失败（${lastErr}）`)
    return null
  }

  const out: string[] = [frontmatter]
  for (const ch of chapters) {
    const done: string[] = []
    let ok = true
    for (const chunk of chunkChapterBody(ch.body)) {
      const got = await punctuateChunk(chunk)
      if (got === null) { ok = false; break }
      done.push(got)
    }
    if (!ok) {
      console.warn(`[punctuate] 章「${ch.header.slice(0, 30)}」标点失败，整文件回落原文`)
      return null
    }
    out.push(ch.header ? `${ch.header}\n${done.join("\n")}` : done.join("\n"))
  }
  // 重组：保留 LLM 的语义空行分段。CommonMark 单换行渲染为空格——段内多个
  // 时间戳行渲染时流式连排成一段（时间戳内联可见），空行处成自然段，正是所要。
  // 仅做卫生归一：3+ 连续空行压成一个 + 补结尾换行（纯空白，骨架不受影响）。
  return `${out.filter(Boolean).join("\n\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`
}

// ── 快照（幂等：C1 教训同款）──

/** 标点结果全量快照落盘——续跑/复用按字节回用，绝不重调 LLM。 */
export function persistPunctMd(outDir: string, slug: string, md: string): void {
  const dir = join(outDir, "punct")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${slug}.md`), md)
}

export function loadPunctMd(outDir: string, slug: string): string | null {
  try {
    return readFileSync(join(outDir, "punct", `${slug}.md`), "utf-8")
  } catch {
    return null
  }
}

/**
 * 摄取链入口（永不抛出）：快照优先 → enabled+key 齐备时 LLM 标点（成功即快照）→
 * 任何失败返回原 md。与 trySemanticChapters 同一失败语义。
 */
export async function maybePunctuate(input: {
  md: string
  slug: string
  outDir: string
  cfg?: PunctuateConfig
  deps?: LlmPunctDeps
}): Promise<string> {
  const snapshot = loadPunctMd(input.outDir, input.slug)
  if (snapshot !== null) return snapshot
  const cfg = { ...DEFAULT_PUNCTUATE, ...input.cfg }
  if (!cfg.enabled) return input.md
  if (!input.deps?.apiKey && !process.env.ZAI_API_KEY && !loadZaiKey()) {
    console.warn("[punctuate] 缺 ZAI_API_KEY（env 或 ~/.hermes/.env），正文保持原样")
    return input.md
  }
  try {
    const punctuated = await punctuateMd(input.md, cfg, input.deps)
    if (punctuated === null) return input.md
    persistPunctMd(input.outDir, input.slug, punctuated)
    return punctuated
  } catch (e) {
    console.warn(`[punctuate] ${input.slug}: ${String(e).slice(0, 140)}，正文保持原样`)
    return input.md
  }
}
