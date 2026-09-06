/**
 * 听力音频合成引擎（2026-09-06 图片→听力音频计划 3.3，评审 r2 收口）。
 *
 * 管线：dialogue[] → 逐行 edge-tts（A=en-US-AriaNeural 女 / B=en-US-GuyNeural 男）
 * → 全段归一 24kHz mono wav → ffmpeg concat（行间 0.7s 静音）→ mp3
 * （libmp3lame 48k，与 edge-tts 原生 48kbps 量级一致——评审实证升 128k 零增益）。
 *
 * 评审实证约束（.superpowers/image-to-listening-plan-review-2026-09-06/）：
 * - `--rate` 必须带符号整数百分比（包内校验 `^[+-]\d+%`，照字面传 0.85 被拒）；
 * - `anullsrc` 默认 44.1kHz 立体声与 edge-tts 24kHz mono 不匹配会翻车——静音段
 *   显式 `r=24000:cl=mono`；
 * - 合成有界并发（60 行串行逼近 MCP 300s 超时）；
 * - `--text` 一律数组参数、不经 shell。
 *
 * edge-tts 不可用/失败 → 整体降级 macOS `say -v Ava`（Premium 单声、无行间
 * 留白）——返回值注明引擎与局限。
 */
import { execFile } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

export const EDGE_VOICE_A = "en-US-AriaNeural"
export const EDGE_VOICE_B = "en-US-GuyNeural"
export const LISTENING_GAP_SECONDS = 0.7
export const LISTENING_CONCURRENCY = 5
/** 单个子进程超时（edge-tts 11 词 ~5s；600 字符长行语音 ~40s，90s 兜尾）。 */
export const LISTENING_PROC_TIMEOUT_MS = 90_000
export const LISTENING_SAY_TIMEOUT_MS = 300_000
export const DEFAULT_LISTENING_OUT_DIR = path.join(homedir(), ".hermes", "cache", "ltutor-tts")

export interface DialogueLine {
  speaker?: "A" | "B" | null
  text: string
}

export interface ListeningAudioOptions {
  speed?: number
  title?: string
}

export interface ListeningSynthResult {
  ok: boolean
  path?: string
  engine?: "edge-tts" | "say"
  note?: string
  error?: string
}

export interface ListeningSynthDeps {
  execFile?: (cmd: string, args: string[], opts: { timeout: number }) => Promise<unknown>
  outDir?: string
}

/** 语速倍率 → edge-tts `--rate` 带符号整数百分比（1.0→+0%，0.85→-15%）。 */
export function speedToRate(speed: number): string {
  const percent = Math.round((speed - 1) * 100)
  const clamped = Math.max(-50, Math.min(100, percent))
  return clamped >= 0 ? `+${clamped}%` : `${clamped}%`
}

/** 文件名主题清洗：白名单 [A-Za-z0-9 汉字 _-]、剥首尾分隔符、≤80，空回落 listening。 */
export function sanitizeTitle(raw: unknown): string {
  if (typeof raw !== "string") return "listening"
  const cleaned = raw.replace(/[^A-Za-z0-9\u4e00-\u9fa5_-]/g, "").replace(/^[-_]+|[-_]+$/g, "")
  return cleaned.slice(0, 80) || "listening"
}

function timestampName(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0")
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
}

function voiceFor(speaker: DialogueLine["speaker"]): string {
  return speaker === "B" ? EDGE_VOICE_B : EDGE_VOICE_A
}

async function runWithConcurrency(jobs: Array<() => Promise<void>>, limit: number): Promise<void> {
  let next = 0
  const workers = Array.from({ length: Math.min(limit, jobs.length) }, async () => {
    while (next < jobs.length) {
      const index = next++
      await jobs[index]()
    }
  })
  await Promise.all(workers)
}

