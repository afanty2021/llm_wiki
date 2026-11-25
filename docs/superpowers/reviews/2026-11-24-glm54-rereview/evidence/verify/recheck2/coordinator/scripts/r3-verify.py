#!/usr/bin/env python3
"""协调者亲验 R3 席（03:17 周报巡检 provision 断链修复 710111b0）。

用法：
  r3-verify.py pre     首轮：前置核对、live 快照、沙箱 import 探针、承重数字、监控覆盖、相邻历史
                       （注：首轮用 mode=ro 打开了 WAL 库 executions.db，在 live cron 目录生成了 -wal/-shm，见 pre2 的核查）
  r3-verify.py pre2    修正后的承重数字复算 + 探针补全 + immutable 只读历史 + 副作用核查
  r3-verify.py dryrun  live dry-run 恰好一次（防重跑标记）+ 前后比对 + 终态
live 只读（dry-run 只会刷两个目录的 ctime）；其余写入全部在 /tmp/glm54-recheck-20261125/C/ 下。"""
import ast
import hashlib
import json
import os
import re
import sqlite3
import subprocess
import sys
import time
import traceback

LIVE = '/Users/berton/Github/kb-obsidian/llm_wiki'
HERMES = '/Users/berton/Github/Coding-Agents/Hermes-agent'
HOME = os.path.expanduser('~')
HM = HOME + '/.hermes'
PROF = HM + '/profiles/lt-tutor'
SCRIPT_REL = 'tools/ltutor/provision-teacher-weekly.sh'
SCRIPT = LIVE + '/' + SCRIPT_REL
PY = '/opt/homebrew/Caskroom/miniconda/base/envs/hermes-3.11/bin/python'
SITE = '/opt/homebrew/Caskroom/miniconda/base/envs/hermes-3.11/lib/python3.11/site-packages'
LOG = HOME + '/Library/Logs/ltutor-weekly-audit.log'
W = '/tmp/glm54-recheck-20261125/C'
RAW = W + '/raw'
R3 = W + '/r3'
MARK = W + '/.r3-dryrun-ran'
SNAP = RAW + '/r3-live-snapshot.json'
FMT = '%Y-%m-%d %H:%M:%S'
SUM = open(RAW + '/summary-r3.txt', 'a')
CREDS = re.compile(r'access_key|ticket=|bearer|api[_-]?key|sk-[A-Za-z0-9]{8}', re.I)

STATIC = '''
import json, os, re, sys
HERMES, tops = sys.argv[1], set(json.loads(sys.argv[2]))
pys = [n for n in os.listdir(HERMES) if n.endswith('.py')]
pkgs = [n for n in os.listdir(HERMES) if os.path.isfile(os.path.join(HERMES, n, '__init__.py'))]
names = [n[:-3] for n in pys] + pkgs
site = '/opt/homebrew/Caskroom/miniconda/base/envs/hermes-3.11/lib/python3.11/site-packages'
site_tops = {re.split(r'[.-]', n, 1)[0] for n in os.listdir(site)} | {n[:-4] for n in os.listdir(site) if n.endswith('.pth')}
std = set(sys.stdlib_module_names)
print('检出根可 import 顶层名', len(names), '= py', len(pys), '+ pkg', len(pkgs), '| 在映射', len([n for n in names if n in tops]), '| 不在映射', len([n for n in names if n not in tops]))
print('hermes_yaml 在根', 'hermes_yaml' in names, '| hermes_platform 在根', 'hermes_platform' in names, '| hermes_platform 在映射', 'hermes_platform' in tops)
print('根名 ∩ stdlib', sorted(set(names) & std), '| 根名 ∩ site-packages 顶层', sorted(set(names) & site_tops), '| site 顶层名数', len(site_tops))
print('python', sys.version.split()[0])
'''

