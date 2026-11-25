import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { resolveConfig } from "vite"
import { describe, expect, it } from "vitest"

/**
 * 构建形态 × 产物目录分流——WEB-1 门控的回归钉。
 *
 * 本仓检出同时是 live 运行目录：`dist/` 是 src-server :8080 运行时读盘的静态根，
 * `mcp-server/{dist,node_modules}` 是 Hermes 网关 live 加载的进程入口。桌面构建若写进
 * 这两处，一次 `tauri build` 就把线上换掉（2026-11-24 实锺：10-25 本地打包后 :8080
 * 静默回桌面形态近一月才被发现）。上游合并容易吞掉这类 fork 分流，故钉进 CI 门。
 */

const ROOT = fileURLToPath(new URL("../..", import.meta.url))
const readJson = (rel: string) => JSON.parse(readFileSync(path.join(ROOT, rel), "utf8"))

const pkg = readJson("package.json") as { scripts: Record<string, string> }
const tauri = readJson("src-tauri/tauri.conf.json") as {
  build: { beforeBuildCommand?: string; frontendDist: string }
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

/** 把 `a && b` 链展开到实际执行的外部命令（`npm run x` 递归代入 scripts.x） */
function expand(command: string): string[] {
  return command
    .split("&&")
    .map((part) => {
      const tokens = part.trim().split(/\s+/)
      if (tokens[0] === "npm" && tokens[1] === "run") {
        const script = pkg.scripts[tokens[2]]
        if (script === undefined) throw new Error(`package.json 缺脚本 ${tokens[2]}`)
        return expand(script)
      }
      return [tokens.join(" ")]
    })
    .flat()
}

/** 命令里 `vite build` 用的 mode（CLI 缺省 = production） */
function viteBuildModes(commands: string[]): string[] {
  return commands.flatMap((cmd) =>
    /\bvite build\b/.test(cmd) ? [/--mode[=\s]+(\S+)/.exec(cmd)?.[1] ?? "production"] : [],
  )
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
      execFileSync("git", ["check-ignore", "-q", path.join(ROOT, dir, "probe")], { stdio: "ignore" }),
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
})
