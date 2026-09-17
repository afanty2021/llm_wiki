/**
 * 教师素材提取引擎（2026-09-17 v2 方案
 * docs/superpowers/plans/2026-09-17-ltutor-pptx-v2-tool.md Task 1，设计
 * docs/superpowers/specs/2026-09-17-ltutor-pptx-v2-design.md D1-D9；两轮评审修正已并入）。
 *
 * 服务端确定性管线：ffprobe 探测 → ffmpeg（16k wav → whisper 用毕即删 / mp3 / 3×3
 * contact sheet）→ whisper-cli turbo `-l auto`（勿强制语言——参照会话教训）→ 幻觉过滤
 * （transcriber 四纯函数照行号拷贝）→ 结构化返回。agent 无 shell 红线维持（D1）。
 *
 * 纪律：
 * - 全部失败面 { ok:false, error } 正常文本返回，**绝不抛 ToolArgumentError**（计划评审 C3：
 *   media_path 由模型转写注记行、抄错 3 次即熔断整服务器 60s——training.ts:754 前例）；
 * - 错误文案剥绝对路径、成功载荷保留路径（agent 后续 vision_analyze/pptx 嵌入要消费）；
 * - 不发 MEDIA: 行、不进 Hermes auto-append 白名单（网关按工具名门控，双保险）；
 * - 分段预算 20+60+200=280s ≤ 300s MCP 硬顶（计划评审 C1/N2：段级共享 deadline，
 *   ffmpeg 组内多调用共享 60s——读成「每个各 60s」最坏和会变 340s）；
 * - 保留策略三重防线（D7，计划评审 C2）：wav 即删 + 入口自清扫 >7 天 + 1GB LRU
 *   （网关小时清扫只清 9 个具名目录，ltutor-* 不在内——run.py:4515 实证）；
 * - 互斥排队深度=1（D9）：在跑即返回稍后再试，不入队（排队必击穿 300s）。
 */
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import {
  createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync,
} from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

// ── 常量 ──
export const MEDIA_MAX_DURATION_S = 900
export const MEDIA_TRANSCRIPT_MAX_SEGMENTS = 400
export const DEFAULT_MEDIA_OUT_ROOT = join(homedir(), ".hermes", "cache", "ltutor-media")
export const MEDIA_RETENTION_DAYS = 7
export const MEDIA_TOTAL_CAP_BYTES = 1024 ** 3
/** 段级预算（秒）——单一权威表，和 280s ≤ 300s（计划评审 C1）。 */
export const SEGMENT_BUDGET_S = { probe: 20, ffmpeg: 60, whisper: 200 } as const

const DEFAULT_BIN_CANDIDATES = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"] as const
const VIDEO_EXTS = new Set([".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm", ".3gp"])
const AUDIO_EXTS = new Set([".mp3", ".wav", ".m4a", ".aac", ".ogg", ".opus", ".flac", ".amr"])
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".heic"])

export interface TranscriptSegment {
  start_s: number
  end_s: number
  text: string
}

export interface MediaExtractResult {
  ok: boolean
  kind?: "video" | "audio"
  duration_s?: number
  sheet_path?: string
  transcript?: TranscriptSegment[]
  audio_mp3_path?: string
  transcript_truncated?: boolean
  error?: string
}

export interface MediaExtractDeps {
  outRoot?: string
  /** 允许根注入点（测试用；缺省 ~/.hermes/cache/ 系）。 */
  allowRoots?: string[]
  /** 注入点（测试/运维）：缺省解析 process.env。 */
  env?: Record<string, string | undefined>
  /** execFile 注入点（测试用 fake 管线）。 */
  exec?: (cmd: string, args: string[], opts: { timeout: number; maxBuffer: number }) => Promise<{ stdout: string }>
}

// ── 二进制与模型解析 ──

/** env 覆盖优先（存在性校验），否则候选目录探测；都不在返回 null（调用方给友好文案）。 */
export function resolveToolBinary(
  name: string,
  envPath: string | undefined,
  candidates: readonly string[] = DEFAULT_BIN_CANDIDATES,
): string | null {
  if (envPath && envPath.trim() !== "") {
    return existsSync(envPath) ? envPath : null
  }
  for (const dir of candidates) {
    const p = join(dir, name)
    if (existsSync(p)) return p
  }
  return null
}

