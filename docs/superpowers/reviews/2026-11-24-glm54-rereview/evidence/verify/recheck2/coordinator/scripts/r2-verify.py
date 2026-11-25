#!/usr/bin/env python3
"""协调者亲验 R2b 席（web-clip undici destroy 崩溃修复）。live 只读；一切写入在 /tmp/glm54-recheck-20261125/C/。"""
import glob
import hashlib
import os
import re
import shutil
import subprocess
import sys
import time
import traceback

LIVE = '/Users/berton/Github/kb-obsidian/llm_wiki'
W = '/tmp/glm54-recheck-20261125/C'
M = W + '/tree/mcp-server'
RAW = W + '/raw'
ENV = {'npm_config_logs_dir': W + '/npm-logs'}
PROD = '/Users/berton/.hermes/tools/node-26.12.1-darwin-arm64/bin/node'
LOCAL = shutil.which('node')
LIVE_WEBCLIP_SHA = 'f3b8562d79029bd44b8eaec0a5c1b10788e93cb7a3988d97a2101d81dd1d2b3f'
SRC = 'src/web-clip.ts'
NET = 'test/web-clip-net.test.ts'
CLOSURE_LISTENER = '      res.body.once("error", () => {})\n'

os.makedirs(RAW, exist_ok=True)
SUM = open(RAW + '/summary-r2.txt', 'a')
ORIG = {}


def out(*a):
    s = ' '.join(str(x) for x in a)
    print(s, flush=True)
    SUM.write(s + '\n')
    SUM.flush()


def now():
    return time.strftime('%Y-%m-%d %H:%M:%S')


def sh(cmd, cwd=None, timeout=600):
    e = dict(os.environ)
    e.update(ENV)
    p = subprocess.run(cmd, cwd=cwd, env=e, capture_output=True, text=True, timeout=timeout)
    return p.returncode, p.stdout + p.stderr


def sha(p):
    return hashlib.sha256(open(p, 'rb').read()).hexdigest()


def save(name, rc, text):
    open(f'{RAW}/{name}.txt', 'w').write(f'$ rc={rc}\n{text}')


def orig(rel):
    if rel not in ORIG:
        ORIG[rel] = open(f'{M}/{rel}').read()
    return ORIG[rel]


def put(rel, text, label):
    cur = open(f'{M}/{rel}').read()
    assert cur == orig(rel), f'{rel} 施加 {label} 前不是原件'
    assert text != orig(rel), f'{label} 未生效'
    open(f'{M}/{rel}', 'w').write(text)


def restore(rel):
    open(f'{M}/{rel}', 'w').write(orig(rel))
    assert open(f'{M}/{rel}').read() == orig(rel)


def build(label):
    t0 = time.time()
    rc, o = sh(['npm', '--prefix', M, 'run', 'build'])
    save('r2-build-' + label, rc, o[-3000:])
    out(f'BUILD {label}: rc={rc} {time.time()-t0:.1f}s ts_errors={len(re.findall(r"error TS", o))} dist_web-clip.js={sha(M+"/dist/src/web-clip.js")[:16]}')
    return rc


def totals(tap):
    # 聚合摘要在最后：取每个计数器的最后一次出现
    def last(key):
        ms = re.findall(rf'^# {key} (\d+)$', tap, re.M)
        return int(ms[-1]) if ms else None
    return {k: last(k) for k in ('tests', 'pass', 'fail', 'skipped')}


def runtests(label, files, node):
    rc, o = sh([node, '--test', '--test-reporter=tap', *files], cwd=M)
    save('r2-test-' + label, rc, o)
    t = totals(o)
    notok = [l.strip() for l in o.split('\n') if re.match(r'^\s*not ok ', l)]
    codes = sorted(set(re.findall(r"code: '([A-Z_]+)'", o)))
    ftypes = sorted(set(re.findall(r"failureType: '([a-zA-Z]+)'", o)))
    out(f'TEST {label} [{node.rsplit("/", 1)[-1]}@{os.path.dirname(node)[-20:]}]: rc={rc} {t} codes={codes} failureType={ftypes}')
    for l in notok:
        out('      ' + l[:150])
    return rc, t, o


