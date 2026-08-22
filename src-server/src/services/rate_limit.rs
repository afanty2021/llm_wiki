//! 进程内固定窗口限流（Task 6 r3 收编：t_page 三端点防滥用）。
//!
//! [`FixedWindowLimiter`] 是规格件：`new(cap, window)` + `check(&self, key) -> bool`，
//! `Mutex<HashMap<key, (window_start, count)>>` 固定窗口计数，惰性清理——
//! - **按 key 惰性复位**：命中条目窗口已过 → 视为新窗口从 0 计数（不依赖后台任务）；
//! - **阈值触发清扫**：map 超过 [`SWEEP_THRESHOLD`] 条时顺带 `retain` 掉全部过期窗口
//!   （防孤儿 key 无界增长；正常量级下每 key 恰一条活跃记录，清扫近似 no-op）。
//!
//! 进程内（非 redis）：限流对象是单实例 src-server 的三个无鉴权端点，容量语义
//! （爆表 → 429）不需要跨副本精确；重启清零可接受。
//!
//! [`PageRateLimits`] 把 t_page 的三档规格组合进一个 AppState 字段（`limiter`）：
//! - `short_link`：GET /s/:code，默认 30 次/分钟，key = code（短码即身份）；
//! - `beacon`：POST /t/:token/seen 与 /complete，默认 60 次/分钟，key = sha256(token)
//!   前 16 hex（与 /media fp 同法——JWT 前缀全同构，裸 token 前缀会让所有
//!   token 共享一个桶；哈希前 16 hex 是本仓既定的 token 指纹形态）。seen 与
//!   complete 同 key **共桶**：一个 /t/ 会话的全部 beacon 共用 60/min 预算。
//! - `t_page`：GET /t/:token，默认 30 次/分钟，key = token 指纹（同 beacon_key
//!   形态、独立桶）——SEC-7：view 事件随 GET 无界写，闸在此处。
//! 三档规格经 config 注入（评审 R4：AppConfig.page_rate_limits，默认 30/60/30，
//! env `PAGE_RATE_LIMITS__S_PER_MIN`/`__BEACON_PER_MIN`/`__T_PER_MIN` 可覆盖）。

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// 触发过期清扫的 map 大小阈值（超过才 O(n) retain，平时 check 为 O(1)）。
const SWEEP_THRESHOLD: usize = 1024;

/// 固定窗口计数限流器（规格件，见模块注释）。
pub struct FixedWindowLimiter {
    cap: usize,
    window: Duration,
    buckets: Mutex<HashMap<String, (Instant, u32)>>,
}

impl FixedWindowLimiter {
    pub fn new(cap: usize, window: Duration) -> Self {
        Self {
            cap,
            window,
            buckets: Mutex::new(HashMap::new()),
        }
    }

    /// 本次请求是否放行。窗口内第 1..=cap 次 → true（计数 +1）；超出 → false。
    /// 窗口过期（按该 key 惰性判定）→ 重新开窗从 0 计数。
    pub fn check(&self, key: &str) -> bool {
        let now = Instant::now();
        let mut map = self.buckets.lock().unwrap();
        // 阈值触发惰性清扫：清掉全局已过期的窗口条目，防孤儿 key 无界增长。
        if map.len() > SWEEP_THRESHOLD {
            map.retain(|_, (ws, _)| now.duration_since(*ws) < self.window);
        }
        let (start, count) = match map.get(key) {
            // 窗口内：续计
            Some(&(ws, c)) if now.duration_since(ws) < self.window => (ws, c),
            // 无条目或窗口已过：新窗口
            _ => (now, 0),
        };
        if count as usize >= self.cap {
            // 拒绝也刷新条目（保留窗口起点，让拒绝计数本身可观察/可清扫）
            map.insert(key.to_string(), (start, count));
            return false;
        }
        map.insert(key.to_string(), (start, count + 1));
        true
    }
}

