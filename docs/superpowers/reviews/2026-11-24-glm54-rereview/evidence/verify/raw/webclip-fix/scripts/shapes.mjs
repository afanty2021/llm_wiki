// 实测：不同正文形态下 Readability 选中的节点是否含页头（决定阈值边界测试的夹具形态）。
import { pathToFileURL } from "node:url"
const wc = await import(pathToFileURL(`${process.argv[2]}/web-clip.js`).href)
const nws = (s) => s.replace(/\s+/g, "").length
const page = (body) => `<html><head><meta charset="utf-8"><meta property="og:title" content="边界页"><title>边界页</title></head><body><div id="img-content" class="rich_media_wrp"><h1 class="rich_media_title" id="activity-name"><span class="js_title_inner">边界页</span></h1><div id="meta_content" class="rich_media_meta_list"><span id="copyright_logo" class="rich_media_meta icon_appmsg_tag appmsg_title_tag">原创</span><span class="rich_media_meta rich_media_meta_text"><span id="js_author_name">愉快学英语</span></span><span class="rich_media_meta rich_media_meta_nickname" id="profileBt"><a id="js_name">郑新民谈英语教学与研究</a></span><em id="publish_time" class="rich_media_meta rich_media_meta_tag">2026年11月20日 08:00</em></div><div id="js_content" class="rich_media_content js_underline_content" style="visibility: hidden; opacity: 0; ">${body}</div></div></body></html>`
const shapes = [[199], [200], [100, 99], [100, 100], [50, 50, 50, 49], [50, 50, 50, 50], [67, 66, 66], [68, 66, 66]]
for (const shape of shapes) {
  const body = shape.map((n) => `<p>${"字".repeat(n)}</p>`).join("")
  try {
    const a = await wc.extractArticle(page(body), "https://mp.weixin.qq.com/s/abc")
    console.log(`${JSON.stringify(shape)} total=${shape.reduce((x, y) => x + y, 0)} -> OK md_nws=${nws(a.markdown)} decoy=${/郑新民|愉快学|原创|2026年/.test(a.markdown)}`)
  } catch (e) {
    console.log(`${JSON.stringify(shape)} total=${shape.reduce((x, y) => x + y, 0)} -> ${e.code} ${e.message.replace(/\s*\(.*/, "")}`)
  }
}
