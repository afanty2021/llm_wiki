// OKF v0.1 导出层：把 wiki bundle 只读转换为 OKF-conformant bundle。
//
// 依据 https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md
// 仅做硬性转换（frontmatter 格式修复 / timestamp 注入 / index.md & log.md 规整）。
// 不做 wikilink 双写（P1）、Tauri 命令（P0b）、description/resource 派生（P2）。
//
// 零运行时依赖，纯 ESM。

import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync, existsSync } from "node:fs"
import { join, relative, dirname, basename } from "node:path"

export interface ExportReport {
  /** 写出的 .md 文件数 */
  written: number
  /** 其中 concept 文件数（非 reserved） */
  concepts: number
  /** reserved 文件数（index.md / log.md 各层级） */
  reserved: number
  /** 歧义/异常记录（如 truly-none 兜底） */
  warnings: string[]
}

const RESERVED = new Set(["index.md", "log.md"])
const KEY_VALUE_RE = /^[A-Za-z0-9_-]+\s*:\s*\S/
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// 判断 relative() 返回值是否表示不同盘符的绝对路径（macOS/Linux: 以 / 开头；Windows: 以 X:\ 开头）
function isAbsoluteLike(p: string): boolean {
  return p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p)
}

// ──────────────────────────────────────────────────────────────────
// Frontmatter 解析 / 分类（与 validate-okf.mjs 语义一致的四分类）
// ──────────────────────────────────────────────────────────────────

/**
 * 拆出 frontmatter payload 与 body。
 * 仅匹配首字符即 --- 的严格围栏；返回 null 表示无严格围栏。
 */
function splitStrictFence(content: string): { payload: string; body: string } | null {
  const m = content.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/)
  if (!m) return null
  return { payload: m[1], body: content.slice(m[0].length) }
}

/**
 * §4.0 四分支判断。与 validate-okf.mjs::parseFrontmatter 的 defect 分类语义一致：
 *   normal          → 严格围栏在首字符
 *   leading-blank   → 前导空白/空行后才有 ---（实际有 fm 内容）
 *   missing-fence   → 有 key:value 行但无开头 --- 围栏
 *   truly-none      → 完全无 fm 内容（兜底）
 */
export function classifyFrontmatter(content: string): "normal" | "leading-blank" | "missing-fence" | "truly-none" {
  if (/^---[ \t]*\r?\n/.test(content)) return "normal"
  // 前导空白后才出现 ---，且后续有闭合 ---
  if (/^[ \t\r\n]*---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.test(content)) {
    return "leading-blank"
  }
  // 有 key: value 行但无围栏
  if (KEY_VALUE_RE.test(content.slice(0, 512).replace(/^[ \t\r\n]+/, ""))) {
    return "missing-fence"
  }
  return "truly-none"
}

/** 解析 frontmatter payload 为 Map<key, value>（逐行 key: value，不引 YAML 库）。 */
function parseFields(payload: string): Map<string, string> {
  const fields = new Map<string, string>()
  for (const line of payload.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+)[ \t]*:[ \t]*(.*)$/)
    if (m) fields.set(m[1], m[2].trim())
  }
  return fields
}

