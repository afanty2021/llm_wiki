#!/usr/bin/env python3
"""11.3-3a 巡检脚本沙箱验证（auto-provision-weekly.sh / provision-teacher-weekly.sh 修后）。

live 零写入的保证：HOME、TMPDIR 指向沙箱；被测脚本拉起的每个 python 进程经 sitecustomize 装审计钩子——
沙箱之外的任何写入 / 改权限 / 改名、起子进程、联网一律拒绝。launchd 形态：cwd=/、最小环境变量。
Hermes 检出只读导入（PYTHONDONTWRITEBYTECODE=1，不落 .pyc）。教师 id 全是化名。
用法：python3 audit-sandbox.py
"""
import hashlib
import json
import os
import shutil
import stat
import subprocess
import sys
import time

W = os.path.realpath('/tmp/glm54-fix-20261125')  # /tmp → /private/tmp：Hermes 侧路径都经 resolve()，守卫根须用规范路径
SB = W + '/audit-sandbox'
REPO = '/Users/berton/Github/kb-obsidian/llm_wiki'
AUDIT = REPO + '/tools/ltutor/auto-provision-weekly.sh'
PROV = REPO + '/tools/ltutor/provision-teacher-weekly.sh'
HPY = '/opt/homebrew/Caskroom/miniconda/base/envs/hermes-3.11/bin/python'
RAW = open(W + '/raw/audit-sandbox.txt', 'w')
RESULTS = []

GUARD = r'''import os, sys
_ROOT = os.environ['SB_GUARD_ROOT']
_WF = os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND
_FD_RELATIVE = [False]  # shutil.rmtree 走 fd 相对名（os.unlink(name, dir_fd=…)）：只能经已打开的目录 fd 触达，放行


def _ok(p):
    if _FD_RELATIVE[0]:
        return True
    if isinstance(p, bytes):
        p = os.fsdecode(p)
    if not isinstance(p, str):
        return True  # 文件描述符整数：放行
    ap = os.path.abspath(p)
    return ap == _ROOT or ap.startswith(_ROOT + os.sep)


def _deny(what, p):
    raise PermissionError(f'sandbox guard: {what} denied outside sandbox: {p}')


def _hook(event, args):
    _FD_RELATIVE[0] = event != 'open' and len(args) > 1 and isinstance(args[-1], int)
    if event == 'open':
        path, mode, flags = args
        writing = (isinstance(mode, str) and any(c in mode for c in 'wax+')) or \
                  (isinstance(flags, int) and bool(flags & _WF))
        if writing and not _ok(path):
            _deny('write', path)
    elif event in ('os.mkdir', 'os.remove', 'os.rmdir', 'os.chmod', 'os.chown', 'os.utime', 'os.truncate'):
        if args and not _ok(args[0]):
            _deny(event, args[0])
    elif event in ('os.rename', 'os.link', 'os.symlink'):
        for p in args[:2]:
            if not _ok(p):
                _deny(event, p)
    elif event in ('subprocess.Popen', 'os.system', 'socket.connect', 'socket.bind', 'os.kill'):
        _deny(event, '')


sys.addaudithook(_hook)
'''

NOCRON = r'''
import importlib.abc


class _BlockCron(importlib.abc.MetaPathFinder):
    def find_spec(self, name, path, target=None):
        if name == 'cron':
            raise ImportError('sandbox: cron import blocked on purpose')
        return None


sys.meta_path.insert(0, _BlockCron())
'''

MAIN_CFG = (
    "# sandbox: structure only\n"
    "gateway:\n"
    "    - name: lt-tutor-wecom\n"
    "      platform: wecom\n"
    "      profile: lt-tutor\n"
    "      enabled: true\n"
)
PROFILE_CFG = "# sandbox profile config\nmodel: sandbox-model\n"
ANCHORLESS_CFG = MAIN_CFG.replace("    - name: lt-tutor-wecom\n", "    - name: renamed-catch-all\n")

STUB_PROV = r'''#!/bin/bash
# 沙箱桩：名字带 bad 的教师开办失败（exit 3），其余记一笔后成功
case "$1" in
  *bad*|Bad*) echo "stub: fail $1" >&2; exit 3 ;;
esac
echo "$1" >> "$(dirname "$0")/../out/stub-ok.txt"
echo "stub: ok $1"
'''


def out(*a):
    s = ' '.join(str(x) for x in a)
    print(s, flush=True)
    RAW.write(s + '\n')
    RAW.flush()


