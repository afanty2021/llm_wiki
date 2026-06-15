//! NotifyLayer —— 捕获所有 ERROR 级别 tracing event，触发桌面通知。
//!
//! 前后端统一：前端 ERROR 经 router.rs 转为 tracing::error!(target:"frontend")，
//! 后端 ERROR 直接用 tracing::error! 宏，两者流经同一 Registry，均被本 Layer 捕获。

use crate::logging::config::read_error_notification_config;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;
use tracing::field::Visit;
use tracing::{Event, Subscriber};
use tracing_subscriber::Layer;

/// 通知去重窗口（秒）：窗口内仅发送首条 ERROR 通知
const NOTIFY_DEBOUNCE_SECS: u64 = 10;

/// 通知 body 最大字符数（通知 UI 限制，保守值）
const MAX_BODY_CHARS: usize = 200;

pub struct NotifyLayer {
    app_handle: AppHandle,
    last_notify: Mutex<Option<Instant>>,
}

impl NotifyLayer {
    pub fn new(app_handle: AppHandle) -> Self {
        Self {
            app_handle,
            last_notify: Mutex::new(None),
        }
    }

    /// 时间窗口去重：窗口内抑制后续通知。
    /// 内部委托给可注入的纯函数 acquire_slot_at，便于单测（避免依赖真实 Instant）。
    fn acquire_slot(&self) -> bool {
        acquire_slot_at(&self.last_notify, Instant::now(), Duration::from_secs(NOTIFY_DEBOUNCE_SECS))
    }

    /// 读取 error_notification 配置（默认开启）。
    fn notification_enabled(&self) -> bool {
        read_error_notification_config(&self.app_handle).unwrap_or(true)
    }
}

/// 纯时间窗口判定逻辑（可注入 now 与 threshold，便于单测）。
///
/// - last_notify 为 None（从未通知）→ 占用并返回 true
/// - now 距上次通知 ≥ threshold → 占用并返回 true
/// - 否则（窗口内）→ 返回 false（抑制）
fn acquire_slot_at(
    last_notify: &Mutex<Option<Instant>>,
    now: Instant,
    threshold: Duration,
) -> bool {
    let mut last = last_notify.lock().expect("last_notify mutex poisoned");
    if let Some(t) = *last {
        if now.duration_since(t) < threshold {
            return false;
        }
    }
    *last = Some(now);
    true
}

impl<S: Subscriber> Layer<S> for NotifyLayer {
    fn on_event(&self, event: &Event<'_>, _ctx: tracing_subscriber::layer::Context<'_, S>) {
        // 仅 ERROR 级别触发
        if event.metadata().level() != &tracing::Level::ERROR {
            return;
        }
        if !self.notification_enabled() {
            return;
        }
        if !self.acquire_slot() {
            return;
        }

        let mut visitor = MessageVisitor::default();
        event.record(&mut visitor);
        let body = visitor.message.unwrap_or_else(|| "(no message)".to_string());
        let body = truncate_message(&body);

        // macOS 关键约束：UNUserNotificationCenter 必须在主线程调用（见设计文档技术验证 4、
        // tauri issue #3241）。用 run_on_main_thread 将 show() 调度到主线程。
        let app = self.app_handle.clone();
        let final_body = format!("{}\n（更多错误详见日志）", body);
        tauri::async_runtime::spawn(async move {
            let app_for_closure = app.clone();
            let _ = app.run_on_main_thread(move || {
                let _ = app_for_closure
                    .notification()
                    .builder()
                    .title("LLM Wiki 发生错误")
                    .body(final_body)
                    .show();
            });
        });
    }
}

/// 截断超长消息（按字符数，非字节，正确处理多字节中文）。
fn truncate_message(s: &str) -> String {
    if s.chars().count() > MAX_BODY_CHARS {
        let truncated: String = s.chars().take(MAX_BODY_CHARS - 3).collect();
        format!("{}...", truncated)
    } else {
        s.to_string()
    }
}

