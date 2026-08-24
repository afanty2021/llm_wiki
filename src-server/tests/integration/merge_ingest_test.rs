//! 多源累积合并集成测试（t8_ 前缀 + SWEEPS；spec §5）。
//! stub chat 服务器覆盖 step1/step2/merge 全成功路径——现有集成测试只测失败路径，
//! 这是本仓库首次在集成层跑通 LLM 成功链（SSE 格式对齐 llm_stream openai 解析：
//! choices[].delta.content + 末尾空 choices 的 usage chunk）。
//! Task 6 四用例：成功累积 / merge 失败整页回退 / 单源重生成 Replace / A→B→A 存续。
//! 全部 `#[ignore]`：跑法 `cargo test --test integration t8_ -- --ignored --test-threads=1`
//! （串行——共享 live PG@5433 + Redis@6380；需 docker 起且批次 4 摄取终态避免互扰）。
//!
//! 编排铁律（评审 C-3）：
//! - 绝不 HTTP enqueue（会 LPUSH 进共享 live Redis 被 launchd worker 抢走，对进程内
//!   stub 双跑竞态）——直接 INSERT ingest_jobs 行 + 直接 run_ingest_job（t8_insert_and_run）。
//! - 两 job 模型：job1（Ch01 建页）与 job2（Ch02 撞入）分别 INSERT 分别跑；"new_pages
//!   不含"断言只对 job2 的 result 成立（单 job 下建页必进 new_pages）。
//! - 防 step1 缓存错位（评审 C-2）：`ingest:cache:{content_hash}` 无 project 维度、TTL
//!   7 天——fixture source 文本内嵌每次运行唯一 uuid（`[run-{uuid}]`）。
//! - stub step2 输出约束（评审 M-15）：每响应 <4 个 FILE 块且 <10000 字符（低于
//!   review.rs dedicated review 第三调阈值），且不含 `---REVIEW:`。
//! - 不脚本 `StubResp::Text("")`——空 delta 被 SSE 解析静默跳过。

use axum::{extract::State, response::IntoResponse, routing::post, Router};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

pub(crate) enum StubResp {
    Text(String),
    Error(u16),
}

