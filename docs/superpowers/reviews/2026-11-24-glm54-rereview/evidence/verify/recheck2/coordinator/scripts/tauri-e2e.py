#!/usr/bin/env python3
"""协调者独立端到端：在 /tmp 副本里跑一趟 `tauri build --bundles app`（--offline），验证
「桌面构建不碰 dist/、不重建 mcp-server、frontendDist 与产物目录对齐、bundle 内 MCP 是只读拷贝」。
live 检出只读；一切写入在 /tmp/glm54-recheck-20261125/C/。"""
import glob
import hashlib
import os
import re
import subprocess
import sys
import time
import traceback

LIVE = '/Users/berton/Github/kb-obsidian/llm_wiki'
W = '/tmp/glm54-recheck-20261125/C'
T = W + '/tree'
RAW = W + '/raw'
SUM = open(RAW + '/summary-tauri.txt', 'a')


def out(*a):
    s = ' '.join(str(x) for x in a)
    print(s, flush=True)
    SUM.write(s + '\n')
    SUM.flush()


def now():
    return time.strftime('%Y-%m-%d %H:%M:%S')


def sha(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''):
            h.update(b)
    return h.hexdigest()


def snapshot(d):
    r = {}
    for root, _, fs in os.walk(d):
        for f in fs:
            p = os.path.join(root, f)
            r[os.path.relpath(p, d)] = sha(p)
    return r


def nm_state(d):
    st = os.stat(d)
    newest = 0.0
    n = 0
    for root, dirs, fs in os.walk(d):
        for name in dirs + fs:
            try:
                m = os.lstat(os.path.join(root, name)).st_mtime
                newest = max(newest, m)
                n += 1
            except OSError:
                pass
    return {'inode': st.st_ino, 'dir_mtime': time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(st.st_mtime)),
            'entries': n, 'newest_entry_mtime': time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(newest)),
            'package_lock_sha': sha(os.path.join(d, '.package-lock.json'))}


def same(a, b):
    return sum(1 for k in a if k in b and b[k] == a[k])


def state():
    return {
        'dist': snapshot(f'{T}/dist'),
        'dist-desktop': snapshot(f'{T}/dist-desktop'),
        'mcp-server/dist': snapshot(f'{T}/mcp-server/dist'),
        'mcp-server/node_modules': nm_state(f'{T}/mcp-server/node_modules'),
    }


def cmp_state(a, b, label):
    for k in ('dist', 'dist-desktop', 'mcp-server/dist'):
        chg = sum(1 for f in set(a[k]) | set(b[k]) if a[k].get(f) != b[k].get(f))
        out(f'  {label} {k}: 变化 {chg}/{len(set(a[k]) | set(b[k]))}')
    na, nb = a['mcp-server/node_modules'], b['mcp-server/node_modules']
    out(f'  {label} mcp-server/node_modules: ' + ', '.join(f'{x}={"同" if na[x] == nb[x] else "异"}' for x in na)
        + f' (inode={nb["inode"]}, dir_mtime={nb["dir_mtime"]}, entries={nb["entries"]}, newest_entry={nb["newest_entry_mtime"]})')


