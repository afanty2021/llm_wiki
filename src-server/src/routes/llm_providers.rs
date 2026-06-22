// routes/llm_providers.rs — team-scoped LLM provider CRUD（Admin 写 / Member 读，GET 不回传 key）。
use crate::middleware::project_guard::{check_team_access_with_role, RequiredRole};
use crate::services::llm::derive_key;
use crate::{AppError, AppState};
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde::{Deserialize, Serialize};

pub fn llm_provider_routes() -> axum::Router<AppState> {
    axum::Router::new()
        .route("/api/v1/teams/:id/llm-providers", axum::routing::post(create_provider))
        .route("/api/v1/teams/:id/llm-providers", axum::routing::get(get_provider))
        .route("/api/v1/teams/:id/llm-providers/:sid", axum::routing::put(update_provider))
        .route("/api/v1/teams/:id/llm-providers/:sid", axum::routing::delete(delete_provider))
}

#[derive(Deserialize)]
pub struct CreateBody {
    pub provider_type: String,
    pub api_key: String,
    pub base_url: Option<String>,
    pub model: Option<String>,
    pub context_size: Option<i32>,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ProviderResp {
    pub id: i32,
    pub provider_type: String,
    pub base_url: Option<String>,
    pub model: String,
    pub context_size: i32,
    pub is_enabled: bool,
    pub has_key: bool,
}

pub async fn create_provider(
    State(state): State<AppState>, Path(team_id): Path<i32>, headers: HeaderMap, Json(body): Json<CreateBody>,
) -> Result<(StatusCode, Json<ProviderResp>), AppError> {
    check_team_access_with_role(&state, &headers, team_id, RequiredRole::Admin).await?;
    let key = derive_key(&state.config);
    let enc = crate::utils::crypto::encrypt_api_key(&body.api_key, &key)?;
    let model = body.model.clone().unwrap_or_else(|| "gpt-4o".into());
    let context_size = body.context_size.unwrap_or(128000);
    let row: Result<(i32,), sqlx::Error> = sqlx::query_as(
        "INSERT INTO llm_providers (team_id, provider_type, api_key_encrypted, base_url, model, context_size) \
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id")
        .bind(team_id).bind(&body.provider_type).bind(&enc).bind(&body.base_url)
        .bind(&model).bind(context_size)
        .fetch_one(&state.db).await;
    let (id,) = match row {
        Ok(r) => r,
        Err(sqlx::Error::Database(e)) if e.is_unique_violation() => {
            return Err(AppError::Conflict("provider_type already exists for team".into()));
        }
        Err(e) => return Err(AppError::DatabaseError(e)),
    };
    Ok((StatusCode::CREATED, Json(ProviderResp {
        id, provider_type: body.provider_type, base_url: body.base_url,
        model, context_size, is_enabled: true, has_key: true,
    })))
}

pub async fn get_provider(
    State(state): State<AppState>, Path(team_id): Path<i32>, headers: HeaderMap,
) -> Result<Json<Option<ProviderResp>>, AppError> {
    check_team_access_with_role(&state, &headers, team_id, RequiredRole::Member).await?;
    let row: Option<(i32, String, Option<String>, String, i32, bool)> = sqlx::query_as(
        "SELECT id, provider_type, base_url, model, context_size, is_enabled \
         FROM llm_providers WHERE team_id=$1 AND is_enabled=TRUE ORDER BY id LIMIT 1")
        .bind(team_id).fetch_optional(&state.db).await?;
    Ok(Json(row.map(|(id, t, b, m, c, e)| ProviderResp {
        id, provider_type: t, base_url: b, model: m, context_size: c, is_enabled: e, has_key: true,
    })))
}

#[derive(Deserialize)]
pub struct UpdateBody {
    pub api_key: Option<String>,
    pub base_url: Option<String>,
    pub model: Option<String>,
    pub context_size: Option<i32>,
    pub is_enabled: Option<bool>,
}

pub async fn update_provider(
    State(state): State<AppState>, Path((team_id, sid)): Path<(i32, i32)>, headers: HeaderMap, Json(body): Json<UpdateBody>,
) -> Result<Json<ProviderResp>, AppError> {
    check_team_access_with_role(&state, &headers, team_id, RequiredRole::Admin).await?;
    let mut tx = state.db.begin().await?;
    if let Some(plain) = body.api_key.as_deref() {
        let key = derive_key(&state.config);
        let enc = crate::utils::crypto::encrypt_api_key(plain, &key)?;
        sqlx::query("UPDATE llm_providers SET api_key_encrypted=$1 WHERE id=$2 AND team_id=$3")
            .bind(&enc).bind(sid).bind(team_id).execute(&mut *tx).await?;
    }
    if let Some(b) = body.base_url.as_deref() {
        sqlx::query("UPDATE llm_providers SET base_url=$1 WHERE id=$2 AND team_id=$3")
            .bind(b).bind(sid).bind(team_id).execute(&mut *tx).await?;
    }
    if let Some(m) = body.model.as_deref() {
        sqlx::query("UPDATE llm_providers SET model=$1 WHERE id=$2 AND team_id=$3")
            .bind(m).bind(sid).bind(team_id).execute(&mut *tx).await?;
    }
    if let Some(c) = body.context_size {
        sqlx::query("UPDATE llm_providers SET context_size=$1 WHERE id=$2 AND team_id=$3")
            .bind(c).bind(sid).bind(team_id).execute(&mut *tx).await?;
    }
    if let Some(e) = body.is_enabled {
        sqlx::query("UPDATE llm_providers SET is_enabled=$1 WHERE id=$2 AND team_id=$3")
            .bind(e).bind(sid).bind(team_id).execute(&mut *tx).await?;
    }
    let row: (i32, String, Option<String>, String, i32, bool) = sqlx::query_as(
        "SELECT id, provider_type, base_url, model, context_size, is_enabled FROM llm_providers WHERE id=$1 AND team_id=$2")
        .bind(sid).bind(team_id).fetch_one(&mut *tx).await
        .map_err(|_| AppError::ResourceNotFound("llm_provider".into()))?;
    tx.commit().await?;
    Ok(Json(ProviderResp {
        id: row.0, provider_type: row.1, base_url: row.2, model: row.3,
        context_size: row.4, is_enabled: row.5, has_key: true,
    }))
}

pub async fn delete_provider(
    State(state): State<AppState>, Path((team_id, sid)): Path<(i32, i32)>, headers: HeaderMap,
) -> Result<StatusCode, AppError> {
    check_team_access_with_role(&state, &headers, team_id, RequiredRole::Admin).await?;
    let n = sqlx::query("DELETE FROM llm_providers WHERE id=$1 AND team_id=$2")
        .bind(sid).bind(team_id).execute(&state.db).await?;
    if n.rows_affected() == 0 {
        return Err(AppError::ResourceNotFound("llm_provider".into()));
    }
    Ok(StatusCode::OK)
}