async function synthViaEdge(
  run: NonNullable<ListeningSynthDeps["execFile"]>,
  dialogue: DialogueLine[],
  rate: string,
  tmp: string,
): Promise<void> {
  const jobs = dialogue.map((line, i) => async () => {
    const mp3 = path.join(tmp, `line${i}.mp3`)
    const wav = path.join(tmp, `line${i}.wav`)
    await run(
      "edge-tts",
      ["--voice", voiceFor(line.speaker), "--rate", rate, "--text", line.text, "--write-media", mp3],
      { timeout: LISTENING_PROC_TIMEOUT_MS },
    )
    // 归一到与静音段一致的 24kHz mono，concat demuxer 才能直接拼。
    await run("ffmpeg", ["-y", "-i", mp3, "-ar", "24000", "-ac", "1", wav], { timeout: LISTENING_PROC_TIMEOUT_MS })
  })
  await runWithConcurrency(jobs, LISTENING_CONCURRENCY)
}

async function synthViaSay(
  run: NonNullable<ListeningSynthDeps["execFile"]>,
  dialogue: DialogueLine[],
  tmp: string,
): Promise<void> {
  const aiff = path.join(tmp, "say-all.aiff")
  await run("say", ["-v", "Ava", "-o", aiff, dialogue.map((l) => l.text).join("\n\n")], {
    timeout: LISTENING_SAY_TIMEOUT_MS,
  })
}

/**
 * 合成听力音频。成功返回 { ok, path, engine, note }；两级引擎都失败返回
 * { ok: false, error }。tmp 目录始终清理。
 */
export async function synthesizeListeningAudio(
  dialogue: DialogueLine[],
  options: ListeningAudioOptions = {},
  deps: ListeningSynthDeps = {},
): Promise<ListeningSynthResult> {
  if (dialogue.length === 0) return { ok: false, error: "dialogue 为空" }
  const run = deps.execFile ?? execFileAsync
  const outDir = deps.outDir ?? DEFAULT_LISTENING_OUT_DIR
  const rate = speedToRate(options.speed ?? 1)
  const finalPath = path.join(outDir, `${timestampName()}_${sanitizeTitle(options.title)}.mp3`)

  mkdirSync(outDir, { recursive: true })
  const tmp = mkdtempSync(path.join(outDir, "tmp-"))
  try {
    let engine: "edge-tts" | "say"
    try {
      await synthViaEdge(run, dialogue, rate, tmp)
      engine = "edge-tts"
    } catch (edgeErr) {
      try {
        await synthViaSay(run, dialogue, tmp)
        engine = "say"
      } catch (sayErr) {
        return {
          ok: false,
          error: `edge-tts 失败（${String(edgeErr)}）；say 备用也失败（${String(sayErr)}）`,
        }
      }
    }

    if (engine === "say") {
      await run(
        "ffmpeg",
        ["-y", "-i", path.join(tmp, "say-all.aiff"), "-ar", "24000", "-ac", "1", "-c:a", "libmp3lame", "-b:a", "48k", finalPath],
        { timeout: LISTENING_PROC_TIMEOUT_MS },
      )
      return {
        ok: true,
        path: finalPath,
        engine,
        note: "备用系统嗓音（Ava，单人声、无行间留白）——建议网络恢复后重新生成双人声版",
      }
    }

    // edge 路径：行间静音（显式 24kHz mono，见文件头评审实证）+ concat + 终编。
    if (dialogue.length > 1) {
      await run(
        "ffmpeg",
        ["-y", "-f", "lavfi", "-i", `anullsrc=r=24000:cl=mono`, "-t", String(LISTENING_GAP_SECONDS), path.join(tmp, "silence.wav")],
        { timeout: LISTENING_PROC_TIMEOUT_MS },
      )
    }
    const listPath = path.join(tmp, "concat.txt")
    const parts: string[] = []
    dialogue.forEach((_, i) => {
      parts.push(`file '${path.join(tmp, `line${i}.wav`)}'`)
      if (i < dialogue.length - 1) parts.push(`file '${path.join(tmp, "silence.wav")}'`)
    })
    writeFileSync(listPath, parts.join("\n") + "\n", "utf8")
    await run(
      "ffmpeg",
      ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c:a", "libmp3lame", "-b:a", "48k", finalPath],
      { timeout: LISTENING_PROC_TIMEOUT_MS },
    )
    return { ok: true, path: finalPath, engine, note: "双人声：A=Aria（女）B=Guy（男），行间留白 0.7s" }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}
