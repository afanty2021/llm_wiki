use crate::logging::types::{FrontendLogEntry, LogLevel};

/// 处理前端批量日志
pub fn route_batch_logs(entries: Vec<FrontendLogEntry>) {
    for entry in entries {
        route_single_log(entry);
    }
}

/// 路由单条日志到 tracing 层
fn route_single_log(entry: FrontendLogEntry) {
    let trace_id = entry.trace_id;
    let target = entry.module.as_str();

    match entry.level {
        LogLevel::Debug => {
            let span = tracing::debug_span!(target: target, "frontend_log", trace_id = %trace_id);
            let _guard = span.enter();
            tracing::debug!("{}", entry.message);
            if let Some(data) = entry.data {
                tracing::debug!(data = ?data, "context");
            }
        }
        LogLevel::Info => {
            let span = tracing::info_span!(target: target, "frontend_log", trace_id = %trace_id);
            let _guard = span.enter();
            tracing::info!("{}", entry.message);
            if let Some(data) = entry.data {
                tracing::info!(data = ?data, "context");
            }
        }
        LogLevel::Warn => {
            let span = tracing::warn_span!(target: target, "frontend_log", trace_id = %trace_id);
            let _guard = span.enter();
            tracing::warn!("{}", entry.message);
            if let Some(data) = entry.data {
                tracing::warn!(data = ?data, "context");
            }
        }
        LogLevel::Error => {
            let span = tracing::error_span!(target: target, "frontend_log", trace_id = %trace_id);
            let _guard = span.enter();
            tracing::error!("{}", entry.message);
            if let Some(data) = entry.data {
                tracing::error!(data = ?data, "context");
            }
        }
    }
}