/** 从 body 提取首个 # 标题文本（无则返回 null）。 */
function firstHeadingText(body: string): string | null {
  for (const line of body.split(/\r?\n/)) {
    const m = line.match(/^#\s+(.+?)\s*$/)
    if (m) return m[1]
  }
  return null
}

// ──────────────────────────────────────────────────────────────────
// timestamp 派生（决策 A：日期精度，不虚构时间精度）
// ──────────────────────────────────────────────────────────────────

/**
 * 派生 timestamp 值（公共工具函数，供外部/测试按需使用）。
 *
 * 优先级：现有 updated → created → mtime(YYYY-MM-DD)。
 * 源值本就是 YYYY-MM-DD（由 currentWikiDate 生成），直接使用，不加 T/Z。
 * content 期望已含严格围栏（payload 在围栏内）；若无围栏则尝试 loose 提取。
 *
 * 主线分工说明：`convertConcept` 主线**不调用**本函数，而是使用
 * {@link pickTimestampFromFields}（解析已有 fm 字段）+ {@link mtimeDate}（mtime 兜底）
 * 的组合（见 {@link injectTimestamp}）。本函数作为独立工具保留，方便外部脚本或
 * 测试在不走完整 convert 流程时复用同款"updated → created → mtime"优先级逻辑。
 * 当前项目内仅 `okf-export.test.ts` 直接调用。
 */
export function deriveTimestamp(
  content: string,
  nowFallback: Date,
  fileMtime?: Date,
): string {
  const strict = splitStrictFence(content)
  const payload = strict?.payload ?? extractLoosePayload(content)
  if (payload) {
    const fields = parseFields(payload)
    const updated = fields.get("updated")
    if (updated && ISO_DATE_RE.test(updated)) return updated
    const created = fields.get("created")
    if (created && ISO_DATE_RE.test(created)) return created
  }
  const m = fileMtime ?? nowFallback
  return m.toISOString().slice(0, 10)
}

// loose payload 提取：对 missing-fence（无开头 --- 但有 key:value 行）情况，
// 提取连续的 key:value 行块。
//
// 孤立性说明：当前仅被 {@link deriveTimestamp}（同样属孤立公共工具）调用，
// 主线 convertConcept/injectTimestamp 不经过此函数。保留以支撑 deriveTimestamp
// 在无严格围栏场景下的字段提取能力，与该函数的"公共工具"定位一致。
function extractLoosePayload(content: string): string | null {
  const lines = content.split(/\r?\n/)
  const startIdx = lines.findIndex((l) => KEY_VALUE_RE.test(l))
  if (startIdx === -1) return null
  const endIdx = lines.findIndex((l, i) => i > startIdx && /^---[ \t]*$/.test(l))
  if (endIdx === -1) return lines.slice(startIdx).join("\n")
  return lines.slice(startIdx, endIdx).join("\n")
}

// ──────────────────────────────────────────────────────────────────
// index.md 转换
// ──────────────────────────────────────────────────────────────────

/** bundle-root index.md：剥离原 fm，重写为仅含 okf_version + 原 body。 */
export function convertBundleRootIndex(content: string): string {
  const body = stripFrontmatter(content)
  return `---\nokf_version: "0.1"\n---\n${body.replace(/^\n+/, "")}`
}

/** 子目录 index.md：剥离全部 frontmatter，仅留 body。 */
export function convertSubdirIndex(content: string): string {
  return stripFrontmatter(content).replace(/^\n+/, "")
}

/** 剥离 frontmatter（严格围栏或前导空白围栏），返回剩余 body；无围栏则原样返回。 */
function stripFrontmatter(content: string): string {
  const strict = content.match(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/)
  if (strict) return content.slice(strict[0].length)
  const leading = content.match(/^[ \t\r\n]*---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/)
  if (leading) return content.slice(leading[0].length)
  return content
}

// ──────────────────────────────────────────────────────────────────
// log.md 转换
// ──────────────────────────────────────────────────────────────────

/**
 * §7: normalize 每个 ## 标题为纯 YYYY-MM-DD，动作 + 明细移入下一行正文。
 * 保证每个 ## YYYY-MM-DD 标题下有非空正文。
 */
export function normalizeLogContent(content: string): string {
  const lines = content.split(/\r?\n/)
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const m = line.match(/^##\s+(.+?)\s*$/)
    if (!m) {
      out.push(line)
      continue
    }
    const head = m[1]
    const norm = normalizeLogHeading(head)
    out.push(`## ${norm.date}`)
    // 若有注入的 prose 行，加入；保证非空正文
    if (norm.injected) out.push("", `- **${norm.action}**: ${norm.detail}`)
  }
  return out.join("\n")
}

function normalizeLogHeading(head: string): { date: string; injected: boolean; action: string; detail: string } {
  // 纯 YYYY-MM-DD 已合规
  if (ISO_DATE_RE.test(head)) {
    return { date: head, injected: false, action: "", detail: "" }
  }
  // 提取日期前缀
  const dm = head.match(/^\[?(\d{4}-\d{2}-\d{2})\]?\s*(.*)$/)
  if (!dm) {
    // 无法识别为日期开头——原样保留（不注入），validator 会判违规但这是源数据问题
    return { date: head, injected: false, action: "", detail: "" }
  }
  const date = dm[1]
  let rest = dm[2].trim()
  // 双竖线情况：## DATE | action | detail
  if (rest.startsWith("|")) rest = rest.slice(1).trim()
  if (!rest) {
    return { date, injected: false, action: "", detail: "" }
  }
  // 拆 action / detail
  const pipeIdx = rest.indexOf("|")
  let action: string
  let detail: string
  if (pipeIdx === -1) {
    action = rest.trim()
    detail = ""
  } else {
    action = rest.slice(0, pipeIdx).trim()
    detail = rest.slice(pipeIdx + 1).trim()
  }
  if (!action) {
    return { date, injected: false, action: "", detail: "" }
  }
  const actionCap = capitalizeAction(action)
  return { date, injected: true, action: actionCap, detail: detail || "(no detail)" }
}

function capitalizeAction(action: string): string {
  if (!action) return action
  // 首字母大写，保留后续
  return action.charAt(0).toUpperCase() + action.slice(1)
}

// ──────────────────────────────────────────────────────────────────
// concept 转换（含 overview.md 等所有非 reserved .md）
// ──────────────────────────────────────────────────────────────────

/**
 * 修复 frontmatter 格式 + 补 timestamp。warnings 通过传入数组追加。
 */
export function convertConcept(
  content: string,
  filename: string,
  nowFallback: Date,
  warnings: string[],
  fileMtime?: Date,
): string {
  const cls = classifyFrontmatter(content)
  let fixed: string
  switch (cls) {
    case "normal":
      fixed = content
      break
    case "leading-blank":
      fixed = stripLeadingBlank(content)
      break
    case "missing-fence":
      try {
        fixed = repairMissingFenceOrThrow(content)
      } catch (e) {
        // 无闭合 ---：不能把 body 吞进 frontmatter（会致 YAML 解析失败）。
        // 转走 truly-none 路径——注入完整最小 fm，原内容作 body。
        if (e === NO_CLOSING_FENCE) {
          return injectMinimalFrontmatter(content, filename, nowFallback, fileMtime, warnings)
        }
        throw e
      }
      break
    case "truly-none":
      fixed = injectMinimalFrontmatter(content, filename, nowFallback, fileMtime, warnings)
      // truly-none 已注入 timestamp，直接返回
      return fixed
  }
  // normal / leading-blank / missing-fence：补 timestamp
  return injectTimestamp(fixed, nowFallback, fileMtime)
}

/** leading-blank: strip 前导空白与空行，使 --- 成为首字符。 */
function stripLeadingBlank(content: string): string {
  return content.replace(/^[ \t\r\n]+/, "")
}

/**
 * missing-fence（已确认存在闭合 ---）：在文件最前补 ---\n。
 * 前缀通常是空行/空白，丢弃；闭合 --- 之后的 body 原样保留。
 * 关键：避免双 ---。
 *
 * 前置条件：调用方 {@link repairMissingFenceOrThrow} 已校验 hasClosing=true。
 */
function repairMissingFence(content: string): string {
  const lines = content.split(/\r?\n/)
  const startIdx = lines.findIndex((l) => KEY_VALUE_RE.test(l))
  if (startIdx === -1) return content // 不该到这里
  // 从首行 key:value 到文件末尾（含闭合 --- 与 body），前面补 ---\n。
  // 前缀空白行被 slice(startIdx) 自然丢弃。
  return `---\n${lines.slice(startIdx).join("\n")}`
}

/**
 * 检测 missing-fence 文件是否具备闭合 ---。
 * - 有闭合 → 返回修复后的内容（补开头 ---，body 保留在闭合 --- 之后）。
 * - 无闭合 → 抛 {@link NO_CLOSING_FENCE}，调用方应转走 truly-none 路径
 *   （注入完整最小 fm，原内容作 body），避免把 body 吞进 frontmatter 导致 YAML 解析失败。
 *
 * 当前生产数据中所有 missing-fence 文件均带闭合 ---，无闭合属防御性场景；
 * 但防御代码必须正确——不能为了"补全围栏"而把 body 当作 frontmatter payload。
 */
const NO_CLOSING_FENCE = Symbol("no-closing-fence")
function repairMissingFenceOrThrow(content: string): string {
  const lines = content.split(/\r?\n/)
  const startIdx = lines.findIndex((l) => KEY_VALUE_RE.test(l))
  if (startIdx === -1) return content // 不该到这里
  let hasClosing = false
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^---[ \t]*$/.test(lines[i])) {
      hasClosing = true
      break
    }
  }
  if (!hasClosing) throw NO_CLOSING_FENCE
  return repairMissingFence(content)
}

