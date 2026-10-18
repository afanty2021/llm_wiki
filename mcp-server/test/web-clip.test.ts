import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { test } from "node:test"

import {
  WebClipError,
  buildSourceMarkdown,
  clipFileName,
  decodeBody,
  explainRejection,
  isPublicUnicast,
  kebabSlug,
  normalizeUrl,
  sniffCharset,
  urlHash8,
} from "../src/web-clip.js"

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

function assertWebClipError(fn: () => unknown, code: string): void {
  assert.throws(fn, (err: unknown) => err instanceof WebClipError && err.code === code)
}

// ── normalizeUrl（§4.3：归一化在前，微信分享链变体必须收敛到同一形态）──

test("normalizeUrl·微信短路径：`/s/abc` 的两种带参变体归一为同一无参结果", () => {
  const a = normalizeUrl("https://mp.weixin.qq.com/s/abc?src=11&scene=23")
  const b = normalizeUrl("https://mp.weixin.qq.com/s/abc?chksm=x")
  assert.equal(a, "https://mp.weixin.qq.com/s/abc")
  assert.equal(a, b, "同文不同参必须同归一结果（判重主场景，评审 I4）")
})

test("normalizeUrl·微信非短路径：白名单参数照剥，语义参数保留", () => {
  assert.equal(
    normalizeUrl("https://mp.weixin.qq.com/mp/article?scene=1&item_id=5"),
    "https://mp.weixin.qq.com/mp/article?item_id=5",
  )
})

test("normalizeUrl·剥 utm 前缀与精确名白名单，其余参数保留", () => {
  assert.equal(normalizeUrl("https://example.com/page?utm_source=a&x=1"), "https://example.com/page?x=1")
  assert.equal(
    normalizeUrl(
      "https://example.com/p?utm_medium=n&from=timeline&pass_ticket=pt&scene=1&isfromandroid=1&src=copy&u_source=weixin&keep=me&srcx=1",
    ),
    "https://example.com/p?keep=me&srcx=1",
    "utm_ 前缀 + pass_ticket/scene/from/isfromandroid/src/u_source 精确名剥除；srcx 非精确名保留",
  )
  assert.equal(normalizeUrl("https://example.com/p?utm_source=a"), "https://example.com/p", "剥空后 query 整体消失")
})

test("normalizeUrl·大小写/默认端口/fragment/参数排序", () => {
  assert.equal(normalizeUrl("HTTPS://Example.COM:443/a?b=2&a=1#frag"), "https://example.com/a?a=1&b=2")
  assert.equal(normalizeUrl("http://example.com:80/x"), "http://example.com/x")
  assert.equal(normalizeUrl("https://example.com:8443/x"), "https://example.com:8443/x", "非默认端口保留")
  assert.equal(normalizeUrl("https://example.com/p#section"), "https://example.com/p")
  assert.equal(normalizeUrl("https://example.com/p?z=1&y=2&a=3"), "https://example.com/p?a=3&y=2&z=1")
})

test("normalizeUrl·非法 URL → WebClipError('invalid_url')", () => {
  assertWebClipError(() => normalizeUrl("not a url"), "invalid_url")
  assertWebClipError(() => normalizeUrl(""), "invalid_url")
  assertWebClipError(() => normalizeUrl("example.com/foo"), "invalid_url")
})

test("normalizeUrl·剥 userinfo（实现评审 Minor-3）：凭证不进 source_url/LLM 输入/外发请求", () => {
  assert.equal(normalizeUrl("https://user:p%40ss@example.com/a?x=1"), "https://example.com/a?x=1")
  assert.equal(normalizeUrl("http://token@example.com/"), "http://example.com/")
  // 只有 username 的形态（`@` 空段）同样剥净
  assert.equal(normalizeUrl("https://@example.com/x"), "https://example.com/x")
  // 归一收敛：带凭证与不带凭证同文判重（urlhash8 同值）
  assert.equal(
    urlHash8(normalizeUrl("https://user:secret@example.com/a")),
    urlHash8(normalizeUrl("https://example.com/a")),
    "凭证形态与裸形态归一到同一 hash（重复收藏不因凭证分叉）",
  )
})

