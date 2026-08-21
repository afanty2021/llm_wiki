//! Training 管线路由。
//! - POST /media-assets：批量 upsert（svc-transcriber 调用，LT team Admin 鉴权）
//! - POST /bind：企业微信侧幂等建号（TRAINING__ADMIN_TOKEN 鉴权 + refresh 轮换）
//! - M2 批1（Task 7，均 require_auth + user_id=claims.sub，token 即本人）：
//!   GET/PUT /profile（教师档案；onboarding_state 仅 pending→surveyed）、
//!   POST /events（仅 event_type="ask"，其余 400）、GET /progress（plans 概览 + 最近 20 事件）
//! - M2 批2（Task 8）：POST/GET /plans、GET /plans/:id、POST /plans/:id/link、
//!   POST /items/:id/complete（单调投影）、POST /progress/rebuild（事件重放重建投影，M2 调试）
//! - Task 9b：plans/link 响应的 link 字段改吐 `/s/<code>` 10 字符短链（同事务落
//!   short_links 表）。结构性根治：实测 LLM 转发 164-char `/t/<JWT>` 两次中途
//!   省略号截断致死链（SKILL 硬规则约束不住模型行为）——10 字符短码对任何
//!   模型/聊天应用的截断免疫。短码不过期（capability URL，与 /t/ token 同信任
//!   模型）：plan 存活期间每次点击由 GET /s/:code 现签新 7d /t/ token，链接
//!   永不失效；撤销 = 删 short_links 行或删 plan（FK 级联）。
//! - M3 Task 3：GET /overview（管理总览逐教师聚合，require_training_admin）+
//!   plans 创建 origin="weekly" 分支的 period_key 服务端自算（省略→自算落库；
//!   格式合法但≠当周→400 含 expected_period_key；格式非法→400）。

use axum::{extract::{Path, Query, State}, http::{HeaderMap, StatusCode}, routing::{get, post}, Json, Router};
use chrono::{Datelike as _, Duration as ChronoDuration};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::middleware::project_guard::{check_project_access_with_role, RequiredRole};
use crate::middleware::require_auth;
use crate::models::{AuthResponse, UserResponse};
use crate::{AppState, AppError};

pub fn training_routes() -> Router<AppState> {
    Router::new()
        .route("/media-assets", post(import_media_assets))
        .route("/bind", post(bind))
        .route("/profile", get(get_profile).put(update_profile))
        .route("/events", post(create_event))
        .route("/progress", get(get_progress))
        .route("/progress/rebuild", post(rebuild_progress))
        .route("/plans", post(create_plan).get(list_plans))
        .route("/plans/:id", get(get_plan))
        .route("/plans/:id/link", post(regen_plan_link))
        .route("/items/:id/complete", post(complete_item))
        .route("/overview", get(get_overview))
}

#[derive(Deserialize)]
pub struct MediaAssetItem {
    pub slug: String,
    pub media_ref: String,
    pub playback_path: Option<String>,
    pub duration_s: i32,
    pub codec: Option<String>,
    pub kind: String,
    pub chapters: serde_json::Value,
    pub transcript_page_path: Option<String>,
    pub source_path: Option<String>,
}

#[derive(Deserialize)]
pub struct ImportRequest {
    pub items: Vec<MediaAssetItem>,
}

/// POST /api/v1/training/media-assets — 批量 upsert（ON CONFLICT (slug)），响应 `{"imported": N}`。
/// 鉴权：TRAINING__PROJECT_ID 所指项目的 Admin（owner 亦可通过，role_meets 语义）。
async fn import_media_assets(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<ImportRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let project_id = state
        .config
        .training
        .project_id
        .ok_or_else(|| AppError::InternalError("TRAINING__PROJECT_ID not configured".into()))?;
    let _ = check_project_access_with_role(&state, &headers, project_id, RequiredRole::Admin).await?;
    if req.items.is_empty() {
        return Err(AppError::BadRequest("items is empty".into()));
    }
    // 批量原子：中途 Err 提前返回 → tx drop 回滚，不落半批。
    let mut tx = state.db.begin().await.map_err(AppError::from)?;
    for it in &req.items {
        if !(it.kind == "video" || it.kind == "audio") {
            return Err(AppError::BadRequest(format!("bad kind: {}", it.kind)));
        }
        // 长度校验（400 而非 DB 22001→500）：slug VARCHAR(255)，业务上限 200 chars 留余量；
        // 按 chars 计数（列宽语义）。批量原子：中途 400 → tx drop 回滚，不落半批。
        if it.slug.chars().count() > 200 {
            return Err(AppError::BadRequest(format!(
                "slug exceeds 200 characters: {}...",
                it.slug.chars().take(32).collect::<String>()
            )));
        }
        // playback_path 用 COALESCE：常规 transcribe CLI 发 None，不得清空 demo/人工
        // 补登的转码覆盖值（Some 才覆盖——demo 模式注册逻辑不变）；其余列照常覆盖。
        sqlx::query(
            "INSERT INTO media_assets (slug, media_ref, playback_path, duration_s, codec, kind, chapters, transcript_page_path, source_path) \
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) \
             ON CONFLICT (slug) DO UPDATE SET media_ref=EXCLUDED.media_ref, \
               playback_path=COALESCE(EXCLUDED.playback_path, media_assets.playback_path), \
               duration_s=EXCLUDED.duration_s, codec=EXCLUDED.codec, kind=EXCLUDED.kind, chapters=EXCLUDED.chapters, \
               transcript_page_path=EXCLUDED.transcript_page_path, source_path=EXCLUDED.source_path, updated_at=NOW()",
        )
        .bind(&it.slug)
        .bind(&it.media_ref)
        .bind(&it.playback_path)
        .bind(it.duration_s)
        .bind(&it.codec)
        .bind(&it.kind)
        .bind(&it.chapters)
        .bind(&it.transcript_page_path)
        .bind(&it.source_path)
        .execute(&mut *tx)
        .await
        .map_err(AppError::from)?;
    }
    tx.commit().await.map_err(AppError::from)?;
    Ok(Json(serde_json::json!({ "imported": req.items.len() })))
}

// ============ Task 8：POST /api/v1/training/bind ============

#[derive(Deserialize)]
pub struct BindRequest {
    pub wecom_userid: String,
    pub display_name: Option<String>,
}

/// 校验 TRAINING__ADMIN_TOKEN（企业微信侧管理凭据）。
/// - 未配置 → InternalError（fail closed：宁可拒绝服务也不放行无凭据请求）
/// - 不匹配 → 401 AuthInvalid + warn 日志（拒绝原因不回传客户端，防探测）
///   注：brief 草图写 PermissionDenied，但 error.rs 将其映射为 403；缺失/错误凭据
///   语义上是 401（brief 测试与验收矩阵均断言 401），故取 AuthInvalid。
fn require_training_admin(state: &AppState, headers: &HeaderMap) -> Result<(), AppError> {
    let expect = &state.config.training.admin_token;
    if expect.is_empty() {
        return Err(AppError::InternalError(
            "TRAINING__ADMIN_TOKEN not configured".into(),
        ));
    }
    let got = headers
        .get("x-training-admin-token")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    // ct_eq 对长度不同的输入返回 0（无泄漏、无 panic）
    if subtle::ConstantTimeEq::ct_eq(expect.as_bytes(), got.as_bytes()).into() {
        Ok(())
    } else {
        tracing::warn!("bind rejected: invalid training admin token");
        Err(AppError::AuthInvalid("Invalid training admin token".into()))
    }
}