/** truly-none: 注入完整最小 frontmatter（type/title/timestamp），记录 warning。 */
function injectMinimalFrontmatter(
  content: string,
  filename: string,
  nowFallback: Date,
  fileMtime: Date | undefined,
  warnings: string[],
): string {
  const body = content
  const title = firstHeadingText(body) ?? basename(filename).replace(/\.md$/i, "")
  const ts = (fileMtime ?? nowFallback).toISOString().slice(0, 10)
  warnings.push(
    `truly-none: ${filename} had no frontmatter content; injected minimal fm (type/title/timestamp).`,
  )
  return `---\ntype: concept\ntitle: ${title}\ntimestamp: ${ts}\n---\n${body}`
}

/**
 * 给已有 frontmatter 的 concept 注入 timestamp（若无）。
 * 保留 updated/created/sources/related/tags/type/title 等扩展字段。
 */
function injectTimestamp(
  content: string,
  nowFallback: Date,
  fileMtime: Date | undefined,
): string {
  // 标准 frontmatter：open 围栏 + 非空 payload + close 围栏（close 前必须有 \n）
  let m = content.match(/^(---[ \t]*\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$))/)
  // 空 payload 情况：---\n---\n（payload 为空，close 紧接 open）
  if (!m) {
    const emptyM = content.match(/^(---[ \t]*\r?\n)(---[ \t]*(?:\r?\n|$))([\s\S]*)$/)
    if (!emptyM) return content // 不应发生（已修复格式）
    const [, open, close, body] = emptyM
    const ts = mtimeDate(fileMtime) ?? nowFallback.toISOString().slice(0, 10)
    // 空 payload 注入 timestamp：插入到 open 与 close 之间（close 自带 \n，body 直接拼接）
    return `${open}timestamp: ${ts}\n${close}${body}`
  }
  const [, open, payload, close] = m
  const body = content.slice(m[0].length)
  const fields = parseFields(payload)
  // 已有 timestamp，保留不动
  if (fields.has("timestamp")) {
    return content
  }
  const ts = pickTimestampFromFields(fields) ?? mtimeDate(fileMtime) ?? nowFallback.toISOString().slice(0, 10)
  // 在 payload 末尾追加 timestamp 行
  const newPayload = payload.endsWith("\n") ? `${payload}timestamp: ${ts}` : `${payload}\ntimestamp: ${ts}`
  return `${open}${newPayload}${close}${body}`
}

