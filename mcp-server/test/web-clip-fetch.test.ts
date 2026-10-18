// Task 2 测试：fetchWithGuards（SSRF 门/钉 IP/重定向/CT 白名单/10MB 流式帽）+
// extractArticle（Readability+turndown-gfm）+ orchestrateClip（全 fake io 编排契约）+
// api-client 剪藏写入链四新方法（照 test/api-client.test.ts 的 fetchImpl mock 模式）。
// 网络一概不真发：fetchWithGuards 经 FetchGuardsDeps 注入 lookup/requestOnce。
import assert from "node:assert/strict"
import type { LookupAddress } from "node:dns"
import { Readable } from "node:stream"
import { test } from "node:test"

import {
  ApiHttpError,
  ApiNotFoundError,
  LlmWikiApiClient,
} from "../src/api-client.js"
import {
  FetchGuardResult,
  GuardedResponse,
  WebClipError,
  WebClipIo,
  buildSourceMarkdown,
  clipFileName,
  extractArticle,
  fetchWithGuards,
  normalizeUrl,
  orchestrateClip,
  parseContentType,
  pinnedLookup,
  sniffCharset,
} from "../src/web-clip.js"

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

async function assertWebClipError(p: Promise<unknown>, code: string, messagePattern?: RegExp): Promise<void> {
  await assert.rejects(
    p,
    (err: unknown) =>
      err instanceof WebClipError
      && err.code === code
      && (messagePattern === undefined || messagePattern.test(err.message)),
  )
}

// ── fetchWithGuards 公共桩 ────────────────────────────────────────────────────

const PUBLIC_A: LookupAddress = { address: "93.184.216.34", family: 4 }
const PUBLIC_AAAA: LookupAddress = { address: "2606:4700::1111", family: 6 }

/** DNS 桩：表驱动 + 调用记录（未命中回退公网地址；私网目标须显式建表）。 */
function lookupStub(table: Record<string, LookupAddress[]> = {}): {
  lookupAll: (hostname: string) => Promise<LookupAddress[]>
  hosts: string[]
} {
  const hosts: string[] = []
  return {
    hosts,
    lookupAll: async (hostname: string) => {
      hosts.push(hostname)
      return table[hostname] ?? [PUBLIC_A]
    },
  }
}

/** 单跳响应桩：异步生成器 body 读 destroy 后即停（可观测「撕流后不再供给」）。 */
function resStub(o: {
  status?: number
  location?: string | null
  contentType?: string | null
  chunks?: Uint8Array[]
  onDestroy?: () => void
} = {}): { response: GuardedResponse; destroyed: () => boolean } {
  let destroyedFlag = false
  const chunks = o.chunks ?? [bytes("<html><body>ok</body></html>")]
  const body: AsyncIterable<Uint8Array> = (async function* () {
    for (const chunk of chunks) {
      if (destroyedFlag) return
      yield chunk
    }
  })()
  const response: GuardedResponse = {
    status: o.status ?? 200,
    location: o.location ?? null,
    contentType: o.contentType === undefined ? "text/html" : o.contentType,
    body,
    destroy: () => {
      destroyedFlag = true
      o.onDestroy?.()
    },
  }
  return { response, destroyed: () => destroyedFlag }
}

/** 顺序响应桩：按序出牌（越界复用最后一个），记录每跳 URL 与钉住地址。 */
function requestSeq(
  make: Array<(url: URL, pinned: LookupAddress) => GuardedResponse>,
): { requestOnce: (url: URL, pinned: LookupAddress) => Promise<GuardedResponse>; calls: Array<{ url: string; pinned: LookupAddress }> } {
  const calls: Array<{ url: string; pinned: LookupAddress }> = []
  let i = 0
  return {
    calls,
    requestOnce: async (url, pinned) => {
      calls.push({ url: url.toString(), pinned })
      const factory = make[Math.min(i, make.length - 1)]!
      i += 1
      return factory(url, pinned)
    },
  }
}

const MB = 1024 * 1024

// ── fetchWithGuards：成功路径与钉 IP 传递 ────────────────────────────────────

test("fetchWithGuards·200 成功：chunk 拼接 / CT 归一 / finalUrl / 钉首个过门地址", async () => {
  const look = lookupStub({ "example.com": [PUBLIC_A, PUBLIC_AAAA] })
  const seq = requestSeq([
    () => resStub({ chunks: [bytes("<html>头"), bytes("尾</html>")] }).response,
  ])
  const out = await fetchWithGuards("https://example.com/article?x=1", {
    lookupAll: look.lookupAll,
    requestOnce: seq.requestOnce,
  })
  assert.deepEqual(Array.from(out.bytes), Array.from(bytes("<html>头尾</html>")))
  assert.equal(out.contentType, "text/html")
  assert.equal(out.finalUrl, "https://example.com/article?x=1")
  assert.deepEqual(look.hosts, ["example.com"])
  assert.deepEqual(seq.calls[0]?.pinned, PUBLIC_A, "多 A/AAAA 记录取首个过门 IP（验证与连接同一地址）")
})

