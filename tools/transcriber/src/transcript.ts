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

  const md = blocks.length === 0 ? `${transcriptFrontmatter(input)}\n` : `${transcriptFrontmatter(input)}\n\n${blocks.join("\n\n")}\n`;
  return { md, chapters };
}

/** frontmatter 构造（机械切分与语义切章共用——单一来源保证两种产物逐字节同构）。 */
export function transcriptFrontmatter(input: TranscriptInput): string {
  return [
    "---",
    `title: ${JSON.stringify(input.title)}`, // 双引号标量：吸收标题中的 ":"/"？" 等 YAML 敏感字符
    "type: transcript",
    `media_slug: ${input.mediaSlug}`,
    `duration_s: ${input.durationS}`,
    "sources:",
    `  - ${input.sourcePath}`,
    "---",
  ].join("\n");
}

export const ABSTRACT_HEADING = "课例摘要";

/** 中文课例摘要块插入（2026-09-08 门槛④）：置于 frontmatter 之后、首个章节之前
 *  ——检索锚放页首权重最高，观摩者最先读到。幂等：已有摘要块则原位替换
 *  （重生成/回填重跑不叠块）。frontmatter 缺失（空页形态）时置顶。
 *  纯字符串切片实现：replace 的 `$` 特殊符号与 multiline `$` 提前截断都是坑。 */
export function insertAbstract(md: string, abstract: string): string {
  const block = `## ${ABSTRACT_HEADING}\n\n${abstract.trim()}`;
  const head = `\n## ${ABSTRACT_HEADING}\n`;
  const start = md.indexOf(head);
  if (start !== -1) {
    const next = md.indexOf("\n## ", start + 1);
    const end = next === -1 ? md.length : next;
    return md.slice(0, start) + "\n" + block + (end === md.length ? "\n" : md.slice(end));
  }
  const fmEnd = md.indexOf("\n---\n", 1);
  if (fmEnd === -1) return `${block}\n\n${md}`;
  const after = fmEnd + "\n---\n".length;
  return `${md.slice(0, after)}\n\n${block}\n${md.slice(after).replace(/^\n+/, "")}`;
}