function pickTimestampFromFields(fields: Map<string, string>): string | null {
  const u = fields.get("updated")
  if (u && ISO_DATE_RE.test(u)) return u
  const c = fields.get("created")
  if (c && ISO_DATE_RE.test(c)) return c
  return null
}

/**
 * 把文件 mtime 格式化为 YYYY-MM-DD；无 mtime 则返回 null（由调用方兜底 nowFallback）。
 *
 * 历史版本曾用 `statSync(filename)` 作回退——但传入的是相对 wikiDir 的 relPath，
 * CWD≠wikiDir 时必然失败靠 catch 吞错，是掩盖问题的坏味道。
 * 生产入口 `exportOkfBundle` 总是通过 `statSync(abs).mtime` 传入绝对路径的 mtime，
 * 此回退从未真正执行。故移除 filename 参数与 statSync 调用。
 */
function mtimeDate(fileMtime: Date | undefined): string | null {
  return fileMtime?.toISOString().slice(0, 10) ?? null
}

// ──────────────────────────────────────────────────────────────────
// exportOkfBundle — 端到端
// ──────────────────────────────────────────────────────────────────

/**
 * 递归收集所有 .md 文件（相对 wikiDir 的绝对路径）。
 *
 * 行为说明：
 * - 跳过符号链接（`statSync().isSymbolicLink()`），防止循环链接导致无限递归或源污染。
 * - 跳过 `node_modules` 与以 `.` 开头的目录/文件。
 *
 * IO 错误（如权限拒绝、目录消失）会抛出异常；调用方需自行 try/catch。
 */
