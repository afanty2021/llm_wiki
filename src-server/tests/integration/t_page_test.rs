//! Task 9：/t/ 落地页三端点（GET /t/:token、POST seen、POST complete）+ /media fp 签名。
//! 矩阵（brief Step 1）：错 typ（access token）403、过期 403（友好页不泄漏原因）、
//! plan 不存在/不归属 404、HTML 含 plan 标题与 items、XSS 敌意 fixture 不出原样标签、
//! seen 空 body 无 content-type → 200 页面级事件（Option 提取器）、view 事件落库且
//! 不改投影、seen 页面级/项级、complete 伪造 item_id 400、/media 带 fp 签名 206 +
//! 旧两段式兼容 206。
//! fixture 模式：training 段 + media 签名键经「改 config 后 create_app」注入
//! （learning_api_test / media_test 同款）；slug/用户名 unique() 隔离。

use axum::http::StatusCode;
use axum_test::TestServer;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicU64, Ordering};

static COUNTER: AtomicU64 = AtomicU64::new(0);

fn unique(tag: &str) -> String {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    format!("t9_{}_{}_{}", tag, std::process::id(), n)
}

fn bearer(token: &str) -> String {
    format!("Bearer {}", token)
}

const MEDIA_KEY: &str = "test_media_key_32bytes______________";

/// 注入 training 段 + media 签名键后建 app（同库同 Redis）。
async fn t_fixture(tag: &str) -> (TestServer, llm_wiki_server::AppState) {
    let (app1, _state1) = crate::setup_test_app().await;
    let s1 = TestServer::new(app1).unwrap();

    let owner_name = unique(tag);
    let owner = crate::register_user(
        &s1,
        &owner_name,
        &format!("{}@t9.com", owner_name),
        "secret123",
    )
    .await;
    let team = s1
        .post("/api/v1/teams")
        .add_header("authorization", bearer(&owner))
        .json(&json!({"name": format!("LT测试team_{}", owner_name)}))
        .await;
    assert_eq!(team.status_code(), StatusCode::CREATED);
    let team_id = team.json::<serde_json::Value>()["id"].as_i64().unwrap();
    let proj = s1
        .post("/api/v1/projects")
        .add_header("authorization", bearer(&owner))
        .json(&json!({"name": format!("LT项目_{}", owner_name), "team_id": team_id}))
        .await;
    assert_eq!(proj.status_code(), StatusCode::CREATED);
    let project_id = proj.json::<serde_json::Value>()["id"].as_i64().unwrap() as i32;

    crate::ensure_test_jwt_secret();
    let mut cfg = llm_wiki_server::AppConfig::from_env().unwrap();
    cfg.training.project_id = Some(project_id);
    cfg.training.admin_token = "tok123".to_string();
    cfg.media.signing_key = MEDIA_KEY.to_string();
    let (app2, state) = llm_wiki_server::create_app(cfg).await.unwrap();
    (TestServer::new(app2).unwrap(), state)
}

/// bind 一名教师，返回 (access_token, user_id)。
async fn bind_teacher(server: &TestServer, wid: &str) -> (String, i64) {
    let r = server
        .post("/api/v1/training/bind")
        .add_header("x-training-admin-token", "tok123")
        .json(&json!({"wecom_userid": wid, "display_name": "测试教师"}))
        .await;
    assert_eq!(r.status_code(), StatusCode::OK);
    let v = r.json::<serde_json::Value>();
    (
        v["access_token"].as_str().unwrap().to_string(),
        v["user"]["id"].as_i64().unwrap(),
    )
}

/// 播种 wiki 页（training 项目下，可带敌意 content/sources）。
async fn seed_wiki_page(
    state: &llm_wiki_server::AppState,
    path: &str,
    title: &str,
    content: &str,
    sources: serde_json::Value,
) {
    let pid = state.config.training.project_id.unwrap();
    sqlx::query(
        "INSERT INTO wiki_pages (project_id, path, title, content, page_type, sources) \
         VALUES ($1, $2, $3, $4, 'concept', $5)",
    )
    .bind(pid)
    .bind(path)
    .bind(title)
    .bind(content)
    .bind(sources)
    .execute(&state.db)
    .await
    .unwrap();
}

