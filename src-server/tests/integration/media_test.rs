//! Task 7：GET /media/:media_id（HMAC 签名 + Range 流式）。
//! 鉴权密钥取 `state.config.media.signing_key`——测试用 T3/T6 同款
//! 「改 config 后 create_app」模式注入；slug 用 unique() 隔离避免重复跑撞唯一约束。

use axum::http::StatusCode;
use axum_test::TestServer;
use std::sync::atomic::{AtomicU64, Ordering};

static COUNTER: AtomicU64 = AtomicU64::new(0);

fn unique(tag: &str) -> String {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    format!("t7_{}_{}_{}", tag, std::process::id(), n)
}

/// 注入 MEDIA__SIGNING_KEY 后建 app（同库同 Redis），返回 (server, state)。
/// SEC-2：许可根集 = 临时目录（fixture 的媒体文件都落在 temp 下；库外用 /etc/hosts
/// 做越界样本——真实存在且可读，方能证明"会读"而非"碰巧 404"）。
async fn media_fixture() -> (TestServer, llm_wiki_server::AppState) {
    crate::ensure_test_jwt_secret();
    let mut cfg = llm_wiki_server::AppConfig::from_env().unwrap();
    cfg.media.signing_key = "test_media_key_32bytes______________".to_string();
    cfg.media.allowed_roots = vec![std::env::temp_dir().to_string_lossy().to_string()];
    let (app, state) = llm_wiki_server::create_app(cfg).await.unwrap();
    let server = TestServer::new(app).unwrap();
    (server, state)
}

#[tokio::test]
async fn media_signing_and_range() {
    let (server, state) = media_fixture().await;
    let key = "test_media_key_32bytes______________";
    let slug = unique("s1");

    // 4096 字节真实临时 mp4 + 直插 media_assets 行（playback_path 为 NULL → 走 media_ref）
    let path = std::env::temp_dir().join(format!("m1_media_test_{}.mp4", std::process::id()));
    std::fs::write(&path, vec![0u8; 4096]).unwrap();
    sqlx::query(
        "INSERT INTO media_assets (slug, media_ref, duration_s, kind, chapters) \
         VALUES ($1,$2,10,'video','[]')",
    )
    .bind(&slug)
    .bind(path.to_str().unwrap())
    .execute(&state.db)
    .await
    .unwrap();

    let exp = chrono::Utc::now().timestamp() + 3600;
    let good = llm_wiki_server::utils::media_sign::sign_media(key, &slug, exp);

    // 无参 → 403
    server.get(&format!("/media/{slug}")).await.assert_status(StatusCode::FORBIDDEN);
    // 错签 → 403
    server
        .get(&format!("/media/{slug}?exp={exp}&sig=deadbeef"))
        .await
        .assert_status(StatusCode::FORBIDDEN);
    // 过期 → 403（exp 用过去时间 + 对应新签名，验证签名有效但已过期）
    let old_exp = chrono::Utc::now().timestamp() - 10;
    let old_sig = llm_wiki_server::utils::media_sign::sign_media(key, &slug, old_exp);
    server
        .get(&format!("/media/{slug}?exp={old_exp}&sig={old_sig}"))
        .await
        .assert_status(StatusCode::FORBIDDEN);
    // 未知 slug → 404
    let sig404 = llm_wiki_server::utils::media_sign::sign_media(key, "nope", exp);
    server
        .get(&format!("/media/nope?exp={exp}&sig={sig404}"))
        .await
        .assert_status(StatusCode::NOT_FOUND);
    // 全量 → 200
    let r = server
        .get(&format!("/media/{slug}?exp={exp}&sig={good}"))
        .await;
    r.assert_status(StatusCode::OK);
    assert_eq!(r.as_bytes().len(), 4096);
    // Range 0-1023 → 206 + body 1024
    let rr = server
        .get(&format!("/media/{slug}?exp={exp}&sig={good}"))
        .add_header("range", "bytes=0-1023")
        .await;
    rr.assert_status(StatusCode::PARTIAL_CONTENT);
    assert_eq!(rr.as_bytes().len(), 1024);
    // 越界 start → 416
    let r416 = server
        .get(&format!("/media/{slug}?exp={exp}&sig={good}"))
        .add_header("range", "bytes=99999-")
        .await;
    r416.assert_status(StatusCode::RANGE_NOT_SATISFIABLE);

    // Step 3 签名纵深：exp 距 now 超过 30 天 → 403（即使签名本身有效）
    let far = chrono::Utc::now().timestamp() + 30 * 86400 + 3600;
    let far_sig = llm_wiki_server::utils::media_sign::sign_media(key, &slug, far);
    server
        .get(&format!("/media/{slug}?exp={far}&sig={far_sig}"))
        .await
        .assert_status(StatusCode::FORBIDDEN);
    // 30 天内（贴上限 -1h，防边界抖动）→ 200
    let near = chrono::Utc::now().timestamp() + 30 * 86400 - 3600;
    let near_sig = llm_wiki_server::utils::media_sign::sign_media(key, &slug, near);
    let rn = server
        .get(&format!("/media/{slug}?exp={near}&sig={near_sig}"))
        .await;
    rn.assert_status(StatusCode::OK);

    // 清理 fixture（行 + 临时文件）
    let _ = sqlx::query("DELETE FROM media_assets WHERE slug = $1")
        .bind(&slug)
        .execute(&state.db)
        .await;
    let _ = std::fs::remove_file(&path);
    // 测试卫生：清理上一轮残留（cutoff 保护在飞测试，见 mod.rs）
    crate::teardown_test_data(&state).await;
}