PROBE = r'''
import hashlib, json, os, re, sys
MODE, ROOT, SCRATCH, HOME_REAL, MAPPFILE = sys.argv[1:6]
MAPP = set(json.load(open(MAPPFILE)))
ALLOW_W = (SCRATCH, '/dev/', '/private/var/db/', '/private/tmp/glm54-recheck-20261125/C/r3/')
events = []
def hook(name, args):
    if name == 'open':
        p, mode, flags = args
        if not isinstance(p, (str, bytes)):
            return
        p = os.fsdecode(p)
        if p.startswith(HOME_REAL + '/.hermes'):
            events.append(('READ-LIVE-HERMES-HOME', p.replace(HOME_REAL, '~')))
            raise RuntimeError('denied: live ~/.hermes access')
        writing = (isinstance(mode, str) and any(c in mode for c in 'wax+')) or (isinstance(flags, int) and flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND))
        if not writing:
            return
        paths = [p]
    elif name in ('os.mkdir', 'os.remove', 'os.rmdir', 'os.chmod', 'os.utime', 'os.truncate'):
        paths = [args[0]]
    elif name in ('os.rename', 'os.link', 'os.symlink'):
        paths = [args[0], args[1]]
    elif name in ('subprocess.Popen', 'os.system', 'socket.connect', 'socket.connect_ex', 'socket.bind'):
        events.append((name, str(args)[:80]))
        raise RuntimeError('denied: ' + name)
    else:
        return
    for p in paths:
        if p is None or not isinstance(p, (str, bytes)):
            continue
        p = os.fsdecode(p)
        if not os.path.isabs(p):
            p = os.path.join(os.getcwd(), p)
        if not p.startswith(ALLOW_W):
            events.append((name, p.replace(HOME_REAL, '~')))
            raise RuntimeError('denied: %s %s' % (name, p))
sys.addaudithook(hook)
os.environ['HERMES_HOME'] = SCRATCH
if MODE == 'fix':
    sys.path.insert(0, ROOT)
try:
    from cron import jobs
    print('IMPORT-OK')
except BaseException as e:
    print('EXC', type(e).__name__, str(e)[:120])
    tb = e.__traceback__
    while tb:
        f = tb.frame if hasattr(tb, 'frame') else tb.tb_frame
        fn = f.f_code.co_filename
        rel = os.path.relpath(fn, ROOT) if fn.startswith(ROOT) else fn.replace(HOME_REAL, '~')
        print('FRAME', rel, tb.tb_lineno, f.f_code.co_name)
        tb = tb.tb_next
    print('AUDIT-EVENTS', events)
    sys.exit(0)
for n in ('cron', 'cron.jobs', 'utils', 'hermes_yaml', 'hermes_platform'):
    m = sys.modules.get(n)
    print('FROM', n, (getattr(m, '__file__', None) or str(getattr(m, '__path__', ''))).replace(HOME_REAL, '~') if m else '(未载入)')
origin = set()
for n, m in list(sys.modules.items()):
    f = getattr(m, '__file__', None) or ''
    ps = [str(x) for x in (getattr(m, '__path__', None) or [])]
    if f.startswith(ROOT) or any(x.startswith(ROOT) for x in ps):
        origin.add(n.split('.')[0])
print('ORIGIN 从检出载入的顶层名', len(origin), sorted(origin))
print('ORIGIN 其中不在映射', sorted(origin - MAPP))
print('FROM-LIVE-HERMES-HOME', sorted(n for n, m in sys.modules.items() if (getattr(m, '__file__', None) or '').startswith(HOME_REAL + '/.hermes')))
print('AUDIT-EVENTS(import 段)', events)
os.makedirs(os.path.join(SCRATCH, 'cron'), exist_ok=True)
jf = os.path.join(SCRATCH, 'cron', 'jobs.json')
rec = {'jobs': [{'id': 'job-w', 'name': 'lt-tutor-weekly:teachf', 'enabled': True, 'schedule': {'kind': 'cron', 'expr': '5 19 * * 0'}, 'prompt': 'x', 'deliver': 'wecom:teachf'}], 'updated_at': '2026-11-25T00:00:00+08:00'}
open(jf, 'w').write(json.dumps(rec))
h0 = hashlib.sha256(open(jf, 'rb').read()).hexdigest()
for ref in ('lt-tutor-weekly:TeachF', 'lt-tutor-weekly:TEACHF', 'lt-tutor-weekly:Nobody'):
    try:
        r = jobs.resolve_job_ref(ref)
        print('RESOLVE', ref, '->', bool(r), (r.get('name') if isinstance(r, dict) else type(r).__name__) if r else None)
    except BaseException as e:
        print('RESOLVE', ref, 'EXC', type(e).__name__, str(e)[:100])
h1 = hashlib.sha256(open(jf, 'rb').read()).hexdigest()
print('JOBSFILE 未变', h0 == h1, h0[:12], '| 仍是 1 条', len(json.load(open(jf))['jobs']))
print('AUDIT-EVENTS(resolve 段)', events)
'''


