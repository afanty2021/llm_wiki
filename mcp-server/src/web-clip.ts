/**
 * teacher_tutor_web_clip 纯函数核心层（Task 1，方案 §4.1/§4.2/§4.3 纯函数部分）。
 *
 * 本模块零 IO、零网络、零第三方依赖（仅 node:crypto），供 Task 2 在其上接
 * fetch/正文提取/写与提交。规格出处：
 *   - URL 归一化 + 判重路径：§4.3（归一化在前，urlhash8 = 归一化后 URL 的 sha256 前 8 位）
 *   - SSRF 门（默认拒绝、只放行公网单播）：§4.1
 *   - charset 嗅探链 + GBK 家族归一 + 乱码拒落库：§4.2
 */

import { createHash } from "node:crypto"

/** 所有 web-clip 错误统一出口：code 机器可读（invalid_url / undecodable / ...），message 默认 = code。 */
export class WebClipError extends Error {
  readonly code: string

  constructor(code: string, message?: string) {
    super(message ?? code)
    this.name = "WebClipError"
    this.code = code
  }
}

// ── §4.3 URL 归一化 ─────────────────────────────────────────────────────────

/** 剥追踪参数白名单：utm_ 前缀全部 + 下列精确名（只剥白名单，不剥语义参数防误伤分页/文章 id）。 */
const TRACKING_QUERY_EXACT = new Set(["pass_ticket", "scene", "from", "isfromandroid", "src", "u_source"])

/** 微信公众号文章短路径形态（`/s/` + base64url 风格 id）：命中即丢弃全部 query。 */
const WEIXIN_SHORT_PATH = /^\/s\/[A-Za-z0-9_-]+$/

function isTrackingParam(name: string): boolean {
  return name.startsWith("utm_") || TRACKING_QUERY_EXACT.has(name)
}

/**
 * URL 归一化（判重前置，方案 I4）：scheme/host 小写、去 fragment、去默认端口
 * （http:80 / https:443）、剥追踪参数白名单、微信 `/s/<id>` 短路径丢全部 query、
 * 剩余参数按名排序（确定性）。解析失败 → WebClipError('invalid_url')。
 */
export function normalizeUrl(input: string): string {
  let u: URL
  try {
    u = new URL(input)
  } catch {
    throw new WebClipError("invalid_url", `invalid_url: ${input}`)
  }
  u.hash = ""
  if ((u.protocol === "http:" && u.port === "80") || (u.protocol === "https:" && u.port === "443")) {
    u.port = ""
  }
  const dropAllQuery = u.hostname === "mp.weixin.qq.com" && WEIXIN_SHORT_PATH.test(u.pathname)
  const kept = dropAllQuery
    ? []
    : Array.from(u.searchParams.entries()).filter(([name]) => !isTrackingParam(name))
  kept.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  u.search = kept.length === 0 ? "" : new URLSearchParams(kept).toString()
  return u.toString()
}

/** 归一化后 URL 的 sha256 hex 前 8 字符（判重路径成分，同 URL 恒同值）。 */
export function urlHash8(normalizedUrl: string): string {
  return createHash("sha256").update(normalizedUrl).digest("hex").slice(0, 8)
}

// ── §4.3 slug 与确定性路径 ──────────────────────────────────────────────────

/**
 * 标题 → kebab-slug（notes/ 命名惯例）：小写 → 非 [a-z0-9]+ 归 `-` → 压缩连续 `-`
 * → 去首尾 `-` → 截断 60 字符。纯 CJK 标题（结果为空）→ 'clip'。
 */
export function kebabSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
  return slug === "" ? "clip" : slug
}

/** 剪藏源文件名：`<标题slug>-<urlhash8>.md`（同 URL 恒同路径，替代撞名 -2 后缀）。 */
export function clipFileName(title: string, normalizedUrl: string): string {
  return `${kebabSlug(title)}-${urlHash8(normalizedUrl)}.md`
}