/// GET /s/:code 限流默认规格：30 次/分钟（短码跳转，key=code）。
/// 评审 R4 入 config（AppConfig.page_rate_limits.s_per_min，env
/// PAGE_RATE_LIMITS__S_PER_MIN 可覆盖）。**默认值单一真源在此**：config.rs 的
/// serde 缺省函数与 PageRateLimits::new 均引用本常量，改默认只改这里。
pub const S_REDIRECT_CAP_PER_MIN: usize = 30;
/// /t/ beacon（seen+complete）限流默认规格：60 次/分钟（key=sha256(token) 前 16 hex）。
/// 评审 R4 入 config（AppConfig.page_rate_limits.beacon_per_min，env
/// PAGE_RATE_LIMITS__BEACON_PER_MIN 可覆盖）。**默认值单一真源在此**：config.rs 的
/// serde 缺省函数与 PageRateLimits::new 均引用本常量，改默认只改这里。
pub const BEACON_CAP_PER_MIN: usize = 60;
/// GET /t/:token 落地限流默认规格：30 次/分钟（key=sha256(token) 前 16 hex，与
/// beacon 同指纹形态、独立桶）。SEC-7（终审强烈建议）：view 事件随 GET 无界写——
/// 持任一 plan_link 者可刷库膨胀 learning_events 并污染 view 统计。30/min 对真人
/// 足够宽裕（连续刷新/重开链接），超限 429 与 /s/ 同语义。env
/// PAGE_RATE_LIMITS__T_PER_MIN 可覆盖。**默认值单一真源在此**（同上）。
pub const T_VIEW_CAP_PER_MIN: usize = 30;

/// t_page 端点限流规格组合（AppState.limiter 持有，见模块注释）。
pub struct PageRateLimits {
    /// GET /s/:code（默认 30/min，key=code）
    pub short_link: FixedWindowLimiter,
    /// POST /t/:token/seen 与 /t/:token/complete（默认 60/min，key=token 指纹，共桶）
    pub beacon: FixedWindowLimiter,
    /// GET /t/:token（默认 30/min，key=token 指纹，独立桶——view 事件写库闸门）
    pub t_page: FixedWindowLimiter,
}

impl PageRateLimits {
    /// 按规格构造（lib.rs create_app 从 config 接线处调用）。
    pub fn with_caps(s_per_min: usize, beacon_per_min: usize, t_per_min: usize) -> Self {
        let minute = Duration::from_secs(60);
        Self {
            short_link: FixedWindowLimiter::new(s_per_min, minute),
            beacon: FixedWindowLimiter::new(beacon_per_min, minute),
            t_page: FixedWindowLimiter::new(t_per_min, minute),
        }
    }

    /// 默认规格（30/60/30 每分钟，与 config 缺省一致——规格件单测用）。
    pub fn new() -> Self {
        Self::with_caps(
            S_REDIRECT_CAP_PER_MIN,
            BEACON_CAP_PER_MIN,
            T_VIEW_CAP_PER_MIN,
        )
    }
}

impl Default for PageRateLimits {
    fn default() -> Self {
        Self::new()
    }
}

/// beacon 限流 key：sha256(token) 前 16 hex（/media fp 同法，见模块注释）。
pub fn beacon_key(token: &str) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(token.as_bytes()))[..16].to_string()
}

// ============ SEC-3（终审必修）：bind/login IP 级限流 ============

/// /training/bind 与 /auth/login 的 IP 级限流默认规格：10 次/分钟/IP 每端点
/// （防 TRAINING__ADMIN_TOKEN 暴力枚举与口令猜解）。两桶独立（bind/login 各自
/// 计数），复用 [`FixedWindowLimiter`]（进程内固定窗口，语义同上）。
pub const AUTH_IP_CAP_PER_MIN: usize = 10;

/// bind + login 两档 IP 限流组合（AppState.ip_limiter 持有）。
pub struct IpRateLimits {
    /// POST /api/v1/training/bind（key = 客户端 IP）
    pub bind: FixedWindowLimiter,
    /// POST /api/v1/auth/login（key = 客户端 IP）
    pub login: FixedWindowLimiter,
}

impl IpRateLimits {
    pub fn new() -> Self {
        let minute = Duration::from_secs(60);
        Self {
            bind: FixedWindowLimiter::new(AUTH_IP_CAP_PER_MIN, minute),
            login: FixedWindowLimiter::new(AUTH_IP_CAP_PER_MIN, minute),
        }
    }
}

