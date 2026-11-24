// N-1 用户可见症状取证：真实微信文章链接 → 生产同款 extractArticle + clipReplyText（不写库、不入队）。
// 用法（cwd=/tmp/review-verify/mcp）：node smoke_reply.mjs <url> [<url>...]
import { fetchWithGuards, extractArticle, normalizeUrl } from '/tmp/review-verify/mcp/dist/src/web-clip.js';
// clipReplyText 未导出（training.ts:898-902 模块私有），此处逐字复刻 created 分支模板
const clipReplyText = (o) => o.status === 'created' ? `已收藏《${o.title}》，稍后整理完成后即可检索` : '';

for (const url of process.argv.slice(2)) {
  const target = normalizeUrl(url);
  const out = { urlTail: url.slice(-10) };
  try {
    const r = await fetchWithGuards(target);
    const html = new TextDecoder('utf-8').decode(r.bytes);
    const a = await extractArticle(html, target);
    const title = a.title ?? '';
    const outcome = { status: 'created', title, sourcePath: a.sourcePath ?? '', pagePath: a.pagePath ?? '', jobId: 'dry' };
    out.bytes = r.bytes.byteLength;
    out.byline = a.byline ?? null;
    out.titleChars = title.length;
    out.title = title.slice(0, 60);
    out.markdownChars = a.markdown.length;
    out.reply = clipReplyText(outcome);
  } catch (e) {
    out.error = String(e && e.message ? e.message : e).slice(0, 160);
  }
  console.log(JSON.stringify(out));
}
