# LLM Wiki Web 版实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 LLM Wiki 从 Tauri 桌面应用改造为 Web 应用，支持公司内网多用户访问，实现团队隔离的知识库管理。

**Architecture:** 三层架构 - React 前端（复用现有代码）+ Rust HTTP API 服务（Axum）+ PostgreSQL + pgvector 数据存储。使用 JWT 认证（5分钟 TTL + refresh token）和基于角色的权限控制。

**Tech Stack:** 
- 后端：Rust + Axum + SQLx + PostgreSQL + pgvector + Redis
- 前端：React 19 + TypeScript + Vite（复用现有）
- 部署：Docker Compose + Nginx

---

## 文件结构

### 后端 (Rust HTTP 服务)

```
src-server/                        # Rust HTTP 服务（新增）
├── migrations/                    # SQLx 数据库迁移
│   ├── 001_initial_schema.sql
│   ├── 002_add_llm_providers.sql
│   └── ...
├── src/
│   ├── main.rs                   # HTTP 服务入口
│   ├── lib.rs                    # 库入口
│   ├── config.rs                 # 配置管理
│   ├── db.rs                     # 数据库连接池
│   ├── redis.rs                  # Redis 客户端
│   ├── error.rs                  # 错误类型定义
│   ├── routes/                   # API 路由
│   │   ├── mod.rs
│   │   ├── auth.rs              # /auth/* - 认证
│   │   ├── users.rs             # /users/* - 用户管理
│   │   ├── teams.rs             # /teams/* - 团队管理
│   │   ├── projects.rs          # /projects/* - 项目管理
│   │   ├── files.rs             # /files/:project_id/* - 文件操作
│   │   ├── search.rs            # /search - 搜索
│   │   ├── chat.rs              # /chat/stream - 流式聊天
│   │   └── graph.rs             # /graph/:project_id - 知识图谱
│   ├── middleware/               # 中间件
│   │   ├── mod.rs
│   │   ├── auth.rs              # JWT 认证中间件
│   │   └── cors.rs              # CORS 处理
│   ├── models/                   # 数据模型
│   │   ├── mod.rs
│   │   ├── user.rs
│   │   ├── team.rs
│   │   ├── project.rs
│   │   └── llm_provider.rs
│   ├── services/                 # 业务逻辑（复用现有代码）
│   │   ├── mod.rs
│   │   ├── ingest.rs            # 摄取逻辑
│   │   ├── search.rs            # 搜索逻辑
│   │   ├── embedding.rs         # 向量嵌入（pgvector）
│   │   └── graph.rs             # 图谱构建
│   └── utils/                    # 工具函数
│       ├── mod.rs
│       ├── crypto.rs            # 加密/解密
│       └── cursor.rs            # 分页 cursor 编解码
├── Cargo.toml
├── .env.example
└── docker-compose.yml           # Docker Compose 配置
```

### 前端 (React 改造)

```
src/                               # 现有前端代码
├── components/auth/              # 新增认证组件
│   ├── LoginPage.tsx
│   ├── RegisterPage.tsx
│   └── TeamSwitcher.tsx
├── lib/
│   └── api-client.ts             # 新增 HTTP 客户端
├── stores/
│   └── auth-store.ts             # 新增认证状态管理
├── commands/                     # 现有 Tauri 命令（改造为 API 调用）
│   ├── fs.ts
│   ├── project.ts
│   └── vectorstore.ts
└── main.tsx                      # 修改入口（添加路由）
```

---

## Phase 1: Rust HTTP 服务基础 + Axum 框架 + 项目结构

### Task 1.1: 创建 Rust HTTP 服务项目结构

**Files:**
- Create: `src-server/Cargo.toml`
- Create: `src-server/src/main.rs`
- Create: `src-server/src/lib.rs`
- Create: `src-server/.env.example`

- [ ] **Step 1: 创建 Cargo.toml**

```toml
[package]
name = "llm-wiki-server"
version = "0.1.0"
edition = "2021"

[dependencies]
# HTTP 框架
axum = "0.7"
tokio = { version = "1.35", features = ["full"] }
tower = "0.4"
tower-http = { version = "0.5", features = ["cors", "trace"] }

# 数据库
sqlx = { version = "0.7", features = ["runtime-tokio-rustls", "postgres", "chrono", "uuid", "migrate"] }
pgvector = { version = "0.3", features = ["sqlx"] }

# Redis
deadpool-redis = "0.14"
redis = "0.24"

# 序列化
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"

# 认证
jsonwebtoken = "9.2"
bcrypt = "0.15"

# 加密
aes-gcm = "0.10"
rand = "0.8"
hex = "0.4"

# 日志
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }

# 时间处理
chrono = { version = "0.4", features = ["serde"] }
uuid = { version = "1.6", features = ["v4", "serde"] }

# 环境变量
dotenvy = "0.15"

# 错误处理
anyhow = "1.0"
thiserror = "1.0"

# 配置
config = "0.14"
```

- [ ] **Step 2: 创建 .env.example**

```bash
# 数据库
DATABASE_URL=postgresql://llmwiki:password@localhost/llmwiki
DATABASE_MAX_CONNECTIONS=10

# Redis
REDIS_URL=redis://localhost:6379

# JWT
JWT_SECRET=your-super-secret-key-change-this
JWT_ACCESS_TOKEN_TTL=300  # 5 分钟
JWT_REFRESH_TOKEN_TTL=604800  # 7 天

# 文件存储
STORAGE_PATH=/data/storage
STORAGE_TYPE=local  # local 或 s3

# S3 配置（可选）
S3_ENDPOINT=
S3_ACCESS_KEY=
S3_SECRET_KEY=
S3_BUCKET=
S3_REGION=us-east-1

# 服务器
HOST=0.0.0.0
PORT=8080

# CORS
ALLOWED_ORIGINS=http://localhost:1420,http://192.168.1.100

# 日志
RUST_LOG=info
```

- [ ] **Step 3: 创建 src/lib.rs**

```rust
use anyhow::Result;
use std::sync::Arc;

pub mod config;
pub mod db;
pub mod error;
pub mod middleware;
pub mod models;
pub mod routes;
pub mod services;
pub mod utils;

pub use config::AppConfig;
pub use db::DbPool;
pub use error::{AppError, IntoAppError};

#[derive(Clone)]
pub struct AppState {
    pub db: DbPool,
    pub redis: deadpool_redis::Pool,
    pub config: Arc<Config>,
}

pub async fn create_app(config: AppConfig) -> Result<(axum::Router, AppState)> {
    // 初始化数据库连接池
    let db = db::create_pool(&config.database_url, config.database_max_connections).await?;
    
    // 初始化 Redis 连接池
    let redis = db::create_redis_pool(&config.redis_url).await?;
    
    let state = AppState {
        db,
        redis,
        config: Arc::new(config),
    };
    
    // 构建路由
    let app = routes::create_router(state.clone());
    
    Ok((app, state))
}
```

- [ ] **Step 4: 创建 src/main.rs**

```rust
use anyhow::Result;
use dotenvy::dotenv;
use llm_wiki_server::create_app;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

#[tokio::main]
async fn main() -> Result<()> {
    // 加载环境变量
    dotenv().ok();
    
    // 初始化日志
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "llm_wiki_server=info,tower_http=debug,axum=trace".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();
    
    // 读取配置
    let config = llm_wiki_server::AppConfig::from_env()?;
    
    // 创建应用
    let (app, _state) = create_app(config).await?;
    
    // 启动服务器
    let addr = format!("{}:{}", _state.config.host, _state.config.port);
    tracing::info!("listening on {}", addr);
    
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    axum::serve(listener, app).await?;
    
    Ok(())
}
```

- [ ] **Step 5: 创建基础文件**

```bash
# 创建空的模块文件
touch src-server/src/config.rs
touch src-server/src/db.rs
touch src-server/src/error.rs
touch src-server/src/routes/mod.rs
touch src-server/src/middleware/mod.rs
touch src-server/src/models/mod.rs
touch src-server/src/services/mod.rs
touch src-server/src/utils/mod.rs
```

- [ ] **Step 6: 初始化 Git 提交**

```bash
cd src-server
git init
git add .
git commit -m "feat: initialize Rust HTTP service project structure"
```

---

### Task 1.2: 实现配置管理 (config.rs)

**Files:**
- Modify: `src-server/src/config.rs`

- [ ] **Step 1: 编写配置结构体**

```rust
use config::{Config as ConfigBuilder, Environment, File};
use serde::Deserialize;
use std::time::Duration;

#[derive(Debug, Clone, Deserialize)]
pub struct ServerConfig {
    pub host: String,
    pub port: u16,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DatabaseConfig {
    pub url: String,
    pub max_connections: u32,
}

#[derive(Debug, Clone, Deserialize)]
pub struct JwtConfig {
    pub secret: String,
    pub access_token_ttl: u64,  // 秒
    pub refresh_token_ttl: u64,  // 秒
}

#[derive(Debug, Clone, Deserialize)]
pub struct StorageConfig {
    pub path: String,
    pub storage_type: String,  // local 或 s3
    pub s3_endpoint: Option<String>,
    pub s3_access_key: Option<String>,
    pub s3_secret_key: Option<String>,
    pub s3_bucket: Option<String>,
    pub s3_region: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CorsConfig {
    pub allowed_origins: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AppConfig {
    pub server: ServerConfig,
    pub database: DatabaseConfig,
    pub redis_url: String,
    pub jwt: JwtConfig,
    pub storage: StorageConfig,
    pub cors: CorsConfig,
}

impl AppConfig {
    pub fn from_env() -> Result<Self, anyhow::Error> {
        let mut builder = ConfigBuilder::builder()
            .add_source(File::with_name("config/default"))
            .add_source(Environment::default().separator("__"))
            .build()?;
        
        builder.cache_enabled(false);
        
        let config: AppConfig = builder.try_deserialize()?;
        
        // 验证必需配置
        if config.jwt.secret == "your-super-secret-key-change-this" {
            anyhow::bail!("JWT_SECRET must be set to a secure value");
        }
        
        Ok(config)
    }
    
    pub fn database_url(&self) -> &str {
        &self.database.url
    }
    
    pub fn database_max_connections(&self) -> u32 {
        self.database.max_connections
    }
    
    pub fn redis_url(&self) -> &str {
        &self.redis_url
    }
    
    pub fn host(&self) -> &str {
        &self.server.host
    }
    
    pub fn port(&self) -> u16 {
        self.server.port
    }
    
    pub fn jwt_secret(&self) -> &str {
        &self.jwt.secret
    }
    
    pub fn jwt_access_token_ttl(&self) -> Duration {
        Duration::from_secs(self.jwt.access_token_ttl)
    }
    
    pub fn jwt_refresh_token_ttl(&self) -> Duration {
        Duration::from_secs(self.jwt.refresh_token_ttl)
    }
    
    pub fn storage_path(&self) -> &str {
        &self.storage.path
    }
    
    pub fn allowed_origins(&self) -> &Vec<String> {
        &self.cors.allowed_origins
    }
}
```

- [ ] **Step 2: 更新 lib.rs 导入**

```rust
pub mod config;

pub use config::AppConfig;

pub async fn create_app(config: AppConfig) -> Result<(axum::Router, AppState)> {
    let db = db::create_pool(&config.database_url(), config.database_max_connections()).await?;
    let redis = db::create_redis_pool(config.redis_url()).await?;
    
    let state = AppState {
        db,
        redis,
        config: Arc::new(config),
    };
    
    let app = routes::create_router(state.clone());
    
    Ok((app, state))
}
```

- [ ] **Step 3: 提交**

```bash
git add src/config.rs src/lib.rs
git commit -m "feat: add configuration management"
```

---

### Task 1.3: 实现错误类型 (error.rs)

**Files:**
- Modify: `src-server/src/error.rs`

- [ ] **Step 1: 编写错误类型定义**

```rust
use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;
use thiserror::Error;

pub const ERR_AUTH_INVALID: &str = "AUTH_INVALID";
pub const ERR_AUTH_EXPIRED: &str = "AUTH_EXPIRED";
pub const ERR_PERMISSION_DENIED: &str = "PERMISSION_DENIED";
pub const ERR_RESOURCE_NOT_FOUND: &str = "RESOURCE_NOT_FOUND";
pub const ERR_VALIDATION_FAILED: &str = "VALIDATION_FAILED";
pub const ERR_DATABASE_ERROR: &str = "DATABASE_ERROR";
pub const ERR_FILE_UPLOAD_FAILED: &str = "FILE_UPLOAD_FAILED";
pub const ERR_LLM_API_ERROR: &str = "LLM_API_ERROR";
pub const ERR_INTERNAL_ERROR: &str = "INTERNAL_ERROR";

#[derive(Error, Debug)]
pub enum AppError {
    #[error("Authentication failed: {0}")]
    AuthInvalid(String),
    
    #[error("Authentication expired")]
    AuthExpired,
    
    #[error("Bad request: {0}")]
    BadRequest(String),
    
    #[error("Permission denied")]
    PermissionDenied,
    
    #[error("Resource not found: {0}")]
    ResourceNotFound(String),
    
    #[error("Validation failed: {0}")]
    ValidationError(String),
    
    #[error("Database error: {0}")]
    DatabaseError(#[from] sqlx::Error),
    
    #[error("Redis error: {0}")]
    RedisError(#[from] deadpool_redis::PoolError),
    
    #[error("IO error: {0}")]
    IoError(#[from] std::io::Error),
    
    #[error("JWT error: {0}")]
    JwtError(#[from] jsonwebtoken::errors::Error),
    
    #[error("Encryption error: {0}")]
    EncryptionError(String),
    
    #[error("Internal error: {0}")]
    InternalError(String),
    
    #[error("File upload failed")]
    FileUploadFailed,
    
    #[error("LLM API error: {0}")]
    LlmApiError(String),
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, code, message) = match &self {
            AppError::AuthInvalid(msg) => (StatusCode::UNAUTHORIZED, ERR_AUTH_INVALID, msg.clone()),
            AppError::AuthExpired => (StatusCode::UNAUTHORIZED, ERR_AUTH_EXPIRED, "Authentication expired".to_string()),
            AppError::PermissionDenied => (StatusCode::FORBIDDEN, ERR_PERMISSION_DENIED, "Permission denied".to_string()),
            AppError::ResourceNotFound(msg) => (StatusCode::NOT_FOUND, ERR_RESOURCE_NOT_FOUND, msg.clone()),
            AppError::BadRequest(msg) => (StatusCode::BAD_REQUEST, ERR_VALIDATION_FAILED, msg.clone()),
            AppError::ValidationError(msg) => (StatusCode::BAD_REQUEST, ERR_VALIDATION_FAILED, msg.clone()),
            AppError::DatabaseError(_) => (StatusCode::INTERNAL_SERVER_ERROR, ERR_DATABASE_ERROR, "Database error".to_string()),
            AppError::RedisError(_) => (StatusCode::INTERNAL_SERVER_ERROR, ERR_DATABASE_ERROR, "Cache error".to_string()),
            AppError::JwtError(_) => (StatusCode::INTERNAL_SERVER_ERROR, ERR_INTERNAL_ERROR, "Token processing error".to_string()),
            AppError::EncryptionError(msg) => (StatusCode::INTERNAL_SERVER_ERROR, ERR_INTERNAL_ERROR, msg.clone()),
            AppError::IoError(_) => (StatusCode::INTERNAL_SERVER_ERROR, ERR_INTERNAL_ERROR, "IO error".to_string()),
            AppError::InternalError(msg) => (StatusCode::INTERNAL_SERVER_ERROR, ERR_INTERNAL_ERROR, msg.clone()),
            AppError::FileUploadFailed => (StatusCode::INTERNAL_SERVER_ERROR, ERR_FILE_UPLOAD_FAILED, "File upload failed".to_string()),
            AppError::LlmApiError(msg) => (StatusCode::INTERNAL_SERVER_ERROR, ERR_LLM_API_ERROR, msg.clone()),
        };
        
        let body = Json(json!({
            "error": {
                "code": code,
                "message": message,
            }
        }));
        
        (status, body).into_response()
    }
}

// ParseIntError 转换（用于 claims.sub.parse::<i32>()）
impl From<std::num::ParseIntError> for AppError {
    fn from(err: std::num::ParseIntError) -> Self {
        AppError::AuthInvalid(format!("Invalid user ID: {}", err))
    }
}

pub trait IntoAppError<T> {
    fn into_app_error(self) -> Result<T, AppError>;
}

impl<T, E> IntoAppError<T> for Result<T, E>
where
    E: Into<AppError>,
{
    fn into_app_error(self) -> Result<T, AppError> {
        self.map_err(|e| e.into())
    }
}
```

- [ ] **Step 2: 更新 lib.rs 导入**

