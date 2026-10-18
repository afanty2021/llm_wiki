/**
 * teacher_tutor_web_clip 核心层。
 * Task 1（§4.1/§4.2/§4.3 纯函数部分）：零 IO、零网络、零第三方依赖（仅 node:crypto）。
 * Task 2 在其上接取回/提取/写与提交：
 *   - §4.1 fetch 层 fetchWithGuards：DNS 全址过门 + undici 连接时钉 IP（anti-rebinding）
 *     + 手动重定向（逐跳复验、https→http 拒）+ Content-Type 白名单 + 10MB 流式帽
 *   - §4.2 正文提取 extractArticle：jsdom（禁外部资源）+ Readability + turndown(gfm)
 *   - §4.3 编排 orchestrateClip：取回→提取→判重→写与提交（恒 enqueue=失败自愈 I6）
 * 规格出处：
 *   - URL 归一化 + 判重路径：§4.3（归一化在前，urlhash8 = 归一化后 URL 的 sha256 前 8 位）
 *   - SSRF 门（默认拒绝、只放行公网单播）：§4.1
 *   - charset 嗅探链 + GBK 家族归一 + 乱码拒落库：§4.2
 */

import { createHash } from "node:crypto"
import type { LookupAddress } from "node:dns"
import { lookup as dnsLookup } from "node:dns/promises"
import { isIP, type LookupFunction } from "node:net"
import { createRequire } from "node:module"

import { Readability } from "@mozilla/readability"
import { JSDOM } from "jsdom"
import { Agent, request as undiciRequest } from "undici"
import TurndownService from "turndown"

import { LlmWikiApiClient } from "./api-client.js"

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
 * 标题 → kebab-slug（notes/ 命名惯例）。R10 修订（评审 M4）：**保留 CJK**——
 * `[\p{Script=Han}a-z0-9]` 之外的字符全替换 `-`（库内 transcripts 中文文件名+-hash
 * 后缀有大量先例，safe_resolve 无 unicode 限制）→ 压缩连续 `-` → 去首尾 → 截断 60。
 * 纯标点/空白标题（结果为空）→ 'clip'。
 * 例：《初中英语教师如何维持口语水平？》 → 初中英语教师如何维持口语水平
 */
export function kebabSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^\p{Script=Han}a-z0-9]+/gu, "-")
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

/** 剪藏页 frontmatter（Task 2 新增单一事实源：md 组稿与 upsertPage 请求体共用）。 */
export interface ClipFrontmatter {
  title: string
  source_url: string
  clipped_at: string
  clipped_by: string
  via: "teacher-tutor"
}

/** provenance 字段对象（键=英文短键，评审 M8）：POST /pages 的 frontmatter 体。 */
export function clipFrontmatter(o: SourceMarkdownInput): ClipFrontmatter {
  return {
    title: o.title,
    source_url: o.url,
    clipped_at: o.clippedAt,
    clipped_by: o.clippedBy,
    via: "teacher-tutor",
  }
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
  const fm = clipFrontmatter(o)
  const frontmatter = [
    `title: ${yamlQuote(fm.title)}`,
    `source_url: ${yamlQuote(fm.source_url)}`,
    `clipped_at: ${yamlQuote(fm.clipped_at)}`,
    `clipped_by: ${yamlQuote(fm.clipped_by)}`,
    `via: "teacher-tutor"`,
  ]
  return `---\n${frontmatter.join("\n")}\n---\n\n${o.body}`
}

// ── §4.1 fetch 层（Task 2）：DNS 全址过门 + 连接时钉 IP + 重定向手动复验 ───────

/** 请求超时（headers/body/connect 三处统一 20s）。 */
const REQUEST_TIMEOUT_MS = 20000
/** 手动重定向上限（超 3 跳 → too_many_redirects）。 */
const MAX_REDIRECT_HOPS = 3
/** 响应体硬帽（流式累计，超帽即撕流——不得先整缓冲）。 */
const MAX_BODY_BYTES = 10 * 1024 * 1024
/** 桌面 Safari UA 串（微信等站点对非浏览器 UA 返回降级壳）。 */
const CLIP_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15"
/** Content-Type 白名单（M7：含 application/xhtml+xml；按 `;` 分段后首段精确匹配）。 */
const ALLOWED_MEDIA_TYPES = new Set(["text/html", "application/xhtml+xml", "text/plain"])
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