/// SEC-2（终审必修）服务侧：COALESCE(playback_path, media_ref) 的 DB 值指向许可
/// 根集之外的**真实存在**文件（/etc/hosts）→ 有效签名也只能 404——修复前 200
/// 直开并回传文件内容（任意文件读实锚）。media_ref 与 playback_path 同标准：
/// playback_path 为 NULL 时走 media_ref，同样受根集约束。
#[tokio::test]
async fn media_serve_rejects_path_outside_allowed_roots() {
    let (server, state) = media_fixture().await;
    let key = "test_media_key_32bytes______________";

    // ① playback_path 越界：/etc/hosts 在 temp 根外且真实可读
    let slug_pb = unique("oob");
    sqlx::query(
        "INSERT INTO media_assets (slug, media_ref, playback_path, duration_s, kind, chapters) \
         VALUES ($1,$2,$3,10,'video','[]')",
    )
    .bind(&slug_pb)
    .bind("/tmp/never-opened.mov")
    .bind("/etc/hosts")
    .execute(&state.db)
    .await
    .unwrap();

    // ② media_ref 越界（playback NULL → COALESCE 落 media_ref）
    let slug_ref = unique("oob2");
    sqlx::query(
        "INSERT INTO media_assets (slug, media_ref, duration_s, kind, chapters) \
         VALUES ($1,$2,10,'video','[]')",
    )
    .bind(&slug_ref)
    .bind("/etc/hosts")
    .execute(&state.db)
    .await
    .unwrap();

    let exp = chrono::Utc::now().timestamp() + 3600;
    for slug in [&slug_pb, &slug_ref] {
        let sig = llm_wiki_server::utils::media_sign::sign_media(key, slug, exp);
        let r = server
            .get(&format!("/media/{slug}?exp={exp}&sig={sig}"))
            .await;
        assert_eq!(
            r.status_code(),
            StatusCode::NOT_FOUND,
            "{slug}: signed URL to out-of-root file must 404, got {} with body len {}",
            r.status_code(),
            r.as_bytes().len()
        );
        assert!(
            !r.text().contains("localhost"),
            "must not leak /etc/hosts content"
        );
    }

    // 清理
    for slug in [&slug_pb, &slug_ref] {
        let _ = sqlx::query("DELETE FROM media_assets WHERE slug = $1")
            .bind(slug)
            .execute(&state.db)
            .await;
    }
    crate::teardown_test_data(&state).await;
}
