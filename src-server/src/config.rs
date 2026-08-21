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

/// 注册开关（AUTH__REGISTRATION_ENABLED；默认 false——config/default.json 亦为 false
/// （Task 6 r3 fail-closed）。dev 由 src-server/.env 显式 true 开启；集成测试由
/// tests/integration/mod.rs 的 setup_test_app 注入 true（测试二进制不读 .env））
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

/// t_page 三端点限流规格（评审 R4 入 config；此前 rate_limit.rs 硬编码 30/60）。
/// - `s_per_min`：GET /s/:code 每分钟上限（默认 30）
/// - `beacon_per_min`：POST /t/:token/seen 与 /complete 每分钟上限（默认 60，共桶）
/// 环境变量覆盖（"__" 分隔嵌套）：PAGE_RATE_LIMITS__S_PER_MIN / PAGE_RATE_LIMITS__BEACON_PER_MIN
#[derive(Debug, Clone, Deserialize)]
pub struct PageRateLimitConfig {
    #[serde(default = "default_page_rate_s_per_min")]
    pub s_per_min: usize,
    #[serde(default = "default_page_rate_beacon_per_min")]
    pub beacon_per_min: usize,
}

fn default_page_rate_s_per_min() -> usize { 30 }
fn default_page_rate_beacon_per_min() -> usize { 60 }

impl Default for PageRateLimitConfig {
    fn default() -> Self {
        Self {
            s_per_min: default_page_rate_s_per_min(),
            beacon_per_min: default_page_rate_beacon_per_min(),
        }
    }
}

/// 已泄露/占位 secret 黑名单：命中即拒绝启动
/// - "your-super-secret-key-change-this": 模板占位符
/// - "test_secret_for_development_32bytes!": 2026-08 已提交进 git，视为泄露
/// - "907986fb...": 2026-08 dev 64-hex secret 曾提交进 git（M1 评审 #1），视为泄露
const LEAKED_SECRETS: &[&str] = &[
    "your-super-secret-key-change-this",
    "test_secret_for_development_32bytes!", // 2026-08 已提交进 git，视为泄露
    // 2026-08 dev 64-hex secret 已提交进 git（M1 评审 #1），视为泄露自新
    "907986fb3f032f9f8df33a4e8f3760d903e778bdbb03633d85ef837bccef4d55",
];

