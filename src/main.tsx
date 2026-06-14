import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import "@/i18n";
import { loadAndApplyTheme, watchSystemTheme } from "@/lib/theme";
import { initLogger } from "@/lib/logger";

// Initialize Logger (fire-and-forget): pulls backend log level + registers
// close-event flush handlers. Runs before render so the earliest logs route
// correctly. Not awaited — default level (WARN) buffers safely until the
// backend level resolves.
initLogger().catch((error) => {
  console.error("Failed to initialize logger:", error);
});

function applyPlatformClass() {
  const isTauri = "__TAURI_INTERNALS__" in window || "__TAURI__" in window;
  if (isTauri && navigator.userAgent.includes("Mac OS X")) {
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
