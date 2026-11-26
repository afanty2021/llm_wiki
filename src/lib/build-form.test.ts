import { execFileSync } from "node:child_process"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { resolveConfig } from "vite"
import { describe, expect, it } from "vitest"

/**
 * 构建形态 × 产物目录分流——WEB-1 门控的回归钉。
 *
 * 本仓检出同时是 live 运行目录：`dist/` 是 src-server :8080 运行时读盘的静态根，
 * `mcp-server/{dist,node_modules}` 是 Hermes 网关 live 加载的进程入口。桌面构建若写进
 * 这两处，一次 `tauri build` 就把线上换掉（2026-11-24 实锤：10-25 本地打包后 :8080
 * 静默回桌面形态近一月才被发现）。上游合并容易吞掉这类 fork 分流，故钉进 CI 门。
 */

const ROOT = fileURLToPath(new URL("../..", import.meta.url))
const readJson = (rel: string) => JSON.parse(readFileSync(path.join(ROOT, rel), "utf8"))

const pkg = readJson("package.json") as { scripts: Record<string, string> }
const tauri = readJson("src-tauri/tauri.conf.json") as {
  build: { beforeDevCommand?: string; beforeBuildCommand?: string; frontendDist: string }
}
const serverCfg = readJson("src-server/config/default.json") as { frontend: { dist_dir: string } }

const WEB_OUT_DIR = "dist"

/** 走 vite 真实的配置解析（等价 CLI `vite build --mode <mode>`）取产物目录，相对仓根 */
const cache = new Map<string, Promise<string>>()
function outDirFor(mode: string): Promise<string> {
  let p = cache.get(mode)
  if (!p) {
    p = resolveConfig({ root: ROOT, configFile: path.join(ROOT, "vite.config.ts") }, "build", mode).then(
      (cfg) => path.relative(ROOT, path.resolve(cfg.root, cfg.build.outDir)),
    )
    cache.set(mode, p)
  }
  return p
}

/** 把 `a && b` 链展开到实际执行的外部命令（`npm run x` 递归代入 scripts.x）。
 *  `npm run x -- <参数>` 的透传参数由 npm 接到 x 展开后的最后一条命令上，必须一起带下去：
 *  丢了它，`build:desktop = npm run build -- --mode web` 这种写法会让桌面构建改写 dist/ 而本文件全绿。 */
function expand(command: string): string[] {
  return command
    .split("&&")
    .map((part) => {
      const tokens = part.trim().split(/\s+/)
      if (tokens[0] === "npm" && tokens[1] === "run") {
        const script = pkg.scripts[tokens[2]]
        if (script === undefined) throw new Error(`package.json 缺脚本 ${tokens[2]}`)
        const chain = expand(script)
        const at = tokens.indexOf("--")
        if (at !== -1 && chain.length > 0) chain[chain.length - 1] += ` ${tokens.slice(at + 1).join(" ")}`
        return chain
      }
      return [tokens.join(" ")]
    })
    .flat()
}

/** 命令里 `vite build` 用的 mode（CLI 缺省 = production）；`--mode` 与短写 `-m` 两种拼法都算 */
function viteBuildModes(commands: string[]): string[] {
  return commands.flatMap((cmd) =>
    /\bvite build\b/.test(cmd) ? [/(?:--mode|-m)[=\s]+(\S+)/.exec(cmd)?.[1] ?? "production"] : [],
  )
}


/** 链上出现过的脚本名（递归） */
function referencedScripts(command: string, seen: Set<string>): Set<string> {
  for (const part of command.split("&&")) {
    const tokens = part.trim().split(/\s+/)
    if (tokens[0] === "npm" && tokens[1] === "run" && tokens[2] !== undefined && !seen.has(tokens[2])) {
      seen.add(tokens[2])
      referencedScripts(pkg.scripts[tokens[2]] ?? "", seen)
    }
  }
  return seen
}