/// 进程内 stub：POST {base}/chat/completions 按序弹出脚本化响应；耗尽 → 500。
/// 路由路径已对照 llm_stream openai provider 的实际拼接核实（llm_stream.rs
/// provider_for_project）：base_url 非空时 endpoint =
/// `base.trim_end_matches('/') + "/chat/completions"`——不自动补 /v1，故把
/// llm_providers.base_url 配成 stub 根（http://127.0.0.1:{port}）即命中本路由。
/// SSE 三帧与 parse_openai_sse_line 逐行对齐：text delta → usage（空 choices）→
/// [DONE]（缺 [DONE] 会被消费方以 StreamEnded 收尾，务必带上）。
pub(crate) async fn spawn_stub_chat_server(
    script: Vec<StubResp>,
) -> (String, tokio::task::JoinHandle<()>) {
    let script = Arc::new(Mutex::new(script));
    let app = Router::new()
        .route(
            "/chat/completions",
            post(|State(script): State<Arc<Mutex<Vec<StubResp>>>>| async move {
                let next = {
                    let mut s = script.lock().unwrap();
                    if s.is_empty() { None } else { Some(s.remove(0)) }
                };
                // 三臂响应类型不同（(StatusCode,&str) vs ([(..);1],String)），
                // 统一经 IntoResponse 收敛为 axum::response::Response。
                match next {
                    Some(StubResp::Error(code)) => (
                        axum::http::StatusCode::from_u16(code).unwrap(),
                        "stub error",
                    )
                        .into_response(),
                    Some(StubResp::Text(t)) => {
                        let content_json = serde_json::to_string(&t).unwrap();
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
                    None => (
                        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                        "stub exhausted",
                    )
                        .into_response(),
                }
            }),
        )
        .with_state(script);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let handle = tokio::spawn(async move { axum::serve(listener, app).await.unwrap(); });
    (format!("http://{}", addr), handle)
}

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// t8_ fixture（评审 C-1）：命名必须与 mod.rs SWEEPS 扩入的 t8 模式逐字匹配——
/// 项目名 `LT项目_t8_{uuid}`（projects sweep：name LIKE 'LT项目_t8\_%'）、
/// username `t8_merge_{uuid}`（users sweep 锚定 username LIKE 't8\_%'）、
/// email `t8_merge_{uuid}@t8.com`（users sweep 非锚定 email LIKE '%t8\_%'）。
/// 序列模板 reviews_test.rs::setup_project（注册 / POST /teams / POST /projects），
/// 但命名不可照抄其固定 `test-proj`（不匹配 SWEEPS 模式，每轮净漏清扫）。
/// 入参 state：以其 config 克隆起临时 setup app（同库同 Redis）跑 HTTP 序列，
/// registration_enabled 强制 true（与 setup_test_app 同款防御——default.json 已翻
/// false，裸 from_env config 下注册会 403）。
/// 返回 (project_id, team_id, token)——Task 6 用例以 token 经 providers HTTP API
/// 把 team provider base_url 指向 stub 根（创建者是 owner，满足 Admin 写权限）。
async fn t8_setup_project(state: &llm_wiki_server::AppState) -> (i32, i32, String) {
    let mut cfg = (*state.config).clone();
    cfg.auth.registration_enabled = true;
    let (app, _setup_state) = llm_wiki_server::create_app(cfg).await.expect("t8 fixture app");
    let server = axum_test::TestServer::new(app).unwrap();

    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let uuid = format!("{}_{}", std::process::id(), n);
    let username = format!("t8_merge_{uuid}");
    let token =
        crate::register_user(&server, &username, &format!("{}@t8.com", username), "password123")
            .await;

    let team = server
        .post("/api/v1/teams")
        .add_header("authorization", format!("Bearer {}", token))
        .json(&serde_json::json!({"name": format!("LT测试team_t8_{uuid}")}))
        .await;
    assert_eq!(team.status_code(), axum::http::StatusCode::CREATED);
    let team_id = team.json::<serde_json::Value>()["id"].as_i64().unwrap() as i32;

    let proj = server
        .post("/api/v1/projects")
        .add_header("authorization", format!("Bearer {}", token))
        .json(&serde_json::json!({"name": format!("LT项目_t8_{uuid}"), "team_id": team_id}))
        .await;
    assert_eq!(proj.status_code(), axum::http::StatusCode::CREATED);
    let pid = proj.json::<serde_json::Value>()["id"].as_i64().unwrap() as i32;
    (pid, team_id, token)
}

// ── Task 6：用例公共脚手架 ──

/// 用例环境：app state + fixture 项目坐标 + 本次运行唯一 uuid + stub 句柄。
struct T8Env {
    state: llm_wiki_server::AppState,
    pid: i32,
    team_id: i32,
    /// 每次运行唯一 uuid，内嵌进 fixture source 文本——`ingest:cache:{content_hash}`
    /// 是无 project 维度的全局 Redis 键（TTL 7 天），不嵌则重跑/并行同内容互相污染
    /// （症状：第一次过、重跑挂，评审 C-2）。
    run: String,
    stub: tokio::task::JoinHandle<()>,
}

/// 组装公共前置：生成 run uuid → stub（脚本由 uuid 现场构建——FILE 块正文同样
/// 内嵌 run-uuid，与 DB 断言侧的模板函数共用一套构造，杜绝脚本/断言漂移）→
/// app/state → fixture 项目 → 经 providers HTTP API 把 team provider 指到 stub 根
/// （provider_type openai，base_url=stub 根；llm_stream 拼接 `{base}/chat/completions`
/// 命中 stub 路由，见 spawn_stub_chat_server 注释；api_key 任意非空、model 任意——
/// stub 不校验）。
async fn t8_prepare<F>(script_of: F) -> T8Env
where
    F: FnOnce(&str) -> Vec<StubResp>,
{
    let run = uuid::Uuid::new_v4().simple().to_string();
    let (stub_root, stub) = spawn_stub_chat_server(script_of(&run)).await;
    let (app, state) = crate::setup_test_app().await;
    let (pid, team_id, token) = t8_setup_project(&state).await;
    let server = axum_test::TestServer::new(app).unwrap();
    let r = server
        .post(&format!("/api/v1/teams/{}/llm-providers", team_id))
        .add_header("authorization", format!("Bearer {}", token))
        .json(&serde_json::json!({
            "provider_type": "openai",
            "api_key": "sk-t8-stub",
            "base_url": stub_root,
            "model": "t8-stub-model",
        }))
        .await;
    assert_eq!(
        r.status_code(),
        axum::http::StatusCode::CREATED,
        "team provider 创建失败: {}",
        r.text()
    );
    T8Env {
        state,
        pid,
        team_id,
        run,
        stub,
    }
}

/// 经 storage 后端写 fixture source（LocalStorage 落 /tmp/llmwiki_storage，
/// 与 run_ingest_job 的 read_bytes 同一后端，无视图漂移）。dyn Trait 接收者上
/// 调 trait 方法无需 use 引入（类型即作用域），故无内部 use 行。
async fn t8_write_source(env: &T8Env, rel: &str, content: &str) {
    env.state
        .storage
        .write_string(env.team_id, env.pid, rel, content)
        .await
        .expect("storage write_string fixture source");
}

/// 直接 INSERT ingest_jobs 行 + 直接调 run_ingest_job（不经 worker / 不 HTTP
/// enqueue——编排铁律 C-3：enqueue 会 LPUSH 进共享 live Redis 被 launchd worker
/// 抢走，对进程内 stub 形成双跑竞态）。模式照 ingest_reliability_test:198-217。
/// 失败即 panic（携带 Err 全文，all-failed 报文已并入 warnings 便于诊断）。
/// 终态落库（终审 F2）：run_ingest_job 本身不写终态（终态在 worker 层 finalize，
/// 测试直调绕过 worker）——不补 UPDATE 则行永久停留 running，每轮测试向 live 库
/// 写残留，server 重启被 recover_pending 重投（噪音）。Ok → succeeded；Err →
/// failed + error 列留诊断（同 mark_job_failed 的列形态），落库后再 panic 上抛。
async fn t8_insert_and_run(
    env: &T8Env,
    source: &str,
) -> llm_wiki_server::services::ingest_queue::IngestJobResult {
    let job_id = uuid::Uuid::new_v4();
    sqlx::query(
        "INSERT INTO ingest_jobs (id, project_id, source_paths, status) \
         VALUES ($1, $2, ARRAY[$3], 'running')",
    )
    .bind(job_id)
    .bind(env.pid)
    .bind(source)
    .execute(&env.state.db)
    .await
    .expect("insert ingest_jobs 行");
    let job: llm_wiki_server::services::ingest_queue::IngestJob =
        sqlx::query_as("SELECT * FROM ingest_jobs WHERE id=$1")
            .bind(job_id)
            .fetch_one(&env.state.db)
            .await
            .expect("回读 IngestJob");
    match llm_wiki_server::services::ingest_pipeline::run_ingest_job(&env.state, &job).await {
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
            panic!("run_ingest_job 应返回 Ok（脚本内全成功路径；Err 含 warnings 诊断）: {e}")
        }
    }
}

