export const DEFAULT_API_BASE_URL = "http://127.0.0.1:19828"

/**
 * API 形态：desktop = Tauri 桌面端本地 API（POST /projects/:id/search 等）；
 * src-server = 独立 src-server（GET /api/v1/search?project_id&query&limit 等）。
 * 由 env LLM_WIKI_API_FORM 显式选择（src-server | desktop），缺省 desktop
 * （保持既有桌面行为；Hermes lt-tutor 挂载时显式设 src-server）。
 */
export type ApiForm = "desktop" | "src-server"

export function resolveApiForm(env: { LLM_WIKI_API_FORM?: string } = process.env): ApiForm {
  return env.LLM_WIKI_API_FORM?.trim() === "src-server" ? "src-server" : "desktop"
}

export interface LlmWikiApiClientOptions {
  baseUrl?: string
  token?: string
  fetchImpl?: typeof fetch
}

export interface ApiProject {
  id: string
  name: string
  path: string
  current: boolean
}

export interface ApiFileNode {
  name: string
  path: string
  isDir: boolean
  children?: ApiFileNode[]
}

export interface ApiSearchResult {
  path: string
  title: string
  snippet: string
  score: number
  titleMatch?: boolean
  images?: Array<{ url: string; alt: string }>
  vectorScore?: number | null
}

export interface ApiSearchResponse {
  results: ApiSearchResult[]
  mode?: string
  tokenHits?: number
  vectorHits?: number
}

export interface ApiPageEmbeddingResult {
  path: string
  pageId: string
  revision: string
  chunks: number
  vectorsWritten: number
  status: string
}

export interface ApiChatReference {
  title: string
  path: string
  kind: string
  snippet?: string
  score?: number
}

export interface ApiChatToolEvent {
  tool: string
  status: string
  detail?: string
}

export interface ApiChatEvent {
  type: string
  [key: string]: unknown
}

export interface ApiChatUsage {
  promptChars?: number
  completionChars?: number
  referenceCount?: number
  toolEventCount?: number
}

export interface ApiChatResponse {
  projectId?: string
  sessionId: string
  mode?: string
  message: {
    role: string
    content: string
  }
  references: ApiChatReference[]
  toolEvents: ApiChatToolEvent[]
  events: ApiChatEvent[]
  usage?: ApiChatUsage
}

export interface ApiGraphNode {
  id: string
  label: string
  type: string
  path?: string
  linkCount?: number
  weight?: number
}

export interface ApiGraphEdge {
  source: string
  target: string
  weight?: number
}

export type ApiReviewStatus = "unresolved" | "resolved" | "all"

export interface ApiReviewOption {
  label: string
  action: string
}

export interface ApiReviewItem {
  id: string
  type: string
  title: string
  description: string
  sourcePath?: string
  affectedPages?: string[]
  searchQueries?: string[]
  options: ApiReviewOption[]
  resolved: boolean
  resolvedAction?: string
  createdAt: number
}

export interface ApiReviewsResponse {
  projectId?: string
  status: ApiReviewStatus
  count: number
  reviews: ApiReviewItem[]
}

export interface ApiFilesResponse {
  files: ApiFileNode[]
  truncated?: boolean
}

export interface ApiHealth {
  ok?: boolean
  status?: string
  enabled?: boolean
  mcpEnabled?: boolean
  authRequired?: boolean
  authConfigured?: boolean
  allowUnauthenticated?: boolean
  tokenSource?: string
  /** src-server 降级详情（healthSrc：/health 含 degraded 字段时透传，见 healthSrc）。 */
  degraded?: unknown
  [key: string]: unknown
}

/** src-server AuthResponse（snake_case：/auth/refresh、/auth/login、/training/bind 共用）。 */
export interface ApiAuthUser {
  id: number
  username: string
  email: string | null
  full_name: string | null
  created_at: string | null
}

export interface ApiAuthResponse {
  access_token: string
  refresh_token: string
  expires_in: number
  user: ApiAuthUser
}

/**
 * API 404（应用级"未找到"，如文件不存在）——单独分流的类型化错误。
 * read_file 捕获后转为正常返回（isError=false）引导模型纠正 path，避免 MCP 客户端
 * （如 Hermes）把工具级失败计入熔断器、3 次后整服务器熔断；未捕获场景与普通 Error
 * 等价上抛（message 形状不变），其他错误形态（5xx/网络）不受影响。
 */
