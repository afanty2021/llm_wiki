/**
 * 教师学案海报渲染引擎（2026-09-10 方案
 * docs/superpowers/plans/2026-09-10-teacher-worksheet-tool.md，评审 C-1/I-1..I-8 已并入）。
 *
 * 混合路径：LLM 只产 JSON 结构（六种块型判别联合）→ 确定性渲染 HTML（nature 主题，
 * 探针样式固化 assets/worksheet-probe/page.html）→ 复用 chromeScreenshotRunner +
 * isCompletePng + 临时名 rename → PNG → MEDIA: 投递链。
 *
 * 与 markmap 的差异：内容必须以可读文本进 HTML（非 base64），因此
 * - 每个文本字段过 `esc()`（&<>"' 五件套 + 控制字符压空格），输入文本只进文本节点、
 *   HTML 属性值一律模板常量（I-2）；
 * - 模板零 script 元素（纯静态页）。
 *
 * 纪律沿袭：caps 超限→文本引导不进熔断器；IEND+临时名 rename（白屏/半截不得
 * ok:true）；文件名 sha1(渲染 HTML)（I-4，与 mindmap.ts 哈希纪律对齐）；
 * Chrome 缺失等环境故障透传友好文案（I-7b——勿用 mindmap friendlyRenderError，
 * 其 ENOENT 文案是 graphviz 专属）。
 */
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { chromeScreenshotRunner, isCompletePng } from "./mindmap-markmap.js"

export const WORKSHEET_CANVAS_W = 1500
export const WORKSHEET_CANVAS_H = 1100
export const DEFAULT_WORKSHEET_OUT_DIR = join(homedir(), ".hermes", "cache", "ltutor-worksheet")

// ── caps（评审 I-5：字段级优先于总量；长度口径 String.length；min 2 sections 在 caps 强制）──
export const WORKSHEET_MAX_TITLE_CHARS = 40
export const WORKSHEET_MAX_SUBTITLE_CHARS = 60
export const WORKSHEET_MAX_FOOTER_CHARS = 60
export const WORKSHEET_MAX_HEADING_CHARS = 30
export const WORKSHEET_MAX_ICON_CODEPOINTS = 8
export const WORKSHEET_MAX_TEXT_CHARS = 120
export const WORKSHEET_MAX_PHRASE_CHARS = 60
export const WORKSHEET_MAX_CHECK_ITEM_CHARS = 30
export const WORKSHEET_MAX_TABLE_CELL_CHARS = 12
export const WORKSHEET_MAX_SECTIONS = 4
export const WORKSHEET_MIN_SECTIONS = 2
export const WORKSHEET_MAX_BLOCKS_PER_SECTION = 4
export const WORKSHEET_MAX_LIST_ITEMS = 6
export const WORKSHEET_MAX_FILL_ITEMS = 4
export const WORKSHEET_MAX_TABLE_COLS = 5
export const WORKSHEET_MAX_TABLE_ROWS = 4
export const WORKSHEET_MAX_TOTAL_CHARS = 1200

export type WorksheetBlockType = "text" | "fill" | "boxfill" | "checklist" | "numbered" | "table"

export interface WorksheetTextBlock { type: "text"; text: string }
export interface WorksheetFillBlock { type: "fill" | "boxfill" | "numbered"; items: Array<{ before: string; after?: string }> }
export interface WorksheetChecklistBlock { type: "checklist"; items: string[] }
export interface WorksheetTableBlock { type: "table"; headers: string[]; rows: string[][] }
export type WorksheetBlock = WorksheetTextBlock | WorksheetFillBlock | WorksheetChecklistBlock | WorksheetTableBlock

export interface WorksheetSection {
  heading: string
  icon?: string
  blocks: WorksheetBlock[]
}

export interface WorksheetDoc {
  title: string
  subtitle?: string
  theme: "nature"
  footer?: string
  sections: WorksheetSection[]
}

export interface WorksheetRenderResult {
  ok: boolean
  path?: string
  sections?: number
  blocks?: number
  error?: string
}

