import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"

import {
  compileDot,
  countNodes,
  maxDepth,
  normalizeOutline,
  OutlineFormatError,
  outlineCapsError,
  renderMindmap,
} from "../src/mindmap.js"

const SAMPLE = {
  title: "一般过去时",
  root: {
    children: [
      { label: "构成规则", children: [{ label: "动词 +ed" }, { label: "不规则动词表" }] },
      { label: "时间标志词" },
    ],
  },
}

// ── normalizeOutline ──

test("normalizeOutline: 归一形状——root.label 即 title、缺 children 补空、递归展开", () => {
  const outline = normalizeOutline(SAMPLE)
  assert.equal(outline.title, "一般过去时")
  assert.equal(outline.root.label, "一般过去时")
  assert.equal(outline.root.children.length, 2)
  assert.deepEqual(outline.root.children[0]!.children.map((c) => c.label), ["动词 +ed", "不规则动词表"])
  assert.deepEqual(outline.root.children[1]!.children, [])
})

test("normalizeOutline: 形状非法 → OutlineFormatError", () => {
  assert.throws(() => normalizeOutline({ title: "", root: {} }), OutlineFormatError)
  assert.throws(() => normalizeOutline({ title: 42, root: {} }), OutlineFormatError)
  assert.throws(() => normalizeOutline({ title: "t", root: "x" }), OutlineFormatError)
  assert.throws(() => normalizeOutline({ title: "t", root: [] }), OutlineFormatError)
  assert.throws(() => normalizeOutline({ title: "t", root: { children: [{}] } }), /label/)
  assert.throws(() => normalizeOutline({ title: "t", root: { children: ["x"] } }), /must be an object/)
  assert.throws(() => normalizeOutline({ title: "t", root: { children: { label: "x" } } }), /must be an array/)
})

// ── caps ──

function wideTree(n: number) {
  return {
    title: "t",
    root: { children: Array.from({ length: n }, (_, i) => ({ label: `b${i}` })) },
  }
}

test("outlineCapsError: 61 节点超限、恰好 60 通过", () => {
  const over = normalizeOutline(wideTree(60)) // root + 60 = 61
  assert.match(outlineCapsError(over)!, /节点总数 61 个超过上限 60/)
  const edge = normalizeOutline(wideTree(59)) // root + 59 = 60
  assert.equal(outlineCapsError(edge), null)
})

test("outlineCapsError: 深度超限（root=0 层，最深许可 4）", () => {
  const deep = {
    title: "t",
    root: {
      children: [{ label: "1", children: [{ label: "2", children: [{ label: "3", children: [{ label: "4", children: [{ label: "5" }] }] }] }] }],
    },
  }
  assert.match(outlineCapsError(normalizeOutline(deep))!, /超过上限 5 层/)
  const ok = {
    title: "t",
    root: { children: [{ label: "1", children: [{ label: "2", children: [{ label: "3", children: [{ label: "4" }] }] }] }] },
  }
  assert.equal(outlineCapsError(normalizeOutline(ok)), null)
})

test("outlineCapsError: 标签/标题超长——指明位置", () => {
  const overLabel = normalizeOutline({ title: "t", root: { children: [{ label: "x".repeat(41) }] } })
  assert.match(outlineCapsError(overLabel)!, /root\.children\[0\]/)
  const overTitle = normalizeOutline({ title: "t".repeat(61), root: {} })
  assert.match(outlineCapsError(overTitle)!, /标题 61 字符/)
  assert.equal(countNodes(normalizeOutline(SAMPLE).root), 5)
  assert.equal(maxDepth(normalizeOutline(SAMPLE).root), 2)
})

// ── compileDot ──

