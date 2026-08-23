pub mod auth_test;
pub mod ingest_queue_test;
pub mod ingest_reliability_test;
pub mod ingest_test;
pub mod pages_test;
pub mod files_stat_test;
pub mod files_raw_test;
pub mod files_list_test;
pub mod files_fresh_project_test;
pub mod projects_list_test;
pub mod chat_stream_test;
pub mod servedir_test;
mod chat_sessions_test;
mod reviews_test;
mod permissions_test;
mod research_test;
mod registration_gate_test;
mod techdebt_r3_test;
mod token_cleanup_test;
mod training_test;
mod learning_api_test;
mod media_test;
mod t_page_test;
pub mod merge_ingest_test;

use axum::Router;
use llm_wiki_server::AppState;

/// 测试数据 teardown（测试卫生）：按五套 unique() 的实际前缀清理积累的测试行——
/// `t6_`（training_test）、`t3_`（training_test M3 Task 3，bind 教师 unique_t3）、
/// `t7_`（learning_api_test + media_test）、`t9_`（t_page_test）、
/// `t8_`（merge_ingest_test）。
///
/// 前缀落点（grep 五套 unique() 的实际用途）：
/// - users.username：注册用户 = `t*_*_*`；bind 合成用户 = `wecom_t*_*`
///   （超长 wecom_userid 按 chars 截断后，username 只剩 `wecom_` + wid 前 30 chars +
///   digest，username 与 email 的起始 `t*_` 锚点都可能丢——见下）；
/// - users.email：`t*_*@t*.com`（注册）/ `t*_*@wecom.local`（bind）。username 用起始
///   锚定 `t*\_%` / `wecom_t*\_%`，但 email 必须非锚定 `%t*\_%`：bind 截断分支合成
///   email = `{全量 wid}@wecom.local`，wid 前段是任意业务串（如 CJK 混排测试输入）时
///   email 起始无 `t*_`，起始锚定永远匹配不上、每轮净漏删；非锚定 % 通配理论上有
///   误删面，但测试 email 域仅 @t*.com / @wecom.local，真实用户 email 不可能含
///   `t3_`/`t6_`/`t7_`/`t8_`/`t9_` 测试前缀串，安全；
/// - projects.name：fixtures 统一 `LT项目_<owner_name>`（projects.created_by 无级联，
///   残留项目会挡住 users 删除，故最先删；wiki_pages/embeddings 等随项目级联）；
/// - media_assets.slug：无 user FK，独立按 slug 清。
/// teams/team_members/refresh_tokens/teacher_profiles/learning_plans/items/events/
/// short_links/chat_* 均随 users ON DELETE CASCADE，无需单列。
///
/// 并行安全：cargo 并行执行 #[tokio::test]，无条件按前缀删会误删其他在飞测试的行。
/// cutoff 取「本测试二进制首次 teardown 时刻 - 60s」（DB/客户端钟差余量）——只清
/// 历史残留；本次运行新建的行留给下一轮收尾（稳态：每轮清上一轮，不再无限累积）。
/// 在飞测试的行 created_at > cutoff，永不被触碰。
///
/// 范围边界（评审 F6）：SWEEPS 只覆盖 LT 域五前缀族（t3_/t6_/t7_/t8_/t9_）；同二进制
/// 内 M1/M2 域测试（permissions/reviews/research/chat_sessions 等，tag 形如
/// `rev-insert`/`perm-mgmt`）不经本函数清理，每轮净积累——已知取舍，勿误以为
/// 本函数是全二进制卫生机制；如需收口可为那些文件统一前缀并入 SWEEPS。
pub async fn teardown_test_data(state: &AppState) {
    use std::sync::OnceLock;
    static CUTOFF: OnceLock<chrono::DateTime<chrono::Utc>> = OnceLock::new();
    let cutoff = *CUTOFF.get_or_init(|| chrono::Utc::now() - chrono::Duration::seconds(60));

    const SWEEPS: [&str; 3] = [
        // 1) projects 先删：created_by 无级联，残留会让 users 删除撞 FK
        "DELETE FROM projects WHERE created_at < $1 AND (\
             name LIKE 'LT项目_t3\\_%' OR name LIKE 'LT项目_t6\\_%' \
             OR name LIKE 'LT项目_t7\\_%' OR name LIKE 'LT项目_t9\\_%' \
             OR name LIKE 'LT项目_t8\\_%')",
        // 2) users：注册（username/email）+ bind 合成（wecom_ 前缀 username / wecom.local email）。
        //    email 非锚定 '%t*\_%'：bind 截断分支 email = {全量 wid}@wecom.local，起始可能是
        //    任意业务串（无 t*_ 锚点），起始锚定漏删；测试 email 域仅 @t*.com/@wecom.local，
        //    真实用户不含 t3_/t6_ 等测试前缀串，非锚定无误删面（详见函数头注释）。
        "DELETE FROM users WHERE created_at < $1 AND (\
             username LIKE 't3\\_%' OR username LIKE 't6\\_%' \
             OR username LIKE 't7\\_%' OR username LIKE 't9\\_%' \
             OR username LIKE 't8\\_%' \
             OR username LIKE 'wecom_t3\\_%' OR username LIKE 'wecom_t6\\_%' \
             OR username LIKE 'wecom_t7\\_%' OR username LIKE 'wecom_t9\\_%' \
             OR email LIKE '%t3\\_%' OR email LIKE '%t6\\_%' \
             OR email LIKE '%t7\\_%' OR email LIKE '%t9\\_%' \
             OR email LIKE '%t8\\_%')",
        // 3) media_assets：无 user FK，按 slug 清
        "DELETE FROM media_assets WHERE created_at < $1 AND (\
             slug LIKE 't3\\_%' OR slug LIKE 't6\\_%' OR slug LIKE 't7\\_%' OR slug LIKE 't9\\_%' \
             OR slug LIKE 't8\\_%')",
    ];
    for sql in SWEEPS {
        sqlx::query(sql)
            .bind(cutoff)
            .execute(&state.db)
            .await
            .expect("teardown_test_data sweep failed");
    }
}

