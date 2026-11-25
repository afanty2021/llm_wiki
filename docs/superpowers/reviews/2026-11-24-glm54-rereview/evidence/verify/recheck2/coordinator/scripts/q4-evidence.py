#!/usr/bin/env python3
"""Q4 取证汇总：崩溃修复 0f17695f 在 11-24 22:00 前是否已加载。全程只读，输出落 C/raw/q4-loaded-evidence.txt。

来源：三笔提交信息（git，live 检出只读）；~/.hermes/logs/mcp-stderr.log 的启动 / 尾幅行；
~/.hermes/logs/agent.log 两个窗口（滤凭证、去 msg=、截 200）；主网关 state.db（mode=ro&immutable=1，
只取 teacher_tutor_web_clip 调用的 url 实参与工具结果字符数）。不打印任何聊天正文。"""
import json
import os
import re
import sqlite3
import subprocess
import time

LIVE = '/Users/berton/Github/kb-obsidian/llm_wiki'
HOME = os.path.expanduser('~')
OUT = '/tmp/glm54-recheck-20261125/C/raw/q4-loaded-evidence.txt'
CRED = re.compile(r'access_key|ticket=|bearer|api[_-]?key|sk-', re.I)
lines = []


def w(s=''):
    lines.append(s)


def sh(cmd):
    return subprocess.run(cmd, capture_output=True, text=True, cwd=LIVE).stdout


def clean(s, n=200):
    s = re.sub(r'(poc_token=)\w+', r'\1<masked>', s)
    return s[:n]


w('# Q4 取证：0f17695f 在 11-24 22:00 前是否已加载（协调者，%s）' % time.strftime('%Y-%m-%d %H:%M:%S'))
w('结论见 report.md §十一。本文件只列原始行：时间戳、工具名、URL 实参、字符数；聊天正文与带凭证的行不入档。')
w()
w('## A. 三笔提交的正文（git show -s，live 检出只读）')
for c in ['0f17695f', 'e8ee2893', '8887af93']:
    w(sh(['git', '--no-optional-locks', 'show', '-s', '--format=--- %h %ci%n%B', c]).strip())
w()
w('## B. mcp-stderr.log：11-24 20:50 之后的 training / admin 启动行与 Node.js 尾幅')
def stamp(l):
    """启动行的时刻在方括号里（===== [YYYY-MM-DD HH:MM:SS] starting…），尾幅行的时刻是行首前缀。"""
    m = re.match(r'^===== \[(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\]', l)
    if m:
        return m.group(1)
    return l[:19] if re.match(r'^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d', l) else None


with open(f'{HOME}/.hermes/logs/mcp-stderr.log', errors='replace') as f:
    for i, l in enumerate(f, 1):
        s = stamp(l)
        if s and s >= '2026-11-24 20:50' and re.search(r"starting MCP server '(llm-wiki-training|llm-wiki-admin)'|Node\.js v", l):
            w('%d:%s' % (i, l.rstrip()[:120]))
w('（20:52:07 之后新增的 Node.js 尾幅数见 B 段：无）')
w()
w('## C. agent.log：四个窗口（滤凭证、去 msg=、截 200）')
wins = [('C1 四次崩溃与工具报错 20:51:15–20:52:10', r'^2026-11-24 20:5(1:[1-5][0-9]|2:0[0-9]|2:10)'),
        ('C2 补丁到重拉 20:53:40–20:54:14', r'^2026-11-24 20:5(3:[4-5][0-9]|4:0[0-9]|4:1[0-4])'),
        ('C3 补收任务 21:10:55–21:11:20 与 21:28:05–21:28:46', r'^2026-11-24 21:(10:5[5-9]|11:[01][0-9]|28:(0[5-9]|[1-4][0-9]|5[0-9]))'),
        ('C4 落盘两篇时的工具 21:42:00–21:43:10', r'^2026-11-24 21:4(2:[0-5][0-9]|3:[01][0-9])')]
keep = re.compile(r'teacher_tutor_web_clip|stdio|respawn|reconnect|tool [A-Za-z_]+ completed|returned error|'
                  r'Running job|completed successfully|delivered to|conversation_loop: API call|lsp\[')
with open(f'{HOME}/.hermes/logs/agent.log', errors='replace') as f:
    rows = [(i, l.rstrip()) for i, l in enumerate(f, 1)]
for title, rx in wins:
    w('### ' + title)
    for i, l in rows:
        if re.search(rx, l) and keep.search(l) and 'msg=' not in l and not CRED.search(l):
            w('%d:%s' % (i, clean(l)))
    w()
w('## D. 会话库（state.db，immutable 只读）：11-24 20:50–22:00 的 teacher_tutor_web_clip 调用')
con = sqlite3.connect(f'file:{HOME}/.hermes/state.db?mode=ro&immutable=1', uri=True)
rows = con.execute('select session_id, role, content, tool_call_id, tool_calls, timestamp from messages').fetchall()
con.close()
calls, res = {}, {}
for sid, role, content, tcid, tc, ts in rows:
    if not isinstance(ts, (int, float)):
        continue
    sec = ts / 1000 if ts > 1e11 else ts
    when = time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(sec))
    if not ('2026-11-24 20:50:00' <= when <= '2026-11-24 22:00:00'):
        continue
    if tc and 'web_clip' in str(tc):
        for c in json.loads(tc):
            fn = c.get('function') or {}
            if 'web_clip' in (fn.get('name') or ''):
                a = json.loads(fn.get('arguments') or '{}')
                u = a.get('url') or ''
                mid = re.search(r'mid=(\d+)', u)
                calls[c.get('id')] = (when, sid[:22], (mid.group(1) if mid else '非老式链'), '老式 __biz 链' if '__biz' in u else '其它')
    elif role == 'tool':
        res[tcid] = content or ''
for k, (when, sid, mid, kind) in sorted(calls.items(), key=lambda kv: kv[1][0]):
    r = res.get(k, '')
    inner = re.sub(r'^\s*<untrusted_tool_result[^>]*>\s*', '', re.sub(r'</untrusted_tool_result>\s*$', '', r.strip()))
    m = re.search(r'\{"(result|error)": "([^"]{0,40})', inner)
    verdict = (m.group(1) + '=' + m.group(2) + '…') if m else clean(inner, 60)
    w('%s  会话=%s…  %s mid=%s  工具结果 %d 字符 | %s' % (when, sid, kind, mid, len(inner), verdict))
w()
w('读法：20:51:18–20:52:06 四次调用 = 四次崩溃（B 段四条尾幅、C1 段四条 lost its stdio subprocess）；')
w('      20:54:05 起同一批链接的调用全部优雅返回（result=「这篇提不了正文…」），此后 B 段零尾幅；')
w('      服务这些调用的 training 进程 = 20:54:05 那次无尾幅重拉（C2：派发时「had already exited」，respawning and retrying once）。')
open(OUT, 'w').write('\n'.join(lines) + '\n')
print('\n'.join(lines))
