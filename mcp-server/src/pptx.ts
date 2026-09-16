/**
 * 教师课件 PPT 渲染引擎（2026-09-16 方案
 * docs/superpowers/plans/2026-09-16-ltutor-pptx-tool.md，max 评审 5I/7M 已并入）。
 *
 * 混合路径（worksheet 同构，但无 Chrome 链路、更轻）：LLM 只产 slides JSON →
 * pptxgenjs 确定性渲染 16:9 .pptx → MEDIA: 投递链（网关 MEDIA_DELIVERY_EXTS 含 .pptx，
 * 企微原生文件消息，零网关改动）。
 *
 * 纪律沿袭 worksheet：
 * - caps 超限→文本引导不进熔断器；结构非法（PptxFormatError）handler 转 ToolArgumentError；
 * - 文件名 sha1(规范形 JSON)前 12（有意选择：哈希输入规范形而非渲染产物——模板/主题
 *   升级不轮换文件名，同内容静默覆盖（渲染不跳过已存在文件，覆盖无害）；需强制轮换时
 *   在规范形加模板版本常量。评审 M-3 明写）；
 * - 失败自带最小透传文案 + 绝对路径不进模型视野（勿 import mindmap friendlyRenderError）；
 * - 字号预算钉死（评审 M-5）：heading 30pt / bullet 18pt / 行距 1.25——最坏 6×80 字
 *   ≈12 行 ≈4.7in ≤ 版心可用 ~5.4in；
 * - fontFace 全钉 "Microsoft YaHei"（教师 Win 机标准字体；addNotes 无字体选项，
 *   备注字体由 PowerPoint notes master 决定，不做无谓尝试——评审 M-4）。
 */
import { createHash } from "node:crypto"
import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import pptxgenjs from "pptxgenjs"

// NodeNext/CJS 互操作坑：pptxgenjs 的 d.ts 用 ESM `export default`，而包是 CJS
// （module.exports = 类）——编译期默认导入解析到「模块命名空间」类型（无构造签名），
// 运行时默认导入又恰是类本身。桥接：命名空间类型的 .default 即类类型，经 unknown
// 转换取构造签名；实例类型 InstanceType 还原完整 d.ts 推断。
type PptxClass = (typeof pptxgenjs)["default"]
type PptxInstance = InstanceType<PptxClass>
const PptxGenJS = pptxgenjs as unknown as PptxClass

export const DEFAULT_PPTX_OUT_DIR = join(homedir(), ".hermes", "cache", "ltutor-pptx")

// ── caps（评审 I-1 口径钉死：单页 = heading + Σbullets（note 不进任何面板）；
//    总文本 = title + subtitle + Σ(heading+bullets)，沿 worksheet totalChars 先例计入
//    title/subtitle；多页满编 5500 > 总帽 2500 的全局挤压有意为之，报错引导精简/拆分）──
export const PPTX_MAX_TITLE_CHARS = 40
export const PPTX_MAX_SUBTITLE_CHARS = 60
export const PPTX_MAX_HEADING_CHARS = 30
export const PPTX_MAX_BULLET_CHARS = 80
export const PPTX_MAX_NOTE_CHARS = 120
export const PPTX_MAX_BULLETS_PER_SLIDE = 6
export const PPTX_MIN_SLIDES = 3
export const PPTX_MAX_SLIDES = 10
export const PPTX_MAX_PAGE_CHARS = 550
export const PPTX_MAX_TOTAL_CHARS = 2500

export interface PptxSlide {
  heading: string
  bullets: string[]
  note?: string
}

export interface PptxDoc {
  title: string
  subtitle?: string
  theme: "warm"
  slides: PptxSlide[]
}

export interface PptxRenderResult {
  ok: boolean
  path?: string
  slides?: number
  error?: string
}

/** 结构非法（类型/缺字段/空串）：handler 转 ToolArgumentError（WorksheetFormatError 先例）。 */
export class PptxFormatError extends Error {}

// ── 校验与归一 ──

function requireText(value: unknown, at: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new PptxFormatError(`${at} is required`)
  }
  return value.trim()
}

function optionalText(value: unknown, at: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string") throw new PptxFormatError(`${at} must be a string`)
  const trimmed = value.trim()
  return trimmed === "" ? undefined : trimmed
}

/** 控制字符压空格（M1 教训的 pptx 等价物；换行也压——bullets 是单行语义，防版式被 \n 打穿）。 */
function scrubControlChars(text: string): string {
  return text.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s{2,}/g, " ").trim()
}

