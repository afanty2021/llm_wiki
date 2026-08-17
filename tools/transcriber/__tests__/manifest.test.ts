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
