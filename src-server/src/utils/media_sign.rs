//! 媒体 URL 签名（Task 7 / Task 12 CLI 共用算法；Task 9 fingerprint 升级）。
//! - 三段式（Task 9 起，唯一格式）：`sig = HMAC-SHA256(key, "{media_id}:{exp}:{fp}")`
//!   → hex，fp = sha256(plan_link token) 前 16 hex。媒体票据由此绑定到具体的
//!   /t/ 链接（链接即凭证的纵深）。验签时 fp 只参与 HMAC 消息——绑定发生在
//!   签发侧（t_page 由 token 派生 fp），调试 CLI 可用合成 fp 走同一格式。
//! - 校验用常数时间比较防时序侧信道。
//! - 历史：M1 两段式（`{media_id}:{exp}`）兼容回落已于 2026-08-25 移除（原保守
//!   排期 ~09-18，提前依据：三段式 08-19 起为唯一服务端签发格式、票据 TTL
//!   12h，存量两段式票据 08-20 起全部自然过期）。两段式票据现在恒拒。

use hmac::{Hmac, Mac};
use sha2::Sha256;

/// 调试 CLI（sign-media）用的合成 fp：不绑定任何 /t/ token，仅满足三段式
/// 消息格式——安全性与两段式等价（秘密仍是 key 的持有）。
pub const DEBUG_FP: &str = "0000000000000000";

pub fn sign_media_with_fp(key: &str, media_id: &str, exp: i64, fp: &str) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(key.as_bytes()).expect("hmac key");
    mac.update(format!("{media_id}:{exp}:{fp}").as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

/// 严格三段式验签：fp 缺失（None）或 sig 不匹配即假；常数时间比较。
pub fn verify_media_sig(key: &str, media_id: &str, exp: i64, sig: &str, fp: Option<&str>) -> bool {
    let Some(fp) = fp else { return false };
    let expect = sign_media_with_fp(key, media_id, exp, fp);
    subtle::ConstantTimeEq::ct_eq(expect.as_bytes(), sig.as_bytes()).into()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 预计算向量（Rust/TS 双锁）：与 tools/transcriber/__tests__/api-client.test.ts
    /// 的向量为**同一组值**——两侧实现漂移会在各自测试失败。全部由
    /// `node -e 'createHmac("sha256", key).update(msg).digest("hex")'` 独立生成。
    const K: &str = "k";

    /// 三段式向量 1：fp 恒定 16 hex（sha256(token) 前 16）。
    #[test]
    fn precomputed_three_part_vector_1() {
        assert_eq!(
            sign_media_with_fp(K, "m", 123, "abcdef0123456789"),
            "6ff287af43e5e25e63cc640d715c5ba4c2fa7be0256e84783d23f2b9aa03d7cf"
        );
    }

    /// 三段式向量 2：真实量级 exp + 带连字符 media_id。
    #[test]
    fn precomputed_three_part_vector_2() {
        assert_eq!(
            sign_media_with_fp(K, "media-slug-1", 1700000000, "0011223344556677"),
            "453dc8bd833a447601595d6b4f80507beb8e52b78221e4138e7317233a143c4e"
        );
    }

    /// 严格三段式验签矩阵：对 fp 验真、错 fp 拒、无 fp 拒；
    /// 旧两段式签名（消息无 fp 段）即使带 fp 参数也恒拒（回落已移除）；
    /// 乱签拒、exp 错拒。
    #[test]
    fn verify_strict_three_part_matrix() {
        let fp = "abcdef0123456789";
        let sig3 = sign_media_with_fp(K, "m", 123, fp);
        // 两段式签名向量（历史值，回归钉：回落移除后恒拒）
        let legacy_two_part =
            "3d2dc485f29e280c2a5dbf7988b55d23378e06aa891b1df1372714ca19f2fed9";

        assert!(verify_media_sig(K, "m", 123, &sig3, Some(fp)), "3-part with matching fp");
        assert!(!verify_media_sig(K, "m", 123, &sig3, Some("0000000000000000")), "3-part with wrong fp");
        assert!(!verify_media_sig(K, "m", 123, &sig3, None), "no fp param rejected");
        assert!(!verify_media_sig(K, "m", 123, legacy_two_part, None), "legacy 2-part rejected (fallback removed)");
        assert!(!verify_media_sig(K, "m", 123, legacy_two_part, Some(fp)), "legacy 2-part with fp param rejected");
        assert!(!verify_media_sig(K, "m", 123, "deadbeef", Some(fp)), "garbage sig rejected");
        assert!(!verify_media_sig(K, "m", 124, &sig3, Some(fp)), "exp mismatch rejected");
        assert!(verify_media_sig(K, "m", 123, &sign_media_with_fp(K, "m", 123, DEBUG_FP), Some(DEBUG_FP)), "debug fp round-trip (CLI path)");
    }
}
