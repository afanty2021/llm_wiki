// tools/transcriber/src/audio.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

export type AudioJob = "extract" | "playbackVideo" | "playbackAudio";

/**
 * 三类 ffmpeg 作业的完整参数序列（纯函数，供测试与 runner 复用）：
 * - extract：16kHz mono 16-bit PCM wav（whisper.cpp 的输入形态）
 * - playbackVideo：桶 B 视频转 H.264+AAC——macOS 硬编 videotoolbox（23.88h 约 0.5-1.5h；
 *   若被迫软编 fallback libx264 -preset veryfast -crf 23 约 6-12h，CLI 层届时加 --no-transcode 惰性转码）
 * - playbackAudio：纯音频源 -vn 转 m4a（AAC）
 */
export function audioArgs(kind: AudioJob, input: string, output: string): string[] {
  switch (kind) {
    case "extract":
      return ["-y", "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", output];
    case "playbackVideo":
      // -movflags +faststart：moov 前置——web 首播免整文件下载即可起播（T15 评审遗留）
      return ["-y", "-i", input, "-c:v", "h264_videotoolbox", "-c:a", "aac", "-movflags", "+faststart", output];
    case "playbackAudio":
      return ["-y", "-i", input, "-vn", "-c:a", "aac", output];
  }
}

async function runFfmpeg(args: string[]): Promise<void> {
  // 不设 timeout：桶 B 转码按小时计；ffmpeg 自身失败会非零退出并带 stderr
  await execFileAsync("ffmpeg", ["-v", "error", ...args], { maxBuffer: 10 * 1024 * 1024 });
}

export async function extractAudio(absPath: string, wavOut: string): Promise<void> {
  await runFfmpeg(audioArgs("extract", absPath, wavOut));
}

export async function transcodePlayback(absPath: string, mp4Out: string): Promise<void> {
  await runFfmpeg(audioArgs("playbackVideo", absPath, mp4Out));
}

export async function transcodeAudioPlayback(absPath: string, m4aOut: string): Promise<void> {
  await runFfmpeg(audioArgs("playbackAudio", absPath, m4aOut));
}

/** 文件 SHA-256（hex）。wav 去重键 = sha256(wav)——同内容音频只抽/只转一份。 */
export function sha256File(p: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(p)
      .on("data", chunk => h.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(h.digest("hex")));
  });
}

export const sha8Of = (sha256Hex: string): string => sha256Hex.slice(0, 8);

// —— 产物路径约定（T15 管线沿用）：wav 内容寻址去重、副本按 slug 寻址 ——
export const audioOutPath = (outDir: string, wavSha8: string): string => join(outDir, "audio", `${wavSha8}.wav`);
export const playbackOutPath = (outDir: string, slug: string, ext: ".mp4" | ".m4a"): string =>
  join(outDir, "playback", `${slug}${ext}`);
