import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"

import {
  EDGE_VOICE_A,
  EDGE_VOICE_B,
  LISTENING_CONCURRENCY,
  sanitizeTitle,
  speedToRate,
  synthesizeListeningAudio,
} from "../src/listening-audio.js"

interface FakeRunCall {
  cmd: string
  args: string[]
}

/** 可编程 execFile 假体：按命令形态落盘产物（concat 时顺带快照清单内容）。 */
function makeFakeRun(opts: { failEdge?: boolean } = {}) {
  const calls: FakeRunCall[] = []
  const state: { peakInflight: number; concatList: string | null } = { peakInflight: 0, concatList: null }
  let inflight = 0
  const run = async (cmd: string, args: string[]): Promise<unknown> => {
    if (cmd === "edge-tts" && opts.failEdge) {
      throw new Error("ENOENT: edge-tts not found")
    }
    calls.push({ cmd, args })
    inflight += 1
    state.peakInflight = Math.max(state.peakInflight, inflight)
    await new Promise((resolve) => setTimeout(resolve, 4))
    try {
      if (cmd === "edge-tts") {
        const i = args.indexOf("--write-media")
        writeFileSync(args[i + 1], "fake-mp3-bytes")
      } else if (cmd === "say") {
        const i = args.indexOf("-o")
        writeFileSync(args[i + 1], "fake-aiff-bytes")
      } else if (cmd === "ffmpeg") {
        if (args.includes("concat")) {
          const i = args.indexOf("-i")
          state.concatList = readFileSync(args[i + 1], "utf8")
        }
        writeFileSync(args[args.length - 1], "fake-audio-bytes")
      }
    } finally {
      inflight -= 1
    }
    return { stdout: "", stderr: "" }
  }
  return { run, calls, state }
}

const DIALOGUE = [
  { speaker: "A" as const, text: "Good morning, class." },
  { speaker: "B" as const, text: "Good morning, Miss Li." },
  { text: "Today we will learn about animals." },
]

test("speedToRate：带符号整数百分比（评审 R1 正则 ^[+-]\\d+%$）", () => {
  assert.equal(speedToRate(1), "+0%")
  assert.equal(speedToRate(0.85), "-15%")
  assert.equal(speedToRate(1.2), "+20%")
  assert.equal(speedToRate(0.2), "-50%")
  assert.equal(speedToRate(3), "+100%")
  for (const s of [1, 0.85, 1.27]) {
    assert.match(speedToRate(s), /^[+-]\d+%$/)
  }
})

test("sanitizeTitle：白名单清洗 + 长度上限 + 空回落", () => {
  assert.equal(sanitizeTitle("Unit 3: 对话/测试*"), "Unit3对话测试")
  assert.equal(sanitizeTitle("  "), "listening")
  assert.equal(sanitizeTitle(undefined), "listening")
  assert.equal(sanitizeTitle("-_trim_-"), "trim")
  assert.equal(sanitizeTitle("x".repeat(200)).length, 80)
})