/** 模型缺省路径：模块文件起 4 层 dirname 至 repo root（dist/src/media-extract.js → 仓根），
 * 拼 tools/transcriber/models/ggml-large-v3-turbo.bin（计划评审 I-7：唯一 ggml 模型即 turbo，
 * ~/.cache/whisper 下是 Python whisper 的 .pt 权重勿读——设计 §三-1）。 */
export function modelPathFromModulePath(moduleFilePath: string): string {
  const repoRoot = dirname(dirname(dirname(dirname(moduleFilePath))))
  return join(repoRoot, "tools", "transcriber", "models", "ggml-large-v3-turbo.bin")
}

// ── 允许根校验（D6）──

const MEDIA_ALLOW_ROOTS = [join(homedir(), ".hermes", "cache")]

/** 路径存在 → 只认真身（词面在根内、真身在根外的符号链接必须拒）；不存在 → 只能词法，
 * 与根的词面/真身双形态都比（macOS /var → /private/var 同根双写）。 */
export function isAllowedMediaPath(p: string, roots: string[] = MEDIA_ALLOW_ROOTS): boolean {
  let pReal: string | null = null
  try {
    pReal = realpathSync(p)
  } catch {
    // 不存在按词法
  }
  const pLex = resolve(p)
  for (const root of roots) {
    let rReal: string | null = null
    try {
      rReal = realpathSync(root)
    } catch {
      // 同上
    }
    const rLex = resolve(root)
    if (pReal !== null) {
      if (rReal !== null && (pReal === rReal || pReal.startsWith(rReal + sep))) return true
    } else {
      if (pLex === rLex || pLex.startsWith(rLex + sep)) return true
      if (rReal !== null && (pLex === rReal || pLex.startsWith(rReal + sep))) return true
    }
  }
  return false
}

// ── 媒体内容哈希（D8：sha12 = 源媒体字节 sha1 前 12，评审 M-11）──

export async function mediaSha1(filePath: string): Promise<string> {
  return await new Promise<string>((res, rej) => {
    const h = createHash("sha1")
    const s = createReadStream(filePath)
    s.on("data", d => h.update(d))
    s.on("end", () => res(h.digest("hex")))
    s.on("error", rej)
  })
}

// ── 纯工具函数（供测试与 T2 复用）──

/** contact sheet 抽帧间隔 = duration/9，下限 5s、**无上限**（评审 I-6：60s 帽会让
 * ≥9.5min 视频尾部无帧；900s → 100s，帧落 0-900s 全覆盖）。 */
export function sheetInterval(durationS: number): number {
  return Math.max(5, durationS / 9)
}

/** 段内剩余预算（ms）：deadline - now，下限 1ms（execFile timeout 需正数）。 */
export function remainingTimeoutMs(deadlineMs: number, now: number = Date.now()): number {
  return Math.max(1, deadlineMs - now)
}

/** transcriber audio.ts:19 同参（-v error 前缀为 runner 层，此处只出作业参数）。 */
export function wavExtractArgs(input: string, output: string): string[] {
  return ["-y", "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", output]
}

export function mp3Args(input: string, output: string): string[] {
  return ["-y", "-i", input, "-vn", "-codec:a", "libmp3lame", "-qscale:a", "4", output]
}

export function sheetArgs(input: string, output: string, durationS: number): string[] {
  const interval = sheetInterval(durationS)
  return ["-y", "-i", input, "-vf", `fps=1/${interval},scale=480:-1,tile=3x3`, "-frames:v", "1", "-q:v", "3", output]
}

/** transcriber whisper.ts:218-223 同参（`-l auto` 勿强制语言——参照会话教训）。 */
export function whisperArgs(modelPath: string, wavPath: string, outJsonPath: string): string[] {
  const args = ["-m", modelPath, "-f", wavPath, "-l", "auto", "-mc", "0"]
  args.push("-oj", "-of", outJsonPath.replace(/\.json$/, ""))
  return args
}

// ── Whisper 幻觉过滤拷贝件（tools/transcriber/src/whisper.ts:34/41/87/134 照行号拷贝，
// 计划评审 I-5 权威清单；runDegenerationGate 非纯勿拷——env 口子+console.warn 副作用）──

export interface Segment {
  startS: number
  endS: number
  text: string
}

/** 已知幻觉词：搬运视频的字幕组署名音轨/BGM/水印被 Whisper 转成整段重复垃圾。
 * 串面是开放集合，此处只兜已知高频族；开放集由窗级退化守门按循环签名兜底。 */