export class ApiNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ApiNotFoundError"
  }
}

export function normalizeBaseUrl(value?: string): string {
  const raw = (value ?? DEFAULT_API_BASE_URL).trim() || DEFAULT_API_BASE_URL
  return raw.replace(/\/+$/, "")
}

function apiPath(path: string): string {
  return path.startsWith("/api/v1") ? path : `/api/v1${path.startsWith("/") ? path : `/${path}`}`
}

function requireObject(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context}: expected JSON object`)
  }
  return value as Record<string, unknown>
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function requireString(value: unknown, context: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`${context}: expected non-empty string`)
  }
  return value
}

function requireNumber(value: unknown, context: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${context}: expected finite number`)
  }
  return value
}

export class LlmWikiApiClient {
  private readonly baseUrl: string
  private readonly token?: string
  private readonly fetchImpl: typeof fetch

  constructor(options: LlmWikiApiClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? process.env.LLM_WIKI_API_BASE_URL)
    this.token = options.token ?? process.env.LLM_WIKI_API_TOKEN
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async health(): Promise<ApiHealth> {
    return this.requestObject("/health", { auth: false }) as Promise<ApiHealth>
  }

  async projects(): Promise<{ projects: ApiProject[]; currentProject: ApiProject | null }> {
    const json = await this.requestObject("/projects")
    const projects = Array.isArray(json.projects) ? json.projects.map(parseProject) : []
    const currentProject = json.currentProject ? parseProject(json.currentProject) : null
    return { projects, currentProject }
  }

  async files(projectId = "current", options: { root?: "wiki" | "sources" | "all"; recursive?: boolean; maxFiles?: number } = {}): Promise<ApiFilesResponse> {
    const params = new URLSearchParams()
    params.set("root", options.root ?? "wiki")
    if (options.recursive !== undefined) params.set("recursive", String(options.recursive))
    if (options.maxFiles !== undefined) params.set("maxFiles", String(options.maxFiles))
    const json = await this.requestObject(`/projects/${encodeURIComponent(projectId)}/files?${params.toString()}`)
    return {
      files: Array.isArray(json.files) ? json.files.map(parseFileNode) : [],
      truncated: json.truncated === true,
    }
  }

  async fileContent(projectId = "current", path: string): Promise<{ path: string; content: string }> {
    const params = new URLSearchParams({ path })
    const json = await this.requestObject(`/projects/${encodeURIComponent(projectId)}/files/content?${params.toString()}`)
    return {
      path: typeof json.path === "string" ? json.path : path,
      content: typeof json.content === "string" ? json.content : "",
    }
  }

  async reviews(projectId = "current", options: { status?: ApiReviewStatus; type?: string; limit?: number } = {}): Promise<ApiReviewsResponse> {
    const params = new URLSearchParams()
    if (options.status) params.set("status", options.status)
    if (options.type) params.set("type", options.type)
    if (options.limit !== undefined) params.set("limit", String(options.limit))
    const suffix = params.toString() ? `?${params.toString()}` : ""
    const json = await this.requestObject(`/projects/${encodeURIComponent(projectId)}/reviews${suffix}`)
    const reviews = Array.isArray(json.reviews) ? json.reviews.map(parseReviewItem) : []
    return {
      projectId: typeof json.projectId === "string" ? json.projectId : undefined,
      status: parseReviewStatus(json.status),
      count: numberOrUndefined(json.count) ?? reviews.length,
      reviews,
    }
  }

  async search(projectId = "current", query: string, options: { topK?: number; includeContent?: boolean } = {}): Promise<ApiSearchResponse> {
    const json = await this.requestObject(`/projects/${encodeURIComponent(projectId)}/search`, {
      method: "POST",
      body: {
        query,
        topK: options.topK,
        includeContent: options.includeContent,
      },
    })
    return {
      results: Array.isArray(json.results) ? json.results.map(parseSearchResult) : [],
      mode: typeof json.mode === "string" ? json.mode : undefined,
      tokenHits: numberOrUndefined(json.tokenHits),
      vectorHits: numberOrUndefined(json.vectorHits),
    }
  }

