import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"

import JSZip from "jszip"

import {
  normalizePptx,
  PPTX_MAX_BULLET_CHARS,
  PPTX_MAX_BULLETS_PER_SLIDE,
  PPTX_MAX_PAGE_CHARS,
  PptxFormatError,
  pptxCapsError,
  renderPptx,
} from "../src/pptx.js"
import { PPTX_FIXTURE } from "./pptx-fixture.js"

// ── normalizePptx ──

test("normalizePptx: trim 语义 + 空串可选项归一 + theme 回落", () => {
  const doc = normalizePptx({
    title: "  Green School  ",
    subtitle: " ",
    theme: "cold",
    slides: [
      { heading: " A ", bullets: [" b ", " c "] },
    ],
  })
  assert.equal(doc.title, "Green School")
  assert.equal(doc.subtitle, undefined, "纯空白可选项归一为 undefined")
  assert.equal(doc.theme, "warm", "非法 theme 回落 warm")
  assert.deepEqual(doc.slides[0], { heading: "A", bullets: ["b", "c"] })
})

test("normalizePptx: 标题剥「课件/PPT」字样（worksheet 剥「学案」先例）", () => {
  const doc = normalizePptx({ title: "一般过去时课件", slides: [{ heading: "h", bullets: ["b"] }] })
  assert.equal(doc.title, "一般过去时")
  const doc2 = normalizePptx({ title: "Past Simple PPT", slides: [{ heading: "h", bullets: ["b"] }] })
  assert.equal(doc2.title, "Past Simple")
})

test("normalizePptx: 剥除边角——全角 ＰＰＴ 与尾点（评审 M-5）", () => {
  const doc = normalizePptx({ title: "一般过去时ＰＰＴ", slides: [{ heading: "h", bullets: ["b"] }] })
  assert.equal(doc.title, "一般过去时", "全角 ＰＰＴ 也要剥")
  const doc2 = normalizePptx({ title: "一般过去时.ppt", slides: [{ heading: "h", bullets: ["b"] }] })
  assert.equal(doc2.title, "一般过去时", "剥后悬挂尾点清掉")
  const doc3 = normalizePptx({ title: "Past Simple. pptx.", slides: [{ heading: "h", bullets: ["b"] }] })
  assert.equal(doc3.title, "Past Simple", "大小写+多段尾点")
})

test("normalizePptx: 标题只剩「课件/PPT」→ 拒", () => {
  assert.throws(
    () => normalizePptx({ title: "课件PPT", slides: [{ heading: "h", bullets: ["b"] }] }),
    PptxFormatError,
  )
})

test("normalizePptx: 形状非法 → PptxFormatError", () => {
  assert.throws(() => normalizePptx({ title: "", slides: [] }), PptxFormatError)
  assert.throws(() => normalizePptx({ title: "t", slides: "x" }), PptxFormatError)
  assert.throws(() => normalizePptx({ title: "t", slides: [{}] }), /heading/)
  assert.throws(
    () => normalizePptx({ title: "t", slides: [{ heading: "h" }] }),
    /bullets must be an array/,
  )
  assert.throws(
    () => normalizePptx({ title: "t", slides: [{ heading: "h", bullets: [] }] }),
    /不能为空/,
  )
  assert.throws(
    () => normalizePptx({ title: "t", slides: [{ heading: "h", bullets: [42] }] }),
    /bullets\[0\]/,
  )
})

test("normalizePptx: 控制字符压空格（换行也压——bullets 是单行语义）", () => {
  const doc = normalizePptx({
    title: "t\x01\x02",
    slides: [{ heading: "h\x00x", bullets: ["a\nb\x1fc"] }],
  })
  assert.equal(doc.title, "t")
  assert.equal(doc.slides[0]!.heading, "h x")
  assert.equal(doc.slides[0]!.bullets[0], "a b c")
})

// ── caps（I-1 口径：单页 = heading + Σbullets，note 不进面板；总文本计 title/subtitle）──

function docWithSlides(n: number) {
  return normalizePptx({
    title: "t",
    slides: Array.from({ length: n }, () => ({ heading: "h", bullets: ["b"] })),
  })
}

test("caps: 内容页 3-10 边界（2 拒 / 3 过 / 10 过 / 11 拒）", () => {
  assert.match(pptxCapsError(docWithSlides(2))!, /少于下限 3/)
  assert.equal(pptxCapsError(docWithSlides(3)), null)
  assert.equal(pptxCapsError(docWithSlides(10)), null)
  assert.match(pptxCapsError(docWithSlides(11))!, /超过上限 10/)
})