def check(name, cond, detail=''):
    RESULTS.append((name, bool(cond), detail))
    out(('PASS ' if cond else 'FAIL ') + name + (f' | {detail}' if detail else ''))


def sh(cmd, cwd='/', env=None, timeout=240):
    p = subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, text=True, timeout=timeout)
    return p.returncode, p.stdout, p.stderr


def env_for(d, guard='guard'):
    return {
        'HOME': d + '/home', 'TMPDIR': SB + '/tmp', 'PATH': '/usr/bin:/bin:/usr/sbin:/sbin',
        'PYTHONDONTWRITEBYTECODE': '1', 'PYTHONPATH': f'{SB}/{guard}', 'SB_GUARD_ROOT': SB,
        'LOG': d + '/out/audit.log',
    }


def fresh(name):
    d = f'{SB}/cases/{name}'
    shutil.rmtree(d, ignore_errors=True)
    for sub in ('home/.hermes/profiles/lt-tutor', 'scripts', 'bin', 'out'):
        os.makedirs(f'{d}/{sub}')
    return d


def run_prov(d, *args, guard='guard'):
    return sh(['/bin/bash', f'{d}/scripts/provision-teacher-weekly.sh', *args], env=env_for(d, guard))


def seed(d, teachers):
    """空 profile → 依次真开办 teachers（走生产代码 create_job），得到一个「全部已有」的 HOME。"""
    open(f'{d}/home/.hermes/config.yaml', 'w').write(MAIN_CFG)
    open(f'{d}/home/.hermes/profiles/lt-tutor/config.yaml', 'w').write(PROFILE_CFG)
    shutil.copy2(PROV, f'{d}/scripts/provision-teacher-weekly.sh')
    for t in teachers:
        rc, o, e = run_prov(d, t)
        assert rc == 0, (t, rc, o, e)


def mismatch(d, low, up):
    """把路由 chat_id 改成与任务名仅大小写不同（生产形态：路由 wecom_TeachRoute / 任务 wecom_teachjob / 库用户名 wecom_TeachUser）。"""
    p = f'{d}/home/.hermes/config.yaml'
    s = open(p).read()
    a = f'      chat_id: {low}\n'
    assert s.count(a) == 1
    open(p, 'w').write(s.replace(a, f'      chat_id: {up}\n'))


def snap(root):
    r = {}
    for dp, dns, fns in os.walk(root):
        for n in dns + fns + ['']:
            p = os.path.join(dp, n) if n else dp
            st = os.lstat(p)
            rec = [stat.S_IFMT(st.st_mode), stat.S_IMODE(st.st_mode), st.st_size, st.st_mtime_ns, st.st_ctime_ns]
            if stat.S_ISREG(st.st_mode):
                rec.append(hashlib.sha256(open(p, 'rb').read()).hexdigest()[:16])
            r[os.path.relpath(p, root)] = tuple(rec)
    return r


def snap_diff(a, b):
    ch = []
    for k in sorted(set(a) | set(b)):
        if k not in a:
            ch.append(f'+{k}')
        elif k not in b:
            ch.append(f'-{k}')
        elif a[k] != b[k]:
            x, y = a[k], b[k]
            what = []
            for i, lab in enumerate(['type', 'mode', 'size', 'mtime', 'ctime', 'sha']):
                if i < len(x) and i < len(y) and x[i] != y[i]:
                    what.append(lab)
            ch.append(f'~{k}({",".join(what)})')
    return ch


def jobs(d):
    p = f'{d}/home/.hermes/profiles/lt-tutor/cron/jobs.json'
    if not os.path.exists(p):
        return []
    j = json.load(open(p))
    return sorted((x.get('name'), (x.get('schedule') or {}).get('expr')) for x in (j['jobs'] if isinstance(j, dict) else j))


def write_fake_docker(d, teachers, fail=False):
    open(f'{d}/bin/docker', 'w').write(
        '#!/bin/bash\n'
        + ('echo "Cannot connect to the Docker daemon at sandbox" >&2; exit 1\n' if fail else
           f'cat "{d}/bin/teachers.txt"\n'))
    os.chmod(f'{d}/bin/docker', 0o755)
    open(f'{d}/bin/teachers.txt', 'w').write(''.join(f'wecom_{t}\n' for t in teachers))


