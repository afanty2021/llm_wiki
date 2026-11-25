#!/usr/bin/env python3
"""加验（R1 席 Q3-ii 与 R4 席 M-7 说法相反、都没实跑）：暖构建下 `tauri build` 怎么对待 mcp-server/dist。

在协调者自己的 /tmp 副本里（C/tree，src-tauri/target 已暖）连打三趟：
  S1 不改动再打一次 —— 暖构建耗时，包内 mcp-server 是否原样；
  S2 改 mcp-server/dist/src/admin.js（尾部加注释）并新增 mcp-server/dist/PROBE.txt —— 改动与新文件进不进包；
  S3 把副本的 mcp-server/dist 挪走 —— 构建成败，包里留下什么。
live 检出只读：只在头尾取 live mcp-server/dist 的 sha 证明未被触碰。用法：python3 tauri-mcp-freshness.py"""
import glob
import hashlib
import os
import re
import shutil
import subprocess
import time

LIVE = '/Users/berton/Github/kb-obsidian/llm_wiki'
W = '/tmp/glm54-recheck-20261125/C'
T = W + '/tree'
RAW = W + '/raw'
SUM = open(RAW + '/summary-tauri-mcp.txt', 'a')
SRC = T + '/mcp-server'
STAGE = T + '/src-tauri/target/release/mcp-server'
APP = T + '/src-tauri/target/release/bundle/macos/LLM Wiki.app/Contents/Resources/mcp-server'
PARK = W + '/r3/mcp-dist-parked'


def out(*a):
    s = ' '.join(str(x) for x in a)
    print(s, flush=True)
    SUM.write(s + '\n')
    SUM.flush()


def now():
    return time.strftime('%Y-%m-%d %H:%M:%S')


def sha(p):
    return hashlib.sha256(open(p, 'rb').read()).hexdigest() if os.path.isfile(p) else None


def mt(p):
    return time.strftime('%m-%d %H:%M:%S', time.localtime(os.path.getmtime(p))) if os.path.exists(p) else None


def probe(tag):
    for name, base in (('源', SRC), ('target 暂存', STAGE), ('bundle', APP)):
        d = os.path.join(base, 'dist')
        n = sum(len(fs) for _, _, fs in os.walk(d)) if os.path.isdir(d) else 'ABSENT'
        a, pr = os.path.join(d, 'src/admin.js'), os.path.join(d, 'PROBE.txt')
        out(f'    {tag} {name}: dist 文件数={n} | admin.js sha={(sha(a) or "ABSENT")[:12]} mtime={mt(a)} | PROBE.txt={"在" if os.path.isfile(pr) else "无"}')


def build(label):
    env = dict(os.environ)
    env['PATH'] = (os.path.expanduser('~/.rustup/toolchains/stable-aarch64-apple-darwin/bin') + ':'
                   + os.path.expanduser('~/.cargo/bin') + ':' + env['PATH'])
    env['CARGO_BUILD_JOBS'] = '6'
    env['npm_config_logs_dir'] = W + '/npm-logs'
    cmd = ['npm', 'run', 'tauri', '--', 'build', '--bundles', 'app', '--', '--offline']
    t0 = time.time()
    p = subprocess.run(cmd, cwd=T, env=env, capture_output=True, text=True)
    wall = time.time() - t0
    o = p.stdout + p.stderr
    open(f'{RAW}/tauri-mcp-{label}.txt', 'w').write(f'$ rc={p.returncode} wall={wall:.0f}s\n{o}')
    out(f'[{label}] tauri build rc={p.returncode} wall={wall:.0f}s ({wall / 60:.1f} min)')
    for pat in (r'Finished [`"].*', r'Built application[`"].*', r'Bundling [^\n]*', r'(?:^|\s)error[^\n]*',
                r'panicked[^\n]*', r'[Rr]esource[^\n]*(?:not found|does not exist|doesn\'t exist)[^\n]*', r'Rerun[^\n]*'):
        for h in re.findall(pat, o, re.M)[:5]:
            out('    >', h.strip()[:220])


def main():
    out(f'== TAURI-MCP start {now()} ==')
    live_a0, live_p0 = sha(f'{LIVE}/mcp-server/dist/src/admin.js'), os.path.exists(f'{LIVE}/mcp-server/dist/PROBE.txt')
    orig_admin = open(f'{SRC}/dist/src/admin.js').read()
    assert not os.path.exists(f'{SRC}/dist/PROBE.txt')
    probe('S0 开工')

    build('S1-warm-unchanged')
    probe('S1')

    open(f'{SRC}/dist/src/admin.js', 'w').write(orig_admin + f'// PROBE-MOD {int(time.time())}\n')
    open(f'{SRC}/dist/PROBE.txt', 'w').write('probe\n')
    probe('S2 施变后')
    build('S2-modified')
    probe('S2')

    assert not os.path.exists(PARK)
    shutil.move(f'{SRC}/dist', PARK)
    probe('S3 挪走后')
    build('S3-dist-missing')
    probe('S3')

    # 复原副本
    if os.path.isdir(f'{SRC}/dist'):
        shutil.rmtree(f'{SRC}/dist')
    shutil.move(PARK, f'{SRC}/dist')
    open(f'{SRC}/dist/src/admin.js', 'w').write(orig_admin)
    os.remove(f'{SRC}/dist/PROBE.txt')
    probe('复原后')

    live_a1, live_p1 = sha(f'{LIVE}/mcp-server/dist/src/admin.js'), os.path.exists(f'{LIVE}/mcp-server/dist/PROBE.txt')
    out(f'live mcp-server/dist 未被触碰: admin.js sha 同={live_a0 == live_a1}，live 无 PROBE.txt={not live_p1 and not live_p0}')
    out(f'== TAURI-MCP end {now()} ==')


if __name__ == '__main__':
    main()
