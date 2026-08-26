// tools/transcriber/__tests__/punctuation.test.ts
import { describe, it, expect, vi } from "vitest"
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  markersOf, skeletonOf, verifyPunctuated, splitChapters, chunkChapterBody,
  punctuateMd, maybePunctuate, persistPunctMd, loadPunctMd, DEFAULT_PUNCTUATE,
} from "../src/punctuation"

const MD = [
  "---",
  'title: "测试"',
  "type: transcript",
  "---",
  "",
  "## [00:00] 第一章 开场",
  "",
  "[00:00] 大家好 我是Merry 欢迎来到LT",
  "",
  "[05:00] 今天我们讲词汇教学",
  "",
  "## [10:00] 第二章 实操",
  "",
  "[10:00] 那么首先 请看这个例子 50% 的学生",
  "",
].join("\n") + "\n"

const PUNCTUATED = [
  "---",
  'title: "测试"',
  "type: transcript",
  "---",
  "",
  "## [00:00] 第一章 开场",
  "",
  "[00:00] 大家好，我是Merry，欢迎来到LT！",
  "",
  "[05:00] 今天我们讲词汇教学。",
  "",
  "## [10:00] 第二章 实操",
  "",
  "[10:00] 那么首先，请看这个例子——50% 的学生",
  "",
].join("\n") + "\n"

describe("verifyPunctuated 三重校验", () => {
  it("只加标点/分段 → 通过（英文/数字/标记原样）", () => {
    expect(verifyPunctuated(MD, PUNCTUATED)).toBe(true)
  })
  it("改字 → 拒绝", () => {
    expect(verifyPunctuated(MD, PUNCTUATED.replace("Merry", "Mary"))).toBe(false)
  })
  it("丢时间戳标记 → 拒绝", () => {
    expect(verifyPunctuated(MD, PUNCTUATED.replace("[05:00] ", ""))).toBe(false)
  })
  it("标记乱序 → 拒绝", () => {
    const swapped = PUNCTUATED.replace("[00:00]", "[09:99]").replace("[05:00]", "[00:00]").replace("[09:99]", "[05:00]")
    expect(verifyPunctuated(MD, swapped)).toBe(false)
  })
  it("删句（骨架变短）→ 拒绝；增词 → 拒绝", () => {
    expect(verifyPunctuated(MD, PUNCTUATED.replace("今天我们讲词汇教学。", ""))).toBe(false)
    expect(verifyPunctuated(MD, PUNCTUATED.replace("欢迎来到LT", "欢迎来到LT课堂"))).toBe(false)
  })
})

describe("splitChapters / chunkChapterBody", () => {
  it("frontmatter + 章块切分（章头完整保留在 header）", () => {
    const { frontmatter, chapters } = splitChapters(MD)
    expect(frontmatter).toContain('title: "测试"')
    expect(chapters).toHaveLength(2)
    expect(chapters[0].header).toBe("## [00:00] 第一章 开场")
    expect(chapters[0].body).toContain("[00:00] 大家好")
    expect(chapters[1].body).toContain("50% 的学生")
  })
  it("超长章按窗口行边界切块，每块 ≤ 上限；短章一块", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `[${String(Math.floor(i * 5)).padStart(2, "0")}:00] ${"字".repeat(99)}`)
    const chunks = chunkChapterBody(lines.join("\n"))
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(4000 + 110)
    expect(chunkChapterBody("[00:00] 短章").length).toBe(1)
  })
})

function mockFetchText(text: string) {
  return vi.fn(async () => new Response(JSON.stringify({
    choices: [{ message: { content: text } }],
  }), { status: 200 })) as unknown as typeof fetch
}