// ── §4.1 SSRF 门（默认拒绝，只放行公网单播） ────────────────────────────────

interface CidrRule {
  /** 网络地址（大端 BigInt，IPv4 32 位 / IPv6 128 位）。 */
  net: bigint
  /** 前缀掩码（同宽度）。 */
  mask: bigint
  /** CIDR 标注（错误信息用，如 "10.0.0.0/8"）。 */
  label: string
  /** 拒绝原因短名（错误信息用，如 "private"）。 */
  reason: string
}

function maskOf(bits: 32 | 128, prefix: number): bigint {
  const allOnes = (1n << BigInt(bits)) - 1n
  return prefix === bits ? allOnes : allOnes ^ ((1n << BigInt(bits - prefix)) - 1n)
}

function v4Rule(net: bigint, prefix: number, label: string, reason: string): CidrRule {
  return { net, mask: maskOf(32, prefix), label, reason }
}

function v6Rule(net: bigint, prefix: number, label: string, reason: string): CidrRule {
  return { net, mask: maskOf(128, prefix), label, reason }
}

/** IPv4 拒绝清单（§4.1：不落在任一即放行）。 */
const IPV4_DENY: readonly CidrRule[] = [
  v4Rule(0x00000000n, 8, "0.0.0.0/8", "this-network"),
  v4Rule(0x0a000000n, 8, "10.0.0.0/8", "private"),
  v4Rule(0x64400000n, 10, "100.64.0.0/10", "cgnat"),
  v4Rule(0x7f000000n, 8, "127.0.0.0/8", "loopback"),
  v4Rule(0xa9fe0000n, 16, "169.254.0.0/16", "link-local"),
  v4Rule(0xac100000n, 12, "172.16.0.0/12", "private"),
  v4Rule(0xc0000000n, 24, "192.0.0.0/24", "ietf-protocol-assignments"),
  v4Rule(0xc0000200n, 24, "192.0.2.0/24", "documentation"),
  v4Rule(0xc0a80000n, 16, "192.168.0.0/16", "private"),
  v4Rule(0xc6120000n, 15, "198.18.0.0/15", "benchmarking"),
  v4Rule(0xc6336400n, 24, "198.51.100.0/24", "documentation"),
  v4Rule(0xcb007100n, 24, "203.0.113.0/24", "documentation"),
  v4Rule(0xe0000000n, 4, "224.0.0.0/4", "multicast"),
  v4Rule(0xf0000000n, 4, "240.0.0.0/4", "reserved"),
]

/** IPv6 唯一放行范围：2000::/3 全球单播（§4.1：IPv6 默认拒绝，仅此段可过门）。 */
const IPV6_GLOBAL = v6Rule(0x2000n << 112n, 3, "2000::/3", "global-unicast")

/** 2000::/3 内的三段抠除（文档段 / 6to4 内嵌 v4 / Teredo）。 */
const IPV6_GLOBAL_CARVEOUTS: readonly CidrRule[] = [
  v6Rule(0x20010db8n << 96n, 32, "2001:db8::/32", "documentation"),
  v6Rule(0x2002n << 112n, 16, "2002::/16", "6to4"),
  v6Rule(0x20010000n << 96n, 32, "2001:0::/32", "teredo"),
]

/** 2000::/3 之外的常见段（仅用于 explainRejection 的可读错误信息，判定同走默认拒绝）。 */
const IPV6_KNOWN_NON_GLOBAL: readonly CidrRule[] = [
  v6Rule(0n, 128, "::/128", "unspecified"),
  v6Rule(1n, 128, "::1/128", "loopback"),
  v6Rule(0xffffn << 32n, 96, "::ffff:0:0/96", "v4-mapped"),
  v6Rule(0xfe80n << 112n, 10, "fe80::/10", "link-local"),
  v6Rule(0xfc00n << 112n, 7, "fc00::/7", "unique-local"),
  v6Rule(0xff00n << 112n, 8, "ff00::/8", "multicast"),
]