export const HALLUCINATION_TOKENS = [
  "中文字幕志愿者", "字幕志愿者", "李宗盛", "明镜与点点", "请不吝点赞", "打赏支持",
  "订阅 转发", "打赏", "优优独播剧场", "优独播剧场", "YoYo Television Series Exclusive", "YoYo Television",
] as const

/** 幻觉段过滤：含黑名单词的段，剥词后剩余 ≤2 字即丢弃；不含黑名单词的段无条件保留。 */
export function stripHallucinationSegments(segments: Segment[]): Segment[] {
  return segments.filter(seg => {
    if (!HALLUCINATION_TOKENS.some(tok => seg.text.includes(tok))) return true
    let core = seg.text
    for (const tok of HALLUCINATION_TOKENS) core = core.split(tok).join("")
    return core.replace(/\s/g, "").length > 2
  })
}

export interface DegenerateWindowInfo {
  startS: number
  endS: number
  chars: number
  signature: string
  maxFreq: number
  chainCoverage: number
}

export interface DegenerationReport {
  windows: DegenerateWindowInfo[]
  totalChars: number
  degenerateChars: number
  coverage: number
}

const GATE_WINDOW_S = 300
const GATE_MIN_CHARS = 500
const GATE_NGRAM = 8
const GATE_FREQ = 250
const GATE_CHAIN_COVERAGE = 0.5
export const GATE_REJECT_COVERAGE = 0.4

/** 单窗判定：返回退化窗信息，健康窗返回 null。 */
export function analyzeWindowDegeneration(text: string): Omit<DegenerateWindowInfo, "startS" | "endS"> | null {
  const t = text.replace(/\s+/g, "")
  if (t.length < GATE_MIN_CHARS) return null
  const freq = new Map<string, number>()
  for (let i = 0; i + GATE_NGRAM <= t.length; i++) {
    const g = t.slice(i, i + GATE_NGRAM)
    freq.set(g, (freq.get(g) ?? 0) + 1)
  }
  let signature = "", maxFreq = 0
  for (const [g, f] of freq) if (f > maxFreq) { maxFreq = f; signature = g; }
  if (maxFreq === 0) return null
  const freqCondemned = maxFreq >= GATE_FREQ
  const cov = freqCondemned ? 1 : chainCoverageOf(t, signature)
  if (!freqCondemned && cov < GATE_CHAIN_COVERAGE) return null
  return { chars: t.length, signature, maxFreq, chainCoverage: cov }
}

/** 主导 8-gram 的循环链覆盖：按相邻出现间距的众数恢复周期，把周期连排段计为链。 */
function chainCoverageOf(t: string, g: string): number {
  const idx: number[] = []
  for (let pos = t.indexOf(g); pos !== -1; pos = t.indexOf(g, pos + 1)) idx.push(pos)
  if (idx.length < 2) return idx.length === 1 ? g.length / t.length : 0
  const gapCount = new Map<number, number>()
  for (let i = 1; i < idx.length; i++) {
    const d = idx[i] - idx[i - 1]
    gapCount.set(d, (gapCount.get(d) ?? 0) + 1)
  }
  let period = 0, best = 0
  for (const [d, c] of gapCount) if (c > best || (c === best && d < period)) { best = c; period = d; }
  if (period <= 0) period = g.length
  // 众数间距计数 <3 不构成循环证据（教材脚本自然复现主题词曾误拒；真实循环为百级）。
  if (best < 3) return 0
  let covered = 0, runStart = idx[0], prev = idx[0]
  for (let i = 1; i <= idx.length; i++) {
    const cur = i < idx.length ? idx[i] : Number.NaN
    if (i < idx.length && cur - prev === period) { prev = cur; continue; }
    covered += (prev - runStart) + period
    if (i < idx.length) { runStart = cur; prev = cur; }
  }
  return Math.min(covered, t.length) / t.length
}

