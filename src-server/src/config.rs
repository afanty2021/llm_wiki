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

#[derive(Debug, Clone, Deserialize)]
pub struct SearchConfig {
    #[serde(default = "default_rerank_enabled")]
    pub rerank_enabled: bool,
    #[serde(default = "default_rerank_top_n")]
    pub rerank_top_n: usize,
    #[serde(default = "default_rerank_final_k")]
    pub rerank_final_k: usize,
}

fn default_rerank_enabled() -> bool { true }
fn default_rerank_top_n() -> usize { 20 }
fn default_rerank_final_k() -> usize { 5 }

impl Default for SearchConfig {
    fn default() -> Self {
        SearchConfig { rerank_enabled: true, rerank_top_n: 20, rerank_final_k: 5 }
    }
}

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
pub struct LoggingConfig {
    #[serde(default = "default_log_dir")]
    pub dir: String,
    #[serde(default = "default_log_max_size_bytes")]
    pub max_size_bytes: u64,
    #[serde(default = "default_log_max_files")]
    pub max_files: usize,
    #[serde(default = "default_log_level")]
    pub level: String,
}

impl Default for LoggingConfig {
    fn default() -> Self {
        Self {
            dir: default_log_dir(),
            max_size_bytes: default_log_max_size_bytes(),
            max_files: default_log_max_files(),
            level: default_log_level(),
        }
    }
}

fn default_log_dir() -> String { "./logs".to_string() }
fn default_log_max_size_bytes() -> u64 { 10 * 1024 * 1024 }
fn default_log_max_files() -> usize { 5 }
fn default_log_level() -> String { "INFO".to_string() }
fn default_admin_usernames() -> String { String::new() }

/// 解析逗号分隔的 admin 用户名（空白名单 → 空 Vec）
fn parse_admin_usernames(s: &str) -> Vec<String> {
    s.split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect()
}

/// 注册开关（AUTH__REGISTRATION_ENABLED；默认 false，生产保持关闭，dev/test 由 default.json 显式开启）
#[derive(Debug, Deserialize, Clone, Default)]
pub struct AuthConfig {
    #[serde(default)]
    pub registration_enabled: bool,
}

/// 训练管线（TRAINING__ADMIN_TOKEN / TRAINING__PROJECT_ID；密钥经环境变量注入、不入 git）
#[derive(Debug, Deserialize, Clone, Default)]
pub struct TrainingConfig {
    #[serde(default)]
    pub admin_token: String,
    #[serde(default)]
    pub project_id: Option<i32>,
}

/// 媒体签名密钥（MEDIA__SIGNING_KEY；经环境变量注入、不入 git）
#[derive(Debug, Deserialize, Clone, Default)]
pub struct MediaConfig {
    #[serde(default)]
    pub signing_key: String,
}

/// 已泄露/占位 secret 黑名单：命中即拒绝启动
/// - "your-super-secret-key-change-this": 模板占位符
/// - "test_secret_for_development_32bytes!": 2026-08 已提交进 git，视为泄露
const LEAKED_SECRETS: &[&str] = &[
    "your-super-secret-key-change-this",
    "test_secret_for_development_32bytes!", // 2026-08 已提交进 git，视为泄露
];

/// 校验必填配置（jwt secret 非空且不在黑名单）
fn validate(cfg: &AppConfig) -> anyhow::Result<()> {
    if cfg.jwt.secret.is_empty() || LEAKED_SECRETS.contains(&cfg.jwt.secret.as_str()) {
        anyhow::bail!("JWT_SECRET must be set to a secure value");
    }
    Ok(())
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
    #[serde(default)]
    pub auth: AuthConfig,
    #[serde(default)]
    pub training: TrainingConfig,
    #[serde(default)]
    pub media: MediaConfig,
    #[serde(default)]
    pub search: SearchConfig,
    #[serde(default = "default_frontend")]
    pub frontend: FrontendConfig,
    #[serde(default)]
    pub logging: LoggingConfig,
    #[serde(default = "default_admin_usernames")]
    pub admin_usernames: String,
}