/// 校验必填配置（jwt secret 非空且不在黑名单）
fn validate(cfg: &AppConfig) -> anyhow::Result<()> {
    if cfg.jwt.secret.is_empty() || LEAKED_SECRETS.contains(&cfg.jwt.secret.as_str()) {
        anyhow::bail!("JWT_SECRET must be set to a secure value");
    }
    // 签名纵深：HMAC-SHA256 密钥非空时至少 32 字节（有效强度）；空 = /media 功能未启用，放行
    if !cfg.media.signing_key.is_empty() && cfg.media.signing_key.len() < 32 {
        anyhow::bail!("MEDIA__SIGNING_KEY too short");
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
    pub page_rate_limits: PageRateLimitConfig,
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
            .add_source(
                Environment::default()
                    .separator("__")
                    // 容器（prod compose）内无 config/default.json 且无挂载，Environment 是
                    // 唯一配置源——必须能解析数字/布尔/列表，否则 DATABASE__MAX_CONNECTIONS="10"、
                    // AUTH__REGISTRATION_ENABLED="false"、CORS__ALLOWED_ORIGINS（逗号串）全部
                    // 反序列化失败（config 0.14 try_parsing=false 时一律按 String 交付）。
                    // with_list_parse_key 必须圈定列表键：list_separator 一旦设置而未圈定，
                    // 所有非标量 String 值都会被拆成单元素 Vec<String>（String 字段即炸）——
                    // 仅 cors.allowed_origins 走列表，其余保持 String。
                    // 已知取舍：纯数字/布尔字面量的 String 值会被解析成标量（compose 内不得
                    // 出现纯数字的 String 配置值，如密码恰好全数字）。
                    .try_parsing(true)
                    .list_separator(",")
                    .with_list_parse_key("cors.allowed_origins"),
            )
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
        // default.json 的 jwt.secret 已出库置空（M1 评审 #1），此处经 env 覆盖注入
        // 非 leaked secret（Environment 源优先于 File 源；本测试是 lib 测试二进制中唯一
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
    fn page_rate_limits_default_30_60_and_env_shape() {
        // R4：限流规格入 config——段缺失时 serde 默认 30/60（与旧硬编码零行为变化）；
        // default.json 显式携带同值；Environment 覆盖键形如 PAGE_RATE_LIMITS__S_PER_MIN
        // （"__" 分隔嵌套 + try_parsing 数字解析，与 DATABASE__MAX_CONNECTIONS 同法）。
        let json = r#"{
            "server": {"host": "0.0.0.0", "port": 8080},
            "database": {"url": "postgres://x", "max_connections": 1},
            "redis_url": "redis://x",
            "jwt": {"secret": "x"},
            "storage": {"path": "/tmp/x"},
            "cors": {"allowed_origins": ["http://localhost"]}
        }"#;
        let c: AppConfig = serde_json::from_str(json).unwrap();
        assert_eq!(c.page_rate_limits.s_per_min, 30, "absent section falls back to 30");
        assert_eq!(c.page_rate_limits.beacon_per_min, 60, "absent section falls back to 60");

        // default.json 显式值 = 30/60（from_env 读 cargo test cwd 的 config/default.json）
        std::env::set_var("JWT__SECRET", "unit-test-secret-override-not-leaked");
        let cfg = AppConfig::from_env().expect("from_env");
        assert_eq!(cfg.page_rate_limits.s_per_min, 30);
        assert_eq!(cfg.page_rate_limits.beacon_per_min, 60);

        // env 覆盖形状（独立前缀隔离，避免与并行测试 env 竞争）
        std::env::set_var("T4RATE__S_PER_MIN", "7");
        std::env::set_var("T4RATE__BEACON_PER_MIN", "9");
        #[derive(Deserialize)]
        struct RateProbe {
            s_per_min: usize,
            beacon_per_min: usize,
        }
        let probe: RateProbe = ConfigBuilder::builder()
            .add_source(Environment::with_prefix("T4RATE").separator("__").try_parsing(true))
            .build()
            .unwrap()
            .try_deserialize()
            .unwrap();
        assert_eq!((probe.s_per_min, probe.beacon_per_min), (7, 9));
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
        // 2026-08 曾入库的 dev 64-hex secret 同样命中黑名单（M1 评审 #1 自新）
        cfg.jwt.secret = "907986fb3f032f9f8df33a4e8f3760d903e778bdbb03633d85ef837bccef4d55".to_string();
        assert!(validate(&cfg).is_err());
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

    #[test]
    fn media_signing_key_length_validated() {
        // 签名纵深：非空 signing_key < 32 字节 → 启动即拒；32 字节放行；空 = 功能未启用放行
        let mut cfg: AppConfig = serde_json::from_value(serde_json::json!({
            "server": {"host": "0.0.0.0", "port": 8080},
            "database": {"url": "postgres://x", "max_connections": 1},
            "redis_url": "redis://x",
            "jwt": {"secret": "x"},
            "storage": {"path": "/tmp/x"},
            "cors": {"allowed_origins": ["http://localhost"]}
        }))
        .expect("minimal AppConfig");
        cfg.media.signing_key = "k".repeat(31);
        let err = validate(&cfg).unwrap_err();
        assert!(err.to_string().contains("MEDIA__SIGNING_KEY too short"));
        cfg.media.signing_key = "k".repeat(32);
        assert!(validate(&cfg).is_ok());
        cfg.media.signing_key = String::new();
        assert!(validate(&cfg).is_ok());
    }

    #[derive(Deserialize)]
    struct EnvProbe {
        allowed_origins: Vec<String>,
        max_connections: u32,
        registration_enabled: bool,
        host: String,
    }

    #[test]
    fn env_try_parsing_delivers_vec_u32_bool_and_keeps_string() {
        // Step 4：Environment 源加 try_parsing + list_separator 后，容器 env 的
        // 逗号串→Vec<String>、"10"→u32、"false"→bool；且未列入 list_parse_key 的键
        // 保持 String（config 0.14.1：list_separator 一旦设置而无 with_list_parse_key，
        // 所有 String 都会变单元素 Vec —— from_env 的 String 字段全部炸掉）。
        // 独立前缀 T4CFG__ 隔离，避免与其他并行测试的 env 读写竞争。
        std::env::set_var("T4CFG__ALLOWED_ORIGINS", "http://a.example,http://b.example");
        std::env::set_var("T4CFG__MAX_CONNECTIONS", "10");
        std::env::set_var("T4CFG__REGISTRATION_ENABLED", "false");
        std::env::set_var("T4CFG__HOST", "0.0.0.0");
        std::env::set_var("T4CFG__NUMERIC_LITERALS_BECOME_NUMBERS", "12345");
        let probe: EnvProbe = ConfigBuilder::builder()
            .add_source(
                Environment::with_prefix("T4CFG")
                    .separator("__")
                    .try_parsing(true)
                    .list_separator(",")
                    .with_list_parse_key("allowed_origins"),
            )
            .build()
            .unwrap()
            .try_deserialize()
            .unwrap();
        assert_eq!(probe.allowed_origins, vec!["http://a.example", "http://b.example"]);
        assert_eq!(probe.max_connections, 10);
        assert!(!probe.registration_enabled);
        assert_eq!(probe.host, "0.0.0.0", "non-list keys must stay String");
        // 尖锐边（约束而非期望行为）：纯数字字符串被解析成数字——String 字段收到
        // 纯数字值将无法反序列化，compose 内不得出现纯数字的 String 配置值。
        let raw: serde_json::Value = ConfigBuilder::builder()
            .add_source(
                Environment::with_prefix("T4CFG")
                    .separator("__")
                    .try_parsing(true)
                    .list_separator(",")
                    .with_list_parse_key("allowed_origins"),
            )
            .build()
            .unwrap()
            .try_deserialize()
            .unwrap();
        assert_eq!(raw["numeric_literals_become_numbers"], serde_json::json!(12345));
        assert!(raw["numeric_literals_become_numbers"].is_i64());
    }
}
