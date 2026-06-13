# LLM Wiki Web 版架构设计文档

> **创建时间**: 2026-06-13
> **版本**: 1.0.0
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
│  PostgreSQL + 文件存储 + LanceDB + Redis                     │
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
│   ├── extractors/           # 自定义 extractors
│   │   ├── mod.rs
│   │   └── project.rs       # ProjectId extractor
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
│   ├── api-client.ts         # HTTP 客户端（新增）
│   └── extractors.ts         # 自定义类型提取器
└── stores/
    └── auth-store.ts         # Zustand 认证 store
```

#### 3.2.2 API 客户端设计

```typescript
// src/lib/api-client.ts
class ApiClient {
  private baseUrl: string;
  private token: string | null = null;

  constructor(baseUrl: string = '/api/v1') {
    this.baseUrl = baseUrl;
    // 从 localStorage 读取 token
    this.token = localStorage.getItem('auth_token');
  }

  // 通用请求方法（支持自动 token 刷新）
  private async request<T>(
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

    let response = await fetch(url, { ...options, headers });

    // 401 时尝试刷新 token 并重试
    if (response.status === 401 && this.hasRefreshToken()) {
      await this.refreshAccessToken();
      
      // 重试原请求
      headers['Authorization'] = `Bearer ${this.token}`;
      response = await fetch(url, { ...options, headers });
    }

    if (!response.ok) {
      throw new Error(`API Error: ${response.status}`);
    }

    return response.json();
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

  // 聊天流式
  async *chatStream(message: string, projectId: number): AsyncGenerator<string> {
    const response = await fetch(`${this.baseUrl}/chat/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({ message, project_id: projectId }),
    });

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
    wiki_page_id VARCHAR(255) NOT NULL,
    content VECTOR(1536),  -- OpenAI embedding 维度
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_embeddings_project ON embeddings(project_id);
CREATE INDEX idx_embeddings_content ON embeddings USING ivfflat (content vector_cosine_ops) WITH (lists = 100);

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
    生成 JWT token
    - Payload: {user_id, username, team_ids, exp}
    - Secret: 环境变量
           ↓
    返回 {token, user} 给前端
           ↓
    前端存储 token（localStorage）
           ↓
    后续请求携带 Authorization: Bearer {token}
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
// 自定义 extractor：从路径提取项目 ID
pub struct ProjectId(i32);

impl<S> FromRequestParts<S> for ProjectId
where
    S: Send + Sync,
{
    type Rejection = (StatusCode, String);

    async fn from_request_parts(
        parts: &mut Parts,
        _state: &S,
    ) -> Result<Self, Self::Rejection> {
        let uri = parts.uri.clone();
        let path = uri.path();
        
        // 从路径中提取项目 ID
        // 例如: /api/v1/projects/123/files
        let segments: Vec<&str> = path.split('/').collect();
        let project_id = segments
            .get(4)
            .and_then(|s| s.parse::<i32>().ok())
            .ok_or((StatusCode::BAD_REQUEST, "Invalid project ID".to_string()))?;
            
        Ok(ProjectId(project_id))
    }
}

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

// Handler 使用示例
pub async fn get_project_files(
    State(db): State<PgPool>,
    Auth(user): Auth<User>,
    ProjectId(project_id): ProjectId,  // 自定义 extractor
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
      test: ["CMD", "curl", "-f", "http://localhost:8080/health"]
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

# 构建前端
cd ../
npm run build

# 复制到 Nginx 目录
sudo cp -r dist/* /var/www/llm-wiki/

# 重启 Nginx
sudo systemctl reload nginx
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
| 权限中间件复杂度 | 低 | 使用自定义 extractor 模式 |

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

- API 服务无状态设计，支持多实例
- PostgreSQL 主从复制
- Redis 集群

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
        // 解码 cursor（base64 编码的 (id, created_at)）
        let (last_id, created_at) = decode_cursor(cursor)?;
        
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

```rust
// 简单的 base64 编码
fn encode_cursor<T: serde::Serialize>(data: T) -> String {
    let json = serde_json::to_string(&data).unwrap();
    base64::encode(json)
}

fn decode_cursor<T: serde::de::DeserializeOwned>(
    cursor: String,
) -> Result<T, Error> {
    let json = base64::decode(&cursor)?;
    serde_json::from_str(&json).map_err(|_| Error::InvalidCursor)
}
```

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
- 测试框架：`Playwright` 或 `Cypress`
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

## 附录

### A. 参考资料

- Axum 文档: https://docs.rs/axum/
- SQLx 文档: https://docs.rs/sqlx/
- JWT in Rust: https://github.com/Keats/jsonwebtoken
- PostgreSQL 文档: https://www.postgresql.org/docs/

### B. 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.1 | 2026-06-13 | 修复严重问题：1) 用 pgvector 替代 LanceDB（解决并发问题）2) JWT 短 TTL + 实时 DB 查询（解决成员变更）3) 权限检查改用 extractor。修复中等问题：1) 添加 refresh_tokens 表 2) API 客户端 token 自动刷新 3) Docker Compose 健康检查。添加分页设计和测试策略章节 |
| 1.0.0 | 2026-06-13 | 初始设计文档 |
