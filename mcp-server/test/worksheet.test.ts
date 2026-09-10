import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"

import {
  buildWorksheetHtml,
  emojiFe0f,
  normalizeWorksheet,
  renderWorksheet,
  WORKSHEET_MAX_BLOCKS_PER_SECTION,
  WORKSHEET_MAX_TOTAL_CHARS,
  WorksheetFormatError,
  worksheetCapsError,
} from "../src/worksheet.js"
import { WORKSHEET_FIXTURE } from "./worksheet-fixture.js"

// ── normalizeWorksheet ──

test("normalizeWorksheet: trim 语义 + 空串可选项归一", () => {
  const doc = normalizeWorksheet({
    title: "  Green School  ",
    subtitle: " ",
    sections: [
      {
        heading: "Classrooms",
        icon: " 🏫 ",
        blocks: [{ type: "fill", items: [{ before: "We can see", after: "" }] }],
      },
    ],
  })
  assert.equal(doc.title, "Green School")
  assert.equal(doc.subtitle, undefined, "纯空白可选项归一为 undefined")
  assert.equal(doc.sections[0]!.icon, "🏫")
  assert.deepEqual(doc.sections[0]!.blocks[0], { type: "fill", items: [{ before: "We can see" }] })
})

test("normalizeWorksheet: 形状非法 → WorksheetFormatError", () => {
  assert.throws(() => normalizeWorksheet({ title: "", sections: [] }), WorksheetFormatError)
  assert.throws(() => normalizeWorksheet({ title: "t", sections: "x" }), WorksheetFormatError)
  assert.throws(() => normalizeWorksheet({ title: "t", sections: [{}] }), /heading/)
  assert.throws(() => normalizeWorksheet({ title: "t", sections: [{ heading: "h" }] }), /blocks/)
  assert.throws(
    () => normalizeWorksheet({ title: "t", sections: [{ heading: "h", blocks: [{ type: "poem" }] }] }),
    /type must be one of/,
  )
  assert.throws(
    () => normalizeWorksheet({ title: "t", sections: [{ heading: "h", blocks: [{ type: "text" }] }] }),
    /text is required/,
  )
  assert.throws(
    () => normalizeWorksheet({ title: "t", sections: [{ heading: "h", blocks: [{ type: "fill", items: [{ after: "x" }] }] }] }),
    /before is required/,
  )
})

// ── caps（I-5：字段级优先于总量；min 2 sections 在 caps 强制）──

function docWith(nSections: number, blocksPer = 1) {
  return normalizeWorksheet({
    title: "t",
    sections: Array.from({ length: nSections }, () => ({
      heading: "h",
      blocks: Array.from({ length: blocksPer }, () => ({ type: "text", text: "x" })),
    })),
  })
}

test("caps: sections 2-4 边界（1 拒 / 4 过 / 5 拒）", () => {
  assert.match(worksheetCapsError(docWith(1))!, /少于下限 2/)
  assert.equal(worksheetCapsError(docWith(4)), null)
  assert.match(worksheetCapsError(docWith(5))!, /超过上限 4/)
})

test("caps: 每卡块数（0 拒 / 4 过 / 5 拒）", () => {
  assert.match(
    worksheetCapsError(normalizeWorksheet({ title: "t", sections: [{ heading: "h", blocks: [] }, { heading: "h2", blocks: [{ type: "text", text: "x" }] }] }))!,
    /至少需要 1 个内容块/,
  )
  assert.equal(worksheetCapsError(docWith(2, WORKSHEET_MAX_BLOCKS_PER_SECTION)), null)
  assert.match(worksheetCapsError(docWith(2, WORKSHEET_MAX_BLOCKS_PER_SECTION + 1))!, /超过上限 4/)
})

