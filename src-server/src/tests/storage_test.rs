use crate::services::storage::{LocalStorage, StorageBackend, FileEntry};
use crate::AppError;

fn tmp_store() -> (tempfile::TempDir, LocalStorage) {
    let tmp = tempfile::tempdir().unwrap();
    let store = LocalStorage::new(tmp.path().to_string_lossy().to_string());
    (tmp, store)
}

#[tokio::test]
async fn local_storage_write_read_remove() {
    let (_tmp, store) = tmp_store();
    store.write_string(1, 1, "raw/sources/a.txt", "hello").await.unwrap();
    assert_eq!(store.read_string(1, 1, "raw/sources/a.txt").await.unwrap(), "hello");
    let meta = store.metadata(1, 1, "raw/sources/a.txt").await.unwrap();
    assert!(!meta.is_dir && meta.size == 5 && meta.modified > 0);
    store.remove(1, 1, "raw/sources/a.txt").await.unwrap();
    assert!(store.read_string(1, 1, "raw/sources/a.txt").await.is_err());
}

#[tokio::test]
async fn local_storage_list_dir_fields_complete() {
    let (_tmp, store) = tmp_store();
    store.write_string(1, 1, "d/x.txt", "x").await.unwrap();
    let entries: Vec<FileEntry> = store.list_dir(1, 1, "d").await.unwrap();
    assert_eq!(entries.len(), 1);
    let e = &entries[0];
    // 验证全部 5 字段都填了（防 FileEntry 字段缺失回归）
    assert_eq!(e.name, "x.txt");
    assert!(e.path.ends_with("x.txt"));
    assert!(!e.is_dir);
    assert_eq!(e.size, 1);
    assert!(e.modified > 0);
}

#[tokio::test]
async fn local_storage_missing_project_returns_err_or_empty() {
    let (_tmp, store) = tmp_store();
    // 项目目录不存在：list 返空，read/stat/remove 返 Err（handler 映射 exists:false/404）
    assert!(store.list_dir(1, 999, "").await.unwrap().is_empty());
    assert!(store.read_string(1, 999, "x").await.is_err());
    assert!(store.metadata(1, 999, "x").await.is_err());
}

#[tokio::test]
async fn local_storage_traversal_blocked() {
    let (_tmp, store) = tmp_store();
    store.write_string(1, 1, "real.txt", "x").await.unwrap();
    // 正常路径 OK
    assert!(store.read_string(1, 1, "real.txt").await.is_ok());
    // 穿越 ../../etc/passwd 由 LocalStorage 内部 safe_resolve 拒绝
    assert!(store.read_string(1, 1, "../../etc/passwd").await.is_err());
}

#[tokio::test]
async fn local_storage_traversal_rejected_before_io() {
    // review F1：`..` 必须在任何 IO 之前被拒（恢复 fail-closed 不变量；修复沙箱逃逸——
    // 原 write_bytes 在 safe_resolve 前 ensure_dir，会先在 base 外创建目录）。
    let (tmp, store) = tmp_store();
    let err = store.write_string(1, 1, "../../escape_evil/x.txt", "y").await;
    assert!(err.is_err(), "含 `..` 的路径必须被拒绝");
    // 关键断言：guard 在 ensure_dir 之前，故连 teams/ 树都不得被创建
    assert!(
        !tmp.path().join("teams").exists(),
        "穿越路径不得触发任何目录创建（原 bug：ensure_dir 先于 safe_resolve 执行）"
    );
}

#[tokio::test]
async fn local_storage_remove_missing_returns_not_found() {
    // review F4：remove 缺失目标 → ResourceNotFound（对齐 delete_file 404），非 IoError(500)
    let (_tmp, store) = tmp_store();
    store.write_string(1, 1, "real.txt", "x").await.unwrap();
    let err = store.remove(1, 1, "nope.txt").await.unwrap_err();
    assert!(
        matches!(err, AppError::ResourceNotFound(_)),
        "missing target → ResourceNotFound, got {:?}", err
    );
}

#[tokio::test]
async fn local_storage_write_creates_deep_dirs() {
    // review #5：tokio::fs::create_dir_all 对多层缺失中间目录（深层新路径）生效
    let (_tmp, store) = tmp_store();
    store
        .write_string(1, 1, "raw/sources/nested/deep/note.md", "deep")
        .await
        .unwrap();
    assert_eq!(
        store
            .read_string(1, 1, "raw/sources/nested/deep/note.md")
            .await
            .unwrap(),
        "deep"
    );
}

#[tokio::test]
async fn s3_storage_returns_not_implemented_501() {
    // review F3：S3 占位返回 NotImplemented（→HTTP 501），而非 InternalError(500)
    use axum::response::IntoResponse;
    let s3 = crate::services::storage::S3Storage::new(None, None);
    let err = s3.read_string(1, 1, "x").await.unwrap_err();
    assert!(
        matches!(err, AppError::NotImplemented(_)),
        "S3 占位 → NotImplemented, got {:?}", err
    );
    // 验证 HTTP 映射 501
    let resp = AppError::NotImplemented("s3".into()).into_response();
    assert_eq!(resp.status(), axum::http::StatusCode::NOT_IMPLEMENTED);
}
