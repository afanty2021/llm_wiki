import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"

import { LlmWikiApiClient, resolveApiForm } from "../src/api-client.js"
import { TeacherCredentialStore, createSrcServerHandlers, joinTLink } from "../src/training.js"
import { assertSrcServerEnv, buildTools } from "../src/index.js"

// 全部 mock 驱动：不依赖任何 live src-server。
const BASE = "http://127.0.0.1:8080"

interface RecordedCall {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

interface ResponderResult {
  status?: number
  body: unknown
}

interface Route {
  when: (call: RecordedCall) => boolean
  then: (call: RecordedCall) => ResponderResult | Promise<ResponderResult>
}

function mockFetch(routes: Route[], calls: RecordedCall[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const call: RecordedCall = {
      url: String(url),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? init.body : undefined,
    }
    calls.push(call)
    for (const route of routes) {
      if (route.when(call)) {
        const { status = 200, body } = await route.then(call)
        return new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        })
      }
    }
    throw new Error(`unexpected fetch: ${call.method} ${call.url}`)
  }) as typeof fetch
}

function authBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    access_token: "acc-1",
    refresh_token: "ref-rotated",
    expires_in: 3600,
    user: {
      id: 7,
      username: "wecom_t",
      email: "t@wecom.local",
      full_name: null,
      created_at: "2026-01-01T00:00:00Z",
    },
    ...overrides,
  }
}

function tempDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), `mcp-training-${prefix}-`))
}

function seedStore(storePath: string, entries: Record<string, unknown>): void {
  mkdirSync(path.dirname(storePath), { recursive: true })
  writeFileSync(storePath, JSON.stringify(entries))
}

function stubStore(): TeacherCredentialStore {
  return {
    getAccess: async () => "acc-tool",
    invalidate: () => {},
  } as unknown as TeacherCredentialStore
}

function makeHandlers(fetchImpl: typeof fetch, opts: { tbase?: string } = {}) {
  const client = new LlmWikiApiClient({ baseUrl: BASE, fetchImpl })
  return createSrcServerHandlers({
    client,
    store: stubStore(),
    getProjectId: () => 42,
    getPublicTBase: () => opts.tbase ?? BASE,
  })
}

function toolText(result: { content: Array<{ type: string; text: string }> }): string {
  assert.equal(result.content.length, 1)
  assert.equal(result.content[0]?.type, "text")
  return result.content[0]!.text
}

// ── 形态检测 ──

test("resolveApiForm: 默认 desktop，显式 src-server", () => {
  assert.equal(resolveApiForm({}), "desktop")
  assert.equal(resolveApiForm({ LLM_WIKI_API_FORM: "desktop" }), "desktop")
  assert.equal(resolveApiForm({ LLM_WIKI_API_FORM: "src-server" }), "src-server")
  assert.equal(resolveApiForm({ LLM_WIKI_API_FORM: "junk" }), "desktop")
})

// ── TeacherCredentialStore ──

test("store: 并发 3 次 getAccess 只发一次 refresh（single-flight），且轮换持久化", async (t) => {
  const dir = tempDir("single-flight")
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const storePath = path.join(dir, "teachers.json")
  seedStore(storePath, { t1: { refreshToken: "ref-old", userId: 7 } })

  let refreshCalls = 0
  const calls: RecordedCall[] = []
  const fetchImpl = mockFetch([
    {
      when: (c) => c.url === `${BASE}/api/v1/auth/refresh`,
      then: async () => {
        refreshCalls += 1
        await new Promise((resolve) => setTimeout(resolve, 20))
        return { body: authBody({ access_token: "acc-single" }) }
      },
    },
  ], calls)

  const store = new TeacherCredentialStore({ baseUrl: BASE, storePath, fetchImpl })
  const [a, b, c] = await Promise.all([
    store.getAccess("t1"),
    store.getAccess("t1"),
    store.getAccess("t1"),
  ])

  assert.equal(refreshCalls, 1)
  assert.deepEqual([a, b, c], ["acc-single", "acc-single", "acc-single"])
  // 轮换后的 refresh token 落盘
  assert.deepEqual(JSON.parse(readFileSync(storePath, "utf8")).t1, {
    refreshToken: "ref-rotated",
    userId: 7,
  })
})

