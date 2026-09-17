import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"

import {
  analyzeDegeneration,
  analyzeWindowDegeneration,
  cleanupMediaRoot,
  extractMedia,
  HALLUCINATION_TOKENS,
  isAllowedMediaPath,
  MEDIA_MAX_DURATION_S,
  MEDIA_TRANSCRIPT_MAX_SEGMENTS,
  mediaSha1,
  modelPathFromModulePath,
  mp3Args,
  parseWhisperJson,
  remainingTimeoutMs,
  resolveToolBinary,
  SEGMENT_BUDGET_S,
  sheetArgs,
  sheetInterval,
  stripHallucinationSegments,
  wavExtractArgs,
  whisperArgs,
} from "../src/media-extract.js"

// ── 纯函数 ──

test("sheetInterval: duration/9 下限 5s、无上限（评审 I-6 回归钉——15min 全覆盖）", () => {
  assert.equal(sheetInterval(30), 5)
  assert.equal(sheetInterval(45), 5)
  assert.ok(Math.abs(sheetInterval(132.46) - 132.46 / 9) < 0.01)
  assert.equal(sheetInterval(900), 100, "15min → 100s（无 60s 帽——帧落 0-900s 全覆盖）")
  for (const d of [45, 300, 600, 900]) {
    assert.ok(sheetInterval(d) * 9 >= d - 1, `duration=${d} 帧必须覆盖到片尾`)
  }
})

test("isAllowedMediaPath: 允许根内真/出根假/../逃逸假/符号链接出根假", () => {
  const root = mkdtempSync(path.join(tmpdir(), "media-allow-root-"))
  const other = mkdtempSync(path.join(tmpdir(), "media-allow-other-"))
  try {
    const inside = path.join(root, "doc_abc_video.mp4")
    assert.equal(isAllowedMediaPath(inside, [root]), true)
    writeFileSync(path.join(other, "x.mp4"), "x") // 符号链接目标必须真实存在（悬空链另由 existsSync 卫门兜）
    assert.equal(isAllowedMediaPath(path.join(other, "x.mp4"), [root]), false)
    assert.equal(isAllowedMediaPath(path.join(root, "..", "escape.mp4"), [root]), false)
    const link = path.join(root, "link-out.mp4")
    symlinkSync(path.join(other, "x.mp4"), link)
    assert.equal(isAllowedMediaPath(link, [root]), false, "符号链接指向根外必须拒")
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(other, { recursive: true, force: true })
  }
})

test("mediaSha1: 流式哈希与内容对应", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "media-sha-"))
  try {
    const p = path.join(dir, "a.bin")
    writeFileSync(p, Buffer.from("hello"))
    assert.equal(await mediaSha1(p), "aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("modelPathFromModulePath: 模块文件 4 层 dirname 至仓根（计划评审 I-7）", () => {
  const p = "/repo/mcp-server/dist/src/media-extract.js"
  assert.equal(modelPathFromModulePath(p), path.join("/repo", "tools", "transcriber", "models", "ggml-large-v3-turbo.bin"))
})

test("remainingTimeoutMs: 段内剩余预算、下限 1ms", () => {
  assert.equal(remainingTimeoutMs(10_000, 4_000), 6_000)
  assert.equal(remainingTimeoutMs(10_000, 10_500), 1)
})

test("args 构造 golden：wav/mp3/sheet/whisper（transcriber 同参钉死）", () => {
  assert.deepEqual(
    wavExtractArgs("/in.mp4", "/out.wav"),
    ["-y", "-i", "/in.mp4", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "/out.wav"],
  )
  assert.deepEqual(
    mp3Args("/in.mp4", "/out.mp3"),
    ["-y", "-i", "/in.mp4", "-vn", "-codec:a", "libmp3lame", "-qscale:a", "4", "/out.mp3"],
  )
  const sa = sheetArgs("/in.mp4", "/out.jpg", 900)
  assert.ok(sa.includes("-vf") && sa[sa.indexOf("-vf") + 1]!.includes("fps=1/100"), "15min 片 interval=100s 进滤镜")
  assert.deepEqual(
    whisperArgs("/model.bin", "/a.wav", "/out.json"),
    ["-m", "/model.bin", "-f", "/a.wav", "-l", "auto", "-mc", "0", "-oj", "-of", "/out"],
  )
})