/// 取 DB 页行 (content, sources, created_at, updated_at)。
async fn t8_fetch_page(
    env: &T8Env,
    path: &str,
) -> (
    String,
    serde_json::Value,
    chrono::DateTime<chrono::Utc>,
    chrono::DateTime<chrono::Utc>,
) {
    sqlx::query_as(
        "SELECT content, sources, created_at, updated_at FROM wiki_pages \
         WHERE project_id=$1 AND path=$2",
    )
    .bind(env.pid)
    .bind(path)
    .fetch_one(&env.state.db)
    .await
    .expect("wiki_pages 行应存在")
}

/// step1 最小合法输出（对象形状即过 merged_step1_result 守卫；空数组无实体，
/// step2 prompt 仅透传 analysis，stub 不消费请求内容）。
fn t8_step1_json() -> String {
    r#"{"entities":[],"connections":[],"contradictions":[]}"#.to_string()
}

/// step2 单 FILE 块（对齐 parse_file_blocks/parse_single_block：`---FILE: path ---`
/// 开行 + YAML frontmatter（首个 `\n---\n` 分割）+ body + `---END FILE---` 收行）。
/// 单块 + 数百字符，远低于 dedicated review 阈值（≥4 块或 ≥10000 字符）。
/// sources 用 JSON 数组字面量——同是合法 YAML flow 序列。
/// 落库 content 恰为 `{body}\n`（解析器逐行 push 且 END 行不计入）。
fn t8_file_block(path: &str, title: &str, sources: &[&str], body: &str) -> String {
    let srcs = serde_json::to_string(&sources).unwrap();
    format!(
        "---FILE: {path} ---\n---\ntitle: {title}\ntype: concept\nsources: {srcs}\n---\n{body}\n---END FILE---\n"
    )
}

