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
    /// env 形态 `STORAGE__TYPE`（alias "type"——字段名 storage_type 无 alias 时该键
    /// 静默失效，终审 round3 ENV-1：alias 后 env/json 两形态都收，行为不变）。
    #[serde(default = "default_storage_type", alias = "type")]
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

/// 媒体签名密钥（MEDIA__SIGNING_KEY；经环境变量注入、不入 git）+ /media 许可根集。
/// SEC-2（终审必修）：`allowed_roots`（MEDIA__ALLOWED_ROOTS，逗号分隔绝对路径列表）
/// 是 /media 服务与 media-assets upsert 的 playback_path 共同的越界判据——
/// media_ref/playback_path 均为本机绝对路径直开（media.rs File::open），不收口即
/// 任意文件读。signing_key 非空（/media 开启）时 roots 必须非空（validate，fail-closed）。
#[derive(Debug, Deserialize, Clone, Default)]
pub struct MediaConfig {
    #[serde(default)]
    pub signing_key: String,
    /// /media 许可根集：COALESCE(playback_path, media_ref) 规范化后必须落在其一之下。
    #[serde(default)]
    pub allowed_roots: Vec<String>,
}

/// t_page 端点限流规格（评审 R4 入 config；此前 rate_limit.rs 硬编码 30/60）。
/// - `s_per_min`：GET /s/:code 每分钟上限（默认 30）
/// - `beacon_per_min`：POST /t/:token/seen 与 /complete 每分钟上限（默认 60，共桶）
/// - `t_per_min`：GET /t/:token 每分钟上限（默认 30，SEC-7 view 事件写库闸门）
/// 环境变量覆盖（"__" 分隔嵌套）：PAGE_RATE_LIMITS__S_PER_MIN / __BEACON_PER_MIN / __T_PER_MIN
#[derive(Debug, Clone, Deserialize)]
pub struct PageRateLimitConfig {
    #[serde(default = "default_page_rate_s_per_min")]
    pub s_per_min: usize,
    #[serde(default = "default_page_rate_beacon_per_min")]
    pub beacon_per_min: usize,
    #[serde(default = "default_page_rate_t_per_min")]
    pub t_per_min: usize,
}

// 单一真源：字面量只在 rate_limit 常量处存在一次，serde 缺省与 Default 均引用之，
// 改默认值只动 rate_limit.rs 三常量（否则 serde 兜底与 new() 会静默漂移——评审 minor）。
fn default_page_rate_s_per_min() -> usize { crate::services::rate_limit::S_REDIRECT_CAP_PER_MIN }
fn default_page_rate_beacon_per_min() -> usize { crate::services::rate_limit::BEACON_CAP_PER_MIN }
fn default_page_rate_t_per_min() -> usize { crate::services::rate_limit::T_VIEW_CAP_PER_MIN }