describe("punctuateMd（LLM mock）", () => {
  it("两章两块 → 逐块送 LLM、重组通过；章头/frontmatter 不送不改", async () => {
    const sent: string[] = []
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      sent.push(String(init?.body))
      const body = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] }
      const user = body.messages[1].content
      // 回显「加了标点的该块」：把每行文本尾部加句号（标记/骨架不变）
      const out = user.split("\n").map((l) => (/\[\d{1,3}:\d{2}\] /.test(l) ? `${l}。` : l)).join("\n")
      return new Response(JSON.stringify({ choices: [{ message: { content: out } }] }), { status: 200 })
    }) as unknown as typeof fetch
    const result = await punctuateMd(MD, DEFAULT_PUNCTUATE, { fetchImpl })
    expect(result).not.toBeNull()
    expect(verifyPunctuated(MD, result!)).toBe(true)
    expect(result).toContain("## [00:00] 第一章 开场")
    expect(result).toContain('title: "测试"')
    expect(sent.length).toBe(2)
  })
  it("LLM 改字 → 重试+二分兜底全部失败后整文件 null（不盲写）", async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls++
      return new Response(JSON.stringify({ choices: [{ message: { content: "[00:00] 完全不同的内容" } }] }), { status: 200 })
    }) as unknown as typeof fetch
    const sleepFn = vi.fn(async () => {})
    const result = await punctuateMd(MD, DEFAULT_PUNCTUATE, { fetchImpl, sleepFn })
    expect(result).toBeNull()
    expect(calls).toBeGreaterThanOrEqual(2) // 重试 + 二分递归（次数是实现细节）
    expect(sleepFn).toHaveBeenCalled()
  })
  it("代码围栏包裹的输出被剥离", async () => {
    const single = MD.split("## [10:00]")[0] + "\n" // 单章两行
    // 变换式 mock：对送来的 chunk（章 body）加句号后包进围栏
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] }
      const user = body.messages[1].content
      const out = user.split("\n").map((l) => (/\[\d{1,3}:\d{2}\] /.test(l) ? `${l}。` : l)).join("\n")
      return new Response(JSON.stringify({ choices: [{ message: { content: "```markdown\n" + out + "\n```" } }] }), { status: 200 })
    }) as unknown as typeof fetch
    const result = await punctuateMd(single, DEFAULT_PUNCTUATE, { fetchImpl })
    expect(result).not.toBeNull()
    expect(result).not.toContain("```")
    expect(verifyPunctuated(single, result!)).toBe(true)
  })
  it("LLM 的语义分段（空行）原样保留：段内单换行不塌缩、不升级", async () => {
    const lines = Array.from({ length: 6 }, (_, i) => `[0${i}:00] 第${i}行 内容`)
    const md = `---\ntitle: "分段"\n---\n\n## [00:00] 单章\n\n${lines.join("\n")}\n`
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] }
      const ls = body.messages[1].content.split("\n")
      // 模拟 LLM：每行尾加句号 + 第 3 行后按语义插空行
      const out = ls.flatMap((l) =>
        l === lines[2] ? [`${l}。`, ""] : /\[\d{1,3}:\d{2}\] /.test(l) ? [`${l}。`] : [l])
      return new Response(JSON.stringify({ choices: [{ message: { content: out.join("\n") } }] }), { status: 200 })
    }) as unknown as typeof fetch
    const result = await punctuateMd(md, DEFAULT_PUNCTUATE, { fetchImpl })
    expect(result).not.toBeNull()
    expect(verifyPunctuated(md, result!)).toBe(true)
    expect(result).toContain("第2行 内容。\n\n[03:00]")  // 空行分段保留
    expect(result).toContain("第0行 内容。\n[01:00]")   // 段内单换行保持（不升级为空行）
  })
  it("段落门：长块未分段 → 重试；两次都未分段但校验通过 → 接受不二分", async () => {
    const lines = Array.from({ length: 6 }, (_, i) => `[0${i}:00] 第${i}行 内容`)
    const md = `---\ntitle: "分段"\n---\n\n## [00:00] 单章\n\n${lines.join("\n")}\n`
    let calls = 0
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      calls++
      const body = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] }
      const out = body.messages[1].content.split("\n").map((l) => (/\[\d{1,3}:\d{2}\] /.test(l) ? `${l}。` : l)).join("\n")
      return new Response(JSON.stringify({ choices: [{ message: { content: out } }] }), { status: 200 })
    }) as unknown as typeof fetch
    const result = await punctuateMd(md, DEFAULT_PUNCTUATE, { fetchImpl, sleepFn: async () => {} })
    expect(result).not.toBeNull()
    expect(verifyPunctuated(md, result!)).toBe(true)
    expect(calls).toBe(2) // 两次尝试后接受（进入二分会产生更多调用）
    // 接受的就是未分段产物本身（正文内无空行）
    expect(result!.split("## [00:00] 单章\n")[1] ?? "").not.toContain("\n\n")
  })
  it("密度门：≥400 字块偷懒回显（骨架校验通过但零标点）→ 重试一次仍懒判失败，不进二分", async () => {
    const lines = Array.from({ length: 8 }, (_, i) => `[0${i}:00] ${"语料".repeat(28)}`)
    const md = `---\ntitle: "偷懒"\n---\n\n## [00:00] 单章\n\n${lines.join("\n")}\n`
    let calls = 0
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      calls++
      const body = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] }
      // 原样回显：骨架校验必然通过（零增删改），但一个标点都没加
      return new Response(JSON.stringify({ choices: [{ message: { content: body.messages[1].content } }] }), { status: 200 })
    }) as unknown as typeof fetch
    const result = await punctuateMd(md, DEFAULT_PUNCTUATE, { fetchImpl, sleepFn: async () => {} })
    expect(result).toBeNull()
    expect(calls).toBe(8) // 偷懒块预算 8 枪（后 7 枪带 nudge），耗尽判失败不进二分
  })
  it("密度门：首答偷懒 → 重试带强化指令且采纳重答（不误杀整个文件）", async () => {
    const lines = Array.from({ length: 8 }, (_, i) => `[0${i}:00] ${"语料".repeat(28)}`)
    const md = `---\ntitle: "偷懒"\n---\n\n## [00:00] 单章\n\n${lines.join("\n")}\n`
    let calls = 0
    let nudged = false
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      calls++
      const body = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] }
      const user = body.messages[1].content
      if (calls === 1) {
        expect(user).not.toContain("重试指令") // 首答不带 nudge
        return new Response(JSON.stringify({ choices: [{ message: { content: user } }] }), { status: 200 })
      }
      // 重答：请求应带强化指令；mock 剥掉指令尾巴后对正文加纯标点
      expect(user).toContain("重试指令")
      nudged = true
      const core = user.split("\n\n［重试指令")[0]
      const out = core.split("\n").map((l) => (/\[\d{1,3}:\d{2}\] /.test(l) ? `${l}，。` : l)).join("\n\n")
      return new Response(JSON.stringify({ choices: [{ message: { content: out } }] }), { status: 200 })
    }) as unknown as typeof fetch
    const result = await punctuateMd(md, DEFAULT_PUNCTUATE, { fetchImpl, sleepFn: async () => {} })
    expect(result).not.toBeNull()
    expect(calls).toBe(2)
    expect(nudged).toBe(true)
    expect(result).toContain("，。")
  })
  it("传输错误（5xx）重试一次后文件级快速失败——不进二分", async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls++
      return new Response("{}", { status: 500 })
    }) as unknown as typeof fetch
    const result = await punctuateMd(MD, DEFAULT_PUNCTUATE, { fetchImpl, sleepFn: async () => {} })
    expect(result).toBeNull()
    expect(calls).toBe(2) // 两尝试即中止，不递归二分烧调用
  })
  it("429 限流指数退避（5s/10s）后成功——不消耗常规尝试、不进二分", async () => {
    let calls = 0
    const sleeps: number[] = []
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      calls++
      if (calls <= 2) return new Response("rate limited", { status: 429 })
      const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] }
      const out = body.messages[1].content.split("\n").map((l) => (/\[\d{1,3}:\d{2}\] /.test(l) ? `${l}。` : l)).join("\n")
      return new Response(JSON.stringify({ choices: [{ message: { content: out } }] }), { status: 200 })
    }) as unknown as typeof fetch
    const result = await punctuateMd(MD, DEFAULT_PUNCTUATE, {
      fetchImpl,
      sleepFn: async (ms) => { sleeps.push(ms) },
    })
    expect(result).not.toBeNull()
    expect(verifyPunctuated(MD, result!)).toBe(true)
    expect(sleeps.slice(0, 2)).toEqual([5000, 10000])
    expect(calls).toBe(4) // 2×429 退避 + 两章各 1 次成功
  })
  it("字符级二分：单行超长块 verify 恒败 → 递归切半，碎片 <200 字放弃 → 整文件 null", async () => {
    const words = Array.from({ length: 60 }, (_, i) => `词组${i}`)
    const longLine = `[00:00] ${words.join(" ")}` // ~300 字（≥200 才走字符二分）
    const md = `---\ntitle: "x"\n---\n\n## [00:00] 单章\n\n${longLine}\n`
    let calls = 0
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      calls++
      const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] }
      // 恒增字 → verify 必败（驱动二分树走到底）
      return new Response(JSON.stringify({ choices: [{ message: { content: `${body.messages[1].content}多余` } }] }), { status: 200 })
    }) as unknown as typeof fetch
    const result = await punctuateMd(md, DEFAULT_PUNCTUATE, { fetchImpl, sleepFn: async () => {} })
    expect(result).toBeNull()
    // 根块 2 次 + 左半块 2 次（<200 字碎片放弃）；右半因左半 null 短路不再调用
    expect(calls).toBe(4)
  })
})