  async chat(projectId = "current", message: string, options: { sessionId?: string; mode?: string; topK?: number; includeContent?: boolean; wiki?: boolean; web?: boolean; anytxt?: boolean; skills?: string[]; persistSession?: boolean } = {}): Promise<ApiChatResponse> {
    const json = await this.requestObject(`/projects/${encodeURIComponent(projectId)}/chat`, {
      method: "POST",
      body: {
        message,
        sessionId: options.sessionId,
        persistSession: options.persistSession,
        mode: options.mode,
        topK: options.topK,
        includeContent: options.includeContent,
        tools: {
          wiki: options.wiki ?? true,
          web: options.web ?? false,
          anytxt: options.anytxt ?? false,
        },
        skills: options.skills,
      },
    })
    const msg = requireObject(json.message, "chat message")
    return {
      projectId: typeof json.projectId === "string" ? json.projectId : undefined,
      sessionId: typeof json.sessionId === "string" ? json.sessionId : "",
      mode: typeof json.mode === "string" ? json.mode : undefined,
      message: {
        role: typeof msg.role === "string" ? msg.role : "assistant",
        content: typeof msg.content === "string" ? msg.content : "",
      },
      references: Array.isArray(json.references) ? json.references.map(parseChatReference) : [],
      toolEvents: Array.isArray(json.toolEvents) ? json.toolEvents.map(parseChatToolEvent) : [],
      events: Array.isArray(json.events) ? json.events.map(parseChatEvent) : [],
      usage: parseChatUsage(json.usage),
    }
  }

  async cancelChat(projectId = "current", sessionId: string): Promise<{ sessionId: string; cancelled: boolean }> {
    const json = await this.requestObject(`/projects/${encodeURIComponent(projectId)}/chat/${encodeURIComponent(sessionId)}/cancel`, {
      method: "POST",
    })
    return {
      sessionId: typeof json.sessionId === "string" ? json.sessionId : sessionId,
      cancelled: json.cancelled === true,
    }
  }

  async graph(projectId = "current", options: { q?: string; nodeType?: string; limit?: number } = {}): Promise<{ nodes: ApiGraphNode[]; edges: ApiGraphEdge[] }> {
    const params = new URLSearchParams()
    if (options.q) params.set("q", options.q)
    if (options.nodeType) params.set("nodeType", options.nodeType)
    if (options.limit !== undefined) params.set("limit", String(options.limit))
    const suffix = params.toString() ? `?${params.toString()}` : ""
    const json = await this.requestObject(`/projects/${encodeURIComponent(projectId)}/graph${suffix}`)
    return {
      nodes: Array.isArray(json.nodes) ? json.nodes.map(parseGraphNode) : [],
      edges: Array.isArray(json.edges) ? json.edges.map(parseGraphEdge) : [],
    }
  }

  async rescan(projectId = "current"): Promise<Record<string, unknown>> {
    return this.requestObject(`/projects/${encodeURIComponent(projectId)}/sources/rescan`, {
      method: "POST",
    })
  }

  async embedPage(path: string, projectId = "current", force = false): Promise<ApiPageEmbeddingResult> {
    const json = await this.requestObject(`/projects/${encodeURIComponent(projectId)}/pages/embed`, {
      method: "POST",
      body: { path, force },
    })
    const result = requireObject(json.result, "page embedding result")
    return {
      path: requireString(result.path, "page embedding result.path"),
      pageId: requireString(result.pageId, "page embedding result.pageId"),
      revision: requireString(result.revision, "page embedding result.revision"),
      chunks: requireNumber(result.chunks, "page embedding result.chunks"),
      vectorsWritten: requireNumber(result.vectorsWritten, "page embedding result.vectorsWritten"),
      status: requireString(result.status, "page embedding result.status"),
    }
  }

  // ── src-server 形态端点（路径/方法/响应形状按 src-server 路由实现适配）──

  /** GET /health → {status:"ok"}；无 mcpEnabled 断言（src-server 无此开关）。
   *  响应含 degraded 字段（即使 status 仍报 "ok"）时返回结构化降级结果
   *  {ok:false, status:"degraded", degraded:<原样透传>}——不把降级态一律当健康。 */
  async healthSrc(): Promise<ApiHealth> {
    const raw = await this.requestObject("/health", { auth: false, rawPath: true })
    if (raw.degraded !== undefined) {
      return {
        ok: false,
        status: "degraded",
        degraded: raw.degraded,
      }
    }
    return raw as ApiHealth
  }

