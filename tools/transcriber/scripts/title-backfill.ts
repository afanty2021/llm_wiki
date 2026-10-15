// tools/transcriber/scripts/title-backfill.ts
// 纯数字 title 主题化（2026-10-15 QC §三C：Unlock 电子版 4级 N.mp4 搘文件名，
// titleOf 只剩数字）：从页内「## 课例摘要」LLM 取主题短语，标题 =
// `Unlock 4级听说视频N：<主题>` / `Unlock 4级读写视频N：<主题>`（系列取自
// state.jsonl relPath）。
// 四写锁步：页（upsert 自动重嵌+刷 title）+ 源 md + punct 快照同替换
// （快照不同步会被 punctuate-backfill 判陈旧→无谓重标点，C1 同款防御）
// + wiki/index.md 链接文本统一刷（末尾一轮）。
// pending 兜底（评审 2026-10-16 Important 3）：四写任一失败 → slug 落
// out/title-backfill-pending.json 继续跑，重跑先对清单幂等补写——否则页已改而
// 源未改时重跑按「title 已非纯数字」永久跳过，源与页静默漂移（源 md 是下次
// wipe-rebuild 的真值来源，漂移会在重建时复活旧标题）。
// 用法：
//   SVC_PASSWORD=... npx tsx tools/transcriber/scripts/title-backfill.ts            # 干跑（列目标+系列，无 LLM）
//   SVC_PASSWORD=... npx tsx tools/transcriber/scripts/title-backfill.ts --execute  # 实跑（LLM+四写）
import { readFileSync, writeFileSync, existsSync, renameSync, rmSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { ApiClient } from "../src/api-client"
import { loadZaiKey, stripThinking } from "../src/chaptering"
import { DEFAULT_ABSTRACT } from "../src/abstract"

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, "../out")
const EXECUTE = process.argv.includes("--execute")

const ZAI_KEY = process.env.ZAI_API_KEY || loadZaiKey()
if (!ZAI_KEY && EXECUTE) { console.error("缺 ZAI_API_KEY（env 或 ~/.hermes/.env）"); process.exit(1) }
const password = process.env.SVC_PASSWORD
if (!password) { console.error("缺 SVC_PASSWORD"); process.exit(1) }
const api = new ApiClient(process.env.BASE_URL ?? "http://127.0.0.1:8080", {
  projectId: Number(process.env.PROJECT_ID ?? 614),
  authPath: join(outDir, "auth.json"),
})
await api.login(process.env.SVC_USERNAME ?? "svc-transcriber", password)

// state：slug → relPath（系列判定）
const state = new Map<string, string>()
for (const l of readFileSync(join(outDir, "state.jsonl"), "utf-8").trim().split("\n")) {
  const o = JSON.parse(l) as { slug: string; relPath: string }
  state.set(o.slug, o.relPath)
}

