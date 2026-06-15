import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Label } from "@/components/ui/label"
import { getLogLevel, setLogLevel as setRpcLogLevel } from "@/commands/logging"
import { setLogLevel as setLocalLogLevel } from "@/lib/logger"
import { loadErrorNotificationConfig, setErrorNotificationConfig } from "@/lib/error-notification-config"
import { Switch } from "@/components/ui/switch"
import type { LogLevel } from "@/lib/logger-types"

const LOG_LEVELS: LogLevel[] = ["DEBUG", "INFO", "WARN", "ERROR"]

const VALID_LEVELS = new Set<string>(LOG_LEVELS)

/**
 * Narrow an arbitrary backend string to a known LogLevel.
 *
 * The Rust `get_log_level` command returns a bare `String`, so the
 * typed wrapper in `@/commands/logging` only claims `Promise<LogLevel>`
 * by convention. If a future backend change ever returns something
 * unexpected (or IPC hands us `null`/`undefined`), we fall back to
 * "WARN" rather than letting an invalid value silently flow into the
 * logger cache and disable filtering.
 */
function coerceLogLevel(value: unknown): LogLevel {
  return typeof value === "string" && VALID_LEVELS.has(value) ? (value as LogLevel) : "WARN"
}

/**
 * Log level configuration.
 *
 * Persisted immediately on change — bypasses the SettingsView draft +
 * global Save button, because the i18n description promises "changes
 * take effect immediately" and the backend filter update is cheap.
 * Mirrors the inline-persistence pattern used by WebSearchSection.
 */
export function LoggingConfig() {
  const { t } = useTranslation()
  const [level, setLevel] = useState<LogLevel>("WARN")
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState(false)
  const [errorNotify, setErrorNotify] = useState(true)

  useEffect(() => {
    let cancelled = false
    loadErrorNotificationConfig()
      .then((val) => { if (!cancelled) setErrorNotify(val) })
      .catch((error) => { console.error("[logging-config] failed to load error notification config:", error) })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    let cancelled = false
    getLogLevel()
      .then((current) => {
        if (cancelled) return
        setLevel(coerceLogLevel(current))
      })
      .catch((error) => {
        console.error("[logging-config] failed to load log level:", error)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function handleLevelChange(newLevel: LogLevel) {
    if (newLevel === level || pending) return
    setPending(true)
    // Capture the level before the optimistic update so we can restore it
    // if the IPC call fails. The pending guard above prevents re-entry,
    // so `level` stays stable for the lifetime of this handler.
    const previousLevel = level
    // Optimistic local update so the clicked option highlights
    // instantly even if the IPC round-trip is slow.
    setLevel(newLevel)
    try {
      await setRpcLogLevel(newLevel)
      setLocalLogLevel(newLevel)
    } catch (error) {
      console.error("[logging-config] failed to set log level:", error)
      // Revert to the real backend level captured before the optimistic update.
      setLevel(previousLevel)
    } finally {
      setPending(false)
    }
  }

  async function handleNotifyToggle(enabled: boolean) {
    if (enabled === errorNotify) return
    const previous = errorNotify
    setErrorNotify(enabled)
    try {
      await setErrorNotificationConfig(enabled)
    } catch (error) {
      console.error("[logging-config] failed to set error notification:", error)
      setErrorNotify(previous)
    }
  }

  return (
    <div className="space-y-2">
      <div>
        <Label>{t("settings.logging.title")}</Label>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("settings.logging.description")}
        </p>
      </div>
      <div className="grid gap-2 sm:grid-cols-4">
        {LOG_LEVELS.map((logLevel) => {
          const active = level === logLevel
          return (
            <button
              key={logLevel}
              type="button"
              onClick={() => handleLevelChange(logLevel)}
              disabled={loading || pending}
              aria-pressed={active}
              className={`rounded-md border px-3 py-2 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                active
                  ? "border-primary bg-primary/10 text-foreground ring-1 ring-primary/30"
                  : "border-border hover:bg-accent"
              }`}
            >
              <span className="font-medium">{logLevel}</span>
            </button>
          )
        })}
      </div>
      <div className="flex items-center justify-between pt-2">
        <div className="space-y-0.5">
          <Label>Error Desktop Notification</Label>
          <p className="text-xs text-muted-foreground">
            Show a desktop notification on errors (at most once per 10 seconds)
          </p>
        </div>
        <Switch checked={errorNotify} onCheckedChange={handleNotifyToggle} />
      </div>
    </div>
  )
}
