/// files list 端点集成测试。
///
/// 核心:全新项目(storage base 尚未落盘)list 子目录 → 200 + [](非 500)。
/// 回归:list_files 曾缺 base.exists() 前置守卫,safe_resolve 对不存在的 base 做
/// canonicalize → InternalError 500(与 stat_file/raw_file 同款问题,二者已有守卫,
/// list_files 漏了)。复用 files_raw_test.rs / files_stat_test.rs 的 setup 模式。
///
/// 注册:tests/integration/mod.rs 加 `pub mod files_list_test;`。
/// 运行:`cargo test --test integration files_list`(src-server 内,连 live DB 5433 + Redis 6380)。
use axum::http::StatusCode;
use std::sync::atomic::{AtomicU64, Ordering};

/// 全局单调计数器,保证同进程并发测试 username 绝对唯一
/// (照 files_raw_test.rs / files_stat_test.rs 的唯一化模式)。
static COUNTER: AtomicU64 = AtomicU64::new(0);

/// 复用 files_raw_test.rs 的 setup 模式:register → 查 team_id → POST /projects。
/// 返回 (server, state, pid, token);全新项目不落盘,storage base 不存在。
async fn setup() -> (
    axum_test::TestServer,
    llm_wiki_server::AppState,
    i32,
    String,
) {
    let (app, state) = crate::setup_test_app().await;
    let server = axum_test::TestServer::new(app).unwrap();
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let username = format!("flist_{}_{}", std::process::id(), n);
    let token = crate::register_user(
        &server,
        &username,
        &format!("{}@t.com", username),
        "password123",
    )
    .await;

    // register 已建 personal team,查出 team_id
    let team_id: i32 = sqlx::query_scalar(
        "SELECT id FROM teams WHERE created_by = (SELECT id FROM users WHERE username = $1)",
    )
    .bind(&username)
    .fetch_one(&state.db)
    .await
    .unwrap();

    // 建 project(全新,未落盘任何文件)
    let resp = server
        .post("/api/v1/projects")
        .add_header("authorization", format!("Bearer {}", token))
        .json(&serde_json::json!({"name": format!("flist-proj-{}-{}", std::process::id(), n), "team_id": team_id}))
        .await;
    assert_eq!(resp.status_code(), StatusCode::CREATED);
    let pid = resp.json::<serde_json::Value>()["id"].as_i64().unwrap() as i32;
    (server, state, pid, token)
}

/// 查 project 的 team_id(用于定位真实存储根落盘 fixture)。
async fn team_id_of(state: &llm_wiki_server::AppState, pid: i32) -> i32 {
    sqlx::query_scalar("SELECT team_id FROM projects WHERE id = $1")
        .bind(pid)
        .fetch_one(&state.db)
        .await
        .unwrap()
}

/// 全新项目(storage base 尚未落盘)list 子目录 /raw/sources → 200 + []。
/// 回归保护:修复前返回 500(safe_resolve 对不存在 base canonicalize 失败)。
#[tokio::test]
async fn list_files_empty_for_fresh_project_subdir() {
    let (server, _state, pid, token) = setup().await;
    let r = server
        .get(&format!("/api/v1/files/{}/list?dir=/raw/sources", pid))
        .add_header("authorization", format!("Bearer {}", token))
        .await;
    assert_eq!(
        r.status_code(),
        StatusCode::OK,
        "fresh project subdir list must not 500"
    );
    assert_eq!(r.json::<serde_json::Value>(), serde_json::json!([]));
}

/// 全新项目 list 根(无 dir)→ 200 + [](根路径走 base.clone() 不经 safe_resolve,
/// 修复前本就 200;此处防回归)。
#[tokio::test]
async fn list_files_empty_for_fresh_project_root() {
    let (server, _state, pid, token) = setup().await;
    let r = server
        .get(&format!("/api/v1/files/{}/list", pid))
        .add_header("authorization", format!("Bearer {}", token))
        .await;
    assert_eq!(r.status_code(), StatusCode::OK);
    assert_eq!(r.json::<serde_json::Value>(), serde_json::json!([]));
}

/// 落盘后 list 子目录 → 返回已写文件(验证 base.exists() 守卫未误伤正常 list 路径)。
#[tokio::test]
async fn list_files_lists_written_files_after_base_exists() {
    let (server, state, pid, token) = setup().await;
    // 直接落盘而非走 POST /files:全新项目 storage base 尚不存在时,
    // POST /files 的 safe_resolve 同样会 500(pre-existing,见 files_raw_test.rs 同款注释)。
    let base = std::path::PathBuf::from(state.config.storage_path())
        .join("teams")
        .join(team_id_of(&state, pid).await.to_string())
        .join("projects")
        .join(pid.to_string());
    std::fs::create_dir_all(base.join("wiki")).unwrap();
    std::fs::write(base.join("wiki/a.md"), "# A").unwrap();

    let r = server
        .get(&format!("/api/v1/files/{}/list?dir=/wiki", pid))
        .add_header("authorization", format!("Bearer {}", token))
        .await;
    assert_eq!(r.status_code(), StatusCode::OK);
    let nodes = r.json::<serde_json::Value>();
    assert!(
        nodes
            .as_array()
            .unwrap()
            .iter()
            .any(|n| n["name"] == "a.md"),
        "must list written file after base exists: {:?}",
        nodes
    );
}
