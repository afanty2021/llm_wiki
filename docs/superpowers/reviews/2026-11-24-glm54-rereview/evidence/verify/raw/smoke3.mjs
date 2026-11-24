import { fetchWithGuards, extractArticle, normalizeUrl } from '/tmp/review-verify/mcp/dist/src/web-clip.js';
import { JSDOM } from 'jsdom';
import { Readability } from '@mixmark-io/readability';
for (const url of process.argv.slice(2)) {
  const r = await fetchWithGuards(normalizeUrl(url));
  const html = new TextDecoder('utf-8').decode(r.bytes);
  const dom = new JSDOM(html, { url });
  const doc = dom.window.document;
  const jc = doc.getElementById('js_content');
  const jcText = jc ? jc.textContent.replace(/\s+/g,' ').trim() : '';
  let prod = 'n/a';
  try { const a = await extractArticle(html, url); prod = `mdChars=${a.markdown.length} md="${a.markdown.replace(/\s+/g,' ').slice(0,90)}"`; } catch (e) { prod = 'ERR ' + String(e.message).slice(0,70); }
  let ra = 'n/a';
  try { const art = new Readability(doc.cloneNode(true)).parse(); ra = art ? `readability.content chars=${art.content.length} excerpt=${art.textContent.replace(/\s+/g,' ').slice(0,80)}` : 'Readability.parse() = null'; } catch (e) { ra = 'ERR ' + String(e.message).slice(0,80); }
  console.log(JSON.stringify({ url: url.slice(-22), jsContentTextChars: jcText.length, jsContentChildren: jc ? jc.children.length : null, jsContentVisible: jc ? jc.getAttribute('style') : null, excerpt: jcText.slice(0,60), prod, ra }));
  dom.window.close();
}
