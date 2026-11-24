// 真网络回归测试（实现评审 Important-1）：生产 fetch 接线 undiciRequestOnce 的唯一测试触达面。
// 既有 web-clip-fetch.test.ts 全部经 FetchGuardsDeps 注入绕开真实 undici——undici 若升级改变
// buildConnector 透传语义，那批绿灯不会有一个变红，SSRF 门静默退化为「查完再 fetch」。
// 本文件只绑 127.0.0.1 随机端口 + RFC 6761 保留假域名（.invalid 恒不解析），CI 零外网依赖。
// 钉住四件事：
// 1) SSRF 门在全生产路径上先于 socket（负向两形 → ssrf_blocked 且服务端零连接——
//    「查完再 fetch」退化会让零连接断言变红）；
// 2) undici buildConnector 对 connect.lookup 的透传（正向：假域名 + 钉 lookup 真连本地
//    服务——透传被破坏则真实 DNS 解析 .invalid 失败，本测试红）；
// 3) 总墙钟 AbortSignal 撕断慢滴 body（Minor-2：bodyTimeout 是 chunk 闲歇帽，慢滴可绕）；
// 4) remainingMs 收窄单跳 timeout（headersTimeout 旗标在帽内触发）；
// 5) destroy 闭包消化销毁未完成 body 时 undici 的 UND_ERR_ABORTED——删监听器即红
//    （2026-11-24 微信 __biz 老链崩溃回归钉：重定向分支销毁未消费在飞 BodyReadable，
//    四次实锺栈 orchestrateClip）。
import assert from "node:assert/strict"
import http from "node:http"
import type { AddressInfo } from "node:net"
import { test } from "node:test"

import { WebClipError, fetchWithGuards, undiciRequestOnce } from "../src/web-clip.js"

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void

interface LocalServer {
  port: number
  connectionCount: () => number
  close: () => Promise<void>
}

/** 一次性本地 HTTP 服务：绑 127.0.0.1 随机端口，计数真实 TCP 连接数。 */
async function startServer(handler: Handler): Promise<LocalServer> {
  const server = http.createServer(handler)
  let connections = 0
  server.on("connection", () => {
    connections += 1
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  return {
    port,
    connectionCount: () => connections,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

async function assertWebClipError(p: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(
    p,
    (err: unknown) => err instanceof WebClipError && err.code === code,
  )
}

const LOOPBACK: { address: string; family: 4 } = { address: "127.0.0.1", family: 4 }

// ── 负向：SSRF 门先于 socket（全生产路径）─────────────────────────────────────

test("真网络·负向：假域名解析到环回 → ssrf_blocked 且服务端零连接（评审 Important-1① 主测试）", async () => {
  let served = 0
  const s = await startServer((_req, res) => {
    served += 1
    res.end("must never be fetched")
  })
  try {
    // 仅注入 lookupAll——requestOnce 留空 = 生产 undiciRequestOnce 接线在位
    await assertWebClipError(
      fetchWithGuards(`http://guard-probe.invalid:${s.port}/x`, {
        lookupAll: async () => [LOOPBACK],
      }),
      "ssrf_blocked",
    )
    assert.equal(s.connectionCount(), 0, "门必须在 socket 连接前拒绝（若退化为查完再 fetch，本行红）")
    assert.equal(served, 0)
  } finally {
    await s.close()
  }
})

test("真网络·负向：字面量环回零 deps 全生产路径 → ssrf_blocked 且零连接", async () => {
  const s = await startServer((_req, res) => res.end("must never be fetched"))
  try {
    // 零 deps：默认真 dnsLookup（字面量 IP 不发起）、默认 undici 接线
    await assertWebClipError(fetchWithGuards(`http://127.0.0.1:${s.port}/x`), "ssrf_blocked")
    assert.equal(s.connectionCount(), 0)
  } finally {
    await s.close()
  }
})

// ── 正向：钉 lookup 透传活证（undici 升级破坏透传即红）────────────────────────

test("真网络·正向：假域名 + 钉 lookup 真连本地服务；Host 头取 URL 域名与 socket 目标分离", async () => {
  let seenHost: string | null = null
  const s = await startServer((req, res) => {
    seenHost = req.headers.host ?? null
    res.setHeader("content-type", "text/html")
    res.end("<html><body>pinned-ok</body></html>")
  })
  try {
    // 若 buildConnector 不再把 connect.lookup 透传给 net.connect，真实 DNS 解析
    // pin-probe.invalid 将 NXDOMAIN → undiciRequestOnce 抛 fetch_failed → 本测试红
    const res = await undiciRequestOnce(new URL(`http://pin-probe.invalid:${s.port}/y`), LOOPBACK)
    assert.equal(res.status, 200)
    const chunks: Uint8Array[] = []
    for await (const chunk of res.body) chunks.push(chunk)
    res.destroy()
    const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString()
    assert.ok(text.includes("pinned-ok"), "真 socket 往返成立")
    const host: string | null = seenHost as string | null
    assert.ok(
      host !== null && host.startsWith(`pin-probe.invalid:${s.port}`),
      `Host 头仍是 URL 域名（实际 ${host}）——SNI/Host 与 socket 目标分离（anti-rebinding 语义）`,
    )
  } finally {
    await s.close()
  }
})

// ── 总墙钟与单跳预算（Minor-2）────────────────────────────────────────────────

test("真网络·总墙钟：慢滴 body 被 AbortSignal 撕断于帽内（闲歇型 bodyTimeout 帽不住的形态）", async () => {
  const s = await startServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" })
    const drip = setInterval(() => res.write("<p>drip</p>"), 50)
    res.on("close", () => clearInterval(drip))
    res.on("error", () => clearInterval(drip))
  })
  try {
    const deadline = new AbortController()
    setTimeout(() => deadline.abort(), 400).unref()
    const startedAt = Date.now()
    const res = await undiciRequestOnce(new URL(`http://slow.invalid:${s.port}/drip`), LOOPBACK, {
      signal: deadline.signal,
    })
    let consumeErr: unknown = null
    const consumed = (async () => {
      try {
        for await (const chunk of res.body) void chunk
      } catch (err) {
        consumeErr = err
      } finally {
        res.destroy()
      }
    })()
    const belt = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("AbortSignal 未撕断慢滴 body（10s 后仍在滴）")), 10000).unref(),
    )
    await Promise.race([consumed, belt])
    assert.ok(consumeErr !== null, "body 流必须以错误收场（signal 撕断）")
    const elapsed = Date.now() - startedAt
    assert.ok(elapsed < 5000, `撕断须发生在帽内（实际 ${elapsed}ms，不得吃满 20s bodyTimeout）`)
  } finally {
    await s.close()
  }
})

