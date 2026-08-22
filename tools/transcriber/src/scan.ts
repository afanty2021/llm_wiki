// tools/transcriber/src/scan.ts
import { readdirSync } from "node:fs";
import { join, extname } from "node:path";

export const AUDIO_EXTS = new Set([".mp3", ".m4a", ".wma", ".wav", ".flac", ".aac"]);
export const VIDEO_EXTS = new Set([".mp4", ".mov", ".vob", ".mkv", ".avi", ".flv", ".wmv", ".m4v"]);
export const DOC_EXTS = new Set([".pdf", ".pptx", ".docx", ".md"]);

export interface ScannedFile {
  absPath: string;
  relPath: string;
  source: "main" | "hevc";
  category: "audio" | "video" | "doc";
  ext: string;
}

// 返回 files（登记扩展名）+ ignoredPaths（未登记扩展名文件的绝对路径，供 CLI 救援扫描用；
// __MACOSX / 隐藏文件 / ._ 资源叉仍无条件排除且不出现在 ignoredPaths）
export function scanDirectory(root: string, source: "main" | "hevc"): { files: ScannedFile[]; ignoredPaths: string[] } {
  const files: ScannedFile[] = [];
  const ignoredPaths: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      // "." 前缀过滤已一并覆盖 ._ AppleDouble 资源叉（其必然以 . 开头），无需单列分支
      if (entry.name === "__MACOSX" || entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      const ext = extname(entry.name).toLowerCase();
      const category = AUDIO_EXTS.has(ext) ? "audio"
        : VIDEO_EXTS.has(ext) ? "video"
        : DOC_EXTS.has(ext) ? "doc" : null;
      if (!category) { ignoredPaths.push(full); continue; }
      files.push({ absPath: full, relPath: full.slice(root.length + 1), source, category, ext });
    }
  };
  walk(root);
  return { files, ignoredPaths };
}
