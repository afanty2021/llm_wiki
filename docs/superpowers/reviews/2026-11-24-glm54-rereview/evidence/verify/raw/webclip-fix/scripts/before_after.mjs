// 修前（live dist 旧实现）vs 修后（临时副本新实现）在同一份存档 HTML 上的提取结果。只读，不写库不入队。
import { readFileSync, readdirSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { JSDOM } from "/Users/berton/Github/kb-obsidian/llm_wiki/mcp-server/node_modules/jsdom/lib/api.js"
const [oldDist, newDist, pagesDir] = process.argv.slice(2)
const oldWc = await import(pathToFileURL(`${oldDist}/web-clip.js`).href)
const newWc = await import(pathToFileURL(`${newDist}/web-clip.js`).href)
const nws = (s) => s.replace(/\s+/g, "").length
const decoy = /郑新民谈英语教学与研究|愉快学英语|先学好再教别人|李陆桂Englishlearner|不喜欢|内容含AI生成图片/
for (const f of readdirSync(pagesDir).sort()) {
  const html = readFileSync(`${pagesDir}/${f}`, "utf8")
  const url = `https://mp.weixin.qq.com/s/${f.replace(".html", "")}`
  const dom = new JSDOM(html, { url })
  const jsNws = nws(dom.window.document.querySelector("#js_content")?.textContent ?? "")
  dom.window.close()
  const cell = async (wc) => {
    try {
      const a = await wc.extractArticle(html, url)
      return `${String(nws(a.markdown)).padStart(5)} 字符 | decoy=${decoy.test(a.markdown) ? "有" : "无"} | title=${nws(a.title)}字`
    } catch (e) { return `抛 ${e.code}` }
  }
  console.log(`${f.slice(0, 22)}  #js_content=${jsNws} 字`)
  console.log(`   修前: ${await cell(oldWc)}`)
  console.log(`   修后: ${await cell(newWc)}`)
}
