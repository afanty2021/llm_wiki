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
import { closeSync, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  countNodes,
  friendlyRenderError,
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
export const ASSET_BASE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "node_modules")

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

/** 三资产相对路径（评审 I-A.2：渲染前 existsSync 预检，404 白屏成功不再可能）。 */
export const MARKMAP_ASSET_RELPATHS = [
  "markmap-lib/dist/browser/index.iife.js",
  "d3/dist/d3.min.js",
  "markmap-view/dist/browser/index.js",
]

/** PNG 完整性：末 12 字节 = 空 IEND 长度 + "IEND" + 固定 CRC（评审 I-A 完成判据）。 */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const PNG_IEND_TRAILER = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82])
const PNG_MIN_BYTES = 100

export function isCompletePng(path: string): boolean {
  try {
    const fd = openSync(path, "r")
    try {
      const size = fstatSync(fd).size
      if (size < PNG_SIGNATURE.length + PNG_IEND_TRAILER.length || size < PNG_MIN_BYTES) return false
      const tail = Buffer.alloc(PNG_IEND_TRAILER.length)
      readSync(fd, tail, 0, tail.length, size - tail.length)
      return tail.equals(PNG_IEND_TRAILER)
    } finally {
      closeSync(fd)
    }
  } catch {
    return false
  }
}

/**
 * outline → markmap markdown。控制字符压空格；`&`/`<` 转 HTML 实体——
 * markdown 渲染层会把 `<...>` 当内联 HTML 吃掉（HTML 教学导图内容静默缺失，
 * 2026-09-10 v2 目检实锺），实体形态在标签里还原为字面文本。
 */
export function outlineToMarkdown(outline: MindmapOutline): string {
  const escapeLabel = (s: string) => s
    .replace(/[\x00-\x1f]+/g, " ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
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

/** markdown 内联进页面的安全形态：base64（评审 I-A——任何内容形态（`<!--`/
 * `</script>`/`<script`）都不再进入 HTML 解析器，script data 状态机类吞标签
 * 白屏成功整类消灭；页内 atob+TextDecoder 还原 UTF-8）。 */
function encodeInline(markdown: string): string {
  return Buffer.from(markdown, "utf8").toString("base64")
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
<script src="file://${join(opts.assetBase, MARKMAP_ASSET_RELPATHS[0]!)}"></script>
<script src="file://${join(opts.assetBase, MARKMAP_ASSET_RELPATHS[1]!)}"></script>
<script src="file://${join(opts.assetBase, MARKMAP_ASSET_RELPATHS[2]!)}"></script>
<script>
  const PALETTE = ${JSON.stringify(BRANCH_PALETTE)};
  const ROOT_COLOR = ${JSON.stringify(ROOT_COLOR)};
  const src = new TextDecoder().decode(Uint8Array.from(atob("${encodeInline(markdown)}"), (c) => c.charCodeAt(0)));
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
 * 评审 I-B：监听 exit——Chrome 提前退出且无 PNG 时立即失败（快回落，不再固定烧满超时）；
 * 与轮询 resolve 竞态时 settled 保证 no-op。
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
      let settled = false
      const finish = (err?: Error) => {
        if (settled) return
        settled = true
        clearInterval(poll)
        err ? reject(err) : resolve()
      }
      const poll = setInterval(() => {
        if (existsSync(outPath)) finish()
      }, MARKMAP_POLL_MS)
      child.on("error", (err) => finish(err instanceof Error ? err : new Error(String(err))))
      child.on("exit", () => {
        if (existsSync(outPath)) finish()
        else finish(new Error("Chrome 提前退出且未产出截图（安装损坏或参数异常）"))
      })
      setTimeout(() => {
        kill()
        finish(existsSync(outPath) ? undefined : new Error(`Chrome 截图超时（${MARKMAP_KILL_AFTER_MS}ms 内未产出 PNG）`))
      }, MARKMAP_KILL_AFTER_MS).unref()
    })
  } catch (err) {
    console.error("[mindmap] markmap headless 截图失败:", err instanceof Error ? err.message : err)
    throw err
  } finally {
    kill()
    rmSync(profileDir, { recursive: true, force: true })
  }
}

/**
 * markmap 渲染：成功返回 { ok, path, engine:"markmap", nodes, depth }；
 * 失败返回 { ok:false, error }（调用方 renderMindmapAuto 回落 graphviz），绝不抛错。
 * 完成判据 = PNG 末 12 字节 IEND（评审 I-A：文件存在≠渲染成功——白屏/半截 PNG
 * 均不得 ok:true）；截图落临时名、IEND 过后 renameSync 终名（顺解并发同图互写）。
 */
export async function renderMindmapMarkmap(
  outline: MindmapOutline,
  deps: MindmapMarkmapDeps = {},
): Promise<MindmapRenderResult> {
  const outDir = deps.outDir ?? DEFAULT_MARKMAP_OUT_DIR
  const assetBase = deps.assetBase ?? ASSET_BASE
  const missing = MARKMAP_ASSET_RELPATHS.filter((rel) => !existsSync(join(assetBase, rel)))
  if (missing.length > 0) {
    return { ok: false, error: `markmap 资产缺失（${missing.join(", ")}）——请在 mcp-server 目录 npm install 后重试` }
  }
  const screenshot = deps.screenshot ?? ((htmlPath, outPath) => chromeScreenshotRunner(htmlPath, outPath, { chromePath: deps.chromePath }))
  try {
    mkdirSync(outDir, { recursive: true })
    const tmp = mkdtempSync(join(outDir, "tmp-mm-"))
    try {
      const htmlPath = join(tmp, "page.html")
      const shotPath = join(tmp, "shot.png")
      const finalPath = join(outDir, `mindmap-markmap-${hashOutline(outline)}.png`)
      writeFileSync(htmlPath, buildMarkmapHtml(outlineToMarkdown(outline), {
        assetBase, width: MARKMAP_CANVAS_W, height: MARKMAP_CANVAS_H,
      }), "utf8")
      await screenshot(htmlPath, shotPath)
      if (!isCompletePng(shotPath)) {
        return { ok: false, error: "截图不完整（PNG 缺 IEND 结束标记或过小，疑似白屏/半截）——请重试或改用文字版大纲" }
      }
      renameSync(shotPath, finalPath)
      return { ok: true, path: finalPath, engine: "markmap", nodes: countNodes(outline.root), depth: maxDepth(outline.root) + 1 }
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  } catch (err) {
    return { ok: false, error: friendlyRenderError(err) }
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
    // M2'：聚合错误同样过 friendlyRenderError——内部绝对路径不进模型视野。
    error: friendlyRenderError(
      new Error(`markmap 与 graphviz 渲染均失败：${primary.error ?? "?"}；${fallback.error ?? "?"}`),
    ),
  }
}

function hashOutline(outline: MindmapOutline): string {
  return createHash("sha1").update(outlineToMarkdown(outline)).digest("hex").slice(0, 12)
}
