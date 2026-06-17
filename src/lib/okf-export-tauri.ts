// P0b-1: OKF 导出的 Tauri 前端编排层。
//
// 与 {@link exportOkfBundle}（node:fs 版，仅 Node/CLI/测试可跑）逻辑等价，
// 但改用项目 `@/commands/fs` 的 Tauri invoke 封装做 IO，使 app webview 内可导出。
//
// 核心利好：转换函数（convertConcept / normalizeLogContent / index 转换 / timestamp 注入）
// 都是纯字符串函数，直接 import 复用，零逻辑重写。本模块只负责"遍历 → 读 → 转换 → 写"
// 的编排，以及 outDir 防护、目录创建、mtime 获取等 IO 协调。
//
// 不实现：UI（P0b-2）、wikilink 双写（P1）、description/resource 派生（P2）。

import { relative, basename, dirname, join } from "node:path"
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
  isAbsoluteLike,
  type ExportReport,
} from "./okf-export"

const RESERVED = new Set(["index.md", "log.md"])

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
        const relPath = relative(base, abs).replace(/\\/g, "/")
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
  // 判定逻辑与 node 版 exportOkfBundle 完全一致（复用 isAbsoluteLike）。
  const rel = relative(wikiDir, outDir)
  if (rel === "") {
    throw new Error(
      `outDir 不能等于 wikiDir，否则会污染源 wiki（wikiDir=${wikiDir}, outDir=${outDir}）`,
    )
  }
  if (!rel.startsWith("..") && !isAbsoluteLike(rel)) {
    throw new Error(
      `outDir 不能位于 wikiDir 子目录内，否则会污染源 wiki（wikiDir=${wikiDir}, outDir=${outDir}, relative=${rel}）`,
    )
  }

  const files = await walkMarkdownTauri(wikiDir)
  const now = new Date()
  const createdDirs = new Set<string>()

  for (const { abs, relPath } of files) {
    const name = basename(relPath)
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

    const outPath = join(outDir, relPath)
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
        converted = isRoot ? convertBundleRootIndex(content) : convertSubdirIndex(content)
      } else {
        // log.md
        converted = normalizeLogContent(content)
      }
    } else {
      report.concepts++
      converted = convertConcept(content, relPath, now, report.warnings, fileMtime)
    }

    await writeFile(outPath, converted)
    report.written++
  }

  return report
}