export interface WorksheetRenderDeps {
  outDir?: string
  chromePath?: string
  /** 截图执行体（测试注入）；默认 = chromeScreenshotRunner（画布固定 WORKSHEET_CANVAS_*，M-2：不注入尺寸防与模板错位）。 */
  screenshot?: (htmlPath: string, outPath: string) => Promise<void>
}

/** 结构非法（类型/缺字段/空串）：handler 转 ToolArgumentError（normalizeOutline 先例）。 */
export class WorksheetFormatError extends Error {}

// ── 校验与归一 ──

const BLOCK_TYPES: readonly WorksheetBlockType[] = ["text", "fill", "boxfill", "checklist", "numbered", "table"]

function requireText(value: unknown, at: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new WorksheetFormatError(`${at} is required`)
  }
  return value.trim()
}

function optionalText(value: unknown, at: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string") throw new WorksheetFormatError(`${at} must be a string`)
  const trimmed = value.trim()
  return trimmed === "" ? undefined : trimmed
}

/** 结构校验+归一（trim 语义，normalizeOutline 先例）；长度/数量帽归 worksheetCapsError。 */
export function normalizeWorksheet(raw: {
  title: unknown
  subtitle?: unknown
  theme?: unknown
  footer?: unknown
  sections: unknown
}): WorksheetDoc {
  const title = requireText(raw.title, "title")
  const subtitle = optionalText(raw.subtitle, "subtitle")
  // theme（M-1）：非字符串 fail-fast；字符串值非 nature 回落 nature（schema enum 已限，纵深防御）。
  if (raw.theme !== undefined && typeof raw.theme !== "string") {
    throw new WorksheetFormatError("theme must be a string")
  }
  const footer = optionalText(raw.footer, "footer")

  if (!Array.isArray(raw.sections)) throw new WorksheetFormatError("sections must be an array")
  const sections = raw.sections.map((item, i) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new WorksheetFormatError(`sections[${i}] must be an object`)
    }
    const rec = item as Record<string, unknown>
    const heading = requireText(rec.heading, `sections[${i}].heading`)
    const icon = optionalText(rec.icon, `sections[${i}].icon`)
    if (!Array.isArray(rec.blocks)) throw new WorksheetFormatError(`sections[${i}].blocks must be an array`)
    const blocks = rec.blocks.map((b, j) => normalizeBlock(b, `sections[${i}].blocks[${j}]`))
    return { heading, icon, blocks }
  })
  return { title, subtitle, theme: "nature", footer, sections }
}