/// 播种 media_assets（playback 指向真实临时文件；chapters 可带敌意 label）。
async fn seed_media_asset(
    state: &llm_wiki_server::AppState,
    slug: &str,
    chapters: serde_json::Value,
    transcript_page_path: Option<&str>,
    source_path: Option<&str>,
) -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!("t9_media_{}_{}.mp4", slug, std::process::id()));
    std::fs::write(&path, vec![7u8; 2048]).unwrap();
    sqlx::query(
        "INSERT INTO media_assets (slug, media_ref, playback_path, duration_s, kind, chapters, transcript_page_path, source_path) \
         VALUES ($1, $2, $3, 600, 'video', $4, $5, $6)",
    )
    .bind(slug)
    .bind(path.to_str().unwrap())
    .bind(path.to_str().unwrap())
    .bind(chapters)
    .bind(transcript_page_path)
    .bind(source_path)
    .execute(&state.db)
    .await
    .unwrap();
    path
}

/// 建一个带 wiki+media 双项的 plan（page/slug 需先由调用方播种），返回
/// (link_token, plan_id, wiki_item_id, media_item_id)。
async fn make_plan(
    server: &TestServer,
    teacher_token: &str,
    page_path: &str,
    slug: &str,
    title: &str,
    label_wiki: &str,
    label_media: &str,
) -> (String, i64, i64, i64) {
    let body = json!({
        "title": title,
        "reason": "敌意 reason <b>粗体</b>",
        "origin": "chat",
        "period_key": null,
        "items": [
            {"kind": "wiki_page", "target_ref": page_path, "label": label_wiki},
            {"kind": "media", "target_ref": slug, "label": label_media,
             "timecode_start_s": 10, "timecode_end_s": 90}
        ]
    });
    let r = server
        .post("/api/v1/training/plans")
        .add_header("authorization", bearer(teacher_token))
        .json(&body)
        .await;
    assert_eq!(r.status_code(), StatusCode::CREATED, "plan create must succeed");
    let v = r.json::<serde_json::Value>();
    let link = v["link"].as_str().unwrap().to_string();
    let token = link.strip_prefix("/t/").expect("link is /t/<token>").to_string();
    let plan_id = v["plan"]["id"].as_i64().unwrap();
    let wiki_item = v["items"][0]["id"].as_i64().unwrap();
    let media_item = v["items"][1]["id"].as_i64().unwrap();
    (token, plan_id, wiki_item, media_item)
}

/// ============ 矩阵 1：token 验签语义 ============