// ── Task 6：四用例。正文模板单一来源（脚本构造与 DB 断言共用，防漂移）──

/// A 版正文关键词「视频课视角」（case 1 融合断言锚点）。
fn t8_a_body(run: &str) -> String {
    format!("A 版正文（视频课视角）核心论点与例证 [run-{run}]")
}
/// B 版正文关键词「文字稿视角」（case 1/4 融合断言锚点）。
fn t8_b_body(run: &str) -> String {
    format!("B 版正文（文字稿视角）补充细节与数据 [run-{run}]")
}
/// merge(A+B) 输出：同时含两版关键词（case 1 content 断言）。
fn t8_ab_merged(run: &str) -> String {
    format!("A+B 融合正文：视频课视角核心论点 + 文字稿视角补充细节 [run-{run}]")
}
/// case 3 的 v2 改写正文（单源重生成）。
fn t8_v2_body(run: &str) -> String {
    format!("Ch01 第二版正文（观点修正）[run-{run}-v2]")
}
/// case 4 的 A2 改写正文。
fn t8_a2_body(run: &str) -> String {
    format!("A2 版正文（第二版改写）核心论点 [run-{run}-a2]")
}
/// case 4 的 merge(A2+AB) 终态：保留 B 补充细节（B 存续断言锚点）。
fn t8_a2b_merged(run: &str) -> String {
    format!("A2B 融合正文：第二版核心论点 + B 补充细节 [run-{run}]")
}

/// warnings 里是否有含指定子串的条目（embedding 失败等无关 warning 不影响判断——
/// 只做特定子串断言，绝不断言 warnings 为空）。
fn t8_has_warning(res: &llm_wiki_server::services::ingest_queue::IngestJobResult, sub: &str) -> bool {
    res.warnings.iter().any(|w| w.contains(sub))
}

/// case 1：跨源碰撞走 merge——sources 并集、融合内容、只进 merged_pages。
/// job1（Ch01 建页）+ job2（Ch02 撞入）两 job 分别 INSERT+run；断言全对 job2。
#[tokio::test]
#[ignore = "requires PG + Redis"]
async fn t8_merge_success_accumulates() {
    let ch1 = "raw/sources/t8-book/Ch01.md";
    let ch2 = "raw/sources/t8-book/Ch02.md";
    let page = "concepts/t8-demo.md";
    let env = t8_prepare(|run| {
        vec![
            // job1（Ch01 建页）：step1 + step2
            StubResp::Text(t8_step1_json()),
            StubResp::Text(t8_file_block(page, "A", &[ch1], &t8_a_body(run))),
            // job2（Ch02 撞入）：step1 + step2 + merge
            StubResp::Text(t8_step1_json()),
            StubResp::Text(t8_file_block(page, "B", &[ch2], &t8_b_body(run))),
            StubResp::Text(t8_ab_merged(run)),
        ]
    })
    .await;
    t8_write_source(&env, ch1, &format!("Ch01 原文（第一章）[run-{}]", env.run)).await;
    t8_write_source(&env, ch2, &format!("Ch02 原文（第二章）[run-{}]", env.run)).await;

    t8_insert_and_run(&env, ch1).await; // job1 建页（new_pages 必含，不针对它断言）
    let r2 = t8_insert_and_run(&env, ch2).await; // job2 撞入

    let (content, sources, created_at, updated_at) = t8_fetch_page(&env, page).await;
    assert_eq!(
        sources,
        serde_json::json!([ch1, ch2]),
        "sources 应为并集序（existing 在前、当前源尾插）"
    );
    assert!(
        content.contains("视频课视角") && content.contains("文字稿视角"),
        "content 应同时含 A/B 关键词，got: {content}"
    );
    assert!(
        r2.merged_pages.iter().any(|p| p == page),
        "job2 result.merged_pages 应含 {page}，got: {:?}",
        r2.merged_pages
    );
    assert!(
        !r2.new_pages.iter().any(|p| p == page),
        "job2 result.new_pages 不应含 {page}（只进 merged_pages）"
    );
    assert!(updated_at > created_at, "合并写入应推进 updated_at");
    assert!(
        !t8_has_warning(&r2, "fallback replace"),
        "job2 warnings 不应含 fallback replace: {:?}",
        r2.warnings
    );
    crate::teardown_test_data(&env.state).await;
    env.stub.abort(); // 收掉进程内 stub（兼读字段，免 dead_code）
}

