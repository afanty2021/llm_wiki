# LT 师训系统 M0 内容对账 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 产出 LT 师训两目录的权威媒体 manifest（桶分类/时长/跨目录重叠/首批排产），作为 M1 转写批产的输入。

**Architecture:** 独立 Node CLI（`tools/transcriber/`，TypeScript），扫描 → ffprobe → 分桶 → 汇总四段管线；全量探测结果落 `out/manifest.json`（gitignore），汇总落 `out/manifest-summary.json`（提交留档）。

**Tech Stack:** TypeScript + vitest（复用仓库根配置，`npm run test:mocks` 自动拾取）+ tsx（**入 devDependencies**）运行 CLI + 系统 ffprobe。

**Spec:** `docs/superpowers/specs/2026-08-17-teacher-training-design.md`（v5，§3.1；本计划随 v2 修订同步修正 spec 事实口径）

## Global Constraints

- **工作分支**：`feat/m0-content-audit`；每个 Commit 步骤执行前，若当前执行模式要求用户批准，则等待批准后再提交
- 扫描**两个**目录：主库与 `（HEVC）` 目录（含仅存于 HEVC 的约 440-462 个文件，评审实测精确同名仅 3 对）
- 排除 `__MACOSX` 目录与 `._` 前缀资源叉（无条件排除，不计入 ignored）；**未登记扩展名的常规文件不静默丢弃**，计入 `summary.ignoredFiles`
- 分桶两桶制：桶 A「浏览器可播」= 视频 **扩展名 .mp4/.m4v 且 MP4 家族容器 + H.264 + AAC**、音频 mp3/m4a；**其余全部桶 B**（hevc、VOB/MPEG-2、mkv/avi/flv/wmv 非 H.264、wma、**.mov 一律 B**——ffprobe 的 mov demuxer 名无法区分 QuickTime，按扩展名兜底转码）
- **doc 类（pdf/pptx/docx/md）不参与桶统计**：单独 `docFiles` 计数，`bucket` 为 null
- **桶统计口径统一**：`byBucket` 只统计成功探测（无 error）的音视频行；error 行只进 `probeFailures`
- **精度口径**：summary 中小时数值一律 `round(v, 2)`；测试断言用精确值（`toBe`），不用 `toBeCloseTo`
- ffprobe 容器归一化：`format_name` 取首段（mp4 文件为 `"mov,mp4,..."` → `mov`）
- 不修改 `src/`、`src-tauri/`、`src-server/` 任何现有代码（M0 纯新增）
- 单文件 ffprobe 30s 超时；失败记录不阻塞整体
- 机器相关的绝对路径只进 `config.json`（gitignore），提交 `config.example.json`
- **ESM 约束**：仓库根 `"type": "module"`，禁用 `__dirname`，路径一律 `fileURLToPath(new URL(".", import.meta.url))`（仓库 tools/ 既有脚本惯例）

## File Structure

```
tools/transcriber/
  config.json               # 本机路径配置（gitignore）
  config.example.json       # 提交的模板
  tsconfig.json             # 独立 tsconfig（typecheck 用）
  src/
    scan.ts                 # 目录遍历 + 扩展名分类 + ignored 计数
    probe.ts                # ffprobe 封装 + JSON 解析（parseProbe 纯函数）
    bucket.ts               # 两桶分类纯函数（doc 返回 null）
    manifest.ts             # 归一化配对/汇总/manifest 构建（纯函数）
    cli.ts                  # audit 子命令：串起全流程并落盘
  __tests__/
    scan.test.ts
    probe.test.ts
    bucket.test.ts
    manifest.test.ts
  out/                      # manifest.json（gitignore）+ manifest-summary.json（提交留档）
```

---

### Task 1: 脚手架 + 目录扫描器

**Files:**
- Create: `tools/transcriber/tsconfig.json`, `tools/transcriber/config.example.json`, `tools/transcriber/src/scan.ts`, `tools/transcriber/__tests__/scan.test.ts`
- Modify: `package.json`（devDependencies 加 tsx）、`.gitignore`（追加两行）

