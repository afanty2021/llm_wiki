import type {
  ApiError, LoginRequest, RegisterRequest, AuthResponse,
  UserResponse, TeamResponse, ProjectResponse, SearchResponse, GraphData,
  FileStat, ReviewItem, ResolveReviewBody, ResearchTask, EnqueueResearchResponse,
  IngestJob, TriggerIngestResponse, LlmProvider, SearchProvider, WikiPage,
} from "./api-types"

/** 解析 API base。?? 而非 ||:空串(web 同源)是合法值,|| 会 falsy 回退 localhost 破坏同源。
 *  undefined(桌面无 env)→ 默认 localhost:8080(连 src-server);""(web 同源)→ 相对 fetch。 */
export function resolveApiBase(envValue: string | undefined): string {
  return envValue ?? "http://localhost:8080"
}
export const API_BASE = resolveApiBase(import.meta.env.VITE_API_BASE_URL)

/** 类型化请求错误（#6/FS-1）：携带 HTTP status 与服务端 error.code
 *  （error.rs 的 RESOURCE_NOT_FOUND/CONFLICT/…），供调用方做分支而非
 *  解析 message 字符串。body 非 JSON（网关剥 body）时仅 status 可用。 */
export class ApiRequestError extends Error {
  readonly status: number
  readonly code?: string

  constructor(message: string, status: number, code?: string) {
    super(message)
    this.name = "ApiRequestError"
    this.status = status
    this.code = code
  }

  get isNotFound(): boolean {
    return this.status === 404 || this.code === "RESOURCE_NOT_FOUND"
  }

  get isConflict(): boolean {
    return this.status === 409 || this.code === "CONFLICT"
  }
}

class ApiClient {
  private accessToken: string | null = null
  private refreshToken: string | null = null
  /** 并发去重:多个 401 同时触发 refresh 时共享同一个 promise,避免并发刷新竞态/浪费。 */
  private refreshPromise: Promise<void> | null = null

  setTokens(access: string, refresh: string) {
    this.accessToken = access
    this.refreshToken = refresh
    if (typeof localStorage !== "undefined") {
      localStorage.setItem("access_token", access)
      localStorage.setItem("refresh_token", refresh)
    }
  }

  loadTokens(): boolean {
    if (typeof localStorage === "undefined") return false
    const access = localStorage.getItem("access_token")
    const refresh = localStorage.getItem("refresh_token")
    if (access && refresh) {
      this.accessToken = access
      this.refreshToken = refresh
      return true
    }
    return false
  }

