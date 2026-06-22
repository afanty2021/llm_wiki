//! Layer 3 Phase A: wiki-contextual chat — conversation persistence + SSE RAG.
//!
//! Routes (project-scoped, merged under /api/v1/projects):
//!   GET    /:id/chat/conversations                 list current user's conversations
//!   POST   /:id/chat/conversations                 create conversation
//!   GET    /:id/chat/conversations/:cid/messages   list messages (last 100, chronological)
//!   DELETE /:id/chat/conversations/:cid            delete conversation (cascade)
//!   POST   /:id/chat/conversations/:cid/stream     SSE RAG turn (Task 6)

use std::convert::Infallible;
use std::pin::Pin;
use std::time::Duration;

use axum::{
    extract::{Path, Query, State},
    http::HeaderMap,
    response::sse::{Event, KeepAlive, Sse},
    Json,
};
use chrono::{DateTime, Utc};
use futures::stream::{Stream, StreamExt};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::middleware::project_guard::check_project_access;
use crate::services::citations::parse_cited;
use crate::services::llm_stream::provider_for_project;
use crate::services::retrieval::{build_system_prompt, retrieve_context, RetrievedPage};
use crate::services::citations::MessageReference;
use crate::services::llm_stream::{ChatMessage, ChatOpts, StreamChatProvider, TokenDelta};
use crate::{AppError, AppState};

const HISTORY_LIMIT: i64 = 10;
const MESSAGE_PAGE_LIMIT: i64 = 100;

/// Boxed SSE event stream (type-erased), matching routes/chat.rs.
type SseStream = Pin<Box<dyn Stream<Item = Result<Event, Infallible>> + Send>>;

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
        .route(
            "/:id/chat/conversations/:cid/stream",
            axum::routing::post(conversation_stream),
        )
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

// ---- Task 6: SSE RAG stream ----

/// Structured events produced by a chat turn. The SSE handler converts each
/// variant to an axum `Event`; tests consume these directly.
#[derive(Debug, Clone)]
pub enum ChatStreamEvent {
    Retrieval(Vec<RetrievedPage>),
    Token(String),
    Done {
        references: Vec<MessageReference>,
        citations: Vec<i32>,
    },
    Error(String),
}

/// A boxed stream of structured chat-turn events (type-erased, for testing).
pub type TurnStream = Pin<Box<dyn Stream<Item = ChatStreamEvent> + Send>>;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamBody {
    pub message: String,
}

#[derive(sqlx::FromRow)]
struct HistRow {
    role: String,
    content: String,
}

/// Produce the structured events for one RAG turn. Verifies ownership,
/// retrieves context, builds messages, persists the user message, streams
/// tokens from the injected `provider`, parses citations, persists the
/// assistant message, and emits a final `Done`.
pub async fn stream_conversation_turn(
    state: AppState,
    project_id: i32,
    user_id: i32,
    conv_id: i64,
    user_msg: String,
    provider: Box<dyn StreamChatProvider>,
    model: String,
    context_size: i32,
) -> Result<TurnStream, AppError> {
    // ownership check (private conversation)
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

    // history (last N newest-first, reversed to chronological)
    let mut hist: Vec<HistRow> = sqlx::query_as::<_, HistRow>(
        "SELECT role, content FROM chat_messages WHERE conversation_id = $1 \
         ORDER BY created_at DESC LIMIT $2",
    )
    .bind(conv_id)
    .bind(HISTORY_LIMIT)
    .fetch_all(&state.db)
    .await?;
    hist.reverse();

    // retrieval + system prompt
    let retrieval = retrieve_context(&state, project_id, &user_msg, context_size).await?;
    let system_prompt = build_system_prompt(&retrieval);

    // messages = [system, ...history, user]
    let mut messages: Vec<ChatMessage> = Vec::with_capacity(2 + hist.len());
    messages.push(ChatMessage {
        role: "system".into(),
        content: system_prompt,
    });
    for h in hist {
        messages.push(ChatMessage {
            role: h.role,
            content: h.content,
        });
    }
    messages.push(ChatMessage {
        role: "user".into(),
        content: user_msg.clone(),
    });

    // persist user message (+ auto-title on first message)
    let is_first = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM chat_messages WHERE conversation_id = $1",
    )
    .bind(conv_id)
    .fetch_one(&state.db)
    .await?
        == 0;
    sqlx::query(
        "INSERT INTO chat_messages (uuid, conversation_id, role, content) \
         VALUES ($1, $2, 'user', $3)",
    )
    .bind(Uuid::new_v4())
    .bind(conv_id)
    .bind(&user_msg)
    .execute(&state.db)
    .await?;
    if is_first {
        let title: String = user_msg.chars().take(50).collect();
        sqlx::query("UPDATE chat_conversations SET title = $1, updated_at = NOW() WHERE id = $2")
            .bind(&title)
            .bind(conv_id)
            .execute(&state.db)
            .await?;
    }

    let ref_map = retrieval.ref_map.clone();
    let pages_for_event = retrieval.pages.clone();
    let pages_for_persist = retrieval.pages.clone(); // snapshot for retrieval_ctx column
    let state_for_stream = state.clone();

    let stream = async_stream::stream! {
        yield ChatStreamEvent::Retrieval(pages_for_event);

        let opts = ChatOpts {
            model: model.clone(),
            temperature: 0.3,
            max_tokens: 2048,
            system_prompt: None, // system message already in `messages`
            timeout_secs: None,
        };
        let mut ts = match provider.stream_chat(messages, opts).await {
            Ok(s) => s,
            Err(e) => {
                yield ChatStreamEvent::Error(e.to_string());
                return;
            }
        };
        let mut full = String::new();
        while let Some(delta) = ts.next().await {
            match delta {
                Ok(TokenDelta::Text(t)) => {
                    full.push_str(&t);
                    yield ChatStreamEvent::Token(t);
                }
                Ok(TokenDelta::Usage { .. }) => {}
                Ok(TokenDelta::Done) => break,
                Err(e) => {
                    yield ChatStreamEvent::Error(e.to_string());
                    return;
                }
            }
        }

        let citations = parse_cited(&full);
        let cited_refs: Vec<MessageReference> = citations
            .iter()
            .filter_map(|n| ref_map.get(n).cloned())
            .collect();
        let _ = persist_assistant(
            &state_for_stream,
            conv_id,
            &full,
            &citations,
            &cited_refs,
            &pages_for_persist,
        )
        .await;

        yield ChatStreamEvent::Done {
            references: cited_refs,
            citations,
        };
    };

    Ok(Box::pin(stream))
}

