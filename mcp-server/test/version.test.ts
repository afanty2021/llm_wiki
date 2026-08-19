import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { VERSION } from "../src/version.js"

test("VERSION is read from package.json (single source of truth, no drift)", () => {
  // dist/test/ 与 dist/src/ 同层解析：../../package.json 都是 mcp-server/package.json
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf-8")) as { version?: string }
  assert.ok(pkg.version, "package.json must declare a version")
  assert.equal(VERSION, pkg.version)
})
