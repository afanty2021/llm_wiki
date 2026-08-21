use std::time::Duration;

use axum::{Json, extract::State, response::IntoResponse};
use serde_json::json;

use crate::AppState;

/// GET /health。依赖探活（实现评审 F4）：DB/Redis 任一失败（含 2s 超时）→
/// status:"degraded" + degraded 详情，**仍返回 200**——外部可用性探针
/// （cloudflared 外测 / T9 演练判据 health 200）不受影响；mcp-server 启动
/// 探针（index.ts main）消费 degraded 字段告警。
pub async fn health_check(State(state): State<AppState>) -> impl IntoResponse {
    let db_err = match tokio::time::timeout(
        Duration::from_secs(2),
        sqlx::query("SELECT 1").execute(&state.db),
    )
    .await
    {
        Ok(Ok(_)) => None,
        Ok(Err(e)) => Some(e.to_string()),
        Err(_) => Some("timeout after 2s".to_string()),
    };
    let redis_err = match state.redis.get().await {
        Ok(mut conn) => {
            // redis::cmd() 返回线程局部 Cmd 的临时借用——持有其 future 会 E0716，
            // 故与 db.rs 同形态：async 块内联 await，借用即起即落。
            match tokio::time::timeout(Duration::from_secs(2), async {
                let _: String = redis::cmd("PING").query_async(&mut conn).await?;
                Ok::<(), redis::RedisError>(())
            })
            .await
            {
                Ok(Ok(())) => None,
                Ok(Err(e)) => Some(e.to_string()),
                Err(_) => Some("timeout after 2s".to_string()),
            }
        }
        Err(e) => Some(e.to_string()),
    };

    if db_err.is_none() && redis_err.is_none() {
        Json(json!({
            "status": "ok",
            "timestamp": chrono::Utc::now().to_rfc3339()
        }))
    } else {
        Json(json!({
            "status": "degraded",
            "degraded": { "db": db_err, "redis": redis_err },
            "timestamp": chrono::Utc::now().to_rfc3339()
        }))
    }
}