/** 单跳响应（DI 接缝：测试注入假 body/destroy；生产为 undici 响应）。 */
export interface GuardedResponse {
  status: number
  location: string | null
  contentType: string | null
  body: AsyncIterable<Uint8Array>
  /** 流被放弃（超帽/错误/读毕）时撕裂底层连接；须幂等。 */
  destroy: () => void
}

/** fetchWithGuards 依赖接缝（测试注入 lookup/request；生产走 node:dns + undici）。 */
export interface FetchGuardsDeps {
  lookupAll?: (hostname: string) => Promise<LookupAddress[]>
  requestOnce?: (url: URL, pinned: LookupAddress) => Promise<GuardedResponse>
}

export interface FetchGuardResult {
  bytes: Uint8Array
  contentType: string | null
  finalUrl: string
}

/** URL.hostname 的 IPv6 字面量剥括号（`[2606:4700::1]` → `2606:4700::1`）。 */
function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname
}

/**
 * 解析并钉住连接地址（每跳调用）：
 * - host 是字面量 IP（IPv6 含 `[...]`）→ 跳过 DNS 直接逐个校验；
 * - 否则 DNS `lookup(all:true)` **全址过门**——任一地址不过 isPublicUnicast 即拒
 *   （评审 I1：不给「另选过门地址」留绕过面），全过后钉首个地址（验证与连接同一地址）。
 */
