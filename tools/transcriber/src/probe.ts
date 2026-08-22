// tools/transcriber/src/probe.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ProbeResult {
  durationS: number;
  container: string;
  videoCodec: string | null;
  audioCodec: string | null;
}

export function parseProbe(json: unknown): ProbeResult {
  const j = json as { streams?: Array<{ codec_type?: string; codec_name?: string }>; format?: { duration?: string; format_name?: string } };
  const video = j.streams?.find(s => s.codec_type === "video");
  const audio = j.streams?.find(s => s.codec_type === "audio");
  const fmt = j.format?.format_name ?? "";
  return {
    durationS: Math.round(parseFloat(j.format?.duration ?? "0") || 0),
    container: fmt.split(",")[0],
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
  };
}

export async function probeMedia(absPath: string): Promise<ProbeResult> {
  const { stdout } = await execFileAsync(
    "ffprobe",
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", absPath],
    { maxBuffer: 10 * 1024 * 1024, timeout: 30_000 },
  );
  return parseProbe(JSON.parse(stdout));
}
