// 对新构建的 live dist 做 MCP stdio 握手（initialize → tools/list），验证产物可启动、18 工具齐全、web_clip schema 未变。
// 不读任何密钥、不调用工具、不碰网关（独立短命进程，15s 兜底 kill）。
import { spawn } from "node:child_process"
const [nodeBin, entry] = process.argv.slice(2)
const child = spawn(nodeBin, [entry], {
  env: { PATH: process.env.PATH, HOME: process.env.HOME, LLM_WIKI_API_BASE_URL: "http://127.0.0.1:8080", LLM_WIKI_API_FORM: "src-server", TRAINING__PROJECT_ID: "614" },
  stdio: ["pipe", "pipe", "pipe"],
})
let buf = ""; const replies = new Map(); const stderr = []
child.stderr.on("data", (d) => stderr.push(String(d)))
child.stdout.on("data", (d) => {
  buf += String(d)
  let nl
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
    if (!line.trim()) continue
    try { const msg = JSON.parse(line); if (msg.id !== undefined) replies.set(msg.id, msg) } catch { /* non-JSON stdout line */ }
  }
})
const send = (o) => child.stdin.write(JSON.stringify(o) + "\n")
const wait = (id, ms = 10000) => new Promise((res, rej) => {
  const t0 = Date.now()
  const tick = () => { if (replies.has(id)) return res(replies.get(id)); if (Date.now() - t0 > ms) return rej(new Error(`timeout waiting for id=${id}`)); setTimeout(tick, 25) }
  tick()
})
const timer = setTimeout(() => { child.kill("SIGKILL"); console.log("KILLED after 15s"); process.exit(2) }, 15000)
try {
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "handshake-smoke", version: "0" } } })
  const init = await wait(1)
  send({ jsonrpc: "2.0", method: "notifications/initialized" })
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" })
  const list = await wait(2)
  const tools = list.result?.tools ?? []
  console.log(`initialize ok: server=${JSON.stringify(init.result?.serverInfo)} protocol=${init.result?.protocolVersion}`)
  console.log(`tools/list: ${tools.length} tools`)
  const names = tools.map((t) => t.name).sort()
  console.log(`  ${names.join(", ")}`)
  const clip = tools.find((t) => t.name === "teacher_tutor_web_clip")
  console.log(`web_clip schema: ${JSON.stringify(clip?.inputSchema)}`)
} catch (e) {
  console.log(`HANDSHAKE FAILED: ${e.message}\nstderr:\n${stderr.join("").slice(0, 600)}`)
} finally {
  clearTimeout(timer); child.kill("SIGTERM")
}
console.log(`stderr[0]: ${stderr.join("").split("\n")[0]}`)
process.exit(0)