/** 严格点分四段十进制解析（拒前导零/十六进制/缺段），失败 → null（默认拒绝）。 */
function parseIpv4(input: string): bigint | null {
  const parts = input.split(".")
  if (parts.length !== 4) return null
  let value = 0n
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    if (part.length > 1 && part.startsWith("0")) return null
    const octet = Number(part)
    if (octet > 255) return null
    value = (value << 8n) | BigInt(octet)
  }
  return value
}

/** 严格 IPv6 解析（`::` 压缩至多一次、尾嵌 IPv4 点分四段、%zone 剥离），失败 → null。 */
function parseIpv6(input: string): bigint | null {
  let s = input
  const zone = s.indexOf("%")
  if (zone !== -1) s = s.slice(0, zone)

  // 尾部嵌入 IPv4（如 ::ffff:127.0.0.1）→ 折成两个 hextet 再统一处理
  const tailColon = s.lastIndexOf(":")
  if (tailColon !== -1) {
    const tail = s.slice(tailColon + 1)
    if (tail.includes(".")) {
      const v4 = parseIpv4(tail)
      if (v4 === null) return null
      s = `${s.slice(0, tailColon + 1)}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`
    }
  }

  const halves = s.split("::")
  if (halves.length > 2) return null
  let head: string[]
  let tailGroups: string[]
  if (halves.length === 2) {
    head = halves[0] === "" ? [] : halves[0].split(":")
    tailGroups = halves[1] === "" ? [] : halves[1].split(":")
  } else {
    head = s.split(":")
    tailGroups = []
  }
  const groups = [...head, ...tailGroups]
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null
  }
  // 无 `::` 必须整 8 组；有 `::` 压缩段至少代表一组零（总数 ≤ 7）
  if (halves.length === 1 && groups.length !== 8) return null
  if (halves.length === 2 && groups.length > 7) return null

  let value = 0n
  for (let i = 0; i < 8; i++) {
    value <<= 16n
    if (i < head.length) value |= BigInt(parseInt(head[i]!, 16))
    else if (i >= 8 - tailGroups.length) value |= BigInt(parseInt(tailGroups[i - (8 - tailGroups.length)]!, 16))
  }
  return value
}

function inCidr(value: bigint, rule: CidrRule): boolean {
  return (value & rule.mask) === rule.net
}

/**
 * SSRF 门判定（§4.1 评审 I1：默认拒绝、白名单放行）。
 * IPv4：不落在任一拒绝段；IPv6：仅 2000::/3 减三段抠除。解析不了 → false。
 * 与 explainRejection 同源：isPublicUnicast(ip) ⟺ explainRejection(ip) === null。
 */
export function isPublicUnicast(ip: string): boolean {
  return explainRejection(ip) === null
}

/**
 * 拒绝原因（fetch 层错误信息用）：命中拒绝段 → 该 CIDR 标注；解析不了 → unparseable；
 * 放行 → null。
 */
export function explainRejection(ip: string): string | null {
  const v4 = parseIpv4(ip)
  if (v4 !== null) {
    for (const rule of IPV4_DENY) {
      if (inCidr(v4, rule)) return `${ip} falls in ${rule.label} (${rule.reason})`
    }
    return null
  }
  const v6 = parseIpv6(ip)
  if (v6 !== null) {
    if (!inCidr(v6, IPV6_GLOBAL)) {
      for (const rule of IPV6_KNOWN_NON_GLOBAL) {
        if (inCidr(v6, rule)) return `${ip} falls in ${rule.label} (${rule.reason})`
      }
      return `${ip} is not within 2000::/3 global unicast`
    }
    for (const rule of IPV6_GLOBAL_CARVEOUTS) {
      if (inCidr(v6, rule)) return `${ip} falls in ${rule.label} (${rule.reason})`
    }
    return null
  }
  return `unparseable ip: ${ip}`
}

// ── §4.2 charset 嗅探链与解码 ───────────────────────────────────────────────

