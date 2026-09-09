/**
 * 思维导图 markmap 渲染引擎 v2（2026-09-09 方案的 markmap 美化迭代）。
 *
 * 管线：outline JSON → markdown（# 主题 + 缩进列表）→ 自包含 HTML
 * （本地 node_modules 资产：markmap-lib iife + d3 + markmap-view，零 CDN）
 * → headless Chrome `--screenshot` → PNG。
 *
 * 探针实证（2026-09-10，/tmp 探针两轮）：
 * - 曲线分支/中文 PingFang/mm.fit() 全部正常；1500×1100@2x 产出 3000×2200 PNG；
 * - 本 Chrome 152 在 `--headless=new --screenshot` 下写完截图后进程不自退
 *   （--virtual-time-budget / --timeout 均不能令其退出）→ 渲染器采用
 *   「轮询 PNG 出现即 SIGKILL」策略，典型 ~2s，封顶超时兜底；
 * - 配色按 node.state.path 计算分支号不可靠（同层全同色）→ 页面 JS 预遍历
 *   数据树，按一级分支序号固定色相（经典导图惯例：同枝同色）。
 *
 * 可靠性：markmap 失败（Chrome 缺失等）→ renderMindmapAuto 回落 v1 graphviz。
 */
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  countNodes,
  maxDepth,
  renderMindmap,
  type MindmapNode,
  type MindmapOutline,
  type MindmapRenderDeps,
  type MindmapRenderResult,
} from "./mindmap.js"

export const MARKMAP_CANVAS_W = 1500
export const MARKMAP_CANVAS_H = 1100
/** 截图产出 PNG 存在即视为完成；此后无论 Chrome 是否自退都 SIGKILL。 */
export const MARKMAP_POLL_MS = 200
export const MARKMAP_KILL_AFTER_MS = 20_000
export const DEFAULT_MARKMAP_OUT_DIR = join(homedir(), ".hermes", "cache", "ltutor-mindmap")

/** dist/src/ → mcp-server/node_modules（markmap/d3 本地资产，零 CDN 依赖）。 */
const ASSET_BASE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "node_modules")

const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  join(homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
]

export interface MindmapMarkmapDeps {
  outDir?: string
  assetBase?: string
  chromePath?: string
  /** 截图执行体（测试注入）；默认 = headless Chrome 轮询击杀 runner。 */
  screenshot?: (htmlPath: string, outPath: string) => Promise<void>
}

/** 一级分支色相板（探针 2 样式固化）：同枝同色，按分支序号轮换。 */
const BRANCH_PALETTE = ["#E668A7", "#5FA0E8", "#66B987", "#E6A23C", "#8E7BE6", "#5EC2C2"]
const ROOT_COLOR = "#4C6FFF"

/**
 * outline → markmap markdown。换行/制表压成空格（列表行结构唯一硬约束；
 * 中段 #*-+ 等在列表行内是字面文本，探针实证无需转义）。
 */
export function outlineToMarkdown(outline: MindmapOutline): string {
  const escapeLabel = (s: string) => s.replace(/[\r\n\t]+/g, " ")
  const lines: string[] = [`# ${escapeLabel(outline.title)}`]
  const walk = (node: MindmapNode, depth: number): void => {
    for (const child of node.children) {
      lines.push(`${"  ".repeat(depth)}- ${escapeLabel(child.label)}`)
      walk(child, depth + 1)
    }
  }
  // 首层 0 缩进（与探针逐字对齐——已实测渲染正确的形态优先于理论等价形态）。
  walk(outline.root, 0)
  return lines.join("\n") + "\n"
}

