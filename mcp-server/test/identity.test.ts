import assert from "node:assert/strict"
import { test } from "node:test"

import { LlmWikiApiClient } from "../src/api-client.js"
import {
  IdentityMismatchError,
  IdentityUnavailableError,
  ToolArgumentError,
  extractRequestMeta,
  resolveIdentity,
  type MetaLike,
} from "../src/identity.js"
import {
  TeacherCredentialStore,
  createSrcServerHandlers,
  srcServerToolDefinitions,
  trainingToolDefinitions,
  type ToolOutput,
} from "../src/training.js"

const BASE = "http://127.0.0.1:8080"

interface RecordedCall {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

function mockFetch(routes: Array<{ when: (c: RecordedCall) => boolean; then: () => { status?: number; body: unknown } }>, calls: RecordedCall[]): typeof fetch {
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
        const { status = 200, body } = route.then()
        return new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        })
      }
    }
    throw new Error(`unexpected fetch: ${call.method} ${call.url}`)
  }) as typeof fetch
}

const META_WECOM_T1: MetaLike = {
  hermes_platform: "wecom",
  hermes_user_id: "T1",
  hermes_user_name: "张老师",
  hermes_chat_id: "wrRoom1",
  hermes_session_key: "wecom:T1",
  hermes_profile: "lt-tutor",
}

// ── 判定矩阵（brief Step 1 ①-⑦）──

test("① meta{wecom,T1} + 无 args → user 模式（身份取 meta）", () => {
  assert.deepEqual(resolveIdentity(META_WECOM_T1, undefined), { mode: "user", wecomUserid: "T1" })
})

test("② 同 meta + args 'T1' → user 模式（一致通过）", () => {
  assert.deepEqual(resolveIdentity(META_WECOM_T1, "T1"), { mode: "user", wecomUserid: "T1" })
})

test("③ 同 meta + args 'T2' → IdentityMismatch（硬拒不降级）", () => {
  assert.throws(() => resolveIdentity(META_WECOM_T1, "T2"), IdentityMismatchError)
})

test("④ meta{platform:'wecom'}（无 user_id）+ 任意 args → IdentityUnavailable（fail-closed，不落系统模式）", () => {
  assert.throws(() => resolveIdentity({ hermes_platform: "wecom" }, undefined), IdentityUnavailableError)
  assert.throws(() => resolveIdentity({ hermes_platform: "wecom" }, "T1"), IdentityUnavailableError)
  assert.throws(() => resolveIdentity({ hermes_platform: "wecom" }, "T2"), IdentityUnavailableError)
  // user_id 空串 / 非字符串同属不可用（meta 形状可变，以 hermes_user_id 存在性为准）
  assert.throws(() => resolveIdentity({ hermes_platform: "wecom", hermes_user_id: "" }, "T1"), IdentityUnavailableError)
  assert.throws(() => resolveIdentity({ hermes_platform: "wecom", hermes_user_id: 123 }, "T1"), IdentityUnavailableError)
})

test("⑤ meta 空 + args 'T1' → system 模式", () => {
  assert.deepEqual(resolveIdentity(undefined, "T1"), { mode: "system", wecomUserid: "T1" })
  assert.deepEqual(resolveIdentity({}, "T1"), { mode: "system", wecomUserid: "T1" })
})

test("⑥ meta 空 + 无 args → ToolArgumentError（system 必须显式 wecom_userid）", () => {
  assert.throws(
    () => resolveIdentity(undefined, undefined),
    (err: unknown) => err instanceof ToolArgumentError && err.message === "wecom_userid is required for system calls",
  )
})

test("⑦ meta{platform:'cli'} + args → system 模式", () => {
  assert.deepEqual(
    resolveIdentity({ hermes_platform: "cli", hermes_user_id: "cli-op" }, "T1"),
    { mode: "system", wecomUserid: "T1" },
  )
})

test("边界：args 空白串视为省略；meta user_id 去空白；platform 去空白", () => {
  assert.deepEqual(resolveIdentity(META_WECOM_T1, "  "), { mode: "user", wecomUserid: "T1" })
  assert.deepEqual(
    resolveIdentity({ hermes_platform: " wecom ", hermes_user_id: " T1 " }, undefined),
    { mode: "user", wecomUserid: "T1" },
  )
  assert.deepEqual(resolveIdentity(undefined, "  T1  "), { mode: "system", wecomUserid: "T1" })
})

test("对抗补遗（评审 S4）：纯空格 user_id 是 truthy 假象——归一后按不可用硬拒，不落系统模式", () => {
  // T1 的 truthiness 过滤不会省略 "  "（truthy），它会原样进入 _meta——
  // 归一侧必须把它当"身份缺失"走 ②，而不是意外落 ③ 系统模式
  assert.throws(
    () => resolveIdentity({ hermes_platform: "wecom", hermes_user_id: "  " }, "T1"),
    IdentityUnavailableError,
  )
})

