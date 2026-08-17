// tools/transcriber/src/manifest.ts
import type { ProbeResult } from "./probe";
import type { ScannedFile } from "./scan";
import { classifyBucket, type Bucket } from "./bucket";

export interface ManifestRow {
  file: ScannedFile;
  probe: ProbeResult | null;
  error?: string;
}

export interface ManifestEntry {
  absPath: string; relPath: string; source: "main" | "hevc";
  category: "audio" | "video" | "doc"; ext: string;
  container: string | null; videoCodec: string | null; audioCodec: string | null;
  // error 行的 bucket 是保守兜底值（FALLBACK_PROBE 走视频分支 → "B_transcode"），消费方必须先过滤 error 行再按桶分组（M1 起将改为 error → null）
  durationS: number; bucket: Bucket | null; privacy: boolean; inFirstBatch: boolean;
  error?: string;
}

export interface ManifestSummary {
  generatedAt: string;
  totalFiles: number;          // 全部登记行（含 doc 与 error 行）
  totalDurationH: number;      // 仅成功探测的音视频行，round 2
  byBucket: Record<Bucket, { files: number; durationH: number }>; // 仅成功探测的音视频行
  bySource: Record<"main" | "hevc", number>;
  docFiles: number;            // doc 类单独计数
  ignoredFiles: number;        // 未登记扩展名
  probeFailures: number;
  overlap: { matchedPairs: number; mainOnly: number; hevcOnly: number };
  firstBatch: { dir: string; files: number; durationH: number; bySource: { main: number; hevc: number } };
}

const FALLBACK_PROBE: ProbeResult = { durationS: 0, container: "", videoCodec: null, audioCodec: null };
const round2 = (v: number) => Math.round(v * 100) / 100;

export function normalizeName(relPath: string): string {
  const base = relPath.replace(/\.[^.]+$/, "").split("/").pop() ?? "";
  return base.replace(/^[\d\s.、\-—]+/, "").replace(/[\s_（）()\-—]+/g, "").toLowerCase();
}

export function buildManifest(
  rows: ManifestRow[],
  privacyDirs: string[],
  firstBatchDir: string,
  ignoredFiles = 0,
): { entries: ManifestEntry[]; summary: ManifestSummary } {
  const entries: ManifestEntry[] = rows.map(({ file, probe, error }) => {
    const effective = probe ?? FALLBACK_PROBE;
    return {
      ...file,
      container: probe?.container ?? null,
      videoCodec: probe?.videoCodec ?? null,
      audioCodec: probe?.audioCodec ?? null,
      durationS: effective.durationS,
      bucket: classifyBucket(file, effective),
      privacy: privacyDirs.some(d => file.relPath.includes(d)),
      inFirstBatch: file.relPath.includes(firstBatchDir),
      ...(error ? { error } : {}),
    };
  });

  // —— 桶统计：仅成功探测的音视频行（doc 的 bucket 本就是 null）——
  const bucketRows = entries.filter(e => e.bucket !== null && !e.error);
  const sumS = (es: ManifestEntry[]) => es.reduce((a, e) => a + e.durationS, 0);
  const h = (s: number) => round2(s / 3600);

  // —— 跨目录归一化重叠（doc 不参与）——
  const normSets = (source: "main" | "hevc") => {
    const m = new Map<string, number>();
    for (const e of entries) {
      if (e.source !== source || e.category === "doc") continue;
      const k = normalizeName(e.relPath);
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  };
  const mainSet = normSets("main");
  const hevcSet = normSets("hevc");
  let matchedPairs = 0;
  for (const k of mainSet.keys()) if (hevcSet.has(k)) matchedPairs++;

  // —— 首批（按来源拆分，成功探测行）——
  const firstRows = bucketRows.filter(e => e.inFirstBatch);
  const firstBatch = {
    dir: firstBatchDir,
    files: firstRows.length,
    durationH: h(sumS(firstRows)),
    bySource: {
      main: firstRows.filter(e => e.source === "main").length,
      hevc: firstRows.filter(e => e.source === "hevc").length,
    },
  };

  const summary: ManifestSummary = {
    generatedAt: new Date().toISOString(),
    totalFiles: entries.length,
    totalDurationH: h(sumS(bucketRows)),
    byBucket: {
      A_playable: { files: bucketRows.filter(e => e.bucket === "A_playable").length, durationH: h(sumS(bucketRows.filter(e => e.bucket === "A_playable"))) },
      B_transcode: { files: bucketRows.filter(e => e.bucket === "B_transcode").length, durationH: h(sumS(bucketRows.filter(e => e.bucket === "B_transcode"))) },
    },
    bySource: {
      main: entries.filter(e => e.source === "main").length,
      hevc: entries.filter(e => e.source === "hevc").length,
    },
    docFiles: entries.filter(e => e.category === "doc").length,
    ignoredFiles,
    probeFailures: entries.filter(e => e.error).length,
    overlap: {
      matchedPairs,
      mainOnly: [...mainSet.keys()].filter(k => !hevcSet.has(k)).length,
      hevcOnly: [...hevcSet.keys()].filter(k => !mainSet.has(k)).length,
    },
    firstBatch,
  };
  return { entries, summary };
}
