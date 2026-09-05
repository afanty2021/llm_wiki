/**
 * teacher-tutor 工具组（src-server 形态）+ 教师凭证持有。
 *
 * - TeacherCredentialStore：~/.llm-wiki-mcp/teachers.json（600，目录 700）持久化
 *   {wecom_userid: {refreshToken, userId}}；内存 access 缓存提前 60s 过期；
 *   miss → POST /api/v1/auth/refresh（single-flight：并发同 userid 只发一次）；
 *   refresh 失败 → POST /api/v1/training/bind（TRAINING__ADMIN_TOKEN）重建/轮换。
 * - 10 个 src-server 工具：8 个 teacher_tutor_* + 重写的 llm_wiki_search /
 *   llm_wiki_read_file（GET /api/v1/search?project_id、GET /api/v1/files/:id/read?path=）。
 *   project_id 取 env TRAINING__PROJECT_ID；token 全部由 store 注入，绝不进工具返回值。
 * - 身份硬闸（M3 T2）：10 工具统一入口先 resolveIdentity(meta, args.wecom_userid)——
 *   wecom 会话身份（Hermes 注入的 _meta）优先，参数身份仅系统模式可用；返回值追加
 *   identity_source（"user"|"system"）。详见 identity.ts。
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

import {
  ApiNotFoundError,
  LlmWikiApiClient,
  type ApiAuthResponse,
  type ApiSearchResult,
} from "./api-client.js"
import {
  IdentityMode,
  MetaLike,
  resolveIdentity,
  ToolArgumentError,
} from "./identity.js"

// ToolArgumentError 定义迁至 identity.ts（resolveIdentity 需抛出同款类）；
// 此再导出保持既有 import 路径（index.ts 仍从 training.js 取）。
export { ToolArgumentError }

export const DEFAULT_TEACHER_STORE_PATH = path.join(homedir(), ".llm-wiki-mcp", "teachers.json")
export const DEFAULT_PUBLIC_T_BASE = "http://127.0.0.1:8080"
export const MAX_TEXT_BYTES = 120_000
const ACCESS_EARLY_EXPIRY_MS = 60_000

// ── TeacherCredentialStore ──

interface StoredTeacher {
  refreshToken: string
  userId: number
}

type TeacherStoreFile = Record<string, StoredTeacher>

interface CachedAccess {
  accessToken: string
  expiresAtMs: number
}

export interface TeacherCredentialStoreOptions {
  client?: LlmWikiApiClient
  baseUrl?: string
  adminToken?: string
  storePath?: string
  fetchImpl?: typeof fetch
  /** 可注入时钟（测试缓存提前过期）。 */
  now?: () => number
}

export class TeacherCredentialStore {
  private readonly client: LlmWikiApiClient
  private readonly adminToken: string
  private readonly storePath: string
  private readonly now: () => number
  private readonly accessCache = new Map<string, CachedAccess>()
  private readonly inflight = new Map<string, Promise<CachedAccess>>()
  private loaded: TeacherStoreFile | null = null

  constructor(options: TeacherCredentialStoreOptions = {}) {
    this.client = options.client
      ?? new LlmWikiApiClient({ baseUrl: options.baseUrl, fetchImpl: options.fetchImpl })
    this.adminToken = (options.adminToken ?? process.env.TRAINING__ADMIN_TOKEN ?? "").trim()
    this.storePath = (options.storePath ?? process.env.TEACHER_STORE_PATH ?? DEFAULT_TEACHER_STORE_PATH).trim()
      || DEFAULT_TEACHER_STORE_PATH
    this.now = options.now ?? Date.now
  }

  /**
   * 取该教师的 access token：内存缓存（提前 60s 过期）→ refresh（single-flight）
   * → refresh 失败回落 bind（重建档案 + 轮换全部活跃 refresh）。
   */
  async getAccess(wecomUserid: string): Promise<string> {
    const userid = wecomUserid.trim()
    if (!userid) throw new Error("wecom_userid is required")
    const cached = this.accessCache.get(userid)
    if (cached && this.now() < cached.expiresAtMs - ACCESS_EARLY_EXPIRY_MS) {
      return cached.accessToken
    }
    const pending = this.inflight.get(userid)
    if (pending) return (await pending).accessToken

    const flight = this.refreshOrBind(userid)
    // single-flight：同 userid 并发只发一次网络调用；落定后清理 in-flight 槽位
    const wrapped = flight.finally(() => {
      if (this.inflight.get(userid) === wrapped) this.inflight.delete(userid)
    })
    this.inflight.set(userid, wrapped)
    return (await wrapped).accessToken
  }