impl Default for IpRateLimits {
    fn default() -> Self {
        Self::new()
    }
}

/// 客户端 IP（SEC-3 限流 key）：`Cf-Connecting-Ip` 头优先（cloudflared 隧道场景
/// ——socket addr 是隧道回环，真实客户端 IP 只在头里）；回落 axum
/// `ConnectInfo<SocketAddr>`（直连场景，main.rs into_make_service_with_connect_info
/// 注入）；两者皆缺（TestServer/oneshot 直调 Router 等形态）→ `"unknown"` 共桶
/// （fail-closed：缺 IP ≠ 放行，全部进同一桶受限流约束）。
pub struct ClientIp(pub String);

#[axum::async_trait]
impl<S> axum::extract::FromRequestParts<S> for ClientIp
where
    S: Send + Sync,
{
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(
        parts: &mut axum::http::request::Parts,
        _state: &S,
    ) -> Result<Self, Self::Rejection> {
        let ip = parts
            .headers
            .get("cf-connecting-ip")
            .and_then(|v| v.to_str().ok())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .or_else(|| {
                parts
                    .extensions
                    .get::<axum::extract::ConnectInfo<std::net::SocketAddr>>()
                    .map(|ci| ci.0.ip().to_string())
            })
            .unwrap_or_else(|| "unknown".to_string());
        Ok(ClientIp(ip))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_up_to_cap_then_denies() {
        let limiter = FixedWindowLimiter::new(3, Duration::from_secs(60));
        assert!(limiter.check("k"));
        assert!(limiter.check("k"));
        assert!(limiter.check("k"), "cap 内最后一次放行");
        assert!(!limiter.check("k"), "第 cap+1 次拒绝");
        assert!(!limiter.check("k"), "持续拒绝");
    }

    #[test]
    fn keys_are_independent() {
        let limiter = FixedWindowLimiter::new(1, Duration::from_secs(60));
        assert!(limiter.check("a"));
        assert!(!limiter.check("a"));
        assert!(limiter.check("b"), "其他 key 不受影响");
    }

    #[test]
    fn window_expiry_resets_count() {
        let limiter = FixedWindowLimiter::new(1, Duration::from_millis(30));
        assert!(limiter.check("k"));
        assert!(!limiter.check("k"));
        std::thread::sleep(Duration::from_millis(50));
        assert!(limiter.check("k"), "窗口过期后重新开窗");
    }

    #[test]
    fn page_rate_limits_specs() {
        let limits = PageRateLimits::new();
        for i in 0..S_REDIRECT_CAP_PER_MIN {
            assert!(limits.short_link.check("code1"), "/s/ 第 {} 次应放行", i + 1);
        }
        assert!(!limits.short_link.check("code1"), "/s/ 超过 30/min 拒绝");
        assert!(limits.short_link.check("code2"), "他 code 不受影响");

        for i in 0..BEACON_CAP_PER_MIN {
            assert!(limits.beacon.check("fp1"), "beacon 第 {} 次应放行", i + 1);
        }
        assert!(!limits.beacon.check("fp1"), "beacon 超过 60/min 拒绝");
        assert!(limits.beacon.check("fp2"), "他 token 不受影响");
    }

    #[test]
    fn page_rate_limits_with_caps_override() {
        // R4：规格经 config 注入——with_caps 生效即 config 覆盖生效（默认值路径
        // 由 with_caps(三常量) 复用同一实现）
        let limits = PageRateLimits::with_caps(1, 2, 3);
        assert!(limits.short_link.check("c"));
        assert!(!limits.short_link.check("c"), "cap=1 → 第 2 次拒绝");
        assert!(limits.beacon.check("f1"));
        assert!(limits.beacon.check("f1"), "beacon cap=2 内放行");
        assert!(!limits.beacon.check("f1"), "beacon 第 3 次拒绝");
        assert!(limits.t_page.check("f1"));
        assert!(limits.t_page.check("f1"));
        assert!(limits.t_page.check("f1"), "t_page cap=3 内放行");
        assert!(!limits.t_page.check("f1"), "t_page 第 4 次拒绝");
    }

    /// SEC-7：t_page 桶与 beacon 桶独立——GET 落地打满不影响 beacon 上报，
    /// 反之亦然（共指纹形态不共预算）。
    #[test]
    fn t_page_bucket_independent_of_beacon() {
        let limits = PageRateLimits::with_caps(30, 1, 1);
        assert!(limits.t_page.check("f1"));
        assert!(!limits.t_page.check("f1"), "t_page cap=1 已打满");
        assert!(limits.beacon.check("f1"), "beacon 桶不受 t_page 消耗影响");
    }

    #[test]
    fn beacon_key_is_hash_prefix_not_token_prefix() {
        // JWT 头部全同构（eyJ…）：若 key 取裸 token 前缀，所有 token 共享一个桶。
        // 取 sha256 前 16 hex 后不同 token 必得不同 key。
        let k1 = beacon_key("eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.payload-one.sig");
        let k2 = beacon_key("eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.payload-two.sig");
        assert_eq!(k1.len(), 16);
        assert_ne!(k1, k2, "不同 token 的 beacon key 必须不同");
        assert!(k1.chars().all(|c| c.is_ascii_hexdigit()));
    }

    // ============ SEC-3：IpRateLimits / ClientIp ============

    #[test]
    fn ip_rate_limits_bind_login_independent_buckets() {
        // bind/login 各自 10/min：bind 打满不影响 login（独立桶）
        let limits = IpRateLimits::new();
        for i in 0..AUTH_IP_CAP_PER_MIN {
            assert!(limits.bind.check("1.2.3.4"), "bind #{i} allowed");
        }
        assert!(!limits.bind.check("1.2.3.4"), "bind 11th denied");
        assert!(limits.login.check("1.2.3.4"), "login unaffected by bind bucket");
        for i in 0..(AUTH_IP_CAP_PER_MIN - 1) {
            assert!(limits.login.check("1.2.3.4"), "login #{i} allowed");
        }
        assert!(!limits.login.check("1.2.3.4"), "login 11th denied");
        // 其他 IP 不受影响
        assert!(limits.bind.check("5.6.7.8"));
        assert!(limits.login.check("5.6.7.8"));
    }

    #[tokio::test]
    async fn client_ip_prefers_cf_header_then_connect_info_then_unknown() {
        use axum::extract::FromRequestParts;

        // http::request::Parts 有私有字段，经 Request::into_parts 取（无 IO，纯构造）
        let parts = || {
            let req = axum::http::Request::builder().uri("/").body(()).unwrap();
            let (p, ()) = req.into_parts();
            p
        };

        // 无头无扩展 → unknown（fail-closed 共桶）
        let mut p = parts();
        let ip = ClientIp::from_request_parts(&mut p, &()).await.unwrap();
        assert_eq!(ip.0, "unknown");

        // Cf-Connecting-Ip 优先（即使 ConnectInfo 也在）
        let mut p = parts();
        p.headers.insert(
            "cf-connecting-ip",
            axum::http::HeaderValue::from_static("203.0.113.9"),
        );
        p.extensions.insert(axum::extract::ConnectInfo(std::net::SocketAddr::from((
            [127, 0, 0, 1],
            8080,
        ))));
        let ip = ClientIp::from_request_parts(&mut p, &()).await.unwrap();
        assert_eq!(ip.0, "203.0.113.9");

        // 无头、有 ConnectInfo → socket addr 的 IP
        let mut p = parts();
        p.extensions.insert(axum::extract::ConnectInfo(std::net::SocketAddr::from((
            [127, 0, 0, 1],
            8080,
        ))));
        let ip = ClientIp::from_request_parts(&mut p, &()).await.unwrap();
        assert_eq!(ip.0, "127.0.0.1");

        // 空白头视为缺省 → 回落 ConnectInfo（防 "  " 制造独立桶绕过）
        let mut p = parts();
        p.headers.insert(
            "cf-connecting-ip",
            axum::http::HeaderValue::from_static("   "),
        );
        p.extensions.insert(axum::extract::ConnectInfo(std::net::SocketAddr::from((
            [127, 0, 0, 1],
            8080,
        ))));
        let ip = ClientIp::from_request_parts(&mut p, &()).await.unwrap();
        assert_eq!(ip.0, "127.0.0.1");
    }
}