  clearTokens() {
    this.accessToken = null
    this.refreshToken = null
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem("access_token")
      localStorage.removeItem("refresh_token")
    }
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    isRetry = false,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...extraHeaders,
    }

    if (this.accessToken) {
      headers["Authorization"] = `Bearer ${this.accessToken}`
    }

    const response = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    })

    // Token 过期时自动刷新
    if (response.status === 401 && !isRetry && this.refreshToken) {
      try {
        await this.refreshAccessToken()
        return this.request<T>(method, path, body, true, extraHeaders)
      } catch {
        this.clearTokens()
        throw new Error("Session expired")
      }
    }

    if (!response.ok) {
      // #6/FS-1：类型化错误（status + error.code）——调用方可按 isNotFound/
      // isConflict 分支；body 非 JSON（网关剥 body/裸 502）时退回 `HTTP <status>`。
      let code: string | undefined
      let message = `HTTP ${response.status}`
      try {
        const error = (await response.json()) as ApiError
        code = error?.error?.code
        message = error?.error?.message || message
      } catch {
        // 无 JSON body：保留裸 HTTP 状态形态
      }
      throw new ApiRequestError(message, response.status, code)
    }

    return response.json()
  }

  private async refreshAccessToken(): Promise<void> {
    // 并发去重:多个请求同时 401 时只发一次 /auth/refresh,其余等同一个 promise,
    // 避免并发刷新竞态（refresh_token 单次使用语义下尤其重要）。
    if (this.refreshPromise) return this.refreshPromise
    this.refreshPromise = this.doRefreshAccessToken()
    try {
      await this.refreshPromise
    } finally {
      this.refreshPromise = null
    }
  }

  private async doRefreshAccessToken(): Promise<void> {
    if (!this.refreshToken) throw new Error("No refresh token")
    const data = await this.request<{ access_token: string; refresh_token: string }>(
      "POST",
      "/api/v1/auth/refresh",
      { refresh_token: this.refreshToken },
      // isRetry=true：refresh 自身 401 时不再递归触发 refreshAccessToken，否则
      // getMe 401 → refresh → 401 → refresh → ... 无限递归，loadSession 永久卡死（"加载中"）。
      // refresh 失败应直接 throw → 上层 request 的 catch → clearTokens + "Session expired"。
      true,
    )
    // 服务端轮换式发新对（旧 refresh 单次使用即 revoke）——必须整套持久化，
    // 只存 access 会让下一次刷新拿已吊销的旧 refresh → "Session expired" 强制重登
    // （评审 Important：SPA 丢弃轮换后新 refresh，2026-06-13 起存量缺陷）。
    this.setTokens(data.access_token, data.refresh_token)
  }

  /** 公开刷新 access token(供 streamViaServer 等非 request<T> 的 fetch 场景 401 时续期)。
   *  复用私有 refreshAccessToken(POST /auth/refresh + 更新 accessToken/localStorage)。 */
  async refreshSession(): Promise<void> {
    await this.refreshAccessToken()
  }

  // === Auth ===
  async login(req: LoginRequest): Promise<AuthResponse> {
    const data = await this.request<AuthResponse>("POST", "/api/v1/auth/login", req)
    this.setTokens(data.access_token, data.refresh_token)
    return data
  }

  async register(req: RegisterRequest): Promise<AuthResponse> {
    const data = await this.request<AuthResponse>("POST", "/api/v1/auth/register", req)
    this.setTokens(data.access_token, data.refresh_token)
    return data
  }

  async logout(): Promise<void> {
    try {
      // 服务端 logout 的 Json<RefreshTokenRequest> 必填 refresh_token——缺 body 时
      // axum 直接 422、handler 不执行、吊销从未生效（评审 Important：logout 假动作，
      // 叠加 4h access TTL 放大登出后残留窗口）。有 refresh 才发（没有即无可吊销）。
      if (this.refreshToken) {
        await this.request("POST", "/api/v1/auth/logout", {
          refresh_token: this.refreshToken,
        })
      }
    } finally {
      this.clearTokens()
    }
  }

  // === Users ===
  async getMe(): Promise<UserResponse> {
    return this.request<UserResponse>("GET", "/api/v1/users/me")
  }

  async getUserTeams(): Promise<TeamResponse[]> {
    return this.request<TeamResponse[]>("GET", "/api/v1/users/me/teams")
  }

  // === Teams ===
  async createTeam(name: string, description?: string): Promise<TeamResponse> {
    return this.request<TeamResponse>("POST", "/api/v1/teams", { name, description })
  }

  async listTeams(): Promise<{ items: TeamResponse[]; next_cursor?: string; has_more: boolean }> {
    return this.request("GET", "/api/v1/teams")
  }

  // === Projects ===
  async createProject(name: string, teamId: number): Promise<ProjectResponse> {
    return this.request<ProjectResponse>("POST", "/api/v1/projects", { name, team_id: teamId })
  }

  async listProjects(teamId?: number, cursor?: string, limit?: number): Promise<{ items: ProjectResponse[]; next_cursor?: string; has_more: boolean }> {
    const params = new URLSearchParams()
    if (teamId != null) params.set("team_id", String(teamId))
    if (cursor) params.set("cursor", cursor)
    if (limit != null) params.set("limit", String(limit))
    const qs = params.toString()
    return this.request("GET", `/api/v1/projects${qs ? `?${qs}` : ""}`)
  }

  // === Search ===
  async search(projectId: number, query: string): Promise<SearchResponse> {
    const params = new URLSearchParams({ project_id: String(projectId), query })
    return this.request("GET", `/api/v1/search?${params}`)
  }

  // === Graph ===
  async getGraph(projectId: number): Promise<GraphData> {
    return this.request<GraphData>("GET", `/api/v1/graph/${projectId}`)
  }

  // === Pages (wiki_pages DB;web 摄取只写 DB 不写文件,knowledge-tree web 模式读此) ===
  async listPages(projectId: number, pageType?: string): Promise<WikiPage[]> {
    const params = pageType ? `?type=${encodeURIComponent(pageType)}` : ""
    return this.request<WikiPage[]>("GET", `/api/v1/projects/${projectId}/pages${params}`)
  }

  /** GET /projects/:id/page?path= —— 单页全文(含 content/frontmatter/updated_at)。
   *  path 用 query 而非路径段,避免 %2F 二次 decode(与 pages.rs 路由设计一致)。 */
  async getPage(projectId: number, path: string): Promise<WikiPage> {
    const params = `?path=${encodeURIComponent(path)}`
    return this.request<WikiPage>("GET", `/api/v1/projects/${projectId}/page${params}`)
  }

  /** POST /projects/:id/pages —— 建页（#7：web 下新 .md 的页面语义写入；
   *  冲突 409 由调用方处理）。不传 title——pages.rs denormalize 回落 frontmatter。 */
  async createPage(
    projectId: number,
    body: { path: string; content?: string | null; frontmatter?: unknown },
  ): Promise<WikiPage> {
    return this.request<WikiPage>("POST", `/api/v1/projects/${projectId}/pages`, body)
  }

  /** PUT /projects/:id/page?path= —— 更新页面(If-Match 乐观锁,RFC3339 updated_at)。 */
  async updatePage(
    projectId: number,
    path: string,
    body: { path: string; title?: string | null; content?: string | null; frontmatter?: unknown },
    ifMatch: string,
  ): Promise<WikiPage> {
    const params = `?path=${encodeURIComponent(path)}`
    return this.request<WikiPage>(
      "PUT",
      `/api/v1/projects/${projectId}/page${params}`,
      body,
      false,
      { "If-Match": ifMatch },
    )
  }

  /** GET /graph/:id/links?path= —— Links 面板（outgoing/backlinks/missing），
   *  服务端镜像桌面 get_page_links，解析器与图谱构建同源。 */
  async getPageLinks(
    projectId: number,
    path: string,
  ): Promise<{ outgoing: { title: string; path?: string; snippet?: string }[]; backlinks: { title: string; path?: string; snippet?: string }[]; missing: { title: string; path?: string; snippet?: string }[] }> {
    const params = `?path=${encodeURIComponent(path)}`
    return this.request("GET", `/api/v1/graph/${projectId}/links${params}`)
  }

  // === Files ===
  async listFiles(projectId: number, dir?: string, maxDepth?: number): Promise<{ name: string; path: string; is_dir: boolean; size: number }[]> {
    const params = new URLSearchParams()
    if (dir) params.set("dir", dir)
    if (maxDepth && maxDepth > 1) params.set("max_depth", String(maxDepth))
    const qs = params.toString()
    return this.request("GET", `/api/v1/files/${projectId}/list${qs ? `?${qs}` : ""}`)
  }

  async readFile(projectId: number, path: string): Promise<{ path: string; content: string }> {
    const params = new URLSearchParams({ path })
    return this.request("GET", `/api/v1/files/${projectId}/read?${params}`)
  }

  async writeFile(projectId: number, path: string, contents: string): Promise<void> {
    await this.request("POST", `/api/v1/files/${projectId}/write`, { path, contents })
  }

  async deleteFile(projectId: number, path: string): Promise<void> {
    await this.request("POST", `/api/v1/files/${projectId}/delete`, { path })
  }

  // === Files: stat / upload ===
  async statFile(projectId: number, path: string): Promise<FileStat> {
    return this.request("GET", `/api/v1/files/${projectId}/stat/${encodeURI(path)}`)
  }

  /** 当前 API base(桌面为 http://localhost:8080;web 同源为 "")。供 fileBlobUrl 等外部 fetch 拼 URL。 */
  get base(): string {
    return API_BASE
  }

  /** 当前鉴权头(供 multipart/流式等不走 request<T> 的 fetch 场景复用,避免外部 as any 读 private)。 */
  authHeaders(): Record<string, string> {
    const h: Record<string, string> = {}
    if (this.accessToken) h["Authorization"] = `Bearer ${this.accessToken}`
    return h
  }

  async uploadFile(
    projectId: number,
    file: File,
    dir = "",
  ): Promise<{ name: string; path: string; size: number }> {
    const form = new FormData()
    form.append("path", dir)
    form.append("file", file)
    // multipart 不能设 Content-Type(浏览器自动加 boundary),手动 fetch + 复用 authHeaders
    const resp = await fetch(`${API_BASE}/api/v1/files/${projectId}/upload`, {
      method: "POST",
      headers: this.authHeaders(),
      body: form,
    })
    if (!resp.ok) throw new Error(`upload failed: HTTP ${resp.status}`)
    return resp.json()
  }

  // === Ingest ===
  // 实际响应为 {job_id, status:"pending"}(ingest.rs::create_ingest_job),非 JobResponse。
  async triggerIngest(projectId: number, sourcePaths: string[]): Promise<TriggerIngestResponse> {
    return this.request("POST", `/api/v1/projects/${projectId}/ingest`, { source_paths: sourcePaths })
  }

  // GET /ingest/jobs/:id 全局端点,返回完整 JobResponse。
  async getIngestJob(jobId: string): Promise<IngestJob> {
    return this.request("GET", `/api/v1/ingest/jobs/${jobId}`)
  }

  // === Review(camelCase ReviewItemResp)===
  async listReviews(projectId: number): Promise<ReviewItem[]> {
    return this.request("GET", `/api/v1/projects/${projectId}/reviews`)
  }

  // body 为 ResolveAction(tag="kind");如 { kind: "create_page" } 或 { kind: "delete", path: "x" }。
  async resolveReview(projectId: number, itemId: number, body: ResolveReviewBody): Promise<unknown> {
    return this.request("POST", `/api/v1/projects/${projectId}/reviews/${itemId}/resolve`, body)
  }

  // 后端 dismiss_review 无 body 提取器;传 {} 被忽略。
  async dismissReview(projectId: number, itemId: number): Promise<unknown> {
    return this.request("POST", `/api/v1/projects/${projectId}/reviews/${itemId}/dismiss`, {})
  }

  // === Research ===
  // 实际响应为 {uuid}(research.rs::enqueue_research),非 ResearchTask。
  async enqueueResearch(
    projectId: number,
    body: { topic: string; search_queries?: string[] },
  ): Promise<EnqueueResearchResponse> {
    return this.request("POST", `/api/v1/projects/${projectId}/research`, body)
  }

  // GET /research/tasks/:uuid 全局端点(后端仍 check_project_access 鉴权),返回完整 snake_case ResearchTask。
  async getResearchTask(uuid: string): Promise<ResearchTask> {
    return this.request("GET", `/api/v1/research/tasks/${uuid}`)
  }

  // === LLM / Search providers(team 维度,snake_case ProviderResp)===
  // GET 实际返回 Option<ProviderResp>(Json<Option<..>>):null 或单对象,非数组。
  async getLlmProvider(teamId: number): Promise<LlmProvider | null> {
    return this.request("GET", `/api/v1/teams/${teamId}/llm-providers`)
  }

  // POST 为创建(create_provider);每 team 同 provider_type 唯一,故 upsert 语义=先 POST 创建。
  async upsertLlmProvider(
    teamId: number,
    body: { provider_type: string; api_key: string; base_url?: string; model?: string; context_size?: number },
  ): Promise<LlmProvider> {
    return this.request("POST", `/api/v1/teams/${teamId}/llm-providers`, body)
  }

  // 命名 getSearchProvider 反映 routes 实际(Json<Option<ProviderResp>>,单条而非 list)。
  async getSearchProvider(teamId: number): Promise<SearchProvider | null> {
    return this.request("GET", `/api/v1/teams/${teamId}/search-providers`)
  }

  // === Chat (SSE) ===
  streamChat(_projectId: number, messages: Array<{ role: string; content: string }>, model?: string): EventSource {
    const params = new URLSearchParams({ messages: JSON.stringify(messages) })
    if (model) params.set("model", model)
    const url = `${API_BASE}/api/v1/chat/stream?${params}`
    return new EventSource(url)
  }

  get isAuthenticated(): boolean {
    return this.accessToken !== null
  }
}

export const apiClient = new ApiClient()
