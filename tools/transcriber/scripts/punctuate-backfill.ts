// tools/transcriber/scripts/punctuate-backfill.ts
// 存量 239 转写正文标点恢复（2026-08-26 阅读体验根治）：DB 页内容按章送 LLM 补
// 中文标点+分段（三重校验门保逐字保留），成功后 页/源 同 bytes 重写 + **全量快照
// 落盘 out/punct/<slug>.md**（复活通道收口：续跑/复用按快照字节回用，绝不重调 LLM）。
// 核心 import ../src/punctuation（与摄取链同源）。
//
// 安全设计：
//  - 门序（关键）：快照自愈门 → partial 门 → 密度门。快照在最前——「快照已落、
//    页写成、源写败」的 crash 窗口后页已带标点，密度门会 early-return 挡住自愈；
//    快照路径页+源双写天然自愈。快照命中先验与页内容一致性（同 slug 重转写/手编
//    后陈旧 → 删快照重新标点，不把旧文写回）。partial 门（2026-08-27 A+B）在密度
//    门之前——部分接受文件的好章标点推高页密度会被误判达标锁死重试；有
//    out/punct/<slug>.partial 标记即绕过密度门重跑残留章，全胜写快照时标记清除。
//    --force 同时越过快照门、partial 门与密度门。
//  - 部分接受（A+B）：碎片段 verify 终败回填原文、懒章整章回原文，其余照常加工
//    ——页+源双写混合体，**不落快照**（残留保未来重试通道，页面单调变好）。
//  - 跳过门：正文标点密度已 >2%（如已处理过/个别原生带标点）→ skip，--force 可越过；
//  - 校验门：src/punctuation verifyPunctuated（时间戳标记全保留且有序 + 剥空白标点后
//    逐字符一致）——LLM 改字/丢章整文件回落，绝不盲写；
//  - GET 限流退避：429/5xx 重试（rechapter 同款）；
//  - 不动 frontmatter/章头/media.chapters/ingested_files——纯正文级改写，页与源同 bytes。
//
// 用法：
//   SVC_PASSWORD=... npx tsx tools/transcriber/scripts/punctuate-backfill.ts --check   # 零写入预检（密度统计）
//   SVC_PASSWORD=... npx tsx tools/transcriber/scripts/punctuate-backfill.ts --only 06ad7ef1 [--dry-run]
//   SVC_PASSWORD=... npx tsx tools/transcriber/scripts/punctuate-backfill.ts --all [--limit 20] [--exclude a,b]
// 凭证：ZAI_API_KEY env 或 ~/.hermes/.env（不打印）；SVC_PASSWORD 必填。
import { readFileSync, writeFileSync, rmSync, existsSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { ApiClient } from "../src/api-client"
import { loadZaiKey } from "../src/chaptering"
import {
  DEFAULT_PUNCTUATE, punctuateMd, verifyPunctuated, persistPunctMd, loadPunctMd, splitChapters,
} from "../src/punctuation"

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, "../out")

const args = process.argv.slice(2)
const flag = (n: string) => args.includes(n)
const opt = (n: string, d: string) => {
  const i = args.indexOf(n)
  return i >= 0 ? args[i + 1] : d
}
const MODEL = opt("--model", "glm-5.3-flash")
// --base-url：zai 内容审查拦截（HTTP 400 contentFilter code 1301）时的绕行通道——
// 指向本地 omlx（http://127.0.0.1:8001/v1，chat 请求自动拉起已卸载模型 ~9s）
const BASE_URL = opt("--base-url", DEFAULT_PUNCTUATE.baseUrl)
// NaN/非数字并发（--concurrency abc）→ 回落默认，而非 0 worker 静默假跑（评审 M6）
const concurrencyArg = Number(opt("--concurrency", "3"))
const CONCURRENCY = Number.isFinite(concurrencyArg) && concurrencyArg >= 1
  ? Math.min(4, Math.floor(concurrencyArg))
  : 3
const DRY = flag("--dry-run")
const LIMIT = Number(opt("--limit", "0"))
const MODE = flag("--check") ? "check" : flag("--all") ? "all" : "only"
const punctCfg = { ...DEFAULT_PUNCTUATE, enabled: true, model: MODEL, baseUrl: BASE_URL }
const ZAI_KEY = process.env.ZAI_API_KEY || loadZaiKey()
if (!ZAI_KEY && MODE !== "check") {
  console.error("缺 ZAI_API_KEY（env 或 ~/.hermes/.env）")
  process.exit(1)
}

const stateLines = readFileSync(join(outDir, "state.jsonl"), "utf-8")
  .trim().split("\n").map((l) => JSON.parse(l) as { slug: string; status: string })