impl AppConfig {
    pub fn from_env() -> Result<Self, anyhow::Error> {
        // Load from config directory and environment variables
        let builder = ConfigBuilder::builder()
            .add_source(File::with_name("config/default").required(false))
            .add_source(Environment::default().separator("__"))
            .build()?;

        let config: AppConfig = builder.try_deserialize()?;

        validate(&config)?;

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

    // Logging 配置 getter（src-server 日志系统）
    pub fn log_dir(&self) -> &str { &self.logging.dir }
    pub fn log_max_size_bytes(&self) -> u64 { self.logging.max_size_bytes }
    pub fn log_max_files(&self) -> usize { self.logging.max_files }
    pub fn log_level(&self) -> &str { &self.logging.level }
    /// admin 用户名列表（从 ADMIN_USERNAMES 逗号分隔字符串解析，空白名单 → 空 Vec）
    pub fn admin_usernames(&self) -> Vec<String> {
        parse_admin_usernames(&self.admin_usernames)
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
    fn admin_usernames_parses_comma_string() {
        assert!(parse_admin_usernames("").is_empty());
        assert_eq!(parse_admin_usernames("alice"), vec!["alice"]);
        // 含空格与空段
        assert_eq!(
            parse_admin_usernames("alice, bob , carol"),
            vec!["alice", "bob", "carol"]
        );
        assert_eq!(parse_admin_usernames("alice,,bob,"), vec!["alice", "bob"]);
    }

    #[test]
    fn test_embedding_config_loaded() {
        // config/default.json 含 embedding 段；cargo test cwd = src-server
        // 旧 dev secret 已入黑名单（Task 6 才轮换 default.json），此处经 env 覆盖注入
        // 非黑名单 secret（Environment 源优先于 File 源；本测试是 lib 测试二进制中唯一
        // from_env 调用方，无并发 env 竞争）
        std::env::set_var("JWT__SECRET", "unit-test-secret-override-not-leaked");
        let cfg = AppConfig::from_env().expect("from_env");
        let emb = cfg.embedding.expect("embedding should be configured in default.json");
        assert_eq!(emb.model, "bge-m3-mlx-fp16");
        assert_eq!(emb.dim, 1024);
    }

    #[test]
    fn registration_disabled_by_default() {
        // brief 的 from_str("{}") 写法对必填段必 panic；按其注释意图（断言 Deserialize 默认）
        // 改为最小必填 JSON、不含 auth/training/media 段，验证 #[serde(default)] 生效
        let json = r#"{
            "server": {"host": "0.0.0.0", "port": 8080},
            "database": {"url": "postgres://x", "max_connections": 1},
            "redis_url": "redis://x",
            "jwt": {"secret": "x"},
            "storage": {"path": "/tmp/x"},
            "cors": {"allowed_origins": ["http://localhost"]}
        }"#;
        let c: AppConfig = serde_json::from_str(json).unwrap();
        assert!(!c.auth.registration_enabled);
        assert_eq!(c.training.admin_token, "");
        assert!(c.training.project_id.is_none());
        assert_eq!(c.media.signing_key, "");
    }

    #[test]
    fn leaked_dev_secret_rejected() {
        // 旧已泄露 dev secret 必须被校验拒绝（黑名单）
        // 无 test_config_with_override helper → 按 brief 备注 from_value 构造最小 AppConfig
        let mut cfg: AppConfig = serde_json::from_value(serde_json::json!({
            "server": {"host": "0.0.0.0", "port": 8080},
            "database": {"url": "postgres://x", "max_connections": 1},
            "redis_url": "redis://x",
            "jwt": {"secret": "x"},
            "storage": {"path": "/tmp/x"},
            "cors": {"allowed_origins": ["http://localhost"]}
        }))
        .expect("minimal AppConfig");
        // 阳性对照：普通 secret 应通过，防 validate 恒错
        assert!(validate(&cfg).is_ok());
        cfg.jwt.secret = "test_secret_for_development_32bytes!".to_string();
        let err = validate(&cfg).unwrap_err();
        assert!(err.to_string().contains("JWT_SECRET"));
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
