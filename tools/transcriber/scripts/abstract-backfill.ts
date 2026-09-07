// tools/transcriber/scripts/abstract-backfill.ts
// 存量英文主导视频页补中文课例摘要（2026-09-08 门槛④回填，用户拍板窄口径）：
// 全库 transcripts 页按中文字符占比筛（<15% = 全英文课堂实录，跨语言检索实测
// 前 30 全空），LLM 生成摘要插入页首，三写同 purge 范式（API upsert 自动重建
// 向量 + 源文件 + abstract 快照——管线重跑按快照字节复用，不重调 LLM）。
//
// 用法：
//   SVC_PASSWORD=... npx tsx tools/transcriber/scripts/abstract-backfill.ts --dry-run  # 只列目标页
//   SVC_PASSWORD=... npx tsx tools/transcriber/scripts/abstract-backfill.ts            # 实跑
import { writeFileSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { ApiClient } from "../src/api-client"
import { insertAbstract } from "../src/transcript"
import { llmAbstract, sampleMdForAbstract, persistAbstract, DEFAULT_ABSTRACT, type AbstractConfig } from "../src/abstract"

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, "../out")
const DRY = process.argv.includes("--dry-run")
const RATIO_THRESHOLD = 0.15

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
    done++
  } catch (e) {
    failed++
    console.error(`  [fail] ${slug}: ${String(e).slice(0, 160)}`)
  }
}
console.log(`完成：目标 ${targets} 页，成功 ${done}，失败 ${failed}，已有摘要跳过 ${skipped}${DRY ? "（DRY-RUN 未写入）" : ""}`)