def install_audit(d, paused=(), stub=False):
    s = open(AUDIT).read()
    a = 'DOCKER="/opt/homebrew/bin/docker"\n'
    assert s.count(a) == 1
    open(f'{d}/scripts/auto-provision-weekly.sh', 'w').write(s.replace(a, f'DOCKER="{d}/bin/docker"\n'))
    open(f'{d}/scripts/paused-weekly.txt', 'w').write(''.join(f'{p}\n' for p in paused))
    if stub:
        open(f'{d}/scripts/provision-teacher-weekly.sh', 'w').write(STUB_PROV)


def run_audit(d, guard='guard'):
    rc, o, e = sh(['/bin/bash', f'{d}/scripts/auto-provision-weekly.sh'], env=env_for(d, guard))
    log = open(f'{d}/out/audit.log').read() if os.path.exists(f'{d}/out/audit.log') else ''
    return rc, log, o + e


def setup_guards():
    shutil.rmtree(SB, ignore_errors=True)
    os.makedirs(SB + '/tmp')
    for g in ('guard', 'guard-nocron', 'guard-ns'):
        os.makedirs(f'{SB}/{g}')
    open(f'{SB}/guard/sitecustomize.py', 'w').write(GUARD)
    open(f'{SB}/guard-nocron/sitecustomize.py', 'w').write(GUARD + NOCRON)
    os.makedirs(f'{SB}/guard-ns/hermes_cli')  # 无 __init__.py：hermes_cli 成了命名空间包，__file__ 为 None
    open(f'{SB}/guard-ns/sitecustomize.py', 'w').write(GUARD)