function normalizeBlock(raw: unknown, at: string): WorksheetBlock {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new WorksheetFormatError(`${at} must be an object`)
  }
  const rec = raw as Record<string, unknown>
  const type = rec.type
  if (typeof type !== "string" || !BLOCK_TYPES.includes(type as WorksheetBlockType)) {
    throw new WorksheetFormatError(`${at}.type must be one of ${BLOCK_TYPES.join("/")}`)
  }
  if (type === "text") {
    return { type, text: requireText(rec.text, `${at}.text`) }
  }
  if (type === "checklist") {
    if (!Array.isArray(rec.items)) throw new WorksheetFormatError(`${at}.items must be an array`)
    if (rec.items.length < 1) {
      const demo = type === "checklist"
        ? '如 {"type":"checklist","items":["Plants 🌱","Trees 🌳"]}'
        : '如 {"type":"fill","items":[{"before":"We can see","after":"right outside."}]}'
      throw new WorksheetFormatError(`${at}.items 不能为空——至少 1 项，${demo}`)
    }
    return {
      type,
      items: rec.items.map((item, k) => requireText(item, `${at}.items[${k}]`)),
    }
  }
  if (type === "table") {
    if (!Array.isArray(rec.headers)) throw new WorksheetFormatError(`${at}.headers must be an array`)
    if (!Array.isArray(rec.rows)) throw new WorksheetFormatError(`${at}.rows must be an array`)
    if (rec.headers.length < 1) {
      throw new WorksheetFormatError(`${at}.headers 不能为空——至少 1 列，如 ["Monday","Tuesday","Wednesday"]`)
    }
    if (rec.rows.length < 1) {
      throw new WorksheetFormatError(`${at}.rows 不能为空——至少 1 行，如 [["English","Math","Music"]]，且每行格数与 headers 一致`)
    }
    const headers = rec.headers.map((h, k) => requireText(h, `${at}.headers[${k}]`))
    const rows = rec.rows.map((row, r) => {
      if (!Array.isArray(row)) throw new WorksheetFormatError(`${at}.rows[${r}] must be an array`)
      // I-1：歪表行——列数与表头不等即拒（超列静默丢格 / 短列静默补空都吃内容）。
      if (row.length !== headers.length) {
        throw new WorksheetFormatError(
          `${at}.rows[${r}] 有 ${row.length} 个单元格，与表头 ${headers.length} 列不一致——请补齐或删至列数一致`,
        )
      }
      return row.map((cell, c) => {
        if (typeof cell !== "string") throw new WorksheetFormatError(`${at}.rows[${r}][${c}] must be a string`)
        return cell.trim()
      })
    })
    return { type, headers, rows }
  }
  // fill / boxfill / numbered：items[] { before, after? }
  if (!Array.isArray(rec.items)) throw new WorksheetFormatError(`${at}.items must be an array`)
  if (rec.items.length < 1) throw new WorksheetFormatError(`${at}.items 不能为空（I-4：空块不渲染）`)
  const items = rec.items.map((item, k) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new WorksheetFormatError(`${at}.items[${k}] must be an object`)
    }
    const ir = item as Record<string, unknown>
    const before = requireText(ir.before, `${at}.items[${k}].before`)
    const after = optionalText(ir.after, `${at}.items[${k}].after`)
    // I-2：numbered 渲染只用 before——after 被接受即静默丢内容，直接拒。
    if (type === "numbered" && after !== undefined) {
      throw new WorksheetFormatError(`${at}.items[${k}].after 不适用于 numbered（编号行只有题干+答题空线）——请改用 fill 并把内容并入 before`)
    }
    return after === undefined ? { before } : { before, after }
  })
  return { type: type as "fill" | "boxfill" | "numbered", items }
}

// ── caps ──

function countBlocks(sections: WorksheetSection[]): number {
  return sections.reduce((n, s) => n + s.blocks.length, 0)
}

function totalChars(doc: WorksheetDoc): number {
  let n = doc.title.length + (doc.subtitle?.length ?? 0) + (doc.footer?.length ?? 0)
  for (const s of doc.sections) {
    n += s.heading.length + (s.icon?.length ?? 0)
    for (const b of s.blocks) {
      if (b.type === "text") n += b.text.length
      else if (b.type === "checklist") n += b.items.reduce((m, x) => m + x.length, 0)
      else if (b.type === "table") {
        n += b.headers.reduce((m, x) => m + x.length, 0)
        n += b.rows.reduce((m, row) => m + row.reduce((mm, x) => mm + x.length, 0), 0)
      } else {
        n += b.items.reduce((m, x) => m + x.before.length + (x.after?.length ?? 0), 0)
      }
    }
  }
  return n
}

