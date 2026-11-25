import { readFileSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
const T = process.argv[2], W = process.argv[3]
const sha = (b) => createHash("sha256").update(b).digest("hex").slice(0, 12)
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "")
const BW = '"build:web": "npm run typecheck && vite build --mode web"'
const B = '"build": "npm run typecheck && vite build"'
const BD = '"build:desktop": "npm run build"'
const M = [
  ["M-a", "vite outDir 恒 dist", "vite.config.ts", 'outDir: mode === "web" ? "dist" : "dist-desktop"', 'outDir: "dist"'],
  ["M-b", "frontendDist 退回 ../dist", "src-tauri/tauri.conf.json", '"frontendDist": "../dist-desktop"', '"frontendDist": "../dist"'],
  ["M-c", "build:desktop 退回串 mcp ci+build", "package.json", BD, '"build:desktop": "npm --prefix mcp-server ci && npm run mcp:build && npm run build"'],
  ["M-d", "build:web 丢 --mode web", "package.json", BW, '"build:web": "npm run typecheck && vite build"'],
  ["M-e", "裸 build 改成 web 形态", "package.json", B, '"build": "npm run typecheck && vite build --mode web"'],
  ["M-f", ".gitignore 丢 dist-desktop", ".gitignore", "dist-desktop/\n", ""],
  ["M-g(R4加)", "裸 build 加 --outDir dist", "package.json", B, '"build": "npm run typecheck && vite build --outDir dist"'],
  ["M-h(R4加)", "build:web 加 --outDir dist-desktop", "package.json", BW, '"build:web": "npm run typecheck && vite build --mode web --outDir dist-desktop"'],
  ["M-k(R4加)", "build:desktop 透传 -- --mode web", "package.json", BD, '"build:desktop": "npm run build -- --mode web"'],
  ["M-l(R4加)", "beforeBuildCommand 改成 build:web", "src-tauri/tauri.conf.json", '"beforeBuildCommand": "npm run build:desktop"', '"beforeBuildCommand": "npm run build:web"'],
]
function run(id) {
  const r = spawnSync("npx", ["vitest", "run", "src/lib/build-form.test.ts", "--reporter=verbose"], { cwd: T, encoding: "utf8", env: { ...process.env, CI: "1", NO_COLOR: "1" } })
  const out = strip((r.stdout ?? "") + (r.stderr ?? ""))
  if (id) writeFileSync(`${W}/mut-${id}.log`, out)
  const failed = new Set()
  for (const m of out.matchAll(/^\s*(?:×|✗)\s+(?:\d+ms\s+)?>?\s*(.+?)\s*(?:\d+ms)?\s*$/gm)) failed.add(m[1])
  for (const m of out.matchAll(/^ FAIL \s+\S+ > (.+)$/gm)) failed.add(m[1])
  const tests = (out.match(/^\s*✓ .+$/gm) ?? []).length
  const summary = (out.match(/Tests\s+[^\n]+/) ?? [""])[0].trim()
  const red = failed.size ? "\n    红: " + [...failed].map((f) => f.replace(/^.*?> /, "").slice(0, 70)).join("\n    红: ") : ""
  return `exit=${r.status} | ${summary} | ✓行=${tests} | 红=${failed.size}` + red
}
console.log("BASELINE " + run("baseline"))
for (const [id, name, file, from, to] of M) {
  const p = `${T}/${file}`
  const orig = readFileSync(p, "utf8")
  const n = orig.split(from).length - 1
  if (n !== 1) { console.log(`SKIP ${id} ${name}: 原串出现 ${n} 次`); continue }
  writeFileSync(p, orig.replace(from, to))
  const res = run(id)
  writeFileSync(p, orig)
  const same = sha(readFileSync(p)) === sha(orig)
  console.log(`${/红=0\b/.test(res) ? "SURVIVED" : "KILLED  "} | ${id} ${name} | ${res} | 还原=${same ? "同" : "异!"}`)
}
console.log("RESTORED " + run("restored"))