function walkMarkdown(dir: string, base: string = dir): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue
    const p = join(dir, name)
    const s = statSync(p)
    if (s.isSymbolicLink()) continue
    if (s.isDirectory()) out.push(...walkMarkdown(p, base))
    else if (name.endsWith(".md")) out.push(p)
  }
  return out
}

/**
 * 端到端导出：把 wikiDir 只读转换为 OKF-conformant bundle，写入 outDir。
 *
 * 安全约束：
 * - 源 wiki 只读，源文件内容（含任何 UTF-8 BOM）会被 strip 后再分类/转换，但不会写回源。
 * - 若 outDir 是 wikiDir 本身或其子目录，会抛出 Error，防止导出产物污染源 wiki。
 *
 * IO 错误（如 walkMarkdown / readFileSync / writeFileSync 失败）会向上抛出；
 * 调用方需自行 try/catch 并清理临时目录。
 */
export async function exportOkfBundle(wikiDir: string, outDir: string): Promise<ExportReport> {
  const report: ExportReport = { written: 0, concepts: 0, reserved: 0, warnings: [] }
  if (!existsSync(wikiDir)) {
    throw new Error(`wikiDir 不存在: ${wikiDir}`)
  }
  // I1: 防止 outDir 落在 wikiDir 内（含相等），避免源被污染
  // path.relative(wikiDir, outDir) 返回：
  //   ""              → 两者相等
  //   ".."开头        → outDir 在 wikiDir 外（合法）
  //   其他相对路径    → outDir 在 wikiDir 内（非法）
  //   绝对路径        → 不同盘符（macOS/Linux/Windows 同盘下不会出现，视为合法外置）
  const rel = relative(wikiDir, outDir)
  if (rel === "") {
    throw new Error(`outDir 不能等于 wikiDir，否则会污染源 wiki（wikiDir=${wikiDir}, outDir=${outDir}）`)
  }
  if (!rel.startsWith("..") && !isAbsoluteLike(rel)) {
    throw new Error(
      `outDir 不能位于 wikiDir 子目录内，否则会污染源 wiki（wikiDir=${wikiDir}, outDir=${outDir}, relative=${rel}）`,
    )
  }
  const files = walkMarkdown(wikiDir)
  const now = new Date()

  for (const abs of files) {
    const relPath = relative(wikiDir, abs).replace(/\\/g, "/")
    const name = basename(abs)
    const isReserved = RESERVED.has(name)
    // I3: strip UTF-8 BOM（跨平台 bug：BOM 使首字符非 -，被误分类为 truly-none）
    const rawContent = readFileSync(abs, "utf8")
    const content = rawContent.replace(/^﻿/, "")
    const mtime = statSync(abs).mtime
    const outPath = join(outDir, relPath)
    mkdirSync(dirname(outPath), { recursive: true })

    let converted: string

    if (isReserved) {
      report.reserved++
      if (name === "index.md") {
        // bundle-root index.md vs 子目录 index.md
        const isRoot = dirname(relPath) === "."
        converted = isRoot ? convertBundleRootIndex(content) : convertSubdirIndex(content)
      } else {
        // log.md
        converted = normalizeLogContent(content)
      }
    } else {
      report.concepts++
      converted = convertConcept(content, relPath, now, report.warnings, mtime)
    }

    writeFileSync(outPath, converted, "utf8")
    report.written++
  }

  return report
}
