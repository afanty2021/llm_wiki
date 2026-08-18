// tools/transcriber/__tests__/transcript.test.ts
// buildTranscriptMd 纯函数（无 IO）
import { describe, it, expect } from "vitest";
import { buildTranscriptMd, mmss } from "../src/transcript";
import type { Segment } from "../src/whisper";

describe("buildTranscriptMd", () => {
  const segs = Array.from({ length: 130 }, (_, i) => ({ startS: i * 5, endS: i * 5 + 5, text: `句${i}` }));
  const { md, chapters } = buildTranscriptMd({ title: "提问的艺术", segments: segs, sourcePath: "sources/t1.md", mediaSlug: "t1", durationS: 650 });
  it("frontmatter 含 type/sources/media slug 经 sources 反规范化", () => {
    expect(md).toMatch(/^---\n/);
    expect(md).toContain("type: transcript");
    expect(md).toContain("sources:");
    expect(md).toContain("sources/t1.md");
  });
  it("章节 ~300s：650s → 3 章，label 取首句截断", () => {
    expect(chapters.length).toBe(3);
    expect(chapters[0]).toEqual({ start_s: 0, end_s: expect.any(Number), label: "句0" });
    expect(chapters[0].end_s).toBeGreaterThan(280);
  });
  it("正文时间戳 [mm:ss] 单调", () => {
    const stamps = [...md.matchAll(/\[(\d{2}):(\d{2})\]/g)].map(m => +m[1] * 60 + +m[2]);
    expect(stamps.length).toBeGreaterThanOrEqual(3);
    expect([...stamps].sort((a, b) => a - b)).toEqual(stamps);
  });
  it("章节边界与窗内文本：300/600 切窗，每章正文含该窗全部句", () => {
    expect(chapters.map(c => c.start_s)).toEqual([0, 300, 600]);
    expect(chapters.map(c => c.end_s)).toEqual([300, 600, 650]);
    expect(md).toContain("句0");
    expect(md).toContain("句59");
    expect(md).toContain("句60");
    expect(md).toContain("句129");
    expect(chapters[1].label).toBe("句60");
    expect(chapters[2].label).toBe("句120");
  });
  it("label 首句去空白截 40 字", () => {
    const long: Segment[] = [
      { startS: 0, endS: 5, text: ` ${"字".repeat(100)}` },
      { startS: 6, endS: 9, text: "尾句" },
    ];
    const r = buildTranscriptMd({ title: "t", segments: long, sourcePath: "s.md", mediaSlug: "m", durationS: 9 });
    expect(r.chapters[0].label).toBe("字".repeat(40));
  });
  it("空 segments：frontmatter 仍产出、零章节、无时间戳", () => {
    const r = buildTranscriptMd({ title: "空", segments: [], sourcePath: "s.md", mediaSlug: "m", durationS: 0 });
    expect(r.md).toMatch(/^---\n/);
    expect(r.md).toContain("type: transcript");
    expect(r.chapters).toEqual([]);
    expect([...r.md.matchAll(/\[\d{2}:\d{2}\]/g)]).toHaveLength(0);
  });
});

describe("mmss", () => {
  it("秒 → [mm:ss]（分秒各补零到 2 位；≥100 分钟不截断）", () => {
    expect(mmss(0)).toBe("[00:00]");
    expect(mmss(5)).toBe("[00:05]");
    expect(mmss(65)).toBe("[01:05]");
    expect(mmss(3000)).toBe("[50:00]");
    expect(mmss(10800)).toBe("[180:00]");
  });
});
