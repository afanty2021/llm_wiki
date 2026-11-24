// 取回真实微信文章存档 + 修前基线（live dist 的 extractArticle）+ 结构检查。只读外呼，不写库不入队。
import { writeFileSync } from "node:fs"
import { pathToFileURL } from "node:url"
const DIST = process.argv[2]
const OUT = process.argv[3]
const wc = await import(pathToFileURL(`${DIST}/web-clip.js`).href)
const { JSDOM } = await import(pathToFileURL(`${DIST}/../../node_modules/jsdom/lib/api.js`).href)
const urls = process.argv.slice(4)
const nws = (s) => s.replace(/\s+/g, "").length
for (const raw of urls) {
  const id = raw.split("/s/")[1]
  try {
    const norm = wc.normalizeUrl(raw)
    const res = await wc.fetchWithGuards(norm)
    const html = wc.decodeBody(res.bytes, wc.sniffCharset(res.contentType, res.bytes))
    writeFileSync(`${OUT}/${id}.html`, html)
    let base = "(extract threw)"
    try {
      const a = await wc.extractArticle(html, res.finalUrl)
      base = `title=${JSON.stringify(a.title)} markdown=${a.markdown.length} chars`
      if (a.markdown.length < 200) base += ` body=${JSON.stringify(a.markdown.replace(/\s+/g, " ").trim())}`
    } catch (e) { base = `(extract threw ${e.code ?? e.message})` }
    const dom = new JSDOM(html, { url: res.finalUrl })
    const doc = dom.window.document
    const js = doc.querySelector("#js_content")
    let struct = "NO #js_content"
    if (js) {
      const hiddenDesc = [...js.querySelectorAll("*")].filter((el) => el.style && el.style.visibility === "hidden").length
      const ariaHidden = [...js.querySelectorAll("*")].filter((el) => el.hasAttribute("hidden") || el.getAttribute("aria-hidden") === "true" || (el.style && el.style.display === "none")).length
      struct = `style=${JSON.stringify(js.getAttribute("style"))} textContent_nws=${nws(js.textContent)} desc_visibility_hidden=${hiddenDesc} desc_display_none_or_hidden_attr=${ariaHidden} elems=${js.querySelectorAll("*").length}`
    }
    console.log(`${id} | bytes=${res.bytes.length} ct=${res.contentType} final=${res.finalUrl}\n   BEFORE: ${base}\n   #js_content: ${struct}`)
    dom.window.close()
  } catch (e) {
    console.log(`${id} | FETCH FAILED ${e.code ?? ""} ${String(e.message).slice(0, 120)}`)
  }
}
