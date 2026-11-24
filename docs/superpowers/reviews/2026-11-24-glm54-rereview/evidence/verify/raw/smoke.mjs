import { fetchWithGuards, extractArticle, normalizeUrl } from '/tmp/review-verify/mcp/dist/src/web-clip.js';
const url = process.argv[2];
const t0 = Date.now();
try {
  const norm = normalizeUrl(url);
  const r = await fetchWithGuards(norm);
  console.log('fetch: status=%s contentType=%s bytes=%s elapsedMs=%s', r.status, r.contentType, r.body ? r.body.length : null, Date.now()-t0);
  const html = new TextDecoder('utf-8').decode(r.body);
  const a = await extractArticle(html, r.finalUrl || norm);
  console.log('extract: titleLen=%s markdownChars=%s', a.title.length, a.markdown.length);
  console.log('title(head 60):', a.title.slice(0,60));
  console.log('markdown(head 120):', a.markdown.replace(/\s+/g,' ').slice(0,120));
} catch (e) { console.log('SMOKE_ERROR:', e && e.name, String(e && e.message).slice(0,200)); process.exit(2); }
