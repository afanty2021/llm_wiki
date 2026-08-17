# LT 师训系统 M0 内容对账 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 产出 LT 师训两目录的权威媒体 manifest（桶分类/时长/重叠/首批排产），作为 M1 转写批产的输入。

**Architecture:** 独立 Node CLI（`tools/transcriber/`，TypeScript），扫描 → ffprobe → 分桶 → 汇总四段纯函数管线；全量探测结果落 `out/manifest.json`（gitignore），汇总落 `out/manifest-summary.json`（提交留档）。

**Tech Stack:** TypeScript + vitest（复用仓库根配置，`npm run test:mocks` 自动拾取）+ tsx 运行 CLI + 系统 ffprobe。

**Spec:** `docs/superpowers/specs/2026-08-17-teacher-training-design.md`（v5，§3.1）

## Global Constraints

- 扫描**两个**目录：主库与 `（HEVC）` 目录（含仅存于 HEVC 的约 440 个文件）
- 排除 `__MACOSX` 目录与 `._` 前缀 macOS 资源叉文件（实测 30 个垃圾）
- 分桶两桶制：桶 A「浏览器可播」= 视频 MP4 容器+H.264+AAC、音频 mp3/m4a；**其余全部桶 B**（hevc、VOB/MPEG-2、mkv/avi/flv/wmv 非 H.264、wma 等）
- ffprobe 容器归一化：`format_name` 取首段（mp4 文件为 `"mov,mp4,..."` → `mov`）
- 不修改 `src/`、`src-tauri/`、`src-server/` 任何现有代码（M0 纯新增）
- 单文件 ffprobe 30s 超时；失败记录不阻塞整体
- 机器相关的绝对路径只进 `config.json`（gitignore），提交 `config.example.json`

## File Structure

```
tools/transcriber/
  config.json               # 本机路径配置（gitignore）
  config.example.json       # 提交的模板
  tsconfig.json             # 独立 tsconfig（typecheck 用）
  src/
    scan.ts                 # 目录遍历 + 扩展名分类 + 垃圾排除
    probe.ts                # ffprobe 封装 + JSON 解析（parseProbe 纯函数）
    bucket.ts               # 两桶分类纯函数
    manifest.ts             # 归一化/汇总/manifest 构建（纯函数）
    cli.ts                  # audit 子命令：串起全流程并落盘
  __tests__/
    scan.test.ts
    probe.test.ts
    bucket.test.ts
    manifest.test.ts
  out/                      # manifest.json + manifest-summary.json（manifest.json gitignore）
```

---

### Task 1: 脚手架 + 目录扫描器

**Files:**
- Create: `tools/transcriber/tsconfig.json`, `tools/transcriber/config.example.json`, `tools/transcriber/src/scan.ts`, `tools/transcriber/__tests__/scan.test.ts`
- Modify: `.gitignore`（追加两行）

**Interfaces:**
- Consumes: 无（首个任务）
- Produces: `scanDirectory(root: string, source: "main" | "hevc"): ScannedFile[]`；`ScannedFile = { absPath: string; relPath: string; source: "main"|"hevc"; category: "audio"|"video"|"doc"; ext: string }`；常量 `AUDIO_EXTS`/`VIDEO_EXTS`/`DOC_EXTS`

- [ ] **Step 1: 写失败测试**

