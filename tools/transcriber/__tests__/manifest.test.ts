// tools/transcriber/__tests__/manifest.test.ts
import { describe, it, expect } from "vitest";
import { pairingKey, buildManifest } from "../src/manifest";
import type { ScannedFile } from "../src/scan";
import type { ProbeResult } from "../src/probe";
import type { ManifestRow } from "../src/manifest";

const sf = (relPath: string, source: "main" | "hevc", category: "audio" | "video" | "doc", ext?: string): ScannedFile =>
  ({ absPath: `/root/${source}/${relPath}`, relPath, source, category,
     ext: ext ?? (relPath.endsWith(".mp3") ? ".mp3" : relPath.endsWith(".pdf") ? ".pdf" : ".mp4") });
const pr = (s: number): ProbeResult => ({ durationS: s, container: "mov", videoCodec: "h264", audioCodec: "aac" });

describe("pairingKey（父目录一级 + 去编号前缀主干）", () => {
  it("父目录入键：同名 section 在不同 test 目录不是同一个键", () => {
    expect(pairingKey("剑桥1/test1/section1.mp3")).toBe("test1/section1");
    expect(pairingKey("剑桥1/test2/section1.mp3")).toBe("test2/section1");
    expect(pairingKey("剑桥1/test1/section1.mp3")).not.toBe(pairingKey("剑桥1/test2/section1.mp3"));
  });

  it("仅剥离开头编号前缀；分隔符（含下划线/句点/全半角括号）折叠；小写", () => {
    expect(pairingKey("专栏/01.课堂_提问.mp4")).toBe("专栏/课堂提问");
    expect(pairingKey("专栏/421. 独立教师-线上自媒体教师.mp4"))
      .toBe(pairingKey("专栏/独立教师（线上自媒体教师）.mp4"));
  });

  it("救援式无扩展名长文件名：句点不当扩展名剥离，编号前缀照剥", () => {
    expect(pairingKey("教学新知班级管理专栏/137. IBL-Inquiry based learning"))
      .toBe("教学新知班级管理专栏/iblinquirybasedlearning");
  });

  it("两段都归一化为空（如顶层纯编号名）→ null，排除出配对", () => {
    expect(pairingKey("3-1.mp3")).toBeNull();
    expect(pairingKey("10.mp4")).toBeNull();
  });

  it("有父目录时即使主干剥空也不为 null（目录仍可区分）", () => {
    expect(pairingKey("Unlock/1.mp4")).toBe("unlock/");
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
  const { entries, summary, overlapGroups } = buildManifest(rows, ["课堂实录"], "教学新知班级管理专栏", { total: 7, mediaRescued: 2 });

  it("桶归属正确；doc 行 bucket 为 null 不进桶统计", () => {
    expect(entries[0].bucket).toBe("A_playable");
    expect(entries[0].inFirstBatch).toBe(true);
    expect(entries.find(e => e.relPath.includes("hevc源"))?.bucket).toBe("B_transcode");
    expect(entries.find(e => e.relPath.endsWith("guide.pdf"))?.bucket).toBeNull();
    expect(summary.docFiles).toBe(1);
  });

  it("error 行 bucket 为 null（不再有保守兜底值），仅进 probeFailures", () => {
    const bad = entries.find(e => e.relPath === "坏文件.mp4")!;
    expect(bad.error).toBe("ffprobe timeout");
    expect(bad.bucket).toBeNull();
    expect(summary.probeFailures).toBe(1);
  });

  it("桶统计只含成功探测的音视频行", () => {
    // ok 音视频 = 3600 + 1800 + 600 = 6000s；坏文件（bucket null）不进 byBucket
    expect(summary.byBucket["A_playable"]).toEqual({ files: 2, durationH: 1.5 });
    expect(summary.byBucket["B_transcode"]).toEqual({ files: 1, durationH: 0.17 });
    expect(summary.totalFiles).toBe(5);
    expect(summary.totalDurationH).toBe(1.67); // 6000/3600 → round 2 位
  });

  it("bySource 含 doc/error 的文件数与非 doc 行时长；privacyFiles 计数；ignored = total - mediaRescued", () => {
    expect(summary.bySource.main).toEqual({ files: 4, durationH: 1.5 }); // 提问+管理+坏文件+guide.pdf；时长=3600+1800+0
    expect(summary.bySource.hevc).toEqual({ files: 1, durationH: 0.17 });
    expect(summary.privacyFiles).toBe(0);
    expect(summary.ignoredFiles).toBe(5); // 7 - 2
    expect(summary.elapsedS).toBe(0); // 由 CLI 覆写
  });

  it("firstBatch 按来源拆分（该专栏主体在 HEVC 的实测形态）", () => {
    expect(summary.firstBatch).toEqual({
      dir: "教学新知班级管理专栏", files: 2, durationH: 1.5,
      bySource: { main: 2, hevc: 0 },
    });
  });

  it("配对：matched/mainOnly/hevcOnly 按键计（空键与 doc 不参与）", () => {
    expect(summary.overlap).toEqual({ matchedPairs: 0, mainOnly: 3, hevcOnly: 1 });
    // main 键：教学新知班级管理专栏/提问、/管理、坏文件 → 3 个 mainOnly；hevc：其他/hevc源 → 1 个 hevcOnly
    expect(overlapGroups).toEqual([]);
  });

  it("privacy 目录命中标记", () => {
    const rows2: ManifestRow[] = [
      { file: sf("课堂实录/a.mp4", "main", "video"), probe: pr(100) },
    ];
    const r2 = buildManifest(rows2, ["课堂实录"], "x");
    expect(r2.entries[0].privacy).toBe(true);
    expect(r2.summary.privacyFiles).toBe(1);
  });

  it("重叠配对：归一化同名且时长兼容跨目录计 1 对", () => {
    const rows3: ManifestRow[] = [
      { file: sf("专栏/421. 独立教师-线上自媒体教师.mp4", "main", "video"), probe: pr(3600) },
      { file: sf("专栏/独立教师（线上自媒体教师）.mp4", "hevc", "video"), probe: pr(3605) },
    ];
    const r3 = buildManifest(rows3, [], "x");
    expect(r3.summary.overlap).toEqual({ matchedPairs: 1, mainOnly: 0, hevcOnly: 0 });
    expect(r3.overlapGroups).toEqual([
      { key: "专栏/独立教师线上自媒体教师", main: ["专栏/421. 独立教师-线上自媒体教师.mp4"], hevc: ["专栏/独立教师（线上自媒体教师）.mp4"] },
    ]);
  });

  it("时长不兼容（差值超 max(2, 1%) 容差）不算配对，overlap 标 duration_mismatch", () => {
    const rows4: ManifestRow[] = [
      { file: sf("专栏/01.提问.mp4", "main", "video"), probe: pr(3600) },
      { file: sf("专栏/提问.mp4", "hevc", "video"), probe: pr(60) }, // 差 3540s >> 36s 容差
    ];
    const r4 = buildManifest(rows4, [], "x");
    expect(r4.summary.overlap).toEqual({ matchedPairs: 0, mainOnly: 0, hevcOnly: 0 });
    expect(r4.overlapGroups[0].note).toBe("duration_mismatch");
  });

  it("组内含 error 行（损坏副本 durationS=0）不算配对，标 error_involved", () => {
    const rows5: ManifestRow[] = [
      { file: sf("专栏/01.提问.mp4", "main", "video"), probe: pr(3600) },
      { file: sf("专栏/提问.mp4", "hevc", "video"), probe: null, error: "moov atom not found" },
    ];
    const r5 = buildManifest(rows5, [], "x");
    expect(r5.summary.overlap.matchedPairs).toBe(0);
    expect(r5.overlapGroups[0].note).toBe("error_involved");
  });

  it("音频 error 行（.mp3）bucket 同样为 null", () => {
    const rows6: ManifestRow[] = [
      { file: sf("剑桥/test1/track1.mp3", "main", "audio"), probe: null, error: "Invalid data" },
    ];
    expect(buildManifest(rows6, [], "x").entries[0].bucket).toBeNull();
  });
});
