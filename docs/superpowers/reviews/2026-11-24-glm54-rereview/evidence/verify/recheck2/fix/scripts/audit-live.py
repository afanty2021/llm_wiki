#!/usr/bin/env python3
"""live 只读验证（11.3-3a 收尾）：
① 重放：昨晚巡检日志里的候选 × live jobs.json（只读），按修后的判重逻辑逐个分类——期望六人全部「已有任务」。
② live --dry-run 恰好一次：对象取自日志里那位任务名大小写不一致的教师。进程装审计钩子（临时目录之外拒写），
   前后对 ~/.hermes 的相关文件与目录取 sha256 / size / mtime / ctime 快照，并清点新文件。
输出里教师 id 一律掩码。不做任何 git 操作，不写 live。"""
import hashlib
import os
import re
import stat
import subprocess
import sys
import time

W = os.path.realpath('/tmp/glm54-fix-20261125')
REPO = '/Users/berton/Github/kb-obsidian/llm_wiki'
HOME = os.path.expanduser('~')
PROV = REPO + '/tools/ltutor/provision-teacher-weekly.sh'
LOG = HOME + '/Library/Logs/ltutor-weekly-audit.log'
HPY = '/opt/homebrew/Caskroom/miniconda/base/envs/hermes-3.11/bin/python'
TMPROOT = W + '/live-dryrun-tmp'
GUARD_DIR = W + '/live-dryrun-guard'
RAW = open(W + '/raw/audit-live.txt', 'w')
ids = {}


def out(*a):
    s = ' '.join(str(x) for x in a)
    print(s, flush=True)
    RAW.write(s + '\n')
    RAW.flush()


def mask(x):
    return ids.setdefault(x, f'T{len(ids) + 1}')


def snap():
    r = {}
    targets = [HOME + '/.hermes/config.yaml', HOME + '/.hermes/profiles/lt-tutor/config.yaml',
               HOME + '/.hermes/profiles/lt-tutor/cron', HOME + '/.hermes/profiles/lt-tutor/cron/output',
               HOME + '/.hermes/profiles/lt-tutor/cron/jobs.json', HOME + '/.hermes']
    for p in targets:
        st = os.lstat(p)
        rec = [stat.S_IMODE(st.st_mode), st.st_size, st.st_mtime_ns, st.st_ctime_ns]
        if stat.S_ISREG(st.st_mode):
            rec.append(hashlib.sha256(open(p, 'rb').read()).hexdigest())
        r[p.replace(HOME, '~')] = tuple(rec)
    baks = {}
    for d in (HOME + '/.hermes', HOME + '/.hermes/profiles/lt-tutor', HOME + '/.hermes/profiles/lt-tutor/cron'):
        baks[d.replace(HOME, '~')] = sorted(x for x in os.listdir(d) if '.bak-' in x or x.startswith('.config.yaml.') or x.startswith('jobs.json.'))
    return r, baks


out(f'== start {time.strftime("%F %T")} ==')
# ① 重放
log = open(LOG, errors='replace').read().split('\n')
starts = [i for i, l in enumerate(log) if '巡检开始' in l]
last = log[starts[-1]:]
cand_line = next(l for l in last if l.startswith('候选'))
cands = re.search(r'：(.*)$', cand_line).group(1).split()
provisioned = [re.search(r'自动开办：(\S+)', l).group(1) for l in last if '▶ 自动开办' in l]
out(f'日志：{len(log)} 行、{len(starts)} 趟；最后一趟候选 {len(cands)} 人，其中被旧逻辑判成缺任务 {len(provisioned)} 人（{[mask(x) for x in provisioned]}）')
jobs_doc = __import__('json').load(open(HOME + '/.hermes/profiles/lt-tutor/cron/jobs.json'))
jobs = jobs_doc['jobs'] if isinstance(jobs_doc, dict) else jobs_doc
existing = ['wecom_' + j.get('name', '').split(':', 1)[1] for j in jobs
            if str(j.get('name', '')).startswith('lt-tutor-weekly:') and j.get('enabled', True)]
