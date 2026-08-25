// tools/transcriber/src/slug.ts

/**
 * transcript 页 slug = 净化 basename + "-" + wav 的 SHA-256 前 8 hex。
 * 必须在音频抽取之后调用——slug 随内容稳定，不随目录迁移漂移：
 * 同一文件从主库迁到 HEVC 时 relPath 变、但 basename 与 wav 指纹不变，slug 不变（幂等写入的关键）。
 *
 * 2026-08-25 中文化（M4 前决策）：字符集扩至 CJK（\u4e00-\u9fff 基本区 + \u3400-\u4dbf 扩展A）。
 * 旧规则纯中文名净化为空 → 落 8 位纯哈希（存量 39 个 `06ad7ef1.md` 形），未来 ~1200+ 视频
 * 大片纯中文名，改规则使文件名可读。Windows 非法字符/控制符/空格标点照旧折叠为 -；
 * CJK 长 stem 封顶 60 chars 防超长路径。已转写内容的幂等性由 cli.ts 的 state wavSha 桥
 * 保证（同 sha 沿用旧 slug），不依赖本函数跨版本不变。
 */
export function slugFor(basename: string, wavSha8: string): string {
  // 真扩展名（短且无空白），避免把 "137. IBL-Inquiry based learning" 的句点当扩展名分隔符（同 manifest.ts 的教训）
  const stem = basename.replace(/\.[A-Za-z0-9]{1,6}$/, "");
  const clean = stem
    .replace(/[^a-zA-Z0-9\u4e00-\u9fff\u3400-\u4dbf]+/g, "-") // 非 [字母/数字/CJK]（含空格、中西标点、Windows 非法字符、控制符）折叠为单个 -
    .replace(/^-+|-+$/g, ""); // 首尾 - 修剪
  if (clean === "") return wavSha8; // 全不可用字符：仅内容指纹，仍唯一且稳定
  const capped = Array.from(clean).slice(0, 60).join("");
  return `${capped}-${wavSha8}`;
}