test("normalizeUrl·尾点 host 归一（DNS 根标签）：example.com. ≡ example.com", () => {
  assert.equal(normalizeUrl("https://example.com./a?x=1"), "https://example.com/a?x=1")
  assert.equal(normalizeUrl("https://example.com../a"), "https://example.com/a", "多尾点同样收敛")
  assert.equal(
    urlHash8(normalizeUrl("https://example.com./a")),
    urlHash8(normalizeUrl("https://example.com/a")),
    "同文双形态同 hash（防双份收藏，实现评审 Minor-3）",
  )
})

// ── urlHash8 / kebabSlug / clipFileName（§4.3：确定性路径）──

test("urlHash8·sha256 hex 前 8 字符（含已知答案）+ 确定性", () => {
  assert.equal(urlHash8("x"), "2d711642", "sha256('x') 前 8 字符已知答案")
  assert.equal(
    urlHash8("https://example.com/a"),
    createHash("sha256").update("https://example.com/a").digest("hex").slice(0, 8),
  )
  assert.match(urlHash8("anything"), /^[0-9a-f]{8}$/)
  assert.equal(urlHash8("u1"), urlHash8("u1"), "同输入恒同值")
  assert.notEqual(urlHash8("u1"), urlHash8("u2"))
})

test("kebabSlug·小写/分隔/压缩/去首尾/空结果回退", () => {
  assert.equal(kebabSlug("Hello World! Foo"), "hello-world-foo")
  assert.equal(kebabSlug("My Great Article — Part 2"), "my-great-article-part-2", "em dash 等非保留字符归分隔符")
  assert.equal(kebabSlug("  --leading--and--trailing--  "), "leading-and-trailing")
  assert.equal(kebabSlug("？！。"), "clip", "纯标点结果为空 → clip")
  assert.equal(kebabSlug(""), "clip")
})

test("kebabSlug·R10 修订：保留 CJK（Han），标点/空白归分隔符", () => {
  assert.equal(kebabSlug("纯中文标题"), "纯中文标题", "纯 CJK 标题原样保留（R10 前→clip）")
  assert.equal(kebabSlug("《初中英语教师如何维持口语水平？》"), "初中英语教师如何维持口语水平", "书名号/问号剥除，正文保留")
  assert.equal(kebabSlug("Hello 世界 Foo"), "hello-世界-foo", "拉丁小写化 + CJK 保留，边界归分隔符")
  assert.equal(kebabSlug("英文 English 混排 123"), "英文-english-混排-123", "混排逐词分段")
})

test("kebabSlug·截断 60 字符（CJK 每字计 1）", () => {
  assert.equal(kebabSlug("a".repeat(70)), "a".repeat(60))
  assert.equal(kebabSlug(`-${"b".repeat(65)}-`), "b".repeat(60))
  assert.equal(kebabSlug("语".repeat(70)), "语".repeat(60), "CJK 超 60 截断")
})

test("clipFileName·`<slug>-<hash8>.md`（CJK 标题保留 CJK slug）", () => {
  const url = "https://example.com/article"
  assert.equal(clipFileName("纯中文标题", url), `纯中文标题-${urlHash8(url)}.md`)
  assert.equal(clipFileName("Hello World", url), `hello-world-${urlHash8(url)}.md`)
  assert.match(clipFileName("T", url), /^t-[0-9a-f]{8}\.md$/)
  assert.equal(
    clipFileName("《初中英语教师如何维持口语水平？》", url),
    `初中英语教师如何维持口语水平-${urlHash8(url)}.md`,
    "产物文件名如 初中英语教师如何维持口语水平-8f3a2b1c.md（方案 R10 例）",
  )
})

// ── isPublicUnicast / explainRejection（§4.1：默认拒绝，只放行公网单播）──