/** 结构校验+归一（trim 语义，normalizeWorksheet 先例）；长度/数量帽归 pptxCapsError。 */
export function normalizePptx(raw: {
  title: unknown
  subtitle?: unknown
  theme?: unknown
  slides: unknown
}): PptxDoc {
  // 标题剥「课件/PPT」字样（worksheet 剥「学案」先例：标题=主题名本身；指引在
  // schema/flow，此处兜底保证规则恒成立）。剥空则拒。
  let title = scrubControlChars(requireText(raw.title, "title"))
  // 剥文档类型字样（评审 M-5 边角）：课件 + 半/全角 ppt/pptx（含前后悬挂点空）。
  title = title
    .replace(/课件/g, "")
    .replace(/[.\s]*[PpＰｐ][PpＰｐ][TtＴｔ][XxＸｘ]?[.\s]*/g, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/[.。．]+$/, "")
    .trim()
  if (title === "") {
    throw new PptxFormatError('title 不能只含「课件/PPT」等文档类型字样——请直接用主题名，如「一般过去时 The Past Simple Tense」')
  }
  const subtitleRaw = optionalText(raw.subtitle, "subtitle")
  const subtitle = subtitleRaw === undefined ? undefined : scrubControlChars(subtitleRaw)
  // theme：非字符串 fail-fast；字符串值非 warm 回落 warm（schema enum 已限，纵深防御）。
  if (raw.theme !== undefined && typeof raw.theme !== "string") {
    throw new PptxFormatError("theme must be a string")
  }

  if (!Array.isArray(raw.slides)) throw new PptxFormatError("slides must be an array")
  const slides = raw.slides.map((item, i): PptxSlide => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new PptxFormatError(`slides[${i}] must be an object`)
    }
    const rec = item as Record<string, unknown>
    const heading = scrubControlChars(requireText(rec.heading, `slides[${i}].heading`))
    if (!Array.isArray(rec.bullets)) throw new PptxFormatError(`slides[${i}].bullets must be an array`)
    if (rec.bullets.length < 1) {
      throw new PptxFormatError(`slides[${i}].bullets 不能为空——每页至少 1 条要点，如 ["过去式表示过去发生的动作"]`)
    }
    const bullets = rec.bullets.map((b, j) =>
      scrubControlChars(requireText(b, `slides[${i}].bullets[${j}]`)))
    const noteRaw = optionalText(rec.note, `slides[${i}].note`)
    const note = noteRaw === undefined ? undefined : scrubControlChars(noteRaw)
    return note === undefined ? { heading, bullets } : { heading, bullets, note }
  })
  return { title, subtitle, theme: "warm", slides }
}

// ── caps ──

function pageChars(slide: PptxSlide): number {
  return slide.heading.length + slide.bullets.reduce((n, b) => n + b.length, 0)
}

function totalChars(doc: PptxDoc): number {
  return doc.title.length + (doc.subtitle?.length ?? 0)
    + doc.slides.reduce((n, s) => n + pageChars(s), 0)
}

/** 量级闸（超限返回人类可读原因，handler 包裹成文本引导；字段级优先于页数/页级/总量）。 */
export function pptxCapsError(doc: PptxDoc): string | null {
  if (doc.title.length > PPTX_MAX_TITLE_CHARS) {
    return `标题 ${doc.title.length} 字符超过上限 ${PPTX_MAX_TITLE_CHARS}`
  }
  if ((doc.subtitle?.length ?? 0) > PPTX_MAX_SUBTITLE_CHARS) {
    return `副标题 ${doc.subtitle!.length} 字符超过上限 ${PPTX_MAX_SUBTITLE_CHARS}`
  }
  for (const [i, s] of doc.slides.entries()) {
    if (s.heading.length > PPTX_MAX_HEADING_CHARS) {
      return `第 ${i + 1} 页标题 ${s.heading.length} 字符超过上限 ${PPTX_MAX_HEADING_CHARS}`
    }
    if (s.bullets.length > PPTX_MAX_BULLETS_PER_SLIDE) {
      return `第 ${i + 1} 页有 ${s.bullets.length} 条要点超过上限 ${PPTX_MAX_BULLETS_PER_SLIDE}`
    }
    for (const [j, b] of s.bullets.entries()) {
      if (b.length > PPTX_MAX_BULLET_CHARS) {
        return `第 ${i + 1} 页第 ${j + 1} 条要点 ${b.length} 字符超过上限 ${PPTX_MAX_BULLET_CHARS}`
      }
    }
    if ((s.note?.length ?? 0) > PPTX_MAX_NOTE_CHARS) {
      return `第 ${i + 1} 页讲稿备注 ${s.note!.length} 字符超过上限 ${PPTX_MAX_NOTE_CHARS}`
    }
  }
  if (doc.slides.length < PPTX_MIN_SLIDES) {
    return `内容页 ${doc.slides.length} 页少于下限 ${PPTX_MIN_SLIDES}——课件至少 3 页，请补足内容或改出文字版大纲`
  }
  if (doc.slides.length > PPTX_MAX_SLIDES) {
    return `内容页 ${doc.slides.length} 页超过上限 ${PPTX_MAX_SLIDES}——请精简合并，或拆成两份课件`
  }
  for (const [i, s] of doc.slides.entries()) {
    if (pageChars(s) > PPTX_MAX_PAGE_CHARS) {
      return `第 ${i + 1} 页文本 ${pageChars(s)} 字符超过单页上限 ${PPTX_MAX_PAGE_CHARS}——请精简该页要点或拆页`
    }
  }
  if (totalChars(doc) > PPTX_MAX_TOTAL_CHARS) {
    return `全篇文本 ${totalChars(doc)} 字符超过总量上限 ${PPTX_MAX_TOTAL_CHARS}——请精简或拆成两份课件`
  }
  return null
}

