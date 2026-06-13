use std::path::{Path, PathBuf};
use crate::AppError;

/// 解析项目存储基路径
/// 格式: {storage_path}/teams/{team_id}/projects/{project_id}
pub fn project_base(storage_path: &str, team_id: i32, project_id: i32) -> PathBuf {
    PathBuf::from(storage_path)
        .join("teams")
        .join(team_id.to_string())
        .join("projects")
        .join(project_id.to_string())
}

/// 安全地将用户请求的路径约束在项目基路径内。
/// 1. 将 user_path 拼接到 base 后得到完整路径 P。
/// 2. canonicalize(P) — 解析所有 ../ 和符号链接。
/// 3. 验证 canonicalized 路径以 base 开头。
///
/// 返回完全解析后的 PathBuf。
pub fn safe_resolve(
    base: &Path,
    user_path: &str,
) -> Result<PathBuf, AppError> {
    let candidate = base.join(user_path.trim_start_matches('/'));

    // 如果文件不存在，先对父目录做 canonicalize 再做检查
    let resolved = if candidate.exists() {
        candidate.canonicalize().map_err(|e| AppError::BadRequest(
            format!("Invalid path: {}", e)
        ))
    } else {
        // 对于写操作，文件可能还不存在 — 只规范化可解析的部分
        let parent = candidate.parent().unwrap_or(base);
        let parent_canon = parent.canonicalize()
            .map_err(|e| AppError::InternalError(
                format!("Failed to resolve parent path: {}", e)
            ))?;
        Ok(parent_canon.join(candidate.file_name().unwrap_or_default()))
    }?;

    // canonicalize 必须保留 base 前缀
    if !resolved.starts_with(base.canonicalize()
        .map_err(|e| AppError::InternalError(format!("Failed to resolve base: {}", e)))?)
    {
        return Err(AppError::BadRequest(
            "Path traversal detected".to_string()
        ));
    }

    Ok(resolved)
}

/// 确保目录存在
pub fn ensure_dir(path: &Path) -> Result<(), AppError> {
    std::fs::create_dir_all(path)
        .map_err(|e| AppError::IoError(e))
}

/// 提取文件扩展名（小写）
pub fn file_ext(path: &Path) -> &str {
    path.extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
}