describe("build 形态 × 产物目录分流", () => {
  it("build:web 显式走 --mode web，产物落 dist/ —— src-server :8080 读盘的静态根", async () => {
    expect(viteBuildModes(expand(pkg.scripts["build:web"]))).toEqual(["web"])
    expect(await outDirFor("web")).toBe(WEB_OUT_DIR)
    expect(serverCfg.frontend.dist_dir).toBe(`../${WEB_OUT_DIR}`)
  })

  it("桌面形态（npm run build）的产物不落 dist/，目录独立且已 gitignore", async () => {
    const modes = viteBuildModes(expand(pkg.scripts.build))
    expect(modes).toHaveLength(1)
    const dir = await outDirFor(modes[0])
    expect(dir).not.toBe(WEB_OUT_DIR)
    expect(() =>
      execFileSync("git", ["check-ignore", "-q", path.join(ROOT, dir, "probe")], { cwd: ROOT, stdio: "ignore" }),
    ).not.toThrow()
  })

  it("tauri build：frontendDist 指向 beforeBuildCommand 链实际构建出的目录，且不是 dist/", async () => {
    const modes = viteBuildModes(expand(tauri.build.beforeBuildCommand ?? ""))
    expect(modes).toHaveLength(1)
    const built = await outDirFor(modes[0])
    expect(built).not.toBe(WEB_OUT_DIR)
    // frontendDist 相对 src-tauri/ 解析
    expect(path.relative(ROOT, path.resolve(ROOT, "src-tauri", tauri.build.frontendDist))).toBe(built)
  })

  it("tauri build 不重建 mcp-server —— bundle 只读拷贝检出的 mcp-server/（Hermes live 进程入口）", () => {
    const commands = expand(tauri.build.beforeBuildCommand ?? "")
    expect(commands.length).toBeGreaterThan(0)
    for (const cmd of commands) expect(cmd).not.toMatch(/mcp/)
  })

  it("C1 不变量：除 web 外任何 mode 都不写 dist/ —— 上游若把分流改成按别的条件判，即红", async () => {
    for (const m of ["production", "development", "staging", "test"]) {
      expect(await outDirFor(m), `mode=${m}`).not.toBe(WEB_OUT_DIR)
    }
  })
  it("C2 任何平台的 tauri.<platform>.conf.json 都不得覆盖 build 段（frontendDist / beforeBuildCommand）", () => {
    const names = readdirSync(path.join(ROOT, "src-tauri")).filter((n) => /^tauri\.[^.]+\.conf\.json$/.test(n))
    expect(names.length).toBeGreaterThan(0)
    for (const f of names) {
      const c = readJson(`src-tauri/${f}`) as { build?: Record<string, string> }
      expect(c.build ?? {}).not.toHaveProperty("frontendDist")
      expect(c.build ?? {}).not.toHaveProperty("beforeBuildCommand")
    }
  })
  it("C3 三条构建链展开后，vite build 命令行不得带会盖掉配置的 flag（--outDir / --out-dir / --config / -c）", () => {
    const chains = [pkg.scripts.build, pkg.scripts["build:web"], tauri.build.beforeBuildCommand ?? ""]
    for (const cmd of chains.flatMap((c) => expand(c))) {
      expect(cmd).not.toMatch(/--out-?dir|--config\b|\s-c\b/i)
    }
  })
  it("C4 桌面链（npm run build、build:desktop、tauri beforeBuildCommand 链）里的 vite build 不得用 --mode web", () => {
    for (const c of [pkg.scripts.build, pkg.scripts["build:desktop"], tauri.build.beforeBuildCommand ?? ""]) {
      expect(viteBuildModes(expand(c))).not.toContain("web")
    }
  })
  it("C5 链上每个脚本（递归）的 pre/post 生命周期钩子都不得碰 mcp-server", () => {
    const names = new Set<string>()
    for (const c of [pkg.scripts.build, pkg.scripts["build:web"], tauri.build.beforeBuildCommand ?? ""]) {
      referencedScripts(c, names)
    }
    expect(names.has("build")).toBe(true)
    for (const n of names) {
      for (const hook of [`pre${n}`, `post${n}`]) {
        if (pkg.scripts[hook] !== undefined) {
          for (const cmd of expand(pkg.scripts[hook])) expect(cmd, hook).not.toMatch(/mcp/)
        }
      }
    }
  })
  it("C7 tauri dev 的 beforeDevCommand 不得跑 vite build（会把产物写进 dist/ 或 dist-desktop/）也不得碰 mcp-server", () => {
    const commands = expand(tauri.build.beforeDevCommand ?? "")
    expect(commands.length).toBeGreaterThan(0)
    for (const cmd of commands) {
      expect(cmd).not.toMatch(/\bvite build\b/)
      expect(cmd).not.toMatch(/mcp/)
    }
    for (const n of referencedScripts(tauri.build.beforeDevCommand ?? "", new Set())) {
      for (const hook of [`pre${n}`, `post${n}`]) {
        if (pkg.scripts[hook] !== undefined) {
          for (const cmd of expand(pkg.scripts[hook])) expect(cmd, hook).not.toMatch(/\bvite build\b|mcp/)
        }
      }
    }
  })
  it("C6 web 构建必须同源：.env.web 的 VITE_API_BASE_URL 恰有一行且为空", () => {
    const env = readFileSync(path.join(ROOT, ".env.web"), "utf8")
    expect(env.match(/^VITE_API_BASE_URL=[ \t]*$/gm) ?? []).toHaveLength(1)
    expect(env).not.toMatch(/^VITE_API_BASE_URL=\S/m)
  })
})
