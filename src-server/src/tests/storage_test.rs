use crate::services::storage::{LocalStorage, StorageBackend, FileEntry};

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