  /** GET /api/v1/search?project_id=&query=&limit=&rerank=（响应 camelCase：mode/results/tokenHits/vectorHits）。 */
  async searchSrc(projectId: number, query: string, options: { limit?: number; rerank?: boolean; token?: string } = {}): Promise<ApiSearchResponse> {
    const params = new URLSearchParams({ project_id: String(projectId), query })
    if (options.limit !== undefined) params.set("limit", String(options.limit))
    if (options.rerank !== undefined) params.set("rerank", String(options.rerank))
    const json = await this.requestObject(`/api/v1/search?${params.toString()}`, { token: options.token })
    return {
      results: Array.isArray(json.results) ? json.results.map(parseSearchResult) : [],
      mode: typeof json.mode === "string" ? json.mode : undefined,
      tokenHits: numberOrUndefined(json.tokenHits),
      vectorHits: numberOrUndefined(json.vectorHits),
    }
  }

  /** GET /api/v1/files/:project_id/read?path= → {path, content, extension}。 */
  async readFileSrc(projectId: number, filePath: string, options: { token?: string } = {}): Promise<{ path: string; content: string }> {
    const params = new URLSearchParams({ path: filePath })
    const json = await this.requestObject(`/api/v1/files/${projectId}/read?${params.toString()}`, { token: options.token })
    return {
      path: typeof json.path === "string" ? json.path : filePath,
      content: typeof json.content === "string" ? json.content : "",
    }
  }

  /** POST /api/v1/auth/refresh {refresh_token} → AuthResponse（旧 refresh 即刻吊销）。 */
  async authRefresh(refreshToken: string): Promise<ApiAuthResponse> {
    return parseAuthResponse(await this.requestObject("/api/v1/auth/refresh", {
      method: "POST",
      body: { refresh_token: refreshToken },
      auth: false,
    }))
  }

  /** POST /api/v1/auth/login {username, password} → AuthResponse。 */
  async authLogin(username: string, password: string): Promise<ApiAuthResponse> {
    return parseAuthResponse(await this.requestObject("/api/v1/auth/login", {
      method: "POST",
      body: { username, password },
      auth: false,
    }))
  }

  /** POST /api/v1/training/bind（header x-training-admin-token；幂等建档 + 轮换全部活跃 refresh）。 */
  async trainingBind(wecomUserid: string, adminToken: string, displayName?: string): Promise<ApiAuthResponse> {
    const token = adminToken.trim()
    if (!token) throw new Error("TRAINING__ADMIN_TOKEN is required for training bind")
    const body: Record<string, unknown> = { wecom_userid: wecomUserid }
    if (displayName !== undefined) body.display_name = displayName
    return parseAuthResponse(await this.requestObject("/api/v1/training/bind", {
      method: "POST",
      body,
      adminToken: token,
      auth: false,
    }))
  }

  async trainingProfileGet(token: string): Promise<Record<string, unknown>> {
    return this.requestObject("/api/v1/training/profile", { token })
  }

  async trainingProfilePut(token: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestObject("/api/v1/training/profile", { method: "PUT", body, token })
  }

  async trainingEventAsk(token: string, payload: unknown): Promise<{ id: number }> {
    const json = await this.requestObject("/api/v1/training/events", {
      method: "POST",
      body: { event_type: "ask", payload },
      token,
    })
    return { id: numberOrUndefined(json.id) ?? 0 }
  }

  async trainingProgress(token: string): Promise<Record<string, unknown>> {
    return this.requestObject("/api/v1/training/progress", { token })
  }

  async trainingPlanCreate(token: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestObject("/api/v1/training/plans", { method: "POST", body, token })
  }

  /** GET /api/v1/training/plans?status= — 顶层 JSON 数组。 */
  async trainingPlanList(token: string, status?: string): Promise<unknown[]> {
    const suffix = status ? `?status=${encodeURIComponent(status)}` : ""
    const json = await this.doFetch(`/api/v1/training/plans${suffix}`, { token })
    if (!Array.isArray(json)) throw new Error("LLM Wiki API response: expected JSON array (plans list)")
    return json
  }

  async trainingPlanGet(token: string, planId: number): Promise<Record<string, unknown>> {
    return this.requestObject(`/api/v1/training/plans/${planId}`, { token })
  }

  async trainingPlanLink(token: string, planId: number): Promise<{ link: string }> {
    const json = await this.requestObject(`/api/v1/training/plans/${planId}/link`, { method: "POST", token })
    return { link: typeof json.link === "string" ? json.link : "" }
  }

