// tools/transcriber/src/cli.ts
// 子命令：audit（全库审计）/ transcribe（首批转写五步写入 + ingest + 对账）/ sign-media（HMAC 播放 URL）
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, renameSync, realpathSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, basename as pathBasename } from "node:path";
import { scanDirectory, type ScannedFile } from "./scan";
import { probeMedia } from "./probe";
import { buildManifest, type ManifestRow, type ManifestEntry, type ManifestSummary } from "./manifest";
import { extractAudio, transcodePlayback, sha256File, sha8Of, audioOutPath, playbackOutPath } from "./audio";
import { slugFor } from "./slug";
import { withinWindow, runTranscribe, parseWhisperJson, loadState, saveState, initLine, type StateLine } from "./whisper";
import { buildTranscriptMd } from "./transcript";
import { ApiClient, sha256Hex, type MediaAssetItem } from "./api-client";

const execFileAsync = promisify(execFile);

// 仓库根是 "type": "module"——禁用 __dirname，用 import.meta.url（tools/ 既有脚本惯例）
const here = fileURLToPath(new URL(".", import.meta.url));
const configPath = join(here, "../config.json");
const outDir = join(here, "../out");
const modelPath = join(here, "../models/ggml-large-v3-turbo.bin");
const statePath = join(outDir, "state.jsonl");
const whisperJsonPath = (slug: string) => join(outDir, "transcripts", `${slug}.json`);
const DEFAULT_BASE_URL = "http://127.0.0.1:8080";

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

// 预检：配置可读可解析、ffprobe 可用；根目录缺失降级为警告（迁移终态主库目录将被整体删除，
// 音频同样迁移、最终仅存 HEVC 目录）——双根皆缺在扫描层报错退出（防 config 路径打错的静默空跑）
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
  const mainOk = !!cfg.mainRoot && existsSync(cfg.mainRoot);
  const hevcOk = !!cfg.hevcRoot && existsSync(cfg.hevcRoot);
  if (!mainOk) console.warn(`⚠ mainRoot 不存在，视为空集：${cfg.mainRoot ?? "(未配置)"}`);
  if (!hevcOk) console.warn(`⚠ hevcRoot 不存在，视为空集：${cfg.hevcRoot ?? "(未配置)"}`);
  if (!mainOk && !hevcOk) return fail("mainRoot 与 hevcRoot 皆不存在——请检查 config.json 路径");
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

// —— transcribe / sign-media 参数与纯函数（单测覆盖）——

export interface TranscribeArgs {
  window: string;        // 时间窗口（默认 23:00-08:00，白天直跑传 00:00-23:59）
  limit?: number;        // 本次最多处理 N 个（断点续跑分段）
  force: boolean;        // 全部行重置 pending（重跑）
  demoSlug?: string;     // 仅该 slug 转一份 videotoolbox 副本（M4 按需转码缓存主案的验收演示）
}

export function parseTranscribeArgs(argv: string[]): TranscribeArgs {
  const val = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const window = val("--window") ?? "23:00-08:00";
  withinWindow(new Date(), window); // 非法窗口串在此即抛（fail fast，别等 48 个文件跑一半）
  const limitStr = val("--limit");
  if (limitStr !== undefined && (!/^\d+$/.test(limitStr) || +limitStr < 1)) {
    fail(`--limit 需为正整数（收到 ${limitStr}）`);
  }
  return {
    window,
    limit: limitStr !== undefined ? +limitStr : undefined,
    force: argv.includes("--force"),
    demoSlug: val("--demo-slug"),
  };
}

/** 首批目标：重审计结果过滤 inFirstBatch && !error && category==='video'（以重跑为准，允许迁移 ±漂移）。 */
export function selectFirstBatchVideos(entries: ManifestEntry[]): ManifestEntry[] {
  return entries
    .filter(e => e.inFirstBatch && !e.error && e.category === "video")
    .sort((a, b) => a.relPath.localeCompare(b.relPath));
}

/** bootstrap.sh 状态文件（KEY=VALUE 行）→ 记录；缺失/损坏返回空对象（调用方决定是否 fail）。行尾 " # 注释" 剥离（值域为 hex/数字，不含空格#）。 */
export function parseBootstrapEnv(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (!m) continue;
    out[m[1]] = m[2].replace(/\s+#.*$/, "").trim();
  }
  return out;
}

// —— audit（全库审计；transcribe 主循环第一步复用——重跑兼作迁移健康检查）——

