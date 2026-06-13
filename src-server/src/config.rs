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

fn default_allowed_origins() -> Vec<String> {
    vec!["http://localhost:1420".to_string()]
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
}