  /** 丢弃内存 access 缓存（如 API 401 后强制重取）。 */
  invalidate(wecomUserid: string): void {
    this.accessCache.delete(wecomUserid.trim())
  }

  private async refreshOrBind(userid: string): Promise<CachedAccess> {
    const stored = this.loadStore()[userid]
    if (stored?.refreshToken) {
      try {
        return this.cacheAccess(userid, await this.client.authRefresh(stored.refreshToken))
      } catch {
        // refresh 失败（过期/被轮换/吊销）→ bind 幂等重建档案并轮换
      }
    }
    return this.cacheAccess(userid, await this.client.trainingBind(userid, this.adminToken))
  }

  private cacheAccess(userid: string, auth: ApiAuthResponse): CachedAccess {
    const entry: CachedAccess = {
      accessToken: auth.access_token,
      expiresAtMs: this.now() + auth.expires_in * 1000,
    }
    this.accessCache.set(userid, entry)
    this.persist(userid, { refreshToken: auth.refresh_token, userId: auth.user.id })
    return entry
  }

  private loadStore(): TeacherStoreFile {
    if (this.loaded) return this.loaded
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.storePath, "utf8"))
      this.loaded = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as TeacherStoreFile
        : {}
    } catch {
      this.loaded = {}
    }
    return this.loaded
  }

  private persist(userid: string, cred: StoredTeacher): void {
    const store = this.loadStore()
    store[userid] = cred
    this.loaded = store
    const dir = path.dirname(this.storePath)
    mkdirSync(dir, { recursive: true })
    chmodSync(dir, 0o700)
    // 原子写：先写同目录临时文件（同样 600），再 rename 替换（POSIX 同目录 rename 原子）。
    // 直接 writeFileSync 目标路径会在中途崩溃/磁盘满时留下截断 JSON，loadStore 吞解析错
    // 返回 {} → 全部教师各触发一次 bind + 服务端轮换。临时文件名含 pid+时间戳防并发互踩。
    const tmpPath = `${this.storePath}.tmp-${process.pid}-${Date.now()}`
    writeFileSync(tmpPath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 })
    chmodSync(tmpPath, 0o600)
    try {
      renameSync(tmpPath, this.storePath)
    } catch (err) {
      rmSync(tmpPath, { force: true })
      throw err
    }
  }
}

// ── 工具定义与 handler ──

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: {
    type: "object"
    properties: Record<string, unknown>
    required?: string[]
    additionalProperties: false
  }
}

export type ToolOutput = { content: Array<{ type: "text"; text: string }> }

export type SrcToolHandler = (args: Record<string, unknown>, meta?: MetaLike) => Promise<ToolOutput>

export interface SrcServerHandlerDeps {
  client: LlmWikiApiClient
  store: TeacherCredentialStore
  /** env TRAINING__PROJECT_ID（数值），惰性解析。 */
  getProjectId: () => number
  /** env PUBLIC_T_BASE（默认 http://127.0.0.1:8080）。 */
  getPublicTBase: () => string
}

// wecom_userid 在 schema 可选声明、不进 required（2026-09-05 修订 08-24 加固）：
// wecom 教师会话身份由 Hermes `_meta` 注入、identity.ts 锁定，勿传（描述明示；
// 模型仍硬传且与会话不符时 identity 锁照常拒绝，纵深防御保留）；cron/运维系统
// 回合必传——glm-5.3-flash 严格遵循 schema，不声明就不会 emit，08-24 的
// 「完全不暴露」形态曾致周报 cron -32602 通道断裂（422b42f2 根修）。08-24
// 不暴露的缘由是弱回退模型照抄示例值硬传（-32602 ×4 触发熔断假故障），现描述
// 文本无示例值且身份锁兜底，风险窗口收窄为「弱模型顶班 + 从上下文抄他人 id」。
// 契约由 identity.test.ts 可选声明测试钉住；handler 直读 args 的透传前提见
// index.ts CallToolRequestSchema 处注释。

