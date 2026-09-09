import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"

import { normalizeOutline, renderMindmap } from "../src/mindmap.js"
import {
  ASSET_BASE,
  MARKMAP_ASSET_RELPATHS,
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

/** 最小合法 PNG 字节：签名 + 填充（过 100B 阈值）+ IEND 尾（完成判据只认这两处）。 */
function validPngBytes(): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(84),
    Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]),
  ])
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

// ── buildMarkmapHtml（I-A：内容 base64 内联，不进 HTML 解析器）──

test("buildMarkmapHtml: 本地资产引用/base64 内联/画布尺寸/fit 与色板在页", () => {
  const html = buildMarkmapHtml("# 一般过去时\n- 分支", {
    assetBase: "/base/node_modules", width: 1500, height: 1100,
  })
  assert.ok(html.includes("markmap-lib/dist/browser/index.iife.js"))
  assert.ok(html.includes("d3/dist/d3.min.js"))
  assert.ok(html.includes("markmap-view/dist/browser/index.js"))
  assert.ok(html.includes("atob("))
  assert.ok(html.includes("width:1500px") && html.includes("height:1100px"))
  assert.ok(html.includes("mm.fit()"), "fit 逻辑必须在页内")
  assert.ok(html.includes("PALETTE"), "分支色相板必须在页内")
})

test("I-A 注入用例: <!-- 与 <script>/</script> 内容不再以任何可解析形态进 HTML", () => {
  const md = "# HTML 基础\n- 注释\n  - 语法：<!-- 注释内容 -->\n- 脚本\n  - <script> 标签与 </script> 闭合"
  const html = buildMarkmapHtml(md, { assetBase: "/base", width: 1500, height: 1100 })
  // 内容 base64 后原文不出现——script data 状态机类吞标签白屏成功整类消灭
  assert.ok(!html.includes("注释内容"), "原文注释内容不得出现")
  assert.ok(!html.includes("<script> 标签"), "原文 script 字样不得出现")
  assert.ok(!html.includes("</script> 闭合"), "原文闭合字样不得出现")
  // 页面自身的标签结构完整：闭合数 = 3 资产 + 1 引导
  assert.equal((html.match(/<script/g) || []).length, 4)
  assert.equal((html.match(/<\/script>/g) || []).length, 4)
})

// ── 资产预检（I-A.2）──

test("ASSET_BASE 三资产实存（拦资产漂移，M4'）", () => {
  for (const rel of MARKMAP_ASSET_RELPATHS) {
    assert.ok(existsSync(path.join(ASSET_BASE, rel)), `资产缺失: ${rel}`)
  }
})

test("renderMindmapMarkmap: 资产缺失 → ok:false 预检失败（不启动 Chrome）", async () => {
  const result = await renderMindmapMarkmap(normalizeOutline(SAMPLE), {
    outDir: mkdtempSync(path.join(tmpdir(), "ltutor-mm-assets-")),
    assetBase: "/nonexistent/node_modules",
    screenshot: async () => {
      throw new Error("Chrome 不应被启动")
    },
  })
  assert.equal(result.ok, false)
  assert.match(result.error!, /markmap 资产缺失/)
})

// ── renderMindmapMarkmap（fake screenshot）──

function fakeScreenshot(bytes: Buffer = validPngBytes()) {
  const calls: Array<{ htmlPath: string; outPath: string; html: string }> = []
  const fn = async (htmlPath: string, outPath: string): Promise<void> => {
    // tmp 目录在 render 返回前即清理，HTML 必须在调用时快照。
    calls.push({ htmlPath, outPath, html: readFileSync(htmlPath, "utf8") })
    writeFileSync(outPath, bytes)
  }
  return { fn, calls }
}

test("renderMindmapMarkmap: 成功——engine/path 命名/rename 落终名/nodes+depth", async () => {
  const outDir = mkdtempSync(path.join(tmpdir(), "ltutor-mindmap-mm-"))
  const { fn, calls } = fakeScreenshot()

  const result = await renderMindmapMarkmap(normalizeOutline(SAMPLE), { outDir, screenshot: fn })
  assert.equal(result.ok, true)
  assert.equal(result.engine, "markmap")
  assert.equal(result.nodes, 5)
  assert.equal(result.depth, 3)
  assert.match(path.basename(result.path!), /^mindmap-markmap-[0-9a-f]{12}\.png$/)
  assert.ok(readFileSync(result.path!).equals(validPngBytes()))
  // 截图写的是临时名（评审 I-A），终名由 rename 产生
  assert.ok(calls[0]!.outPath !== result.path)
  assert.ok(path.dirname(calls[0]!.outPath) !== outDir, "临时截图应落在 tmp 子目录")
  // 喂给截图的 HTML 含本次 markdown（base64 形态下直接注入 md 原文不可见，检查 title 的 b64）
  const expectB64 = Buffer.from(outlineToMarkdown(normalizeOutline(SAMPLE)), "utf8").toString("base64")
  assert.ok(calls[0]!.html.includes(expectB64))

  // 幂等：同大纲重渲染 → 同一路径
  const again = await renderMindmapMarkmap(normalizeOutline(SAMPLE), { outDir, screenshot: fn })
  assert.equal(again.path, result.path)

  rmSync(outDir, { recursive: true, force: true })
})

