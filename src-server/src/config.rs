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
    #[serde(default = "default_access_token_ttl")]
    pub access_token_ttl: u64,
    #[serde(default = "default_refresh_token_ttl")]
    pub refresh_token_ttl: u64,
}

fn default_access_token_ttl() -> u64 {
    3600 // 1 hour in seconds
}

fn default_refresh_token_ttl() -> u64 {
    604800 // 7 days in seconds
}

#[derive(Debug, Clone, Deserialize)]
pub struct StorageConfig {
    pub path: String,
    #[serde(default = "default_storage_type")]
    pub storage_type: String,
    pub s3_endpoint: Option<String>,
    pub s3_access_key: Option<String>,
    pub s3_secret_key: Option<String>,
    pub s3_bucket: Option<String>,
    pub s3_region: Option<String>,
}

fn default_storage_type() -> String {
    "local".to_string()
}

#[derive(Debug, Clone, Deserialize)]
pub struct CorsConfig {
    #[serde(default = "default_allowed_origins")]
    pub allowed_origins: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct EmbeddingConfig {
    pub base_url: String,
    pub model: String,
    pub dim: usize,
    pub timeout_secs: u64,
    #[serde(default = "default_chunk_size")]
    pub chunk_size: usize,
    #[serde(default = "default_overlap")]
    pub overlap: usize,
    #[serde(default = "default_ef_search")]
    pub ef_search: usize,
    #[serde(default = "default_embed_max_retries")]
    pub max_retries: u32,
}

fn default_chunk_size() -> usize { 384 }
fn default_overlap() -> usize { 64 }
fn default_ef_search() -> usize { 80 }
fn default_embed_max_retries() -> u32 { 3 }

fn default_allowed_origins() -> Vec<String> {
    vec!["http://localhost:1420".to_string()]
}

#[derive(Debug, Clone, Deserialize)]
pub struct FrontendConfig {
    #[serde(default = "default_frontend_dist_dir")]
    pub dist_dir: String,
    #[serde(default = "default_frontend_index_html")]
    pub index_html: String,
}

fn default_frontend_dist_dir() -> String {
    "../dist".to_string()
}

fn default_frontend_index_html() -> String {
    "../dist/index.html".to_string()
}

fn default_frontend() -> FrontendConfig {
    FrontendConfig {
        dist_dir: default_frontend_dist_dir(),
        index_html: default_frontend_index_html(),
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct AppConfig {
    pub server: ServerConfig,
    pub database: DatabaseConfig,
    pub redis_url: String,
    pub jwt: JwtConfig,
    pub storage: StorageConfig,
    pub cors: CorsConfig,
    pub embedding: Option<EmbeddingConfig>,
    #[serde(default = "default_frontend")]
    pub frontend: FrontendConfig,
}

impl AppConfig {
    pub fn from_env() -> Result<Self, anyhow::Error> {
        // Load from config directory and environment variables
        let builder = ConfigBuilder::builder()
            .add_source(File::with_name("config/default").required(false))
            .add_source(Environment::default().separator("__"))
            .build()?;

        let config: AppConfig = builder.try_deserialize()?;

        // Validate required configuration
        if config.jwt.secret.is_empty() || config.jwt.secret == "your-super-secret-key-change-this" {
            anyhow::bail!("JWT_SECRET must be set to a secure value");
        }

        Ok(config)
    }

    // Database configuration getters
    pub fn database_url(&self) -> &str {
        &self.database.url
    }

    pub fn database_max_connections(&self) -> u32 {
        self.database.max_connections
    }

    // Redis configuration getter
    pub fn redis_url(&self) -> &str {
        &self.redis_url
    }

    // Server configuration getters
    pub fn host(&self) -> &str {
        &self.server.host
    }

    pub fn port(&self) -> u16 {
        self.server.port
    }

    pub fn server_address(&self) -> String {
        format!("{}:{}", self.host(), self.port())
    }

    // JWT configuration getters
    pub fn jwt_secret(&self) -> &str {
        &self.jwt.secret
    }

    pub fn jwt_access_token_ttl(&self) -> Duration {
        Duration::from_secs(self.jwt.access_token_ttl)
    }

    pub fn jwt_refresh_token_ttl(&self) -> Duration {
        Duration::from_secs(self.jwt.refresh_token_ttl)
    }

    // Storage configuration getters
    pub fn storage_path(&self) -> &str {
        &self.storage.path
    }

    pub fn storage_type(&self) -> &str {
        &self.storage.storage_type
    }

    pub fn is_s3_storage(&self) -> bool {
        self.storage.storage_type == "s3"
    }

    // CORS configuration getter
    pub fn allowed_origins(&self) -> &[String] {
        &self.cors.allowed_origins
    }

    // Frontend 配置 getter（Layer 5 同源托管 dist）
    pub fn dist_dir(&self) -> &str {
        &self.frontend.dist_dir
    }

    pub fn index_html(&self) -> &str {
        &self.frontend.index_html
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_values() {
        // Test that default values are applied correctly
        let jwt_config = JwtConfig {
            secret: "test-secret".to_string(),
            access_token_ttl: default_access_token_ttl(),
            refresh_token_ttl: default_refresh_token_ttl(),
        };

        assert_eq!(jwt_config.access_token_ttl, 3600);
        assert_eq!(jwt_config.refresh_token_ttl, 604800);
    }

    #[test]
    fn test_storage_type_default() {
        assert_eq!(default_storage_type(), "local");
    }

    #[test]
    fn test_allowed_origins_default() {
        let origins = default_allowed_origins();
        assert_eq!(origins.len(), 1);
        assert_eq!(origins[0], "http://localhost:1420");
    }

    #[test]
    fn test_embedding_config_loaded() {
        // config/default.json 含 embedding 段；cargo test cwd = src-server
        let cfg = AppConfig::from_env().expect("from_env");
        let emb = cfg.embedding.expect("embedding should be configured in default.json");
        assert_eq!(emb.model, "bge-m3-mlx-fp16");
        assert_eq!(emb.dim, 1024);
    }

    #[test]
    fn test_embedding_config_optional_when_absent() {
        // 构造无 embedding 段的最小 JSON，确认 Option → None（serde 默认行为）
        let json = r#"{
            "server": {"host": "0.0.0.0", "port": 8080},
            "database": {"url": "postgres://x", "max_connections": 1},
            "redis_url": "redis://x",
            "jwt": {"secret": "test_secret_for_development_32bytes!"},
            "storage": {"path": "/tmp/x"},
            "cors": {"allowed_origins": ["http://localhost"]}
        }"#;
        let cfg: AppConfig = serde_json::from_str(json).unwrap();
        assert!(cfg.embedding.is_none());
    }
}