test("caps: 各字段帽与总量", () => {
  assert.match(worksheetCapsError(normalizeWorksheet({ title: "t".repeat(41), sections: [{ heading: "h", blocks: [{ type: "text", text: "x" }] }, { heading: "h", blocks: [{ type: "text", text: "x" }] }] }))!, /标题 41 字符/)
  const longCheck = normalizeWorksheet({
    title: "t",
    sections: [{ heading: "h", blocks: [{ type: "checklist", items: Array.from({ length: 7 }, () => "x") }] }, { heading: "h", blocks: [{ type: "text", text: "x" }] }],
  })
  assert.match(worksheetCapsError(longCheck)!, /勾选项 7 个超过上限 6/)
  const wide = normalizeWorksheet({
    title: "t",
    sections: [
      { heading: "h", blocks: [{ type: "table", headers: ["a", "b", "c", "d", "e", "f"], rows: [["1", "2", "3", "4", "5", "6"]] }] },
      { heading: "h", blocks: [{ type: "text", text: "x" }] },
    ],
  })
  assert.match(worksheetCapsError(wide)!, /6 列超过上限 5/)
  // 总量：4 卡 ×（heading 30 + text 120 + text 120）= 1080，+ title/subtitle/footer 121 = 1201 > 1200
  const fat = normalizeWorksheet({
    title: "t",
    subtitle: "s".repeat(60),
    footer: "f".repeat(60),
    sections: Array.from({ length: 4 }, () => ({
      heading: "h".repeat(30),
      blocks: [{ type: "text", text: "x".repeat(120) }, { type: "text", text: "y".repeat(120) }],
    })),
  })
  assert.ok(totalOf(fat) > WORKSHEET_MAX_TOTAL_CHARS)
  assert.match(worksheetCapsError(fat)!, /总文本量/)
  // 字段级优先于总量：标题超长 + 总量同超 → 报字段级
  const both = normalizeWorksheet({
    title: "t".repeat(41),
    subtitle: "s".repeat(60),
    sections: Array.from({ length: 4 }, () => ({ heading: "h".repeat(30), blocks: [{ type: "text", text: "x".repeat(120) }] })),
  })
  assert.match(worksheetCapsError(both)!, /标题 41 字符/)
})

function totalOf(doc: ReturnType<typeof normalizeWorksheet>): number {
  // 与 worksheet.ts totalChars 同口径的测试侧实现（仅断言用）
  let n = doc.title.length + (doc.subtitle?.length ?? 0) + (doc.footer?.length ?? 0)
  for (const sec of doc.sections) {
    n += sec.heading.length + (sec.icon?.length ?? 0)
    for (const b of sec.blocks) {
      if (b.type === "text") n += b.text.length
      else if (b.type === "checklist") n += b.items.reduce((m, x) => m + x.length, 0)
      else if (b.type === "table") {
        n += b.headers.reduce((m, x) => m + x.length, 0)
        n += b.rows.reduce((m, r) => m + r.reduce((mm, x) => mm + x.length, 0), 0)
      } else n += b.items.reduce((m, x) => m + x.before.length + (x.after?.length ?? 0), 0)
    }
  }
  return n
}

// ── esc 与 emoji（I-2/I-3）──

test("esc: 五件套 + 控制字符压空格（经 buildWorksheetHtml 断言产物）", () => {
  const html = buildWorksheetHtml(normalizeWorksheet({
    title: 'T&S <script>x</script> "q" \'a\'',
    sections: [{ heading: "h", blocks: [{ type: "text", text: "a\x01b" }] }],
  }))
  assert.ok(html.includes("T&amp;S &lt;script&gt;x&lt;/script&gt; &quot;q&quot; &#39;a&#39;"))
  assert.ok(!html.includes("<script>x"))
  assert.ok(html.includes("a b"), "控制字符应压成空格（a\x01b → a b）")
  assert.ok(!html.includes("\x01"), "注入的控制字符不得原样进产物")
})