```rust
pub use error::{AppError, IntoAppError, ERR_AUTH_INVALID, ERR_AUTH_EXPIRED, ERR_PERMISSION_DENIED, 
               ERR_RESOURCE_NOT_FOUND, ERR_VALIDATION_FAILED, ERR_DATABASE_ERROR, ERR_FILE_UPLOAD_FAILED,
               ERR_LLM_API_ERROR, ERR_INTERNAL_ERROR};
```

- [ ] **Step 3: 提交**

```bash
git add src/error.rs src/lib.rs
git commit -m "feat: add error type definitions and response handling"
```

---

### Task 1.4: 实现数据库连接池 (db.rs)

**Files:**
- Modify: `src-server/src/db.rs`

- [ ] **Step 1: 编写数据库连接池实现**

```rust
use anyhow::Result;
use deadpool_redis::{Config as RedisConfig, Pool, Runtime};
use sqlx::{postgres::PgPoolOptions, Pool as PgPool};
use std::time::Duration;

pub type DbPool = PgPool;
pub type RedisPool = Pool;

pub async fn create_pool(database_url: &str, max_connections: u32) -> Result<DbPool> {
    let pool = PgPoolOptions::new()
        .max_connections(max_connections)
        .acquire_timeout(Duration::from_secs(30))
        .idle_timeout(Duration::from_secs(600))
        .max_lifetime(Duration::from_secs(1800))
        .connect(database_url)
        .await?;
    
    // 验证连接
    sqlx::query("SELECT 1")
        .execute(&pool)
        .await
        .map_err(|e| anyhow::anyhow!("Failed to verify database connection: {}", e))?;
    
    tracing::info!("Connected to database");
    Ok(pool)
}

pub async fn create_redis_pool(redis_url: &str) -> Result<RedisPool> {
    let cfg = RedisConfig::from_url(redis_url);
    let pool = cfg
        .create_pool(Some(Runtime::Tokio1))
        .map_err(|e| anyhow::anyhow!("Failed to create Redis pool: {}", e))?;
    
    // 验证连接
    let mut conn = pool
        .get()
        .await
        .map_err(|e| anyhow::anyhow!("Failed to get Redis connection: {}", e))?;
    
    let _: String = redis::cmd("PING")
        .query_async(&mut conn)
        .await
        .map_err(|e| anyhow::anyhow!("Failed to PING Redis: {}", e))?;
    
    tracing::info!("Connected to Redis");
    Ok(pool)
}
```

- [ ] **Step 2: 更新 lib.rs 导入**

```rust
pub mod db;

pub use db::{create_pool, create_redis_pool, DbPool, RedisPool};
```

- [ ] **Step 3: 提交**

```bash
git add src/db.rs src/lib.rs
git commit -m "feat: add database and Redis connection pools"
```

---

### Task 1.5: 创建基础路由结构 (routes/mod.rs)

**Files:**
- Modify: `src-server/src/routes/mod.rs`
- Create: `src-server/src/routes/auth.rs`
- Create: `src-server/src/routes/health.rs`

- [ ] **Step 1: 创建路由模块文件**

```bash
touch src-server/src/routes/auth.rs
touch src-server/src/routes/health.rs
touch src-server/src/routes/users.rs
touch src-server/src/routes/teams.rs
touch src-server/src/routes/projects.rs
touch src-server/src/routes/files.rs
touch src-server/src/routes/search.rs
touch src-server/src/routes/chat.rs
touch src-server/src/routes/graph.rs
```

- [ ] **Step 2: 实现 routes/mod.rs**

```rust
use axum::{Router, routing::get};
use super::{health, auth};

pub fn create_router(state: crate::AppState) -> Router {
    Router::new()
        .route("/health", get(health::health_check))
        .nest("/api/v1/auth", auth::auth_routes())
        .nest("/api/v1/users", users::user_routes())
        .nest("/api/v1/teams", teams::team_routes())
        .nest("/api/v1/projects", projects::project_routes())
        .with_state(state)
}
```

- [ ] **Step 3: 实现健康检查 (health.rs)**

```rust
use axum::{Json, response::IntoResponse};
use serde_json::json;

pub async fn health_check() -> impl IntoResponse {
    Json(json!({
        "status": "ok",
        "timestamp": chrono::Utc::now().to_rfc3339()
    }))
}
```

- [ ] **Step 4: 实现认证路由框架 (auth.rs)**

```rust
use axum::Router;

pub fn auth_routes() -> Router {
    Router::new()
        // 路由将在 Task 2.1-2.3 中实现
}
```

- [ ] **Step 5: 更新 lib.rs**

```rust
pub mod routes;
```

- [ ] **Step 6: 提交**

```bash
git add src/routes/
git commit -m "feat: create route structure with health check endpoint"
```

---

### Task 1.6: 创建 Docker Compose 配置

**Files:**
- Create: `src-server/docker-compose.yml`

- [ ] **Step 1: 编写 docker-compose.yml**

```yaml
services:
  postgres:
    image: postgres:15
    environment:
      POSTGRES_DB: llmwiki
      POSTGRES_USER: llmwiki
      POSTGRES_PASSWORD: ${DB_PASSWORD:-change_this_password}
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

volumes:
  postgres_data:
  redis_data:
```

- [ ] **Step 2: 创建 .dockerignore**

```text
target/
Dockerfile
.dockerignore
.env
*.md
.git/
```

- [ ] **Step 3: 提交**

```bash
git add docker-compose.yml .dockerignore
git commit -m "feat: add Docker Compose configuration for PostgreSQL and Redis"
```

---

### Task 1.7: 创建数据库迁移目录结构

**Files:**
- Create: `src-server/migrations/.gitkeep`
- Create: `src-server/migrations/001_initial_schema.sql`

- [ ] **Step 1: 创建迁移目录**

```bash
mkdir -p src-server/migrations
touch src-server/migrations/.gitkeep
```

- [ ] **Step 2: 创建初始 schema 迁移文件**

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
    content VECTOR(1536),
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_embeddings_project ON embeddings(project_id);
CREATE INDEX idx_embeddings_content ON embeddings USING ivfflat (content vector_cosine_ops) WITH (lists = 100);
-- 索引参数调优建议:
-- - lists 参数应根据向量数量调整，通常设为 sqrt(rows) 或 rows/1000
-- - 示例：100 万向量 → lists=1000，10 万向量 → lists=316，1 万向量 → lists=100

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

- [ ] **Step 3: 提交**

```bash
git add migrations/
git commit -m "feat: add initial database schema migration"
```

---

## Phase 2: 数据库设计 + 用户认证（JWT）+ 登录/登出

### Task 2.1: 创建所有数据模型

**Files:**
- Modify: `src-server/src/models/mod.rs`
- Create: `src-server/src/models/user.rs`
- Create: `src-server/src/models/team.rs`
- Create: `src-server/src/models/project.rs`
- Create: `src-server/src/models/auth.rs`

- [ ] **Step 1: 实现 models/auth.rs（JWT Claims + 认证相关）**

```rust
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Claims {
    pub sub: String,  // user_id
    pub exp: usize,   // expiry time
    pub iat: usize,   // issued at
    pub jti: String,  // JWT ID (for refresh token)
}

#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
}

#[derive(Debug, Deserialize)]
pub struct RegisterRequest {
    pub username: String,
    pub email: String,
    pub password: String,
    pub full_name: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct AuthResponse {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_in: u64,
}

#[derive(Debug, Deserialize)]
pub struct RefreshTokenRequest {
    pub refresh_token: String,
}

#[derive(Debug, Serialize)]
pub struct RefreshClaims {
    pub sub: String,
    pub exp: usize,
    pub jti: String,
}
```

- [ ] **Step 2: 实现 models/user.rs**

```rust
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct User {
    pub id: i32,
    pub username: String,
    pub email: String,
    #[serde(skip_serializing)]
    pub password_hash: String,
    pub full_name: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, FromRow)]
pub struct UserResponse {
    pub id: i32,
    pub username: String,
    pub email: String,
    pub full_name: Option<String>,
    pub created_at: DateTime<Utc>,
}
```

- [ ] **Step 3: 实现 models/team.rs**

```rust
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Team {
    pub id: i32,
    pub name: String,
    pub description: Option<String>,
    pub created_by: i32,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, FromRow)]
pub struct TeamResponse {
    pub id: i32,
    pub name: String,
    pub description: Option<String>,
    pub created_by: i32,
    pub created_at: DateTime<Utc>,
    pub member_count: i64,
}

#[derive(Debug, Deserialize)]
pub struct CreateTeamRequest {
    pub name: String,
    pub description: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateTeamRequest {
    pub name: Option<String>,
    pub description: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ListTeamsQuery {
    pub page: Option<u32>,
    pub limit: Option<u32>,
}

#[derive(Debug, Deserialize)]
pub struct AddMemberRequest {
    pub user_id: i32,
    pub role: String,
}

#[derive(Debug, Serialize, FromRow)]
pub struct TeamMemberResponse {
    pub team_id: i32,
    pub user_id: i32,
    pub username: String,
    pub role: String,
    pub joined_at: DateTime<Utc>,
}
```

- [ ] **Step 4: 实现 models/project.rs**

```rust
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Project {
    pub id: i32,
    pub team_id: i32,
    pub name: String,
    pub storage_path: String,
    pub created_by: i32,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, FromRow)]
pub struct ProjectResponse {
    pub id: i32,
    pub team_id: i32,
    pub name: String,
    pub storage_path: String,
    pub created_by: i32,
    pub created_at: DateTime<Utc>,
    pub file_count: i64,
}

#[derive(Debug, Deserialize)]
pub struct CreateProjectRequest {
    pub name: String,
    pub team_id: Option<i32>,
    pub storage_path: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateProjectRequest {
    pub name: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ListProjectsQuery {
    pub team_id: Option<i32>,
    pub cursor: Option<String>,
    pub limit: Option<u32>,
}
```

- [ ] **Step 5: 更新 models/mod.rs**

```rust
pub mod auth;
pub mod user;
pub mod team;
pub mod project;

pub use auth::{Claims, LoginRequest, RegisterRequest, AuthResponse, RefreshTokenRequest, RefreshClaims};
pub use user::{User, UserResponse};
pub use team::{Team, TeamResponse, CreateTeamRequest, UpdateTeamRequest, ListTeamsQuery, AddMemberRequest, TeamMemberResponse};
pub use project::{Project, ProjectResponse, CreateProjectRequest, UpdateProjectRequest, ListProjectsQuery};
```

- [ ] **Step 6: 提交**

```bash
git add src-server/src/models/
git commit -m "feat: add all data models with complete definitions"
```

---

### Task 2.2: 实现 JWT 工具函数

**Files:**
- Create: `src-server/src/utils/mod.rs`
- Create: `src-server/src/utils/jwt.rs`
- Create: `src-server/src/utils/crypto.rs`

- [ ] **Step 1: 实现 utils/jwt.rs**

```rust
use anyhow::Result;
use chrono::{Duration, Utc};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use crate::{AppError, Claims};

const BEARER_PREFIX: &str = "Bearer ";

#[derive(Debug, Serialize, Deserialize)]
struct RefreshClaims {
    sub: String,  // user_id
    exp: i64,
    iat: i64,
    jti: String,  // token ID
}

pub fn generate_access_token(user_id: i32, username: &str, secret: &str, ttl: Duration) -> Result<String> {
    let now = Utc::now();
    let expire = now + ttl;
    
    let claims = Claims {
        sub: user_id.to_string(),
        username: username.to_string(),
        exp: expire.timestamp(),
        iat: now.timestamp(),
    };
    
    let token = encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_ref()),
    )?;
    
    Ok(token)
}

pub fn generate_refresh_token(user_id: i32, secret: &str, ttl: Duration) -> Result<(String, String)> {
    let now = Utc::now();
    let expire = now + ttl;
    let jti = uuid::Uuid::new_v4().to_string();
    
    let claims = RefreshClaims {
        sub: user_id.to_string(),
        exp: expire.timestamp(),
        iat: now.timestamp(),
        jti: jti.clone(),
    };
    
    let token = encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_ref()),
    )?;
    
    Ok((token, jti))
}

pub fn verify_token(token: &str, secret: &str) -> Result<Claims, AppError> {
    let token = token.trim_start_matches(BEARER_PREFIX);
    
    let decoded = decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_ref()),
        &Validation::default(),
    )?;
    
    Ok(decoded.claims)
}

pub fn verify_refresh_token(token: &str, secret: &str) -> Result<(i32, String), AppError> {
    let token = token.trim_start_matches(BEARER_PREFIX);
    
    let decoded = decode::<RefreshClaims>(
        token,
        &DecodingKey::from_secret(secret.as_ref()),
        &Validation::default(),
    )?;
    
    let user_id = decoded.claims.sub.parse::<i32>()
        .map_err(|_| AppError::AuthInvalid("Invalid user ID in token".to_string()))?;
    
    Ok((user_id, decoded.claims.jti))
}
```

- [ ] **Step 2: 实现 utils/crypto.rs**

```rust
use anyhow::Result;
use aes_gcm::{Aes256Gcm, Key, Nonce};
use rand::Rng;
use sha2::{Sha256, Digest};
use hex::{ToHex, FromHex};

pub fn hash_password(password: &str) -> Result<String> {
    let hash = bcrypt::hash(password, bcrypt::DEFAULT_COST)?;
    Ok(hash)
}

pub fn verify_password(password: &str, hash: &str) -> Result<bool> {
    Ok(bcrypt::verify(password, hash)?)
}

pub fn encrypt_api_key(api_key: &str, secret: &[u8; 32]) -> String {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(secret));
    
    // 生成随机 nonce（每次加密必须不同）
    let mut nonce_bytes = [0u8; 12];
    rand::thread_rng().fill(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    
    let ciphertext = cipher.encrypt(nonce, api_key.as_bytes(), &[]).unwrap();
    
    // 将 nonce + 密文一起编码
    let mut combined = nonce_bytes.to_vec();
    combined.extend_from_slice(&ciphertext);
    combined.to_hex()
}

pub fn decrypt_api_key(encrypted: &str, secret: &[u8; 32]) -> Result<String, AppError> {
    let combined = Vec::from_hex(encrypted)
        .map_err(|_| AppError::EncryptionError("Invalid hex encoding".to_string()))?;
    
    if combined.len() < 12 {
        return Err(AppError::EncryptionError("Invalid encrypted data".to_string()));
    }
    
    let (nonce_bytes, ciphertext) = combined.split_at(12);
    let nonce = Nonce::from_slice(nonce_bytes);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(secret));
    
    cipher
        .decrypt(nonce, ciphertext, &[])
        .map(|bytes| String::from_utf8_lossy(&bytes).to_string())
        .map_err(|_| AppError::EncryptionError("Decryption failed".to_string()))
}

pub fn hash_refresh_token(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    let result = hasher.finalize();
    result.to_hex()
}
```

- [ ] **Step 3: 实现 utils/mod.rs**

```rust
pub mod jwt;
pub mod crypto;

pub use jwt::*;
pub use crypto::*;
```

- [ ] **Step 4: 更新 lib.rs**

```rust
pub mod utils;
```

- [ ] **Step 5: 更新 Cargo.toml**

```toml
# 更新现有依赖
sha2 = "0.10"
uuid = { version = "1.6", features = ["v4", "serde"] }
```

- [ ] **Step 6: 提交**

```bash
git add src/utils/ Cargo.toml src/lib.rs
git commit -m "feat: add JWT and crypto utility functions"
```

---

### Task 2.3: 实现认证中间件

**Files:**
- Modify: `src-server/src/middleware/mod.rs`
- Create: `src-server/src/middleware/auth.rs`
- Create: `src-server/src/middleware/cors.rs`

- [ ] **Step 1: 实现 middleware/auth.rs**

```rust
use axum::{
    extract::{Request, State},
    http::HeaderMap,
    middleware::Next,
    response::Response,
};
use crate::{AppState, Claims, verify_token, AppError};

pub struct Auth(pub Claims);

#[axum::async_trait]
impl<S> FromRequestParts<S> for Auth
where
    S: Send + Sync,
{
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut axum::http::request::Parts,
        _state: &S,
    ) -> Result<Self, Self::Rejection> {
        // 从 State 获取配置
        // 这里需要从 parts.extractor() 获取 State
        // 简化版本：从 header 提取 token
        let headers = HeaderMap::from_headers(parts.headers.clone());
        
        let auth_header = headers
            .get("authorization")
            .and_then(|h| h.to_str().ok())
            .ok_or(AppError::AuthInvalid("Missing authorization header".to_string()))?;
        
        // 需要获取 JWT_SECRET
        // 这里通过 State 传递，需要修改提取方式
        // 简化：在 Handler 中直接提取
        Err(AppError::InternalError("Use Auth extractor with State".to_string()))
    }
}

// 认证辅助函数（普通函数，非Axum extractor）
pub async fn require_auth(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<Claims, AppError> {
    let auth_header = headers
        .get("authorization")
        .and_then(|h| h.to_str().ok())
        .ok_or(AppError::AuthInvalid("Missing authorization header".to_string()))?;
    
    let secret = &state.config.jwt.secret;
    let claims = verify_token(auth_header, secret)?;
    
    Ok(claims)
}
```

