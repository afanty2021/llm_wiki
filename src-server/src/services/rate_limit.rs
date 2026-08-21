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
//! [`PageRateLimits`] 把 t_page 的两档规格组合进一个 AppState 字段（`limiter`）：
//! - `short_link`：GET /s/:code，默认 30 次/分钟，key = code（短码即身份）；
//! - `beacon`：POST /t/:token/seen 与 /complete，默认 60 次/分钟，key = sha256(token)
//!   前 16 hex（与 /media fp 同法——JWT 前缀全同构，裸 token 前缀会让所有
//!   token 共享一个桶；哈希前 16 hex 是本仓既定的 token 指纹形态）。seen 与
//!   complete 同 key **共桶**：一个 /t/ 会话的全部 beacon 共用 60/min 预算。
//! 两档规格经 config 注入（评审 R4：AppConfig.page_rate_limits，默认 30/60 与
//! 旧硬编码一致，env `PAGE_RATE_LIMITS__S_PER_MIN`/`PAGE_RATE_LIMITS__BEACON_PER_MIN` 可覆盖）。

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

/// t_page 三端点限流规格组合（AppState.limiter 持有，见模块注释）。
pub struct PageRateLimits {
    /// GET /s/:code（默认 30/min，key=code）
    pub short_link: FixedWindowLimiter,
    /// POST /t/:token/seen 与 /t/:token/complete（默认 60/min，key=token 指纹，共桶）
    pub beacon: FixedWindowLimiter,
}

impl PageRateLimits {
    /// 按规格构造（lib.rs create_app 从 config 接线处调用）。
    pub fn with_caps(s_per_min: usize, beacon_per_min: usize) -> Self {
        let minute = Duration::from_secs(60);
        Self {
            short_link: FixedWindowLimiter::new(s_per_min, minute),
            beacon: FixedWindowLimiter::new(beacon_per_min, minute),
        }
    }

    /// 默认规格（30/60 每分钟，与 config 缺省一致——规格件单测用）。
    pub fn new() -> Self {
        Self::with_caps(S_REDIRECT_CAP_PER_MIN, BEACON_CAP_PER_MIN)
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
        // 由 with_caps(S_REDIRECT_CAP_PER_MIN, BEACON_CAP_PER_MIN) 复用同一实现）
        let limits = PageRateLimits::with_caps(1, 2);
        assert!(limits.short_link.check("c"));
        assert!(!limits.short_link.check("c"), "cap=1 → 第 2 次拒绝");
        assert!(limits.beacon.check("f1"));
        assert!(limits.beacon.check("f1"), "beacon cap=2 内放行");
        assert!(!limits.beacon.check("f1"), "beacon 第 3 次拒绝");
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
}
