// tools/transcriber/__tests__/whisper.test.ts
// 纯函数 + JSONL 状态机（真实 whisper 转写冒烟留 Task 15）
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseWhisperJson, withinWindow, whisperArgs, loadState, saveState, nextPending, initLine } from "../src/whisper";

// saveState 原子写断言需要观测 renameSync（ESM namespace 不可 spy，改 partial mock 记录调用）
const h = vi.hoisted(() => ({ renameCalls: [] as Array<[string, string]> }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: (from: string, to: string) => { h.renameCalls.push([from, to]); return actual.renameSync(from, to); },
  };
});

const fixture = { transcription: [
  { offsets: { from: 30720, to: 33000 }, text: " 大家好" },
  { offsets: { from: 33000, to: 35500 }, text: " 今天我们讲课堂提问" } ] };
describe("parseWhisperJson", () => {
  it("毫秒 offset → 秒，text 保留", () => {
    expect(parseWhisperJson(fixture)).toEqual([
      { startS: 30.72, endS: 33, text: "大家好" },  // 实现里 strip 首空格
      { startS: 33, endS: 35.5, text: "今天我们讲课堂提问" },
    ]);
  });
  it("空 transcription 容错", () => { expect(parseWhisperJson({ transcription: [] })).toEqual([]); });
  it("缺 transcription 字段容错（防 -oj 输出形态变化时抛错）", () => { expect(parseWhisperJson({})).toEqual([]); });
});
describe("withinWindow", () => {
  it("跨午夜窗口", () => {
    expect(withinWindow(new Date("2026-08-18T23:30:00"), "23:00-08:00")).toBe(true);
    expect(withinWindow(new Date("2026-08-18T06:00:00"), "23:00-08:00")).toBe(true);
    expect(withinWindow(new Date("2026-08-18T12:00:00"), "23:00-08:00")).toBe(false);
  });
  it("窗口边界：起点含、终点含（Task 6 r3：一行两处端点均改为闭区间）；非跨午夜窗口同规则", () => {
    expect(withinWindow(new Date("2026-08-18T23:00:00"), "23:00-08:00")).toBe(true);
    expect(withinWindow(new Date("2026-08-18T08:00:00"), "23:00-08:00")).toBe(true);  // 跨午夜端点整点 → 含端为 true
    expect(withinWindow(new Date("2026-08-18T08:01:00"), "23:00-08:00")).toBe(false);
    expect(withinWindow(new Date("2026-08-18T09:00:00"), "09:00-18:00")).toBe(true);
    expect(withinWindow(new Date("2026-08-18T18:00:00"), "09:00-18:00")).toBe(true);  // 直区间端点整点 → 含端为 true
    expect(withinWindow(new Date("2026-08-18T18:01:00"), "09:00-18:00")).toBe(false);
    expect(withinWindow(new Date("2026-08-18T08:59:00"), "09:00-18:00")).toBe(false);
  });
  it("单分钟窗口 23:59-23:59 在 23:59:30 → true（分钟粒度：同分即两端皆命中）", () => {
    expect(withinWindow(new Date("2026-08-18T23:59:30"), "23:59-23:59")).toBe(true);
    expect(withinWindow(new Date("2026-08-18T23:58:30"), "23:59-23:59")).toBe(false);
    expect(withinWindow(new Date("2026-08-19T00:00:00"), "23:59-23:59")).toBe(false);  // f==t 非跨午夜分支：cur > t
  });
  it("跨午夜窗 23:00-02:00：01:30 → true 且 02:00:00 整 → true（第二处端点）；02:01 → false", () => {
    expect(withinWindow(new Date("2026-08-19T01:30:00"), "23:00-02:00")).toBe(true);
    expect(withinWindow(new Date("2026-08-19T02:00:00"), "23:00-02:00")).toBe(true);  // 第二处 cur<t 的端点：02:00 整仍在窗内
    expect(withinWindow(new Date("2026-08-19T02:01:00"), "23:00-02:00")).toBe(false);
    expect(withinWindow(new Date("2026-08-18T23:00:00"), "23:00-02:00")).toBe(true);
    expect(withinWindow(new Date("2026-08-18T12:00:00"), "23:00-02:00")).toBe(false);
  });
  it("非法窗口串抛错（T15 评审遗留：缺端点/非数字/越界都不许静默当合法窗口）", () => {
    expect(() => withinWindow(new Date(), "23:00")).toThrow(/非法窗口串/);       // 缺 "-" 端点
    expect(() => withinWindow(new Date(), "23:00-")).toThrow(/非法窗口串/);      // 空端点
    expect(() => withinWindow(new Date(), "ab:cd-08:00")).toThrow(/非法窗口串/); // 非数字
    expect(() => withinWindow(new Date(), "25:00-08:00")).toThrow(/非法窗口串/); // 时越界
    expect(() => withinWindow(new Date(), "23:00-08:60")).toThrow(/非法窗口串/); // 分越界
  });
});
describe("whisperArgs（命令构造，Task 10 已验证的调用形态）", () => {
  it("-l zh -oj -of（of 剥 .json 后缀）+ 模型/音频/prompt", () => {
    expect(whisperArgs({ wavPath: "/a/x.wav", modelPath: "/m/ggml.bin", prompt: "LT英语师训", outJsonPath: "/o/x.json" })).toEqual(
      ["-m", "/m/ggml.bin", "-f", "/a/x.wav", "-l", "zh", "--prompt", "LT英语师训", "-oj", "-of", "/o/x"]);
  });
  it("无 prompt 则省略 --prompt 对", () => {
    const args = whisperArgs({ wavPath: "/a/x.wav", modelPath: "/m/ggml.bin", prompt: undefined, outJsonPath: "/o/x.json" });
    expect(args).not.toContain("--prompt");
    expect(args).toEqual(["-m", "/m/ggml.bin", "-f", "/a/x.wav", "-l", "zh", "-oj", "-of", "/o/x"]);
  });
});