/// POST /api/v1/training/bind — 幂等绑定企业微信教师账号（svc-wecom 调用）。
/// 已绑定 → 复用账号并轮换全部活跃 refresh（重发即安全：旧 token 全废）；
/// 未绑定 → 合成不可登录密码账号 + LT team member + teacher_profiles(pending)。
/// 不建 personal team（区别于 /auth/register）。所有写库走同一事务：中途失败
/// 不留半账号，重 bind 幂等自愈（team_members ON CONFLICT DO NOTHING 兜底补写）。
async fn bind(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<BindRequest>,
) -> Result<Json<AuthResponse>, AppError> {
    require_training_admin(&state, &headers)?;
    if req.wecom_userid.trim().is_empty() {
        return Err(AppError::BadRequest("wecom_userid is empty".into()));
    }
    // 长度校验（400 而非 DB 22001→500）：wecom_userid 业务上限 64 chars（列宽 VARCHAR(100)，
    // 且合成 email {wid}@wecom.local ≤ 76 < 100）；display_name 进 users.full_name 与
    // teacher_profiles.display_name（均 VARCHAR(100)）。按 chars 计数（列宽语义）。
    if req.wecom_userid.chars().count() > 64 {
        return Err(AppError::BadRequest("wecom_userid exceeds 64 characters".into()));
    }
    if req.display_name.as_ref().is_some_and(|n| n.chars().count() > 100) {
        return Err(AppError::BadRequest("display_name exceeds 100 characters".into()));
    }
    let project_id = state
        .config
        .training
        .project_id
        .ok_or_else(|| AppError::InternalError("TRAINING__PROJECT_ID not configured".into()))?;
    let team_id: i32 = sqlx::query_scalar("SELECT team_id FROM projects WHERE id = $1")
        .bind(project_id)
        .fetch_one(&state.db)
        .await
        .map_err(AppError::from)?;

    let mut tx = state.db.begin().await.map_err(AppError::from)?;

    // 并发竞态修复：事务级 advisory lock 串行化同 wecom_userid 的并发 bind。
    // FOR UPDATE 锁不住不存在的行（READ COMMITTED 下 absent-row 不加锁），且旧的
    // existing 查询跑在池连接上（不在事务内）——并发新用户会双双 INSERT → 23505 → 500。
    // pg_advisory_xact_lock 随事务提交/回滚自动释放，key = hashtextextended(wecom_userid)。
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(&req.wecom_userid)
        .execute(&mut *tx)
        .await
        .map_err(AppError::from)?;
    // 存量检查移入事务（锁后）：第二个并发请求在此看到第一个已提交的档案
    let existing: Option<i32> =
        sqlx::query_scalar("SELECT user_id FROM teacher_profiles WHERE wecom_userid = $1")
            .bind(&req.wecom_userid)
            .fetch_optional(&mut *tx)
            .await
            .map_err(AppError::from)?;

    let (user_id, username) = if let Some(uid) = existing {
        let uname: String = sqlx::query_scalar("SELECT username FROM users WHERE id = $1")
            .bind(uid)
            .fetch_one(&state.db)
            .await
            .map_err(AppError::from)?;
        // 轮换：废全部活跃 refresh；heal：team_members 若曾被中断则补写
        sqlx::query(
            "UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL",
        )
        .bind(uid)
        .execute(&mut *tx)
        .await
        .map_err(AppError::from)?;
        sqlx::query(
            "INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member') \
             ON CONFLICT DO NOTHING",
        )
        .bind(team_id)
        .bind(uid)
        .execute(&mut *tx)
        .await
        .map_err(AppError::from)?;
        (uid, uname)
    } else {
        // 合成唯一 username（users.username VARCHAR(50)）：超长时 chars 截断（禁字节切片，
        // 防切在多字节字符边界 panic）+ sha256 前 8 hex 保唯一性；
        // 密码为随机 64 hex、永不外发 → 合成账号无法用密码登录。
        let digest8 = &hex::encode(Sha256::digest(req.wecom_userid.as_bytes()))[..8]; // hex 为 ASCII，切片安全
        let username = if req.wecom_userid.chars().count() + 6 > 50 {
            format!(
                "wecom_{}_{}",
                req.wecom_userid.chars().take(30).collect::<String>(),
                digest8
            )
        } else {
            format!("wecom_{}", req.wecom_userid)
        };
        let email = format!("{}@wecom.local", req.wecom_userid);
        let password = hex::encode(rand::random::<[u8; 32]>());
        let password_hash = crate::utils::hash_password(&password)?;
        // 兜底（belt-and-braces）：advisory lock 之外的残余 23505（如 hashtextextended
        // 碰撞、绕过路由的并发路径）映射 409 而非 500；提前 return → tx drop 回滚，
        // 不留半账号，重 bind 幂等自愈走既有档案路径。模式见 llm_providers.rs create_provider。
        // 409 文案中性（Task 6 r3）：该 23505 可能来自 users（username/email 占用）或
        // teacher_profiles（wecom_userid 已绑定）任一约束——「已被占用或已绑定」不向
        // 调用方泄漏具体命中哪张表。
        let row: Result<i32, sqlx::Error> = sqlx::query_scalar(
            "INSERT INTO users (username, email, password_hash, full_name) \
             VALUES ($1, $2, $3, $4) RETURNING id",
        )
        .bind(&username)
        .bind(&email)
        .bind(&password_hash)
        .bind(&req.display_name)
        .fetch_one(&mut *tx)
        .await;
        let row: i32 = match row {
            Ok(r) => r,
            Err(sqlx::Error::Database(e)) if e.is_unique_violation() => {
                return Err(AppError::Conflict("已被占用或已绑定".into()));
            }
            Err(e) => return Err(AppError::from(e)),
        };
        sqlx::query(
            "INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member') \
             ON CONFLICT DO NOTHING",
        )
        .bind(team_id)
        .bind(row)
        .execute(&mut *tx)
        .await
        .map_err(AppError::from)?;
        let profile: Result<sqlx::postgres::PgQueryResult, sqlx::Error> = sqlx::query(
            "INSERT INTO teacher_profiles (user_id, wecom_userid, display_name) \
             VALUES ($1, $2, $3)",
        )
        .bind(row)
        .bind(&req.wecom_userid)
        .bind(&req.display_name)
        .execute(&mut *tx)
        .await;
        match profile {
            Ok(_) => {}
            Err(sqlx::Error::Database(e)) if e.is_unique_violation() => {
                // 中性文案（Task 6 r3，与 users 分支同串）：不泄漏具体命中哪张表的唯一约束
                return Err(AppError::Conflict("已被占用或已绑定".into()));
            }
            Err(e) => return Err(AppError::from(e)),
        }
        (row, username)
    };

    // 发 token（同 auth.rs 模式）；refresh 写入同一事务，与轮换原子
    let secret = state.config.jwt_secret();
    let access_ttl_secs = state.config.jwt_access_token_ttl().as_secs();
    let refresh_ttl_secs = state.config.jwt_refresh_token_ttl().as_secs();

    let access_token = crate::utils::generate_access_token(
        user_id,
        &username,
        secret,
        ChronoDuration::seconds(access_ttl_secs as i64),
    )?;
    let (refresh_token, _jti) = crate::utils::generate_refresh_token(
        user_id,
        secret,
        ChronoDuration::seconds(refresh_ttl_secs as i64),
    )?;
    let token_hash = crate::utils::hash_refresh_token(&refresh_token);
    let expires_at = chrono::Utc::now() + ChronoDuration::seconds(refresh_ttl_secs as i64);
    sqlx::query("INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)")
        .bind(user_id)
        .bind(&token_hash)
        .bind(expires_at)
        .execute(&mut *tx)
        .await
        .map_err(AppError::from)?;
    tx.commit().await.map_err(AppError::from)?;

    // commit 后读库组装响应（UserResponse 为 FromRow，直接 query_as 五字段）
    let user: UserResponse = sqlx::query_as(
        "SELECT id, username, email, full_name, created_at FROM users WHERE id = $1",
    )
    .bind(user_id)
    .fetch_one(&state.db)
    .await
    .map_err(AppError::from)?;

    Ok(Json(AuthResponse {
        access_token,
        refresh_token,
        expires_in: access_ttl_secs,
        user,
    }))
}

