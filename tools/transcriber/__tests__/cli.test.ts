// tools/transcriber/__tests__/cli.test.ts
// transcribe/sign-media 子命令的纯函数部分：参数解析（含缺值校验）/ 首批过滤 / bootstrap.env 解析
// （主循环 IO 编排由 Task 15 真跑验收；模块顶部 invokedAsScript 守卫保证 import 无副作用）
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  parseTranscribeArgs, selectFirstBatchVideos, parseBootstrapEnv,
  parseFailedItemStates, isRescuableMedia, RESCUE_CODEC_BLACKLIST, lineEligible,
  applyWriteFailure, applyTranscribeFailure, runIngestPhase, transcribeExitCode,
  parseDiffPath,
} from "../src/cli";
import type { ManifestEntry } from "../src/manifest";
import type { StateLine } from "../src/whisper";
import type { JobStatus } from "../src/api-client";

describe("parseTranscribeArgs", () => {
  it("默认 window=23:00-08:00，无 limit/force/demoSlug/dirs", () => {
    expect(parseTranscribeArgs([])).toEqual({ window: "23:00-08:00", limit: undefined, force: false, demoSlug: undefined, dirs: undefined });
  });
  it("白天直跑：--window 00:00-23:59 --limit 5 --force --demo-slug x", () => {
    expect(parseTranscribeArgs(["--window", "00:00-23:59", "--limit", "5", "--force", "--demo-slug", "x"]))
      .toEqual({ window: "00:00-23:59", limit: 5, force: true, demoSlug: "x", dirs: undefined });
  });
  it("非法窗口串在解析期即抛（fail fast，不等 48 个文件跑一半）", () => {
    expect(() => parseTranscribeArgs(["--window", "25:00-08:00"])).toThrow(/非法窗口串/);
    expect(() => parseTranscribeArgs(["--window", "23:00"])).toThrow(/非法窗口串/);
  });
  it("--dir 单子串与逗号分隔多子串；空段剔除", () => {
    expect(parseTranscribeArgs(["--dir", "幼儿英语启蒙"]).dirs).toEqual(["幼儿英语启蒙"]);
    expect(parseTranscribeArgs(["--dir", "幼儿英语启蒙, 教材及教学素材解析,"]).dirs)
      .toEqual(["幼儿英语启蒙", "教材及教学素材解析"]);
    expect(parseTranscribeArgs(["--dir", ","]).dirs).toEqual([]);
  });
  it("--dir 结尾缺值 → 报错退出", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("exit") }) as never);
    try { expect(() => parseTranscribeArgs(["--force", "--dir"])).toThrow(); } finally { exit.mockRestore(); }
  });
});

describe("参数缺值校验（M2 前置：末位缺值报错退出，不再静默默认）", () => {
  afterEach(() => vi.restoreAllMocks());
  /** fail() 走 console.error + process.exit(1)——桩掉两者并断言退出码与错误消息。 */
  const expectFailExit1 = (argv: string[], msgRe: RegExp) => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation(m => errors.push(String(m)));
    const exit = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("EXIT_NOW"); });
    expect(() => parseTranscribeArgs(argv)).toThrow("EXIT_NOW");
    expect(exit).toHaveBeenCalledWith(1);
    expect(errors.some(e => msgRe.test(e))).toBe(true);
  };

  it("--window 结尾缺值 → 报错退出（此前静默回落默认窗口 23:00-08:00）", () => {
    expectFailExit1(["--window"], /--window 需带值/);
  });
  it("--window 后跟下一 flag → 视为缺值报错（此前把 --force 当窗口串报格式错）", () => {
    expectFailExit1(["--window", "--force", "00:00-23:59"], /--window 需带值/);
  });
  it("--demo-slug 结尾缺值 → 报错退出（此前静默当未传）", () => {
    expectFailExit1(["--window", "00:00-23:59", "--demo-slug"], /--demo-slug 需带值/);
  });
  it("--demo-slug 后跟下一 flag → 视为缺值报错（此前 demoSlug=\"--force\" 静默错配）", () => {
    expectFailExit1(["--demo-slug", "--force"], /--demo-slug 需带值/);
  });
  it("--limit 结尾缺值 → 同规则报错（值型 flag 统一走缺值校验）", () => {
    expectFailExit1(["--limit"], /--limit 需带值/);
  });
  it("合法传参不受影响：三个值型 flag 均有值时照常解析", () => {
    expect(parseTranscribeArgs(["--window", "00:00-23:59", "--limit", "3", "--demo-slug", "s1"]))
      .toEqual({ window: "00:00-23:59", limit: 3, force: false, demoSlug: "s1" });
  });
});

