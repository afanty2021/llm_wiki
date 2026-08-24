// tools/books/mineru_parse.ts —— MinerU 桥接（spec §3 双协议，参 src/lib/mineru.ts:698-853 本地分支）
// 用法：npx tsx tools/books/mineru_parse.ts --book <slug> --dir /tmp/books [--only Ch01] [--force] [--concurrency N] [--config tools/books/books.json]
// 产出：<dir>/<slug>/staged/ChNN-*.md（清洗后、带上源头的章节 markdown）+ parse-report.json
// 量化闸：非空白字符/页 < gate.minCharsPerPage（默认 200）→ gate_blocked，不落 staged（Task 9 只消费过闸章节）。
// 断点续跑：staged 已存在的章默认跳过（--force 重解析）。
// 并发：--concurrency N（默认 2，上限 4）——缓存命中的跳过仍串行先行；未解析章由 N 个
// worker 并行处理（mineru-api 单进程共享已加载流水线，并发主要吃空闲 CPU 核）。单章失败
// 仅记 failed 不影响其他章；报告条目写入前按 manifest 章序排序（并发完成序不确定）。
//
// 本地协议实测注记（2026-08-23，mineru-api 3.4.5 / protocol_version 2）：
// - POST /tasks 返回 202 + {task_id, status:"pending"}；GET /tasks/:id 状态词表
//   "pending" → "processing" → 终态 "completed" | "failed"（终态与桌面端 src/lib/mineru.ts:787/845 一致）。
// - 首次解析会按需下载模型权重；期间 /tasks/:id 可能连续若干次返回空体 —— 轮询需容忍瞬时非 JSON 响应。
// - lang_list="en" 服务端实测接受（202），尽管 OpenAPI items enum 只列 ch/ch_server/korean/…；
//   若换版本被 422 拒绝，回退 "ch"（官方描述 ch 覆盖 Chinese/English/Japanese/Latin）。
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import { parseArgs } from "node:util"

// ── 配置 ──

// backend：multipart 表单的解析后端，默认 "hybrid-engine"（同桌面端 mineru.ts:711）。
// 宿主 MPS 部署（mineru-api 直接跑在 macOS 宿主）实测 hybrid-engine 慢/不可用，
// books.json 设 "pipeline"（parse_method auto/ocr 兜底走 OCR）约快 15×。
interface LocalCfg { baseUrl: string; token?: string; backend?: string }
interface GateCfg { minCharsPerPage?: number }
interface BooksConfig {
  mode: "local" | "cloud"
  local: LocalCfg
  cloud: { token?: string }
  gate: GateCfg
}

interface ManifestChapter {
  file: string
  title: string
  from_page: number
  to_page: number
  est_tokens?: number
}
interface Manifest { book: string; total_pages: number; chapters: ManifestChapter[] }

interface ChapterReport {
  file: string
  title: string
  status: "ok" | "gate_blocked" | "failed" | "not_selected"
  /** 解析指标（not_selected 未解析，不含）。 */
  pages?: number
  chars?: number
  ratio?: number
  seconds?: number
  error?: string
  cached?: boolean
}

const LOCAL_POLL_INTERVAL_MS = 3_000
const LOCAL_POLL_TIMEOUT_MS = 3_600_000
const CLOUD_POLL_TIMEOUT_MS = 300_000
const DEFAULT_MIN_CHARS_PER_PAGE = 200
const DEFAULT_CONCURRENCY = 2
const MAX_CONCURRENCY = 4

// ── HTML 表格 → Markdown（自 src/lib/mineru.ts:288-370 移植，纯字符串处理，无 Tauri 依赖） ──

function decodeHtmlEntities(text: string): string {
  const safeCodePoint = (raw: string, radix: 10 | 16): string => {
    const n = Number.parseInt(raw, radix)
    if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return radix === 16 ? `&#x${raw};` : `&#${raw};`
    try {
      return String.fromCodePoint(n)
    } catch {
      return radix === 16 ? `&#x${raw};` : `&#${raw};`
    }
  }

  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_m, code: string) => safeCodePoint(code, 10))
    .replace(/&#x([0-9a-f]+);/gi, (_m, code: string) => safeCodePoint(code, 16))
}

