// tools/transcriber/src/transcript.ts
import type { Segment } from "./whisper";

export interface Chapter {
  start_s: number;
  end_s: number;
  label: string;
}

export interface TranscriptInput {
  title: string;
  segments: Segment[];
  sourcePath: string;
  mediaSlug: string;
  durationS: number;
}

export const CHAPTER_WINDOW_S = 300; // ~300s 章节聚合窗
export const LABEL_MAX = 40;        // 章节 label 截断长度

/** 秒 → "[mm:ss]"。分/秒各补零到 2 位；≥100 分钟不截断（正则 \d{2} 匹配不到 3 位分，但长课程可读性优先）。 */
export function mmss(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `[${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}]`;
}

/**
 * 转写包装（纯函数）：frontmatter（title / type: transcript / media slug 经 sources 反规范化引用源文档）
 * + 每窗一段正文——"[mm:ss] 起始 + 该窗文本行"。
 * 章节按 ~300s 固定边界分窗（锚定 0 点）：start_s/end_s 取窗内首/末 segment 的实际时刻，
 * label = 窗内首句去空白截 40 字。空窗（无 segment 的 300s 段）不生成章节。
 */
export function buildTranscriptMd(input: TranscriptInput): { md: string; chapters: Chapter[] } {
  const windows = new Map<number, Segment[]>();
  // 防御性排序（T15 评审遗留）：whisper -oj 理论有序，但坏输出/手改 JSON 乱序时章节也会保持时间升序
  for (const seg of [...input.segments].sort((a, b) => a.startS - b.startS)) {
    const w = Math.floor(seg.startS / CHAPTER_WINDOW_S);
    const bucket = windows.get(w) ?? [];
    bucket.push(seg);
    windows.set(w, bucket);
  }

  const chapters: Chapter[] = [];
  const blocks: string[] = [];
  for (const w of [...windows.keys()].sort((a, b) => a - b)) {
    const segs = windows.get(w)!;
    const startS = segs[0].startS;
    const endS = segs[segs.length - 1].endS;
    const label = segs[0].text.trim().slice(0, LABEL_MAX);
    chapters.push({ start_s: startS, end_s: endS, label });
    const stamp = mmss(startS);
    blocks.push(`## ${stamp} ${label}`);
    blocks.push(`${stamp} ${segs.map(s => s.text).join(" ")}`);
  }

  const fm = [
    "---",
    `title: ${JSON.stringify(input.title)}`, // 双引号标量：吸收标题中的 ":"/"？" 等 YAML 敏感字符
    "type: transcript",
    `media_slug: ${input.mediaSlug}`,
    `duration_s: ${input.durationS}`,
    "sources:",
    `  - ${input.sourcePath}`,
    "---",
  ].join("\n");

  const md = blocks.length === 0 ? `${fm}\n` : `${fm}\n\n${blocks.join("\n\n")}\n`;
  return { md, chapters };
}