test("对抗补遗（评审 S2/S4）：platform 大小写漂移归一后仍落用户模式（fail-closed 方向）", () => {
  assert.deepEqual(
    resolveIdentity({ hermes_platform: "WECOM", hermes_user_id: "T1" }, undefined),
    { mode: "user", wecomUserid: "T1" },
  )
  assert.deepEqual(
    resolveIdentity({ hermes_platform: " WeCom ", hermes_user_id: "T1" }, undefined),
    { mode: "user", wecomUserid: "T1" },
  )
  // 大小写漂移 + args 不符 → 仍是 IdentityMismatch 硬拒（不得因漂移静默放行到系统模式）
  assert.throws(
    () => resolveIdentity({ hermes_platform: "WECOM", hermes_user_id: "T1" }, "T2"),
    IdentityMismatchError,
  )
})

test("对抗补遗（评审 S4）：platform 非字符串（如数字）归一为空 → 系统模式须显式 wecom_userid", () => {
  assert.deepEqual(
    resolveIdentity({ hermes_platform: 123, hermes_user_id: "T1" }, "T1"),
    { mode: "system", wecomUserid: "T1" },
  )
  assert.throws(
    () => resolveIdentity({ hermes_platform: 123, hermes_user_id: "T1" }, undefined),
    ToolArgumentError,
  )
})

test("extractRequestMeta：对象直通，非对象/数组归 undefined", () => {
  assert.deepEqual(extractRequestMeta({ hermes_platform: "wecom" }), { hermes_platform: "wecom" })
  assert.equal(extractRequestMeta(undefined), undefined)
  assert.equal(extractRequestMeta(null), undefined)
  assert.equal(extractRequestMeta("wecom"), undefined)
  assert.equal(extractRequestMeta([{ hermes_platform: "wecom" }]), undefined)
})

// ── 集成位：training 工具三态（user 通畅 / mismatch 拒 / wecom-空-身份拒）──

/** 记录 getAccess 收到的 userid（凭证层身份）的 stub store。 */
function recordingStore(seen: string[]): TeacherCredentialStore {
  return {
    getAccess: async (userid: string) => {
      seen.push(userid)
      return "acc-tool"
    },
    invalidate: () => {},
  } as unknown as TeacherCredentialStore
}

function identityHandlers(fetchImpl: typeof fetch, seenUserids: string[]) {
  return createSrcServerHandlers({
    client: new LlmWikiApiClient({ baseUrl: BASE, fetchImpl }),
    store: recordingStore(seenUserids),
    getProjectId: () => 42,
    getPublicTBase: () => BASE,
  })
}

function identityBlocks(result: ToolOutput): string[] {
  return result.content.map((block) => block.text)
}

test("集成·user 通畅：teacher_tutor_progress 省略 wecom_userid + wecom meta → 凭证层用 meta 身份 + identity_source:'user'", async () => {
  const calls: RecordedCall[] = []
  const fetchImpl = mockFetch([
    { when: (c) => c.url === `${BASE}/api/v1/training/progress`, then: () => ({ body: { plans: [], recent_events: [] } }) },
  ], calls)
  const seen: string[] = []
  const handlers = identityHandlers(fetchImpl, seen)

  const result = await handlers.get("teacher_tutor_progress")!({}, META_WECOM_T1)

  assert.deepEqual(seen, ["T1"], "credential store must receive the session identity")
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.headers.Authorization, "Bearer acc-tool")
  assert.deepEqual(JSON.parse(result.content[0]!.text), { plans: [], recent_events: [] })
  assert.deepEqual(identityBlocks(result).slice(1), ['identity_source: "user"'], "trailing identity_source block")
})

test("集成·user 一致通过：llm_wiki_search 显式等值 wecom_userid → 正常执行 + identity_source:'user'", async () => {
  const calls: RecordedCall[] = []
  const fetchImpl = mockFetch([
    { when: (c) => c.url.startsWith(`${BASE}/api/v1/search`), then: () => ({ body: { mode: "keyword", results: [], tokenHits: 0, vectorHits: 0 } }) },
  ], calls)
  const seen: string[] = []
  const handlers = identityHandlers(fetchImpl, seen)

  const result = await handlers.get("llm_wiki_search")!({ wecom_userid: "T1", query: "q" }, META_WECOM_T1)

  assert.deepEqual(seen, ["T1"])
  assert.equal(calls.length, 1)
  assert.deepEqual(identityBlocks(result).slice(1), ['identity_source: "user"'])
})

test("集成·mismatch 硬拒：teacher_tutor_progress args 'T2' vs meta 'T1' → IdentityMismatch + 零请求", async () => {
  const calls: RecordedCall[] = []
  const fetchImpl = mockFetch([], calls)
  const seen: string[] = []
  const handlers = identityHandlers(fetchImpl, seen)

  await assert.rejects(
    handlers.get("teacher_tutor_progress")!({ wecom_userid: "T2" }, META_WECOM_T1),
    (err: unknown) => err instanceof IdentityMismatchError,
  )
  assert.deepEqual(calls, [], "no HTTP request may be made on identity mismatch")
  assert.deepEqual(seen, [], "no credential may be requested on identity mismatch")
})

