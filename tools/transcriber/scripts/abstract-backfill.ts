// tools/transcriber/scripts/abstract-backfill.ts
// 存量英文主导视频页补中文课例摘要（2026-09-08 门槛④回填，用户拍板窄口径）：
// 全库 transcripts 页按中文字符占比筛（<15% = 全英文课堂实录，跨语言检索实测
// 前 30 全空），LLM 生成摘要插入页首，三写同 purge 范式（API upsert 自动重建
// 向量 + 源文件 + abstract 快照——管线重跑按快照字节复用，不重调 LLM）。
//
// 用法：
//   SVC_PASSWORD=... npx tsx tools/transcriber/scripts/abstract-backfill.ts --dry-run  # 只列目标页
//   SVC_PASSWORD=... npx tsx tools/transcriber/scripts/abstract-backfill.ts            # 实跑
//   --ratio 0.30：阈值旋钮（2026-10-15）——0.15 对「英文正文+LLM 中文章头」页太紧，
//   章头把占比抬到 0.16-0.30 的英文课堂页漏网（QC 10-15 的 10 页即此族）。
// pending 兜底（评审 2026-10-16 Important 3）：三写任一失败 → slug 落
// out/abstract-backfill-pending.json，重跑先对清单幂等补写——否则页已有摘要而
// 源未写时重跑按「已有摘要跳过」，源与页静默漂移（源 md 是下次 wipe-rebuild 的
// 真值来源）。insertAbstract 天然幂等（已有摘要块原位替换）。
import { writeFileSync, existsSync, readFileSync, renameSync, rmSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { ApiClient } from "../src/api-client"
import { insertAbstract } from "../src/transcript"
import { llmAbstract, sampleMdForAbstract, persistAbstract, loadAbstract, DEFAULT_ABSTRACT, type AbstractConfig } from "../src/abstract"

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, "../out")
const DRY = process.argv.includes("--dry-run")
// --ratio 0.30 与 --ratio=0.30 双形态（评审 2026-10-16 Minor 3：等号形此前静默回落 0.15）
const ratioArgv = process.argv.find((a) => a === "--ratio" || a.startsWith("--ratio="))
const ratioArg = Number(ratioArgv?.includes("=") ? ratioArgv.slice("--ratio=".length)
  : process.argv[process.argv.indexOf("--ratio") + 1])
const RATIO_THRESHOLD = Number.isFinite(ratioArg) && ratioArg > 0 && ratioArg < 1 ? ratioArg : 0.15

const cfg: Required<AbstractConfig> = { ...DEFAULT_ABSTRACT }
if (existsSync(join(here, "../config.json"))) {
  const fileCfg = (JSON.parse(readFileSyncSafe()) as { abstract?: AbstractConfig }).abstract
  Object.assign(cfg, fileCfg ?? {})
}
function readFileSyncSafe(): string {
  try { return readFileSync(join(here, "../config.json"), "utf-8") } catch { return "{}" }
}

const chineseRatio = (s: string): number =>
  (s.replace(/^---[\s\S]*?---/, "").match(/[\u4e00-\u9fff]/g)?.length ?? 0) / Math.max(s.length, 1)
const readFileSyncPunct = (p: string): string => readFileSync(p, "utf-8")

const password = process.env.SVC_PASSWORD
if (!password) { console.error("缺 SVC_PASSWORD"); process.exit(1) }
const api = new ApiClient(process.env.BASE_URL ?? "http://127.0.0.1:8080", {
  projectId: Number(process.env.PROJECT_ID ?? 614),
  authPath: join(outDir, "auth.json"),
})
await api.login(process.env.SVC_USERNAME ?? "svc-transcriber", password)

const r = await api.authedFetch(`/api/v1/projects/${api.projectId}/pages`)
if (!r.ok) { console.error(`listPages 失败 HTTP ${r.status}`); process.exit(1) }
const pages = ((await r.json()) as Array<{ path: string }>).filter(p => p.path.startsWith("transcripts/"))

