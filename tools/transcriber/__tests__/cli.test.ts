// tools/transcriber/__tests__/cli.test.ts
// transcribe/sign-media 子命令的纯函数部分：参数解析 / 首批过滤 / bootstrap.env 解析
// （主循环 IO 编排由 Task 15 真跑验收；模块顶部 invokedAsScript 守卫保证 import 无副作用）
import { describe, it, expect } from "vitest";
import {
  parseTranscribeArgs, selectFirstBatchVideos, parseBootstrapEnv,
  parseFailedItemStates, isRescuableMedia, RESCUE_CODEC_BLACKLIST, lineEligible,
  applyWriteFailure, applyTranscribeFailure,
} from "../src/cli";
import type { ManifestEntry } from "../src/manifest";
import type { StateLine } from "../src/whisper";

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

describe("parseFailedItemStates（M1 评审 #2：ingest item 级失败可见）", () => {
  it("服务端 JSONB 形状 [{path,status,error}] → 仅取 failed 项（含 error）", () => {
    expect(parseFailedItemStates([
      { path: "sources/transcripts/a.md", status: "done", error: null },
      { path: "sources/transcripts/b.md", status: "failed", error: "embedding timeout" },
      { path: "sources/transcripts/c.md", status: "skipped", error: null },
    ])).toEqual([{ path: "sources/transcripts/b.md", error: "embedding timeout" }]);
  });
  it("succeeded_with_warnings 且 0 failed → 空（CLI 据此 exit 0）", () => {
    expect(parseFailedItemStates([{ path: "a.md", status: "done", error: null }])).toEqual([]);
  });
  it("防御式：非数组 / 非对象元素 / 缺 path / status 非 failed 均跳过，不抛错", () => {
    expect(parseFailedItemStates(undefined)).toEqual([]);
    expect(parseFailedItemStates(null)).toEqual([]);
    expect(parseFailedItemStates({})).toEqual([]);
    expect(parseFailedItemStates([42, "x", null, { status: "failed" }, { path: "a.md", status: "failed", error: 7 }]))
      .toEqual([{ path: "a.md", error: undefined }]);
  });
});

describe("isRescuableMedia（M1 评审 #5：静帧 codec 黑名单）", () => {
  it("真视频/纯音频可救援", () => {
    expect(isRescuableMedia({ videoCodec: "hevc", audioCodec: "aac" })).toBe(true);
    expect(isRescuableMedia({ videoCodec: null, audioCodec: "aac" })).toBe(true);
  });
  it("jpg/png 等静帧 codec（mjpeg/png/bmp/tiff/gif）不算媒体——归 ignored", () => {
    for (const codec of ["mjpeg", "png", "bmp", "tiff", "gif"]) {
      expect(isRescuableMedia({ videoCodec: codec, audioCodec: null })).toBe(false);
    }
    expect(RESCUE_CODEC_BLACKLIST.has("mjpeg")).toBe(true);
  });
  it("大写 codec 名同样命中（防御 toLowerCase）", () => {
    expect(isRescuableMedia({ videoCodec: "MJPEG", audioCodec: null })).toBe(false);
  });
  it("双流皆无 → 不可救援", () => {
    expect(isRescuableMedia({ videoCodec: null, audioCodec: null })).toBe(false);
  });
});

describe("lineEligible（M1 评审 #4：主循环接 nextPending 的 tries 上限语义）", () => {
  const mk = (over: Partial<StateLine>): StateLine =>
    ({ slug: "s", wavSha: "abcd1234", status: "pending", tries: 0, ...over });
  it("无行（新文件）/ done / pending 可处理", () => {
    expect(lineEligible(undefined)).toBe(true);
    expect(lineEligible(mk({ status: "done", tries: 1 }))).toBe(true);
    expect(lineEligible(mk({ status: "pending", tries: 5 }))).toBe(true);
  });
  it("failed 且 tries<2 可重试；tries≥2 跳过（列 report，不再无限重试）", () => {
    expect(lineEligible(mk({ status: "failed", tries: 1 }))).toBe(true);
    expect(lineEligible(mk({ status: "failed", tries: 2 }))).toBe(false);
    expect(lineEligible(mk({ status: "failed", tries: 3 }))).toBe(false);
  });
  it("崩溃残留的 running 同样受 tries 上限（与 nextPending 一致）", () => {
    expect(lineEligible(mk({ status: "running", tries: 1 }))).toBe(true);
    expect(lineEligible(mk({ status: "running", tries: 2 }))).toBe(false);
  });
});

describe("失败分类（M1 review r2：tries 只计转写失败，写入类不消耗）", () => {
  const mk = (over: Partial<StateLine>): StateLine =>
    ({ slug: "s", wavSha: "abcd1234", status: "pending", tries: 0, ...over });
  it("注册网络错（写入类）标 failed 但 tries 不变——done 行（tries=1）下轮仍 eligible，自愈不失效", () => {
    const after = applyWriteFailure(mk({ status: "done", tries: 1 }), "registerMediaAssets: 503");
    expect(after.status).toBe("failed");
    expect(after.tries).toBe(1);            // 写步骤幂等，不消耗配额
    expect(lineEligible(after)).toBe(true); // 下轮仍可重试（非 exhaustedRetries）
  });
  it("转写失败两次 → tries=2 exhausted（不再 eligible，列 report）", () => {
    let l = applyTranscribeFailure(mk({}), "whisper-cli exited 1");
    expect(l.tries).toBe(1);
    expect(lineEligible(l)).toBe(true);     // 第 1 次后仍可重试
    l = applyTranscribeFailure(l, "whisper-cli exited 1");
    expect(l.tries).toBe(2);
    expect(lineEligible(l)).toBe(false);    // exhaustedRetries，--force 才重置
  });
});