#[tokio::test]
async fn t_page_token_typ_expiry_and_ownership() {
    let (server, state) = t_fixture("tok").await;
    let (teacher, _uid) = bind_teacher(&server, &unique("w")).await;

    // 错 typ：access token 当 plan_link 用 → 403 + 友好页（HTML，不泄漏失败原因）
    let r = server.get(&format!("/t/{}", teacher)).await;
    assert_eq!(r.status_code(), StatusCode::FORBIDDEN, "access token must be rejected");
    let html = r.text();
    assert!(html.contains("链接已过期或无效"), "friendly invalid-link page: {html:.200}");
    assert!(html.contains("企业微信"), "must tell teacher to go back to wecom: {html:.200}");

    // 垃圾 token → 同一 403 友好页（不区分 401 签名无效/403 过期）
    let r = server.get("/t/not-a-jwt-at-all").await;
    assert_eq!(r.status_code(), StatusCode::FORBIDDEN);
    assert!(r.text().contains("链接已过期或无效"));

    // 过期 plan_link → 403 友好页（负 TTL -120s 越过 60s leeway）
    let secret = state.config.jwt_secret().to_string();
    let expired = llm_wiki_server::utils::generate_plan_link_token(
        1, 1, &secret, chrono::Duration::seconds(-120),
    )
    .unwrap();
    let r = server.get(&format!("/t/{expired}")).await;
    assert_eq!(r.status_code(), StatusCode::FORBIDDEN);
    assert!(r.text().contains("链接已过期或无效"));

    // 有效签名但 plan 不存在 → 404（路由层职责）
    let ghost = llm_wiki_server::utils::generate_plan_link_token(
        1, 999999999, &secret, chrono::Duration::hours(1),
    )
    .unwrap();
    let r = server.get(&format!("/t/{ghost}")).await;
    assert_eq!(r.status_code(), StatusCode::NOT_FOUND);

    // 归属：B 的 token 指向 A 的 plan → 404（不泄漏存在性）
    let (_teacher_a, uid_a) = bind_teacher(&server, &unique("wa")).await;
    let (teacher_b, _uid_b) = bind_teacher(&server, &unique("wb")).await;
    let page_path = format!("concepts/own-{}.md", unique("pg"));
    seed_wiki_page(&state, &page_path, "A的页", "内容", json!([])).await;
    let r = server
        .post("/api/v1/training/plans")
        .add_header("authorization", bearer(&_teacher_a))
        .json(&json!({"title": "A的计划", "origin": "chat", "period_key": null,
                      "items": [{"kind": "wiki_page", "target_ref": page_path, "label": "l"}]}))
        .await;
    assert_eq!(r.status_code(), StatusCode::CREATED);
    let plan_a = r.json::<serde_json::Value>()["plan"]["id"].as_i64().unwrap();
    // B 的凭证（手工签 plan_link(B, plan_a)）→ 404
    let forged = llm_wiki_server::utils::generate_plan_link_token(
        _uid_b as i32, plan_a as i32, &secret, chrono::Duration::hours(1),
    )
    .unwrap();
    let _ = teacher_b;
    let r = server.get(&format!("/t/{forged}")).await;
    assert_eq!(r.status_code(), StatusCode::NOT_FOUND);
    // 无 view 事件落库（404 路径不渲染不记账）
    let n: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM learning_events WHERE user_id = $1 AND event_type = 'view'",
    )
    .bind(_uid_b as i32)
    .fetch_one(&state.db)
    .await
    .unwrap();
    assert_eq!(n, 0);
    let _ = uid_a;
}

/// ============ 矩阵 2：渲染 + view 事件（不改投影） ============