// —— pending 未完成写清单（slug → 页 path；重放 text 优先取 out/abstract 快照，
//    快照也丢才重调 LLM）——
const pendingPath = join(outDir, "abstract-backfill-pending.json")
const loadPendingMap = (): Record<string, string> => {
  if (!existsSync(pendingPath)) return {}
  try { return JSON.parse(readFileSync(pendingPath, "utf-8")) } catch (e) {
    // 损坏拒绝静默清零（复查 2026-10-16 Minor）：半写文件被当空清单，下次落盘即覆盖丢账
    console.error(`pending 清单损坏：${String(e).slice(0, 80)}——人工核查 ${pendingPath} 后删除再跑`)
    process.exit(1)
  }
}
let pending = loadPendingMap()
// 原子写 tmp+rename（saveState 同款）且空清单不落 {} 噪音文件（复查 2026-10-16 Minor）
const savePending = () => {
  if (Object.keys(pending).length === 0) { try { rmSync(pendingPath) } catch { /* 本就不存在 */ } return }
  const tmp = `${pendingPath}.tmp`
  writeFileSync(tmp, JSON.stringify(pending, null, 1))
  renameSync(tmp, pendingPath)
}

if (!DRY && Object.keys(pending).length > 0) {
  console.log(`发现未完成写清单 ${Object.keys(pending).length} 条，幂等补写…`)
  for (const [slug, path] of Object.entries(pending)) {
    try {
      const gr = await api.authedFetch(`/api/v1/projects/${api.projectId}/page?path=${encodeURIComponent(path)}`)
      const page = (await gr.json()) as { content: string | null }
      if (!page.content) { console.error(`  [留存] ${slug}: 页缺失`); continue }
      let text = loadAbstract(outDir, slug)
      if (text === null) {
        text = await llmAbstract(sampleMdForAbstract(page.content), cfg)
        persistAbstract(outDir, slug, text)
      }
      const next = insertAbstract(page.content, text) // 已有摘要块 → 原位替换，幂等
      await api.upsertTranscriptPage(path, next)
      await api.writeSource(`sources/transcripts/${slug}.md`, next)
      const punctPath = join(outDir, "punct", `${slug}.md`)
      if (existsSync(punctPath)) writeFileSync(punctPath, insertAbstract(readFileSyncPunct(punctPath), text))
      delete pending[slug]; savePending()
      console.log(`  [补写完成] ${slug}`)
    } catch (e) { console.error(`  [留存] ${slug}: ${String(e).slice(0, 120)}`) }
  }
}

console.log(`模式=${DRY ? "DRY-RUN" : "BACKFILL"} 扫描 ${pages.length} 页（中文字符占比 < ${RATIO_THRESHOLD} 为目标）…`)

let targets = 0, done = 0, skipped = 0, failed = 0
for (const p of pages) {
  const slug = p.path.replace("transcripts/", "").replace(/\.md$/, "")
  const gr = await api.authedFetch(`/api/v1/projects/${api.projectId}/page?path=${encodeURIComponent(p.path)}`)
  if (!gr.ok) { console.error(`  [skip] GET ${p.path} HTTP ${gr.status}`); continue }
  const page = (await gr.json()) as { content: string | null }
  if (!page.content) continue
  if (page.content.includes("## 课例摘要")) { skipped++; continue }
  const ratio = chineseRatio(page.content)
  if (ratio >= RATIO_THRESHOLD) continue
  targets++
  console.log(`  ${slug}（中文占比 ${(ratio * 100).toFixed(0)}%）`)
  if (DRY) continue
  try {
    const text = await llmAbstract(sampleMdForAbstract(page.content), cfg)
    const next = insertAbstract(page.content, text)
    persistAbstract(outDir, slug, text) // 管线重跑按快照复用（out/abstract/<slug>.md）
    await api.upsertTranscriptPage(p.path, next)
    await api.writeSource(`sources/transcripts/${slug}.md`, next)
    // punct 快照同步（2026-10-15）：页内容变了，快照若不同步会被 backfill 判陈旧
    // → 删快照重标点（无谓 LLM churn）。快照本与旧页 byte-equal，套同一 insertAbstract
    // 即与新页 byte-equal，三工件锁步（页/源/快照）。
    const punctPath = join(outDir, "punct", `${slug}.md`)
    if (existsSync(punctPath)) {
      writeFileSync(punctPath, insertAbstract(readFileSyncPunct(punctPath), text))
    }
    delete pending[slug]; savePending()
    done++
  } catch (e) {
    pending[slug] = p.path; savePending()
    failed++
    console.error(`  [fail] ${slug}: ${String(e).slice(0, 160)}（已记 pending 清单，重跑对账补写）`)
  }
}
console.log(`完成：目标 ${targets} 页，成功 ${done}，失败 ${failed}，已有摘要跳过 ${skipped}${DRY ? "（DRY-RUN 未写入）" : ""}`)
if (Object.keys(pending).length > 0) {
  console.error(`${Object.keys(pending).length} 条未完成写留存 ${pendingPath}（去 --dry-run 重跑本脚本对账补写，干跑不执行重放）`)
  process.exit(1)
}