describe("parseDiffPath（audit --diff 值解析，同 val() 缺值规则）", () => {
  afterEach(() => vi.restoreAllMocks());

  it("未传 → undefined；正常传值 → 路径字符串", () => {
    expect(parseDiffPath([])).toBeUndefined();
    expect(parseDiffPath(["--concurrency", "8"])).toBeUndefined();
    expect(parseDiffPath(["--diff", "/tmp/prev-manifest.json", "--concurrency", "8"])).toBe("/tmp/prev-manifest.json");
  });

  it("末位缺值 / 下一 flag 视为缺值 → 报错退出（exit 1）", () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation(m => errors.push(String(m)));
    const exit = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("EXIT_NOW"); });
    expect(() => parseDiffPath(["--diff"])).toThrow("EXIT_NOW");
    expect(() => parseDiffPath(["--diff", "--concurrency", "8"])).toThrow("EXIT_NOW");
    expect(exit).toHaveBeenCalledWith(1);
    expect(errors.some(e => /--diff 需带值/.test(e))).toBe(true);
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

describe("runIngestPhase / transcribeExitCode（评审 #5：waitJob 超时不丢报告）", () => {
  afterEach(() => vi.restoreAllMocks());

  const records = [
    { slug: "s1", pagePath: "transcripts/s1.md", sourcePath: "sources/transcripts/s1.md", expectedHash: "h1", md: "# s1" },
    { slug: "s2", pagePath: "transcripts/s2.md", sourcePath: "sources/transcripts/s2.md", expectedHash: "h2", md: "# s2" },
  ];
  const mkApi = (over: {
    triggerIngest?: (sourcePaths: string[]) => Promise<string>;
    waitJob?: (jobId: string) => Promise<JobStatus>;
  } = {}) => {
    const verifyCalls: Array<{ pagePath: string }> = [];
    return {
      triggerIngest: vi.fn(over.triggerIngest ?? (async (_paths: string[]) => "job-42")),
      waitJob: vi.fn(over.waitJob ?? (async (_jobId: string): Promise<JobStatus> => {
        throw new Error("waitJob not stubbed");
      })),
      verifyTranscriptIntact: vi.fn(async (pagePath: string, _expectedHash: string): Promise<boolean> => {
        verifyCalls.push({ pagePath });
        return true;
      }),
      upsertTranscriptPage: vi.fn(async (_pagePath: string, _md: string) => "updated" as const),
      verifyCalls,
    };
  };

  it("waitJob 抛出（超时/重试耗尽）→ wait_failed 假终态返回，不再上抛；job 后对账仍尽力执行", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(m => errors.push(String(m)));
    const api = mkApi({ waitJob: vi.fn().mockRejectedValue(new Error("waitJob timed out after 14400000ms: job job-42 未到终态")) });
    const result = await runIngestPhase(api, records);

    // wait_failed 假终态：报告字段（jobStatus/jobId/failedSources）仍可组装
    expect(result.jobId).toBe("job-42");
    expect(result.job.status).toBe("wait_failed");
    expect(result.job.error).toContain("timed out");
    expect(result.failedSources).toEqual([]);            // item_states 缺失 → 防御式空
    expect(result.warnings).toEqual([]);
    // 对账两阶段都跑了（ingest前 + job 后——超时不跳过 best-effort）：2 records × 2 phases
    expect(api.verifyTranscriptIntact).toHaveBeenCalledTimes(4);
    // CLI 据此非零退出（报告照写 + exit 1 的判定输入）
    expect(transcribeExitCode(0, result.failedSources, result.job.status)).toBe(1);
    expect(errors.some(e => e.includes("wait_failed"))).toBe(true);
  });

  it("waitJob 正常终态 → 形状直通 + item 级 failed 解析（happy path 不变）", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const job: JobStatus = {
      id: "job-42", project_id: 7, status: "succeeded_with_warnings",
      item_states: [
        { path: "sources/transcripts/s1.md", status: "done", error: null },
        { path: "sources/transcripts/s2.md", status: "failed", error: "embedding timeout" },
      ],
    };
    const api = mkApi({ waitJob: vi.fn().mockResolvedValue(job) });

    const result = await runIngestPhase(api, records);

    expect(result.jobId).toBe("job-42");
    expect(result.job).toBe(job);                          // 同一对象直通，无包装
    expect(result.failedSources).toEqual([{ path: "sources/transcripts/s2.md", error: "embedding timeout" }]);
    expect(api.verifyTranscriptIntact).toHaveBeenCalledTimes(4);
    expect(transcribeExitCode(0, result.failedSources, result.job.status)).toBe(1);
  });

  it("transcribeExitCode 判定矩阵：failed 文件 / failed source / job failed / wait_failed → 1；干净轮 → 0", () => {
    expect(transcribeExitCode(0, [], "succeeded")).toBe(0);
    expect(transcribeExitCode(0, [], "succeeded_with_warnings")).toBe(0);
    expect(transcribeExitCode(1, [], "succeeded")).toBe(1);                      // 本轮有 failed 文件
    expect(transcribeExitCode(0, [{ path: "a.md" }], "succeeded_with_warnings")).toBe(1); // item 级 failed
    expect(transcribeExitCode(0, [], "failed")).toBe(1);                          // job failed
    expect(transcribeExitCode(0, [], "wait_failed")).toBe(1);                     // 评审 #5：等待失败必非零
  });
});