// ── 渲染 ──

const FONT = "Microsoft YaHei"
const BG_WARM = "FBF7EF"      // 暖纸浅底（worksheet nature 家族感）
const INK_TITLE = "1F3A5F"    // 深蓝标题
const ACCENT_GOLD = "C9973B"  // 金色强调
const INK_BODY = "333333"

function canonicalJson(doc: PptxDoc): string {
  // 固定字面量键序重建（键序漂移不破坏幂等）；模板升级需强制轮换文件名时在此加版本常量。
  return JSON.stringify({
    theme: doc.theme,
    title: doc.title,
    subtitle: doc.subtitle ?? "",
    slides: doc.slides.map(s => ({
      heading: s.heading,
      bullets: s.bullets,
      note: s.note ?? "",
    })),
  })
}

function hashDoc(doc: PptxDoc): string {
  return createHash("sha1").update(canonicalJson(doc)).digest("hex").slice(0, 12)
}

function buildPresentation(doc: PptxDoc): PptxInstance {
  const pptx = new PptxGenJS()
  pptx.layout = "LAYOUT_WIDE"
  pptx.theme = { headFontFace: FONT, bodyFontFace: FONT }
  pptx.author = "LT 师训学习助手"

  // 封面页（渲染器自动生成，不算 slides 配额，总页数 = slides+1）。
  const cover = pptx.addSlide()
  cover.background = { color: BG_WARM }
  cover.addText(doc.title, {
    x: 0.8, y: 2.5, w: 11.7, h: 1.4,
    fontFace: FONT, fontSize: 40, bold: true, color: INK_TITLE, align: "center",
  })
  if (doc.subtitle) {
    cover.addText(doc.subtitle, {
      x: 0.8, y: 4.0, w: 11.7, h: 0.8,
      fontFace: FONT, fontSize: 20, color: INK_BODY, align: "center",
    })
  }
  cover.addText("— LT 师训 · 课堂课件 —", {
    x: 0.8, y: 6.3, w: 11.7, h: 0.5,
    fontFace: FONT, fontSize: 14, color: ACCENT_GOLD, align: "center",
  })

  // 内容页：heading 30pt + bullets 18pt / 行距 1.25（字号预算见文件头）。
  for (const slide of doc.slides) {
    const s = pptx.addSlide()
    s.background = { color: BG_WARM }
    s.addText(slide.heading, {
      x: 0.7, y: 0.45, w: 11.9, h: 0.9,
      fontFace: FONT, fontSize: 30, bold: true, color: INK_TITLE,
    })
    // 金色装饰条（评审 I-1 根修）：纯形状无文本——addText 首参是文本内容，
    // 旧写法把色值常量 "C9973B" 渲染成每页可见字串。
    s.addShape("rect", { x: 0.7, y: 1.4, w: 1.6, h: 0.06, fill: { color: ACCENT_GOLD } })
    s.addText(
      slide.bullets.map(text => ({
        text,
        options: { fontFace: FONT, fontSize: 18, color: INK_BODY, bullet: { characterCode: "2022" }, breakLine: true },
      })),
      { x: 0.9, y: 1.9, w: 11.5, h: 5.0, lineSpacingMultiple: 1.25, valign: "top" },
    )
    if (slide.note) s.addNotes(slide.note)
  }
  return pptx
}

/**
 * 渲染课件 .pptx。成功 { ok, path, slides }；任何失败（依赖/磁盘异常）{ ok:false, error }
 * 绝不抛错——环境故障走文本引导不进熔断器（renderWorksheet 先例）。
 */
export async function renderPptx(
  doc: PptxDoc,
  outDir: string = DEFAULT_PPTX_OUT_DIR,
): Promise<PptxRenderResult> {
  const finalPath = join(outDir, `pptx-${hashDoc(doc)}.pptx`)
  try {
    mkdirSync(outDir, { recursive: true })
    const pptx = buildPresentation(doc)
    await pptx.writeFile({ fileName: finalPath })
    return { ok: true, path: finalPath, slides: doc.slides.length }
  } catch (err) {
    // I-7b：自带最小透传（勿用 mindmap friendlyRenderError——graphviz 专属文案误导）。
    // M-3：绝对路径不进模型视野（含 macOS 真实 tmpdir /var/folders 与 /private 前缀——
    // mkdtempSync(tmpdir()) 的错误消息走解析后路径，只有 /tmp 前缀剥不干净）。
    const raw = String(err)
    const stripped = raw.replace(/\/(?:Users|tmp|home|var\/folders|private)\/[^\s'"]+/g, "<路径>")
    return { ok: false, error: stripped === raw ? raw : stripped }
  }
}