test("I-3 emojiFe0f 五例：单码位补 / 已带变体不动 / 旗不动 / ZWJ 不动 / CJK 不动", () => {
  assert.equal(emojiFe0f("🌱"), "🌱\uFE0F")
  assert.equal(emojiFe0f("🎨\uFE0F"), "🎨\uFE0F", "已带 FE0F 不得双补")
  assert.equal(emojiFe0f("🇨🇳"), "🇨🇳", "旗（region-indicator 簇）不得拆")
  assert.equal(emojiFe0f("👨‍👩‍👧"), "👨‍👩‍👧", "ZWJ 序列不得破坏")
  assert.equal(emojiFe0f("一般过去时 ABC"), "一般过去时 ABC", "CJK/ASCII 不得污染")
  assert.equal(emojiFe0f("🌱Plants"), "🌱\uFE0FPlants", "簇级处理不污染相邻 ASCII")
})

// ── buildWorksheetHtml（I-8b 逐字断言 + 全局毒饼）──

test("I-8b 文字准确性: fixture 全字段 esc 后逐字存在于 page.html", () => {
  const html = buildWorksheetHtml(WORKSHEET_FIXTURE)
  const expectedTexts: string[] = [WORKSHEET_FIXTURE.title, WORKSHEET_FIXTURE.subtitle!, WORKSHEET_FIXTURE.footer!]
  for (const sec of WORKSHEET_FIXTURE.sections) {
    expectedTexts.push(sec.heading)
    if (sec.icon !== undefined) expectedTexts.push(sec.icon)
    for (const b of sec.blocks) {
      if (b.type === "text") expectedTexts.push(b.text)
      else if (b.type === "checklist") expectedTexts.push(...b.items)
      else if (b.type === "table") expectedTexts.push(...b.headers, ...b.rows.flat())
      else for (const x of b.items) expectedTexts.push(x.before, ...(x.after !== undefined ? [x.after] : []))
    }
  }
  for (const s of expectedTexts.filter((x) => x !== "")) {
    assert.ok(html.includes(s), `逐字缺失: ${s}`)
  }
  assert.equal((html.match(/class="card"/g) || []).length, WORKSHEET_FIXTURE.sections.length)
  assert.ok(html.includes("<table>"))
})

test("I-2 全局毒饼: 模板级字段 + 六块全字段灌毒 → 产物零裸毒串", () => {
  const poison = '<script>alert(1)</script><!-- --> "q" &\''
  const html = buildWorksheetHtml(normalizeWorksheet({
    title: poison,
    subtitle: poison,
    footer: poison,
    sections: [
      {
        heading: poison,
        icon: "🌱",
        blocks: [
          { type: "text", text: poison },
          { type: "fill", items: [{ before: poison, after: poison }] },
          { type: "boxfill", items: [{ before: poison, after: poison }] },
          { type: "numbered", items: [{ before: poison }] },
          { type: "checklist", items: [poison] },
          { type: "table", headers: [poison], rows: [[poison]] },
        ],
      },
      { heading: poison, blocks: [{ type: "text", text: poison }] },
    ],
  }))
  for (const raw of ["<script>", "<!--", 'alert(1)</script>']) {
    assert.ok(!html.includes(raw), `裸毒串泄漏: ${raw}`)
  }
  assert.ok(html.includes("&lt;script&gt;"), "毒串应以 esc 形态存在")
})

// ── renderWorksheet（fake screenshot）──

function validPngBytes(): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(84),
    Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]),
  ])
}

function fakeScreenshot(bytes: Buffer = validPngBytes()) {
  const calls: Array<{ htmlPath: string; outPath: string; html: string }> = []
  const fn = async (htmlPath: string, outPath: string): Promise<void> => {
    calls.push({ htmlPath, outPath, html: readFileSync(htmlPath, "utf8") })
    writeFileSync(outPath, bytes)
  }
  return { fn, calls }
}

