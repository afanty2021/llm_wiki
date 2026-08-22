import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import "@/i18n";
import { loadAndApplyTheme, watchSystemTheme } from "@/lib/theme";
import { initLogger } from "@/lib/logger";
import { caps } from "@/lib/capabilities";
import { AppDialogHost } from "@/components/app-dialog-host";

// Initialize Logger (fire-and-forget): pulls backend log level + registers
// close-event flush handlers. Runs before render so the earliest logs route
// correctly. Not awaited — default level (WARN) buffers safely until the
// backend level resolves.
initLogger().catch((error) => {
  // KEEP as console.error: this catch fires when logger initialization
  // ITSELF failed (e.g. Tauri invoke threw). Routing through logger here
  // would be circular — the logger is the thing that just failed to init.
  console.error("Failed to initialize logger:", error);
});

function applyPlatformClass() {
  // 仅桌面壳 + macOS 加 platform-macos class
  if (caps.platform === "tauri" && navigator.userAgent.includes("Mac OS X")) {
    document.documentElement.classList.add("platform-macos");
  }
}

// Apply theme before render to avoid flash
async function initApp() {
  try {
    applyPlatformClass();
    await loadAndApplyTheme();
    watchSystemTheme();

    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <React.StrictMode>
        <App />
        <AppDialogHost />
      </React.StrictMode>
    );
  } catch (err) {
    console.error("[startup] failed to initialize LLM Wiki:", err);
    const root = document.getElementById("root");
    if (root) {
      const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
      root.innerHTML = `
        <div style="font-family: system-ui, sans-serif; padding: 24px; color: #111; color: light-dark(#111, #f5f5f5); background: #fff; background: light-dark(#fff, #111); min-height: 100vh; color-scheme: light dark;">
          <h1 style="font-size: 18px; margin: 0 0 12px;">LLM Wiki failed to start</h1>
          <p style="margin: 0 0 12px;">The frontend startup code threw an error before React could render.</p>
          <pre style="white-space: pre-wrap; border: 1px solid light-dark(#ddd, #333); border-radius: 8px; padding: 12px; background: light-dark(#f7f7f7, #1d1d1d);">${message.replace(/[&<>"']/g, (ch) => ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;",
          }[ch] ?? ch))}</pre>
        </div>
      `;
    }
  }
}

initApp();