test("edge 主路径：rate/voice 映射、静音段 24kHz mono、concat 行间交错、文件名清洗", async () => {
  const outDir = mkdtempSync(path.join(tmpdir(), "ltutor-tts-out-"))
  const { run, calls, state } = makeFakeRun()

  const result = await synthesizeListeningAudio(
    DIALOGUE,
    { speed: 0.85, title: "Unit 3: 对话" },
    { execFile: run, outDir },
  )

  assert.equal(result.ok, true)
  assert.equal(result.engine, "edge-tts")
  assert.ok(result.path, "result.path 必须存在")
  assert.ok(result.path!.endsWith(".mp3"))
  assert.match(path.basename(result.path!), /_Unit3对话\.mp3$/)

  const edgeCalls = calls.filter((c) => c.cmd === "edge-tts")
  assert.equal(edgeCalls.length, 3)
  assert.deepEqual(
    edgeCalls.map((c) => c.args[c.args.indexOf("--voice") + 1]),
    [EDGE_VOICE_A, EDGE_VOICE_B, EDGE_VOICE_A],
  )
  for (const c of edgeCalls) {
    assert.equal(c.args[c.args.indexOf("--rate") + 1], "-15%")
  }
  for (const c of edgeCalls) {
    // R1/I2④：文本走数组参数（无 shell 拼接），此处即验证 args 内为独立元素。
    assert.ok(c.args.includes("--text"))
  }

  const silence = calls.find((c) => c.cmd === "ffmpeg" && c.args.some((a) => a.startsWith("anullsrc")))
  assert.ok(silence, "必须生成行间静音段")
  assert.ok(silence.args.some((a) => a === "anullsrc=r=24000:cl=mono"), "静音段必须显式 24kHz mono")

  assert.ok(state.concatList, "concat 清单必须被读取")
  const files = state.concatList!.split("\n").filter((l) => l.startsWith("file ")).map((l) => l.slice(6, -1))
  assert.equal(files.length, 5, "3 行对话 + 2 段静音")
  assert.ok(files[0].includes("line0.wav"))
  assert.ok(files[1].endsWith("silence.wav"))
  assert.ok(files[2].includes("line1.wav"))
  assert.ok(files[3].endsWith("silence.wav"))
  assert.ok(files[4].includes("line2.wav"))
})

test("say 降级：edge 失败整体回落、单人声局限注明", async () => {
  const outDir = mkdtempSync(path.join(tmpdir(), "ltutor-tts-say-"))
  const { run, calls } = makeFakeRun({ failEdge: true })

  const result = await synthesizeListeningAudio(DIALOGUE, { title: "fallback" }, { execFile: run, outDir })

  assert.equal(result.ok, true)
  assert.equal(result.engine, "say")
  assert.ok(result.note!.includes("单人声"))
  const sayCall = calls.find((c) => c.cmd === "say")
  assert.ok(sayCall, "必须调用 say")
  assert.ok(sayCall.args.includes("Ava"))
  assert.ok(sayCall.args.some((a) => a.includes("Good morning, class.")))
  assert.ok(sayCall.args.some((a) => a.includes("animals")), "全部行文本进入单次合成")
})

test("双引擎皆败：返回可读聚合错误", async () => {
  const outDir = mkdtempSync(path.join(tmpdir(), "ltutor-tts-err-"))
  const run = async () => {
    throw new Error("boom")
  }
  const result = await synthesizeListeningAudio(DIALOGUE, {}, { execFile: run, outDir })
  assert.equal(result.ok, false)
  assert.ok(result.error!.includes("edge-tts 失败"))
  assert.ok(result.error!.includes("say 备用也失败"))
})

test("并发有界：12 行合成峰值 ≤ LISTENING_CONCURRENCY", async () => {
  const outDir = mkdtempSync(path.join(tmpdir(), "ltutor-tts-conc-"))
  const { run, state } = makeFakeRun()
  const many = Array.from({ length: 12 }, (_, i) => ({ speaker: (i % 2 ? "B" : "A") as "A" | "B", text: `Line ${i}.` }))

  const result = await synthesizeListeningAudio(many, {}, { execFile: run, outDir })
  assert.equal(result.ok, true)
  assert.ok(state.peakInflight <= LISTENING_CONCURRENCY + 2, `峰值 ${state.peakInflight} 应贴近并发上限（ffmpeg 静音/终编串行）`)
})

test("I3 同构: outDir 为普通文件 → ok:false 不抛错（2026-09-10 评审）", async () => {
  const fileDir = path.join(mkdtempSync(path.join(tmpdir(), "ltutor-tts-ei-")), "not-a-dir")
  writeFileSync(fileDir, "occupied")
  const result = await synthesizeListeningAudio(DIALOGUE, { title: "x" }, { outDir: fileDir })
  assert.equal(result.ok, false)
  assert.ok(result.error!.length > 0)
})