old_mis, new_mis = [], []
for u in cands:
    exact = subprocess.run(['/usr/bin/grep', '-qx', u], input='\n'.join(existing), text=True, cwd='/').returncode == 0
    ci = subprocess.run(['/usr/bin/grep', '-qix', u], input='\n'.join(existing), text=True, cwd='/').returncode == 0
    if not exact:
        old_mis.append(mask(u[len('wecom_'):]))
    if not ci:
        new_mis.append(mask(u[len('wecom_'):]))
out(f'重放（/usr/bin/grep = launchd PATH 下那个）：旧逻辑 -qx 判缺任务 {len(old_mis)} 人 {old_mis}；新逻辑 -qix 判缺任务 {len(new_mis)} 人 {new_mis}')
out(f'launchd PATH 下的 grep：{subprocess.run(["/bin/bash", "-c", "PATH=/usr/bin:/bin:/usr/sbin:/sbin; command -v grep"], capture_output=True, text=True).stdout.strip()}')
target = provisioned[0] if provisioned else None   # 日志行里的 id 已不含 wecom_ 前缀
if target is None:
    out('昨晚没有被判成缺任务的教师——跳过 live dry-run')
    sys.exit(0)

# ② live dry-run 恰好一次
shutil = __import__('shutil')
shutil.rmtree(TMPROOT, ignore_errors=True)
os.makedirs(TMPROOT)
os.makedirs(GUARD_DIR, exist_ok=True)
guard_src = open(W + '/audit-sandbox/guard/sitecustomize.py').read()
open(GUARD_DIR + '/sitecustomize.py', 'w').write(guard_src)
before, baks_before = snap()
marker = W + '/live-dryrun.marker'
open(marker, 'w').write('')
env = {'HOME': HOME, 'TMPDIR': TMPROOT, 'PATH': '/usr/bin:/bin:/usr/sbin:/sbin', 'PYTHONDONTWRITEBYTECODE': '1',
       'PYTHONPATH': GUARD_DIR, 'SB_GUARD_ROOT': TMPROOT}
t0 = time.time()
p = subprocess.run(['/bin/bash', PROV, target, '--dry-run'], cwd='/', env=env, capture_output=True, text=True, timeout=180)
dt = time.time() - t0
after, baks_after = snap()
out(f'live dry-run：rc={p.returncode} {dt:.2f}s | 输出（id 掩码）：')
for l in (p.stdout + p.stderr).strip().split('\n'):
    out('    ' + l.replace(target, mask(target)))
changed = [k for k in before if before[k] != after.get(k)]
out(f'快照对账（sha256/size/mtime/ctime/mode）：{len(before)} 项，变化 {len(changed)} 项 {changed}')
out(f'备份与临时文件清点前后相同：{baks_before == baks_after}')
newer = []
for dp, dns, fns in os.walk(HOME + '/.hermes/profiles/lt-tutor'):
    for n in dns + fns:
        q = os.path.join(dp, n)
        try:
            if os.lstat(q).st_mtime_ns > os.lstat(marker).st_mtime_ns or os.lstat(q).st_ctime_ns > os.lstat(marker).st_ctime_ns:
                newer.append(q.replace(HOME, '~'))
        except OSError:
            pass
top = [n for n in os.listdir(HOME + '/.hermes') if os.lstat(os.path.join(HOME + '/.hermes', n)).st_mtime_ns > os.lstat(marker).st_mtime_ns]
out(f'lt-tutor profile 下 mtime/ctime 晚于标记的条目 {len(newer)} 个（日志目录会被网关持续写，单列）→ 非日志条目：{[x for x in newer if "/logs/" not in x and "/sessions/" not in x and "/cache/" not in x][:10]}')
out(f'~/.hermes 顶层晚于标记的条目：{top}')
out(f'临时目录内容（应只剩空壳，atexit 已清）：{os.listdir(TMPROOT)}')
shutil.rmtree(TMPROOT, ignore_errors=True)
os.unlink(marker)
out(f'== end {time.strftime("%F %T")} ==')
