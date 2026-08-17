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

export function scanDirectory(root: string, source: "main" | "hevc"): { files: ScannedFile[]; ignored: number } {
  const files: ScannedFile[] = [];
  let ignored = 0;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "__MACOSX" || entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (entry.name.startsWith("._")) continue;
      const ext = extname(entry.name).toLowerCase();
      const category = AUDIO_EXTS.has(ext) ? "audio"
        : VIDEO_EXTS.has(ext) ? "video"
        : DOC_EXTS.has(ext) ? "doc" : null;
      if (!category) { ignored++; continue; }
      files.push({ absPath: full, relPath: full.slice(root.length + 1), source, category, ext });
    }
  };
  walk(root);
  return { files, ignored };
}
