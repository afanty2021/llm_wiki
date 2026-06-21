//! Layer 3 Phase A: wiki-contextual chat — conversation persistence + SSE RAG.
//!
//! Routes (project-scoped, merged under /api/v1/projects):
//!   GET    /:id/chat/conversations                 list current user's conversations
//!   POST   /:id/chat/conversations                 create conversation
//!   GET    /:id/chat/conversations/:cid/messages   list messages (last 100, chronological)
//!   DELETE /:id/chat/conversations/:cid            delete conversation (cascade)
//!   POST   /:id/chat/conversations/:cid/stream     SSE RAG turn (Task 6)

use axum::{
    extract::{Path, Query, State},
    http::HeaderMap,
    Json,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::services::citations::MessageReference;
use crate::services::llm_stream::{ChatMessage, ChatOpts, StreamChatProvider, TokenDelta};
use crate::{AppState, AppError};
use crate::middleware::project_guard::check_project_access;

const HISTORY_LIMIT: i64 = 10;
const MESSAGE_PAGE_LIMIT: i64 = 100;

// ---- response DTOs ----
#[derive(Debug, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct ConversationResp {
    pub id: i64,
    pub uuid: Uuid,
    pub project_id: i32,
    pub user_id: i32,
    pub title: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageResp {
    pub id: i64,
    pub uuid: Uuid,
    pub conversation_id: i64,
    pub role: String,
    pub content: String,
    pub refs: Option<Vec<MessageReference>>,
    pub citations: Option<Vec<i32>>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, sqlx::FromRow)]
struct MsgRow {
    id: i64,
    uuid: Uuid,
    conversation_id: i64,
    role: String,
    content: String,
    refs: Option<serde_json::Value>,
    citations: Option<Vec<i32>>,
    created_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateConvBody {
    pub title: Option<String>,
}

pub fn chat_session_routes() -> axum::Router<AppState> {
    axum::Router::new()
        .route(
            "/:id/chat/conversations",
            axum::routing::get(list_conversations).post(create_conversation),
        )
        .route(
            "/:id/chat/conversations/:cid/messages",
            axum::routing::get(list_messages),
        )
        .route(
            "/:id/chat/conversations/:cid",
            axum::routing::delete(delete_conversation),
        )
        // conversation_stream is added in Task 6
}

// ---- list: current user's conversations, newest first ----
pub async fn list_conversations(
    State(state): State<AppState>,
    Path(project_id): Path<i32>,
    headers: HeaderMap,
) -> Result<Json<Vec<ConversationResp>>, AppError> {
    let (user_id, _) = check_project_access(&state, &headers, project_id).await?;
    let rows = sqlx::query_as::<_, ConversationResp>(
        "SELECT id, uuid, project_id, user_id, title, created_at, updated_at \
         FROM chat_conversations WHERE project_id = $1 AND user_id = $2 \
         ORDER BY updated_at DESC",
    )
    .bind(project_id)
    .bind(user_id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

// ---- create ----
pub async fn create_conversation(
    State(state): State<AppState>,
    Path(project_id): Path<i32>,
    headers: HeaderMap,
    Json(body): Json<CreateConvBody>,
) -> Result<(axum::http::StatusCode, Json<ConversationResp>), AppError> {
    let (user_id, _) = check_project_access(&state, &headers, project_id).await?;
    let title = body
        .title
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| "New chat".to_string());
    let row = sqlx::query_as::<_, ConversationResp>(
        "INSERT INTO chat_conversations (uuid, project_id, user_id, title) \
         VALUES ($1, $2, $3, $4) \
         RETURNING id, uuid, project_id, user_id, title, created_at, updated_at",
    )
    .bind(Uuid::new_v4())
    .bind(project_id)
    .bind(user_id)
    .bind(&title)
    .fetch_one(&state.db)
    .await?;
    Ok((axum::http::StatusCode::CREATED, Json(row)))
}

// ---- messages: last 100 chronological ----
pub async fn list_messages(
    State(state): State<AppState>,
    Path((project_id, conv_id)): Path<(i32, i64)>,
    headers: HeaderMap,
) -> Result<Json<Vec<MessageResp>>, AppError> {
    let (user_id, _) = check_project_access(&state, &headers, project_id).await?;
    // ownership check
    let owned = sqlx::query_scalar::<_, i64>(
        "SELECT id FROM chat_conversations WHERE id = $1 AND project_id = $2 AND user_id = $3",
    )
    .bind(conv_id)
    .bind(project_id)
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?;
    if owned.is_none() {
        return Err(AppError::ResourceNotFound("conversation not found".into()));
    }
    // fetch last N newest-first, then reverse to chronological
    let mut rows = sqlx::query_as::<_, MsgRow>(
        "SELECT id, uuid, conversation_id, role, content, refs, citations, created_at \
         FROM chat_messages WHERE conversation_id = $1 \
         ORDER BY created_at DESC LIMIT $2",
    )
    .bind(conv_id)
    .bind(MESSAGE_PAGE_LIMIT)
    .fetch_all(&state.db)
    .await?;
    rows.reverse();
    let out: Vec<MessageResp> = rows
        .into_iter()
        .map(|r| MessageResp {
            id: r.id,
            uuid: r.uuid,
            conversation_id: r.conversation_id,
            role: r.role,
            content: r.content,
            refs: r
                .refs
                .and_then(|v| serde_json::from_value::<Vec<MessageReference>>(v).ok()),
            citations: r.citations,
            created_at: r.created_at,
        })
        .collect();
    Ok(Json(out))
}

// ---- delete (cascade messages) ----
pub async fn delete_conversation(
    State(state): State<AppState>,
    Path((project_id, conv_id)): Path<(i32, i64)>,
    headers: HeaderMap,
) -> Result<axum::http::StatusCode, AppError> {
    let (user_id, _) = check_project_access(&state, &headers, project_id).await?;
    let res = sqlx::query(
        "DELETE FROM chat_conversations WHERE id = $1 AND project_id = $2 AND user_id = $3",
    )
    .bind(conv_id)
    .bind(project_id)
    .bind(user_id)
    .execute(&state.db)
    .await?;
    if res.rows_affected() == 0 {
        return Err(AppError::ResourceNotFound("conversation not found".into()));
    }
    Ok(axum::http::StatusCode::NO_CONTENT)
}