describe("JSONL 状态机（断点续跑）", () => {
  let dir: string;
  let jl: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "t12-state-")); jl = join(dir, "state.jsonl"); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("loadState：文件不存在 → 空数组（首次跑无状态文件）", () => {
    expect(loadState(jl)).toEqual([]);
  });
  it("saveState→loadState 往返：JSONL 每行一个状态对象", () => {
    const lines = [
      initLine("s-a", "aa000000"),
      { ...initLine("s-b", "bb000000"), status: "done" as const, tries: 1 },
    ];
    saveState(jl, lines);
    expect(existsSync(jl)).toBe(true);
    expect(loadState(jl)).toEqual(lines);
  });
  it("saveState 原子写（T15 评审遗留）：temp+rename，无 .tmp 残留，旧内容整体替换", () => {
    const lines = [initLine("s-a", "aa000000")];
    writeFileSync(jl, "旧内容半截写入\n");
    h.renameCalls.length = 0;
    saveState(jl, lines);
    expect(h.renameCalls).toContainEqual([`${jl}.tmp`, jl]);
    expect(existsSync(`${jl}.tmp`)).toBe(false);
    expect(loadState(jl)).toEqual(lines);
  });
  it("initLine：pending / tries 0", () => {
    expect(initLine("s-a", "aa000000")).toEqual({ slug: "s-a", wavSha: "aa000000", status: "pending", tries: 0 });
  });
  it("nextPending：跳过 done；failed 且 tries<2 可重试；failed tries=2 不再取", () => {
    const lines = [
      { slug: "s-a", wavSha: "a", status: "done" as const, tries: 1 },
      { slug: "s-b", wavSha: "b", status: "failed" as const, tries: 2, error: "boom" },
      { slug: "s-c", wavSha: "c", status: "pending" as const, tries: 0 },
      { slug: "s-d", wavSha: "d", status: "failed" as const, tries: 1, error: "timeout" },
    ];
    expect(nextPending(lines)?.slug).toBe("s-c");
    expect(nextPending(lines.slice(3))?.slug).toBe("s-d"); // tries=1 < 2 → 重试
    expect(nextPending([lines[0], lines[1]])).toBeUndefined(); // 全 done/耗尽
  });
  it("nextPending：崩溃残留的 running 视为可续（新进程启动即证明旧 runner 已死）", () => {
    const lines = [
      { slug: "s-a", wavSha: "a", status: "running" as const, tries: 1 },
      { slug: "s-b", wavSha: "b", status: "pending" as const, tries: 0 },
    ];
    expect(nextPending(lines)?.slug).toBe("s-a");
  });
  it("nextPending：running 残留也接 tries 上限（tries>=2 不再续，T15 评审遗留）——否则坏文件崩两次后永久卡队列头", () => {
    const lines = [
      { slug: "s-a", wavSha: "a", status: "running" as const, tries: 2, error: "OOM" },
      { slug: "s-b", wavSha: "b", status: "pending" as const, tries: 0 },
    ];
    expect(nextPending(lines)?.slug).toBe("s-b"); // 跳过耗尽的 running，取后面的 pending
    expect(nextPending([lines[0]])).toBeUndefined();
  });
});
