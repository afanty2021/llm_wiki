#!/usr/bin/env python3
"""11.3-1 落实后的终验：live 的 src/lib/build-form.test.ts 已是再加固版 C——对 live 文件的内容重跑 19 个变异体。

复用第二轮的变异器（r1-verify.py / r4-nail-verify.py，原件在 /tmp/glm54-recheck-20261125/C/scripts/）。
live 检出只读；一切写入在 /tmp。用法：python3 nail-final-verify.py
"""
import importlib.util
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
W = os.path.dirname(HERE)
PREV = '/tmp/glm54-recheck-20261125/C/scripts'
LIVE = '/Users/berton/Github/kb-obsidian/llm_wiki'
ARCHIVED_C = LIVE + '/docs/superpowers/reviews/2026-11-24-glm54-rereview/evidence/verify/recheck2/coordinator/nail-hardened-C.test.ts'

spec = importlib.util.spec_from_file_location('r4v', PREV + '/r4-nail-verify.py')
r4 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r4)
r1v = r4.r1v
r1v.SUMMARY.close()
os.makedirs(W + '/raw', exist_ok=True)
r1v.SUMMARY = open(W + '/raw/summary-nail-final.txt', 'a')
out, sh, now = r1v.out, r1v.sh, r1v.now
T, NAIL = r1v.T, r1v.NAIL
RESULTS = {}


def nail(label):
    rc, o = sh(['npx', 'vitest', 'run', 'src/lib/build-form.test.ts', '--reporter=verbose'], cwd=T, timeout=300)
    r1v.save('nail-final-' + label, rc, o)
    m = re.search(r'Tests\s+([^\n]*)', o)
    failed = re.search(r'(\d+) failed', o)
    passed = re.search(r'(\d+) passed', o)
    RESULTS[label] = 'RED' if failed else ('green' if rc == 0 else 'ERR')
    out(f'NAIL {label}: rc={rc} | {m.group(0).strip() if m else "NO-SUMMARY"}')
    if failed:
        for x in re.findall(r'^\s*(?:×|✗|FAIL)\s[^\n]*', o, re.M):
            out('      RED:', x.strip()[:170])


def main():
    out(f'== NAIL-FINAL start {now()} ==')
    r1v.setup()
    live = open(f'{LIVE}/{NAIL}').read()
    archived = open(ARCHIVED_C).read()
    out('live 钉与归档 nail-hardened-C 同字节:', live == archived, '| sha256', r1v.sha(f'{LIVE}/{NAIL}')[:16])
    out('it( 数 =', len(re.findall(r'^[ ]*it[(]', live, re.M)))
    for rel in ['vite.config.ts', 'package.json', '.env.web', '.gitignore', 'src-tauri/tauri.conf.json',
                'src-tauri/tauri.macos.conf.json', 'src-tauri/tauri.windows.conf.json', 'src-tauri/tauri.linux.conf.json']:
        same = r1v.sha(f'{T}/{rel}') == r1v.sha(f'{LIVE}/{rel}')
        out(f'  副本与 live 同字节: {rel} {same}')
        assert same, rel
    r1v.set_nail(live)
    nail('baseline')
    for mname, rel, fn in r4.MUTANTS:
        r1v.apply(rel, fn(), mname)
        try:
            r1v.set_nail(live)
            nail(mname)
        finally:
            r1v.restore(rel)
    r1v.set_nail(live)
    nail('restored-final')
    out('')
    out('== 矩阵（live 钉 = C；green = 变异体存活 / RED = 被杀）==')
    for mname, rel, _ in r4.MUTANTS:
        out(f'  {mname:16s} {rel:36s} {RESULTS.get(mname, "?")}')
    surv = [m for m, _, _ in r4.MUTANTS if RESULTS.get(m) != 'RED']
    out(f'live 钉: 存活 {len(surv)} / {len(r4.MUTANTS)} -> {surv}')
    out(f'== NAIL-FINAL end {now()} ==')
    sys.exit(0 if (not surv and RESULTS.get('baseline') == 'green' and RESULTS.get('restored-final') == 'green') else 1)


if __name__ == '__main__':
    main()