function htmlImgTagsToMarkdown(html: string): string {
  return html.replace(/<img\b[^>]*\bsrc=(["'])([^"']+)\1[^>]*>/gi, (full, _quote: string, src: string) => {
    const alt = full.match(/\balt=(["'])([^"']*)\1/i)?.[2] ?? ""
    return `![${alt}](${src})`
  })
}

function htmlCellToMarkdown(cell: string): string {
  return decodeHtmlEntities(
    htmlImgTagsToMarkdown(cell)
      .replace(/<br\s*\/?>/gi, "<br>")
      .replace(/<\/p\s*>/gi, "<br>")
      .replace(/<[^>]+>/g, "")
      .replace(/\s*<br>\s*/gi, "<br>")
      .replace(/\s+/g, " ")
      .trim(),
  ).replace(/\|/g, "\\|")
}

function convertHtmlTablesInSegment(segment: string): string {
  return segment.replace(/<table\b[\s\S]*?<\/table>/gi, (tableHtml) => {
    const rows: string[][] = []
    for (const rowMatch of tableHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const rowHtml = rowMatch[1] ?? ""
      const cells: string[] = []
      for (const cellMatch of rowHtml.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)) {
        cells.push(htmlCellToMarkdown(cellMatch[1] ?? ""))
      }
      if (cells.length > 0) rows.push(cells)
    }
    if (rows.length === 0) return tableHtml

    const width = Math.max(...rows.map((row) => row.length))
    const padded = rows.map((row) => {
      const out = [...row]
      while (out.length < width) out.push("")
      return out
    })
    const header = padded[0]
    const separator = Array.from({ length: width }, () => "---")
    const body = padded.slice(1)
    return [
      "",
      `| ${header.join(" | ")} |`,
      `| ${separator.join(" | ")} |`,
      ...body.map((row) => `| ${row.join(" | ")} |`),
      "",
    ].join("\n")
  })
}

function convertHtmlTablesToMarkdown(markdown: string): string {
  return markdown
    .split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g)
    .map((segment) => (
      segment.startsWith("```") || segment.startsWith("~~~")
        ? segment
        : convertHtmlTablesInSegment(segment)
    ))
    .join("")
}

// ── 本地协议：multipart POST /tasks → 轮询 GET /tasks/:id → GET /tasks/:id/result 取 md_content ──

// 终态词表：主用实测/桌面端一致的 "completed"|"failed"；同义词防御性兜底（未知状态仅记录继续轮询）。
const SUCCESS_STATUSES = new Set(["completed", "done", "success", "finished"])
const FAILURE_STATUSES = new Set(["failed", "error"])

async function localJson(url: string, token: string | undefined): Promise<unknown | null> {
  try {
    const res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
    if (!res.ok) return null // 瞬时错误（含首跑模型下载期的空体响应）交给下一轮轮询
    return await res.json()
  } catch {
    return null
  }
}

async function parseLocal(pdf: Buffer, name: string, cfg: LocalCfg, log: (msg: string) => void): Promise<string> {
  const form = new FormData()
  form.append("files", new Blob([pdf], { type: "application/pdf" }), name)
  form.append("lang_list", "en")
  form.append("backend", cfg.backend ?? "hybrid-engine") // 默认 hybrid-engine（mineru.ts:711）；宿主 MPS 部署经 books.json local.backend 配 "pipeline"
  form.append("effort", "medium")
  form.append("parse_method", "auto")
  form.append("formula_enable", "true")
  form.append("table_enable", "true")
  form.append("return_md", "true")
  form.append("return_images", "false")
  form.append("response_format_zip", "false")

  const submit = await fetch(`${cfg.baseUrl}/tasks`, {
    method: "POST",
    body: form,
    headers: cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {},
  })
  if (!submit.ok) throw new Error(`local submit HTTP ${submit.status}: ${(await submit.text()).slice(0, 300)}`)
  const submitted = await submit.json() as { task_id?: string }
  const tid = submitted.task_id?.trim()
  if (!tid) throw new Error(`local MinerU returned no task ID: ${JSON.stringify(submitted).slice(0, 200)}`)
  log(`task ${tid}`)

  const statusUrl = `${cfg.baseUrl}/tasks/${encodeURIComponent(tid)}`
  const resultUrl = `${statusUrl}/result`
  const start = Date.now()
  let lastStatus = ""
  while (Date.now() - start < LOCAL_POLL_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, LOCAL_POLL_INTERVAL_MS))
    const st = await localJson(statusUrl, cfg.token) as { status?: string; error?: unknown } | null
    if (!st || typeof st.status !== "string") continue // 空体/非 JSON：模型下载期实测出现，重试
    if (st.status !== lastStatus) {
      lastStatus = st.status
      log(`status=${st.status} (+${Math.round((Date.now() - start) / 1000)}s)`)
    }
    if (SUCCESS_STATUSES.has(st.status)) {
      const result = await localJson(resultUrl, cfg.token) as {
        results?: Record<string, { md_content?: unknown }>
      } | null
      const md = result && result.results
        ? Object.values(result.results)[0]?.md_content
        : undefined
      if (typeof md !== "string" || !md.trim()) {
        throw new Error(`local MinerU returned empty md_content: ${JSON.stringify(result ?? {}).slice(0, 200)}`)
      }
      return convertHtmlTablesToMarkdown(md)
    }
    if (FAILURE_STATUSES.has(st.status)) {
      throw new Error(`local task failed: ${JSON.stringify(st).slice(0, 300)}`)
    }
  }
  throw new Error(`local MinerU poll timeout (${LOCAL_POLL_TIMEOUT_MS / 60_000}min), last status=${lastStatus}`)
}

