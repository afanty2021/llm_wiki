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
  // error 行的 bucket 为 null（探测失败无从分类）；doc 类也返回 null。消费方按桶分组时自然排除两类行
  durationS: number; bucket: Bucket | null; privacy: boolean; inFirstBatch: boolean;
  error?: string;
}

export interface IgnoredStats {
  total: number;        // 扫描发现的未登记扩展名文件总数（救援前）
  mediaRescued: number; // 其中经 ffprobe 确认为媒体并救援登记的数量（ext=""）
}

export interface OverlapGroup {
  key: string;
  main: string[]; // relPath
  hevc: string[]; // relPath
  note?: "duration_mismatch" | "error_involved"; // 同名但未通过时长交叉验证时的原因
}

export interface ManifestSummary {
  generatedAt: string;
  elapsedS: number;           // CLI 记录的端到端耗时（buildManifest 内默认 0，由 CLI 覆写）
  totalFiles: number;          // 全部登记行（含 doc、error 与救援行）
  totalDurationH: number;      // 仅成功探测的音视频行，round 2
  byBucket: Record<Bucket, { files: number; durationH: number }>; // 仅成功探测的音视频行
  bySource: Record<"main" | "hevc", { files: number; durationH: number }>; // files=全部行（含 doc/error）；durationH=非 doc 行（error 行时长 0）
  docFiles: number;            // doc 类单独计数
  privacyFiles: number;        // privacy 目录命中行数
  ignoredFiles: number;        // 救援后仍未登记（非媒体）的文件数 = total - mediaRescued
  probeFailures: number;
  overlap: { matchedPairs: number; mainOnly: number; hevcOnly: number }; // matchedPairs 经时长交叉验证；mainOnly/hevcOnly 为各自独立 key 数（null key 不计）
  firstBatch: { dir: string; files: number; durationH: number; bySource: { main: number; hevc: number } };
}

const FALLBACK_PROBE: ProbeResult = { durationS: 0, container: "", videoCodec: null, audioCodec: null };
const round2 = (v: number) => Math.round(v * 100) / 100;

// 分隔符折叠：空格、下划线、连字符/破折号、全半角括号、句点
const SEP_RE = /[\s_\-—（）().]+/g;
// 仅剥离文件名开头的集数/音轨号前缀（数字及其后紧跟的分隔符），不动中间的数字
const LEADING_NUM_RE = /^[\d\s.、\-—_]+/;
// 真扩展名（短且无空白），避免把 "137. IBL-Inquiry based learning" 的句点当扩展名分隔符
const TRAILING_EXT_RE = /\.[A-Za-z0-9]{1,6}$/;

const normalizeSegment = (s: string): string => s.replace(SEP_RE, "").toLowerCase();

/**
 * 跨目录配对键 = 父目录名（仅一级，紧邻 basename 的那段）+ "/" + 去编号前缀的文件名主干。
 * 目录段的加入修复旧 normalizeName 丢目录导致的过度合并（如 剑桥1/test1 与 test2 同名 section）。
 * 两段都归一化为空（如顶层 "3-1.mp3" 整体是编号）→ 返回 null，完全排除出配对。
 */
export function pairingKey(relPath: string): string | null {
  const slash = relPath.lastIndexOf("/");
  const basename = slash >= 0 ? relPath.slice(slash + 1) : relPath;
  const parentSeg = slash >= 0 ? (relPath.slice(0, slash).split("/").pop() ?? "") : null;
  const stem = normalizeSegment(basename.replace(TRAILING_EXT_RE, "").replace(LEADING_NUM_RE, ""));
  const parent = parentSeg !== null ? normalizeSegment(parentSeg) : null;
  if (parent === null) return stem === "" ? null : stem;
  if (parent === "" && stem === "") return null;
  return `${parent}/${stem}`;
}

// 时长交叉验证：两边都探出正时长，且差值在 max(2s, 1%) 容差内（转码副本允许微小漂移）
const durationCompatible = (a: ManifestEntry, b: ManifestEntry): boolean =>
  a.durationS > 0 && b.durationS > 0 &&
  Math.abs(a.durationS - b.durationS) <= Math.max(2, Math.round(0.01 * Math.max(a.durationS, b.durationS)));