test("store: 首次建档走 bind——请求形状 + 文件 600 / 目录 700", async (t) => {
  const dir = tempDir("perms")
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const storePath = path.join(dir, "nested", "teachers.json")

  const calls: RecordedCall[] = []
  const fetchImpl = mockFetch([
    {
      when: (c) => c.url === `${BASE}/api/v1/training/bind`,
      then: () => ({ body: authBody({ user: { id: 9 } }) }),
    },
  ], calls)

  const store = new TeacherCredentialStore({ baseUrl: BASE, storePath, fetchImpl, adminToken: "adm-secret" })
  assert.equal(await store.getAccess("t9"), "acc-1")

  const bind = calls.find((c) => c.url.endsWith("/api/v1/training/bind"))
  assert.ok(bind, "bind request recorded")
  assert.equal(bind!.method, "POST")
  assert.equal(bind!.headers["x-training-admin-token"], "adm-secret")
  assert.deepEqual(JSON.parse(bind!.body!), { wecom_userid: "t9" })

  assert.equal(statSync(storePath).mode & 0o777, 0o600, "teachers.json must be chmod 600")
  assert.equal(statSync(path.join(dir, "nested")).mode & 0o777, 0o700, "store dir must be chmod 700")
  assert.deepEqual(JSON.parse(readFileSync(storePath, "utf8")).t9, { refreshToken: "ref-rotated", userId: 9 })
})

test("store: 持久化原子写——无临时文件残留，内容/权限完好", async (t) => {
  const dir = tempDir("atomic")
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const storePath = path.join(dir, "teachers.json")

  const fetchImpl = mockFetch([
    { when: (c) => c.url === `${BASE}/api/v1/training/bind`, then: () => ({ body: authBody() }) },
  ], [])

  const store = new TeacherCredentialStore({ baseUrl: BASE, storePath, fetchImpl, adminToken: "adm-secret" })
  assert.equal(await store.getAccess("t7"), "acc-1")

  const leftovers = readdirSync(dir).filter((f) => f !== "teachers.json")
  assert.deepEqual(leftovers, [], "no temp file residue next to teachers.json")
  assert.equal(statSync(storePath).mode & 0o777, 0o600)
  assert.deepEqual(JSON.parse(readFileSync(storePath, "utf8")).t7, { refreshToken: "ref-rotated", userId: 7 })
})

test("store: refresh 失败（401）回落 bind 并轮换", async (t) => {
  const dir = tempDir("bind-fallback")
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const storePath = path.join(dir, "teachers.json")
  seedStore(storePath, { t2: { refreshToken: "ref-dead", userId: 3 } })

  let refreshCalls = 0
  let bindCalls = 0
  const fetchImpl = mockFetch([
    {
      when: (c) => c.url === `${BASE}/api/v1/auth/refresh`,
      then: () => {
        refreshCalls += 1
        return {
          status: 401,
          body: { error: { code: "AUTH_INVALID", message: "Refresh token has been revoked" } },
        }
      },
    },
    {
      when: (c) => c.url === `${BASE}/api/v1/training/bind`,
      then: () => {
        bindCalls += 1
        return { body: authBody({ access_token: "acc-bind", refresh_token: "ref-new", user: { id: 3 } }) }
      },
    },
  ], [])

  const store = new TeacherCredentialStore({ baseUrl: BASE, storePath, fetchImpl, adminToken: "adm-secret" })
  assert.equal(await store.getAccess("t2"), "acc-bind")
  assert.equal(refreshCalls, 1)
  assert.equal(bindCalls, 1)
  assert.deepEqual(JSON.parse(readFileSync(storePath, "utf8")).t2, { refreshToken: "ref-new", userId: 3 })
})

