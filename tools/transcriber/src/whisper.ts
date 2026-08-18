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

/** whisper.cpp `-oj` 输出 → Segment[]（offsets 毫秒 → 秒；text 去首尾空白）。容错：缺 transcription 字段返回 []。 */
export function parseWhisperJson(raw: unknown): Segment[] {
  const j = raw as { transcription?: Array<{ offsets?: { from?: number; to?: number }; text?: string }> };
  return (j.transcription ?? []).map(t => ({
    startS: (t.offsets?.from ?? 0) / 1000,
    endS: (t.offsets?.to ?? 0) / 1000,
    text: (t.text ?? "").trim(),
  }));
}

/**
 * 时间窗口判断，支持跨午夜（"23:00-08:00"）。分钟粒度：起点含、终点不含。
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
  return f <= t ? cur >= f && cur < t : cur >= f || cur < t; // f > t 即跨午夜
}

export interface TranscribeOpts {
  wavPath: string;
  modelPath: string;
  prompt?: string;
  outJsonPath: string;
}

/** whisper-cli 参数序列（Task 10 冒烟已验证的形态）。-of 取输出基名：whisper.cpp 会自行补 .json。 */
export function whisperArgs(o: TranscribeOpts): string[] {
  const args = ["-m", o.modelPath, "-f", o.wavPath, "-l", "zh"];
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