  async trainingItemComplete(token: string, itemId: number): Promise<Record<string, unknown>> {
    return this.requestObject(`/api/v1/training/items/${itemId}/complete`, { method: "POST", token })
  }

  private async requestObject(path: string, options: RequestOptions = {}): Promise<Record<string, unknown>> {
    return requireObject(await this.doFetch(path, options), "LLM Wiki API response")
  }

  private async doFetch(path: string, options: RequestOptions = {}): Promise<unknown> {
    const url = `${this.baseUrl}${options.rawPath ? path : apiPath(path)}`
    const headers: Record<string, string> = { Accept: "application/json" }
    if (options.adminToken?.trim()) headers["x-training-admin-token"] = options.adminToken.trim()
    const bearer = options.token ?? this.token
    if (options.auth !== false && bearer?.trim()) {
      headers.Authorization = `Bearer ${bearer.trim()}`
    }
    if (options.body !== undefined) headers["Content-Type"] = "application/json"

    let response: Response
    try {
      response = await this.fetchImpl(url, {
        method: options.method ?? (options.body === undefined ? "GET" : "POST"),
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      })
    } catch (err) {
      throw new Error(`LLM Wiki API request failed. Is the desktop app running? ${err instanceof Error ? err.message : String(err)}`)
    }

    const text = await response.text()
    let json: unknown
    try {
      json = text ? JSON.parse(text) : {}
    } catch (err) {
      throw new Error(`LLM Wiki API returned non-JSON response (${response.status}): ${text.slice(0, 300)}${err instanceof Error ? ` (${err.message})` : ""}`)
    }

    const okFlag = json && typeof json === "object" && !Array.isArray(json)
      ? (json as Record<string, unknown>).ok
      : undefined
    if (!response.ok || okFlag === false) {
      const message = `LLM Wiki API ${response.status}: ${apiErrorMessage(json, response.statusText)}`
      // 404 = 应用级"未找到"（如文件不存在，多半是调用方拼错 path），不是服务故障：
      // 抛类型化 ApiNotFoundError 供 read_file 等工具分流为正常返回。
      if (response.status === 404) throw new ApiNotFoundError(message)
      throw new Error(message)
    }
    return json
  }
}

interface RequestOptions {
  method?: "GET" | "POST" | "PUT"
  body?: unknown
  auth?: boolean
  /** 按调用注入的 Bearer token（教师工具经凭证库注入；优先于 client 级 token）。 */
  token?: string
  /** x-training-admin-token（training/bind 专用）。 */
  adminToken?: string
  /** 跳过 /api/v1 前缀（src-server 顶层 /health）。 */
  rawPath?: boolean
}

/** 错误消息提取：desktop {error:"..."} 与 src-server {error:{code,message}} 双形状。 */
function apiErrorMessage(json: unknown, fallback: string): string {
  if (json && typeof json === "object" && !Array.isArray(json)) {
    const error = (json as Record<string, unknown>).error
    if (typeof error === "string") return error
    if (error && typeof error === "object" && !Array.isArray(error)) {
      const message = (error as Record<string, unknown>).message
      if (typeof message === "string" && message !== "") return message
    }
  }
  return fallback
}

function parseAuthResponse(value: unknown): ApiAuthResponse {
  const obj = requireObject(value, "auth response")
  const user = requireObject(obj.user, "auth response user")
  const access_token = String(obj.access_token ?? "")
  const refresh_token = String(obj.refresh_token ?? "")
  if (!access_token || !refresh_token) {
    throw new Error("auth response is missing access_token/refresh_token")
  }
  // expires_in 硬校验：缺失/非正有限数按失败抛错（调用方走 refresh 失败 → bind 重建链），
  // 不再 `?? 0` 静默吸收——0 会把 access 缓存立即置过期，畸形响应被当成功。
  const expires_in = numberOrUndefined(obj.expires_in)
  if (expires_in === undefined || expires_in <= 0) {
    throw new Error(`auth response has missing or invalid expires_in: ${JSON.stringify(obj.expires_in)}`)
  }
  return {
    access_token,
    refresh_token,
    expires_in,
    user: {
      id: numberOrUndefined(user.id) ?? 0,
      username: String(user.username ?? ""),
      email: typeof user.email === "string" ? user.email : null,
      full_name: typeof user.full_name === "string" ? user.full_name : null,
      created_at: typeof user.created_at === "string" ? user.created_at : null,
    },
  }
}