test("compileDot: 结构/根样式/深度配色/中文与转义", () => {
  const dot = compileDot(normalizeOutline({
    title: "一般过去时",
    root: { children: [{ label: '引号"与反斜杠\\' }, { label: "换行\n压空格", children: [{ label: "深层", children: [{ label: "更深层" }] }] }] },
  }))
  assert.ok(dot.includes("rankdir=LR"))
  assert.ok(dot.includes("PingFang SC"))
  // 根节点 = 白字大号蓝底
  assert.match(dot, /n0 \[label="一般过去时", fillcolor="#4C6FFF", fontcolor="white", fontsize=17\];/)
  // 转义：引号/反斜杠转义、换行压成空格——label 字段内部无裸换行
  assert.ok(dot.includes('label="引号\\"与反斜杠\\\\"'))
  assert.ok(dot.includes('label="换行 压空格"'))
  // 边数 = 节点数 - 1（树）
  const nodeLines = dot.split("\n").filter((l) => l.includes("[label="))
  const edgeLines = dot.split("\n").filter((l) => l.includes(" -> "))
  assert.equal(nodeLines.length, 5)
  assert.equal(edgeLines.length, 4)
  // 深度配色：depth1/2/3
  assert.ok(dot.includes('fillcolor="#DCE7FF"'))
  assert.ok(dot.includes('fillcolor="#F0F4FF"'))
  assert.ok(dot.includes('fillcolor="#F7FAFF"'))
})

test("compileDot: 撞名 label 生成独立节点 id", () => {
  const dot = compileDot(normalizeOutline({ title: "t", root: { children: [{ label: "同" }, { label: "同" }] } }))
  const ids = dot.split("\n").filter((l) => l.includes("[label=")).map((l) => l.slice(0, l.indexOf(" [")))
  assert.deepEqual(new Set(ids).size, 3)
})

// ── renderMindmap ──

function makeFakeRun() {
  const calls: Array<{ cmd: string; args: string[] }> = []
  const state: { dotSrc: string | null } = { dotSrc: null }
  const run = async (cmd: string, args: string[]): Promise<unknown> => {
    calls.push({ cmd, args })
    // tmp 目录在 render 返回前即清理，dot 源码必须在调用时快照。
    state.dotSrc = readFileSync(args[1]!, "utf8")
    const o = args.indexOf("-o")
    writeFileSync(args[o + 1]!, "fake-png-bytes")
    return { stdout: "", stderr: "" }
  }
  return { run, calls, state }
}

test("renderMindmap: 成功——dot 参数/产物落 outDir/文件名 sha1 前 12 位幂等/nodes+depth", async () => {
  const outDir = mkdtempSync(path.join(tmpdir(), "ltutor-mindmap-out-"))
  const { run, calls, state } = makeFakeRun()
  const outline = normalizeOutline(SAMPLE)

  const result = await renderMindmap(outline, { execFile: run, outDir })
  assert.equal(result.ok, true)
  assert.equal(result.nodes, 5)
  assert.equal(result.depth, 3)
  assert.match(path.basename(result.path!), /^mindmap-[0-9a-f]{12}\.png$/)
  assert.ok(result.path!.startsWith(outDir))
  assert.ok(readFileSync(result.path!, "utf8") === "fake-png-bytes")

  const dotCall = calls[0]!
  assert.equal(dotCall.cmd, "dot")
  assert.equal(dotCall.args[0], "-Tpng")
  assert.equal(dotCall.args[2], "-o")
  assert.equal(state.dotSrc, compileDot(outline), "喂给 dot 的源码必须与 compileDot 逐字节一致")

  // 幂等：同大纲重渲染 → 同一路径（覆盖写）
  const again = await renderMindmap(outline, { execFile: run, outDir })
  assert.equal(again.path, result.path)

  rmSync(outDir, { recursive: true, force: true })
})

test("renderMindmap: dot 失败 → ok:false + tmp 清理", async () => {
  const outDir = mkdtempSync(path.join(tmpdir(), "ltutor-mindmap-err-"))
  const run = async () => {
    throw new Error("Command failed: dot: boom")
  }
  const result = await renderMindmap(normalizeOutline(SAMPLE), { execFile: run, outDir })
  assert.equal(result.ok, false)
  assert.match(result.error!, /boom/)
  const leftovers = readdirSync(outDir).filter((n) => n.startsWith("tmp-"))
  assert.deepEqual(leftovers, [], "tmp 目录必须清理")
  rmSync(outDir, { recursive: true, force: true })
})