/// Convert a structured event into an SSE wire event.
fn to_sse_event(e: ChatStreamEvent) -> Event {
    match e {
        ChatStreamEvent::Retrieval(pages) => Event::default()
            .event("retrieval")
            .data(serde_json::to_string(&pages).unwrap_or_else(|_| "[]".into())),
        ChatStreamEvent::Token(t) => Event::default().event("token").data(t),
        ChatStreamEvent::Done {
            references,
            citations,
        } => Event::default().event("done").data(
            serde_json::json!({ "references": references, "citations": citations }).to_string(),
        ),
        ChatStreamEvent::Error(m) => Event::default()
            .event("error")
            .data(serde_json::json!({ "message": m }).to_string()),
    }
}

async fn persist_assistant(
    state: &AppState,
    conv_id: i64,
    content: &str,
    citations: &[i32],
    refs: &[MessageReference],
    retrieval_pages: &[RetrievedPage],
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO chat_messages (uuid, conversation_id, role, content, refs, citations, retrieval_ctx) \
         VALUES ($1, $2, 'assistant', $3, $4, $5, $6)",
    )
    .bind(Uuid::new_v4())
    .bind(conv_id)
    .bind(content)
    .bind(serde_json::to_value(refs).unwrap_or(serde_json::Value::Null))
    .bind(citations)
    .bind(
        serde_json::to_value(retrieval_pages).unwrap_or(serde_json::Value::Null),
    )
    .execute(&state.db)
    .await?;
    sqlx::query("UPDATE chat_conversations SET updated_at = NOW() WHERE id = $1")
        .bind(conv_id)
        .execute(&state.db)
        .await?;
    Ok(())
}

/// POST /:id/chat/conversations/:cid/stream — SSE RAG turn.
pub async fn conversation_stream(
    State(state): State<AppState>,
    Path((project_id, conv_id)): Path<(i32, i64)>,
    headers: HeaderMap,
    Json(body): Json<StreamBody>,
) -> Result<Sse<SseStream>, AppError> {
    let (user_id, _) = check_project_access(&state, &headers, project_id).await?;
    if body.message.trim().is_empty() {
        return Err(AppError::ValidationError("message is required".into()));
    }
    let llm = crate::services::llm::get_llm_config(&state.db, project_id).await?;
    let provider = provider_for_project(&state, project_id).await?;
    let turn = stream_conversation_turn(
        state,
        project_id,
        user_id,
        conv_id,
        body.message,
        provider,
        llm.model,
        llm.context_size,
    )
    .await?;
    let sse_stream: SseStream = Box::pin(turn.map(|e| Ok::<_, Infallible>(to_sse_event(e))));
    Ok(Sse::new(sse_stream)
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(15)).text("ping")))
}