def main():
    out(f'== TAURI E2E start {now()} ==')
    st0 = state()
    out('开工: dist %d 文件, dist-desktop %d 文件, mcp-server/dist %d 文件' % (len(st0['dist']), len(st0['dist-desktop']), len(st0['mcp-server/dist'])))
    for k, v in st0['mcp-server/node_modules'].items():
        out(f'  mcp-server/node_modules.{k} = {v}')
    live_dist = snapshot(f'{LIVE}/dist')
    out('  副本 dist 与 live dist 同字节: %d/%d' % (same(st0['dist'], live_dist), len(st0['dist'])))

    env = dict(os.environ)
    env['PATH'] = os.path.expanduser('~/.rustup/toolchains/stable-aarch64-apple-darwin/bin') + ':' + os.path.expanduser('~/.cargo/bin') + ':' + env['PATH']
    env['CARGO_BUILD_JOBS'] = '6'
    env['npm_config_logs_dir'] = W + '/npm-logs'
    cmd = ['npm', 'run', 'tauri', '--', 'build', '--bundles', 'app', '--', '--offline']
    out('命令:', ' '.join(cmd), '| CARGO_BUILD_JOBS=6 | PATH 加 cargo 工具链')
    t0 = time.time()
    p = subprocess.run(cmd, cwd=T, env=env, capture_output=True, text=True)
    wall = time.time() - t0
    o = p.stdout + p.stderr
    open(RAW + '/tauri-build.txt', 'w').write(f'$ rc={p.returncode} wall={wall:.0f}s\n{o}')
    out(f'tauri build: rc={p.returncode} wall={wall:.0f}s ({wall/60:.1f} min)')
    for pat in (r'Finished [`"].*', r'Built application[`"].*', r'Bundling [^\n]*', r'error[^\n]*', r'warning: unused[^\n]*'):
        hits = re.findall(pat, o)
        for h in hits[:6]:
            out('   >', h[:200])
    tail = [l for l in o.strip().split('\n') if l.strip()][-6:]
    for l in tail:
        out('   |', l[:200])

    st1 = state()
    cmp_state(st0, st1, '构建前后')
    out('  构建后 dist-desktop 与 live dist-desktop 同字节: %d/%d (live %d)' % (same(st1['dist-desktop'], snapshot(f'{LIVE}/dist-desktop')), len(st1['dist-desktop']), 221))

    apps = glob.glob(f'{T}/src-tauri/target/release/bundle/macos/*.app')
    out('bundle/macos/*.app:', [os.path.basename(a) for a in apps])
    for app in apps:
        res = os.path.join(app, 'Contents', 'Resources', 'mcp-server')
        out('  bundle Resources 顶层:', sorted(os.listdir(os.path.join(app, 'Contents', 'Resources')))[:20])
        for rel in ('package.json', 'dist/src/web-clip.js', 'dist/src/index.js', 'node_modules/undici/package.json'):
            a, b = os.path.join(res, rel), os.path.join(T, 'mcp-server', rel)
            out(f'   bundle mcp-server/{rel}: 存在={os.path.isfile(a)} 与副本检出同字节={os.path.isfile(a) and sha(a) == sha(b)}')
    info = os.path.join(apps[0], 'Contents', 'Info.plist') if apps else None
    if info and os.path.isfile(info):
        m = re.search(r'<key>CFBundleShortVersionString</key>\s*<string>([^<]+)</string>', open(info).read())
        out('  Info.plist CFBundleShortVersionString =', m.group(1) if m else '?')
    binary = f'{T}/src-tauri/target/release/llm-wiki'
    if os.path.isfile(binary):
        data = open(binary, 'rb').read()
        out(f'  release 二进制 {len(data)/1e6:.1f} MB mtime={time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(os.path.getmtime(binary)))}')
        names = lambda d: set(os.listdir(os.path.join(d, 'assets')))
        desk_only = sorted(names(f'{T}/dist-desktop') - names(f'{T}/dist'))
        web_only = sorted(names(f'{T}/dist') - names(f'{T}/dist-desktop'))
        hit = lambda n: (b'assets/' + n.encode()) in data
        out(f'  桌面独有资源名 {sum(hit(n) for n in desk_only)}/{len(desk_only)} 出现在二进制；web 独有资源名 {sum(hit(n) for n in web_only)}/{len(web_only)}')
        out(f'  api-client: desktop 名在二进制={hit([n for n in desk_only if n.startswith("api-client-")][0])}, web 名在二进制={hit([n for n in web_only if n.startswith("api-client-")][0])}')
    else:
        out('  release 二进制不存在')

    st2 = state()
    cmp_state(st1, st2, '核对期间(应零变化)')
    out('live 终态:')
    out('  live dist 与开工快照同字节: %d/%d' % (same(snapshot(f'{LIVE}/dist'), live_dist), len(live_dist)))
    lv = nm_state(f'{LIVE}/mcp-server/node_modules')
    out('  live mcp-server/node_modules:', {k: lv[k] for k in ('inode', 'dir_mtime', 'entries', 'newest_entry_mtime')})
    out(f'== TAURI E2E end {now()} ==')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        out('EXCEPTION:\n' + traceback.format_exc())
        sys.exit(1)
