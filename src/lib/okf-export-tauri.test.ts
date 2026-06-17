// P0b-1: exportOkfBundleTauri 编排层测试。
//
// 策略：直接 mock `@/commands/fs`（编排的真实依赖边界），构造虚拟文件树，
// 断言编排调用序列 + 转换结果正确。vitest 环境无真实 Tauri，真实 app 内验证留 P0b-2。
//
// 转换逻辑（convertConcept / normalizeLogContent / index 转换 / timestamp 注入）
// 已由 okf-export.test.ts 覆盖；本测试聚焦"编排是否把纯函数正确接线到 IO 层"，
// 而非重测纯函数本身（避免 tautology）。

import { beforeEach, describe, expect, it, vi } from "vitest"

// ──────────────────────────────────────────────────────────────────
// 虚拟文件系统：内存 Map<absPath, content> + 目录树。
// mock 工厂闭包持有 state，每个 it 通过 beforeEach 重置。
// ──────────────────────────────────────────────────────────────────
const state = vi.hoisted(() => {
  return {
    files: new Map<string, string>(), // 文件 absPath → content
    dirs: new Set<string>(), // 目录 absPath
    mtimes: new Map<string, number>(), // absPath → epoch ms（可选）
    writeCalls: new Array<{ path: string; contents: string }>(),
    createDirCalls: new Array<string>(),
    readFileThrows: new Set<string>(), // 强制某些路径读取抛错（负面测试）
  }
})

vi.mock("@/commands/fs", () => ({
  readFile: vi.fn(async (path: string): Promise<string> => {
    if (state.readFileThrows.has(path)) {
      throw new Error(`mock readFile throw: ${path}`)
    }
    const c = state.files.get(path)
    if (c === undefined) throw new Error(`mock readFile ENOENT: ${path}`)
    return c
  }),
  writeFile: vi.fn(async (path: string, contents: string): Promise<void> => {
    state.writeCalls.push({ path, contents })
  }),
  createDirectory: vi.fn(async (path: string): Promise<void> => {
    state.createDirCalls.push(path)
    state.dirs.add(path)
  }),
  // 预递归：对齐生产 build_tree 契约（src-tauri/src/commands/fs.rs::build_tree）。
  // 一次 listDirectory(dir) 返回该 dir 的完整预递归树：目录节点带递归填充的
  // children（空目录或超 30 层 → children: undefined）。消费方不应再对子目录
  // 重调 listDirectory——这与真实 Tauri 后端语义一致。
  //
  // FileNode 无 mtime 字段（见 @/types/wiki.ts）。
  listDirectory: vi.fn(async (path: string) => {
    return buildPretree(path)
  }),
  getFileModifiedTime: vi.fn(async (path: string): Promise<number> => {
    return state.mtimes.get(path) ?? 0
  }),
}))

import { exportOkfBundleTauri } from "./okf-export-tauri"

const WIKI = "/mock/wiki"
const OUT = "/mock/out"
const PAGE = (fm: string, body: string) => `---\n${fm}\n---\n\n${body}`

function resetState() {
  state.files.clear()
  state.dirs.clear()
  state.mtimes.clear()
  state.writeCalls.length = 0
  state.createDirCalls.length = 0
  state.readFileThrows.clear()
  // 清除 mock 调用记录（保留实现），使每个 it 的调用次数断言从 0 开始
  vi.clearAllMocks()
}

/**
 * 模拟生产 build_tree（src-tauri/src/commands/fs.rs::build_tree）：
 * 返回给定 dir 的预递归 FileNode[]。
 * - 目录节点：递归填充 children；空目录或无可见条目 → children: undefined
 *   （对齐 Rust: `if kids.is_empty() { None } else { Some(kids) }`）
 * - 跳过 dotfiles/`node_modules`（对齐 Rust: `!n.starts_with('.')`）；
 *   注：生产后端不跳 node_modules，但编排层会跳——此处不过滤 node_modules
 *   以便编排层的过滤逻辑被测试覆盖。
 * - 目录在前、文件在后，组内按名排序（对齐 Rust sort）
 */
