// P0b-2: OKF 导出的 app 内 UI 入口（settings section）。
//
// 模式跟随 logs-section.tsx：无 draft/setDraft props（本 section 不参与全局
// Save 栏，导出是一次性动作，不需要持久化设置），自管理状态。
//
// 流程：用户点击「导出为 OKF bundle」→ dialog 选输出目录 → 调
// {@link exportOkfBundleTauri}(wikiDir, outDir) → 展示报告或错误。
//
// wikiDir 推导、warnings 截断等可测逻辑见 {@link ./okf-export-helpers}。

import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Loader2, Download } from "lucide-react"
import { open } from "@tauri-apps/plugin-dialog"
import { Button } from "@/components/ui/button"
import { useWikiStore } from "@/stores/wiki-store"
import { exportOkfBundleTauri } from "@/lib/okf-export-tauri"
import type { ExportReport } from "@/lib/okf-export"
import { createLogger } from "@/lib/logger"
import {
  deriveWikiDir,
  summarizeReport,
  errorMessage,
} from "./okf-export-helpers"

const logger = createLogger("okf-export-section")

type Status =
  | { kind: "idle" }
  | { kind: "exporting" }
  | { kind: "success"; report: ExportReport; outDir: string }
  | { kind: "error"; message: string }

/**
 * 导出当前 wiki 为 OKF v0.1 bundle 的设置面板。
 *
 * 只读转换：源 wiki 不被修改，结果写入用户选择的 outDir。
 * 无打开项目时按钮禁用。
 */
export function OkfExportSection() {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const [status, setStatus] = useState<Status>({ kind: "idle" })

  const wikiDir = deriveWikiDir(project?.path)
  const noProject = wikiDir === null

  const handleExport = async () => {
    if (!wikiDir) return
    // re-entrancy guard:按钮已 disabled,但编程式调用/键盘 ENTER 可能绕过(I2)
    if (status.kind === "exporting") return
    setStatus({ kind: "exporting" })

    let outDir: string | null
    try {
      outDir = await open({
        directory: true,
        title: t("settings.okfExport.selectOutDir", {
          defaultValue: "Select Output Directory",
        }),
      })
    } catch (err) {
      const message = errorMessage(err)
      logger.error("dialog open failed", { error: message })
      setStatus({ kind: "error", message })
      return
    }

    // 用户取消对话框（返回 null）
    if (!outDir || typeof outDir !== "string") {
      setStatus({ kind: "idle" })
      return
    }

    try {
      const report = await exportOkfBundleTauri(wikiDir, outDir)
      logger.info("okf export done", {
        written: report.written,
        concepts: report.concepts,
        reserved: report.reserved,
        warnings: report.warnings.length,
      })
      setStatus({ kind: "success", report, outDir })
    } catch (err) {
      const message = errorMessage(err)
      logger.error("okf export failed", { error: message })
      setStatus({ kind: "error", message })
    }
  }

  const exporting = status.kind === "exporting"

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-medium">{t("settings.okfExport.title")}</h3>
        <p className="text-sm text-muted-foreground">
          {t("settings.okfExport.description")}
        </p>
      </div>

      {noProject && (
        <div className="rounded-md border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
          {t("settings.okfExport.noProject")}
        </div>
      )}

      <Button
        onClick={() => void handleExport()}
        disabled={noProject || exporting}
      >
        {exporting ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            {t("settings.okfExport.exporting")}
          </>
        ) : (
          <>
            <Download className="mr-2 h-4 w-4" />
            {t("settings.okfExport.exportButton")}
          </>
        )}
      </Button>

      {status.kind === "success" && (
        <SuccessBlock report={status.report} outDir={status.outDir} />
      )}

      {status.kind === "error" && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          {t("settings.okfExport.errorPrefix")}: {status.message}
        </div>
      )}
    </div>
  )
}

function SuccessBlock({
  report,
  outDir,
}: {
  report: ExportReport
  outDir: string
}) {
  const { t } = useTranslation()
  const summary = summarizeReport(report)

  return (
    <div className="space-y-2 rounded-md border bg-muted/20 p-3 text-sm">
      <p className="font-medium text-foreground">
        {t("settings.okfExport.successTitle")}
      </p>
      <p className="text-xs text-muted-foreground break-all">{outDir}</p>
      <ul className="space-y-0.5 text-sm">
        <li>
          {t("settings.okfExport.written", { count: summary.written })}
        </li>
        <li>
          {t("settings.okfExport.concepts", { count: summary.concepts })}
        </li>
        <li>
          {t("settings.okfExport.reserved", { count: summary.reserved })}
        </li>
        <li>
          {t("settings.okfExport.warnings", { count: summary.warningCount })}
        </li>
      </ul>

      {summary.shownWarnings.length > 0 && (
        <div className="mt-2 space-y-1">
          <p className="text-xs font-medium text-muted-foreground">
            {t("settings.okfExport.warningsTitle")}
          </p>
          <ul className="space-y-0.5 text-xs text-muted-foreground">
            {summary.shownWarnings.map((w, i) => (
              <li key={i} className="break-all">
                {w}
              </li>
            ))}
          </ul>
          {summary.hasMoreWarnings && (
            <p className="text-xs italic text-muted-foreground">
              {t("settings.okfExport.moreWarnings", {
                count: summary.warningCount - summary.shownWarnings.length,
              })}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
