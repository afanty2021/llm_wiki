// API 响应类型
export interface ApiError {
  error: {
    code: string
    message: string
  }
}

export interface LoginRequest {
  username: string
  password: string
}

export interface RegisterRequest {
  username: string
  email: string
  password: string
  full_name?: string
}

export interface AuthResponse {
  access_token: string
  refresh_token: string
  expires_in: number
  user: UserResponse
}

export interface UserResponse {
  id: number
  username: string
  email: string
  full_name?: string
  created_at: string
}

export interface TeamResponse {
  id: number
  name: string
  description?: string
  created_by: number
  created_at: string
  member_count: number
}

export interface ProjectResponse {
  id: number
  team_id: number
  name: string
  storage_path: string
  created_by: number
  created_at: string
  file_count: number
}

export interface SearchResult {
  path: string
  title: string
  snippet: string
  titleMatch: boolean
  score: number
  vectorScore?: number
  images: Array<{ url: string; alt: string }>
}

export interface SearchResponse {
  mode: "keyword" | "vector" | "hybrid"
  results: SearchResult[]
  tokenHits: number
  vectorHits: number
}

export interface GraphData {
  nodes: Array<{
    id: string
    label: string
    type: string
    path: string
    linkCount: number
    community: number
  }>
  edges: Array<{
    source: string
    target: string
    weight: number
  }>
  communities: Array<{
    id: number
    nodeCount: number
    cohesion: number
    topNodes: string[]
  }>
}

// ── Layer 3/4 响应类型(字段命名严格按 src-server routes serde 实际核对)──

/**
 * 文件元信息(GET /files/:pid/stat/*path)。
 * 对应 files.rs::StatResp——无 rename_all,默认 snake_case。
 */
export interface FileStat {
  exists: boolean
  is_dir: boolean
  size: number
  modified: number
}

/**
 * Review 列表项(GET /projects/:pid/reviews)。
 * 对应 reviews.rs::ReviewItemResp——#[serde(rename_all = "camelCase")]。
 * 嵌套 ReviewOption(services/review.rs)亦为 camelCase(label/action)。
 */
export interface ReviewItem {
  id: number
  uuid: string
  projectId: number
  sourcePath: string | null
  reviewType: string
  title: string
  description: string
  affectedPages: string[] | null
  searchQueries: string[] | null
  options: Array<{ label: string; action: string }>
  status: string
  resolvedAction: string | null
  resolvedBy: number | null
  resolvedAt: string | null
  createdAt: string
}

/**
 * Resolve review 请求体(POST /projects/:pid/reviews/:iid/resolve)。
 * 对应 services/review.rs::ResolveAction——#[serde(tag="kind", rename_all="snake_case")]。
 * kind 取值:create_page / skip / delete / open / deep_research;
 * delete / open 携带可选 path。
 */
export interface ResolveReviewBody {
  kind: string
  path?: string
}

/**
 * Research 任务(GET /research/tasks/:uuid)。
 * 对应 services/research/mod.rs::ResearchTask——无 rename_all,默认 snake_case。
 * 完整字段:含 web_results/user_id/started_at/finished_at/updated_at。
 */
export interface ResearchTask {
  id: string
  project_id: number
  user_id: number | null
  topic: string
  search_queries: string[] | null
  status: string
  stage: string | null
  web_results: unknown | null
  synthesis: string | null
  saved_path: string | null
  source_kind: string
  error: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
  updated_at: string
}

/**
 * Research 入队响应(POST /projects/:pid/research)。
 * 对应 research.rs::enqueue_research——返回 json!({"uuid": uuid})(非 ResearchTask)。
 */
export interface EnqueueResearchResponse {
  uuid: string
}

/**
 * Ingest 任务(GET /ingest/jobs/:id)。
 * 对应 services/ingest_queue.rs::JobResponse——无 rename_all,默认 snake_case。
 */
export interface IngestJob {
  id: string
  project_id: number
  status: string
  stage: string | null
  progress: number
  error: string | null
  result: unknown | null
  created_at: string
  started_at: string | null
  finished_at: string | null
}

/**
 * Ingest 入队响应(POST /projects/:pid/ingest)。
 * 对应 ingest.rs::create_ingest_job——返回 json!({"job_id","status":"pending"})(非 JobResponse)。
 */
export interface TriggerIngestResponse {
  job_id: string
  status: string
}

/**
 * LLM provider(GET/POST /teams/:tid/llm-providers)。
 * 对应 llm_providers.rs::ProviderResp——#[serde(rename_all = "snake_case")]。
 * GET 实际返回 Option<ProviderResp>(单条,null 或对象,非数组)。
 */
export interface LlmProvider {
  id: number
  provider_type: string
  base_url: string | null
  model: string
  context_size: number
  is_enabled: boolean
  has_key: boolean
}

/**
 * Search provider(GET/POST /teams/:tid/search-providers)。
 * 对应 search_providers.rs::ProviderResp——#[serde(rename_all = "snake_case")]。
 * GET 实际返回 Option<ProviderResp>(单条,null 或对象,非数组)。
 */
export interface SearchProvider {
  id: number
  provider_type: string
  base_url: string | null
  is_enabled: boolean
  has_key: boolean
}

/** wiki_pages DB 行（src-server 摄取只写 DB 不写 storage 文件）。 */
export interface WikiPage {
  id: number
  project_id: number
  path: string
  title: string | null
  content: string | null
  frontmatter: Record<string, unknown> | null
  page_type: string | null
  sources: unknown | null
  images: unknown | null
  created_at: string
  updated_at: string
}