/// default.json 的 jwt.secret 已出库置空（M1 评审 #1：靠 env 注入倒逼非默认值）。
/// 测试二进制在 from_env 前统一注入非黑名单 secret；若外部已设置（本地调试覆盖）则不覆盖。
/// 同一二进制内并发测试 set 的是同一常量值，无实际竞争。
pub fn ensure_test_jwt_secret() {
    if std::env::var("JWT__SECRET").unwrap_or_default().is_empty() {
        std::env::set_var("JWT__SECRET", "integration_test_secret_not_for_prod_32b");
    }
}

/// 构建测试 app（连 live DB 5433 + Redis 6380，配置来自 config/default.json）。
/// default.json 已翻 registration_enabled=false（Task 6 r3 fail-closed；测试二进制
/// 不读 .env——from_env 无 dotenv），故 from_env 后显式注入 true 再 create_app，
/// 否则本文件 27 处 register_user 调用全 403。
pub async fn setup_test_app() -> (Router, AppState) {
    ensure_test_jwt_secret();
    let mut config = llm_wiki_server::AppConfig::from_env().expect("Failed to load test config");
    config.auth.registration_enabled = true;
    llm_wiki_server::create_app(config)
        .await
        .expect("Failed to create test app")
}

/// 注册用户，返回 access_token（register 响应已含 token，无需再 login）。
pub async fn register_user(
    server: &axum_test::TestServer,
    username: &str,
    email: &str,
    password: &str,
) -> String {
    let resp = server
        .post("/api/v1/auth/register")
        .content_type("application/json")
        .json(&serde_json::json!({"username":username,"email":email,"password":password}))
        .await;
    assert_eq!(resp.status_code(), axum::http::StatusCode::CREATED);
    resp.json::<serde_json::Value>()["access_token"]
        .as_str()
        .expect("access_token in response")
        .to_string()
}