test("store: access 内存缓存提前 60s 过期，重刷新使用轮换后的 refresh token", async (t) => {
  const dir = tempDir("early-expiry")
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const storePath = path.join(dir, "teachers.json")
  seedStore(storePath, { t3: { refreshToken: "ref-1", userId: 1 } })

  let clock = 1_000_000
  let refreshCalls = 0
  const fetchImpl = mockFetch([
    {
      when: (c) => c.url === `${BASE}/api/v1/auth/refresh`,
      then: (c) => {
        refreshCalls += 1
        const used = JSON.parse(c.body ?? "{}") as { refresh_token?: string }
        assert.equal(used.refresh_token, `ref-${refreshCalls}`, "must use the rotated token from disk")
        return {
          body: authBody({
            access_token: `acc-${refreshCalls}`,
            refresh_token: `ref-${refreshCalls + 1}`,
            expires_in: 100,
          }),
        }
      },
    },
  ], [])

  const store = new TeacherCredentialStore({ baseUrl: BASE, storePath, fetchImpl, now: () => clock })
  assert.equal(await store.getAccess("t3"), "acc-1")
  clock += 39_000 // expires_in=100s，提前 60s → 40s 内有效
  assert.equal(await store.getAccess("t3"), "acc-1")
  assert.equal(refreshCalls, 1)
  clock += 2_000 // 41s > 40s → 缓存过期
  assert.equal(await store.getAccess("t3"), "acc-2")
  assert.equal(refreshCalls, 2)
})

// ── src-server 形态：client 请求形状 ──

test("healthSrc: GET /health（无 /api/v1 前缀、无鉴权头），接受 {status:\"ok\"}", async () => {
  const calls: RecordedCall[] = []
  const fetchImpl = mockFetch([
    { when: (c) => c.url === `${BASE}/health`, then: () => ({ body: { status: "ok", timestamp: "2026-08-18T00:00:00Z" } }) },
  ], calls)

  const client = new LlmWikiApiClient({ baseUrl: BASE, fetchImpl })
  const health = await client.healthSrc()

  assert.equal(calls[0]?.url, `${BASE}/health`)
  assert.equal(calls[0]?.method, "GET")
  assert.equal(calls[0]?.headers.Authorization, undefined)
  assert.equal(health.status, "ok")
})

test("llm_wiki_search（src-server 形态）: GET /api/v1/search?project_id&query&limit + Bearer", async () => {
  const calls: RecordedCall[] = []
  const searchBody = {
    mode: "hybrid",
    tokenHits: 2,
    vectorHits: 1,
    results: [
      { path: "wiki/a.md", title: "Attention", snippet: "hit", titleMatch: true, score: 0.42, vectorScore: 0.9, images: [] },
    ],
  }
  const fetchImpl = mockFetch([
    { when: (c) => c.url.startsWith(`${BASE}/api/v1/search`), then: () => ({ body: searchBody }) },
  ], calls)

  const handlers = makeHandlers(fetchImpl)
  const result = await handlers.get("llm_wiki_search")!({ wecom_userid: "t1", query: "attention 机制", limit: 5 })

  const expectedQuery = new URLSearchParams({ project_id: "42", query: "attention 机制", limit: "5" }).toString()
  assert.equal(calls[0]?.url, `${BASE}/api/v1/search?${expectedQuery}`)
  assert.equal(calls[0]?.method, "GET")
  assert.equal(calls[0]?.headers.Authorization, "Bearer acc-tool")
  const text = toolText(result)
  assert.ok(text.includes('# Search results for "attention 机制"'), text)
  assert.ok(text.includes("Attention"), text)
  assert.ok(!text.includes("acc-tool"), "access token must never appear in tool output")
})

test("llm_wiki_read_file（src-server 形态）: GET /api/v1/files/:id/read?path=", async () => {
  const calls: RecordedCall[] = []
  const fetchImpl = mockFetch([
    {
      when: (c) => c.url.startsWith(`${BASE}/api/v1/files/42/read`),
      then: () => ({ body: { path: "wiki/a.md", content: "# Hello", extension: "md" } }),
    },
  ], calls)

  const handlers = makeHandlers(fetchImpl)
  const result = await handlers.get("llm_wiki_read_file")!({ wecom_userid: "t1", path: "wiki/a.md" })

  assert.equal(calls[0]?.url, `${BASE}/api/v1/files/42/read?${new URLSearchParams({ path: "wiki/a.md" })}`)
  assert.equal(calls[0]?.method, "GET")
  assert.equal(calls[0]?.headers.Authorization, "Bearer acc-tool")
  assert.equal(toolText(result), "# wiki/a.md\n\n# Hello")
})

