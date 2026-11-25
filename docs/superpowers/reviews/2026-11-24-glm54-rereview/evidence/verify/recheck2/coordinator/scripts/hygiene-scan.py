#!/usr/bin/env python3
"""推送前卫生扫描（协调者）：① origin/main..HEAD 新增行；② 评审目录全量文本文件。
命中只输出掩码（前 6 字符 + 长度），不回显完整命中。只读。"""
import os, re, subprocess
L = '/Users/berton/Github/kb-obsidian/llm_wiki'
R = L + '/docs/superpowers/reviews/2026-11-24-glm54-rereview'
OUT = '/tmp/glm54-recheck-20261125/C/raw/hygiene-scan.txt'
PATS = [
    ('key-prefix', re.compile(r'\b(sk-[A-Za-z0-9_\-]{16,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abp]-[A-Za-z0-9\-]{10,}|AIza[0-9A-Za-z_\-]{30,}|eyJ[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{10,})')),
    ('kv-secret', re.compile(r'(?i)\b(api[_\-]?key|secret|token|password|passwd|access[_\-]?key|authorization)\b\s*[:=]\s*["\']?([A-Za-z0-9_\-\.\/+]{12,})')),
    ('cred-url', re.compile(r'(?i)[?&](access_key|ticket|sig|token|key|secret|signature)=[A-Za-z0-9_\-\.%]{8,}')),
    ('email', re.compile(r'[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}')),
    ('ipv4-public', re.compile(r'\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b')),
    ('cn-mobile', re.compile(r'(?<![\dA-Za-z])1[3-9]\d{9}(?![\dA-Za-z])')),
    ('wecom-id', re.compile(r'\b(wm[A-Za-z0-9_\-]{8,}|wr[A-Za-z0-9_\-]{8,}|ww[0-9a-fA-F]{16,})\b')),
    ('wecom-user', re.compile(r'wecom_[A-Za-z][A-Za-z0-9]{1,24}')),
    ('hex-32-63', re.compile(r'\b[0-9a-f]{32,63}\b')),
]
def mask(s): return s[:6] + '…(%d)' % len(s)
def private(ip):
    p = [int(x) for x in ip.split('.')]
    return p[0] in (0, 10, 127) or (p[0] == 192 and p[1] == 168) or (p[0] == 172 and 16 <= p[1] <= 31) or (p[0] == 169 and p[1] == 254)
rows = []
diff = subprocess.run(['git', '-C', L, 'diff', 'origin/main..HEAD'], capture_output=True, text=True).stdout
cur = None; n = 0
for line in diff.split('\n'):
    if line.startswith('+++ b/'):
        cur = line[6:]; n = 0; continue
    if line.startswith('+') and cur is not None:
        n += 1; rows.append(('diff+' + cur, n, line[1:]))
nd = len(rows)
for root, _, fs in os.walk(R):
    for f in fs:
        p = os.path.join(root, f)
        if os.path.getsize(p) > 5000000: continue
        try: txt = open(p, errors='ignore').read()
        except OSError: continue
        rel = os.path.relpath(p, L)
        for i, line in enumerate(txt.split('\n'), 1):
            rows.append((rel, i, line))
out = []
out.append('# 推送前卫生扫描（协调者，只读）')
out.append('来源：origin/main..HEAD 新增行 %d 条；评审目录全量文本行 %d 条（共 %d）' % (nd, len(rows) - nd, len(rows)))
url = subprocess.run(['git', '-C', L, 'remote', 'get-url', 'origin'], capture_output=True, text=True).stdout.strip()
m = re.search(r'github\.com[/:]([^/:]+/[^/:]+?)(?:\.git)?$', url)
slug = m.group(1) if m else None
out.append('origin slug: %s（URL 已脱敏）' % slug)
if slug:
    try:
        g = subprocess.run(['gh', 'repo', 'view', slug, '--json', 'visibility,isPrivate'], capture_output=True, text=True, timeout=30)
        out.append('gh: rc=%d %s' % (g.returncode, (g.stdout or g.stderr).strip()[:200]))
    except Exception as e:
        out.append('gh: 失败 %s' % type(e).__name__)
hits = {}
for src, ln, text in rows:
    for name, rx in PATS:
        for mm in rx.finditer(text):
            tok = mm.group(2) if name == 'kv-secret' else mm.group(0)
            if name == 'ipv4-public' and private(tok): continue
            if name == 'hex-32-63' and len(tok) in (40, 64): continue  # git sha1 / sha256 证据哈希
            hits.setdefault(name, []).append((src, ln, tok))
for name, _ in PATS:
    hs = hits.get(name, [])
    out.append('## %s: %d 处' % (name, len(hs)))
    seen = set()
    for src, ln, tok in hs:
        key = (src, tok)
        if key in seen: continue
        seen.add(key)
        if len(seen) > 25: out.append('   …（余略）'); break
        out.append('   %s:%s  %s' % (src.replace('docs/superpowers/reviews/2026-11-24-glm54-rereview/', '<R>/'), ln, mask(tok)))
open(OUT, 'w').write('\n'.join(out) + '\n')
print('\n'.join(out))
