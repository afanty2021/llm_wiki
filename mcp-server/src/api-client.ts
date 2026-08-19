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

  // ── src-server 形态端点（路径/方法/响应形状按 src-server 路由实现适配）──

  /** GET /health → {status:"ok"}；无 mcpEnabled 断言（src-server 无此开关）。 */
  async healthSrc(): Promise<ApiHealth> {
    return (await this.requestObject("/health", { auth: false, rawPath: true })) as ApiHealth
  }

  /** GET /api/v1/search?project_id=&query=&limit=（响应 camelCase：mode/results/tokenHits/vectorHits）。 */
  async searchSrc(projectId: number, query: string, options: { limit?: number; token?: string } = {}): Promise<ApiSearchResponse> {
    const params = new URLSearchParams({ project_id: String(projectId), query })
    if (options.limit !== undefined) params.set("limit", String(options.limit))
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
      throw new Error(`LLM Wiki API ${response.status}: ${apiErrorMessage(json, response.statusText)}`)
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
  return {
    access_token,
    refresh_token,
    expires_in: numberOrUndefined(obj.expires_in) ?? 0,
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
