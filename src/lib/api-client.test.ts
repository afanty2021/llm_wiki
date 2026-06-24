import { describe, it, expect, vi } from "vitest"

describe("api-client resolveApiBase", () => {
  it("undefined→localhost:8080(桌面无 env 默认连 src-server)", async () => {
    const { resolveApiBase } = await import("./api-client")
    expect(resolveApiBase(undefined)).toBe("http://localhost:8080")
  })
  it("空串→空串(web 同源,?? 不回退 localhost)", async () => {
    const { resolveApiBase } = await import("./api-client")
    expect(resolveApiBase("")).toBe("")
  })
  it("显式值→显式值", async () => {
    const { resolveApiBase } = await import("./api-client")
    expect(resolveApiBase("http://host:9")).toBe("http://host:9")
  })
})

/** 辅助:mock fetch 返回 JSON Response */
function mockFetchJson(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }))
}

describe("ApiClient 新方法(按 src-server routes 实际 serde 核对)", () => {
  // ===== Files: stat / upload =====
  it("statFile 发 GET stat,返回 FileStat(snake_case)", async () => {
    const { apiClient } = await import("./api-client")
    const mockFetch = mockFetchJson({ exists: true, is_dir: false, size: 3, modified: 1 })
    vi.stubGlobal("fetch", mockFetch)
    const r = await apiClient.statFile(7, "a.md")
    expect(r.exists).toBe(true)
    expect(r.is_dir).toBe(false)
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/files/7/stat/a.md"),
      expect.objectContaining({ method: "GET" }),
    )
    vi.unstubAllGlobals()
  })

  it("uploadFile 发 multipart POST,不带 Content-Type(浏览器加 boundary),复用 authHeaders", async () => {
    const { apiClient } = await import("./api-client")
    apiClient.setTokens("tok-abc", "refresh-abc")
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ name: "a.md", path: "a.md", size: 3 }), { status: 200 }),
    )
    vi.stubGlobal("fetch", mockFetch)
    const file = new File(["hi\n"], "a.md", { type: "text/markdown" })
    const r = await apiClient.uploadFile(7, file, "docs")
    expect(r.name).toBe("a.md")
    const [, init] = mockFetch.mock.calls[0]
    expect((init as RequestInit).method).toBe("POST")
    // multipart:不预设 Content-Type,FormData 在 body
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers["Content-Type"]).toBeUndefined()
    expect(headers["Authorization"]).toBe("Bearer tok-abc")
    expect((init as RequestInit).body).toBeInstanceOf(FormData)
    vi.unstubAllGlobals()
  })

  it("authHeaders 提供 Bearer(供 multipart/流式复用)", async () => {
    const { apiClient } = await import("./api-client")
    apiClient.setTokens("xyz", "refresh-x")
    expect(apiClient.authHeaders()).toEqual({ Authorization: "Bearer xyz" })
    apiClient.clearTokens()
    expect(apiClient.authHeaders()).toEqual({})
  })

  // ===== Ingest(实际:create_ingest_job 返回 {job_id, status:"pending"},非 JobResponse)=====
  it("triggerIngest 发 POST ingest,返回 {job_id, status}(routes 实际)", async () => {
    const { apiClient } = await import("./api-client")
    const mockFetch = mockFetchJson({ job_id: "job-1", status: "pending" }, 201)
    vi.stubGlobal("fetch", mockFetch)
    const r = await apiClient.triggerIngest(5, ["a.md"])
    expect(r.job_id).toBe("job-1")
    expect(r.status).toBe("pending")
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/projects/5/ingest"),
      expect.objectContaining({ method: "POST", body: JSON.stringify({ source_paths: ["a.md"] }) }),
    )
    vi.unstubAllGlobals()
  })

  it("getIngestJob 发 GET 全局端点,返回 JobResponse(snake_case)", async () => {
    const { apiClient } = await import("./api-client")
    const mockFetch = mockFetchJson({
      id: "job-1", project_id: 5, status: "running", stage: "embed",
      progress: 42, error: null, result: null, created_at: "t",
      started_at: null, finished_at: null,
    })
    vi.stubGlobal("fetch", mockFetch)
    const r = await apiClient.getIngestJob("job-1")
    expect(r.id).toBe("job-1")
    expect(r.progress).toBe(42)
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/ingest/jobs/job-1"),
      expect.objectContaining({ method: "GET" }),
    )
    vi.unstubAllGlobals()
  })

  // ===== Review(camelCase ReviewItemResp)=====
  it("listReviews 返回 camelCase ReviewItem[]", async () => {
    const { apiClient } = await import("./api-client")
    const item = {
      id: 1, uuid: "u-1", projectId: 5, sourcePath: "a.md",
      reviewType: "dangling", title: "t", description: "d",
      affectedPages: ["p"], searchQueries: null,
      options: [{ label: "create", action: "create_page" }],
      status: "open", resolvedAction: null, resolvedBy: null,
      resolvedAt: null, createdAt: "t",
    }
    const mockFetch = mockFetchJson([item])
    vi.stubGlobal("fetch", mockFetch)
    const r = await apiClient.listReviews(5)
    expect(r[0].projectId).toBe(5)
    expect(r[0].reviewType).toBe("dangling")
    expect(r[0].options[0].action).toBe("create_page")
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/projects/5/reviews"),
      expect.objectContaining({ method: "GET" }),
    )
    vi.unstubAllGlobals()
  })

  it("resolveReview 发 POST resolve(tag=kind body)", async () => {
    const { apiClient } = await import("./api-client")
    const mockFetch = mockFetchJson({ kind: "resolved", resolvedAction: "create_page", createdPath: "p.md" })
    vi.stubGlobal("fetch", mockFetch)
    await apiClient.resolveReview(5, 9, { kind: "create_page" })
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/projects/5/reviews/9/resolve"),
      expect.objectContaining({ method: "POST", body: JSON.stringify({ kind: "create_page" }) }),
    )
    vi.unstubAllGlobals()
  })

  it("dismissReview 发 POST dismiss", async () => {
    const { apiClient } = await import("./api-client")
    const mockFetch = mockFetchJson({}, 200)
    vi.stubGlobal("fetch", mockFetch)
    await apiClient.dismissReview(5, 9)
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/projects/5/reviews/9/dismiss"),
      expect.objectContaining({ method: "POST" }),
    )
    vi.unstubAllGlobals()
  })

  // ===== Research(实际:enqueue 返回 {uuid},非 ResearchTask)=====
  it("enqueueResearch 发 POST research,返回 {uuid}(routes 实际)", async () => {
    const { apiClient } = await import("./api-client")
    const mockFetch = mockFetchJson({ uuid: "r-uuid-1" }, 201)
    vi.stubGlobal("fetch", mockFetch)
    const r = await apiClient.enqueueResearch(5, { topic: "量子计算" })
    expect(r.uuid).toBe("r-uuid-1")
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/projects/5/research"),
      expect.objectContaining({
        method: "POST", body: JSON.stringify({ topic: "量子计算" }),
      }),
    )
    vi.unstubAllGlobals()
  })

  it("getResearchTask 发 GET 全局端点,返回 snake_case ResearchTask", async () => {
    const { apiClient } = await import("./api-client")
    const task = {
      id: "r-uuid-1", project_id: 5, user_id: null, topic: "x",
      search_queries: null, status: "running", stage: "search",
      web_results: null, synthesis: null, saved_path: null,
      source_kind: "manual", error: null, created_at: "t",
      started_at: null, finished_at: null, updated_at: "t",
    }
    const mockFetch = mockFetchJson(task)
    vi.stubGlobal("fetch", mockFetch)
    const r = await apiClient.getResearchTask("r-uuid-1")
    expect(r.id).toBe("r-uuid-1")
    expect(r.project_id).toBe(5)
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/research/tasks/r-uuid-1"),
      expect.objectContaining({ method: "GET" }),
    )
    vi.unstubAllGlobals()
  })

  // ===== LLM / Search providers(snake_case;实际 GET 返回 Option 单个,非数组)=====
  it("getLlmProvider 发 GET,返回 ProviderResp | null(单个)", async () => {
    const { apiClient } = await import("./api-client")
    const prov = {
      id: 3, provider_type: "openai", base_url: null, model: "gpt-4o",
      context_size: 128000, is_enabled: true, has_key: true,
    }
    const mockFetch = mockFetchJson(prov)
    vi.stubGlobal("fetch", mockFetch)
    const r = await apiClient.getLlmProvider(2)
    expect(r?.provider_type).toBe("openai")
    expect(r?.context_size).toBe(128000)
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/teams/2/llm-providers"),
      expect.objectContaining({ method: "GET" }),
    )
    vi.unstubAllGlobals()
  })

  it("upsertLlmProvider 发 POST(创建),返回 ProviderResp", async () => {
    const { apiClient } = await import("./api-client")
    const prov = {
      id: 4, provider_type: "openai", base_url: null, model: "gpt-4o",
      context_size: 128000, is_enabled: true, has_key: true,
    }
    const mockFetch = mockFetchJson(prov, 201)
    vi.stubGlobal("fetch", mockFetch)
    const r = await apiClient.upsertLlmProvider(2, { provider_type: "openai", api_key: "sk-x" })
    expect(r.id).toBe(4)
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/teams/2/llm-providers"),
      expect.objectContaining({
        method: "POST", body: JSON.stringify({ provider_type: "openai", api_key: "sk-x" }),
      }),
    )
    vi.unstubAllGlobals()
  })

  it("getSearchProvider 发 GET,返回 Option(实际单条,null/对象非数组)", async () => {
    const { apiClient } = await import("./api-client")
    const prov = { id: 7, provider_type: "tavily", base_url: null, is_enabled: true, has_key: true }
    const mockFetch = mockFetchJson(prov)
    vi.stubGlobal("fetch", mockFetch)
    const r = await apiClient.getSearchProvider(2)
    expect(r?.provider_type).toBe("tavily")
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/teams/2/search-providers"),
      expect.objectContaining({ method: "GET" }),
    )
    vi.unstubAllGlobals()
  })
})
