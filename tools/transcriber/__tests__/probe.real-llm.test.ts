import { describe, it, expect } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { probeMedia } from "../src/probe";
const SAMPLE = "/Users/berton/Github/L T师训 2024-2025（HEVC）/【2024-2025】LT年度师训会员（高年级版）/教学新知班级管理专栏";
const first = existsSync(SAMPLE) ? readdirSync(SAMPLE).find(f => f.toLowerCase().endsWith(".mp4")) : undefined;
describe.skipIf(!first)("probeMedia real ffprobe smoke", () => {
  it("probes a real first-batch mp4", async () => {
    const r = await probeMedia(join(SAMPLE, first!));
    expect(r.videoCodec).toBe("hevc");
    expect(r.durationS).toBeGreaterThan(60);
  });
});
