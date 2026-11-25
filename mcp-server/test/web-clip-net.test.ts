// 真网络回归测试（实现评审 Important-1）：生产 fetch 接线 undiciRequestOnce 的唯一测试触达面。
// 既有 web-clip-fetch.test.ts 全部经 FetchGuardsDeps 注入绕开真实 undici——undici 若升级改变
// buildConnector 透传语义，那批绿灯不会有一个变红，SSRF 门静默退化为「查完再 fetch」。
// 本文件只绑 127.0.0.1 随机端口 + RFC 6761 保留假域名（.invalid 恒不解析），CI 零外网依赖。
// 钉住六件事（加项时同步改计数——评审 R2b-M2）：
// 1) SSRF 门在全生产路径上先于 socket（负向两形 → ssrf_blocked 且服务端零连接——
//    「查完再 fetch」退化会让零连接断言变红）；
// 2) undici buildConnector 对 connect.lookup 的透传（正向：假域名 + 钉 lookup 真连本地
//    服务——透传被破坏则真实 DNS 解析 .invalid 失败，本测试红）；
// 3) 总墙钟 AbortSignal 撕断慢滴 body（Minor-2：bodyTimeout 是 chunk 闲歇帽，慢滴可绕）；
// 4) remainingMs 收窄单跳 timeout（headersTimeout 旗标在帽内触发）；
// 5) 重定向分支销毁未读 body 时不以未捕获 error 击杀进程（2026-11-24 微信 __biz 老链
//    崩溃回归钉）：全路径钉走 fetchWithGuards 重定向分支 → 生产 destroy 闭包，闭包直呼钉
//    钉同一个闭包——删掉监听器，几枚同红；
// 6) 契约层（评审 R2b-M1）：头已到、调用方既不消费也不 destroy、socket 随后出错——
//    body 的 error 事件不得成为未捕获异常。
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

// ── 5) 重定向分支销毁未读 body 不击杀进程（2026-11-24 __biz 老链崩溃回归钉）──────────

test("真网络·destroy 闭包：销毁在飞未完成的 302 body 不以未捕获 error 击杀进程，且连接被释放（2026-11-24 崩溃钉）", async () => {
  // 生产形态：微信 __biz 老链 → 302，fetchWithGuards 重定向分支 res.destroy() 销毁未读的
  // BodyReadable——undici 的 BodyReadable.destroy 对未完成流会带 UND_ERR_ABORTED 销毁，
  // 无 error 监听器时该抛点无人接住：生产裸异步链里即 uncaught 'error' 击杀整个 MCP
  // 进程（11-24 四次实锺，栈 orchestrateClip；node:test 捕获为用例失败）。修复=
  // undiciRequestOnce 返回响应前挂常驻 noop 监听器。SSRF 门不放环回进 fetchWithGuards 的
  // 默认接线（负向钉 1 钉的正是该语义），所以生产路径另有一枚全路径钉（见下，评审
  // R2b-I1）；本钉直呼 undiciRequestOnce，钉的是同一个 destroy 闭包。
  let oldLinkClosed = 0
  const s = await startServer((_req, res) => {
    // 永不 end 的 302：响应 body 处于在飞未完成态（生产崩溃的触发条件）
    res.writeHead(302, { location: "/final" })
    const drip = setInterval(() => res.write("redirect-body"), 20)
    let stopped = false
    const stop = () => {
      if (stopped) return
      stopped = true
      clearInterval(drip)
      oldLinkClosed += 1
    }
    res.on("close", stop)
    res.on("error", stop)
  })
  try {
    const res = await undiciRequestOnce(new URL(`http://weixin-old.invalid:${s.port}/old-link`), LOOPBACK)
    assert.equal(res.status, 302)
    assert.equal(res.location, "/final")
    res.destroy() // 生产崩溃点：销毁未读的在飞 body（闭包内 agent.close 撕断在飞交换）
    // 钉性质不钉实现（评审 R2b-M2）：断言「在飞连接在窗内被释放」——GuardedResponse.destroy
    // 的契约就是撕裂底层连接；不断言 body.destroyed 标志，那会把「排空代替销毁」这类
    // 不崩的等价修法判红。
    for (const until = Date.now() + 2000; oldLinkClosed === 0 && Date.now() < until;) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(oldLinkClosed, 1, "destroy 须释放那条在飞连接")
    // 给 emitErrorNT/abort 机制留窗口：活到此处=钉子成立（删监听器=uncaughtException，本用例红）
    await new Promise((resolve) => setTimeout(resolve, 150))
  } finally {
    await s.close()
  }
})