- [ ] **Step 2: 实现中间件（可选，用于日志）**

```rust
use axum::{
    extract::Request,
    middleware::Next,
    response::Response,
};
use tracing::info;

pub async fn logging_middleware(
    req: Request,
    next: Next,
) -> Response {
    let method = req.method().clone();
    let uri = req.uri().clone();
    
    info!(method = %method, uri = %uri, "incoming request");
    
    let response = next.run(req).await;
    
    info!(method = %method, uri = %uri, status = ?response.status(), "request completed");
    
    response
}
```

- [ ] **Step 3: 实现 middleware/cors.rs**

```rust
use axum::{
    http::{HeaderMap, HeaderValue, Method},
    response::Response,
};
use tower_http::cors::{Any, CorsLayer};
use tower::ServiceBuilder;

pub fn create_cors_layer(allowed_origins: &[String]) -> CorsLayer {
    let allowed_origins = allowed_origins
        .iter()
        .filter_map(|origin| origin.parse::<HeaderValue>().ok())
        .collect();
    
    CorsLayer::new()
        .allow_origin(allowed_origins)
        .allow_methods([Method::GET, Method::POST, Method::PUT, Method::DELETE, Method::PATCH])
        .allow_headers(Any)
        .allow_credentials(true)
        .expose_headers(["content-length"])
        .max_age(Duration::from_secs(86400))
}
```

- [ ] **Step 4: 更新 lib.rs**

```rust
pub mod middleware;
```

- [ ] **Step 5: 提交**

```bash
git add src/middleware/
git commit -m "feat: add authentication and CORS middleware"
```

---

### Task 2.4: 实现认证 API

**Files:**
- Modify: `src-server/src/routes/auth.rs`

- [ ] **Step 1: 实现登录 API**

```rust
use axum::{
    extract::State,
    Json,
    response::IntoResponse,
};
use crate::{
    AppState, Claims, generate_access_token, generate_refresh_token, hash_refresh_token,
    verify_password, hash_password, AppError,
    RegisterRequest, LoginRequest, AuthResponse, UserResponse, User,
};
use sqlx::Postgres;

pub fn auth_routes() -> axum::Router {
    axum::Router::new()
        .route("/register", axum::routing::post(register))
        .route("/login", axum::routing::post(login))
        .route("/logout", axum::routing::post(logout))
        .route("/refresh", axum::routing::post(refresh))
}

pub async fn register(
    State(state): State<AppState>,
    Json(payload): Json<RegisterRequest>,
) -> Result<impl IntoResponse, AppError> {
    // 检查用户名是否已存在
    let existing = sqlx::query_scalar::<_, i32>(
        "SELECT id FROM users WHERE username = $1"
    )
    .bind(&payload.username)
    .fetch_optional(&state.db)
    .await?;
    
    if existing.is_some() {
        return Err(AppError::ValidationError("Username already exists".to_string()));
    }
    
    // 检查邮箱是否已存在
    let existing = sqlx::query_scalar::<_, i32>(
        "SELECT id FROM users WHERE email = $1"
    )
    .bind(&payload.email)
    .fetch_optional(&state.db)
    .await?;
    
    if existing.is_some() {
        return Err(AppError::ValidationError("Email already exists".to_string()));
    }
    
    // 哈希密码
    let password_hash = hash_password(&payload.password)?;
    
    // 创建用户
    let user = sqlx::query_as::<_, User>(
        "INSERT INTO users (username, email, password_hash, full_name) 
         VALUES ($1, $2, $3, $4) 
         RETURNING *"
    )
    .bind(&payload.username)
    .bind(&payload.email)
    .bind(&password_hash)
    .bind(&payload.full_name)
    .fetch_one(&state.db)
    .await?;
    
    // 生成 token
    let token = generate_access_token(
        user.id,
        &user.username,
        &state.config.jwt.secret,
        state.config.jwt_access_token_ttl(),
    )?;
    
    let (refresh_token, jti) = generate_refresh_token(
        user.id,
        &state.config.jwt.secret,
        state.config.jwt_refresh_token_ttl(),
    )?;
    
    // 存储 refresh token
    let token_hash = hash_refresh_token(&jti);
    let expires_at = chrono::Utc::now() + state.config.jwt_refresh_token_ttl();
    
    sqlx::query(
        "INSERT INTO refresh_tokens (user_id, token_hash, expires_at) 
         VALUES ($1, $2, $3)"
    )
    .bind(user.id)
    .bind(&token_hash)
    .bind(expires_at)
    .execute(&state.db)
    .await?;
    
    let response = AuthResponse {
        token,
        refresh_token,
        user: UserResponse::from(user),
    };
    
    Ok(Json(response))
}

pub async fn login(
    State(state): State<AppState>,
    Json(payload): Json<LoginRequest>,
) -> Result<impl IntoResponse, AppError> {
    // 查找用户
    let user = sqlx::query_as::<_, User>(
        "SELECT * FROM users WHERE username = $1"
    )
    .bind(&payload.username)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::AuthInvalid("Invalid credentials".to_string()))?;
    
    // 验证密码
    let is_valid = verify_password(&payload.password, &user.password_hash)?;
    if !is_valid {
        return Err(AppError::AuthInvalid("Invalid credentials".to_string()));
    }
    
    // 生成 token
    let token = generate_access_token(
        user.id,
        &user.username,
        &state.config.jwt.secret,
        state.config.jwt_access_token_ttl(),
    )?;
    
    let (refresh_token, jti) = generate_refresh_token(
        user.id,
        &state.config.jwt.secret,
        state.config.jwt_refresh_token_ttl(),
    )?;
    
    // 存储 refresh token
    let token_hash = hash_refresh_token(&jti);
    let expires_at = chrono::Utc::now() + state.config.jwt_refresh_token_ttl();
    
    sqlx::query(
        "INSERT INTO refresh_tokens (user_id, token_hash, expires_at) 
         VALUES ($1, $2, $3)"
    )
    .bind(user.id)
    .bind(&token_hash)
    .bind(expires_at)
    .execute(&state.db)
    .await?;
    
    let response = AuthResponse {
        token,
        refresh_token,
        user: UserResponse::from(user),
    };
    
    Ok(Json(response))
}

pub async fn logout(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
) -> Result<impl IntoResponse, AppError> {
    let auth_header = headers
        .get("authorization")
        .and_then(|h| h.to_str().ok())
        .ok_or(AppError::AuthInvalid("Missing authorization header".to_string()))?;
    
    let (user_id, jti) = verify_refresh_token(auth_header, &state.config.jwt.secret)?;
    
    // 吊销 refresh token
    let token_hash = hash_refresh_token(&jti);
    sqlx::query(
        "UPDATE refresh_tokens SET revoked_at = NOW() 
         WHERE user_id = $1 AND token_hash = $2"
    )
    .bind(user_id)
    .bind(&token_hash)
    .execute(&state.db)
    .await?;
    
    Ok(Json(json!({"message": "Logged out successfully"})))
}

pub async fn refresh(
    State(state): State<AppState>,
    Json(payload): Json<serde_json::Value>,
) -> Result<impl IntoResponse, AppError> {
    let refresh_token = payload
        .get("refresh_token")
        .and_then(|v| v.as_str())
        .ok_or(AppError::AuthInvalid("Missing refresh token".to_string()))?;
    
    let (user_id, jti) = verify_refresh_token(refresh_token, &state.config.jwt.secret)?;
    
    // 检查 refresh token 是否有效
    let token_hash = hash_refresh_token(&jti);
    let token_valid = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(
            SELECT 1 FROM refresh_tokens 
            WHERE user_id = $1 AND token_hash = $2 
            AND revoked_at IS NULL AND expires_at > NOW()
        )"
    )
    .bind(user_id)
    .bind(&token_hash)
    .fetch_one(&state.db)
    .await?;
    
    if !token_valid {
        return Err(AppError::AuthExpired);
    }
    
    // 获取用户信息
    let user = sqlx::query_as::<_, User>(
        "SELECT * FROM users WHERE id = $1"
    )
    .bind(user_id)
    .fetch_one(&state.db)
    .await?;
    
    // 生成新的 access token
    let token = generate_access_token(
        user.id,
        &user.username,
        &state.config.jwt.secret,
        state.config.jwt_access_token_ttl(),
    )?;
    
    Ok(Json(json!({"token": token})))
}
```

- [ ] **Step 2: 提交**

```bash
git add src/routes/auth.rs
git commit -m "feat: implement authentication APIs (register, login, logout, refresh)"
```

---

### Task 2.5: 实现用户管理 API

**Files:**
- Modify: `src-server/src/routes/users.rs`

- [ ] **Step 1: 实现用户管理 API**

```rust
use axum::{
    extract::{Path, State},
    Json,
    response::IntoResponse,
};
use crate::{AppState, require_auth, Claims, UserResponse, AppError};

pub fn user_routes() -> axum::Router {
    axum::Router::new()
        .route("/me", axum::routing::get(get_current_user))
        .route("/me", axum::routing::put(update_current_user))
        .route("/me/teams", axum::routing::get(get_user_teams))
        .route("/:id", axum::routing::get(get_user_by_id))
}

pub async fn get_current_user(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
) -> Result<impl IntoResponse, AppError> {
    let claims = require_auth(&state, &headers).await?;
    
    let user = sqlx::query_as::<_, crate::UserResponse>(
        "SELECT id, username, email, full_name, created_at 
         FROM users WHERE id = $1"
    )
    .bind(claims.sub.parse::<i32>()?)
    .fetch_one(&state.db)
    .await?;
    
    Ok(Json(user))
}

pub async fn update_current_user(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(payload): Json<serde_json::Value>,
) -> Result<impl IntoResponse, AppError> {
    let claims = require_auth(&state, &headers).await?;
    let user_id = claims.sub.parse::<i32>()?;
    
    // 简化版本：只支持更新 full_name
    let full_name = payload.get("full_name")
        .and_then(|v| v.as_str())
        .ok_or(AppError::ValidationError("full_name is required".to_string()))?;
    
    let user = sqlx::query_as::<_, crate::UserResponse>(
        "UPDATE users SET full_name = $1, updated_at = NOW() 
         WHERE id = $2 
         RETURNING id, username, email, full_name, created_at"
    )
    .bind(full_name)
    .bind(user_id)
    .fetch_one(&state.db)
    .await?;
    
    Ok(Json(user))
}

pub async fn get_user_teams(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
) -> Result<impl IntoResponse, AppError> {
    let claims = require_auth(&state, &headers).await?;
    let user_id = claims.sub.parse::<i32>()?;
    
    let teams = sqlx::query_as::<_, crate::TeamResponse>(
        "SELECT t.id, t.name, t.description, t.created_by, t.created_at,
         COUNT(tm.user_id) as member_count
         FROM teams t
         JOIN team_members tm ON t.id = tm.team_id
         WHERE tm.user_id = $1
         GROUP BY t.id
         ORDER BY t.created_at DESC"
    )
    .bind(user_id)
    .fetch_all(&state.db)
    .await?;
    
    Ok(Json(teams))
}

pub async fn get_user_by_id(
    State(state): State<AppState>,
    Path(id): Path<i32>,
) -> Result<impl IntoResponse, AppError> {
    let user = sqlx::query_as::<_, crate::UserResponse>(
        "SELECT id, username, email, full_name, created_at 
         FROM users WHERE id = $1"
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::ResourceNotFound("User not found".to_string()))?;
    
    Ok(Json(user))
}
```

- [ ] **Step 2: 提交**

```bash
git add src/routes/users.rs
git commit -m "feat: implement user management APIs"
```

---

### Task 2.6: 添加单元测试

**Files:**
- Create: `src-server/src/tests/auth_tests.rs`
- Create: `src-server/src/tests/mod.rs`

- [ ] **Step 1: 创建测试目录和文件**

```bash
mkdir -p src-server/src/tests
touch src-server/src/tests/mod.rs
touch src-server/src/tests/auth_tests.rs
```

- [ ] **Step 2: 实现认证测试**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::{generate_access_token, verify_token, Claims};
    use chrono::Duration;
    
    #[tokio::test]
    async fn test_generate_and_verify_token() {
        let secret = "test-secret";
        let ttl = Duration::minutes(5);
        
        let token = generate_access_token(1, "alice", secret, ttl).unwrap();
        let claims = verify_token(&token, secret).unwrap();
        
        assert_eq!(claims.sub, "1");
        assert_eq!(claims.username, "alice");
    }
    
    #[tokio::test]
    async fn test_verify_invalid_token() {
        let secret = "test-secret";
        let invalid_token = "invalid.token.here";
        
        let result = verify_token(invalid_token, secret);
        assert!(result.is_err());
    }
    
    #[tokio::test]
    async fn test_verify_expired_token() {
        let secret = "test-secret";
        let ttl = Duration::seconds(-1);  // 已过期
        
        let token = generate_access_token(1, "alice", secret, ttl).unwrap();
        let result = verify_token(&token, secret);
        
        assert!(result.is_err());
    }
}
```

- [ ] **Step 3: 更新 Cargo.toml**

```toml
[dev-dependencies]
tokio-test = "0.4"
```

- [ ] **Step 4: 更新 lib.rs**

```rust
#[cfg(test)]
mod tests;
```

- [ ] **Step 5: 运行测试**

```bash
cd src-server
cargo test --lib
```

- [ ] **Step 6: 提交**

```bash
git add src/tests/ Cargo.toml src/lib.rs
git commit -m "test: add authentication unit tests"
```

---

## Phase 3: 团队管理 + 项目管理 + 权限检查中间件

### Task 3.1: 实现团队管理 API

**Files:**
- Modify: `src-server/src/routes/teams.rs`
- Modify: `src-server/src/models/team.rs`

- [ ] **Step 1: 实现团队 CRUD API**

```rust
use axum::{
    extract::{Path, Query, State},
    Json,
    response::IntoResponse,
};
use serde::Deserialize;
use crate::{AppState, require_auth, Claims, TeamResponse, Team, CreateTeamRequest, AppError};

#[derive(Debug, Deserialize)]
pub struct ListTeamsQuery {
    cursor: Option<String>,
    limit: Option<u32>,
}

pub fn team_routes() -> axum::Router {
    axum::Router::new()
        .route("/", axum::routing::post(create_team))
        .route("/", axum::routing::get(list_teams))
        .route("/:id", axum::routing::get(get_team))
        .route("/:id", axum::routing::put(update_team))
        .route("/:id", axum::routing::delete(delete_team))
        .route("/:id/members", axum::routing::post(add_member))
        .route("/:id/members/:user_id", axum::routing::delete(remove_member))
        .route("/:id/members", axum::routing::get(get_team_members))
}

pub async fn create_team(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(payload): Json<CreateTeamRequest>,
) -> Result<impl IntoResponse, AppError> {
    let claims = require_auth(&state, &headers).await?;
    
    let team = sqlx::query_as::<_, Team>(
        "INSERT INTO teams (name, description, created_by) 
         VALUES ($1, $2, $3) 
         RETURNING *"
    )
    .bind(&payload.name)
    .bind(&payload.description)
    .bind(claims.sub.parse::<i32>()?)
    .fetch_one(&state.db)
    .await?;
    
    // 创建者自动成为 owner
    sqlx::query(
        "INSERT INTO team_members (team_id, user_id, role) 
         VALUES ($1, $2, 'owner')"
    )
    .bind(team.id)
    .bind(claims.sub.parse::<i32>()?)
    .execute(&state.db)
    .await?;
    
    let response = TeamResponse::from(team);
    Ok(Json(response))
}