test("真网络·remainingMs 收窄单跳 headersTimeout：响应头迟于剩余预算 → fetch_failed 于帽内", async () => {
  const s = await startServer((_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { "content-type": "text/html" })
      res.end("late")
    }, 800)
  })
  try {
    const startedAt = Date.now()
    await assert.rejects(
      undiciRequestOnce(new URL(`http://late.invalid:${s.port}/z`), LOOPBACK, { remainingMs: 300 }),
      (err: unknown) => err instanceof WebClipError && err.code === "fetch_failed",
    )
    assert.ok(Date.now() - startedAt < 5000, `headersTimeout=min(20s, remaining)=300ms 应先触发（实际 ${Date.now() - startedAt}ms）`)
  } finally {
    await s.close()
  }
})

test("总墙钟·跨跳预算：预算耗尽即拒（fetch_failed budget），不再发起任何一跳", async () => {
  let called = 0
  await assert.rejects(
    fetchWithGuards("https://example.com/a", {
      totalBudgetMs: 0,
      requestOnce: async () => {
        called += 1
        throw new Error("must not be called")
      },
    }),
    (err: unknown) => err instanceof WebClipError && err.code === "fetch_failed" && /budget/.test(err.message),
  )
  assert.equal(called, 0)
})

test("DNS 超时：解析悬挂超 dnsTimeoutMs → dns_failed（Minor-2：不吃满 OS resolver 默认 30s+）", async () => {
  const startedAt = Date.now()
  await assert.rejects(
    fetchWithGuards("https://hanging.example/x", {
      dnsTimeoutMs: 150,
      lookupAll: () => new Promise(() => {}),
    }),
    (err: unknown) =>
      err instanceof WebClipError && err.code === "dns_failed" && /exceeded 150ms/.test(err.message),
  )
  assert.ok(Date.now() - startedAt < 5000)
})

// ── 5) 重定向分支 destroy 消化 UND_ERR_ABORTED（2026-11-24 __biz 老链崩溃回归钉）──

test("真网络·destroy 闭包：销毁未完成的 302 body 不以 unhandled error 击杀进程（2026-11-24 崩溃钉）", async () => {
  // 生产形态：微信 __biz 老链 → 302，fetchWithGuards 重定向分支 res.destroy() 销毁
  // 未消费的在飞 BodyReadable——undici v6 的 BodyReadable.destroy 对未完成流会带
  // UND_ERR_ABORTED 销毁，无 error 监听器时该抛点无人接住：生产裸异步链里即
  // uncaught 'error' 击杀整个 MCP 进程（11-24 四次实锺，栈 orchestrateClip；node:test
  // 捕获为用例失败）。修复=destroy 闭包先挂一次性 noop 监听器。SSRF 门不放环回进
  // fetchWithGuards（负向钉 1 钉的正是该语义），故本钉直呼 undiciRequestOnce——
  // 生产重定向分支销毁的正是同一个 destroy 闭包。删掉监听器那行，本测试即红
  // （变异实跑证真：destroy 调用点同步抛 UND_ERR_ABORTED AbortError）。
  const s = await startServer((_req, res) => {
    // 永不 end 的 302：响应 body 处于在飞未完成态（生产崩溃的触发条件）
    res.writeHead(302, { location: "/final" })
    const drip = setInterval(() => res.write("redirect-body"), 20)
    res.on("close", () => clearInterval(drip))
    res.on("error", () => clearInterval(drip))
  })
  try {
    const res = await undiciRequestOnce(new URL(`http://weixin-old.invalid:${s.port}/old-link`), LOOPBACK)
    assert.equal(res.status, 302)
    assert.equal(res.location, "/final")
    res.destroy() // 生产崩溃点：销毁未完成的在飞 body（闭包内 agent.close 撕断在飞交换）
    // GuardedResponse.body 声明为 AsyncIterable，运行时是 undici Readable（destroy 同步置位）
    const body = res.body as unknown as { destroyed: boolean }
    assert.ok(body.destroyed, "body 须已销毁")
    // 给 emitErrorNT/abort 机制留窗口：活到此处=钉子成立（删监听器=进程崩溃）
    await new Promise((resolve) => setTimeout(resolve, 150))
  } finally {
    await s.close()
  }
})