let targets = stateLines.filter((l) => l.status === "done")
const doneTotal = targets.length
if (MODE === "only") {
  const want = new Set(opt("--only", "").split(",").map((x) => x.trim()).filter(Boolean))
  targets = targets.filter((l) => want.has(l.slug))
  if (targets.length === 0) { console.error(`--only 未命中（state done 共 ${doneTotal}）`); process.exit(1) }
}
{
  const ex = new Set(opt("--exclude", "").split(",").map((x) => x.trim()).filter(Boolean))
  if (ex.size) targets = targets.filter((l) => !ex.has(l.slug))
}
if (LIMIT > 0 && MODE === "all") targets = targets.slice(0, LIMIT)
console.log(`模式=${MODE} 目标=${targets.length} model=${MODEL} concurrency=${CONCURRENCY}${DRY ? " DRY-RUN" : ""}`)

const password = process.env.SVC_PASSWORD
if (!password) { console.error("缺 SVC_PASSWORD（source tools/transcriber/out/bootstrap.env）"); process.exit(1) }
const api = new ApiClient(process.env.BASE_URL ?? "http://127.0.0.1:8080", {
  projectId: Number(process.env.PROJECT_ID ?? 614),
  authPath: join(outDir, "auth.json"),
})
await api.login(process.env.SVC_USERNAME ?? "svc-transcriber", password)

/** GET 页内容（限流耐受：429/5xx 退避重试；语义性 4xx 直接 null）。 */
async function getPageContent(pagePath: string): Promise<string | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await api.authedFetch(`/api/v1/projects/${api.projectId}/page?path=${encodeURIComponent(pagePath)}`)
    if (res.ok) {
      const page = (await res.json()) as { content: string | null }
      return page.content ?? null
    }
    if (res.status !== 429 && res.status < 500) return null
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)))
  }
  return null
}

/** 正文标点密度（剥 frontmatter/章头/时间戳后，标点 / CJK 字符）。 */
function punctDensity(md: string): number {
  const { chapters } = splitChapters(md)
  const body = chapters.map((c) => c.body).join("")
  const text = body.replace(/\[\d{1,3}:\d{2}\]/g, "")
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length
  const punct = (text.match(/[，。！？；：、“”‘’（）——……]/g) ?? []).length
  return cjk > 0 ? punct / cjk : 1
}

interface Outcome {
  slug: string
  status: "ok" | "ok_partial" | "skipped_already_punctuated" | "skipped_snapshot" | "error"
  chapters?: number
  densityBefore?: number
  densityAfter?: number
  reason?: string
}
const outcomes: Outcome[] = []

/** 部分接受标记（out/punct/<slug>.partial）：页面=好章+残留章混合体，好章
 *  标点会推高页密度，密度门会误判达标挡死重试（Language-systems 锁死实证）。
 *  有标记 → 绕过密度门重跑残留章；全胜写快照时清除（自然升级）。 */
const partialMarker = (slug: string) => join(outDir, "punct", `${slug}.partial`)