test("I-A 半截 PNG: 截图缺 IEND 尾 → ok:false 走回落（不 ok:true 直送教师）", async () => {
  const outDir = mkdtempSync(path.join(tmpdir(), "ltutor-mindmap-mm-half-"))
  const result = await renderMindmapMarkmap(normalizeOutline(SAMPLE), {
    outDir,
    screenshot: async (_html, outPath) => {
      writeFileSync(outPath, Buffer.concat([validPngBytes().subarray(0, 12), Buffer.alloc(50)]))
    },
  })
  assert.equal(result.ok, false)
  assert.match(result.error!, /IEND|不完整/)
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
      screenshot: async (_html, outPath) => {
        writeFileSync(outPath, validPngBytes())
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

test("renderMindmapAuto: 双败 → 聚合两个引擎的错误（M2'：内部路径已被 friendly 化）", async () => {
  const outDir = mkdtempSync(path.join(tmpdir(), "ltutor-mindmap-auto-2x-"))
  const result = await renderMindmapAuto(normalizeOutline(SAMPLE), {
    markmap: {
      outDir,
      screenshot: async () => {
        throw new Error("spawn chrome ENOENT")
      },
    },
    graphviz: {
      outDir,
      execFile: async () => {
        throw new Error("spawn dot ENOENT")
      },
    },
  })
  assert.equal(result.ok, false)
  assert.match(result.error!, /渲染组件未安装/)
  rmSync(outDir, { recursive: true, force: true })
})

// ── chromeScreenshotRunner（I-B exit 早退）──

test("I-B: Chrome 提前退出无截图 → 立即失败（非 20s 慢败）", { timeout: 10_000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ltutor-mm-exit-"))
  const t0 = Date.now()
  await assert.rejects(
    chromeScreenshotRunner(path.join(dir, "p.html"), path.join(dir, "out.png"), { chromePath: "/usr/bin/true" }),
    /提前退出/,
  )
  assert.ok(Date.now() - t0 < 5_000, `应在秒级失败，实耗 ${Date.now() - t0}ms`)
  rmSync(dir, { recursive: true, force: true })
})

test("chromeScreenshotRunner: Chrome 缺失 → 可读错误", async () => {
  await assert.rejects(
    chromeScreenshotRunner("/nonexistent.html", "/tmp/nonexistent-out.png", { chromePath: "/nonexistent/chrome" }),
    /Chrome\/Chromium 未找到/,
  )
})

// ── 真渲染冒烟（仅本机有 Chrome 时；无则跳过）──

test("renderMindmapMarkmap: 真实 Chrome 冒烟（本地资产 + headless 截图 + IEND 判据）", { timeout: 40_000 }, async (t) => {
  const outDir = mkdtempSync(path.join(tmpdir(), "ltutor-mindmap-real-"))
  const result = await renderMindmapMarkmap(normalizeOutline(SAMPLE), { outDir })
  if (!result.ok && /Chrome\/Chromium 未找到/.test(result.error ?? "")) {
    t.skip("本机无 Chrome/Chromium——真渲染冒烟不可用（差额复验 §6.3：静默 return 改可见 skip）")
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

test("I-A 内容保真: HTML 标签字面文本经实体转义可见（不 被 markdown 吃掉）", () => {
  const md = outlineToMarkdown(normalizeOutline({
    title: "HTML 基础",
    root: { children: [{ label: "语法：<!-- 注释 -->" }, { label: "<script> 标签" }] },
  }))
  assert.ok(md.includes("语法：&lt;!-- 注释 -->"))
  // <script> → &lt;script>（> 无需转义，中段字面安全）
  assert.ok(md.includes("&lt;script> 标签"))
  assert.ok(!md.includes("<script> 标签"), "裸 <script> 不得进 markdown")
})