# ───────── provision 脚本 ─────────
def test_provision():
    out('== provision-teacher-weekly.sh ==')
    # P1 dry-run：三步全跳过（含任务名仅大小写不同），沙箱 HOME 零变化
    d = fresh('P1')
    seed(d, ['amy', 'casey'])
    mismatch(d, 'casey', 'Casey')
    before = snap(d + '/home')
    rc, o, e = run_prov(d, 'Casey', '--dry-run')
    check('P1 dry-run 三步全跳过 rc=0', rc == 0 and o.count('跳过') == 3 and '[3/3] 周报任务已存在' in o, f'rc={rc} {o.strip()!r}')
    check('P1 dry-run 对 HOME 零写入（含 ctime）', not snap_diff(before, snap(d + '/home')), str(snap_diff(before, snap(d + '/home'))))
    check('P1 干跑横幅写明零写入', '对 live 目录零写入' in o)

    # P2 dry-run：全新教师，三步都「将…」，零写入、无备份
    d = fresh('P2')
    seed(d, ['amy'])
    before = snap(d + '/home')
    rc, o, e = run_prov(d, 'Newbie', '--dry-run')
    check('P2 dry-run 全新教师 rc=0、两行「将」+platforms 已存在', rc == 0 and o.count('将') == 2 and '[2/3] platforms.wecom 启用块已存在' in o, f'rc={rc} {o.strip()!r}')
    check('P2 dry-run 零写入', not snap_diff(before, snap(d + '/home')), str(snap_diff(before, snap(d + '/home'))))
    check('P2 槽位=下一个空分钟（已有 0）', '19:01' in o)

    # P3 真跑：全新教师——路由 / platforms / 任务三样都落，备份三份，权限位保留，无残留临时文件
    d = fresh('P3')
    open(f'{d}/home/.hermes/config.yaml', 'w').write(MAIN_CFG)
    open(f'{d}/home/.hermes/profiles/lt-tutor/config.yaml', 'w').write(PROFILE_CFG)
    shutil.copy2(PROV, f'{d}/scripts/provision-teacher-weekly.sh')
    for f in ('config.yaml', 'profiles/lt-tutor/config.yaml'):
        os.chmod(f'{d}/home/.hermes/{f}', 0o600)
    ino_before = os.stat(f'{d}/home/.hermes/config.yaml').st_ino
    rc, o, e = run_prov(d, 'Newbie')
    cfg = open(f'{d}/home/.hermes/config.yaml').read()
    pcfg = open(f'{d}/home/.hermes/profiles/lt-tutor/config.yaml').read()
    check('P3 真跑 rc=0 且三步 ✓ + 重启提示', rc == 0 and o.count('✓') == 3 and '需重启网关' in o, f'rc={rc} {o.strip()!r} {e[-300:]!r}')
    check('P3 路由落在锚点之后、形态正确', cfg == MAIN_CFG.replace(
        "      enabled: true\n", "      enabled: true\n"
        "    - name: lt-tutor-wecom-newbie\n      platform: wecom\n      chat_id: Newbie\n      profile: lt-tutor\n      enabled: true\n", 1), repr(cfg))
    check('P3 platforms 块追加', pcfg.endswith("\n\n# cron 投递闸门需逻辑平台启用；无凭据=#101113 卫星形态，传输走主网关\nplatforms:\n  wecom:\n    enabled: true\n"))
    check('P3 任务已建 19:00', jobs(d) == [('lt-tutor-weekly:Newbie', '0 19 * * 0')], str(jobs(d)))
    baks = sorted(os.path.basename(x) for x in os.listdir(f'{d}/home/.hermes') if '.bak-' in x)
    baks2 = sorted(os.path.basename(x) for x in os.listdir(f'{d}/home/.hermes/profiles/lt-tutor') if '.bak-' in x)
    baks3 = sorted(os.path.basename(x) for x in os.listdir(f'{d}/home/.hermes/profiles/lt-tutor/cron') if '.bak-' in x)
    check('P3 两份备份（jobs.json 尚不存在，无从备份）', len(baks) == 1 and len(baks2) == 1 and baks3 == [], f'{baks} {baks2} {baks3}')
    st = os.stat(f'{d}/home/.hermes/config.yaml')
    check('P3 主 config 权限位保留 0600、inode 已换（原子替换）', stat.S_IMODE(st.st_mode) == 0o600 and st.st_ino != ino_before,
          f'mode={oct(stat.S_IMODE(st.st_mode))} ino {ino_before}->{st.st_ino}')
    check('P3 profile config 权限位保留 0600', stat.S_IMODE(os.stat(f'{d}/home/.hermes/profiles/lt-tutor/config.yaml').st_mode) == 0o600)
    leftovers = [x for dp, _, fs in os.walk(f'{d}/home/.hermes') for x in fs if x.startswith('.config.yaml.')]
    check('P3 无残留临时文件', not leftovers, str(leftovers))
    check('P3 备份内容=写前原文', open(f'{d}/home/.hermes/{baks[0]}').read() == MAIN_CFG)

    # P4 重跑：三步全跳过，无新备份
    before = snap(d + '/home')
    rc, o, e = run_prov(d, 'Newbie')
    after = snap_diff(before, snap(d + '/home'))
    # 真跑时 load_jobs() 的 ensure_dirs() 会对两个 cron 目录各做一次 mkdir(exist_ok)+chmod 0700（Hermes 内部行为，网关自己也周期性做）：只允许这两处 ctime 变
    check('P4 重跑幂等 rc=0 三跳过、无新备份、除 cron 两目录 ctime 外零变化', rc == 0 and o.count('跳过') == 3
          and after == ['~.hermes/profiles/lt-tutor/cron(ctime)', '~.hermes/profiles/lt-tutor/cron/output(ctime)'], f'rc={rc} {after}')

    # P5 参数校验
    d = fresh('P5')
    seed(d, ['amy'])
    before = snap(d + '/home')
    rc, o, e = run_prov(d, 'Newbie', '--dryrun')
    check('P5 --dryrun 笔误 exit=2 且零写入', rc == 2 and not snap_diff(before, snap(d + '/home')), f'rc={rc} {e.strip()!r}')
    rc, o, e = run_prov(d, 'Newbie', '--dry-run=1')
    check('P5 --dry-run=1 exit=2', rc == 2 and not snap_diff(before, snap(d + '/home')), f'rc={rc}')
    rc, o, e = run_prov(d, 'Newbie', '--dry-run', 'extra')
    check('P5 多余参数 exit=2', rc == 2 and not snap_diff(before, snap(d + '/home')), f'rc={rc} {e.strip()!r}')
    rc, o, e = run_prov(d)
    check('P5 缺教师 id exit=1', rc == 1 and '用法' in e, f'rc={rc}')

    # P6 import 断链：全新教师也零写盘（import 先于 ①② 的写盘）
    d = fresh('P6')
    open(f'{d}/home/.hermes/config.yaml', 'w').write(MAIN_CFG)
    open(f'{d}/home/.hermes/profiles/lt-tutor/config.yaml', 'w').write(PROFILE_CFG)
    shutil.copy2(PROV, f'{d}/scripts/provision-teacher-weekly.sh')
    before = snap(d + '/home')
    rc, o, e = run_prov(d, 'Newbie', guard='guard-nocron')
    check('P6 cron 断链 → rc=1、零写盘、带说明', rc == 1 and not snap_diff(before, snap(d + '/home')) and 'import cron.jobs 失败' in e
          and '未写任何文件' in e, f'rc={rc} {e.strip()[-260:]!r}')
    rc, o, e = run_prov(d, 'Newbie', guard='guard-ns')
    check('P6 检出根推导失败 → rc=1、零写盘、带说明', rc == 1 and not snap_diff(before, snap(d + '/home')) and '推导出的检出根不对' in e,
          f'rc={rc} {e.strip()[-200:]!r}')

    # P7 锚点丢失：① 之前零写盘
    d = fresh('P7')
    open(f'{d}/home/.hermes/config.yaml', 'w').write(ANCHORLESS_CFG)
    open(f'{d}/home/.hermes/profiles/lt-tutor/config.yaml', 'w').write(PROFILE_CFG)
    shutil.copy2(PROV, f'{d}/scripts/provision-teacher-weekly.sh')
    before = snap(d + '/home')
    rc, o, e = run_prov(d, 'Newbie')
    check('P7 锚点丢失 → rc=1、零写盘', rc == 1 and not snap_diff(before, snap(d + '/home')) and '找不到 lt-tutor-wecom catch-all 锚点' in (o + e),
          f'rc={rc}')

    # P8 dry-run 且 live 没有 jobs.json
    d = fresh('P8')
    open(f'{d}/home/.hermes/config.yaml', 'w').write(MAIN_CFG)
    open(f'{d}/home/.hermes/profiles/lt-tutor/config.yaml', 'w').write(PROFILE_CFG)
    shutil.copy2(PROV, f'{d}/scripts/provision-teacher-weekly.sh')
    before = snap(d + '/home')
    rc, o, e = run_prov(d, 'Newbie', '--dry-run')
    check('P8 dry-run 无 jobs.json → rc=0、19:00、零写入', rc == 0 and '19:00' in o and not snap_diff(before, snap(d + '/home')),
          f'rc={rc} {o.strip()!r}')

    # P9 目录不可写：备份先失败 → 原文件完好
    d = fresh('P9')
    seed(d, ['amy'])
    cfg_sha = hashlib.sha256(open(f'{d}/home/.hermes/config.yaml', 'rb').read()).hexdigest()
    os.chmod(f'{d}/home/.hermes', 0o500)
    try:
        rc, o, e = run_prov(d, 'Newbie')
    finally:
        os.chmod(f'{d}/home/.hermes', 0o700)
    check('P9 目录不可写 → rc=1、主 config 完好', rc == 1 and hashlib.sha256(open(f'{d}/home/.hermes/config.yaml', 'rb').read()).hexdigest() == cfg_sha
          and jobs(d) == [('lt-tutor-weekly:amy', '0 19 * * 0')], f'rc={rc}')

    # P10 真跑时任务名仅大小写不同：不重复建任务
    d = fresh('P10')
    seed(d, ['amy', 'casey'])
    rc, o, e = run_prov(d, 'Casey')
    check('P10 任务名仅大小写不同 → ③ 跳过、不建第二个任务', rc == 0 and '[3/3] 周报任务已存在' in o
          and [n for n, _ in jobs(d)] == ['lt-tutor-weekly:amy', 'lt-tutor-weekly:casey'], f'rc={rc} {o.strip()!r}')