#[tokio::test]
async fn t_page_renders_html_and_records_view_without_projection() {
    let (server, state) = t_fixture("render").await;
    let (teacher, uid) = bind_teacher(&server, &unique("w")).await;

    let page_path = format!("concepts/rr-{}.md", unique("pg"));
    let slug = unique("md");
    let tr_path = format!("transcripts/tr-{}.md", unique("tr"));
    seed_wiki_page(
        &state,
        &page_path,
        "分数概念",
        "# 分数概念\n\n分数表示整体的一部分。\n",
        json!([]),
    )
    .await;
    // transcript 页（transcripts/ 命名空间也存 wiki_pages，落地页按 path 读取）
    seed_wiki_page(
        &state,
        &tr_path,
        "转写",
        "---\ntitle: \"转写\"\ntype: transcript\n---\n\n## [00:30] 开场\n\n[00:30] 大家好。\n",
        json!([format!("sources/{tr_path}")]),
    )
    .await;
    // 摘要页：sources 含该媒体的 source_path
    seed_wiki_page(
        &state,
        &format!("concepts/sum-{}.md", unique("sm")),
        "本片摘要",
        "这是摘要正文。",
        json!([format!("sources/transcripts/{slug}.md")]),
    )
    .await;
    seed_media_asset(
        &state,
        &slug,
        json!([{"start_s": 0, "end_s": 300, "label": "开场"},
               {"start_s": 300, "end_s": 600, "label": "进阶"}]),
        Some(&tr_path),
        Some(&format!("sources/transcripts/{slug}.md")),
    )
    .await;

    let body = json!({
        "title": "分数教学补强",
        "reason": "ask 之后生成",
        "origin": "chat",
        "period_key": null,
        "items": [
            {"kind": "wiki_page", "target_ref": page_path, "label": "分数概念"},
            {"kind": "media", "target_ref": slug, "label": "分数视频",
             "timecode_start_s": 10, "timecode_end_s": 90}
        ]
    });
    let r = server
        .post("/api/v1/training/plans")
        .add_header("authorization", bearer(&teacher))
        .json(&body)
        .await;
    assert_eq!(r.status_code(), StatusCode::CREATED);
    let v = r.json::<serde_json::Value>();
    let token = v["link"].as_str().unwrap().strip_prefix("/t/").unwrap().to_string();
    let plan_id = v["plan"]["id"].as_i64().unwrap();
    let wiki_item = v["items"][0]["id"].as_i64().unwrap();
    let media_item = v["items"][1]["id"].as_i64().unwrap();

    let r = server
        .get(&format!("/t/{token}"))
        .add_header("user-agent", "Mozilla/5.0 WeCom-test")
        .await;
    assert_eq!(r.status_code(), StatusCode::OK);
    let html = r.text();
    // 标题/reason/items/标签
    assert!(html.contains("分数教学补强"), "plan title in html");
    assert!(html.contains("ask 之后生成"), "plan reason in html");
    assert!(html.contains("分数概念"), "wiki item label");
    assert!(html.contains("分数视频"), "media item label");
    // media 项：<video controls> + 带 fp 签名 URL + chapters + transcript + 摘要
    assert!(html.contains("<video"), "video element");
    let fp_expected = hex::encode(Sha256::digest(token.as_bytes()))[..16].to_string();
    assert!(html.contains(&format!("fp={fp_expected}")), "fp param in signed url");
    assert!(html.contains("/media/"), "media path");
    assert!(html.contains("exp="), "exp param");
    assert!(html.contains("sig="), "sig param");
    assert!(html.contains("开场"), "chapter label 1");
    assert!(html.contains("进阶"), "chapter label 2");
    assert!(html.contains("大家好"), "transcript body text");
    assert!(html.contains("摘要"), "summary affordance present");
    assert!(html.contains("这是摘要正文"), "summary content reachable");
    // mobile-first viewport
    assert!(html.contains("viewport"), "viewport meta");
    // beacon JS：页面级 + 项级 + complete 形状
    assert!(html.contains("/seen"), "seen beacon");
    assert!(html.contains("item_id"), "item-level beacon body");
    assert!(html.contains("/complete"), "complete beacon");

    // view 事件：恰 1 条，user 本人、item_id NULL、payload 含 plan_id 与简化 ua
    let rows: Vec<(i32, Option<i32>, serde_json::Value)> = sqlx::query_as(
        "SELECT user_id, item_id, payload FROM learning_events \
         WHERE user_id = $1 AND event_type = 'view'",
    )
    .bind(uid as i32)
    .fetch_all(&state.db)
    .await
    .unwrap();
    assert_eq!(rows.len(), 1, "exactly one view event per render");
    assert_eq!(rows[0].0, uid as i32);
    assert_eq!(rows[0].1, None);
    assert_eq!(rows[0].2["plan_id"], plan_id);
    let ua = rows[0].2["ua"].as_str().unwrap_or("");
    assert!(ua.contains("WeCom-test"), "simplified ua recorded: {ua}");

    // 投影不动：两 item 仍 pending（view 只是渲染信号）
    let sts: Vec<(i32, String)> = sqlx::query_as(
        "SELECT id, status FROM learning_items WHERE plan_id = $1 ORDER BY sort_order",
    )
    .bind(plan_id as i32)
    .fetch_all(&state.db)
    .await
    .unwrap();
    assert_eq!(sts.len(), 2);
    assert!(sts.iter().all(|(_, s)| s == "pending"), "view must not touch projection: {sts:?}");
    let _ = (wiki_item, media_item);

    // 二次 GET：再记一条 view（渲染即记），投影依旧不动
    let r2 = server.get(&format!("/t/{token}")).await;
    assert_eq!(r2.status_code(), StatusCode::OK);
    let n: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM learning_events WHERE user_id = $1 AND event_type = 'view'",
    )
    .bind(uid as i32)
    .fetch_one(&state.db)
    .await
    .unwrap();
    assert_eq!(n, 2);
}

