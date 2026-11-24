import sqlite3, json, datetime, sys
DB='/Users/berton/.hermes/profiles/lt-tutor/state.db'
con=sqlite3.connect('file:%s?mode=ro' % DB, uri=True)
CST=datetime.timezone(datetime.timedelta(hours=8))
def t(ts): return datetime.datetime.fromtimestamp(ts, CST).strftime('%m-%d %H:%M:%S') if ts else '-'
lo=datetime.datetime(2026,10,31,0,0,tzinfo=CST).timestamp(); hi=datetime.datetime(2026,11,1,0,0,tzinfo=CST).timestamp()
# ggtms 是什么形态的 user_id
rows=con.execute("select user_id, count(*) from sessions where started_at>=? and started_at<? group by 1 order by 2 desc limit 8",(lo,hi)).fetchall()
print('10-31 当天会话按 user_id:', [(u[:28] if u else u, n) for u,n in rows])
sess=con.execute("select id, started_at, ended_at, end_reason, message_count, tool_call_count, source, title from sessions where started_at>=? and started_at<? and (user_id like '%ggtms%' or chat_id like '%ggtms%' or session_key like '%ggtms%') order by started_at",(lo,hi)).fetchall()
print('ggtms 10-31 会话数:',len(sess))
for sid,st,en,er,mc,tc,src,title in sess:
    print('\n=== session %s  %s → %s  end=%s msgs=%s tool_calls=%s source=%s title=%r' % (sid, t(st), t(en), er, mc, tc, src, (title or '')[:30]))
    for role, content, tool_calls, tool_name, ts in con.execute("select role, content, tool_calls, tool_name, timestamp from messages where session_id=? and active=1 order by timestamp, id",(sid,)):
        if role=='user':
            c=(content or '').replace('\n',' ')
            print('  [USER %s] %s' % (t(ts), c[:110]))
        elif role=='assistant' and tool_calls:
            try: calls=json.loads(tool_calls)
            except Exception: calls=[]
            for c in calls if isinstance(calls,list) else []:
                fn=(c.get('function') or {}); name=fn.get('name') or c.get('name'); args=fn.get('arguments') or c.get('arguments') or ''
                if isinstance(args,str):
                    try: a=json.loads(args)
                    except Exception: a=args
                key={k:(str(v)[:60]) for k,v in a.items()} if isinstance(a,dict) else str(a)[:60]
                print('  [CALL %s] %s %s' % (t(ts), name, json.dumps(key, ensure_ascii=False)[:170]))
        elif role=='tool':
            pass
        elif role=='assistant':
            c=(content or '').replace('\n',' ')
            print('  [ASSISTANT %s] len=%d  %s' % (t(ts), len(content or ''), c[:100]))