test("renderWorksheet: 成功——path 命名 sha1(html)/rename/sections+blocks 计数", async () => {
  const outDir = mkdtempSync(path.join(tmpdir(), "ltutor-ws-out-"))
  const { fn, calls } = fakeScreenshot()
  const doc = normalizeWorksheet(WORKSHEET_FIXTURE)

  const result = await renderWorksheet(doc, { outDir, screenshot: fn })
  assert.equal(result.ok, true)
  assert.equal(result.sections, 4)
  assert.equal(result.blocks, 10)
  assert.match(path.basename(result.path!), /^worksheet-[0-9a-f]{12}\.png$/)
  assert.ok(readFileSync(result.path!).equals(validPngBytes()))
  // 截图写临时名（tmp 子目录），终名由 rename 产生
  assert.ok(calls[0]!.outPath !== result.path)
  // I-4：文件名 = sha1(渲染 HTML)——用同一 HTML 可复算
  const { createHash } = await import("node:crypto")
  const expect = createHash("sha1").update(calls[0]!.html).digest("hex").slice(0, 12)
  assert.equal(path.basename(result.path!), `worksheet-${expect}.png`)

  const again = await renderWorksheet(doc, { outDir, screenshot: fn })
  assert.equal(again.path, result.path, "同内容幂等覆盖")

  rmSync(outDir, { recursive: true, force: true })
})

test("I-A 半截 PNG → ok:false（不 ok:true 直送教师）", async () => {
  const outDir = mkdtempSync(path.join(tmpdir(), "ltutor-ws-half-"))
  const result = await renderWorksheet(normalizeWorksheet(WORKSHEET_FIXTURE), {
    outDir,
    screenshot: async (_html, outPath) => {
      writeFileSync(outPath, Buffer.concat([validPngBytes().subarray(0, 12), Buffer.alloc(50)]))
    },
  })
  assert.equal(result.ok, false)
  assert.match(result.error!, /IEND|不完整/)
  assert.ok(!result.error!.includes("请重试"), "M-4：与 handler 勿刷屏话术不得矛盾")
  rmSync(outDir, { recursive: true, force: true })
})

test("M-3: 异常消息剥绝对路径", async () => {
  const outDir = mkdtempSync(path.join(tmpdir(), "ltutor-ws-path-"))
  const result = await renderWorksheet(normalizeWorksheet(WORKSHEET_FIXTURE), {
    outDir,
    screenshot: async () => {
      throw new Error("/Users/berton/.hermes/cache/ltutor-worksheet/tmp-ws-x/shot.png: EACCES permission denied")
    },
  })
  assert.equal(result.ok, false)
  assert.ok(!result.error!.includes("/Users/berton"), "绝对路径不得进模型视野")
  assert.ok(result.error!.includes("<路径>"))
  rmSync(outDir, { recursive: true, force: true })
})

test("M-1: theme 非字符串 → WorksheetFormatError", () => {
  assert.throws(() => normalizeWorksheet({ title: "t", theme: 42, sections: [{ heading: "h", blocks: [{ type: "text", text: "x" }] }, { heading: "h2", blocks: [{ type: "text", text: "y" }] }] }), WorksheetFormatError)
})

test("renderWorksheet: 截图异常 → ok:false 透传友好文案（不抛错）", async () => {
  const outDir = mkdtempSync(path.join(tmpdir(), "ltutor-ws-err-"))
  const result = await renderWorksheet(normalizeWorksheet(WORKSHEET_FIXTURE), {
    outDir,
    screenshot: async () => {
      throw new Error("Chrome/Chromium 未找到（headless 截图不可用）")
    },
  })
  assert.equal(result.ok, false)
  assert.match(result.error!, /Chrome/)
  rmSync(outDir, { recursive: true, force: true })
})

// ── 真渲染冒烟（仅本机有 Chrome 时）──