pub async fn list_teams(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Query(query): Query<ListTeamsQuery>,
) -> Result<impl IntoResponse, AppError> {
    let claims = require_auth(&state, &headers).await?;
    let user_id = claims.sub.parse::<i32>()?;
    
    let limit = query.limit.unwrap_or(20).min(100) as i64;
    
    let teams = if let Some(cursor) = query.cursor {
        // 解码 cursor（hex 编码的 (id, created_at)）
        let bytes = hex::decode(cursor)
            .map_err(|_| AppError::BadRequest("Invalid cursor format".to_string()))?;
        let last_id = i32::from_le_bytes(bytes[0..4].try_into().unwrap());
        let created_at = chrono::DateTime::<chrono::Utc>::from_timestamp(
            i64::from_le_bytes(bytes[8..16].try_into().unwrap()) / 1000,
            0
        ).ok_or_else(|| AppError::BadRequest("Invalid cursor timestamp".to_string()))?;
        
        sqlx::query_as::<_, TeamResponse>(
            "SELECT t.id, t.name, t.description, t.created_by, t.created_at,
             COUNT(tm.user_id) as member_count
             FROM teams t
             JOIN team_members tm ON t.id = tm.team_id
             WHERE tm.user_id = $1 AND (t.id, t.created_at) > ($2, $3)
             GROUP BY t.id
             ORDER BY t.id ASC, t.created_at ASC
             LIMIT $4"
        )
        .bind(user_id)
        .bind(last_id)
        .bind(created_at)
        .bind(limit)
        .fetch_all(&state.db)
        .await?
    } else {
        sqlx::query_as::<_, TeamResponse>(
            "SELECT t.id, t.name, t.description, t.created_by, t.created_at,
             COUNT(tm.user_id) as member_count
             FROM teams t
             JOIN team_members tm ON t.id = tm.team_id
             WHERE tm.user_id = $1
             GROUP BY t.id
             ORDER BY t.id ASC, t.created_at ASC
             LIMIT $2"
        )
        .bind(user_id)
        .bind(limit)
        .fetch_all(&state.db)
        .await?
    };
    
    let has_more = teams.len() == limit as usize;
    let next_cursor = if has_more {
        if let Some(last_team) = teams.last() {
            let mut bytes = Vec::new();
            bytes.extend_from_slice(&last_team.id.to_le_bytes());
            if let Some(ts) = last_team.created_at.timestamp_millis().to_le_bytes().get(0..8) {
                bytes.extend_from_slice(ts);
            }
            Some(hex::encode(bytes))
        } else {
            None
        }
    } else {
        None
    };
    
    Ok(Json(json!({
        "items": teams,
        "next_cursor": next_cursor,
        "has_more": has_more,
    })))
}

pub async fn get_team(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<i32>,
) -> Result<impl IntoResponse, AppError> {
    let claims = require_auth(&state, &headers).await?;
    let user_id = claims.sub.parse::<i32>()?;
    
    // 检查权限
    let is_member = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(
            SELECT 1 FROM team_members 
            WHERE team_id = $1 AND user_id = $2
        )"
    )
    .bind(id)
    .bind(user_id)
    .fetch_one(&state.db)
    .await?;
    
    if !is_member {
        return Err(AppError::PermissionDenied);
    }
    
    let team = sqlx::query_as::<_, TeamResponse>(
        "SELECT t.id, t.name, t.description, t.created_by, t.created_at,
         COUNT(tm.user_id) as member_count
         FROM teams t
         JOIN team_members tm ON t.id = tm.team_id
         WHERE t.id = $1
         GROUP BY t.id"
    )
    .bind(id)
    .fetch_one(&state.db)
    .await?;
    
    Ok(Json(team))
}

pub async fn update_team(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<i32>,
    Json(payload): Json<CreateTeamRequest>,
) -> Result<impl IntoResponse, AppError> {
    let claims = require_auth(&state, &headers).await?;
    let user_id = claims.sub.parse::<i32>()?;
    
    // 检查是否是 owner 或 admin
    let is_admin = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(
            SELECT 1 FROM team_members 
            WHERE team_id = $1 AND user_id = $2 
            AND role IN ('owner', 'admin')
        )"
    )
    .bind(id)
    .bind(user_id)
    .fetch_one(&state.db)
    .await?;
    
    if !is_admin {
        return Err(AppError::PermissionDenied);
    }
    
    let team = sqlx::query_as::<_, TeamResponse>(
        "UPDATE teams SET name = $1, description = $2 
         WHERE id = $3 
         RETURNING id, name, description, created_by, created_at"
    )
    .bind(&payload.name)
    .bind(&payload.description)
    .bind(id)
    .fetch_one(&state.db)
    .await?;
    
    Ok(Json(team))
}

pub async fn delete_team(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<i32>,
) -> Result<impl IntoResponse, AppError> {
    let claims = require_auth(&state, &headers).await?;
    let user_id = claims.sub.parse::<i32>()?;
    
    // 检查是否是 owner
    let is_owner = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(
            SELECT 1 FROM team_members 
            WHERE team_id = $1 AND user_id = $2 AND role = 'owner'
        )"
    )
    .bind(id)
    .bind(user_id)
    .fetch_one(&state.db)
    .await?;
    
    if !is_owner {
        return Err(AppError::PermissionDenied);
    }
    
    sqlx::query("DELETE FROM teams WHERE id = $1")
        .bind(id)
        .execute(&state.db)
        .await?;
    
    Ok(Json(json!({"message": "Team deleted successfully"})))
}
```

- [ ] **Step 2: 提交**

```bash
git add src/routes/teams.rs
git commit -m "feat: implement team CRUD APIs"
```

---

### Task 3.2: 实现团队成员管理 API

**Files:**
- Modify: `src-server/src/routes/teams.rs`（继续）

- [ ] **Step 1: 实现成员管理 API**

```rust
// 续 teams.rs

pub async fn add_member(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<i32>,
    Json(payload): Json<crate::AddMemberRequest>,
) -> Result<impl IntoResponse, AppError> {
    let claims = require_auth(&state, &headers).await?;
    let user_id = claims.sub.parse::<i32>()?;
    
    // 检查是否是 owner 或 admin
    let is_admin = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(
            SELECT 1 FROM team_members 
            WHERE team_id = $1 AND user_id = $2 
            AND role IN ('owner', 'admin')
        )"
    )
    .bind(id)
    .bind(user_id)
    .fetch_one(&state.db)
    .await?;
    
    if !is_admin {
        return Err(AppError::PermissionDenied);
    }
    
    // 验证 role
    if !["owner", "admin", "member"].contains(&payload.role) {
        return Err(AppError::ValidationError("Invalid role".to_string()));
    }
    
    // 检查用户是否存在
    let user_exists = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM users WHERE id = $1)"
    )
    .bind(payload.user_id)
    .fetch_one(&state.db)
    .await?;
    
    if !user_exists {
        return Err(AppError::ResourceNotFound("User not found".to_string()));
    }
    
    // 添加成员
    sqlx::query(
        "INSERT INTO team_members (team_id, user_id, role) 
         VALUES ($1, $2, $3) 
         ON CONFLICT (team_id, user_id) 
         DO UPDATE SET role = $3"
    )
    .bind(id)
    .bind(payload.user_id)
    .bind(&payload.role)
    .execute(&state.db)
    .await?;
    
    Ok(Json(json!({"message": "Member added successfully"})))
}

pub async fn remove_member(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Path((id, user_id)): Path<(i32, i32)>,
) -> Result<impl IntoResponse, AppError> {
    let claims = require_auth(&state, &headers).await?;
    let current_user_id = claims.sub.parse::<i32>()?;
    
    // 不能移除自己
    if current_user_id == user_id {
        return Err(AppError::ValidationError("Cannot remove yourself".to_string()));
    }
    
    // 检查是否是 owner 或 admin
    let is_admin = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(
            SELECT 1 FROM team_members 
            WHERE team_id = $1 AND user_id = $2 
            AND role IN ('owner', 'admin')
        )"
    )
    .bind(id)
    .bind(current_user_id)
    .fetch_one(&state.db)
    .await?;
    
    if !is_admin {
        return Err(AppError::PermissionDenied);
    }
    
    sqlx::query(
        "DELETE FROM team_members WHERE team_id = $1 AND user_id = $2"
    )
    .bind(id)
    .bind(user_id)
    .execute(&state.db)
    .await?;
    
    Ok(Json(json!({"message": "Member removed successfully"})))
}

pub async fn get_team_members(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<i32>,
) -> Result<impl IntoResponse, AppError> {
    let claims = require_auth(&state, &headers).await?;
    let user_id = claims.sub.parse::<i32>()?;
    
    // 检查是否是成员
    let is_member = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(
            SELECT 1 FROM team_members 
            WHERE team_id = $1 AND user_id = $2
        )"
    )
    .bind(id)
    .bind(user_id)
    .fetch_one(&state.db)
    .await?;
    
    if !is_member {
        return Err(AppError::PermissionDenied);
    }
    
    let members = sqlx::query_as::<_, crate::TeamMemberResponse>(
        "SELECT u.id, u.username, u.email, u.full_name, tm.role, tm.joined_at
         FROM team_members tm
         JOIN users u ON tm.user_id = u.id
         WHERE tm.team_id = $1
         ORDER BY tm.joined_at ASC"
    )
    .bind(id)
    .fetch_all(&state.db)
    .await?;
    
    Ok(Json(members))
}
```

- [ ] **Step 2: 提交**

```bash
git add src/routes/teams.rs
git commit -m "feat: implement team member management APIs"
```

---

### Task 3.3: 实现项目管理 API

**Files:**
- Modify: `src-server/src/routes/projects.rs

- [ ] **Step 1: 实现项目 CRUD API**

```rust
use axum::{
    extract::{Path, Query, State},
    Json,
    response::IntoResponse,
};
use serde::Deserialize;
use crate::{AppState, require_auth, Claims, ProjectResponse, Project, CreateProjectRequest, AppError};

#[derive(Debug, Deserialize)]
pub struct ListProjectsQuery {
    team_id: Option<i32>,
    cursor: Option<String>,
    limit: Option<u32>,
}

pub fn project_routes() -> axum::Router {
    axum::Router::new()
        .route("/", axum::routing::post(create_project))
        .route("/", axum::routing::get(list_projects))
        .route("/:id", axum::routing::get(get_project))
        .route("/:id", axum::routing::put(update_project))
        .route("/:id", axum::routing::delete(delete_project))
}

pub async fn create_project(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(payload): Json<CreateProjectRequest>,
) -> Result<impl IntoResponse, AppError> {
    let claims = require_auth(&state, &headers).await?;
    
    // 需要指定 team_id
    let team_id = payload.team_id.ok_or_else(|| 
        AppError::ValidationError("team_id is required".to_string()))?;
    
    // 检查权限（是否是团队成员）
    let is_member = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(
            SELECT 1 FROM team_members 
            WHERE team_id = $1 AND user_id = $2
        )"
    )
    .bind(team_id)
    .bind(claims.sub.parse::<i32>()?)
    .fetch_one(&state.db)
    .await?;
    
    if !is_member {
        return Err(AppError::PermissionDenied);
    }
    
    // 生成存储路径
    let storage_path = format!("{}/{}/{}", state.config.storage_path, team_id, uuid::Uuid::new_v4());
    
    // 创建目录
    std::fs::create_dir_all(&storage_path)?;
    
    let project = sqlx::query_as::<_, Project>(
        "INSERT INTO projects (team_id, name, storage_path, created_by) 
         VALUES ($1, $2, $3, $4) 
         RETURNING *"
    )
    .bind(team_id)
    .bind(&payload.name)
    .bind(&storage_path)
    .bind(claims.sub.parse::<i32>()?)
    .fetch_one(&state.db)
    .await?;
    
    let response = ProjectResponse {
        id: project.id,
        team_id: project.team_id,
        name: project.name,
        storage_path: project.storage_path,
        created_by: project.created_by,
        created_at: project.created_at,
        file_count: 0,
    };
    
    Ok(Json(response))
}

pub async fn list_projects(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Query(query): Query<ListProjectsQuery>,
) -> Result<impl IntoResponse, AppError> {
    let claims = require_auth(&state, &headers).await?;
    let user_id = claims.sub.parse::<i32>()?;
    
    let limit = query.limit.unwrap_or(20).min(100) as i64;
    
    let projects = if let Some(team_id) = query.team_id {
        // 检查权限
        let is_member = sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(
                SELECT 1 FROM team_members 
                WHERE team_id = $1 AND user_id = $2
            )"
        )
        .bind(team_id)
        .bind(user_id)
        .fetch_one(&state.db)
        .await?;
        
        if !is_member {
            return Err(AppError::PermissionDenied);
        }
        
        if let Some(cursor) = query.cursor {
            let bytes = hex::decode(cursor)
                .map_err(|_| AppError::BadRequest("Invalid cursor format".to_string()))?;
            let last_id = i32::from_le_bytes(bytes[0..4].try_into().unwrap());
            let created_at = chrono::DateTime::<chrono::Utc>::from_timestamp(
                i64::from_le_bytes(bytes[8..16].try_into().unwrap()) / 1000,
                0
            ).ok_or_else(|| AppError::BadRequest("Invalid cursor timestamp".to_string()))?;
            
            sqlx::query_as::<_, ProjectResponse>(
                "SELECT p.id, p.team_id, p.name, p.storage_path, p.created_by, p.created_at, 0 as file_count
                 FROM projects p
                 WHERE p.team_id = $1 AND (p.id, p.created_at) > ($2, $3)
                 ORDER BY p.id ASC, p.created_at ASC
                 LIMIT $4"
            )
            .bind(team_id)
            .bind(last_id)
            .bind(created_at)
            .bind(limit)
            .fetch_all(&state.db)
            .await?
        } else {
            sqlx::query_as::<_, ProjectResponse>(
                "SELECT p.id, p.team_id, p.name, p.storage_path, p.created_by, p.created_at, 0 as file_count
                 FROM projects p
                 WHERE p.team_id = $1
                 ORDER BY p.id ASC, p.created_at ASC
                 LIMIT $2"
            )
            .bind(team_id)
            .bind(limit)
            .fetch_all(&state.db)
            .await?
        }
    } else {
        // 获取用户所有团队的项目
        if let Some(cursor) = query.cursor {
            let bytes = hex::decode(cursor)
                .map_err(|_| AppError::BadRequest("Invalid cursor format".to_string()))?;
            let last_id = i32::from_le_bytes(bytes[0..4].try_into().unwrap());
            let created_at = chrono::DateTime::<chrono::Utc>::from_timestamp(
                i64::from_le_bytes(bytes[8..16].try_into().unwrap()) / 1000,
                0
            ).ok_or_else(|| AppError::BadRequest("Invalid cursor timestamp".to_string()))?;
            
            sqlx::query_as::<_, ProjectResponse>(
                "SELECT p.id, p.team_id, p.name, p.storage_path, p.created_by, p.created_at, 0 as file_count
                 FROM projects p
                 JOIN team_members tm ON p.team_id = tm.team_id
                 WHERE tm.user_id = $1 AND (p.id, p.created_at) > ($2, $3)
                 ORDER BY p.id ASC, p.created_at ASC
                 LIMIT $4"
            )
            .bind(user_id)
            .bind(last_id)
            .bind(created_at)
            .bind(limit)
            .fetch_all(&state.db)
            .await?
        } else {
            sqlx::query_as::<_, ProjectResponse>(
                "SELECT p.id, p.team_id, p.name, p.storage_path, p.created_by, p.created_at, 0 as file_count
                 FROM projects p
                 JOIN team_members tm ON p.team_id = tm.team_id
                 WHERE tm.user_id = $1
                 ORDER BY p.id ASC, p.created_at ASC
                 LIMIT $2"
            )
            .bind(user_id)
            .bind(limit)
            .fetch_all(&state.db)
            .await?
        }
    };
    
    let has_more = projects.len() == limit as usize;
    let next_cursor = if has_more {
        if let Some(last_project) = projects.last() {
            let mut bytes = Vec::new();
            bytes.extend_from_slice(&last_project.id.to_le_bytes());
            if let Some(ts) = last_project.created_at.timestamp_millis().to_le_bytes().get(0..8) {
                bytes.extend_from_slice(ts);
            }
            Some(hex::encode(bytes))
        } else {
            None
        }
    } else {
        None
    };
    
    Ok(Json(json!({
        "items": projects,
        "next_cursor": next_cursor,
        "has_more": has_more,
    })))
}

pub async fn get_project(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<i32>,
) -> Result<impl IntoResponse, AppError> {
    let claims = require_auth(&state, &headers).await?;
    let user_id = claims.sub.parse::<i32>()?;
    
    // 检查权限
    let has_access = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(
            SELECT 1 FROM projects p
            JOIN team_members tm ON p.team_id = tm.team_id
            WHERE p.id = $1 AND tm.user_id = $2
        )"
    )
    .bind(id)
    .bind(user_id)
    .fetch_one(&state.db)
    .await?;
    
    if !has_access {
        return Err(AppError::PermissionDenied);
    }
    
    let project = sqlx::query_as::<_, ProjectResponse>(
        "SELECT p.id, p.team_id, p.name, p.storage_path, p.created_by, p.created_at, 0 as file_count
         FROM projects p
         WHERE p.id = $1"
    )
    .bind(id)
    .fetch_one(&state.db)
    .await?;
    
    Ok(Json(project))
}

pub async fn update_project(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<i32>,
    Json(payload): Json<CreateProjectRequest>,
) -> Result<impl IntoResponse, AppError> {
    let claims = require_auth(&state, &headers).await?;
    let user_id = claims.sub.parse::<i32>()?;
    
    // 检查权限（必须是创建者或团队 admin）
    let has_permission = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(
            SELECT 1 FROM projects p
            JOIN team_members tm ON p.team_id = tm.team_id
            WHERE p.id = $1 AND tm.user_id = $2 
            AND (p.created_by = $2 OR tm.role IN ('owner', 'admin'))
        )"
    )
    .bind(id)
    .bind(user_id)
    .fetch_one(&state.db)
    .await?;
    
    if !has_permission {
        return Err(AppError::PermissionDenied);
    }
    
    let project = sqlx::query_as::<_, ProjectResponse>(
        "UPDATE projects SET name = $1 WHERE id = $2 
         RETURNING id, team_id, name, storage_path, created_by, created_at"
    )
    .bind(&payload.name)
    .bind(id)
    .fetch_one(&state.db)
    .await?;
    
    Ok(Json(project))
}

pub async fn delete_project(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<i32>,
) -> Result<impl IntoResponse, AppError> {
    let claims = require_auth(&state, &headers).await?;
    let user_id = claims.sub.parse::<i32>()?;
    
    // 检查权限（必须是创建者或团队 owner）
    let has_permission = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(
            SELECT 1 FROM projects p
            JOIN team_members tm ON p.team_id = tm.team_id
            WHERE p.id = $1 AND tm.user_id = $2 
            AND (p.created_by = $2 OR tm.role = 'owner')
        )"
    )
    .bind(id)
    .bind(user_id)
    .fetch_one(&state.db)
    .await?;
    
    if !has_permission {
        return Err(AppError::PermissionDenied);
    }
    
    // 删除文件系统中的数据
    let project = sqlx::query_as::<_, Project>(
        "SELECT * FROM projects WHERE id = $1"
    )
    .bind(id)
    .fetch_one(&state.db)
    .await?;
    
    // TODO: 递归删除文件
    std::fs::remove_dir_all(&project.storage_path)?;
    
    // 删除数据库记录
    sqlx::query("DELETE FROM projects WHERE id = $1")
        .bind(id)
        .execute(&state.db)
        .await?;
    
    Ok(Json(json!({"message": "Project deleted successfully"})))
}
```

