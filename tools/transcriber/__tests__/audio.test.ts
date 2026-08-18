// tools/transcriber/__tests__/audio.test.ts
// extractAudio/transcodePlayback 的命令构造以纯函数 audioArgs 测参数序列（真实 ffmpeg 冒烟见 audio.real-ffmpeg.test.ts）
import { describe, it, expect } from "vitest";
import { audioArgs, audioOutPath, playbackOutPath, sha8Of } from "../src/audio";

describe("audioArgs", () => {
  it("extract: 16k mono wav（-vn + pcm_s16le，whisper.cpp 要求的 WAV 形态）", () => {
    expect(audioArgs("extract", "/a/b.mp4", "/o/b.wav")).toEqual(
      ["-y", "-i", "/a/b.mp4", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "/o/b.wav"]);
  });
  it("extract 参数序列包含 16k/mono 关键对", () => {
    expect(audioArgs("extract", "/a/b.mp4", "/o/b.wav")).toEqual(
      expect.arrayContaining(["-ac", "1", "-ar", "16000"]));
  });
  it("playbackVideo: 桶B视频转 H.264+AAC（macOS videotoolbox 硬编）", () => {
    expect(audioArgs("playbackVideo", "/a/b.mov", "/o/b.mp4")).toEqual(
      expect.arrayContaining(["-c:v", "h264_videotoolbox", "-c:a", "aac"]));
    expect(audioArgs("playbackVideo", "/a/b.mov", "/o/b.mp4")).toEqual(
      ["-y", "-i", "/a/b.mov", "-c:v", "h264_videotoolbox", "-c:a", "aac", "-movflags", "+faststart", "/o/b.mp4"]);
  });
  it("playbackAudio: 纯音频源 -vn 转 m4a（AAC）", () => {
    expect(audioArgs("playbackAudio", "/a/b.wma", "/o/b.m4a")).toEqual(
      ["-y", "-i", "/a/b.wma", "-vn", "-c:a", "aac", "/o/b.m4a"]);
  });
});

describe("产物路径约定", () => {
  it("wav 落 out/audio/<sha8>.wav（同内容跨目录共用一份音频）", () => {
    expect(audioOutPath("/out", "ab12cd34")).toBe("/out/audio/ab12cd34.wav");
  });
  it("可播副本落 out/playback/<slug>.mp4|.m4a", () => {
    expect(playbackOutPath("/out", "s1", ".mp4")).toBe("/out/playback/s1.mp4");
    expect(playbackOutPath("/out", "s2", ".m4a")).toBe("/out/playback/s2.m4a");
  });
  it("sha8Of 取 SHA-256 hex 前 8 位", () => {
    expect(sha8Of("0123456789abcdef0123456789abcdef")).toBe("01234567");
  });
});