test("renderWorksheet: 真实 Chrome 冒烟（fixture → PNG + IEND 完整）", { timeout: 40_000 }, async (t) => {
  const outDir = mkdtempSync(path.join(tmpdir(), "ltutor-ws-real-"))
  const result = await renderWorksheet(normalizeWorksheet(WORKSHEET_FIXTURE), { outDir })
  if (!result.ok && /Chrome\/Chromium 未找到/.test(result.error ?? "")) {
    t.skip("本机无 Chrome/Chromium——真渲染冒烟不可用")
    return
  }
  assert.equal(result.ok, true)
  const bytes = readFileSync(result.path!)
  assert.ok(bytes.length > 20_000, `PNG 应为真实截图（${bytes.length} bytes）`)
  assert.equal(bytes[0], 0x89)
  // M-8：IHDR 尺寸断言（1500×1100 @2x = 3000×2200）——C-1 布局回归的尺寸钉。
  assert.equal(bytes.readUInt32BE(16), 3000)
  assert.equal(bytes.readUInt32BE(20), 2200)
  rmSync(outDir, { recursive: true, force: true })
})

// ── 实现评审跟进修（2026-09-10 §五：C-1/I-1/I-2/I-4）──

test("I-1 歪表: 行列数与表头不等 → WorksheetFormatError（超列/短列都拒）", () => {
  const mk = (row: string[]) => normalizeWorksheet({
    title: "t",
    sections: [{ heading: "h", blocks: [{ type: "table", headers: ["a"], rows: [row] }] }, { heading: "h2", blocks: [{ type: "text", text: "x" }] }],
  })
  assert.throws(() => mk(["1", "2", "3"]), /3 个单元格，与表头 1 列不一致/)
  assert.throws(() => mk([]), /0 个单元格，与表头 1 列不一致/)
})

test("I-2 numbered 带 after → WorksheetFormatError（渲染只用 before，接受即静默丢内容）", () => {
  assert.throws(
    () => normalizeWorksheet({
      title: "t",
      sections: [{ heading: "h", blocks: [{ type: "numbered", items: [{ before: "b", after: "a" }] }] }, { heading: "h2", blocks: [{ type: "text", text: "x" }] }],
    }),
    /after 不适用于 numbered/,
  )
})

test("I-4 空数组拒 + cell 文案带位置与真实长度", () => {
  const sec2 = { heading: "h2", blocks: [{ type: "text", text: "x" }] }
  for (const blocks of [
    [{ type: "checklist", items: [] }],
    [{ type: "fill", items: [] }],
    [{ type: "table", headers: [], rows: [] }],
    [{ type: "table", headers: ["a"], rows: [] }],
  ]) {
    assert.throws(
      () => normalizeWorksheet({ title: "t", sections: [{ heading: "h", blocks }, sec2] }),
      /不能为空/,
    )
  }
  const longCell = normalizeWorksheet({
    title: "t",
    sections: [{
      heading: "h",
      blocks: [{ type: "table", headers: ["a", "b"], rows: [["ok", "x".repeat(13)]] }],
    }, sec2],
  })
  assert.match(worksheetCapsError(longCell)!, /rows\[0\]\[1\] 单元格 13 字符超过上限 12/)
})

test("C-1 布局预算闸: 对抗密度文档被拒、fixture 通过（评审双数据点标定）", () => {
  const b60 = "请根据课文内容完成下列句子的填空练习并且注意时态变化和单复数拼写规则"
  const dense = normalizeWorksheet({
    title: "密集练习纸",
    sections: [
      { heading: "勾选", blocks: [{ type: "checklist", items: Array.from({ length: 6 }, () => b60.slice(0, 30)) }] },
      { heading: "填空", blocks: [{ type: "fill", items: Array.from({ length: 4 }, () => ({ before: b60.slice(0, 60) })) }] },
      { heading: "编号", blocks: [{ type: "numbered", items: Array.from({ length: 4 }, () => ({ before: b60.slice(0, 60) })) }] },
      { heading: "短文", blocks: [{ type: "text", text: "短文内容" }] },
    ],
  })
  assert.match(worksheetCapsError(dense)!, /内容过密.*1000px.*拆成多张/)
  assert.equal(worksheetCapsError(normalizeWorksheet(WORKSHEET_FIXTURE)), null)
})