**Interfaces:**
- Consumes: 无（首个任务）
- Produces: `scanDirectory(root: string, source: "main" | "hevc"): { files: ScannedFile[]; ignored: number }`；`ScannedFile = { absPath: string; relPath: string; source: "main"|"hevc"; category: "audio"|"video"|"doc"; ext: string }`；常量 `AUDIO_EXTS`/`VIDEO_EXTS`/`DOC_EXTS`

- [ ] **Step 1: 安装 tsx 并写失败测试**

```bash
npm i -D tsx
```

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
    const { files } = scanDirectory(root, "main");
    const mp4 = files.find(f => f.relPath === "专栏A/01.课程.mp4");
    expect(mp4).toMatchObject({ category: "video", ext: ".mp4", source: "main" });
    expect(files.find(f => f.relPath === "b.mp3")?.category).toBe("audio");
    expect(files.find(f => f.relPath === "c.pdf")?.category).toBe("doc");
  });

  it("排除 __MACOSX、隐藏文件与 ._ 资源叉（不计入 ignored）", () => {
    mkdirSync(join(root, "__MACOSX", "sub"), { recursive: true });
    writeFileSync(join(root, "__MACOSX", "sub", "junk.mp4"), "x");
    writeFileSync(join(root, "._hidden.mp4"), "x");
    writeFileSync(join(root, ".DS_Store"), "x");
    const { files, ignored } = scanDirectory(root, "main");
    expect(files.some(f => f.relPath.includes("__MACOSX"))).toBe(false);
    expect(files.some(f => f.relPath.startsWith("._"))).toBe(false);
    expect(ignored).toBe(0);
  });

  it("未登记扩展名计入 ignored，不静默丢弃", () => {
    writeFileSync(join(root, "note.txt"), "x");
    writeFileSync(join(root, "cover.jpg"), "x");
    const { files, ignored } = scanDirectory(root, "main");
    expect(files.some(f => f.relPath === "note.txt")).toBe(false);
    expect(ignored).toBe(2);
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

export function scanDirectory(root: string, source: "main" | "hevc"): { files: ScannedFile[]; ignored: number } {
  const files: ScannedFile[] = [];
  let ignored = 0;
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
      if (!category) { ignored++; continue; }
      files.push({ absPath: full, relPath: full.slice(root.length + 1), source, category, ext });
    }
  };
  walk(root);
  return { files, ignored };
}
```

```json
// tools/transcriber/tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022", "module": "ESNext", "moduleResolution": "bundler",
    "strict": true, "noEmit": true, "skipLibCheck": true,
    "types": ["node"]
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

- [ ] **Step 5: gitignore 与提交**（分支 `feat/m0-content-audit`；需用户批准的执行模式下先等批准）

`.gitignore` 追加：

```
tools/transcriber/config.json
tools/transcriber/out/manifest.json
```