test("集成·wecom-空-身份硬拒：teacher_tutor_plan_create 任意 args → IdentityUnavailable + 零请求", async () => {
  const calls: RecordedCall[] = []
  const fetchImpl = mockFetch([], calls)
  const seen: string[] = []
  const handlers = identityHandlers(fetchImpl, seen)

  await assert.rejects(
    handlers.get("teacher_tutor_plan_create")!({ title: "t", origin: "chat", items: [] }, { hermes_platform: "wecom" }),
    (err: unknown) => err instanceof IdentityUnavailableError,
  )
  assert.deepEqual(calls, [], "no HTTP request may be made when identity unavailable")
  assert.deepEqual(seen, [], "no credential may be requested when identity unavailable")
})

test("集成·system 模式：teacher_tutor_progress 无 meta + 显式 wecom_userid → identity_source:'system'", async () => {
  const calls: RecordedCall[] = []
  const fetchImpl = mockFetch([
    { when: (c) => c.url === `${BASE}/api/v1/training/progress`, then: () => ({ body: { plans: [], recent_events: [] } }) },
  ], calls)
  const seen: string[] = []
  const handlers = identityHandlers(fetchImpl, seen)

  const result = await handlers.get("teacher_tutor_progress")!({ wecom_userid: "cron-teacher" }, undefined)

  assert.deepEqual(seen, ["cron-teacher"])
  assert.deepEqual(identityBlocks(result).slice(1), ['identity_source: "system"'])
})

test("集成·system 模式缺 wecom_userid：无 meta 且省略 → ToolArgumentError + 零请求", async () => {
  const calls: RecordedCall[] = []
  const fetchImpl = mockFetch([], calls)
  const seen: string[] = []
  const handlers = identityHandlers(fetchImpl, seen)

  await assert.rejects(
    handlers.get("teacher_tutor_profile_get")!({}, undefined),
    (err: unknown) => err instanceof ToolArgumentError && err.message === "wecom_userid is required for system calls",
  )
  assert.deepEqual(calls, [])
  assert.deepEqual(seen, [])
})

// ── schema：10 工具不暴露 wecom_userid（2026-08-24 事故加固，运行时仍接受）──

test("schema：全部 10 个 src-server 工具不暴露 wecom_userid，其余 required 保留", () => {
  const tools = [...srcServerToolDefinitions(), ...trainingToolDefinitions()]
  assert.equal(tools.length, 10)
  for (const tool of tools) {
    assert.equal(
      "wecom_userid" in (tool.inputSchema.properties ?? {}),
      false,
      `${tool.name}: wecom_userid must NOT be exposed in inputSchema (weak-fallback models copy example values into it; identity lock refusals then trip client breakers)`,
    )
  }
  // 其余必填位不受牵连
  const search = tools.find((t) => t.name === "llm_wiki_search")!
  assert.deepEqual(search.inputSchema.required, ["query"])
  const readFile = tools.find((t) => t.name === "llm_wiki_read_file")!
  assert.deepEqual(readFile.inputSchema.required, ["path"])
  const planCreate = tools.find((t) => t.name === "teacher_tutor_plan_create")!
  assert.deepEqual(planCreate.inputSchema.required, ["title", "origin", "items"])
  const itemComplete = tools.find((t) => t.name === "teacher_tutor_item_complete")!
  assert.deepEqual(itemComplete.inputSchema.required, ["item_id"])
  const planLink = tools.find((t) => t.name === "teacher_tutor_plan_link")!
  assert.deepEqual(planLink.inputSchema.required, ["plan_id"])
})

// ── _meta 链路（T1 → MCP SDK → 低层 setRequestHandler handler）──

test("链路：client callTool _meta 经 SDK 真实管线到达 handler 的 request.params._meta（hermes_* 键不被剥离）", async () => {
  const { Server } = await import("@modelcontextprotocol/sdk/server/index.js")
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js")
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js")
  const { CallToolRequestSchema } = await import("@modelcontextprotocol/sdk/types.js")

  let seenMeta: MetaLike | undefined
  const server = new Server({ name: "identity-link-test", version: "0.0.0" }, { capabilities: { tools: {} } })
  // 与 index.ts 相同的取法：低层 setRequestHandler 的 request.params._meta 直接可取
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    seenMeta = extractRequestMeta(request.params._meta)
    return { content: [{ type: "text" as const, text: "ok" }] }
  })

  const client = new Client({ name: "identity-link-client", version: "0.0.0" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])

  await client.callTool({
    name: "teacher_tutor_progress",
    arguments: {},
    _meta: {
      hermes_platform: "wecom",
      hermes_user_id: "T1",
      hermes_user_name: "张老师",
      hermes_session_key: "wecom:T1",
    },
  } as never)

  assert.equal(seenMeta?.hermes_platform, "wecom")
  assert.equal(seenMeta?.hermes_user_id, "T1")
  // 形状可变（空值键省略）：只带 platform 的最小 meta 同样透传
  await client.callTool({ name: "teacher_tutor_progress", arguments: {}, _meta: { hermes_platform: "wecom" } } as never)
  assert.equal(seenMeta?.hermes_user_id, undefined, "omitted keys stay omitted (no fixed key set assumed)")
  await client.close()
  await server.close()
})
