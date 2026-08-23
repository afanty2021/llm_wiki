//! refresh_tokens 表清理 job（评审遗留项收口，2026-08-23）。
//!
//! SPA/transcriber 每次 refresh 都走单次使用式轮换：revoke 旧行 + 插新行。
//! 无清理则表无限增长（4h access TTL 后轮换频率大降，但历史行仍累积）。
//! 策略：**过期行即删**（expires_at < NOW，无论是否吊销）+ **已吊销行保留
//! 7 天观测窗后删**（revoked_at < NOW - 7d）——活跃行永不触碰。

use crate::AppState;

/// server 启动时调用一次（与 ingest_worker::spawn_worker 同款接线）：
/// 立即跑一轮，之后每小时一轮。失败只 warn 不退出（下一轮自愈）。
pub fn spawn_token_cleanup(state: AppState) {
    tokio::spawn(async move {
        tracing::info!("token cleanup job started (hourly)");
        loop {
            match cleanup_once(&state).await {
                Ok(n) if n > 0 => tracing::info!("token cleanup: removed {n} rows"),
                Ok(_) => {}
                Err(e) => tracing::warn!("token cleanup error: {e}"),
            }
            tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
        }
    });
}

/// 删除过期行 + 吊销超 7 天的行，返回删除行数。pub 供集成测试直调。
pub async fn cleanup_once(state: &AppState) -> Result<u64, sqlx::Error> {
    let res = sqlx::query(
        "DELETE FROM refresh_tokens \
         WHERE expires_at < NOW() \
            OR (revoked_at IS NOT NULL AND revoked_at < NOW() - INTERVAL '7 days')",
    )
    .execute(&state.db)
    .await?;
    Ok(res.rows_affected())
}
