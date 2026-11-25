#!/usr/bin/env python3
"""协调者亲验 R1 席（N-2 结构性根治）。live 检出只读；一切写入在 /tmp/glm54-recheck-20261125/C/。

用法：python3 r1-verify.py light   # 回归钉 × 变异矩阵（原钉 / R1 提案 / 加固版）
      python3 r1-verify.py heavy   # 行为级构建 + 全量 test:mocks + Minor 抽查 + live 终态
"""
import glob
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time

LIVE = '/Users/berton/Github/kb-obsidian/llm_wiki'
W = '/tmp/glm54-recheck-20261125/C'
T = W + '/tree'
RAW = W + '/raw'
MODE = sys.argv[1] if len(sys.argv) > 1 else 'light'
ENV = {'npm_config_logs_dir': W + '/npm-logs'}

os.makedirs(RAW, exist_ok=True)
os.makedirs(W + '/npm-logs', exist_ok=True)
SUMMARY = open(f'{RAW}/summary-{MODE}.txt', 'a')
RESULTS = {}
ORIG = {}


def out(*a):
    s = ' '.join(str(x) for x in a)
    print(s, flush=True)
    SUMMARY.write(s + '\n')
    SUMMARY.flush()


def now():
    return time.strftime('%Y-%m-%d %H:%M:%S')


def sh(cmd, cwd=None, timeout=900):
    e = dict(os.environ)
    e.update(ENV)
    p = subprocess.run(cmd, cwd=cwd, env=e, capture_output=True, text=True, timeout=timeout)
    return p.returncode, p.stdout + p.stderr


def sha(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''):
            h.update(b)
    return h.hexdigest()


def save(name, rc, text):
    with open(f'{RAW}/{name}.txt', 'w') as f:
        f.write(f'$ rc={rc}\n{text}')


def snapshot(d):
    r = {}
    for root, _, fs in os.walk(d):
        for f in fs:
            p = os.path.join(root, f)
            r[os.path.relpath(p, d)] = sha(p)
    return r


def same(a, b):
    return sum(1 for k in a if k in b and b[k] == a[k])


# ───────────── setup ─────────────
def setup():
    if os.path.isfile(T + '/vite.config.ts') and os.path.isdir(T + '/node_modules/vite'):
        out('setup: tree 已存在，复用')
        return
    os.makedirs(T, exist_ok=True)
    rc, o = sh(['git', '--no-optional-locks', '-C', LIVE, 'archive', '--format=tar', '-o', W + '/head.tar', 'cb78ed06'])
    out('git archive cb78ed06 -> head.tar rc=%d %s' % (rc, o.strip()[:200]))
    rc, o = sh(['tar', '-xf', W + '/head.tar', '-C', T])
    out('tar -xf rc=%d %s' % (rc, o.strip()[:200]))
    rc, o = sh(['cp', '-cR', LIVE + '/node_modules', T + '/node_modules'])
    out('cp -cR node_modules rc=%d %s' % (rc, o.strip()[:200]))
    for rel in ['vite.config.ts', 'package.json', 'src/lib/build-form.test.ts', 'src-tauri/tauri.conf.json',
                'src-tauri/tauri.macos.conf.json', 'src-tauri/tauri.windows.conf.json', 'src-tauri/tauri.linux.conf.json']:
        out('  与 live 同字节:', rel, sha(f'{T}/{rel}') == sha(f'{LIVE}/{rel}'))


NAIL = 'src/lib/build-form.test.ts'
ORIG_NAIL = None


def set_nail(text):
    with open(f'{T}/{NAIL}', 'w') as f:
        f.write(text)


def nail(label):
    rc, o = sh(['npx', 'vitest', 'run', 'src/lib/build-form.test.ts', '--reporter=verbose'], cwd=T, timeout=300)
    save('nail-' + re.sub(r'[^A-Za-z0-9_.-]', '_', label), rc, o)
    m = re.search(r'Tests\s+([^\n]*)', o)
    red = re.findall(r'^\s*(?:×|✗|FAIL)\s[^\n]*', o, re.M)
    summ = f'rc={rc} | {m.group(0).strip() if m else "NO-SUMMARY"}'
    RESULTS[label] = summ
    out(f'NAIL {label}: {summ}')
    for x in red:
        out('      RED:', x.strip()[:170])
    if rc != 0 and not red:
        out('      (no per-test lines) tail:', o[-1200:])
    return rc