/** 别名归一：GBK 家族（超集兼容）统一走 gb18030（Node 内建 full-icu）。 */
const CHARSET_ALIAS: Record<string, string> = {
  gbk: "gb18030",
  gb2312: "gb18030",
  gb18030: "gb18030",
}

function normalizeEncoding(label: string): string {
  const lower = label.toLowerCase()
  return CHARSET_ALIAS[lower] ?? lower
}

/** 前 2048 字节转小写 ASCII 串（非 ASCII/控制字节折成空格，仅供 meta 正则扫描）。 */
function asciiHead(body: Uint8Array): string {
  let out = ""
  const end = Math.min(body.length, 2048)
  for (let i = 0; i < end; i++) {
    const b = body[i]!
    out += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : " "
  }
  return out.toLowerCase()
}

/**
 * charset 嗅探链（§4.2 评审 I3）：Content-Type charset > BOM（UTF-8/UTF-16LE/BE）
 * > HTML `<meta charset>` / `<meta http-equiv="content-type" content="...charset=...">`
 * （仅扫前 2048 字节，ASCII 不区分大小写）> 'utf-8'。GBK 家族归一为 'gb18030'。
 */
export function sniffCharset(contentTypeHeader: string | null, body: Uint8Array): string {
  if (contentTypeHeader !== null) {
    const m = /charset\s*=\s*["']?([A-Za-z0-9_.:+-]+)/i.exec(contentTypeHeader)
    if (m !== null) return normalizeEncoding(m[1]!)
  }
  if (body.length >= 3 && body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) return "utf-8"
  if (body.length >= 2 && body[0] === 0xff && body[1] === 0xfe) return "utf-16le"
  if (body.length >= 2 && body[0] === 0xfe && body[1] === 0xff) return "utf-16be"
  const head = asciiHead(body)
  // 单式覆盖两种 meta 形态：都含 `charset=` 属性
  const m = /<meta\s[^>]*charset\s*=\s*["']?\s*([a-z0-9_.:+-]+)/.exec(head)
  if (m !== null) return normalizeEncoding(m[1]!)
  return "utf-8"
}

/**
 * 解码响应体：TextDecoder 解码后 U+FFFD 替换字符占比 > 2% → WebClipError('undecodable')
 * （乱码绝不落共享库——一旦进库即被嵌入成永久污染）；编码标签非法同样归 undecodable。
 */
export function decodeBody(body: Uint8Array, encoding: string): string {
  let text: string
  try {
    text = new TextDecoder(encoding).decode(body)
  } catch {
    throw new WebClipError("undecodable", `undecodable: cannot decode body as ${encoding}`)
  }
  if (text.length > 0) {
    const replacements = text.split("\uFFFD").length - 1
    if (replacements / text.length > 0.02) {
      throw new WebClipError(
        "undecodable",
        `undecodable: replacement-char ratio ${((100 * replacements) / text.length).toFixed(1)}% exceeds 2% (${encoding})`,
      )
    }
  }
  return text
}

// ── §4.2/§4.3 源文件组稿 ───────────────────────────────────────────────────

export interface SourceMarkdownInput {
  title: string
  url: string
  clippedAt: string
  clippedBy: string
  body: string
}

/** YAML 双引号标量转义（\ 与 "）。 */
function yamlQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

/**
 * 组剪藏源文件：frontmatter（provenance 永久保留出处，便于清源）+ 空行 + 正文原样。
 * via 恒为 "teacher-tutor"（教师侧通道标记）。
 */
export function buildSourceMarkdown(o: SourceMarkdownInput): string {
  const frontmatter = [
    `title: ${yamlQuote(o.title)}`,
    `source_url: ${yamlQuote(o.url)}`,
    `clipped_at: ${yamlQuote(o.clippedAt)}`,
    `clipped_by: ${yamlQuote(o.clippedBy)}`,
    `via: "teacher-tutor"`,
  ]
  return `---\n${frontmatter.join("\n")}\n---\n\n${o.body}`
}