def out(*a):
    s = ' '.join(str(x) for x in a)
    print(s, flush=True)
    SUM.write(s + '\n')
    SUM.flush()


def now():
    return time.strftime(FMT)


def sh(cmd, cwd=None, env=None, timeout=600):
    p = subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, text=True, timeout=timeout)
    return p.returncode, p.stdout + p.stderr


def git(repo, *args):
    return sh(['git', '--no-optional-locks', '-C', repo, *args])


def sha(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''):
            h.update(b)
    return h.hexdigest()


def file_state(p):
    st = os.stat(p)
    return {'sha': sha(p)[:16], 'mtime': time.strftime(FMT, time.localtime(st.st_mtime)), 'size': st.st_size}


def dir_state(d):
    st = os.stat(d)
    return {'ctime': time.strftime(FMT, time.localtime(st.st_ctime)), 'mode': oct(st.st_mode & 0o777), 'inode': st.st_ino}


def short(p):
    return p.replace(HM, '~/.hermes')


def snap():
    s = {'files': {}, 'dirs': {}, 'listings': {}}
    for p in (HM + '/config.yaml', PROF + '/config.yaml', PROF + '/cron/jobs.json'):
        s['files'][p] = file_state(p)
    for d in (PROF + '/cron', PROF + '/cron/output'):
        s['dirs'][d] = dir_state(d)
    for d in (PROF, PROF + '/cron'):
        s['listings'][d] = sorted(os.listdir(d))
    s['listings'][HM] = sorted(n for n in os.listdir(HM) if '.bak' in n or n.startswith('config'))
    return s


def diff_snap(a, b):
    ch = []
    for k in a['files']:
        if a['files'][k] != b['files'][k]:
            ch.append(('file', short(k), a['files'][k], b['files'][k]))
    for k in a['dirs']:
        if a['dirs'][k] != b['dirs'][k]:
            ch.append(('dir', short(k), a['dirs'][k], b['dirs'][k]))
    for k in a['listings']:
        if a['listings'][k] != b['listings'][k]:
            ch.append(('listing', short(k), sorted(set(a['listings'][k]) ^ set(b['listings'][k])), ''))
    return ch


def show_snap(s):
    for k, v in s['files'].items():
        out('   file', short(k), v)
    for k, v in s['dirs'].items():
        out('   dir ', short(k), v)
    for k, v in s['listings'].items():
        out('   list', short(k), 'entries=%d' % len(v))


def newer_than(marker):
    o = subprocess.run(['find', HERMES, '-newer', marker, '-type', 'f', '-not', '-path', '*/.git/*'],
                       capture_output=True, text=True).stdout.split('\n')
    return [n.replace(HERMES, '<hermes>') for n in o if n.strip()]


def mapping():
    f = [n for n in os.listdir(SITE) if n.startswith('__editable___') and n.endswith('.py')][0]
    p = os.path.join(SITE, f)
    val = {}
    for node in ast.walk(ast.parse(open(p).read())):
        tgt = None
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            tgt = node.targets[0].id
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            tgt = node.target.id
        if tgt == 'MAPPING':
            val = ast.literal_eval(node.value)
    return f, val, p


