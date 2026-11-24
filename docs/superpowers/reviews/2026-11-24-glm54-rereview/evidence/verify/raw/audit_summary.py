import json,sys
a=json.load(open(sys.argv[1]))
print('summary:',a.get('metadata',{}).get('vulnerabilities',{}))
if 'error' in a: print('ERROR:',json.dumps(a['error'])[:400])
order=['critical','high','moderate','low','info']
vul=a.get('vulnerabilities',{})
for name,v in sorted(vul.items(), key=lambda kv:(order.index(kv[1].get('severity')) if kv[1].get('severity') in order else 9, kv[0])):
    print('- %s [%s] range=%s direct=%s fixAvailable=%s' % (name, v.get('severity'), v.get('range'), v.get('isDirect'), str(v.get('fixAvailable'))[:90]))
    for x in v.get('via',[])[:3]:
        if isinstance(x,str): print('     via pkg:',x)
        else: print('     via adv:',x.get('title'),'|',x.get('url'),'| range',x.get('range'))