/// ============ 矩阵 3：XSS 敌意 fixture ============

#[tokio::test]
async fn t_page_xss_hostile_fixtures_neutralized() {
    let (server, state) = t_fixture("xss").await;
    let (teacher, _uid) = bind_teacher(&server, &unique("w")).await;

    let hostile_label = "<img src=x onerror=fetch('/t/X/seen')>";
    let page_path = format!("concepts/xs-{}.md", unique("pg"));
    let slug = unique("md");
    let tr_path = format!("transcripts/xt-{}.md", unique("tr"));
    seed_wiki_page(
        &state,
        &page_path,
        "<script>alert('page-title')</script>",
        "# 标题 <script>alert('content')</script>\n\n正文有 <img src=x onerror=alert(2)>（wiki_page 项只读渲染，不做时间戳 linkify）\n",
        json!([]),
    )
    .await;
    seed_wiki_page(
        &state,
        &tr_path,
        "t",
        "---\ntitle: \"t\"\n---\n\n## [00:10] <script>alert('chapter')</script>\n\n[00:10] 转写正文 <b>加粗</b> [00:42] 尾。\n",
        json!([format!("sources/{tr_path}")]),
    )
    .await;
    seed_media_asset(
        &state,
        &slug,
        json!([{"start_s": 0, "end_s": 60, "label": "<script>alert('chap')</script>"}]),
        Some(&tr_path),
        None,
    )
    .await;

    let (token, _plan, _wi, _mi) = make_plan(
        &server,
        &teacher,
        &page_path,
        &slug,
        "<script>alert('title')</script>",
        hostile_label,
        hostile_label,
    )
    .await;

    let r = server.get(&format!("/t/{token}")).await;
    assert_eq!(r.status_code(), StatusCode::OK);
    let html = r.text();

    // 敌意标签不得原样出现（转义后仅作可见文本，无标签语义——onerror/alert(
    // 作为可见字词允许存在，危险的是裸标签结构）
    assert!(!html.contains("<img"), "no raw <img> anywhere");
    assert!(!html.contains("<script>alert"), "no raw <script>alert");
    assert!(!html.contains("<b>"), "no raw <b> from content");
    // 语义保留：转义后的形态在输出中
    assert!(html.contains("&lt;script&gt;alert(&#39;title&#39;)&lt;/script&gt;"), "escaped plan title");
    assert!(html.contains("&lt;img src=x onerror=fetch(&#39;/t/X/seen&#39;)&gt;"), "escaped label");
    assert!(html.contains("&lt;script&gt;alert(&#39;content&#39;)&lt;/script&gt;"), "escaped wiki content");
    // 属性上下文（title="..."）同样转义：不出现被拆引号注入的痕迹
    assert!(!html.contains("title=\"<"), "attribute context escaped");
    // [mm:ss] 在已转义文本上仍 linkify（时间戳跳转可用）
    assert!(html.contains("data-start=\"42\""), "[00:42] linkified to 42s");
    assert!(html.contains("data-start=\"10\""), "[00:10] linkified to 10s");
}

/// ============ 矩阵 4：seen 双粒度 + Option 提取器 ============