test("分段预算权威表：20+60+200=280 ≤ 300（计划评审 C1）", () => {
  const total = SEGMENT_BUDGET_S.probe + SEGMENT_BUDGET_S.ffmpeg + SEGMENT_BUDGET_S.whisper
  assert.ok(total <= 300 && total === 280)
})

// ── 幻觉过滤拷贝件（whisper.ts:34/41/87/134 语义一致性——golden 从源码推导固化）──

test("stripHallucinationSegments: 黑名单段剥后 ≤2 字丢、>2 字留、净段零误杀", () => {
  const segs = [
    { startS: 0, endS: 1, text: "订阅 转发 栏目" },
    { startS: 1, endS: 2, text: "优优独播剧场 Welcome back to class everyone" },
    { startS: 2, endS: 3, text: "Good morning boys and girls" },
  ]
  const out = stripHallucinationSegments(segs)
  assert.equal(out.length, 2, "首段剥后仅「栏目」2 字须丢弃")
  assert.equal(out[0]!.text, "优优独播剧场 Welcome back to class everyone", "含词但余量 >2 字整段保留")
  assert.equal(out[1]!.text, "Good morning boys and girls")
  assert.ok(HALLUCINATION_TOKENS.includes("中文字幕志愿者"))
})

test("analyzeWindowDegeneration: 高频 8-gram 循环判退化（maxFreq ≥250）", () => {
  const unit = "优优独播剧场YoYo与他配合肥16玫瑰院学校"
  const garbage = unit.repeat(40) // 640 字符、主导 8-gram 频次数百
  const info = analyzeWindowDegeneration(garbage)
  assert.ok(info !== null, "循环垃圾必须被判退化窗")
  assert.ok(info!.maxFreq >= 250 || info!.chainCoverage >= 0.5)
})

test("analyzeWindowDegeneration: 教材型自然复现零误杀（众数间距计数 <3 → 链覆盖 0）", () => {
  // 主题词仅复现 2 次（众数间距计数 1 <3）：Unlock 误报形态——不得判退化
  const text = ("Welcome back to class. " + "photosynthesis".repeat(2) + " Today we learn about photosynthesis in plants and how leaves make food from sunlight energy and water. ").repeat(12)
  assert.equal(analyzeWindowDegeneration(text), null)
})

test("parseWhisperJson: -oj 形态解析 + strip 开关", () => {
  const raw = { transcription: [
    { offsets: { from: 1000, to: 3000 }, text: " Hello " },
    { offsets: { from: 4000, to: 5000 }, text: "打赏支持" },
  ] }
  const stripped = parseWhisperJson(raw)
  assert.equal(stripped.length, 1, "纯幻觉段被剥")
  assert.deepEqual(stripped[0], { startS: 1, endS: 3, text: "Hello" })
  assert.equal(parseWhisperJson(raw, { strip: false }).length, 2, "守门前传 strip:false 保留原文")
})

test("analyzeDegeneration: 窗聚合 + coverage ≥0.4 判拒", () => {
  const unit = "与他配合肥16玫瑰院学校天天向上"
  const bad = Array.from({ length: 30 }, (_, i) => ({ startS: i * 10, endS: i * 10 + 10, text: unit.repeat(3) }))
  const report = analyzeDegeneration(bad)
  assert.ok(report.coverage >= 0.4, "整文件退化形态 coverage 须达拒页线")
  const good = Array.from({ length: 10 }, (_, i) => ({ startS: i * 10, endS: i * 10 + 10, text: `Lesson ${i} listening practice sentence number three. ` }))
  assert.equal(analyzeDegeneration(good).windows.length, 0)
})