def static_numbers():
    out('-- 承重数字复算')
    raw = open(LOG, 'rb').read()
    txt = raw.decode('utf-8', 'replace')
    out('  巡检日志: 字节=%d 换行数=%d splitlines=%d | 巡检开始=%d 巡检完成=%d 自动开办行=%d' % (
        len(raw), raw.count(b'\n'), len(txt.splitlines()), txt.count('巡检开始'), txt.count('巡检完成'), txt.count('▶ 自动开办')))
    dates = sorted(set(re.findall(r'^── (\d{4}-\d{2}-\d{2}) \d{2}:\d{2}:\d{2} 巡检开始', txt, re.M)))
    out('  巡检日期数=%d 首=%s 末=%s | ≤11-24 的趟数=%d' % (
        len(dates), dates[0] if dates else None, dates[-1] if dates else None, len([d for d in dates if d <= '2026-11-24'])))
    out('  日志文件 birth=%s' % time.strftime(FMT, time.localtime(os.stat(LOG).st_birthtime)))
    baks = sorted(n for n in os.listdir(HM) if re.search(r'bak-2026\d{4}-0317', n))
    out('  ~/.hermes 根下 03:17 时刻的 config 备份:', baks, '| 根下 .bak-* 总数:', len([n for n in os.listdir(HM) if '.bak' in n]))
    jobs = json.load(open(PROF + '/cron/jobs.json'))['jobs']
    out('  jobs:', [(j['name'].split(':')[1], j['created_at'][:19], j['schedule'].get('expr') if isinstance(j.get('schedule'), dict) else None) for j in jobs])
    f, mp, p = mapping()
    tops = {k.split('.')[0] for k in mp}
    st = os.stat(p)
    out('  finder %s | mtime %s | MAPPING 项数 %d | 顶层名 %d | 含 hermes_yaml=%s 含 mcp_serve=%s' % (
        f, time.strftime(FMT, time.localtime(st.st_mtime)), len(mp), len(tops), 'hermes_yaml' in tops, 'mcp_serve' in tops))
    out('  MAPPING 顶层名:', sorted(tops))
    out('  MAPPING 目标都在检出下:', all(v.startswith(HERMES) for v in mp.values()), '| 目标不存在的:', sorted(k for k, v in mp.items() if not os.path.exists(v)))
    rc, o = sh([PY, '-I', '-c', STATIC, HERMES, json.dumps(sorted(tops))])
    for l in o.strip().split('\n'):
        out('  ' + l[:400])
    if rc != 0:
        out('  (STATIC rc=%d)' % rc)
    return tops


def probes(tops):
    out('-- 沙箱 import 探针（HOME=假目录、HERMES_HOME=沙箱、cwd=/、-I -B；审计钩子拒绝沙箱外写入/子进程/联网/读真 ~/.hermes）')
    fake = R3 + '/fakehome'
    os.makedirs(fake, exist_ok=True)
    os.makedirs(R3, exist_ok=True)
    mfile = R3 + '/mapping.json'
    json.dump(sorted(tops), open(mfile, 'w'))
    for mode in ('nofix', 'fix'):
        sc = R3 + '/scratch-' + mode
        os.makedirs(sc, exist_ok=True)
        if os.path.exists(sc + '/cron/jobs.json'):
            os.remove(sc + '/cron/jobs.json')
        env = {'HOME': fake, 'HERMES_HOME': sc, 'PATH': '/usr/bin:/bin', 'LANG': 'en_US.UTF-8'}
        rc, o = sh([PY, '-I', '-B', '-c', PROBE, mode, HERMES, sc, HOME, mfile], cwd='/', env=env, timeout=300)
        open(f'{RAW}/r3-probe-{mode}.txt', 'w').write(f'$ rc={rc}\n{o}')
        out(f'  探针 {mode}: rc={rc}')
        for l in o.strip().split('\n'):
            out('     ' + l[:360])


def ro(path):
    # immutable=1：纯只读打开，不创建 -wal/-shm，也不加锁
    return sqlite3.connect('file:' + path + '?mode=ro&immutable=1', uri=True, timeout=5)