test("isPublicUnicast·负向：环回/私网/CGNAT/链路本地/组播/保留/v6 特殊段全拒", () => {
  const negatives = [
    "127.0.0.1",
    "10.1.2.3",
    "0.0.0.7",
    "169.254.169.254",
    "100.64.0.1",
    "224.0.0.1",
    "240.0.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "fe80::1",
    "fc00::1",
    "ff02::1",
    "2001:db8::1",
    "2002:0a00:0001::",
    "2001:0::1",
  ]
  for (const ip of negatives) {
    assert.equal(isPublicUnicast(ip), false, `${ip} must be rejected (default deny)`)
  }
})

test("isPublicUnicast·负向补遗：边界与回退段", () => {
  const negatives = [
    "0.1.2.3", // 0.0.0.0/8
    "255.255.255.255", // 240.0.0.0/4（广播被保留段覆盖）
    "172.16.0.0",
    "172.31.255.255",
    "192.168.1.1",
    "192.0.0.8", // 192.0.0.0/24
    "192.0.2.1", // TEST-NET-1
    "198.18.0.0", // 198.18.0.0/15 起点（含 198.18/198.19 两段）
    "198.19.255.255",
    "198.51.100.7", // TEST-NET-2
    "203.0.113.7", // TEST-NET-3
    "100.64.0.0",
    "100.127.255.255", // CGNAT 终点
    "239.255.255.255", // 224.0.0.0/4 终点
    "::", // 未指定
    "::ffff:8.8.8.8", // mapped 即使内嵌公网 v4 也拒（默认拒绝，评审 I1）
    "64:ff9b::1", // NAT64，2000::/3 之外
    "1fff::", // 2000::/3 下边界外
    "4000::", // 2000::/3 上边界外
    "2001:0::", // Teredo 抠除段（2001:0::/32）
    "2002:0808:0808::", // 6to4 即使内嵌公网 v4 也拒（规格整段抠除）
  ]
  for (const ip of negatives) {
    assert.equal(isPublicUnicast(ip), false, ip)
  }
})

test("isPublicUnicast·正向：公网单播放行（含段边界）", () => {
  const positives = ["1.1.1.1", "8.8.8.8", "93.184.216.34", "2606:4700::1111"]
  for (const ip of positives) {
    assert.equal(isPublicUnicast(ip), true, ip)
  }
  const boundaries = [
    "9.255.255.255", // 10/8 前一址
    "11.1.1.1",
    "100.63.255.255", // CGNAT 前一址
    "100.128.0.0", // CGNAT 后一址
    "172.15.255.255", // 172.16/12 前一址
    "172.32.0.0", // 172.16/12 后一址
    "198.17.255.255", // 198.18/15 前一址
    "198.20.0.0", // 198.18/15 后一址
    "192.0.1.1", // 192.0.0/24 后一址
    "223.255.255.255", // 224/4 前一址
    "2000::", // 2000::/3 起点
    "3fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", // 2000::/3 终点
    "2001:1::1", // Teredo 段（2001:0::/32）外一址
    "2001:db9::1", // 文档段（2001:db8::/32）外一址
    "2001:4860:4860::8888",
  ]
  for (const ip of boundaries) {
    assert.equal(isPublicUnicast(ip), true, ip)
  }
})

test("isPublicUnicast·乱串/畸形 → false（默认拒绝）", () => {
  const garbage = ["", "not-an-ip", "1.2.3", "1.2.3.4.5", "999.1.1.1", "1.2.3.256", "010.1.2.3", "0x7f000001", "2130706433", ":::", "1::2::3", "12345::", "fe80:::1", " 1.1.1.1"]
  for (const ip of garbage) {
    assert.equal(isPublicUnicast(ip), false, ip)
    assert.ok(explainRejection(ip) !== null, `${ip}: explainRejection 须给出拒绝原因`)
  }
})

