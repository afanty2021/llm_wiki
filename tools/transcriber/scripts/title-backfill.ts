// tools/transcriber/scripts/title-backfill.ts
// 纯数字 title 主题化（2026-10-15 QC §三C：Unlock 电子版 4级 N.mp4 搘文件名，
// titleOf 只剩数字）：从页内「## 课例摘要」LLM 取主题短语，标题 =
// `Unlock 4级听说视频N：<主题>` / `Unlock 4级读写视频N：<主题>`（系列取自
// state.jsonl relPath）。
// 四写锁步：页（upsert 自动重嵌+刷 title）+ 源 md + punct 快照同替换
// （快照不同步会被 punctuate-backfill 判陈旧→无谓重标点，C1 同款防御）
// + wiki/index.md 链接文本统一刷（末尾一轮）。
// 用法：
//   SVC_PASSWORD=... npx tsx tools/transcriber/scripts/title-backfill.ts            # 干跑（列目标+系列，无 LLM）
//   SVC_PASSWORD=... npx tsx tools/transcriber/scripts/title-backfill.ts --execute  # 实跑（LLM+四写）
import { readFileSync, writeFileSync, existsSync } from "node:fs"
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
  const series = rel.includes("听说视频") ? "听说" : rel.includes("读写视频") ? "读写" : null
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
  plans.push({ slug, path: p.path, old: page.title, neu, content: next })
  console.log(`  ${page.title} → ${neu}  (${slug})`)
  if (EXECUTE) {
    await api.upsertTranscriptPage(p.path, next)
    await api.writeSource(`sources/transcripts/${slug}.md`, next)
    const punctPath = join(outDir, "punct", `${slug}.md`)
    if (existsSync(punctPath)) {
      const snapNeu = replaceTitle(readFileSync(punctPath, "utf-8"), neu)
      if (snapNeu === null) { console.error(`  [warn] ${slug}: punct 快照 title 行异常，未同步`); failed++ }
      else writeFileSync(punctPath, snapNeu)
    }
  }
}

// index.md 链接文本刷新（label 从数字换新标题；路径不动）
if (plans.length > 0) {
  const idxPath = "wiki/index.md"
  const gr = await api.authedFetch(`/api/v1/projects/${api.projectId}/page?path=${encodeURIComponent(idxPath)}`)
  const idx = (await gr.json()) as { content: string | null }
  let content = idx.content ?? ""
  let hits = 0
  for (const pl of plans) {
    const oldLink = `[${pl.old}](${pl.path})`
    const neuLink = `[${pl.neu}](${pl.path})`
    if (!content.includes(oldLink)) { console.error(`  [warn] index 未找到 [${pl.old}](${pl.path})`); continue }
    content = content.split(oldLink).join(neuLink)
    hits++
  }
  console.log(`index.md 链接文本：${hits}/${plans.length} 处${EXECUTE ? "" : "（dry-run 未写入）"}`)
  if (EXECUTE && hits > 0) await api.upsertTranscriptPage(idxPath, content)
}
if (failed) { console.error(`${failed} 个失败/跳过`); process.exit(1) }
console.log(EXECUTE ? `完成 ${plans.length} 页` : `干跑通过 ${plans.length} 页（加 --execute 实跑）`)
