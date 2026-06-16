#!/usr/bin/env node
// OKF v0.1 合规校验器（零依赖，纯 Node）
//
// 依据: https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md
// 用法: node scripts/validate-okf.mjs <bundle-dir> [--soft]
//   <bundle-dir>  一个 OKF bundle 根目录（本项目的 wiki/ 目录即视作 bundle root）
//   --soft        同时输出软性（推荐）建议；默认只判硬性合规
//
// 退出码: 0 = conformant（硬性全过）, 1 = non-conformant, 2 = 用法错误
//
// 硬性规则（§9 Conformance）：
//   C1  每个非保留 .md 文件含可解析 YAML frontmatter
//   C2  每个 frontmatter 块含非空 type 字段
//   C3a index.md 不含 frontmatter（唯一例外: bundle-root index.md 仅声明 okf_version）
//   C3b log.md 遵循 §7 结构（date heading 为 ISO 8601 YYYY-MM-DD）
// 软性规则（§4.1 推荐 / §5 链接 / §8 citation / §11 版本声明）仅在 --soft 时报告

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, basename } from "node:path";

const RESERVED = new Set(["index.md", "log.md"]);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME =
  /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (name.endsWith(".md")) out.push(p);
  }
  return out;
}

// 解析 frontmatter：返回 { hasFm, fields, body, defect }
//   defect: 'none' | 'leading-blank' | 'missing-fence' | 'none-at-all'
// 故意不引 YAML 库——frontmatter 足够简单，逐行 key: value 即可。
// 严格遵循 §4.1 "delimited by --- at the start of the file"：前导空行 / 缺开头围栏
// 均判 hasFm=false（违规），但 defect 字段精确区分修复难度。
function parseFields(payload) {
  const fields = new Map();
  for (const line of payload.split(/\r?\n/)) {
    const mm = line.match(/^([A-Za-z0-9_-]+)[ \t]*:[ \t]*(.*)$/);
    if (mm) fields.set(mm[1], mm[2].trim());
  }
  return fields;
}
function parseFrontmatter(content) {
  // 严格：首字符即 ---
  const strict = content.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (strict) return { hasFm: true, fields: parseFields(strict[1]), body: content.slice(strict[0].length), defect: "none" };
  // 诊断：前导空白/空行后才出现 ---（实际有 fm 内容，strip 即修复）
  const leading = content.match(/^[ \t\r\n]*---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (leading) return { hasFm: false, fields: parseFields(leading[1]), body: content.slice(leading[0].length), defect: "leading-blank" };
  // 诊断：有 key: value 行但无 --- 围栏（损坏，补开头 --- 即修复）
  if (/^[A-Za-z0-9_-]+[ \t]*:[ \t]/m.test(content.slice(0, 512))) {
    return { hasFm: false, fields: new Map(), body: content, defect: "missing-fence" };
  }
  return { hasFm: false, fields: new Map(), body: content, defect: "none-at-all" };
}

function isBundleRootIndex(absPath, bundleDir) {
  return basename(absPath) === "index.md" && dirname_abs(absPath) === bundleDir;
}
function dirname_abs(p) {
  // 用 split 而非 path.dirname，避免依赖——但 path 已 import，直接用更稳
  return p.split(/[\\/]/).slice(0, -1).join("/");
}

// 统计 body 中的链接形态（用于 §5 软性检查）
function linkShapes(body) {
  const wikilinks = (body.match(/!?\[\[([^\]]+)\]\]/g) || []).filter(
    (x) => !x.startsWith("!")
  ).length;
  const mdlinks = (body.match(/\[[^\]]+\]\((?!http|https|#|mailto)[^)]+\)/g) || [])
    .length;
  return { wikilinks, mdlinks };
}

function main() {
  const args = process.argv.slice(2);
  const soft = args.includes("--soft");
  const dirArg = args.find((a) => !a.startsWith("--"));
  if (!dirArg) {
    console.error("用法: node scripts/validate-okf.mjs <bundle-dir> [--soft]");
    process.exit(2);
  }
  const bundleDir = dirArg.replace(/\/$/, "");
  let files;
  try {
    files = walk(bundleDir);
  } catch (e) {
    console.error(`无法读取目录: ${bundleDir}\n${e.message}`);
    process.exit(2);
  }

  const errors = []; // 硬性违规
  const warns = []; // 软性建议
  const infos = [];
  let conceptCount = 0;
  let reservedCount = 0;

  for (const abs of files) {
    const rel = relative(bundleDir, abs).replace(/\\/g, "/");
    const name = basename(abs);
    const isReserved = RESERVED.has(name);
    const content = readFileSync(abs, "utf8");
    const { hasFm, fields, body, defect } = parseFrontmatter(content);

    if (isReserved) {
      reservedCount++;
      // C3a: index.md 不含 frontmatter，bundle-root 仅允许 okf_version
      if (name === "index.md") {
        if (hasFm) {
          const keys = [...fields.keys()];
          const root = isBundleRootIndex(abs, bundleDir);
          const onlyVersion =
            keys.length === 1 && keys[0] === "okf_version";
          if (root && onlyVersion) {
            // §11 合规的 bundle-root index.md
          } else {
            errors.push({
              file: rel,
              rule: "C3a/§6",
              msg: `index.md 含 frontmatter [${keys.join(", ")}]；§6 规定 index files 不含 frontmatter（仅 bundle-root index.md 可声明 okf_version）`,
            });
          }
        }
      }
      // C3b: log.md date heading 须为 YYYY-MM-DD
      if (name === "log.md") {
        for (const line of body.split(/\r?\n/)) {
          const hm = line.match(/^##\s+(.+?)\s*$/);
          if (!hm) continue;
          const head = hm[1];
          // §7: date headings MUST use ISO 8601 YYYY-MM-DD
          if (head.startsWith("[")) {
            errors.push({
              file: rel,
              rule: "C3b/§7",
              msg: `log.md 标题 "${head}" 不是纯 YYYY-MM-DD（含方括号/后缀）`,
            });
          } else if (!ISO_DATE.test(head) && /^\[?\d{4}-\d{2}-\d{2}/.test(head)) {
            errors.push({
              file: rel,
              rule: "C3b/§7",
              msg: `log.md 标题 "${head}" 不是纯 YYYY-MM-DD`,
            });
          }
        }
      }
      continue; // 保留文件不做 concept 检查
    }

    // —— concept 文件 ——
    conceptCount++;

    // C1: frontmatter 必须在文件起始（§4.1 "at the start of the file"）
    if (!hasFm) {
      const detail =
        defect === "leading-blank" ? "前导空行后才有 frontmatter（实际有 fm 内容，strip 前导空行即修复）"
        : defect === "missing-fence" ? "有 frontmatter 字段但缺开头 --- 分隔符（损坏，补围栏即修复）"
        : "完全无 frontmatter 内容";
      errors.push({ file: rel, rule: "C1/§4.1", msg: `frontmatter 不在文件起始：${detail}` });
      // 格式缺陷但仍可能含 type 字段——继续 C2 诊断，不跳过
    }
    // C2: 必须有非空 type
    const type = fields.get("type");
    if (!type || !type.trim()) {
      errors.push({ file: rel, rule: "C2/§4.1", msg: "frontmatter 缺少非空 type 字段" });
    }

    if (soft) {
      const ts = fields.get("timestamp");
      if (!ts) {
        // 本项目用 created/updated——映射提示
        const alt = fields.get("updated") || fields.get("created");
        warns.push({
          file: rel,
          rule: "§4.1 timestamp",
          msg: alt
            ? `无 timestamp（本项目用 ${alt}）；OKF 推荐 ISO 8601 datetime，如 2026-06-16T00:00:00Z`
            : "无 timestamp；OKF 推荐 ISO 8601 datetime",
        });
      } else if (!ISO_DATETIME.test(ts)) {
        warns.push({ file: rel, rule: "§4.1 timestamp", msg: `timestamp "${ts}" 不是 ISO 8601 datetime` });
      }

      if (!fields.has("description")) {
        warns.push({ file: rel, rule: "§4.1 description", msg: "无 description（index/search snippet 会缺摘要）" });
      }
      if (!fields.has("resource")) {
        infos.push({ file: rel, rule: "§4.1 resource", msg: "无 resource（抽象概念可缺省，资源类概念建议补 URI）" });
      }

      const { wikilinks, mdlinks } = linkShapes(body);
      if (wikilinks > 0 && mdlinks === 0) {
        warns.push({
          file: rel,
          rule: "§5 links",
          msg: `body 仅用 ${wikilinks} 个 [[wikilink]]，无标准 markdown link；OKF consumer 抽不到关系图`,
        });
      }

      if (!/# Citations/i.test(body)) {
        infos.push({ file: rel, rule: "§8 citations", msg: "无 # Citations section（本项目的 frontmatter sources[] 已部分覆盖该语义）" });
      }
    }
  }

  if (soft) {
    const rootIndex = join(bundleDir, "index.md");
    try {
      const c = readFileSync(rootIndex, "utf8");
      const { hasFm, fields } = parseFrontmatter(c);
      if (!hasFm || !fields.has("okf_version")) {
        infos.push({ file: "index.md", rule: "§11 versioning", msg: "bundle-root index.md 未声明 okf_version: \"0.1\"" });
      }
    } catch {
      infos.push({ file: "index.md", rule: "§11 versioning", msg: "bundle-root 无 index.md（可选，但建议声明 okf_version）" });
    }
  }

  // —— 报告 ——
  const conformant = errors.length === 0;
  console.log(`OKF v0.1 合规校验: ${bundleDir}`);
  console.log(`  concept 文件: ${conceptCount} | 保留文件: ${reservedCount}`);
  console.log(`  判定: ${conformant ? "✅ CONFORMANT" : "❌ NON-CONFORMANT"}（${errors.length} 硬性违规）`);
  console.log("");

  if (errors.length) {
    console.log("── 硬性违规（必须修复才能宣称合规）──");
    for (const e of errors) console.log(`  [${e.rule}] ${e.file}: ${e.msg}`);
    console.log("");
  }
  if (soft && warns.length) {
    console.log(`── 软性建议（${warns.length}，影响互操作质量，不影响合规判定）──`);
    const shown = warns.slice(0, 30);
    for (const w of shown) console.log(`  [${w.rule}] ${w.file}: ${w.msg}`);
    if (warns.length > 30) console.log(`  ... 另有 ${warns.length - 30} 条同类建议`);
    console.log("");
  }
  if (soft && infos.length) {
    console.log(`── 信息（${infos.length}）──`);
    for (const i of infos.slice(0, 10)) console.log(`  [${i.rule}] ${i.file}: ${i.msg}`);
    if (infos.length > 10) console.log(`  ... 另有 ${infos.length - 10} 条`);
    console.log("");
  }

  process.exit(conformant ? 0 : 1);
}

main();
