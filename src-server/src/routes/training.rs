//! Training 管线路由（M1）。
//! - POST /media-assets：批量 upsert（svc-transcriber 调用，LT team Admin 鉴权）
//! - POST /bind：企业微信侧幂等建号（TRAINING__ADMIN_TOKEN 鉴权 + refresh 轮换）

use axum::{extract::State, http::HeaderMap, routing::post, Json, Router};
use chrono::Duration as ChronoDuration;
use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::middleware::project_guard::{check_project_access_with_role, RequiredRole};
use crate::models::{AuthResponse, UserResponse};
use crate::{AppState, AppError};

pub fn training_routes() -> Router<AppState> {
    Router::new()
        .route("/media-assets", post(import_media_assets))
        .route("/bind", post(bind))
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
        sqlx::query(
            "INSERT INTO media_assets (slug, media_ref, playback_path, duration_s, codec, kind, chapters, transcript_page_path, source_path) \
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) \
             ON CONFLICT (slug) DO UPDATE SET media_ref=EXCLUDED.media_ref, playback_path=EXCLUDED.playback_path, \
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
                return Err(AppError::Conflict("wecom_userid already bound".into()));
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
                return Err(AppError::Conflict("wecom_userid already bound".into()));
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