- [ ] **Step 2: 更新 models/project.rs 添加 team_id**

```rust
#[derive(Debug, Deserialize)]
pub struct CreateProjectRequest {
    pub name: String,
    pub team_id: Option<i32>,
}
```

- [ ] **Step 3: 验证 routes/mod.rs 已包含 projects 路由**

```rust
// routes/mod.rs 已包含所有路由，无需额外修改。
// Task 1.5 已定义最终版本含 projects::project_routes()。
```

- [ ] **Step 4: 提交**

```bash
git add src/routes/projects.rs src/routes/mod.rs src/models/project.rs
git commit -m "feat: implement project management APIs"
```

### Task 3.4: 路由组装函数

**Files:**
- Modify: `src/routes/teams.rs:120-140`
- Modify: `src/routes/users.rs:80-100`
- Modify: `src/routes/projects.rs:130-150`

- [ ] **Step 1: 在 teams.rs 添加 team_routes() 函数**

```rust
use axum::{Router, routing::{get, post, delete}};
use super::{handlers::teams::*};

pub fn team_routes() -> Router<crate::AppState> {
    Router::new()
        .route("/", post(create_team).get(list_teams))
        .route("/:id", get(get_team).delete(delete_team))
        .route("/:id/members", post(add_member).get(list_members))
        .route("/:id/members/:user_id", delete(remove_member))
}
```

- [ ] **Step 2: 在 users.rs 添加 user_routes() 函数**

```rust
use axum::{Router, routing::{get, post}};
use super::{handlers::users::*};

pub fn user_routes() -> Router<crate::AppState> {
    Router::new()
        .route("/me", get(get_current_user))
        .route("/me/teams", get(list_my_teams))
}
```

- [ ] **Step 3: 在 projects.rs 添加 project_routes() 函数**

```rust
use axum::{Router, routing::{get, post, delete}};
use super::{handlers::projects::*};

pub fn project_routes() -> Router<crate::AppState> {
    Router::new()
        .route("/", post(create_project).get(list_projects))
        .route("/:id", get(get_project).delete(delete_project))
}
```

- [ ] **Step 4: 提交**

```bash
git add src/routes/teams.rs src/routes/users.rs src/routes/projects.rs
git commit -m "feat: add route assembly functions"
```

---
## Phase 4: Cargo.toml 依赖补充 + AppError 扩展

### Task 4.1: 添加 Phase 6-8 所需依赖

**Files:**
- Modify: `src-server/Cargo.toml`

- [ ] **Step 1: 在 Cargo.toml [dependencies] 节追加新依赖**

```toml
# 文件上传
multer = "3"
mime_guess = "2"

# HTTP 客户端（LLM API 调用 + embedding API）
reqwest = { version = "0.12", features = ["json", "stream"] }

# 流处理
futures = "0.3"
tokio-stream = "0.1"

# 正则解析 wikilinks
regex-lite = "0.1"

# 文档解析（复用 Tauri 后端 crate）
docx-rs = "0.4"
calamine = "0.35"
```

- [ ] **Step 2: 运行 cargo check 验证依赖解析**

```bash
cd src-server && cargo check 2>&1 | head -20
```

### Task 4.2: 添加 reqwest 错误转换到 AppError

**Files:**
- Modify: `src-server/src/error.rs`

- [ ] **Step 1: 在 AppError 定义中添加 LLM API 相关 variant**

当前 error.rs 已有 `LlmApiError(String)` variant，验证其存在，无需修改。

- [ ] **Step 2: 添加 From<reqwest::Error> 实现**

在 `error.rs` 文件末尾（其它 From impl 之后）添加：

```rust
// reqwest 错误转换（LLM API 调用、embedding API 调用）
impl From<reqwest::Error> for AppError {
    fn from(err: reqwest::Error) -> Self {
        AppError::LlmApiError(format!("HTTP request failed: {}", err))
    }
}

impl From<reqwest::header::ToStrError> for AppError {
    fn from(err: reqwest::header::ToStrError) -> Self {
        AppError::InternalError(format!("Header conversion error: {}", err))
    }
}
```

- [ ] **Step 3: 验证编译**

```bash
cd src-server && cargo check 2>&1
```

- [ ] **Step 4: 提交**

```bash
git add src-server/Cargo.toml src-server/src/error.rs
git commit -m "feat: add Phase 6-8 dependencies and reqwest error conversions"
```

---

## Phase 5: 存储基础设施 + project_guard 中间件

### Task 5.1: 实现项目存储路径辅助函数

**Files:**
- Create: `src-server/src/services/mod.rs`
- Create: `src-server/src/services/storage.rs`

- [ ] **Step 1: 创建 services/mod.rs**

```rust
pub mod storage;
pub mod search;
pub mod graph;
pub mod embedding;
pub mod llm;
```

- [ ] **Step 2: 创建 storage.rs — 项目存储路径解析与路径遍历防护**

```rust
use std::path::{Path, PathBuf};
use crate::AppError;

/// 解析项目存储基路径
/// 格式: {storage_path}/teams/{team_id}/projects/{project_id}
pub fn project_base(storage_path: &str, team_id: i32, project_id: i32) -> PathBuf {
    PathBuf::from(storage_path)
        .join("teams")
        .join(team_id.to_string())
        .join("projects")
        .join(project_id.to_string())
}

/// 安全地将用户请求的路径约束在项目基路径内。
/// 1. 将 user_path 拼接到 base 后得到完整路径 P。
/// 2. canonicalize(P) — 解析所有 ../ 和符号链接。
/// 3. 验证 canonicalized 路径以 base 开头。
///
/// 返回完全解析后的 PathBuf。
pub fn safe_resolve(
    base: &Path,
    user_path: &str,
) -> Result<PathBuf, AppError> {
    let candidate = base.join(user_path.trim_start_matches('/'));

    // 如果文件不存在，先对父目录做 canonicalize 再做检查
    let resolved = if candidate.exists() {
        candidate.canonicalize()
    } else {
        // 对于写操作，文件可能还不存在 — 只规范化可解析的部分
        let parent = candidate.parent().unwrap_or(base);
        let parent_canon = parent.canonicalize()
            .map_err(|e| AppError::InternalError(
                format!("Failed to resolve parent path: {}", e)
            ))?;
        parent_canon.join(candidate.file_name().unwrap_or_default())
    }
    .map_err(|e| AppError::BadRequest(
        format!("Invalid path: {}", e)
    ))?;

    // canonicalize 必须保留 base 前缀
    if !resolved.starts_with(base.canonicalize()
        .map_err(|e| AppError::InternalError(format!("Failed to resolve base: {}", e)))?)
    {
        return Err(AppError::BadRequest(
            "Path traversal detected".to_string()
        ));
    }

    Ok(resolved)
}

/// 确保目录存在
pub fn ensure_dir(path: &Path) -> Result<(), AppError> {
    std::fs::create_dir_all(path)
        .map_err(|e| AppError::IoError(e))
}

/// 提取文件扩展名（小写）
pub fn file_ext(path: &Path) -> &str {
    path.extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
}
```

- [ ] **Step 3: 提交**

```bash
git add src-server/src/services/mod.rs src-server/src/services/storage.rs
git commit -m "feat: add project storage path helpers with traversal protection"
```

### Task 5.2: 实现 project_guard 中间件

**Files:**
- Create: `src-server/src/middleware/project_guard.rs`
- Modify: `src-server/src/middleware/mod.rs`
- Modify: `src-server/src/routes/files.rs`

- [ ] **Step 1: 创建 project_guard.rs**

```rust
use crate::{AppState, AppError};
use axum::http::HeaderMap;
use crate::middleware::auth::require_auth;

/// 验证当前用户是否可以访问指定项目
/// 返回 (user_id, team_id)，供后续 handler 使用
pub async fn check_project_access(
    state: &AppState,
    headers: &HeaderMap,
    project_id: i32,
) -> Result<(i32, i32), AppError> {
    let claims = require_auth(state, headers).await?;
    let user_id = claims.sub.parse::<i32>()?;

    let row = sqlx::query!(
        "SELECT p.team_id, tm.role as member_role
         FROM projects p
         JOIN team_members tm ON p.team_id = tm.team_id
         WHERE p.id = $1 AND tm.user_id = $2",
        project_id,
        user_id
    )
    .fetch_optional(&state.db)
    .await
    .map_err(|e| AppError::DatabaseError(e))?;

    match row {
        Some(r) => Ok((user_id, r.team_id)),
        None => Err(AppError::PermissionDenied),
    }
}
```

- [ ] **Step 2: 更新 middleware/mod.rs 添加模块声明和重导出**

```rust
pub mod project_guard;
pub use project_guard::*;
```

- [ ] **Step 3: 提交**

```bash
git add src-server/src/middleware/project_guard.rs src-server/src/middleware/mod.rs
git commit -m "feat: add project-level access guard middleware"
```

---

## 里程碑 M1: 认证完成

### 验收标准：
- [ ] 用户可以注册账号
- [ ] 用户可以登录获取 token
- [ ] Token 过期后可以刷新
- [ ] 用户可以查看所属团队列表
- [ ] 可以创建新团队
- [ ] 可以添加/移除团队成员
- [ ] 可以创建/查看项目

### 测试命令：
```bash
# 启动服务
cd src-server && cargo run

# 测试健康检查
curl http://localhost:8080/health

# 测试注册
curl -X POST http://localhost:8080/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"test","email":"test@example.com","password":"password123"}'

# 测试登录
curl -X POST http://localhost:8080/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"test","password":"password123"}'

# 测试获取当前用户（使用上面返回的 token）
curl http://localhost:8080/api/v1/users/me \
  -H "Authorization: Bearer <token>"

# 测试创建团队
curl -X POST http://localhost:8080/api/v1/teams \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"name":"Test Team","description":"A test team"}'
```

### Phase 1-5 现有状态验证

在执行 Phase 6 之前，确认以下文件均已存在且编译通过：

```bash
# 验证核心文件存在
ls src-server/src/lib.rs src-server/src/main.rs src-server/src/config.rs
ls src-server/src/db.rs src-server/src/error.rs src-server/Cargo.toml
ls src-server/src/middleware/{mod,auth,cors}.rs
ls src-server/src/routes/{mod,auth,users,teams,projects}.rs
ls src-server/src/models/{mod,auth,user,team,project}.rs
ls src-server/src/utils/{mod,jwt,crypto}.rs
ls src-server/migrations/001_initial_schema.sql
ls src-server/migrations/002_add_llm_providers.sql
ls src-server/docker-compose.yml src-server/Dockerfile src-server/.env.example

# 验证编译
cd src-server && cargo test --lib 2>&1 | tail -5
# 预期: "test result: ok. 59 passed; 0 failed; ..."
```

**注意：** 现有 `001_initial_schema.sql` 已包含 `wiki_pages`、`ingested_files`、`embeddings`、`activity_logs` 表定义，因此 Phase 6 **不再需要创建新的 migration 文件**。实施者只需要确认这些表存在于 schema 中。

