/// files 端点对全新项目(storage base 未落盘)的统一行为集成测试。
///
/// 回归:读端点(list/stat/raw/read)对不存在 base 的 safe_resolve 会 canonicalize 失败 → 500;
/// 写端点(upload/write)同理 500(阻断 web 摄取第一次上传)。修复:读端点加 base.exists()
/// 短路(返回空/404),写端点加 ensure_dir(&base)(创建目录)。delete 同读端点返回 404。
///
/// 每个 #[tokio::test] 独立 setup()(各自新 project),隔离 base 是否已创建的状态。
///
/// 运行:`cargo test --test integration files_fresh`(src-server 内,连 live DB 5433 + Redis 6380)。
use axum::http::StatusCode;
use axum_test::multipart::{MultipartForm, Part};
use std::sync::atomic::{AtomicU64, Ordering};

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// 复用 files_list_test.rs / files_raw_test.rs 的 setup 模式:register → 查 team_id → POST /projects。
/// 全新项目不落盘,storage base 不存在。返回 (server, pid, token)。
async fn setup() -> (axum_test::TestServer, i32, String) {
    let (app, state) = crate::setup_test_app().await;
    let server = axum_test::TestServer::new(app).unwrap();
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let username = format!("ffre_{}_{}", std::process::id(), n);
    let token = crate::register_user(
        &server,
        &username,
        &format!("{}@t.com", username),
        "password123",
    )
    .await;
    let team_id: i32 = sqlx::query_scalar(
        "SELECT id FROM teams WHERE created_by = (SELECT id FROM users WHERE username = $1)",
    )
    .bind(&username)
    .fetch_one(&state.db)
    .await
    .unwrap();
    let resp = server
        .post("/api/v1/projects")
        .add_header("authorization", format!("Bearer {}", token))
        .json(&serde_json::json!({"name": format!("ffre-proj-{}-{}", std::process::id(), n), "team_id": team_id}))
        .await;
    assert_eq!(resp.status_code(), StatusCode::CREATED);
    let pid = resp.json::<serde_json::Value>()["id"].as_i64().unwrap() as i32;
    (server, pid, token)
}

/// 全新项目 read 不存在文件 → 404(非 500)。
/// 回归:read_file 缺 base.exists() 守卫时,前端打开项目读 .llm-wiki/*.json 全 500。
#[tokio::test]
async fn read_returns_404_for_fresh_project() {
    let (server, pid, token) = setup().await;
    let r = server
        .get(&format!("/api/v1/files/{}/read?path=/.llm-wiki/ingest-queue.json", pid))
        .add_header("authorization", format!("Bearer {}", token))
        .await;
    assert_eq!(
        r.status_code(),
        StatusCode::NOT_FOUND,
        "fresh project read must not 500"
    );
}

/// 全新项目 write → 200(ensure_dir 创建 base 后写入,非 500)。
#[tokio::test]
async fn write_creates_base_for_fresh_project() {
    let (server, pid, token) = setup().await;
    let r = server
        .post(&format!("/api/v1/files/{}/write", pid))
        .add_header("authorization", format!("Bearer {}", token))
        .json(&serde_json::json!({"path": ".llm-wiki/test.json", "contents": "{}"}))
        .await;
    assert_eq!(
        r.status_code(),
        StatusCode::OK,
        "fresh project write must create base, not 500"
    );
}

/// 全新项目 upload(multipart)→ 201(P0:web 摄取第一次上传依赖此路径,非 500)。
#[tokio::test]
async fn upload_creates_base_for_fresh_project() {
    let (server, pid, token) = setup().await;
    let form = MultipartForm::new()
        .add_text("path", "raw/sources")
        .add_part(
            "file",
            Part::bytes(b"# hello".to_vec())
                .file_name("test.md")
                .mime_type("text/markdown"),
        );
    let r = server
        .post(&format!("/api/v1/files/{}/upload", pid))
        .add_header("authorization", format!("Bearer {}", token))
        .multipart(form)
        .await;
    assert_eq!(
        r.status_code(),
        StatusCode::CREATED,
        "fresh project upload must create base, not 500"
    );
    let body = r.json::<serde_json::Value>();
    assert_eq!(body["name"], "test.md");
}

/// 全新项目 delete → 404(非 500)。delete 用 body {path}(非 URL *path)。
#[tokio::test]
async fn delete_returns_404_for_fresh_project() {
    let (server, pid, token) = setup().await;
    let r = server
        .delete(&format!("/api/v1/files/{}/delete", pid))
        .add_header("authorization", format!("Bearer {}", token))
        .json(&serde_json::json!({"path": "wiki/none.md"}))
        .await;
    assert_eq!(
        r.status_code(),
        StatusCode::NOT_FOUND,
        "fresh project delete must not 500"
    );
}

/// write 文件 → delete 同 path(body)→ 200 "deleted"(验证 delete 用 body path,非 URL *path)。
#[tokio::test]
async fn delete_succeeds_via_body_path() {
    let (server, pid, token) = setup().await;
    let w = server
        .post(&format!("/api/v1/files/{}/write", pid))
        .add_header("authorization", format!("Bearer {}", token))
        .json(&serde_json::json!({"path": "wiki/del.md", "contents": "x"}))
        .await;
    assert_eq!(w.status_code(), StatusCode::OK);
    let r = server
        .delete(&format!("/api/v1/files/{}/delete", pid))
        .add_header("authorization", format!("Bearer {}", token))
        .json(&serde_json::json!({"path": "wiki/del.md"}))
        .await;
    assert_eq!(r.status_code(), StatusCode::OK, "delete via body path");
    assert_eq!(r.json::<serde_json::Value>()["status"], "deleted");
}

/// write 到 payload path(深层 .llm-wiki/sub/test.md)→ read 同 path(query)→ 200 + 内容。
/// 验证 read/write 都用 body/query path(非 URL *path):早期 write 写到 base/write、
/// read 读 base/read(query path 被忽略),web fs 读写全错位。
#[tokio::test]
async fn read_returns_content_after_write_to_payload_path() {
    let (server, pid, token) = setup().await;
    let w = server
        .post(&format!("/api/v1/files/{}/write", pid))
        .add_header("authorization", format!("Bearer {}", token))
        .json(&serde_json::json!({"path": ".llm-wiki/sub/test.md", "contents": "# Hello Wiki"}))
        .await;
    assert_eq!(w.status_code(), StatusCode::OK, "write to deep payload path");

    let r = server
        .get(&format!("/api/v1/files/{}/read?path=.llm-wiki/sub/test.md", pid))
        .add_header("authorization", format!("Bearer {}", token))
        .await;
    assert_eq!(
        r.status_code(),
        StatusCode::OK,
        "read must find written file via query path"
    );
    let body = r.json::<serde_json::Value>();
    assert_eq!(body["content"], "# Hello Wiki", "read content via query path: {:?}", body);
}