async function resolveAndPin(
  u: URL,
  lookupAll: (hostname: string) => Promise<LookupAddress[]>,
): Promise<LookupAddress> {
  const host = stripIpv6Brackets(u.hostname)
  const literalFamily = isIP(host)
  if (literalFamily !== 0) {
    if (!isPublicUnicast(host)) {
      throw new WebClipError("ssrf_blocked", `ssrf_blocked: ${u.hostname} ${explainRejection(host)}`)
    }
    return { address: host, family: literalFamily }
  }
  let addresses: LookupAddress[]
  try {
    addresses = await lookupAll(u.hostname)
  } catch (err) {
    throw new WebClipError(
      "dns_failed",
      `dns_failed: ${u.hostname} ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  if (addresses.length === 0) {
    throw new WebClipError("dns_failed", `dns_failed: ${u.hostname} resolved to no addresses`)
  }
  for (const addr of addresses) {
    if (!isPublicUnicast(addr.address)) {
      throw new WebClipError("ssrf_blocked", `ssrf_blocked: ${u.hostname} ${explainRejection(addr.address)}`)
    }
  }
  return addresses[0]!
}

/**
 * Content-Type 解析（M7 细节钉死）：按 `;` 分段 → 首段 trim+小写为媒体类型；
 * charset 参数走「分段 → 小写 → 去引号」——产物供白名单判定与 T1 sniffCharset 复核。
 */
export function parseContentType(header: string | null): { mediaType: string; charsetParam: string | null } {
  if (header === null) return { mediaType: "", charsetParam: null }
  const segments = header.split(";")
  const mediaType = (segments[0] ?? "").trim().toLowerCase()
  for (const segment of segments.slice(1)) {
    const m = /^\s*charset\s*=\s*(.*?)\s*$/i.exec(segment)
    if (m !== null) {
      return { mediaType, charsetParam: m[1]!.replace(/^"(.*)"$/, "$1").toLowerCase() }
    }
  }
  return { mediaType, charsetParam: null }
}

/** undici 多值头拼合（Set-Cookie 等重复头 join ", "）。 */
function headerValue(headers: Record<string, unknown>, name: string): string | null {
  const value = headers[name]
  if (value === undefined) return null
  return Array.isArray(value) ? value.join(", ") : String(value)
}

/**
 * 连接时钉 IP 的 lookup 钩子（anti-rebinding，评审 I2）：忽略入参 hostname，
 * 恒返回已验证地址——undici buildConnector 把 connect.* 透传给 net/tls.connect，
 * 故 TLS SNI / Host 头仍取 URL 域名，而 socket 连钉住的 IP。
 * （导出仅为单测直证「DNS 答案无法左右 socket 目标」这一安全性质。）
 */
export function pinnedLookup(pinned: LookupAddress): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all === true) {
      callback(null, [{ address: pinned.address, family: pinned.family }])
    } else {
      callback(null, pinned.address, pinned.family)
    }
  }
}

/** 生产单跳请求：每跳新建钉 IP Agent（剪藏为低频操作，逐跳 Agent 免复用状态）。 */
async function undiciRequestOnce(url: URL, pinned: LookupAddress): Promise<GuardedResponse> {
  const agent = new Agent({
    connect: { timeout: REQUEST_TIMEOUT_MS, lookup: pinnedLookup(pinned) },
  })
  let res: Awaited<ReturnType<typeof undiciRequest>>
  try {
    res = await undiciRequest(url, {
      dispatcher: agent,
      // 手动跳重定向（undici v8 移除 maxRedirections 选项且非零值直接抛错——
      // request() 缺省即不跟随重定向 ≡ maxRedirections: 0，逐跳复验在 fetchWithGuards）
      headersTimeout: REQUEST_TIMEOUT_MS,
      bodyTimeout: REQUEST_TIMEOUT_MS,
      headers: { "user-agent": CLIP_USER_AGENT },
    })
  } catch (err) {
    void agent.close().catch(() => {})
    throw new WebClipError(
      "fetch_failed",
      `fetch_failed: ${url.toString()} ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  return {
    status: res.statusCode,
    location: headerValue(res.headers, "location"),
    contentType: headerValue(res.headers, "content-type"),
    body: res.body,
    destroy: () => {
      res.body.destroy()
      void agent.close().catch(() => {})
    },
  }
}

/**
 * 带 SSRF 门的取回（Task 2 核心）：scheme 仅 http/https；每跳 DNS 全址过门 + 连接时
 * 钉 IP；重定向手动 ≤3 跳（新 URL 重走完整校验链，https→http 降级一律拒绝）；
 * Content-Type 白名单（text/html、application/xhtml+xml、text/plain）；10MB 流式帽
 * （逐 chunk 累计，超帽 destroy 流再抛——绝不先整缓冲）。
 */
export async function fetchWithGuards(normalizedUrl: string, deps: FetchGuardsDeps = {}): Promise<FetchGuardResult> {
  const lookupAll = deps.lookupAll ?? ((hostname: string) => dnsLookup(hostname, { all: true }))
  let current: URL
  try {
    current = new URL(normalizedUrl)
  } catch {
    throw new WebClipError("invalid_url", `invalid_url: ${normalizedUrl}`)
  }
  let hops = 0
  for (;;) {
    if (current.protocol !== "http:" && current.protocol !== "https:") {
      throw new WebClipError("bad_scheme", `bad_scheme: ${current.protocol} (only http/https)`)
    }
    const pinned = await resolveAndPin(current, lookupAll)
    const res = deps.requestOnce !== undefined
      ? await deps.requestOnce(current, pinned)
      : await undiciRequestOnce(current, pinned)
    if (REDIRECT_STATUSES.has(res.status) && res.location !== null) {
      res.destroy()
      hops += 1
      if (hops > MAX_REDIRECT_HOPS) {
        throw new WebClipError(
          "too_many_redirects",
          `too_many_redirects: exceeded ${MAX_REDIRECT_HOPS} hops at ${current.toString()}`,
        )
      }
      let next: URL
      try {
        next = new URL(res.location, current) // 相对 Location 按 RFC 3986 相对解析（M7）
      } catch {
        throw new WebClipError("invalid_url", `invalid_url: bad redirect Location "${res.location}" from ${current.toString()}`)
      }
      if (current.protocol === "https:" && next.protocol === "http:") {
        throw new WebClipError(
          "redirect_downgrade",
          `redirect_downgrade: ${current.toString()} -> ${next.toString()}`,
        )
      }
      current = next
      continue // 新 URL 重走完整校验链（scheme + DNS + 钉 IP）
    }
    const { mediaType, charsetParam } = parseContentType(res.contentType)
    if (!ALLOWED_MEDIA_TYPES.has(mediaType)) {
      res.destroy()
      throw new WebClipError("bad_content_type", `bad_content_type: ${res.contentType ?? "(none)"}`)
    }
    const chunks: Uint8Array[] = []
    let total = 0
    try {
      try {
        for await (const chunk of res.body) {
          total += chunk.byteLength
          if (total > MAX_BODY_BYTES) {
            throw new WebClipError("too_large", `too_large: body exceeded ${MAX_BODY_BYTES} bytes`)
          }
          chunks.push(chunk)
        }
      } catch (err) {
        // 中途断流（socket 断裂/RESET 等）也是取回失败——统一入错误族，不漏裸 undici 错误
        if (err instanceof WebClipError) throw err
        throw new WebClipError(
          "fetch_failed",
          `fetch_failed: body stream aborted at ${current.toString()} after ${total} bytes (${err instanceof Error ? err.message : String(err)})`,
        )
      }
    } finally {
      res.destroy()
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return {
      bytes,
      contentType: charsetParam !== null ? `${mediaType}; charset=${charsetParam}` : mediaType,
      finalUrl: current.toString(),
    }
  }
}

// ── §4.2 正文提取（Task 2）：jsdom（禁外部资源）+ Readability + turndown(gfm) ──

// CJS 互操作（对照 src/pptx.ts:41 注释）：readability/jsdom/turndown 均为 CJS，
// NodeNext+esModuleInterop 下 named/default import 直取；唯 turndown-plugin-gfm
// 无类型声明也无 @types 包——createRequire 按值加载 + 本地签名
// （其插件形状 = (service) => void，结构兼容 TurndownService.use 的 Plugin）。
const requireCjs = createRequire(import.meta.url)
const { gfm } = requireCjs("turndown-plugin-gfm") as { gfm: (service: TurndownService) => void }

/** 与桌面 Clipper 同引擎同质量（extension/clipper-core.js）：atx 标题 + 围栏代码 + gfm 表格。 */
const clipTurndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
})
clipTurndown.use(gfm)

export interface ExtractedArticle {
  title: string
  markdown: string
}

/**
 * 正文提取：`new JSDOM(html, { url })` 不开 resources/referrers（禁外部加载，顺带
 * 收窄图片面，M10）；Readability 解析；turndown 转 Markdown（gfm 表格保留）。
 * Readability null 或 turndown 后剥空白为空 → WebClipError('empty_content')
 * （微信失效文=200 空壳，Phase 0 实证）。title 取 Readability 结果，回落
 * document.title（空白折叠去空格），再回落 'clip'。
 */
export async function extractArticle(html: string, url: string): Promise<ExtractedArticle> {
  const dom = new JSDOM(html, { url })
  try {
    const doc = dom.window.document
    const article = new Readability(doc).parse()
    if (article === null) {
      throw new WebClipError("empty_content", `empty_content: Readability parse returned null (${url})`)
    }
    const markdown = clipTurndown.turndown(article.content ?? "")
    if (markdown.trim() === "") {
      throw new WebClipError("empty_content", `empty_content: extracted markdown is blank (${url})`)
    }
    const title = (article.title ?? "").trim() || doc.title.replace(/\s+/g, " ").trim() || "clip"
    return { title, markdown }
  } finally {
    dom.window.close()
  }
}

// ── §4.3 编排（Task 2）：取回→提取→判重→写与提交（恒 enqueue）─────────────────

/** orchestrateClip 消费的 API 面（LlmWikiApiClient 满足之；测试注入 fake）。 */
export interface ClipApiLike {
  getPage(path: string, projectId?: string): Promise<{ content: string; updated_at: string } | null>
  writeSource(path: string, contents: string, projectId?: string): Promise<void>
  upsertPage(
    path: string,
    md: string,
    frontmatter: object,
    projectId?: string,
  ): Promise<"created" | "skipped" | "updated">
  embedPage(path: string, projectId?: string, force?: boolean): Promise<unknown>
  createIngestJob(sourcePaths: string[], projectId?: string): Promise<{ job_id: string }>
}

/** orchestrateClip 依赖注入面（生产缺省自建；测试注入全 fake）。 */
export interface WebClipIo {
  /** 目标项目（"current"|uuid|数值 id——src-server 形态下为 TRAINING__PROJECT_ID 数值串）。 */
  projectId: string
  fetchHtml(url: string): Promise<FetchGuardResult>
  api: ClipApiLike
  /** 当前时刻 ISO（新建收藏的 clipped_at；测试注入固定值）。 */
  now(): string
}

export interface ClipOutcome {
  status: "created" | "already"
  title: string
  sourcePath: string
  pagePath: string
  jobId: string
  /** already 时携带（共享库语境 M5：回复能说「王老师已于…收藏」）。 */
  prevClippedAt?: string
  prevClippedBy?: string
}

/** 生产 io：fetchWithGuards + LlmWikiApiClient（env 同 client 约定）+ 真时钟。 */
export function defaultWebClipIo(): WebClipIo {
  return {
    projectId: (process.env.TRAINING__PROJECT_ID ?? "").trim() || "current",
    fetchHtml: (url: string) => fetchWithGuards(url),
    api: new LlmWikiApiClient(),
    now: () => new Date().toISOString(),
  }
}

/** 既有页 frontmatter 字符串值提取（本工具自产的双引号 YAML 标量走 JSON.parse 吸收转义）。 */
function frontmatterValue(md: string, key: string): string | undefined {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md)
  if (block === null) return undefined
  const m = new RegExp(`^${key}:\\s*(.*)$`, "m").exec(block[1]!)
  if (m === null) return undefined
  const raw = m[1]!.trim()
  if (raw === "") return undefined
  if (raw.startsWith('"')) {
    try {
      const parsed = JSON.parse(raw) as unknown
      return typeof parsed === "string" ? parsed : raw
    } catch {
      return raw
    }
  }
  return raw
}

