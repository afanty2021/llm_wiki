import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  exportOkfBundle,
  classifyFrontmatter,
  normalizeLogContent,
  convertConcept,
  convertBundleRootIndex,
  convertSubdirIndex,
  deriveTimestamp,
} from "./okf-export"
import { buildSlugIndex } from "./okf-convert"

const PAGE = (fm: string, body: string) => `---\n${fm}\n---\n\n${body}`

// ──────────────────────────────────────────────────────────────────
// classifyFrontmatter — §4.0 四分支判断
// ──────────────────────────────────────────────────────────────────
describe("classifyFrontmatter", () => {
  it("normal: --- 在文件首字符", () => {
    expect(classifyFrontmatter(PAGE("type: concept", "body"))).toBe("normal")
  })

  it("leading-blank: 前导空行后才出现 ---", () => {
    expect(classifyFrontmatter("\n\n---\ntype: concept\n---\nbody")).toBe("leading-blank")
  })

  it("missing-fence: 首行是 key:value，无 --- 围栏", () => {
    expect(classifyFrontmatter("type: concept\ntitle: Foo\n---\nbody")).toBe("missing-fence")
  })

  it("truly-none: 无 frontmatter 内容，首行非 key:value", () => {
    expect(classifyFrontmatter("# Just a title\n\nbody")).toBe("truly-none")
  })
})

// ──────────────────────────────────────────────────────────────────
// convertBundleRootIndex — 剥离 fm，重写为仅 okf_version
// ──────────────────────────────────────────────────────────────────
describe("convertBundleRootIndex", () => {
  it("strips original fm and rewrites to okf_version only, preserving body", () => {
    const input = PAGE("type: index\ntitle: 维基索引\ntags: []", "# 维基索引\n\n- [[foo]]")
    const out = convertBundleRootIndex(input)
    expect(out.startsWith('---\nokf_version: "0.1"\n---\n')).toBe(true)
    // body preserved (frontmatter stripped, body kept)
    expect(out).toContain("# 维基索引")
    expect(out).toContain("[[foo]]")
    expect(out).not.toContain("type: index")
    expect(out).not.toContain("维基索引\n---") // 原标题区不混入
  })

  it("handles index.md with no frontmatter at all", () => {
    const input = "# Just a body\n\nsome text"
    const out = convertBundleRootIndex(input)
    expect(out.startsWith('---\nokf_version: "0.1"\n---\n')).toBe(true)
    expect(out).toContain("# Just a body")
  })
})

// ──────────────────────────────────────────────────────────────────
// convertSubdirIndex — 剥离全部 frontmatter，仅留 body
// ──────────────────────────────────────────────────────────────────
describe("convertSubdirIndex", () => {
  it("strips all frontmatter, keeps body only", () => {
    const input = PAGE("type: index\ntitle: 子目录索引", "# Subsection\n\n- [[a]]")
    const out = convertSubdirIndex(input)
    expect(out).not.toContain("---")
    expect(out).not.toContain("type:")
    expect(out).toContain("# Subsection")
    expect(out).toContain("[[a]]")
  })

  it("passes through body when no frontmatter", () => {
    const input = "# Body only"
    expect(convertSubdirIndex(input)).toBe("# Body only")
  })
})