/** src-server 形态下重写的 2 个通用工具（project_id 来自 env，token 经 store 注入）。 */
export function srcServerToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "llm_wiki_search",
      description: "Search the training wiki project using the src-server hybrid keyword/vector retrieval (GET /api/v1/search).",
      inputSchema: {
        type: "object",
        properties: {
          wecom_userid: { type: "string", description: "系统/cron 回合必填（目标教师企微 id）；wecom 教师会话勿传——身份已由会话锁定，传错会被拒。" },
          query: { type: "string", description: "Search query." },
          limit: { type: "number", description: "Maximum results (server clamps 1..50; omitted → 5)." },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    {
      name: "llm_wiki_read_file",
      description: "Read a text file from the training wiki project through the src-server API (GET /api/v1/files/:project_id/read?path=).",
      inputSchema: {
        type: "object",
        properties: {
          wecom_userid: { type: "string", description: "系统/cron 回合必填（目标教师企微 id）；wecom 教师会话勿传——身份已由会话锁定，传错会被拒。" },
          path: { type: "string", description: "Project-relative file path, for example wiki/index.md." },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  ]
}

/** 8 个 teacher_tutor_* 工具（首参一律 wecom_userid）。 */
export function trainingToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "teacher_tutor_profile_get",
      description: "读取教师档案（subject / grade_levels / goals / interests / onboarding_state）。",
      inputSchema: {
        type: "object",
        properties: {
          wecom_userid: { type: "string", description: "系统/cron 回合必填（目标教师企微 id）；wecom 教师会话勿传——身份已由会话锁定，传错会被拒。" },
        },
        additionalProperties: false,
      },
    },
    {
      name: "teacher_tutor_profile_put",
      description: "部分更新教师档案（仅传入字段被更新；onboarding_state 仅 pending→surveyed）。",
      inputSchema: {
        type: "object",
        properties: {
          wecom_userid: { type: "string", description: "系统/cron 回合必填（目标教师企微 id）；wecom 教师会话勿传——身份已由会话锁定，传错会被拒。" },
          display_name: { type: "string", description: "显示名（≤100 chars）" },
          subject: { type: "string", description: "任教科目（≤100 chars）" },
          grade_levels: { type: "array", items: { type: "string" }, description: "任教年级" },
          goals: { type: "array", items: { type: "string" }, description: "学习目标" },
          interests: { type: "array", items: { type: "string" }, description: "兴趣点" },
          onboarding_state: { type: "string", enum: ["pending", "surveyed"] },
        },
        additionalProperties: false,
      },
    },
    {
      name: "teacher_tutor_record_ask",
      description: "上报一次教师提问事件（event_type=ask，payload 为提问上下文 JSON）。",
      inputSchema: {
        type: "object",
        properties: {
          wecom_userid: { type: "string", description: "系统/cron 回合必填（目标教师企微 id）；wecom 教师会话勿传——身份已由会话锁定，传错会被拒。" },
          payload: { type: "object", description: "提问上下文，必含提问文本（任一字符串值 ≥2 字符，如 {question: \"…\"}）；空对象/纯数字/省略均会被拒不计。" },
        },
        additionalProperties: false,
      },
    },
    {
      name: "teacher_tutor_plan_create",
      description: "创建学习计划（返回 {plan, items, link}，link 为可直接分享的完整 /s/ 短链——短链永活，点开时系统现签短期凭证）。period_key 幂等：同 (user, origin, period_key) 重复创建返回既有计划。",
      inputSchema: {
        type: "object",
        properties: {
          wecom_userid: { type: "string", description: "系统/cron 回合必填（目标教师企微 id）；wecom 教师会话勿传——身份已由会话锁定，传错会被拒。" },
          title: { type: "string", description: "计划标题（非空，≤200 chars）" },
          reason: { type: "string", description: "创建理由" },
          origin: { type: "string", enum: ["chat", "weekly"] },
          period_key: { type: "string", description: "幂等键（≤20 chars，如 2026-W34）" },
          items: {
            type: "array",
            description: "计划条目",
            items: {
              type: "object",
              properties: {
                kind: { type: "string", enum: ["wiki_page", "media"] },
                target_ref: { type: "string", description: "wiki 页相对路径或 media slug" },
                timecode_start_s: { type: "number" },
                timecode_end_s: { type: "number" },
                label: { type: "string", description: "条目标题（≤200 chars）" },
              },
              required: ["kind", "target_ref", "label"],
              additionalProperties: false,
            },
          },
        },
        required: ["title", "origin", "items"],
        additionalProperties: false,
      },
    },
    {
      name: "teacher_tutor_plan_list",
      description: "列出教师的全部学习计划（created_at DESC，含 items 计数）。",
      inputSchema: {
        type: "object",
        properties: {
          wecom_userid: { type: "string", description: "系统/cron 回合必填（目标教师企微 id）；wecom 教师会话勿传——身份已由会话锁定，传错会被拒。" },
          status: { type: "string", enum: ["active", "archived"] },
        },
        additionalProperties: false,
      },
    },
    {
      name: "teacher_tutor_item_complete",
      description: "标记计划条目完成（幂等；单调投影不回退）。",
      inputSchema: {
        type: "object",
        properties: {
          wecom_userid: { type: "string", description: "系统/cron 回合必填（目标教师企微 id）；wecom 教师会话勿传——身份已由会话锁定，传错会被拒。" },
          item_id: { type: "number", description: "learning_items.id" },
        },
        required: ["item_id"],
        additionalProperties: false,
      },
    },
    {
      name: "teacher_tutor_plan_link",
      description: "取计划的全新 /s/ 短链（短链永活、点开时系统现签短期凭证；旧链打不开多为隧道/网络问题。返回完整 URL）。",
      inputSchema: {
        type: "object",
        properties: {
          wecom_userid: { type: "string", description: "系统/cron 回合必填（目标教师企微 id）；wecom 教师会话勿传——身份已由会话锁定，传错会被拒。" },
          plan_id: { type: "number", description: "learning_plans.id" },
        },
        required: ["plan_id"],
        additionalProperties: false,
      },
    },
    {
      name: "teacher_tutor_progress",
      description: "学习进度总览：全部计划（含 items 计数）+ 最近 20 条学习事件。",
      inputSchema: {
        type: "object",
        properties: {
          wecom_userid: { type: "string", description: "系统/cron 回合必填（目标教师企微 id）；wecom 教师会话勿传——身份已由会话锁定，传错会被拒。" },
        },
        additionalProperties: false,
      },
    },
  ]
}

