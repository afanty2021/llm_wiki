import sqlite3, json, datetime
DB='/Users/berton/.hermes/profiles/lt-tutor/state.db'
con=sqlite3.connect('file:%s?mode=ro' % DB, uri=True)
CST=datetime.timezone(datetime.timedelta(hours=8))
t=lambda ts: datetime.datetime.fromtimestamp(ts, CST).strftime('%H:%M:%S')
sid='20261031_151519_f26c71df'
print('=== session', sid, '全部消息（含 inactive / tool 结果，按时间） ===')
for mid, role, content, tool_name, active, ts, pmid in con.execute("select id, role, content, tool_name, active, timestamp, platform_message_id from messages where session_id=? order by timestamp, id",(sid,)):
    c=(content or '').replace('\n',' ')
    if role=='tool':
        print('  #%s [TOOL %s a=%s] %s' % (mid, tool_name, active, c[:230]))
    else:
        print('  #%s [%s %s a=%s pmid=%s] len=%d  %s' % (mid, role.upper(), t(ts), active, (pmid or '')[-6:], len(content or ''), c[:400]))