async function llmTopic(abstract: string): Promise<string> {
  const res = await fetch(`${DEFAULT_ABSTRACT.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ZAI_KEY}` },
    body: JSON.stringify({
      model: DEFAULT_ABSTRACT.model,
      messages: [
        { role: "system", content: "你为英语课例视频提炼中文主题短语：不超过 15 个字，可保留必要的英文专名，不加书名号引号句号。只输出短语本身。" },
        { role: "user", content: abstract.slice(0, 3000) },
      ],
      thinking: { type: "disabled" },
    }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const j = (await res.json()) as { choices: Array<{ message: { content: string } }> }
  const t = stripThinking(j.choices?.[0]?.message?.content ?? "").trim().replaceAll("\n", "")
  if (!t || t.length > 30) throw new Error(`主题异常：「${t}」`)
  return t
}

function abstractOf(md: string): string | null {
  const m = /(^|\n)## 课例摘要\n([\s\S]*?)(?=\n## |\n$|$)/.exec(md)
  return m ? m[2].trim() : null
}
function replaceTitle(md: string, neu: string): string | null {
  const m = /^---\n([\s\S]*?)\n---/.exec(md)
  if (!m) return null
  const fm = m[1]
  const lines = fm.split("\n")
  let hit = 0
  for (let i = 0; i < lines.length; i++) {
    if (/^title: /.test(lines[i])) { lines[i] = `title: ${JSON.stringify(neu)}`; hit++ }
  }
  if (hit !== 1) return null
  return md.replace(/^---\n[\s\S]*?\n---/, `---\n${lines.join("\n")}\n---`)
}

// —— pending 未完成写清单（幂等重放：replaceTitle 同值替换、upsert sha 相同 skipped、
//    源覆盖写、index old 链接找不到 = 已刷过跳过）——
const pendingPath = join(outDir, "title-backfill-pending.json")
const loadPending = (): Record<string, { path: string; old: string; neu: string }> => {
  if (!existsSync(pendingPath)) return {}
  try { return JSON.parse(readFileSync(pendingPath, "utf-8")) } catch (e) {
    // 损坏拒绝静默清零（复查 2026-10-16 Minor）：半写文件被当空清单，下次落盘即覆盖丢账
    console.error(`pending 清单损坏：${String(e).slice(0, 80)}——人工核查 ${pendingPath} 后删除再跑`)
    process.exit(1)
  }
}
let pending = loadPending()
// 原子写 tmp+rename（saveState 同款）且空清单不落 {} 噪音文件（复查 2026-10-16 Minor）
const savePending = () => {
  if (Object.keys(pending).length === 0) { try { rmSync(pendingPath) } catch { /* 本就不存在 */ } return }
  const tmp = `${pendingPath}.tmp`
  writeFileSync(tmp, JSON.stringify(pending, null, 1))
  renameSync(tmp, pendingPath)
}

// 上次未完成写：先对账补写再进主扫描（页 GET 现值 → replaceTitle 幂等出 next → 三写）
const replayLinks: Array<{ old: string; neu: string; path: string }> = []
if (EXECUTE && Object.keys(pending).length > 0) {
  console.log(`发现未完成写清单 ${Object.keys(pending).length} 条，幂等补写…`)
  for (const [slug, info] of Object.entries(pending)) {
    try {
      const gr = await api.authedFetch(`/api/v1/projects/${api.projectId}/page?path=${encodeURIComponent(info.path)}`)
      const page = (await gr.json()) as { content: string | null }
      const next = page.content === null ? null : replaceTitle(page.content, info.neu)
      if (next === null) { console.error(`  [留存] ${slug}: 页缺失或 frontmatter 异常`); continue }
      await api.upsertTranscriptPage(info.path, next)
      await api.writeSource(`sources/transcripts/${slug}.md`, next)
      const punctPath = join(outDir, "punct", `${slug}.md`)
      if (existsSync(punctPath)) {
        const snapNeu = replaceTitle(readFileSync(punctPath, "utf-8"), info.neu)
        if (snapNeu === null) throw new Error("punct 快照 title 行异常") // 与主循环同口径（复查 Minor）
        writeFileSync(punctPath, snapNeu)
      }
      replayLinks.push({ old: info.old, neu: info.neu, path: info.path })
      delete pending[slug]; savePending()
      console.log(`  [补写完成] ${slug}`)
    } catch (e) { console.error(`  [留存] ${slug}: ${String(e).slice(0, 120)}`) }
  }
}

const r = await api.authedFetch(`/api/v1/projects/${api.projectId}/pages`)
const pages = ((await r.json()) as Array<{ path: string }>).filter(p => p.path.startsWith("transcripts/"))
console.log(`模式=${EXECUTE ? "EXECUTE" : "dry-run"} 扫描 ${pages.length} 页（title 纯数字为目标）…`)

interface Plan { slug: string; path: string; old: string; neu: string; content: string }
const plans: Plan[] = []
let failed = 0
for (const p of pages) {
  const gr = await api.authedFetch(`/api/v1/projects/${api.projectId}/page?path=${encodeURIComponent(p.path)}`)
  const page = (await gr.json()) as { title: string | null; content: string | null }
  if (!page.title || !/^\d+$/.test(page.title) || !page.content) continue
  const slug = p.path.slice(12, -3)
  const rel = state.get(slug) ?? ""
  // 系列判定要求 relPath 属 Unlock 系列（评审 2026-10-16 Minor 4：防未来其他系列
  // 的纯数字标题被错误冠名「Unlock 4级…」）
  const series = !rel.includes("Unlock") ? null
    : rel.includes("听说视频") ? "听说" : rel.includes("读写视频") ? "读写" : null
  const abs = abstractOf(page.content)
  if (!series || !abs) {
    console.error(`  [skip] ${slug}：series=${series} 有摘要=${!!abs}`)
    failed++; continue
  }
  let neu: string
  if (EXECUTE) {
    try { neu = `Unlock 4级${series}视频${page.title}：${await llmTopic(abs)}` }
    catch (e) { console.error(`  [fail] ${slug}: ${String(e).slice(0, 120)}`); failed++; continue }
  } else {
    neu = `Unlock 4级${series}视频${page.title}：<LLM 主题>`
  }
  const next = replaceTitle(page.content, neu)
  if (next === null) { console.error(`  [fail] ${slug}: frontmatter title 行异常`); failed++; continue }
  if (EXECUTE) {
    try {
      await api.upsertTranscriptPage(p.path, next)
      await api.writeSource(`sources/transcripts/${slug}.md`, next)
      const punctPath = join(outDir, "punct", `${slug}.md`)
      if (existsSync(punctPath)) {
        const snapNeu = replaceTitle(readFileSync(punctPath, "utf-8"), neu)
        if (snapNeu === null) throw new Error("punct 快照 title 行异常")
        writeFileSync(punctPath, snapNeu)
      }
    } catch (e) {
      pending[slug] = { path: p.path, old: page.title, neu }
      savePending()
      console.error(`  [pending] ${slug}: ${String(e).slice(0, 120)}（已记清单，重跑对账补写）`)
      failed++
      continue
    }
    delete pending[slug]; savePending()
  }
  plans.push({ slug, path: p.path, old: page.title, neu, content: next })
  console.log(`  ${page.title} → ${neu}  (${slug})`)
}

// index.md 链接文本刷新（label 从数字换新标题；路径不动）；含重放补写成功的条目
const indexTargets = [...replayLinks, ...plans]
if (indexTargets.length > 0) {
  const idxPath = "wiki/index.md"
  const gr = await api.authedFetch(`/api/v1/projects/${api.projectId}/page?path=${encodeURIComponent(idxPath)}`)
  const idx = (await gr.json()) as { content: string | null }
  let content = idx.content ?? ""
  let hits = 0
  for (const pl of indexTargets) {
    const oldLink = `[${pl.old}](${pl.path})`
    const neuLink = `[${pl.neu}](${pl.path})`
    if (!content.includes(oldLink)) { console.error(`  [warn] index 未找到 [${pl.old}](${pl.path})`); continue }
    content = content.split(oldLink).join(neuLink)
    hits++
  }
  console.log(`index.md 链接文本：${hits}/${indexTargets.length} 处${EXECUTE ? "" : "（dry-run 未写入）"}`)
  if (EXECUTE && hits > 0) await api.upsertTranscriptPage(idxPath, content)
}
if (Object.keys(pending).length > 0) {
  console.error(`${Object.keys(pending).length} 条未完成写留存 ${pendingPath}（加 --execute 重跑本脚本对账补写，干跑不执行重放）`)
  process.exit(1)
}
if (failed) { console.error(`${failed} 个失败/跳过`); process.exit(1) }
console.log(EXECUTE ? `完成 ${plans.length} 页` : `干跑通过 ${plans.length} 页（加 --execute 实跑）`)
