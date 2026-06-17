// P0b-2: okf-export-helpers 的单元测试。
//
// 项目 vitest 默认 environment=node，无 jsdom/happy-dom、无 React Testing Library
// （见 CLAUDE.md「测试覆盖缺口 → UI 组件测试」），因此无法对 section 组件本身做
// 渲染测试。将可测逻辑抽到 okf-export-helpers.ts，在此覆盖：
// - wikiDir 推导（含无项目 / 空串 / 正常路径）
// - ExportReport 摘要（warnings 截断 + hasMore 标记）
// - errorMessage 提取
//
// 组件层面的「点击 → 调 exportOkfBundleTauri → 显示报告」交互链由 typecheck +
// 手动验证保证（见任务报告 DONE_WITH_CONCERNS 说明）。

import { describe, it, expect } from "vitest"
import {
  deriveWikiDir,
  summarizeReport,
  errorMessage,
  MAX_WARNINGS_SHOWN,
} from "./okf-export-helpers"
import type { ExportReport } from "@/lib/okf-convert"

describe("deriveWikiDir", () => {
  it("returns null when project path is undefined", () => {
    expect(deriveWikiDir(undefined)).toBeNull()
  })

  it("returns null when project path is empty string", () => {
    expect(deriveWikiDir("")).toBeNull()
  })

  it("returns null when project path is whitespace-only", () => {
    expect(deriveWikiDir("   ")).toBeNull()
  })

  it("appends /wiki to a normal project path", () => {
    expect(deriveWikiDir("/home/user/my-wiki")).toBe("/home/user/my-wiki/wiki")
  })

  it("strips a trailing slash before appending /wiki", () => {
    expect(deriveWikiDir("/home/user/my-wiki/")).toBe("/home/user/my-wiki/wiki")
  })
})

describe("summarizeReport", () => {
  it("passes through counts and returns empty warnings list when none", () => {
    const report: ExportReport = {
      written: 3,
      concepts: 2,
      reserved: 1,
      warnings: [],
    }
    const s = summarizeReport(report)
    expect(s.written).toBe(3)
    expect(s.concepts).toBe(2)
    expect(s.reserved).toBe(1)
    expect(s.warningCount).toBe(0)
    expect(s.shownWarnings).toEqual([])
    expect(s.hasMoreWarnings).toBe(false)
  })

  it("returns all warnings when count is within the cap", () => {
    const warnings = ["a", "b", "c"]
    const report: ExportReport = {
      written: 3,
      concepts: 3,
      reserved: 0,
      warnings,
    }
    const s = summarizeReport(report)
    expect(s.shownWarnings).toEqual(warnings)
    expect(s.hasMoreWarnings).toBe(false)
  })

  it("truncates warnings to MAX_WARNINGS_SHOWN and flags remainder", () => {
    const warnings = Array.from({ length: MAX_WARNINGS_SHOWN + 3 }, (_, i) => `w${i}`)
    const report: ExportReport = {
      written: 0,
      concepts: 0,
      reserved: 0,
      warnings,
    }
    const s = summarizeReport(report)
    expect(s.warningCount).toBe(MAX_WARNINGS_SHOWN + 3)
    expect(s.shownWarnings).toHaveLength(MAX_WARNINGS_SHOWN)
    expect(s.shownWarnings).toEqual(warnings.slice(0, MAX_WARNINGS_SHOWN))
    expect(s.hasMoreWarnings).toBe(true)
  })

  it("does not flag more when exactly at the cap", () => {
    const warnings = Array.from({ length: MAX_WARNINGS_SHOWN }, (_, i) => `w${i}`)
    const report: ExportReport = {
      written: 0,
      concepts: 0,
      reserved: 0,
      warnings,
    }
    const s = summarizeReport(report)
    expect(s.shownWarnings).toHaveLength(MAX_WARNINGS_SHOWN)
    expect(s.hasMoreWarnings).toBe(false)
  })
})

describe("errorMessage", () => {
  it("extracts message from Error instances", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom")
  })

  it("stringifies non-Error values", () => {
    expect(errorMessage("plain string")).toBe("plain string")
    expect(errorMessage(42)).toBe("42")
    expect(errorMessage({ x: 1 })).toBe("[object Object]")
  })

  it("handles null/undefined", () => {
    expect(errorMessage(null)).toBe("null")
    expect(errorMessage(undefined)).toBe("undefined")
  })
})
