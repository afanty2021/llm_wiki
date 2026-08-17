// tools/transcriber/src/cli.ts
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { scanDirectory, type ScannedFile } from "./scan";
import { probeMedia } from "./probe";
import { buildManifest, type ManifestRow } from "./manifest";

const execFileAsync = promisify(execFile);

// 仓库根是 "type": "module"——禁用 __dirname，用 import.meta.url（tools/ 既有脚本惯例）
const here = fileURLToPath(new URL(".", import.meta.url));
const configPath = join(here, "../config.json");

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

function fail(msg: string): never {
  console.error(`✗ 预检失败：${msg}`);
  process.exit(1);
}

// 预检：配置可读可解析、两个根目录存在、ffprobe 可用——失败即退出，不进扫描
async function preflight(): Promise<Config> {
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf-8");
  } catch (e) {
    return fail(`无法读取 ${configPath}（${String(e).slice(0, 120)}）`);
  }
  let cfg: Config;
  try {
    cfg = JSON.parse(raw) as Config;
  } catch (e) {
    return fail(`${configPath} 不是合法 JSON（${String(e).slice(0, 120)}）`);
  }
  for (const [label, root] of [["mainRoot", cfg.mainRoot], ["hevcRoot", cfg.hevcRoot]] as const) {
    if (!root || !existsSync(root)) return fail(`配置的 ${label} 目录不存在：${root}`);
  }
  try {
    await execFileAsync("ffprobe", ["-version"]);
  } catch {
    return fail("ffprobe 不可用——请先安装 ffmpeg（macOS: brew install ffmpeg）");
  }
  return cfg;
}

function parseConcurrency(argv: string[]): number {
  const i = argv.indexOf("--concurrency");
  if (i < 0) return 4;
  const n = Number(argv[i + 1]);
  if (!Number.isInteger(n) || n < 1) fail(`--concurrency 需为正整数（收到 ${argv[i + 1] ?? "无值"}）`);
  return n;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] !== "audit") { console.error("用法: tsx tools/transcriber/src/cli.ts audit [--concurrency N]"); process.exit(1); }
  const t0 = Date.now();
  const concurrency = parseConcurrency(argv);
  const cfg = await preflight();

  const mainScan = scanDirectory(cfg.mainRoot, "main");
  const hevcScan = scanDirectory(cfg.hevcRoot, "hevc");
  const ignored = [
    ...mainScan.ignoredPaths.map(absPath => ({ absPath, source: "main" as const, root: cfg.mainRoot })),
    ...hevcScan.ignoredPaths.map(absPath => ({ absPath, source: "hevc" as const, root: cfg.hevcRoot })),
  ];

  // 救援扫描：未登记扩展名不等于非媒体（如 "137. IBL…" 无扩展名）——逐个 ffprobe，探出流即登记（ext=""）
  const rescued: ScannedFile[] = [];
  if (ignored.length > 0) {
    console.log(`救援扫描：ffprobe 探测 ${ignored.length} 个未登记扩展名文件…`);
    const probes = await mapLimit(ignored, concurrency, async ({ absPath }) => {
      try { return await probeMedia(absPath); } catch { return null; }
    });
    ignored.forEach((ig, i) => {
      const probe = probes[i];
      if (probe && (probe.videoCodec ?? probe.audioCodec) !== null) {
        rescued.push({
          absPath: ig.absPath,
          relPath: ig.absPath.slice(ig.root.length + 1),
          source: ig.source,
          category: probe.videoCodec ? "video" : "audio",
          ext: "",
        });
      }
    });
    console.log(`救援：${rescued.length}/${ignored.length} 个确认为媒体，纳入登记（ext="" → 桶B）`);
  }

  const files = [...mainScan.files, ...hevcScan.files, ...rescued];
  console.log(`扫描到 ${files.length} 个登记文件（另 ${ignored.length - rescued.length} 个未登记扩展名），开始 ffprobe（并发 ${concurrency}）…`);

  let done = 0;
  const rows: ManifestRow[] = await mapLimit(files, concurrency, async file => {
    done++; // 含 doc 行的统一进度（doc 不探测但不跳过计数）
    if (done % 20 === 0) console.log(`  进度 ${done}/${files.length}`);
    if (file.category === "doc") return { file, probe: null };
    try {
      return { file, probe: await probeMedia(file.absPath) };
    } catch (e) {
      return { file, probe: null, error: String(e).slice(0, 200) };
    }
  });

  const { entries, summary, overlapGroups } =
    buildManifest(rows, cfg.privacyDirs, cfg.firstBatchDir, { total: ignored.length, mediaRescued: rescued.length });
  summary.elapsedS = Math.round((Date.now() - t0) / 100) / 10;
  mkdirSync(join(here, "../out"), { recursive: true });
  writeFileSync(join(here, "../out/manifest.json"), JSON.stringify(entries, null, 2));
  writeFileSync(join(here, "../out/manifest-summary.json"), JSON.stringify(summary, null, 2));
  writeFileSync(join(here, "../out/overlap.json"), JSON.stringify(overlapGroups, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