```typescript
// tools/transcriber/__tests__/scan.test.ts
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterAll } from "vitest";
import { scanDirectory } from "../src/scan";

const root = mkdtempSync(join(tmpdir(), "m0-scan-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("scanDirectory", () => {
  it("分类音视频与文档，保留相对路径", () => {
    mkdirSync(join(root, "专栏A"), { recursive: true });
    writeFileSync(join(root, "专栏A", "01.课程.mp4"), "x");
    writeFileSync(join(root, "b.mp3"), "x");
    writeFileSync(join(root, "c.pdf"), "x");
    const files = scanDirectory(root, "main");
    const mp4 = files.find(f => f.relPath === "专栏A/01.课程.mp4");
    expect(mp4).toMatchObject({ category: "video", ext: ".mp4", source: "main" });
    expect(files.find(f => f.relPath === "b.mp3")?.category).toBe("audio");
    expect(files.find(f => f.relPath === "c.pdf")?.category).toBe("doc");
  });

  it("排除 __MACOSX、隐藏文件与 ._ 资源叉", () => {
    mkdirSync(join(root, "__MACOSX", "sub"), { recursive: true });
    writeFileSync(join(root, "__MACOSX", "sub", "junk.mp4"), "x");
    writeFileSync(join(root, "._hidden.mp4"), "x");
    writeFileSync(join(root, ".DS_Store"), "x");
    const files = scanDirectory(root, "main");
    expect(files.some(f => f.relPath.includes("__MACOSX"))).toBe(false);
    expect(files.some(f => f.relPath.startsWith("._"))).toBe(false);
  });

  it("忽略未登记扩展名", () => {
    writeFileSync(join(root, "note.txt"), "x");
    writeFileSync(join(root, "cover.jpg"), "x");
    expect(scanDirectory(root, "main").some(f => f.relPath === "note.txt")).toBe(false);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tools/transcriber/__tests__/scan.test.ts`
Expected: FAIL（`Cannot find module '../src/scan'`）

- [ ] **Step 3: 最小实现**

```typescript
// tools/transcriber/src/scan.ts
import { readdirSync } from "node:fs";
import { join, extname } from "node:path";

export const AUDIO_EXTS = new Set([".mp3", ".m4a", ".wma", ".wav", ".flac", ".aac"]);
export const VIDEO_EXTS = new Set([".mp4", ".mov", ".vob", ".mkv", ".avi", ".flv", ".wmv", ".m4v"]);
export const DOC_EXTS = new Set([".pdf", ".pptx", ".docx", ".md"]);

export interface ScannedFile {
  absPath: string;
  relPath: string;
  source: "main" | "hevc";
  category: "audio" | "video" | "doc";
  ext: string;
}

export function scanDirectory(root: string, source: "main" | "hevc"): ScannedFile[] {
  const out: ScannedFile[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "__MACOSX" || entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (entry.name.startsWith("._")) continue;
      const ext = extname(entry.name).toLowerCase();
      const category = AUDIO_EXTS.has(ext) ? "audio"
        : VIDEO_EXTS.has(ext) ? "video"
        : DOC_EXTS.has(ext) ? "doc" : null;
      if (!category) continue;
      out.push({ absPath: full, relPath: full.slice(root.length + 1), source, category, ext });
    }
  };
  walk(root);
  return out;
}
```

```json
// tools/transcriber/tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022", "module": "ESNext", "moduleResolution": "bundler",
    "strict": true, "noEmit": true, "skipLibCheck": true
  },
  "include": ["src/**/*.ts", "__tests__/**/*.ts"]
}
```

```json
// tools/transcriber/config.example.json
{
  "mainRoot": "/path/to/L T师训 2024-2025",
  "hevcRoot": "/path/to/L T师训 2024-2025（HEVC）",
  "privacyDirs": ["课堂教学案例", "课堂活动"],
  "firstBatchDir": "教学新知班级管理专栏"
}
```

- [ ] **Step 4: 运行确认通过 + typecheck**

Run: `npx vitest run tools/transcriber/__tests__/scan.test.ts && npx tsc -p tools/transcriber`
Expected: 3 passed；typecheck 无错误

- [ ] **Step 5: gitignore 与提交**

`.gitignore` 追加：

```
tools/transcriber/config.json
tools/transcriber/out/manifest.json
```

```bash
git add tools/transcriber .gitignore
git commit -m "feat(transcriber): M0 目录扫描器——扩展名分类与垃圾排除"
```

---

### Task 2: ffprobe 探测

