use tauri::Manager;

/// 从 app-state.json 读取 error_notification 配置。
///
/// 复用 proxy.rs 的读取模式：直接读 tauri-plugin-store 写入的 JSON 文件。
/// 返回 None 时，调用方使用默认值（true = 开启通知）。
///
/// 【前提与风险】本项目前端通过 `load("app-state.json", ...)` 显式使用 `.json`
/// 扩展名，实测 plugin-store 2.4.x 将该文件存为纯明文 JSON（见设计文档技术验证 5）。
/// 风险：若未来 plugin-store 改用二进制格式，本函数静默返回 None（→默认开启），
/// 届时应迁移到 StoreExt API。
pub fn read_error_notification_config(app: &tauri::AppHandle) -> Option<bool> {
    let app_data_dir = app.path().app_data_dir().ok()?;
    let store_path = app_data_dir.join("app-state.json");
    let content = std::fs::read_to_string(&store_path).ok()?;
    let json: serde_json::Value = serde_json::from_str(&content).ok()?;
    let val = json.get("error_notification")?;
    val.as_bool()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 不依赖 AppHandle：直接测「给定 JSON 内容，能否正确提取 error_notification」。
    /// 把核心解析逻辑抽出为纯函数 parse_error_notification，便于单测。
    fn parse_error_notification(json_str: &str) -> Option<bool> {
        let json: serde_json::Value = serde_json::from_str(json_str).ok()?;
        json.get("error_notification")?.as_bool()
    }

    #[test]
    fn parses_true() {
        assert_eq!(parse_error_notification(r#"{"error_notification": true}"#), Some(true));
    }

    #[test]
    fn parses_false() {
        assert_eq!(
            parse_error_notification(r#"{"error_notification": false, "other": 1}"#),
            Some(false)
        );
    }

    #[test]
    fn missing_key_returns_none() {
        assert_eq!(parse_error_notification(r#"{"proxyConfig": {}}"#), None);
    }

    #[test]
    fn invalid_json_returns_none() {
        assert_eq!(parse_error_notification("not json"), None);
    }

    #[test]
    fn non_bool_value_returns_none() {
        assert_eq!(parse_error_notification(r#"{"error_notification": "yes"}"#), None);
    }
}
