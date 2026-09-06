// 一次性审计：155 个快照的章级密度，扫偷懒章残留（<400 字块豁免）
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PUNCT = new Set("，。！？；：、\u201c\u201d\u2018\u2019（）——……,.!?;:()'\"".split(""));
const TS = /\[\d{1,3}:\d{2}\]/g;

function punctDens(s: string): number {
  const t = s.replace(TS, "").replace(/\s+/g, "");
  if (!t.length) return 1;
  let n = 0;
  for (const ch of t) if (PUNCT.has(ch)) n++;
  return n / t.length;
}

const dir = "/Users/berton/Github/kb-obsidian/llm_wiki/tools/transcriber/out/punct";
const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
let bad = 0;
for (const f of files) {
  const text = readFileSync(join(dir, f), "utf8");
  // 按章头 `## [mm:ss]` 切
  const parts = text.split(/(?=^## \[\d{1,3}:\d{2}\])/m);
  for (const part of parts) {
    const head = part.match(/^## \[(\d{1,3}:\d{2})\]/)?.[1] ?? "(front)";
    const body = part.replace(/^## \[.*$/m, "");
    const clean = body.replace(/\s+/g, "");
    if (clean.length >= 400) {
      const d = punctDens(body);
      if (d < 0.02) {
        bad++;
        console.log(`LAZY ${f} [${head}] dens=${d.toFixed(3)} len=${clean.length}`);
      }
    }
  }
}
console.log(`\n快照总数=${files.length} 偷懒章=${bad}`);
