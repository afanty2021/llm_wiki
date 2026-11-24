import sqlite3, datetime, re, collections
DB='/Users/berton/.hermes/profiles/lt-tutor/state.db'
con=sqlite3.connect('file:%s?mode=ro' % DB, uri=True)
CST=datetime.timezone(datetime.timedelta(hours=8))
t=lambda ts: datetime.datetime.fromtimestamp(ts, CST).strftime('%m-%d %H:%M')
drift=datetime.datetime(2026,11,20,14,57,tzinfo=CST).timestamp()
lo=datetime.datetime(2026,11,17,0,0,tzinfo=CST).timestamp()
print('=== 11-20 14:57 漂移之后：含「家长会/家校沟通」的用户消息 ===')
n=0
for uid, ts, c in con.execute("select s.user_id, m.timestamp, m.content from messages m join sessions s on s.id=m.session_id where m.role='user' and m.active=1 and m.timestamp>=? and (m.content like '%家长会%' or m.content like '%家校沟通%') order by m.timestamp",(drift,)):
    n+=1; print('  ', t(ts), (uid or '')[:4]+'…', (c or '').replace('\n',' ')[:70])
print('  count:', n)
print('=== 11-17 起：工具结果里带 409 的记录（按工具计数 + 首末时刻） ===')
agg=collections.defaultdict(list)
for tn, ts, c in con.execute("select m.tool_name, m.timestamp, m.content from messages m where m.role='tool' and m.timestamp>=? and m.content like '%409%' order by m.timestamp",(lo,)):
    i=c.find('409'); agg[tn].append((ts, c[max(0,i-90):i+110].replace('\n',' ')))
for tn, lst in sorted(agg.items(), key=lambda kv:-len(kv[1])):
    print('  %s: %d 条  %s → %s' % (tn, len(lst), t(lst[0][0]), t(lst[-1][0])))
    for ts, snip in lst[:2]: print('      ', snip[:200])
print('=== 11-17 起：用户消息里出现「家长会」之前（漂移前）是否已有相关请求 ===')
for uid, ts, c in con.execute("select s.user_id, m.timestamp, m.content from messages m join sessions s on s.id=m.session_id where m.role='user' and m.active=1 and m.timestamp<? and (m.content like '%家长会%' or m.content like '%家校沟通%') order by m.timestamp desc limit 5",(drift,)):
    print('  ', t(ts), (uid or '')[:4]+'…', (c or '').replace('\n',' ')[:70])
