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

/// 提取文件扩展名（小写）
pub fn file_ext(path: &Path) -> &str {
    path.extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
}

// ============================================================================
// Layer 6 Phase 1: StorageBackend trait + LocalStorage / S3Storage
// 逻辑坐标 (team_id, project_id, rel_path) 抽象,LocalStorage 内部复用上面的
// project_base / safe_resolve,行为与 routes/files.rs 现有直调一致。
// ============================================================================

use async_trait::async_trait;

/// 文件存储后端抽象。方法接收**逻辑坐标** (team_id, project_id, rel_path),
/// 对 Local(本地路径)和 S3(object key = teams/{tid}/projects/{pid}/{rel})都成立。
/// LocalStorage 内部负责 project_base + safe_resolve + base.exists 短路（写时 tokio::fs::create_dir_all 建父目录）。
#[async_trait]
pub trait StorageBackend: Send + Sync {
    async fn read_string(&self, team_id: i32, project_id: i32, rel_path: &str) -> Result<String, AppError>;
    async fn read_bytes(&self, team_id: i32, project_id: i32, rel_path: &str) -> Result<Vec<u8>, AppError>;
    async fn write_string(&self, team_id: i32, project_id: i32, rel_path: &str, data: &str) -> Result<(), AppError>;
    async fn write_bytes(&self, team_id: i32, project_id: i32, rel_path: &str, data: &[u8]) -> Result<(), AppError>;
    async fn list_dir(&self, team_id: i32, project_id: i32, dir_rel: &str) -> Result<Vec<FileEntry>, AppError>;
    /// 文件/目录不存在 → Err（调用方按需映射 exists:false 或 404；不在此软失败）
    async fn metadata(&self, team_id: i32, project_id: i32, rel_path: &str) -> Result<FileMeta, AppError>;
    /// 目标不存在 → ResourceNotFound（对齐 delete_file 的 404，调用方无需前置 exists 检查）；
    /// 其它 IO 错误（权限等）→ IoError(500)
    async fn remove(&self, team_id: i32, project_id: i32, rel_path: &str) -> Result<(), AppError>;
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: i64,
}

#[derive(Debug, Clone)]
pub struct FileMeta {
    pub is_dir: bool,
    pub size: u64,
    pub modified: i64,
}