function buildPretree(dir: string): Array<{
  name: string
  path: string
  is_dir: boolean
  children?: ReturnType<typeof buildPretree>
}> {
  // 收集直接子条目
  const subdirs: Array<{ name: string; path: string }> = []
  const subfiles: Array<{ name: string; path: string }> = []

  for (const d of state.dirs) {
    if (!d.startsWith(dir + "/")) continue
    const rest = d.slice(dir.length + 1)
    if (rest.length === 0 || rest.includes("/")) continue
    if (rest.startsWith(".")) continue // 对齐后端 dotfile 过滤
    subdirs.push({ name: rest, path: d })
  }
  for (const [fp] of state.files) {
    if (!fp.startsWith(dir + "/")) continue
    const rest = fp.slice(dir.length + 1)
    if (rest.length === 0 || rest.includes("/")) continue
    if (rest.startsWith(".")) continue
    subfiles.push({ name: rest, path: fp })
  }

  subdirs.sort((a, b) => a.name.localeCompare(b.name))
  subfiles.sort((a, b) => a.name.localeCompare(b.name))

  const out: Array<{
    name: string
    path: string
    is_dir: boolean
    children?: ReturnType<typeof buildPretree>
  }> = []
  for (const sd of subdirs) {
    const kids = buildPretree(sd.path)
    out.push({
      name: sd.name,
      path: sd.path,
      is_dir: true,
      children: kids.length > 0 ? kids : undefined,
    })
  }
  for (const sf of subfiles) {
    out.push({ name: sf.name, path: sf.path, is_dir: false })
  }
  return out
}

function writeFile(path: string, content: string, mtimeMs?: number) {
  state.files.set(path, content)
  if (mtimeMs !== undefined) state.mtimes.set(path, mtimeMs)
}

function addDir(path: string) {
  state.dirs.add(path)
}

