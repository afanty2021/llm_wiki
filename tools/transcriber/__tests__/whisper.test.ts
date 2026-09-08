// tools/transcriber/__tests__/whisper.test.ts
// 纯函数 + JSONL 状态机（真实 whisper 转写冒烟留 Task 15）
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseWhisperJson, withinWindow, whisperArgs, loadState, saveState, nextPending, initLine, runDegenerationGate, analyzeWindowDegeneration, DegenerationRejectError } from "../src/whisper";

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

describe("stripHallucinationSegments（B 站搬运幻觉过滤，2026-08-29 全库 55 页波及后落地）", () => {
  const seg = (text: string) => ({ startS: 1, endS: 2, text });
  it("纯幻觉段剥词后为空 → 丢弃（含中文字幕志愿者完整署名形态）", () => {
    expect(parseWhisperJson({ transcription: [
      { offsets: { from: 1000, to: 2000 }, text: "字幕志愿者 李宗盛" },
      { offsets: { from: 2000, to: 3000 }, text: "中文字幕志愿者 李宗盛" },
      { offsets: { from: 3000, to: 4000 }, text: "请不吝点赞 订阅 转发 打赏支持明镜与点点栏目" },
    ] })).toEqual([]);
  });
  it("真段（幻觉词只是子串或无关内容）→ 保留零误杀", () => {
    const out = parseWhisperJson({ transcription: [
      { offsets: { from: 1000, to: 2000 }, text: "Hello 各位老师大家好，我是Mary" },
      { offsets: { from: 2000, to: 3000 }, text: "今天讲词汇教学" },
    ] });
    expect(out).toHaveLength(2);
    expect(out[0].text).toContain("Mary");
  });
  it("剥词后仍有内容的段保留（混合段不丢真字）", () => {
    const out = parseWhisperJson({ transcription: [
      { offsets: { from: 1000, to: 2000 }, text: "字幕志愿者 If you hear my voice, clap once" },
    ] });
    expect(out).toHaveLength(1);
    expect(out[0].text).toContain("clap once");
  });
  it("2026-09-07 扩容：优独播剧场/YoYo Television 纯幻觉段丢弃（优优独播剧场为优独播剧场子串一网打尽）", () => {
    expect(parseWhisperJson({ transcription: [
      { offsets: { from: 1000, to: 2000 }, text: "优优独播剧场——YoYo Television Series Exclusive" },
      { offsets: { from: 2000, to: 3000 }, text: "优独播剧场——YoYo Television Series Exclusive" },
    ] })).toEqual([]);
  });
});

