import { readFileSync } from "node:fs"

/**
 * 版本单一事实源：mcp-server/package.json（此前 index.ts 硬编码 "0.4.20" 已漂移至 0.4.23）。
 * 解析基准是编译产物位置：dist/src/version.js → ../../package.json 即 mcp-server/package.json
 * （bin/start 均从 dist 运行；测试 dist/test/*.test.js 同层解析，路径一致）。
 * 读取失败回落字面量——版本读取不应让 MCP server 启动崩溃（test/version.test.ts 锁对齐）。
 */
export const VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf-8")) as { version?: string }
    if (typeof pkg.version === "string" && pkg.version !== "") return pkg.version
  } catch {
    // 落到兜底字面量
  }
  return "0.4.23"
})()