def apply(rel, new_text, label):
    if rel not in ORIG:
        ORIG[rel] = open(f'{T}/{rel}').read()
    cur = open(f'{T}/{rel}').read()
    assert cur == ORIG[rel], f'{rel} 施加 {label} 前不是原件'
    assert new_text != ORIG[rel], f'变异 {label} 未生效（{rel}）'
    open(f'{T}/{rel}', 'w').write(new_text)


def restore(rel):
    with open(f'{T}/{rel}', 'w') as f:
        f.write(ORIG[rel])
    assert open(f'{T}/{rel}').read() == ORIG[rel]


def o(rel):
    if rel not in ORIG:
        ORIG[rel] = open(f'{T}/{rel}').read()
    return ORIG[rel]


def scripts_patch(**kv):
    d = json.loads(o('package.json'))
    d['scripts'].update(kv)
    return json.dumps(d, indent=2, ensure_ascii=False) + '\n'


# ───────────── 变异体 ─────────────
def m_e():
    s = o('vite.config.ts')
    assert 'outDir: mode === "web" ? "dist" : "dist-desktop",' in s
    return s.replace('mode === "web" ? "dist"', 'mode !== "production" ? "dist"')


def m_a1():
    d = json.loads(o('src-tauri/tauri.macos.conf.json'))
    d['build'] = {'frontendDist': '../dist'}
    return json.dumps(d, indent=2, ensure_ascii=False) + '\n'


def m_a2():
    d = json.loads(o('src-tauri/tauri.windows.conf.json'))
    d['build'] = {'beforeBuildCommand': 'npm --prefix mcp-server ci && npm run mcp:build && npm run build:desktop'}
    return json.dumps(d, indent=2, ensure_ascii=False) + '\n'


def m_f1():
    return scripts_patch(prebuild='npm run mcp:build')


def m_f1b():
    # 协调者加码：钩子挂在链上内层脚本（build = npm run typecheck && vite build）
    return scripts_patch(pretypecheck='npm run mcp:build')


def m_f2():
    return scripts_patch(build='npm run typecheck && vite build --outDir dist')


def m_f2b():
    # 协调者加码：kebab-case 写法
    return scripts_patch(build='npm run typecheck && vite build --out-dir dist')


def m_f4():
    return scripts_patch(**{'build:web': 'npm run typecheck && vite build --mode web --outDir dist-desktop'})


def m_env():
    # 协调者加码：.env.web 的 API base 不再为空（web 构建不再同源）。内容不打印。
    s = o('.env.web')
    new, n = re.subn(r'(?m)^VITE_API_BASE_URL=[ \t]*$', 'VITE_API_BASE_URL=http://localhost:8080', s)
    assert n == 1, f'env 变异命中 {n} 行（期望 1）'
    return new


MUTANTS = [
    ('e-mode-flip', 'vite.config.ts', m_e),
    ('a1-macos-frontendDist', 'src-tauri/tauri.macos.conf.json', m_a1),
    ('a2-windows-beforeBuild', 'src-tauri/tauri.windows.conf.json', m_a2),
    ('f1-prebuild', 'package.json', m_f1),
    ('f2-outDir-flag', 'package.json', m_f2),
    ('f4-web-outDir-flag', 'package.json', m_f4),
    ('X-f1b-pretypecheck', 'package.json', m_f1b),
    ('X-f2b-out-dir-kebab', 'package.json', m_f2b),
    ('X-env-web-base', '.env.web', m_env),
]
R1_SURVIVORS = ['e-mode-flip', 'a1-macos-frontendDist', 'a2-windows-beforeBuild', 'f1-prebuild', 'f2-outDir-flag', 'f4-web-outDir-flag']

