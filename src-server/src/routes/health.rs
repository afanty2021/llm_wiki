use std::time::Duration;

use axum::{Json, extract::State, response::IntoResponse};
use serde_json::json;

use crate::AppState;

/// SEC-4（终审必修）：degraded 详情字段恒为常量。DB/Redis 驱动的 `to_string()`
/// 可能携带 DSN/内部拓扑/驱动细节等敏感串（sqlx 错误常含连接信息），完整原文只进
/// `tracing::warn`（运维日志可见），对外响应（外部探针/mcp-server 消费方）只见常量。
const DEGRADED_DETAIL: &str = "unavailable";

/// 掩码：错误原文落 warn 日志，返回恒定 [`DEGRADED_DETAIL`]。
fn log_and_mask(e: &(impl std::fmt::Display + ?Sized), dep: &str) -> &'static str {
    tracing::warn!(dependency = dep, error = %e, "health check dependency degraded");
    DEGRADED_DETAIL
}

/// GET /health。依赖探活（实现评审 F4）：DB/Redis 任一失败（含 2s 超时）→
/// status:"degraded" + degraded 详情（恒为常量，见 [`DEGRADED_DETAIL`]），
/// **仍返回 200**——外部可用性探针（cloudflared 外测 / T9 演练判据 health 200）
/// 不受影响；mcp-server 启动探针（index.ts main）消费 degraded 字段告警。
pub async fn health_check(State(state): State<AppState>) -> impl IntoResponse {
    let db_err: Option<&'static str> = match tokio::time::timeout(
        Duration::from_secs(2),
        sqlx::query("SELECT 1").execute(&state.db),
    )
    .await
    {
        Ok(Ok(_)) => None,
        Ok(Err(e)) => Some(log_and_mask(&e, "db")),
        Err(_) => Some("timeout after 2s"),
    };
    let redis_err: Option<&'static str> = match state.redis.get().await {
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
                Ok(Err(e)) => Some(log_and_mask(&e, "redis")),
                Err(_) => Some("timeout after 2s"),
            }
        }
        Err(e) => Some(log_and_mask(&e, "redis_pool")),
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

#[cfg(test)]
mod tests {
    use super::*;

    /// SEC-4（终审必修）：degraded 详情字段恒为常量 "unavailable"——构造含独特
    /// 标记（模拟 DSN/驱动内部串）的错误，掩码返回值不得含原文任何片段。
    #[test]
    fn degraded_detail_is_constant_not_error_text() {
        struct FakeErr(&'static str);
        impl std::fmt::Display for FakeErr {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(f, "SECRET-DBL-DETAIL host=10.0.0.1 dsn={}", self.0)
            }
        }
        let masked = log_and_mask(&FakeErr("postgres://u:p@db:5432"), "db");
        assert_eq!(masked, "unavailable", "masked field must be the constant");
        assert!(!masked.contains("SECRET"), "no error text may leak");
        assert!(!masked.contains("10.0.0.1"), "no internals may leak");
        assert_eq!(DEGRADED_DETAIL, "unavailable");
    }
}
