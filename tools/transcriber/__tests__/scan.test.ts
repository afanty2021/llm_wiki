// tools/transcriber/__tests__/scan.test.ts
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterAll } from "vitest";
import { scanDirectory } from "../src/scan";

const root = mkdtempSync(join(tmpdir(), "m0-scan-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("scanDirectory", () => {
  it("分类音视频与文档，保留相对路径", () => {
    mkdirSync(join(root, "专栏A"), { recursive: true });
    writeFileSync(join(root, "专栏A", "01.课程.mp4"), "x");
    writeFileSync(join(root, "b.mp3"), "x");
    writeFileSync(join(root, "c.pdf"), "x");
    const { files } = scanDirectory(root, "main");
    const mp4 = files.find(f => f.relPath === "专栏A/01.课程.mp4");
    expect(mp4).toMatchObject({ category: "video", ext: ".mp4", source: "main" });
    expect(files.find(f => f.relPath === "b.mp3")?.category).toBe("audio");
    expect(files.find(f => f.relPath === "c.pdf")?.category).toBe("doc");
  });

  it("排除 __MACOSX、隐藏文件与 ._ 资源叉（不计入 ignored）", () => {
    mkdirSync(join(root, "__MACOSX", "sub"), { recursive: true });
    writeFileSync(join(root, "__MACOSX", "sub", "junk.mp4"), "x");
    writeFileSync(join(root, "._hidden.mp4"), "x");
    writeFileSync(join(root, ".DS_Store"), "x");
    const { files, ignored } = scanDirectory(root, "main");
    expect(files.some(f => f.relPath.includes("__MACOSX"))).toBe(false);
    expect(files.some(f => f.relPath.startsWith("._"))).toBe(false);
    expect(ignored).toBe(0);
  });

  it("未登记扩展名计入 ignored，不静默丢弃", () => {
    writeFileSync(join(root, "note.txt"), "x");
    writeFileSync(join(root, "cover.jpg"), "x");
    const { files, ignored } = scanDirectory(root, "main");
    expect(files.some(f => f.relPath === "note.txt")).toBe(false);
    expect(ignored).toBe(2);
  });
});