def history2():
    out('-- 相邻历史（immutable 只读；只取状态与时间列，job_json 只取 name）')
    names = {}
    for j in json.load(open(PROF + '/cron/jobs.json'))['jobs']:
        names[j.get('id')] = j['name'].split(':')[1]
    con = ro(PROF + '/cron/executions.db')
    rows = con.execute('select job_id, started_at, status, delivery_outcome, error from executions order by rowid').fetchall()
    for jid, nm in names.items():
        rs = [r for r in rows if r[0] == jid]
        out(f'  [{nm}] executions 共 {len(rs)}；末 8 行:')
        for r in rs[-8:]:
            out('      ', (r[1] or '')[:16], '|', r[2], '| delivery_outcome=', r[3], '|', (r[4] or '')[:60])
    out('  cron_incidents:')
    for r in con.execute('select job_id, state, failure_type, first_seen_at, last_seen_at, alerted_at, acked_at, closed_at, error from cron_incidents order by rowid').fetchall():
        out('      ', names.get(r[0], r[0]), '|', r[1], '|', r[2], '| first', (r[3] or '')[:16], '| last', (r[4] or '')[:16],
            '| alerted_at', (r[5] or '')[:16] if r[5] else None, '| acked_at', (r[6] or '')[:16] if r[6] else None,
            '| closed_at', (r[7] or '')[:16] if r[7] else None, '|', (r[8] or '')[:50])
    ex = {eid: (names.get(jid, jid), (st or '')[:16]) for eid, jid, st in con.execute('select id, job_id, started_at from executions').fetchall()}
    con.close()
    con = ro(PROF + '/cron/deliveries.db')
    rows = con.execute('select execution_id, job_json, for_failure, status, created_at, finished_at, error from deliveries order by rowid').fetchall()
    per = {}
    for eid, jj, ff, st, ca, fa, err in rows:
        try:
            nm = json.loads(jj).get('name', '?').split(':')[-1]
        except Exception:
            nm = '?'
        per.setdefault(nm, []).append((ex.get(eid, ('?', ''))[1] or (ca or '')[:16], 'failure' if ff else 'report', st, (err or '')[:70]))
    out(f'  deliveries 共 {len(rows)} 行:')
    for nm, lst in per.items():
        out(f'      [{nm}] 共 {len(lst)}；末 6 行:')
        for x in lst[-6:]:
            out('          ', ' | '.join(str(y) for y in x))
    con.close()
    out('-- TeachF 投递日志行（按文件；滤凭证；截 230）')
    cnt = {}
    for d in (PROF + '/logs', HM + '/logs'):
        if not os.path.isdir(d):
            continue
        for n in sorted(os.listdir(d)):
            if not re.search(r'(agent|gateway|cron)[-\w]*\.log', n):
                continue
            p = d + '/' + n
            tag = ('profile/' if d.startswith(PROF) else 'main/') + n
            for l in open(p, errors='ignore'):
                if CREDS.search(l) or 'msg=' in l:
                    continue
                if re.search(r'teachf', l, re.I) and re.search(r'send|deliver|sent|dispatch', l, re.I):
                    cnt.setdefault(tag, []).append(l.rstrip()[:230])
    for tag, lst in cnt.items():
        out(f'   [{tag}] 共 {len(lst)} 行；末 12 行:')
        for l in lst[-12:]:
            out('       ', l)


def sideeffect_check():
    out('-- 协调者首轮 sqlite 打开的副作用核查（executions.db* 现状）')
    for n in sorted(os.listdir(PROF + '/cron')):
        if n.startswith('executions.db') or n.startswith('deliveries.db'):
            st = os.stat(PROF + '/cron/' + n)
            out('   ', n, 'size=%d' % st.st_size, 'mtime=' + time.strftime(FMT, time.localtime(st.st_mtime)),
                'birth=' + time.strftime(FMT, time.localtime(st.st_birthtime)))
    rc, o = sh(['lsof', '-w', PROF + '/cron/executions.db', PROF + '/cron/executions.db-wal', PROF + '/cron/executions.db-shm'])
    lines = [l for l in o.split('\n') if l.strip()]
    out('    lsof rc=%d 输出行数=%d' % (rc, len(lines)))
    for l in lines[1:6]:
        out('      ', ' '.join(l.split()[:2]))


