// scripts/check-web-bundle.mjs
// web 形态产物自检（2026-11-26，评审 R1 建议 3）：`npm run build:web` 的产物必须是 web 形态。
// 钉的是 API base 的取值来源：api-client chunk 里 `resolveApiBase(<实参>)` 的实参必须是取自
// .env.web 的字符串字面量（现为空串 = 同源相对请求），不能是桌面形态的 `void 0`——那会回落
// http://localhost:8080，正是 N-2 的线上症状（桌面形态写进 dist/ 后 :8080 被静默换形）。
// 用法: node scripts/check-web-bundle.mjs [产物目录=dist]（CI 在 npm run build:web 之后跑）
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const distDir = process.argv[2] ?? "dist";
const assetsDir = join(distDir, "assets");

const fail = (message) => {
  console.error(`✗ web 形态自检失败（${distDir}）：${message}`);
  process.exit(1);
};

let chunks;
try {
  chunks = readdirSync(assetsDir).filter((name) => /^api-client-[\w-]+\.js$/.test(name));
} catch {
  fail(`读不到 ${assetsDir}（先跑 npm run build:web）`);
}
if (chunks.length !== 1) {
  fail(`${assetsDir} 下 api-client chunk 应恰有 1 个，实际 ${chunks.length} 个`);
}

const code = readFileSync(join(assetsDir, chunks[0]), "utf8");
// src/lib/api-client.ts:
//   export function resolveApiBase(base?: string) { return base ?? "http://localhost:8080" }
//   export const API_BASE = resolveApiBase(import.meta.env.VITE_API_BASE_URL)
// 压缩后变量名随构建变、结构不变，形如
//   function n(e){return e??`http://localhost:8080`}var r=n(<实参>)
const call = /function \w+\(\w+\)\{return \w+\?\?["'`]http:\/\/localhost:8080["'`]\}var \w+=\w+\(([^)]*)\)/.exec(code);
if (call === null) {
  fail(`${chunks[0]} 里找不到 resolveApiBase 的定义与调用处（源码或压缩器输出结构变了，同步改本脚本）`);
}
const arg = call[1];
if (arg === "void 0") {
  fail("API base 实参是 void 0（桌面形态，回落 localhost:8080）——.env.web 没被加载，或构建没带 --mode web");
}
if (!/^("[^"]*"|'[^']*'|`[^`$\\]*`)$/.test(arg)) {
  fail(`API base 实参不是字符串字面量：${arg}`);
}
const sameOrigin = arg === '""' || arg === "''" || arg === "``";
console.log(`✓ web 形态自检通过：${chunks[0]} 的 API base 是字符串字面量${sameOrigin ? "（空串 = 同源）" : ""}`);