#[tokio::test]
async fn t_page_seen_beacon_dual_granularity() {
    let (server, state) = t_fixture("seen").await;
    let (teacher, uid) = bind_teacher(&server, &unique("w")).await;

    let page_path = format!("concepts/sn-{}.md", unique("pg"));
    let slug = unique("md");
    seed_wiki_page(&state, &page_path, "p", "内容", json!([])).await;
    seed_media_asset(&state, &slug, json!([]), None, None).await;
    let body = json!({
        "title": "计划", "origin": "chat", "period_key": null,
        "items": [
            {"kind": "wiki_page", "target_ref": page_path, "label": "i1"},
            {"kind": "media", "target_ref": slug, "label": "i2"}
        ]
    });
    let r = server
        .post("/api/v1/training/plans")
        .add_header("authorization", bearer(&teacher))
        .json(&body)
        .await;
    assert_eq!(r.status_code(), StatusCode::CREATED);
    let v = r.json::<serde_json::Value>();
    let token = v["link"].as_str().unwrap().strip_prefix("/t/").unwrap().to_string();
    let plan_id = v["plan"]["id"].as_i64().unwrap() as i32;
    let item1 = v["items"][0]["id"].as_i64().unwrap() as i32;
    let item2 = v["items"][1]["id"].as_i64().unwrap() as i32;

    // 空 body + 无 content-type（beacon 兼容）→ 200，页面级语义
    let r = server.post(&format!("/t/{token}/seen")).await;
    assert_eq!(r.status_code(), StatusCode::OK, "empty-body beacon must be page-level 200");
    let n_page: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM learning_events WHERE user_id = $1 AND event_type='seen' AND item_id IS NULL",
    )
    .bind(uid as i32)
    .fetch_one(&state.db)
    .await
    .unwrap();
    assert_eq!(n_page, 1, "page-level seen event recorded");
    let sts: Vec<String> = sqlx::query_scalar(
        "SELECT status FROM learning_items WHERE plan_id = $1 ORDER BY sort_order",
    )
    .bind(plan_id)
    .fetch_all(&state.db)
    .await
    .unwrap();
    assert_eq!(sts, vec!["pending".to_string(), "pending".to_string()], "page-level seen must not touch items");

    // {} body + content-type → 同为页面级
    let r = server
        .post(&format!("/t/{token}/seen"))
        .content_type("application/json")
        .json(&json!({}))
        .await;
    assert_eq!(r.status_code(), StatusCode::OK);
    let n_page: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM learning_events WHERE user_id = $1 AND event_type='seen' AND item_id IS NULL",
    )
    .bind(uid as i32)
    .fetch_one(&state.db)
    .await
    .unwrap();
    assert_eq!(n_page, 2);

    // 项级：{"item_id": item1} → viewed 投影
    let r = server
        .post(&format!("/t/{token}/seen"))
        .content_type("application/json")
        .json(&json!({"item_id": item1}))
        .await;
    assert_eq!(r.status_code(), StatusCode::OK);
    let st: String = sqlx::query_scalar("SELECT status FROM learning_items WHERE id = $1")
        .bind(item1)
        .fetch_one(&state.db)
        .await
        .unwrap();
    assert_eq!(st, "viewed");
    let st2: String = sqlx::query_scalar("SELECT status FROM learning_items WHERE id = $1")
        .bind(item2)
        .fetch_one(&state.db)
        .await
        .unwrap();
    assert_eq!(st2, "pending", "other items untouched");

    // 先 complete 再 seen → completed 不回退
    let r = server
        .post(&format!("/t/{token}/complete"))
        .content_type("application/json")
        .json(&json!({"item_id": item1}))
        .await;
    assert_eq!(r.status_code(), StatusCode::OK);
    let r = server
        .post(&format!("/t/{token}/seen"))
        .content_type("application/json")
        .json(&json!({"item_id": item1}))
        .await;
    assert_eq!(r.status_code(), StatusCode::OK);
    let st: String = sqlx::query_scalar("SELECT status FROM learning_items WHERE id = $1")
        .bind(item1)
        .fetch_one(&state.db)
        .await
        .unwrap();
    assert_eq!(st, "completed", "seen must not regress completed");

    // 伪造 item_id：另一 plan 的 item / 不存在 → 400 且零写
    let other_page = format!("concepts/of-{}.md", unique("pg"));
    seed_wiki_page(&state, &other_page, "p2", "c2", json!([])).await;
    let r = server
        .post("/api/v1/training/plans")
        .add_header("authorization", bearer(&teacher))
        .json(&json!({"title": "他计划", "origin": "chat", "period_key": null,
                      "items": [{"kind": "wiki_page", "target_ref": other_page, "label": "o"}]}))
        .await;
    assert_eq!(r.status_code(), StatusCode::CREATED);
    let other_item = r.json::<serde_json::Value>()["items"][0]["id"].as_i64().unwrap() as i32;
    for bad in [other_item, 999999999] {
        let r = server
            .post(&format!("/t/{token}/seen"))
            .content_type("application/json")
            .json(&json!({"item_id": bad}))
            .await;
        assert_eq!(r.status_code(), StatusCode::BAD_REQUEST, "forged item_id {bad} must 400");
    }
    let n_forge: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM learning_events WHERE item_id = ANY($1)",
    )
    .bind(vec![other_item, 999999999])
    .fetch_one(&state.db)
    .await
    .unwrap();
    assert_eq!(n_forge, 0, "forged seen must not record events");
    let st: String = sqlx::query_scalar("SELECT status FROM learning_items WHERE id = $1")
        .bind(other_item)
        .fetch_one(&state.db)
        .await
        .unwrap();
    assert_eq!(st, "pending", "other plan's item untouched");

    // 无效 token → 403（JSON 错误，beacon 静默丢弃即可）
    let r = server.post("/t/garbage/seen").json(&json!({"item_id": item1})).await;
    assert_eq!(r.status_code(), StatusCode::FORBIDDEN);
    let r = server.post("/t/garbage/seen").await;
    assert_eq!(r.status_code(), StatusCode::FORBIDDEN);
}