# ───────────── 加固版钉子 ─────────────
BLOCK_A = r'''
  it("A1 不变量：除 web 外任何 mode 都不写 dist/", async () => {
    for (const m of ["production", "development", "staging", "test"]) {
      expect(await outDirFor(m), `mode=${m}`).not.toBe(WEB_OUT_DIR)
    }
  })
  it("A2 平台 conf 不得覆盖 build 段", () => {
    for (const p of ["macos", "linux", "windows"]) {
      const c = readJson(`src-tauri/tauri.${p}.conf.json`) as { build?: Record<string, string> }
      expect(c.build ?? {}).not.toHaveProperty("frontendDist")
      expect(c.build ?? {}).not.toHaveProperty("beforeBuildCommand")
    }
  })
  it("A3 vite build 命令行不得带会盖掉配置的 flag", () => {
    const commands = [
      ...expand(pkg.scripts.build),
      ...expand(pkg.scripts["build:web"]),
      ...expand(tauri.build.beforeBuildCommand ?? ""),
    ]
    for (const cmd of commands) expect(cmd).not.toMatch(/--outDir|--config\b|\s-c\b/)
  })
  it("A4 生命周期钩子里不得重建 mcp", () => {
    for (const n of ["prebuild", "postbuild", "prebuild:desktop", "postbuild:desktop", "prebuild:web", "postbuild:web"]) {
      expect(pkg.scripts[n] ?? "").not.toMatch(/mcp/)
    }
  })
'''

HELPERS_B = r'''
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

BLOCK_B = r'''
  it("B1 不变量：除 web 外任何 mode 都不写 dist/", async () => {
    for (const m of ["production", "development", "staging", "test"]) {
      expect(await outDirFor(m), `mode=${m}`).not.toBe(WEB_OUT_DIR)
    }
  })
  it("B2 任何 tauri.<platform>.conf.json 都不得覆盖 build 段", () => {
    const names = readdirSync(path.join(ROOT, "src-tauri")).filter((n) => /^tauri\.[^.]+\.conf\.json$/.test(n))
    expect(names.length).toBeGreaterThan(0)
    for (const f of names) {
      const c = readJson(`src-tauri/${f}`) as { build?: Record<string, string> }
      expect(c.build ?? {}).not.toHaveProperty("frontendDist")
      expect(c.build ?? {}).not.toHaveProperty("beforeBuildCommand")
    }
  })
  it("B3 vite build 命令行不得带会盖掉配置的 flag（含 kebab-case）", () => {
    const chains = [pkg.scripts.build, pkg.scripts["build:web"], tauri.build.beforeBuildCommand ?? ""]
    for (const cmd of chains.flatMap((c) => expand(c))) {
      expect(cmd).not.toMatch(/--out-?dir|--config\b|\s-c\b/i)
    }
  })
  it("B4 链上每个脚本（递归）的 pre/post 钩子都不得碰 mcp", () => {
    const names = new Set<string>()
    for (const c of [pkg.scripts.build, pkg.scripts["build:web"], tauri.build.beforeBuildCommand ?? ""]) {
      referencedScripts(c, names)
    }
    expect(names.has("build")).toBe(true)
    expect(names.has("typecheck")).toBe(true)
    for (const n of names) {
      for (const hook of [`pre${n}`, `post${n}`]) {
        if (pkg.scripts[hook] !== undefined) {
          for (const cmd of expand(pkg.scripts[hook])) expect(cmd, hook).not.toMatch(/mcp/)
        }
      }
    }
  })