test("工具 401 后失效重试一次（invalidate + 新 token）", async (t) => {
  const dir = tempDir("retry-401")
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const storePath = path.join(dir, "teachers.json")
  seedStore(storePath, { t5: { refreshToken: "ref-1", userId: 1 } })

  let refreshCalls = 0
  const calls: RecordedCall[] = []
  const fetchImpl = mockFetch([
    {
      when: (c) => c.url === `${BASE}/api/v1/auth/refresh`,
      then: () => {
        refreshCalls += 1
        return { body: authBody({ access_token: `acc-${refreshCalls}`, refresh_token: `ref-${refreshCalls + 1}` }) }
      },
    },
    {
      when: (c) => c.url.startsWith(`${BASE}/api/v1/search`),
      then: (c) => c.headers.Authorization === "Bearer acc-1"
        ? { status: 401, body: { error: { code: "AUTH_INVALID", message: "Invalid token" } } }
        : { body: { mode: "keyword", results: [], tokenHits: 0, vectorHits: 0 } },
    },
  ], calls)

  const client = new LlmWikiApiClient({ baseUrl: BASE, fetchImpl })
  const store = new TeacherCredentialStore({ baseUrl: BASE, storePath, fetchImpl })
  const handlers = createSrcServerHandlers({ client, store, getProjectId: () => 42, getPublicTBase: () => BASE })

  const result = await handlers.get("llm_wiki_search")!({ wecom_userid: "t5", query: "q" })
  assert.equal(refreshCalls, 2)
  const searchCalls = calls.filter((c) => c.url.startsWith(`${BASE}/api/v1/search`))
  assert.equal(searchCalls.length, 2)
  assert.equal(searchCalls[1]?.headers.Authorization, "Bearer acc-2")
  assert.ok(toolText(result).includes("No results"), "second attempt must succeed")
})

// ── teacher_tutor 工具透传形状 ──