test("pinnedLookup·恒返回已验证地址（DNS 答案无法左右 socket 目标，anti-rebinding）", () => {
  const lookup = pinnedLookup({ address: "1.2.3.4", family: 4 })
  // all:true 形态（undici/net autoSelectFamily 会用）
  lookup("rebound.example", { all: true }, (err, addresses) => {
    assert.equal(err, null)
    assert.deepEqual(addresses, [{ address: "1.2.3.4", family: 4 }])
  })
  // 单址形态
  lookup("anything-else.example", {}, (err, address, family) => {
    assert.equal(err, null)
    assert.equal(address, "1.2.3.4")
    assert.equal(family, 4)
  })
})

// ── fetchWithGuards：scheme 与 SSRF 门（默认拒绝）────────────────────────────

test("fetchWithGuards·非 http/https scheme 拒（bad_scheme，DNS 未发起）", async () => {
  const look = lookupStub()
  await assertWebClipError(fetchWithGuards("ftp://example.com/x", { lookupAll: look.lookupAll }), "bad_scheme")
  await assertWebClipError(fetchWithGuards("file:///etc/passwd", { lookupAll: look.lookupAll }), "bad_scheme")
  assert.equal(look.hosts.length, 0, "scheme 检查在 DNS 之前")
})

test("fetchWithGuards·DNS 解析私网地址 → ssrf_blocked（message 带 explainRejection 的 CIDR）", async () => {
  const look = lookupStub({ "evil.example": [{ address: "10.1.2.3", family: 4 }] })
  await assertWebClipError(
    fetchWithGuards("https://evil.example/x", { lookupAll: look.lookupAll }),
    "ssrf_blocked",
    /10\.0\.0\.0\/8/,
  )
})

test("fetchWithGuards·多地址任一不过门即拒（含公网+私网混合 AAAA 场景）", async () => {
  const look = lookupStub({
    "mixed.example": [PUBLIC_A, { address: "192.168.0.9", family: 4 }],
    "v6.example": [PUBLIC_AAAA, { address: "::ffff:127.0.0.1", family: 6 }],
  })
  await assertWebClipError(
    fetchWithGuards("https://mixed.example/x", { lookupAll: look.lookupAll }),
    "ssrf_blocked",
    /192\.168\.0\.0\/16/,
  )
  await assertWebClipError(
    fetchWithGuards("https://v6.example/x", { lookupAll: look.lookupAll }),
    "ssrf_blocked",
    /::ffff:0:0\/96/,
  )
})

test("fetchWithGuards·字面量 IP host 跳过 DNS 直接校验：环回拒、公网过且钉住", async () => {
  const look = lookupStub()
  const seq = requestSeq([() => resStub().response])
  await assertWebClipError(
    fetchWithGuards("http://127.0.0.1:8080/x", { lookupAll: look.lookupAll, requestOnce: seq.requestOnce }),
    "ssrf_blocked",
    /127\.0\.0\.0\/8/,
  )
  assert.equal(look.hosts.length, 0, "字面量 IP 不走 DNS")
  assert.equal(seq.calls.length, 0)

  const out = await fetchWithGuards("https://93.184.216.34/a", {
    lookupAll: look.lookupAll,
    requestOnce: seq.requestOnce,
  })
  assert.equal(out.finalUrl, "https://93.184.216.34/a")
  assert.deepEqual(seq.calls[0]?.pinned, { address: "93.184.216.34", family: 4 })
  assert.equal(look.hosts.length, 0)
})

test("fetchWithGuards·IPv6 字面量（含 [] 括号）直接校验：::1 拒、全球单播放行", async () => {
  const look = lookupStub()
  const seq = requestSeq([() => resStub().response])
  await assertWebClipError(
    fetchWithGuards("http://[::1]/x", { lookupAll: look.lookupAll }),
    "ssrf_blocked",
    /::1\/128/,
  )
  await fetchWithGuards("http://[2606:4700::1111]/x", {
    lookupAll: look.lookupAll,
    requestOnce: seq.requestOnce,
  })
  assert.deepEqual(seq.calls[0]?.pinned, { address: "2606:4700::1111", family: 6 })
  assert.equal(look.hosts.length, 0)
})

test("fetchWithGuards·DNS 失败 / 空记录 → dns_failed", async () => {
  const thrower = async (hostname: string): Promise<LookupAddress[]> => {
    throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" })
  }
  await assertWebClipError(fetchWithGuards("https://nope.example/x", { lookupAll: thrower }), "dns_failed", /ENOTFOUND/)
  const empty = async (): Promise<LookupAddress[]> => []
  await assertWebClipError(fetchWithGuards("https://nope.example/x", { lookupAll: empty }), "dns_failed")
})

// ── fetchWithGuards：重定向链（逐跳复验 / 降级拒 / 跳数帽 / 相对解析）──────────