// ============ M3 Task 3：GET /api/v1/training/overview（管理总览） ============

/// overview 直读行（单条聚合 SQL）。三个**预聚合子查询**分别算 plans/items 全期、
/// items_7d、事件时间——若平铺 JOIN（plans×items）×（7d plans×items）×events，
/// 行间笛卡尔积会虚增全部 COUNT；子查询按 user_id 各自 GROUP BY 后再 LEFT JOIN，
/// 教师侧无扇出（每教师恰一行）。
#[derive(sqlx::FromRow)]
struct OverviewRow {
    wecom_userid: String,
    display_name: Option<String>,
    onboarding_state: String,
    plans_total: i64,
    items_total: i64,
    items_viewed: i64,
    items_completed: i64,
    items_7d_total: i64,
    items_7d_viewed: i64,
    items_7d_completed: i64,
    last_active_at: Option<chrono::DateTime<chrono::Utc>>,
    last_ask_at: Option<chrono::DateTime<chrono::Utc>>,
}

/// items_7d 口径（评审 sub-80）：learning_items 无 created_at 列，代理口径 =
/// **近 7 天创建的 plan 的 items**（子查询 p7：`learning_plans.created_at >=
/// NOW() - INTERVAL '7 days'` 再 JOIN items 按状态计数）——"本周新建清单里的
/// 条目"，与周报语义自洽。
const OVERVIEW_SQL: &str = "\
SELECT tp.wecom_userid, tp.display_name, tp.onboarding_state, \
       COALESCE(pi.plans_total, 0) AS plans_total, \
       COALESCE(pi.items_total, 0) AS items_total, \
       COALESCE(pi.items_viewed, 0) AS items_viewed, \
       COALESCE(pi.items_completed, 0) AS items_completed, \
       COALESCE(p7.items_total, 0) AS items_7d_total, \
       COALESCE(p7.items_viewed, 0) AS items_7d_viewed, \
       COALESCE(p7.items_completed, 0) AS items_7d_completed, \
       ev.last_active_at, ev.last_ask_at \
FROM teacher_profiles tp \
LEFT JOIN ( \
  SELECT p.user_id, \
         COUNT(DISTINCT p.id) AS plans_total, \
         COUNT(i.id) AS items_total, \
         COUNT(i.id) FILTER (WHERE i.status = 'viewed') AS items_viewed, \
         COUNT(i.id) FILTER (WHERE i.status = 'completed') AS items_completed \
  FROM learning_plans p \
  LEFT JOIN learning_items i ON i.plan_id = p.id \
  GROUP BY p.user_id \
) pi ON pi.user_id = tp.user_id \
LEFT JOIN ( \
  SELECT p.user_id, \
         COUNT(i.id) AS items_total, \
         COUNT(i.id) FILTER (WHERE i.status = 'viewed') AS items_viewed, \
         COUNT(i.id) FILTER (WHERE i.status = 'completed') AS items_completed \
  FROM learning_plans p \
  LEFT JOIN learning_items i ON i.plan_id = p.id \
  WHERE p.created_at >= NOW() - INTERVAL '7 days' \
  GROUP BY p.user_id \
) p7 ON p7.user_id = tp.user_id \
LEFT JOIN ( \
  SELECT user_id, \
         MAX(created_at) AS last_active_at, \
         MAX(created_at) FILTER (WHERE event_type = 'ask') AS last_ask_at \
  FROM learning_events \
  GROUP BY user_id \
) ev ON ev.user_id = tp.user_id \
ORDER BY tp.wecom_userid";

/// 单教师总览条目（items 复用 ItemCounts：全期 / 近 7 天创建的 plan 的 items）。
#[derive(Serialize)]
pub struct TeacherOverview {
    pub wecom_userid: String,
    pub display_name: Option<String>,
    pub onboarding_state: String,
    pub plans_total: i64,
    pub items: ItemCounts,
    pub items_7d: ItemCounts,
    pub last_active_at: Option<chrono::DateTime<chrono::Utc>>,
    pub last_ask_at: Option<chrono::DateTime<chrono::Utc>>,
}

#[derive(Serialize)]
pub struct OverviewResponse {
    pub teachers: Vec<TeacherOverview>,
    pub generated_at: chrono::DateTime<chrono::Utc>,
}

