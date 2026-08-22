// tools/transcriber/__tests__/probe.test.ts
import { describe, it, expect } from "vitest";
import { parseProbe } from "../src/probe";

const mp4Json = {
  streams: [
    { codec_type: "video", codec_name: "h264" },
    { codec_type: "audio", codec_name: "aac" },
  ],
  format: { duration: "1854.236", format_name: "mov,mp4,m4a,3gp,3g2,mj2" },
};
const vobJson = {
  streams: [
    { codec_type: "video", codec_name: "mpeg2video" },
    { codec_type: "audio", codec_name: "mp2" },
  ],
  format: { duration: "612.5", format_name: "mpeg" },
};
const wmaJson = {
  streams: [{ codec_type: "audio", codec_name: "wmav2" }],
  format: { duration: "90.0", format_name: "asf" },
};

describe("parseProbe", () => {
  it("mp4：容器取 format_name 首段 mov，编码 h264/aac，时长取整", () => {
    expect(parseProbe(mp4Json)).toEqual({
      durationS: 1854, container: "mov", videoCodec: "h264", audioCodec: "aac",
    });
  });
  it("VOB：mpeg2video/mp2 → 桶 B 输入", () => {
    expect(parseProbe(vobJson).videoCodec).toBe("mpeg2video");
    expect(parseProbe(vobJson).container).toBe("mpeg");
  });
  it("wma 纯音频：videoCodec 为 null", () => {
    expect(parseProbe(wmaJson)).toEqual({
      durationS: 90, container: "asf", videoCodec: null, audioCodec: "wmav2",
    });
  });
  it("缺 duration 容错为 0", () => {
    expect(parseProbe({ streams: [], format: {} }).durationS).toBe(0);
  });
});