/// ============ 矩阵 5：complete（∈ plan 校验 + 幂等） ============

#[tokio::test]
async fn t_page_complete_membership_and_idempotency() {
    let (server, state) = t_fixture("comp").await;
    let (teacher, _uid) = bind_teacher(&server, &unique("w")).await;

    let page_path = format!("concepts/cp-{}.md", unique("pg"));
    let slug = unique("md");
    seed_wiki_page(&state, &page_path, "p", "c", json!([])).await;
    seed_media_asset(&state, &slug, json!([]), None, None).await;
    let body = json!({
        "title": "计划", "origin": "chat", "period_key": null,
        "items": [
            {"kind": "wiki_page", "target_ref": page_path, "label": "i1"},
            {"kind": "media", "target_ref": slug, "label": "i2"}
        ]
    });
    let r = server
        .post("/api/v1/training/plans")
        .add_header("authorization", bearer(&teacher))
        .json(&body)
        .await;
    assert_eq!(r.status_code(), StatusCode::CREATED);
    let v = r.json::<serde_json::Value>();
    let token = v["link"].as_str().unwrap().strip_prefix("/t/").unwrap().to_string();
    let item1 = v["items"][0]["id"].as_i64().unwrap() as i32;

    // 合法 complete → 200 + completed
    let r = server
        .post(&format!("/t/{token}/complete"))
        .content_type("application/json")
        .json(&json!({"item_id": item1}))
        .await;
    assert_eq!(r.status_code(), StatusCode::OK);
    let (st, at): (String, Option<chrono::DateTime<chrono::Utc>>) =
        sqlx::query_as("SELECT status, completed_at FROM learning_items WHERE id = $1")
            .bind(item1)
            .fetch_one(&state.db)
            .await
            .unwrap();
    assert_eq!(st, "completed");
    let at = at.expect("completed_at set");

    // 幂等：二次 → 200，completed_at 不变（complete 事件记账两次）
    let r = server
        .post(&format!("/t/{token}/complete"))
        .content_type("application/json")
        .json(&json!({"item_id": item1}))
        .await;
    assert_eq!(r.status_code(), StatusCode::OK);
    let at2: Option<chrono::DateTime<chrono::Utc>> =
        sqlx::query_scalar("SELECT completed_at FROM learning_items WHERE id = $1")
            .bind(item1)
            .fetch_one(&state.db)
            .await
            .unwrap();
    assert_eq!(at2, Some(at), "second complete must not reset completed_at");

    // 伪造：不存在 / 他 plan 的 item → 400，零写
    let other_page = format!("concepts/co-{}.md", unique("pg"));
    seed_wiki_page(&state, &other_page, "p2", "c2", json!([])).await;
    let r = server
        .post("/api/v1/training/plans")
        .add_header("authorization", bearer(&teacher))
        .json(&json!({"title": "他计划2", "origin": "chat", "period_key": null,
                      "items": [{"kind": "wiki_page", "target_ref": other_page, "label": "o"}]}))
        .await;
    assert_eq!(r.status_code(), StatusCode::CREATED);
    let other_item = r.json::<serde_json::Value>()["items"][0]["id"].as_i64().unwrap() as i32;
    for bad in [other_item, 999999999] {
        let r = server
            .post(&format!("/t/{token}/complete"))
            .content_type("application/json")
            .json(&json!({"item_id": bad}))
            .await;
        assert_eq!(r.status_code(), StatusCode::BAD_REQUEST, "forged item_id {bad} must 400");
    }
    let st: String = sqlx::query_scalar("SELECT status FROM learning_items WHERE id = $1")
        .bind(other_item)
        .fetch_one(&state.db)
        .await
        .unwrap();
    assert_eq!(st, "pending");
    let n_ev: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM learning_events WHERE event_type='complete' AND item_id = ANY($1)",
    )
    .bind(vec![other_item, 999999999])
    .fetch_one(&state.db)
    .await
    .unwrap();
    assert_eq!(n_ev, 0, "forged complete must not record events");

    // 无效 token → 403
    let r = server
        .post("/t/garbage/complete")
        .json(&json!({"item_id": item1}))
        .await;
    assert_eq!(r.status_code(), StatusCode::FORBIDDEN);
}