test("caps: 每页要点数（1 过 / 6 过 / 7 拒）", () => {
  const mk = (n: number) =>
    normalizePptx({
      title: "t",
      slides: [
        { heading: "h", bullets: Array.from({ length: n }, () => "b") },
        { heading: "h2", bullets: ["b"] },
        { heading: "h3", bullets: ["b"] },
      ],
    })
  assert.equal(pptxCapsError(mk(1)), null)
  assert.equal(pptxCapsError(mk(6)), null)
  assert.match(pptxCapsError(mk(7))!, /超过上限 6/)
})

test("caps: 字段长度帽（title/subtitle/heading/bullet/note）", () => {
  const long = "x".repeat(81)
  assert.match(
    pptxCapsError(normalizePptx({ title: "x".repeat(41), slides: [{ heading: "h", bullets: ["b"] }] }))!,
    /标题 41 字符超过上限 40/,
  )
  assert.match(
    pptxCapsError(normalizePptx({ title: "t", subtitle: "s".repeat(61), slides: [{ heading: "h", bullets: ["b"] }] }))!,
    /副标题 61 字符超过上限 60/,
  )
  assert.match(
    pptxCapsError(normalizePptx({ title: "t", slides: [{ heading: "h".repeat(31), bullets: ["b"] }] }))!,
    /标题 31 字符超过上限 30/,
  )
  assert.match(
    pptxCapsError(normalizePptx({ title: "t", slides: [{ heading: "h", bullets: [long] }] }))!,
    /要点 81 字符超过上限 80/,
  )
  assert.match(
    pptxCapsError(normalizePptx({ title: "t", slides: [{ heading: "h", bullets: ["b"], note: "n".repeat(121) }] }))!,
    /备注 121 字符超过上限 120/,
  )
})

test("caps: 全字段最大合法值合成用例（评审 I-1 防回归钉）——6×80+30=510 ≤ 550 必须过", () => {
  const doc = normalizePptx({
    title: "T".repeat(40),
    subtitle: "S".repeat(60),
    slides: [
      {
        heading: "H".repeat(30),
        bullets: Array.from({ length: 6 }, () => "B".repeat(80)),
        note: "N".repeat(120),
      },
      { heading: "h", bullets: ["b"] },
      { heading: "h2", bullets: ["b2"] },
    ],
  })
  // 单页 510 ≤ 550 通过；但总文本 40+60+510+2+2 = 614 ≤ 2500 也通过 → null。
  assert.equal(pptxCapsError(doc), null)
})

test("caps: 单页上限 ≥ 字段级最大合计（510）——页级帽是字段帽未来放宽时的护栏，当前不可被合法输入触达", () => {
  // 字段级全最大（heading 30 + 6×80 = 510）合法输入的单页极值；页级 550 只在
  // 未来字段帽放宽时才可能触达——钉常量关系防回归（评审 I-1）。
  assert.ok(PPTX_MAX_PAGE_CHARS >= 510, "单页上限必须 ≥ 字段级最大合计 510")
  assert.ok(PPTX_MAX_BULLETS_PER_SLIDE * PPTX_MAX_BULLET_CHARS + 30 <= PPTX_MAX_PAGE_CHARS)
})

test("caps: 总量超限拒（10 页 × 短要点构造 >2500）", () => {
  const doc = normalizePptx({
    title: "t",
    slides: Array.from({ length: 10 }, () => ({
      heading: "h",
      bullets: Array.from({ length: 6 }, () => "b".repeat(45)), // 30 页文本×… 构造超 2500
    })),
  })
  assert.match(pptxCapsError(doc)!, /总量上限 2500/)
})

// ── 文件名幂等（规范形 JSON：键序漂移不破坏）──

