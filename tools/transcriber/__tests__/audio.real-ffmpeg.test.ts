// tools/transcriber/__tests__/audio.real-ffmpeg.test.ts
// #real：真实 ffmpeg 集成冒烟——对 60s 真实样本跑 extractAudio，ffprobe 验 16000/mono。
// 采样目录缺失时整组跳过（同 probe.real-llm.test.ts 惯例）。
import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractAudio } from "../src/audio";

const execFileAsync = promisify(execFile);
const SAMPLE_DIR = "/Users/berton/Github/L T师训 2024-2025（HEVC）/【2024-2025】LT年度师训会员（高年级版）/教学新知班级管理专栏";
const firstMp4 = existsSync(SAMPLE_DIR) ? readdirSync(SAMPLE_DIR).find(f => f.toLowerCase().endsWith(".mp4")) : undefined;

describe.skipIf(!firstMp4)("extractAudio real ffmpeg smoke（Task 10 同源样本）", () => {
  it("60s 样本 → wav 存在且 ffprobe 报 16000Hz / 1 channel / pcm_s16le", async () => {
    const dir = mkdtempSync(join(tmpdir(), "t11-audio-"));
    try {
      const sample = join(dir, "sample60.mp4");
      // 流拷贝截 60s，模拟"60s 样本"（与 Task 10 冒烟取样方式一致）
      await execFileAsync("ffmpeg", ["-y", "-v", "error", "-t", "60", "-i", join(SAMPLE_DIR, firstMp4!), "-c", "copy", sample]);
      const wav = join(dir, "sample60.wav");
      await extractAudio(sample, wav);
      expect(existsSync(wav)).toBe(true);
      const { stdout } = await execFileAsync("ffprobe",
        ["-v", "error", "-print_format", "json", "-show_streams", wav], { maxBuffer: 1024 * 1024 });
      const s = (JSON.parse(stdout).streams as Array<{ codec_name?: string; sample_rate?: string; channels?: number }>)[0];
      expect(s.sample_rate).toBe("16000");
      expect(s.channels).toBe(1);
      expect(s.codec_name).toBe("pcm_s16le");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
