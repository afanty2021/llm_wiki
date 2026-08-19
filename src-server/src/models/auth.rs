use serde::{Deserialize, Serialize};
use crate::models::UserResponse;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Claims {
    pub sub: String,      // user_id
    pub username: String, // username
    pub exp: i64,         // expiry time
    pub iat: i64,         // issued at
    pub jti: String,      // JWT ID (for refresh token)
    /// Token 类型隔离（Task 6）：access token 显式带 `typ="access"`；
    /// `None` = M1 存量旧 token（无 typ 字段），按 access 兼容放行。
    /// 非 "access" 的 typ（如 plan_link）在 require_auth 处被拒。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub typ: Option<String>,
}

/// plan_link token 载体（/t/ 落地页，Task 6）——独立结构，不与 access Claims
/// 混用字段语义（缺 username/jti，多 plid）。decode 后先验 `typ == "plan_link"`
/// 再取 plid；伪造方向（access token 喂 verify_plan_link_token）在反序列化或
/// typ 检查处被拒。
#[derive(Debug, Serialize, Deserialize)]
pub struct PlanLinkClaims {
    pub sub: String, // user_id
    pub plid: i32,   // plan_id
    pub exp: i64,    // expiry time
    pub typ: String, // 必须为 "plan_link"
}

#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
}

#[derive(Debug, Deserialize)]
pub struct RegisterRequest {
    pub username: String,
    pub email: String,
    pub password: String,
    pub full_name: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct AuthResponse {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_in: u64,
    pub user: UserResponse,
}

#[derive(Debug, Deserialize)]
pub struct RefreshTokenRequest {
    pub refresh_token: String,
}
