import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"

import { normalizeOutline, renderMindmap } from "../src/mindmap.js"
import {
  buildMarkmapHtml,
  chromeScreenshotRunner,
  outlineToMarkdown,
  renderMindmapAuto,
  renderMindmapMarkmap,
} from "../src/mindmap-markmap.js"

const SAMPLE = {
  title: "一般过去时",
  root: {
    children: [
      { label: "构成规则", children: [{ label: "动词 +ed" }, { label: "不规则动词表" }] },
      { label: "时间标志词" },
    ],
  },
}

// ── outlineToMarkdown ──

test("outlineToMarkdown: # 主题 + 两空格缩进列表", () => {
  const md = outlineToMarkdown(normalizeOutline(SAMPLE))
  const lines = md.split("\n")
  assert.equal(lines[0], "# 一般过去时")
  assert.equal(lines[1], "- 构成规则")
  assert.equal(lines[2], "  - 动词 +ed")
  assert.equal(lines[3], "  - 不规则动词表")
  assert.equal(lines[4], "- 时间标志词")
})

test("outlineToMarkdown: 换行/制表压空格（列表行结构唯一硬约束）", () => {
  const md = outlineToMarkdown(normalizeOutline({
    title: "t1",
    root: { children: [{ label: "第一行\n第二行\t制表" }] },
  }))
  assert.ok(md.includes("- 第一行 第二行 制表"))
  assert.ok(!md.includes("\n第二行"), "label 内换行不得产生新列表行")
})

// ── buildMarkmapHtml ──

test("buildMarkmapHtml: 本地资产引用/markdown 内联/script 闭合转义/画布尺寸", () => {
  const html = buildMarkmapHtml("# 一般过去时\n- 分支</script>注入", {
    assetBase: "/base/node_modules", width: 1500, height: 1100,
  })
  assert.ok(html.includes('src="file:///base/node_modules/markmap-lib/dist/browser/index.iife.js"'))
  assert.ok(html.includes('src="file:///base/node_modules/d3/dist/d3.min.js"'))
  assert.ok(html.includes('src="file:///base/node_modules/markmap-view/dist/browser/index.js"'))
  assert.ok(html.includes("<script type=\"text/template\""))
  // </script> 注入必须被转义（模板边界不可被 markdown 内容破坏）
  assert.ok(html.includes("<\\/script>注入"), "</script> 必须转义为 <\\/script>")
  assert.ok(html.includes("width:1500px") && html.includes("height:1100px"))
  assert.ok(html.includes("mm.fit()"), "fit 逻辑必须在页内")
  assert.ok(html.includes("PALETTE"), "分支色相板必须在页内")
})

// ── renderMindmapMarkmap（fake screenshot）──

function fakeScreenshot() {
  const calls: Array<{ htmlPath: string; outPath: string; html: string }> = []
  const fn = async (htmlPath: string, outPath: string): Promise<void> => {
    // tmp 目录在 render 返回前即清理，HTML 必须在调用时快照。
    calls.push({ htmlPath, outPath, html: readFileSync(htmlPath, "utf8") })
    writeFileSync(outPath, "fake-markmap-png")
  }
  return { fn, calls }
}

test("renderMindmapMarkmap: 成功——engine/path 命名/tmp 清理", async () => {
  const outDir = mkdtempSync(path.join(tmpdir(), "ltutor-mindmap-mm-"))
  const { fn, calls } = fakeScreenshot()

  const result = await renderMindmapMarkmap(normalizeOutline(SAMPLE), { outDir, screenshot: fn })
  assert.equal(result.ok, true)
  assert.equal(result.engine, "markmap")
  assert.equal(result.nodes, 5)
  assert.equal(result.depth, 3)
  assert.match(path.basename(result.path!), /^mindmap-markmap-[0-9a-f]{12}\.png$/)
  assert.ok(readFileSync(result.path!, "utf8") === "fake-markmap-png")
  // 喂给截图的 HTML 含本次 markdown
  assert.ok(calls[0]!.html.includes("# 一般过去时"))

  // 幂等：同大纲 → 同一路径
  const again = await renderMindmapMarkmap(normalizeOutline(SAMPLE), { outDir, screenshot: fn })
  assert.equal(again.path, result.path)

  rmSync(outDir, { recursive: true, force: true })
})