fn modified_secs(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub struct LocalStorage {
    root: String,
}

impl LocalStorage {
    pub fn new(root: String) -> Self {
        Self { root }
    }

    fn base(&self, team_id: i32, project_id: i32) -> PathBuf {
        project_base(&self.root, team_id, project_id)
    }

    /// 解析项目内已存在路径：项目 base 不存在 → ResourceNotFound；否则 safe_resolve 防穿越。
    /// read_string/read_bytes/metadata/remove 共用，收拢 base.exists 守卫（DRY）。
    fn resolve_existing(&self, team_id: i32, project_id: i32, rel_path: &str) -> Result<PathBuf, AppError> {
        let base = self.base(team_id, project_id);
        if !base.exists() {
            return Err(AppError::ResourceNotFound("project storage not found".into()));
        }
        safe_resolve(&base, rel_path)
    }
}

#[async_trait]
impl StorageBackend for LocalStorage {
    /// 读取文本文件。文件不存在 → ResourceNotFound（对齐 read_file 的 404）；其它 IO 错误 → IoError(500)。
    async fn read_string(&self, team_id: i32, project_id: i32, rel_path: &str) -> Result<String, AppError> {
        let p = self.resolve_existing(team_id, project_id, rel_path)?;
        tokio::fs::read_to_string(&p).await.map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => AppError::ResourceNotFound("file not found".into()),
            _ => AppError::IoError(e),
        })
    }

    /// 读取二进制文件。文件不存在 → ResourceNotFound（对齐 raw_file 的 404）；其它 IO 错误 → IoError(500)。
    async fn read_bytes(&self, team_id: i32, project_id: i32, rel_path: &str) -> Result<Vec<u8>, AppError> {
        let p = self.resolve_existing(team_id, project_id, rel_path)?;
        tokio::fs::read(&p).await.map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => AppError::ResourceNotFound("file not found".into()),
            _ => AppError::IoError(e),
        })
    }

    async fn write_string(&self, team_id: i32, project_id: i32, rel_path: &str, data: &str) -> Result<(), AppError> {
        self.write_bytes(team_id, project_id, rel_path, data.as_bytes()).await
    }

    async fn write_bytes(&self, team_id: i32, project_id: i32, rel_path: &str, data: &[u8]) -> Result<(), AppError> {
        // F1: 显式拒绝 `..` —— 必须在创建父目录之前，否则穿越路径会先在 base 外创建目录
        // （原 write_file 前置 `..` 守卫随抽象下沉，此处恢复 fail-closed-before-IO 不变量）。
        if rel_path.split('/').any(|c| c == "..") {
            return Err(AppError::BadRequest("Path traversal detected".into()));
        }
        let base = self.base(team_id, project_id);
        // F5: tokio::fs 异步建父目录（消除 async 内 std::fs 阻塞）；深层新路径仍可正确 canonicalize
        let target = base.join(rel_path.trim_start_matches('/'));
        if let Some(parent) = target.parent() {
            tokio::fs::create_dir_all(parent).await.map_err(AppError::IoError)?;
        }
        let p = safe_resolve(&base, rel_path)?;
        tokio::fs::write(&p, data).await.map_err(AppError::IoError)
    }

    async fn list_dir(&self, team_id: i32, project_id: i32, dir_rel: &str) -> Result<Vec<FileEntry>, AppError> {
        let base = self.base(team_id, project_id);
        if !base.exists() {
            return Ok(Vec::new());
        }
        let dir = if dir_rel.trim_matches('/').is_empty() {
            base.clone()
        } else {
            safe_resolve(&base, dir_rel)?
        };
        if !dir.exists() {
            return Ok(Vec::new());
        }
        let mut out = Vec::new();
        let mut entries = tokio::fs::read_dir(&dir).await.map_err(AppError::IoError)?;
        while let Some(entry) = entries.next_entry().await.map_err(AppError::IoError)? {
            let meta = entry.metadata().await.map_err(AppError::IoError)?;
            let path = entry.path().strip_prefix(&base).unwrap_or(&entry.path()).to_string_lossy().to_string();
            out.push(FileEntry {
                name: entry.file_name().to_string_lossy().to_string(),
                path,
                is_dir: meta.is_dir(),
                size: meta.len(),
                modified: modified_secs(&meta),
            });
        }
        Ok(out)
    }

    async fn metadata(&self, team_id: i32, project_id: i32, rel_path: &str) -> Result<FileMeta, AppError> {
        let p = self.resolve_existing(team_id, project_id, rel_path)?;
        let meta = tokio::fs::metadata(&p).await.map_err(AppError::IoError)?;
        Ok(FileMeta {
            is_dir: meta.is_dir(),
            size: meta.len(),
            modified: modified_secs(&meta),
        })
    }

    async fn remove(&self, team_id: i32, project_id: i32, rel_path: &str) -> Result<(), AppError> {
        let p = self.resolve_existing(team_id, project_id, rel_path)?;
        // 区分「不存在」(→ResourceNotFound/404) 与「其它 IO 错误如权限」(→IoError/500)，
        // 调用方无需前置 exists 检查（兼修 delete_file 双 stat + 权限被掩盖为 404）。
        let meta = match tokio::fs::metadata(&p).await {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Err(AppError::ResourceNotFound("file not found".into()));
            }
            Err(e) => return Err(AppError::IoError(e)),
        };
        if meta.is_dir() {
            tokio::fs::remove_dir_all(&p).await.map_err(AppError::IoError)
        } else {
            tokio::fs::remove_file(&p).await.map_err(AppError::IoError)
        }
    }
}

/// S3 / 对象存储实现 —— 占位。Phase 1 不实现真实 S3 调用(不引入 S3 SDK 依赖)。
/// 逻辑坐标 (team_id, project_id, rel_path) 可直接映射为 object key
/// teams/{team_id}/projects/{project_id}/{rel_path},故未来实现时 trait 签名无需改动。
pub struct S3Storage {
    #[allow(dead_code)]
    endpoint: Option<String>,
    #[allow(dead_code)]
    bucket: Option<String>,
}

impl S3Storage {
    pub fn new(endpoint: Option<String>, bucket: Option<String>) -> Self {
        Self { endpoint, bucket }
    }
}

#[async_trait]
impl StorageBackend for S3Storage {
    async fn read_string(&self, _t: i32, _p: i32, _r: &str) -> Result<String, AppError> {
        Err(AppError::NotImplemented("s3 storage not yet implemented".into()))
    }
    async fn read_bytes(&self, _t: i32, _p: i32, _r: &str) -> Result<Vec<u8>, AppError> {
        Err(AppError::NotImplemented("s3 storage not yet implemented".into()))
    }
    async fn write_string(&self, _t: i32, _p: i32, _r: &str, _d: &str) -> Result<(), AppError> {
        Err(AppError::NotImplemented("s3 storage not yet implemented".into()))
    }
    async fn write_bytes(&self, _t: i32, _p: i32, _r: &str, _d: &[u8]) -> Result<(), AppError> {
        Err(AppError::NotImplemented("s3 storage not yet implemented".into()))
    }
    async fn list_dir(&self, _t: i32, _p: i32, _r: &str) -> Result<Vec<FileEntry>, AppError> {
        Err(AppError::NotImplemented("s3 storage not yet implemented".into()))
    }
    async fn metadata(&self, _t: i32, _p: i32, _r: &str) -> Result<FileMeta, AppError> {
        Err(AppError::NotImplemented("s3 storage not yet implemented".into()))
    }
    async fn remove(&self, _t: i32, _p: i32, _r: &str) -> Result<(), AppError> {
        Err(AppError::NotImplemented("s3 storage not yet implemented".into()))
    }
}
