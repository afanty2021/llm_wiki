// tools/transcriber/src/whisper.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";

const execFileAsync = promisify(execFile);

export interface Segment {
  startS: number;
  endS: number;
  text: string;
}

/** whisper.cpp `-oj` 输出 → Segment[]（offsets 毫秒 → 秒；text 去首尾空白）。容错：缺 transcription 字段返回 []。
 *  strip 默认 true 剥黑名单纯幻觉段；退化守门须以剥前原文判窗（06 型主签名是黑名单词，
 *  先剥再判会把整页垃圾误判成健康——2026-09-07 回放实证），故守门前传 strip:false。 */
export function parseWhisperJson(raw: unknown, opts: { strip?: boolean } = {}): Segment[] {
  const j = raw as { transcription?: Array<{ offsets?: { from?: number; to?: number }; text?: string }> };
  const segs = (j.transcription ?? []).map(t => ({
    startS: (t.offsets?.from ?? 0) / 1000,
    endS: (t.offsets?.to ?? 0) / 1000,
    text: (t.text ?? "").trim(),
  }));
  return opts.strip === false ? segs : stripHallucinationSegments(segs);
}

// ── Whisper 幻觉过滤（2026-08-29 全库扫描 55/552 页波及后落地）──

/** 已知幻觉词：搬运视频的字幕组署名音轨/BGM/水印被 Whisper 转成整段重复垃圾
 *  （实测重度页「字幕志愿者 李宗盛」×1909、「优优独播剧场——YoYo Television」
 *  ×295/窗，2026-09-07 刘飞雪试点）。串面是开放集合，此处只兜已知高频族；
 *  开放集由下方窗级退化守门按循环签名兜底。剥词后整段为空才丢弃——真段剥词后
 *  仍有内容必保留，零误杀。 */
export const HALLUCINATION_TOKENS = [
  "中文字幕志愿者", "字幕志愿者", "李宗盛", "明镜与点点", "请不吝点赞", "打赏支持",
  "订阅 转发", "打赏", "优优独播剧场", "优独播剧场", "YoYo Television Series Exclusive",
] as const;

/** 幻觉段过滤：含黑名单词的段，剥词后剩余 ≤2 字（「订阅 转发 栏目」级搬运
 *  话术残渣）即丢弃；不含黑名单词的段无条件保留（零误杀入口）。 */
export function stripHallucinationSegments(segments: Segment[]): Segment[] {
  return segments.filter(seg => {
    if (!HALLUCINATION_TOKENS.some(tok => seg.text.includes(tok))) return true
    let core = seg.text
    for (const tok of HALLUCINATION_TOKENS) core = core.split(tok).join("")
    return core.replace(/\s/g, "").length > 2
  })
}

// ── 窗级退化守门（2026-09-07 刘飞雪试点 04/06 双例后落地，评审专科阈值）──
// Whisper 退化循环的串面是开放集合（「优独播剧场YoYo」「与他配合肥16玫瑰院学校」
// 「Go to th」…），黑名单迭代追不上——按循环签名判窗：窗 ≥500 字符内取字符
// 8-gram，max_freq ≥250（长单元低频覆盖型，06 实测 295/窗）或主循环链覆盖 ≥0.5
// （短周期高占比型，5410328e 实测 0.988）判窗退化；退化窗字占全文 ≥40% → 整文件
// 拒绝（调用方按转写类失败记账，tries 走尽留 failed+原因=人工复核出口）；不足
// 40% → 告警放行（段级不做跨段链手术——聚合行级清扫归 scripts/purge-hallucinations.ts
// 按同签名做）。真实课堂复读上界（02「甜甜」×103、05 链覆盖 0.378）验证零误杀。

export interface DegenerateWindowInfo {
  startS: number;
  endS: number;
  chars: number;
  signature: string;
  maxFreq: number;
  chainCoverage: number;
}

export interface DegenerationReport {
  windows: DegenerateWindowInfo[];
  totalChars: number;
  degenerateChars: number;
  /** 退化窗字占全文比例，≥0.4 拒页 */
  coverage: number;
}

const GATE_WINDOW_S = 300;
const GATE_MIN_CHARS = 500;
const GATE_NGRAM = 8;
const GATE_FREQ = 250;
const GATE_CHAIN_COVERAGE = 0.5;
const GATE_REJECT_COVERAGE = 0.4;