/// 从 event fields 提取 message 字段。
///
/// tracing 的消息（tracing::error!("text")）经名为 "message" 的 field 传递，
/// 字符串以 Debug 形式记录（record_debug），format!("{:?}", "失败") 带引号。
/// 故 record_debug 中需 strip_debug_quotes 去引号。
#[derive(Default)]
struct MessageVisitor {
    message: Option<String>,
}

impl Visit for MessageVisitor {
    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" {
            let formatted = format!("{:?}", value);
            self.message = Some(strip_debug_quotes(&formatted));
        }
    }
    fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
        if field.name() == "message" {
            self.message = Some(value.to_string());
        }
    }
}

/// 去除 Debug 格式化给字符串值加的首尾引号。
/// 仅当首尾均为 `"` 时去除（避免误删消息内容中合法的引号）。
/// 权衡：内部转义序列不反转义——对通知场景足够。
fn strip_debug_quotes(s: &str) -> String {
    let bytes = s.as_bytes();
    if bytes.len() >= 2 && bytes.first() == Some(&b'"') && bytes.last() == Some(&b'"') {
        s[1..s.len() - 1].to_string()
    } else {
        s.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_quotes_removes_wrapping_double_quotes() {
        assert_eq!(strip_debug_quotes(r#""hello""#), "hello");
    }

    #[test]
    fn strip_quotes_leaves_unquoted_intact() {
        assert_eq!(strip_debug_quotes("hello"), "hello");
    }

    #[test]
    fn strip_quotes_leaves_single_quote_intact() {
        assert_eq!(strip_debug_quotes(r#""a""#), "a");
        assert_eq!(strip_debug_quotes(""), "");
        assert_eq!(strip_debug_quotes(r#"""#), r#"""#); // 单个引号，长度<2 不处理
    }

    #[test]
    fn truncate_keeps_short_message() {
        assert_eq!(truncate_message("short"), "short");
    }

    #[test]
    fn truncate_cuts_long_message_with_ellipsis() {
        let long = "x".repeat(250);
        let result = truncate_message(&long);
        assert_eq!(result.chars().count(), MAX_BODY_CHARS);
        assert!(result.ends_with("..."));
    }

    #[test]
    fn truncate_handles_multibyte_chars() {
        let long = "中".repeat(250);
        let result = truncate_message(&long);
        assert_eq!(result.chars().count(), MAX_BODY_CHARS);
        assert!(result.ends_with("..."));
    }

    #[test]
    fn acquire_slot_first_call_takes_slot() {
        let last = Mutex::new(None);
        let now = Instant::now();
        assert!(acquire_slot_at(&last, now, Duration::from_secs(10)));
        assert_eq!(*last.lock().unwrap(), Some(now));
    }

    #[test]
    fn acquire_slot_blocks_within_window() {
        let last = Mutex::new(None);
        let t0 = Instant::now();
        // 第一次占用
        assert!(acquire_slot_at(&last, t0, Duration::from_secs(10)));
        // 窗口内（+5s）第二次 → 抑制
        let t1 = t0 + Duration::from_secs(5);
        assert!(!acquire_slot_at(&last, t1, Duration::from_secs(10)));
        // last_notify 不变（仍为 t0）
        assert_eq!(*last.lock().unwrap(), Some(t0));
    }

    #[test]
    fn acquire_slot_allows_after_window_expires() {
        let last = Mutex::new(None);
        let t0 = Instant::now();
        assert!(acquire_slot_at(&last, t0, Duration::from_secs(10)));
        // 恰好 10s（>= threshold）→ 允许
        let t1 = t0 + Duration::from_secs(10);
        assert!(acquire_slot_at(&last, t1, Duration::from_secs(10)));
        // last_notify 更新为 t1
        assert_eq!(*last.lock().unwrap(), Some(t1));
    }
}
