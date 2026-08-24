// tools/transcriber/__tests__/chaptering.test.ts
// 语义切章单元测试：解析守门（首章=0/递增/全覆盖/字符串化 JSON）、守门规则、
// md 结构（frontmatter 同构/章头/章内 300s 行）、LLM 失败回落（fetch 注入，零网络）。
import { describe, it, expect, vi, beforeEach } from "vitest"
import type { Segment } from "../src/whisper"
import type { TranscriptInput } from "../src/transcript"
import { buildTranscriptMd } from "../src/transcript"
import {
  DEFAULT_CHAPTERING,
  parseCuts,
  guardrailReason,
  chaptersFor,
  buildSemanticMd,
  trySemanticChapters,
  llmChapter,
  type LlmChapterDeps,
} from "../src/chaptering"

const seg = (startS: number, text: string): Segment => ({ startS, endS: startS + 3, text })
// 10 个 segment，每 60s 一个（覆盖 ~10min）
const segs10: Segment[] = Array.from({ length: 10 }, (_, i) => seg(i * 60, `第${i}句内容`))

const input = (segments: Segment[], durationS = 600): TranscriptInput => ({
  title: "测试视频",
  segments,
  sourcePath: "sources/transcripts/x.md",
  mediaSlug: "x",
  durationS,
})

function okResponse(content: string) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })
}

describe("parseCuts", () => {
  it("合法切分：首章 0、递增", () => {
    const cuts = parseCuts('{"chapters":[{"start_idx":0,"title":"导入"},{"start_idx":5,"title":"正题"}]}', 10)
    expect(cuts).toEqual([{ startIdx: 0, title: "导入" }, { startIdx: 5, title: "正题" }])
  })

  it("glm 字符串化 JSON（content 首尾带引号、内部转义）也能抓到内层对象", () => {
    const raw = '"{\\"chapters\\":[{\\"start_idx\\":0,\\"title\\":\\"导入\\"}]}"'
    expect(parseCuts(raw, 10)).toEqual([{ startIdx: 0, title: "导入" }])
  })

  it("拒绝：首章非 0 / 重复边界 / 越界 / 缺标题 / 非 JSON", () => {
    expect(parseCuts('{"chapters":[{"start_idx":2,"title":"a"}]}', 10)).toBeNull()
    expect(parseCuts('{"chapters":[{"start_idx":0,"title":"a"},{"start_idx":0,"title":"b"}]}', 10)).toBeNull()
    expect(parseCuts('{"chapters":[{"start_idx":0,"title":"a"},{"start_idx":10,"title":"b"}]}', 10)).toBeNull()
    expect(parseCuts('{"chapters":[{"start_idx":0}]}', 10)).toBeNull()
    expect(parseCuts("前置说明 {\"chapters\":[]} 后缀", 10)).toBeNull()
  })
})

describe("guardrailReason", () => {
  it("≥10min 仅 1 章 → 回落", () => {
    expect(guardrailReason([{ startIdx: 0, title: "a" }], segs10, 600)).toMatch(/仅 1 章/)
  })
  it("<10min 仅 1 章 → 放行（短视频合法）", () => {
    expect(guardrailReason([{ startIdx: 0, title: "a" }], segs10.slice(0, 5), 300)).toBeNull()
  })
  it("单章 >45min → 回落", () => {
    const long: Segment[] = Array.from({ length: 50 }, (_, i) => seg(i * 60, `s${i}`))
    expect(guardrailReason([{ startIdx: 0, title: "a" }, { startIdx: 46, title: "b" }], long, 3000)).toMatch(/单章/)
  })
})

describe("buildSemanticMd / chaptersFor", () => {
  const cuts = [{ startIdx: 0, title: "导入" }, { startIdx: 5, title: "正题" }]

  it("frontmatter 与机械切分逐字节同构", () => {
    const fmOf = (md: string) => md.split("---\n")[1]
    expect(fmOf(buildSemanticMd(input(segs10), cuts))).toBe(fmOf(buildTranscriptMd(input(segs10)).md))
  })

  it("章头 `## [mm:ss] 标题` 数量与切分一致；章内保留 300s 窗口行", () => {
    const md = buildSemanticMd(input(segs10), cuts)
    const heads = md.split("\n").filter((l) => l.startsWith("## "))
    expect(heads).toEqual(["## [00:00] 导入", "## [05:00] 正题"])
    // 每章各含一个 [mm:ss] 正文行（本 fixture 每章 5 分钟 < 300s 窗口 → 各 1 行）
    expect(md.match(/^\[\d{2}:\d{2}\] /gm)).toHaveLength(2)
  })

  it("chaptersFor 取章内首/末 segment 实际时刻", () => {
    expect(chaptersFor(segs10, cuts)).toEqual([
      { start_s: 0, end_s: 4 * 60 + 3, label: "导入" },
      { start_s: 5 * 60, end_s: 9 * 60 + 3, label: "正题" },
    ])
  })
})

describe("llmChapter / trySemanticChapters（fetch 注入）", () => {
  const depsOf = (impl: typeof fetch, apiKey = "k"): LlmChapterDeps => ({ fetchImpl: impl, apiKey, sleepFn: async () => {} })

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
  })

  it("成功路径 + thinking 400 降级重试", async () => {
    let calls = 0
    const impl = (async (_url: unknown, init?: RequestInit) => {
      calls++
      const body = JSON.parse(String(init?.body))
      if (calls === 1) return new Response('{"error":{"message":"thinking param not allowed"}}', { status: 400 })
      expect(body.thinking).toBeUndefined() // 降级重试不再带 thinking
      return okResponse('{"chapters":[{"start_idx":0,"title":"全片"}]}')
    }) as unknown as typeof fetch
    const cuts = await llmChapter("t", segs10.slice(0, 5), DEFAULT_CHAPTERING, depsOf(impl))
    expect(cuts).toEqual([{ startIdx: 0, title: "全片" }])
    expect(calls).toBe(2)
  })

  it("解析失败重试一次后成功", async () => {
    let calls = 0
    const impl = (async () => {
      calls++
      return okResponse(calls === 1 ? "垃圾输出" : '{"chapters":[{"start_idx":0,"title":"a"}]}')
    }) as unknown as typeof fetch
    expect(await llmChapter("t", segs10.slice(0, 5), DEFAULT_CHAPTERING, depsOf(impl))).toEqual([{ startIdx: 0, title: "a" }])
    expect(calls).toBe(2)
  })

  it("两次全败 → trySemanticChapters 返回 null（回落，不抛出）", async () => {
    const impl = (async () => new Response("boom", { status: 502 })) as unknown as typeof fetch
    const cfg = { ...DEFAULT_CHAPTERING, enabled: true }
    expect(await trySemanticChapters({ title: "t", segments: segs10, durationS: 600 }, cfg, depsOf(impl))).toBeNull()
  })

  it("守门触发 → null", async () => {
    const impl = (async () => okResponse('{"chapters":[{"start_idx":0,"title":"唯一"}]}')) as unknown as typeof fetch
    const cfg = { ...DEFAULT_CHAPTERING, enabled: true }
    expect(await trySemanticChapters({ title: "t", segments: segs10, durationS: 900 }, cfg, depsOf(impl))).toBeNull()
  })

  it("enabled=false → 不调 LLM 直接 null", async () => {
    const impl = vi.fn() as unknown as typeof fetch
    expect(await trySemanticChapters({ title: "t", segments: segs10, durationS: 600 }, DEFAULT_CHAPTERING, depsOf(impl))).toBeNull()
    expect(impl).not.toHaveBeenCalled()
  })
})