test("fetchWithGuards·重定向目标私网 → 逐跳复验拒绝（302 → 内网地址）", async () => {
  const look = lookupStub({
    "redirector.example": [PUBLIC_A],
    "inner.example": [{ address: "169.254.169.254", family: 4 }], // 云元数据端点
  })
  const first = resStub({ status: 302, location: "https://inner.example/creds" })
  const seq = requestSeq([() => first.response])
  await assertWebClipError(
    fetchWithGuards("https://redirector.example/a", { lookupAll: look.lookupAll, requestOnce: seq.requestOnce }),
    "ssrf_blocked",
    /169\.254\.0\.0\/16/,
  )
  assert.deepEqual(look.hosts, ["redirector.example", "inner.example"], "重定向目标重走 DNS 全址校验")
  assert.ok(first.destroyed(), "跳走前撕裂上一跳响应体")
  assert.equal(seq.calls.length, 1, "内网目标在请求前即拒")
})

test("fetchWithGuards·https→http 降级一律拒绝（redirect_downgrade）", async () => {
  const look = lookupStub()
  const seq = requestSeq([() => resStub({ status: 301, location: "http://example.com/plain" }).response])
  await assertWebClipError(
    fetchWithGuards("https://example.com/a", { lookupAll: look.lookupAll, requestOnce: seq.requestOnce }),
    "redirect_downgrade",
    /https:\/\/example\.com\/a -> http:\/\/example\.com\/plain/,
  )
  assert.equal(seq.calls.length, 1, "降级判定在第二跳请求之前")
})

test("fetchWithGuards·重定向超 3 跳 → too_many_redirects（恰 3 跳放行）", async () => {
  const look = lookupStub()
  const always302 = (url: URL) =>
    resStub({ status: 302, location: new URL(`/hop/${Math.random()}`, url).toString() }).response
  const endless = requestSeq(Array.from({ length: 10 }, () => always302))
  await assertWebClipError(
    fetchWithGuards("https://example.com/start", { lookupAll: look.lookupAll, requestOnce: endless.requestOnce }),
    "too_many_redirects",
  )
  assert.equal(endless.calls.length, 4, "初始 + 3 跳重定向后才计超")

  const ok3 = requestSeq([
    () => resStub({ status: 302, location: "https://example.com/r1" }).response,
    () => resStub({ status: 302, location: "https://example.com/r2" }).response,
    () => resStub({ status: 308, location: "https://example.com/final" }).response,
    () => resStub({ chunks: [bytes("<html><body>done</body></html>")] }).response,
  ])
  const out = await fetchWithGuards("https://example.com/start", {
    lookupAll: look.lookupAll,
    requestOnce: ok3.requestOnce,
  })
  assert.equal(out.finalUrl, "https://example.com/final")
  assert.equal(ok3.calls.length, 4)
})

test("fetchWithGuards·相对 Location 按 RFC 3986 相对解析（M7）", async () => {
  const look = lookupStub()
  const seq = requestSeq([
    () => resStub({ status: 302, location: "/next/page" }).response,
    () => resStub({ status: 302, location: "leaf.html" }).response,
    () => resStub().response,
  ])
  await fetchWithGuards("https://example.com/a/b?q=1", { lookupAll: look.lookupAll, requestOnce: seq.requestOnce })
  assert.equal(seq.calls[1]?.url, "https://example.com/next/page", "根相对")
  assert.equal(seq.calls[2]?.url, "https://example.com/next/leaf.html", "同目录相对（相对**当前跳** URL 解析）")
})

test("fetchWithGuards·重定向到非 http(s) scheme → bad_scheme", async () => {
  const look = lookupStub()
  const seq = requestSeq([() => resStub({ status: 302, location: "ftp://example.com/x" }).response])
  await assertWebClipError(
    fetchWithGuards("https://example.com/a", { lookupAll: look.lookupAll, requestOnce: seq.requestOnce }),
    "bad_scheme",
  )
})

test("fetchWithGuards·畸形 Location 头 → invalid_url（统一错误族，不漏裸 TypeError）", async () => {
  const look = lookupStub()
  const seq = requestSeq([() => resStub({ status: 302, location: "http://exa mple:坏/x" }).response])
  await assertWebClipError(
    fetchWithGuards("https://example.com/a", { lookupAll: look.lookupAll, requestOnce: seq.requestOnce }),
    "invalid_url",
    /bad redirect Location/,
  )
})

// ── fetchWithGuards：Content-Type 白名单与 charset 解析 ──────────────────────

test("fetchWithGuards·Content-Type 白名单外拒（bad_content_type）", async () => {
  const look = lookupStub()
  for (const contentType of [
    "application/pdf",
    "application/octet-stream",
    "text/htmlx", // 前缀近似串不算 text/html（`;` 分段后整段精确匹配）
    "image/svg+xml",
    null, // 缺失 Content-Type 同样默认拒绝
  ]) {
    const seq = requestSeq([() => resStub({ contentType }).response])
    await assertWebClipError(
      fetchWithGuards("https://example.com/x", { lookupAll: look.lookupAll, requestOnce: seq.requestOnce }),
      "bad_content_type",
    )
  }
})

