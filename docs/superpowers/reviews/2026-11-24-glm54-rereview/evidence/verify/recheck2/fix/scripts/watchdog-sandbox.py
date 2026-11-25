#!/usr/bin/env python3
"""11.3-3b 看门第 6 查的沙箱验证（tools/pg-backup/pg-watchdog.sh 修后）。

备份侧用脚本自带的 PG_* 旋钮指到沙箱（1–5 查全绿，好走到第 6 查）；launchctl 与 osascript 用假件——
launchctl 按 audit/rc 文件回报「最近退出码」或「查不到服务」，osascript 只把通知记进文件（不弹真通知、不碰真 launchd）。
live 零写入、零服务操作。用法：python3 watchdog-sandbox.py
"""
import os
import shutil
import subprocess
import sys
import time

W = os.path.realpath('/tmp/glm54-fix-20261125')
SB = W + '/watchdog-sandbox'
WD = '/Users/berton/Github/kb-obsidian/llm_wiki/tools/pg-backup/pg-watchdog.sh'
RAW = open(W + '/raw/watchdog-sandbox.txt', 'w')
RESULTS = []

FAKE_LAUNCHCTL = r'''#!/bin/bash
# 沙箱假件：launchctl print <domain>/label → 按 audit/rc 回报；其余子命令只记账
here="$(cd "$(dirname "$0")" && pwd)"
if [ "$1" = "print" ]; then
  if [ "$(cat "$here/../audit/rc" 2>/dev/null)" = "missing" ]; then
    echo "Bad request." >&2
    echo "Could not find service \"${2##*/}\" in domain for user gui: 501" >&2
    exit 113
  fi
  echo "${2##*/} = {"
  echo "	active count = 0"
  echo "	state = $([ -f "$here/../audit/running" ] && echo running || echo exited)"
  echo "	program = /bin/bash"
  echo "	runs = 1"
  echo "	last exit code = $(cat "$here/../audit/rc")"
  echo "		event details = {"
  echo "			state = active"
  echo "		}"
  echo "}"
  exit 0
fi
echo "launchctl $*" >> "$here/../launchctl.calls"
'''
FAKE_OSASCRIPT = r'''#!/bin/bash
here="$(cd "$(dirname "$0")" && pwd)"
echo "$*" >> "$here/../notifications.txt"
'''


def out(*a):
    s = ' '.join(str(x) for x in a)
    print(s, flush=True)
    RAW.write(s + '\n')
    RAW.flush()


def check(name, cond, detail=''):
    RESULTS.append((name, bool(cond)))
    out(('PASS ' if cond else 'FAIL ') + name + (f' | {detail}' if detail else ''))


def case(name, rc_value, runs, log_age_h=6.0, running=False):
    """runs：每趟的行列表（不含首行「巡检开始」，首行按时间自动生成）。rc_value：假 launchctl 回报的退出码 / 'missing'。"""
    d = f'{SB}/{name}'
    shutil.rmtree(d, ignore_errors=True)
    for sub in ('bin', 'pg', 'mirror', 'storage', 'audit', 'home'):
        os.makedirs(f'{d}/{sub}')
    for fn, body in (('launchctl', FAKE_LAUNCHCTL), ('osascript', FAKE_OSASCRIPT)):
        open(f'{d}/bin/{fn}', 'w').write(body)
        os.chmod(f'{d}/bin/{fn}', 0o755)
    open(f'{d}/audit/rc', 'w').write(str(rc_value) + '\n')
    if running:
        open(f'{d}/audit/running', 'w').write('')
    # 1–5 查全绿
    now = time.time()
    for f in ('pg/last-success', 'pg/last-verify', 'storage/.mirror-ok', 'mirror/llmwiki-20261125-043000-1.dump'):
        open(f'{d}/{f}', 'w').write('')
    dump = f'{d}/pg/llmwiki-20261125-043000-1.dump'
    with open(dump, 'wb') as f:
        f.write(os.urandom(11 * 1024 * 1024))
    # 巡检日志：每趟相隔 24h，最后一趟在 log_age_h 小时前
    text = ''
    assert all(isinstance(x, list) for x in runs), 'runs 必须是「趟」的列表，每趟是行的列表'
    n = len(runs)
    for i, lines in enumerate(runs):
        age = log_age_h + 24.0 * (n - 1 - i)
        stamp = time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(now - age * 3600))
        text += f'── {stamp} 巡检开始 ──\n' + ''.join(l + '\n' for l in lines)
    logp = f'{d}/audit/audit.log'
    open(logp, 'w').write(text)
    os.utime(logp, (now - log_age_h * 3600, now - log_age_h * 3600))
    return d


