# LLM Wiki Web 版架构设计文档

> **创建时间**: 2026-06-13
> **版本**: 1.0.5
> **状态**: 设计阶段

---

## 1. 概述

### 1.1 目标

将 LLM Wiki 从 Tauri 桌面应用改造为 Web 应用，支持公司内网多用户访问，实现团队隔离的知识库管理。

### 1.2 设计原则

- **复用优先**：最大程度复用现有 React 前端和 Rust 后端代码
- **增量实施**：分阶段实现，先核心功能后高级功能
- **简单清晰**：三层架构，避免过度复杂
- **团队隔离**：支持多团队、多用户的知识库隔离

### 1.3 部署环境

- **部署位置**：公司内网（局域网）
- **访问方式**：内网 IP + 端口
- **用户模式**：团队隔离 + 团队内共享
- **现有数据**：本地版与 Web 版共存

---

## 2. 系统架构

### 2.1 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│                    前端层 (React)                            │
│  现有代码库 + 认证 UI + 团队管理 UI                         │
└─────────────────────────────────────────────────────────────┘
                          ↕ REST/HTTPS
┌─────────────────────────────────────────────────────────────┐
│                    API 层 (Rust HTTP)                        │
│  Axum 路由 + JWT 认证 + 权限中间件                          │
└─────────────────────────────────────────────────────────────┘
                          ↕
┌─────────────────────────────────────────────────────────────┐
│                    数据层                                    │
│  PostgreSQL + pgvector + 文件存储 + Redis                     │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 技术栈

| 层级 | 技术选型 | 说明 |
|------|---------|------|
| **前端** | React 19 + TypeScript + Vite | 复用现有代码 |
| **UI 框架** | shadcn/ui + Tailwind CSS v4 | 复用现有代码 |
| **状态管理** | Zustand | 复用现有代码，添加认证状态 |
| **HTTP 框架** | Axum | 异步、类型安全，与现有 Rust 代码兼容 |
| **数据库** | PostgreSQL (SQLx) + pgvector | 类型安全查询，向量存储 |
| **缓存/会话** | Redis | 会话管理和缓存 |
| **文件存储** | 本地文件系统 | 后续可扩展 MinIO |
| **向量数据库** | pgvector (PostgreSQL 扩展) | 支持高并发，避免嵌入式数据库锁问题 |
| **认证** | JWT (jsonwebtoken) | 无状态认证 |

---

## 3. 核心组件设计

### 3.1 Rust HTTP 服务端（新增）

#### 3.1.1 项目结构

```
src-server/                      # Rust HTTP 服务（独立于 Tauri）
├── src/
│   ├── main.rs              # HTTP 服务入口
│   ├── routes/              # API 路由
│   │   ├── mod.rs
│   │   ├── auth.rs          # 认证相关
│   │   ├── users.rs         # 用户管理
│   │   ├── teams.rs         # 团队管理
│   │   ├── projects.rs      # 项目管理
│   │   ├── files.rs         # 文件操作
│   │   ├── search.rs        # 搜索
│   │   ├── chat.rs          # LLM 聊天
│   │   └── graph.rs         # 知识图谱
│   ├── middleware/           # 中间件
│   │   ├── mod.rs
│   │   ├── auth.rs          # JWT 认证中间件
│   │   └── cors.rs          # CORS 处理
│   ├── extractors/           # Axum Path 提取 + 权限检查函数
│   │   ├── mod.rs
│   │   └── project.rs       # 项目权限检查辅助函数
│   ├── models/              # 数据模型
│   │   ├── mod.rs
│   │   ├── user.rs
│   │   ├── team.rs
│   │   └── project.rs
│   ├── services/            # 业务逻辑（复用现有代码）
│   │   ├── ingest.rs        # 摄取逻辑
│   │   ├── search.rs        # 搜索逻辑
│   │   ├── embedding.rs     # 向量嵌入（使用 pgvector）
│   │   └── graph.rs         # 图谱构建
│   └── db/                  # 数据库连接
│       ├── mod.rs
│       └── pool.rs
├── Cargo.toml
└── .env.example
```

#### 3.1.2 API 路由结构

```
/api/v1/
├── /auth              # 认证
│   ├── POST /login    # 登录
│   ├── POST /register # 注册
│   ├── POST /logout   # 登出
│   └── POST /refresh  # 刷新 token
├── /users             # 用户管理
│   ├── GET  /         # 获取当前用户信息
│   ├── PUT  /         # 更新用户信息
│   └── GET  /teams    # 获取用户所属团队
├── /teams             # 团队管理
│   ├── GET  /         # 获取团队列表
│   ├── POST /         # 创建团队
│   ├── GET  /:id      # 获取团队详情
│   ├── PUT  /:id      # 更新团队
│   ├── DELETE /:id     # 删除团队
│   └── POST /:id/members  # 添加成员
├── /projects          # 项目管理
│   ├── GET  /         # 获取项目列表（分页）
│   ├── POST /         # 创建项目
│   ├── GET  /:id      # 获取项目详情
│   ├── PUT  /:id      # 更新项目
│   └── DELETE /:id     # 删除项目
├── /files             # 文件操作
│   ├── GET    /:project_id/*path    # 读取文件
│   ├── POST   /:project_id/*path    # 写入文件
│   ├── GET    /:project_id/list/*path  # 列出目录
│   ├── DELETE /:project_id/*path    # 删除文件
│   └── POST   /:project_id/upload   # 上传文件
├── /search            # 搜索
│   ├── POST /         # 分词搜索
│   └── POST /vector   # 向量搜索
├── /chat              # LLM 聊天
│   ├── POST /stream   # 流式聊天
│   └── POST /message  # 单条消息
└── /graph             # 知识图谱
    ├── GET /:project_id      # 获取图谱数据
    └── GET /:project_id/insights  # 获取图洞察
```

### 3.2 React 前端（改造现有代码）

#### 3.2.1 新增文件

```
src/
├── components/auth/
│   ├── LoginPage.tsx         # 登录页面
│   ├── RegisterPage.tsx      # 注册页面（可选）
│   └── TeamSwitcher.tsx      # 团队切换器
├── lib/
│   └── api-client.ts         # HTTP 客户端（新增）
└── stores/
    └── auth-store.ts         # Zustand 认证 store
```

