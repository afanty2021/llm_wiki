// tools/transcriber/src/cli.ts
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { scanDirectory } from "./scan";
import { probeMedia } from "./probe";
import { buildManifest, type ManifestRow } from "./manifest";

// 仓库根是 "type": "module"——禁用 __dirname，用 import.meta.url（tools/ 既有脚本惯例）
const here = fileURLToPath(new URL(".", import.meta.url));

interface Config {
  mainRoot: string; hevcRoot: string;
  privacyDirs: string[]; firstBatchDir: string;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }));
  return results;
}

async function main() {
  const [cmd] = process.argv.slice(2);
  if (cmd !== "audit") { console.error("用法: tsx tools/transcriber/src/cli.ts audit"); process.exit(1); }
  const cfg: Config = JSON.parse(readFileSync(join(here, "../config.json"), "utf-8"));
  const mainScan = scanDirectory(cfg.mainRoot, "main");
  const hevcScan = scanDirectory(cfg.hevcRoot, "hevc");
  const files = [...mainScan.files, ...hevcScan.files];
  const ignored = mainScan.ignored + hevcScan.ignored;
  console.log(`扫描到 ${files.length} 个登记文件（另 ${ignored} 个未登记扩展名），开始 ffprobe（并发 4）…`);

  let done = 0;
  const rows: ManifestRow[] = await mapLimit(files, 4, async file => {
    done++; // 含 doc 行的统一进度（doc 不探测但不跳过计数）
    if (done % 20 === 0) console.log(`  进度 ${done}/${files.length}`);
    if (file.category === "doc") return { file, probe: null };
    try {
      return { file, probe: await probeMedia(file.absPath) };
    } catch (e) {
      return { file, probe: null, error: String(e).slice(0, 200) };
    }
  });

  const { entries, summary } = buildManifest(rows, cfg.privacyDirs, cfg.firstBatchDir, ignored);
  mkdirSync(join(here, "../out"), { recursive: true });
  writeFileSync(join(here, "../out/manifest.json"), JSON.stringify(entries, null, 2));
  writeFileSync(join(here, "../out/manifest-summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
