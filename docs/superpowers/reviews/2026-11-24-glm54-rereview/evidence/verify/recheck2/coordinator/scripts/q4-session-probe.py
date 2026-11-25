#!/usr/bin/env python3
"""Q4 取证补遗：0f17695f 在 11-24 22:00 前是否已加载——修复后头几次 web_clip 调用打的是什么链接。

只读打开主网关 state.db（mode=ro&immutable=1：不建 -wal/-shm、不加锁、不写入），只取：
  · assistant 消息里 teacher_tutor_web_clip 调用的 url 实参；
  · 对应工具结果的字符数与前 96 个字符（工具回执文案，不是聊天正文）。
不打印任何 user/assistant 正文；命令行给起止时间（YYYY-MM-DD HH:MM），只落在这个窗内的行。
用法：python3 q4-session-probe.py '2026-11-24 20:50' '2026-11-24 22:00'"""
import json
import re
import sqlite3
import sys
import time

DB = 'file:/Users/berton/.hermes/state.db?mode=ro&immutable=1'
CRED = re.compile(r'access_key|ticket=|bearer|api[_-]?key|sk-', re.I)
t0 = time.mktime(time.strptime(sys.argv[1], '%Y-%m-%d %H:%M'))
t1 = time.mktime(time.strptime(sys.argv[2], '%Y-%m-%d %H:%M'))

con = sqlite3.connect(DB, uri=True)
cur = con.cursor()
tables = [r[0] for r in cur.execute("select name from sqlite_master where type='table'")]
cols = {t: [r[1] for r in cur.execute(f'pragma table_info("{t}")')] for t in tables}
msg_t = next(t for t in tables if 'tool_calls' in cols[t])
print('表:', tables)
print('消息表:', msg_t, cols[msg_t])
allcols = ', '.join(f'"{c}"' for c in cols[msg_t])
rows = cur.execute(f'select {allcols} from "{msg_t}"').fetchall()
print('消息表行数:', len(rows))


def ts(v):
    """时间列可能是 epoch 秒 / 毫秒 / ISO 串；统一转成本地时间字符串，转不了原样返回。"""
    if isinstance(v, (int, float)):
        v = v / 1000 if v > 1e11 else v
        return time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(v)), (v >= t0 and v <= t1)
    try:
        p = time.strptime(str(v)[:19], '%Y-%m-%dT%H:%M:%S')
    except Exception:
        try:
            p = time.strptime(str(v)[:19], '%Y-%m-%d %H:%M:%S')
        except Exception:
            return str(v)[:19], True
        return str(v)[:19], (t0 <= time.mktime(p) + 8 * 3600 <= t1) if str(v).endswith('Z') else (t0 <= time.mktime(p) <= t1)
    return str(v)[:19], (t0 <= time.mktime(p) + 8 * 3600 <= t1) if str(v).endswith('Z') else (t0 <= time.mktime(p) <= t1)


idx = {c: i for i, c in enumerate(cols[msg_t])}
calls = {}   # tool_call_id -> (时间, 会话, url)
results = []  # (时间, 会话, tool_call_id, 长度, 前 96 字符)
for r in rows:
    tcol = next(c for c in ('timestamp', 'created_at', 'ts', 'time') if c in idx)
    when, inwin = ts(r[idx[tcol]])
    if not inwin:
        continue
    sid = str(r[idx['session_id']])[:44] if 'session_id' in idx else '-'
    tc = r[idx['tool_calls']]
    role = r[idx['role']] if 'role' in idx else '?'
    if tc and 'web_clip' in str(tc):
        try:
            for c in json.loads(tc):
                fn = (c.get('function') or {})
                if 'web_clip' in (fn.get('name') or c.get('name') or ''):
                    args = fn.get('arguments') or c.get('arguments') or '{}'
                    a = json.loads(args) if isinstance(args, str) else args
                    calls[c.get('id')] = (when, sid, a.get('url') or a.get('link') or json.dumps(a, ensure_ascii=False)[:160])
        except Exception as e:
            print('  (tool_calls 解析失败)', type(e).__name__, when)
    elif role == 'tool' and calls and r[idx['tool_call_id']] in calls:
        content = r[idx['content']] or ''
        results.append((when, sid, r[idx['tool_call_id']], len(content), content[:96]))

print(f'\n== 窗口 {sys.argv[1]} – {sys.argv[2]} 内的 teacher_tutor_web_clip 调用 ==')
for k, (when, sid, url) in sorted(calls.items(), key=lambda kv: kv[1][0]):
    res = [x for x in results if x[2] == k]
    kind = '老式 __biz 链' if '__biz' in url else ('非微信/新式链' if 'mp.weixin' not in url else '新式 /s/ 链')
    print(f'{when}  会话={sid[:28]}…  {kind}')
    print(f'    url: {url[:150]}')
    for when2, _, _, n, head in res:
        head = CRED.sub('<cred>', head).replace('\n', ' ')
        print(f'    结果: {n} 字符 | {head}')
    if not res:
        print('    结果: (未找到对应 tool 行)')
con.close()
