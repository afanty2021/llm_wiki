import assert from "node:assert/strict"
import { test } from "node:test"

import { LlmWikiApiClient } from "../src/api-client.js"
import {
  IdentityMismatchError,
  IdentityUnavailableError,
  ToolArgumentError,
  extractRequestMeta,
  hasWecomSessionIdentity,
  resolveIdentity,
  resolveIdentityWithSupervision,
  sessionWecomUserid,
  type MetaLike,
} from "../src/identity.js"
import {
  SUPERVISION_TOOLS,
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

// ── T2 主管越权门：resolveIdentityWithSupervision 纯判定（identity.ts 保持零 IO，
//    白名单常量在 training.ts 分发层——这里以 SUPERVISION_TOOLS 成员名作输入，
//    只验纯函数语义，不验白名单本身）──

test("supervisor·冲突+admin → 目标身份 + identitySource:'supervisor'", () => {
  assert.deepEqual(
    resolveIdentityWithSupervision(META_WECOM_T1, "T2", { toolName: "teacher_tutor_plan_create", isCallerAdmin: true }),
    { mode: "user", wecomUserid: "T2", identitySource: "supervisor" },
  )
})

test("supervisor·冲突+非 admin → IdentityMismatch（非 admin 语义文案，照拒不降级）", () => {
  assert.throws(
    () => resolveIdentityWithSupervision(META_WECOM_T1, "T2", { toolName: "teacher_tutor_plan_list", isCallerAdmin: false }),
    (err: unknown) =>
      err instanceof IdentityMismatchError
      && /requires an admin\/owner session/.test(err.message)
      && /teacher_tutor_plan_list/.test(err.message),
  )
})

test("supervisor·args 空白/等于会话 → 现行为（返回会话身份，无 identitySource 标记）", () => {
  assert.deepEqual(
    resolveIdentityWithSupervision(META_WECOM_T1, undefined, { toolName: "teacher_tutor_plan_create", isCallerAdmin: true }),
    { mode: "user", wecomUserid: "T1" },
  )
  assert.deepEqual(
    resolveIdentityWithSupervision(META_WECOM_T1, "  ", { toolName: "teacher_tutor_plan_create", isCallerAdmin: true }),
    { mode: "user", wecomUserid: "T1" },
  )
  assert.deepEqual(
    resolveIdentityWithSupervision(META_WECOM_T1, "T1", { toolName: "teacher_tutor_plan_create", isCallerAdmin: true }),
    { mode: "user", wecomUserid: "T1" },
  )
})

test("supervisor·系统模式 → 现行为（显式 wecom_userid 直通；缺参 ToolArgumentError 不受 admin 标志影响）", () => {
  assert.deepEqual(
    resolveIdentityWithSupervision(undefined, "T1", { toolName: "teacher_tutor_plan_create", isCallerAdmin: false }),
    { mode: "system", wecomUserid: "T1" },
  )
  assert.throws(
    () => resolveIdentityWithSupervision(undefined, undefined, { toolName: "teacher_tutor_plan_create", isCallerAdmin: true }),
    ToolArgumentError,
  )
})

test("supervisor·wecom 会话身份缺失 → IdentityUnavailable 照旧透传（admin 标志不救，fail-closed）", () => {
  assert.throws(
    () => resolveIdentityWithSupervision({ hermes_platform: "wecom" }, "T2", { toolName: "teacher_tutor_plan_create", isCallerAdmin: true }),
    IdentityUnavailableError,
  )
})

test("supervisor·闸辅助谓词：hasWecomSessionIdentity / sessionWecomUserid 归一与 resolveIdentity 同源", () => {
  assert.equal(hasWecomSessionIdentity(META_WECOM_T1), true)
  assert.equal(sessionWecomUserid(META_WECOM_T1), "T1")
  assert.equal(hasWecomSessionIdentity({ hermes_platform: "wecom" }), false, "wecom 但无身份 → 闸不适用（落 IdentityUnavailable）")
  assert.equal(hasWecomSessionIdentity({ hermes_platform: " WECOM ", hermes_user_id: " T1 " }), true, "platform/身份归一")
  assert.equal(hasWecomSessionIdentity(undefined), false)
  assert.equal(sessionWecomUserid(undefined), "")
})

test("extractRequestMeta：对象直通，非对象/数组归 undefined", () => {
  assert.deepEqual(extractRequestMeta({ hermes_platform: "wecom" }), { hermes_platform: "wecom" })
  assert.equal(extractRequestMeta(undefined), undefined)
  assert.equal(extractRequestMeta(null), undefined)
  assert.equal(extractRequestMeta("wecom"), undefined)
  assert.equal(extractRequestMeta([{ hermes_platform: "wecom" }]), undefined)
})

// ── 集成位：training 工具三态（user 通畅 / mismatch 拒 / wecom-空-身份拒）──

/** 记录 getAccess 收到的 userid（凭证层身份）的 stub store（含主管门 admin token 出口）。 */
function recordingStore(seen: string[]): TeacherCredentialStore {
  return {
    getAccess: async (userid: string) => {
      seen.push(userid)
      return "acc-tool"
    },
    invalidate: () => {},
    getAdminToken: () => "adm-secret",
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

// ── 集成：T2 主管越权门分发层（member-role 查询注入，计划 §2.1/§2.2）──

const MEMBER_ROLE_URL_T1 = `${BASE}/api/v1/training/member-role?${new URLSearchParams({ wecom_userid: "T1" })}`

test("集成·主管 override 放行：admin 会话 plan_list 带 T2 → member-role 后放行，凭证层用 T2 + identity_source:'supervisor'", async () => {
  const calls: RecordedCall[] = []
  const fetchImpl = mockFetch([
    { when: (c) => c.url === MEMBER_ROLE_URL_T1, then: () => ({ body: { role: "admin" } }) },
    { when: (c) => c.url === `${BASE}/api/v1/training/plans`, then: () => ({ body: [{ id: 1, status: "active" }] }) },
  ], calls)
  const seen: string[] = []
  const handlers = identityHandlers(fetchImpl, seen)

  const result = await handlers.get("teacher_tutor_plan_list")!({ wecom_userid: "T2" }, META_WECOM_T1)

  const roleCall = calls.find((c) => c.url === MEMBER_ROLE_URL_T1)!
  assert.ok(roleCall, "member-role must be queried on identity conflict")
  assert.equal(roleCall.method, "GET")
  assert.equal(roleCall.headers["x-training-admin-token"], "adm-secret", "member-role uses x-training-admin-token (同 bind/overview)")
  assert.equal(roleCall.headers.Authorization, undefined, "member-role 不带教师 Bearer")
  assert.deepEqual(seen, ["T2"], "credential store must receive the target teacher id")
  assert.ok(calls.some((c) => c.url === `${BASE}/api/v1/training/plans`), "放行后触达 plans（api-client 放行到端点）")
  assert.deepEqual(identityBlocks(result).slice(1), ['identity_source: "supervisor"'], "主管调用尾块如实标 supervisor")
})

test("集成·owner 视同 admin：role=owner → override 放行（controller Ruling 与 role_meets Admin 级对齐）", async () => {
  const calls: RecordedCall[] = []
  const fetchImpl = mockFetch([
    { when: (c) => c.url === MEMBER_ROLE_URL_T1, then: () => ({ body: { role: "owner" } }) },
    { when: (c) => c.url === `${BASE}/api/v1/training/plans`, then: () => ({ body: [] }) },
  ], calls)
  const seen: string[] = []
  const handlers = identityHandlers(fetchImpl, seen)

  await handlers.get("teacher_tutor_plan_list")!({ wecom_userid: "T2" }, META_WECOM_T1)
  assert.deepEqual(seen, ["T2"])
  assert.ok(calls.some((c) => c.url === `${BASE}/api/v1/training/plans`))
})

test("集成·必补① 非 admin 传他人 userid 照拒：member 会话 plan_list 带 T2 → IdentityMismatch（非 admin 语义）+ 不触达 plans/凭证", async () => {
  const calls: RecordedCall[] = []
  const fetchImpl = mockFetch([
    { when: (c) => c.url === MEMBER_ROLE_URL_T1, then: () => ({ body: { role: "member" } }) },
  ], calls)
  const seen: string[] = []
  const handlers = identityHandlers(fetchImpl, seen)

  await assert.rejects(
    handlers.get("teacher_tutor_plan_list")!({ wecom_userid: "T2" }, META_WECOM_T1),
    (err: unknown) =>
      err instanceof IdentityMismatchError
      && /requires an admin\/owner session/.test(err.message)
      && !/temporarily unavailable/.test(err.message),
  )
  assert.ok(calls.some((c) => c.url === MEMBER_ROLE_URL_T1), "role 查询发生了")
  assert.equal(calls.some((c) => c.url === `${BASE}/api/v1/training/plans`), false, "拒绝后不得触达 plans")
  assert.deepEqual(seen, [], "拒绝后不得取凭证")
})

test("集成·必补② role 查询失败照拒（文案区分）：member-role 500 → IdentityMismatch（unavailable 语义，区别于普通 mismatch）", async () => {
  const calls: RecordedCall[] = []
  const fetchImpl = mockFetch([
    { when: (c) => c.url === MEMBER_ROLE_URL_T1, then: () => ({ status: 500, body: { error: { code: "INTERNAL", message: "boom" } } }) },
  ], calls)
  const seen: string[] = []
  const handlers = identityHandlers(fetchImpl, seen)

  await assert.rejects(
    handlers.get("teacher_tutor_plan_list")!({ wecom_userid: "T2" }, META_WECOM_T1),
    (err: unknown) =>
      err instanceof IdentityMismatchError
      && /temporarily unavailable/.test(err.message)
      && !/requires an admin\/owner session/.test(err.message),
  )
  assert.equal(calls.some((c) => c.url === `${BASE}/api/v1/training/plans`), false)
  assert.deepEqual(seen, [])
})

test("集成·member-role 404（会话者非本 team 成员）→ 非 admin 臂照拒，文案走「非 admin」语义（复审 Minor-2）", async () => {
  const calls: RecordedCall[] = []
  const fetchImpl = mockFetch([
    { when: (c) => c.url === MEMBER_ROLE_URL_T1, then: () => ({ status: 404, body: { error: { code: "NOT_FOUND", message: "Member not found" } } }) },
  ], calls)
  const seen: string[] = []
  const handlers = identityHandlers(fetchImpl, seen)

  await assert.rejects(
    handlers.get("teacher_tutor_plan_create")!({ wecom_userid: "T2", title: "t", origin: "chat", items: [] }, META_WECOM_T1),
    (err: unknown) =>
      err instanceof IdentityMismatchError
      && /requires an admin\/owner session/.test(err.message)
      && !/temporarily unavailable/.test(err.message),
  )
  assert.ok(calls.some((c) => c.url === MEMBER_ROLE_URL_T1))
  assert.equal(calls.some((c) => c.url === `${BASE}/api/v1/training/plans`), false)
  assert.deepEqual(seen, [])
})

test("集成·决策② 仅 mismatch 才查：白名单工具本人调用（无冲突）→ member-role 零调用", async () => {
  const calls: RecordedCall[] = []
  const fetchImpl = mockFetch([
    { when: (c) => c.url === `${BASE}/api/v1/training/plans`, then: () => ({ body: [] }) },
  ], calls)
  const seen: string[] = []
  const handlers = identityHandlers(fetchImpl, seen)

  await handlers.get("teacher_tutor_plan_list")!({}, META_WECOM_T1)
  assert.equal(calls.some((c) => c.url.includes("member-role")), false, "正常教师流量零额外延迟（不查角色）")
  assert.deepEqual(seen, ["T1"])
})

// ── 集成：plan_create 主管 override 目标预查（终审 Rec-2 合并后跟进）──
// plan_create 是唯一带 bind 写副作用的白名单工具：猜错的 userid 会被服务端自动
// 建脏档案（G7 残面）。override 路径建计划前先查目标 member-role，404 即拒；
// user/system 路径零额外往返。

const MEMBER_ROLE_URL_T2 = `${BASE}/api/v1/training/member-role?${new URLSearchParams({ wecom_userid: "T2" })}`

const PLAN_CREATE_ARGS = {
  wecom_userid: "T2",
  title: "听力任务",
  origin: "supervisor",
  items: [{ kind: "media", target_ref: "m1", label: "L1" }],
}

test("集成·目标预查·404 拒：admin 会话 plan_create 带不在册 T2 → 正常文本拒（isError=false）+ 不触达 plans/凭证", async () => {
  const calls: RecordedCall[] = []
  const fetchImpl = mockFetch([
    { when: (c) => c.url === MEMBER_ROLE_URL_T1, then: () => ({ body: { role: "admin" } }) },
    { when: (c) => c.url === MEMBER_ROLE_URL_T2, then: () => ({ status: 404, body: { error: { code: "NOT_FOUND", message: "Member not found" } } }) },
  ], calls)
  const seen: string[] = []
  const handlers = identityHandlers(fetchImpl, seen)

  const result = await handlers.get("teacher_tutor_plan_create")!({ ...PLAN_CREATE_ARGS }, META_WECOM_T1)

  const text = result.content[0]!.text
  assert.ok(text.includes("不在名册"), "拒绝文案点名不在名册")
  assert.ok(text.includes("roster_search"), "文案引导回 roster_search 核实")
  assert.ok(text.includes("T2"), "文案回显目标 userid 供模型自纠")
  assert.equal(calls.some((c) => c.url === `${BASE}/api/v1/training/plans`), false, "拒绝后不得触达 plans")
  assert.deepEqual(seen, [], "拒绝后不得取凭证")
  const targetCall = calls.find((c) => c.url === MEMBER_ROLE_URL_T2)!
  assert.ok(targetCall, "目标 member-role 查询发生了")
  assert.equal(targetCall.headers["x-training-admin-token"], "adm-secret")
  assert.deepEqual(identityBlocks(result).slice(1), ['identity_source: "supervisor"'], "尾块如实标 supervisor")
})

test("集成·目标预查·在册放行：目标 member-role 200（普通 member 即可）→ plans 正常建", async () => {
  const calls: RecordedCall[] = []
  const fetchImpl = mockFetch([
    { when: (c) => c.url === MEMBER_ROLE_URL_T1, then: () => ({ body: { role: "admin" } }) },
    { when: (c) => c.url === MEMBER_ROLE_URL_T2, then: () => ({ body: { role: "member" } }) },
    { when: (c) => c.url === `${BASE}/api/v1/training/plans`, then: () => ({ body: { plan: { id: 9 }, items: [], link: "/s/abcdefghij" } }) },
  ], calls)
  const seen: string[] = []
  const handlers = identityHandlers(fetchImpl, seen)

  const result = await handlers.get("teacher_tutor_plan_create")!({ ...PLAN_CREATE_ARGS }, META_WECOM_T1)
  assert.ok(calls.some((c) => c.url === `${BASE}/api/v1/training/plans`))
  assert.equal(JSON.parse(result.content[0]!.text).plan.id, 9)
  assert.deepEqual(seen, ["T2"], "凭证层用目标身份")
})

test("集成·目标预查·查询失败 fail-closed：目标 member-role 500 → unavailable 臂抛错 + 不触达 plans", async () => {
  const calls: RecordedCall[] = []
  const fetchImpl = mockFetch([
    { when: (c) => c.url === MEMBER_ROLE_URL_T1, then: () => ({ body: { role: "admin" } }) },
    { when: (c) => c.url === MEMBER_ROLE_URL_T2, then: () => ({ status: 500, body: { error: { code: "INTERNAL", message: "boom" } } }) },
  ], calls)
  const seen: string[] = []
  const handlers = identityHandlers(fetchImpl, seen)

  await assert.rejects(
    handlers.get("teacher_tutor_plan_create")!({ ...PLAN_CREATE_ARGS }, META_WECOM_T1),
    (err: unknown) =>
      err instanceof IdentityMismatchError && /temporarily unavailable/.test(err.message),
  )
  assert.equal(calls.some((c) => c.url === `${BASE}/api/v1/training/plans`), false)
  assert.deepEqual(seen, [])
})

test("集成·目标预查仅 supervisor 路径：教师本人自建（无冲突）与 system 回合均零 member-role 往返", async () => {
  const calls: RecordedCall[] = []
  const fetchImpl = mockFetch([
    { when: (c) => c.url === `${BASE}/api/v1/training/plans`, then: () => ({ body: { plan: { id: 1 }, items: [] } }) },
  ], calls)
  const seen: string[] = []
  const handlers = identityHandlers(fetchImpl, seen)

  await handlers.get("teacher_tutor_plan_create")!({ title: "t", origin: "chat", items: [] }, META_WECOM_T1)
  await handlers.get("teacher_tutor_plan_create")!({ wecom_userid: "cron-teacher", title: "t", origin: "cron", items: [] }, undefined)
  assert.equal(calls.some((c) => c.url.includes("member-role")), false, "user/system 路径零额外往返")
  assert.deepEqual(seen, ["T1", "cron-teacher"])
})

test("集成·roster_search admin 闸·非 admin 拒：member 会话 → IdentityMismatch + 不触达 roster", async () => {
  const calls: RecordedCall[] = []
  const fetchImpl = mockFetch([
    { when: (c) => c.url === MEMBER_ROLE_URL_T1, then: () => ({ body: { role: "member" } }) },
  ], calls)
  const seen: string[] = []
  const handlers = identityHandlers(fetchImpl, seen)

  await assert.rejects(
    handlers.get("teacher_tutor_roster_search")!({ q: "张" }, META_WECOM_T1),
    (err: unknown) =>
      err instanceof IdentityMismatchError
      && /admin-gated/.test(err.message)
      && !/temporarily unavailable/.test(err.message),
  )
  assert.ok(calls.some((c) => c.url === MEMBER_ROLE_URL_T1), "工具级闸一律先查角色（不受决策②约束）")
  assert.equal(calls.some((c) => c.url.includes("/api/v1/training/roster")), false)
  assert.deepEqual(seen, [])
})

test("集成·roster_search admin 闸·admin 过：→ roster 透传 + identity_source:'user'", async () => {
  const roster = [{ wecom_userid: "t9", display_name: "钱老师" }]
  const calls: RecordedCall[] = []
  const fetchImpl = mockFetch([
    { when: (c) => c.url === MEMBER_ROLE_URL_T1, then: () => ({ body: { role: "admin" } }) },
    { when: (c) => c.url === `${BASE}/api/v1/training/roster?${new URLSearchParams({ q: "钱" })}`, then: () => ({ body: roster }) },
  ], calls)
  const seen: string[] = []
  const handlers = identityHandlers(fetchImpl, seen)

  const result = await handlers.get("teacher_tutor_roster_search")!({ q: "钱" }, META_WECOM_T1)
  const rosterCall = calls.find((c) => c.url.includes("/api/v1/training/roster"))!
  assert.equal(rosterCall.headers["x-training-admin-token"], "adm-secret")
  assert.deepEqual(JSON.parse(result.content[0]!.text), roster, "名册两键原样透传")
  assert.deepEqual(identityBlocks(result).slice(1), ['identity_source: "user"'])
})

test("集成·roster_search 核验不可用 → unavailable 臂照拒（文案区分）+ 不触达 roster", async () => {
  const calls: RecordedCall[] = []
  const fetchImpl = mockFetch([
    { when: (c) => c.url === MEMBER_ROLE_URL_T1, then: () => ({ status: 503, body: { error: { code: "UNAVAILABLE", message: "down" } } }) },
  ], calls)
  const seen: string[] = []
  const handlers = identityHandlers(fetchImpl, seen)

  await assert.rejects(
    handlers.get("teacher_tutor_roster_search")!({ q: "张" }, META_WECOM_T1),
    (err: unknown) =>
      err instanceof IdentityMismatchError
      && /temporarily unavailable/.test(err.message),
  )
  assert.equal(calls.some((c) => c.url.includes("/api/v1/training/roster")), false)
  assert.deepEqual(seen, [])
})

test("集成·SUPERVISION_TOOLS 白名单钉桩（决策③：常量在分发层）：恰好三工具、record_ask/search 等不在列", () => {
  assert.deepEqual([...SUPERVISION_TOOLS], [
    "teacher_tutor_plan_create",
    "teacher_tutor_plan_list",
    "teacher_tutor_video_search",
  ])
})

// ── schema：wecom_userid 可选声明（2026-09-05 修订 2026-08-24 加固）──
// 旧设计（schema 完全隐藏 + prompt 指示 cron 回合传未声明参数）在 glm-5.3-flash
// 上失效：模型严格遵循 schema，不 emit 未声明字段 → cron 系统回合全链 -32602
// （周报任务 ca270c3a5a58 2026-09-05 实锺）。新契约：可选声明（系统/cron 通道
// 显式化）；用户会话防冒名不变——identity 锁对不匹配参数照常硬拒。

test("schema：16 个 src-server 工具——14 个可选声明 wecom_userid；两个 T2 检索工具不声明（brief §4：无身份参数，supervisor 路径天然不触发）", () => {
  const tools = [...srcServerToolDefinitions(), ...trainingToolDefinitions()]
  assert.equal(tools.length, 16)
  const newSearchTools = ["teacher_tutor_video_search", "teacher_tutor_roster_search"]
  const declaringTools = tools.filter((tool) => !newSearchTools.includes(tool.name))
  assert.equal(declaringTools.length, 14)
  for (const tool of declaringTools) {
    const props = (tool.inputSchema.properties ?? {}) as Record<string, unknown>
    assert.ok(
      typeof props.wecom_userid === "object" && props.wecom_userid !== null,
      `${tool.name}: wecom_userid must be declared (cron system turns pass it explicitly)`,
    )
    assert.equal(
      (tool.inputSchema.required ?? []).includes("wecom_userid"),
      false,
      `${tool.name}: wecom_userid must stay optional (wecom user sessions never pass it; identity comes from _meta)`,
    )
  }
  // 两个新检索工具：q 必填非空白、limit 可选、不声明 wecom_userid（系统/cron 回合
  // 本就不该用它们——主管找片/点名是交互会话流量）
  for (const name of newSearchTools) {
    const tool = tools.find((t) => t.name === name)!
    assert.ok(tool, `${name} must be defined`)
    const props = tool.inputSchema.properties as Record<string, unknown>
    assert.equal(props.wecom_userid, undefined, `${name}: 不声明 wecom_userid`)
    assert.deepEqual(tool.inputSchema.required, ["q"])
    assert.ok(typeof props.limit === "object", `${name}: limit 可选声明`)
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
  const listeningAudio = tools.find((t) => t.name === "teacher_tutor_listening_audio")!
  assert.deepEqual(listeningAudio.inputSchema.required, ["dialogue"])
  const mindmap = tools.find((t) => t.name === "teacher_tutor_mindmap")!
  assert.deepEqual(mindmap.inputSchema.required, ["title", "root"])
  const worksheet = tools.find((t) => t.name === "teacher_tutor_worksheet")!
  assert.deepEqual(worksheet.inputSchema.required, ["title", "sections"])
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

test("链路：schema 未声明的 wecom_userid 经 SDK 管线原样到达 handler（cron 系统调用依赖）", async () => {
  const { Server } = await import("@modelcontextprotocol/sdk/server/index.js")
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js")
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js")
  const { CallToolRequestSchema } = await import("@modelcontextprotocol/sdk/types.js")

  // 本测试自建镜像 server（低层 setRequestHandler + asObject，同 index.ts 的
  // 分发习语），并非 import 生产 dispatch——它钉住的前提是「SDK 客户端与
  // CallToolRequestSchema 不剥离 schema 未声明参数」（SDK 1.29.0 源码级核实：
  // 低层传原始 request，registerTool 则 safeParse 剥未知键）。因此若未来真把
  // index.ts 迁到 registerTool，此测试不会红——生产侧防线是 training.ts 与
  // index.ts 的 ⚠ 前提依赖注释，迁移前必读。
  let seenArgs: Record<string, unknown> | undefined
  const server = new Server({ name: "passthrough-test", version: "0.0.0" }, { capabilities: { tools: {} } })
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    seenArgs = request.params.arguments as Record<string, unknown>
    return { content: [{ type: "text" as const, text: "ok" }] }
  })

  const client = new Client({ name: "passthrough-client", version: "0.0.0" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])

  await client.callTool({
    name: "teacher_tutor_profile_get",
    arguments: { wecom_userid: "cron-teacher" },
  })

  assert.equal((seenArgs as Record<string, unknown> | undefined)?.wecom_userid, "cron-teacher")
  await client.close()
  await server.close()
})