/**
 * 核心编排（方案 §3 数据流 ①→⑧，每步都是契约）：
 * 1. 归一化 URL（I4）→ 取回 → charset 嗅探+解码 → 提取（empty_content 立即抛=零写入）
 * 2. 文件名用**提取后**的 title（标题要提取后才知）：clipFileName(title, normalized)
 * 3. 判重 api.getPage：存在 → clipped_at/by 原样保留不 bump（I5）+ status='already'；
 *    不存在 → now()/actor + status='created'
 * 4. sourceMd 组稿；changed（!existing || 内容差异）时才 writeSource + upsertPage
 * 5. 嵌入：upsert='created' → embed(force=false)；'updated' → embed(force=true)
 *   （内容已变须 force，服务端已嵌未 force=405 语义）；'skipped' → 不嵌
 * 6. **恒 createIngestJob([sourcePath])**（I6：重复剪藏也入队——ingested_files 按
 *    路径+内容哈希现成短路，成功=近零成本 no-op、失败=自动重试，失败死局不存在）
 */
export async function orchestrateClip(url: string, actor: string, io?: WebClipIo): Promise<ClipOutcome> {
  const eff = io ?? defaultWebClipIo()
  const normalized = normalizeUrl(url)
  const fetched = await eff.fetchHtml(normalized)
  const html = decodeBody(fetched.bytes, sniffCharset(fetched.contentType, fetched.bytes))
  const { title, markdown } = await extractArticle(html, fetched.finalUrl)
  const fileName = clipFileName(title, normalized)
  const sourcePath = `sources/clips/${fileName}`
  const pagePath = `clips/${fileName}`

  const existing = await eff.api.getPage(pagePath, eff.projectId)
  let clippedAt: string
  let clippedBy: string
  let prevClippedAt: string | undefined
  let prevClippedBy: string | undefined
  if (existing !== null) {
    prevClippedAt = frontmatterValue(existing.content, "clipped_at")
    prevClippedBy = frontmatterValue(existing.content, "clipped_by")
    clippedAt = prevClippedAt ?? eff.now() // 原样保留；缺落（异常页）补当前值
    clippedBy = prevClippedBy ?? actor
  } else {
    clippedAt = eff.now()
    clippedBy = actor
  }
  const status: ClipOutcome["status"] = existing !== null ? "already" : "created"

  const input: SourceMarkdownInput = { title, url: normalized, clippedAt, clippedBy, body: markdown }
  const sourceMd = buildSourceMarkdown(input)
  const changed = existing === null || existing.content !== sourceMd
  let upsert: "created" | "skipped" | "updated" = "skipped"
  if (changed) {
    await eff.api.writeSource(sourcePath, sourceMd, eff.projectId)
    upsert = await eff.api.upsertPage(pagePath, sourceMd, clipFrontmatter(input), eff.projectId)
  }
  if (upsert === "created") {
    await eff.api.embedPage(pagePath, eff.projectId, false)
  } else if (upsert === "updated") {
    await eff.api.embedPage(pagePath, eff.projectId, true)
  }
  const { job_id } = await eff.api.createIngestJob([sourcePath], eff.projectId)

  const outcome: ClipOutcome = { status, title, sourcePath, pagePath, jobId: job_id }
  if (status === "already") {
    outcome.prevClippedAt = prevClippedAt
    outcome.prevClippedBy = prevClippedBy
  }
  return outcome
}