describe("exportOkfBundleTauri", () => {
  beforeEach(() => resetState())

  // ─────────────────────────────────────────────────────────────
  // 端到端编排：混合 bundle（normal/leading-blank/missing-fence concept
  // + index.md + log.md + 子目录 + CJK 文件名）
  // ─────────────────────────────────────────────────────────────
  it("orchestrates a mixed bundle: reserved + concepts + subdir + CJK names", async () => {
    addDir(`${WIKI}/concepts`)
    addDir(`${WIKI}/entities`)

    // bundle-root index.md（reserved，root → convertBundleRootIndex）
    writeFile(`${WIKI}/index.md`, PAGE("type: index\ntitle: 索引", "# Index\n\n- [[foo]]"))
    // log.md（reserved → normalizeLogContent）
    writeFile(
      `${WIKI}/log.md`,
      "# Research Log\n\n## [2026-05-19] ingest | 首次导入\n\n- body\n",
    )
    // normal concept
    writeFile(
      `${WIKI}/concepts/academic.md`,
      PAGE("type: concept\ntitle: Academic\nupdated: 2026-05-19", "# Academic"),
      new Date("2026-05-19T00:00:00Z").getTime(),
    )
    // leading-blank concept（前导空行）
    writeFile(
      `${WIKI}/concepts/wikilink.md`,
      "\n\n---\ntype: concept\ntitle: Wikilink\n---\n# W",
    )
    // CJK 文件名 concept（missing-fence 走 truly-none 兜底，因无闭合 ---）
    writeFile(`${WIKI}/entities/概念实体.md`, "# 只是一个标题\n\nbody")
    // overview concept（normal）
    writeFile(
      `${WIKI}/overview.md`,
      PAGE("type: overview\ntitle: 概述\nupdated: 2026-05-19", "# 概述"),
    )

    const report = await exportOkfBundleTauri(WIKI, OUT)

    // 计数：6 written = 1 root index + 1 log + 4 concepts（academic/wikilink/概念实体/overview）
    expect(report.written).toBe(6)
    expect(report.reserved).toBe(2)
    expect(report.concepts).toBe(4)
    // 概念实体.md 无任何 fm → truly-none 兜底 → 1 warning
    expect(report.warnings.length).toBe(1)
    expect(report.warnings[0]).toContain("概念实体.md")

    // ── 转换结果断言（验证编排正确接线纯函数，非重测纯函数）──
    const written = new Map(state.writeCalls.map((c) => [c.path, c.contents]))

    // bundle-root index.md → okf_version only，剥离原 fm
    const rootIndex = written.get(`${OUT}/index.md`)!
    expect(rootIndex.startsWith('---\nokf_version: "0.1"\n---\n')).toBe(true)
    expect(rootIndex).toContain("# Index")
    expect(rootIndex).not.toContain("type: index")

    // log.md 标题规范化（## [2026-05-19] ingest → ## 2026-05-19 + 注入 prose）
    const log = written.get(`${OUT}/log.md`)!
    expect(log).toContain("## 2026-05-19")
    expect(log).not.toContain("[2026-05-19]")

    // normal concept：保留结构 + timestamp 来自 updated
    const academic = written.get(`${OUT}/concepts/academic.md`)!
    expect(academic.startsWith("---\ntype: concept")).toBe(true)
    expect(academic).toContain("timestamp: 2026-05-19")

    // leading-blank：前导空行被 strip
    const wl = written.get(`${OUT}/concepts/wikilink.md`)!
    expect(wl.startsWith("---\n")).toBe(true)
    expect(wl).not.toMatch(/^\n/)

    // CJK concept：truly-none → 注入最小 fm
    const cjk = written.get(`${OUT}/entities/概念实体.md`)!
    expect(cjk.startsWith("---\ntype: concept\ntitle: ")).toBe(true)
    expect(cjk).toContain("timestamp:")
    expect(cjk).toContain("# 只是一个标题") // 原 body 保留

    // ── IO 层调用序列断言 ──
    // 每个文件被 readFile 一次；非根目录文件（concepts/*, entities/*）触发 createDirectory
    expect(state.createDirCalls).toContain(`${OUT}/concepts`)
    expect(state.createDirCalls).toContain(`${OUT}/entities`)
    // 写出数 = 文件数
    expect(state.writeCalls.length).toBe(6)
  })

  // ─────────────────────────────────────────────────────────────
  // outDir 防护：outDir == wikiDir → throw
  // ─────────────────────────────────────────────────────────────
  it("throws when outDir equals wikiDir", async () => {
    await expect(exportOkfBundleTauri(WIKI, WIKI)).rejects.toThrow(/不能等于 wikiDir/)
    // 不应发生任何写入
    expect(state.writeCalls.length).toBe(0)
  })

  // ─────────────────────────────────────────────────────────────
  // outDir 防护：outDir 在 wikiDir 子目录内 → throw
  // ─────────────────────────────────────────────────────────────
  it("throws when outDir is inside wikiDir", async () => {
    await expect(exportOkfBundleTauri(WIKI, `${WIKI}/subdir`)).rejects.toThrow(
      /不能位于 wikiDir 子目录内/,
    )
    expect(state.writeCalls.length).toBe(0)
  })

  // ─────────────────────────────────────────────────────────────
  // 子目录 index.md：reserved 名 → convertSubdirIndex（剥离全部 fm）
  // ─────────────────────────────────────────────────────────────
  it("handles subdir index.md by stripping all frontmatter (not root okf_version)", async () => {
    addDir(`${WIKI}/concepts`)
    writeFile(`${WIKI}/concepts/index.md`, PAGE("type: index\ntitle: Sub", "# Sub idx"))

    const report = await exportOkfBundleTauri(WIKI, OUT)

    const out = state.writeCalls.find((c) => c.path === `${OUT}/concepts/index.md`)!
    expect(out).toBeDefined()
    // 子目录 index.md：无围栏、无 okf_version，仅 body
    expect(out.contents).not.toContain("---")
    expect(out.contents).not.toContain("okf_version")
    expect(out.contents).toContain("# Sub idx")
    expect(report.reserved).toBe(1)
    expect(report.concepts).toBe(0)
  })

  // ─────────────────────────────────────────────────────────────
  // 空 wikiDir：report 全 0，不抛错
  // ─────────────────────────────────────────────────────────────
  it("returns empty report for empty wiki dir", async () => {
    const report = await exportOkfBundleTauri(WIKI, OUT)
    expect(report.written).toBe(0)
    expect(report.concepts).toBe(0)
    expect(report.reserved).toBe(0)
    expect(report.warnings.length).toBe(0)
    expect(state.writeCalls.length).toBe(0)
  })

  // ─────────────────────────────────────────────────────────────
  // UTF-8 BOM strip：BOM + 正常 fm → 不触发 truly-none 兜底
  // ─────────────────────────────────────────────────────────────
  it("strips UTF-8 BOM before classify so BOM file is treated as normal", async () => {
    const BOM = "﻿"
    writeFile(
      `${WIKI}/bom.md`,
      `${BOM}---\ntype: concept\ntitle: BomTitle\nupdated: 2026-05-19\n---\n\n# Body`,
    )

    const report = await exportOkfBundleTauri(WIKI, OUT)

    expect(report.warnings.some((w) => w.includes("bom.md") || w.includes("truly-none"))).toBe(false)
    const out = state.writeCalls.find((c) => c.path === `${OUT}/bom.md`)!
    expect(out.contents.startsWith("---\n")).toBe(true)
  })

  // ─────────────────────────────────────────────────────────────
  // mtime 兜底：concept 无 updated/created，timestamp 来自 getFileModifiedTime
  // ─────────────────────────────────────────────────────────────
  it("uses getFileModifiedTime for timestamp when concept lacks updated/created", async () => {
    writeFile(
      `${WIKI}/entity.md`,
      PAGE("type: entity\ntitle: Person", "# Person"),
      new Date("2026-03-15T00:00:00Z").getTime(),
    )

    const report = await exportOkfBundleTauri(WIKI, OUT)

    const out = state.writeCalls.find((c) => c.path === `${OUT}/entity.md`)!
    // timestamp 来自 mtime = 2026-03-15
    expect(out.contents).toContain("timestamp: 2026-03-15")
    expect(report.concepts).toBe(1)
  })

  // ─────────────────────────────────────────────────────────────
  // 嵌套子目录：2 层深结构，createDirectory 对最深父目录调用一次
  // （后端 create_directory 用 fs::create_dir_all，recursive 等价 mkdir -p，
  //  故编排只调直接父目录即可，中间层由后端递归创建）
  // ─────────────────────────────────────────────────────────────
  it("walks nested subdirs and calls createDirectory for the deepest outDir parent", async () => {
    addDir(`${WIKI}/a`)
    addDir(`${WIKI}/a/b`)
    writeFile(`${WIKI}/a/b/deep.md`, PAGE("type: concept\ntitle: Deep\nupdated: 2026-05-19", "# Deep"))

    const report = await exportOkfBundleTauri(WIKI, OUT)

    expect(report.written).toBe(1)
    expect(state.writeCalls.find((c) => c.path === `${OUT}/a/b/deep.md`)).toBeDefined()
    // 直接父目录 = OUT/a/b（后端 create_dir_all 会递归创建 OUT 和 OUT/a）
    expect(state.createDirCalls).toContain(`${OUT}/a/b`)
    // 契约：listDirectory(wikiDir) 一次返回完整预递归树（含 children），
    // 编排不得对子目录重调 listDirectory——否则丢弃后端已做的预递归工作。
    // 对嵌套 a/b/deep.md 场景，期望恰好 1 次调用（wikiDir）。
    const { listDirectory } = await import("@/commands/fs")
    expect((listDirectory as unknown as { mock: { calls: unknown[][] } }).mock.calls.length).toBe(1)
    expect((listDirectory as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0]).toBe(WIKI)
  })

  // ─────────────────────────────────────────────────────────────
  // 负面测试：readFile 抛错 → 编排必须 reject（不吞读错误）。
  // 锁定：walkMarkdownTauri 收集到的 .md 由 exportOkfBundleTauri 逐个 readFile，
  // 任一抛错都必须向上传播，而非被静默吞掉写入空文件或跳过。
  // ─────────────────────────────────────────────────────────────
  it("rejects when readFile throws for a collected .md (does not swallow read errors)", async () => {
    writeFile(`${WIKI}/good.md`, PAGE("type: concept\ntitle: Good\nupdated: 2026-05-19", "# Good"))
    writeFile(`${WIKI}/bad.md`, PAGE("type: concept\ntitle: Bad\nupdated: 2026-05-19", "# Bad"))
    state.readFileThrows.add(`${WIKI}/bad.md`)

    await expect(exportOkfBundleTauri(WIKI, OUT)).rejects.toThrow(/mock readFile throw/)
    // 不应写出 bad.md（good.md 是否已写取决于遍历顺序，但 bad.md 绝不能落地）
    expect(state.writeCalls.find((c) => c.path === `${OUT}/bad.md`)).toBeUndefined()
  })
})

