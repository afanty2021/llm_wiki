// OKF v0.1 纯转换层：把 wiki markdown 只读转换为 OKF-conformant 字符串。
//
// 本模块是 okf-export.ts 的「纯函数子集」，被以下两方共享：
//   - okf-export.ts        （node:fs 版端到端导出，CLI/test 用）
//   - okf-export-tauri.ts  （Tauri invoke 版端到端导出，app webview 用）
//
// 关键约束：**零 node 内置依赖**（无 node:fs / node:path）。
// 原因：本模块会被 app webview（client bundle）间接 import
// （okf-export-section → okf-export-tauri → 本模块），任何 node:* 顶层 import
// 都会被 Vite externalize 给 client，运行时报 "Cannot access ..." 并白屏。
// 因此凡需要 basename/dirname 等路径工具处，一律自实现纯字符串版本。
//
// 依据 https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md
// 仅做硬性转换（frontmatter 格式修复 / timestamp 注入 / index.md & log.md 规整）。
//
// 零运行时依赖，纯 ESM。

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

export const RESERVED = new Set(["index.md", "log.md"])
const KEY_VALUE_RE = /^[A-Za-z0-9_-]+\s*:\s*\S/
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// ──────────────────────────────────────────────────────────────────
// P1: slug→path 索引（wikilink 双写）
// ──────────────────────────────────────────────────────────────────

/** slug → 候选 path 列表（bundle-relative，如 "concepts/foo.md"，不含 wiki/ 前缀）。 */
export type SlugIndex = Map<string, string[]>

/**
 * 遍历 relPaths 建 slug → path[] 索引（§3）。
 * - slug = basename 去 .md（与 wiki-graph fileNameToId 语义一致，但独立实现避免耦合/信息丢失）。
 * - 排除 reserved（index.md/log.md 非概念链接目标；其自身 body 双写复用本索引）。
 * - 精确匹配，不 normalize 大小写/空格。
 */
export function buildSlugIndex(relPaths: string[]): SlugIndex {
  const index: SlugIndex = new Map()
  for (const relPath of relPaths) {
    const name = basename(relPath)
    if (RESERVED.has(name)) continue
    const slug = name.replace(/\.md$/i, "")
    let arr = index.get(slug)
    if (!arr) {
      arr = []
      index.set(slug, arr)
    }
    arr.push(relPath)
  }
  return index
}

// ──────────────────────────────────────────────────────────────────
// P1: wikilink 双写（[[slug]] → [[slug]] ([Title](/path.md[#anchor]))）
// ──────────────────────────────────────────────────────────────────

/**
 * 对 body 中的 [[wikilink]] 就地双写标准 link（§4/§5）。
 *
 * ⚠️ 契约：入参 `body` **必须**是已剥离 frontmatter 的正文——调用方负责
 * splitStrictFence 分离后只传 body。绝不可传完整 content（fm 字段值里的
 * `[[...]]` 会被双写致 YAML 损坏）。
 *
 * - unique：追加 ([Title](/path.md[#anchor]))，Title = alias ?? slug
 * - ambiguous/dangling/self：原样保留（ambiguous 记 warning）
 * - 含 "/" 的相对路径 wikilink：原样保留
 * - 已知限制：反引号 fenced code block 内 skip；~~~ tilde 围栏与行内代码内暂不 skip（见 §5.3）
 */
export function doubleWriteWikilinks(
  body: string,
  slugIndex: SlugIndex,
  currentRelPath: string,
  warnings: string[],
): string {
  // 按 fenced code block 切段：捕获组（代码块）跳过，只双写 prose 段
  const segments = body.split(/(```[\s\S]*?```)/g)
  return segments
    .map((seg, i) => (i % 2 === 1 ? seg : rewriteProseWikilinks(seg, slugIndex, currentRelPath, warnings)))
    .join("")
}

/** prose 段内的 [[wikilink]] 双写（不含代码块）。 */
function rewriteProseWikilinks(
  prose: string,
  slugIndex: SlugIndex,
  currentRelPath: string,
  warnings: string[],
): string {
  return prose.replace(/\[\[([^\[\]]+?)\]\]/g, (full, inner: string) => {
    // 含 "/" 的相对路径形式 → slug 模糊，不双写（§4）
    if (inner.includes("/")) return full
    // linkPart = target[#anchor]，aliasPart = 纯 display（Obsidian：anchor 在 | 前）
    const [linkPart, aliasPart] = inner.split("|")
    const [slugRaw, anchorRaw] = linkPart.split(/#/)
    const slug = slugRaw.trim()
    if (!slug) return full
    const paths = slugIndex.get(slug)
    if (!paths || paths.length === 0) return full // dangling
    if (paths.length > 1) {
      warnings.push(`ambiguous wikilink [[${slug}]] → ${paths.length} paths: ${JSON.stringify(paths)}`)
      return full // ambiguous：宁可丢边不造错边
    }
    const path = paths[0]
    if (path === currentRelPath) return full // self
    // Title 来源（§4 决策 C）：有 alias 用 alias 原样；无 alias 用 slug 首字母大写。
    // 首字母大写为显示约定（spec §4 表示例：[[foo]] → [Foo]），与 slug 精确匹配（决策 E）正交。
    const title = aliasPart ? aliasPart.trim() : capitalizeFirst(slug)
    const anchor = anchorRaw && !anchorRaw.startsWith("^") ? `#${anchorRaw.trim()}` : ""
    return `${full} ([${title}](/${path}${anchor}))`
  })
}

/** 首字母大写（显示约定，仅用于无 alias 时的 title 文本）。 */
function capitalizeFirst(s: string): string {
  if (!s) return s
  return s.charAt(0).toUpperCase() + s.slice(1)
}

// 判断 relative() 返回值是否表示不同盘符的绝对路径（macOS/Linux: 以 / 开头；Windows: 以 X:\ 开头）
//
// exported for P0b-1 编排层（okf-export-tauri.ts）复用同一 outDir 防护判定，避免逻辑重复。
export function isAbsoluteLike(p: string): boolean {
  return p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p)
}

/**
 * 自实现 basename（纯字符串，无 node:path 依赖）。
 *
 * 行为对齐 node:path.posix.basename / node:path.win32.basename 的并集：
 *   - 同时识别 `/` 与 `\` 作为分隔符（生产 wiki 路径来自 macOS/Windows，relPath
 *     已被 `.replace(/\\/g, "/")` 归一，但 filename 入参可能是任意形式）。
 *   - 返回路径最后一段；无分隔符时原样返回。
 *
 * 与 node:path.basename 在本模块的实际调用点行为一致：
 *   - injectMinimalFrontmatter 的 `basename(filename)`：filename 是 relPath
 *     （POSIX 形式，如 "concepts/foo.md"），取末段 "foo.md"。
 *
 * 不实现 node:path 的 ext 去除参数（调用方自行 `.replace(/\.md$/i, "")`）。
 */
function basename(p: string): string {
  if (!p) return p
  const parts = p.split(/[/\\]/)
  return parts[parts.length - 1] || p
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
export const NO_CLOSING_FENCE = Symbol("no-closing-fence")
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

export function pickTimestampFromFields(fields: Map<string, string>): string | null {
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
export function mtimeDate(fileMtime: Date | undefined): string | null {
  return fileMtime?.toISOString().slice(0, 10) ?? null
}