function parseProject(value: unknown): ApiProject {
  const obj = requireObject(value, "project")
  return {
    id: String(obj.id ?? ""),
    name: String(obj.name ?? ""),
    path: String(obj.path ?? ""),
    current: obj.current === true,
  }
}

function parseFileNode(value: unknown): ApiFileNode {
  const obj = requireObject(value, "file node")
  const children = Array.isArray(obj.children) ? obj.children.map(parseFileNode) : undefined
  return {
    name: String(obj.name ?? ""),
    path: String(obj.path ?? ""),
    isDir: obj.isDir === true || obj.is_dir === true,
    ...(children ? { children } : {}),
  }
}

function parseSearchResult(value: unknown): ApiSearchResult {
  const obj = requireObject(value, "search result")
  return {
    path: String(obj.path ?? ""),
    title: String(obj.title ?? ""),
    snippet: String(obj.snippet ?? ""),
    score: numberOrUndefined(obj.score) ?? 0,
    titleMatch: obj.titleMatch === true,
    images: Array.isArray(obj.images) ? obj.images.map((image) => {
      const item = requireObject(image, "image")
      return { url: String(item.url ?? ""), alt: String(item.alt ?? "") }
    }) : [],
    vectorScore: numberOrUndefined(obj.vectorScore) ?? null,
  }
}

function parseChatReference(value: unknown): ApiChatReference {
  const obj = requireObject(value, "chat reference")
  return {
    title: String(obj.title ?? ""),
    path: String(obj.path ?? ""),
    kind: String(obj.kind ?? "wiki"),
    snippet: typeof obj.snippet === "string" ? obj.snippet : undefined,
    score: numberOrUndefined(obj.score),
  }
}

function parseChatToolEvent(value: unknown): ApiChatToolEvent {
  const obj = requireObject(value, "chat tool event")
  return {
    tool: String(obj.tool ?? ""),
    status: String(obj.status ?? ""),
    detail: typeof obj.detail === "string" ? obj.detail : undefined,
  }
}

function parseChatEvent(value: unknown): ApiChatEvent {
  const obj = requireObject(value, "chat event")
  return {
    ...obj,
    type: String(obj.type ?? ""),
  }
}

function parseChatUsage(value: unknown): ApiChatUsage | undefined {
  if (value === undefined || value === null) return undefined
  const obj = requireObject(value, "chat usage")
  return {
    promptChars: numberOrUndefined(obj.promptChars),
    completionChars: numberOrUndefined(obj.completionChars),
    referenceCount: numberOrUndefined(obj.referenceCount),
    toolEventCount: numberOrUndefined(obj.toolEventCount),
  }
}

function parseReviewStatus(value: unknown): ApiReviewStatus {
  return value === "resolved" || value === "all" ? value : "unresolved"
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.map((item) => String(item))
}

function parseReviewItem(value: unknown): ApiReviewItem {
  const obj = requireObject(value, "review item")
  return {
    id: String(obj.id ?? ""),
    type: String(obj.type ?? ""),
    title: String(obj.title ?? ""),
    description: String(obj.description ?? ""),
    sourcePath: typeof obj.sourcePath === "string" ? obj.sourcePath : undefined,
    affectedPages: stringArray(obj.affectedPages),
    searchQueries: stringArray(obj.searchQueries),
    options: Array.isArray(obj.options) ? obj.options.map((option) => {
      const item = requireObject(option, "review option")
      return { label: String(item.label ?? ""), action: String(item.action ?? "") }
    }) : [],
    resolved: obj.resolved === true,
    resolvedAction: typeof obj.resolvedAction === "string" ? obj.resolvedAction : undefined,
    createdAt: numberOrUndefined(obj.createdAt) ?? 0,
  }
}

function parseGraphNode(value: unknown): ApiGraphNode {
  const obj = requireObject(value, "graph node")
  return {
    id: String(obj.id ?? ""),
    label: String(obj.label ?? ""),
    type: String(obj.nodeType ?? obj.type ?? "other"),
    path: typeof obj.path === "string" ? obj.path : undefined,
    linkCount: numberOrUndefined(obj.linkCount),
    weight: numberOrUndefined(obj.weight),
  }
}

function parseGraphEdge(value: unknown): ApiGraphEdge {
  const obj = requireObject(value, "graph edge")
  return {
    source: String(obj.source ?? ""),
    target: String(obj.target ?? ""),
    weight: numberOrUndefined(obj.weight),
  }
}