def pre2():
    out(f'== R3 PRE2 start {now()} ==')
    s0 = snap()
    tops = static_numbers()
    probes(tops)
    history2()
    sideeffect_check()
    ch = diff_snap(s0, snap())
    out('pre2 阶段 live 变化（相对 pre2 开工）:', ch if ch else '无')
    nw = newer_than(SNAP)
    out('Hermes 检出内比首轮快照新的文件数:', len(nw), nw[:8])
    out(f'== R3 PRE2 end {now()} ==')


def dryrun():
    out(f'== R3 DRYRUN start {now()} ==')
    if os.path.exists(MARK):
        out('标记已存在，拒绝重复运行:', open(MARK).read().strip())
        return
    _, head = git(LIVE, 'rev-parse', 'HEAD')
    _, br = git(LIVE, 'rev-parse', '--abbrev-ref', 'HEAD')
    _, blob = git(LIVE, 'show', 'HEAD:' + SCRIPT_REL)
    ok = blob == open(SCRIPT).read() and 'sys.path.insert(0,' in blob
    out('前置: HEAD', head.strip()[:8], '| branch', br.strip(), '| 脚本 = HEAD blob 且含修复行:', ok)
    if not ok:
        out('前置不满足，放弃 dry-run')
        return
    _, st = git(HERMES, 'status', '--porcelain')
    out('Hermes 检出 status --porcelain:', [l for l in st.split('\n') if l.strip()])
    s1 = snap()
    out('live 快照（dry-run 前）:')
    show_snap(s1)
    s0 = json.load(open(SNAP))
    d = sorted(set(s0['listings'][PROF + '/cron']) ^ set(s1['listings'][PROF + '/cron']))
    out('cron 目录清单相对首轮开工快照的差异:', d if d else '无（首轮 mode=ro 打开留下的 -wal/-shm 已不在）')
    for k in s0['files']:
        if s0['files'][k] != s1['files'][k]:
            out('  首轮以来文件有变:', short(k), s0['files'][k], '->', s1['files'][k])
    open(MARK, 'w').write(now() + ' pid=' + str(os.getpid()) + '\n')
    env = {'HOME': HOME, 'PATH': '/usr/bin:/bin:/usr/sbin:/sbin', 'PYTHONDONTWRITEBYTECODE': '1'}
    cmd = ['/bin/bash', SCRIPT, 'TeachF', '--dry-run']
    out('命令:', ' '.join(cmd), '| cwd=/ | env=HOME,PATH(launchd 默认),PYTHONDONTWRITEBYTECODE=1')
    t0 = time.time()
    p = subprocess.run(cmd, cwd='/', env=env, capture_output=True, text=True, timeout=300)
    wall = time.time() - t0
    open(RAW + '/r3-dryrun-raw.txt', 'w').write(f'$ rc={p.returncode} wall={wall:.2f}s\n{p.stdout}--- stderr ---\n{p.stderr}')
    out(f'dry-run: rc={p.returncode} wall={wall:.2f}s | stdout 行数={len(p.stdout.splitlines())} stderr 字节={len(p.stderr)}')
    for l in p.stdout.rstrip('\n').split('\n'):
        out('   |', l)
    if p.stderr.strip():
        out('   stderr:', p.stderr.strip()[:300])
    time.sleep(1.0)
    ch = diff_snap(s1, snap())
    out('dry-run 前后 live 变化:')
    if not ch:
        out('   无')
    for c in ch:
        out('  ', c)
    nw = newer_than(MARK)
    out('dry-run 期间 Hermes 检出内新写入的文件数:', len(nw), nw[:8])
    _, head2 = git(LIVE, 'rev-parse', 'HEAD')
    _, st = git(HERMES, 'status', '--porcelain')
    out('终态: live HEAD', head2.strip()[:8], '| Hermes 检出 status 行数:', len([l for l in st.split('\n') if l.strip()]))
    out(f'== R3 DRYRUN end {now()} ==')


if __name__ == '__main__':
    try:
        mode = sys.argv[1] if len(sys.argv) > 1 else ''
        {'pre2': pre2, 'dryrun': dryrun}[mode]()
    except Exception:
        out('EXCEPTION:\n' + traceback.format_exc())
        sys.exit(1)
