// ingest 并发化集成测（spec 2026-08-29 §测试与验收 1/2/6：并发正确性、确定性
// 归并、N=1 等价）。需 PG(docker @5433) + Redis(@6380)；#[ignore] 门。
// 铁律：直 INSERT ingest_jobs + 直调 run_ingest_job（不经 enqueue/HTTP——LPUSH
// 会被共享 redis 侧 worker 抢走双跑，t8_insert_and_run 同款）。
// 命名：t10_ 前缀族（mod.rs SWEEPS 已扩入）。
use llm_wiki_server::services::ingest_pipeline;
use llm_wiki_server::services::ingest_queue::IngestJob;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

// —— 路由 stub：按请求体 content 的子串组合路由（并发下"按序弹栈"会竞态）——

#[derive(Clone)]
pub(crate) enum RouteResp {
    /// SSE 文本响应（step1/step2/review/merge 通用三帧）
    Text(String),
    Error(u16),
}

/// 调用类型锚（llm prompt 结构性差异，稳定可依赖）：step1 = "<document>"；
/// step2 = "<analysis>"；dedicated review = "## Wiki Purpose"；merge = "<existing>"。
/// 源身份锚 = fixture 内容埋 MARKxx（step1 的 <document> 与 step2 的 <source> 都
/// 内嵌原文 → 同一 marker 命中两调用）。
#[derive(Clone)]
pub(crate) struct StubRoute {
    /// 全部子串都出现在请求 content 里 → 命中（组合定位：调用类型 + 源身份）
    pub all: Vec<&'static str>,
    pub delay_ms: u64,
    pub resp: RouteResp,
}

pub(crate) struct RoutingStub {
    pub base: String,
    /// 完成序 marker 记录（断言调用次序用；marker = all.join("+")）
    pub calls: Arc<Mutex<Vec<String>>>,
    /// 每 marker 进入即计（delay 前）——测试等待"已开始"锚点
    pub started: Arc<Mutex<HashMap<String, usize>>>,
}

pub(crate) async fn spawn_routing_stub(routes: Vec<StubRoute>) -> RoutingStub {
    use axum::extract::{Json, State};
    use axum::response::IntoResponse;
    use axum::routing::post;
    use axum::Router;

    let routes = Arc::new(routes);
    let calls: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let started: Arc<Mutex<HashMap<String, usize>>> = Arc::new(Mutex::new(HashMap::new()));

    let app = Router::new()
        .route(
            "/chat/completions",
            post(
                |State((routes, calls, started)): State<(
                    Arc<Vec<StubRoute>>,
                    Arc<Mutex<Vec<String>>>,
                    Arc<Mutex<HashMap<String, usize>>>,
                )>,
                 Json(body): Json<serde_json::Value>| async move {
                    // openai provider 把 system_prompt 折进 messages（role=system）
                    // ——拼 messages 各项 content 即覆盖 system + user。
                    let content: String = body["messages"]
                        .as_array()
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|m| m["content"].as_str().map(String::from))
                                .collect::<Vec<_>>()
                                .join("\n")
                        })
                        .unwrap_or_default();
                    let hit = routes.iter().find(|r| r.all.iter().all(|m| content.contains(m)));
                    let route = match hit {
                        Some(r) => r,
                        None => {
                            return (axum::http::StatusCode::INTERNAL_SERVER_ERROR, "no route")
                                .into_response()
                        }
                    };
                    let marker = route.all.join("+");
                    *started.lock().unwrap().entry(marker.clone()).or_insert(0) += 1;
                    if route.delay_ms > 0 {
                        tokio::time::sleep(Duration::from_millis(route.delay_ms)).await;
                    }
                    calls.lock().unwrap().push(marker);
                    match &route.resp {
                        RouteResp::Text(t) => {
                            // SSE 三帧照 merge_ingest_test::spawn_stub_chat_server
                            // 逐字节同款（text delta → usage → [DONE]）
                            let content_json = serde_json::to_string(t).unwrap();
                            let sse = format!(
                                "data: {{\"choices\":[{{\"delta\":{{\"content\":{}}}}}]}}\n\n\
                                 data: {{\"choices\":[],\"usage\":{{\"prompt_tokens\":10,\"completion_tokens\":100}}}}\n\n\
                                 data: [DONE]\n\n",
                                content_json
                            );
                            (
                                [(axum::http::header::CONTENT_TYPE, "text/event-stream")],
                                sse,
                            )
                                .into_response()
                        }
                        RouteResp::Error(code) => {
                            (axum::http::StatusCode::from_u16(*code).unwrap(), "stub error")
                                .into_response()
                        }
                    }
                },
            ),
        )
        .with_state((routes, calls.clone(), started.clone()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap(); });
    RoutingStub {
        base: format!("http://{}", addr),
        calls,
        started,
    }
}