#### 3.2.2 API 客户端设计

```typescript
// src/lib/api-client.ts

// 错误响应类型（与 §15.1 格式对应）
// 使用 class（而非 interface）以支持 instanceof 运行时检查
class ApiError {
  code: string;
  message: string;
  details?: any;

  constructor(code: string, message: string, details?: any) {
    this.code = code;
    this.message = message;
    this.details = details;
  }
}

class ApiClient {
  private baseUrl: string;
  private token: string | null = null;

  constructor(baseUrl: string = '/api/v1') {
    this.baseUrl = baseUrl;
    // 从 localStorage 读取 token
    this.token = localStorage.getItem('auth_token');
  }

  // 内部方法：执行实际 HTTP 请求（不处理业务错误）
  private async fetch<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
      ...options.headers,
    };

    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    const response = await fetch(url, { ...options, headers });

    if (!response.ok) {
      const body = await response.json().catch(() => ({ code: 'UNKNOWN', message: 'Request failed' }));
      throw new ApiError(body.code, body.message, body.details);
    }

    return response.json();
  }

  // 公开方法：包含业务错误处理 + 自动 token 刷新
  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    try {
      return await this.fetch<T>(endpoint, options);
    } catch (error) {
      if (error instanceof ApiError) {
        switch (error.code) {
          case 'AUTH_EXPIRED':
            // 401 时尝试刷新 token 并重试一次
            await this.refreshAccessToken();
            return await this.fetch<T>(endpoint, options);
          case 'AUTH_INVALID':
            // Token 无效，清除本地状态并跳转登录
            localStorage.removeItem('auth_token');
            localStorage.removeItem('refresh_token');
            window.location.href = '/login';
            throw new Error('认证失效，请重新登录');
          case 'PERMISSION_DENIED':
            throw new Error('权限不足，请联系管理员');
          case 'RESOURCE_NOT_FOUND':
            throw new Error(error.message || '资源不存在');
          case 'VALIDATION_FAILED': {
            const fields = error.details?.errors
              ?.map((e: { field: string }) => e.field)
              .join(', ');
            throw new Error(`验证失败: ${fields}`);
          }
          default:
            throw new Error(error.message);
        }
      }
      throw error;
    }
  }

  private hasRefreshToken(): boolean {
    return !!localStorage.getItem('refresh_token');
  }

  private async refreshAccessToken(): Promise<void> {
    const refreshToken = localStorage.getItem('refresh_token');
    if (!refreshToken) {
      throw new Error('No refresh token available');
    }

    const response = await fetch(`${this.baseUrl}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });

    if (!response.ok) {
      // refresh token 也失效了，清除所有 token
      localStorage.removeItem('auth_token');
      localStorage.removeItem('refresh_token');
      throw new Error('Session expired');
    }

    const { token } = await response.json();
    this.token = token;
    localStorage.setItem('auth_token', token);
  }

  // 认证
  async login(username: string, password: string): Promise<{ token: string; refresh_token: string; user: User }> {
    const result = await this.request<{ token: string; refresh_token: string; user: User }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    this.token = result.token;
    localStorage.setItem('auth_token', result.token);
    localStorage.setItem('refresh_token', result.refresh_token);
    return result;
  }

  async logout(): Promise<void> {
    try {
      await this.request('/auth/logout', { method: 'POST' });
    } finally {
      this.token = null;
      localStorage.removeItem('auth_token');
      localStorage.removeItem('refresh_token');
    }
  }

  // 项目
  async getProjects(teamId?: number): Promise<Project[]> {
    const query = teamId ? `?team_id=${teamId}` : '';
    return this.request(`/projects${query}`);
  }

  async createProject(name: string, teamId: number): Promise<Project> {
    return this.request('/projects', {
      method: 'POST',
      body: JSON.stringify({ name, team_id: teamId }),
    });
  }

  // 文件上传（支持 token 刷新）
  async uploadFile(projectId: number, file: File): Promise<void> {
    const upload = async (): Promise<Response> => {
      const formData = new FormData();
      formData.append('file', file);

      return fetch(`${this.baseUrl}/files/${projectId}/upload`, {
        method: 'POST',
        headers: {
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        body: formData,
      });
    };

    let response = await upload();

    // 401 时尝试刷新 token 并重试
    if (response.status === 401 && this.hasRefreshToken()) {
      await this.refreshAccessToken();
      response = await upload();
    }

    if (!response.ok) {
      throw new Error(`Upload failed: ${response.status}`);
    }
  }

  // 搜索
  async search(query: string, projectId: number): Promise<SearchResult[]> {
    return this.request('/search', {
      method: 'POST',
      body: JSON.stringify({ query, project_id: projectId }),
    });
  }

  // 聊天流式（含 401 处理：刷新 token 后重新建立流，已消费内容不回放）
  async *chatStream(message: string, projectId: number): AsyncGenerator<string> {
    let response = await fetch(`${this.baseUrl}/chat/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({ message, project_id: projectId }),
    });

    // 401 时尝试刷新 token 并重试（流式重试不回放已消费内容）
    if (response.status === 401 && this.hasRefreshToken()) {
      await this.refreshAccessToken();
      response = await fetch(`${this.baseUrl}/chat/stream`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify({ message, project_id: projectId }),
      });
    }

    if (!response.ok) {
      const error: ApiError = await response.json().catch(() => ({ code: 'UNKNOWN', message: 'Stream request failed' }));
      throw new Error(error.message);
    }

    const reader = response.body?.getReader();
    const decoder = new TextDecoder();

    if (!reader) throw new Error('No response body');

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      yield decoder.decode(value);
    }
  }
}
```

#### 3.2.3 认证状态管理

```typescript
// src/stores/auth-store.ts
interface AuthState {
  user: User | null;
  token: string | null;
  currentTeam: Team | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  switchTeam: (team: Team) => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  token: null,
  currentTeam: null,
  login: async (username, password) => {
    const apiClient = new ApiClient();
    const { token, user } = await apiClient.login(username, password);
    set({ token, user });
  },
  logout: () => {
    localStorage.removeItem('auth_token');
    set({ user: null, token: null, currentTeam: null });
  },
  switchTeam: (team) => set({ currentTeam: team }),
}));
```

#### 3.2.4 Tauri 命令替换映射

| 原命令 | 新 API | 改动位置 |
|--------|--------|----------|
| `readFile` | `GET /files/{project_id}/{path}` | `src/commands/fs.ts` |
| `writeFile` | `POST /files/{project_id}/{path}` | `src/commands/fs.ts` |
| `listFiles` | `GET /files/{project_id}/list/{path}` | `src/commands/fs.ts` |
| `deleteFile` | `DELETE /files/{project_id}/{path}` | `src/commands/fs.ts` |
| `createProject` | `POST /projects` | `src/commands/project.ts` |
| `vectorSearch` | `POST /search/vector` | `src/commands/vectorstore.ts` |
| `ingestFile` | `POST /files/{project_id}/ingest` | 新增 |

---

## 4. 数据模型

### 4.1 数据库表设计（PostgreSQL）

```sql
-- 启用 pgvector 扩展
CREATE EXTENSION IF NOT EXISTS vector;

-- 用户表
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(100),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_users_username ON users(username);
CREATE INDEX idx_users_email ON users(email);

-- 团队表
CREATE TABLE teams (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    created_by INTEGER REFERENCES users(id),
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_teams_created_by ON teams(created_by);

-- 团队成员表
CREATE TABLE team_members (
    team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    role VARCHAR(20) NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
    joined_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (team_id, user_id)
);

CREATE INDEX idx_team_members_user ON team_members(user_id);

-- 项目（wiki）表
CREATE TABLE projects (
    id SERIAL PRIMARY KEY,
    team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    storage_path TEXT NOT NULL,
    created_by INTEGER REFERENCES users(id),
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(team_id, name)
);

CREATE INDEX idx_projects_team ON projects(team_id);
CREATE INDEX idx_projects_created_by ON projects(created_by);

-- 向量嵌入表（使用 pgvector）
CREATE TABLE embeddings (
    id SERIAL PRIMARY KEY,
    project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    wiki_page_id VARCHAR(255) NOT NULL,  -- 格式: {project_id}/wiki/{path}.md
    content VECTOR(1536),  -- OpenAI embedding 维度
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_embeddings_project ON embeddings(project_id);
CREATE INDEX idx_embeddings_content ON embeddings USING ivfflat (content vector_cosine_ops) WITH (lists = 100);
-- ⚠️ 索引参数调优建议:
-- - lists 参数应根据向量数量调整，通常设为 sqrt(rows) 或 rows/1000
-- - 示例：100 万向量 → lists=1000，10 万向量 → lists=316，1 万向量 → lists=100
-- - 过小会降低召回率，过大会降低查询性能
-- - 建议在实际部署前根据向量规模测试不同 lists 值

-- wiki_page_id 与文件系统路径映射:
-- wiki_page_id 格式: "{project_id}/wiki/entities/Alice.md"
-- 文件系统路径: "/data/storage/teams/{team_id}/projects/{project_id}/wiki/entities/Alice.md"
-- 两者一一对应，通过字符串拼接转换

-- 刷新令牌表
CREATE TABLE refresh_tokens (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    token_hash VARCHAR(255) UNIQUE NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    revoked_at TIMESTAMP DEFAULT NULL
);

CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX idx_refresh_tokens_expires ON refresh_tokens(expires_at) WHERE revoked_at IS NULL;

-- 活动日志表（可选）
CREATE TABLE activity_logs (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    action VARCHAR(50) NOT NULL,
    details JSONB,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_activity_logs_user ON activity_logs(user_id);
CREATE INDEX idx_activity_logs_project ON activity_logs(project_id);
```

### 4.2 文件存储结构

```
/data/storage/
├── teams/
│   ├── {team_id}/
│   │   ├── projects/
│   │   │   ├── {project_id}/
│   │   │   │   ├── sources/           # 原始文档
│   │   │   │   │   ├── file1.pdf
│   │   │   │   │   └── file2.docx
│   │   │   │   ├── wiki/              # 生成的 wiki
│   │   │   │   │   ├── index.md
│   │   │   │   │   ├── entities/
│   │   │   │   │   └── concepts/
│   │   │   │   └── cache/             # 摄取缓存
│   │   │   │       └── sha256_cache.json
│   │   │   │   
│   │   │   └── exports/              # 导出文件（可选）
```

### 4.3 Redis 数据结构

```redis
# JWT Token 黑名单
token_blacklist:{jti} = "1"  # TTL: token 剩余有效期

# 用户会话
user_session:{user_id} = {
  "current_team_id": 1,
  "last_login": "2026-06-13T00:00:00Z"
}

# 搜索结果缓存（可选）
search_cache:{project_id}:{query_hash} = {results_json}
TTL: 3600  # 1 小时
```

---

## 5. 认证与权限

### 5.1 认证流程

```
用户输入 → POST /api/v1/auth/login
           ↓
    验证用户名密码（bcrypt）
           ↓
    生成 JWT token（不含 team_ids）
    - Payload: {sub: user_id, username: exp, iat}
    - Access Token: 5 分钟 TTL
           ↓
    生成 Refresh Token（存储到数据库）
           ↓
    返回 {token, refresh_token, user} 给前端
           ↓
    前端存储 token（localStorage）
           ↓
    后续请求携带 Authorization: Bearer {token}
           ↓
    中间件验证 token 签名和有效期
           ↓
    Handler 从数据库实时查询用户权限
```

### 5.2 JWT Token 结构

**Access Token（5 分钟 TTL）**：
```json
{
  "sub": "user_id",
  "username": "alice",
  "exp": 1718000000,
  "iat": 1717919700
}
```

**注意**：token 中不包含 team_ids，每次请求从数据库实时查询用户所属团队，确保成员变更立即生效。

**Refresh Token（7 天 TTL）**：
- 存储在数据库 refresh_tokens 表
- 登录时返回，用于刷新 access token
- 支持 token 吊销（logout 时标记 revoked_at）

### 5.3 权限模型

#### 角色定义

| 角色 | 权限 |
|------|------|
| **owner** | - 删除团队<br>- 管理所有成员<br>- 创建/删除项目 |
| **admin** | - 添加/移除 member<br>- 创建项目<br>- 管理项目 |
| **member** | - 查看团队项目<br>- 上传文件<br>- 搜索<br>- 聊天 |

#### 权限检查示例

```rust
// 权限检查函数
async fn check_project_access(
    db: &PgPool,
    user_id: i32,
    project_id: i32,
) -> Result<(), (StatusCode, &'static str)> {
    let has_access = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(
            SELECT 1 FROM projects p
            JOIN team_members tm ON p.team_id = tm.team_id
            WHERE p.id = $1 AND tm.user_id = $2
        )"
    )
    .bind(project_id)
    .bind(user_id)
    .fetch_one(db)
    .await
    .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Database error"))?;

    if has_access {
        Ok(())
    } else {
        Err((StatusCode::FORBIDDEN, "无权限访问此项目"))
    }
}

// Handler 使用 Axum 原生 Path 提取
pub async fn get_project_files(
    State(db): State<PgPool>,
    Auth(user): Auth<User>,
    Path(project_id): Path<i32>,  // Axum 原生提取，直接使用
) -> Result<impl Reply, impl Reply> {
    // 检查权限
    check_project_access(&db, user.id, project_id).await?;
    
    // 业务逻辑
    let files = list_project_files(&db, project_id).await?;
    Ok(Json(files))
}

// 团队管理员权限检查
async fn check_team_admin(
    db: &PgPool,
    user_id: i32,
    team_id: i32,
) -> Result<(), (StatusCode, &'static str)> {
    let is_admin = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(
            SELECT 1 FROM team_members
            WHERE team_id = $1 AND user_id = $2
            AND role IN ('owner', 'admin')
        )"
    )
    .bind(team_id)
    .bind(user_id)
    .fetch_one(db)
    .await
    .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Database error"))?;

    if is_admin {
        Ok(())
    } else {
        Err((StatusCode::FORBIDDEN, "需要管理员权限"))
    }
}
```

---

## 6. 部署架构

### 6.1 内网部署方案

```
┌─────────────────────────────────────────────────────────────┐
│                    内网服务器                                │
│                    IP: 192.168.1.100                        │
├─────────────────────────────────────────────────────────────┤
│  Nginx (反向代理 + 静态文件) - 端口 80/443                 │
│  ├── /              → React 前端 (dist/)                   │
│  └── /api           → Rust API (localhost:8080)            │
├─────────────────────────────────────────────────────────────┤
│  Rust HTTP Service - 端口 8080                             │
│  ├── PostgreSQL - 端口 5432                                 │
│  ├── Redis - 端口 6379                                      │
│  └── 文件存储 (/data/storage)                              │
└─────────────────────────────────────────────────────────────┘
```

### 6.2 Nginx 配置

**HTTP（推荐用于内网测试）**：
```nginx
server {
    listen 80;
    server_name 192.168.1.100;

    # 前端静态文件
    location / {
        root /var/www/llm-wiki/dist;
        try_files $uri $uri/ /index.html;
    }

    # API 代理
    location /api {
        proxy_pass http://localhost:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # SSE 支持（聊天流式）
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_cache off;
    }
}
```

**HTTPS（生产环境推荐）**：
```nginx
server {
    listen 443 ssl http2;
    server_name 192.168.1.100;

    # 自签名证书（内网）
    ssl_certificate /etc/nginx/ssl/selfsigned.crt;
    ssl_certificate_key /etc/nginx/ssl/selfsigned.key;

    # 安全配置
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

    # 前端静态文件
    location / {
        root /var/www/llm-wiki/dist;
        try_files $uri $uri/ /index.html;
    }

    # API 代理
    location /api {
        proxy_pass http://localhost:8080;
        # ... 其余配置同上
    }
}

# HTTP 重定向到 HTTPS
server {
    listen 80;
    server_name 192.168.1.100;
    return 301 https://$server_name$request_uri;
}
```

**生成自签名证书**：
```bash
# 生成自签名证书（有效期 365 天）
openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout /etc/nginx/ssl/selfsigned.key \
  -out /etc/nginx/ssl/selfsigned.crt \
  -subj "/C=CN/ST=State/L=City/O=Company/CN=192.168.1.100"

# ⚠️ 注意：使用自签名证书时，浏览器会显示安全警告
# 用户需要手动点击"继续访问"或"接受风险"
# 如需避免警告，需要：
# 1. 配置内网 CA 服务器
# 2. 使用内网 CA 签发证书
# 3. 在所有用户设备上安装 CA 证书
```

### 6.3 Docker Compose 配置

```yaml
services:
  postgres:
    image: postgres:15
    environment:
      POSTGRES_DB: llmwiki
      POSTGRES_USER: llmwiki
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    ports:
      - "5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U llmwiki"]
      interval: 10s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5

  api:
    build: ./src-server
    environment:
      DATABASE_URL: postgresql://llmwiki:${DB_PASSWORD}@postgres/llmwiki
      REDIS_URL: redis://redis:6379
      JWT_SECRET: ${JWT_SECRET}
      STORAGE_PATH: /data/storage
    ports:
      - "8080:8080"
    volumes:
      - storage_data:/data/storage
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    healthcheck:
      # 使用 TCP probe 检查（Rust 容器无需 curl）
      test: ["CMD-SHELL", "timeout 5 bash -c 'cat < /dev/null > /dev/tcp/127.0.0.1/8080'"]
      interval: 30s
      timeout: 10s
      retries: 3

volumes:
  postgres_data:
  redis_data:
  storage_data:
```

### 6.4 环境变量

```bash
# .env
DATABASE_URL=postgresql://llmwiki:password@localhost/llmwiki
REDIS_URL=redis://localhost:6379
JWT_SECRET=your-super-secret-key-change-this
STORAGE_PATH=/data/storage
ALLOWED_ORIGINS=http://192.168.1.100

# 前端
VITE_API_BASE_URL=http://192.168.1.100/api
```

### 6.5 启动脚本

```bash
#!/bin/bash
# start.sh

# 启动 Docker 服务
docker-compose up -d

# 等待数据库就绪
echo "等待数据库启动..."
until docker-compose exec -T postgres pg_isready -U llmwiki; do
  sleep 1
done

# 运行数据库迁移
echo "运行数据库迁移..."
docker-compose exec -T api sqlx migrate run

# 构建前端
cd ../
npm run build

# 复制到 Nginx 目录
sudo cp -r dist/* /var/www/llm-wiki/

# 重启 Nginx
sudo systemctl reload nginx

echo "启动完成！访问 http://192.168.1.100"
```

---

## 7. 实施计划

### 7.1 开发阶段

| 阶段 | 内容 | 工期 |
|------|------|------|
| **Phase 1** | Rust HTTP 服务基础 + Axum 框架 + 项目结构 | 3 天 |
| **Phase 2** | 数据库设计 + 用户认证（JWT）+ 登录/登出 | 4 天 |
| **Phase 3** | 团队管理 + 项目管理 + 权限检查中间件 | 3 天 |
| **Phase 4** | 文件上传/下载 API + 文件存储服务 | 3 天 |
| **Phase 5** | 搜索 API + 聊天 API（流式） | 4 天 |
| **Phase 6** | 图谱 API + 向量搜索 API | 3 天 |
| **Phase 7** | 前端 API 客户端 + 认证 UI | 3 天 |
| **Phase 8** | 前端改造：替换 Tauri 命令 | 4 天 |
| **Phase 9** | 集成测试 + Bug 修复 | 3 天 |
| **Phase 10** | 部署配置 + 内网测试 | 2 天 |

**总工期**: 约 6-7 周

### 7.2 里程碑

| 里程碑 | 验收标准 |
|--------|----------|
| **M1: 认证完成** | 用户可以登录、查看团队列表 |
| **M2: 项目管理** | 可以创建项目、上传文件 |
| **M3: 核心功能** | 搜索、聊天、图谱功能可用 |
| **M4: 完整功能** | 所有功能集成测试通过 |
| **M5: 部署上线** | 内网部署完成，同事可访问 |

### 7.3 技术风险

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| Rust HTTP 框架学习曲线 | 中 | 选择 Axum（文档完善，社区活跃） |
| SSE 流式响应实现 | 低 | 参考 Tauri 现有实现 |
| 文件上传大文件处理 | 中 | 使用分片上传或流式处理 |
| pgvector 性能优化 | 中 | 评估向量规模，必要时考虑专业向量库 |
| 权限中间件复杂度 | 低 | 使用 Axum Path 提取 + 数据库查询模式 |

---

## 8. 本地版与 Web 版共存策略

### 8.1 数据导入/导出

```typescript
// 本地版 → Web 版
// 1. 本地版导出项目为 ZIP
// 2. Web 版导入 ZIP 并解析

// Web 版 → 本地版
// 1. Web 版导出项目为 ZIP
// 2. 本地版导入 ZIP
```

### 8.2 功能对比

| 功能 | 本地版 | Web 版 |
|------|--------|--------|
| 单用户 | ✅ | ❌ |
| 多用户协作 | ❌ | ✅ |
| 团队隔离 | ❌ | ✅ |
| 文件存储 | 本地 | 服务器 |
| 向量搜索 | ✅ | ✅ |
| 知识图谱 | ✅ | ✅ |
| 离线使用 | ✅ | ❌ |

### 8.3 同步策略（可选，后期实现）

```
本地版 → 同步服务 → Web 版
         ↓
    冲突解决策略
    - 时间戳优先
    - 用户选择
    - 保留两个版本
```

---

## 9. 安全考虑

### 9.1 认证安全

- ✅ JWT token 有效期控制（access: 5min, refresh: 7d）
- ✅ 短 TTL 确保成员变更立即生效（从数据库查询）
- ✅ 密码 bcrypt 哈希（salt rounds: 12）
- ✅ HTTPS 传输（内网可自签名证书，浏览器会警告）
- ✅ CORS 配置限制允许的源
- ✅ Refresh token 支持吊销（logout 时标记）

### 9.2 权限安全

- ✅ 所有 API 请求验证用户身份
- ✅ 项目访问权限检查
- ✅ 文件路径遍历防护
- ✅ SQL 注入防护（参数化查询）

### 9.3 数据安全

- ✅ 定期数据库备份
- ✅ 文件存储备份
- ✅ 敏感信息不记录日志

---

## 10. 性能优化

### 10.1 缓存策略

- Redis 缓存搜索结果（TTL: 1h）
- 静态资源 CDN（可选）
- 图谱数据缓存

### 10.2 数据库优化

- 适当的索引
- 连接池配置
- 慢查询监控

### 10.3 文件处理

- 大文件流式上传
- PDF 解析结果缓存
- 向量嵌入缓存

---

## 11. 监控与日志

### 11.1 日志

```rust
// 使用 tracing crate
use tracing::{info, warn, error};

info!(user_id = %user.id, "User logged in");
warn!(project_id = %id, "Project not found");
error!(error = %err, "Database query failed");
```

### 11.2 监控指标

- API 响应时间
- 数据库查询时间
- 文件上传成功率
- 活跃用户数

---

## 12. 扩展性

### 12.1 水平扩展

**单实例部署（初始配置）**：
- API 服务：1 实例
- 文件存储：本地 `/data/storage`（Docker volume）
- 适用场景：团队 < 20 人，日活 < 100

**水平扩展部署（高负载配置）**：
- API 服务：多实例负载均衡
- 文件存储：MinIO 或 NFS 共享存储
- 适用场景：团队 > 20 人，或需要高可用

**MinIO 配置示例**：
```yaml
# docker-compose.yml (高负载版本)
services:
  minio:
    image: minio/minio
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: minio
      MINIO_ROOT_PASSWORD: ${MINIO_PASSWORD}
    volumes:
      - minio_data:/data
    ports:
      - "9000:9000"
      - "9001:9001"
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:9000/minio/health/live"]
      interval: 30s
      timeout: 20s
      retries: 3

  api:
    environment:
      # 使用 MinIO 替代本地文件系统
      STORAGE_TYPE: s3
      S3_ENDPOINT: http://minio:9000
      S3_ACCESS_KEY: minio
      S3_SECRET_KEY: ${MINIO_PASSWORD}
      S3_BUCKET: llmwiki-storage
      S3_REGION: us-east-1
```

### 12.2 功能扩展

- Web Clipper 功能保留
- Deep Research 功能保留
- 定时导入功能保留
- API Rate Limiting
- 审计日志

---

## 13. 分页设计

### 13.1 列表 API 分页参数

所有列表类 API 支持分页，使用 cursor-based 分页：

```typescript
// 请求参数
interface PaginationParams {
  cursor?: string;      // 上一页返回的 cursor
  limit?: number;       // 每页数量，默认 20，最大 100
}

// 响应格式
interface PaginatedResponse<T> {
  items: T[];
  next_cursor: string | null;  // 下一页 cursor，null 表示无更多
  has_more: boolean;           // 是否有更多数据
  total: number;               // 总数（可选，用于显示）
}
```

### 13.2 分页实现示例

**获取团队项目列表**：
```rust
// GET /api/v1/teams/:team_id/projects?cursor=xxx&limit=20
pub async fn get_team_projects(
    State(db): State<PgPool>,
    Auth(user): Auth<User>,
    Path(team_id): Path<i32>,
    Query(params): Query<PaginationParams>,
) -> Result<impl Reply, impl Reply> {
    // 权限检查
    check_team_member(&db, user.id, team_id).await?;

    let limit = params.limit.unwrap_or(20).min(100);
    
    let projects = if let Some(cursor) = params.cursor {
        // 解码 cursor（hex 编码的 (id, created_at)）
        let (last_id, created_at) = decode_cursor(&cursor)?;
        
        sqlx::query!(
            "SELECT id, name, storage_path, created_at
             FROM projects
             WHERE team_id = $1 AND (id, created_at) > ($2, $3)
             ORDER BY id ASC, created_at ASC
             LIMIT $4",
            team_id, last_id, created_at, limit as i64
        )
        .fetch_all(&db)
        .await?
    } else {
        sqlx::query!(
            "SELECT id, name, storage_path, created_at
             FROM projects
             WHERE team_id = $1
             ORDER BY id ASC, created_at ASC
             LIMIT $2",
            team_id, limit as i64
        )
        .fetch_all(&db)
        .await?
    };

    let next_cursor = projects
        .last()
        .map(|p| encode_cursor((p.id, p.created_at)));

    let response = PaginatedResponse {
        items: projects,
        next_cursor,
        has_more: next_cursor.is_some(),
        total: sqlx::query_scalar("SELECT COUNT(*) FROM projects WHERE team_id = $1")
            .bind(team_id)
            .fetch_one(&db)
            .await?,
    };

    Ok(Json(response))
}
```

### 13.3 Cursor 编解码

**方案：使用 hex 编码（推荐）**

```rust
use serde::{Serialize, Deserialize};
use hex::{ToHex, FromHex};

// 编码：序列化为 JSON → hex 编码
fn encode_cursor<T: serde::Serialize>(data: &T) -> String {
    let json = serde_json::to_vec(data).unwrap();
    json.to_hex() // 将 json 字节数组编码为 hex 字符串
}

// 解码：hex 解码 → 反序列化
fn decode_cursor<T: serde::de::DeserializeOwned>(
    cursor: &str,
) -> Result<T, Error> {
    let bytes = Vec::from_hex(cursor)
        .map_err(|_| Error::InvalidCursor)?;
    serde_json::from_slice(&bytes)
        .map_err(|_| Error::InvalidCursor)
}

// 错误类型定义
#[derive(Debug)]
pub enum Error {
    InvalidCursor,
    // ... 其他错误
}
```

**优势**：
- ✅ 无需处理 base64 padding 字符
- ✅ hex 字符串 URL 安全
- ✅ 实现简单，不易出错

---

## 14. 测试策略

### 14.1 单元测试

**Rust 后端**：
- 测试框架：`cargo test` + `tokio::test`
- 覆盖目标：
  - 所有 extractor 和权限检查函数
  - 数据库查询逻辑
  - 业务逻辑函数（嵌入、搜索）
- 工具：`tarpaulin` 生成覆盖率报告

```rust
#[cfg(test)]
mod tests {
    use super::*;
    
    #[tokio::test]
    async fn test_check_project_access() {
        // 测试有权限的用户
        assert!(check_project_access(&db, user1.id, project1.id).await.is_ok());
        
        // 测试无权限的用户
        assert!(check_project_access(&db, user2.id, project1.id).await.is_err());
    }
}
```

**React 前端**：
- 测试框架：`vitest`（已配置）
- 覆盖目标：
  - ApiClient 方法
  - auth-store 状态管理逻辑
  - 认证组件快照测试
- 工具：`@testing-library/react` + `@testing-library/user-event`

```typescript
describe('ApiClient', () => {
  it('should login successfully', async () => {
    const client = new ApiClient();
    const result = await client.login('alice', 'password');
    expect(result.token).toBeTruthy();
    expect(localStorage.getItem('auth_token')).toBe(result.token);
  });
});
```

### 14.2 集成测试

**API 集成测试**：
- 测试框架：`axum::test` + `reqwest`
- 覆盖场景：
  - 完整的认证流程（登录 → 刷新 token → 登出）
  - 文件上传 → 摄取 → 搜索
  - 权限边界测试

```rust
#[tokio::test]
async fn test_auth_flow() {
    let app = create_app().await;
    
    // 登录
    let response = app
        .oneshot(Request::builder()
            .uri("/auth/login")
            .body(Body::from(json!({"username": "alice", "password": "pass"})))
            .unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    
    // 使用 token 访问受保护资源
    let token = extract_token(response).await;
    let response = app
        .oneshot(Request::builder()
            .uri("/teams")
            .header("Authorization", format!("Bearer {}", token))
            .body(Body::empty())
            .unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
}
```

### 14.3 E2E 测试

**端到端测试**：
- **测试框架选择：Playwright**
  - 选择原因：更好的 TypeScript 支持、并行测试能力、稳定的跨浏览器特性
  - 与 vitest 生态集成良好

- 覆盖场景：
  - 用户登录 → 创建团队 → 创建项目 → 上传文件 → 搜索
  - 多用户协作（不同权限）
  - Token 过期自动刷新

```typescript
test('complete wiki workflow', async ({ page }) => {
  // 登录
  await page.goto('http://localhost:3000');
  await page.fill('[name="username"]', 'alice');
  await page.fill('[name="password"]', 'password');
  await page.click('[type="submit"]');
  
  // 创建团队
  await page.click('text=创建团队');
  await page.fill('[name="team_name"]', 'Test Team');
  await page.click('text=确认');
  
  // 创建项目
  await page.click('text=新建项目');
  await page.fill('[name="project_name"]', 'Test Wiki');
  await page.click('text=创建');
  
  // 上传文件
  const fileInput = await page.input('input[type="file"]');
  await fileInput.setInputFiles('test.pdf');
  await page.click('text=上传');
  
  // 搜索
  await page.fill('[placeholder="搜索..."]', 'test query');
  await page.press('[placeholder="搜索..."]', 'Enter');
  await expect(page.locator('.search-results')).toBeVisible();
});
```

### 14.4 测试覆盖率目标

| 层级 | 覆盖率目标 | 优先级 |
|------|-----------|--------|
| 核心业务逻辑（权限、认证） | 90%+ | 高 |
| API handler | 80%+ | 高 |
| 前端 ApiClient | 80%+ | 中 |
| UI 组件 | 60%+ | 中 |
| 工具函数 | 70%+ | 低 |

---

## 15. API 错误响应规范

### 15.1 统一错误格式

所有 API 错误响应使用统一的 JSON 格式：

```typescript
// 标准错误响应
interface ErrorResponse {
  error: {
    code: string;        // 错误码（机器可读）
    message: string;      // 错误消息（人类可读）
    details?: {           // 可选的详细信息
      field?: string;     // 验证错误字段名
      value?: any;        // 验证错误的值
      constraint?: string; // 约束说明
    };
    stack_trace?: string; // 开发环境堆栈跟踪
  };
}
```

### 15.2 错误码定义

```rust
// 错误码常量
pub const ERR_AUTH_INVALID: &str = "AUTH_INVALID";
pub const ERR_AUTH_EXPIRED: &str = "AUTH_EXPIRED";
pub const ERR_PERMISSION_DENIED: &str = "PERMISSION_DENIED";
pub const ERR_RESOURCE_NOT_FOUND: &str = "RESOURCE_NOT_FOUND";
pub const ERR_VALIDATION_FAILED: &str = "VALIDATION_FAILED";
pub const ERR_DATABASE_ERROR: &str = "DATABASE_ERROR";
pub const ERR_FILE_UPLOAD_FAILED: &str = "FILE_UPLOAD_FAILED";
pub const ERR_LLM_API_ERROR: &str = "LLM_API_ERROR";

// 使用示例
pub async fn get_project(
    State(db): State<PgPool>,
    Auth(user): Auth<User>,
    Path(id): Path<i32>,
) -> Result<impl Reply, impl Reply> {
    let project = match sqlx::query!("SELECT * FROM projects WHERE id = $1", id)
        .fetch_optional(&db)
        .await
    {
        Ok(Some(p)) => p,
        Ok(None) => {
            return Ok(Json(json!({
                "error": {
                    "code": ERR_RESOURCE_NOT_FOUND,
                    "message": format!("项目 {} 不存在", id)
                }
            }))).into_response());
        }
        Err(e) => {
            return Ok(Json(json!({
                "error": {
                    "code": ERR_DATABASE_ERROR,
                    "message": "数据库查询失败",
                    "stack_trace": Some(e.to_string())
                }
            }))).into_response());
        }
    };
    
    // ...
}
```

### 15.3 验证错误响应

字段级验证错误包含详细字段信息：

```json
// 400 Bad Request - 验证失败示例
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "请求参数验证失败",
    "details": {
      "errors": [
        {
          "field": "username",
          "value": "",
          "constraint": "不能为空"
        },
        {
          "field": "email",
          "value": "invalid-email",
          "constraint": "必须是有效的邮箱地址"
        }
      ]
    }
  }
}
```

### 15.4 HTTP 状态码映射

| HTTP 状态 | 错误码 | 场景 |
|----------|--------|------|
| 400 | VALIDATION_FAILED | 请求参数验证失败 |
| 401 | AUTH_INVALID | Token 无效或缺失 |
| 401 | AUTH_EXPIRED | Token 已过期 |
| 403 | PERMISSION_DENIED | 权限不足 |
| 404 | RESOURCE_NOT_FOUND | 资源不存在 |
| 409 | RESOURCE_CONFLICT | 资源冲突（如重复创建） |
| 413 | PAYLOAD_TOO_LARGE | 文件过大 |
| 500 | DATABASE_ERROR | 数据库错误 |
| 500 | LLM_API_ERROR | LLM API 调用失败 |
| 500 | INTERNAL_ERROR | 其他内部错误 |

### 15.5 前端错误处理

错误处理逻辑已集成在 ApiClient 中（见 §3.2.2）。`fetch()` 抛出结构化 `ApiError`，`request()` 按错误码路由：

| 错误码 | 处理策略 |
|--------|---------|
| `AUTH_EXPIRED` | 自动 refresh token → 重试一次 |
| `AUTH_INVALID` | 清除本地 token → 跳转登录页 |
| `PERMISSION_DENIED` | 显示提示"权限不足，请联系管理员" |
| `VALIDATION_FAILED` | 显示具体字段验证错误 |
| `RESOURCE_NOT_FOUND` | 显示"资源不存在" |
| 其他 | 显示 `error.message` |

> **注**：`ApiError` 使用 `class`（而非 `interface`）定义以支持 `instanceof` 运行时检查（见 §3.2.2）。

---

## 16. LLM Provider 配置

### 16.1 支持的 LLM Provider

Web 版支持与桌面版相同的 LLM provider：

- **OpenAI**: GPT-4o, GPT-4o-mini, o1（需要 API key）
- **Anthropic**: Claude 3.5 Sonnet, Claude 3.5 Haiku（需要 API key）
- **Google**: Gemini Pro, Gemini Flash（需要 API key）
- **Ollama**: 本地部署模型（内网推荐）
- **自定义**: OpenAI-compatible API（如 Azure OpenAI）

### 16.2 配置存储

LLM provider 配置存储在数据库中，每个团队可以独立配置：

```sql
-- LLM Provider 配置表
CREATE TABLE llm_providers (
    id SERIAL PRIMARY KEY,
    team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
    provider_type VARCHAR(50) NOT NULL,  -- 'openai', 'anthropic', 'ollama', 'custom'
    api_key TEXT,                         -- 加密存储
    base_url TEXT,                        -- 自定义 endpoint
    model VARCHAR(100) NOT NULL,
    is_default BOOLEAN DEFAULT FALSE,     -- 是否为该 provider 的默认配置
    config JSONB,                         -- 其他配置
    created_by INTEGER REFERENCES users(id),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(team_id, provider_type, model)  -- 允许同一 provider 配置多个模型
);

-- 注意：is_default 在 DB 级别不强制唯一。应用层需确保：
-- 1. 设置默认时，先 UPDATE 同 (team_id, provider_type) 的其他行 SET is_default = FALSE
-- 2. 查询默认模型时取 WHERE is_default = TRUE LIMIT 1
-- 3. 注册页/API 不依赖 is_default 自动选择 — 应由用户或团队管理员显式指定

CREATE INDEX idx_llm_providers_team ON llm_providers(team_id);
CREATE INDEX idx_llm_providers_default ON llm_providers(team_id, provider_type) WHERE is_default = TRUE;
```

**配置加密**：
```rust
// API key 使用 AES-256-GCM 加密
// Cargo.toml 依赖：
// aes-gcm = "0.10"
// rand = "0.8"

use aes_gcm::{Aes256Gcm, Key, Nonce};
use rand::Rng;
use base64::{Engine as _, engine::general_purpose::STANDARD};

pub fn encrypt_api_key(key: &str, secret: &[u8; 32]) -> String {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(secret));
    
    // 生成随机 nonce（每次加密必须不同）
    let mut nonce_bytes = [0u8; 12];
    rand::thread_rng().fill(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    
    let ciphertext = cipher.encrypt(nonce, key.as_bytes(), &[]).unwrap();
    
    // 将 nonce + 密文一起编码（nonce 需要存储以供解密）
    let mut combined = nonce_bytes.to_vec();
    combined.extend_from_slice(&ciphertext);
    STANDARD.encode(&combined)
}

pub fn decrypt_api_key(encrypted: &str, secret: &[u8; 32]) -> Result<String, String> {
    let combined = STANDARD.decode(encrypted).map_err(|_| "Invalid base64")?;
    
    if combined.len() < 12 {
        return Err("Invalid encrypted data".to_string());
    }
    
    let (nonce_bytes, ciphertext) = combined.split_at(12);
    let nonce = Nonce::from_slice(nonce_bytes);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(secret));
    
    cipher
        .decrypt(nonce, ciphertext, &[])
        .map(|bytes| String::from_utf8_lossy(&bytes).to_string())
        .map_err(|_| "Decryption failed".to_string())
}
```

### 16.3 内网部署 LLM 方案

#### 方案 A：Ollama（推荐）

**优势**：
- ✅ 完全离线运行
- ✅ 无 API key 管理
- ✅ 数据不出内网
- ✅ 免费

**部署示例**：
```bash
# 在内网服务器部署 Ollama
docker run -d --gpus all -p 11434:11434 \
  -v ollama:/root/.ollama \
  ollama/ollama

# 拉取模型
docker exec ollama ollama pull llama3.1
docker exec ollama ollama pull qwen2.5

# API 配置
# provider_type: 'ollama'
# base_url: 'http://ollama:11434'
# model: 'llama3.1'
```

#### 方案 B：HTTP Proxy

如果需要访问外部 API（如 OpenAI），配置 HTTP Proxy：

```bash
# 环境变量
HTTP_PROXY=http://proxy.company.com:8080
HTTPS_PROXY=http://proxy.company.com:8080
NO_PROXY=localhost,127.0.0.1,.company.com

# 或在 Docker Compose 中
api:
  environment:
    HTTP_PROXY: http://proxy.company.com:8080
    HTTPS_PROXY: http://proxy.company.com:8080
```

### 16.4 LLM 调用流程

```
用户操作 → 获取团队 LLM 配置（从数据库）
          ↓
    解密 API key（如需要）
          ↓
    调用 LLM API（OpenAI/Anthropic/Ollama）
          ↓
    返回结果给用户
```

### 16.5 配置界面

前端提供 LLM 配置管理界面：

```
设置 → LLM Provider → 添加 Provider
  - Provider Type: [OpenAI | Anthropic | Ollama | 自定义]
  - API Key: ********（加密存储）
  - Base URL: https://api.openai.com/v1（或自定义）
  - Model: gpt-4o（或自定义）
  - 高级配置:
    - Temperature: 0.7
    - Max Tokens: 4096
    - Timeout: 60s
```

---

## 附录

### A. 参考资料

- Axum 文档: https://docs.rs/axum/
- SQLx 文档: https://docs.rs/sqlx/
- JWT in Rust: https://github.com/Keats/jsonwebtoken
- PostgreSQL 文档: https://www.postgresql.org/docs/

### B. 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.5 | 2026-06-13 | 修复代码示例细节：1) ApiError 改为 class（支持 instanceof）2) 添加 AUTH_INVALID 和 RESOURCE_NOT_FOUND 错误处理 case |
| 1.0.4 | 2026-06-13 | 修复一致性问题：1) §3.2.2 与 §15.5 ApiClient 统一为 fetch()+request() 分层 2) chatStream 添加 401 刷新 3) 移除废弃 extractor 引用（改用 Axum Path） 4) is_default 标注应用层唯一约束规则 |
| 1.0.3 | 2026-06-13 | 修复安全问题：1) AES nonce 改为随机生成（避免硬编码）。修复一致性问题：1) 架构图同步更新为 pgvector 2) llm_providers 支持多模型配置 3) cursor hex 编码修复代码错误 4) 更新注释为 hex 5) 错误处理示例与 ApiClient 设计一致 |
| 1.0.2 | 2026-06-13 | 完善实施细节：1) 添加 pgvector 索引参数调优说明 2) 移除未使用的 extractors.ts 引用 3) 启动脚本添加数据库迁移步骤 4) cursor codec 改用 hex 编码 5) E2E 测试明确选择 Playwright |
| 1.0.1 | 2026-06-13 | 修复严重问题：1) 用 pgvector 替代 LanceDB（解决并发问题）2) JWT 短 TTL + 实时 DB 查询（解决成员变更）3) 权限检查改用 extractor。修复中等问题：1) 添加 refresh_tokens 表 2) API 客户端 token 自动刷新 3) Docker Compose 健康检查。添加分页设计和测试策略章节 |
| 1.0.0 | 2026-06-13 | 初始设计文档 |
