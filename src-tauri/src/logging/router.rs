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

    // target 固定为字面量 "frontend"（tracing 宏的 callsite 要求 target 为编译期 &'static str，
    // 无法用 entry.module 这种运行时变量——那会触发 E0435）。
    // 收益：RUST_LOG=frontend=debug 可单独控制所有前端日志（与后端分离）；
    //       EnvFilter 字段语法 frontend[module="src/lib/ingest.ts"]=debug 可按模块筛选。
    // module 作为 span 字段保留，供 JSON 日志查询与字段过滤。
    match entry.level {
        LogLevel::Debug => {
            let span = tracing::debug_span!(target: "frontend", "frontend_log", trace_id = %trace_id, module = %entry.module, frontend_ts = %entry.timestamp);
            let _guard = span.enter();
            tracing::debug!(target: "frontend", "{}", entry.message);
            if let Some(data) = entry.data {
                tracing::debug!(target: "frontend", data = ?data, "context");
            }
        }
        LogLevel::Info => {
            let span = tracing::info_span!(target: "frontend", "frontend_log", trace_id = %trace_id, module = %entry.module, frontend_ts = %entry.timestamp);
            let _guard = span.enter();
            tracing::info!(target: "frontend", "{}", entry.message);
            if let Some(data) = entry.data {
                tracing::info!(target: "frontend", data = ?data, "context");
            }
        }
        LogLevel::Warn => {
            let span = tracing::warn_span!(target: "frontend", "frontend_log", trace_id = %trace_id, module = %entry.module, frontend_ts = %entry.timestamp);
            let _guard = span.enter();
            tracing::warn!(target: "frontend", "{}", entry.message);
            if let Some(data) = entry.data {
                tracing::warn!(target: "frontend", data = ?data, "context");
            }
        }
        LogLevel::Error => {
            let span = tracing::error_span!(target: "frontend", "frontend_log", trace_id = %trace_id, module = %entry.module, frontend_ts = %entry.timestamp);
            let _guard = span.enter();
            tracing::error!(target: "frontend", "{}", entry.message);
            if let Some(data) = entry.data {
                tracing::error!(target: "frontend", data = ?data, "context");
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
