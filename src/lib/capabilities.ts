/**
 * 运行时能力探测:桌面(Tauri 壳) vs web(纯浏览器)的唯一判断源。
 * 取代散落在 main.tsx/theme.ts/fs.ts 的 isTauri/USE_HTTP 判断。
 * 桌面版所有能力开启、行为零变化;web 版按能力降级。
 */
export interface Capabilities {
  platform: "tauri" | "web"
  /** 选文件/目录:桌面=tauri dialog;web=<input type=file>+拖拽(降级可用) */
  canPickFiles: boolean
  /** 文件读写:两者皆 true(web 走 HTTP) */
  canAccessFs: boolean
  /** clip-watcher 轮询本地 clip server:桌面 only */
  canWatchClipboard: boolean
  /** 开机自启:桌面 only */
  canAutoStart: boolean
  /** Claude/Codex CLI 本地进程:桌面 only */
  canRunCli: boolean
  /** file-watcher 本地同步:桌面 only */
  canWatchFiles: boolean
  /** 系统通知:桌面=tauri notif;web=Notification API */
  canShowNotif: boolean
}

export function detect(): Capabilities {
  const isTauri =
    typeof window !== "undefined" &&
    ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)
  if (isTauri) {
    return {
      platform: "tauri",
      canPickFiles: true,
      canAccessFs: true,
      canWatchClipboard: true,
      canAutoStart: true,
      canRunCli: true,
      canWatchFiles: true,
      canShowNotif: true,
    }
  }
  return {
    platform: "web",
    canPickFiles: true,
    canAccessFs: true,
    canWatchClipboard: false,
    canAutoStart: false,
    canRunCli: false,
    canWatchFiles: false,
    canShowNotif: typeof Notification !== "undefined",
  }
}

/** 模块级单例,启动时探测一次。 */
export const caps: Capabilities = detect()