/** markdown 内联进 <script type="text/template"> 的安全转义：`</` 破坏标签边界。 */
function escapeScriptClose(s: string): string {
  return s.replace(/<\//g, "<\\/")
}

export function buildMarkmapHtml(markdown: string, opts: { assetBase: string; width: number; height: number }): string {
  const inner = opts.width - 40
  const innerH = opts.height - 40
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;background:#fff}
  #wrap{width:${opts.width}px;height:${opts.height}px;display:flex;align-items:center;justify-content:center}
  svg.markmap{width:${inner}px;height:${innerH}px;font-family:'PingFang SC','Hiragino Sans GB',sans-serif}
  svg.markmap .markmap-node-text{fill:#333}
</style></head><body>
<div id="wrap"><svg class="markmap" id="mm"></svg></div>
<script type="text/template" class="markmap" id="src">${escapeScriptClose(markdown)}</script>
<script src="file://${join(opts.assetBase, "markmap-lib/dist/browser/index.iife.js")}"></script>
<script src="file://${join(opts.assetBase, "d3/dist/d3.min.js")}"></script>
<script src="file://${join(opts.assetBase, "markmap-view/dist/browser/index.js")}"></script>
<script>
  const PALETTE = ${JSON.stringify(BRANCH_PALETTE)};
  const ROOT_COLOR = ${JSON.stringify(ROOT_COLOR)};
  const src = document.getElementById('src').textContent;
  const { Transformer, Markmap } = markmap;
  const data = new Transformer().transform(src).root;
  // 预遍历：按一级分支序号固定色相（node.state.path 同层同值不可用，探针实证）。
  (function paint(node, color) {
    node._color = color;
    node.children.forEach((child) => paint(child, color));
  })(data, ROOT_COLOR);
  (data.children || []).forEach((branch, i) => {
    const hue = PALETTE[i % PALETTE.length];
    (function walk(n) { n._color = hue; (n.children || []).forEach(walk); })(branch);
  });
  const mm = Markmap.create(document.getElementById('mm'), {
    autoFit: false, duration: 0, spacingVertical: 12, spacingHorizontal: 110,
    paddingX: 24, color: (node) => node._color || ROOT_COLOR,
  }, data);
  mm.fit();
</script>
</body></html>
`
}

function resolveChromePath(explicit?: string): string | null {
  if (explicit) return existsSync(explicit) ? explicit : null
  for (const candidate of CHROME_CANDIDATES) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * headless Chrome 截图 runner：spawn 后轮询 PNG 出现 → SIGKILL。
 * （本机 Chrome 152 --screenshot 后进程不自退，--timeout/--virtual-time-budget 均无效，探针实证。）
 */
export async function chromeScreenshotRunner(htmlPath: string, outPath: string, opts: { chromePath?: string } = {}): Promise<void> {
  const chrome = resolveChromePath(opts.chromePath)
  if (!chrome) throw new Error("Chrome/Chromium 未找到（headless 截图不可用）")
  const profileDir = mkdtempSync(join(dirname(outPath), "chrome-profile-"))
  const child = spawn(chrome, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--hide-scrollbars", `--user-data-dir=${profileDir}`,
    `--window-size=${MARKMAP_CANVAS_W},${MARKMAP_CANVAS_H}`,
    "--force-device-scale-factor=2", `--screenshot=${outPath}`,
    `file://${htmlPath}`,
  ], { stdio: "ignore" })
  const kill = () => {
    try { child.kill("SIGKILL") } catch { /* 已退出 */ }
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const poll = setInterval(() => {
        if (existsSync(outPath)) {
          clearInterval(poll)
          resolve()
        }
      }, MARKMAP_POLL_MS)
      child.on("error", (err) => {
        clearInterval(poll)
        reject(err)
      })
      setTimeout(() => {
        clearInterval(poll)
        if (existsSync(outPath)) resolve()
        else reject(new Error(`Chrome 截图超时（${MARKMAP_KILL_AFTER_MS}ms 内未产出 PNG）`))
      }, MARKMAP_KILL_AFTER_MS).unref()
    })
  } finally {
    kill()
    rmSync(profileDir, { recursive: true, force: true })
  }
}

/**
 * markmap 渲染：成功返回 { ok, path, nodes, depth, engine:"markmap" }；
 * 失败返回 { ok:false, error }（调用方 renderMindmapAuto 回落 graphviz）。
 */
export async function renderMindmapMarkmap(
  outline: MindmapOutline,
  deps: MindmapMarkmapDeps = {},
): Promise<MindmapRenderResult> {
  const outDir = deps.outDir ?? DEFAULT_MARKMAP_OUT_DIR
  const screenshot = deps.screenshot ?? ((htmlPath, outPath) => chromeScreenshotRunner(htmlPath, outPath, { chromePath: deps.chromePath }))
  try {
    mkdirSync(outDir, { recursive: true })
    const tmp = mkdtempSync(join(outDir, "tmp-mm-"))
    try {
      const htmlPath = join(tmp, "page.html")
      const finalPath = join(outDir, `mindmap-markmap-${hashOutline(outline)}.png`)
      writeFileSync(htmlPath, buildMarkmapHtml(outlineToMarkdown(outline), {
        assetBase: deps.assetBase ?? ASSET_BASE, width: MARKMAP_CANVAS_W, height: MARKMAP_CANVAS_H,
      }), "utf8")
      await screenshot(htmlPath, finalPath)
      if (!existsSync(finalPath)) return { ok: false, error: "截图完成但 PNG 未落盘" }
      return { ok: true, path: finalPath, engine: "markmap", nodes: countNodes(outline.root), depth: maxDepth(outline.root) + 1 }
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}

/** v2 首选 markmap、失败回落 v1 graphviz 的自动链。 */
export async function renderMindmapAuto(
  outline: MindmapOutline,
  deps: { markmap?: MindmapMarkmapDeps; graphviz?: MindmapRenderDeps } = {},
): Promise<MindmapRenderResult> {
  const primary = await renderMindmapMarkmap(outline, deps.markmap ?? {})
  if (primary.ok) return primary
  const fallback = await renderMindmap(outline, deps.graphviz ?? {})
  return fallback.ok ? fallback : {
    ...fallback,
    error: `markmap 与 graphviz 渲染均失败：${primary.error ?? "?"}；${fallback.error ?? "?"}`,
  }
}

function hashOutline(outline: MindmapOutline): string {
  return createHash("sha1").update(outlineToMarkdown(outline)).digest("hex").slice(0, 12)
}
