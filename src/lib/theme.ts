import { loadTheme } from "@/lib/project-store"
import { getCurrentWindow, type Theme as NativeTheme } from "@tauri-apps/api/window"
import { caps } from "@/lib/capabilities"

const logger = createLogger("theme")
import { createLogger } from "@/lib/logger"

export type AppTheme = "light" | "dark" | "system"

let activeTheme: AppTheme = "system"
let mediaQuery: MediaQueryList | null = null
let mediaListenerInstalled = false

function systemPrefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches
}

function syncNativeWindowTheme(resolved: NativeTheme): void {
  // 仅桌面壳可调原生 window API;web 跳过
  if (caps.platform !== "tauri") return
  const win = getCurrentWindow()
  const background = resolved === "dark" ? "#27282b" : "#ffffff"
  void win.setTheme(resolved).catch((err) => {
    logger.warn("Failed to sync native window theme", { error: String(err) })
  })
  void win.setBackgroundColor(background).catch((err) => {
    logger.warn("Failed to sync native window background", { error: String(err) })
  })
}

export function applyTheme(theme: AppTheme): void {
  activeTheme = theme
  const root = document.documentElement
  const resolved = theme === "system"
    ? systemPrefersDark()
      ? "dark"
      : "light"
    : theme

  root.classList.remove("light", "dark")
  root.classList.add(resolved)
  root.dataset.theme = theme
  syncNativeWindowTheme(resolved)
}

export function watchSystemTheme(): void {
  if (mediaListenerInstalled) return
  mediaQuery = window.matchMedia("(prefers-color-scheme: dark)")
  mediaQuery.addEventListener("change", () => {
    if (activeTheme === "system") applyTheme("system")
  })
  mediaListenerInstalled = true
}

export async function loadAndApplyTheme(): Promise<AppTheme> {
  try {
    const savedTheme = await loadTheme()
    const theme = savedTheme ?? "system"
    applyTheme(theme)
    return theme
  } catch {
    applyTheme("system")
    return "system"
  }
}
