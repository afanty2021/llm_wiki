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
