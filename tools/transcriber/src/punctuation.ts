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
const PUNCT_DENSITY_MIN = 0.02      // 密度门：输出标点密度下限（与回填页级门同值；实测偷懒簇≤0.013 / 合格簇≥0.033）
const DENSITY_GATE_MIN_CHARS = 400  // 密度门只作用于完整块；二分碎片豁免（短文本密度噪声大、误杀率高）
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
 *  漂移形态；whisper 英文大小写本就任意）与全宽/半宽互转（５０↔50）。
 *  容忍面如实声明（评审 I5）：中文表意字符语义零放松；但英文词界与符号存在
 *  不可检测等价——"no table"↔"not able"（剥空格后同骨架）、$↔¥、→↔←、
 *  ①→1 兼容折叠。收紧（保留词间空格）会误伤中文标点插入位，权衡后维持，
 *  已知局限记录在案。 */
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

/** 文件级快速失败：调用预算耗尽 / 传输错误重试耗尽——上抛后整文件回落原文，
 *  绝不进二分（二分只会产生更多注定失败的调用，限流/断网时火上浇油）。 */
class PunctFileAbort extends Error {}
/** 429 限流：独立指数退避重试（不消耗常规尝试次数），耗尽后文件级中止。 */
class PunctRateLimited extends Error {}

/** 单文件调用预算：2h 视频正常约 40-60 块；预算是二分树最坏情况的硬顶——
 *  网络全断时不再烧完整棵递归树才放弃。 */
const MAX_CALLS_PER_FILE = 200

async function zaiChatPunct(
  chunk: string,
  cfg: Required<PunctuateConfig>,
  deps: LlmPunctDeps,
  gate: () => void,
  allowThinking = true,
): Promise<string> {
  gate()
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
    if (allowThinking && res.status === 400 && /thinking/i.test(text)) return zaiChatPunct(chunk, cfg, deps, gate, false)
    if (res.status === 429) throw new PunctRateLimited(`zai 429: ${text}`)
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
  let calls = 0
  const gate = () => {
    if (++calls > MAX_CALLS_PER_FILE) throw new PunctFileAbort(`调用预算耗尽（>${MAX_CALLS_PER_FILE}）`)
  }

  /** 单块标点+分段。失败分流（评审 I4）：
   *  - verify 失败 → 重试一次 → 行边界二分递归（小上下文复制保真度高），
   *    单行仍失败 → 字符级二分；<200 字碎片失败即放弃（上层整文件回落）。
   *  - 429 限流 → 指数退避独立重试（≤3 次，不消耗常规尝试、不进二分）。
   *  - 其他传输错误（网络/5xx）→ 重试一次后文件级中止（快速失败，不二分）。
   *  段落门：≥PARA_MIN_LINES 行的块校验通过但未分段 → 再试一次；两次都通过
   *  但仍无分段 → 接受（标点已保真）并告警，不进二分。
   *  密度门（2026-08-26 回填实测补）：≥DENSITY_GATE_MIN_CHARS 字的块校验通过但
   *  标点密度 < PUNCT_DENSITY_MIN（模型偷懒原样回显——骨架校验只保真不保干活，
   *  且补空行分段即可骗过段落门）→ 重试一次；仍偷懒 → 判块失败（章失败→整文件
   *  回落），不进二分——二分治保真失败，治不了不干活，切小只会重复偷懒烧预算。 */
  const lineCount = (t: string) => t.split("\n").filter((l) => l.trim()).length
  const hasPara = (t: string) => /\n[ \t]*\n/.test(t)
  /** 块级标点密度：剥时间戳与空白后，标点数 / 全字符数（中英混排通用——
   *  回填页级门用 CJK 分母，纯英文块会失真，此处不用同款）。 */
  const punctDens = (t: string) => {
    const core = t.replace(/\[\d{1,3}:\d{2}\]/g, "").replace(/\s/g, "")
    if (!core.length) return 1
    const punct = (core.match(/[，。！？；：、“”‘’（）——……,.!?;:()]/g) ?? []).length
    return punct / core.length
  }
  const punctuateChunk = async (text: string): Promise<string | null> => {
    let lastErr = ""
    let unsegmented: string | null = null
    let lazyEcho: string | null = null
    let transportErr: unknown = null
    let attempt = 0
    let rateLimited = 0
    while (attempt < 2) {
      attempt += 1
      try {
        const raw = await zaiChatPunct(text, cfg, deps, gate)
        if (verifyPunctuated(text, raw)) {
          const lazy = text.length >= DENSITY_GATE_MIN_CHARS && punctDens(raw) < PUNCT_DENSITY_MIN
          if (lazy) {
            lazyEcho = raw
            lastErr = `偷懒回显（dens=${punctDens(raw).toFixed(3)}）`
          } else if (lineCount(text) < PARA_MIN_LINES || hasPara(raw)) {
            return raw
          } else {
            unsegmented = raw
            lastErr = "校验通过但未分段"
          }
        } else {
          lazyEcho = null // 后续尝试转向保真失败 → 归二分语义，不按偷懒判
          lastErr = `verify: ${raw.slice(0, 60)}`
        }
        await sleep(3000)
      } catch (e) {
        if (e instanceof PunctFileAbort) throw e
        if (e instanceof PunctRateLimited && rateLimited < 3) {
          rateLimited += 1
          attempt -= 1 // 限流退避不消耗常规尝试次数
          await sleep(5000 * 2 ** (rateLimited - 1)) // 5s/10s/20s
          continue
        }
        transportErr = e
        lastErr = String(e).slice(0, 120)
        await sleep(3000)
      }
    }
    if (unsegmented !== null) {
      console.warn(`[punctuate] ${lineCount(text)} 行块校验通过但两次都未分段，保留整块（仅标点）`)
      return unsegmented
    }
    if (lazyEcho !== null) {
      console.warn(`[punctuate] ${text.length}ch 块重试后仍偷懒回显（${lastErr}），判失败`)
      return null
    }
    if (transportErr !== null) {
      // 传输错误不进二分：切小只会产生更多注定失败的调用
      throw new PunctFileAbort(`传输错误重试耗尽（${lastErr}）`)
    }
    const lines = text.split("\n").filter((l) => l.trim())
    if (lines.length > 1) {
      const half = Math.ceil(lines.length / 2)
      const head = await punctuateChunk(lines.slice(0, half).join("\n"))
      if (head === null) return null
      const tail = await punctuateChunk(lines.slice(half).join("\n"))
      if (tail === null) return null
      // 块/二分接缝强制空行：落在接缝处的话题转换不失分段（整段跨缝连排
      // 是更差的读感取舍），纯空白变化不影响骨架
      return `${head}\n\n${tail}`
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
  try {
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
      out.push(ch.header ? `${ch.header}\n${done.join("\n\n")}` : done.join("\n\n"))
    }
  } catch (e) {
    if (e instanceof PunctFileAbort) {
      console.warn(`[punctuate] ${e.message}，整文件回落原文`)
      return null
    }
    throw e
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
  if (snapshot !== null) {
    // 快照一致性（评审 I2）：同 slug 不同 md（同 wav 重转写——whisper 非确定、
    // rechapter 换 cuts）时，陈旧快照会把旧文写回。命中时廉价校验标记+骨架，
    // 不匹配按 miss 处理（重新标点并覆盖快照）。
    if (verifyPunctuated(input.md, snapshot)) return snapshot
    console.warn(`[punctuate] ${input.slug}: 快照与当前正文不一致（重转写/重切章后），重新标点并覆盖快照`)
  }
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
