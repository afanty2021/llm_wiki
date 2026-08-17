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
  if (file.ext === "") return "B_transcode"; // 救援出的无扩展名媒体（编码已知但浏览器兼容性未验）：安全默认转码
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