/** record_ask 最小形状检查（2026-09-05）：payload 必须含至少一个 ≥2 字符的字符串
 * 值（任意层级）。真实提问的 payload 形状多样——{"question"} / {"q"} /
 * {"queries":[...]} / {"context":{...}}——共通点是总有一段提问文本；而测试/噪声
 * 形态（{} / {"n": 24}）全是数字或空。递归扫，命中即真。 */
function payloadHasQuestionText(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length >= 2
  if (Array.isArray(value)) return value.some(payloadHasQuestionText)
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some(payloadHasQuestionText)
  }
  return false
}

/** /t/ 链接拼装：PUBLIC_T_BASE（去尾斜杠）+ API 返回的相对 link；绝对 link 直通。 */
export function joinTLink(base: string, link: string): string {
  if (/^https?:\/\//i.test(link)) return link
  return `${base.replace(/\/+$/, "")}${link.startsWith("/") ? link : `/${link}`}`
}

function textResult(text: string): ToolOutput {
  return { content: [{ type: "text", text }] }
}

/**
 * read_file 404 的正常返回文案（isError=false）：应用级"未找到"（模型拼错/引用了
 * 不存在的 path）不是服务故障，抛 MCP 错误会被 Hermes 客户端计入熔断器，3 次即把
 * 整个服务器熔断 ~60s（T8 周报 fire#1 根因）——改为正常返回引导模型优雅纠正。
 */
export function fileNotFoundText(relPath: string): string {
  return `未找到文件：${relPath}（本工具只接受 search 返回的确切 path；请核对后重试或换一个来源）`
}

/**
 * record_ask 拒绝的正常返回文案（isError=false）：空/无意义 payload 是应用级
 * 输入问题不是服务故障——抛 ToolArgumentError（-32602）会被 Hermes 熔断器计入，
 * 3 次即熔断 ~60s（同 read_file 404 前例，见上），弱模型连续传空 payload 会把
 * 整个服务器熔断成假故障。
 */
export function invalidAskPayloadText(): string {
  return `未记录该提问事件：payload 未含提问文本（需任一字符串值 ≥2 字符，如 {question: "…"}）。请补全 payload 后重试，或跳过记录继续当前任务。`
}

function jsonResult(value: unknown): ToolOutput {
  return textResult(JSON.stringify(value, null, 2))
}

/**
 * 工具返回值追加 identity_source（content 数组追加一块 text，文本 `identity_source: "user"`）。
 * 其余形状不变：原 content[0] 逐字节保留（JSON 载荷可照常解析；文本工具原文不动），
 * 顶层数组载荷（plan_list）也无需改形状。客户端按 MCP 惯例拼接 text 块即对模型可见。
 */
function withIdentitySource(result: ToolOutput, mode: IdentityMode): ToolOutput {
  return {
    content: [...result.content, { type: "text" as const, text: `identity_source: ${JSON.stringify(mode)}` }],
  }
}

function stringArg(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ToolArgumentError(`${name} is required`)
  }
  return value
}