def run(d):
    env = {'HOME': d + '/home', 'PATH': d + '/bin:/usr/bin:/bin:/usr/sbin:/sbin',
           'PG_BACKUP_DIR': d + '/pg', 'PG_MIRROR_DIR': d + '/mirror', 'PG_STORAGE_DST': d + '/storage',
           'LTUTOR_AUDIT_LOG': d + '/audit/audit.log'}
    p = subprocess.run(['/bin/bash', WD], cwd='/', env=env, capture_output=True, text=True, timeout=200)
    wlog = open(f'{d}/pg/watchdog.log').read() if os.path.exists(f'{d}/pg/watchdog.log') else ''
    notes = open(f'{d}/notifications.txt').read() if os.path.exists(f'{d}/notifications.txt') else ''
    return p.returncode, wlog, notes, p.stdout + p.stderr


OK_RUN = ['候选（surveyed、非测试、非主人）：wecom_a wecom_b ', '  已有任务：a', '  已有任务：b',
          '── 巡检完成：新开办 0 个、失败 0 个 ──', '── 巡检结束 exit=0 ──']


def main():
    out(f'== WATCHDOG-SANDBOX start {time.strftime("%F %T")} ==')
    shutil.rmtree(SB, ignore_errors=True)
    os.makedirs(SB)
    r = subprocess.run(['/bin/bash', '-n', WD], capture_output=True, text=True)
    check('bash -n 过（系统 bash 3.2）', r.returncode == 0, r.stderr.strip())

    d = case('W1-ok', 0, [OK_RUN])
    rc, wlog, notes, e = run(d)
    check('W1 正常：rc=0、OK 行带 ltutor audit ok、零通知', rc == 0 and 'OK: backup fresh, mirror fresh, size ok, verify fresh, ltutor audit ok' in wlog
          and notes == '' and 'ALERT' not in wlog, f'rc={rc} {wlog.strip()!r} {e[-300:]!r}')

    d = case('W2-failed', 1, [['候选：…', '  ▶ 自动开办：x', 'Traceback (most recent call last):', 'ModuleNotFoundError: No module named \'hermes_yaml\'']])
    rc, wlog, notes, e = run(d)
    al = [l for l in wlog.split('\n') if 'ALERT' in l]
    check('W2 上一趟失败（旧格式、无 exit 行）：rc=1、两条问题、一次通知',
          rc == 1 and len(al) == 1 and '巡检最近一趟退出码 1；' in al[0] and '没走到「巡检完成」；' in al[0] and '日志记的退出码' not in al[0]
          and notes.count('display notification') == 1 and '周报巡检看门' in notes and 'Basso' in notes, f'rc={rc} {al} {notes!r}')

    d = case('W2b-failed-newfmt', 1, [['候选：…', '  ✗ 开办失败：y（exit=1）', '── 巡检完成：新开办 1 个、失败 1 个 ──', '── 巡检结束 exit=1 ──']])
    rc, wlog, notes, e = run(d)
    al = [l for l in wlog.split('\n') if 'ALERT' in l]
    check('W2b 新格式失败趟：退出码两处都报、不误报「没走到完成」', rc == 1 and len(al) == 1 and '巡检最近一趟退出码 1；' in al[0]
          and '日志记的退出码 1；' in al[0] and '没走到' not in al[0], f'rc={rc} {al}')

    d = case('W3-stale', 0, [OK_RUN], log_age_h=30.0)
    rc, wlog, notes, e = run(d)
    al = [l for l in wlog.split('\n') if 'ALERT' in l]
    check('W3 日志 30h 没更新：告警', rc == 1 and len(al) == 1 and '日志已 30 小时没更新' in al[0], f'rc={rc} {al}')

    d = case('W4-missing', 'missing', [OK_RUN])
    rc, wlog, notes, e = run(d)
    al = [l for l in wlog.split('\n') if 'ALERT' in l]
    check('W4 任务未加载：告警且不误报退出码', rc == 1 and len(al) == 1 and '未加载' in al[0] and '退出码' not in al[0], f'rc={rc} {al}')

    d = case('W5-paused', 0, [['候选：…', '  [停发-告警] 名单内但任务仍在跑：p —— 长期停发请 hermes cron remove（runbook §6.2）'] + OK_RUN[4:]])
    rc, wlog, notes, e = run(d)
    al = [l for l in wlog.split('\n') if 'ALERT' in l]
    check('W5 停发告警：告警', rc == 1 and len(al) == 1 and '有「停发-告警」' in al[0], f'rc={rc} {al}')

    d = case('W6-new', 0, [['候选：…', '  已有任务：a', '  ▶ 自动开办：n', '[3/3] ✓ 周报任务已建', '── 巡检完成：新开办 1 个、失败 0 个 ──', '── 巡检结束 exit=0 ──']])
    rc, wlog, notes, e = run(d)
    n1 = notes.count('display notification')
    rc2, wlog2, notes2, e2 = run(d)
    check('W6 新开办 1：rc=0、NOTIFY 一次、静默通知一次', rc == 0 and wlog.count('NOTIFY: ltutor 周报巡检') == 1 and notes.count('display notification') == 1
          and '新开办 1 位教师' in notes and 'Basso' not in notes, f'rc={rc} {wlog.strip()!r} {notes!r}')
    check('W6 再跑：同一趟不重复通知', rc2 == 0 and wlog2.count('NOTIFY: ltutor 周报巡检') == 1 and notes2.count('display notification') == n1, f'{wlog2.strip()!r}')

    d = case('W7-nolog', 0, [], log_age_h=6.0)
    os.unlink(f'{d}/audit/audit.log')
    rc, wlog, notes, e = run(d)
    al = [l for l in wlog.split('\n') if 'ALERT' in l]
    check('W7 日志不存在：告警', rc == 1 and len(al) == 1 and '日志不存在' in al[0], f'rc={rc} {al}')

    # W8 睡醒补火：日志陈旧 + 巡检在跑 → 等它收尾（12s 后日志被刷新）→ 不告警
    d = case('W8-wake', 0, [OK_RUN], log_age_h=30.0, running=True)
    logp = f'{d}/audit/audit.log'
    stamp_old = open(logp).read()

    def bg():
        time.sleep(12)
        now = time.time()
        new = f'── {time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(now))} 巡检开始 ──\n' + ''.join(l + '\n' for l in OK_RUN)
        open(logp, 'w').write(new)
        os.utime(logp, None)
        os.unlink(f'{d}/audit/running')
    import threading
    t = threading.Thread(target=bg)
    t.start()
    t0 = time.time()
    rc, wlog, notes, e = run(d)
    dt = time.time() - t0
    t.join()
    check('W8 睡醒补火：等在跑的巡检收尾后不告警（空等 ≥10s）', rc == 0 and 'ALERT' not in wlog and notes == '' and dt >= 10 and 'ltutor audit ok' in wlog,
          f'rc={rc} dt={dt:.1f}s {wlog.strip()!r}')

    # locale 稳健性：launchd 无 LANG；也可能被 setenv 成 UTF-8。三种环境解析结果须一致
    for lang in ('', 'zh_CN.UTF-8', 'C.UTF-8'):
        d = case(f'W9-{lang or "none"}', 0, [['候选：…', '  ▶ 自动开办：n', '[3/3] ✓ 周报任务已建', '── 巡检完成：新开办 1 个、失败 0 个 ──', '── 巡检结束 exit=0 ──']])
        env = {'HOME': d + '/home', 'PATH': d + '/bin:/usr/bin:/bin:/usr/sbin:/sbin',
               'PG_BACKUP_DIR': d + '/pg', 'PG_MIRROR_DIR': d + '/mirror', 'PG_STORAGE_DST': d + '/storage',
               'LTUTOR_AUDIT_LOG': d + '/audit/audit.log'}
        if lang:
            env['LANG'] = env['LC_ALL'] = lang
        p = subprocess.run(['/bin/bash', WD], cwd='/', env=env, capture_output=True, text=True, timeout=200)
        wlog = open(f'{d}/pg/watchdog.log').read()
        notes = open(f'{d}/notifications.txt').read() if os.path.exists(f'{d}/notifications.txt') else ''
        check(f'W9 locale={lang or "(无)"}：正常趟 → rc=0、NOTIFY 一次、stderr 干净', p.returncode == 0 and 'ALERT' not in wlog
              and wlog.count('NOTIFY: ltutor 周报巡检') == 1 and '新开办 1 位教师' in notes and p.stderr.strip() == '', f'rc={p.returncode} {wlog.strip()!r} {p.stderr[-200:]!r}')
    bad = [n for n, ok in RESULTS if not ok]
    out(f'== 结果：{len(RESULTS) - len(bad)} 过 / {len(bad)} 败 {bad} ==')
    out(f'== WATCHDOG-SANDBOX end {time.strftime("%F %T")} ==')
    sys.exit(1 if bad else 0)


if __name__ == '__main__':
    main()
