// tools/transcriber/__tests__/cli.test.ts
// transcribe/sign-media 子命令的纯函数部分：参数解析 / 首批过滤 / bootstrap.env 解析
// （主循环 IO 编排由 Task 15 真跑验收；模块顶部 invokedAsScript 守卫保证 import 无副作用）
import { describe, it, expect } from "vitest";
import { parseTranscribeArgs, selectFirstBatchVideos, parseBootstrapEnv } from "../src/cli";
import type { ManifestEntry } from "../src/manifest";

describe("parseTranscribeArgs", () => {
  it("默认 window=23:00-08:00，无 limit/force/demoSlug", () => {
    expect(parseTranscribeArgs([])).toEqual({ window: "23:00-08:00", limit: undefined, force: false, demoSlug: undefined });
  });
  it("白天直跑：--window 00:00-23:59 --limit 5 --force --demo-slug x", () => {
    expect(parseTranscribeArgs(["--window", "00:00-23:59", "--limit", "5", "--force", "--demo-slug", "x"]))
      .toEqual({ window: "00:00-23:59", limit: 5, force: true, demoSlug: "x" });
  });
  it("非法窗口串在解析期即抛（fail fast，不等 48 个文件跑一半）", () => {
    expect(() => parseTranscribeArgs(["--window", "25:00-08:00"])).toThrow(/非法窗口串/);
    expect(() => parseTranscribeArgs(["--window", "23:00"])).toThrow(/非法窗口串/);
  });
});

describe("selectFirstBatchVideos", () => {
  const mk = (over: Partial<ManifestEntry>): ManifestEntry => ({
    absPath: "/x/a.mp4", relPath: "a.mp4", source: "hevc", category: "video", ext: ".mp4",
    container: "mov,mp4", videoCodec: "hevc", audioCodec: "aac", durationS: 60,
    bucket: "B_transcode", privacy: false, inFirstBatch: false, ...over,
  });
  it("只取 inFirstBatch && !error && category==='video'，按 relPath 稳定排序", () => {
    const entries = [
      mk({ relPath: "b/2.mp4", inFirstBatch: true }),
      mk({ relPath: "b/1.mp4", inFirstBatch: true }),
      mk({ relPath: "c/doc.md", category: "doc", inFirstBatch: true }),
      mk({ relPath: "d/broken.mp4", inFirstBatch: true, error: "probe fail", bucket: null }),
      mk({ relPath: "e/not-first.mp4" }),
      mk({ relPath: "f/audio.m4a", category: "audio", inFirstBatch: true }),
    ];
    expect(selectFirstBatchVideos(entries).map(e => e.relPath)).toEqual(["b/1.mp4", "b/2.mp4"]);
  });
});

describe("parseBootstrapEnv", () => {
  it("KEY=VALUE 行解析；注释/空行/小写/井尾忽略", () => {
    const raw = [
      "ADMIN_PASSWORD=abc123",
      "SVC_PASSWORD=def456 # 仅供 CLI 登录",
      "TEAM_ID=916",
      "",
      "# 注释行",
      "lowercase=skip",
    ].join("\n");
    expect(parseBootstrapEnv(raw)).toEqual({ ADMIN_PASSWORD: "abc123", SVC_PASSWORD: "def456", TEAM_ID: "916" });
  });
  it("空串 → 空对象（调用方决定是否 fail）", () => {
    expect(parseBootstrapEnv("")).toEqual({});
  });
});