describe("窗级退化守门（2026-09-07 刘飞雪试点 04/06 双例后落地）", () => {
  const seg = (startS: number, text: string) => ({ startS, endS: startS + 5, text });

  // 合成正常窗：多样文本 ~700 字（>500 字门槛），无循环
  const normalText = Array.from({ length: 50 }, (_, i) =>
    `第${i}个教学环节老师引导学生讨论问题${i}并给出不同的示例与反馈`).join("");

  it("健康窗零误杀：多样文本 + 真实课堂复读（02 甜甜×103 规模）不触发", () => {
    // 甜甜×103：8-gram freq≈199 <250，链覆盖 ~206 字 / 大窗远 <0.5
    expect(runDegenerationGate("s-ok", [seg(0, normalText + "甜甜".repeat(103) + "课堂继续")])).toEqual(
      [seg(0, normalText + "甜甜".repeat(103) + "课堂继续")]);
  });
  it("低于拒页线的局部循环告警放行（03 BGM 循环×124 规模，签名单元 9 字）", () => {
    const loopUnit = "我能不能再唱歌吗";
    const out = runDegenerationGate("s-warn", [seg(0, normalText + loopUnit.repeat(124))]);
    expect(out).toHaveLength(1);
  });
  it("06 型拒页：长单元 ×295/窗、退化窗字占 ≥40% → 抛 DegenerationRejectError 带签名与占比", () => {
    const unit = "优优独播剧场——YoYo Television Series Exclusive"; // 25 字符
    const spamSegs = Array.from({ length: 8 }, (_, w) => seg(w * 300, unit.repeat(295))); // 8 个全退化窗
    try {
      runDegenerationGate("s-reject", spamSegs);
      expect.unreachable("应当拒页");
    } catch (e) {
      expect(e).toBeInstanceOf(DegenerationRejectError);
      expect((e as Error).message).toContain("须重转或人工复核");
      expect((e as Error).message).toContain("≥40%");
      expect((e as Error).message).toContain("优优独播剧场");
    }
  });
  it("04 型拒页：12 字单元 ×1005 内联在 300s 窗（freq 臂），真实内容窗并存时按字占比判", () => {
    const unit = "与他配合肥16玫瑰院学校"; // 12 字符
    const spam = unit.repeat(1005);
    const goodSegs = Array.from({ length: 3 }, (_, w) => seg(w * 300, normalText));
    try {
      runDegenerationGate("s-04", [seg(0, spam), ...goodSegs]);
      expect.unreachable("spam 字占 7/10 应当拒页");
    } catch (e) {
      expect(e).toBeInstanceOf(DegenerationRejectError);
      expect((e as Error).message).toContain("与他配合肥16玫瑰院学校".slice(0, 8));
    }
  });
  it("链覆盖臂：短周期高占比（5410328e 型 cov≈0.99）在 freq<250 时仍拒页", () => {
    // 单元 40 字重复 120 次 = 4800 字符纯循环（每 8-gram freq = 120 <250），窗内占比 100%
    const unit = "这是一个用于测试短周期高占比循环链覆盖臂的合成单元文本嗯";
    const out40 = unit.repeat(120);
    try {
      runDegenerationGate("s-cov", [seg(0, out40)]);
      expect.unreachable("覆盖臂应当拒页");
    } catch (e) {
      expect(e).toBeInstanceOf(DegenerationRejectError);
    }
  });
  it("短于 500 字的窗不参与判定（段碎片不误杀）", () => {
    const short = "看，看，看，".repeat(60); // 360 字符 < 500 门槛
    expect(runDegenerationGate("s-short", [seg(0, short)])).toHaveLength(1);
  });
  it("Unlock 误报修正：干净文本主题词少量不规则复现（×3、众数间距计数 1）不触发链臂（2026-09-09）", () => {
    // 教材伴学视频形态：脚本自然复现主题词（orangutan/France is 等 ×2-17），
    // 修复前众数间距被当成循环周期，链覆盖 0.76-1.00 整批误拒（80 件拒 11）。
    // filler 用词表错步取词 + 数字后缀：所有 8-gram 跨数字即唯一，整体无循环结构
    const words = ["课堂", "提问", "讨论", "演示", "反馈", "语法", "词汇", "阅读", "写作", "听力", "口语", "发音", "游戏", "歌曲", "故事", "任务", "评价", "作业", "复习", "拓展"];
    const filler = (tag: string, n: number) =>
      Array.from({ length: n }, (_, i) =>
        words[(i * 7 + tag.charCodeAt(0)) % 20] + words[(i * 11 + 3) % 20] + words[(i * 13 + 5) % 20] + ((i * 17 + 11) % 97)).join("");
    const text = "orangutan" + filler("A", 40) + "orangutan" + filler("B", 43) + "orangutan" + filler("C", 8);
    expect(text.length).toBeGreaterThan(500);
    expect(runDegenerationGate("s-unlock", [seg(0, text)])).toEqual([seg(0, text)]);
    expect(analyzeWindowDegeneration(text)).toBeNull();
  });
  it("人工复核出口：TRANSCRIBER_GATE_ALLOW 精确 slug 命中才放行，近似 slug 仍拒（防同名 lesson 误扫）", () => {
    const unit = "优优独播剧场——YoYo Television Series Exclusive";
    const spam = Array.from({ length: 8 }, (_, w) => ({ startS: w * 300, endS: w * 300 + 5, text: unit.repeat(295) }));
    process.env.TRANSCRIBER_GATE_ALLOW = "儿歌分享-What-s-your-favourite-color-f30ce801,what-s-your-favourite-color-3a6e19e5";
    try {
      const out = runDegenerationGate("儿歌分享-What-s-your-favourite-color-f30ce801", spam);
      expect(out).toHaveLength(8);
      const out2 = runDegenerationGate("what-s-your-favourite-color-3a6e19e5", spam);
      expect(out2).toHaveLength(8);
    } finally {
      delete process.env.TRANSCRIBER_GATE_ALLOW;
    }
    // 未列入 allow 的近似 slug（同名 lesson 不同转写）照拒
    expect(() => runDegenerationGate("what-s-your-favourite-color-9zzzzzzz", spam)).toThrow(DegenerationRejectError);
  });
  it("analyzeWindowDegeneration 直测：<500 字返回 null，纯循环窗返回签名与 freq", () => {
    expect(analyzeWindowDegeneration("太短")).toBeNull();
    const unit = "优优独播剧场——YoYo Television Series Exclusive";
    const info = analyzeWindowDegeneration(unit.repeat(295));
    expect(info).not.toBeNull();
    expect(info!.maxFreq).toBeGreaterThanOrEqual(250);
    expect(info!.signature).toBe(unit.slice(0, 8));
  });
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
describe("whisperArgs（命令构造）", () => {
  it("-l auto -mc 0 -oj -of（of 剥 .json 后缀）+ 模型/音频/prompt（2026-09-07：-mc 0 禁跨段上下文防退化滚雪球，-l auto 适配中英混讲）", () => {
    expect(whisperArgs({ wavPath: "/a/x.wav", modelPath: "/m/ggml.bin", prompt: "LT英语师训", outJsonPath: "/o/x.json" })).toEqual(
      ["-m", "/m/ggml.bin", "-f", "/a/x.wav", "-l", "auto", "-mc", "0", "--prompt", "LT英语师训", "-oj", "-of", "/o/x"]);
  });
  it("无 prompt 则省略 --prompt 对", () => {
    const args = whisperArgs({ wavPath: "/a/x.wav", modelPath: "/m/ggml.bin", prompt: undefined, outJsonPath: "/o/x.json" });
    expect(args).not.toContain("--prompt");
    expect(args).toEqual(["-m", "/m/ggml.bin", "-f", "/a/x.wav", "-l", "auto", "-mc", "0", "-oj", "-of", "/o/x"]);
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