test("renderMindmapMarkmap: 截图失败 → ok:false（不抛错）", async () => {
  const outDir = mkdtempSync(path.join(tmpdir(), "ltutor-mindmap-mm-err-"))
  const result = await renderMindmapMarkmap(normalizeOutline(SAMPLE), {
    outDir,
    screenshot: async () => {
      throw new Error("Chrome/Chromium 未找到（headless 截图不可用）")
    },
  })
  assert.equal(result.ok, false)
  assert.match(result.error!, /Chrome/)
  rmSync(outDir, { recursive: true, force: true })
})

// ── renderMindmapAuto（自动链）──

test("renderMindmapAuto: markmap 成功 → 直接用、不碰 graphviz", async () => {
  const outDir = mkdtempSync(path.join(tmpdir(), "ltutor-mindmap-auto-"))
  let dotCalled = false
  const result = await renderMindmapAuto(normalizeOutline(SAMPLE), {
    markmap: {
      outDir,
      screenshot: async (_htmlPath, outPath) => {
        writeFileSync(outPath, "mm-png")
      },
    },
    graphviz: {
      outDir,
      execFile: async () => {
        dotCalled = true
        throw new Error("dot 不应被调用")
      },
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.engine, "markmap")
  assert.equal(dotCalled, false)
  rmSync(outDir, { recursive: true, force: true })
})

test("renderMindmapAuto: markmap 失败 → 回落 graphviz", async () => {
  const outDir = mkdtempSync(path.join(tmpdir(), "ltutor-mindmap-auto-fb-"))
  const result = await renderMindmapAuto(normalizeOutline(SAMPLE), {
    markmap: {
      outDir,
      screenshot: async () => {
        throw new Error("chrome boom")
      },
    },
    graphviz: {
      outDir,
      execFile: async (_cmd, args) => {
        const o = args.indexOf("-o")
        writeFileSync(args[o + 1]!, "dot-png")
        return { stdout: "", stderr: "" }
      },
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.engine, "graphviz")
  rmSync(outDir, { recursive: true, force: true })
})

test("renderMindmapAuto: 双败 → 聚合两个引擎的错误", async () => {
  const outDir = mkdtempSync(path.join(tmpdir(), "ltutor-mindmap-auto-2x-"))
  const result = await renderMindmapAuto(normalizeOutline(SAMPLE), {
    markmap: {
      outDir,
      screenshot: async () => {
        throw new Error("chrome boom")
      },
    },
    graphviz: {
      outDir,
      execFile: async () => {
        throw new Error("dot boom")
      },
    },
  })
  assert.equal(result.ok, false)
  assert.match(result.error!, /chrome boom/)
  assert.match(result.error!, /dot boom/)
  rmSync(outDir, { recursive: true, force: true })
})

// ── 真渲染冒烟（仅本机有 Chrome 时；无则跳过）──

test("renderMindmapMarkmap: 真实 Chrome 冒烟（本地资产 + headless 截图）", { timeout: 40_000 }, async () => {
  const outDir = mkdtempSync(path.join(tmpdir(), "ltutor-mindmap-real-"))
  const result = await renderMindmapMarkmap(normalizeOutline(SAMPLE), { outDir })
  if (!result.ok && /Chrome\/Chromium 未找到/.test(result.error ?? "")) {
    return
  }
  assert.equal(result.ok, true)
  const bytes = readFileSync(result.path!)
  assert.ok(bytes.length > 10_000, `PNG 应为真实截图（${bytes.length} bytes）`)
  assert.equal(bytes[0], 0x89)
  assert.equal(bytes[1], 0x50) // 'P'
  rmSync(outDir, { recursive: true, force: true })
})

// graphviz 引擎字段回归（v1）
test("renderMindmap(graphviz): engine 字段 = graphviz", async () => {
  const outDir = mkdtempSync(path.join(tmpdir(), "ltutor-mindmap-gv-"))
  const result = await renderMindmap(normalizeOutline(SAMPLE), {
    outDir,
    execFile: async (_cmd, args) => {
      const o = args.indexOf("-o")
      writeFileSync(args[o + 1]!, "dot-png")
      return { stdout: "", stderr: "" }
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.engine, "graphviz")
  rmSync(outDir, { recursive: true, force: true })
})

// chromeScreenshotRunner 只做不可用路径单测（可用路径由真实冒烟覆盖）
test("chromeScreenshotRunner: Chrome 缺失 → 可读错误", async () => {
  await assert.rejects(
    chromeScreenshotRunner("/nonexistent.html", "/tmp/nonexistent-out.png", { chromePath: "/nonexistent/chrome" }),
    /Chrome\/Chromium 未找到/,
  )
})