test("explainRejection·命中段给出 CIDR 标注，放行返回 null，与 isPublicUnicast 一致", () => {
  assert.equal(explainRejection("1.1.1.1"), null)
  assert.match(explainRejection("10.1.2.3")!, /10\.0\.0\.0\/8/)
  assert.match(explainRejection("169.254.169.254")!, /169\.254\.0\.0\/16/)
  assert.match(explainRejection("100.64.0.1")!, /100\.64\.0\.0\/10/)
  assert.match(explainRejection("::1")!, /::1\/128/)
  assert.match(explainRejection("::ffff:127.0.0.1")!, /::ffff:0:0\/96/)
  assert.match(explainRejection("fe80::1")!, /fe80::\/10/)
  assert.match(explainRejection("fc00::1")!, /fc00::\/7/)
  assert.match(explainRejection("ff02::1")!, /ff00::\/8/)
  assert.match(explainRejection("2001:db8::1")!, /2001:db8::\/32/)
  assert.match(explainRejection("2002:0a00:0001::")!, /2002::\/16/)
  assert.match(explainRejection("2001:0::1")!, /2001:0::\/32/)
  assert.match(explainRejection("4000::")!, /2000::\/3/)
  // 一致性：判定与解释同源
  for (const ip of ["1.1.1.1", "10.0.0.1", "2606:4700::1111", "::1", "junk"]) {
    assert.equal(isPublicUnicast(ip), explainRejection(ip) === null, ip)
  }
})

// ── sniffCharset（§4.2：header > BOM > meta(前 2048B) > utf-8）──

test("sniffCharset·Content-Type charset 最优先（含 GBK 家族归一）", () => {
  assert.equal(sniffCharset("text/html; charset=gbk", bytes("<meta charset=\"big5\">")), "gb18030", "header 压过 meta")
  assert.equal(sniffCharset("text/html; charset=gb2312", new Uint8Array(0)), "gb18030")
  assert.equal(sniffCharset("text/plain; charset=\"GBK\"", new Uint8Array(0)), "gb18030", "带引号/大小写不敏感")
  assert.equal(sniffCharset("text/html; charset=Big5", bytes("x")), "big5", "非 GBK 家族标签原样（小写化）")
})

test("sniffCharset·BOM：header 无 charset 时按 BOM 判 UTF-8/UTF-16LE/BE", () => {
  assert.equal(sniffCharset("text/html", new Uint8Array([0xef, 0xbb, 0xbf, 0x3c])), "utf-8")
  assert.equal(sniffCharset(null, new Uint8Array([0xff, 0xfe, 0x3c])), "utf-16le")
  assert.equal(sniffCharset(null, new Uint8Array([0xfe, 0xff, 0x3c])), "utf-16be")
  assert.equal(sniffCharset("text/html; charset=gbk", new Uint8Array([0xef, 0xbb, 0xbf])), "gb18030", "规格优先级：header > BOM")
})

test("sniffCharset·meta charset / meta http-equiv（ASCII 不区分大小写，前 2048 字节）", () => {
  assert.equal(sniffCharset("text/html", bytes('<html><head><meta charset="gb2312"></head>')), "gb18030")
  assert.equal(
    sniffCharset(null, bytes('<HTML><HEAD><META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=GBK"></HEAD></HTML>')),
    "gb18030",
  )
  assert.equal(sniffCharset(null, bytes('<meta charset=utf-8>')), "utf-8", "无引号形态")
})

test("sniffCharset·meta 超出前 2048 字节不扫；恰好在内可用", () => {
  assert.equal(sniffCharset(null, bytes("x".repeat(2100) + '<meta charset="gb2312">')), "utf-8", "超出窗口 → 默认")
  assert.equal(sniffCharset(null, bytes("x".repeat(2000) + '<meta charset="gb2312">')), "gb18030", "窗口内（结束于 2022 字节）")
})

test("sniffCharset·无任何线索 → utf-8（含空 body）", () => {
  assert.equal(sniffCharset(null, bytes("<html><body>hello</body></html>")), "utf-8")
  assert.equal(sniffCharset("text/html", new Uint8Array(0)), "utf-8")
  assert.equal(sniffCharset(null, new Uint8Array(0)), "utf-8")
})

