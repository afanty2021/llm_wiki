// P0b-2: OKF 导出 section 的纯函数辅助。
//
// 抽出为独立模块便于在 node 环境（无 jsdom/happy-dom，项目 vitest 默认 environment）
// 下做单元测试：项目当前无 React Testing Library 配置（见 CLAUDE.md UI 测试缺口），
// 因此组件渲染测试不可行；将可测的逻辑（wikiDir 推导、warnings 截断、报告摘要文案）
// 放在此处，组件只做渲染与编排。

import { normalizePath } from "@/lib/path-utils"
import type { ExportReport } from "@/lib/okf-convert"

/**
 * 从项目路径推导 wiki 目录约定路径。
 *
 * 约定：wiki 内容位于 `${project.path}/wiki`（见 wiki-graph.ts::buildWikiGraph、
 * ingest.ts 的多处 `${projectPath}/wiki/...` 引用）。无项目（path 为空）时返回 null，
 * 调用方据此禁用导出按钮并提示先打开项目。
 *
 * @param projectPath 当前项目路径，可能为 undefined（无打开项目）
 * @returns wiki 目录绝对路径，或 null
 */
export function deriveWikiDir(projectPath?: string): string | null {
  if (!projectPath) return null
  // 先 trim 空白，再去掉 normalize 后可能残留的单个尾斜杠，避免拼出 `path//wiki`。
  // 现有 wiki-graph.ts 直接用 `${normalizePath(projectPath)}/wiki` 不去尾斜杠，
  // 此处做更稳健的处理（不影响其调用方）。
  const normalized = normalizePath(projectPath.trim())
  if (!normalized) return null
  const trimmed = normalized.replace(/\/+$/, "")
  if (!trimmed) return null
  return `${trimmed}/wiki`
}

/** 最多展示的 warnings 条数（避免长列表撑爆 UI）。 */
export const MAX_WARNINGS_SHOWN = 5

/**
 * 从 ExportReport 构造面向用户的摘要文案行。
 *
 * 纯函数：无 IO、无 i18n 依赖；返回结构化字段，由组件/i18n 渲染。
 * warnings 截断到 {@link MAX_WARNINGS_SHOWN} 条，并标记是否还有更多。
 */
export function summarizeReport(report: ExportReport): {
  written: number
  concepts: number
  reserved: number
  warningCount: number
  shownWarnings: string[]
  hasMoreWarnings: boolean
} {
  const warningCount = report.warnings.length
  const shown = report.warnings.slice(0, MAX_WARNINGS_SHOWN)
  return {
    written: report.written,
    concepts: report.concepts,
    reserved: report.reserved,
    warningCount,
    shownWarnings: shown,
    hasMoreWarnings: warningCount > shown.length,
  }
}

/**
 * 从任意错误值提取面向用户的错误文案。
 *
 * 复用项目内既有 err→message 模式（见 logs-section.tsx、settings-view.tsx）。
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
