import path from "path"
import { readFileSync } from "fs"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

const host = process.env.TAURI_DEV_HOST

// Read version from package.json at config-load time so the Settings
// UI can show the running app version without duplicating the string.
const pkgJson = JSON.parse(readFileSync(path.resolve(__dirname, "package.json"), "utf-8"))

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],

  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },

  define: {
    __APP_VERSION__: JSON.stringify(pkgJson.version),
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    // 绑 127.0.0.1（IPv4）：vite 默认监听 IPv6 [::1]，而 Tauri WKWebView 把
    // localhost 解析为 IPv4 127.0.0.1，连不上 IPv6 → webview 白屏。
    host: host || "127.0.0.1",
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },

  test: {
    environment: "node",
    // Loads .env.test.local into process.env for real-LLM tests.
    // The loader itself is a no-op if the file is absent, so this is
    // safe to keep on for every test run.
    setupFiles: ["./src/test-helpers/load-test-env.ts"],
  },
}))