/** 量级闸（超限返回人类可读原因，handler 包裹成文本引导；字段级优先于总量）。 */
export function worksheetCapsError(doc: WorksheetDoc): string | null {
  if (doc.title.length > WORKSHEET_MAX_TITLE_CHARS) {
    return `标题 ${doc.title.length} 字符超过上限 ${WORKSHEET_MAX_TITLE_CHARS}`
  }
  if ((doc.subtitle?.length ?? 0) > WORKSHEET_MAX_SUBTITLE_CHARS) {
    return `副标题 ${doc.subtitle!.length} 字符超过上限 ${WORKSHEET_MAX_SUBTITLE_CHARS}`
  }
  if ((doc.footer?.length ?? 0) > WORKSHEET_MAX_FOOTER_CHARS) {
    return `页脚 ${doc.footer!.length} 字符超过上限 ${WORKSHEET_MAX_FOOTER_CHARS}`
  }
  if (doc.sections.length < WORKSHEET_MIN_SECTIONS) {
    return `板块 ${doc.sections.length} 张少于下限 ${WORKSHEET_MIN_SECTIONS} 张`
  }
  if (doc.sections.length > WORKSHEET_MAX_SECTIONS) {
    return `板块 ${doc.sections.length} 张超过上限 ${WORKSHEET_MAX_SECTIONS} 张`
  }
  for (const [i, s] of doc.sections.entries()) {
    if (s.heading.length > WORKSHEET_MAX_HEADING_CHARS) {
      return `sections[${i}].heading ${s.heading.length} 字符超过上限 ${WORKSHEET_MAX_HEADING_CHARS}`
    }
    if (s.icon !== undefined && [...s.icon].length > WORKSHEET_MAX_ICON_CODEPOINTS) {
      return `sections[${i}].icon 超过 ${WORKSHEET_MAX_ICON_CODEPOINTS} 个码位`
    }
    if (s.blocks.length < 1) return `sections[${i}] 至少需要 1 个内容块`
    if (s.blocks.length > WORKSHEET_MAX_BLOCKS_PER_SECTION) {
      return `sections[${i}] 内容块 ${s.blocks.length} 个超过上限 ${WORKSHEET_MAX_BLOCKS_PER_SECTION} 个`
    }
    const blockErr = blockCapsError(s.blocks, `sections[${i}]`)
    if (blockErr) return blockErr
  }
  const total = totalChars(doc)
  if (total > WORKSHEET_MAX_TOTAL_CHARS) {
    return `总文本量 ${total} 字符超过上限 ${WORKSHEET_MAX_TOTAL_CHARS}——请精简或拆成多张`
  }
  // C-1 布局预算闸：估高 > 版心即拒——确定性零渲染开销，替代「渲染后静默裁切」。
  const height = estimateWorksheetHeight(doc)
  if (height > WORKSHEET_LAYOUT_BUDGET_PX) {
    return `内容过密：预估排版高度 ${height}px 超出版心 ${WORKSHEET_LAYOUT_BUDGET_PX}px（底部会被裁切）——请精简内容或拆成多张`
  }
  return null
}

// ── 布局预算（评审 C-1：caps 合法输入仍可能整页溢出被截图静默裁切）──

/** 版心可用高度：frame 1060 − 上下 padding 52，留 8px 余量。 */
export const WORKSHEET_LAYOUT_BUDGET_PX = 1000

// 估高常量（探针 CSS 量纲：卡片内宽 ~649px、正文字号 21px/行高 36、CJK 每行 ~28 字）。
const LINE_PX = 36
const BLOCK_MARGIN_PX = 12
const CHARS_PER_LINE = 28
const CARD_PADDING_PX = 40
const HEADING_PX = 44
const PAGE_HEADER_PX = 130 // 标题 + 副标题 + 页脚 + grid 上边距
const GRID_GAP_PX = 22

function linesFor(chars: number): number {
  return Math.max(1, Math.ceil(chars / CHARS_PER_LINE))
}

function blockHeight(b: WorksheetBlock): number {
  if (b.type === "text") return linesFor(b.text.length) * LINE_PX + BLOCK_MARGIN_PX
  if (b.type === "checklist") {
    // flex-wrap 后：每项宽 ≈ 字数×21 + 勾选框与间距 60，按半宽卡 640px 折行。
    const width = b.items.reduce((w, x) => w + x.length * 21 + 60, 0)
    return Math.ceil(width / 640) * 38 + BLOCK_MARGIN_PX
  }
  if (b.type === "table") return (b.rows.length + 1) * 36 + BLOCK_MARGIN_PX
  // fill/boxfill：内容宽 = before+after 字数×21 + 空线 ~220；numbered 行高 2.1 ≈ 46。
  if (b.type === "numbered") {
    return b.items.reduce((h, x) => h + linesFor(x.before.length) * 46 + 10, 0)
  }
  return b.items.reduce((h, x) => {
    const widthChars = x.before.length + (x.after?.length ?? 0) + 10
    return h + linesFor(widthChars) * LINE_PX + BLOCK_MARGIN_PX
  }, 0)
}