/// ============ 矩阵 6：/media fp 三段式签名 + 两段式兼容 ============

#[tokio::test]
async fn media_fp_signature_and_legacy_compat() {
    let (server, state) = t_fixture("fp").await;
    let slug = unique("s");
    let path = seed_media_asset(&state, &slug, json!([]), None, None).await;

    let exp = chrono::Utc::now().timestamp() + 3600;
    let token = llm_wiki_server::utils::generate_plan_link_token(
        1, 1, state.config.jwt_secret(), chrono::Duration::hours(1),
    )
    .unwrap();
    let fp = hex::encode(Sha256::digest(token.as_bytes()))[..16].to_string();
    let sig3 = llm_wiki_server::utils::media_sign::sign_media_with_fp(MEDIA_KEY, &slug, exp, &fp);

    // 三段式 + Range → 206 + 100 字节
    let r = server
        .get(&format!("/media/{slug}?exp={exp}&sig={sig3}&fp={fp}"))
        .add_header("range", "bytes=0-99")
        .await;
    assert_eq!(r.status_code(), StatusCode::PARTIAL_CONTENT, "fp-signed request must 206");
    assert_eq!(r.as_bytes().len(), 100);

    // 旧两段式（无 fp）→ 206（M1 兼容期）
    let sig2 = llm_wiki_server::utils::media_sign::sign_media(MEDIA_KEY, &slug, exp);
    let r = server
        .get(&format!("/media/{slug}?exp={exp}&sig={sig2}"))
        .add_header("range", "bytes=0-99")
        .await;
    assert_eq!(r.status_code(), StatusCode::PARTIAL_CONTENT, "legacy two-part sig must stay accepted");
    assert_eq!(r.as_bytes().len(), 100);

    // dual-format try：带 fp 参数但两段式签名 → 回落通过
    let r = server
        .get(&format!("/media/{slug}?exp={exp}&sig={sig2}&fp={fp}"))
        .add_header("range", "bytes=0-99")
        .await;
    assert_eq!(r.status_code(), StatusCode::PARTIAL_CONTENT, "legacy sig with fp param falls back");

    // 错 fp（三段式签名对不上）→ 403
    let r = server
        .get(&format!("/media/{slug}?exp={exp}&sig={sig3}&fp=0000000000000000"))
        .add_header("range", "bytes=0-99")
        .await;
    assert_eq!(r.status_code(), StatusCode::FORBIDDEN, "mismatched fp must be rejected");

    let _ = sqlx::query("DELETE FROM media_assets WHERE slug = $1")
        .bind(&slug)
        .execute(&state.db)
        .await;
    let _ = std::fs::remove_file(&path);
}
