/**
 * 思维导图 PNG 渲染引擎（2026-09-09 教师思维导图工具，方案
 * docs/superpowers/plans/2026-09-09-teacher-mindmap-tool.md）。
 *
 * 管线：outline JSON（LLM 只产结构、永不产图语法——语法错误类整体消灭）
 * → 确定性编译 DOT → `dot -Tpng`（graphviz 本地渲染）。
 *
 * 方案 §二 路线实测（2026-09-09）：graphviz 热渲染 0.08s（mermaid.ink 5.25s/次、
 * 无 SLA、大纲进 GET URL——落选）；PingFang SC 中文渲染无豆腐块（探针目检过）。
 *
 * 约束（方案 §四.1）：
 * - 输出落 ~/.hermes/cache/ltutor-mindmap/（对齐 ltutor-tts 先例；勿 /tmp——重启即清）；
 * - 文件名 = sha1(dot 源码) 前 12 位：同大纲幂等覆盖、不堆积；
 * - dot 缺失/失败 → { ok:false }，由 handler 走文本引导（应用级故障不进熔断器）。
 */
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

export const MINDMAP_MAX_DEPTH = 4
export const MINDMAP_MAX_NODES = 60
export const MINDMAP_MAX_LABEL_CHARS = 40
export const MINDMAP_MAX_TITLE_CHARS = 60
export const MINDMAP_PROC_TIMEOUT_MS = 15_000
export const DEFAULT_MINDMAP_OUT_DIR = path.join(homedir(), ".hermes", "cache", "ltutor-mindmap")

export interface MindmapNode {
  label: string
  children: MindmapNode[]
}

export interface MindmapOutline {
  title: string
  root: MindmapNode
}

export interface MindmapRenderResult {
  ok: boolean
  path?: string
  nodes?: number
  depth?: number
  /** 渲染引擎（"graphviz" | "markmap"），成功时返回并进教师可见摘要。 */
  engine?: "graphviz" | "markmap"
  error?: string
}

export interface MindmapRenderDeps {
  execFile?: (cmd: string, args: string[], opts: { timeout: number }) => Promise<unknown>
  outDir?: string
}

/** outline 结构非法（类型/缺字段）：handler 转 ToolArgumentError（对齐 listening 形状错误先例）。 */
export class OutlineFormatError extends Error {}

/**
 * 递归校验并归一 outline。root 的 label 即 title（入参分离，避免模型在两处
 * 重复/不一致）；children 缺省为空数组，归一后形状全量确定。
 */
export function normalizeOutline(raw: { title: unknown; root: unknown }): MindmapOutline {
  if (typeof raw.title !== "string" || raw.title.trim() === "") {
    throw new OutlineFormatError("title is required")
  }
  if (!raw.root || typeof raw.root !== "object" || Array.isArray(raw.root)) {
    throw new OutlineFormatError("root must be an object")
  }
  const rootChildren = (raw.root as Record<string, unknown>).children
  return {
    title: raw.title,
    root: { label: raw.title, children: normalizeChildren(rootChildren, "root.children", 0) },
  }
}

/** 嵌套深度前置拦截（评审 I3）：~8000 层即 RangeError 且非 OutlineFormatError，
 * 会逸出「不进熔断器」承诺——在递归爆栈前以正常校验错误拒绝。 */
const MAX_OUTLINE_NESTING = 100

function normalizeChildren(raw: unknown, at: string, depth: number): MindmapNode[] {
  if (depth > MAX_OUTLINE_NESTING) {
    throw new OutlineFormatError(`${at} 嵌套超过 ${MAX_OUTLINE_NESTING} 层`)
  }
  if (raw === undefined) return []
  if (!Array.isArray(raw)) throw new OutlineFormatError(`${at} must be an array`)
  return raw.map((item, i) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new OutlineFormatError(`${at}[${i}] must be an object`)
    }
    const rec = item as Record<string, unknown>
    if (typeof rec.label !== "string" || rec.label.trim() === "") {
      throw new OutlineFormatError(`${at}[${i}].label is required`)
    }
    return { label: rec.label, children: normalizeChildren(rec.children, `${at}[${i}].children`, depth + 1) }
  })
}

export function countNodes(node: MindmapNode): number {
  return 1 + node.children.reduce((n, c) => n + countNodes(c), 0)
}

/** 树高：root=0 层，root 的孩子为 1 层。 */
export function maxDepth(node: MindmapNode): number {
  return node.children.reduce((m, c) => Math.max(m, maxDepth(c) + 1), 0)
}

/**
 * 量级闸（对齐 LISTENING_MAX_* 纪律）：超限返回人类可读原因，handler 包裹成
 * 正常文本引导（应用级输入问题不进熔断器，record_ask/listening 前例）。
 */