async function processOne(line: { slug: string }): Promise<Outcome> {
  const { slug } = line
  const pagePath = `transcripts/${slug}.md`
  const sourcePath = `sources/transcripts/${slug}.md`

  const content = await getPageContent(pagePath)
  if (content === null) return { slug, status: "error", reason: "GET 页失败/空内容" }
  const density = punctDensity(content)
  if (MODE === "check") return { slug, status: density > 0.02 ? "skipped_already_punctuated" : "ok", densityBefore: density }

  // 快照自愈门——必须在密度门**之前**（评审 round2 R1）：crash 在「快照已落、
  // 页写成、源写败」窗口后，重跑时页已带标点 → 密度门 early-return，快照
  // 永不被咨询，源永久机械滞后；快照路径页+源双写天然自愈。--force 越过
  // 快照门全量重跑（覆盖快照）。
  const snapshot = loadPunctMd(outDir, slug)
  if (snapshot !== null && !flag("--force")) {
    if (verifyPunctuated(content, snapshot)) {
      // 重跑幂等/自愈：重写页+源为快照 bytes（对齐漂移），不调 LLM
      if (!DRY) {
        await api.upsertTranscriptPage(pagePath, snapshot)
        await api.writeSource(sourcePath, snapshot)
      }
      return { slug, status: "skipped_snapshot", densityAfter: punctDensity(snapshot) }
    }
    // 快照陈旧（评审 round2 R2：同 slug 重转写/重切章后，旧快照覆盖新文 = I2
    // 同款陈旧写回；含用户手编页——旧逻辑会把手编页覆写回快照）。删快照按
    // miss 走重新标点；DRY 不动磁盘，如实报告实跑动作。
    if (DRY) return { slug, status: "ok", densityBefore: density, reason: "快照陈旧：实跑将删快照并重新标点" }
    rmSync(join(outDir, "punct", `${slug}.md`), { force: true })
    console.warn(`[backfill] ${slug}: 快照与页内容不一致（重转写/手编后陈旧），删快照重新标点`)
  }

  // partial 门（2026-08-27 A+B）：上轮部分接受的文件重跑——重跑输入=当前页，
  // 已带标点的好章模型原样保留（回显密度高不判懒）→ 坏章再抽签，页面单调变好。
  const hasPartial = existsSync(partialMarker(slug)) && !flag("--force")
  if (hasPartial) {
    console.warn(`[backfill] ${slug}: 部分接受标记在，绕过密度门重试残留章`)
  }
  if (density > 0.02 && !flag("--force") && !hasPartial) {
    // 已带标点（旧版仅标点未分段）→ 默认跳过；--force 重送 LLM 补语义分段
    return { slug, status: "skipped_already_punctuated", densityBefore: density, reason: `密度 ${(density * 100).toFixed(1)}% 已达标` }
  }

  const result = await punctuateMd(content, punctCfg, { apiKey: ZAI_KEY })
  if (result === null) return { slug, status: "error", reason: "LLM/校验失败（见上方 warn）" }
  const punctuated = result.text
  if (punctuated === content) return { slug, status: "error", reason: "标点结果与原文相同（异常）" }
  // 双保险：入口外再验一次（punctuateMd 内部已逐块验过）
  if (!verifyPunctuated(content, punctuated)) return { slug, status: "error", reason: "终验失败（不应到达）" }

  if (DRY) {
    return { slug, status: result.partial ? "ok_partial" : "ok", densityBefore: density, densityAfter: punctDensity(punctuated) }
  }
  if (result.partial) {
    // 部分接受：页+源双写混合体，不落快照（残留章保未来重试通道），标记先落
    // （crash 在页写前 → 重跑仍走 partial 门自愈）。
    mkdirSync(join(outDir, "punct"), { recursive: true })
    writeFileSync(partialMarker(slug), `${JSON.stringify({ slug, updatedAt: new Date().toISOString() }, null, 2)}\n`)
    await api.upsertTranscriptPage(pagePath, punctuated)
    await api.writeSource(sourcePath, punctuated)
    return { slug, status: "ok_partial", densityBefore: density, densityAfter: punctDensity(punctuated) }
  }
  // 全胜：清 partial 标记（从部分接受升级的文件在此收口）+ 快照先于双写落盘
  // （评审 I1）：页写成功/源写失败的 crash 窗口后，重跑走 skipped_snapshot
  // 路径（本就页+源双写自愈）——若快照后落，密度门会把 punctuated 页判为已
  // 处理，源永久滞后且无自愈通道。
  rmSync(partialMarker(slug), { force: true })
  persistPunctMd(outDir, slug, punctuated)
  await api.upsertTranscriptPage(pagePath, punctuated)
  await api.writeSource(sourcePath, punctuated)
  return { slug, status: "ok", densityBefore: density, densityAfter: punctDensity(punctuated) }
}

const queue = [...targets]
const workers = Array.from({ length: MODE === "check" ? 4 : CONCURRENCY }, async () => {
  for (;;) {
    const line = queue.shift()
    if (!line) return
    try {
      outcomes.push(await processOne(line))
      if (outcomes.length % 10 === 0 || outcomes.length === targets.length) console.log(`  ${outcomes.length}/${targets.length}…`)
    } catch (e) {
      outcomes.push({ slug: line.slug, status: "error", reason: String(e).slice(0, 160) })
    }
    await new Promise((r) => setTimeout(r, 120))
  }
})
await Promise.all(workers)

const by = (s: string) => outcomes.filter((o) => o.status === s).length
console.log(`完成：ok=${by("ok")} ok_partial=${by("ok_partial")} skipped_snapshot=${by("skipped_snapshot")} skipped_already=${by("skipped_already_punctuated")} error=${by("error")}`)
for (const o of outcomes) {
  if (o.status === "error") console.log(`  [error] ${o.slug}: ${o.reason}`)
  else if (o.status === "ok_partial") {
    console.log(`  [partial] ${o.slug}: 密度 ${((o.densityBefore ?? 0) * 100).toFixed(1)}% → ${((o.densityAfter ?? 0) * 100).toFixed(1)}%（残留章回原文，未落快照）`)
  } else if (MODE !== "check" && o.status === "ok") {
    console.log(`  ${o.slug}: 密度 ${((o.densityBefore ?? 0) * 100).toFixed(1)}% → ${((o.densityAfter ?? 0) * 100).toFixed(1)}%`)
  }
}
writeFileSync(join(outDir, "punctuate-backfill-report.json"), `${JSON.stringify({ model: MODEL, generatedAt: new Date().toISOString(), outcomes }, null, 2)}\n`)
console.log(`报告：${join(outDir, "punctuate-backfill-report.json")}`)
// 退出码：有 error 或（非 check 模式下）一条都没实际处理 → 1。check 模式的
// skipped_already_punctuated 是「全部已达标」的合法终态，不算失败（评审 M5）。
// ok_partial（部分接受）= 页面已写入改善，计入实际处理。
const meaningful = MODE === "check" ? by("ok") + by("skipped_already_punctuated") : by("ok") + by("ok_partial") + by("skipped_snapshot")
process.exit(by("error") > 0 || (meaningful === 0 && targets.length > 0) ? 1 : 0)