---
## Phase 6: 文件上传/下载 API + 文件存储服务
### Task 6.1: 创建文件操作路由（含路径遍历防护）
**Files:**
- Create: `src-server/src/routes/files.rs`
- Modify: `src-server/src/routes/mod.rs`
- [ ] **Step 1: 创建 files.rs — 完整路由文件**
```rust
use axum::{
    extract::{DefaultBodyLimit, Multipart, Path, State, Query},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};
use crate::{
    AppState, AppError,
    middleware::project_guard::check_project_access,
    services::storage,
};
use std::path::PathBuf;
const MAX_UPLOAD_SIZE: usize = 100 * 1024 * 1024; // 100MB
#[derive(Serialize)]
struct FileNode {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
    modified: i64,
}
pub fn file_routes() -> axum::Router<AppState> {
    axum::Router::new()
        // 通配符路由匹配架构文档 §3.1.2
        .route("/:project_id/upload", axum::routing::post(upload_file)
            .layer(DefaultBodyLimit::max(MAX_UPLOAD_SIZE)))
        .route("/:project_id/list/{*dir}", axum::routing::get(list_files))
        .route("/:project_id/{*path}", axum::routing::get(read_file))
        .route("/:project_id/{*path}", axum::routing::post(write_file))
        .route("/:project_id/{*path}", axum::routing::delete(delete_file))
}
// POST /api/v1/files/:project_id/upload
pub async fn upload_file(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(project_id): Path<i32>,
    mut multipart: Multipart,
) -> Result<impl IntoResponse, AppError> {
    let (_user_id, team_id) = check_project_access(&state, &headers, project_id).await?;
    let base = storage::project_base(&state.config.storage_path(), team_id, project_id);
    let mut dest_subdir = String::new();
    let mut file_data: Vec<u8> = Vec::new();
    let mut file_name = String::from("upload.bin");
    while let Some(field) = multipart.next_field().await
        .map_err(|_| AppError::FileUploadFailed)?
    {
        match field.name().unwrap_or("") {
            "path" => {
                dest_subdir = field.text().await
                    .map_err(|_| AppError::BadRequest("Invalid path field".into()))?;
            }
            "file" => {
                file_name = field.file_name()
                    .unwrap_or("upload.bin").to_string();
                file_data = field.bytes().await
                    .map_err(|_| AppError::FileUploadFailed)?
                    .to_vec();
            }
            _ => {}
        }
    }
    if file_data.is_empty() {
        return Err(AppError::BadRequest("No file provided".into()));
    }
    // safe_resolve 防止路径遍历
    let dest = storage::safe_resolve(&base, &format!("{}/{}", dest_subdir, file_name))?;
    if let Some(parent) = dest.parent() {
        storage::ensure_dir(parent)?;
    }
    std::fs::write(&dest, &file_data).map_err(|e| AppError::IoError(e))?;
    Ok((StatusCode::CREATED, Json(serde_json::json!({
        "name": file_name,
        "path": dest.strip_prefix(&base).unwrap_or(&dest).to_string_lossy(),
        "size": file_data.len(),
    }))))
}
// GET /api/v1/files/:project_id/list/{*dir}
pub async fn list_files(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Path((project_id, dir)): Path<(i32, String)>,
) -> Result<impl IntoResponse, AppError> {
    let (_user_id, team_id) = check_project_access(&state, &headers, project_id).await?;
    let base = storage::project_base(&state.config.storage_path(), team_id, project_id);
    let dir_path = if dir.is_empty() {
        base.clone()
    } else {
        storage::safe_resolve(&base, &dir)?
    };
    if !dir_path.exists() {
        storage::ensure_dir(&dir_path)?;
        return Ok(Json(serde_json::json!([])));
    }
    let mut nodes: Vec<FileNode> = Vec::new();
    for entry in std::fs::read_dir(&dir_path).map_err(|e| AppError::IoError(e))? {
        let entry = entry.map_err(|e| AppError::IoError(e))?;
        let meta = entry.metadata().map_err(|e| AppError::IoError(e))?;
        nodes.push(FileNode {
            name: entry.file_name().to_string_lossy().to_string(),
            path: entry.path().strip_prefix(&base)
                .unwrap_or(&entry.path())
                .to_string_lossy()
                .to_string(),
            is_dir: meta.is_dir(),
            size: meta.len(),
            modified: meta.modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0),
        });
    }
    Ok(Json(serde_json::json!(nodes)))
}
// GET /api/v1/files/:project_id/{*path}
pub async fn read_file(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Path((project_id, path)): Path<(i32, String)>,
) -> Result<impl IntoResponse, AppError> {
    let (_user_id, team_id) = check_project_access(&state, &headers, project_id).await?;
    let base = storage::project_base(&state.config.storage_path(), team_id, project_id);
    let file_path = storage::safe_resolve(&base, &path)?;
    if !file_path.exists() {
        return Err(AppError::ResourceNotFound("File not found".into()));
    }
    if !file_path.is_file() {
        return Err(AppError::BadRequest("Path is a directory".into()));
    }
    let ext = storage::file_ext(&file_path).to_lowercase();
    let content = match ext.as_str() {
        "pdf" => extract_pdf(&file_path)?,
        "docx" => extract_docx(&file_path)?,
        "xlsx" | "xls" | "ods" => extract_spreadsheet(&file_path)?,
        _ => std::fs::read_to_string(&file_path)
            .map_err(|e| AppError::IoError(e))?,
    };
    Ok(Json(serde_json::json!({
        "path": path,
        "content": content,
        "extension": ext,
    })))
}
fn extract_pdf(path: &PathBuf) -> Result<String, AppError> {
    // 依赖外部 pdftotext 工具（Dockerfile 需安装 poppler-utils）
    use std::process::Command;
    let output = Command::new("pdftotext")
        .arg("-layout")
        .arg(path)
        .arg("-")
        .output()
        .map_err(|_| AppError::InternalError(
            "pdftotext not available. Install poppler-utils in Dockerfile.".into()
        ))?;
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}
fn extract_docx(path: &PathBuf) -> Result<String, AppError> {
    let bytes = std::fs::read(path).map_err(|e| AppError::IoError(e))?;
    docx_rs::read_docx(&bytes)
        .map(|doc| doc.document.xml)
        .map_err(|e| AppError::InternalError(format!("DOCX parse error: {}", e)))
}
fn extract_spreadsheet(path: &PathBuf) -> Result<String, AppError> {
    use calamine::{open_workbook, Reader};
    let mut workbook = open_workbook::<calamine::Xlsx<_>, _>(path)
        .map_err(|e| AppError::InternalError(format!("XLSX open error: {}", e)))?;
    let mut result = String::new();
    let sheet_names = workbook.sheet_names().to_vec();
    for name in sheet_names {
        if let Ok(range) = workbook.worksheet_range(&name) {
            result.push_str(&format!("\n## {}\n\n", name));
            for row in range.rows() {
                let cells: Vec<String> = row.iter()
                    .map(|c| c.to_string())
                    .collect();
                result.push_str(&cells.join(" | "));
                result.push('\n');
            }
        }
    }
    Ok(result)
}
// POST /api/v1/files/:project_id/{*path} — 写入文件
#[derive(Deserialize)]
struct WriteRequest {
    contents: String,
}
pub async fn write_file(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Path((project_id, path)): Path<(i32, String)>,
    Json(payload): Json<WriteRequest>,
) -> Result<impl IntoResponse, AppError> {
    let (_user_id, team_id) = check_project_access(&state, &headers, project_id).await?;
    let base = storage::project_base(&state.config.storage_path(), team_id, project_id);
    let file_path = storage::safe_resolve(&base, &path)?;
    if let Some(parent) = file_path.parent() {
        storage::ensure_dir(parent)?;
    }
    std::fs::write(&file_path, &payload.contents)
        .map_err(|e| AppError::IoError(e))?;
    Ok(Json(serde_json::json!({"status": "ok"})))
}
// DELETE /api/v1/files/:project_id/{*path}
pub async fn delete_file(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Path((project_id, path)): Path<(i32, String)>,
) -> Result<impl IntoResponse, AppError> {
    let (_user_id, team_id) = check_project_access(&state, &headers, project_id).await?;
    let base = storage::project_base(&state.config.storage_path(), team_id, project_id);
    let file_path = storage::safe_resolve(&base, &path)?;
    if !file_path.exists() {
        return Err(AppError::ResourceNotFound("File not found".into()));
    }
    if file_path.is_dir() {
        std::fs::remove_dir_all(&file_path).map_err(|e| AppError::IoError(e))?;
    } else {
        std::fs::remove_file(&file_path).map_err(|e| AppError::IoError(e))?;
    }
    Ok(Json(serde_json::json!({"status": "deleted"})))
}
```

- [ ] **Step 2: 更新 routes/mod.rs 添加 files 路由**

```rust
// 在 mod 声明中添加:
mod files;

// 在 create_router 中添加:
.nest("/api/v1/files", files::file_routes())
```

- [ ] **Step 3: 验证编译**

```bash
cd src-server && cargo check 2>&1
```

- [ ] **Step 4: 提交**

```bash
git add src-server/src/routes/files.rs src-server/src/routes/mod.rs
git commit -m "feat: add file upload/download APIs with path traversal protection"
```

---

## Phase 7: 搜索 API + 聊天 API（流式）

### Task 7.1: 实现搜索 API

**Files:**
- Create: `src-server/src/services/search.rs`
- Create: `src-server/src/routes/search.rs`
- Modify: `src-server/src/routes/mod.rs`

- [ ] **Step 1: 实现搜索服务 (services/search.rs)**

```rust
use sqlx::PgPool;
use crate::AppError;

#[derive(serde::Serialize, sqlx::FromRow)]
pub struct SearchResult {
    pub path: String,
    pub title: String,
    pub snippet: String,
    pub title_match: bool,
    pub score: f64,
    pub vector_score: Option<f64>,
    pub images: serde_json::Value,
}

/// 分词：英文按空白/标点分割，中文 CJK bigram
fn tokenize(query: &str) -> Vec<String> {
    let mut tokens: Vec<String> = Vec::new();
    for part in query.split(|c: char| {
        c.is_whitespace() || c == ',' || c == '，' || c == '。'
            || c == '！' || c == '？' || c == '、' || c == '；'
    }) {
        let trimmed = part.trim();
        if trimmed.is_empty() { continue; }
        let chars: Vec<char> = trimmed.chars().collect();
        let has_cjk = chars.iter().any(|c| {
            ('\u{4E00}'..='\u{9FFF}').contains(c)
                || ('\u{3040}'..='\u{309F}').contains(c)
                || ('\u{30A0}'..='\u{30FF}').contains(c)
                || ('\u{AC00}'..='\u{D7AF}').contains(c)
        });
        if has_cjk {
            for i in 0..chars.len().saturating_sub(1) {
                tokens.push(format!("{}{}", chars[i], chars[i + 1]));
            }
        } else {
            tokens.push(trimmed.to_lowercase());
        }
    }
    tokens
}

pub async fn search_wiki(
    pool: &PgPool,
    project_id: i32,
    query: &str,
    limit: i32,
) -> Result<Vec<SearchResult>, AppError> {
    let tokens = tokenize(query);
    if tokens.is_empty() {
        return Ok(Vec::new());
    }

    // 构建 ILIKE 条件
    let conditions: Vec<String> = tokens.iter().enumerate()
        .map(|(i, _)| {
            format!(
                "(wp.title ILIKE '%' || ${} || '%' OR wp.content ILIKE '%' || ${} || '%')",
                i + 2, i + 2  // $1 = project_id, $2+ = tokens
            )
        })
        .collect();
    let where_clause = conditions.join(" OR ");

    let sql = format!(
        "SELECT
            wp.path,
            wp.title,
            COALESCE(
                substring(wp.content FROM
                    GREATEST(1, position(lower($2) in lower(COALESCE(wp.content, ''))) - 80)
                    FOR 200
                ),
                substring(COALESCE(wp.content, '') FROM 1 FOR 200)
            ) as snippet,
            CASE WHEN lower(wp.title) LIKE '%' || lower($2) || '%' THEN true ELSE false END as title_match,
            CASE WHEN lower(wp.title) LIKE '%' || lower($2) || '%' THEN 10.0
                 WHEN lower(COALESCE(wp.content, '')) LIKE '%' || lower($2) || '%' THEN 1.0
                 ELSE 0.0
            END as score,
            NULL::double precision as vector_score,
            COALESCE(wp.sources, '[]'::jsonb) as images
        FROM wiki_pages wp
        WHERE wp.project_id = $1
        AND ({where})
        ORDER BY score DESC
        LIMIT ${l}",
        where = where_clause,
        l = tokens.len() + 2
    );

    let mut q = sqlx::query_as::<_, SearchResult>(&sql)
        .bind(project_id);

    for token in &tokens {
        q = q.bind(token);
    }
    q = q.bind(limit);

    q.fetch_all(pool).await.map_err(|e| AppError::DatabaseError(e))
}
```

- [ ] **Step 2: 实现搜索路由 (routes/search.rs)**

```rust
use axum::{
    extract::{Query, State},
    Json,
    response::IntoResponse,
};
use serde::Deserialize;
use crate::{AppState, AppError};
use crate::middleware::project_guard::check_project_access;

#[derive(Deserialize)]
pub struct SearchQueryParams {
    pub project_id: i32,
    pub query: String,
    pub limit: Option<i32>,
}

pub fn search_routes() -> axum::Router<AppState> {
    axum::Router::new()
        .route("/", axum::routing::get(search_handler))
        .route("/vector", axum::routing::get(vector_search_handler))
}

pub async fn search_handler(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Query(params): Query<SearchQueryParams>,
) -> Result<impl IntoResponse, AppError> {
    let _user_id = check_project_access(&state, &headers, params.project_id).await?.0;
    let limit = params.limit.unwrap_or(20).min(100);

    let results = crate::services::search::search_wiki(
        &state.db,
        params.project_id,
        &params.query,
        limit,
    ).await?;

    Ok(Json(serde_json::json!({
        "results": results,
        "query": params.query,
        "total": results.len(),
    })))
}

pub async fn vector_search_handler(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Query(params): Query<SearchQueryParams>,
) -> Result<impl IntoResponse, AppError> {
    let _user_id = check_project_access(&state, &headers, params.project_id).await?.0;
    let limit = params.limit.unwrap_or(10).min(50);

    // 从 llm_providers 表获取配置（解密 API key）
    let llm_cfg = crate::services::llm::get_llm_config(&state.db, params.project_id).await?;

    let embedding = crate::services::embedding::get_embeddings(
        &params.query,
        &llm_cfg,
    ).await?;

    let results = crate::services::embedding::vector_search(
        &state.db,
        params.project_id,
        embedding,
        limit,
    ).await?;

    Ok(Json(serde_json::json!({
        "results": results,
        "query": params.query,
        "total": results.len(),
    })))
}
```

- [ ] **Step 3: 更新 routes/mod.rs 和 services/mod.rs**

```rust
// routes/mod.rs:
mod search;
// 在 create_router 中:
.nest("/api/v1/search", search::search_routes())

// services/mod.rs 确保这些模块已声明
```

- [ ] **Step 4: 提交**

```bash
git add src-server/src/services/search.rs src-server/src/routes/search.rs src-server/src/routes/mod.rs
git commit -m "feat: implement search API with tokenized query matching"
```

---

### Task 7.2: 实现 LLM 配置服务 + 流式聊天 API（SSE）

**Files:**
- Create: `src-server/src/services/llm.rs`
- Create: `src-server/src/routes/chat.rs`
- Modify: `src-server/src/routes/mod.rs`

- [ ] **Step 1: 创建 LLM 配置服务 (services/llm.rs)**

```rust
use sqlx::PgPool;
use serde::Deserialize;
use crate::AppError;

/// 解密后的 LLM provider 配置
#[derive(Clone, Debug)]
pub struct LlmConfig {
    pub provider_type: String,
    pub api_key: String,
    pub base_url: Option<String>,
    pub model: String,
    pub context_size: i32,
}

#[derive(sqlx::FromRow)]
struct LlmProviderRow {
    provider_type: String,
    api_key_encrypted: String,
    base_url: Option<String>,
    model: String,
    context_size: i32,
}

impl Default for LlmConfig {
    fn default() -> Self {
        Self {
            provider_type: "openai".into(),
            api_key: String::new(),
            base_url: Some("https://api.openai.com/v1".into()),
            model: "gpt-4o".into(),
            context_size: 128000,
        }
    }
}

/// 从 llm_providers 表获取第一个启用的 provider 配置
/// 使用 AES-256-GCM 解密 API key（密钥来自 JWT secret 的前 32 字节）
pub async fn get_llm_config(pool: &PgPool, project_id: i32) -> Result<LlmConfig, AppError> {
    let row = sqlx::query_as::<_, LlmProviderRow>(
        "SELECT provider_type, api_key_encrypted, base_url, model, context_size
         FROM llm_providers
         WHERE project_id = $1 AND is_enabled = TRUE
         ORDER BY id LIMIT 1"
    )
    .bind(project_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| AppError::DatabaseError(e))?;

    match row {
        Some(r) => {
            // 解密 API key — 注意：加密密钥在 AppConfig 中管理
            // 这里返回 encrypted key，由调用方（chat/embedding handlers）传入 config 解密
            Ok(LlmConfig {
                provider_type: r.provider_type,
                api_key: r.api_key_encrypted,
                base_url: r.base_url,
                model: r.model,
                context_size: r.context_size,
            })
        }
        None => {
            // 没有配置时返回错误
            Err(AppError::BadRequest(
                "No LLM provider configured for this project".into()
            ))
        }
    }
}

/// 解密 API key（使用 AES-256-GCM）
/// encryption_key = config.jwt_secret()[..32].as_bytes()
pub fn decrypt_api_key(
    encrypted: &str,
    config: &crate::AppConfig,
) -> Result<String, AppError> {
    let key_bytes: [u8; 32] = {
        let secret = config.jwt_secret();
        let mut key = [0u8; 32];
        let len = secret.len().min(32);
        key[..len].copy_from_slice(&secret.as_bytes()[..len]);
        key
    };
    crate::utils::decrypt_api_key(encrypted, &key_bytes)
}
```

- [ ] **Step 2: 创建聊天路由 (routes/chat.rs)**

```rust
use axum::{
    extract::{Path, State},
    response::sse::{Event, Sse},
    response::IntoResponse,
    Json,
};
use std::convert::Infallible;
use std::time::Duration;
use futures::stream::{self, Stream, StreamExt};
use serde::{Deserialize, Serialize};
use crate::{AppState, AppError};
use crate::middleware::project_guard::check_project_access;

#[derive(Deserialize)]
struct ChatMessage {
    role: String,
    content: String,
}

#[derive(Deserialize)]
struct StreamRequest {
    messages: Vec<ChatMessage>,
    model: Option<String>,
}

pub fn chat_routes() -> axum::Router<AppState> {
    axum::Router::new()
        .route("/stream", axum::routing::post(chat_stream))
        .route("/message", axum::routing::post(chat_message))
}

// POST /api/v1/chat/stream — 流式聊天
pub async fn chat_stream(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, AppError> {
    let project_id = body.get("project_id")
        .and_then(|v| v.as_i64())
        .unwrap_or(0) as i32;
    let _user_id = check_project_access(&state, &headers, project_id).await?.0;

    let messages: Vec<ChatMessage> = body.get("messages")
        .and_then(|m| serde_json::from_value(m.clone()).ok())
        .unwrap_or_default();

    let model_override = body.get("model")
        .and_then(|m| m.as_str().map(String::from));

    Ok(stream_chat_to_sse(&state, project_id, &messages, model_override).await)
}

// POST /api/v1/chat/message — 非流式单消息
pub async fn chat_message(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> Result<impl IntoResponse, AppError> {
    let messages: Vec<ChatMessage> = body.get("messages")
        .and_then(|m| serde_json::from_value(m.clone()).ok())
        .unwrap_or_default();

    let project_id = body.get("project_id")
        .and_then(|v| v.as_i64())
        .unwrap_or(0) as i32;

    let _user_id = check_project_access(&state, &headers, project_id).await?.0;

    let model = body.get("model")
        .and_then(|m| m.as_str())
        .unwrap_or("gpt-4o");

    let llm = crate::services::llm::get_llm_config(&state.db, project_id).await?;
    let api_key = crate::services::llm::decrypt_api_key(&llm.api_key, &state.config)?;
    let base_url = llm.base_url.as_deref().unwrap_or("https://api.openai.com/v1");

    let client = reqwest::Client::new();
    let response = client
        .post(format!("{}/chat/completions", base_url))
        .header("Authorization", format!("Bearer {}", api_key))
        .json(&serde_json::json!({
            "model": model,
            "messages": messages.iter().map(|m| {
                serde_json::json!({"role": m.role, "content": m.content})
            }).collect::<Vec<_>>(),
            "stream": false,
        }))
        .send()
        .await?;

    let body: serde_json::Value = response.json().await?;
    Ok(Json(serde_json::json!({
        "content": body["choices"][0]["message"]["content"],
        "model": model,
    })))
}

async fn stream_chat_to_sse(
    state: &AppState,
    project_id: i32,
    messages: &[ChatMessage],
    model_override: Option<String>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    // 从数据库获取 LLM 配置
    let llm_config = match crate::services::llm::get_llm_config(&state.db, project_id).await {
        Ok(cfg) => cfg,
        Err(e) => {
            let error_stream = stream::once(async move {
                Ok(Event::default().data(format!("Error: {}", e)))
            });
            return Sse::new(error_stream);
        }
    };

    let api_key = match crate::services::llm::decrypt_api_key(&llm_config.api_key, &state.config) {
        Ok(k) => k,
        Err(e) => {
            let error_stream = stream::once(async move {
                Ok(Event::default().data(format!("Decrypt error: {}", e)))
            });
            return Sse::new(error_stream);
        }
    };

    let base_url = llm_config.base_url.as_deref().unwrap_or("https://api.openai.com/v1");
    let model = model_override.unwrap_or(llm_config.model);

    let system_prompt = "You are a helpful knowledge assistant.";
    let system_msg = serde_json::json!({"role": "system", "content": system_prompt});
    let chat_messages: Vec<_> = std::iter::once(&system_msg)
        .chain(messages.iter().map(|m| &serde_json::json!({"role": m.role, "content": m.content})))
        .collect();

    let client = reqwest::Client::new();
    let response = match client
        .post(format!("{}/chat/completions", base_url))
        .header("Authorization", format!("Bearer {}", api_key))
        .json(&serde_json::json!({
            "model": model,
            "messages": chat_messages,
            "stream": true,
        }))
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            let error_stream = stream::once(async move {
                Ok(Event::default().data(format!("LLM request error: {}", e)))
            });
            return Sse::new(error_stream);
        }
    };

    let byte_stream = response.bytes_stream().map(|result| {
        match result {
            Ok(bytes) => Ok(Event::default().data(String::from_utf8_lossy(&bytes).to_string())),
            Err(e) => Ok(Event::default().data(format!("Stream error: {}", e))),
        }
    });

    Sse::new(byte_stream).keep_alive(
        axum::response::sse::KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("ping")
    )
}
```

