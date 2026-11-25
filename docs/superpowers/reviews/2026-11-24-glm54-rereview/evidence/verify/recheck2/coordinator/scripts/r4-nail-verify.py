#!/usr/bin/env python3
"""协调者亲验 R4 席 I-3（回归钉的成文断言比钉子覆盖宽）：R4 的 4 个变异体 + 协调者加码，对三版钉子实跑。

三版钉子：ORIG = live 原钉；B = 协调者 R1 轮的加固版（r1-verify.py 的 BLOCK_B）；
          C = 本轮再加固（expand 带回 `npm run x -- <透传参数>`、桌面链禁 --mode web、.env.web 同源断言）。
live 检出只读；一切写入在 /tmp/glm54-recheck-20261125/C/。用法：python3 r4-nail-verify.py
"""
import importlib.util
import json
import os
import re
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.argv = [sys.argv[0], 'r4']  # 让被导入的 r1-verify.py 把汇总落到 summary-r4.txt（本脚本沿用它）
spec = importlib.util.spec_from_file_location('r1v', os.path.join(HERE, 'r1-verify.py'))
r1v = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r1v)

T, RAW, W, NAIL = r1v.T, r1v.RAW, r1v.W, r1v.NAIL
out, sh, now = r1v.out, r1v.sh, r1v.now
RESULTS = {}

EXPAND_NEW = r'''/** 把 `a && b` 链展开到实际执行的外部命令（`npm run x` 递归代入 scripts.x）。
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
'''

HELPERS_C = r'''
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
'''

BLOCK_C = r'''
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
  it("C6 web 构建必须同源：.env.web 的 VITE_API_BASE_URL 恰有一行且为空", () => {
    const env = readFileSync(path.join(ROOT, ".env.web"), "utf8")
    expect(env.match(/^VITE_API_BASE_URL=[ \t]*$/gm) ?? []).toHaveLength(1)
    expect(env).not.toMatch(/^VITE_API_BASE_URL=\S/m)
  })
'''


def build_c(orig):
    text = orig
    a = 'import { readFileSync } from "node:fs"'
    assert text.count(a) == 1
    text = text.replace(a, 'import { readdirSync, readFileSync } from "node:fs"')
    i = text.index('function expand(command: string): string[] {')
    start = text.rindex('\n/** 把 ', 0, i) + 1
    end = text.index('\n}\n', i) + 3
    old = text[start:end]
    assert old.count('return expand(script)') == 1 and old.startswith('/** 把 `a && b`'), old[:120]
    text = text[:start] + EXPAND_NEW + text[end:]
    a = '\ndescribe("build 形态 × 产物目录分流", () => {'
    assert text.count(a) == 1
    text = text.replace(a, '\n' + HELPERS_C + a)
    a = '{ stdio: "ignore" }'
    assert text.count(a) == 1
    text = text.replace(a, '{ cwd: ROOT, stdio: "ignore" }')  # R1-M5：git check-ignore 不依赖调用方的 cwd
    base = text.rstrip()
    assert base.endswith('})')
    return base[:-2] + BLOCK_C + '})\n'


def conf_patch(**kv):
    d = json.loads(r1v.o('src-tauri/tauri.conf.json'))
    d['build'].update(kv)
    return json.dumps(d, indent=2, ensure_ascii=False) + '\n'


def m_env2():
    s = r1v.o('.env.web')
    new, n = re.subn(r'(?m)^VITE_API_BASE_URL=[ \t]*\n', '', s)
    assert n == 1, f'env 变异命中 {n} 行（期望 1）'
    return new


def m_gitignore():
    s = r1v.o('.gitignore')
    new, n = re.subn(r'(?m)^dist-desktop/\n', '', s)
    assert n == 1, f'gitignore 变异命中 {n} 行（期望 1）'
    return new


def sp(**kv):
    return r1v.scripts_patch(**kv)