// ── 云端协议（条件任务，评审 I-8：仅先决检查选云 token 时实现）——
// 锚点：src/lib/mineru.ts:429-571（桌面端云端分支完整实现，可整段参考移植）。
// 要点：POST https://mineru.net/api/v4/extract/task 带 Bearer token（cloud.token）→ 轮询
// task/batch（CLOUD_POLL_TIMEOUT_MS 5min 上限）→ 状态 done 后取 full_zip_url 下载 zip
// （jszip，root node_modules 已有）→ 解出 .md → 走下方同一 convertHtmlTables/clean/gate。
// 本任务先决裁定走本地 docker（tools/books/README.md §2.1 用户决策），此分支保持 TODO。

// ── 清洗 + 质量闸 ──

function clean(md: string, book: string, file: string): string {
  const noImages = md
    // 剥图片引用：alt/URL 均可跨行（字符类含 \n；URL 侧容忍一层嵌套括号，同 mineru.ts:393 风格）
    .replace(/!\[[^\]]*\]\((?:[^()]|\([^()]*\))*\)/g, "")
    // 残留 <img> HTML 标签（未请求图片时 MinerU 偶发输出）
    .replace(/<img\b[^>]*>/gi, "")
  const header = `> 来源：${book} · ${file.replace(/\.pdf$/, "")}\n\n`
  return header + noImages.trim() + "\n"
}

function nonWhitespaceChars(md: string): number {
  return md.replace(/\s/g, "").length
}

function gate(chars: number, pages: number, minPerPage: number): boolean {
  return chars / pages >= minPerPage
}

// ── main ──