'''


def with_block(block, helpers=''):
    base = ORIG_NAIL.rstrip()
    assert base.endswith('})'), '原钉结尾不是 })'
    text = base[:-2] + block + '})\n'
    if helpers:
        text = text.replace('\ndescribe("build 形态 × 产物目录分流", () => {', '\n' + helpers + '\ndescribe("build 形态 × 产物目录分流", () => {')
        text = text.replace('import { readFileSync } from "node:fs"', 'import { readdirSync, readFileSync } from "node:fs"')
    return text


# ───────────── light：变异矩阵 ─────────────
def light():
    out(f'== LIGHT start {now()} ==')
    setup()
    global ORIG_NAIL
    ORIG_NAIL = open(f'{T}/{NAIL}').read()
    out('原钉 it( 数 =', len(re.findall(r'^\s*it\(', ORIG_NAIL, re.M)))

    nail('ORIG-baseline-nogit')
    rc, o_ = sh(['git', 'init', '-q'], cwd=T)
    out('git init (copy) rc=%d' % rc)
    nail('ORIG-baseline')

    versions = [('ORIG', ORIG_NAIL), ('A-R1-proposal', with_block(BLOCK_A)), ('B-hardened', with_block(BLOCK_B, HELPERS_B))]
    for vname, text in versions:
        set_nail(text)
        if vname != 'ORIG':
            nail(f'{vname}-baseline')
        for mname, rel, fn in MUTANTS:
            apply(rel, fn(), mname)
            try:
                nail(f'{vname}--{mname}')
            finally:
                restore(rel)
    set_nail(ORIG_NAIL)
    nail('ORIG-restored-final')

    out('')
    out('== 矩阵（钉子结果：绿=变异体存活 / 红=被杀）==')
    for mname, _, _ in MUTANTS:
        tag = 'R1存活体' if mname in R1_SURVIVORS else '协调者加码'
        row = [f'{mname:26s} [{tag}]']
        for vname, _ in versions:
            s = RESULTS.get(f'{vname}--{mname}', '?')
            mm = re.search(r'(\d+) passed|(\d+) failed', s)
            passed = re.search(r'(\d+) passed', s)
            failed = re.search(r'(\d+) failed', s)
            row.append(f'{vname}: ' + (f"RED({failed.group(1)} failed)" if failed else f"green({passed.group(1) if passed else '?'})" if 'rc=0' in s else 'ERR'))
        out('  '.join(row))
    out(f'== LIGHT end {now()} ==')


# ───────────── heavy：行为级 + 全量 ─────────────
def form(d):
    if not os.path.isdir(d):
        return 'ABSENT'
    n = sum(len(fs) for _, _, fs in os.walk(d))
    assets = os.listdir(os.path.join(d, 'assets')) if os.path.isdir(os.path.join(d, 'assets')) else []
    ac = sorted(f for f in assets if f.startswith('api-client-'))
    ix = sorted(f for f in assets if f.startswith('index-') and f.endswith('.js'))
    cls = '?'
    if ac:
        s = open(os.path.join(d, 'assets', ac[0])).read()
        i = s.find('http://localhost:8080')
        if i >= 0:
            after = s[i:i+400]
            mv = re.search(r'[\w$]+\(void 0\)', after)
            me = re.search(r'[\w$]+\(``\)', after)
            if mv and (not me or mv.start() < me.start()):
                cls = 'DESKTOP (' + mv.group(0) + ')'
            elif me:
                cls = 'WEB (' + me.group(0) + ')'
            else:
                cls = 'UNKNOWN after=' + repr(after[:110])
        else:
            cls = 'no-literal'
    return f'files={n} api-client={ac[0] if ac else None} entry={ix[0] if ix else None} {cls}'


def heavy():
    out(f'== HEAVY start {now()} ==')
    setup()
    global ORIG_NAIL
    ORIG_NAIL = open(f'{T}/{NAIL}').read()
    if not os.path.isdir(T + '/.git'):
        sh(['git', 'init', '-q'], cwd=T)

    def build(label, cmd):
        rc, o_ = sh(cmd, cwd=T, timeout=900)
        save('build-' + label, rc, o_[-6000:])
        out(f'BUILD {label}: `{" ".join(cmd)}` rc={rc}')
        out('    dist/        :', form(f'{T}/dist'))
        out('    dist-desktop/:', form(f'{T}/dist-desktop'))

    def snap():
        return (snapshot(f'{T}/dist') if os.path.isdir(f'{T}/dist') else {},
                snapshot(f'{T}/dist-desktop') if os.path.isdir(f'{T}/dist-desktop') else {})

    def chg(a, b):
        return f'变化={sum(1 for k in set(a) | set(b) if a.get(k) != b.get(k))}/{len(set(a) | set(b))}'

    if '--no-clean' not in sys.argv:
        for d in ('dist', 'dist-desktop'):
            if os.path.isdir(f'{T}/{d}'):
                shutil.rmtree(f'{T}/{d}')

    live_dist = snapshot(f'{LIVE}/dist')
    live_dd = snapshot(f'{LIVE}/dist-desktop')
    out(f'live: dist {len(live_dist)} 文件, dist-desktop {len(live_dd)} 文件')

    build('H1-build-web', ['npm', 'run', 'build:web'])
    s1 = snap()
    out(f'  副本 dist vs live dist: 同字节 {same(s1[0], live_dist)}/{len(s1[0])}（live {len(live_dist)}）; dist-desktop 存在={bool(s1[1])}')
    build('H2-build-desktop', ['npm', 'run', 'build'])
    s2 = snap()
    out(f'  副本 dist-desktop vs live dist-desktop: 同字节 {same(s2[1], live_dd)}/{len(s2[1])}（live {len(live_dd)}）; dist/ 在桌面构建后 {chg(s1[0], s2[0])}; dist-desktop 内部 web/桌面两套交集同字节 {same(s1[1], s2[1])}')
    build('H3-f2-flag-outDir-dist', ['npx', 'vite', 'build', '--outDir', 'dist'])
    s3 = snap()
    out(f'  dist/ {chg(s2[0], s3[0])}; dist-desktop/ {chg(s2[1], s3[1])}')
    build('H4-build-web-again', ['npm', 'run', 'build:web'])
    s4 = snap()
    out(f'  dist/ {chg(s3[0], s4[0])}')
    apply('vite.config.ts', m_e(), 'e')
    try:
        build('H5-mutant-e-dev-mode', ['npx', 'vite', 'build', '--mode', 'development'])
    finally:
        restore('vite.config.ts')
    s5 = snap()
    out(f'  dist/ {chg(s4[0], s5[0])}; dist-desktop/ {chg(s4[1], s5[1])}')
    out('  vite.config.ts 还原后与 live 同字节:', sha(f'{T}/vite.config.ts') == sha(f'{LIVE}/vite.config.ts'))
    build('H6-build-web-restore', ['npm', 'run', 'build:web'])
    s6 = snap()
    build('H7-f4-flag-web-outDir-dist-desktop', ['npx', 'vite', 'build', '--mode', 'web', '--outDir', 'dist-desktop'])
    s7 = snap()
    out(f'  dist/ {chg(s6[0], s7[0])}; dist-desktop/ {chg(s6[1], s7[1])}')
    build('H8-build-desktop-restore', ['npm', 'run', 'build'])

    # M-6：vite preview 预览的是哪个目录
    pv = subprocess.Popen(['npx', 'vite', 'preview', '--port', '4179', '--strictPort', '--host', '127.0.0.1'], cwd=T,
                          env={**os.environ, **ENV}, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    served = None
    for _ in range(40):
        time.sleep(0.25)
        rc, body = sh(['curl', '-s', '--max-time', '2', 'http://127.0.0.1:4179/'], timeout=10)
        if rc == 0 and '<html' in body.lower():
            served = hashlib.sha256(body.encode()).hexdigest()
            break
    pv.terminate()
    try:
        pv.wait(timeout=5)
    except Exception:
        pv.kill()
    h = lambda p: hashlib.sha256(open(p, 'rb').read()).hexdigest() if os.path.isfile(p) else None
    out(f'M-6 preview: served_index==dist/index.html? {served == h(f"{T}/dist/index.html")} | ==dist-desktop/index.html? {served == h(f"{T}/dist-desktop/index.html")} | served={bool(served)}')

    # Q9-f1：npm 生命周期钩子（scratch 包，1 秒级）
    S = W + '/scratch-pkg'
    os.makedirs(S, exist_ok=True)
    json.dump({'name': 'scratch', 'version': '1.0.0',
               'scripts': {'build': "node -e \"console.log('REAL-BUILD')\"", 'prebuild': "node -e \"console.log('HOOK-RAN')\""}},
              open(S + '/package.json', 'w'))
    rc, o_ = sh(['npm', 'run', 'build'], cwd=S, timeout=60)
    out(f'npm 钩子检查（npm {sh(["npm", "--version"])[1].strip()}）: rc={rc} 执行顺序={re.findall(r"HOOK-RAN|REAL-BUILD", o_)}')

    # 全量 test:mocks
    t0 = time.time()
    rc, o_ = sh(['npm', 'run', 'test:mocks'], cwd=T, timeout=2400)
    save('test-mocks-head', rc, o_[-30000:])
    m = re.search(r'Test Files\s+[^\n]*', o_)
    n = re.search(r'Tests\s+[^\n]*', o_)
    d = re.search(r'Duration\s+[^\n]*', o_)
    out(f'TEST:MOCKS HEAD(cb78ed06 副本): rc={rc} | {m.group(0).strip() if m else "?"} | {n.group(0).strip() if n else "?"} | {d.group(0).strip() if d else "?"} | wall={time.time()-t0:.0f}s')
    out('  build-form 行:', re.findall(r'[^\n]*build-form\.test\.ts[^\n]*', o_)[:2])

    # base→HEAD 在 test:mocks 口径内的文件变化
    rc, o_ = sh(['git', '--no-optional-locks', '-C', LIVE, 'diff', '--name-status', '710111b0', 'cb78ed06'])
    files = [l for l in o_.splitlines() if l.strip()]
    scoped = [l for l in files if re.match(r'\s*[AMDR]\S*\s+src/', l) and '.real-llm.test.' not in l and '/mcp-server/' not in l]
    out(f'710111b0..cb78ed06 变更文件 {len(files)} 个；落在 test:mocks 口径（src/ 且非 real-llm、非 mcp-server）的: {scoped}')

    # Minor 抽查（live 只读）
    def line(path, needle, limit=3):
        for i, l in enumerate(open(path, errors='replace'), 1):
            if needle in l:
                out(f'  {path.replace(LIVE + "/", "")}:{i}: {l.strip()[:230]}')
                limit -= 1
                if limit == 0:
                    break
    out('Minor 抽查:')
    line(f'{LIVE}/src-server/src/routes/mod.rs', 'npm run build')
    line(f'{LIVE}/docker-compose.prod.yml', './dist')
    for i, l in enumerate(open(f'{LIVE}/.dockerignore'), 1):
        if 'dist' in l:
            out(f'  .dockerignore:{i}: {l.strip()}')
    rp = f'{LIVE}/docs/superpowers/reviews/2026-11-24-glm54-rereview/report.md'
    rl = open(rp).read().split('\n')
    out(f'  report.md 总行数 {len(rl)}')
    for n_ in (49, 182):
        out(f'  report.md:{n_}: {rl[n_-1].strip()[:260]}')

    # live 终态
    out('live 终态:')
    rc, o_ = sh(['git', '--no-optional-locks', '-C', LIVE, 'rev-parse', '--short', 'HEAD'])
    out('  HEAD', o_.strip())
    out('  live dist/      :', form(f'{LIVE}/dist'))
    out('  live dist-desktop/:', form(f'{LIVE}/dist-desktop'))
    s_end_d, s_end_dd = snapshot(f'{LIVE}/dist'), snapshot(f'{LIVE}/dist-desktop')
    out(f'  live dist 本次前后 {chg(live_dist, s_end_d)}; dist-desktop {chg(live_dd, s_end_dd)}')
    rc, o_ = sh(['git', '--no-optional-locks', '-C', LIVE, 'status', '--short'], timeout=60)
    out('  git status --short:', o_.strip().replace('\n', ' | '))
    out(f'== HEAVY end {now()} ==')


if __name__ == '__main__':
    try:
        if MODE == 'light':
            light()
        else:
            heavy()
    except Exception:
        import traceback
        out('EXCEPTION:\n' + traceback.format_exc())
        sys.exit(1)