// —— fixture（t8 模式逐段移植：命名 t10 化、并发度参数化）——

pub(crate) struct IcEnv {
    pub state: llm_wiki_server::AppState,
    pub pid: i32,
    pub team_id: i32,
    pub stub: RoutingStub,
}

/// 并发度参数化 setup：stub 先 spawn 拿 base → clone state.config 设
/// ingest.source_concurrency → create_app（同库同 Redis，t8_setup_project 同款）
/// → 注册 t10_conc_{uuid} 用户 → LT项目_t10_{uuid} 项目 → team provider 指向
/// 路由 stub 根（providers HTTP API，owner 权限；请求体字段照
/// merge_ingest_test.rs t8 原样，仅 base_url 换 stub.base）。
/// 注册自动建 personal team（owner=self，routes/auth.rs:145），无需再 POST /teams。
pub(crate) async fn ic_setup(routes: Vec<StubRoute>, n: usize) -> IcEnv {
    let stub = spawn_routing_stub(routes).await;
    let (app, state) = crate::setup_test_app().await;
    let mut cfg = (*state.config).clone();
    cfg.ingest.source_concurrency = n;
    let (_app2, state) = llm_wiki_server::create_app(cfg).await.expect("并发度注入 app");
    let server = axum_test::TestServer::new(app).unwrap();
    let n_id = COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let uuid = format!("{}_{}", std::process::id(), n_id);
    let username = format!("t10_conc_{uuid}");
    let token = crate::register_user(&server, &username, &format!("{}@t10.com", username), "password123").await;
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
        .json(&serde_json::json!({"name": format!("LT项目_t10_{uuid}"), "team_id": team_id}))
        .await;
    assert_eq!(resp.status_code(), axum::http::StatusCode::CREATED);
    let pid = resp.json::<serde_json::Value>()["id"].as_i64().unwrap() as i32;
    // team provider → stub 根（t8 同款端点与字段；base_url 指到 stub）
    let resp = server
        .post(&format!("/api/v1/teams/{}/llm-providers", team_id))
        .add_header("authorization", format!("Bearer {}", token))
        .json(&serde_json::json!({
            "provider_type": "openai",
            "api_key": "sk-t10-stub",
            "base_url": stub.base.clone(),
            "model": "t10-stub-model",
        }))
        .await;
    assert!(resp.status_code().is_success(), "team provider 创建失败: {}", resp.text());
    IcEnv { state, pid, team_id, stub }
}

/// 经 storage 后端写 fixture source（t8_write_source 同款）。
pub(crate) async fn ic_write_source(env: &IcEnv, rel: &str, content: &str) {
    env.state
        .storage
        .write_string(env.team_id, env.pid, rel, content)
        .await
        .expect("storage write_string fixture source");
}

/// INSERT 'running' job 行 + 回读（t8_insert_and_run 前半；text[] bind）。
pub(crate) async fn ic_insert_job(env: &IcEnv, sources: Vec<String>) -> IngestJob {
    let job_id = uuid::Uuid::new_v4();
    sqlx::query(
        "INSERT INTO ingest_jobs (id, project_id, source_paths, status) \
         VALUES ($1, $2, $3, 'running')",
    )
    .bind(job_id)
    .bind(env.pid)
    .bind(&sources)
    .execute(&env.state.db)
    .await
    .expect("insert ingest_jobs 行");
    sqlx::query_as("SELECT * FROM ingest_jobs WHERE id=$1")
        .bind(job_id)
        .fetch_one(&env.state.db)
        .await
        .expect("回读 IngestJob")
}

