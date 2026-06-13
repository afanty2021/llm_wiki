use sqlx::PgPool;
use crate::AppError;

/// Decrypted LLM provider configuration
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

/// Fetch the first enabled LLM provider config for a project
pub async fn get_llm_config(pool: &PgPool, project_id: i32) -> Result<LlmConfig, AppError> {
    let row = sqlx::query_as::<_, LlmProviderRow>(
        "SELECT provider_type, api_key_encrypted, base_url, model, context_size
         FROM llm_providers
         WHERE project_id = $1 AND is_enabled = TRUE
         ORDER BY id LIMIT 1",
    )
    .bind(project_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| AppError::DatabaseError(e))?;

    match row {
        Some(r) => Ok(LlmConfig {
            provider_type: r.provider_type,
            api_key: r.api_key_encrypted,
            base_url: r.base_url,
            model: r.model,
            context_size: r.context_size,
        }),
        None => Err(AppError::BadRequest(
            "No LLM provider configured for this project".into(),
        )),
    }
}

/// Decrypt the stored API key using a key derived from JWT secret.
/// The key is first 32 bytes of config.jwt_secret().
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