test("文件名幂等: 同内容两次渲染同 sha1 名 + 键序漂移不影响", async () => {
  const dir = mkdtempSync(joinTmp())
  try {
    const r1 = await renderPptx(PPTX_FIXTURE, dir)
    assert.equal(r1.ok, true)
    // 手动打乱原始入参键序再 normalize——规范形键序固定，hash 不变
    const raw = {
      slides: PPTX_FIXTURE.slides.map(s => ({ note: s.note ?? undefined, bullets: s.bullets, heading: s.heading })),
      theme: "warm",
      subtitle: PPTX_FIXTURE.subtitle,
      title: PPTX_FIXTURE.title,
    }
    const r2 = await renderPptx(normalizePptx(raw), dir)
    assert.equal(r2.ok, true)
    assert.equal(r1.path, r2.path, "键序漂移后文件名不变（规范形哈希）")
    assert.equal(r1.slides, 3)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── 真渲染 + zip 解包断言（jszip 显式 devDependency，评审 I-5）──

/** 收集一张 slide XML 的全部 <a:t> 文本（严格清单断言用——只查存在性查不出多出来的东西，评审 I-1）。
 * XML 实体反解后比对（&amp; 最后还原，防双重转义）。 */
type PptxZip = Awaited<ReturnType<typeof JSZip.loadAsync>>
function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
}
async function slideTexts(zip: PptxZip, n: number): Promise<string[]> {
  const xml = await zip.file(`ppt/slides/slide${n}.xml`)!.async("string")
  return [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map(m => unescapeXml(m[1]!))
}

test("真渲染: slide 数=slides+1（封面）/ CJK 完好 / note 在 notesSlide / <script> 被转义 / 严格 <a:t> 清单无多余文本", async () => {
  const dir = mkdtempSync(joinTmp())
  try {
    const result = await renderPptx(
      normalizePptx({
        ...PPTX_FIXTURE,
        slides: [
          ...PPTX_FIXTURE.slides,
          { heading: "Injection probe", bullets: ["<script>alert(1)</script> & 'quote'"], note: "note & <b>keep</b>" },
        ],
      }),
      dir,
    )
    assert.equal(result.ok, true)
    assert.ok(result.path!.endsWith(".pptx"))
    const zip = await JSZip.loadAsync(readFileSync(result.path!))
    // 封面 + 4 内容页 = 5 张 slide
    const slideNames = Object.keys(zip.files).filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    assert.equal(slideNames.length, 5, "封面自动生成，总页数 = slides+1")
    const slide1 = await zip.file("ppt/slides/slide1.xml")!.async("string")
    assert.ok(slide1.includes("Microsoft YaHei"), "封面字体钉 YaHei")
    // CJK 完好（评审 M-1：断言真 CJK 子串，非英文串）
    const slide2Texts = await slideTexts(zip, 2)
    assert.ok(
      slide2Texts.some(t => t.includes("过去已完成的动作")),
      `CJK 要点须原样进 <a:t>，实得 ${JSON.stringify(slide2Texts)}`,
    )
    // 注入字面进 <a:t> 后必须是转义形态（pptxgenjs encodeXmlEntities）
    const slide5 = await zip.file("ppt/slides/slide5.xml")!.async("string")
    assert.ok(!slide5.includes("<script>alert"), "script 标签不可原样存在")
    assert.ok(slide5.includes("&lt;script&gt;"), "转义后的 script 字面在")
    // note 在 notesSlide（pptxgenjs addNotes）
    const notes = Object.keys(zip.files).filter(n => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n))
    assert.ok(notes.length >= 2, "有备注的页生成 notesSlide")
    // 严格清单（评审 I-1 根修配套）：每张内容页的 <a:t> 集合恰 = heading + bullets，
    // 无任何实现常量（旧缺陷形态：装饰条把色值 "C9973B" 渲染成可见文本）。
    const expected: string[][] = [
      ...PPTX_FIXTURE.slides.map(s => [s.heading, ...s.bullets]),
      ["Injection probe", "<script>alert(1)</script> & 'quote'"],
    ]
    for (let i = 0; i < expected.length; i++) {
      const texts = await slideTexts(zip, i + 2)
      assert.deepEqual(
        [...texts].sort(),
        [...expected[i]!].sort(),
        `slide${i + 2} 文本清单必须恰等于 heading+bullets（无多余文本）`,
      )
    }
    const coverTexts = await slideTexts(zip, 1)
    assert.deepEqual(
      [...coverTexts].sort(),
      [...[PPTX_FIXTURE.title, PPTX_FIXTURE.subtitle!, "— LT 师训 · 课堂课件 —"]].sort(),
      "封面文本清单恰 = title+subtitle+页脚行",
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("真渲染: 引擎自身错误路径——outDir 指向普通文件 → ok:false、绝对路径剥除（评审 M-2）", async () => {
  const tmp = joinTmp() + "catch-probe-"
  const dir = mkdtempSync(tmp)
  try {
    const filePath = path.join(dir, "a-file") // 普通文件占位，mkdirSync 会 ENOTDIR/EEXIST
    writeFileSync(filePath, "x")
    const result = await renderPptx(PPTX_FIXTURE, filePath)
    assert.equal(result.ok, false)
    assert.equal(result.path, undefined)
    assert.ok(!result.error!.includes("/private/tmp") && !result.error!.includes("/var/folders"),
      "绝对路径不进模型视野：" + result.error!)
    assert.ok(result.error!.length > 0, "错误文案非空")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("真渲染: 字节级不保证确定（docProps 时间戳）——只断言结构有效可再解包", async () => {
  const dir = mkdtempSync(joinTmp())
  try {
    const r = await renderPptx(PPTX_FIXTURE, dir)
    assert.equal(r.ok, true)
    const zip = await JSZip.loadAsync(readFileSync(r.path!))
    assert.ok(zip.file("[Content_Types].xml"), "OOXML 结构有效")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

function joinTmp(): string {
  return path.join(tmpdir(), "pptx-test-")
}
