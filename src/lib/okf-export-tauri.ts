// P0b-1: OKF 导出的 Tauri 前端编排层。
//
// 与 {@link exportOkfBundle}（node:fs 版，仅 Node/CLI/测试可跑）逻辑等价，
// 但改用项目 `@/commands/fs` 的 Tauri invoke 封装做 IO，使 app webview 内可导出。
//
// 核心利好：转换函数（convertConcept / normalizeLogContent / index 转换 / timestamp 注入）
// 都是纯字符串函数，直接 import 复用，零逻辑重写。本模块只负责"遍历 → 读 → 转换 → 写"
// 的编排，以及 outDir 防护、目录创建、mtime 获取等 IO 协调。
//
// 不实现：description/resource 派生（P2）。wikilink 双写（P1）已实现。
//
// ⚠️ client-safe：本模块被 app webview 间接 import
// （okf-export-section → 本模块），故**禁止**顶层 `import ... from "node:*"`——
// Vite 会 externalize 给 client 并白屏。路径工具一律用项目自带的
// `@/lib/path-utils`（纯字符串）或本地自实现，不引 node:path。
// 转换函数从 `@/lib/okf-convert`（零 node 依赖）import，不从 `@/lib/okf-export`
// import（后者顶层 import node:fs）。

import {
  normalizePath,
  joinPath,
  getFileName,
  getRelativePath,
} from "@/lib/path-utils"
import {
  readFile,
  writeFile,
  listDirectory,
  createDirectory,
  getFileModifiedTime,
} from "@/commands/fs"
import type { FileNode } from "@/types/wiki"
import {
  convertConcept,
  normalizeLogContent,
  convertBundleRootIndex,
  convertSubdirIndex,
  buildSlugIndex,
  doubleWriteContent,
  RESERVED,
  type ExportReport,
} from "@/lib/okf-convert"

/**
 * 自实现 dirname（纯字符串，无 node:path 依赖）。
 *
 * 行为对齐 node:path 在本模块调用点的实际语义：
 *   - 输入均为 POSIX 形式（relPath 已 `.replace(/\\/g, "/")`；outPath 由
 *     joinPath 拼成 `/`-分隔）。
 *   - 末段去掉后若剩 "" → 返回 "."（对齐 `dirname("foo.md") === "."`）。
 *   - 单段无分隔符 → "."；根路径 "/foo" → "/"。
 *
 * 不处理 node:path.win32 的 UNC/盘符细节——本模块路径来自 Tauri 后端 / 用户
 * 选目录对话框，进入此函数前都已被 normalizePath 归一为 `/`-分隔。
 */
function dirname(p: string): string {
  if (!p) return "."
  const normalized = p.replace(/\\/g, "/")
  // 去掉末尾分隔符
  const trimmed = normalized.replace(/\/+$/, "")
  const slashIdx = trimmed.lastIndexOf("/")
  if (slashIdx === -1) return "."
  if (slashIdx === 0) return "/"
  return trimmed.slice(0, slashIdx)
}

/**
 * 收集 wikiDir 下所有 .md 文件（绝对路径 + 相对 wikiDir 的 POSIX relPath）。
 *
 * 契约：`listDirectory(wikiDir)` 一次返回该 dir 的**预递归树**——目录节点的
 * `children` 字段已被后端递归填充（见 src-tauri/src/commands/fs.rs::build_tree，
 * 最多 30 层）。本函数**只调用一次 listDirectory**，然后递归遍历 `children`，
 * 不再对子目录重调——否则会丢弃后端已做的预递归工作并重复遍历整棵树。
 *
 * 边界处理：
 * - `children` 为 undefined/空：is_dir 但后端未填充（空目录，或超 30 层）。
 *   build_tree 保证 ≤30 层全填充，故 children 缺失 = 空目录 → 跳过（无 .md）。
 *   超 30 层极深嵌套在生产 wiki 中不存在，若出现则该子树被静默跳过（已知限制）。
 * - 跳过 `node_modules` 与以 `.` 开头的项（与 node 版 walkMarkdown 一致；
 *   后端 build_tree 已过滤 dotfiles，此处双保险）。
 * - symlink：FileNode 无 symlink 字段（见 {@link FileNode}），编排层无法判定。
 *   依赖后端实现；生产 wiki 无 symlink 循环，此为已知限制。
 *
 * IO 错误（listDirectory 失败）向上抛出；调用方需自行 try/catch。
 */
async function walkMarkdownTauri(
  dir: string,
  base: string = dir,
): Promise<Array<{ abs: string; relPath: string }>> {
  let root: FileNode[]
  try {
    root = await listDirectory(dir)
  } catch (e) {
    throw new Error(`listDirectory 失败: ${dir}: ${(e as Error).message}`)
  }
  const out: Array<{ abs: string; relPath: string }> = []
  // 递归消耗预递归树（对齐 src/components/layout/knowledge-tree.tsx::flattenMdFiles）
  const walk = (nodes: FileNode[]): void => {
    for (const node of nodes) {
      if (node.name === "node_modules" || node.name.startsWith(".")) continue
      if (node.is_dir) {
        // children 缺失 = 空目录或超 30 层（build_tree 契约）→ 无 .md 可收集，跳过
        if (node.children && node.children.length > 0) {
          walk(node.children)
        }
      } else if (node.name.endsWith(".md")) {
        // node.path 由后端 build_tree 填充为绝对路径;依赖此契约,不提供会拼错子目录层级的回退
        if (!node.path) continue
        const abs = node.path
        // abs 始终在 base (wikiDir) 下（walkMarkdownTauri 从 wikiDir 根起递归），
        // getRelativePath(fullPath, basePath) 返回 base 之后的相对段，等价 node 版
        // relative(base, abs)。再 normalize 到 POSIX（后端可能返回 \ on Windows）。
        const relPath = getRelativePath(abs, base).replace(/\\/g, "/")
        out.push({ abs, relPath })
      }
    }
  }
  walk(root)
  return out
}