test("teacher_tutor 工具透传：profile_get/put、record_ask、plan_list、item_complete、plan_link、progress", async () => {
  const calls: RecordedCall[] = []
  const profileBody = {
    wecom_userid: "t1",
    display_name: null,
    subject: "数学",
    grade_levels: [],
    goals: [],
    interests: [],
    onboarding_state: "pending",
  }
  const fetchImpl = mockFetch([
    { when: (c) => c.url === `${BASE}/api/v1/training/profile` && c.method === "GET", then: () => ({ body: profileBody }) },
    { when: (c) => c.url === `${BASE}/api/v1/training/profile` && c.method === "PUT", then: () => ({ body: { ...profileBody, onboarding_state: "surveyed" } }) },
    { when: (c) => c.url === `${BASE}/api/v1/training/events`, then: () => ({ body: { id: 9 } }) },
    { when: (c) => c.url === `${BASE}/api/v1/training/plans?status=active`, then: () => ({ body: [] }) },
    { when: (c) => c.url === `${BASE}/api/v1/training/plans/3/link`, then: () => ({ body: { link: "/s/abcdefghij" } }) },
    { when: (c) => c.url === `${BASE}/api/v1/training/items/12/complete`, then: () => ({ body: { item_id: 12, status: "completed" } }) },
    { when: (c) => c.url === `${BASE}/api/v1/training/progress`, then: () => ({ body: { plans: [], recent_events: [] } }) },
  ], calls)

  const handlers = makeHandlers(fetchImpl)

  const profile = await handlers.get("teacher_tutor_profile_get")!({ wecom_userid: "t1" })
  assert.equal(JSON.parse(toolText(profile)).subject, "数学")

  await handlers.get("teacher_tutor_profile_put")!({
    wecom_userid: "t1",
    subject: "数学",
    grade_levels: ["高一"],
    onboarding_state: "surveyed",
  })
  const put = calls.find((c) => c.method === "PUT")!
  assert.equal(put.url, `${BASE}/api/v1/training/profile`)
  assert.equal(put.headers.Authorization, "Bearer acc-tool")
  assert.deepEqual(JSON.parse(put.body!), { subject: "数学", grade_levels: ["高一"], onboarding_state: "surveyed" })

  const ask = await handlers.get("teacher_tutor_record_ask")!({ wecom_userid: "t1", payload: { question: "如何讲注意力" } })
  assert.deepEqual(JSON.parse(toolText(ask)), { id: 9 })
  const askCall = calls.find((c) => c.url === `${BASE}/api/v1/training/events`)!
  assert.equal(askCall.method, "POST")
  assert.deepEqual(JSON.parse(askCall.body!), { event_type: "ask", payload: { question: "如何讲注意力" } })

  const list = await handlers.get("teacher_tutor_plan_list")!({ wecom_userid: "t1", status: "active" })
  assert.deepEqual(JSON.parse(toolText(list)), [])
  const listCall = calls.find((c) => c.url === `${BASE}/api/v1/training/plans?status=active`)!
  assert.equal(listCall.method, "GET")
  assert.equal(listCall.headers.Authorization, "Bearer acc-tool")

  const complete = await handlers.get("teacher_tutor_item_complete")!({ wecom_userid: "t1", item_id: 12 })
  assert.deepEqual(JSON.parse(toolText(complete)), { item_id: 12, status: "completed" })
  const completeCall = calls.find((c) => c.url === `${BASE}/api/v1/training/items/12/complete`)!
  assert.equal(completeCall.method, "POST")

  const link = await handlers.get("teacher_tutor_plan_link")!({ wecom_userid: "t1", plan_id: 3 })
  assert.equal(JSON.parse(toolText(link)).link, `${BASE}/s/abcdefghij`)
  const linkCall = calls.find((c) => c.url === `${BASE}/api/v1/training/plans/3/link`)!
  assert.equal(linkCall.method, "POST")

  const progress = await handlers.get("teacher_tutor_progress")!({ wecom_userid: "t1" })
  assert.deepEqual(JSON.parse(toolText(progress)), { plans: [], recent_events: [] })
  const progressCall = calls.find((c) => c.url === `${BASE}/api/v1/training/progress`)!
  assert.equal(progressCall.method, "GET")

  for (const c of calls) {
    assert.ok(!c.body?.includes("acc-tool"), "no token in any request body")
  }
})

test("teacher_tutor_plan_create: POST /plans 透传 + 返回含完整 /s/ 短链", async () => {
  const calls: RecordedCall[] = []
  const fetchImpl = mockFetch([
    {
      when: (c) => c.url === `${BASE}/api/v1/training/plans`,
      then: () => ({ body: { plan: { id: 5, title: "第 1 周计划" }, items: [], link: "/s/0123456789" } }),
    },
  ], calls)

  const handlers = makeHandlers(fetchImpl, { tbase: "https://t.example.com/" })
  const result = await handlers.get("teacher_tutor_plan_create")!({
    wecom_userid: "t1",
    title: "第 1 周计划",
    reason: "补基础",
    origin: "chat",
    period_key: "2026-W34",
    items: [{ kind: "wiki_page", target_ref: "wiki/a.md", label: "读 A", timecode_start_s: 0 }],
  })

  const create = calls[0]!
  assert.equal(create.url, `${BASE}/api/v1/training/plans`)
  assert.equal(create.method, "POST")
  assert.equal(create.headers.Authorization, "Bearer acc-tool")
  assert.deepEqual(JSON.parse(create.body!), {
    title: "第 1 周计划",
    reason: "补基础",
    origin: "chat",
    period_key: "2026-W34",
    items: [{ kind: "wiki_page", target_ref: "wiki/a.md", label: "读 A", timecode_start_s: 0 }],
  })

  const payload = JSON.parse(toolText(result))
  assert.equal(payload.link, "https://t.example.com/s/0123456789")
  assert.equal(payload.plan.id, 5)
  assert.ok(!toolText(result).includes("acc-tool"), "access token must never appear in tool output")
})