# ───────── 巡检脚本 ─────────
def test_audit():
    out('== auto-provision-weekly.sh ==')
    # A1 全部已有（含大小写不一致）：零开办、exit=0
    d = fresh('A1')
    seed(d, ['amy', 'casey', 'pat1'])
    mismatch(d, 'casey', 'Casey')
    before_jobs = jobs(d)
    write_fake_docker(d, ['amy', 'Casey', 'pat1'])
    install_audit(d)
    rc, log, e = run_audit(d)
    check('A1 全部已有（含大小写不一致）', rc == 0 and '已有任务：Casey' in log and '自动开办' not in log
          and '巡检完成：新开办 0 个、失败 0 个' in log and '巡检结束 exit=0' in log and jobs(d) == before_jobs, f'rc={rc}\n{log}')
    check('A1 每趟三行标记齐全', log.count('巡检开始') == 1 and log.count('巡检完成') == 1 and log.count('巡检结束 exit=') == 1)

    # A2 一名新教师：真开办
    d = fresh('A2')
    seed(d, ['amy', 'casey'])
    write_fake_docker(d, ['amy', 'casey', 'Newbie'])
    install_audit(d)
    rc, log, e = run_audit(d)
    check('A2 新教师真开办 rc=0', rc == 0 and '▶ 自动开办：Newbie' in log and '精确路由已补' in log and '周报任务已建' in log
          and '巡检完成：新开办 1 个、失败 0 个' in log and '巡检结束 exit=0' in log
          and ('lt-tutor-weekly:Newbie', '2 19 * * 0') in jobs(d), f'rc={rc}\n{log}')
    check('A2 jobs.json 建前备份已留', any(x.startswith('jobs.json.bak-') for x in os.listdir(f'{d}/home/.hermes/profiles/lt-tutor/cron')))

    # A3 失败隔离：桩脚本让 Bad* 失败
    d = fresh('A3')
    seed(d, ['amy'])
    write_fake_docker(d, ['amy', 'BadOne', 'GoodOne', 'BadTwo'])
    install_audit(d, stub=True)
    rc, log, e = run_audit(d)
    stub_ok = open(f'{d}/out/stub-ok.txt').read().split() if os.path.exists(f'{d}/out/stub-ok.txt') else []
    check('A3 单个失败不拖垮整轮', rc == 1 and '✗ 开办失败：BadOne（exit=3）' in log and '✗ 开办失败：BadTwo（exit=3）' in log
          and stub_ok == ['GoodOne'] and '巡检完成：新开办 1 个、失败 2 个' in log and '巡检结束 exit=1' in log, f'rc={rc} stub_ok={stub_ok}\n{log}')

    # A4 停发名单
    d = fresh('A4')
    seed(d, ['amy', 'pat'])
    write_fake_docker(d, ['amy', 'Pat', 'Quinn'])
    install_audit(d, paused=['Pat', 'Quinn'])
    rc, log, e = run_audit(d)
    check('A4 停发名单：名单内任务在→告警、不在→不开办', rc == 0 and '[停发-告警] 名单内但任务仍在跑：Pat' in log and '[停发] Quinn 不自动开办' in log
          and '▶ 自动开办' not in log and '巡检完成：新开办 0 个、失败 0 个' in log, f'rc={rc}\n{log}')

    # A5 docker 失败
    d = fresh('A5')
    seed(d, ['amy'])
    write_fake_docker(d, [], fail=True)
    install_audit(d)
    rc, log, e = run_audit(d)
    check('A5 docker 失败 → 非零退出、有 exit 行、无「巡检完成」', rc != 0 and '巡检结束 exit=1' in log and '巡检完成' not in log
          and log.count('巡检结束 exit=') == 1, f'rc={rc}\n{log}')