export function outlineCapsError(outline: MindmapOutline): string | null {
  if (outline.title.length > MINDMAP_MAX_TITLE_CHARS) {
    return `标题 ${outline.title.length} 字符超过上限 ${MINDMAP_MAX_TITLE_CHARS} 字符`
  }
  const nodes = countNodes(outline.root)
  if (nodes > MINDMAP_MAX_NODES) {
    return `节点总数 ${nodes} 个超过上限 ${MINDMAP_MAX_NODES} 个`
  }
  const depth = maxDepth(outline.root)
  if (depth > MINDMAP_MAX_DEPTH) {
    return `导图 ${depth + 1} 层超过上限 ${MINDMAP_MAX_DEPTH + 1} 层`
  }
  // root 不查 40 字符闸：root.label 由 title 强制而来、模型传不到该字段，
  // title 的 60 字符上限已在上面单独检查（评审 I1——报错误导读不到的字段）。
  for (const [i, child] of outline.root.children.entries()) {
    const hit = findOverlongLabel(child, `root.children[${i}]`)
    if (hit) return hit
  }
  return null
}

function findOverlongLabel(node: MindmapNode, at: string): string | null {
  if (node.label.length > MINDMAP_MAX_LABEL_CHARS) {
    return `${at} 的标签 ${node.label.length} 字符超过上限 ${MINDMAP_MAX_LABEL_CHARS} 字符（「${node.label.slice(0, 20)}…」）`
  }
  for (const [i, child] of node.children.entries()) {
    const hit = findOverlongLabel(child, `${at}.children[${i}]`)
    if (hit) return hit
  }
  return null
}

// 深度配色（方案 §五，探针样式固化）：depth 0..3，更深回落最浅档。
const DOT_FILLS = ["#4C6FFF", "#DCE7FF", "#F0F4FF", "#F7FAFF"]

/** DOT 字符串字面量转义：反斜杠/双引号必须转义；全部控制字符压成空格（评审 M1——\x01 等会被 dot 原样画进 PNG）。 */
function escapeDotLabel(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\x00-\x1f]+/g, " ")
}

/** 纯函数：outline → DOT 源码（rankdir=LR 圆角填充树，PingFang SC）。 */
export function compileDot(outline: MindmapOutline): string {
  const lines: string[] = [
    "digraph mindmap {",
    "  rankdir=LR;",
    '  graph [dpi=144, bgcolor="white", pad=0.4, fontname="PingFang SC"];',
    '  node [shape=box, style="rounded,filled", fontname="PingFang SC", fontsize=13, margin="0.18,0.1", penwidth=0];',
    '  edge [arrowhead=none, color="#B0B7C3", penwidth=1.4];',
  ]
  let seq = 0
  const emit = (label: string, depth: number, parentId?: string): string => {
    const id = `n${seq++}`
    const fill = DOT_FILLS[Math.min(depth, DOT_FILLS.length - 1)]
    if (depth === 0) {
      lines.push(`  ${id} [label="${escapeDotLabel(label)}", fillcolor="${fill}", fontcolor="white", fontsize=17];`)
    } else {
      lines.push(`  ${id} [label="${escapeDotLabel(label)}", fillcolor="${fill}"];`)
    }
    if (parentId) lines.push(`  ${parentId} -> ${id};`)
    return id
  }
  const walk = (node: MindmapNode, depth: number, parentId: string): void => {
    const id = emit(node.label, depth, parentId)
    for (const child of node.children) walk(child, depth + 1, id)
  }
  const rootId = emit(outline.title, 0)
  for (const child of outline.root.children) walk(child, 1, rootId)
  lines.push("}")
  return lines.join("\n") + "\n"
}

/** 渲染错误人性化：spawn ENOENT（含 tmp 绝对路径）→ 中文「组件未安装」引导（评审 M6）。 */
export function friendlyRenderError(err: unknown): string {
  const raw = String(err)
  if (/spawn .*ENOENT/.test(raw)) {
    return `渲染组件未安装（${/spawn \S+/.exec(raw)?.[0] ?? "子进程"} ENOENT）。dot 缺失时请先 brew install graphviz，再重试或先给教师文字版大纲`
  }
  return raw
}

/**
 * 渲染思维导图 PNG。成功返回 { ok, path, engine, nodes, depth }；任何失败
 * （dot 缺失/outDir 不可写等）返回 { ok:false, error }，绝不抛错——
 * mkdir/mkdtemp 都在 try 内，环境故障走文本引导不进熔断器（评审 I3）。
 */
export async function renderMindmap(
  outline: MindmapOutline,
  deps: MindmapRenderDeps = {},
): Promise<MindmapRenderResult> {
  const run = deps.execFile ?? execFileAsync
  const outDir = deps.outDir ?? DEFAULT_MINDMAP_OUT_DIR
  const dotSrc = compileDot(outline)
  // 哈希 dot 源码而非 outline JSON：同一渲染结果幂等覆盖，语义等价且免归一化歧义。
  const hash = createHash("sha1").update(dotSrc).digest("hex").slice(0, 12)
  const finalPath = path.join(outDir, `mindmap-${hash}.png`)

  try {
    mkdirSync(outDir, { recursive: true })
    const tmp = mkdtempSync(path.join(outDir, "tmp-"))
    try {
      const dotPath = path.join(tmp, "mindmap.dot")
      writeFileSync(dotPath, dotSrc, "utf8")
      await run("dot", ["-Tpng", dotPath, "-o", finalPath], { timeout: MINDMAP_PROC_TIMEOUT_MS })
      return {
        ok: true,
        path: finalPath,
        engine: "graphviz",
        nodes: countNodes(outline.root),
        depth: maxDepth(outline.root) + 1,
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  } catch (err) {
    return { ok: false, error: friendlyRenderError(err) }
  }
}