/// insert + run + 落 succeeded 终态；Err → 落 failed 后 panic（携带全文诊断）。
/// 返回 (job, result)——job 供 item_states 断言。
pub(crate) async fn ic_run_ok(
    env: &IcEnv,
    sources: Vec<String>,
) -> (IngestJob, llm_wiki_server::services::ingest_queue::IngestJobResult) {
    let job = ic_insert_job(env, sources).await;
    match ingest_pipeline::run_ingest_job(&env.state, &job).await {
        Ok(res) => {
            sqlx::query("UPDATE ingest_jobs SET status='succeeded', finished_at=NOW() WHERE id=$1")
                .bind(job.id)
                .execute(&env.state.db)
                .await
                .expect("落 succeeded 终态");
            (job, res)
        }
        Err(e) => {
            sqlx::query(
                "UPDATE ingest_jobs SET status='failed', error=$1, finished_at=NOW() WHERE id=$2",
            )
            .bind(e.to_string())
            .bind(job.id)
            .execute(&env.state.db)
            .await
            .expect("落 failed 终态");
            panic!("run_ingest_job 应返回 Ok: {e}");
        }
    }
}

/// 回读既有 job + run + 落 succeeded（resume 用例复用）。
pub(crate) async fn ic_run_existing(
    env: &IcEnv,
    job_id: uuid::Uuid,
) -> llm_wiki_server::services::ingest_queue::IngestJobResult {
    let job: IngestJob = sqlx::query_as("SELECT * FROM ingest_jobs WHERE id=$1")
        .bind(job_id)
        .fetch_one(&env.state.db)
        .await
        .expect("回读 IngestJob");
    match ingest_pipeline::run_ingest_job(&env.state, &job).await {
        Ok(res) => {
            sqlx::query("UPDATE ingest_jobs SET status='succeeded', finished_at=NOW() WHERE id=$1")
                .bind(job_id)
                .execute(&env.state.db)
                .await
                .expect("落 succeeded 终态");
            res
        }
        Err(e) => {
            sqlx::query(
                "UPDATE ingest_jobs SET status='failed', error=$1, finished_at=NOW() WHERE id=$2",
            )
            .bind(e.to_string())
            .bind(job_id)
            .execute(&env.state.db)
            .await
            .expect("落 failed 终态");
            panic!("resume run 应返回 Ok: {e}");
        }
    }
}

/// 取 DB 页行 (content, sources, updated_at)——t8_fetch_page 简化版。
pub(crate) async fn ic_fetch_page(env: &IcEnv, path: &str) -> (String, serde_json::Value, chrono::DateTime<chrono::Utc>) {
    sqlx::query_as(
        "SELECT content, sources, updated_at FROM wiki_pages WHERE project_id=$1 AND path=$2",
    )
    .bind(env.pid)
    .bind(path)
    .fetch_one(&env.state.db)
    .await
    .expect("页面必须已落库")
}

/// 展开 item_states 为 (path, status, error) 三元组列表。
pub(crate) async fn ic_fetch_item_states(env: &IcEnv, job_id: uuid::Uuid) -> Vec<(String, String, Option<String>)> {
    let v: serde_json::Value = sqlx::query_scalar("SELECT item_states FROM ingest_jobs WHERE id=$1")
        .bind(job_id)
        .fetch_one(&env.state.db)
        .await
        .expect("读 item_states");
    v.as_array()
        .map(|arr| {
            arr.iter()
                .map(|e| {
                    (
                        e["path"].as_str().unwrap_or_default().to_string(),
                        e["status"].as_str().unwrap_or_default().to_string(),
                        e["error"].as_str().map(String::from),
                    )
                })
                .collect()
        })
        .unwrap_or_default()
}

// —— 用例（spec §测试与验收 1/2/6）——

