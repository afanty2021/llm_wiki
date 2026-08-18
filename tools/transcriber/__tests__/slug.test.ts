// tools/transcriber/__tests__/slug.test.ts
import { describe, it, expect } from "vitest";
import { slugFor } from "../src/slug";
describe("slugFor", () => {
  it("确定性：同名+同 wavSha 同 slug；同内容跨目录（wavSha 同、basename 同）slug 不变", () => {
    expect(slugFor("01.提问.mp4", "ab12cd34")).toBe(slugFor("01.提问.mp4", "ab12cd34"));
    expect(slugFor("01.提问.mp4", "ab12cd34")).toBe(slugFor("01.提问.mp4", "ab12cd34")); // 同内容从主库迁到 HEVC：basename 与 wav 均不变
    expect(slugFor("01.提问.mp4", "ab12cd34")).not.toBe(slugFor("01.提问.mp4", "ff00ff00"));
    expect(slugFor("01.提问.mp4", "ab12cd34")).toMatch(/^[a-zA-Z0-9-]+$/);
  });
  it("净化：扩展名剥离、非 [a-zA-Z0-9] 折叠为单个 -、首尾 - 修剪", () => {
    expect(slugFor("01.提问.mp4", "ab12cd34")).toBe("01-ab12cd34");
    expect(slugFor("137. IBL-Inquiry based learning", "ab12cd34")).toBe("137-IBL-Inquiry-based-learning-ab12cd34");
    expect(slugFor("全部中文文件名.mp4", "ab12cd34")).toBe("ab12cd34"); // 主干净化为空 → 仅内容指纹，仍唯一且稳定
    expect(slugFor("句 全中文名.mp4", "ff00ff00")).not.toContain("句");
  });
});