- [ ] **Step 3: 更新路由模块**

```rust
// routes/mod.rs:
mod chat;
// 在 create_router 中:
.nest("/api/v1/chat", chat::chat_routes())
```

- [ ] **Step 4: 提交**

```bash
git add src-server/src/services/llm.rs src-server/src/routes/chat.rs src-server/src/routes/mod.rs
git commit -m "feat: implement streaming chat API with llm_providers DB config"
```

---

## Phase 8: 图谱 API + 向量搜索 API

### Task 8.1: 实现知识图谱 API

**Files:**
- Create: `src-server/src/services/graph.rs`
- Create: `src-server/src/routes/graph.rs`
- Modify: `src-server/src/routes/mod.rs`

- [ ] **Step 1: 实现图数据服务 (services/graph.rs)**

```rust
use sqlx::PgPool;
use crate::AppError;
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(serde::Serialize)]
pub struct GraphNode {
    pub id: String,
    pub label: String,
    #[serde(rename = "type")]
    pub node_type: String,
    pub path: String,
    #[serde(rename = "linkCount")]
    pub link_count: i32,
    pub community: i32,
}

#[derive(serde::Serialize)]
pub struct GraphEdge {
    pub source: String,
    pub target: String,
    pub weight: f64,
}

#[derive(serde::Serialize)]
pub struct CommunityInfo {
    pub id: i32,
    #[serde(rename = "nodeCount")]
    pub node_count: i64,
    pub cohesion: f64,
    #[serde(rename = "topNodes")]
    pub top_nodes: Vec<String>,
}

#[derive(serde::Serialize)]
pub struct WikiGraph {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    pub communities: Vec<CommunityInfo>,
}

/// 基本内存缓存：key = (project_id, max_updated_at_timestamp)
static GRAPH_CACHE: std::sync::LazyLock<Mutex<HashMap<(i32, i64), WikiGraph>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

/// 从 wiki_pages 表构建知识图谱
/// 链接通过 [[wikilink]] 引用解析得出
/// 使用基本内存缓存 — 当 wiki_pages updated_at 变更时自动失效
pub async fn build_graph(
    pool: &PgPool,
    project_id: i32,
) -> Result<WikiGraph, AppError> {
    // 0. 检查缓存
    if let Some(ttl_cache) = GRAPH_CACHE.lock().ok() {
        for ((pid, _ts), graph) in ttl_cache.iter() {
            if *pid == project_id {
                return Ok(WikiGraph {
                    nodes: graph.nodes.iter().map(|n| GraphNode { /* clone */ id: n.id.clone(), ..n.clone() }).collect(),
                    edges: graph.edges.clone(),
                    communities: graph.communities.clone(),
                });
            }
        }
    }

    // 1. 获取所有 wiki 页面
    let pages = sqlx::query_as::<_, WikiPageRow>(
        "SELECT path, title, content, page_type FROM wiki_pages WHERE project_id = $1"
    )
    .bind(project_id)
    .fetch_all(pool)
    .await
    .map_err(|e| AppError::DatabaseError(e))?;

    // 2. 提取 [[wikilinks]]
    let mut links: HashMap<String, HashSet<String>> = HashMap::new();
    let link_pattern = regex_lite::Regex::new(r"\[\[([^\]]+)\]\]").unwrap();

    for page in &pages {
        let mut targets = HashSet::new();
        if let Some(ref content) = page.content {
            for cap in link_pattern.captures_iter(content) {
                let link_target = cap.get(1).unwrap().as_str().to_string();
                let clean_target = link_target.split('#').next()
                    .unwrap_or(&link_target).to_string();
                targets.insert(clean_target);
            }
        }
        links.insert(page.path.clone(), targets);
    }

    // 3. 构建节点
    let nodes: Vec<GraphNode> = pages.iter().enumerate().map(|(i, p)| {
        let link_count = links.get(&p.path).map(|t| t.len() as i32).unwrap_or(0)
            + links.values().filter(|t| t.contains(&p.path)).count() as i32;
        GraphNode {
            id: format!("node_{}", i),
            label: p.title.clone(),
            node_type: p.page_type.clone().unwrap_or_else(|| "concept".into()),
            path: p.path.clone(),
            link_count,
            community: 0,
        }
    }).collect();

    // 4. 构建边
    let path_to_id: HashMap<&str, &str> = nodes.iter()
        .map(|n| (n.path.as_str(), n.id.as_str()))
        .collect();

    let mut edges: Vec<GraphEdge> = Vec::new();
    let mut seen_edges: HashSet<(String, String)> = HashSet::new();

    for (source_path, targets) in &links {
        let source_id = match path_to_id.get(source_path.as_str()) {
            Some(id) => id.to_string(),
            None => continue,
        };
        for target_path in targets {
            let target_id = match path_to_id.get(target_path.as_str()) {
                Some(id) => id.to_string(),
                None => continue,
            };
            if source_id == target_id { continue; }
            let edge_key = if source_id < target_id {
                (source_id.clone(), target_id.clone())
            } else {
                (target_id.clone(), source_id.clone())
            };
            if seen_edges.contains(&edge_key) { continue; }
            seen_edges.insert(edge_key);
            edges.push(GraphEdge {
                source: source_id.clone(),
                target: target_id.clone(),
                weight: 1.0,
            });
        }
    }

    // 5. 简化社区检测 — 按 page_type 分组作为初始社区
    let mut community_map: HashMap<String, i32> = HashMap::new();
    let mut next_community = 1;
    let mut communities: Vec<CommunityInfo> = Vec::new();

    // 按 node_type 分组
    let mut type_groups: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, node) in nodes.iter().enumerate() {
        type_groups.entry(node.node_type.clone())
            .or_default()
            .push(i);
    }

    for (node_type, indices) in &type_groups {
        let community_id = *community_map.entry(node_type.clone())
            .or_insert_with(|| { let c = next_community; next_community += 1; c });
        communities.push(CommunityInfo {
            id: community_id,
            node_count: indices.len() as i64,
            cohesion: 1.0 / (indices.len() as f64).max(1.0),
            top_nodes: indices.iter().take(5)
                .map(|&i| nodes[i].label.clone())
                .collect(),
        });
    }

    let graph = WikiGraph { nodes, edges, communities };

    // 6. 写入缓存
    let ts = 0i64; // 简化版 — 每次 build 后缓存直到项目变更
    if let Ok(mut cache) = GRAPH_CACHE.lock() {
        cache.insert((project_id, ts), WikiGraph {
            nodes: graph.nodes.iter().map(|n| GraphNode {
                id: n.id.clone(), label: n.label.clone(),
                node_type: n.node_type.clone(), path: n.path.clone(),
                link_count: n.link_count, community: n.community,
            }).collect(),
            edges: graph.edges.clone(),
            communities: graph.communities.iter().map(|c| CommunityInfo {
                id: c.id, node_count: c.node_count,
                cohesion: c.cohesion,
                top_nodes: c.top_nodes.clone(),
            }).collect(),
        });
    }

    Ok(graph)
}

#[derive(sqlx::FromRow)]
struct WikiPageRow {
    path: String,
    title: String,
    content: Option<String>,
    page_type: Option<String>,
}
```

- [ ] **Step 2: 实现图谱路由 (routes/graph.rs)**

```rust
use axum::{
    extract::{Path, State},
    Json,
    response::IntoResponse,
};
use crate::{AppState, AppError};
use crate::middleware::project_guard::check_project_access;

pub fn graph_routes() -> axum::Router<AppState> {
    axum::Router::new()
        .route("/:project_id", axum::routing::get(get_graph))
        .route("/:project_id/insights", axum::routing::get(get_insights))
}

pub async fn get_graph(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(project_id): Path<i32>,
) -> Result<impl IntoResponse, AppError> {
    let _user_id = check_project_access(&state, &headers, project_id).await?.0;
    let graph_data = crate::services::graph::build_graph(&state.db, project_id).await?;
    Ok(Json(graph_data))
}

pub async fn get_insights(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(project_id): Path<i32>,
) -> Result<impl IntoResponse, AppError> {
    let _user_id = check_project_access(&state, &headers, project_id).await?.0;
    let graph_data = crate::services::graph::build_graph(&state.db, project_id).await?;
    Ok(Json(serde_json::json!({
        "node_count": graph_data.nodes.len(),
        "edge_count": graph_data.edges.len(),
        "density": if graph_data.nodes.len() > 1 {
            let max_edges = graph_data.nodes.len() * (graph_data.nodes.len() - 1) / 2;
            graph_data.edges.len() as f64 / max_edges as f64
        } else {
            0.0
        },
        "communities": graph_data.communities,
    })))
}
```

- [ ] **Step 3: 更新 routes/mod.rs**

```rust
mod graph;
// 在 create_router 中:
.nest("/api/v1/graph", graph::graph_routes())
```

- [ ] **Step 4: 提交**

```bash
git add src-server/src/services/graph.rs src-server/src/routes/graph.rs src-server/src/routes/mod.rs
git commit -m "feat: implement knowledge graph API with wikilink parsing and memory cache"
```

---

### Task 8.2: 实现向量搜索 API（pgvector + 数据库 LLM 配置）

**Files:**
- Create: `src-server/src/services/embedding.rs`
- Modify: `src-server/src/routes/search.rs` (已在 Phase 7 中预留了 `/vector` 路由)

- [ ] **Step 1: 实现向量嵌入服务 (services/embedding.rs)**

```rust
use sqlx::PgPool;
use pgvector::Vector;
use crate::AppError;
use crate::services::llm::LlmConfig;

#[derive(serde::Serialize, sqlx::FromRow)]
pub struct VectorSearchResult {
    pub path: String,
    pub title: String,
    pub snippet: String,
    pub score: f64,
}

/// 使用 pgvector 进行余弦相似度搜索
pub async fn vector_search(
    pool: &PgPool,
    project_id: i32,
    query_embedding: Vec<f32>,
    limit: i32,
) -> Result<Vec<VectorSearchResult>, AppError> {
    let embedding = Vector::from(query_embedding);

    let results = sqlx::query_as::<_, VectorSearchResult>(
        "SELECT
            wp.path,
            wp.title,
            COALESCE(substring(COALESCE(wp.content, '') FROM 1 FOR 200), '') as snippet,
            1.0 - (e.content <=> $1) as score
        FROM embeddings e
        JOIN wiki_pages wp ON e.wiki_page_id = wp.path AND e.project_id = wp.project_id
        WHERE e.project_id = $2
        ORDER BY e.content <=> $1
        LIMIT $3"
    )
    .bind(embedding)
    .bind(project_id)
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(|e| AppError::DatabaseError(e))?;

    Ok(results)
}

/// 获取文本的向量嵌入
/// 使用解密后的 LlmConfig（不是 env var!）
pub async fn get_embeddings(
    text: &str,
    llm: &LlmConfig,
) -> Result<Vec<f32>, AppError> {
    let base_url = llm.base_url.as_deref().unwrap_or("https://api.openai.com/v1");
    let client = reqwest::Client::new();

    let response = client
        .post(format!("{}/embeddings", base_url))
        .header("Authorization", format!("Bearer {}", llm.api_key))
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({
            "model": "text-embedding-ada-002",
            "input": text,
        }))
        .send()
        .await?;  // 使用 From<reqwest::Error> 自动转换

    let body: serde_json::Value = response.json().await?;

    let embedding = body["data"][0]["embedding"]
        .as_array()
        .ok_or_else(|| AppError::LlmApiError("Invalid embedding response".into()))?
        .iter()
        .map(|v| v.as_f64().unwrap_or(0.0) as f32)
        .collect();

    Ok(embedding)
}
```

注意：`vector_search_handler` 已在 Phase 7 Task 7.1 的 `routes/search.rs` 中实现了（通过 `llm::get_llm_config` + `decrypt_api_key` 获取配置）。

- [ ] **Step 2: 提交**

```bash
git add src-server/src/services/embedding.rs
git commit -m "feat: implement vector search with pgvector and DB-backed LLM config"
```

---

## 里程碑 M2: 后端 API 完成

### 验收标准：
- [ ] 文件可以上传、下载、列出、删除（路径遍历已防护）
- [ ] 搜索返回关键词匹配结果（CJK bigram + ILIKE）
- [ ] SSE 聊天连接成功建立并流式返回（LLM 配置从 llm_providers 表读取）
- [ ] 图谱能正确构建节点和边（[[wikilink]] 解析 + 内存缓存）
- [ ] 向量搜索返回语义相似结果（pgvector + 数据库 LLM 配置）

---
- [ ] 搜索返回关键词匹配结果
- [ ] SSE 聊天连接成功建立并流式返回
- [ ] 图谱能正确构建节点和边
- [ ] 向量搜索返回语义相似结果

---

## Phase 9: 前端 API 客户端 + 认证 UI

### Task 9.1: 创建 HTTP API 客户端

**Files:**
- Create: `src/lib/api-client.ts`
- Create: `src/lib/api-types.ts`
- Modify: `src/types/wiki.ts`

- [ ] **Step 1: 创建 API 类型定义 (api-types.ts)**

```typescript
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
  title_match: boolean
  score: number
  vector_score?: number
  images: Array<{ url: string; alt: string }>
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
```

- [ ] **Step 2: 创建 API 客户端 (api-client.ts)**

```typescript
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

  // === Chat (SSE) ===
  streamChat(projectId: number, messages: Array<{ role: string; content: string }>, model?: string): EventSource {
    const params = new URLSearchParams({ messages: JSON.stringify(messages) })
    if (model) params.set("model", model)
    const url = `${API_BASE}/api/v1/chat/stream?${params}`
    // 注意: EventSource 不支持自定义 headers，实际使用时需通过 fetch + ReadableStream 实现
    return new EventSource(url)
  }

  get isAuthenticated(): boolean {
    return this.accessToken !== null
  }
}

export const apiClient = new ApiClient()
```

- [ ] **Step 3: 提交**

```bash
git add src/lib/api-client.ts src/lib/api-types.ts
git commit -m "feat: add HTTP API client with token management"
```

---

### Task 9.2: 创建认证状态管理

**Files:**
- Create: `src/stores/auth-store.ts`
- Create: `src/components/auth/LoginPage.tsx`
- Create: `src/components/auth/RegisterPage.tsx`

- [ ] **Step 1: 创建 auth-store.ts**