function optionalStringArg(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string") throw new ToolArgumentError(`${name} must be a string`)
  return value
}

function optionalNumberArg(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ToolArgumentError(`${name} must be a number`)
  }
  return value
}

function optionalStringArrayArg(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ToolArgumentError(`${name} must be an array of strings`)
  }
  return value as string[]
}

function requiredArrayArg(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new ToolArgumentError(`${name} is required (array)`)
  return value
}

/** 取 token 并执行 fn；API 401 → invalidate 后强制重取一次再重试。 */
async function callWithAccess<T>(
  deps: SrcServerHandlerDeps,
  wecomUserid: string,
  fn: (token: string) => Promise<T>,
): Promise<T> {
  let token = await deps.store.getAccess(wecomUserid)
  try {
    return await fn(token)
  } catch (err) {
    if (err instanceof Error && /LLM Wiki API 401/.test(err.message)) {
      deps.store.invalidate(wecomUserid)
      token = await deps.store.getAccess(wecomUserid)
      return await fn(token)
    }
    throw err
  }
}

export function createSrcServerHandlers(deps: SrcServerHandlerDeps): Map<string, SrcToolHandler> {
  const handlers = new Map<string, SrcToolHandler>()

  handlers.set("llm_wiki_search", async (args, meta) => {
    const ident = resolveIdentity(meta, optionalStringArg(args.wecom_userid, "wecom_userid"))
    const query = stringArg(args.query, "query")
    const limit = optionalNumberArg(args.limit, "limit")
    // rerank=false：教师会话每回合 3-5 次搜索，LLM 精排 ~6s/次的延迟税不可接受，
    // 固定 opt-out 回落 RRF 序（web UI / deep research 不受影响）。恢复质量删此行。
    // limit 缺省 5：对齐旧精排路径的 rerank_final_k=5——不钉死则 opt-out 返回
    // DEFAULT_RESULTS=20，上下文膨胀 ~4 倍部分抵消延迟收益（评审 M1）。
    const search = await callWithAccess(deps, ident.wecomUserid, (token) =>
      deps.client.searchSrc(deps.getProjectId(), query, { limit: limit ?? 5, rerank: false, token }))
    return withIdentitySource(textResult(formatSearchResults(query, search)), ident.mode)
  })

  handlers.set("llm_wiki_read_file", async (args, meta) => {
    const ident = resolveIdentity(meta, optionalStringArg(args.wecom_userid, "wecom_userid"))
    const relPath = stringArg(args.path, "path")
    try {
      const { path: filePath, content } = await callWithAccess(deps, ident.wecomUserid, (token) =>
        deps.client.readFileSrc(deps.getProjectId(), relPath, { token }))
      return withIdentitySource(
        textResult(`# ${filePath}\n\n${truncateText(content, MAX_TEXT_BYTES)}`),
        ident.mode,
      )
    } catch (err) {
      // 404 = 应用级"未找到" → 正常返回（isError=false），熔断器不被触发；
      // 其他错误形态（5xx/网络）保持抛错上抛。
      if (err instanceof ApiNotFoundError) {
        return withIdentitySource(textResult(fileNotFoundText(relPath)), ident.mode)
      }
      throw err
    }
  })

  handlers.set("teacher_tutor_profile_get", async (args, meta) => {
    const ident = resolveIdentity(meta, optionalStringArg(args.wecom_userid, "wecom_userid"))
    return withIdentitySource(jsonResult(await callWithAccess(deps, ident.wecomUserid, (token) =>
      deps.client.trainingProfileGet(token))), ident.mode)
  })

  handlers.set("teacher_tutor_profile_put", async (args, meta) => {
    const ident = resolveIdentity(meta, optionalStringArg(args.wecom_userid, "wecom_userid"))
    const body: Record<string, unknown> = {}
    const display_name = optionalStringArg(args.display_name, "display_name")
    const subject = optionalStringArg(args.subject, "subject")
    const grade_levels = optionalStringArrayArg(args.grade_levels, "grade_levels")
    const goals = optionalStringArrayArg(args.goals, "goals")
    const interests = optionalStringArrayArg(args.interests, "interests")
    const onboarding_state = optionalStringArg(args.onboarding_state, "onboarding_state")
    if (display_name !== undefined) body.display_name = display_name
    if (subject !== undefined) body.subject = subject
    if (grade_levels !== undefined) body.grade_levels = grade_levels
    if (goals !== undefined) body.goals = goals
    if (interests !== undefined) body.interests = interests
    if (onboarding_state !== undefined) body.onboarding_state = onboarding_state
    if (Object.keys(body).length === 0) {
      throw new ToolArgumentError("at least one profile field is required")
    }
    return withIdentitySource(jsonResult(await callWithAccess(deps, ident.wecomUserid, (token) =>
      deps.client.trainingProfilePut(token, body))), ident.mode)
  })

  handlers.set("teacher_tutor_record_ask", async (args, meta) => {
    const ident = resolveIdentity(meta, optionalStringArg(args.wecom_userid, "wecom_userid"))
    const payload = args.payload !== undefined ? args.payload : {}
    if (!payloadHasQuestionText(payload)) {
      // 拒绝走正常返回而非 -32602（跟进修 A）：应用级输入问题不进熔断器
      return withIdentitySource(textResult(invalidAskPayloadText()), ident.mode)
    }
    return withIdentitySource(jsonResult(await callWithAccess(deps, ident.wecomUserid, (token) =>
      deps.client.trainingEventAsk(token, payload))), ident.mode)
  })

  handlers.set("teacher_tutor_plan_create", async (args, meta) => {
    const ident = resolveIdentity(meta, optionalStringArg(args.wecom_userid, "wecom_userid"))
    const body: Record<string, unknown> = {
      title: stringArg(args.title, "title"),
      origin: stringArg(args.origin, "origin"),
      items: requiredArrayArg(args.items, "items").map((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          throw new ToolArgumentError("items must be an array of objects")
        }
        const entry = item as Record<string, unknown>
        const timecode_start_s = optionalNumberArg(entry.timecode_start_s, "items.timecode_start_s")
        const timecode_end_s = optionalNumberArg(entry.timecode_end_s, "items.timecode_end_s")
        const out: Record<string, unknown> = {
          kind: stringArg(entry.kind, "items.kind"),
          target_ref: stringArg(entry.target_ref, "items.target_ref"),
          label: stringArg(entry.label, "items.label"),
        }
        if (timecode_start_s !== undefined) out.timecode_start_s = timecode_start_s
        if (timecode_end_s !== undefined) out.timecode_end_s = timecode_end_s
        return out
      }),
    }
    const reason = optionalStringArg(args.reason, "reason")
    const period_key = optionalStringArg(args.period_key, "period_key")
    if (reason !== undefined) body.reason = reason
    if (period_key !== undefined) body.period_key = period_key

    const response = await callWithAccess(deps, ident.wecomUserid, (token) =>
      deps.client.trainingPlanCreate(token, body))
    // link 升级为完整 URL（PUBLIC_T_BASE + /t/<token>）
    if (typeof response.link === "string" && response.link !== "") {
      response.link = joinTLink(deps.getPublicTBase(), response.link)
    }
    return withIdentitySource(jsonResult(response), ident.mode)
  })

  handlers.set("teacher_tutor_plan_list", async (args, meta) => {
    const ident = resolveIdentity(meta, optionalStringArg(args.wecom_userid, "wecom_userid"))
    const status = optionalStringArg(args.status, "status")
    return withIdentitySource(jsonResult(await callWithAccess(deps, ident.wecomUserid, (token) =>
      deps.client.trainingPlanList(token, status))), ident.mode)
  })

  handlers.set("teacher_tutor_item_complete", async (args, meta) => {
    const ident = resolveIdentity(meta, optionalStringArg(args.wecom_userid, "wecom_userid"))
    const itemId = optionalNumberArg(args.item_id, "item_id")
    if (itemId === undefined) throw new ToolArgumentError("item_id is required")
    return withIdentitySource(jsonResult(await callWithAccess(deps, ident.wecomUserid, (token) =>
      deps.client.trainingItemComplete(token, itemId))), ident.mode)
  })

  handlers.set("teacher_tutor_plan_link", async (args, meta) => {
    const ident = resolveIdentity(meta, optionalStringArg(args.wecom_userid, "wecom_userid"))
    const planId = optionalNumberArg(args.plan_id, "plan_id")
    if (planId === undefined) throw new ToolArgumentError("plan_id is required")
    const response = await callWithAccess(deps, ident.wecomUserid, (token) =>
      deps.client.trainingPlanLink(token, planId))
    // link 空值守卫（评审 #4）：与 plan_create 同形状校验——服务端未回 link
    // （响应形状意外/网关截断）时抛清晰错误，绝不把裸 base URL 当可用链接发给 LLM。
    if (typeof response.link !== "string" || response.link === "") {
      throw new Error(
        `teacher_tutor_plan_link: server returned no link for plan ${planId} (got ${JSON.stringify(response)})`,
      )
    }
    return withIdentitySource(jsonResult({ link: joinTLink(deps.getPublicTBase(), response.link) }), ident.mode)
  })

  handlers.set("teacher_tutor_progress", async (args, meta) => {
    const ident = resolveIdentity(meta, optionalStringArg(args.wecom_userid, "wecom_userid"))
    return withIdentitySource(jsonResult(await callWithAccess(deps, ident.wecomUserid, (token) =>
      deps.client.trainingProgress(token))), ident.mode)
  })

  return handlers
}

