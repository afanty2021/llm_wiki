// tools/transcriber/scripts/purge-hallucinations.ts
// 存量幻觉净化（2026-08-29，用户拍板 A）：全库 transcripts 页扫 Whisper 幻觉行
// （B 站搬运字幕组署名音轨/BGM 被转成整段垃圾，实测重度页「字幕志愿者 李宗盛」
// ×1909），行级剥除后 DB 页 + 源文件 + 本地快照三写。
//
// 行级规则（与 src/whisper.ts stripHallucinationSegments 同源哲学）：剥黑名单词 +
// 时间戳 + 空白 + 标点后不剩任何字符的行删除（幻觉实测 100% 纯段，真段剥词后仍有
// 内容必保留）；其余行一字不动。
//
// 2026-10-15 QC 变体家族补充：「订阅，转发，明镜与点栏目。」标点重复串——基础 token
// 的空格形（订阅 转发）与点点形（明镜与点点）都匹配不上（故 08-29 清扫后仍残留）。
// 变体只做整行处置（不做行内序列剥除，防误杀直播里合法口播的「订阅/关注/转发」）：
// 行含「明镜与点」水印，或全行仅由 订阅/转发/栏目 词元+标点组成（≥3 词元）——
// 剥词元后剩真内容则保留、全空则删行。
//
// 用法：
//   SVC_PASSWORD=... npx tsx tools/transcriber/scripts/purge-hallucinations.ts --dry-run  # 只报将删行数
//   SVC_PASSWORD=... npx tsx tools/transcriber/scripts/purge-hallucinations.ts           # 实跑三写
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { ApiClient } from "../src/api-client"
import { HALLUCINATION_TOKENS } from "../src/whisper"

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, "../out")
const DRY = process.argv.includes("--dry-run")

const TS_LINE = /^\s*\[(\d{1,3}:\d{2})\]\s*/

/** 幻觉序列：黑名单词与纯空白/标点连接的重复串（md 是段落聚合行，一行内可混
 *  数百次幻觉重复+真内容——实测「字幕志愿者 李宗盛」×646 同行连排）。只剥词
 *  本身及其分隔符，词后紧跟的真字保留（保守防误杀）。 */
const HALLUCINATION_SEQ = new RegExp(
  `(?:\\s*(?:${HALLUCINATION_TOKENS.join("|")})[\\s，。！？；：、,.!?;:（）()"'—-]*)+`,
  "g",
)

/** 变体家族行处置：null=非变体行（走基础规则）；""=删行；字符串=替换行。 */
function variantLine(line: string): string | null {
  const bare = line.replace(TS_LINE, "")
  if (!bare.includes("明镜与点")) {
    const toks = bare.split(/[，。、；,.!?;:\s（）()]+/).filter(Boolean)
    if (!(toks.length >= 3 && toks.every(t => t === "订阅" || t === "转发" || t === "栏目"))) return null
  }
  const ts = TS_LINE.exec(line)?.[1]
  const remainder = bare.replace(/(订阅|转发|明镜与点[点点]?|栏目)[\s，。！？；：、,.!?;:（）()"'—-]*/g, "").trim()
  if (!remainder) return ""
  return ts ? `[${ts}] ${remainder}` : remainder
}

/** md 全文清洗：frontmatter/章头/无幻觉行一字不动。命中幻觉的行——
 *  剥幻觉序列后：剩真内容 → 行替换为剥后文本；全空 → 整行删（含时间戳）。
 *  变体行的余烬必须**串行再过基础规则**（首版短路 bug：变体余烬混基础 token
 *  ——「订阅，转发，明镜与点栏目。请不吝点赞，打赏支持」剥变体词后基础 token 幸存）。
 *  返回 null = 无幻觉。 */
export function purgeMd(md: string): { text: string; removed: number; cleaned: number } | null {
  if (!HALLUCINATION_TOKENS.some(tok => md.includes(tok)) && !md.includes("明镜与点")) return null
  const lines = md.split("\n")
  const out: string[] = []
  let removed = 0, cleaned = 0
  for (const line of lines) {
    let cur = line
    const v = variantLine(cur)
    if (v === "") { removed++; continue }
    if (v !== null) cur = v
    if (!HALLUCINATION_TOKENS.some(tok => cur.includes(tok))) {
      if (cur !== line) { cleaned++; out.push(cur) } else out.push(line)
      continue
    }
    const ts = TS_LINE.exec(cur)?.[1]
    const body = cur.replace(TS_LINE, "")
    const stripped = body.replace(HALLUCINATION_SEQ, "").trim()
    if (!stripped) { removed++; continue }
    cleaned++
    out.push(ts ? `[${ts}] ${stripped}` : stripped)
  }
  if (removed + cleaned === 0) return null
  return { text: out.join("\n").replace(/\n{3,}/g, "\n\n"), removed, cleaned }
}

// ── CLI ──
const password = process.env.SVC_PASSWORD
if (!password) { console.error("缺 SVC_PASSWORD"); process.exit(1) }
const api = new ApiClient(process.env.BASE_URL ?? "http://127.0.0.1:8080", {
  projectId: Number(process.env.PROJECT_ID ?? 614),
  authPath: join(outDir, "auth.json"),
})
await api.login(process.env.SVC_USERNAME ?? "svc-transcriber", password)

// 全库 transcripts 页扫（有幻觉的页才处理）
const r = await api.authedFetch(`/api/v1/projects/${api.projectId}/pages`)
if (!r.ok) { console.error(`listPages 失败 HTTP ${r.status}`); process.exit(1) }
const pages = (await r.json()) as Array<{ path: string }>
const targets = pages.filter(p => p.path.startsWith("transcripts/"))
console.log(`模式=${DRY ? "DRY-RUN" : "PURGE"} 扫描 ${targets.length} 页…`)

let touched = 0, totalRemoved = 0, totalCleaned = 0
for (const p of targets) {
  const slug = p.path.replace("transcripts/", "").replace(/\.md$/, "")
  const gr = await api.authedFetch(`/api/v1/projects/${api.projectId}/page?path=${encodeURIComponent(p.path)}`)
  if (!gr.ok) { console.error(`  [skip] GET ${p.path} HTTP ${gr.status}`); continue }
  const page = (await gr.json()) as { content: string | null }
  if (!page.content) continue
  const purged = purgeMd(page.content)
  if (purged === null) continue
  touched++
  totalRemoved += purged.removed
  totalCleaned += purged.cleaned
  console.log(`  ${slug}: 删整行 ${purged.removed}，行内清洗 ${purged.cleaned}`)
  if (DRY) continue
  await api.upsertTranscriptPage(p.path, purged.text)
  await api.writeSource(`sources/transcripts/${slug}.md`, purged.text)
  const snap = join(outDir, "punct", `${slug}.md`)
  if (existsSync(snap)) writeFileSync(snap, purged.text)
}
console.log(`完成：${touched} 页命中，删整行 ${totalRemoved}，行内清洗 ${totalCleaned}${DRY ? "（DRY-RUN 未写入）" : "，三写已落"}`)
