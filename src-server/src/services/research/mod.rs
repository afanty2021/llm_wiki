// src/services/research/mod.rs — Research 类型 + 纯函数 + 入队。
pub mod synthesize;
// pub mod worker;      // Task 6 启用

use crate::{AppError, AppState};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(sqlx::FromRow, Debug, Clone, Serialize)]
pub struct ResearchTask {
    pub id: Uuid,
    pub project_id: i32,
    pub user_id: Option<i32>,
    pub topic: String,
    pub search_queries: Option<Vec<String>>,
    pub status: String,
    pub stage: Option<String>,
    pub web_results: Option<serde_json::Value>,
    pub synthesis: Option<String>,
    pub saved_path: Option<String>,
    pub source_kind: String,
    pub error: Option<String>,
    pub created_at: DateTime<Utc>,
    pub started_at: Option<DateTime<Utc>>,
    pub finished_at: Option<DateTime<Utc>>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Deserialize)]
pub struct EnqueueBody {
    pub topic: String,
    pub search_queries: Option<Vec<String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchOutcome {
    pub path: String,
    pub synthesis: String,
}

/// 纯：topic → [topic, "{topic} overview", "{topic} latest"]（CJK 安全）。
pub fn derive_queries(topic: &str) -> Vec<String> {
    let t = topic.trim();
    vec![t.to_string(), format!("{} overview", t), format!("{} latest", t)]
}

/// 纯：topic → slug（复用 review::slugify，已 pub）。
pub fn slugify_topic(topic: &str) -> String {
    crate::services::review::slugify(topic)
}

/// 入队：INSERT research_task + LPUSH research:queue，返回 task id。
pub async fn enqueue_research_task(
    state: &AppState,
    project_id: i32,
    user_id: Option<i32>,
    topic: &str,
    search_queries: Option<Vec<String>>,
    source_kind: &str,
) -> Result<Uuid, AppError> {
    let row: (Uuid,) = sqlx::query_as(
        "INSERT INTO research_tasks (project_id, user_id, topic, search_queries, source_kind) \
         VALUES ($1,$2,$3,$4,$5) RETURNING id")
        .bind(project_id).bind(user_id).bind(topic)
        .bind(search_queries.as_ref()).bind(source_kind)
        .fetch_one(&state.db).await?;
    let id = row.0;
    let mut redis = state.redis.get().await.map_err(AppError::from)?;
    let _: i64 = redis::cmd("LPUSH").arg("research:queue").arg(id.to_string())
        .query_async(&mut *redis).await
        .unwrap_or_else(|e| { tracing::error!("LPUSH research:queue {}: {}", id, e); 0 });
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn derive_queries_cjk_safe() {
        let q = derive_queries("量子计算");
        assert_eq!(q.len(), 3);
        assert_eq!(q[0], "量子计算");
        assert_eq!(q[1], "量子计算 overview");
        assert_eq!(q[2], "量子计算 latest");
    }
    #[test]
    fn slugify_topic_ascii_and_cjk() {
        assert_eq!(slugify_topic("Hello World"), "hello-world");
        assert_eq!(slugify_topic("量子 计算!"), "量子-计算");
    }
}