// ── 展示辅助（index.ts 桌面路径与 src-server 工具共用）──

export function truncateText(value: string, maxBytes: number): string {
  const bytes = Buffer.byteLength(value, "utf8")
  if (bytes <= maxBytes) return value
  let out = ""
  let used = 0
  for (const ch of value) {
    const size = Buffer.byteLength(ch, "utf8")
    if (used + size > maxBytes) break
    out += ch
    used += size
  }
  return `${out}\n\n[truncated: ${bytes - used} bytes omitted]`
}

export function formatSearchResults(query: string, search: { results: ApiSearchResult[]; mode?: string; tokenHits?: number; vectorHits?: number }): string {
  const { results } = search
  if (results.length === 0) return `No results for "${query}".`
  const meta = [
    search.mode ? `Mode: ${search.mode}` : null,
    typeof search.tokenHits === "number" ? `Token hits: ${search.tokenHits}` : null,
    typeof search.vectorHits === "number" ? `Vector hits: ${search.vectorHits}` : null,
  ].filter(Boolean)
  const lines = [`# Search results for "${query}"`, ...(meta.length > 0 ? [meta.join(" | ")] : []), ""]
  results.forEach((result, index) => {
    lines.push(`## ${index + 1}. ${result.title}`)
    lines.push(`Path: ${result.path}`)
    lines.push(`Score: ${result.score.toFixed(6)}${typeof result.vectorScore === "number" ? ` | Vector score: ${result.vectorScore.toFixed(6)}` : ""}`)
    if (result.snippet) lines.push(`Snippet: ${result.snippet}`)
    if (result.images && result.images.length > 0) {
      lines.push(`Images: ${result.images.map((image) => image.url).join(", ")}`)
    }
    lines.push("")
  })
  return lines.join("\n")
}
