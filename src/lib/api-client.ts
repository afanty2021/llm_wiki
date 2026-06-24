import type {
  ApiError, LoginRequest, RegisterRequest, AuthResponse,
  UserResponse, TeamResponse, ProjectResponse, SearchResponse, GraphData,
  FileStat, ReviewItem, ResolveReviewBody, ResearchTask, EnqueueResearchResponse,
  IngestJob, TriggerIngestResponse, LlmProvider, SearchProvider,
} from "./api-types"

/** 解析 API base。?? 而非 ||:空串(web 同源)是合法值,|| 会 falsy 回退 localhost 破坏同源。
 *  undefined(桌面无 env)→ 默认 localhost:8080(连 src-server);""(web 同源)→ 相对 fetch。 */
export function resolveApiBase(envValue: string | undefined): string {
  return envValue ?? "http://localhost:8080"
}
export const API_BASE = resolveApiBase(import.meta.env.VITE_API_BASE_URL)

class ApiClient {
  private accessToken: string | null = null
  private refreshToken: string | null = null

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
  ): Promise<T> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
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
        return this.request<T>(method, path, body, true)
      } catch {
        this.clearTokens()
        throw new Error("Session expired")
      }
    }

    if (!response.ok) {
      const error: ApiError = await response.json()
      throw new Error(error.error?.message || `HTTP ${response.status}`)
    }

    return response.json()
  }

  private async refreshAccessToken(): Promise<void> {
    if (!this.refreshToken) throw new Error("No refresh token")
    const data = await this.request<{ access_token: string }>(
      "POST",
      "/api/v1/auth/refresh",
      { refresh_token: this.refreshToken },
      // isRetry=true：refresh 自身 401 时不再递归触发 refreshAccessToken，否则
      // getMe 401 → refresh → 401 → refresh → ... 无限递归，loadSession 永久卡死（"加载中"）。
      // refresh 失败应直接 throw → 上层 request 的 catch → clearTokens + "Session expired"。
      true,
    )
    this.accessToken = data.access_token
    if (typeof localStorage !== "undefined") {
      localStorage.setItem("access_token", data.access_token)
    }
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
      await this.request("POST", "/api/v1/auth/logout")
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

  // === Files ===
  async listFiles(projectId: number, dir?: string): Promise<{ name: string; path: string; is_dir: boolean; size: number }[]> {
    const params = dir ? `?dir=${encodeURIComponent(dir)}` : ""
    return this.request("GET", `/api/v1/files/${projectId}/list${params}`)
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