/** 确定性估高（px）：页头 130 + Σ(网格行高=max(同行卡片)) + 行距。偏保守（估高≥实测）。 */
export function estimateWorksheetHeight(doc: WorksheetDoc): number {
  const cardHeights = doc.sections.map((s) => {
    let h = CARD_PADDING_PX + HEADING_PX
    for (const b of s.blocks) h += blockHeight(b)
    return h
  })
  let grid = 0
  for (let i = 0; i < cardHeights.length; i += 2) {
    grid += Math.max(cardHeights[i]!, cardHeights[i + 1] ?? 0) + GRID_GAP_PX
  }
  return PAGE_HEADER_PX + grid
}

function blockCapsError(blocks: WorksheetBlock[], at: string): string | null {
  for (const [j, b] of blocks.entries()) {
    const where = `${at}.blocks[${j}]`
    if (b.type === "text") {
      if (b.text.length > WORKSHEET_MAX_TEXT_CHARS) {
        return `${where}.text ${b.text.length} 字符超过上限 ${WORKSHEET_MAX_TEXT_CHARS}`
      }
    } else if (b.type === "checklist") {
      if (b.items.length > WORKSHEET_MAX_LIST_ITEMS) {
        return `${where} 勾选项 ${b.items.length} 个超过上限 ${WORKSHEET_MAX_LIST_ITEMS} 个`
      }
      const over = b.items.findIndex((x) => x.length > WORKSHEET_MAX_CHECK_ITEM_CHARS)
      if (over >= 0) return `${where}.items[${over}] ${b.items[over]!.length} 字符超过上限 ${WORKSHEET_MAX_CHECK_ITEM_CHARS}`
    } else if (b.type === "table") {
      if (b.headers.length > WORKSHEET_MAX_TABLE_COLS) {
        return `${where} 表格 ${b.headers.length} 列超过上限 ${WORKSHEET_MAX_TABLE_COLS} 列`
      }
      if (b.rows.length > WORKSHEET_MAX_TABLE_ROWS) {
        return `${where} 表格 ${b.rows.length} 行超过上限 ${WORKSHEET_MAX_TABLE_ROWS} 行`
      }
      const wide = b.rows.findIndex((row) => row.length > WORKSHEET_MAX_TABLE_COLS)
      if (wide >= 0) return `${where}.rows[${wide}] ${b.rows[wide]!.length} 列超过上限 ${WORKSHEET_MAX_TABLE_COLS} 列`
      const cellIdx = firstOver(b.headers, WORKSHEET_MAX_TABLE_CELL_CHARS)
      if (cellIdx !== null) {
        return `${where}.headers[${cellIdx}] 单元格 ${b.headers[cellIdx]!.length} 字符超过上限 ${WORKSHEET_MAX_TABLE_CELL_CHARS}`
      }
      for (const [r, row] of b.rows.entries()) {
        const c = firstOver(row, WORKSHEET_MAX_TABLE_CELL_CHARS)
        if (c !== null) {
          return `${where}.rows[${r}][${c}] 单元格 ${row[c]!.length} 字符超过上限 ${WORKSHEET_MAX_TABLE_CELL_CHARS}`
        }
      }
    } else {
      if (b.items.length > WORKSHEET_MAX_FILL_ITEMS) {
        return `${where} 填空行 ${b.items.length} 行超过上限 ${WORKSHEET_MAX_FILL_ITEMS} 行`
      }
      const bad = b.items.findIndex((x) => x.before.length > WORKSHEET_MAX_PHRASE_CHARS || (x.after?.length ?? 0) > WORKSHEET_MAX_PHRASE_CHARS)
      if (bad >= 0) return `${where}.items[${bad}] 短语超过上限 ${WORKSHEET_MAX_PHRASE_CHARS} 字符`
    }
  }
  return null
}

function firstOver(items: string[], max: number): number | null {
  const idx = items.findIndex((x) => x.length > max)
  return idx === -1 ? null : idx
}

// ── HTML 组装 ──

