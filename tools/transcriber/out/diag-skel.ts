import { readFileSync } from "node:fs"
import { DEFAULT_PUNCTUATE, skeletonOf, SYS } from "../src/punctuation"

const src = readFileSync(
  "/Users/berton/kb-storage/teams/916/projects/614/sources/transcripts/160-classroom-rules-798336c6.md",
  "utf8",
)
const chap = src.split(/\n(?=## \[06:41\])/)[1]?.split(/\n(?=## \[)/)[0] ?? ""
const body = chap.replace(/^## \[[^\]]*\]\s*.*\n/, "").trim()

const model = process.argv[2] ?? "glm-5.1"
const key = (await import("../src/chaptering")).loadZaiKey()
const res = await fetch("https://open.bigmodel.cn/api/coding/paas/v4/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
  body: JSON.stringify({
    model,
    temperature: 0,
    thinking: { type: "disabled" },
    max_tokens: 8000,
    messages: [
      { role: "system", content: SYS },
      { role: "user", content: body },
    ],
  }),
  signal: AbortSignal.timeout(120000),
})
const j = (await res.json()) as { choices: Array<{ message: { content: string } }> }
const raw = j.choices[0].message.content

const a = skeletonOf(body)
const b = skeletonOf(raw)
console.log(`model=${model} | input skel ${a.length}ch, output skel ${b.length}ch`)
let i = 0
while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++
console.log(`first mismatch @${i}`)
console.log(`input  : …${a.slice(Math.max(0, i - 25), i + 25)}…`)
console.log(`output : …${b.slice(Math.max(0, i - 25), i + 25)}…`)
const core = raw.replace(/\[\d{1,3}:\d{2}\]/g, "").replace(/\s/g, "")
console.log(`dens=${((raw.match(/[，。！？；：、,.!?;:()]/g) ?? []).length / Math.max(1, core.length)).toFixed(3)}`)
console.log(DEFAULT_PUNCTUATE ? "" : "")
