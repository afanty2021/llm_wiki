import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { RefreshCw, Loader2, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { readLogFile, clearLogs } from "@/commands/logging"
import { createLogger } from "@/lib/logger"
import type { LogDisplayEntry, LogLevel } from "@/lib/logger-types"

const logger = createLogger("logs-section")

const ALL_LEVELS: LogLevel[] = ["DEBUG", "INFO", "WARN", "ERROR"]
const DEFAULT_LEVELS: LogLevel[] = ["ERROR", "WARN", "INFO"] // DEBUG default off
const PAGE_SIZE = 100

/**
 * In-app log viewer. Paginated, with level toggle chips, keyword search,
 * and trace_id filter. ERROR rows highlighted.
 *
 * Fetches from backend read_log_file (server-side filtering + pagination).
 */
export function LogsSection() {
  const { t } = useTranslation()
  const [entries, setEntries] = useState<LogDisplayEntry[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [levels, setLevels] = useState<LogLevel[]>(DEFAULT_LEVELS)
  const [keyword, setKeyword] = useState("")
  const [traceId, setTraceId] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [clearing, setClearing] = useState(false)

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  const loadLogs = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const levelFilter = levels.length < ALL_LEVELS.length ? levels : undefined
      const res = await readLogFile(
        PAGE_SIZE,
        page * PAGE_SIZE,
        levelFilter,
        keyword.trim() || undefined,
        traceId.trim() || undefined,
      )
      setEntries(res.entries)
      setTotal(res.total)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
      logger.error("Failed to load logs", { error: msg })
    } finally {
      setLoading(false)
    }
  }, [page, levels, keyword, traceId])

  useEffect(() => {
    void loadLogs()
  }, [loadLogs])

  const handleClear = useCallback(async () => {
    const confirmed = window.confirm(t("settings.logs.clearConfirm"))
    if (!confirmed) return
    setClearing(true)
    try {
      await clearLogs()
      setPage(0)
      await loadLogs()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
      logger.error("Failed to clear logs", { error: msg })
    } finally {
      setClearing(false)
    }
  }, [t, loadLogs])

  const toggleLevel = (lvl: LogLevel) => {
    setLevels((prev) =>
      prev.includes(lvl)
        ? prev.filter((l) => l !== lvl)
        : [...prev, lvl],
    )
    setPage(0)
  }

  const onKeywordChange = (v: string) => { setKeyword(v); setPage(0) }
  const onTraceIdChange = (v: string) => { setTraceId(v); setPage(0) }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h3 className="text-lg font-medium">{t("settings.logs.title")}</h3>
          <p className="text-sm text-muted-foreground">{t("settings.logs.description")}</p>
        </div>
        <Button
          variant="destructive"
          size="sm"
          onClick={() => void handleClear()}
          disabled={clearing || loading || total === 0}
        >
          {clearing ? (
            <Loader2 className="mr-1 h-4 w-4 animate-spin" />
          ) : (
            <Trash2 className="mr-1 h-4 w-4" />
          )}
          {t("settings.logs.clear")}
        </Button>
      </div>

      {/* 过滤栏 */}
      <div className="space-y-2">
        <div className="flex flex-wrap gap-2">
          {ALL_LEVELS.map((lvl) => {
            const active = levels.includes(lvl)
            return (
              <button
                key={lvl}
                type="button"
                onClick={() => toggleLevel(lvl)}
                aria-pressed={active}
                className={`rounded-md border px-3 py-1 text-xs font-medium transition-colors ${
                  active
                    ? levelChipActiveClass(lvl)
                    : "border-border text-muted-foreground hover:bg-accent"
                }`}
              >
                {lvl}
              </button>
            )
          })}
        </div>
        <div className="flex gap-2">
          <Input
            placeholder={t("settings.logs.searchPlaceholder")}
            value={keyword}
            onChange={(e) => onKeywordChange(e.target.value)}
            className="flex-1"
          />
          <Input
            placeholder="trace_id"
            value={traceId}
            onChange={(e) => onTraceIdChange(e.target.value)}
            className="flex-1"
          />
          <Button variant="outline" size="icon" onClick={() => void loadLogs()} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </Button>
        </div>
      </div>

      {/* 日志列表 */}
      {error ? (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          {t("settings.logs.loadError")}: {error}
        </div>
      ) : loading && entries.length === 0 ? (
        <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> {t("settings.logs.loading")}
        </div>
      ) : entries.length === 0 ? (
        <div className="py-8 text-center text-sm text-muted-foreground">
          {t("settings.logs.empty")}
        </div>
      ) : (
        <div className="max-h-[480px] overflow-auto rounded-md border">
          <table className="w-full text-xs">
            <tbody>
              {entries.map((e, i) => (
                <tr
                  key={i}
                  className={`border-b last:border-0 ${e.level === "ERROR" ? "bg-destructive/10" : ""}`}
                >
                  <td className="whitespace-nowrap px-2 py-1 font-mono text-muted-foreground">
                    {formatTime(e.timestamp)}
                  </td>
                  <td className={`whitespace-nowrap px-2 py-1 font-semibold ${levelTextClass(e.level)}`}>
                    {e.level}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1 font-mono text-muted-foreground">
                    {e.module}
                  </td>
                  <td className="px-2 py-1 break-all">{e.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 分页栏 */}
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">
          {t("settings.logs.total", { count: total })}
        </span>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0 || loading}
          >
            {t("settings.logs.prev")}
          </Button>
          <span className="text-muted-foreground">
            {page + 1} / {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            disabled={page >= totalPages - 1 || loading}
          >
            {t("settings.logs.next")}
          </Button>
        </div>
      </div>
    </div>
  )
}

function levelChipActiveClass(lvl: LogLevel): string {
  switch (lvl) {
    case "ERROR": return "border-destructive bg-destructive/10 text-destructive"
    case "WARN": return "border-yellow-500 bg-yellow-500/10 text-yellow-700 dark:text-yellow-400"
    case "INFO": return "border-blue-500 bg-blue-500/10 text-blue-700 dark:text-blue-400"
    case "DEBUG": return "border-border bg-accent text-foreground"
  }
}

function levelTextClass(lvl: LogLevel): string {
  switch (lvl) {
    case "ERROR": return "text-destructive"
    case "WARN": return "text-yellow-700 dark:text-yellow-400"
    case "INFO": return "text-blue-700 dark:text-blue-400"
    case "DEBUG": return "text-muted-foreground"
  }
}

function formatTime(iso: string): string {
  const tIdx = iso.indexOf("T")
  if (tIdx < 0) return iso
  const timePart = iso.slice(tIdx + 1)
  const dotIdx = timePart.indexOf(".")
  return dotIdx < 0 ? timePart : timePart.slice(0, dotIdx)
}
