import { fetchWithGuards, extractArticle, normalizeUrl } from '/tmp/review-verify/mcp/dist/src/web-clip.js';
const urls = process.argv.slice(2);
for (const url of urls) {
  const t0 = Date.now();
  try {
    const norm = normalizeUrl(url);
    const r = await fetchWithGuards(norm);
    const keys = Object.keys(r).join(',');
    const bytes = r.bytes || r.body || r.raw || r.data;
    const status = r.status ?? r.statusCode ?? r.httpStatus;
    const html = bytes ? new TextDecoder('utf-8').decode(bytes) : '';
    const probe = [];
    for (const marker of ['环境异常','完成验证','已被发布者删除','违规无法查看','此内容因违规','该内容已被发布者删除','参数错误','请在微信客户端打开','验证码','operation_seq','js_content','rich_media_title','activity-name','htmlcontent','该公众号','暂时无法查看','频繁','访问过于频繁']) {
      if (html.includes(marker)) probe.push(marker);
    }
    let ext = 'n/a';
    try { const a = await extractArticle(html, r.finalUrl || norm); ext = `OK titleLen=${a.title.length} mdChars=${a.markdown.length}`; } catch (e) { ext = 'ERR ' + String(e.message).slice(0, 60); }
    console.log(JSON.stringify({ url: url.slice(0, 60), ms: Date.now()-t0, status, keys: keys.slice(0,120), htmlChars: html.length, finalUrl: (r.finalUrl||'').slice(0,70), title: (html.match(/<meta property="og:title" content="([^"]*)"/)||[])[1]?.slice(0,50), markers: probe, extract: ext }));
  } catch (e) { console.log(JSON.stringify({ url: url.slice(0,60), ms: Date.now()-t0, SMOKE_ERROR: String(e.message).slice(0,160) })); }
}
