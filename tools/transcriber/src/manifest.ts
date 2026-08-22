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

// —— manifest v2 信封（M4 前工具项）：行内去 absPath（实测约占体积 45%），绝对根上提到信封层 ——
// v1 = 裸数组（无 version 字段，每行自带 absPath）；parseManifest 读取侧兼容两版，
// 写侧（serializeManifest）默认只产 v2。manifest-summary / overlap 口径不变（本就只按 relPath 统计）。

/** relPath 的基准根：双根扫描（main/hevc）单一字符串装不下，行内按 source 取对应根 */
export type ManifestBaseDir = { main: string; hevc: string };

/** v2 信封行 = ManifestEntry 去 absPath（读取侧按 baseDir[source] + "/" + relPath 重建） */
export type ManifestEntrySlim = Omit<ManifestEntry, "absPath">;

export interface ManifestEnvelope {
  version: 2;                 // v1 无信封（裸数组），读取侧以 Array.isArray 区分新旧
  baseDir: ManifestBaseDir;   // 行内 relPath 相对的绝对根（按行 source 取）
  generatedAt: string;        // 与 manifest-summary.generatedAt 同源
  rows: ManifestEntrySlim[];
}

/** 序列化为 v2 信封（写侧唯一格式）：仅剥行内 absPath，其余字段原样保留。 */
export function serializeManifest(
  entries: ManifestEntry[],
  baseDir: ManifestBaseDir,
  generatedAt: string,
): ManifestEnvelope {
  return {
    version: 2,
    baseDir,
    generatedAt,
    rows: entries.map(({ absPath: _absPath, ...rest }) => rest),
  };
}

// 行形状防御：行必须是含 relPath 字符串的对象（--diff 的输入是显式指定的文件，坏形状直接抛，fail fast）
const assertRows = (rows: unknown[], what: string): void => {
  for (const r of rows) {
    if (typeof r !== "object" || r === null || typeof (r as { relPath?: unknown }).relPath !== "string") {
      throw new Error(`${what} 存在缺 relPath 的行`);
    }
  }
};

/**
 * 读取侧兼容 v1/v2：v1（无 version 字段的裸数组）行含 absPath，原样透传；
 * v2 信封行按 baseDir[source] + "/" + relPath 重建 absPath（source 无对应根或根为空串时
 * 退化为 relPath——diff 等消费方只用 relPath/source，绝对路径仅展示用）。形状不符抛错。
 */
export function parseManifest(json: unknown): ManifestEntry[] {
  if (Array.isArray(json)) {
    assertRows(json, "v1 裸数组");
    return json as ManifestEntry[];
  }
  const version = (json as { version?: unknown } | null | undefined)?.version;
  if (version === 2) {
    const env = json as { baseDir?: unknown; rows?: unknown };
    if (typeof env.baseDir !== "object" || env.baseDir === null || !Array.isArray(env.rows)) {
      throw new Error("v2 信封形状不符：需 baseDir 对象 + rows 数组");
    }
    assertRows(env.rows, "v2 rows");
    const baseDir = env.baseDir as Partial<ManifestBaseDir>;
    return (env.rows as ManifestEntrySlim[]).map(e => {
      const root = baseDir[e.source];
      return { ...e, absPath: root ? `${root}/${e.relPath}` : e.relPath };
    });
  }
  throw new Error(`不识别的 manifest 形状（version=${version === undefined ? "无" : String(version)}）——期望 v1 裸数组或 v2 信封`);
}

// —— audit --diff（M4 前工具项，spec §3.1 迁移健康检查）：上一份 manifest 与本次扫描对比 ——
// 配对键口径与 overlap 一致：pairingKey 忽略 source 与编号前缀——迁移期搬家（main→hevc）
// 或改名重编号都能对上，不误报新增/移除；纯编号空键（pairingKey 返回 null）退化为
// source/relPath 严格身份，仍参与 diff。

export interface ManifestDiffRow {
  source: "main" | "hevc";
  relPath: string;
  error?: string;
}

export interface ManifestDiffChanged {
  key: string;            // 配对键（空键兜底的严格身份键以 \0 前缀区分）
  fields: string[];       // 发生变化的字段名（人读清单）
  prev: ManifestDiffRow;
  curr: ManifestDiffRow;
}