/** 单窗判定：返回退化窗信息，健康窗返回 null。 */
export function analyzeWindowDegeneration(text: string): Omit<DegenerateWindowInfo, "startS" | "endS"> | null {
  const t = text.replace(/\s+/g, "");
  if (t.length < GATE_MIN_CHARS) return null;
  const freq = new Map<string, number>();
  for (let i = 0; i + GATE_NGRAM <= t.length; i++) {
    const g = t.slice(i, i + GATE_NGRAM);
    freq.set(g, (freq.get(g) ?? 0) + 1);
  }
  let signature = "", maxFreq = 0;
  for (const [g, f] of freq) if (f > maxFreq) { maxFreq = f; signature = g; }
  if (maxFreq === 0) return null;
  const freqCondemned = maxFreq >= GATE_FREQ;
  const cov = freqCondemned ? 1 : chainCoverageOf(t, signature); // freq 臂已判退化，覆盖臂不再参与
  if (!freqCondemned && cov < GATE_CHAIN_COVERAGE) return null;
  return { chars: t.length, signature, maxFreq, chainCoverage: cov };
}

/** 主导 8-gram 的循环链覆盖：按相邻出现间距的众数恢复周期，把周期连排段计为链，
 *  链字符 / 窗字符。近似实现——重叠 8-gram 在周期串里每周期命中一次，众数间距
 *  即单元长；非周期偶现不连排不计入。 */
function chainCoverageOf(t: string, g: string): number {
  const idx: number[] = [];
  for (let pos = t.indexOf(g); pos !== -1; pos = t.indexOf(g, pos + 1)) idx.push(pos);
  if (idx.length < 2) return idx.length === 1 ? g.length / t.length : 0;
  const gapCount = new Map<number, number>();
  for (let i = 1; i < idx.length; i++) {
    const d = idx[i] - idx[i - 1];
    gapCount.set(d, (gapCount.get(d) ?? 0) + 1);
  }
  let period = 0, best = 0;
  for (const [d, c] of gapCount) if (c > best || (c === best && d < period)) { best = c; period = d; }
  if (period <= 0) period = g.length;
  let covered = 0, runStart = idx[0], prev = idx[0];
  for (let i = 1; i <= idx.length; i++) {
    const cur = i < idx.length ? idx[i] : Number.NaN;
    if (i < idx.length && cur - prev === period) { prev = cur; continue; }
    covered += (prev - runStart) + period;
    if (i < idx.length) { runStart = cur; prev = cur; }
  }
  return Math.min(covered, t.length) / t.length;
}

/** 全文（按 300s 窗聚合）退化分析。 */
export function analyzeDegeneration(segments: Segment[]): DegenerationReport {
  const buckets = new Map<number, { startS: number; endS: number; parts: string[] }>();
  for (const seg of segments) {
    const b = Math.floor(seg.startS / GATE_WINDOW_S);
    let w = buckets.get(b);
    if (!w) { w = { startS: b * GATE_WINDOW_S, endS: (b + 1) * GATE_WINDOW_S, parts: [] }; buckets.set(b, w); }
    w.parts.push(seg.text);
  }
  const windows: DegenerateWindowInfo[] = [];
  let totalChars = 0;
  for (const w of buckets.values()) {
    const info = analyzeWindowDegeneration(w.parts.join(""));
    totalChars += info?.chars ?? w.parts.join("").replace(/\s+/g, "").length;
    if (info) windows.push({ ...info, startS: w.startS, endS: w.endS });
  }
  const degenerateChars = windows.reduce((a, x) => a + x.chars, 0);
  return { windows, totalChars, degenerateChars, coverage: totalChars > 0 ? degenerateChars / totalChars : 0 };
}

/** 拒页错误：带完整报告，调用方原样入 failed 行 error 字段（人工复核出口）。 */
export class DegenerationRejectError extends Error {
  report: DegenerationReport;
  constructor(report: DegenerationReport) {
    const sigs = report.windows
      .map(w => `[${fmtMMSS(w.startS)}]「${w.signature}」×${w.maxFreq}(链覆盖 ${w.chainCoverage.toFixed(2)})`)
      .join("；");
    super(`转写退化守门拒页：退化窗字占 ${(report.coverage * 100).toFixed(0)}% ≥${GATE_REJECT_COVERAGE * 100}%（${report.degenerateChars}/${report.totalChars} 字符）——须重转或人工复核。签名：${sigs}`);
    this.name = "DegenerationRejectError";
    this.report = report;
  }
}

/** 守门入口：拒页线以上抛 DegenerationRejectError；以下有退化窗则告警放行（清扫交 purge 脚本）。 */
export function runDegenerationGate(slug: string, segments: Segment[]): Segment[] {
  const report = analyzeDegeneration(segments);
  if (report.windows.length === 0) return segments;
  if (report.coverage >= GATE_REJECT_COVERAGE) throw new DegenerationRejectError(report);
  const sigs = report.windows.map(w => `[${fmtMMSS(w.startS)}]「${w.signature}」×${w.maxFreq}`).join("；");
  console.warn(`⚠ ${slug} 退化循环低于拒页线（窗字占 ${(report.coverage * 100).toFixed(0)}%）：${sigs} ——放行，存量清扫按同签名处理`);
  return segments;
}