```bash
git add tools/transcriber package.json package-lock.json .gitignore
git commit -m "feat(transcriber): M0 目录扫描器——扩展名分类/垃圾排除/ignored 计数"
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
- Produces: `classifyBucket(file: ScannedFile, probe: ProbeResult): Bucket | null`（doc 返回 null）；`type Bucket = "A_playable" | "B_transcode"`

- [ ] **Step 1: 写失败测试**（覆盖 spec §3.1 分桶情形 + .mov 扩展名兜底）

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
  it("桶A：.mp4 扩展名 + MP4 家族容器(ffprobe 报 mov) + h264 + aac", () => {
    expect(classifyBucket(f("mp4", "video"), p("mov", "h264", "aac"))).toBe("A_playable");
  });
  it("桶A：.m4v 同样直用", () => {
    expect(classifyBucket(f("m4v", "video"), p("mov", "h264", "aac"))).toBe("A_playable");
  });
  it("桶B：.mov 扩展名兜底——即使 h264+aac 也转码（mov demuxer 名无法区分 QuickTime）", () => {
    expect(classifyBucket(f("mov", "video"), p("mov", "h264", "aac"))).toBe("B_transcode");
  });
  it("桶B：hevc 源（主库样本实测编码）", () => {
    expect(classifyBucket(f("mp4", "video"), p("mov", "hevc", "aac"))).toBe("B_transcode");
  });
  it("桶B：VOB/MPEG-2", () => {
    expect(classifyBucket(f("vob", "video"), p("mpeg", "mpeg2video", "mp2"))).toBe("B_transcode");
  });
  it("桶B：mp4 容器但非 H.264", () => {
    expect(classifyBucket(f("mp4", "video"), p("mov", "mpeg4", "aac"))).toBe("B_transcode");
  });
  it("桶B：h264 但容器 mkv", () => {
    expect(classifyBucket(f("mkv", "video"), p("matroska", "h264", "aac"))).toBe("B_transcode");
  });
  it("桶B：音频轨缺失（无 AAC）", () => {
    expect(classifyBucket(f("mp4", "video"), p("mov", "h264", null))).toBe("B_transcode");
  });
  it("桶A：mp3 / m4a 纯音频", () => {
    expect(classifyBucket(f("mp3", "audio"), p("mp3", null, "mp3"))).toBe("A_playable");
    expect(classifyBucket(f("m4a", "audio"), p("mov", null, "aac"))).toBe("A_playable");
  });
  it("桶B：wma 等浏览器不可播音频", () => {
    expect(classifyBucket(f("wma", "audio"), p("asf", null, "wmav2"))).toBe("B_transcode");
  });
  it("doc 类返回 null（不参与桶统计）", () => {
    expect(classifyBucket(f("pdf", "doc"), p("", null, null))).toBeNull();
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

/**
 * spec §3.1 两桶制：浏览器可播 = 视频 (.mp4|.m4v 且 MP4 家族容器 + H.264 + AAC) / 音频 mp3|m4a。
 * 其余一律 B。.mov 按扩展名兜底进 B（ffprobe 的 mov demuxer 名无法区分 QuickTime）。
 * doc 类返回 null，由 manifest 层单独计数，不参与桶统计。
 */
export function classifyBucket(file: ScannedFile, probe: ProbeResult): Bucket | null {
  if (file.category === "doc") return null;
  if (file.category === "audio") {
    return file.ext === ".mp3" || file.ext === ".m4a" ? "A_playable" : "B_transcode";
  }
  if (file.ext !== ".mp4" && file.ext !== ".m4v") return "B_transcode";
  // ffprobe 的 mp4 家族 format_name 首段是 "mov"
  const isMp4Family = probe.container === "mov" || probe.container === "mp4";
  return isMp4Family && probe.videoCodec === "h264" && probe.audioCodec === "aac"
    ? "A_playable"
    : "B_transcode";
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tools/transcriber/__tests__/bucket.test.ts`
Expected: 11 passed

- [ ] **Step 5: 提交**

```bash
git add tools/transcriber/src/bucket.ts tools/transcriber/__tests__/bucket.test.ts
git commit -m "feat(transcriber): 两桶分类（.mov 扩展名兜底/doc 出桶）"
```

---

### Task 4: manifest 构建、跨目录重叠与汇总

**Files:**
- Create: `tools/transcriber/src/manifest.ts`, `tools/transcriber/__tests__/manifest.test.ts`

**Interfaces:**
- Consumes: `ScannedFile`（Task 1）、`ProbeResult`（Task 2）、`Bucket`/`classifyBucket`（Task 3）
- Produces:
  - `normalizeName(relPath: string): string`
  - `buildManifest(rows: ManifestRow[], privacyDirs: string[], firstBatchDir: string, ignoredFiles = 0): { entries: ManifestEntry[]; summary: ManifestSummary }`
  - `ManifestRow = { file: ScannedFile; probe: ProbeResult | null; error?: string }`
  - `ManifestEntry`（见实现）+ `ManifestSummary`（见实现；含 `overlap`、`docFiles`、`ignoredFiles`、`firstBatch.bySource`）
  - **精度口径**：summary 中小时值一律 `Math.round(v * 100) / 100`，测试断言精确值

- [ ] **Step 1: 写失败测试**