describe("快照幂等（maybePunctuate）", () => {
  it("快照存在 → 字节回用不调 LLM；成功后落快照；失败回落原文", async () => {
    const dir = mkdtempSync(join(tmpdir(), "punct-test-"))
    try {
      // 失败回落：无快照 + LLM 挂 → 原文
      const bad = vi.fn(async () => new Response("{}", { status: 500 })) as unknown as typeof fetch
      const out1 = await maybePunctuate({ md: MD, slug: "s1", outDir: dir, cfg: { enabled: true }, deps: { fetchImpl: bad, sleepFn: async () => {} } })
      expect(out1).toBe(MD)
      // 成功路径：回声加标点 → 快照落盘
      const echo = (async (_u: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] }
        const user = body.messages[1].content
        const out = user.split("\n").map((l) => (/\[\d{1,3}:\d{2}\] /.test(l) ? `${l}。` : l)).join("\n")
        return new Response(JSON.stringify({ choices: [{ message: { content: out } }] }), { status: 200 })
      }) as unknown as typeof fetch
      const out2 = await maybePunctuate({ md: MD, slug: "s2", outDir: dir, cfg: { enabled: true }, deps: { fetchImpl: echo } })
      expect(verifyPunctuated(MD, out2)).toBe(true)
      expect(loadPunctMd(dir, "s2")).toBe(out2)
      // 快照命中：LLM 永不被调（mock 抛错证明）
      const boom = (async () => { throw new Error("不应被调用") }) as unknown as typeof fetch
      const out3 = await maybePunctuate({ md: MD, slug: "s2", outDir: dir, cfg: { enabled: true }, deps: { fetchImpl: boom } })
      expect(out3).toBe(out2)
      // 快照与当前正文不一致（同 slug 不同 md：重转写/重切章）→ 按 miss
      // 重新标点并覆盖快照（不把陈旧文本写回）
      const altered = MD.replace("词汇教学", "语法教学")
      const out5 = await maybePunctuate({ md: altered, slug: "s2", outDir: dir, cfg: { enabled: true }, deps: { fetchImpl: echo } })
      expect(verifyPunctuated(altered, out5)).toBe(true)
      expect(out5).not.toBe(out2)
      expect(loadPunctMd(dir, "s2")).toBe(out5)
      // 未启用 → 原文
      const out4 = await maybePunctuate({ md: MD, slug: "s3", outDir: dir })
      expect(out4).toBe(MD)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it("persistPunctMd/loadPunctMd 往返", () => {
    const dir = mkdtempSync(join(tmpdir(), "punct-snap-"))
    try {
      persistPunctMd(dir, "x", "内容\n")
      expect(readFileSync(join(dir, "punct", "x.md"), "utf-8")).toBe("内容\n")
      expect(loadPunctMd(dir, "x")).toBe("内容\n")
      expect(loadPunctMd(dir, "missing")).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
