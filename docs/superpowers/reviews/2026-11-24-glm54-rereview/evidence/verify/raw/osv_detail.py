import json, urllib.request, re
ids = ['CVE-2026-116685','CVE-2026-59951','CVE-2026-115563','CVE-2026-116686','CVE-2026-116684']
for i in ids:
    try:
        d = json.load(urllib.request.urlopen('https://api.osv.dev/v1/vulns/' + i, timeout=30))
    except Exception as e:
        print(i, 'ERR', e); continue
    sev = '; '.join('%s %s' % (s.get('type'), s.get('score')) for s in (d.get('severity') or []))
    summary = (d.get('summary') or '').strip()
    details = re.sub(r'\s+', ' ', d.get('details') or '').strip()
    fixed = sorted({e.get('fixed') for a in d.get('affected', []) for r in a.get('ranges', []) for e in r.get('events', []) if e.get('fixed')})
    print('- %s [%s] fixed=%s\n    %s\n    %s' % (i, sev, fixed, summary[:200], details[:330]))