// ──────────────────────────────────────────────────────────────────
// P1 wikilink 双写：端到端集成测试（resolvable fixture 填补 Task 6 reviewer 指出的 gap）
//
// Task 6 reviewer 备注：现有 fixture wikilinks 都是 dangling（双写 no-op），
// 无法验证编排层确实把 slugIndex 接线到 convertConcept/doubleWriteContent 并产出
// 双写 link。下面 3 个 case 用 resolvable fixture（target .md 真实存在）真正触发双写。
// ──────────────────────────────────────────────────────────────────
describe("exportOkfBundleTauri — P1 wikilink 双写", () => {
  beforeEach(() => resetState())

  it("concept body 的 [[slug]] 双写为标准 link，原 wikilink 保留；self 不双写", async () => {
    addDir(`${WIKI}/concepts`)
    writeFile(
      `${WIKI}/concepts/foo.md`,
      PAGE("type: concept\ntitle: Foo\nupdated: 2026-05-19", "# Foo\n\nself [[foo]]"),
    )
    writeFile(
      `${WIKI}/concepts/bar.md`,
      PAGE("type: concept\ntitle: Bar\nupdated: 2026-05-19", "# Bar\n\nsee [[foo]]"),
    )

    await exportOkfBundleTauri(WIKI, OUT)
    const written = new Map(state.writeCalls.map((c) => [c.path, c.contents]))

    // foo.md 自身的 [[foo]] 是 self → 不双写
    const foo = written.get(`${OUT}/concepts/foo.md`)!
    expect(foo).toContain("self [[foo]]")
    expect(foo).not.toContain("[[foo]] ([Foo](/concepts/foo.md))")
    // bar.md 的 [[foo]] 唯一映射 → 双写
    expect(written.get(`${OUT}/concepts/bar.md`)!).toContain(
      "see [[foo]] ([Foo](/concepts/foo.md))",
    )
  })

  it("index.md 的 [[slug]] 双写，log.md 不双写", async () => {
    addDir(`${WIKI}/concepts`)
    writeFile(
      `${WIKI}/concepts/foo.md`,
      PAGE("type: concept\ntitle: Foo\nupdated: 2026-05-19", "# Foo"),
    )
    writeFile(`${WIKI}/index.md`, PAGE("type: index", "# Index\n\n- [[foo]]"))
    writeFile(`${WIKI}/log.md`, "# Log\n\n## 2026-05-19\n\nsee [[foo]]\n")

    await exportOkfBundleTauri(WIKI, OUT)
    const written = new Map(state.writeCalls.map((c) => [c.path, c.contents]))

    expect(written.get(`${OUT}/index.md`)!).toContain("[[foo]] ([Foo](/concepts/foo.md))")
    expect(written.get(`${OUT}/log.md`)!).not.toContain("[[foo]] ([Foo](/concepts/foo.md))") // log 不双写
  })

  it("ambiguous wikilink 记入 report.warnings，不双写", async () => {
    addDir(`${WIKI}/concepts`)
    addDir(`${WIKI}/entities`)
    writeFile(
      `${WIKI}/concepts/wikilink.md`,
      PAGE("type: concept\ntitle: W1\nupdated: 2026-05-19", "# W1"),
    )
    writeFile(
      `${WIKI}/entities/wikilink.md`,
      PAGE("type: concept\ntitle: W2\nupdated: 2026-05-19", "# W2"),
    )
    writeFile(
      `${WIKI}/concepts/refs.md`,
      PAGE("type: concept\ntitle: Refs\nupdated: 2026-05-19", "see [[wikilink]]"),
    )

    const report = await exportOkfBundleTauri(WIKI, OUT)
    const written = new Map(state.writeCalls.map((c) => [c.path, c.contents]))

    expect(written.get(`${OUT}/concepts/refs.md`)!).toContain("see [[wikilink]]")
    expect(written.get(`${OUT}/concepts/refs.md`)!).not.toContain("([W1]")
    expect(written.get(`${OUT}/concepts/refs.md`)!).not.toContain("([W2]")
    expect(report.warnings.some((w) => /ambiguous wikilink \[\[wikilink\]\] → 2 paths:/.test(w))).toBe(true)
  })
})