```typescript
// tools/transcriber/__tests__/manifest.test.ts
import { describe, it, expect } from "vitest";
import { normalizeName, buildManifest } from "../src/manifest";
import type { ScannedFile } from "../src/scan";
import type { ProbeResult } from "../src/probe";
import type { ManifestRow } from "../src/manifest";

const sf = (relPath: string, source: "main" | "hevc", category: "audio" | "video" | "doc"): ScannedFile =>
  ({ absPath: `/root/${source}/${relPath}`, relPath, source, category,
     ext: relPath.endsWith(".mp3") ? ".mp3" : relPath.endsWith(".pdf") ? ".pdf" : ".mp4" });
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
    { file: sf("会员资料/guide.pdf", "main", "doc"), probe: null },
  ];
  const { entries, summary } = buildManifest(rows, ["课堂实录"], "教学新知班级管理专栏", 7);

  it("桶归属正确；doc 行 bucket 为 null 不进桶统计", () => {
    expect(entries[0].bucket).toBe("A_playable");
    expect(entries[0].inFirstBatch).toBe(true);
    expect(entries.find(e => e.relPath.includes("hevc源"))?.bucket).toBe("B_transcode");
    expect(entries.find(e => e.relPath.endsWith("guide.pdf"))?.bucket).toBeNull();
    expect(summary.docFiles).toBe(1);
  });

  it("桶统计只含成功探测的音视频行（error 行仅进 probeFailures）", () => {
    // ok 音视频 = 3600 + 1800 + 600 = 6000s；坏文件不进 byBucket
    expect(summary.byBucket["A_playable"]).toEqual({ files: 2, durationH: 1.5 });
    expect(summary.byBucket["B_transcode"]).toEqual({ files: 1, durationH: 0.17 });
    expect(summary.probeFailures).toBe(1);
    expect(summary.totalFiles).toBe(5);
    expect(summary.totalDurationH).toBe(1.67); // 6000/3600 → round 2 位
    expect(summary.ignoredFiles).toBe(7);
  });

  it("firstBatch 按来源拆分（该专栏主体在 HEVC 的实测形态）", () => {
    expect(summary.firstBatch).toEqual({
      dir: "教学新知班级管理专栏", files: 2, durationH: 1.5,
      bySource: { main: 2, hevc: 0 },
    });
  });

  it("跨目录归一化重叠：matched/mainOnly/hevcOnly", () => {
    expect(summary.overlap).toEqual({ matchedPairs: 0, mainOnly: 3, hevcOnly: 1 });
    // main 归一名：提问/管理/坏文件（doc 不参与重叠）→ 3 个 mainOnly；hevc：hevc源 → 1 个 hevcOnly
  });

  it("privacy 目录命中标记", () => {
    const rows2: ManifestRow[] = [
      { file: sf("课堂实录/a.mp4", "main", "video"), probe: pr(100) },
    ];
    expect(buildManifest(rows2, ["课堂实录"], "x").entries[0].privacy).toBe(true);
  });

  it("重叠配对：归一化同名跨目录计 1 对", () => {
    const rows3: ManifestRow[] = [
      { file: sf("专栏/421. 独立教师-线上自媒体教师.mp4", "main", "video"), probe: pr(100) },
      { file: sf("专栏/独立教师（线上自媒体教师）.mp4", "hevc", "video"), probe: pr(100) },
    ];
    expect(buildManifest(rows3, [], "x").summary.overlap).toEqual({ matchedPairs: 1, mainOnly: 0, hevcOnly: 0 });
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
```

- [ ] **Step 4: 运行确认通过 + 全量回归**

Run: `npx vitest run tools/transcriber && npm run test:mocks`
Expected: tools 下全部 passed（精度断言用 toBe 精确值）；仓库既有测试无回归

- [ ] **Step 5: 提交**

```bash
git add tools/transcriber/src/manifest.ts tools/transcriber/__tests__/manifest.test.ts
git commit -m "feat(transcriber): manifest 构建——跨目录归一化重叠/桶口径统一/首批按源拆分"
```

---

### Task 5: CLI 入口 + 真实对账运行（M0 验收）

**Files:**
- Create: `tools/transcriber/src/cli.ts`
- Create（运行产物，提交）: `tools/transcriber/out/manifest-summary.json`