function die(msg: string): never {
  console.error(`[mineru_parse] ${msg}`)
  process.exit(1)
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      book: { type: "string" },
      dir: { type: "string", default: "/tmp/books" },
      only: { type: "string" },
      config: { type: "string" },
      force: { type: "boolean", default: false },
      concurrency: { type: "string" },
    },
  })
  const bookSlug = values.book
  if (!bookSlug) die("--book <slug> is required (e.g. LT-LearningTeaching-3rd)")

  // --concurrency N：未解析章的并行度。1 = 单 worker 依序执行，与历史串行路径行为一致。
  let concurrency = DEFAULT_CONCURRENCY
  if (values.concurrency !== undefined) {
    const m = /^(\d+)$/.exec(values.concurrency)
    const n = m ? Number(m[1]) : NaN
    if (!Number.isInteger(n) || n < 1) {
      die(`--concurrency must be an integer in [1, ${MAX_CONCURRENCY}] (got "${values.concurrency}")`)
    }
    if (n > MAX_CONCURRENCY) {
      console.warn(`[mineru_parse] --concurrency ${n} > ${MAX_CONCURRENCY}（mineru-api 单进程共享流水线），按 ${MAX_CONCURRENCY} 执行`)
      concurrency = MAX_CONCURRENCY
    } else {
      concurrency = n
    }
  }
  const configPath = values.config ?? fileURLToPath(new URL("books.json", import.meta.url))

  let cfg: BooksConfig
  try {
    cfg = JSON.parse(readFileSync(configPath, "utf8")) as BooksConfig
  } catch (err) {
    die(`cannot read config ${configPath}: ${err instanceof Error ? err.message : err}`)
  }
  if (!cfg.local?.baseUrl) die(`config missing local.baseUrl: ${configPath}`)
  const minPerPage = cfg.gate?.minCharsPerPage ?? DEFAULT_MIN_CHARS_PER_PAGE
  if (cfg.mode === "cloud") {
    die("cloud protocol not implemented (先决裁定走本地 docker)；移植时参考 src/lib/mineru.ts:429-571")
  }

  const bookDir = join(values.dir!, bookSlug)
  const manifestPath = join(bookDir, "manifest.json")
  let manifest: Manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest
  } catch (err) {
    die(`cannot read manifest ${manifestPath}: ${err instanceof Error ? err.message : err}`)
  }

  const all = manifest.chapters ?? []
  const chapters = values.only ? all.filter((c) => c.file.includes(values.only!)) : all
  if (chapters.length === 0) {
    die(`no chapter matches --only "${values.only}" (manifest has ${all.length} chapters)`)
  }
  const stagedDir = join(bookDir, "staged")
  mkdirSync(stagedDir, { recursive: true })

  console.log(
    `[mineru_parse] book=${bookSlug} chapters=${chapters.length}/${all.length}` +
    ` mode=local baseUrl=${cfg.local.baseUrl} gate=${minPerPage} chars/page concurrency=${concurrency}` +
    (values.only ? ` only="${values.only}"` : "") + (values.force ? " force" : ""),
  )

  const reports: ChapterReport[] = []

  // Pass 1（串行，缓存命中瞬时完成）：staged 已存在的章跳过（--force 重解析）。
  const pending: ManifestChapter[] = []
  for (const ch of chapters) {
    const stagedPath = join(stagedDir, ch.file.replace(/\.pdf$/, ".md"))
    if (values.force || !existsSync(stagedPath)) {
      pending.push(ch)
      continue
    }
    // 与新解析同一口径：闸指标不含我们自己加的来源头
    const pages = ch.to_page - ch.from_page + 1
    const chars = nonWhitespaceChars(readFileSync(stagedPath, "utf8").replace(/^> 来源：[^\n]*\n\n/, ""))
    reports.push({
      file: ch.file, title: ch.title, status: "ok", pages,
      chars, ratio: Math.round((chars / pages) * 10) / 10,
      seconds: 0, cached: true,
    })
    console.log(`  [cached] ${ch.file} (${chars} chars)`)
  }

  // Pass 2：未解析章，N 个 worker 并行。单章流程与串行版逐步一致
  // （submit → poll → result → 表格转换 → clean → gate → stage）；
  // processChapter 永不抛出——单章失败只记 failed 报告项，不影响其他章（错误隔离）。
  // 日志均为整行单次 console 调用 + [ChNN] 前缀，多 worker 交错不会破行。
  async function processChapter(ch: ManifestChapter): Promise<ChapterReport> {
    const pages = ch.to_page - ch.from_page + 1
    const stagedPath = join(stagedDir, ch.file.replace(/\.pdf$/, ".md"))
    const prefix = `  [${ch.file}]`
    const started = Date.now()
    try {
      const pdfPath = join(bookDir, ch.file)
      const pdf = readFileSync(pdfPath)
      const md0 = await parseLocal(pdf, ch.file, cfg.local, (msg) => console.log(`${prefix} ${msg}`))
      const cleaned = clean(md0, manifest.book, ch.file)
      // 闸指标只量测 OCR 正文（剥掉我们自己加的来源头，避免闸被固定头部稀释/污染）
      const body = cleaned.replace(/^> 来源：[^\n]*\n\n/, "")
      const chars = nonWhitespaceChars(body)
      const ratio = Math.round((chars / pages) * 10) / 10
      const seconds = Math.round((Date.now() - started) / 1000)
      if (!gate(chars, pages, minPerPage)) {
        console.log(`${prefix} gate_blocked: ${ratio} chars/page < ${minPerPage} (${chars} chars / ${pages} pages)`)
        return {
          file: ch.file, title: ch.title, status: "gate_blocked", pages,
          chars, ratio, seconds,
          error: `${ratio} chars/page < ${minPerPage} (pages=${pages})`,
        }
      }
      writeFileSync(stagedPath, cleaned)
      console.log(`${prefix} ok: ${chars} chars / ${pages} pages = ${ratio} chars/page (${seconds}s)`)
      return { file: ch.file, title: ch.title, status: "ok", pages, chars, ratio, seconds }
    } catch (err) {
      const seconds = Math.round((Date.now() - started) / 1000)
      const message = err instanceof Error ? err.message : String(err)
      console.error(`${prefix} failed: ${message}`)
      return { file: ch.file, title: ch.title, status: "failed", pages, chars: 0, ratio: 0, seconds, error: message }
    }
  }

  if (pending.length > 0) {
    console.log(`[mineru_parse] parsing ${pending.length} chapter(s), concurrency=${concurrency}`)
    // 工人池：N 个 worker 共享递增下标拉章。取号（next++）在任一 await 前同步完成，
    // 单线程事件循环下不会重号/漏号；concurrency=1 时退化为单 worker 依序执行。
    let next = 0
    const worker = async (): Promise<void> => {
      while (true) {
        const i = next++
        if (i >= pending.length) return
        reports.push(await processChapter(pending[i]!))
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, () => worker()))
  }

  // --only 子集运行（终审 F4）：未选章以 not_selected 记入报告，保证 parse-report.json
  // 始终覆盖 manifest 全部章——否则报告只剩子集，随后 upload_and_ingest 直跑会静默
  // 部分上传（upload 侧 status!==ok 一律 skip 并逐条列出，not_selected 即显式可见，
  // 与流水线「断言防静默」立场一致）。只记 file/title，不落 staged（无解析产物）。
  const selected = new Set(chapters)
  for (const ch of all) {
    if (!selected.has(ch)) {
      reports.push({ file: ch.file, title: ch.title, status: "not_selected" })
    }
  }

  // 并发完成序 ≠ 章序：写入前按 manifest 章序排序，报告确定可 diff（summary 只数
  // 状态，不受顺序影响；sort 稳定，未知 file 兜底排末尾）。
  const order = new Map(all.map((c, i) => [c.file, i]))
  reports.sort((a, b) => (order.get(a.file) ?? all.length) - (order.get(b.file) ?? all.length))

  const summary = {
    ok: reports.filter((r) => r.status === "ok").length,
    gate_blocked: reports.filter((r) => r.status === "gate_blocked").length,
    failed: reports.filter((r) => r.status === "failed").length,
    not_selected: reports.filter((r) => r.status === "not_selected").length,
  }
  const report = {
    book: manifest.book,
    mode: "local",
    baseUrl: cfg.local.baseUrl,
    minCharsPerPage: minPerPage,
    generatedAt: new Date().toISOString(),
    summary: { ...summary, total: reports.length },
    chapters: reports,
  }
  const reportPath = join(bookDir, "parse-report.json")
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  console.log(
    `[mineru_parse] done: ok=${summary.ok} gate_blocked=${summary.gate_blocked} failed=${summary.failed}` +
    (summary.not_selected > 0 ? ` not_selected=${summary.not_selected}（--only 子集；报告已全量覆盖 manifest 章）` : "") +
    ` → ${reportPath}`,
  )
  if (summary.failed > 0 || summary.gate_blocked > 0) process.exit(1)
}

await main()