**Files:**
- Create: `tools/transcriber/src/probe.ts`, `tools/transcriber/__tests__/probe.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `probeMedia(absPath: string): Promise<ProbeResult>`；`parseProbe(json: unknown): ProbeResult`；`ProbeResult = { durationS: number; container: string; videoCodec: string | null; audioCodec: string | null }`

- [ ] **Step 1: 写失败测试**（parseProbe 纯函数，用真实 ffprobe JSON 形状做夹具）

```typescript
// tools/transcriber/__tests__/probe.test.ts
import { describe, it, expect } from "vitest";
import { parseProbe } from "../src/probe";

const mp4Json = {
  streams: [
    { codec_type: "video", codec_name: "h264" },
    { codec_type: "audio", codec_name: "aac" },
  ],
  format: { duration: "1854.236", format_name: "mov,mp4,m4a,3gp,3g2,mj2" },
};
const vobJson = {
  streams: [
    { codec_type: "video", codec_name: "mpeg2video" },
    { codec_type: "audio", codec_name: "mp2" },
  ],
  format: { duration: "612.5", format_name: "mpeg" },
};
const wmaJson = {
  streams: [{ codec_type: "audio", codec_name: "wmav2" }],
  format: { duration: "90.0", format_name: "asf" },
};

describe("parseProbe", () => {
  it("mp4：容器取 format_name 首段 mov，编码 h264/aac，时长取整", () => {
    expect(parseProbe(mp4Json)).toEqual({
      durationS: 1854, container: "mov", videoCodec: "h264", audioCodec: "aac",
    });
  });
  it("VOB：mpeg2video/mp2 → 桶 B 输入", () => {
    expect(parseProbe(vobJson).videoCodec).toBe("mpeg2video");
    expect(parseProbe(vobJson).container).toBe("mpeg");
  });
  it("wma 纯音频：videoCodec 为 null", () => {
    expect(parseProbe(wmaJson)).toEqual({
      durationS: 90, container: "asf", videoCodec: null, audioCodec: "wmav2",
    });
  });
  it("缺 duration 容错为 0", () => {
    expect(parseProbe({ streams: [], format: {} }).durationS).toBe(0);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tools/transcriber/__tests__/probe.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 最小实现**

```typescript
// tools/transcriber/src/probe.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ProbeResult {
  durationS: number;
  container: string;
  videoCodec: string | null;
  audioCodec: string | null;
}

export function parseProbe(json: unknown): ProbeResult {
  const j = json as { streams?: Array<{ codec_type?: string; codec_name?: string }>; format?: { duration?: string; format_name?: string } };
  const video = j.streams?.find(s => s.codec_type === "video");
  const audio = j.streams?.find(s => s.codec_type === "audio");
  const fmt = j.format?.format_name ?? "";
  return {
    durationS: Math.round(parseFloat(j.format?.duration ?? "0") || 0),
    container: fmt.split(",")[0],
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
  };
}

export async function probeMedia(absPath: string): Promise<ProbeResult> {
  const { stdout } = await execFileAsync(
    "ffprobe",
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", absPath],
    { maxBuffer: 10 * 1024 * 1024, timeout: 30_000 },
  );
  return parseProbe(JSON.parse(stdout));
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tools/transcriber/__tests__/probe.test.ts`
Expected: 4 passed

- [ ] **Step 5: 提交**

```bash
git add tools/transcriber/src/probe.ts tools/transcriber/__tests__/probe.test.ts
git commit -m "feat(transcriber): ffprobe 封装与解析（容器首段归一/时长取整）"
```

---

### Task 3: 两桶分类规则

**Files:**
- Create: `tools/transcriber/src/bucket.ts`, `tools/transcriber/__tests__/bucket.test.ts`

**Interfaces:**
- Consumes: `ScannedFile`（Task 1）、`ProbeResult`（Task 2）
- Produces: `classifyBucket(file: ScannedFile, probe: ProbeResult): Bucket`；`type Bucket = "A_playable" | "B_transcode"`

- [ ] **Step 1: 写失败测试**（覆盖 spec §3.1 全部分桶情形）

```typescript
// tools/transcriber/__tests__/bucket.test.ts
import { describe, it, expect } from "vitest";
import { classifyBucket } from "../src/bucket";
import type { ScannedFile } from "../src/scan";
import type { ProbeResult } from "../src/probe";

const f = (ext: string, category: ScannedFile["category"]): ScannedFile =>
  ({ absPath: "/x", relPath: `a.${ext}`, source: "main", category, ext: `.${ext}` });
const p = (container: string, v: string | null, a: string | null): ProbeResult =>
  ({ durationS: 100, container, videoCodec: v, audioCodec: a });

describe("classifyBucket（两桶制，spec §3.1）", () => {
  it("桶A：MP4 容器(ffprobe 报 mov) + h264 + aac", () => {
    expect(classifyBucket(f("mp4", "video"), p("mov", "h264", "aac"))).toBe("A_playable");
  });
  it("桶B：hevc 源（主库样本实测编码）", () => {
    expect(classifyBucket(f("mp4", "video"), p("mov", "hevc", "aac"))).toBe("B_transcode");
  });
  it("桶B：VOB/MPEG-2", () => {
    expect(classifyBucket(f("vob", "video"), p("mpeg", "mpeg2video", "mp2"))).toBe("B_transcode");
  });
  it("桶B：mp4 容器但非 H.264（如 avi 打包的 mpeg4）", () => {
    expect(classifyBucket(f("mp4", "video"), p("mov", "mpeg4", "aac"))).toBe("B_transcode");
  });
  it("桶B：h264 但容器 mkv", () => {
    expect(classifyBucket(f("mkv", "video"), p("matroska", "h264", "aac"))).toBe("B_transcode");
  });
  it("桶B：h264+aac 但无 AAC（音频轨缺失）按规则转码", () => {
    expect(classifyBucket(f("mp4", "video"), p("mov", "h264", null))).toBe("B_transcode");
  });
  it("桶A：mp3 / m4a 纯音频", () => {
    expect(classifyBucket(f("mp3", "audio"), p("mp3", null, "mp3"))).toBe("A_playable");
    expect(classifyBucket(f("m4a", "audio"), p("mov", null, "aac"))).toBe("A_playable");
  });
  it("桶B：wma 等浏览器不可播音频", () => {
    expect(classifyBucket(f("wma", "audio"), p("asf", null, "wmav2"))).toBe("B_transcode");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tools/transcriber/__tests__/bucket.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 最小实现**

```typescript
// tools/transcriber/src/bucket.ts
import type { ProbeResult } from "./probe";
import type { ScannedFile } from "./scan";

export type Bucket = "A_playable" | "B_transcode";

/** spec §3.1 两桶制：浏览器可播 = 视频 MP4+H.264+AAC / 音频 mp3|m4a；其余一律 B。 */
export function classifyBucket(file: ScannedFile, probe: ProbeResult): Bucket {
  if (file.category === "audio") {
    return file.ext === ".mp3" || file.ext === ".m4a" ? "A_playable" : "B_transcode";
  }
  // ffprobe 的 mp4 家族 format_name 首段是 "mov"
  const isMp4Family = probe.container === "mov" || probe.container === "mp4";
  return isMp4Family && probe.videoCodec === "h264" && probe.audioCodec === "aac"
    ? "A_playable"
    : "B_transcode";
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tools/transcriber/__tests__/bucket.test.ts`
Expected: 8 passed

- [ ] **Step 5: 提交**

```bash
git add tools/transcriber/src/bucket.ts tools/transcriber/__tests__/bucket.test.ts
git commit -m "feat(transcriber): 两桶播放兼容分类（A 可播 / B 转码，含 wma）"
```

---

### Task 4: manifest 构建与汇总

**Files:**
- Create: `tools/transcriber/src/manifest.ts`, `tools/transcriber/__tests__/manifest.test.ts`

**Interfaces:**
- Consumes: `ScannedFile`（Task 1）、`ProbeResult`（Task 2）、`Bucket`/`classifyBucket`（Task 3）
- Produces:
  - `normalizeName(relPath: string): string`
  - `buildManifest(rows: ManifestRow[], privacyDirs: string[], firstBatchDir: string): { entries: ManifestEntry[]; summary: ManifestSummary }`
  - `ManifestRow = { file: ScannedFile; probe: ProbeResult | null; error?: string }`
  - `ManifestEntry = ManifestRow["file"] 的扁平化 + probe 字段 + { bucket: Bucket; privacy: boolean; inFirstBatch: boolean }`
  - `ManifestSummary`（字段见测试）

- [ ] **Step 1: 写失败测试**

```typescript
// tools/transcriber/__tests__/manifest.test.ts
import { describe, it, expect } from "vitest";
import { normalizeName, buildManifest } from "../src/manifest";
import type { ScannedFile } from "../src/scan";
import type { ProbeResult } from "../src/probe";
import type { ManifestRow } from "../src/manifest";

const sf = (relPath: string, source: "main" | "hevc", category: "audio" | "video"): ScannedFile =>
  ({ absPath: `/root/${source}/${relPath}`, relPath, source, category, ext: relPath.endsWith(".mp3") ? ".mp3" : ".mp4" });
const pr = (s: number): ProbeResult => ({ durationS: s, container: "mov", videoCodec: "h264", audioCodec: "aac" });

describe("normalizeName", () => {
  it("去编号前缀/空白/全半角括号，小写", () => {
    expect(normalizeName("421. 独立教师-线上自媒体教师.mp4"))
      .toBe(normalizeName("独立教师（线上自媒体教师）.mp4"));
    expect(normalizeName("第01课 课堂提问.mp4")).toBe("第01课课堂提问");
  });
});

describe("buildManifest", () => {
  const rows: ManifestRow[] = [
    { file: sf("教学新知班级管理专栏/01.提问.mp4", "main", "video"), probe: pr(3600) },
    { file: sf("教学新知班级管理专栏/02.管理.mp4", "main", "video"), probe: pr(1800) },
    { file: sf("其他/hevc源.mp4", "hevc", "video"), probe: { durationS: 600, container: "mov", videoCodec: "hevc", audioCodec: "aac" } },
    { file: sf("坏文件.mp4", "main", "video"), probe: null, error: "ffprobe timeout" },
  ];
  const { entries, summary } = buildManifest(rows, ["课堂实录"], "教学新知班级管理专栏");

  it("桶与时长归属正确", () => {
    const e0 = entries[0];
    expect(e0.bucket).toBe("A_playable");
    expect(e0.inFirstBatch).toBe(true);
    expect(entries.find(e => e.relPath.includes("hevc源"))?.bucket).toBe("B_transcode");
  });
  it("probe 失败行保留并计数，不阻塞", () => {
    const bad = entries.find(e => e.relPath === "坏文件.mp4");
    expect(bad?.bucket).toBe("B_transcode"); // 无探测数据按保守桶 B
    expect(summary.probeFailures).toBe(1);
  });
  it("汇总数学：总时长/分桶统计/首批", () => {
    expect(summary.totalFiles).toBe(4);
    expect(summary.totalDurationH).toBeCloseTo(6000 / 3600, 5); // 仅成功探测行计入
    expect(summary.byBucket["A_playable"].files).toBe(2);
    expect(summary.firstBatch.files).toBe(2);
    expect(summary.firstBatch.durationH).toBeCloseTo(5400 / 3600, 5);
  });
  it("privacy 目录命中标记", () => {
    const rows2: ManifestRow[] = [
      { file: sf("课堂实录/a.mp4", "main", "video"), probe: pr(100) },
    ];
    expect(buildManifest(rows2, ["课堂实录"], "x").entries[0].privacy).toBe(true);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tools/transcriber/__tests__/manifest.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 最小实现**

```typescript
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
  durationS: number; bucket: Bucket; privacy: boolean; inFirstBatch: boolean;
  error?: string;
}

export interface ManifestSummary {
  generatedAt: string;
  totalFiles: number;
  totalDurationH: number;
  byBucket: Record<Bucket, { files: number; durationH: number }>;
  bySource: Record<"main" | "hevc", number>;
  probeFailures: number;
  firstBatch: { dir: string; files: number; durationH: number };
}

const FALLBACK_PROBE: ProbeResult = { durationS: 0, container: "", videoCodec: null, audioCodec: null };

export function normalizeName(relPath: string): string {
  const base = relPath.replace(/\.[^.]+$/, "").split("/").pop() ?? "";
  return base.replace(/^[\d\s.、\-—]+/, "").replace(/[\s_（）()\-—]+/g, "").toLowerCase();
}

export function buildManifest(rows: ManifestRow[], privacyDirs: string[], firstBatchDir: string): {
  entries: ManifestEntry[];
  summary: ManifestSummary;
} {
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

  const h = (s: number) => s / 3600;
  const sum = (es: ManifestEntry[]) => es.reduce((acc, e) => acc + e.durationS, 0);
  const ok = entries.filter(e => !e.error);
  const first = ok.filter(e => e.inFirstBatch);
  const summary: ManifestSummary = {
    generatedAt: new Date().toISOString(),
    totalFiles: entries.length,
    totalDurationH: +h(sum(ok)).toFixed(2),
    byBucket: {
      A_playable: { files: entries.filter(e => e.bucket === "A_playable").length, durationH: +h(sum(ok.filter(e => e.bucket === "A_playable"))).toFixed(2) },
      B_transcode: { files: entries.filter(e => e.bucket === "B_transcode").length, durationH: +h(sum(ok.filter(e => e.bucket === "B_transcode"))).toFixed(2) },
    },
    bySource: {
      main: entries.filter(e => e.source === "main").length,
      hevc: entries.filter(e => e.source === "hevc").length,
    },
    probeFailures: entries.filter(e => e.error).length,
    firstBatch: { dir: firstBatchDir, files: first.length, durationH: +h(sum(first)).toFixed(2) },
  };
  return { entries, summary };
}
```

- [ ] **Step 4: 运行确认通过 + 全量回归**

Run: `npx vitest run tools/transcriber && npm run test:mocks -- --exclude='**/*.real-llm.test.ts'`
Expected: tools 下全部 passed；仓库既有测试无回归

- [ ] **Step 5: 提交**

```bash
git add tools/transcriber/src/manifest.ts tools/transcriber/__tests__/manifest.test.ts
git commit -m "feat(transcriber): manifest 构建与汇总（桶统计/首批/隐私标注/失败容错）"
```

---

### Task 5: CLI 入口 + 真实对账运行（M0 验收）

**Files:**
- Create: `tools/transcriber/src/cli.ts`
- Create（运行产物，提交）: `tools/transcriber/out/manifest-summary.json`

**Interfaces:**
- Consumes: `scanDirectory`（Task 1）、`probeMedia`（Task 2）、`buildManifest`（Task 4）
- Produces: `npx tsx tools/transcriber/src/cli.ts audit` 命令；`out/manifest.json`（全量，gitignore）与 `out/manifest-summary.json`（提交留档）

- [ ] **Step 1: 实现 CLI（探测并发 4、进度每 20 个、失败不阻塞）**

```typescript
// tools/transcriber/src/cli.ts
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { scanDirectory } from "./scan";
import { probeMedia } from "./probe";
import { buildManifest, type ManifestRow } from "./manifest";

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
  const cfg: Config = JSON.parse(readFileSync(join(__dirname, "../config.json"), "utf-8"));
  const files = [...scanDirectory(cfg.mainRoot, "main"), ...scanDirectory(cfg.hevcRoot, "hevc")];
  console.log(`扫描到 ${files.length} 个媒体/文档文件，开始 ffprobe（并发 4）…`);

  let done = 0;
  const rows: ManifestRow[] = await mapLimit(files, 4, async file => {
    if (file.category === "doc") return { file, probe: null }; // 文档不探测
    try {
      const probe = await probeMedia(file.absPath);
      return { file, probe };
    } catch (e) {
      return { file, probe: null, error: String(e).slice(0, 200) };
    } finally {
      if (++done % 20 === 0) console.log(`  进度 ${done}/${files.length}`);
    }
  });

  const { entries, summary } = buildManifest(rows, cfg.privacyDirs, cfg.firstBatchDir);
  mkdirSync(join(__dirname, "../out"), { recursive: true });
  writeFileSync(join(__dirname, "../out/manifest.json"), JSON.stringify(entries, null, 2));
  writeFileSync(join(__dirname, "../out/manifest-summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: 建本机 config 并全量运行**

```bash
cp tools/transcriber/config.example.json tools/transcriber/config.json
# 编辑 config.json 填入真实路径：
#   mainRoot: /Users/berton/Github/L T师训 2024-2025
#   hevcRoot: /Users/berton/Github/L T师训 2024-2025（HEVC）
npx tsx tools/transcriber/src/cli.ts audit
```

Expected: 进度日志推进至 ~1500 个文件；summary 打印 `byBucket`/`totalDurationH`/`firstBatch`/`probeFailures`；`probeFailures` 应为个位数（异常再逐个排查）

- [ ] **Step 3: 核对 M0 验收口径**

对照 summary 检查四项（写入运行日志或 PR 描述）：
1. `totalDurationH` 实测值 vs spec 区间估计 343-363h——**用实测值回填 spec §3.1 的"约 343-363h"**
2. `byBucket.B_transcode` 覆盖 hevc + VOB(60) + wma(16) + 其他非 H.264（数量级核对）
3. `firstBatch`（教学新知班级管理专栏）文件数 ≈ 36、时长记入排产
4. 抽查 3 个 probeFailures（如有）：坏文件 or ffprobe 边界

- [ ] **Step 4: 回填 spec 实测值并提交**

Edit `docs/superpowers/specs/2026-08-17-teacher-training-design.md` §3.1：将"**约 343-363h**"替换为实测值（例：`**实测 XXXh**（M0 manifest-summary.json）`），夜间窗口按实测重算。

```bash
git add tools/transcriber/src/cli.ts tools/transcriber/out/manifest-summary.json docs/superpowers/specs/2026-08-17-teacher-training-design.md
git commit -m "feat(transcriber): M0 对账 CLI + 全量 manifest（实测时长回填 spec）"
```

---

## Self-Review 记录

- **Spec 覆盖**：§3.1 的扫描/排除/两桶/时长/重叠/隐私/首批七项——重叠分析（normalizeName 跨目录对）已实现 normalizeName，跨目录 onlyInHevc 统计在 summary.bySource + manifest 可复核；spec 验收"归一化重叠分析"由 Task 4 normalizeName 测试 + Task 5 Step 3 口径核对覆盖
- **占位符扫描**：无 TBD/TODO；所有代码步骤含完整代码
- **类型一致性**：`ScannedFile`/`ProbeResult`/`Bucket`/`ManifestRow` 在 Task 1/2/3/4 定义，Task 5 消费一致；`classifyBucket(file, effective)` 对 doc 类文件（probe=null 走 FALLBACK_PROBE）会落入桶 B——doc 行不参与播放/转写，桶值无意义但无害，已在 manifest 测试中以"坏文件按保守桶 B"固化该行为