/// spec 测 1：3 源 N=2，stub 延迟乱序（za 慢 400ms、zb/zc 快 30ms）→ 全部落库、
/// item_states 全 done、页面内容正确。
/// review 第三调在本 fixture 下不触发（`should_run_dedicated_review_stage` 对
/// <4 块且 <10000 字符的 step2 输出直接跳过），无需配 review 路由。
#[tokio::test]
#[ignore = "requires PG + Redis"]
async fn concurrent_sources_all_land_in_order() {
    let s1 = r#"{"entities":[{"name":"EA"}],"connections":[],"contradictions":[]}"#;
    let s2 = |slug: &str| format!(
        "---FILE: concepts/{slug}.md ---\n---\ntitle: {slug}\ntype: concept\nsources: [raw/{slug}.md]\n---\n# {slug}\n{slug} body MARK{slug}.\n---END FILE---"
    );
    let routes = vec![
        // za：step1 快、step2 慢（制造乱序完成）
        StubRoute { all: vec!["MARKza", "<document>"], delay_ms: 30, resp: RouteResp::Text(s1.into()) },
        StubRoute { all: vec!["MARKza", "<analysis>"], delay_ms: 400, resp: RouteResp::Text(s2("za")) },
        StubRoute { all: vec!["MARKzb", "<document>"], delay_ms: 30, resp: RouteResp::Text(s1.into()) },
        StubRoute { all: vec!["MARKzb", "<analysis>"], delay_ms: 30, resp: RouteResp::Text(s2("zb")) },
        StubRoute { all: vec!["MARKzc", "<document>"], delay_ms: 30, resp: RouteResp::Text(s1.into()) },
        StubRoute { all: vec!["MARKzc", "<analysis>"], delay_ms: 30, resp: RouteResp::Text(s2("zc")) },
    ];
    let env = ic_setup(routes, 2).await;
    // 防 step1 缓存错位（t8 评审 C-2）：`ingest:cache:{content_hash}` 无 project
    // 维度、TTL 7 天——source 文本内嵌每次运行唯一 uuid，否则重跑时 step1 走缓存
    // 零 LLM 调用（MARKxx 路由锚不受影响）。
    let run = uuid::Uuid::new_v4().simple().to_string();
    ic_write_source(&env, "raw/za.md", &format!("za content MARKza za body text [run-{run}]")).await;
    ic_write_source(&env, "raw/zb.md", &format!("zb content MARKzb zb body text [run-{run}]")).await;
    ic_write_source(&env, "raw/zc.md", &format!("zc content MARKzc zc body text [run-{run}]")).await;
    let (job, res) = ic_run_ok(&env, vec!["raw/za.md".into(), "raw/zb.md".into(), "raw/zc.md".into()]).await;
    assert_eq!(res.new_pages.len(), 3, "三源各一页：{:?}", res.new_pages);
    let (content, _, _) = ic_fetch_page(&env, "concepts/za.md").await;
    assert!(content.contains("MARKza"));
    let states = ic_fetch_item_states(&env, job.id).await;
    assert_eq!(states.len(), 3);
    assert!(states.iter().all(|(_, s, _)| s == "done"), "{:?}", states);
    // 乱序完成实证（stub 路由记录）：6 次 LLM 调用（3 源 × step1+step2）各命中恰
    // 一次。za/zb 的 step1 并发在飞（N=2）；za 的慢 step2（400ms）与 zb 的快
    // step2 同刻起步，zb 先完成——即"完成序 ≠ 起步序"的乱序完成本身。
    // （buffered(N) 是有序窗口：zb 完成但 za 未出窗前不补位，zc 在 za 出窗后才
    // 起步——故 zc 两调固定在 za 慢 step2 之后。）
    let calls = env.stub.calls.lock().unwrap().clone();
    assert_eq!(calls.len(), 6, "6 次路由命中：{calls:?}");
    let pos = |m: &str| calls.iter().position(|c| c == m).unwrap_or_else(|| panic!("{m} 未命中: {calls:?}"));
    assert!(
        pos("MARKzb+<analysis>") < pos("MARKza+<analysis>"),
        "zb 快 step2 应先于 za 慢 step2 完成（乱序完成实证）：{calls:?}"
    );
    let started = env.stub.started.lock().unwrap().clone();
    assert_eq!(started.len(), 6, "6 条路由各进入一次：{started:?}");
    assert!(started.values().all(|c| *c == 1), "{started:?}");
    crate::teardown_test_data(&env.state).await;
}