const fmtMMSS = (s: number): string => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/**
 * 时间窗口判断，支持跨午夜（"23:00-08:00"）。分钟粒度：起点含、终点含（Task 6 r3：
 * 直区间与跨午夜两处端点均改为闭区间——"23:59-23:59" 这类单分钟窗口不再恒 false）。
 * 管线约定：窗口外打印"窗口结束，明日续跑"并 exit 0（CLI 层在每个文件处理前检查）。
 * 非法窗口串（缺端点/非数字/时>23/分>59）抛错——"23:00" 这类缺端点串若静默通过会被
 * 当成跨午夜窗口只跑 23:00-23:59 一小时，排查成本高（T15 评审遗留收口）。
 */
export function withinWindow(now: Date, windowStr: string): boolean {
  const parts = windowStr.split("-");
  if (parts.length !== 2) throw new Error(`非法窗口串: ${windowStr}`);
  const minutes = parts.map(part => {
    const m = /^(\d{1,2}):(\d{1,2})$/.exec(part);
    if (!m || +m[1] > 23 || +m[2] > 59) throw new Error(`非法窗口串: ${windowStr}`);
    return +m[1] * 60 + +m[2];
  });
  const [f, t] = minutes;
  const cur = now.getHours() * 60 + now.getMinutes();
  return f <= t ? cur >= f && cur <= t : cur >= f || cur <= t; // f > t 即跨午夜
}

export interface TranscribeOpts {
  wavPath: string;
  modelPath: string;
  prompt?: string;
  outJsonPath: string;
}

/** whisper-cli 参数序列。-mc 0：禁跨段文本上下文（默认 -1=保留全部——上一段幻觉
 *  喂进下一段正是退化滚雪球根因；whisper.cpp 无 --condition-on-previous-text，
 *  2026-09-07 评审核定等效参数）。-l auto：硬编码 zh 对中英混讲课例扭曲英文段；
 *  语言交由检测。--prompt 仍由调用方传双语锚（prompt 只条件解码器，不影响检测）。
 *  -of 取输出基名：whisper.cpp 会自行补 .json。 */
export function whisperArgs(o: TranscribeOpts): string[] {
  const args = ["-m", o.modelPath, "-f", o.wavPath, "-l", "auto", "-mc", "0"];
  if (o.prompt !== undefined) args.push("--prompt", o.prompt);
  args.push("-oj", "-of", o.outJsonPath.replace(/\.json$/, ""));
  return args;
}

/** spawn whisper-cli 转写并解析 segments。真实调用与速率见 Task 10（15.9x 实时）；不设 timeout——长音频按分钟计。 */
export async function runTranscribe(o: TranscribeOpts): Promise<Segment[]> {
  await execFileAsync("whisper-cli", whisperArgs(o), { maxBuffer: 50 * 1024 * 1024 });
  const raw = JSON.parse(readFileSync(o.outJsonPath, "utf-8"));
  return parseWhisperJson(raw);
}

// —— JSONL 状态机（断点续跑）——
export type TranscribeStatus = "pending" | "running" | "done" | "failed";

export interface StateLine {
  slug: string;
  wavSha: string;
  status: TranscribeStatus;
  tries: number;
  error?: string;
}

export const initLine = (slug: string, wavSha: string): StateLine =>
  ({ slug, wavSha, status: "pending", tries: 0 });

export function loadState(jlPath: string): StateLine[] {
  if (!existsSync(jlPath)) return [];
  return readFileSync(jlPath, "utf-8")
    .split("\n")
    .filter(l => l.trim() !== "")
    .map(l => JSON.parse(l) as StateLine);
}

/** 原子写（T15 评审遗留）：先写 temp 再 rename——并发读者（续跑诊断、tail -f）永不见半截 JSONL。 */
export function saveState(jlPath: string, lines: StateLine[]): void {
  const tmp = `${jlPath}.tmp`;
  writeFileSync(tmp, lines.map(l => JSON.stringify(l)).join("\n") + "\n");
  renameSync(tmp, jlPath);
}

/**
 * 下一个待处理行：pending 优先；failed 且 tries<2 可重试（单文件最多 2 次尝试）；
 * 崩溃残留的 running 也视为可续（但同样受 tries<2 上限——否则坏文件崩满两次后
 * 残留 running 会永久卡死队列头，T15 评审遗留收口）。
 * done 一律跳过（断点续跑核心）。--force 重置由 CLI 层重建全部行为 pending。
 */
export function nextPending(lines: StateLine[]): StateLine | undefined {
  return lines.find(l =>
    l.status === "pending" ||
    (l.status === "running" && l.tries < 2) ||
    (l.status === "failed" && l.tries < 2));
}