test("fetchWithGuards·三种白名单媒体类型放行（含分段参数）", async () => {
  const look = lookupStub()
  for (const contentType of ["text/html", "application/xhtml+xml", "text/plain", "text/html; charset=utf-8"]) {
    const seq = requestSeq([() => resStub({ contentType, chunks: [bytes("x")] }).response])
    const out = await fetchWithGuards("https://example.com/x", {
      lookupAll: look.lookupAll,
      requestOnce: seq.requestOnce,
    })
    assert.ok(out.contentType !== null && out.contentType.startsWith(contentType.split(";")[0]!.trim()))
  }
})

test("parseContentType·charset 参数「分段→小写→去引号」（产物供 T1 sniffCharset 复核）", () => {
  assert.deepEqual(parseContentType('text/html; charset="GBK"'), { mediaType: "text/html", charsetParam: "gbk" })
  assert.deepEqual(parseContentType("text/plain;charset=UTF-8"), { mediaType: "text/plain", charsetParam: "utf-8" })
  assert.deepEqual(parseContentType("text/html"), { mediaType: "text/html", charsetParam: null })
  assert.deepEqual(parseContentType(null), { mediaType: "", charsetParam: null })
  // 端到端：归一化 header 直接喂 sniffCharset，GBK 家族归一 gb18030（T1 契约）
  const parsed = parseContentType('text/html; charset="GBK"')!
  const normalized = `${parsed.mediaType}; charset=${parsed.charsetParam}`
  assert.equal(normalized, "text/html; charset=gbk")
  assert.equal(sniffCharset(normalized, new Uint8Array([0xd6, 0xd0])), "gb18030")
})

// ── fetchWithGuards：10MB 流式帽 ─────────────────────────────────────────────

test("fetchWithGuards·10MB 流式帽：恰 10MB 放行，+1 字节即撕流拒（不得先整缓冲）", async () => {
  const look = lookupStub()
  const chunk = new Uint8Array(MB).fill(0x61)

  // 恰好 10MB：放行
  const atCap = resStub({ chunks: Array.from({ length: 10 }, () => chunk) })
  const seqOk = requestSeq([() => atCap.response])
  const ok = await fetchWithGuards("https://example.com/big", {
    lookupAll: look.lookupAll,
    requestOnce: seqOk.requestOnce,
  })
  assert.equal(ok.bytes.length, 10 * MB)

  // 10MB + 1 字节：too_large + destroy + 中途停止供给
  let yielded = 0
  const overChunks = Array.from({ length: 12 }, () => chunk)
  let destroyedFlag = false
  const body: AsyncIterable<Uint8Array> = (async function* () {
    for (const c of overChunks) {
      if (destroyedFlag) return
      yielded += 1
      yield c
    }
  })()
  const over: GuardedResponse = {
    status: 200,
    location: null,
    contentType: "text/html",
    body,
    destroy: () => {
      destroyedFlag = true
    },
  }
  const seqOver = requestSeq([() => over])
  await assertWebClipError(
    fetchWithGuards("https://example.com/big", { lookupAll: look.lookupAll, requestOnce: seqOver.requestOnce }),
    "too_large",
  )
  assert.ok(destroyedFlag, "超帽即 destroy 流")
  assert.ok(yielded < overChunks.length, `撕流后不再供给（yielded=${yielded} < ${overChunks.length}）`)
})

test("fetchWithGuards·流式帽对 node:stream Readable 同样生效（伪造 undici body 形态）", async () => {
  const look = lookupStub()
  const chunk = new Uint8Array(MB).fill(0x62)
  const stream = Readable.from(Array.from({ length: 11 }, () => chunk))
  const response: GuardedResponse = {
    status: 200,
    location: null,
    contentType: "text/html",
    body: stream,
    destroy: () => stream.destroy(),
  }
  const seq = requestSeq([() => response])
  await assertWebClipError(
    fetchWithGuards("https://example.com/stream", { lookupAll: look.lookupAll, requestOnce: seq.requestOnce }),
    "too_large",
  )
  assert.ok(stream.destroyed, "Readable 已 destroy")
})

// ── extractArticle ───────────────────────────────────────────────────────────

/** 长正文段落（Readability 有最小字符量门槛，真文章亦远超之）。 */
function paras(n: number): string {
  return Array.from(
    { length: n },
    (_, i) => `<p>这是用于剪藏测试的中文段落${i}，讨论初中英语教师在课堂上维持学生口语水平的方法与实践经验总结。</p>`,
  ).join("")
}