/** 全文（按 300s 窗聚合）退化分析。 */
export function analyzeDegeneration(segments: Segment[]): DegenerationReport {
  const buckets = new Map<number, { startS: number; endS: number; parts: string[] }>()
  for (const seg of segments) {
    const b = Math.floor(seg.startS / GATE_WINDOW_S)
    let w = buckets.get(b)
    if (!w) { w = { startS: b * GATE_WINDOW_S, endS: (b + 1) * GATE_WINDOW_S, parts: [] }; buckets.set(b, w); }
    w.parts.push(seg.text)
  }
  const windows: DegenerateWindowInfo[] = []
  let totalChars = 0
  for (const w of buckets.values()) {
    const info = analyzeWindowDegeneration(w.parts.join(""))
    totalChars += info?.chars ?? w.parts.join("").replace(/\s+/g, "").length
    if (info) windows.push({ ...info, startS: w.startS, endS: w.endS })
  }
  const degenerateChars = windows.reduce((a, x) => a + x.chars, 0)
  return { windows, totalChars, degenerateChars, coverage: totalChars > 0 ? degenerateChars / totalChars : 0 }
}

/** whisper.cpp `-oj` 输出 → Segment[]（守门以剥前原文判窗，故守门前传 strip:false）。 */
export function parseWhisperJson(raw: unknown, opts: { strip?: boolean } = {}): Segment[] {
  const j = raw as { transcription?: Array<{ offsets?: { from?: number; to?: number }; text?: string }> }
  const segs = (j.transcription ?? []).map(t => ({
    startS: (t.offsets?.from ?? 0) / 1000,
    endS: (t.offsets?.to ?? 0) / 1000,
    text: (t.text ?? "").trim(),
  }))
  return opts.strip === false ? segs : stripHallucinationSegments(segs)
}

// ── 保留策略（D7 三重防线的②③；①=wav 即删，在管线 finally）──

function dirSize(p: string): number {
  let n = 0
  for (const e of readdirSync(p, { withFileTypes: true })) {
    const c = join(p, e.name)
    try {
      n += e.isDirectory() ? dirSize(c) : statSync(c).size
    } catch {
      // 单项失败忽略（清理路径 best-effort）
    }
  }
  return n
}

/** 入口自清扫：>7 天 <sha12> 目录删除 + 总量帽 1GB 按 mtime LRU 淘汰。best-effort 不外抛。 */
export function cleanupMediaRoot(
  root: string,
  opts: { now?: () => number } = {},
): { removedDirs: number; lruEvicted: number } {
  const result = { removedDirs: 0, lruEvicted: 0 }
  if (!existsSync(root)) return result
  const now = (opts.now ?? Date.now)()
  const cutoff = now - MEDIA_RETENTION_DAYS * 86400_000
  const dirs = readdirSync(root, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => join(root, e.name))
  for (const p of dirs) {
    try {
      if (statSync(p).mtimeMs < cutoff) {
        rmSync(p, { recursive: true, force: true })
        result.removedDirs++
      }
    } catch {
      // best-effort
    }
  }
  const survivors = dirs
    .filter(p => existsSync(p))
    .map(p => ({ p, mtimeMs: statSync(p).mtimeMs, size: dirSize(p) }))
    .sort((a, b) => a.mtimeMs - b.mtimeMs)
  let total = survivors.reduce((n, d) => n + d.size, 0)
  for (const d of survivors) {
    if (total <= MEDIA_TOTAL_CAP_BYTES) break
    try {
      rmSync(d.p, { recursive: true, force: true })
      total -= d.size
      result.lruEvicted++
    } catch {
      break
    }
  }
  return result
}

// ── 错误文案剥绝对路径（v1 pptx.ts 同款正则；成功载荷保留路径）──

