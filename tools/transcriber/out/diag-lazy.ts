import { readFileSync } from "node:fs"
import { punctuateMd, DEFAULT_PUNCTUATE, verifyPunctuated } from "../src/punctuation"

// 诊断：单个失败章走生产管线，捕获每次 LLM 原始响应的密度/保真/样例
const src = readFileSync(
  "/Users/berton/kb-storage/teams/916/projects/614/sources/transcripts/160-classroom-rules-798336c6.md",
  "utf8",
)
const chap = src.split(/\n(?=## \[06:41\])/)[1]?.split(/\n(?=## \[)/)[0] ?? ""
const md = `---\ntitle: "diag"\n---\n\n${chap.trim()}\n`
console.log(`chapter body: ${chap.length}ch`)

const model = process.argv[2] ?? "glm-5.1"
const realFetch = globalThis.fetch
const fetchImpl = (async (u: unknown, init?: RequestInit) => {
  const res = await realFetch(u as string, init)
  const j = (await res.json()) as { choices: Array<{ message: { content: string } }> }
  const raw = j.choices[0].message.content
  const core = raw.replace(/\[\d{1,3}:\d{2}\]/g, "").replace(/\s/g, "")
  const dens = core.length
    ? (raw.match(/[，。！？；：、,.!?;:()]/g) ?? []).length / core.length
    : 0
  const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] }
  const nudged = body.messages[1].content.includes("重试指令")
  console.log(
    `call# body=${body.messages[1].content.length}ch${nudged ? " [nudge]" : ""} -> resp dens=${dens.toFixed(3)} head=${JSON.stringify(raw.slice(0, 120))}`,
  )
  return new Response(JSON.stringify(j), { status: res.status })
}) as unknown as typeof fetch

const out = await punctuateMd(md, { ...DEFAULT_PUNCTUATE, enabled: true, model }, { fetchImpl, apiKey: undefined })
console.log(`result: ${out === null ? "NULL（文件回落）" : `ok ${out.length}ch verify=${verifyPunctuated(md, out)}`}`)