// ── 评审 #4：plan_link 空 link 守卫 ──

test("teacher_tutor_plan_link: 服务端未回 link 时抛错，不输出裸 base URL", async () => {
  // link 缺失 / null / 空串：响应形状意外时抛清晰错误，绝不 join 成裸 base 死链
  for (const bad of [undefined, null, ""]) {
    const calls: RecordedCall[] = []
    const fetchImpl = mockFetch([
      { when: (c) => c.url === `${BASE}/api/v1/training/plans/7/link`, then: () => ({ body: { plan_id: 7, link: bad } }) },
    ], calls)
    const handlers = makeHandlers(fetchImpl)
    await assert.rejects(
      handlers.get("teacher_tutor_plan_link")!({ wecom_userid: "t1", plan_id: 7 }),
      /returned no link/,
    )
  }
})

test("joinTLink: 尾斜杠归一 + 绝对链接直通", () => {
  assert.equal(joinTLink("https://t.example.com/", "/t/x"), "https://t.example.com/t/x")
  assert.equal(joinTLink("http://127.0.0.1:8080", "/t/y"), "http://127.0.0.1:8080/t/y")
  assert.equal(joinTLink("http://127.0.0.1:8080", "https://abs.example/t/z"), "https://abs.example/t/z")
})

// ── 形态注册过滤 ──

test("src-server 形态：只注册 10 工具，6 个桌面工具不在 ListTools", () => {
  const names = buildTools("src-server").map((tool) => tool.name)
  assert.deepEqual([...names].sort(), [
    "llm_wiki_read_file",
    "llm_wiki_search",
    "teacher_tutor_item_complete",
    "teacher_tutor_plan_create",
    "teacher_tutor_plan_link",
    "teacher_tutor_plan_list",
    "teacher_tutor_profile_get",
    "teacher_tutor_profile_put",
    "teacher_tutor_progress",
    "teacher_tutor_record_ask",
  ].sort())
  for (const desktopOnly of [
    "llm_wiki_status",
    "llm_wiki_projects",
    "llm_wiki_files",
    "llm_wiki_reviews",
    "llm_wiki_graph",
    "llm_wiki_rescan_sources",
  ]) {
    assert.ok(!names.includes(desktopOnly), `${desktopOnly} must not be registered in src-server form`)
  }
})

test("desktop 形态：保持 8 个桌面工具且无 teacher_tutor_*", () => {
  const names = buildTools("desktop").map((tool) => tool.name)
  assert.deepEqual([...names].sort(), [
    "llm_wiki_files",
    "llm_wiki_graph",
    "llm_wiki_projects",
    "llm_wiki_read_file",
    "llm_wiki_rescan_sources",
    "llm_wiki_reviews",
    "llm_wiki_search",
    "llm_wiki_status",
  ].sort())
  assert.ok(names.every((name) => !name.startsWith("teacher_tutor_")))
})

test("src-server 形态缺失 LLM_WIKI_API_BASE_URL → 启动 fail-fast；显式设置/桌面形态不抛", () => {
  assert.throws(
    () => assertSrcServerEnv({ LLM_WIKI_API_FORM: "src-server" }),
    /LLM_WIKI_API_BASE_URL/,
  )
  assert.throws(
    () => assertSrcServerEnv({ LLM_WIKI_API_FORM: "src-server", LLM_WIKI_API_BASE_URL: "   " }),
    /LLM_WIKI_API_BASE_URL/,
  )
  assert.doesNotThrow(() =>
    assertSrcServerEnv({ LLM_WIKI_API_FORM: "src-server", LLM_WIKI_API_BASE_URL: "http://127.0.0.1:8080" }))
  assert.doesNotThrow(() => assertSrcServerEnv({}))
  assert.doesNotThrow(() => assertSrcServerEnv({ LLM_WIKI_API_BASE_URL: undefined }))
})
