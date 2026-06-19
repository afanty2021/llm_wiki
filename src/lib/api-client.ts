import type {
  ApiError, LoginRequest, RegisterRequest, AuthResponse,
  UserResponse, TeamResponse, ProjectResponse, SearchResult, GraphData,
} from "./api-types"

const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:8080"

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

  async listProjects(teamId?: number): Promise<{ items: ProjectResponse[]; next_cursor?: string; has_more: boolean }> {
    const params = teamId ? `?team_id=${teamId}` : ""
    return this.request("GET", `/api/v1/projects${params}`)
  }

  // === Search ===
  async search(projectId: number, query: string): Promise<{ results: SearchResult[]; total: number }> {
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