function articlePage(title: string, bodyInner: string): string {
  return (
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title></head><body>` +
    `<article><h1>${title}</h1>${bodyInner}</article></body></html>`
  )
}

test("extractArticle·普通文章：title 与正文 markdown 提取，中文原样", async () => {
  const html = articlePage("初中英语教师如何维持口语水平", paras(12))
  const { title, markdown } = await extractArticle(html, "https://example.com/a")
  assert.equal(title, "初中英语教师如何维持口语水平")
  assert.ok(markdown.includes("口语水平"), "正文关键词在")
  assert.ok(!markdown.includes("<p>"), "HTML 标签已转 markdown")
})

test("extractArticle·表格保留（turndown-plugin-gfm）", async () => {
  const table = '<table><thead><tr><th>方法</th><th>效果</th></tr></thead>'
    + '<tbody><tr><td>复述</td><td>好</td></tr><tr><td>跟读</td><td>中</td></tr></tbody></table>'
  const { markdown } = await extractArticle(articlePage("表格页", paras(6) + table), "https://example.com/t")
  assert.match(markdown, /\| 方法 \| 效果 \|/)
  assert.match(markdown, /\| --- \| --- \|/)
  assert.match(markdown, /\| 复述 \| 好 \|/)
})

test("extractArticle·微信 js_content 形态：rich_media 页面正文可提取", async () => {
  const wx = `<html><head><meta charset="utf-8"><title>初中英语教师如何维持口语水平</title></head><body>`
    + `<div class="rich_media_area_primary"><div class="rich_media_title" id="activity-name">初中英语教师如何维持口语水平</div>`
    + `<div id="js_content" style="opacity: 0;">${paras(10)}</div></div></body></html>`
  const { title, markdown } = await extractArticle(wx, "https://mp.weixin.qq.com/s/abc")
  assert.equal(title, "初中英语教师如何维持口语水平")
  assert.ok(markdown.includes("口语水平"))
})

test("extractArticle·script/style 剥除", async () => {
  const html = articlePage(
    "带脚本页",
    paras(8) + '<script>var secret="SCRIPTTOKEN";</script><style>.body{color:red}</style>',
  )
  const { markdown } = await extractArticle(html, "https://example.com/s")
  assert.ok(!markdown.includes("SCRIPTTOKEN"), "script 内容不进 markdown")
  assert.ok(!markdown.includes("color:red"), "style 内容不进 markdown")
})

test("extractArticle·空壳页面（微信失效文=200 空壳）→ WebClipError('empty_content')", async () => {
  const dead = `<html><head><meta charset="utf-8"><title>该内容已被发布者删除</title></head><body>`
    + `<div id="js_content"></div></body></html>`
  await assertWebClipError(extractArticle(dead, "https://mp.weixin.qq.com/s/dead"), "empty_content")
})

test("extractArticle·title 回落链：无 title/h1 → 'clip'", async () => {
  const html = `<html><body><article>${paras(12)}</article></body></html>`
  const { title, markdown } = await extractArticle(html, "https://example.com/x")
  assert.equal(title, "clip", "Readability 空 title + document.title 空 → clip")
  assert.ok(markdown.length > 0)
})

// ── orchestrateClip（全 fake io）──────────────────────────────────────────────

interface FakeCall {
  method: "fetchHtml" | "getPage" | "writeSource" | "upsertPage" | "embedPage" | "createIngestJob"
  args: unknown[]
}

function clipHtml(title: string): string {
  return articlePage(title, paras(10))
}

function fakeIo(o: {
  existing?: { content: string; updated_at: string } | null
  upsertResult?: "created" | "skipped" | "updated"
  now?: string
  projectId?: string
  html?: string
}): { io: WebClipIo; calls: FakeCall[] } {
  const calls: FakeCall[] = []
  const record = (method: FakeCall["method"], ...args: unknown[]): void => {
    calls.push({ method, args })
  }
  const io: WebClipIo = {
    projectId: o.projectId ?? "7",
    fetchHtml: async (url: string): Promise<FetchGuardResult> => {
      record("fetchHtml", url)
      return {
        bytes: bytes(o.html ?? clipHtml("初中英语教师如何维持口语水平")),
        contentType: "text/html; charset=utf-8",
        finalUrl: url,
      }
    },
    api: {
      getPage: async (path: string, projectId?: string) => {
        record("getPage", path, projectId)
        return o.existing ?? null
      },
      writeSource: async (path: string, contents: string, projectId?: string) => {
        record("writeSource", path, contents, projectId)
      },
      upsertPage: async (path: string, md: string, frontmatter: object, projectId?: string) => {
        record("upsertPage", path, md, frontmatter, projectId)
        return o.upsertResult ?? "created"
      },
      embedPage: async (path: string, projectId?: string, force?: boolean) => {
        record("embedPage", path, projectId, force)
        return { path }
      },
      createIngestJob: async (sourcePaths: string[], projectId?: string) => {
        record("createIngestJob", sourcePaths, projectId)
        return { job_id: "job-123" }
      },
    },
    now: () => o.now ?? "2026-10-18T08:00:00.000Z",
  }
  return { io, calls }
}

const CLIP_URL = "https://mp.weixin.qq.com/s/abc?scene=1&chksm=x"
const CLIP_TITLE = "初中英语教师如何维持口语水平"

function expectedPaths(): { sourcePath: string; pagePath: string } {
  const fileName = clipFileName(CLIP_TITLE, normalizeUrl(CLIP_URL))
  return { sourcePath: `sources/clips/${fileName}`, pagePath: `clips/${fileName}` }
}

test("orchestrateClip·新建流：调用序与精确路径；frontmatter 组稿；embed 不 force；恒 enqueue", async () => {
  const { io, calls } = fakeIo({ existing: null })
  const outcome = await orchestrateClip(CLIP_URL, "李老师", io)

  assert.deepEqual(
    calls.map((c) => c.method),
    ["fetchHtml", "getPage", "writeSource", "upsertPage", "embedPage", "createIngestJob"],
  )
  const { sourcePath, pagePath } = expectedPaths()
  assert.equal(calls[0]?.args[0], "https://mp.weixin.qq.com/s/abc", "fetchHtml 收到归一化 URL（微信短路径丢参）")
  assert.equal(calls[1]?.args[0], pagePath)
  assert.equal(calls[1]?.args[1], "7")
  assert.equal(calls[2]?.args[0], sourcePath)
  assert.equal(calls[3]?.args[0], pagePath)
  assert.deepEqual(calls[5]?.args[0], [sourcePath], "ingest 入队源路径")
  assert.equal(calls[5]?.args[1], "7")

  // sourceMd 快照：clipped_at=注入 now，clipped_by=actor，正文=提取产物
  const expectedMd = buildSourceMarkdown({
    title: CLIP_TITLE,
    url: "https://mp.weixin.qq.com/s/abc",
    clippedAt: "2026-10-18T08:00:00.000Z",
    clippedBy: "李老师",
    body: (await extractArticle(clipHtml(CLIP_TITLE), CLIP_URL)).markdown,
  })
  assert.equal(calls[2]?.args[1], expectedMd)
  assert.equal(calls[3]?.args[1], expectedMd, "页面内容与源文件同文")
  assert.deepEqual(calls[3]?.args[2], {
    title: CLIP_TITLE,
    source_url: "https://mp.weixin.qq.com/s/abc",
    clipped_at: "2026-10-18T08:00:00.000Z",
    clipped_by: "李老师",
    via: "teacher-tutor",
  }, "upsertPage frontmatter 与 md 组稿同源")

  assert.deepEqual(calls[4]?.args, [pagePath, "7", false], "新建 → embed 不 force")
  assert.deepEqual(outcome, {
    status: "created",
    title: CLIP_TITLE,
    sourcePath,
    pagePath,
    jobId: "job-123",
  })
})

test("orchestrateClip·同文重存：skipped 零写放大但仍 enqueue，clipped_at/by 原样保留（I5/I6）", async () => {
  // 第一遍新建，捕获写入内容
  const first = fakeIo({ existing: null })
  await orchestrateClip(CLIP_URL, "李老师", first.io)
  const written = first.calls.find((c) => c.method === "writeSource")!.args[1] as string

  // 第二遍：库内已有同文 → 不重写不重嵌，但恒 enqueue
  const second = fakeIo({ existing: { content: written, updated_at: "2026-10-01T00:00:00Z" } })
  const outcome = await orchestrateClip(CLIP_URL, "王老师", second.io)

  assert.deepEqual(
    second.calls.map((c) => c.method),
    ["fetchHtml", "getPage", "createIngestJob"],
    "同文：零写入零嵌入，恒 enqueue",
  )
  assert.equal(outcome.status, "already")
  assert.equal(outcome.prevClippedAt, "2026-10-18T08:00:00.000Z", "prev 取自库内 frontmatter")
  assert.equal(outcome.prevClippedBy, "李老师", "共享库语境 M5：能说「已于…由谁收藏」")
  const { sourcePath } = expectedPaths()
  assert.deepEqual(second.calls[2]?.args[0], [sourcePath])
})

test("orchestrateClip·正文变更：updated + embed force=true，clipped_at 不 bump", async () => {
  const existingMd = buildSourceMarkdown({
    title: CLIP_TITLE,
    url: "https://mp.weixin.qq.com/s/abc",
    clippedAt: "2026-01-01T00:00:00.000Z",
    clippedBy: "王老师",
    body: "# 旧版正文",
  })
  const { io, calls } = fakeIo({
    existing: { content: existingMd, updated_at: "2026-01-01T00:00:00Z" },
    upsertResult: "updated",
  })
  const outcome = await orchestrateClip(CLIP_URL, "李老师", io)

  const { pagePath } = expectedPaths()
  assert.deepEqual(calls.map((c) => c.method), ["fetchHtml", "getPage", "writeSource", "upsertPage", "embedPage", "createIngestJob"])
  assert.deepEqual(calls[4]?.args, [pagePath, "7", true], "内容已变 → embed force=true（服务端已嵌未 force=405 语义）")
  const rewritten = calls.find((c) => c.method === "writeSource")!.args[1] as string
  assert.match(rewritten, /clipped_at: "2026-01-01T00:00:00\.000Z"/, "重复剪藏保原 clipped_at 不 bump")
  assert.match(rewritten, /clipped_by: "王老师"/, "保原 clipped_by")
  assert.equal(outcome.status, "already")
  assert.equal(outcome.prevClippedBy, "王老师")
})

test("orchestrateClip·空壳正文：empty_content 立即抛，零写入零入队", async () => {
  const { io, calls } = fakeIo({
    html: '<html><head><title>该内容已被发布者删除</title></head><body><div id="js_content"></div></body></html>',
  })
  await assertWebClipError(orchestrateClip(CLIP_URL, "李老师", io), "empty_content")
  assert.deepEqual(
    calls.map((c) => c.method),
    ["fetchHtml"],
    "empty_content 在任何 api 写入/入队之前抛出（取回本身已发生）",
  )
})

test("orchestrateClip·库内页缺 frontmatter（异常页）：clipped_at/by 补当前值，仍走写入", async () => {
  const { io, calls } = fakeIo({ existing: { content: "# 旧页无 frontmatter", updated_at: "2026-01-01T00:00:00Z" } })
  const outcome = await orchestrateClip(CLIP_URL, "李老师", io)
  const rewritten = calls.find((c) => c.method === "writeSource")!.args[1] as string
  assert.match(rewritten, /clipped_at: "2026-10-18T08:00:00\.000Z"/, "缺落时补 now()")
  assert.match(rewritten, /clipped_by: "李老师"/)
  assert.equal(outcome.status, "already")
  assert.equal(outcome.prevClippedAt, undefined)
})

// ── api-client 剪藏写入链四新方法（照 test/api-client.test.ts mock 模式）────

interface RecordedRequest {
  method: string
  url: string
  body?: string
  headers: Record<string, string>
}

function recordingFetch(respond: (req: RecordedRequest) => Response): {
  fetchImpl: typeof fetch
  requests: RecordedRequest[]
} {
  const requests: RecordedRequest[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const req: RecordedRequest = {
      method: String(init?.method ?? "GET"),
      url: String(input),
      body: init?.body === undefined ? undefined : String(init.body),
      headers: (init?.headers ?? {}) as Record<string, string>,
    }
    requests.push(req)
    return respond(req)
  }) as typeof fetch
  return { fetchImpl, requests }
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })

const PAGE_MD = "---\ntitle: \"t\"\n---\n\n正文"

test("writeSource·POST /files/:id/write，body {path, contents}（对照 src-server files.rs）", async () => {
  const { fetchImpl, requests } = recordingFetch(() => json({ status: "ok", path: "sources/clips/a.md" }, 201))
  const client = new LlmWikiApiClient({ fetchImpl })
  await client.writeSource("sources/clips/a.md", PAGE_MD)
  assert.equal(requests[0]?.method, "POST")
  assert.equal(requests[0]?.url, "http://127.0.0.1:19828/api/v1/files/current/write")
  assert.deepEqual(JSON.parse(requests[0]?.body ?? ""), { path: "sources/clips/a.md", contents: PAGE_MD })
})

test("getPage·200 返回 {content, updated_at}；404 → null；其他错误照抛", async () => {
  const ok = recordingFetch(() => json({ path: "clips/a.md", content: PAGE_MD, updated_at: "2026-01-02T03:04:05Z" }))
  const clientOk = new LlmWikiApiClient({ fetchImpl: ok.fetchImpl })
  assert.deepEqual(await clientOk.getPage("clips/a.md"), { content: PAGE_MD, updated_at: "2026-01-02T03:04:05Z" })
  assert.equal(ok.requests[0]?.url, "http://127.0.0.1:19828/api/v1/projects/current/page?path=clips%2Fa.md")

  const gone = recordingFetch(() => json({ error: { code: "NOT_FOUND", message: "page" } }, 404))
  const clientGone = new LlmWikiApiClient({ fetchImpl: gone.fetchImpl })
  assert.equal(await clientGone.getPage("clips/a.md"), null)

  const boom = recordingFetch(() => json({ error: { message: "boom" } }, 500))
  const clientBoom = new LlmWikiApiClient({ fetchImpl: boom.fetchImpl })
  await assert.rejects(() => clientBoom.getPage("clips/a.md"), (err: unknown) => err instanceof ApiHttpError && err.status === 500)
})

test("upsertPage·POST 直建 → created（无后续 GET/PUT）", async () => {
  const { fetchImpl, requests } = recordingFetch(() => json({ path: "clips/a.md", content: PAGE_MD }, 201))
  const client = new LlmWikiApiClient({ fetchImpl })
  assert.equal(await client.upsertPage("clips/a.md", PAGE_MD, { title: "t" }), "created")
  assert.equal(requests.length, 1)
  assert.equal(requests[0]?.url, "http://127.0.0.1:19828/api/v1/projects/current/pages")
  assert.deepEqual(JSON.parse(requests[0]?.body ?? ""), { path: "clips/a.md", content: PAGE_MD, frontmatter: { title: "t" } })
})

test("upsertPage·409 + 服务端同文（sha256 一致）→ skipped", async () => {
  const { fetchImpl, requests } = recordingFetch((req) => {
    if (req.method === "POST") return json({ error: "path already exists in this project" }, 409)
    if (req.method === "GET") return json({ path: "clips/a.md", content: PAGE_MD, updated_at: "2026-01-02T03:04:05Z" })
    throw new Error(`unexpected ${req.method} ${req.url}`)
  })
  const client = new LlmWikiApiClient({ fetchImpl })
  assert.equal(await client.upsertPage("clips/a.md", PAGE_MD, { title: "t" }), "skipped")
  assert.deepEqual(
    requests.map((r) => r.method),
    ["POST", "GET"],
    "同文即止：不发 PUT",
  )
})

test("upsertPage·409 + 内容漂移 → PUT 带 if-match: <GET updated_at> → updated", async () => {
  const { fetchImpl, requests } = recordingFetch((req) => {
    if (req.method === "POST") return json({ error: "path already exists in this project" }, 409)
    if (req.method === "GET") return json({ path: "clips/a.md", content: "# 服务端他版", updated_at: "2026-01-02T03:04:05Z" })
    if (req.method === "PUT") return json({ path: "clips/a.md", content: PAGE_MD, updated_at: "2026-01-03T00:00:00Z" })
    throw new Error(`unexpected ${req.method}`)
  })
  const client = new LlmWikiApiClient({ fetchImpl })
  assert.equal(await client.upsertPage("clips/a.md", PAGE_MD, { title: "t" }), "updated")
  const put = requests.find((r) => r.method === "PUT")
  assert.ok(put, "应发 PUT")
  assert.equal(put?.url, "http://127.0.0.1:19828/api/v1/projects/current/page?path=clips%2Fa.md")
  assert.equal(put?.headers["if-match"], "2026-01-02T03:04:05Z", "If-Match = GET 预检的 updated_at")
  assert.deepEqual(JSON.parse(put?.body ?? ""), { path: "clips/a.md", content: PAGE_MD, frontmatter: { title: "t" } })
})

test("upsertPage·PUT 连续 409 → 整轮重试 ≤3 后成功（镜像 transcriber 轮次）", async () => {
  let putCount = 0
  const { fetchImpl, requests } = recordingFetch((req) => {
    if (req.method === "POST") return json({ error: "conflict" }, 409)
    if (req.method === "GET") return json({ path: "clips/a.md", content: `# 服务端版本${putCount}`, updated_at: `2026-01-02T03:04:0${putCount}Z` })
    putCount += 1
    return putCount < 3 ? json({ error: "updated_at mismatch" }, 409) : json({ path: "clips/a.md", content: PAGE_MD }, 200)
  })
  const client = new LlmWikiApiClient({ fetchImpl })
  assert.equal(await client.upsertPage("clips/a.md", PAGE_MD, { title: "t" }), "updated")
  assert.equal(putCount, 3, "第 3 轮 PUT 成功")
  assert.equal(requests.filter((r) => r.method === "GET").length, 3, "每轮重新 GET 预检")
})

