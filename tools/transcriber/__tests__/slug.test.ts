// tools/transcriber/__tests__/slug.test.ts
import { describe, it, expect } from "vitest";
import { slugFor } from "../src/slug";
describe("slugFor", () => {
  it("确定性：同名+同 wavSha 同 slug；同内容跨目录 slug 不变；不同内容不同 slug", () => {
    expect(slugFor("01.提问.mp4", "ab12cd34")).toBe(slugFor("01.提问.mp4", "ab12cd34"));
    expect(slugFor("01.提问.mp4", "ab12cd34")).toBe(slugFor("01.提问.mp4", "ab12cd34")); // 同内容从主库迁到 HEVC：basename 与 wav 均不变
    expect(slugFor("01.提问.mp4", "ab12cd34")).not.toBe(slugFor("01.提问.mp4", "ff00ff00"));
  });
  it("净化：扩展名剥离、非法/分隔字符折叠为单个 -、首尾 - 修剪", () => {
    expect(slugFor("137. IBL-Inquiry based learning", "ab12cd34")).toBe("137-IBL-Inquiry-based-learning-ab12cd34");
    expect(slugFor("a  --  b.mp4", "ab12cd34")).toBe("a-b-ab12cd34");
    expect(slugFor("端<:>|.mp4", "ab12cd34")).toBe("端-ab12cd34"); // Windows 非法字符折叠，中文保留
  });
  it("中文化（2026-08-25）：CJK 保留进文件名，纯中文名不再落纯哈希", () => {
    expect(slugFor("01.提问.mp4", "ab12cd34")).toBe("01-提问-ab12cd34");
    expect(slugFor("当我们教词汇的时候，我们都在教什么？（二阶段）.mp4", "ab12cd34"))
      .toBe("当我们教词汇的时候-我们都在教什么-二阶段-ab12cd34");
    expect(slugFor("全部中文文件名.mp4", "ab12cd34")).toBe("全部中文文件名-ab12cd34");
  });
  it("全不可用字符仍仅内容指纹；CJK 长 stem 封顶 60 chars", () => {
    expect(slugFor("???***.mp4", "ab12cd34")).toBe("ab12cd34");
    const long = "字".repeat(80);
    expect(slugFor(`${long}.mp4`, "ab12cd34")).toBe(`${"字".repeat(60)}-ab12cd34`);
  });
});