/// GET /api/v1/training/overview — 管理总览（require_training_admin，同 /bind；
/// svc-wecom 管理端 / 周报 cron 消费）。全库教师逐人聚合：档案字段 + plans_total
/// + items（全期，按 learning_items.status 精确计数）+ items_7d（口径见
/// OVERVIEW_SQL 注释）+ last_active_at（最新任意事件）/ last_ask_at（最新 ask）。
/// **无数据教师也列出**（LEFT JOIN 预聚合子查询，空态全 0 / null）。单条语句即
/// 单一快照；generated_at 为处理时刻。
async fn get_overview(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<OverviewResponse>, AppError> {
    require_training_admin(&state, &headers)?;
    let rows = sqlx::query_as::<_, OverviewRow>(OVERVIEW_SQL)
        .fetch_all(&state.db)
        .await?;
    let teachers = rows
        .into_iter()
        .map(|r| TeacherOverview {
            wecom_userid: r.wecom_userid,
            display_name: r.display_name,
            onboarding_state: r.onboarding_state,
            plans_total: r.plans_total,
            items: ItemCounts {
                total: r.items_total,
                viewed: r.items_viewed,
                completed: r.items_completed,
            },
            items_7d: ItemCounts {
                total: r.items_7d_total,
                viewed: r.items_7d_viewed,
                completed: r.items_7d_completed,
            },
            last_active_at: r.last_active_at,
            last_ask_at: r.last_ask_at,
        })
        .collect();
    Ok(Json(OverviewResponse {
        teachers,
        generated_at: chrono::Utc::now(),
    }))
}

// ============ Task 7（M2 批1）：profile / events(ask) / progress ============

/// 教师档案视图（GET/PUT 同形，PUT 响应即更新后档案）。
/// grade_levels/goals/interests 为 JSONB（bind 后初始 `[]`）。
#[derive(Serialize, sqlx::FromRow)]
pub struct TeacherProfileResponse {
    pub wecom_userid: String,
    pub display_name: Option<String>,
    pub subject: Option<String>,
    pub grade_levels: serde_json::Value,
    pub goals: serde_json::Value,
    pub interests: serde_json::Value,
    pub onboarding_state: String,
}

const PROFILE_SELECT: &str =
    "SELECT wecom_userid, display_name, subject, grade_levels, goals, interests, onboarding_state \
     FROM teacher_profiles";

/// GET /api/v1/training/profile — 本人教师档案（require_auth，token 即本人，
/// 跨用户不可达）。无 teacher_profiles 行（未 bind）→ 404。
async fn get_profile(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<TeacherProfileResponse>, AppError> {
    let claims = require_auth(&state, &headers).await?;
    let user_id: i32 = claims.sub.parse()?;
    let profile = sqlx::query_as::<_, TeacherProfileResponse>(&format!(
        "{PROFILE_SELECT} WHERE user_id = $1"
    ))
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::ResourceNotFound("Teacher profile not found".into()))?;
    Ok(Json(profile))
}

/// PUT body：全部可变字段可选（部分更新，缺省字段保持原值）。
/// wecom_userid 不可变（bind 身份）；Vec<String> 落 JSONB 列。
#[derive(Deserialize)]
pub struct UpdateProfileRequest {
    pub display_name: Option<String>,
    pub subject: Option<String>,
    pub grade_levels: Option<Vec<String>>,
    pub goals: Option<Vec<String>>,
    pub interests: Option<Vec<String>>,
    pub onboarding_state: Option<String>,
}

/// PUT /api/v1/training/profile — 更新本人档案。
/// - 无档案 → 404（profile 行只能由 bind 创建；本端点只做更新）
/// - onboarding_state：值必须 ∈ {pending, surveyed}（否则 400）；
///   仅允许 pending→surveyed，反向 surveyed→pending → 409（与当前状态冲突；
///   codebase 惯例：状态/唯一冲突用 Conflict，bind 的 23505 同款）
/// - display_name/subject >100 chars → 400（列宽 VARCHAR(100)，按 chars 计数，bind 同款）
/// - 状态转移在 SELECT ... FOR UPDATE 下校验后同事务 UPDATE，无并发竞态窗口
async fn update_profile(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<UpdateProfileRequest>,
) -> Result<Json<TeacherProfileResponse>, AppError> {
    let claims = require_auth(&state, &headers).await?;
    let user_id: i32 = claims.sub.parse()?;

    if req.display_name.as_ref().is_some_and(|n| n.chars().count() > 100) {
        return Err(AppError::BadRequest("display_name exceeds 100 characters".into()));
    }
    if req.subject.as_ref().is_some_and(|s| s.chars().count() > 100) {
        return Err(AppError::BadRequest("subject exceeds 100 characters".into()));
    }
    if let Some(st) = &req.onboarding_state {
        if st != "pending" && st != "surveyed" {
            return Err(AppError::BadRequest(format!(
                "invalid onboarding_state: {st} (expected 'pending' or 'surveyed')"
            )));
        }
    }
    // Vec<String> → JSONB 绑定（to_value 对字符串数组不会失败）
    let grade_levels = opt_vec_to_json(req.grade_levels)?;
    let goals = opt_vec_to_json(req.goals)?;
    let interests = opt_vec_to_json(req.interests)?;

    let mut tx = state.db.begin().await.map_err(AppError::from)?;
    // FOR UPDATE：锁行后校验转移，防并发 PUT 竞态（如双请求交错 surveyed→pending）
    let current = sqlx::query_as::<_, TeacherProfileResponse>(&format!(
        "{PROFILE_SELECT} WHERE user_id = $1 FOR UPDATE"
    ))
    .bind(user_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| AppError::ResourceNotFound("Teacher profile not found".into()))?;
    if let Some(new_st) = &req.onboarding_state {
        if new_st == "pending" && current.onboarding_state == "surveyed" {
            return Err(AppError::Conflict(
                "onboarding_state cannot transition back from 'surveyed' to 'pending'".into(),
            ));
        }
    }
    let updated = sqlx::query_as::<_, TeacherProfileResponse>(
        "UPDATE teacher_profiles SET \
           display_name = COALESCE($2, display_name), \
           subject = COALESCE($3, subject), \
           grade_levels = COALESCE($4, grade_levels), \
           goals = COALESCE($5, goals), \
           interests = COALESCE($6, interests), \
           onboarding_state = COALESCE($7, onboarding_state), \
           updated_at = NOW() \
         WHERE user_id = $1 \
         RETURNING wecom_userid, display_name, subject, grade_levels, goals, interests, onboarding_state",
    )
    .bind(user_id)
    .bind(&req.display_name)
    .bind(&req.subject)
    .bind(&grade_levels)
    .bind(&goals)
    .bind(&interests)
    .bind(&req.onboarding_state)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await.map_err(AppError::from)?;
    Ok(Json(updated))
}

fn opt_vec_to_json(v: Option<Vec<String>>) -> Result<Option<serde_json::Value>, AppError> {
    v.map(|vec| serde_json::to_value(&vec))
        .transpose()
        .map_err(|e| AppError::InternalError(format!("failed to serialize profile field: {e}")))
}

#[derive(Deserialize)]
pub struct CreateEventRequest {
    pub event_type: String,
    /// 缺省落 DB 默认 `{}`；任意 JSON 均可（ask 语义的提问上下文）
    pub payload: Option<serde_json::Value>,
}

/// POST /api/v1/training/events — 学习事件上报（MCP/教师侧调用）。
/// 仅收 event_type="ask"（DB CHECK 虽允许 view/seen/complete/plan_created，
/// 但那些由服务端内部路径产生，不对 API 客户端开放）→ 其他一律 400。
/// 落库 user_id=claims.sub（本人）。响应 200 `{"id": N}`。
async fn create_event(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<CreateEventRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let claims = require_auth(&state, &headers).await?;
    let user_id: i32 = claims.sub.parse()?;
    if req.event_type != "ask" {
        return Err(AppError::BadRequest(format!(
            "unsupported event_type: {} (only 'ask' is accepted)",
            req.event_type
        )));
    }
    let payload = req.payload.unwrap_or_else(|| serde_json::json!({}));
    let id: i32 = sqlx::query_scalar(
        "INSERT INTO learning_events (user_id, event_type, payload) VALUES ($1, 'ask', $2) RETURNING id",
    )
    .bind(user_id)
    .bind(&payload)
    .fetch_one(&state.db)
    .await?;
    Ok(Json(serde_json::json!({ "id": id })))
}

#[derive(Serialize)]
pub struct ProgressResponse {
    pub plans: Vec<PlanProgress>,
    pub recent_events: Vec<RecentEvent>,
}

#[derive(Serialize)]
pub struct PlanProgress {
    pub id: i32,
    pub title: String,
    pub origin: String,
    pub status: String,
    pub items: ItemCounts,
}

/// items 计数：total / viewed / completed 按 learning_items.status 精确计数
/// （viewed 仅 status='viewed'；"至少看过" = viewed + completed，由消费方自行求和）。
#[derive(Serialize)]
pub struct ItemCounts {
    pub total: i64,
    pub viewed: i64,
    pub completed: i64,
}

#[derive(Serialize, sqlx::FromRow)]
pub struct RecentEvent {
    pub id: i32,
    pub event_type: String,
    pub payload: serde_json::Value,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

/// GET /api/v1/training/progress — 学习进度总览（本人）。
/// plans：全部计划（active+archived）按 created_at DESC（id DESC 防同秒 tie），
/// items 为 LEFT JOIN 聚合计数（无 item 的计划 total=0 而非缺 plan）。
/// recent_events：最近 20 条（created_at DESC，最新在前）。空态均为 `[]` 而非 null。
/// 注：plans 的创建 API 是 Task 8（/t/ 落地页是 Task 9），这里只读。
async fn get_progress(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<ProgressResponse>, AppError> {
    let claims = require_auth(&state, &headers).await?;
    let user_id: i32 = claims.sub.parse()?;

    let rows = sqlx::query_as::<_, (i32, String, String, String, i64, i64, i64)>(
        "SELECT p.id, p.title, p.origin, p.status, \
                COUNT(i.id) AS total, \
                COUNT(i.id) FILTER (WHERE i.status = 'viewed') AS viewed, \
                COUNT(i.id) FILTER (WHERE i.status = 'completed') AS completed \
         FROM learning_plans p \
         LEFT JOIN learning_items i ON i.plan_id = p.id \
         WHERE p.user_id = $1 \
         GROUP BY p.id \
         ORDER BY p.created_at DESC, p.id DESC",
    )
    .bind(user_id)
    .fetch_all(&state.db)
    .await?;
    let plans = rows
        .into_iter()
        .map(|(id, title, origin, status, total, viewed, completed)| PlanProgress {
            id,
            title,
            origin,
            status,
            items: ItemCounts { total, viewed, completed },
        })
        .collect();

    let recent_events = sqlx::query_as::<_, RecentEvent>(
        "SELECT id, event_type, payload, created_at FROM learning_events \
         WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 20",
    )
    .bind(user_id)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(ProgressResponse { plans, recent_events }))
}

// ============ Task 8（M2 批2）：plans / items / link / complete / rebuild ============

/// plan 视图（创建响应 / GET /plans/:id / 列表同形展开）。
#[derive(Serialize, sqlx::FromRow)]
pub struct PlanResponse {
    pub id: i32,
    pub title: String,
    pub reason: Option<String>,
    pub origin: String,
    pub period_key: Option<String>,
    pub status: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

const PLAN_SELECT: &str =
    "SELECT id, title, reason, origin, period_key, status, created_at FROM learning_plans";

/// item 视图（创建即 pending/completed_at NULL）。
#[derive(Serialize, sqlx::FromRow)]
pub struct ItemResponse {
    pub id: i32,
    pub plan_id: i32,
    pub kind: String,
    pub target_ref: String,
    pub timecode_start_s: Option<i32>,
    pub timecode_end_s: Option<i32>,
    pub label: String,
    pub sort_order: i32,
    pub status: String,
    pub completed_at: Option<chrono::DateTime<chrono::Utc>>,
}

const ITEM_SELECT: &str = "SELECT id, plan_id, kind, target_ref, timecode_start_s, timecode_end_s, \
     label, sort_order, status, completed_at FROM learning_items";

#[derive(Deserialize)]
pub struct PlanItemInput {
    pub kind: String,
    pub target_ref: String,
    pub timecode_start_s: Option<i32>,
    pub timecode_end_s: Option<i32>,
    pub label: String,
}

#[derive(Deserialize)]
pub struct CreatePlanRequest {
    pub title: String,
    pub reason: Option<String>,
    pub origin: String,
    pub period_key: Option<String>,
    pub items: Vec<PlanItemInput>,
}

/// plan_link token TTL 已随 /t/ 签发点移至 t_page.rs（`PLAN_LINK_TTL_DAYS`，
/// 7d）：Task 9b 起 /t/ token 不再由本路由签发——GET /s/:code 跳转时现签，
/// plan/link 响应只吐 `/s/<code>` 短链。

/// /s/ 短码长度：10 字符 url-safe [a-zA-Z0-9]（62^10 ≈ 8.4e17 空间）。
/// 对外可分享链路的截断免疫下限（/t/ 164-char JWT 被模型省略号截断的事故根因）。
const SHORT_LINK_CODE_LEN: usize = 10;

/// 生成 10-char url-safe 短码（rand Alphanumeric——与 bind 的 rand 随机同源，
/// 字符集刻意不含 `-_`：纯字母数字在任何聊天应用/手抄场景零歧义）。
fn generate_short_link_code() -> String {
    use rand::distributions::Alphanumeric;
    use rand::Rng;
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(SHORT_LINK_CODE_LEN)
        .map(char::from)
        .collect()
}

/// 生成短码并**同事务**落 short_links 行，返回 "/s/<code>"。
/// 碰撞处理：`ON CONFLICT (code) DO NOTHING RETURNING code`——冲突不中断事务
/// （裸 INSERT 23505 会置 aborted），无行返回则换码重试；62^10 空间下碰撞
/// 概率 ~0，5 次上限纯防御。ON CONFLICT 仲裁模式同 create_plan 的 period_key。
/// tx 参数取 `&mut PgConnection`（projection.rs 同款——Transaction 经 `&mut *tx`
/// 解引用传入，避免具体生命周期类型）。
async fn insert_short_link(
    tx: &mut sqlx::PgConnection,
    user_id: i32,
    plan_id: i32,
) -> Result<String, AppError> {
    for _ in 0..5 {
        let code = generate_short_link_code();
        let inserted: Option<String> = sqlx::query_scalar(
            "INSERT INTO short_links (code, plan_id, user_id) VALUES ($1, $2, $3) \
             ON CONFLICT (code) DO NOTHING RETURNING code",
        )
        .bind(&code)
        .bind(plan_id)
        .bind(user_id)
        .fetch_optional(&mut *tx)
        .await?;
        if let Some(c) = inserted {
            return Ok(format!("/s/{c}"));
        }
    }
    Err(AppError::InternalError(
        "short link code collision after 5 attempts (62^10 space — statistically impossible)".into(),
    ))
}

/// target_ref 合法性（逐条 400，事务外预检——被拒请求零半写）：
/// - 绝对路径（"/" 前缀）→ 400（防文件系统越界引用）；
/// - kind wiki_page：transcripts/ 前缀放行（transcriber 命名空间，页可能未同步），
///   其余必须在 wiki_pages 存在——project 取 `state.training.project_id` 配置
///   （None → 500 配置缺失，不硬编码）；不存在的相对路径 → 400；
/// - kind media：必须在 media_assets.slug 存在，否则 400；
/// - 其他 kind → 400。
async fn validate_plan_items(state: &AppState, items: &[PlanItemInput]) -> Result<(), AppError> {
    let project_id = state.config.training.project_id;
    for it in items {
        if it.kind != "wiki_page" && it.kind != "media" {
            return Err(AppError::BadRequest(format!("invalid item kind: {}", it.kind)));
        }
        if it.target_ref.trim().is_empty() {
            return Err(AppError::BadRequest("target_ref is empty".into()));
        }
        if it.target_ref.starts_with('/') {
            return Err(AppError::BadRequest(format!(
                "target_ref must not be an absolute path: {}...",
                it.target_ref.chars().take(32).collect::<String>()
            )));
        }
        if it.label.chars().count() > 200 {
            return Err(AppError::BadRequest("item label exceeds 200 characters".into()));
        }
        match it.kind.as_str() {
            "wiki_page" => {
                if it.target_ref.starts_with("transcripts/") {
                    continue; // 命名空间页由 transcriber 写入，允许暂不在 wiki_pages
                }
                let pid = project_id.ok_or_else(|| {
                    AppError::InternalError("TRAINING__PROJECT_ID not configured".into())
                })?;
                let exists: Option<i32> =
                    sqlx::query_scalar("SELECT 1 FROM wiki_pages WHERE project_id = $1 AND path = $2")
                        .bind(pid)
                        .bind(&it.target_ref)
                        .fetch_optional(&state.db)
                        .await?;
                if exists.is_none() {
                    return Err(AppError::BadRequest(format!(
                        "wiki_page target_ref not found: {}...",
                        it.target_ref.chars().take(64).collect::<String>()
                    )));
                }
            }
            "media" => {
                let exists: Option<i32> =
                    sqlx::query_scalar("SELECT 1 FROM media_assets WHERE slug = $1")
                        .bind(&it.target_ref)
                        .fetch_optional(&state.db)
                        .await?;
                if exists.is_none() {
                    return Err(AppError::BadRequest(format!(
                        "media target_ref (slug) not found: {}...",
                        it.target_ref.chars().take(64).collect::<String>()
                    )));
                }
            }
            _ => unreachable!("kind checked above"),
        }
    }
    Ok(())
}

/// 当前 ISO 周（服务器本地时区）：`YYYY-Www`，周数两位补零（如 2026-W34）。
/// `iso_week().year()` 是 ISO 周历年——跨年周（如 2027-01-03 ∈ 2026-W53）不取
/// 日历年，否则跨年周会算错一年。
fn current_period_key() -> String {
    let iw = chrono::Local::now().iso_week();
    format!("{:04}-W{:02}", iw.year(), iw.week())
}

/// period_key 形状校验（weekly 分支）：`YYYY-Www` = 4 位年 + "-W" + 恰 2 位周。
/// 只验形状不验周值范围（01-53）——周值合法性由「必须 == 当周」比对兜底
/// （如 2026-W99 形状合法但必 ≠ 当周 → 走 mismatch 400 同样被拒）。
/// 纯 ASCII 判定，字节索引安全。
fn is_period_key_format(pk: &str) -> bool {
    let b = pk.as_bytes();
    b.len() == 8
        && b[0].is_ascii_digit()
        && b[1].is_ascii_digit()
        && b[2].is_ascii_digit()
        && b[3].is_ascii_digit()
        && b[4] == b'-'
        && b[5] == b'W'
        && b[6].is_ascii_digit()
        && b[7].is_ascii_digit()
}

/// items 数量上限（Task 6 r3）：一批清单条目上限 50——防 LLM 失控生成超长清单
/// （DB 无约束，一条 400 早退比落库 200 条垃圾再人工清理便宜得多）。
const PLAN_ITEMS_MAX: usize = 50;

/// POST /api/v1/training/plans — 创建学习计划（access，本人）。
/// 事务：plan + items + plan_created 事件 + short_links 短码原子落库；
/// 响应 201 {plan, items, link}，link 为 `/s/<code>`（10-char 短链；短码不过期，
/// 点击由 GET /s/:code 现签 7d /t/ token 跳转——plan 存活期间链接永不失效）。
///
/// period_key 幂等（并发安全）：`ON CONFLICT (user_id, origin, period_key)
/// WHERE period_key IS NOT NULL DO NOTHING RETURNING id`——部分唯一索引
/// idx_plans_period 仲裁并发，输家 RETURNING 无行 → **同事务**回查 SELECT
/// 返回既有 plan 及其 items → 200（不追加/不覆盖；plan_created 不重记——
/// 但 9b 短码照常现签：capability 行只增不减，两枚 code 均可跳转）。
/// READ COMMITTED 下 DO NOTHING 阻塞至 winner 提交，随后语句快照可见该行，
/// 并发同 period_key 创建收敛到同一 id，绝不 500。
///
/// period_key 权威源（M3 Task 3，仅 origin=="weekly"）：**服务端自算当周**。
/// LLM 手算 ISO 周（年界归属/周一起始）是易错算术，错一字符即绕开上方唯一
/// 索引的幂等语义 → `DO NOTHING` 静默失效、重复建单。省略 → 自算落库；
/// 显式给出且格式合法但 ≠ 当周 → 400（message 含 `expected_period_key=...`，
/// agent 改口重试）；格式非法 → 400。origin=="chat" 现状不变（可选透传）。
async fn create_plan(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<CreatePlanRequest>,
) -> Result<(StatusCode, Json<serde_json::Value>), AppError> {
    let claims = require_auth(&state, &headers).await?;
    let user_id: i32 = claims.sub.parse()?;

    // 入参校验（400 早退，零半写）：origin 枚举、title/period_key 长度（列宽，
    // chars 计数）、target_ref 合法性（见 validate_plan_items）。
    if req.origin != "chat" && req.origin != "weekly" {
        return Err(AppError::BadRequest(format!(
            "invalid origin: {} (expected 'chat' or 'weekly')",
            req.origin
        )));
    }
    if req.title.trim().is_empty() {
        return Err(AppError::BadRequest("title is empty".into()));
    }
    if req.title.chars().count() > 200 {
        return Err(AppError::BadRequest("title exceeds 200 characters".into()));
    }
    if let Some(pk) = &req.period_key {
        if pk.chars().count() > 20 {
            return Err(AppError::BadRequest("period_key exceeds 20 characters".into()));
        }
    }
    // items 上限（Task 6 r3）：>50 → 400 早退（零半写，validate_plan_items 之前
    // 的纯内存检查先挡掉最离谱的请求）。
    if req.items.len() > PLAN_ITEMS_MAX {
        return Err(AppError::BadRequest(format!(
            "items exceeds {PLAN_ITEMS_MAX} entries (got {})",
            req.items.len()
        )));
    }
    // period_key 三分支（仅 weekly；见 create_plan 文档注释的权威源说明）。
    // 空白串视同省略（JSON null/""/缺省对"未给出"语义等价——LLM 显然没算周，
    // 自算兜底优于 400 来回）；trim 后非空才进入格式/当周校验。
    let period_key = if req.origin == "weekly" {
        let expected = current_period_key();
        match req.period_key.as_deref().map(str::trim) {
            None | Some("") => Some(expected),
            Some(pk) => {
                if !is_period_key_format(pk) {
                    return Err(AppError::BadRequest(format!(
                        "invalid period_key format: {pk} (expected YYYY-Www, e.g. 2026-W34)"
                    )));
                }
                if pk != expected {
                    return Err(AppError::BadRequest(format!(
                        "period_key mismatch: got {pk}, expected_period_key={expected} \
                         (server computes the current ISO week; omit period_key or retry with it)"
                    )));
                }
                Some(pk.to_string())
            }
        }
    } else {
        req.period_key.clone()
    };
    validate_plan_items(&state, &req.items).await?;

    let mut tx = state.db.begin().await.map_err(AppError::from)?;

    let inserted: Option<(i32, chrono::DateTime<chrono::Utc>)> = sqlx::query_as(
        "INSERT INTO learning_plans (user_id, title, reason, origin, period_key) \
         VALUES ($1, $2, $3, $4, $5) \
         ON CONFLICT (user_id, origin, period_key) WHERE period_key IS NOT NULL DO NOTHING \
         RETURNING id, created_at",
    )
    .bind(user_id)
    .bind(req.title.trim())
    .bind(&req.reason)
    .bind(&req.origin)
    .bind(&period_key)
    .fetch_optional(&mut *tx)
    .await?;

    let (plan, items, created_new) = if let Some((plan_id, created_at)) = inserted {
        // 新建：items 批次 + plan_created 事件（同事务）
        let mut items = Vec::with_capacity(req.items.len());
        for (i, it) in req.items.iter().enumerate() {
            let item_id: i32 = sqlx::query_scalar(
                "INSERT INTO learning_items \
                   (plan_id, kind, target_ref, timecode_start_s, timecode_end_s, label, sort_order) \
                 VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
            )
            .bind(plan_id)
            .bind(&it.kind)
            .bind(&it.target_ref)
            .bind(it.timecode_start_s)
            .bind(it.timecode_end_s)
            .bind(&it.label)
            .bind(i as i32)
            .fetch_one(&mut *tx)
            .await?;
            items.push(ItemResponse {
                id: item_id,
                plan_id,
                kind: it.kind.clone(),
                target_ref: it.target_ref.clone(),
                timecode_start_s: it.timecode_start_s,
                timecode_end_s: it.timecode_end_s,
                label: it.label.clone(),
                sort_order: i as i32,
                status: "pending".into(),
                completed_at: None,
            });
        }
        sqlx::query(
            "INSERT INTO learning_events (user_id, event_type, payload) \
             VALUES ($1, 'plan_created', $2)",
        )
        .bind(user_id)
        .bind(serde_json::json!({
            "plan_id": plan_id,
            "origin": req.origin,
            "period_key": period_key,
            "item_count": req.items.len(),
        }))
        .execute(&mut *tx)
        .await?;
        (
            PlanResponse {
                id: plan_id,
                title: req.title.trim().to_string(),
                reason: req.reason.clone(),
                origin: req.origin.clone(),
                period_key: period_key.clone(),
                status: "active".into(),
                created_at,
            },
            items,
            true,
        )
    } else {
        // period_key 撞既有（含并发 winner）：同事务回查既有 plan，原样返回（200）
        let plan = sqlx::query_as::<_, PlanResponse>(&format!(
            "{PLAN_SELECT} WHERE user_id = $1 AND origin = $2 AND period_key = $3"
        ))
        .bind(user_id)
        .bind(&req.origin)
        .bind(&period_key)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| {
            // 不可达：DO NOTHING 无行 ⇒ 唯一索引上必有（已提交的）仲裁行
            AppError::InternalError(
                "period_key conflict but existing plan not found (index/row divergence)".into(),
            )
        })?;
        let items = sqlx::query_as::<_, ItemResponse>(&format!(
            "{ITEM_SELECT} WHERE plan_id = $1 ORDER BY sort_order, id"
        ))
        .bind(plan.id)
        .fetch_all(&mut *tx)
        .await?;
        (plan, items, false)
    };

    // 短码同事务落库（Task 9b）：plan/items/plan_created/short_links 原子——
    // 响应里的 link 是 `/s/<code>`（10-char 截断免疫；短码不过期，点击由
    // GET /s/:code 现签 7d /t/ token——plan 存活期间链接永不失效）。
    let link = insert_short_link(&mut *tx, user_id, plan.id).await?;
    tx.commit().await.map_err(AppError::from)?;
    let status = if created_new {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    };
    Ok((
        status,
        Json(serde_json::json!({ "plan": plan, "items": items, "link": link })),
    ))
}

#[derive(Deserialize)]
pub struct ListPlansQuery {
    pub status: Option<String>,
}

/// 列表行：plan 字段 + items 聚合计数（LEFT JOIN，无 item 的 plan total=0）。
#[derive(Serialize)]
pub struct PlanListItem {
    #[serde(flatten)]
    pub plan: PlanResponse,
    pub items: ItemCounts,
}

/// GET /api/v1/training/plans?status= — 本人的计划列表（created_at DESC）。
/// status 可选（active|archived，其余 400）；跨用户不可达（token 即本人）。
async fn list_plans(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<ListPlansQuery>,
) -> Result<Json<Vec<PlanListItem>>, AppError> {
    let claims = require_auth(&state, &headers).await?;
    let user_id: i32 = claims.sub.parse()?;
    if let Some(st) = &q.status {
        if st != "active" && st != "archived" {
            return Err(AppError::BadRequest(format!(
                "invalid status filter: {st} (expected 'active' or 'archived')"
            )));
        }
    }

    let sql = format!(
        "SELECT p.id, p.title, p.reason, p.origin, p.period_key, p.status, p.created_at, \
                COUNT(i.id) AS total, \
                COUNT(i.id) FILTER (WHERE i.status = 'viewed') AS viewed, \
                COUNT(i.id) FILTER (WHERE i.status = 'completed') AS completed \
         FROM learning_plans p \
         LEFT JOIN learning_items i ON i.plan_id = p.id \
         WHERE p.user_id = $1 {} \
         GROUP BY p.id \
         ORDER BY p.created_at DESC, p.id DESC",
        if q.status.is_some() { "AND p.status = $2" } else { "" }
    );
    let mut query = sqlx::query_as::<_, (i32, String, Option<String>, String, Option<String>, String, chrono::DateTime<chrono::Utc>, i64, i64, i64)>(&sql)
        .bind(user_id);
    if let Some(st) = &q.status {
        query = query.bind(st);
    }
    let rows = query.fetch_all(&state.db).await?;
    let plans = rows
        .into_iter()
        .map(|(id, title, reason, origin, period_key, status, created_at, total, viewed, completed)| {
            PlanListItem {
                plan: PlanResponse { id, title, reason, origin, period_key, status, created_at },
                items: ItemCounts { total, viewed, completed },
            }
        })
        .collect();
    Ok(Json(plans))
}

/// GET /api/v1/training/plans/:id — 计划详情（归属：plan.user_id 必须 = token 本人，
/// 否则一律 404——不区分「不存在/不归属」，防探测泄漏）。
async fn get_plan(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(plan_id): Path<i32>,
) -> Result<Json<serde_json::Value>, AppError> {
    let claims = require_auth(&state, &headers).await?;
    let user_id: i32 = claims.sub.parse()?;
    let plan = sqlx::query_as::<_, PlanResponse>(&format!("{PLAN_SELECT} WHERE id = $1 AND user_id = $2"))
        .bind(plan_id)
        .bind(user_id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| AppError::ResourceNotFound("Plan not found".into()))?;
    let items = sqlx::query_as::<_, ItemResponse>(&format!(
        "{ITEM_SELECT} WHERE plan_id = $1 ORDER BY sort_order, id"
    ))
    .bind(plan_id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(serde_json::json!({ "plan": plan, "items": items })))
}

/// POST /api/v1/training/plans/:id/link — 重签分享链接，响应 `{"link": "/s/<code>"}`。
/// 归属同 get_plan（不属 → 404）；**仅 status='active' 的 plan**（归档 → 404，r3 复审：
/// 归档后不应再铸出必 404 的死链短码）。撤销语义：归档 plan 即一键吊销全部既有
/// /s/ 短码与 /t/ 渲染（t_page 侧同判 active）；删 plan 级联删除 short_links 行。
/// 短码不过期：点击由 GET /s/:code 现签新 7d /t/ token，故本端点在 Task 9b 后
/// 语义上已无「刷新窗口」必要（/s/ 永活），保留为兼容入口（MCP/Hermes 既有调用）。
async fn regen_plan_link(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(plan_id): Path<i32>,
) -> Result<Json<serde_json::Value>, AppError> {
    let claims = require_auth(&state, &headers).await?;
    let user_id: i32 = claims.sub.parse()?;
    let mut tx = state.db.begin().await.map_err(AppError::from)?;
    let owned: Option<i32> =
        sqlx::query_scalar("SELECT id FROM learning_plans WHERE id = $1 AND user_id = $2 AND status = 'active'")
            .bind(plan_id)
            .bind(user_id)
            .fetch_optional(&mut *tx)
            .await?;
    if owned.is_none() {
        return Err(AppError::ResourceNotFound("Plan not found".into()));
    }
    let link = insert_short_link(&mut *tx, user_id, plan_id).await?;
    tx.commit().await.map_err(AppError::from)?;
    Ok(Json(serde_json::json!({ "link": link })))
}

/// POST /api/v1/training/items/:id/complete — 完成条目（access，归属链
/// item→plan.user_id，不属/不存在 → 404；**plan 必须 status='active'**——归档 plan
/// → 404（Task 6 r3 / r3 Minor #4：归档 = 吊销，事件写入与 /s/、/t/ 门禁语义一致，
/// 归档后不得再记 complete 事件）。事务内调 projection::complete_item：
/// 记 complete 事件（事件即事实）+ 单调 UPDATE（completed 不回退、completed_at
/// 不重置）→ 二次完成幂等 200。
async fn complete_item(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(item_id): Path<i32>,
) -> Result<Json<serde_json::Value>, AppError> {
    let claims = require_auth(&state, &headers).await?;
    let user_id: i32 = claims.sub.parse()?;
    let mut tx = state.db.begin().await.map_err(AppError::from)?;
    let owned: Option<i32> = sqlx::query_scalar(
        "SELECT i.id FROM learning_items i JOIN learning_plans p ON i.plan_id = p.id \
         WHERE i.id = $1 AND p.user_id = $2 AND p.status = 'active'",
    )
    .bind(item_id)
    .bind(user_id)
    .fetch_optional(&mut *tx)
    .await?;
    if owned.is_none() {
        return Err(AppError::ResourceNotFound("Item not found".into()));
    }
    crate::services::projection::complete_item(&mut tx, item_id, user_id).await?;
    tx.commit().await.map_err(AppError::from)?;
    Ok(Json(serde_json::json!({ "item_id": item_id, "status": "completed" })))
}

/// POST /api/v1/training/progress/rebuild — 事件重放重建本人 items 投影
/// （access，仅本人；M2 调试用）。单事务：清零 + 按 item 级事件重放原子完成。
async fn rebuild_progress(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, AppError> {
    let claims = require_auth(&state, &headers).await?;
    let user_id: i32 = claims.sub.parse()?;
    let mut tx = state.db.begin().await.map_err(AppError::from)?;
    let stats = crate::services::projection::rebuild(&mut tx, user_id).await?;
    tx.commit().await.map_err(AppError::from)?;
    Ok(Json(serde_json::json!({
        "cleared": stats.cleared,
        "viewed": stats.viewed,
        "completed": stats.completed,
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 短码形状（lib 纯函数）：恰 10 字符、纯 [a-zA-Z0-9]、多次采样互异
    /// （62^10 空间随机；积分路径的落库/跳转见 t_page_test 矩阵 7）。
    #[test]
    fn short_link_code_shape() {
        let mut seen = std::collections::HashSet::new();
        for _ in 0..100 {
            let code = generate_short_link_code();
            assert_eq!(code.len(), SHORT_LINK_CODE_LEN, "exactly {SHORT_LINK_CODE_LEN} chars");
            assert!(
                code.chars().all(|c| c.is_ascii_alphanumeric()),
                "url-safe alnum only: {code}"
            );
            seen.insert(code);
        }
        assert_eq!(seen.len(), 100, "100 samples all distinct (collision ~0 at 62^10)");
    }

    /// period_key 形状（lib 纯函数）：恰 `YYYY-Www`（4 位年 + "-W" + 恰 2 位周）
    /// 通过；缺横杠/一位周/三位周/非数字年/小写 w/空白/空串拒绝。
    #[test]
    fn period_key_format_shape() {
        for ok in ["2026-W34", "1999-W01", "2026-W53", "0001-W01"] {
            assert!(is_period_key_format(ok), "valid: {ok}");
        }
        for bad in [
            "2026-W3",     // 一位周
            "2026W34",     // 缺横杠
            "2026-W345",   // 三位周
            "x026-W34",    // 年非数字
            "2026-w34",    // 小写 w
            " 2026-W34",   // 前导空白
            "2026-W34 ",   // 尾随空白
            "",            // 空串
        ] {
            assert!(!is_period_key_format(bad), "invalid: {bad:?}");
        }
    }

    /// 当前周串 == 独立按 chrono 本地时区 ISO 周计算（含 ISO 周历年语义）。
    /// 周界竞态（测试恰跨周翻页）重试兜底：三次全不一致才判失败。
    #[test]
    fn current_period_key_matches_chrono_iso_week() {
        use chrono::Datelike as _;
        for _ in 0..3 {
            let pk = current_period_key();
            let iw = chrono::Local::now().iso_week();
            let expect = format!("{:04}-W{:02}", iw.year(), iw.week());
            if pk == expect {
                assert_eq!(pk.len(), 8);
                assert_eq!(&pk[4..6], "-W", "dash + W at fixed offsets");
                return;
            }
        }
        panic!("current_period_key never matched chrono iso_week across 3 attempts (week flip race?)");
    }
}