TOUCH = ['src-tauri/tauri.conf.json']
# (标签, 相对路径, 变异函数)
MUTANTS = [
    ('R1f2_R4Mg', 'package.json', r1v.m_f2),                                   # build 末尾加 --outDir dist
    ('R1f4_R4Mh', 'package.json', r1v.m_f4),                                   # build:web 末尾加 --outDir dist-desktop
    ('R4Mk', 'package.json', lambda: sp(**{'build:desktop': 'npm run build -- --mode web'})),
    ('R4Ml', 'src-tauri/tauri.conf.json', lambda: conf_patch(beforeBuildCommand='npm run build:web')),
    ('Xk2', 'src-tauri/tauri.conf.json', lambda: conf_patch(beforeBuildCommand='npm run build:desktop -- --mode web')),
    ('Xk3', 'package.json', lambda: sp(**{'build:desktop': 'vite build --mode web'})),
    ('Xk4', 'package.json', lambda: sp(**{'build:desktop': 'npm run build -- --mode=web'})),
    ('Xk5', 'package.json', lambda: sp(**{'build:desktop': 'npm run build -- --outDir dist'})),
    ('Xk6', 'package.json', lambda: sp(**{'build:desktop': 'npm run build -- --out-dir dist'})),
    ('Xf1b', 'package.json', r1v.m_f1b),                                       # pretypecheck=mcp:build
    ('Xf2b', 'package.json', r1v.m_f2b),                                       # build 末尾加 --out-dir dist（kebab）
    ('Xt', 'package.json', lambda: sp(typecheck='npm run mcp:build && tsc --build --pretty')),  # 链上脚本的体内重建 mcp
    ('Xenv', '.env.web', r1v.m_env),                                            # VITE_API_BASE_URL 非空
    ('Xenv2', '.env.web', m_env2),                                              # VITE_API_BASE_URL 行删掉
    ('R1e', 'vite.config.ts', r1v.m_e),
    ('R1a1', 'src-tauri/tauri.macos.conf.json', r1v.m_a1),
    ('R1a2', 'src-tauri/tauri.windows.conf.json', r1v.m_a2),
    ('R1f1', 'package.json', r1v.m_f1),                                         # prebuild=mcp:build
    ('R1f-gitignore', '.gitignore', m_gitignore),                             # .gitignore 丢掉 dist-desktop/
]


def nail(label):
    rc, o = sh(['npx', 'vitest', 'run', 'src/lib/build-form.test.ts', '--reporter=verbose'], cwd=T, timeout=300)
    r1v.save('nail-r4-' + label, rc, o)
    m = re.search(r'Tests\s+([^\n]*)', o)
    failed = re.search(r'(\d+) failed', o)
    passed = re.search(r'(\d+) passed', o)
    RESULTS[label] = f'RED({failed.group(1)} failed)' if failed else (f'green({passed.group(1)})' if rc == 0 else 'ERR')
    out(f'NAIL {label}: rc={rc} | {m.group(0).strip() if m else "NO-SUMMARY"}')


def cell(v, m):
    s = RESULTS.get(f'{v}--{m}', '?')
    return 'RED ' if s.startswith('RED') else ('green' if s.startswith('green') else 'ERR  ')


def main():
    out(f'== R4-NAIL start {now()} ==')
    r1v.setup()
    r1v.ORIG_NAIL = open(f'{T}/{NAIL}').read()
    orig = r1v.ORIG_NAIL
    versions = [('ORIG', orig), ('B', r1v.with_block(r1v.BLOCK_B, r1v.HELPERS_B)), ('C', build_c(orig))]
    os.makedirs(W + '/nails', exist_ok=True)
    open(W + '/nails/build-form.hardened.test.ts', 'w').write(versions[2][1])
    for vname, text in versions:
        r1v.set_nail(text)
        nail(f'{vname}--baseline')
    out(f'ORIG it( 数 = {len(re.findall(r"^[ ]*it[(]", orig, re.M))}；C it( 数 = {len(re.findall(r"^[ ]*it[(]", versions[2][1], re.M))}')
    for mname, rel, fn in MUTANTS:
        r1v.apply(rel, fn(), mname)
        try:
            for vname, _ in versions:
                r1v.set_nail(versions[['ORIG', 'B', 'C'].index(vname)][1])
                nail(f'{vname}--{mname}')
        finally:
            r1v.restore(rel)
    r1v.set_nail(orig)
    nail('ORIG--restored-final')
    for rel in ['package.json', 'vite.config.ts', '.env.web', '.gitignore', 'src-tauri/tauri.conf.json', 'src-tauri/tauri.macos.conf.json',
                'src-tauri/tauri.windows.conf.json', NAIL]:
        same = r1v.sha(f'{T}/{rel}') == r1v.sha(f'{r1v.LIVE}/{rel}')
        out(f'  终态与 live 同字节: {rel} {same}')
        assert same, rel
    out('')
    out('== 矩阵（绿 = 变异体存活 / RED = 被杀）==')
    for mname, _, _ in MUTANTS:
        out(f'  {mname:16s} ORIG:{cell("ORIG", mname)}  B:{cell("B", mname)}  C:{cell("C", mname)}')
    for v, _ in versions:
        surv = [m for m, _, _ in MUTANTS if cell(v, m) == 'green']
        out(f'{v}: 存活 {len(surv)} / {len(MUTANTS)} -> {surv}')
    out(f'== R4-NAIL end {now()} ==')


if __name__ == '__main__':
    main()
