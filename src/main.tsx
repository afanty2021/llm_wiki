import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import "@/i18n";
import { loadAndApplyTheme, watchSystemTheme } from "@/lib/theme";
import { initLogger } from "@/lib/logger";
import { caps } from "@/lib/capabilities";

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
  applyPlatformClass();
  await loadAndApplyTheme();
  watchSystemTheme();

  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}

initApp();