/**
 * 端到端导出（Tauri 版）：把 wikiDir 只读转换为 OKF-conformant bundle，写入 outDir。
 *
 * 逻辑等价 {@link exportOkfBundle}，IO 层换为 `@/commands/fs`。
 *
 * 安全约束（与 node 版一致）：
 * - 源 wiki 只读，源文件内容（含 UTF-8 BOM）会被 strip 后再转换，不写回源。
 * - outDir == wikiDir 或 outDir 在 wikiDir 子目录内 → throw，防源污染。
 *
 * IO 错误（listDirectory / readFile / createDirectory / writeFile 失败）向上抛出；
 * 调用方需自行 try/catch 并清理已写出的部分产物。
 *
 * 已知限制：FileNode 无 mtime 字段，本函数为每个 .md 单独调用
 * `getFileModifiedTime`（N 次 invoke）。若性能成为问题，未来可在后端批量返回。
 */
export async function exportOkfBundleTauri(
  wikiDir: string,
  outDir: string,
): Promise<ExportReport> {
  const report: ExportReport = { written: 0, concepts: 0, reserved: 0, warnings: [] }

  // I1: 防止 outDir 落在 wikiDir 内（含相等），避免源被污染。
  // 判定逻辑与 node 版 exportOkfBundle 完全等价（node 版用 path.relative，这里用
  // 纯字符串前缀检测，规避 node:path 依赖）：
  //   - 归一化两者为 `/`-分隔（统一 macOS/Windows）。
  //   - 相等 / outDir === wikiDir + "/" → 污染（throw 不能等于）。
  //   - outDir 以 `wikiDir + "/"` 开头 → 在 wikiDir 子目录内（throw 不能位于子目录内）。
  //   - 否则合法（outDir 在 wikiDir 外或不同盘符）。
  //
  // 与 node 版 path.relative 的差异点已用等价语义覆盖：
  //   - node 版 `rel === ""`（相等） ↔ 这里 `nOut === nWiki`。
  //   - node 版 `rel.startsWith("..")`（outDir 在外）或 `isAbsoluteLike(rel)`（不同盘符）
  //     视为合法 ↔ 这里 "outDir 不以 wikiDir+/" 开头" 即合法（外置或不同盘符都不以前缀开头）。
  //   - node 版 "其他相对路径"（outDir 在 wikiDir 内） ↔ 这里 `nOut.startsWith(nWiki + "/")`。
  const nWiki = normalizePath(wikiDir)
  const nOut = normalizePath(outDir)
  if (nOut === nWiki) {
    throw new Error(
      `outDir 不能等于 wikiDir，否则会污染源 wiki（wikiDir=${wikiDir}, outDir=${outDir}）`,
    )
  }
  if (nOut.startsWith(nWiki + "/")) {
    throw new Error(
      `outDir 不能位于 wikiDir 子目录内，否则会污染源 wiki（wikiDir=${wikiDir}, outDir=${outDir}）`,
    )
  }
  // 注：outDir 在 wikiDir 外（合法）或不同盘符（合法）均不会满足上述前缀检查，
  //     语义覆盖 node 版 `rel.startsWith("..") || isAbsoluteLike(rel)` 的合法分支。

  const files = await walkMarkdownTauri(wikiDir)
  const slugIndex = buildSlugIndex(files.map((f) => f.relPath)) // P1: 建 slug→path[] 索引
  const now = new Date()
  const createdDirs = new Set<string>()

  for (const { abs, relPath } of files) {
    const name = getFileName(relPath)
    const isReserved = RESERVED.has(name)

    // 读源（strip UTF-8 BOM，跨平台 bug：BOM 使首字符非 -，被误分类为 truly-none）
    const rawContent = await readFile(abs)
    const content = rawContent.replace(/^﻿/, "")

    // mtime：FileNode 无此字段，单独调用 getFileModifiedTime 拿 epoch ms。
    // 失败或返回 0 时 fileMtime=undefined，convertConcept 会走 nowFallback 兜底。
    let fileMtime: Date | undefined
    try {
      const ms = await getFileModifiedTime(abs)
      if (ms > 0) fileMtime = new Date(ms)
    } catch {
      fileMtime = undefined
    }

    const outPath = joinPath(outDir, relPath)
    const outParent = dirname(outPath)
    // 确保写出目录存在（去重，避免对同一目录重复 invoke）
    if (!createdDirs.has(outParent)) {
      await createDirectory(outParent)
      createdDirs.add(outParent)
    }

    let converted: string

    if (isReserved) {
      report.reserved++
      if (name === "index.md") {
        // bundle-root index.md vs 子目录 index.md
        const isRoot = dirname(relPath) === "."
        const idxConverted = isRoot ? convertBundleRootIndex(content) : convertSubdirIndex(content)
        // P1: index.md 双写（root/subdir 均经 doubleWriteContent 处理 fm/body）
        converted = doubleWriteContent(idxConverted, slugIndex, relPath, report.warnings)
      } else {
        // log.md：不双写（normalize 后是日期条目，无 wikilink）
        converted = normalizeLogContent(content)
      }
    } else {
      report.concepts++
      converted = convertConcept(content, relPath, now, report.warnings, fileMtime, slugIndex)
    }

    await writeFile(outPath, converted)
    report.written++
  }

  return report
}
