import json, urllib.request, sys
def q(eco, name, ver):
    req = urllib.request.Request('https://api.osv.dev/v1/query', data=json.dumps({'package': {'name': name, 'ecosystem': eco}, 'version': ver}).encode(), headers={'content-type': 'application/json'})
    try:
        d = json.load(urllib.request.urlopen(req, timeout=30))
    except Exception as e:
        return 'ERR %s' % e
    v = d.get('vulns', [])
    out = []
    for x in v:
        sev = ''
        for s in (x.get('severity') or []):
            sev = s.get('score', '')[:30]
        alias = (x.get('aliases') or [x.get('id', '?')])[0]
        out.append('%s%s' % (alias, ('(' + sev.split('/')[0].split(':')[0] + ')') if sev else ''))
    return '%d %s' % (len(v), ', '.join(out))
for eco, name, ver in [('PyPI', 'openai', '2.24.0'), ('PyPI', 'openai', '2.54.0'), ('PyPI', 'anthropic', '0.87.0'), ('PyPI', 'anthropic', '0.125.0'), ('PyPI', 'mcp', '2.0.0'), ('PyPI', 'mcp', '2.3.0'), ('PyPI', 'pillow-heif', '1.6.0'), ('PyPI', 'pillow-heif', '1.8.1')]:
    print('%-6s %-13s %-8s vulns=%s' % (eco, name, ver, q(eco, name, ver)))
