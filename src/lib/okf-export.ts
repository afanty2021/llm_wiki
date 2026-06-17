// OKF v0.1 导出层：把 wiki bundle 只读转换为 OKF-conformant bundle。
//
// 依据 https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md
// 仅做硬性转换（frontmatter 格式修复 / timestamp 注入 / index.md & log.md 规整）。
// 不做 description/resource 派生（P2）。wikilink 双写（P1）已实现。
//
// ⚠️ 本模块**仅 CLI/Node/test 可用**：顶层 `import { ... } from "node:fs"` 与
// `node:path`。app webview（client bundle）**禁止**直接或间接 import 本模块——
// Vite 会把 node:* externalize 给 client，运行时报
// "Cannot access node:fs.readdirSync" 并白屏。
//
// 纯转换函数（无 node 依赖、client-safe）已抽到 {@link ./okf-convert}。
// client 入口（okf-export-section → okf-export-tauri）应 import okf-convert，
// 不应 import 本文件。本文件下方 `export ... from "./okf-convert"` 仅为保持
// okf-export.test.ts 的现有 import 不破（re-export 不会把 node:fs 拉进依赖本文件
// 符号的下游，因为测试在 node 环境跑；但若被 client import 仍会触发外部化）。

import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync, existsSync } from "node:fs"
import { join, relative, dirname, basename } from "node:path"

// ──────────────────────────────────────────────────────────────────
// 纯函数 re-export（从 okf-convert）
// ──────────────────────────────────────────────────────────────────
// 保留 okf-export.test.ts 与历史调用方的不破：测试 import 的是 ./okf-export，
// 通过 re-export 拿到纯函数。注意：被 client import 仍是危险的（会拉入本文件
// 顶层的 node:fs），故 client 链必须走 ./okf-convert。
export {
  isAbsoluteLike,
  classifyFrontmatter,
  deriveTimestamp,
  convertBundleRootIndex,
  convertSubdirIndex,
  normalizeLogContent,
  convertConcept,
  pickTimestampFromFields,
  mtimeDate,
  NO_CLOSING_FENCE,
  RESERVED,
  buildSlugIndex,
  doubleWriteWikilinks,
  doubleWriteContent,
} from "./okf-convert"
export type { ExportReport, SlugIndex } from "./okf-convert"

// ──────────────────────────────────────────────────────────────────
// exportOkfBundle — 端到端（node:fs 版，仅 CLI/test）
// ──────────────────────────────────────────────────────────────────

import {
  RESERVED as _RESERVED,
  isAbsoluteLike as _isAbsoluteLike,
  convertBundleRootIndex as _convertBundleRootIndex,
  convertSubdirIndex as _convertSubdirIndex,
  normalizeLogContent as _normalizeLogContent,
  convertConcept as _convertConcept,
  buildSlugIndex as _buildSlugIndex,
  doubleWriteContent as _doubleWriteContent,
  type ExportReport as _ExportReport,
} from "./okf-convert"

/**
 * 递归收集所有 .md 文件（相对 wikiDir 的绝对路径）。
 *
 * 行为说明：
 * - 跳过符号链接（`statSync().isSymbolicLink()`），防止循环链接导致无限递归或源污染。
 * - 跳过 `node_modules` 与以 `.` 开头的目录/文件。
 *
 * IO 错误（如权限拒绝、目录消失）会抛出异常；调用方需自行 try/catch。
 */
function walkMarkdown(dir: string, base: string = dir): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue
    const p = join(dir, name)
    const s = statSync(p)
    if (s.isSymbolicLink()) continue
    if (s.isDirectory()) out.push(...walkMarkdown(p, base))
    else if (name.endsWith(".md")) out.push(p)
  }
  return out
}

/**
 * 端到端导出：把 wikiDir 只读转换为 OKF-conformant bundle，写入 outDir。
 *
 * 安全约束：
 * - 源 wiki 只读，源文件内容（含任何 UTF-8 BOM）会被 strip 后再分类/转换，但不会写回源。
 * - 若 outDir 是 wikiDir 本身或其子目录，会抛出 Error，防止导出产物污染源 wiki。
 *
 * IO 错误（如 walkMarkdown / readFileSync / writeFileSync 失败）会向上抛出；
 * 调用方需自行 try/catch 并清理临时目录。
 */
export async function exportOkfBundle(wikiDir: string, outDir: string): Promise<_ExportReport> {
  const report: _ExportReport = { written: 0, concepts: 0, reserved: 0, warnings: [] }
  if (!existsSync(wikiDir)) {
    throw new Error(`wikiDir 不存在: ${wikiDir}`)
  }
  // I1: 防止 outDir 落在 wikiDir 内（含相等），避免源被污染
  // path.relative(wikiDir, outDir) 返回：
  //   ""              → 两者相等
  //   ".."开头        → outDir 在 wikiDir 外（合法）
  //   其他相对路径    → outDir 在 wikiDir 内（非法）
  //   绝对路径        → 不同盘符（macOS/Linux/Windows 同盘下不会出现，视为合法外置）
  const rel = relative(wikiDir, outDir)
  if (rel === "") {
    throw new Error(`outDir 不能等于 wikiDir，否则会污染源 wiki（wikiDir=${wikiDir}, outDir=${outDir}）`)
  }
  if (!rel.startsWith("..") && !_isAbsoluteLike(rel)) {
    throw new Error(
      `outDir 不能位于 wikiDir 子目录内，否则会污染源 wiki（wikiDir=${wikiDir}, outDir=${outDir}, relative=${rel}）`,
    )
  }
  const files = walkMarkdown(wikiDir)
  const slugIndex = _buildSlugIndex(files.map((f) => relative(wikiDir, f).replace(/\\/g, "/"))) // P1: 建 slug→path[] 索引
  const now = new Date()

  for (const abs of files) {
    const relPath = relative(wikiDir, abs).replace(/\\/g, "/")
    const name = basename(abs)
    const isReserved = _RESERVED.has(name)
    // I3: strip UTF-8 BOM（跨平台 bug：BOM 使首字符非 -，被误分类为 truly-none）
    const rawContent = readFileSync(abs, "utf8")
    const content = rawContent.replace(/^﻿/, "")
    const mtime = statSync(abs).mtime
    const outPath = join(outDir, relPath)
    mkdirSync(dirname(outPath), { recursive: true })

    let converted: string

    if (isReserved) {
      report.reserved++
      if (name === "index.md") {
        // bundle-root index.md vs 子目录 index.md
        const isRoot = dirname(relPath) === "."
        const idxConverted = isRoot ? _convertBundleRootIndex(content) : _convertSubdirIndex(content)
        // P1: index.md 双写（root/subdir 均经 doubleWriteContent 处理 fm/body）
        converted = _doubleWriteContent(idxConverted, slugIndex, relPath, report.warnings)
      } else {
        // log.md：不双写（normalize 后是日期条目，无 wikilink）
        converted = _normalizeLogContent(content)
      }
    } else {
      report.concepts++
      converted = _convertConcept(content, relPath, now, report.warnings, mtime, slugIndex)
    }

    writeFileSync(outPath, converted, "utf8")
    report.written++
  }

  return report
}
