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

    match entry.level {
        LogLevel::Debug => {
            let span = tracing::debug_span!("frontend_log", trace_id = %trace_id, module = %entry.module);
            let _guard = span.enter();
            tracing::debug!("{}", entry.message);
            if let Some(data) = entry.data {
                tracing::debug!(data = ?data, "context");
            }
        }
        LogLevel::Info => {
            let span = tracing::info_span!("frontend_log", trace_id = %trace_id, module = %entry.module);
            let _guard = span.enter();
            tracing::info!("{}", entry.message);
            if let Some(data) = entry.data {
                tracing::info!(data = ?data, "context");
            }
        }
        LogLevel::Warn => {
            let span = tracing::warn_span!("frontend_log", trace_id = %trace_id, module = %entry.module);
            let _guard = span.enter();
            tracing::warn!("{}", entry.message);
            if let Some(data) = entry.data {
                tracing::warn!(data = ?data, "context");
            }
        }
        LogLevel::Error => {
            let span = tracing::error_span!("frontend_log", trace_id = %trace_id, module = %entry.module);
            let _guard = span.enter();
            tracing::error!("{}", entry.message);
            if let Some(data) = entry.data {
                tracing::error!(data = ?data, "context");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logging::types::{FrontendLogEntry, LogLevel};
    use serde_json::json;

    #[test]
    fn test_route_single_log_via_batch() {
        let entry = FrontendLogEntry {
            timestamp: "2026-06-14T12:00:00Z".to_string(),
            level: LogLevel::Info,
            module: "test_module".to_string(),
            trace_id: "test-trace-id".to_string(),
            message: "test message".to_string(),
            data: Some(json!({"key": "value"})),
        };

        route_batch_logs(vec![entry]);
    }

    #[test]
    fn test_route_batch_logs() {
        let entries = vec![
            FrontendLogEntry {
                timestamp: "2026-06-14T12:00:00Z".to_string(),
                level: LogLevel::Debug,
                module: "test_module".to_string(),
                trace_id: "trace-1".to_string(),
                message: "debug message".to_string(),
                data: None,
            },
            FrontendLogEntry {
                timestamp: "2026-06-14T12:00:01Z".to_string(),
                level: LogLevel::Error,
                module: "test_module".to_string(),
                trace_id: "trace-2".to_string(),
                message: "error message".to_string(),
                data: None,
            },
        ];

        route_batch_logs(entries);
    }
}