**Interfaces:**
- Consumes: `scanDirectory`（Task 1，返回 `{files, ignored}`）、`probeMedia`（Task 2）、`buildManifest`（Task 4，含 `ignoredFiles` 参数）
- Produces: `npx tsx tools/transcriber/src/cli.ts audit` 命令；`out/manifest.json`（全量，gitignore）与 `out/manifest-summary.json`（提交留档）

- [ ] **Step 1: 实现 CLI（ESM 路径、并发 4、进度每 20 个、失败不阻塞）**

```typescript
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
```

- [ ] **Step 2: 建本机 config 并全量运行**

```bash
cp tools/transcriber/config.example.json tools/transcriber/config.json
# 编辑 config.json 填入真实路径：
#   mainRoot: /Users/berton/Github/L T师训 2024-2025
#   hevcRoot: /Users/berton/Github/L T师训 2024-2025（HEVC）
npx tsx tools/transcriber/src/cli.ts audit
```

Expected: 注册口径总文件数 **约 1850**（媒体 ~1500 + 文档 ~351）+ ignored 数十个；进度日志推进；summary 打印 `byBucket`/`totalDurationH`/`overlap`/`firstBatch`/`probeFailures`；`probeFailures` 应为个位数

- [ ] **Step 3: 核对 M0 验收口径（五项，写入运行日志或 PR 描述）**

1. `totalDurationH` 实测值 vs spec 区间估计 343-363h——**用实测值回填 spec §3.1**
2. `byBucket.B_transcode` 数量级：hevc 源（约 440-460）+ VOB(60) + wma(16) + .mov(9) + 其他非 H.264；**不含文档**（docFiles 单列）
3. `firstBatch.bySource`：预期 HEVC 侧 44 个 mp4 为主、main 侧同目录仅 4 个无扩展名文件（落 ignoredFiles）——排产以 HEVC 侧为准
4. `overlap`：matchedPairs 应接近评审实测的精确同名 3 对（归一化后略高）；`hevcOnly` 约 460 上下——这是 M4 全量排产的独有内容基数
5. 抽查 `probeFailures`（如有）：逐个看 error 字段，坏文件 or ffprobe 边界

- [ ] **Step 4: 回填 spec 实测值并提交**

Edit `docs/superpowers/specs/2026-08-17-teacher-training-design.md` §3.1：将"**约 343-363h**"替换为实测值（例：`**实测 XXXh**（M0 manifest-summary.json）`），夜间窗口按实测重算；`overlap` 与 `firstBatch.bySource` 实测值一并回填。

```bash
git add tools/transcriber/src/cli.ts tools/transcriber/out/manifest-summary.json docs/superpowers/specs/2026-08-17-teacher-training-design.md
git commit -m "feat(transcriber): M0 对账 CLI + 全量 manifest（实测时长/重叠/首批回填 spec）"
```

---

## Self-Review 记录（v2）

- **上轮计划评审 4 项阻断全修**：① cli.ts 改 `fileURLToPath(new URL(".", import.meta.url))`（ESM，仓库 tools/ 惯例），tsx 入 devDependencies；② 重叠分析真做——`normalizeName` 进 `buildManifest`，summary.overlap 三字段 + Step 3 第 4 项核对 + 专项测试；③ 精度口径声明（round 2 + toBe 精确断言），消除 toFixed/toBeCloseTo 矛盾；④ doc 出桶统计（classifyBucket 返回 null、docFiles 单列、桶统计仅含成功探测音视频行）
- **应修 2 项**：firstBatch 按来源拆分（实测专栏主体在 HEVC，main 仅 4 个无扩展名文件）；ignoredFiles 计数 + Step 2 预期改 ~1850
- **过滤项**：.mov 扩展名兜底进 B + 测试；doc 提前 return 的进度计数上移；commit 步骤标注分支与批准提示
- **Spec 覆盖**：§3.1 七项（扫描/排除/两桶/时长/重叠/隐私/首批）全部有对应任务与验收核对项
- **类型一致性**：`scanDirectory` 返回值改为 `{files, ignored}` 后，Task 5 消费处已同步；`classifyBucket` 返回 `Bucket | null` 后 manifest 层 `bucket: Bucket | null` 一致