/// spec 测 2：za/zb 各生成 concepts/shared.md（跨源碰撞 Merge），stub 让 zb 的
/// step2 先完成（za 慢 400ms）→ merge 调用时 existing 必是 za 版（源序归并）。
/// merge 路由锚定 `<existing>\n` 段首：merge prompt 同时内嵌 existing 与
/// incoming 两段版本文本，裸版本串两条路由都会命中（find 取首条 → 顺序错乱的
/// 世界也会假绿 ZA_FIRST）；锚定段首后 existing=za 版才出 ZA_FIRST，
/// existing=zb 版（顺序错乱才会出现）出 WRONG_ORDER。
#[tokio::test]
#[ignore = "requires PG + Redis"]
async fn merge_order_is_source_order_despite_reversed_completion() {
    let s1 = r#"{"entities":[{"name":"E"}],"connections":[],"contradictions":[]}"#;
    let page = |slug: &str| format!(
        "---FILE: concepts/shared.md ---\n---\ntitle: Shared\ntype: concept\nsources: [raw/{slug}.md]\n---\n# Shared\n{slug} version.\n---END FILE---"
    );
    let routes = vec![
        StubRoute { all: vec!["MARKza", "<document>"], delay_ms: 30, resp: RouteResp::Text(s1.into()) },
        StubRoute { all: vec!["MARKza", "<analysis>"], delay_ms: 400, resp: RouteResp::Text(page("za")) },
        StubRoute { all: vec!["MARKzb", "<document>"], delay_ms: 30, resp: RouteResp::Text(s1.into()) },
        StubRoute { all: vec!["MARKzb", "<analysis>"], delay_ms: 30, resp: RouteResp::Text(page("zb")) },
        // merge：existing=za 版时出 ZA_FIRST，existing=zb 版（顺序错乱才会出现）出 WRONG
        StubRoute { all: vec!["<existing>\n# Shared\nza version"], delay_ms: 30, resp: RouteResp::Text("merged: ZA_FIRST".into()) },
        StubRoute { all: vec!["<existing>\n# Shared\nzb version"], delay_ms: 30, resp: RouteResp::Text("merged: WRONG_ORDER".into()) },
    ];
    let env = ic_setup(routes, 2).await;
    // 同 C-2：source 文本内嵌每次运行唯一 uuid 防 step1 缓存错位。
    let run = uuid::Uuid::new_v4().simple().to_string();
    ic_write_source(&env, "raw/za.md", &format!("za content MARKza [run-{run}]")).await;
    ic_write_source(&env, "raw/zb.md", &format!("zb content MARKzb [run-{run}]")).await;
    let (_job, res) = ic_run_ok(&env, vec!["raw/za.md".into(), "raw/zb.md".into()]).await;
    assert_eq!(res.merged_pages, vec!["concepts/shared.md".to_string()]);
    let (content, sources, _) = ic_fetch_page(&env, "concepts/shared.md").await;
    assert!(content.contains("ZA_FIRST"), "merge 的 existing 必须是 za 版（源序）：{}", content);
    assert!(sources.to_string().contains("raw/za.md") && sources.to_string().contains("raw/zb.md"));
    crate::teardown_test_data(&env.state).await;
}

/// spec 测 6：N=1 时 buffered(1)+channel ≈ 今日串行——同用例 1 场景在 n=1 下
/// 结果一致（全落库 + 全 done）。
#[tokio::test]
#[ignore = "requires PG + Redis"]
async fn n1_equivalence_lands_all() {
    let s1 = r#"{"entities":[],"connections":[],"contradictions":[]}"#;
    let s2 = |slug: &str| format!(
        "---FILE: concepts/{slug}.md ---\n---\ntitle: {slug}\ntype: concept\nsources: [raw/{slug}.md]\n---\n# {slug}\n{slug} body.\n---END FILE---"
    );
    // mk 参数须 &'static str（StubRoute.all 是 Vec<&'static str>，字面量调用满足）
    let mk = |m: &'static str| vec![
        StubRoute { all: vec![m, "<document>"], delay_ms: 10, resp: RouteResp::Text(s1.into()) },
        StubRoute { all: vec![m, "<analysis>"], delay_ms: 10, resp: RouteResp::Text(s2(m.trim_start_matches("MARK"))) },
    ];
    let mut routes = vec![];
    routes.extend(mk("MARKza")); routes.extend(mk("MARKzb"));
    let env = ic_setup(routes, 1).await;
    // 同 C-2：source 文本内嵌每次运行唯一 uuid 防 step1 缓存错位。
    let run = uuid::Uuid::new_v4().simple().to_string();
    ic_write_source(&env, "raw/za.md", &format!("a MARKza [run-{run}]")).await;
    ic_write_source(&env, "raw/zb.md", &format!("b MARKzb [run-{run}]")).await;
    let (_job, res) = ic_run_ok(&env, vec!["raw/za.md".into(), "raw/zb.md".into()]).await;
    assert_eq!(res.new_pages.len(), 2);
    crate::teardown_test_data(&env.state).await;
}