/// case 2：merge 调用 500 → 整页回退——content/sources 均 incoming 原样（非并集），
/// merged_pages 空、warnings 留「fallback replace」痕（评审 I1）。
#[tokio::test]
#[ignore = "requires PG + Redis"]
async fn t8_merge_fallback_replaces_wholesale() {
    let ch1 = "raw/sources/t8-book/Ch01.md";
    let ch2 = "raw/sources/t8-book/Ch02.md";
    let page = "concepts/t8-demo.md";
    let env = t8_prepare(|run| {
        vec![
            // job1（Ch01 建页）
            StubResp::Text(t8_step1_json()),
            StubResp::Text(t8_file_block(page, "A", &[ch1], &t8_a_body(run))),
            // job2（Ch02 撞入）：step1 + step2，merge 调用直接 500
            StubResp::Text(t8_step1_json()),
            StubResp::Text(t8_file_block(page, "B", &[ch2], &t8_b_body(run))),
            StubResp::Error(500),
        ]
    })
    .await;
    t8_write_source(&env, ch1, &format!("Ch01 原文（第一章）[run-{}]", env.run)).await;
    t8_write_source(&env, ch2, &format!("Ch02 原文（第二章）[run-{}]", env.run)).await;

    t8_insert_and_run(&env, ch1).await;
    let r2 = t8_insert_and_run(&env, ch2).await;

    let (content, sources, _c, _u) = t8_fetch_page(&env, page).await;
    assert_eq!(
        content,
        format!("{}\n", t8_b_body(&env.run)),
        "回退应整页 incoming 原样（parse_single_block 落库恰为 body+\\n）"
    );
    assert_eq!(
        sources,
        serde_json::json!([ch2]),
        "回退 sources 应为 incoming 单源（非并集）"
    );
    assert!(
        r2.merged_pages.is_empty(),
        "回退不产生 merged_pages，got: {:?}",
        r2.merged_pages
    );
    assert!(
        t8_has_warning(&r2, "fallback replace"),
        "job2 warnings 应留 fallback replace 痕: {:?}",
        r2.warnings
    );
    crate::teardown_test_data(&env.state).await;
    env.stub.abort(); // 收掉进程内 stub（兼读字段，免 dead_code）
}

/// case 3：单源重生成走 Replace——同 source path 内容改写（hash 变）重摄，
/// content 为 v2 原样、merged_pages 空、**无** fallback replace warning（评审 I-6：
/// stub 耗尽 500 触发的回退终态与正确 Replace 一致，只能靠 warnings 区分）。
#[tokio::test]
#[ignore = "requires PG + Redis"]
async fn t8_single_source_regeneration_replaces() {
    let ch1 = "raw/sources/t8-book/Ch01.md";
    let page = "concepts/t8-demo.md";
    let env = t8_prepare(|run| {
        let v1 = format!("Ch01 第一版正文（初始观点）[run-{run}-v1]");
        vec![
            // job1（Ch01 v1 建页）
            StubResp::Text(t8_step1_json()),
            StubResp::Text(t8_file_block(page, "A", &[ch1], &v1)),
            // job2（同一 source path、内容改写 → Replace，零 merge 调用——脚本恰 4 响）
            StubResp::Text(t8_step1_json()),
            StubResp::Text(t8_file_block(page, "A2", &[ch1], &t8_v2_body(run))),
        ]
    })
    .await;
    t8_write_source(&env, ch1, &format!("Ch01 原文 v1（第一版）[run-{}-v1]", env.run)).await;
    t8_insert_and_run(&env, ch1).await; // job1 建页

    // 重写 storage 同 path 内容（hash 变）→ 再 INSERT 再跑（job2）
    t8_write_source(&env, ch1, &format!("Ch01 原文 v2（观点修正版）[run-{}-v2]", env.run)).await;
    let r2 = t8_insert_and_run(&env, ch1).await;

    let (content, sources, _c, _u) = t8_fetch_page(&env, page).await;
    assert_eq!(
        content,
        format!("{}\n", t8_v2_body(&env.run)),
        "单源重生成应 Replace 为 v2 原样"
    );
    assert_eq!(sources, serde_json::json!([ch1]));
    assert!(
        r2.merged_pages.is_empty(),
        "Replace 不产生 merged_pages，got: {:?}",
        r2.merged_pages
    );
    assert!(
        !t8_has_warning(&r2, "fallback replace"),
        "Replace 与回退终态一致，唯一区分是 warnings 不含 fallback replace: {:?}",
        r2.warnings
    );
    assert!(
        r2.new_pages.iter().any(|p| p == page),
        "Replace 落库进 new_pages（记录 Replace 语义）"
    );
    crate::teardown_test_data(&env.state).await;
    env.stub.abort(); // 收掉进程内 stub（兼读字段，免 dead_code）
}