async function runAudit(cfg: Config, concurrency: number): Promise<{ entries: ManifestEntry[]; summary: ManifestSummary }> {
  const t0 = Date.now();
  const scanOf = (root: string, source: "main" | "hevc") =>
    root && existsSync(root) ? scanDirectory(root, source) : { files: [] as ScannedFile[], ignoredPaths: [] as string[] };
  const mainScan = scanOf(cfg.mainRoot, "main");
  const hevcScan = scanOf(cfg.hevcRoot, "hevc");
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

  const mediaCount = entries.filter(e => !e.error && e.category !== "doc").length;
  if (mediaCount === 0) fail("审计结果 0 媒体——config 根目录可能指错（静默空跑防线）");

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(entries, null, 2));
  writeFileSync(join(outDir, "manifest-summary.json"), JSON.stringify(summary, null, 2));
  writeFileSync(join(outDir, "overlap.json"), JSON.stringify(overlapGroups, null, 2));
  return { entries, summary };
}

async function cmdAudit(argv: string[]): Promise<void> {
  const cfg = await preflight();
  const { summary } = await runAudit(cfg, parseConcurrency(argv));
  console.log(JSON.stringify(summary, null, 2));
}

// —— transcribe 主循环 ——

/** 断点续跑行（StateLine + relPath 映射键：迁移期间 absPath 漂移，relPath 也可能变，slug 才是稳定键） */
type Line = StateLine & { relPath?: string };

interface FileOutcome {
  slug: string; relPath: string;
  status: "done" | "skipped" | "failed";
  durationS: number; transcribeMs: number;
  upsert?: "created" | "skipped" | "updated";
  error?: string;
}

interface BatchRecord {
  slug: string; pagePath: string; sourcePath: string; expectedHash: string;
  /** 写入时的 md 原文——对账覆写时按原文重写（title/duration 重建若与当时不同会引入假 hash 漂移） */
  md: string;
}

function readBootstrapEnv(): Record<string, string> {
  try { return parseBootstrapEnv(readFileSync(join(outDir, "bootstrap.env"), "utf-8")); }
  catch { return {}; }
}

function makeApiClient(bootstrap: Record<string, string>): { api: ApiClient; hadTokens: boolean } {
  const projectId = Number(process.env.TRAINING__PROJECT_ID ?? bootstrap.PROJECT_ID ?? NaN);
  if (!Number.isInteger(projectId)) fail("projectId 未知——设 TRAINING__PROJECT_ID 或先跑 scripts/bootstrap.sh");
  const saved = ApiClient.readAuthFile();
  const api = new ApiClient(process.env.TRANSCRIBER_BASE_URL ?? DEFAULT_BASE_URL, {
    projectId,
    accessToken: saved?.access_token,
    refreshToken: saved?.refresh_token,
    username: process.env.SVC_USERNAME ?? bootstrap.SVC_USERNAME ?? "svc-transcriber",
    password: process.env.SVC_PASSWORD ?? bootstrap.SVC_PASSWORD,
    pollIntervalMs: 5000,
  });
  return { api, hadTokens: !!saved };
}

/** 展示标题 = basename 去真扩展名（与 slug 同源的保守正则，防 "137. IBL…" 句点误剥）。 */
const titleOf = (absPath: string): string => pathBasename(absPath).replace(/\.[A-Za-z0-9]{1,6}$/, "");

/** 音频就绪（内容寻址去重）：已有 sha 则复用；否则抽到 tmp、算 sha、命中既有则弃 tmp 否则转正。 */
async function ensureWav(absPath: string, tmpWav: string, knownSha8?: string): Promise<string> {
  if (knownSha8) {
    const finalWav = audioOutPath(outDir, knownSha8);
    if (existsSync(finalWav)) return knownSha8;
  }
  await extractAudio(absPath, tmpWav);
  const sha8 = sha8Of(await sha256File(tmpWav));
  if (knownSha8 && sha8 !== knownSha8) {
    throw new Error(`wav 指纹漂移：state 记 ${knownSha8} 实算 ${sha8}（源文件被迁移改写？）`);
  }
  const finalWav = audioOutPath(outDir, sha8);
  if (existsSync(finalWav)) rmSync(tmpWav); // 同内容跨目录命中既有 wav（sha 去重，跳过保留双份）
  else renameSync(tmpWav, finalWav);
  return sha8;
}

