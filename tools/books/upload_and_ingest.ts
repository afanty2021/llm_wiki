// tools/books/upload_and_ingest.ts —— Task 9：staged 章节 → src-server 上传 + 分批摄取
// 用法：npx tsx tools/books/upload_and_ingest.ts --book <slug> [--dir /tmp/books]
//        [--batch-size 5] [--config tools/books/books.json] [--dry-run]
// 消费：Task 8 产物 <dir>/<slug>/staged/ChNN-*.md + parse-report.json（只取 status=ok 章节，
//       gate_blocked/failed 只记入 report；parse 步骤非零退出无妨——只消费实际存在的 staged 文件）
// 产出：<dir>/<slug>/ingest-report.json（staged/ 旁）：每批 job_id/终态/new_pages/merged_pages/
//       warnings + 汇总（每批完成即落盘一次，中断也有已完成批次记录）。
//
// 断言（spec 写死项 9，违者整跑中止——防 PDF 误传命中 pdfium 路径、破坏 §1 source-type 归因）：
//   每个待上传文件：fileName 以 .md 结尾 且 上传路径以 raw/sources/<bookSlug>/ 开头
//   （另加防穿越/防分隔符检查；上传后服务端返回 path 与预期不一致同样按违例中止）。
// 凭证层（照抄 tools/transcriber/src/api-client.ts:178-283 模式）：login → Bearer；
//   401 → POST /auth/refresh 轮换重放 → 仍 401 → 重登录重放（会话内持有，不落盘）。
// 分批：4-6 章/批（--batch-size，默认 5）→ POST /api/v1/projects/:pid/ingest（source_paths）
//   → 轮询 GET /api/v1/ingest/jobs/:id 至终态（单批上限 30min；失败/超时记录后继续后续批，不中止）。
// 配置：books.json 可选 upload 段 {apiBase, username, password, projectId}，环境变量
//   BOOKS_UPLOAD_API_BASE / _USERNAME / _PASSWORD / _PROJECT_ID 覆盖；--dry-run 不需要凭证、零网络调用。
// 运维注记：目标 project 的 ingest_language 须已是"中文"（live LT 项目即如此；测试项目须设置）。
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import { parseArgs } from "node:util"

// ── 配置与类型 ──

interface UploadCfg {
  apiBase?: string
  username?: string
  password?: string
  projectId?: number
}
interface BooksConfig {
  mode?: string
  local?: { baseUrl?: string }
  cloud?: { token?: string }
  gate?: { minCharsPerPage?: number }
  upload?: UploadCfg
}

interface ChapterReport {
  file: string
  title: string
  status: "ok" | "gate_blocked" | "failed"
  error?: string
}
interface ParseReport {
  book: string
  generatedAt?: string
  chapters?: ChapterReport[]
}

/** GET /api/v1/ingest/jobs/:id 的精简视图（src-server JobResponse）；result 为 Task 3 起的 IngestJobResult。 */
interface IngestJob {
  id: string
  status: string
  stage?: string | null
  progress?: number
  error?: string | null
  result?: {
    new_pages?: string[]
    merged_pages?: string[]
    updated_reserved?: string[]
    warnings?: string[]
  } | null
}

interface UploadTarget {
  file: string // parse-report 章节名（.pdf）
  fileName: string // staged 文件名（.md）
  stagedPath: string
  uploadPath: string // raw/sources/<slug>/<fileName>
}

interface BatchReport {
  batch: number
  chapters: number
  source_paths: string[]
  job_id: string | null
  status: string // succeeded | succeeded_with_warnings | failed | cancelled | timeout | error
  seconds: number
  error?: string
  new_pages?: string[]
  merged_pages?: string[]
  updated_reserved?: string[]
  warnings?: string[]
}