export function stripAbsolutePaths(raw: string): string {
  const stripped = raw.replace(/\/(?:Users|tmp|home|var\/folders|private)\/[^\s'"]+/g, "<路径>")
  return stripped === raw ? raw : stripped
}

// ── 主管线 ──

let extractionInFlight = false

interface ProbeInfo {
  durationS: number
  hasVideo: boolean
  hasAudio: boolean
}

function parseProbeJson(stdout: string): ProbeInfo {
  const j = JSON.parse(stdout) as {
    streams?: Array<{ codec_type?: string }>
    format?: { duration?: string }
  }
  const durationS = Number(j.format?.duration ?? 0)
  return {
    durationS: Number.isFinite(durationS) ? durationS : 0,
    hasVideo: (j.streams ?? []).some(s => s.codec_type === "video"),
    hasAudio: (j.streams ?? []).some(s => s.codec_type === "audio"),
  }
}

/**
 * 提取教师上传的音视频素材。全失败面 { ok:false, error } 正常文本返回（不抛
 * ToolArgumentError——计划评审 C3）；成功含绝对路径（agent 后续消费）。
 */
export async function extractMedia(
  raw: { media_path: unknown; want?: unknown },
  deps: MediaExtractDeps = {},
): Promise<MediaExtractResult> {
  const mediaPath = typeof raw.media_path === "string" ? raw.media_path.trim() : ""
  if (mediaPath === "") {
    return { ok: false, error: "media_path 不能为空——请从消息里的素材注记行取完整路径" }
  }
  if (!isAbsolute(mediaPath)) {
    return { ok: false, error: "media_path 必须是素材注记行里的完整本地路径" }
  }
  // 安全卫门先于格式引导（/etc/passwd 类输入报「允许范围」而非格式文案）。
  if (!isAllowedMediaPath(mediaPath, deps.allowRoots)) {
    return { ok: false, error: "素材路径不在允许范围——请使用消息里系统提供的素材路径" }
  }
  if (!existsSync(mediaPath)) {
    return { ok: false, error: "素材文件不存在（缓存可能已过期，24 小时清理）——请老师重新发送素材" }
  }
  const ext = extOf(mediaPath)
  if (IMAGE_EXTS.has(ext)) {
    return { ok: false, error: "图片素材无需提取——请直接按图片流程处理（vision 转写）" }
  }
  if (!VIDEO_EXTS.has(ext) && !AUDIO_EXTS.has(ext)) {
    return { ok: false, error: `暂不支持的素材格式（${ext}）——支持常见视频/音频格式` }
  }
  if (extractionInFlight) {
    return { ok: false, error: "正在处理另一位老师的素材，请稍后再试" }
  }
  extractionInFlight = true
  try {
    return await runPipeline(mediaPath, raw.want, deps)
  } finally {
    extractionInFlight = false
  }
}

async function runPipeline(
  mediaPath: string,
  want: unknown,
  deps: MediaExtractDeps,
): Promise<MediaExtractResult> {
  const env = deps.env ?? process.env
  const exec = deps.exec
    ?? ((cmd: string, args: string[], opts: { timeout: number; maxBuffer: number }) =>
      execFileAsync(cmd, args, opts) as Promise<{ stdout: string }>)
  const ffmpeg = resolveToolBinary("ffmpeg", env["LTUTOR_MEDIA__FFMPEG"])
  const ffprobe = resolveToolBinary("ffprobe", env["LTUTOR_MEDIA__FFPROBE"])
  const whisperCli = resolveToolBinary("whisper-cli", env["LTUTOR_MEDIA__WHISPER_CLI"])
  if (!ffmpeg || !ffprobe || !whisperCli) {
    return { ok: false, error: "媒体处理组件未安装（ffmpeg/whisper）——环境故障，请勿反复重试；可先给教师文字版大纲" }
  }
  const modelPath = (env["LTUTOR_MEDIA__WHISPER_MODEL"]?.trim() || modelPathFromModulePath(fileURLToPath(import.meta.url)))
  let modelReady = false
  try {
    modelReady = statSync(modelPath).isFile()
  } catch {
    modelReady = false
  }
  if (!modelReady) {
    return { ok: false, error: "转写模型未就绪——环境故障，请勿反复重试；可先给教师文字版大纲" }
  }

  const outRoot = deps.outRoot ?? DEFAULT_MEDIA_OUT_ROOT
  try {
    cleanupMediaRoot(outRoot)
  } catch {
    // best-effort
  }

  // 段 1：probe（预算 20s）
  let probe: ProbeInfo
  try {
    const deadline = Date.now() + SEGMENT_BUDGET_S.probe * 1000
    const { stdout } = await exec(ffprobe, [
      "-v", "error", "-show_entries", "format=duration", "-show_entries", "stream=codec_type", "-of", "json", mediaPath,
    ], { timeout: remainingTimeoutMs(deadline), maxBuffer: 10 * 1024 * 1024 })
    probe = parseProbeJson(stdout)
  } catch (err) {
    return { ok: false, error: `素材探测失败：${stripAbsolutePaths(String(err))}——格式可能不支持` }
  }
  if (probe.durationS <= 0) {
    return { ok: false, error: "素材时长无法识别——格式可能不支持" }
  }
  if (probe.durationS > MEDIA_MAX_DURATION_S) {
    return { ok: false, error: `素材 ${Math.round(probe.durationS / 60)} 分钟超过 15 分钟上限——请老师截取片段，或将素材入库后从库内取材` }
  }

  const sha12 = (await mediaSha1(mediaPath)).slice(0, 12)
  const outDir = join(outRoot, sha12)
  const wavPath = join(outDir, "audio.wav")
  const mp3Path = join(outDir, "audio.mp3")
  const sheetPath = join(outDir, "sheet.jpg")
  const whisperJsonPath = join(outDir, "transcript.json")
  const isVideo = probe.hasVideo && VIDEO_EXTS.has(extOf(mediaPath))
  const wantTranscriptOnly = want === "transcript_only"
  let wavProduced = false

  try {
    mkdirSync(outDir, { recursive: true })

    // 段 2：ffmpeg 组（预算 60s，组内共享 deadline——计划评审 N2）
    const ffmpegDeadline = Date.now() + SEGMENT_BUDGET_S.ffmpeg * 1000
    try {
      if (probe.hasAudio) {
        await exec(ffmpeg, ["-v", "error", ...wavExtractArgs(mediaPath, wavPath)],
          { timeout: remainingTimeoutMs(ffmpegDeadline), maxBuffer: 10 * 1024 * 1024 })
        wavProduced = existsSync(wavPath)
      }
      if (probe.hasAudio) {
        await exec(ffmpeg, ["-v", "error", ...mp3Args(mediaPath, mp3Path)],
          { timeout: remainingTimeoutMs(ffmpegDeadline), maxBuffer: 10 * 1024 * 1024 })
      }
      if (isVideo && !wantTranscriptOnly) {
        await exec(ffmpeg, ["-v", "error", ...sheetArgs(mediaPath, sheetPath, probe.durationS)],
          { timeout: remainingTimeoutMs(ffmpegDeadline), maxBuffer: 10 * 1024 * 1024 })
      }
    } catch (err) {
      return { ok: false, error: `媒体处理超时或失败：${stripAbsolutePaths(String(err))}——素材可能过长或损坏` }
    }

    // 段 3：whisper（预算 200s；wav 用毕即删——D7 防线①）
    let segments: Segment[] = []
    if (wavProduced) {
      try {
        const deadline = Date.now() + SEGMENT_BUDGET_S.whisper * 1000
        await exec(whisperCli, whisperArgs(modelPath, wavPath, whisperJsonPath),
          { timeout: remainingTimeoutMs(deadline), maxBuffer: 50 * 1024 * 1024 })
        const rawJson = JSON.parse(readJsonOr(whisperJsonPath))
        const unstripped = parseWhisperJson(rawJson, { strip: false })
        const report = analyzeDegeneration(unstripped)
        if (report.coverage >= GATE_REJECT_COVERAGE && unstripped.length > 0) {
          return { ok: false, error: "转写质量异常（疑似水印噪音或无有效语音）——建议换素材或截取有效片段" }
        }
        segments = stripHallucinationSegments(unstripped)
      } catch (err) {
        return { ok: false, error: `转写失败：${stripAbsolutePaths(String(err))}——请稍后再试或换素材` }
      } finally {
        try {
          rmSync(wavPath, { force: true })
        } catch {
          // best-effort
        }
      }
    }

    const truncated = segments.length > MEDIA_TRANSCRIPT_MAX_SEGMENTS
    const transcript: TranscriptSegment[] = (truncated ? segments.slice(0, MEDIA_TRANSCRIPT_MAX_SEGMENTS) : segments)
      .map(s => ({ start_s: s.startS, end_s: s.endS, text: s.text }))
    return {
      ok: true,
      kind: isVideo ? "video" : "audio",
      duration_s: Math.round(probe.durationS * 10) / 10,
      sheet_path: isVideo && !wantTranscriptOnly && existsSync(sheetPath) ? sheetPath : undefined,
      transcript,
      audio_mp3_path: probe.hasAudio && existsSync(mp3Path) ? mp3Path : undefined,
      transcript_truncated: truncated || undefined,
    }
  } catch (err) {
    return { ok: false, error: `提取失败：${stripAbsolutePaths(String(err))}` }
  }
}

function extOf(p: string): string {
  const i = p.lastIndexOf(".")
  return i === -1 ? "" : p.slice(i).toLowerCase()
}

/** whisper-cli -oj 会写 <prefix>.json；读回容错（缺文件返回 "null" 让 JSON.parse 走 catch）。 */
function readJsonOr(path: string): string {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return "null"
  }
}