// ──────────────────────────────────────────────────────────────────
// normalizeLogContent — §7 date heading
// ──────────────────────────────────────────────────────────────────
describe("normalizeLogContent", () => {
  it("[DATE] action | detail → ## DATE + injected prose", () => {
    const out = normalizeLogContent("## [2026-05-19] delete | 9 source files\n")
    expect(out).toContain("## 2026-05-19")
    expect(out).toContain("- **Delete**: 9 source files")
    expect(out).not.toContain("[2026-05-19]")
  })

  it("DATE action | detail → ## DATE + injected prose", () => {
    const out = normalizeLogContent("## 2026-05-19 ingest | 标题文字\n")
    expect(out).toContain("## 2026-05-19\n\n- **Ingest**: 标题文字")
  })

  it("DATE || action | detail (双竖线) → 取第一个非日期 token 作 action", () => {
    const out = normalizeLogContent("## 2026-05-19 | ingest | 文字\n")
    expect(out).toContain("## 2026-05-19\n\n- **Ingest**: 文字")
  })

  it("pure YYYY-MM-DD heading → unchanged", () => {
    const input = "## 2026-05-19\n\n- Project created\n"
    expect(normalizeLogContent(input)).toBe(input)
  })

  it("capitalizes action token (delete→Delete, Creation→Creation)", () => {
    expect(normalizeLogContent("## 2026-05-19 delete | x\n")).toContain("- **Delete**: x")
    expect(normalizeLogContent("## 2026-05-19 Creation | x\n")).toContain("- **Creation**: x")
  })

  it("multi-word action (external delete) → capitalized", () => {
    const out = normalizeLogContent("## 2026-05-19 external delete | foo\n")
    expect(out).toContain("- **External delete**: foo")
  })

  it("guarantees non-empty body under each normalized heading", () => {
    const out = normalizeLogContent("## [2026-05-19] ingest | 标题\n")
    const lines = out.split(/\r?\n/)
    const idx = lines.findIndex((l) => /^## 2026-05-19\s*$/.test(l))
    // 下一非空行应存在且非空
    const after = lines.slice(idx + 1).filter((l) => l.trim() !== "")
    expect(after.length).toBeGreaterThan(0)
  })

  it("preserves pre-existing body lines after normalized heading", () => {
    const input = "## [2026-05-19] ingest | title\n\n- 摄入内容\n"
    const out = normalizeLogContent(input)
    expect(out).toContain("## 2026-05-19")
    expect(out).toContain("- **Ingest**: title")
    expect(out).toContain("- 摄入内容")
  })
})

// ──────────────────────────────────────────────────────────────────
// deriveTimestamp — 日期精度，无 T/Z
// ──────────────────────────────────────────────────────────────────
describe("deriveTimestamp", () => {
  it("uses existing updated field (YYYY-MM-DD, no T/Z)", () => {
    const ts = deriveTimestamp(PAGE("type: concept\nupdated: 2026-05-19\ncreated: 2026-04-01", "b"), new Date("2026-06-01"))
    expect(ts).toBe("2026-05-19")
    expect(ts).not.toContain("T")
    expect(ts).not.toContain("Z")
  })

  it("falls back to created when no updated", () => {
    expect(deriveTimestamp(PAGE("type: concept\ncreated: 2026-04-01", "b"), new Date())).toBe("2026-04-01")
  })

  it("falls back to mtime YYYY-MM-DD when no fm dates", () => {
    const ts = deriveTimestamp("# no fm dates here", new Date("2026-06-15T12:00:00Z"))
    expect(ts).toBe("2026-06-15")
  })
})

// ──────────────────────────────────────────────────────────────────
// convertConcept — 四分支 + timestamp 注入
// ──────────────────────────────────────────────────────────────────
describe("convertConcept", () => {
  it("normal: keeps fm structure, adds timestamp if missing", () => {
    const out = convertConcept(
      PAGE("type: concept\ntitle: Foo\nupdated: 2026-05-19", "body"),
      "foo.md",
      new Date("2026-06-01"),
      [],
    )
    expect(out).toMatch(/^---\ntype: concept/)
    expect(out).toContain("timestamp: 2026-05-19")
    expect(out).toContain("title: Foo")
    expect(out).toContain("updated: 2026-05-19")
  })

  it("normal: preserves existing timestamp", () => {
    const out = convertConcept(
      PAGE("type: concept\ntimestamp: 2020-01-01", "b"),
      "foo.md",
      new Date(),
      [],
    )
    expect(out).toContain("timestamp: 2020-01-01")
    // 不重复注入
    expect(out.match(/timestamp:/g)?.length).toBe(1)
  })

  it("leading-blank: strips leading blank lines so --- is first char", () => {
    const out = convertConcept(
      "\n\n---\ntype: concept\ntitle: Wikilink\n---\n# body",
      "wikilink.md",
      new Date("2026-06-01"),
      [],
    )
    expect(out.startsWith("---\n")).toBe(true)
    expect(out).not.toMatch(/^\n/)
    expect(out).toContain("type: concept")
  })

  it("missing-fence: prepends opening --- without creating double ---", () => {
    // 现实样本: type: concept\ntitle:...\n---\n  (只有闭合 ---，缺开头)
    const out = convertConcept(
      "type: concept\ntitle: 四股绳\n---\n# 四股绳",
      "四股绳.md",
      new Date("2026-06-01"),
      [],
    )
    // 文件应以单个 --- 开头
    expect(out.startsWith("---\n")).toBe(true)
    // 不能出现连续两个 --- (双围栏错误)
    expect(out.match(/^---\n---/m)).toBeNull()
    expect(out).toContain("type: concept")
    expect(out).toContain("title: 四股绳")
    expect(out).toContain("# 四股绳")
  })

  // ── 防御性: missing-fence 无闭合围栏不能吞 body ─────────────
  it("missing-fence WITHOUT closing ---: falls back to truly-none so body is not swallowed into frontmatter", () => {
    // 无任何 --- 行；首行是 key:value；后跟 body。
    // 旧实现会把 "type: concept\ntitle: Foo\nsome body line\nanother line"
    // 全部当作 fm payload 包进 ---\n...\n---，YAML 解析失败 + body 丢失。
    const input = "type: concept\ntitle: Foo\nsome body line\nanother line"
    const warnings: string[] = []
    const out = convertConcept(input, "nofence.md", new Date("2026-06-01"), warnings)

    // 1. 输出必须有合规的严格围栏：--- 在首字符，且存在闭合 ---
    expect(out.startsWith("---\n")).toBe(true)
    // frontmatter 块（首个 --- 到闭合 ---）必须存在且非空
    const fmMatch = out.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
    expect(fmMatch).not.toBeNull()
    const [, fmPayload, body] = fmMatch!

    // 2. frontmatter 内有非空 type 字段（truly-none 注入的 type: concept）
    expect(fmPayload).toMatch(/^type:\s*\S/m)

    // 3. 关键验收：body 行出现在闭合 --- 之后，绝不被吞进 frontmatter
    expect(body).toContain("some body line")
    expect(body).toContain("another line")
    expect(fmPayload).not.toContain("some body line")
    expect(fmPayload).not.toContain("another line")

    // 4. 应记录 warning（转走 truly-none 兜底）
    expect(warnings.some((w) => w.includes("nofence.md") || w.includes("truly-none"))).toBe(true)

    // 5. validator 视角：有 timestamp（truly-none 注入）
    expect(out).toMatch(/timestamp: \d{4}-\d{2}-\d{2}/)
  })

  it("truly-none: injects minimal fm, records warning", () => {
    const warnings: string[] = []
    const out = convertConcept("# Just a heading\n\nbody text", "foo.md", new Date("2026-06-01"), warnings)
    expect(out.startsWith("---\n")).toBe(true)
    expect(out).toContain("type: concept")
    expect(out).toContain("title: Just a heading")
    expect(out).toContain("timestamp: 2026-06-01")
    expect(out).toContain("# Just a heading")
    expect(warnings.length).toBeGreaterThan(0)
    expect(warnings.some((w) => w.includes("truly-none") || w.includes("foo.md"))).toBe(true)
  })

  it("truly-none: uses basename (no .md) when no heading", () => {
    const out = convertConcept("just prose no heading", "my-concept.md", new Date("2026-06-01"), [])
    expect(out).toContain("title: my-concept")
  })

  it("preserves sources[], related[], tags as-is", () => {
    const input = PAGE(
      'type: concept\ntitle: Foo\ntags: [a, b]\nrelated: [x, y]\nsources: ["doc.pdf"]',
      "body",
    )
    const out = convertConcept(input, "foo.md", new Date("2026-06-01"), [])
    expect(out).toContain("tags: [a, b]")
    expect(out).toContain("related: [x, y]")
    expect(out).toContain('sources: ["doc.pdf"]')
  })

  it("does NOT implement wikilink double-write (body copied verbatim)", () => {
    const out = convertConcept(
      PAGE("type: concept\ntitle: Foo", "See [[bar]] here."),
      "foo.md",
      new Date("2026-06-01"),
      [],
    )
    // body 原样，不应追加了 markdown link
    expect(out).toContain("See [[bar]] here.")
  })
})

// ──────────────────────────────────────────────────────────────────
// exportOkfBundle — 端到端
// ──────────────────────────────────────────────────────────────────
describe("exportOkfBundle (end-to-end)", () => {
  let wikiDir: string
  let outDir: string

  beforeEach(() => {
    wikiDir = mkdtempSync(join(tmpdir(), "okf-wiki-"))
    outDir = mkdtempSync(join(tmpdir(), "okf-out-"))
  })
  afterEach(() => {
    rmSync(wikiDir, { recursive: true, force: true })
    rmSync(outDir, { recursive: true, force: true })
  })

  it("converts a mixed bundle and preserves subdir structure", async () => {
    mkdirSync(join(wikiDir, "concepts"), { recursive: true })
    mkdirSync(join(wikiDir, "entities"), { recursive: true })
    writeFileSync(join(wikiDir, "index.md"), PAGE("type: index\ntitle: 索引", "# Index\n\n- [[foo]]"))
    writeFileSync(join(wikiDir, "log.md"), "# Research Log\n\n## [2026-05-19] ingest | title\n\n- body\n")
    writeFileSync(join(wikiDir, "overview.md"), PAGE("type: overview\ntitle: 概述\nupdated: 2026-05-19", "# 概述"))
    writeFileSync(join(wikiDir, "concepts", "academic.md"), PAGE("type: concept\ntitle: Academic\nupdated: 2026-05-19", "# Academic"))
    writeFileSync(join(wikiDir, "concepts", "wikilink.md"), "\n\n---\ntype: concept\ntitle: Wikilink\n---\n# W")
    writeFileSync(join(wikiDir, "entities", "person.md"), PAGE("type: entity\ntitle: Person", "# Person"))

    const report = await exportOkfBundle(wikiDir, outDir)

    expect(report.written).toBe(6)
    expect(report.concepts).toBe(4) // overview + 2 concepts + 1 entity
    expect(report.reserved).toBe(2) // index.md + log.md
    expect(report.warnings.length).toBe(0)

    // bundle-root index.md → okf_version only
    const rootIndex = readFileSync(join(outDir, "index.md"), "utf8")
    expect(rootIndex.startsWith('---\nokf_version: "0.1"\n---\n')).toBe(true)
    expect(rootIndex).toContain("# Index")
    expect(rootIndex).not.toContain("type: index")

    // log.md heading normalized
    const log = readFileSync(join(outDir, "log.md"), "utf8")
    expect(log).toContain("## 2026-05-19")
    expect(log).not.toContain("[2026-05-19]")

    // subdir concept keeps structure
    const concept = readFileSync(join(outDir, "concepts", "academic.md"), "utf8")
    expect(concept.startsWith("---\ntype: concept")).toBe(true)
    expect(concept).toContain("timestamp: 2026-05-19")

    // leading-blank fixed
    const wl = readFileSync(join(outDir, "concepts", "wikilink.md"), "utf8")
    expect(wl.startsWith("---\n")).toBe(true)
    expect(wl).not.toMatch(/^\n/)

    // entity concept gets timestamp (from mtime)
    const ent = readFileSync(join(outDir, "entities", "person.md"), "utf8")
    expect(ent).toContain("timestamp:")
  })

  it("does not modify source wiki files", async () => {
    mkdirSync(join(wikiDir, "concepts"), { recursive: true })
    const srcPath = join(wikiDir, "concepts", "foo.md")
    const orig = "\n\n---\ntype: concept\ntitle: Foo\n---\n# Foo"
    writeFileSync(srcPath, orig)
    await exportOkfBundle(wikiDir, outDir)
    expect(readFileSync(srcPath, "utf8")).toBe(orig)
  })

  it("handles subdir index.md by stripping frontmatter", async () => {
    mkdirSync(join(wikiDir, "concepts"), { recursive: true })
    writeFileSync(join(wikiDir, "concepts", "index.md"), PAGE("type: index\ntitle: Sub", "# Sub idx"))
    const report = await exportOkfBundle(wikiDir, outDir)
    // subdir index.md: reserved name, not counted as concept
    const out = readFileSync(join(outDir, "concepts", "index.md"), "utf8")
    expect(out).not.toContain("---")
    expect(out).toContain("# Sub idx")
    // 计数：concepts/index.md 是 reserved，不是 concept
    expect(report.reserved).toBeGreaterThanOrEqual(1)
  })

  it("returns empty report for empty wiki dir", async () => {
    const report = await exportOkfBundle(wikiDir, outDir)
    expect(report.written).toBe(0)
    expect(report.concepts).toBe(0)
    expect(report.reserved).toBe(0)
  })

  // ── I3: UTF-8 BOM strip ──────────────────────────────────────
  it("strips UTF-8 BOM before classify so BOM file is treated as normal (not truly-none)", async () => {
    const BOM = "﻿"
    // BOM + 正常 frontmatter
    const bomContent = `${BOM}---\ntype: concept\ntitle: BomTitle\nupdated: 2026-05-19\n---\n\n# Body`
    writeFileSync(join(wikiDir, "bom.md"), bomContent)

    const report = await exportOkfBundle(wikiDir, outDir)

    // 关键: 不应触发 truly-none 兜底（无 warning 含 "bom.md" / "truly-none"）
    expect(report.warnings.some((w) => w.includes("bom.md") || w.includes("truly-none"))).toBe(false)
    const out = readFileSync(join(outDir, "bom.md"), "utf8")
    // 首字符必须是 `-`（BOM 已 strip，文件首行即 ---）
    expect(out.startsWith("---\n")).toBe(true)
    expect(out.codePointAt(0)).toBe(0x2d) // '-'
    expect(out).toContain("type: concept")
    expect(out).toContain("title: BomTitle")
    expect(out).toContain("timestamp: 2026-05-19")
    expect(out).toContain("# Body")
  })

  // ── I1: outDir-in-wikiDir 防护 ───────────────────────────────
  it("throws when outDir equals wikiDir", async () => {
    await expect(exportOkfBundle(wikiDir, wikiDir)).rejects.toThrow(/不能等于 wikiDir/)
  })

  it("throws when outDir is a subdir of wikiDir", async () => {
    const insideOut = join(wikiDir, "sub", "out")
    await expect(exportOkfBundle(wikiDir, insideOut)).rejects.toThrow(/不能位于 wikiDir 子目录内/)
  })

  // ── I4: 真实场景补充 ─────────────────────────────────────────
  it("handles CRLF frontmatter correctly", async () => {
    const crlf = "---\r\ntype: concept\r\ntitle: CrlfTitle\r\nupdated: 2026-05-19\r\n---\r\n\r\n# Body\r\n"
    writeFileSync(join(wikiDir, "crlf.md"), crlf)
    const report = await exportOkfBundle(wikiDir, outDir)
    expect(report.warnings.length).toBe(0)
    const out = readFileSync(join(outDir, "crlf.md"), "utf8")
    expect(out).toContain("type: concept")
    expect(out).toContain("title: CrlfTitle")
    expect(out).toContain("timestamp: 2026-05-19")
  })

  it("normalizes CRLF log.md headings without losing content", async () => {
    const crlfLog = "# Research Log\r\n\r\n## [2026-05-19] ingest | title\r\n\r\n- body\r\n"
    writeFileSync(join(wikiDir, "log.md"), crlfLog)
    await exportOkfBundle(wikiDir, outDir)
    const out = readFileSync(join(outDir, "log.md"), "utf8")
    expect(out).toContain("## 2026-05-19")
    expect(out).toContain("- **Ingest**: title")
    expect(out).not.toContain("[2026-05-19]")
  })

  it("classifies empty frontmatter (---\\n---\\nbody) as normal with mtime timestamp fallback", async () => {
    const emptyFm = "---\n---\n\n# Empty fm body"
    writeFileSync(join(wikiDir, "empty.md"), emptyFm)
    const report = await exportOkfBundle(wikiDir, outDir)
    expect(report.warnings.some((w) => w.includes("empty.md") || w.includes("truly-none"))).toBe(false)
    const out = readFileSync(join(outDir, "empty.md"), "utf8")
    expect(out.startsWith("---\n")).toBe(true)
    // 空 fm 后注入 timestamp（值来自 mtime，YYYY-MM-DD 格式）
    expect(out).toMatch(/timestamp: \d{4}-\d{2}-\d{2}/)
    expect(out).toContain("# Empty fm body")
  })

  it("end-to-end CJK filename + path with spaces (walkMarkdown path join)", async () => {
    mkdirSync(join(wikiDir, "词汇"), { recursive: true })
    // CJK 文件名
    writeFileSync(join(wikiDir, "四股绳.md"), "---\ntype: concept\ntitle: 四股绳\nupdated: 2026-05-19\n---\n\n# 四股绳")
    // 路径含空格
    writeFileSync(join(wikiDir, "听写 (Dictation).md"), "---\ntype: concept\ntitle: 听写\n---\n\n# 听写")
    // CJK 目录 + CJK 文件名（混合）
    writeFileSync(join(wikiDir, "词汇", "语义.md"), "---\ntype: concept\ntitle: 语义\n---\n\n# 语义")

    const report = await exportOkfBundle(wikiDir, outDir)

    expect(report.written).toBe(3)
    expect(report.concepts).toBe(3)
    expect(report.warnings.length).toBe(0)

    const a = readFileSync(join(outDir, "四股绳.md"), "utf8")
    expect(a).toContain("title: 四股绳")
    expect(a).toContain("timestamp: 2026-05-19")
    expect(a).toContain("# 四股绳")

    const b = readFileSync(join(outDir, "听写 (Dictation).md"), "utf8")
    expect(b).toContain("title: 听写")
    expect(b).toMatch(/timestamp: \d{4}-\d{2}-\d{2}/)
    expect(b).toContain("# 听写")

    const c = readFileSync(join(outDir, "词汇", "语义.md"), "utf8")
    expect(c).toContain("title: 语义")
    expect(c).toMatch(/timestamp: \d{4}-\d{2}-\d{2}/)
    expect(c).toContain("# 语义")
  })
})

// ──────────────────────────────────────────────────────────────────
// buildSlugIndex — §3 slug→path[] 索引
// ──────────────────────────────────────────────────────────────────
describe("buildSlugIndex", () => {
  it("maps slug → [relPath]，去 .md 后缀", () => {
    const idx = buildSlugIndex(["concepts/foo.md", "entities/bar.md"])
    expect(idx.get("foo")).toEqual(["concepts/foo.md"])
    expect(idx.get("bar")).toEqual(["entities/bar.md"])
  })

  it("排除 reserved（index.md / log.md，含子目录）", () => {
    const idx = buildSlugIndex(["index.md", "concepts/index.md", "log.md", "concepts/foo.md"])
    expect(idx.has("index")).toBe(false)
    expect(idx.has("log")).toBe(false)
    expect(idx.get("foo")).toEqual(["concepts/foo.md"])
  })

  it("重名 slug 收集为多 path 数组", () => {
    const idx = buildSlugIndex(["concepts/wikilink.md", "entities/wikilink.md"])
    expect(idx.get("wikilink")).toEqual(["concepts/wikilink.md", "entities/wikilink.md"])
  })
})
