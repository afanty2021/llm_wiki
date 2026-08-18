// tools/transcriber/src/slug.ts

/**
 * transcript 页 slug = 净化 basename + "-" + wav 的 SHA-256 前 8 hex。
 * 必须在音频抽取之后调用——slug 随内容稳定，不随目录迁移漂移：
 * 同一文件从主库迁到 HEVC 时 relPath 变、但 basename 与 wav 指纹不变，slug 不变（幂等写入的关键）。
 */
export function slugFor(basename: string, wavSha8: string): string {
  // 真扩展名（短且无空白），避免把 "137. IBL-Inquiry based learning" 的句点当扩展名分隔符（同 manifest.ts 的教训）
  const stem = basename.replace(/\.[A-Za-z0-9]{1,6}$/, "");
  const clean = stem
    .replace(/[^a-zA-Z0-9]+/g, "-") // 非 [a-zA-Z0-9]（含中文、空格、标点）折叠为单个 -
    .replace(/^-+|-+$/g, ""); // 首尾 - 修剪
  return clean === "" ? wavSha8 : `${clean}-${wavSha8}`; // 全中文名：主干净化为空 → 仅内容指纹，仍唯一且稳定
}