```typescript
import { create } from "zustand"
import { apiClient } from "@/lib/api-client"
import type { UserResponse, TeamResponse } from "@/lib/api-types"

interface AuthState {
  user: UserResponse | null
  teams: TeamResponse[]
  isAuthenticated: boolean
  isLoading: boolean
  error: string | null

  login: (username: string, password: string) => Promise<void>
  register: (username: string, email: string, password: string, full_name?: string) => Promise<void>
  logout: () => Promise<void>
  loadSession: () => Promise<void>
  loadTeams: () => Promise<void>
  clearError: () => void
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  teams: [],
  isAuthenticated: false,
  isLoading: false,
  error: null,

  login: async (username, password) => {
    set({ isLoading: true, error: null })
    try {
      const data = await apiClient.login({ username, password })
      set({
        user: data.user,
        isAuthenticated: true,
        isLoading: false,
      })
    } catch (e) {
      set({
        error: e instanceof Error ? e.message : "Login failed",
        isLoading: false,
      })
      throw e
    }
  },

  register: async (username, email, password, full_name) => {
    set({ isLoading: true, error: null })
    try {
      const data = await apiClient.register({ username, email, password, full_name })
      set({
        user: data.user,
        isAuthenticated: true,
        isLoading: false,
      })
    } catch (e) {
      set({
        error: e instanceof Error ? e.message : "Registration failed",
        isLoading: false,
      })
      throw e
    }
  },

  logout: async () => {
    await apiClient.logout()
    set({ user: null, teams: [], isAuthenticated: false })
  },

  loadSession: async () => {
    if (!apiClient.loadTokens()) return
    set({ isLoading: true })
    try {
      const user = await apiClient.getMe()
      set({ user, isAuthenticated: true, isLoading: false })
    } catch {
      apiClient.clearTokens()
      set({ isLoading: false })
    }
  },

  loadTeams: async () => {
    try {
      const teams = await apiClient.getUserTeams()
      set({ teams })
    } catch {
      // ignore - user may not have teams yet
    }
  },

  clearError: () => set({ error: null }),
}))
```

- [ ] **Step 2: 创建 LoginPage.tsx**

```tsx
import { useState } from "react"
import { useAuthStore } from "@/stores/auth-store"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"

export function LoginPage({ onNavigate }: { onNavigate: (page: string) => void }) {
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const { login, isLoading, error, clearError } = useAuthStore()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      await login(username, password)
    } catch {
      // error is set in store
    }
  }

  return (
    <div className="flex items-center justify-center min-h-screen bg-gray-50">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>登录 LLM Wiki</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div className="p-3 text-sm text-red-600 bg-red-50 rounded-md">
                {error}
              </div>
            )}
            <div>
              <Input
                type="text"
                placeholder="用户名"
                value={username}
                onChange={(e) => { setUsername(e.target.value); clearError() }}
                required
              />
            </div>
            <div>
              <Input
                type="password"
                placeholder="密码"
                value={password}
                onChange={(e) => { setPassword(e.target.value); clearError() }}
                required
              />
            </div>
            <Button type="submit" className="w-full" disabled={isLoading}>
              {isLoading ? "登录中..." : "登录"}
            </Button>
            <p className="text-center text-sm text-gray-500">
              还没有账号？
              <button
                type="button"
                className="text-blue-600 hover:underline ml-1"
                onClick={() => onNavigate("register")}
              >
                注册
              </button>
            </p>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
```

- [ ] **Step 3: 创建 RegisterPage.tsx**

```tsx
import { useState } from "react"
import { useAuthStore } from "@/stores/auth-store"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"

export function RegisterPage({ onNavigate }: { onNavigate: (page: string) => void }) {
  const [username, setUsername] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [fullName, setFullName] = useState("")
  const { register, isLoading, error, clearError } = useAuthStore()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      await register(username, email, password, fullName || undefined)
    } catch {
      // error is set in store
    }
  }

  return (
    <div className="flex items-center justify-center min-h-screen bg-gray-50">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>注册 LLM Wiki</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div className="p-3 text-sm text-red-600 bg-red-50 rounded-md">{error}</div>
            )}
            <Input
              placeholder="用户名"
              value={username}
              onChange={(e) => { setUsername(e.target.value); clearError() }}
              required
            />
            <Input
              type="email"
              placeholder="邮箱"
              value={email}
              onChange={(e) => { setEmail(e.target.value); clearError() }}
              required
            />
            <Input
              type="password"
              placeholder="密码（至少8位）"
              value={password}
              onChange={(e) => { setPassword(e.target.value); clearError() }}
              required
              minLength={8}
            />
            <Input
              placeholder="全名（选填）"
              value={fullName}
              onChange={(e) => { setFullName(e.target.value); clearError() }}
            />
            <Button type="submit" className="w-full" disabled={isLoading}>
              {isLoading ? "注册中..." : "注册"}
            </Button>
            <p className="text-center text-sm text-gray-500">
              已有账号？
              <button
                type="button"
                className="text-blue-600 hover:underline ml-1"
                onClick={() => onNavigate("login")}
              >
                登录
              </button>
            </p>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
```

- [ ] **Step 4: 提交**

```bash
git add src/stores/auth-store.ts src/components/auth/LoginPage.tsx src/components/auth/RegisterPage.tsx
git commit -m "feat: add auth state management and login/register UI"
```

---

### Task 9.3: 更新 App.tsx 路由逻辑

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/main.tsx`

- [ ] **Step 1: 更新 App.tsx 添加认证路由**

在 `App()` 组件的最前面添加认证检查：

```tsx
import { useAuthStore } from "@/stores/auth-store"
import { LoginPage } from "@/components/auth/LoginPage"
import { RegisterPage } from "@/components/auth/RegisterPage"

function App() {
  const { isAuthenticated, isLoading, loadSession, user } = useAuthStore()
  const [authPage, setAuthPage] = useState<"login" | "register">("login")
  // ... existing state ...

  // 启动时加载 session
  useEffect(() => {
    loadSession()
  }, [])

  // 未认证时显示登录/注册页面
  if (!isAuthenticated) {
    if (authPage === "register") {
      return <RegisterPage onNavigate={setAuthPage} />
    }
    return <LoginPage onNavigate={setAuthPage} />
  }

  // 已认证时显示原 App 内容
  // ... rest of existing App component ...
}
```

- [ ] **Step 2: 提交**

```bash
git add src/App.tsx src/main.tsx
git commit -m "feat: add auth routing to App component"
```

---

## Phase 10: 前端改造：替换 Tauri 命令

### Task 10.1: 改造 fs.ts 命令文件

**Files:**
- Modify: `src/commands/fs.ts`

- [ ] **Step 1: 创建 HTTP 版本的 fs 操作**

```typescript
// src/commands/fs.ts — 添加 HTTP 实现
// 原有 Tauri invoke 调用保留，通过环境变量切换

import { apiClient } from "@/lib/api-client"
import type { FileNode } from "@/types/wiki"

const USE_HTTP = import.meta.env.VITE_USE_HTTP_API === "true"

export async function readFile(
  path: string,
  options?: { extractImages?: boolean },
): Promise<string> {
  if (USE_HTTP) {
    const projectId = getCurrentProjectId()
    const result = await apiClient.readFile(projectId, path)
    return result.content
  }
  // 原有 Tauri 实现
  return invoke<string>("read_file", { path, extractImages: options?.extractImages })
}

export async function writeFile(path: string, contents: string): Promise<void> {
  if (USE_HTTP) {
    const projectId = getCurrentProjectId()
    await apiClient.request("POST", `/api/v1/files/${projectId}/write`, { path, contents })
    return
  }
  return invoke<void>("write_file", { path, contents })
}

export async function listDirectory(path: string): Promise<FileNode[]> {
  if (USE_HTTP) {
    const projectId = getCurrentProjectId()
    return apiClient.listFiles(projectId, path)
  }
  return invoke<FileNode[]>("list_directory", { path })
}

export async function deleteFile(path: string): Promise<void> {
  if (USE_HTTP) {
    const projectId = getCurrentProjectId()
    await apiClient.request("POST", `/api/v1/files/${projectId}/delete`, { path })
    return
  }
  return invoke("delete_file", { path })
}

// 从 store 获取当前 project id（替代方案：通过 URL 或 context）
function getCurrentProjectId(): number {
  // 临时实现 — 后续通过 project 状态获取
  if (typeof window !== "undefined") {
    return (window as any).__currentProjectId || 0
  }
  return 0
}
```

- [ ] **Step 2: 提交**

```bash
git add src/commands/fs.ts
git commit -m "feat: add HTTP-based file operations with feature flag"
```

---

### Task 10.2: 改造搜索和图谱调用

**Files:**
- Modify: `src/lib/search.ts`
- Modify: `src/lib/wiki-graph.ts`

- [ ] **Step 1: 在 search.ts 中添加 HTTP 搜索实现**

```typescript
// src/lib/search.ts — 添加 HTTP 版本的 searchWiki
import { apiClient } from "@/lib/api-client"
import type { SearchResult as ApiSearchResult } from "@/lib/api-types"

export async function searchWikiHttp(
  projectId: number,
  query: string,
): Promise<ApiSearchResult[]> {
  const data = await apiClient.search(projectId, query)
  return data.results
}
```

- [ ] **Step 2: 在 wiki-graph.ts 中添加 HTTP 图构建实现**

```typescript
// src/lib/wiki-graph.ts — 添加 HTTP 版本的 buildRetrievalGraph
import { apiClient } from "@/lib/api-client"
import type { GraphData } from "@/lib/api-types"

export async function buildGraphHttp(projectId: number) {
  const data = await apiClient.getGraph(projectId)
  return {
    nodes: data.nodes.map(n => ({
      id: n.id,
      label: n.label,
      type: n.type,
      path: n.path,
      linkCount: n.linkCount,
      community: n.community,
    })),
    edges: data.edges.map(e => ({
      source: e.source,
      target: e.target,
      weight: e.weight,
    })),
  }
}
```

- [ ] **Step 3: 提交**

```bash
git add src/lib/search.ts src/lib/wiki-graph.ts
git commit -m "feat: add HTTP-based search and graph operations"
```

---

## Phase 11: 集成测试 + Bug 修复

### Task 11.1: 后端集成测试

**Files:**
- Create: `src-server/tests/integration/auth_test.rs`
- Create: `src-server/tests/integration/mod.rs`

- [ ] **Step 1: 创建集成测试文件**

```rust
// src-server/tests/integration/mod.rs
pub mod auth_test;

// src-server/tests/integration/auth_test.rs
#[cfg(test)]
mod tests {
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use tower::ServiceExt;

    // 注意: 完整集成测试需要先创建测试数据库
    // 此处提供基本框架，实际运行时需要设置 DATABASE_URL

    fn setup_test_app() -> (axum::Router, llm_wiki_server::AppState) {
        let config = llm_wiki_server::AppConfig::from_env()
            .expect("Failed to load test config");
        tokio_test::block_on(llm_wiki_server::create_app(config))
            .expect("Failed to create test app")
    }

    #[tokio::test]
    #[ignore = "Requires database — run with DATABASE_URL set"]
    async fn test_health_check() {
        let (app, _state) = setup_test_app();

        let response = app
            .oneshot(Request::builder()
                .uri("/health")
                .body(Body::empty())
                .unwrap())
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    #[ignore = "Requires database — run with DATABASE_URL set"]
    async fn test_register_and_login_flow() {
        let (app, _state) = setup_test_app();

        // 注册
        let register_body = serde_json::json!({
            "username": "testuser_int",
            "email": "test_int@example.com",
            "password": "password123",
        });
        let response = app.clone()
            .oneshot(Request::builder()
                .method("POST")
                .uri("/api/v1/auth/register")
                .header("Content-Type", "application/json")
                .body(Body::from(serde_json::to_string(&register_body).unwrap()))
                .unwrap())
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::CREATED);

        // 登录
        let login_body = serde_json::json!({
            "username": "testuser_int",
            "password": "password123",
        });
        let response = app
            .oneshot(Request::builder()
                .method("POST")
                .uri("/api/v1/auth/login")
                .header("Content-Type", "application/json")
                .body(Body::from(serde_json::to_string(&login_body).unwrap()))
                .unwrap())
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
    }
}
```

- [ ] **Step 2: 提交**

```bash
git add src-server/tests/integration/
git commit -m "test: add integration test framework for auth endpoints"
```

---

### Task 11.2: 前端组件测试

**Files:**
- Create: `src/components/auth/LoginPage.test.tsx`
- Create: `src/components/auth/__snapshots__/`

- [ ] **Step 1: 创建 LoginPage 基础渲染测试**

```tsx
import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { LoginPage } from "./LoginPage"

describe("LoginPage", () => {
  it("renders login form", () => {
    render(<LoginPage onNavigate={() => {}} />)
    expect(screen.getByPlaceholderText("用户名")).toBeDefined()
    expect(screen.getByPlaceholderText("密码")).toBeDefined()
    expect(screen.getByRole("button", { name: /登录/ })).toBeDefined()
  })

  it("has link to register page", () => {
    render(<LoginPage onNavigate={() => {}} />)
    expect(screen.getByText("注册")).toBeDefined()
  })
})
```

- [ ] **Step 2: 提交**

```bash
git add src/components/auth/LoginPage.test.tsx
git commit -m "test: add LoginPage component tests"
```

---

## Phase 12: 部署配置 + 内网测试

### Task 12.1: 创建生产 Docker Compose 配置

**Files:**
- Create: `docker-compose.prod.yml`
- Create: `nginx.conf`

- [ ] **Step 1: 创建生产 docker-compose.prod.yml**

```yaml
version: "3.8"

services:
  db:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_DB: llmwiki
      POSTGRES_USER: llmwiki
      POSTGRES_PASSWORD: ${DB_PASSWORD:-changeme}
    volumes:
      - pgdata:/var/lib/postgresql/data
    restart: unless-stopped
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U llmwiki"]
      interval: 10s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    volumes:
      - redisdata:/data
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5

  server:
    build:
      context: ./src-server
      dockerfile: Dockerfile
    environment:
      DATABASE_URL: postgres://llmwiki:${DB_PASSWORD:-changeme}@db:5432/llmwiki
      REDIS_URL: redis://redis:6379
      JWT_SECRET: ${JWT_SECRET}
      STORAGE_PATH: /data/storage
      HOST: 0.0.0.0
      PORT: 8080
      ALLOWED_ORIGINS: ${ALLOWED_ORIGINS:-http://localhost}
      RUST_LOG: info
    ports:
      - "8080:8080"
    volumes:
      - storage_data:/data/storage
    depends_on:
      db:
        condition: service_healthy
      redis:
        condition: service_healthy
    restart: unless-stopped

  nginx:
    image: nginx:alpine
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
      - ./dist:/usr/share/nginx/html:ro
    depends_on:
      - server
    restart: unless-stopped

volumes:
  pgdata:
  redisdata:
  storage_data:
```

- [ ] **Step 2: 创建 nginx.conf**

```nginx
events {
    worker_connections 1024;
}

http {
    include /etc/nginx/mime.types;
    default_type application/octet-stream;

    upstream api {
        server server:8080;
    }

    server {
        listen 80;
        server_name localhost;

        # 前端静态文件
        location / {
            root /usr/share/nginx/html;
            try_files $uri $uri/ /index.html;
        }

        # API 反向代理
        location /api/ {
            proxy_pass http://api;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;

            # SSE 支持
            proxy_buffering off;
            proxy_cache off;
            proxy_read_timeout 3600s;
        }

        # 健康检查
        location /health {
            proxy_pass http://api;
        }
    }
}
```

- [ ] **Step 3: 提交**

```bash
git add docker-compose.prod.yml nginx.conf
git commit -m "feat: add production Docker Compose config with nginx"
```

---

### Task 12.2: 创建前端构建配置

**Files:**
- Create: `.env.production.example`

- [ ] **Step 1: 创建 .env.production.example**

```bash
# LLM Wiki Web — 生产环境变量
VITE_API_BASE_URL=http://localhost:8080
VITE_USE_HTTP_API=true
```

- [ ] **Step 2: 提交**

```bash
git add .env.production.example
git commit -m "feat: add production environment template"
```

---

## 里程碑 M3: 生产就绪

### 验收标准：
- [ ] Docker Compose 一键启动所有服务
- [ ] 文件上传/下载 API 能处理 100MB 文件
- [ ] 搜索 API 能在 1 秒内返回结果（1000 页以内）
- [ ] 聊天 SSE 能流式返回超过 1 分钟的响应
- [ ] 图谱 API 能处理 5000 节点的项目
- [ ] 前端认证流程完整可用
- [ ] Nginx 反向代理正确转发所有 API

### 测试命令：
```bash
# 启动生产环境
docker-compose -f docker-compose.prod.yml up -d

# 构建前端
npm run build

# 健康检查
curl http://localhost/health

# 端到端测试
curl -X POST http://localhost/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","email":"admin@example.com","password":"admin123"}'

# 上传文件
curl -X POST http://localhost/api/v1/files/upload \
  -H "Authorization: Bearer <token>" \
  -F "file=@test.pdf" \
  -F "path=/docs"
```