async function cmdTranscribe(argv: string[]): Promise<void> {
  const args = parseTranscribeArgs(argv);
  if (!existsSync(modelPath)) fail(`whisper 模型缺失：${modelPath}`);
  if (!existsSync(join(outDir, "bootstrap.env"))) fail("out/bootstrap.env 缺失——先跑 tools/transcriber/scripts/bootstrap.sh");

  const startedAt = new Date();
  console.log(`[${startedAt.toISOString()}] transcribe 启动：window=${args.window} limit=${args.limit ?? "∞"} force=${args.force} demoSlug=${args.demoSlug ?? "无"}`);

  // 第一步：重跑 audit（迁移期间 manifest 是时点快照；probeFailures 涌增即转换器产坏件）
  const cfg = await preflight();
  const { entries, summary } = await runAudit(cfg, parseConcurrency(argv));
  const probeFailures = entries.filter(e => e.error);
  if (probeFailures.length > 0) {
    console.warn(`⚠ 重审计 probeFailures=${probeFailures.length}（超出基线 2 则逐个核查——可能是迁移转换器新产坏件）：`);
    for (const e of probeFailures) console.warn(`    ${e.relPath}: ${e.error}`);
  }

  const targets = selectFirstBatchVideos(entries);
  if (targets.length === 0) fail("重审计后首批视频为 0（firstBatchDir 配置或目录漂移？）");
  const totalMediaH = Math.round(targets.reduce((a, e) => a + e.durationS, 0) / 36) / 100;
  console.log(`首批目标 ${targets.length} 个 / ${totalMediaH}h（重审计 firstBatch: ${summary.firstBatch.files} 文件 ${summary.firstBatch.durationH}h）`);

  const bootstrap = readBootstrapEnv();
  const { api, hadTokens } = makeApiClient(bootstrap);
  if (!hadTokens) {
    const user = process.env.SVC_USERNAME ?? bootstrap.SVC_USERNAME ?? "svc-transcriber";
    const pass = process.env.SVC_PASSWORD ?? bootstrap.SVC_PASSWORD;
    if (!pass) fail("SVC_PASSWORD 未知（out/bootstrap.env 缺 SVC_PASSWORD）");
    await api.login(user, pass);
    console.log(`已登录 ${user}（token 持久化 out/auth.json）`);
  }

  mkdirSync(join(outDir, "audio"), { recursive: true });
  mkdirSync(join(outDir, "transcripts"), { recursive: true });
  mkdirSync(join(outDir, "playback"), { recursive: true });

  let lines: Line[] = loadState(statePath);
  if (args.force) lines = lines.map(l => ({ ...l, status: "pending", tries: 0 }));
  const byRel = new Map<string, Line>();
  for (const l of lines) if (l.relPath) byRel.set(l.relPath, l);

  const outcomes: FileOutcome[] = [];
  const records: BatchRecord[] = [];
  let transcribed = 0, skipped = 0, failed = 0, transcribeMsTotal = 0, mediaS = 0, processed = 0;

  for (let i = 0; i < targets.length; i++) {
    const entry = targets[i];
    const base = pathBasename(entry.absPath);
    const title = titleOf(entry.absPath);
    if (!withinWindow(new Date(), args.window)) {
      console.log(`窗口结束，明日续跑（已完成 ${outcomes.length}/${targets.length}，state 已落盘）`);
      process.exit(0);
    }
    if (args.limit !== undefined && processed >= args.limit) {
      console.log(`--limit ${args.limit} 已处理满（本轮 ${outcomes.length}/${targets.length}），续跑去掉 limit 即可`);
      process.exit(0);
    }

    // 已 done 且 segments 落盘 → 复用（按原 title/duration 重建 md，hash 与写入时一致），不重转写
    const line = byRel.get(entry.relPath);
    if (line && line.status === "done" && !args.force && existsSync(whisperJsonPath(line.slug))) {
      const segments = parseWhisperJson(JSON.parse(readFileSync(whisperJsonPath(line.slug), "utf-8")));
      const { md } = buildTranscriptMd({
        title, segments, sourcePath: `sources/transcripts/${line.slug}.md`,
        mediaSlug: line.slug, durationS: entry.durationS,
      });
      records.push({ slug: line.slug, pagePath: `transcripts/${line.slug}.md`, sourcePath: `sources/transcripts/${line.slug}.md`, expectedHash: sha256Hex(md), md });
      outcomes.push({ slug: line.slug, relPath: entry.relPath, status: "skipped", durationS: entry.durationS, transcribeMs: 0 });
      skipped++;
      console.log(`[${i + 1}/${targets.length}] ${line.slug} — done 复用（断点续跑）`);
      continue;
    }

    // 新行或重跑：先抽音频（sha 去重）→ 定 slug → 状态 running → 转写 → 五步写入
    const tmpWav = join(outDir, "audio", `.tmp-${process.pid}-${i}.wav`);
    let sha8: string;
    try {
      sha8 = await ensureWav(entry.absPath, tmpWav, line?.wavSha);
    } catch (e) {
      console.error(`[${i + 1}/${targets.length}] ${entry.relPath} 音频抽取失败：${String(e).slice(0, 200)}`);
      if (line) { line.status = "failed"; line.tries++; line.error = String(e).slice(0, 200); saveState(statePath, lines); }
      outcomes.push({ slug: line?.slug ?? "", relPath: entry.relPath, status: "failed", durationS: entry.durationS, transcribeMs: 0, error: String(e).slice(0, 200) });
      failed++; processed++;
      continue;
    }
    const slug = slugFor(base, sha8);

    let cur = byRel.get(entry.relPath);
    if (!cur) {
      cur = { ...initLine(slug, sha8), relPath: entry.relPath };
      lines.push(cur); byRel.set(entry.relPath, cur);
    }
    cur.slug = slug;
    cur.wavSha = sha8;
    cur.status = "running"; cur.tries++; delete cur.error;
    saveState(statePath, lines);

    const tFile = Date.now();
    try {
      const jsonPath = whisperJsonPath(slug);
      if (!existsSync(jsonPath)) {
        await runTranscribe({ wavPath: audioOutPath(outDir, sha8), modelPath, outJsonPath: jsonPath });
      }
      const segments = parseWhisperJson(JSON.parse(readFileSync(jsonPath, "utf-8")));
      const sourcePath = `sources/transcripts/${slug}.md`;
      const pagePath = `transcripts/${slug}.md`;
      const { md, chapters } = buildTranscriptMd({ title, segments, sourcePath, mediaSlug: slug, durationS: entry.durationS });

      await api.writeSource(sourcePath, md);
      const upsert = await api.upsertTranscriptPage(pagePath, md);

      let playback: string | undefined;
      if (args.demoSlug === slug) {
        playback = playbackOutPath(outDir, slug, ".mp4");
        console.log(`  演示件转码（videotoolbox）：${base} → ${playback}`);
        await transcodePlayback(entry.absPath, playback);
      }

      const item: MediaAssetItem = {
        slug, media_ref: entry.absPath, playback_path: playback,
        duration_s: entry.durationS, codec: entry.videoCodec, kind: "video",
        chapters, transcript_page_path: pagePath, source_path: sourcePath,
      };
      await api.registerMediaAssets([item]);

      cur.status = "done"; cur.error = undefined;
      saveState(statePath, lines);
      const ms = Date.now() - tFile;
      transcribed++; processed++; transcribeMsTotal += ms; mediaS += entry.durationS;
      records.push({ slug, pagePath, sourcePath, expectedHash: sha256Hex(md), md });
      outcomes.push({ slug, relPath: entry.relPath, status: "done", durationS: entry.durationS, transcribeMs: ms, upsert });
      console.log(`[${i + 1}/${targets.length}] ${slug} — done（${(entry.durationS / 60).toFixed(1)}min 音频 / ${(ms / 60000).toFixed(1)}min 转写，upsert=${upsert}）`);
    } catch (e) {
      cur.status = "failed"; cur.error = String(e).slice(0, 200);
      saveState(statePath, lines);
      failed++; processed++;
      outcomes.push({ slug, relPath: entry.relPath, status: "failed", durationS: entry.durationS, transcribeMs: Date.now() - tFile, error: String(e).slice(0, 200) });
      console.error(`[${i + 1}/${targets.length}] ${slug} 失败：${String(e).slice(0, 300)}`);
    }
  }

  if (outcomes.length < targets.length) {
    console.log(`本轮结束：${outcomes.length}/${targets.length}（余量待续跑）`);
    process.exit(0);
  }

  // —— 全部完成：ingest 前对账 → 触发 → 等 job → 终态后对账（覆写则重写+告警）——
  const warnings: string[] = [];
  const reconcile = async (phase: string): Promise<void> => {
    for (const r of records) {
      if (await api.verifyTranscriptIntact(r.pagePath, r.expectedHash)) continue;
      const msg = `${phase} 覆写告警：${r.pagePath} 服务端 hash 不符（疑似 LLM 页覆写），重写…`;
      console.warn(`⚠ ${msg}`);
      warnings.push(msg);
      const up = await api.upsertTranscriptPage(r.pagePath, r.md); // 服务端内容不同 → If-Match PUT
      warnings.push(`${phase} 已重写 ${r.pagePath}（upsert=${up}）`);
    }
  };

  await reconcile("ingest前");
  const sourcePaths = records.map(r => r.sourcePath);
  console.log(`触发 ingest：${sourcePaths.length} 个 source…`);
  const jobId = await api.triggerIngest(sourcePaths);
  console.log(`job ${jobId} 已入队，轮询至终态…`);
  const job = await api.waitJob(jobId);
  console.log(`job 终态：${job.status}${job.error ? `（${job.error.slice(0, 200)}）` : ""}`);
  await reconcile("job后");

  const finishedAt = new Date();
  const durationMinutes = Math.round((finishedAt.getTime() - startedAt.getTime()) / 6000) / 10;
  const transcribeMinutes = Math.round(transcribeMsTotal / 6000) / 10;
  const report = {
    startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(),
    files: targets.length, transcribed, skipped, failed,
    jobStatus: job.status, jobId,
    durationMinutes, transcribeMinutes,
    mediaHours: Math.round(mediaS / 36) / 100,
    realtimeFactor: transcribeMsTotal > 0 ? Math.round((mediaS * 1000 / transcribeMsTotal) * 10) / 10 : null,
    reAudit: {
      generatedAt: summary.generatedAt, probeFailures: summary.probeFailures,
      firstBatch: summary.firstBatch,
      probeFailureEntries: probeFailures.map(e => ({ relPath: e.relPath, error: e.error })),
    },
    perFile: outcomes, warnings,
  };
  writeFileSync(join(outDir, "m1-first-batch-report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ files: report.files, transcribed, skipped, failed, jobStatus: job.status, durationMinutes, transcribeMinutes, realtimeFactor: report.realtimeFactor, warnings: warnings.length }, null, 2));
  console.log(`报告已写 out/m1-first-batch-report.json`);
  if (failed > 0 || job.status === "failed") process.exit(1);
}

// —— sign-media：本地 HMAC（与 Task 7 服务端同算法），输出可直接播放的完整 URL ——

async function cmdSignMedia(argv: string[]): Promise<void> {
  const slug = argv[0];
  if (!slug || slug.startsWith("--")) fail("用法: tsx tools/transcriber/src/cli.ts sign-media <slug> [--hours 12]");
  const hi = argv.indexOf("--hours");
  const hours = hi >= 0 ? Number(argv[hi + 1]) : 12;
  if (!Number.isFinite(hours) || hours <= 0 || hours > 168) fail(`--hours 需为 (0, 168]（收到 ${argv[hi + 1] ?? "无值"}）`);
  const bootstrap = readBootstrapEnv();
  const key = process.env.MEDIA__SIGNING_KEY ?? bootstrap.MEDIA__SIGNING_KEY;
  if (!key) fail("MEDIA__SIGNING_KEY 未知——设环境变量或写入 out/bootstrap.env（须与服务端一致）");
  const client = new ApiClient(process.env.TRANSCRIBER_BASE_URL ?? DEFAULT_BASE_URL, { projectId: 0, mediaSigningKey: key });
  console.log(client.signMediaUrl(slug, hours));
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const rest = argv.slice(1);
  if (cmd === "audit") return cmdAudit(rest);
  if (cmd === "transcribe") return cmdTranscribe(rest);
  if (cmd === "sign-media") return cmdSignMedia(rest);
  console.error("用法: tsx tools/transcriber/src/cli.ts audit [--concurrency N] | transcribe [--window 23:00-08:00] [--limit N] [--force] [--demo-slug <slug>] | sign-media <slug> [--hours 12]");
  process.exit(1);
}

// 直接执行（tsx）才跑 main；测试 import 纯函数不触发
const scriptUrl = (): string | null => {
  try { return pathToFileURL(realpathSync(process.argv[1])).href; } catch { return null; }
};
const invokedAsScript = process.argv[1] ? import.meta.url === scriptUrl() : false;
if (invokedAsScript) {
  main().catch(e => { console.error(e); process.exit(1); });
}