const DEFAULT_DIR = "/tmp/books"
const DEFAULT_BATCH_SIZE = 5
const JOB_POLL_INTERVAL_MS = 5_000
const JOB_POLL_TIMEOUT_MS = 30 * 60_000 // spec 写死：单批轮询上限 30min
/** 服务端 ingest 终态词表（同 transcriber api-client.ts:15，src-server ingest_queue next_status）。 */
const TERMINAL_JOB_STATUSES = new Set(["succeeded", "succeeded_with_warnings", "failed", "cancelled"])
/** 上传路径前缀（断言②）：多源 source-type 归因依赖 raw/sources/ 约定。 */
const uploadPrefix = (slug: string) => `raw/sources/${slug}/`

function die(msg: string): never {
  console.error(`[upload_and_ingest] ${msg}`)
  process.exit(1)
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// ── 断言（spec 写死项 9）──

/** 上传前逐文件断言：返回违例列表（空 = 通过）。违例由调用方汇总后整跑中止。 */
function assertUploadTarget(slug: string, fileName: string): string[] {
  const path = `${uploadPrefix(slug)}${fileName}`
  const violations: string[] = []
  if (!fileName.endsWith(".md")) violations.push(`扩展名非 .md（防 PDF 误传命中 pdfium 路径）`)
  if (!path.startsWith(uploadPrefix(slug))) violations.push(`上传路径前缀不是 ${uploadPrefix(slug)}`)
  if (fileName.includes("/") || fileName.includes("\\") || path.includes("..")) {
    violations.push("文件名含路径分隔符/穿越段")
  }
  return violations
}

// ── 凭证 + API 薄客户端（移植 transcriber api-client.ts:178-283 凭证链）──

class ApiError extends Error {
  constructor(
    public status: number,
    public url: string,
    public body: unknown,
  ) {
    super(`HTTP ${status} ${url}: ${JSON.stringify(body).slice(0, 300)}`)
    this.name = "ApiError"
  }
}

/**
 * 会话内凭证链：login → Bearer；401 → refresh 轮换重放 → 仍 401 → 重登录重放（各一次）。
 * token 不落盘（单次跑批无需续跑；transcriber 的 auth.json 持久化模式此处不引入）。
 * multipart 上传不设 content-type（由 undici 补 boundary）；JSON 端点显式声明。
 */
class BooksApiClient {
  private accessToken = ""
  private refreshToken = ""

  constructor(
    public readonly baseUrl: string,
    private readonly username: string,
    private readonly password: string,
  ) {}

  /** POST /api/v1/auth/login → 记忆 token 对（重登录复用同凭据）。 */
  async login(): Promise<void> {
    this.applyAuth(await this.plainJson("/api/v1/auth/login", { username: this.username, password: this.password }))
  }

  private applyAuth(j: { access_token?: string; refresh_token?: string }): void {
    if (!j.access_token || !j.refresh_token) throw new Error("auth response missing tokens")
    this.accessToken = j.access_token
    this.refreshToken = j.refresh_token
  }

  /** 带 Bearer 的 fetch；仅 401 走凭证链（refresh → relogin，各重放一次），其余原样返回交调用方解读。 */
  async authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
    let res = await this.bearerFetch(path, init)
    if (res.status === 401) {
      if (await this.tryRefresh()) res = await this.bearerFetch(path, init)
      if (res.status === 401 && await this.tryRelogin()) res = await this.bearerFetch(path, init)
    }
    return res
  }

  private async bearerFetch(path: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers)
    headers.set("authorization", `Bearer ${this.accessToken}`)
    return fetch(`${this.baseUrl}${path}`, { ...init, headers })
  }

  private async plainJson(path: string, body: unknown): Promise<{ access_token?: string; refresh_token?: string }> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    return this.parseJson(res, path)
  }

  private async tryRefresh(): Promise<boolean> {
    if (!this.refreshToken) return false
    try {
      this.applyAuth(await this.plainJson("/api/v1/auth/refresh", { refresh_token: this.refreshToken }))
      return true
    } catch {
      return false // 网络异常/revoked/过期一律吞掉，交由上层重登录
    }
  }

  private async tryRelogin(): Promise<boolean> {
    try {
      await this.login()
      return true
    } catch {
      return false
    }
  }

  /** POST /api/v1/files/:pid/upload（multipart：path=目标目录 + file）→ {name,path,size}。
   *  服务端（routes/files.rs:75-79）最终落点 = path 字段(目录) + multipart filename。 */
  async uploadFile(
    projectId: number,
    localPath: string,
    uploadDir: string,
    fileName: string,
  ): Promise<{ name: string; path: string; size: number }> {
    const form = new FormData()
    form.append("path", uploadDir)
    form.append("file", new Blob([readFileSync(localPath)], { type: "text/markdown" }), fileName)
    const res = await this.authedFetch(`/api/v1/files/${projectId}/upload`, { method: "POST", body: form })
    return this.parseJson(res, `upload ${uploadDir}/${fileName}`)
  }

  /** POST /api/v1/projects/:pid/ingest {source_paths} → {job_id, status}。 */
  async triggerIngest(projectId: number, sourcePaths: string[]): Promise<{ job_id: string; status: string }> {
    const res = await this.authedFetch(`/api/v1/projects/${projectId}/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source_paths: sourcePaths }),
    })
    return this.parseJson(res, "triggerIngest")
  }

  /** GET /api/v1/ingest/jobs/:id。 */
  async getJob(jobId: string): Promise<IngestJob> {
    const res = await this.authedFetch(`/api/v1/ingest/jobs/${jobId}`)
    return this.parseJson(res, `job ${jobId}`)
  }

  private async parseJson<T>(res: Response, what: string): Promise<T> {
    const text = await res.text()
    let body: unknown = text
    try {
      body = text ? JSON.parse(text) : {}
    } catch {
      // 非 JSON 响应原样保留进 ApiError
    }
    if (!res.ok) throw new ApiError(res.status, what, body)
    return body as T
  }
}

/** 轮询 job 至终态；单批超时返回 "timeout"；瞬时 5xx/429 有界重试（5s/10s/15s，同一 30min 预算内）。 */
async function waitJob(
  client: BooksApiClient,
  jobId: string,
  log: (msg: string) => void,
): Promise<IngestJob | "timeout"> {
  const started = Date.now()
  let transientRetries = 0
  let lastStage = ""
  for (;;) {
    if (Date.now() - started >= JOB_POLL_TIMEOUT_MS) return "timeout"
    let job: IngestJob
    try {
      job = await client.getJob(jobId)
      transientRetries = 0
    } catch (err) {
      if (err instanceof ApiError && (err.status >= 500 || err.status === 429) && transientRetries < 3) {
        transientRetries++
        await sleep(5_000 * transientRetries)
        continue
      }
      throw err // 4xx 语义性失败（401 凭证链已尽/404 任务不存在）：退避重放同态无意义
    }
    if (TERMINAL_JOB_STATUSES.has(job.status)) return job
    if ((job.stage ?? "") !== lastStage) {
      lastStage = job.stage ?? ""
      log(`job=${jobId} status=${job.status} stage=${lastStage || "-"} progress=${job.progress ?? 0}% (+${Math.round((Date.now() - started) / 1000)}s)`)
    }
    await sleep(JOB_POLL_INTERVAL_MS)
  }
}

// ── main ──

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      book: { type: "string" },
      dir: { type: "string", default: DEFAULT_DIR },
      "batch-size": { type: "string", default: String(DEFAULT_BATCH_SIZE) },
      config: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  })
  const bookSlug = values.book
  if (!bookSlug) die("--book <slug> is required (e.g. LT-LearningTeaching-3rd)")
  if (!/^[\w.-]+$/.test(bookSlug)) {
    die(`--book slug 只允许字母/数字/_-.（防路径穿越），收到 "${bookSlug}"`)
  }
  const batchSize = Number(values["batch-size"])
  if (!Number.isInteger(batchSize) || batchSize < 4 || batchSize > 6) {
    die(`--batch-size 需为 4..6 整数（spec 写死 4-6 章/批；收到 "${values["batch-size"]}"）`)
  }

  // 配置：books.json upload 段 + BOOKS_UPLOAD_* 环境变量覆盖（dry-run 不要求齐全）
  const configPath = values.config ?? fileURLToPath(new URL("books.json", import.meta.url))
  let cfg: BooksConfig = {}
  try {
    cfg = JSON.parse(readFileSync(configPath, "utf8")) as BooksConfig
  } catch (err) {
    die(`cannot read config ${configPath}: ${errMsg(err)}`)
  }
  const envProjectId = process.env.BOOKS_UPLOAD_PROJECT_ID
  const upload: UploadCfg = {
    apiBase: process.env.BOOKS_UPLOAD_API_BASE ?? cfg.upload?.apiBase,
    username: process.env.BOOKS_UPLOAD_USERNAME ?? cfg.upload?.username,
    password: process.env.BOOKS_UPLOAD_PASSWORD ?? cfg.upload?.password,
    projectId: envProjectId !== undefined ? Number(envProjectId) : cfg.upload?.projectId,
  }

  // 消费 Task 8 产物：parse-report（闸状态）+ staged 实存文件
  const bookDir = join(values.dir!, bookSlug)
  const stagedDir = join(bookDir, "staged")
  const parseReportPath = join(bookDir, "parse-report.json")
  let parseReport: ParseReport
  try {
    parseReport = JSON.parse(readFileSync(parseReportPath, "utf8")) as ParseReport
  } catch (err) {
    die(`cannot read ${parseReportPath}（先跑 mineru_parse.ts 生成）：${errMsg(err)}`)
  }

  const skipped: { file: string; status: string; reason?: string }[] = []
  const targets: UploadTarget[] = []
  // 选择期硬违例（与断言同级，整跑中止）：报告标 ok 但 staged 只有原件（.pdf 等）而无 .md 产物
  // ——Task 8 只往 staged 写 .md，此组合即清洗产物丢失/原件误入，防原件被当作上传候选。
  const selectionViolations: string[] = []
  for (const ch of parseReport.chapters ?? []) {
    if (ch.status !== "ok") {
      skipped.push({ file: ch.file, status: ch.status, reason: ch.error })
      continue
    }
    const fileName = ch.file.replace(/\.pdf$/, ".md")
    const stagedPath = join(stagedDir, fileName)
    if (!existsSync(stagedPath)) {
      if (existsSync(join(stagedDir, ch.file))) {
        selectionViolations.push(
          `${uploadPrefix(bookSlug)}${ch.file} → 报告 status=ok 但 staged 只有原件（无 ${fileName} 产物）`,
        )
        continue
      }
      // 容忍 parse 步骤非零退出/中断：只消费实际存在的 staged 文件，缺失记 skip
      skipped.push({ file: ch.file, status: "ok", reason: "staged 文件缺失（parse 中断？重跑 mineru_parse 补齐）" })
      continue
    }
    targets.push({ file: ch.file, fileName, stagedPath, uploadPath: `${uploadPrefix(bookSlug)}${fileName}` })
  }

  // staged/ 中不属于候选的文件（如误拷入的 PDF）：不上传，仅提示——真正的防线上面的断言
  const expectedFiles = new Set(targets.map((t) => t.fileName))
  const ignoredStaged: string[] = []
  try {
    for (const e of readdirSync(stagedDir, { withFileTypes: true })) {
      if (e.isFile() && !expectedFiles.has(e.name)) ignoredStaged.push(e.name)
    }
  } catch {
    // staged 目录不存在且零候选：后面统一提示
  }

  // 断言（dry-run 与真跑同一套；违例汇总后整跑中止）
  console.log(
    `[upload_and_ingest] book=${bookSlug} staged 候选=${targets.length} 跳过=${skipped.length}` +
      ` batch-size=${batchSize}${values["dry-run"] ? " DRY-RUN" : ""}`,
  )
  console.log(`[upload_and_ingest] 断言：每文件 .md 扩展名 + ${uploadPrefix(bookSlug)} 前缀（违者整跑中止）`)
  const violations: string[] = [...selectionViolations]
  for (const t of targets) {
    const v = assertUploadTarget(bookSlug, t.fileName)
    if (v.length === 0) {
      console.log(`  [ok]   ${t.uploadPath}`)
    } else {
      console.error(`  [FAIL] ${t.uploadPath} → ${v.join("；")}`)
      violations.push(`${t.uploadPath} → ${v.join("；")}`)
    }
  }
  if (violations.length > 0) {
    die(`断言违例 ${violations.length} 项，整跑中止（未上传任何文件）：\n  - ${violations.join("\n  - ")}`)
  }
  for (const s of skipped) console.log(`  [skip] ${s.file} (${s.status}${s.reason ? `：${s.reason}` : ""})`)
  for (const f of ignoredStaged) console.log(`  [ignored] staged/ 非候选文件（不上传）：${f}`)

  // 分批（尾部批可小于 4，属正常）
  const batches: { index: number; sourcePaths: string[] }[] = []
  for (let i = 0; i < targets.length; i += batchSize) {
    batches.push({ index: batches.length + 1, sourcePaths: targets.slice(i, i + batchSize).map((t) => t.uploadPath) })
  }

  // ── dry-run：打印计划即止，零网络调用、不要求凭证、不写报告 ──
  if (values["dry-run"]) {
    console.log(`[upload_and_ingest] 计划 ${batches.length} 批 → ${upload.apiBase ?? "(apiBase 未配置)"} projectId=${upload.projectId ?? "(未配置)"}`)
    for (const b of batches) {
      console.log(`  批 ${b.index}/${batches.length}（${b.sourcePaths.length} 章）：`)
      for (const p of b.sourcePaths) console.log(`    - ${p}`)
    }
    console.log(`[upload_and_ingest] dry-run 完成：${targets.length} 章可上传、断言全过、0 次 API 调用`)
    return
  }

  // ── 真跑前置：凭证齐全性 ──
  const missingCfg = (["apiBase", "username", "password", "projectId"] as const).filter((k) => !upload[k])
  if (missingCfg.length > 0) {
    die(`upload 配置缺失 [${missingCfg.join(", ")}]——补 books.json "upload" 段或 BOOKS_UPLOAD_* 环境变量（当前配置：${configPath}）`)
  }

  const client = new BooksApiClient(upload.apiBase!.replace(/\/+$/, ""), upload.username!, upload.password!)
  console.log(`[upload_and_ingest] login ${upload.apiBase}（user=${upload.username}，密码不回显）`)
  try {
    await client.login()
  } catch (err) {
    die(`login failed: ${errMsg(err)}`)
  }

  // ── 上传（逐文件；断言已在上方全量通过；任何失败整跑中止——未触发任何 ingest，可重跑续传）──
  const uploaded: { file: string; path: string; size: number }[] = []
  const uploadDir = uploadPrefix(bookSlug).replace(/\/$/, "") // raw/sources/<slug>（服务端拼 filename）
  for (const t of targets) {
    try {
      const resp = await client.uploadFile(upload.projectId!, t.stagedPath, uploadDir, t.fileName)
      if (resp.path !== t.uploadPath) {
        die(`上传落点漂移：服务端返回 "${resp.path}"，预期 "${t.uploadPath}"——按断言级别整跑中止`)
      }
      uploaded.push({ file: t.fileName, path: resp.path, size: resp.size })
      console.log(`  [uploaded] ${resp.path} (${resp.size} bytes)`)
    } catch (err) {
      die(`上传失败 ${t.uploadPath}：${errMsg(err)}（已上传 ${uploaded.length}/${targets.length}，未触发 ingest，可重跑）`)
    }
  }

  // ── 分批摄取：每批触发 → 轮询至终态；失败/超时记录后继续后续批 ──
  const batchReports: BatchReport[] = []
  const writeReport = (): string => {
    const okCount = batchReports.filter((b) => b.status === "succeeded" || b.status === "succeeded_with_warnings").length
    const report = {
      book: bookSlug,
      apiBase: upload.apiBase,
      projectId: upload.projectId,
      batchSize,
      generatedAt: new Date().toISOString(),
      uploaded,
      skipped,
      ignored_staged_files: ignoredStaged,
      batches: batchReports,
      summary: {
        uploaded_files: uploaded.length,
        skipped: {
          gate_blocked: skipped.filter((s) => s.status === "gate_blocked").length,
          failed: skipped.filter((s) => s.status === "failed").length,
          staged_missing: skipped.filter((s) => s.status === "ok").length,
        },
        batches: { total: batchReports.length, ok: okCount, not_ok: batchReports.length - okCount },
        new_pages_total: batchReports.reduce((n, b) => n + (b.new_pages?.length ?? 0), 0),
        merged_pages_total: batchReports.reduce((n, b) => n + (b.merged_pages?.length ?? 0), 0),
        warnings_total: batchReports.reduce((n, b) => n + (b.warnings?.length ?? 0), 0),
      },
    }
    const outPath = join(bookDir, "ingest-report.json")
    writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`)
    return outPath
  }

  if (batches.length === 0) {
    const outPath = writeReport()
    console.log(`[upload_and_ingest] 无 status=ok 的 staged 章节，未触发任何 ingest → ${outPath}`)
    return
  }

  for (const b of batches) {
    const started = Date.now()
    const entry: BatchReport = {
      batch: b.index,
      chapters: b.sourcePaths.length,
      source_paths: b.sourcePaths,
      job_id: null,
      status: "pending",
      seconds: 0,
    }
    try {
      const triggered = await client.triggerIngest(upload.projectId!, b.sourcePaths)
      entry.job_id = triggered.job_id
      console.log(`[upload_and_ingest] 批 ${b.index}/${batches.length} job=${triggered.job_id}（${b.sourcePaths.length} 章）轮询中…`)
      const job = await waitJob(client, triggered.job_id, (m) => console.log(`  ${m}`))
      if (job === "timeout") {
        entry.status = "timeout"
        entry.error = `单批轮询超时（${JOB_POLL_TIMEOUT_MS / 60_000}min），job=${triggered.job_id}`
        console.error(`  [timeout] 批 ${b.index}：${entry.error}——记录后继续后续批`)
      } else {
        entry.status = job.status
        entry.error = job.error ?? undefined
        if (job.result) {
          entry.new_pages = job.result.new_pages ?? []
          entry.merged_pages = job.result.merged_pages ?? []
          entry.updated_reserved = job.result.updated_reserved ?? []
          entry.warnings = job.result.warnings ?? []
        }
        console.log(
          `  [${job.status}] new_pages=${entry.new_pages?.length ?? 0} merged_pages=${entry.merged_pages?.length ?? 0}` +
            ` warnings=${entry.warnings?.length ?? 0}${entry.error ? ` error=${entry.error}` : ""}`,
        )
      }
    } catch (err) {
      entry.status = "error"
      entry.error = errMsg(err)
      console.error(`  [error] 批 ${b.index}：${entry.error}——记录后继续后续批`)
    }
    entry.seconds = Math.round((Date.now() - started) / 1000)
    batchReports.push(entry)
    writeReport() // 每批落盘：中途中断也有已完成批次记录
  }

  const outPath = writeReport()
  const notOk = batchReports.filter((b) => b.status !== "succeeded" && b.status !== "succeeded_with_warnings")
  console.log(`[upload_and_ingest] done：${batchReports.length - notOk.length}/${batchReports.length} 批成功 → ${outPath}`)
  if (notOk.length > 0) {
    console.error(`[upload_and_ingest] ${notOk.length} 批未成功：${notOk.map((b) => `#${b.batch}(${b.status})`).join(" ")}——详见 report`)
    process.exit(1)
  }
}

await main()
