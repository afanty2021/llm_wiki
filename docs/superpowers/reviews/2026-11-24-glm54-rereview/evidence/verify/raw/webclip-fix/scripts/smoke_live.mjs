// 真链路冒烟：live dist 的生产函数链 fetchWithGuards → sniffCharset/decodeBody → extractArticle（与 orchestrateClip 前半段逐行同款）。不写库不入队。
import { pathToFileURL } from "node:url"
const wc = await import(pathToFileURL("/Users/berton/Github/kb-obsidian/llm_wiki/mcp-server/dist/src/web-clip.js").href)
const nws = (s) => s.replace(/\s+/g, "").length
const raw = process.argv[2]
const norm = wc.normalizeUrl(raw)
const res = await wc.fetchWithGuards(norm)
const html = wc.decodeBody(res.bytes, wc.sniffCharset(res.contentType, res.bytes))
try {
  const a = await wc.extractArticle(html, res.finalUrl)
  console.log(`OK  bytes=${res.bytes.length} ct=${res.contentType} finalHost=${new URL(res.finalUrl).hostname}`)
  console.log(`    title=${JSON.stringify(a.title)}`)
  console.log(`    markdown=${a.markdown.length} 字符（非空白 ${nws(a.markdown)}）| 行数 ${a.markdown.split("\n").length}`)
  console.log(`    文件名: ${wc.clipFileName(a.title, norm)}`)
  console.log(`    --- 回执预览（training.ts clipReplyText 同款模板套真实标题）---`)
  console.log(`    已收藏《${a.title}》，稍后整理完成后即可检索`)
  console.log(`    --- 正文前 160 字 ---\n    ${a.markdown.slice(0, 160).replace(/\n/g, " ⏎ ")}`)
} catch (e) {
  console.log(`REJECT ${e.code}: ${e.message}`)
}
