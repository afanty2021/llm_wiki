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
  mode: string                 // "keyword" | "vector" | "hybrid"
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