export interface ManifestDiff {
  added: ManifestDiffRow[];         // 本次独有（新键，或同键配对剩余的行）
  removed: ManifestDiffRow[];       // 上一份独有（同上）
  changed: ManifestDiffChanged[];
  prevProbeFailures: number;        // 上一份 error 行数
  currProbeFailures: number;        // 本次 error 行数
  newErrorRows: ManifestDiffRow[];  // 新增 error 行：新行带错，或配对行由好变坏（坏→坏不算）
  exitCode: 0 | 1;                  // probeFailures 涌增或新增 error 行 → 1（spec §3.1：转换器产坏件）
}

// 参与变更比较的字段；absPath 不比（v2 行没有，且迁移期路径漂移属预期不算变更）
const DIFF_FIELDS = ["source", "category", "ext", "durationS", "bucket", "privacy", "inFirstBatch", "error"] as const;

export function diffManifests(prev: ManifestEntry[], curr: ManifestEntry[]): ManifestDiff {
  // pairingKey 结果不含 \0（归一化后是字母数字/中日文），严格身份键加 \0 前缀防撞
  const keyOf = (e: ManifestEntry): string => pairingKey(e.relPath) ?? `\0${e.source}/${e.relPath}`;
  const byKey = (rows: ManifestEntry[]): Map<string, ManifestEntry[]> => {
    const m = new Map<string, ManifestEntry[]>();
    for (const e of rows) m.set(keyOf(e), [...(m.get(keyOf(e)) ?? []), e]);
    return m;
  };
  const prevByKey = byKey(prev);
  const currByKey = byKey(curr);
  const lite = (e: ManifestEntry): ManifestDiffRow =>
    ({ source: e.source, relPath: e.relPath, ...(e.error !== undefined ? { error: e.error } : {}) });

  const added: ManifestDiffRow[] = [];
  const removed: ManifestDiffRow[] = [];
  const changed: ManifestDiffChanged[] = [];
  const newErrorRows: ManifestDiffRow[] = [];
  const takeNewError = (c: ManifestEntry, prevErrorFree: boolean): void => {
    if (c.error !== undefined && prevErrorFree) newErrorRows.push(lite(c));
  };
  for (const [key, currRows] of currByKey) {
    const prevRows = prevByKey.get(key);
    if (prevRows === undefined) {
      for (const c of currRows) { added.push(lite(c)); takeNewError(c, true); }
      continue;
    }
    // 同键贪心配对：优先同 source（未搬家的副本），再跨 source（迁移搬家）；本次多出的行归 added
    const used = new Set<number>();
    for (const c of currRows) {
      let idx = prevRows.findIndex((p, i) => !used.has(i) && p.source === c.source);
      if (idx < 0) idx = prevRows.findIndex((_p, i) => !used.has(i));
      if (idx < 0) { added.push(lite(c)); takeNewError(c, true); continue; }
      used.add(idx);
      const p = prevRows[idx];
      const fields = DIFF_FIELDS.filter(f => (p[f] ?? null) !== (c[f] ?? null));
      if (fields.length > 0) changed.push({ key, fields, prev: lite(p), curr: lite(c) });
      takeNewError(c, p.error === undefined); // 由好变坏才算新增（坏→坏只是 error 文案变化，归 changed）
    }
    prevRows.forEach((p, i) => { if (!used.has(i)) removed.push(lite(p)); });
  }
  for (const [key, prevRows] of prevByKey) {
    if (currByKey.has(key)) continue;
    for (const p of prevRows) removed.push(lite(p));
  }
  const byRelPath = (a: ManifestDiffRow, b: ManifestDiffRow) => a.relPath.localeCompare(b.relPath);
  added.sort(byRelPath);
  removed.sort(byRelPath);
  newErrorRows.sort(byRelPath);
  changed.sort((a, b) => a.key.localeCompare(b.key));
  const countErrors = (rows: ManifestEntry[]): number => rows.filter(e => e.error !== undefined).length;
  const prevProbeFailures = countErrors(prev);
  const currProbeFailures = countErrors(curr);
  return {
    added, removed, changed,
    prevProbeFailures, currProbeFailures, newErrorRows,
    // spec §3.1：probeFailures 涌增或新增 error 行 = 转换器产坏件 → 非零（供迁移健康检查）
    exitCode: currProbeFailures > prevProbeFailures || newErrorRows.length > 0 ? 1 : 0,
  };
}