FULLPATH = r'''
// ── R2b 评审试写：全路径钉（fetchWithGuards 重定向分支 → 生产 destroy 闭包）──
test("真网络·全路径：fetchWithGuards 重定向分支销毁在飞 302 body 不击杀进程（R2b 试写）", async () => {
  let hits = 0
  const s = await startServer((req, res) => {
    hits += 1
    if (req.url === "/old-link") {
      // 永不 end 的 302（在飞 body）；Location 相对解析后进第二跳
      res.writeHead(302, { location: "/final" })
      const drip = setInterval(() => res.write("redirect-body"), 20)
      res.on("close", () => clearInterval(drip))
      res.on("error", () => clearInterval(drip))
      return
    }
    res.setHeader("content-type", "text/html")
    res.end("<html><body>final-ok</body></html>")
  })
  try {
    const out = await fetchWithGuards(`http://weixin-old.invalid:${s.port}/old-link`, {
      // 只替换「钉哪个地址」：门放行的公网地址；requestOnce 仍是生产 undiciRequestOnce（真连环回）
      lookupAll: async () => [{ address: "93.184.216.34", family: 4 }],
      requestOnce: (url) => undiciRequestOnce(url, LOOPBACK),
    })
    assert.equal(out.finalUrl, `http://weixin-old.invalid:${s.port}/final`)
    assert.ok(Buffer.from(out.bytes).toString().includes("final-ok"), "第二跳正文取回")
    assert.equal(hits, 2)
    await new Promise((resolve) => setTimeout(resolve, 150))
  } finally {
    await s.close()
  }
})
'''


def listener_at_call_sites(s):
    n = 0
    res = []
    for line in s.split('\n'):
        m = re.match(r'^(\s*)res\.destroy\(\)\s*$', line)
        if m:
            res.append(m.group(1) + 'res.body.once("error", () => {})')
            n += 1
        res.append(line)
    assert n == 3, f'调用点数={n}（期望 3）'
    return '\n'.join(res)


def main():
    out(f'== R2 VERIFY start {now()} ==')
    out('local node:', LOCAL, '|', sh([LOCAL, '--version'])[1].strip(), '| prod node:', sh([PROD, '--version'])[1].strip())
    if not os.path.isdir(M + '/node_modules/undici'):
        rc, o = sh(['cp', '-cR', LIVE + '/mcp-server/node_modules', M + '/node_modules'])
        out('cp -cR mcp-server/node_modules rc=%d' % rc)
    orig(SRC)
    orig(NET)
    out('与 live 同字节: src', sha(f'{M}/{SRC}') == sha(f'{LIVE}/mcp-server/{SRC}'), '| test', sha(f'{M}/{NET}') == sha(f'{LIVE}/mcp-server/{NET}'))
    und = open(M + '/node_modules/undici/package.json').read()
    out('undici 版本(副本):', re.search(r'"version":\s*"([^"]+)"', und).group(1))

    build('baseline')
    out('  副本 dist/src/web-clip.js 与 live 同字节:', sha(M + '/dist/src/web-clip.js') == LIVE_WEBCLIP_SHA)
    files = sorted(glob.glob(M + '/dist/test/*.test.js'))
    out('  dist/test 文件数:', len(files))
    net = [f for f in files if f.endswith('/web-clip-net.test.js')]

    runtests('baseline-full-prod', files, PROD)
    runtests('baseline-full-local', files, LOCAL)
    runtests('baseline-net-prod', net, PROD)

    # R2b I-1：全路径钉可行且能杀「删监听器」
    put(NET, orig(NET).rstrip('\n') + '\n' + FULLPATH, 'fullpath-nail')
    build('fullpath-nail')
    runtests('fullpath-nail-net-prod', net, PROD)

    put(SRC, orig(SRC).replace(CLOSURE_LISTENER, ''), 'drop-listener')
    assert CLOSURE_LISTENER not in open(f'{M}/{SRC}').read()
    build('drop-listener')
    runtests('drop-listener-net-prod', net, PROD)
    runtests('drop-listener-full-prod', files, PROD)
    restore(SRC)

    # 变体 (iv)：监听器改放三处调用点、闭包里不加（生产行为正确）
    put(SRC, listener_at_call_sites(orig(SRC).replace(CLOSURE_LISTENER, '')), 'listener-at-call-sites')
    build('listener-at-call-sites')
    runtests('listener-at-call-sites-net-prod', net, PROD)
    runtests('listener-at-call-sites-full-prod', files, PROD)
    restore(SRC)

    restore(NET)
    build('restored')
    out('还原后 dist/src/web-clip.js 与 live 同字节:', sha(M + '/dist/src/web-clip.js') == LIVE_WEBCLIP_SHA)
    runtests('restored-net-prod', net, PROD)
    live_ok = all(sha(f'{LIVE}/mcp-server/{r}') == hashlib.sha256(ORIG[r].encode()).hexdigest() for r in (SRC, NET))
    out('live src/test 与开工同字节:', live_ok, '| live dist web-clip.js 与副本干净构建同字节:', sha(f'{LIVE}/mcp-server/dist/src/web-clip.js') == LIVE_WEBCLIP_SHA)
    out(f'== R2 VERIFY end {now()} ==')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        out('EXCEPTION:\n' + traceback.format_exc())
        sys.exit(1)