test("真网络·destroy 闭包：销毁已收完但未读的 302 body 同样不击杀进程（评审 R2b-M2：修前这种形态也崩，钉子的触发条件不该比生产更严）", async () => {
  const s = await startServer((_req, res) => {
    res.writeHead(302, { location: "/final" })
    res.end("redirect-body") // body 很快收完；调用方一直不读
  })
  try {
    const res = await undiciRequestOnce(new URL(`http://weixin-old.invalid:${s.port}/old-link`), LOOPBACK)
    assert.equal(res.status, 302)
    // GuardedResponse.body 声明为 AsyncIterable，运行时是 undici Readable：缓冲字节数到位 = 已收完
    const body = res.body as unknown as { readableLength: number }
    for (const until = Date.now() + 2000; body.readableLength < "redirect-body".length && Date.now() < until;) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.ok(body.readableLength >= "redirect-body".length, "前置：body 已收完但未读")
    res.destroy()
    await new Promise((resolve) => setTimeout(resolve, 150))
  } finally {
    await s.close()
  }
})

test("真网络·全路径：fetchWithGuards 重定向分支销毁在飞 302 body 不击杀进程（评审 R2b-I1：钉生产路径，不只钉闭包）", async () => {
  let hits = 0
  const s = await startServer((req, res) => {
    hits += 1
    if (req.url === "/old-link") {
      // 永不 end 的 302（在飞 body）；Location 相对解析后进第二跳
      res.writeHead(302, { location: "/final" })
      const drip = setInterval(() => res.write("redirect-body"), 20)
      res.on("close", () => clearInterval(drip))
      res.on("error", () => clearInterval(drip))
      return
    }
    res.setHeader("content-type", "text/html")
    res.end("<html><body>final-ok</body></html>")
  })
  try {
    const out = await fetchWithGuards(`http://weixin-old.invalid:${s.port}/old-link`, {
      // 只替换「门放行哪个地址」：SSRF 门过的是公网地址；requestOnce 仍是生产
      // undiciRequestOnce，钉的却是环回（真连环回）。fetchWithGuards → res.destroy() 这段
      // 接线与生产逐字相同
      lookupAll: async () => [{ address: "93.184.216.34", family: 4 }],
      requestOnce: (url) => undiciRequestOnce(url, LOOPBACK),
    })
    assert.equal(out.finalUrl, `http://weixin-old.invalid:${s.port}/final`)
    assert.ok(Buffer.from(out.bytes).toString().includes("final-ok"), "第二跳正文取回")
    assert.equal(hits, 2)
    await new Promise((resolve) => setTimeout(resolve, 150))
  } finally {
    await s.close()
  }
})

// ── 6) 契约层：无人消费、无人 destroy 时 socket 出错（评审 R2b-M1）────────────────

test("真网络·契约层：头已到、调用方既不消费也不 destroy，socket 随后出错（FIN / RST / chunked 提前关闭）→ 不击杀进程", async () => {
  for (const form of ["content-length 不符后 FIN", "RST", "chunked 提前关闭"] as const) {
    const s = await startServer((_req, res) => {
      if (form === "content-length 不符后 FIN") {
        res.writeHead(200, { "content-type": "text/html", "content-length": "1000" })
      } else if (form === "chunked 提前关闭") {
        res.writeHead(200, { "content-type": "text/html", "transfer-encoding": "chunked" })
      } else {
        res.writeHead(200, { "content-type": "text/html" })
      }
      res.write("partial-body")
      setTimeout(() => {
        const sock = res.socket as unknown as { destroy(): void; resetAndDestroy?(): void } | null
        if (form === "RST") sock?.resetAndDestroy?.()
        else sock?.destroy()
      }, 30)
    })
    let res: Awaited<ReturnType<typeof undiciRequestOnce>> | undefined
    try {
      res = await undiciRequestOnce(new URL(`http://half-open.invalid:${s.port}/x`), LOOPBACK)
      assert.equal(res.status, 200, `${form}：头已到`)
      // 阳性对照：流确实以 error 收场——否则「进程没死」可能只是因为什么都没发生。
      // 只读 errored 属性，本测试不挂 error 监听器：自己一挂就等于替生产代码把错接走，
      // 钉子会变空（变异实跑踩过：删掉生产监听器本用例照样绿）
      const body = res.body as unknown as { errored: Error | null }
      for (const until = Date.now() + 2000; body.errored === null && Date.now() < until;) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      assert.ok(body.errored instanceof Error, `${form}：body 须以 error 收场`)
      // 活到此处 = undiciRequestOnce 返回前挂的常驻 noop 监听器在位。删掉它，上面那个
      // error 无人接 → uncaughtException，本用例红
      await new Promise((resolve) => setTimeout(resolve, 150))
    } finally {
      res?.destroy()
      await s.close()
    }
  }
})