/// case 4：A→B→A2 序列——B 撞入融合后，A 改写重摄（A2 对 AB 融合），
/// B 内容存续且无逐字膨胀、sources 保持两源并集。
#[tokio::test]
#[ignore = "requires PG + Redis"]
async fn t8_sequence_a_b_a2_preserves_b() {
    let src_a = "raw/sources/t8-book/A.md";
    let src_b = "raw/sources/t8-book/B.md";
    let page = "concepts/t8-demo.md";
    let env = t8_prepare(|run| {
        vec![
            // job A（建页）
            StubResp::Text(t8_step1_json()),
            StubResp::Text(t8_file_block(page, "A", &[src_a], &t8_a_body(run))),
            // job B（撞入，merge A+B）
            StubResp::Text(t8_step1_json()),
            StubResp::Text(t8_file_block(page, "B", &[src_b], &t8_b_body(run))),
            StubResp::Text(t8_ab_merged(run)),
            // job A2（A 内容改写重摄，merge A2+AB）
            StubResp::Text(t8_step1_json()),
            StubResp::Text(t8_file_block(page, "A2", &[src_a], &t8_a2_body(run))),
            StubResp::Text(t8_a2b_merged(run)),
        ]
    })
    .await;
    t8_write_source(&env, src_a, &format!("A 原文 v1（第一版）[run-{}-a1]", env.run)).await;
    t8_write_source(&env, src_b, &format!("B 原文（补充源）[run-{}-b]", env.run)).await;

    t8_insert_and_run(&env, src_a).await; // job A 建页
    t8_insert_and_run(&env, src_b).await; // job B 撞入（merge A+B）
    let (ab_content, ab_sources, _c, _u) = t8_fetch_page(&env, page).await;
    assert_eq!(ab_sources, serde_json::json!([src_a, src_b]), "job B 后应已是两源并集");

    // A 内容改写（hash 变）→ job A2 重摄
    t8_write_source(&env, src_a, &format!("A 原文 v2（第二版改写）[run-{}-a2]", env.run)).await;
    let r3 = t8_insert_and_run(&env, src_a).await;

    let (content, sources, _c2, _u2) = t8_fetch_page(&env, page).await;
    assert!(
        content.contains("B 补充细节"),
        "A2 重摄后 B 内容应存续，got: {content}"
    );
    assert!(
        content.chars().count() < t8_a2_body(&env.run).chars().count() + ab_content.chars().count(),
        "融合终态应短于两版之和（无逐字膨胀）：{} vs {}+{}",
        content.chars().count(),
        t8_a2_body(&env.run).chars().count(),
        ab_content.chars().count()
    );
    assert_eq!(
        sources,
        serde_json::json!([src_a, src_b]),
        "A2 重摄后 sources 保持两源并集"
    );
    assert!(
        r3.merged_pages.iter().any(|p| p == page),
        "job A2 应走 merge（existing {src_a},{src_b} 与 incoming {src_a} 集合不等），got: {:?}",
        r3.merged_pages
    );
    assert!(
        !t8_has_warning(&r3, "fallback replace"),
        "job A2 warnings 不应含 fallback replace: {:?}",
        r3.warnings
    );
    crate::teardown_test_data(&env.state).await;
    env.stub.abort(); // 收掉进程内 stub（兼读字段，免 dead_code）
}