// ── decodeBody（§4.2：替换率 >2% 即拒，乱码绝不落库）──

test("decodeBody·GBK 夹具（手写 hex）解出正确中文", () => {
  // GBK：中 = D6 D0，文 = CE C4
  assert.equal(decodeBody(new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]), "gb18030"), "中文")
  // GBK：你 = C4 E3，好 = BA C3，世 = CA C0，界 = BD E7；嗅探链端到端（header gbk → gb18030 → 解码）
  const gbkBytes = new Uint8Array([0xc4, 0xe3, 0xba, 0xc3, 0xca, 0xc0, 0xbd, 0xe7])
  assert.equal(decodeBody(gbkBytes, sniffCharset("text/html; charset=gbk", gbkBytes)), "你好世界")
})

test("decodeBody·干净 UTF-8 原样返回（含中文与空 body）", () => {
  assert.equal(decodeBody(bytes("hello 中文"), "utf-8"), "hello 中文")
  assert.equal(decodeBody(new Uint8Array(0), "utf-8"), "")
})

test("decodeBody·替换字符占比 >2% → WebClipError('undecodable')", () => {
  const garbage = new Uint8Array(200).fill(0x80) // utf-8 下 200/200 全为 U+FFFD
  assertWebClipError(() => decodeBody(garbage, "utf-8"), "undecodable")
  // GBK 视角下的乱码：合法 ASCII 串按 gb18030 解不出错（GBK 兼容 ASCII），此路用 utf-8 夹具覆盖
})

test("decodeBody·占比 ≤2% 容忍（阈值是严格大于）", () => {
  const onePercent = new Uint8Array(101) // 100×'A' + 1 个坏字节 = 1/101 ≈ 0.99%
  onePercent.fill(0x41)
  onePercent[100] = 0x80
  const text = decodeBody(onePercent, "utf-8")
  assert.ok(text.includes("\uFFFD"), "坏字节如实替换")
  const exactly2pct = new Uint8Array(50) // 49×'A' + 1 坏 = 恰 2%，不抛
  exactly2pct.fill(0x41)
  exactly2pct[49] = 0x80
  assert.ok(decodeBody(exactly2pct, "utf-8").includes("\uFFFD"))
})

test("decodeBody·非法编码标签 → WebClipError（所有错误走 WebClipError）", () => {
  assertWebClipError(() => decodeBody(new Uint8Array([0x41]), "not-a-charset"), "undecodable")
})

// ── buildSourceMarkdown（§4.2/§4.3：frontmatter provenance + 正文原样）──

test("buildSourceMarkdown·快照：frontmatter 全字段 + 空行 + body 原样", () => {
  const md = buildSourceMarkdown({
    title: "深度学习入门",
    url: "https://example.com/article?x=1",
    clippedAt: "2026-10-18T10:00:00.000Z",
    clippedBy: "T1",
    body: "# 标题\n\n正文第一段。",
  })
  assert.equal(
    md,
    [
      "---",
      'title: "深度学习入门"',
      'source_url: "https://example.com/article?x=1"',
      'clipped_at: "2026-10-18T10:00:00.000Z"',
      'clipped_by: "T1"',
      'via: "teacher-tutor"',
      "---",
      "",
      "# 标题\n\n正文第一段。",
    ].join("\n"),
  )
})

test("buildSourceMarkdown·标题内双引号 YAML 转义；via 恒为 teacher-tutor", () => {
  const md = buildSourceMarkdown({ title: 'He said "hi"', url: "u", clippedAt: "t", clippedBy: "c", body: "b" })
  assert.ok(md.includes('title: "He said \\"hi\\""'))
  assert.ok(md.includes('via: "teacher-tutor"'))
})

test("WebClipError·code 机器可读，message 缺省 = code", () => {
  const e = new WebClipError("invalid_url")
  assert.equal(e.code, "invalid_url")
  assert.equal(e.message, "invalid_url")
  assert.ok(e instanceof Error)
  assert.ok(new WebClipError("undecodable", "detail").message === "detail")
})