test("upsertPage·3 轮 PUT 均 409 → 抛错（有界重试）", async () => {
  const { fetchImpl, requests } = recordingFetch((req) => {
    if (req.method === "POST") return json({ error: "conflict" }, 409)
    if (req.method === "GET") return json({ path: "clips/a.md", content: "# 他版", updated_at: "2026-01-02T03:04:05Z" })
    return json({ error: "updated_at mismatch (stale write or page not found)" }, 409)
  })
  const client = new LlmWikiApiClient({ fetchImpl })
  await assert.rejects(
    () => client.upsertPage("clips/a.md", PAGE_MD, { title: "t" }),
    /upsertPage clips\/a\.md: If-Match conflict persisted after 3 rounds/,
  )
  assert.equal(requests.filter((r) => r.method === "PUT").length, 3, "PUT 恰 3 次")
})

test("upsertPage·非 409 错误（如 401/500）原样上抛", async () => {
  const { fetchImpl } = recordingFetch(() => json({ error: { message: "Unauthorized" } }, 401))
  const client = new LlmWikiApiClient({ fetchImpl })
  await assert.rejects(
    () => client.upsertPage("clips/a.md", PAGE_MD, {}),
    (err: unknown) => err instanceof ApiHttpError && err.status === 401 && !(err instanceof ApiNotFoundError),
  )
})

test("createIngestJob·POST /projects/:id/ingest {source_paths} → {job_id}（畸形响应拒）", async () => {
  const { fetchImpl, requests } = recordingFetch(() => json({ job_id: "0196aaaa-eeee", status: "pending" }, 201))
  const client = new LlmWikiApiClient({ fetchImpl })
  assert.deepEqual(await client.createIngestJob(["sources/clips/a.md"], "7"), { job_id: "0196aaaa-eeee" })
  assert.equal(requests[0]?.method, "POST")
  assert.equal(requests[0]?.url, "http://127.0.0.1:19828/api/v1/projects/7/ingest")
  assert.deepEqual(JSON.parse(requests[0]?.body ?? ""), { source_paths: ["sources/clips/a.md"] })

  const malformed = new LlmWikiApiClient({
    fetchImpl: recordingFetch(() => json({ status: "pending" }, 201)).fetchImpl,
  })
  await assert.rejects(() => malformed.createIngestJob(["x"]), /createIngestJob job_id: expected non-empty string/)
})
