// 一次性 QA：游戏合集批次全量章级密度审计（75+ 快照，逐章，无抽样）
// 输出四档：HEALTHY / THIN(<0.033 边际) / LAZY(<0.02) / 短块豁免统计
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
let healthy = 0, thin = 0, lazy = 0, shortChunks = 0, totalChapters = 0;
const lazyList: string[] = [], thinList: string[] = [];
for (const f of files) {
  const text = readFileSync(join(dir, f), "utf8");
  const parts = text.split(/(?=^## \[\d{1,3}:\d{2}\])/m);
  for (const part of parts) {
    const head = part.match(/^## \[(\d{1,3}:\d{2})\]/)?.[1] ?? "(front)";
    const body = part.replace(/^## \[.*$/m, "");
    const clean = body.replace(/\s+/g, "");
    if (!clean.length) continue;
    totalChapters++;
    if (clean.length < 400) { shortChunks++; continue; }
    const d = punctDens(body);
    if (d < 0.02) { lazy++; lazyList.push(`${f} [${head}] dens=${d.toFixed(3)} len=${clean.length}`); }
    else if (d < 0.033) { thin++; thinList.push(`${f} [${head}] dens=${d.toFixed(3)} len=${clean.length}`); }
    else healthy++;
  }
}
console.log(`快照=${files.length} 章=${totalChapters}（<400字短块豁免=${shortChunks}）`);
console.log(`≥400字章: HEALTHY(≥0.033)=${healthy}  THIN(0.02-0.033 边际)=${thin}  LAZY(<0.02)=${lazy}`);
if (lazyList.length) { console.log("\nLAZY 清单:"); lazyList.forEach(l => console.log(" ", l)); }
if (thinList.length) { console.log("\nTHIN 清单（边际，读感可能偏连排）:"); thinList.forEach(l => console.log(" ", l)); }