def main():
    out(f'== AUDIT-SANDBOX start {time.strftime("%F %T")} ==')
    setup_guards()
    # 守卫自检：沙箱外写入必须被拒
    e = env_for(SB + '/cases')
    probe = W + '/guard-selftest.txt'
    rc, o, er = sh([HPY, '-c', f'open({probe!r}, "w")'], env=e)
    leaked = os.path.exists(probe)
    if leaked:
        os.unlink(probe)
    check('守卫自检：沙箱外写入被拒', rc != 0 and 'sandbox guard' in er and not leaked, f'rc={rc} {er.strip()[-120:]!r}')
    rc, o, er = sh([HPY, '-c',
                    'import hermes_cli, os; print(os.path.dirname(os.path.dirname(os.path.realpath(hermes_cli.__file__))))'], env=e)
    check('检出根推导 = 期望路径', rc == 0 and o.strip() == '/Users/berton/Github/Coding-Agents/Hermes-agent', f'rc={rc} {o.strip()!r} {er[-200:]!r}')
    try:
        test_provision()
    except Exception:
        import traceback
        out('EXCEPTION in test_provision:\n' + traceback.format_exc())
        check('test_provision 跑完', False)
    try:
        test_audit()
    except Exception:
        import traceback
        out('EXCEPTION in test_audit:\n' + traceback.format_exc())
        check('test_audit 跑完', False)
    check('干跑的临时目录全部已清（P1/P2/P8 三次干跑）', os.listdir(SB + '/tmp') == [], str(os.listdir(SB + '/tmp')))
    bad = [n for n, ok, _ in RESULTS if not ok]
    out(f'== 结果：{len(RESULTS) - len(bad)} 过 / {len(bad)} 败 {bad} ==')
    out(f'== AUDIT-SANDBOX end {time.strftime("%F %T")} ==')
    sys.exit(1 if bad else 0)


if __name__ == '__main__':
    main()