/** esc（I-2）：五件套 + 控制字符压空格；输入文本只进文本节点，属性值一律模板常量。 */
function esc(s: string): string {
  return s
    .replace(/[\x00-\x1f]+/g, " ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

/**
 * emoji 彩色呈现（评审 I-3 钉死）：按字素簇（Intl.Segmenter）——仅「单码位且含
 * Extended_Pictographic」的簇尾补单个 FE0F；多码位簇（旗 🇨🇳/ZWJ 序列 👨‍👩‍👧/
 * 已带 FE0F/FE0E/20E3 变体者）结构性不动（探针实证：headless 截图部分 emoji
 * 回落单色文本呈现）。
 */
const EXT_PICTOGRAPHIC = /\p{Extended_Pictographic}/u
const VARIANT_TAIL = /[\uFE0F\u20E3]$/u

export function emojiFe0f(s: string): string {
  if (!Intl.Segmenter) return s
  const seg = new Intl.Segmenter("en", { granularity: "grapheme" })
  let out = ""
  for (const { segment } of seg.segment(s)) {
    const cps = [...segment]
    out += cps.length === 1 && EXT_PICTOGRAPHIC.test(segment) && !VARIANT_TAIL.test(segment)
      ? segment + "\uFE0F"
      : segment
  }
  return out
}

/** 文本节点组装：emoji 彩色化在前、esc 在后（FE0F 不在 esc 替换集，顺序无歧义）。 */
function textNode(s: string): string {
  return esc(emojiFe0f(s))
}

function blockHtml(block: WorksheetBlock): string {
  if (block.type === "text") {
    return `<div class="line">${textNode(block.text)}</div>`
  }
  if (block.type === "checklist") {
    const items = block.items.map((item) => `<span><span class="cb"></span>${textNode(item)}</span>`).join("")
    return `<div class="checks">${items}</div>`
  }
  if (block.type === "table") {
    const head = block.headers.map((h) => `<th>${textNode(h)}</th>`).join("")
    const rows = block.rows
      .map((row) => {
        const cells = block.headers.map((_, c) => `<td>${textNode(row[c] ?? "")}</td>`).join("")
        return `<tr>${cells}</tr>`
      })
      .join("")
    return `<table><tr>${head}</tr>${rows}</table>`
  }
  // fill / boxfill / numbered
  const cls = block.type === "boxfill" ? "box" : "blank"
  const rows = block.items
    .map((item, i) => {
      if (block.type === "numbered") {
        return `<div class="num"><b>${i + 1}</b>${textNode(item.before)}<span class="${cls}"></span></div>`
      }
      const after = item.after !== undefined ? textNode(item.after) : ""
      return `<div class="line">${textNode(item.before)}<span class="${cls}"></span>${after}</div>`
    })
    .join("")
  return rows
}

/** nature 主题（探针样式固化：assets/worksheet-probe/page.html）。 */
export function buildWorksheetHtml(doc: WorksheetDoc): string {
  const title = textNode(doc.title)
  const subtitle = doc.subtitle !== undefined ? `<div class="subtitle">${textNode(doc.subtitle)}</div>` : ""
  const footer = doc.footer !== undefined ? `<div class="foot">✂️ ${textNode(doc.footer)}</div>` : ""
  const cards = doc.sections
    .map((s) => {
      const icon = s.icon !== undefined ? `<span class="emoji">${textNode(s.icon)}</span>` : ""
      const blocks = s.blocks.map(blockHtml).join("")
      return `<div class="card">${icon}<h2>${textNode(s.heading)}</h2>${blocks}</div>`
    })
    .join("")
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{width:${WORKSHEET_CANVAS_W}px;height:${WORKSHEET_CANVAS_H}px;
       background:
         repeating-linear-gradient(90deg,rgba(0,0,0,.08) 0 3px,transparent 3px 96px),
         repeating-linear-gradient(90deg,rgba(255,255,255,.05) 0 48px,transparent 48px 96px),
         linear-gradient(180deg,#b08050,#96693f);
       font-family:'PingFang SC','Hiragino Sans GB',sans-serif;color:#4a3b28}
  /* 纸张 */
  .paper{position:absolute;left:50px;top:44px;width:1400px;height:1012px;background:#faf5e9;border-radius:8px;
         box-shadow:0 6px 24px rgba(60,40,10,.45),inset 0 0 60px rgba(160,120,60,.12)}
  .paper::after{content:"";position:absolute;inset:0;border-radius:8px;
         background:repeating-linear-gradient(45deg,transparent,transparent 22px,rgba(150,110,55,.05) 22px,rgba(150,110,55,.05) 44px)}
  /* 竹节边框：四条竹竿（分段渐变+节环）+ 四角竹节 */
  .bamboo{position:absolute;background:
      repeating-linear-gradient(90deg,#8fbc64 0 88px,#e3efd2 92px,#8fbc64 96px 150px,#5f8f3f 150px 162px);
      border-radius:9px;box-shadow:0 2px 5px rgba(40,60,20,.4),inset 0 2px 2px rgba(255,255,255,.35)}
  .b-top{left:28px;top:26px;width:1344px;height:18px}
  .b-bottom{left:28px;bottom:26px;width:1344px;height:18px}
  .b-left{left:28px;top:28px;width:18px;height:1052px;
      background:repeating-linear-gradient(180deg,#8fbc64 0 88px,#e3efd2 92px,#8fbc64 96px 150px,#5f8f3f 150px 162px)}
  .b-right{right:28px;top:28px;width:18px;height:1052px;
      background:repeating-linear-gradient(180deg,#8fbc64 0 88px,#e3efd2 92px,#8fbc64 96px 150px,#5f8f3f 150px 162px)}
  .knot{position:absolute;width:30px;height:30px;border-radius:50%;
      background:radial-gradient(circle at 35% 30%,#a5cd7c,#5f8f3f 70%);border:3px solid #4c7530;box-shadow:0 2px 4px rgba(40,60,20,.4);z-index:3}
  .k1{left:20px;top:18px}.k2{right:20px;top:18px}.k3{left:20px;bottom:18px}.k4{right:20px;bottom:18px}
  /* 角落绿植 */
  .plant{position:absolute;font-size:64px;z-index:4;filter:saturate(1.1)}
  .p1{left:40px;top:38px;transform:rotate(-18deg)}
  .p2{right:44px;top:34px;transform:rotate(14deg)}
  .p3{left:36px;bottom:36px;transform:rotate(160deg)}
  .p4{right:38px;bottom:40px;transform:rotate(-12deg)}
  /* 内容层 */
  .inner{position:absolute;left:96px;top:78px;width:1228px;height:944px}
  .title{text-align:center;font-size:48px;font-weight:800;color:#8b5e34;letter-spacing:2px;
         text-shadow:0 2px 0 rgba(255,255,255,.8)}
  .title .deco{font-size:38px;vertical-align:middle;margin:0 14px}
  .subtitle{text-align:center;font-size:24px;color:#7a6a4f;margin-top:8px}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-top:24px}
  .card{background:#fffdf5;border:3px solid #9cbb72;border-radius:14px;padding:20px 22px;position:relative;
        box-shadow:0 3px 8px rgba(90,60,20,.18)}
  .card::before{content:"";position:absolute;top:-11px;left:26px;width:92px;height:24px;
        background:rgba(226,200,140,.65);border-radius:3px;transform:rotate(-3deg)}
  .card::after{content:"";position:absolute;top:-11px;right:26px;width:92px;height:24px;
        background:rgba(226,200,140,.65);border-radius:3px;transform:rotate(3deg)}
  .card h2{font-size:27px;color:#5d4a2f;border-bottom:2px dashed #d8c39a;padding-bottom:8px}
  .emoji{position:absolute;top:-22px;right:16px;font-size:44px;z-index:2;
        background:#fffdf5;border:2.5px solid #c9a86a;border-radius:50%;width:62px;height:62px;
        display:flex;align-items:center;justify-content:center;box-shadow:0 2px 5px rgba(90,60,20,.25)}
  .line{font-size:21px;margin-top:12px;line-height:1.7}
  .blank{display:inline-block;min-width:220px;border-bottom:2px dotted #9a8563;height:26px;vertical-align:bottom;margin:0 6px}
  .box{display:inline-block;min-width:150px;border:2px dashed #b99b5e;border-radius:6px;height:30px;vertical-align:bottom;margin:0 6px;background:#fffef9}
  .checks{display:flex;flex-wrap:wrap;gap:12px 26px;margin-top:12px;font-size:21px}
  .card,.line,.checks span{overflow-wrap:break-word;word-break:break-word}
  .cb{width:22px;height:22px;border:2px solid #9a8563;border-radius:5px;display:inline-block;vertical-align:middle;margin-right:8px;background:#fffef9}
  table{width:100%;border-collapse:collapse;margin-top:12px;font-size:19px}
  th{background:repeating-linear-gradient(90deg,#e9d9a8 0 60px,#f3e8c8 60px 120px);color:#6b5433;padding:8px;border:1.5px solid #c9a86a}
  td{padding:8px;border:1.5px solid #d8c39a;text-align:center;background:#fffef9}
  .num{margin-top:10px;font-size:21px;line-height:2.1}
  .num b{display:inline-block;width:26px;height:26px;line-height:26px;text-align:center;background:repeating-linear-gradient(90deg,#e8d9ae,#d4c08c);border-radius:50%;margin-right:10px}
  .foot{text-align:center;margin-top:14px;font-size:18px;color:#a08a63}
</style></head><body>
  <div class="paper"></div>
  <div class="bamboo b-top"></div><div class="bamboo b-bottom"></div>
  <div class="bamboo b-left"></div><div class="bamboo b-right"></div>
  <div class="knot k1"></div><div class="knot k2"></div><div class="knot k3"></div><div class="knot k4"></div>
  <div class="plant p1">🎍</div><div class="plant p2">🌿</div>
  <div class="plant p3">🌾</div><div class="plant p4">🍃</div>
  <div class="inner">
  <div class="title"><span class="deco">🎋</span>${title}<span class="deco">🌾</span></div>
  ${subtitle}
  <div class="grid">${cards}</div>
  ${footer}
  </div>
</body></html>
`
}

// ── 渲染 ──

function hashHtml(html: string): string {
  // I-4：哈希渲染产物而非输入 JSON（键序漂移不破坏幂等；theme 变更自动区分）。
  return createHash("sha1").update(html).digest("hex").slice(0, 12)
}

/**
 * 渲染学案海报 PNG。成功 { ok, path, sections, blocks }；任何失败（Chrome 缺失/
 * 半截截图/目录故障）{ ok:false, error } 绝不抛错——环境故障走文本引导不进熔断器。
 */
export async function renderWorksheet(
  doc: WorksheetDoc,
  deps: WorksheetRenderDeps = {},
): Promise<WorksheetRenderResult> {
  const outDir = deps.outDir ?? DEFAULT_WORKSHEET_OUT_DIR
  const html = buildWorksheetHtml(doc)
  const finalPath = join(outDir, `worksheet-${hashHtml(html)}.png`)
  const screenshot = deps.screenshot
    ?? ((htmlPath: string, outPath: string) =>
      chromeScreenshotRunner(htmlPath, outPath, {
        chromePath: deps.chromePath,
        width: WORKSHEET_CANVAS_W,
        height: WORKSHEET_CANVAS_H,
      }))
  try {
    mkdirSync(outDir, { recursive: true })
    const tmp = mkdtempSync(join(outDir, "tmp-ws-"))
    try {
      const htmlPath = join(tmp, "page.html")
      const shotPath = join(tmp, "shot.png")
      writeFileSync(htmlPath, html, "utf8")
      await screenshot(htmlPath, shotPath)
      if (!isCompletePng(shotPath)) {
        return { ok: false, error: "截图不完整（PNG 缺 IEND 结束标记或过小，疑似白屏/半截）——可先以文字版学案继续，图片稍后再生成" }
      }
      renameSync(shotPath, finalPath)
      return {
        ok: true,
        path: finalPath,
        sections: doc.sections.length,
        blocks: countBlocks(doc.sections),
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  } catch (err) {
    // I-7b：自带最小透传文案（勿用 mindmap friendlyRenderError——其 ENOENT 文案是 graphviz 专属）。
    // M-3：绝对路径不进模型视野。
    const raw = String(err)
    const stripped = raw.replace(/\/(?:Users|tmp|home)\/[^\s'"]+/g, "<路径>")
    return { ok: false, error: stripped === raw ? raw : stripped }
  }
}

/** 供测试断言「esc 后文本逐字存在于 page.html」（I-8b 文字准确性 HTML 层确定性）。 */
export function readWorksheetHtml(htmlPath: string): string {
  return readFileSync(htmlPath, "utf8")
}