export function buildManifest(
  rows: ManifestRow[],
  privacyDirs: string[],
  firstBatchDir: string,
  ignoredStats: IgnoredStats = { total: 0, mediaRescued: 0 },
): { entries: ManifestEntry[]; summary: ManifestSummary; overlapGroups: OverlapGroup[] } {
  const entries: ManifestEntry[] = rows.map(({ file, probe, error }) => {
    const effective = probe ?? FALLBACK_PROBE;
    return {
      ...file,
      container: probe?.container ?? null,
      videoCodec: probe?.videoCodec ?? null,
      audioCodec: probe?.audioCodec ?? null,
      durationS: effective.durationS,
      bucket: error ? null : classifyBucket(file, effective),
      privacy: privacyDirs.some(d => file.relPath.includes(d)),
      inFirstBatch: file.relPath.includes(firstBatchDir),
      ...(error ? { error } : {}),
    };
  });

  // —— 桶统计：仅成功探测的音视频行（doc 与 error 行 bucket 均为 null，自然排除）——
  const bucketRows = entries.filter(e => e.bucket !== null);
  const sumS = (es: ManifestEntry[]) => es.reduce((a, e) => a + e.durationS, 0);
  const h = (s: number) => round2(s / 3600);

  // —— 跨目录配对（doc 不参与；error 行进组但打标记）——
  const groups = new Map<string, { main: ManifestEntry[]; hevc: ManifestEntry[] }>();
  for (const e of entries) {
    if (e.category === "doc") continue;
    const k = pairingKey(e.relPath);
    if (k === null) continue; // 空键（纯编号名）不参与配对
    const g = groups.get(k) ?? { main: [], hevc: [] };
    g[e.source].push(e);
    groups.set(k, g);
  }
  let matchedPairs = 0, mainOnly = 0, hevcOnly = 0;
  const overlapGroups: OverlapGroup[] = [];
  for (const [key, g] of groups) {
    if (g.main.length === 0) { hevcOnly++; continue; }
    if (g.hevc.length === 0) { mainOnly++; continue; }
    const group: OverlapGroup = { key, main: g.main.map(e => e.relPath), hevc: g.hevc.map(e => e.relPath) };
    if (g.main.some(a => g.hevc.some(b => durationCompatible(a, b)))) {
      matchedPairs++;
    } else if (g.main.some(e => e.error) || g.hevc.some(e => e.error)) {
      group.note = "error_involved"; // 组内含探测失败行（如损坏副本 durationS=0）
    } else {
      group.note = "duration_mismatch"; // 两边都探测成功但时长对不上
    }
    overlapGroups.push(group);
  }
  overlapGroups.sort((a, b) => a.key.localeCompare(b.key));

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
    elapsedS: 0,
    totalFiles: entries.length,
    totalDurationH: h(sumS(bucketRows)),
    byBucket: {
      A_playable: { files: bucketRows.filter(e => e.bucket === "A_playable").length, durationH: h(sumS(bucketRows.filter(e => e.bucket === "A_playable"))) },
      B_transcode: { files: bucketRows.filter(e => e.bucket === "B_transcode").length, durationH: h(sumS(bucketRows.filter(e => e.bucket === "B_transcode"))) },
    },
    bySource: {
      main: { files: entries.filter(e => e.source === "main").length, durationH: h(sumS(entries.filter(e => e.source === "main" && e.category !== "doc"))) },
      hevc: { files: entries.filter(e => e.source === "hevc").length, durationH: h(sumS(entries.filter(e => e.source === "hevc" && e.category !== "doc"))) },
    },
    docFiles: entries.filter(e => e.category === "doc").length,
    privacyFiles: entries.filter(e => e.privacy).length,
    ignoredFiles: ignoredStats.total - ignoredStats.mediaRescued,
    probeFailures: entries.filter(e => e.error).length,
    overlap: { matchedPairs, mainOnly, hevcOnly },
    firstBatch,
  };
  return { entries, summary, overlapGroups };
}