impl Default for PageRateLimitConfig {
    fn default() -> Self {
        Self {
            s_per_min: default_page_rate_s_per_min(),
            beacon_per_min: default_page_rate_beacon_per_min(),
            t_per_min: default_page_rate_t_per_min(),
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
    // SEC-2 fail-closed：/media 开启（signing_key 非空）而许可根集为空 → 启动即拒。
    // 不收口 roots 的 /media = 任意路径读（media_ref/playback_path 为 DB 值直开）；
    // 拒启动比运行期全 404 更早暴露配置缺失（与 JWT secret 黑名单同风格）。
    if !cfg.media.signing_key.is_empty() && cfg.media.allowed_roots.is_empty() {
        anyhow::bail!("MEDIA__ALLOWED_ROOTS must list at least one absolute path when MEDIA__SIGNING_KEY is set");
    }
    // SEC-3 fail-closed：TRAINING__ADMIN_TOKEN 非空（/bind、/overview 凭据启用）而
    // < 32 字节 → 启动即拒——短 token 在 bind/login IP 限流（10/min）之外仍留
    // 慢速枚举面；空 = 功能未启用放行（与 signing_key 同款语义）。
    if !cfg.training.admin_token.is_empty() && cfg.training.admin_token.len() < 32 {
        anyhow::bail!("TRAINING__ADMIN_TOKEN too short (must be at least 32 bytes when set)");
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
                    // SEC-2：media.allowed_roots 逗号串 → Vec<String>（与 cors 同法）
                    .with_list_parse_key("cors.allowed_origins")
                    .with_list_parse_key("media.allowed_roots"),
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
        // R4：限流规格入 config——段缺失时 serde 默认 30/60/30（与旧硬编码零行为变化；
        // t_per_min = SEC-7 落地限流，round3 复核补断言）；default.json 显式携带同值；
        // Environment 覆盖键形如 PAGE_RATE_LIMITS__S_PER_MIN（"__" 分隔嵌套 +
        // try_parsing 数字解析，与 DATABASE__MAX_CONNECTIONS 同法）。
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
        assert_eq!(c.page_rate_limits.t_per_min, 30, "absent section falls back to 30 (SEC-7)");

        // default.json 显式值 = 30/60/30（from_env 读 cargo test cwd 的 config/default.json）
        std::env::set_var("JWT__SECRET", "unit-test-secret-override-not-leaked");
        let cfg = AppConfig::from_env().expect("from_env");
        assert_eq!(cfg.page_rate_limits.s_per_min, 30);
        assert_eq!(cfg.page_rate_limits.beacon_per_min, 60);
        assert_eq!(cfg.page_rate_limits.t_per_min, 30);

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

    /// ENV-1（终审 round3）：`STORAGE__TYPE` env 键必须能落到 storage_type 字段——
    /// 字段名 storage_type 无 alias 时键被静默忽略（永远 local），alias "type" 修活。
    /// json 的 storage_type 全名形态同时保持兼容。
    #[test]
    fn storage_type_env_alias_and_json_full_name_both_accepted() {
        #[derive(Deserialize)]
        struct StorageProbe {
            #[serde(default = "default_storage_type", alias = "type")]
            storage_type: String,
        }
        std::env::set_var("T4STORE__TYPE", "s3");
        let via_env: StorageProbe = ConfigBuilder::builder()
            .add_source(Environment::with_prefix("T4STORE").separator("__").try_parsing(true))
            .build()
            .unwrap()
            .try_deserialize()
            .unwrap();
        assert_eq!(via_env.storage_type, "s3", "STORAGE__TYPE 形态必须生效");

        let via_json: StorageProbe = serde_json::from_str(r#"{"storage_type": "s3x"}"#).unwrap();
        assert_eq!(via_json.storage_type, "s3x", "json 全名形态保持兼容");
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
        // SEC-2：signing_key 非空即 /media 开启，roots 必须同步给出（见耦合测试）
        cfg.media.allowed_roots = vec!["/media".to_string()];
        cfg.media.signing_key = "k".repeat(32);
        assert!(validate(&cfg).is_ok());
        cfg.media.signing_key = String::new();
        assert!(validate(&cfg).is_ok());
    }

    #[test]
    fn training_admin_token_length_validated() {
        // SEC-3 fail-closed：admin_token 非空（bind/overview 凭据启用）而 < 32 字节
        // → 启动即拒（暴力枚举面）；空 = 功能未启用放行（与 signing_key 同款）。
        let mut cfg: AppConfig = serde_json::from_value(serde_json::json!({
            "server": {"host": "0.0.0.0", "port": 8080},
            "database": {"url": "postgres://x", "max_connections": 1},
            "redis_url": "redis://x",
            "jwt": {"secret": "x"},
            "storage": {"path": "/tmp/x"},
            "cors": {"allowed_origins": ["http://localhost"]}
        }))
        .expect("minimal AppConfig");
        // 空串放行
        assert!(validate(&cfg).is_ok(), "empty token = feature off, pass");
        // 短 token 拒绝（red：修复前 is_ok）
        cfg.training.admin_token = "tok123".to_string();
        let err = validate(&cfg).unwrap_err();
        assert!(
            err.to_string().contains("TRAINING__ADMIN_TOKEN too short"),
            "short token must fail: {err}"
        );
        // 32 字节放行
        cfg.training.admin_token = "t".repeat(32);
        assert!(validate(&cfg).is_ok(), "32-byte token passes");
    }

    #[test]
    fn media_signing_key_requires_allowed_roots() {
        // SEC-2 fail-closed：/media 开启（signing_key 非空）而许可根集为空 → 启动即拒
        // （否则任意路径读仅剩运行期 404，配置漂移静默化）。signing_key 空 = 功能未启用放行。
        let mut cfg: AppConfig = serde_json::from_value(serde_json::json!({
            "server": {"host": "0.0.0.0", "port": 8080},
            "database": {"url": "postgres://x", "max_connections": 1},
            "redis_url": "redis://x",
            "jwt": {"secret": "x"},
            "storage": {"path": "/tmp/x"},
            "cors": {"allowed_origins": ["http://localhost"]}
        }))
        .expect("minimal AppConfig");
        cfg.media.signing_key = "k".repeat(32);
        let err = validate(&cfg).unwrap_err();
        assert!(
            err.to_string().contains("MEDIA__ALLOWED_ROOTS"),
            "signing key set without roots must fail: {err}"
        );
        cfg.media.allowed_roots = vec!["/data/media".to_string()];
        assert!(validate(&cfg).is_ok(), "roots set → pass");
        // 功能未启用（key 空）时 roots 可缺省
        cfg.media.signing_key = String::new();
        cfg.media.allowed_roots.clear();
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
