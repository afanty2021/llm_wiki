use std::path::Path;
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

/// 合法日志级别校验
pub fn is_valid_level(level: &str) -> bool {
    matches!(level, "DEBUG" | "INFO" | "WARN" | "ERROR")
}

/// 从 app-state.json 读取 log_level 配置。
/// 返回 None 时调用方使用默认 "WARN"。
pub fn read_log_level(app_data_dir: &Path) -> Option<String> {
    let store_path = app_data_dir.join("app-state.json");
    let content = std::fs::read_to_string(&store_path).ok()?;
    let json: serde_json::Value = serde_json::from_str(&content).ok()?;
    let level = json.get("log_level")?.as_str()?.to_string();
    if is_valid_level(&level) { Some(level) } else { None }
}

/// 写入 log_level 到 app-state.json（读-改-写，保留其他键）。
pub fn write_log_level(app_data_dir: &Path, level: &str) -> Result<(), String> {
    if !is_valid_level(level) {
        return Err(format!("Invalid log level: {}", level));
    }
    let store_path = app_data_dir.join("app-state.json");
    let mut json: serde_json::Value = std::fs::read_to_string(&store_path)
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    if let Some(obj) = json.as_object_mut() {
        obj.insert("log_level".to_string(), serde_json::Value::String(level.to_string()));
    } else {
        // 现有内容不是 JSON object（异常）→ 用新对象覆盖
        json = serde_json::json!({ "log_level": level });
    }
    let serialized = serde_json::to_string_pretty(&json)
        .map_err(|e| format!("Failed to serialize app-state.json: {}", e))?;
    std::fs::write(&store_path, serialized)
        .map_err(|e| format!("Failed to write app-state.json: {}", e))?;
    Ok(())
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

    // ========================================================================
    // log_level 读写测试
    // ========================================================================

    fn parse_log_level(json_str: &str) -> Option<String> {
        let json: serde_json::Value = serde_json::from_str(json_str).ok()?;
        let level = json.get("log_level")?.as_str()?.to_string();
        if matches!(level.as_str(), "DEBUG" | "INFO" | "WARN" | "ERROR") { Some(level) } else { None }
    }

    #[test]
    fn parses_log_level_info() {
        assert_eq!(parse_log_level(r#"{"log_level": "INFO"}"#), Some("INFO".into()));
    }

    #[test]
    fn missing_log_level_returns_none() {
        assert_eq!(parse_log_level(r#"{"other": 1}"#), None);
    }

    #[test]
    fn invalid_log_level_value_returns_none() {
        assert_eq!(parse_log_level(r#"{"log_level": "TRACE"}"#), None); // TRACE not supported
    }

    #[test]
    fn write_then_read_log_level_roundtrip() {
        let dir = tempfile::TempDir::new().unwrap();
        // 文件不存在 → write 创建
        write_log_level(dir.path(), "DEBUG").unwrap();
        assert_eq!(read_log_level(dir.path()), Some("DEBUG".into()));
    }

    #[test]
    fn write_log_level_preserves_other_keys() {
        let dir = tempfile::TempDir::new().unwrap();
        let store_path = dir.path().join("app-state.json");
        std::fs::write(&store_path, r#"{"error_notification": true, "proxyConfig": {"x":1}}"#).unwrap();
        write_log_level(dir.path(), "INFO").unwrap();
        // 读回验证 log_level 写入且其他键保留
        let content = std::fs::read_to_string(&store_path).unwrap();
        let json: serde_json::Value = serde_json::from_str(&content).unwrap();
        assert_eq!(json["log_level"], "INFO");
        assert_eq!(json["error_notification"], true);
        assert_eq!(json["proxyConfig"]["x"], 1);
    }

    #[test]
    fn write_log_level_rejects_invalid() {
        let dir = tempfile::TempDir::new().unwrap();
        let res = write_log_level(dir.path(), "TRACE");
        assert!(res.is_err());
    }
}