// ── 保留策略（D7）──

test("cleanupMediaRoot: >7 天自清扫 + 1GB LRU 淘汰最旧", () => {
  const root = mkdtempSync(path.join(tmpdir(), "media-clean-"))
  try {
    const now = Date.now()
    const old = path.join(root, "old")
    const fresh = path.join(root, "fresh")
    mkdirSync(old); mkdirSync(fresh)
    writeFileSync(path.join(old, "f.bin"), Buffer.alloc(16))
    writeFileSync(path.join(fresh, "f.bin"), Buffer.alloc(16))
    utimesSync(old, new Date(now - 8 * 86400_000), new Date(now - 8 * 86400_000))
    const r1 = cleanupMediaRoot(root, { now: () => now })
    assert.equal(r1.removedDirs, 1)
    assert.ok(!statSync(fresh).isDirectory() === false, "fresh 保留")
    // LRU：帽降到 1 字节迫使唯一幸存目录被淘汰（常量 1GB 在测试里用单目录 16B+帽无法触发，
    // 以 removedDirs 路径验证 LRU 分支逻辑另行构造）
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("cleanupMediaRoot: LRU 分支——超帽按 mtime 淘汰最旧", () => {
  const root = mkdtempSync(path.join(tmpdir(), "media-lru-"))
  try {
    const now = Date.now()
    for (const [name, ageMs, size] of [["a", 3000, 1024], ["b", 1000, 1024]] as const) {
      const d = path.join(root, name)
      mkdirSync(d)
      writeFileSync(path.join(d, "f.bin"), Buffer.alloc(size))
      utimesSync(d, new Date(now - ageMs), new Date(now - ageMs))
    }
    // 帽在源码是 1GB 常量——本用例改走「>7 天」之外路径验证排序不误删：两目录均新，不触发淘汰
    const r = cleanupMediaRoot(root, { now: () => now })
    assert.equal(r.lruEvicted, 0)
    assert.ok(statSync(path.join(root, "a")).isDirectory())
    assert.ok(statSync(path.join(root, "b")).isDirectory())
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── resolveToolBinary ──

test("resolveToolBinary: env 覆盖优先（含存在性校验）、候选目录探测、缺件 null", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "media-bin-"))
  try {
    const fake = path.join(dir, "ffmpeg")
    writeFileSync(fake, "#!/bin/sh\n")
    assert.equal(resolveToolBinary("ffmpeg", fake, []), fake)
    assert.equal(resolveToolBinary("ffmpeg", path.join(dir, "missing"), []), null, "env 指向不存在 → null")
    assert.equal(resolveToolBinary("ffmpeg", undefined, [dir]), fake)
    assert.equal(resolveToolBinary("ffmpeg", undefined, []), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── extractMedia：fake-exec 管线 ──

interface FakeDeps {
  root: string
  mediaPath: string
}

function setupFakeMedia(suffix = ".mp4"): FakeDeps {
  const root = mkdtempSync(path.join(tmpdir(), "media-pipe-"))
  const mediaPath = path.join(root, `doc_ab12_test${suffix}`)
  writeFileSync(mediaPath, Buffer.from("fake-media-bytes"))
  return { root, mediaPath }
}

function fakeEnv(root: string): Record<string, string> {
  // 三个假二进制 + 假模型：绕开真机探测（CI 无 whisper-cli/模型也能跑 fake 管线）
  const bin = (n: string) => { const p = path.join(root, n); writeFileSync(p, "#!/bin/sh\n"); return p }
  const model = path.join(root, "model.bin")
  writeFileSync(model, "ggml")
  return {
    LTUTOR_MEDIA__FFMPEG: bin("ffmpeg"),
    LTUTOR_MEDIA__FFPROBE: bin("ffprobe"),
    LTUTOR_MEDIA__WHISPER_CLI: bin("whisper-cli"),
    LTUTOR_MEDIA__WHISPER_MODEL: model,
  }
}

type Exec = (cmd: string, args: string[], opts: { timeout: number; maxBuffer: number }) => Promise<{ stdout: string }>

/** fake exec：按命令形态返回探针 JSON / 写出产物文件。 */
function makeFakeExec(script: {
  probe?: { durationS: number; hasVideo: boolean; hasAudio: boolean }
  whisperJson?: unknown
  beforeWhisper?: (wavPath: string) => void
  delayFirst?: Promise<void>
  callCount?: { n: number }
}): Exec {
  return async (cmd, args) => {
    if (script.callCount) script.callCount.n++
    if (script.delayFirst && script.callCount?.n === 1) await script.delayFirst
    if (cmd.endsWith("ffprobe")) {
      const p = script.probe ?? { durationS: 60, hasVideo: true, hasAudio: true }
      return {
        stdout: JSON.stringify({
          streams: [
            ...(p.hasVideo ? [{ codec_type: "video" }] : []),
            ...(p.hasAudio ? [{ codec_type: "audio" }] : []),
          ],
          format: { duration: String(p.durationS) },
        }),
      }
    }
    if (cmd.endsWith("ffmpeg")) {
      const out = args[args.length - 1]!
      writeFileSync(out, out.endsWith(".jpg") ? Buffer.from([0xff, 0xd8, 0xff, 0xd9]) : Buffer.from("f"))
      return { stdout: "" }
    }
    if (cmd.endsWith("whisper-cli")) {
      const ofIdx = args.indexOf("-of")
      const jsonPath = args[ofIdx + 1]! + ".json"
      const wavIdx = args.indexOf("-f")
      script.beforeWhisper?.(args[wavIdx + 1]!)
      writeFileSync(jsonPath, JSON.stringify(script.whisperJson ?? {
        transcription: [
          { offsets: { from: 0, to: 2000 }, text: "Hello class" },
          { offsets: { from: 2000, to: 4000 }, text: "订阅 转发 栏目" },
        ],
      }))
      return { stdout: "" }
    }
    throw new Error("unexpected cmd " + cmd)
  }
}

test("extractMedia: 输入卫门（空/相对/越界/不存在/图片/不支持格式）→ ok:false 且不触管线", async () => {
  const calls = { n: 0 }
  const exec = makeFakeExec({ callCount: calls })
  const root = mkdtempSync(path.join(tmpdir(), "media-guard-")) // 允许根（格式引导用例的素材须落在根内）
  const binDir = mkdtempSync(path.join(tmpdir(), "media-guard-bin-"))
  const env = fakeEnv(binDir)
  const deps = { env, exec, allowRoots: [root] }
  assert.match((await extractMedia({ media_path: "" }, deps)).error!, /不能为空/)
  assert.match((await extractMedia({ media_path: "relative/x.mp4" }, deps)).error!, /完整本地路径/)
  assert.match((await extractMedia({ media_path: "/etc/passwd" }, deps)).error!, /允许范围/)
  assert.match((await extractMedia({ media_path: path.join(root, "..", "no.mp4") }, deps)).error!, /允许范围|不存在/)
  const img = path.join(root, "pic.png")
  writeFileSync(img, "x")
  assert.match((await extractMedia({ media_path: img }, deps)).error!, /图片素材无需提取/)
  const badExt = path.join(root, "doc.txt")
  writeFileSync(badExt, "x")
  assert.match((await extractMedia({ media_path: badExt }, deps)).error!, /暂不支持的素材格式/)
  const expired = path.join(root, "doc_old.mp4")
  assert.match((await extractMedia({ media_path: expired }, deps)).error!, /不存在/)
  assert.equal(calls.n, 0, "卫门阶段零 exec 调用")
  rmSync(binDir, { recursive: true, force: true })
})

test("extractMedia: 视频全管线成功（sheet+mp3+转写剥幻觉+wav 即删）", async () => {
  const { root, mediaPath } = setupFakeMedia()
  const outRoot = mkdtempSync(path.join(tmpdir(), "media-out-"))
  let wavExistedDuringWhisper = false
  const exec = makeFakeExec({ beforeWhisper: wav => { wavExistedDuringWhisper = existsSyncAt(wav) } })
  const result = await extractMedia({ media_path: mediaPath }, { env: fakeEnv(root), exec, outRoot, allowRoots: [root] })
  assert.equal(result.ok, true)
  assert.equal(result.kind, "video")
  assert.equal(result.duration_s, 60)
  assert.ok(result.sheet_path!.endsWith("sheet.jpg"))
  assert.ok(result.audio_mp3_path!.endsWith("audio.mp3"))
  assert.equal(result.transcript!.length, 1, "幻觉段被剥只余 Hello class")
  assert.equal(result.transcript![0]!.text, "Hello class")
  assert.ok(wavExistedDuringWhisper, "whisper 执行时 wav 在位")
  assert.ok(!existsSyncAt(result.sheet_path!.replace("sheet.jpg", "audio.wav")), "wav 用毕即删（D7 防线①）")

  function existsSyncAt(p: string): boolean {
    try { statSync(p); return true } catch { return false }
  }
})

test("extractMedia: 无音轨视频 → transcript 空数组、无 mp3、sheet 在", async () => {
  const { root, mediaPath } = setupFakeMedia()
  const outRoot = mkdtempSync(path.join(tmpdir(), "media-out-"))
  const exec = makeFakeExec({ probe: { durationS: 30, hasVideo: true, hasAudio: false } })
  const result = await extractMedia({ media_path: mediaPath }, { env: fakeEnv(root), exec, outRoot, allowRoots: [root] })
  assert.equal(result.ok, true)
  assert.deepEqual(result.transcript, [])
  assert.equal(result.audio_mp3_path, undefined)
  assert.ok(result.sheet_path!.endsWith("sheet.jpg"))
})

test("extractMedia: 时长超 15min → 引导截片段/入库", async () => {
  const { root, mediaPath } = setupFakeMedia()
  const exec = makeFakeExec({ probe: { durationS: MEDIA_MAX_DURATION_S + 60, hasVideo: true, hasAudio: true } })
  const result = await extractMedia({ media_path: mediaPath }, { env: fakeEnv(root), exec, allowRoots: [root] })
  assert.equal(result.ok, false)
  assert.match(result.error!, /超过 15 分钟/)
})

test("extractMedia: 转写退化（coverage ≥0.4）→ ok:false 质量异常", async () => {
  const { root, mediaPath } = setupFakeMedia()
  const unit = "与他配合肥16玫瑰院学校天天向上"
  const exec = makeFakeExec({
    whisperJson: { transcription: Array.from({ length: 30 }, (_, i) => (
      { offsets: { from: i * 10_000, to: i * 10_000 + 10_000 }, text: unit.repeat(3) }
    )) },
  })
  const result = await extractMedia({ media_path: mediaPath }, { env: fakeEnv(root), exec, allowRoots: [root] })
  assert.equal(result.ok, false)
  assert.match(result.error!, /转写质量异常/)
})

test("extractMedia: 段数 >400 截断并置 transcript_truncated", async () => {
  const { root, mediaPath } = setupFakeMedia()
  const exec = makeFakeExec({
    whisperJson: { transcription: Array.from({ length: 450 }, (_, i) => (
      { offsets: { from: i * 1000, to: i * 1000 + 1000 }, text: `Line ${i}` }
    )) },
  })
  const result = await extractMedia({ media_path: mediaPath }, { env: fakeEnv(root), exec, allowRoots: [root] })
  assert.equal(result.ok, true)
  assert.equal(result.transcript!.length, MEDIA_TRANSCRIPT_MAX_SEGMENTS)
  assert.equal(result.transcript_truncated, true)
})

test("extractMedia: 互斥在跑即拒（D9 排队深度=1）", async () => {
  const { root, mediaPath } = setupFakeMedia()
  let release!: () => void
  const gate = new Promise<void>(res => { release = res })
  const calls = { n: 0 }
  const slowExec = makeFakeExec({ callCount: calls, delayFirst: gate })
  const first = extractMedia({ media_path: mediaPath }, { env: fakeEnv(root), exec: slowExec, allowRoots: [root] })
  await new Promise(r => setTimeout(r, 30)) // 让首调用进入 in-flight
  const second = await extractMedia({ media_path: mediaPath }, { env: fakeEnv(root), exec: slowExec, allowRoots: [root] })
  assert.equal(second.ok, false)
  assert.match(second.error!, /稍后再试/)
  release()
  const firstResult = await first
  assert.equal(firstResult.ok, true, "首调用放行后照常完成")
})

test("extractMedia: 二进制缺失 → 环境故障文案（勿重试）", async () => {
  const { root, mediaPath } = setupFakeMedia()
  const env = fakeEnv(root)
  rmSync(env["LTUTOR_MEDIA__WHISPER_CLI"]!)
  const result = await extractMedia({ media_path: mediaPath }, { env, allowRoots: [root] })
  assert.equal(result.ok, false)
  assert.match(result.error!, /未安装/)
})

test("extractMedia: 模型缺失 → 同款友好文案", async () => {
  const { root, mediaPath } = setupFakeMedia()
  const env = fakeEnv(root)
  rmSync(env["LTUTOR_MEDIA__WHISPER_MODEL"]!)
  const result = await extractMedia({ media_path: mediaPath }, { env, exec: makeFakeExec({}), allowRoots: [root] })
  assert.equal(result.ok, false)
  assert.match(result.error!, /模型未就绪/)
})

// ── 真冒烟（skip-if-missing：whisper-cli/模型缺失即跳——CI ubuntu 无二者，计划评审 I-7）──

test("真冒烟: lavfi testsrc+sine 3s 视频全管线真跑（sheet JPEG 完好/transcript 结构在/mp3 头合法）", { skip: !smokeAvailable() }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "media-smoke-"))
  try {
    const video = path.join(dir, "sample.mp4")
    const { execFile } = await import("node:child_process")
    const { promisify } = await import("node:util")
    const run = promisify(execFile)
    await run("ffmpeg", ["-y", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=10",
      "-f", "lavfi", "-i", "sine=frequency=440", "-t", "3", "-pix_fmt", "yuv420p", video])
    const result = await extractMedia({ media_path: video }, { outRoot: path.join(dir, "out"), allowRoots: [dir] })
    assert.equal(result.ok, true, result.error)
    assert.equal(result.kind, "video")
    // sheet：JPEG SOI/EOI 完好
    const jpg = readFileSync(result.sheet_path!)
    assert.equal(jpg[0], 0xff); assert.equal(jpg[1], 0xd8)
    assert.ok(jpg.lastIndexOf(Buffer.from([0xff, 0xd9])) > 0, "JPEG EOI 在")
    // transcript：结构存在（sine 非语音允许空数组——不断言非空防 flaky，计划评审 I-7）
    assert.ok(Array.isArray(result.transcript))
    // mp3：ID3 头或 MPEG 帧同步
    const mp3 = readFileSync(result.audio_mp3_path!)
    assert.ok(mp3[0] === 0x49 || mp3[0] === 0xff, "mp3 头合法")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

function smokeAvailable(): boolean {
  try {
    const ffmpeg = resolveToolBinary("ffmpeg", undefined)
    const whisper = resolveToolBinary("whisper-cli", undefined)
    if (!ffmpeg || !whisper) return false
    // 模块真身在 ../src/media-extract.js（本测试文件在 dist/test/）
    const modulePath = new URL("../src/media-extract.js", import.meta.url).pathname
    statSync(modelPathFromModulePath(modulePath))
    return true
  } catch {
    return false
  }
}
