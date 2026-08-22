//! 媒体 URL 签名（Task 7 / Task 12 CLI 共用算法；Task 9 fingerprint 升级）。
//! - 两段式（M1）：`sig = HMAC-SHA256(key, "{media_id}:{exp}")` → hex；
//! - 三段式（Task 9，/t/ 落地页签发）：消息追加 link fingerprint——
//!   `sig = HMAC-SHA256(key, "{media_id}:{exp}:{fp}")`，fp = sha256(plan_link token)
//!   前 16 hex。媒体票据由此绑定到具体的 /t/ 链接（链接即凭证的纵深）。
//! - 校验用常数时间比较防时序侧信道；`verify_media_sig` 双格式共存
//!   （M1 兼容期）：请求带 fp → 先验三段式、失败回落两段式；无 fp → 两段式。

use hmac::{Hmac, Mac};
use sha2::Sha256;

pub fn sign_media(key: &str, media_id: &str, exp: i64) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(key.as_bytes()).expect("hmac key");
    mac.update(format!("{media_id}:{exp}").as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

/// 三段式（fp = sha256(plan_link token) 前 16 hex，由调用方传入）。
pub fn sign_media_with_fp(key: &str, media_id: &str, exp: i64, fp: &str) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(key.as_bytes()).expect("hmac key");
    mac.update(format!("{media_id}:{exp}:{fp}").as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

/// 双格式验签（M1 兼容期）：`fp = Some` → 先验三段式，失败回落两段式（dual-format
/// try——存量两段式票据附加任意 fp 参数仍可用，不放大权限：两段式本就无 fp 绑定）；
/// `fp = None` → 仅两段式。任一命中即真；常数时间比较。
pub fn verify_media_sig(key: &str, media_id: &str, exp: i64, sig: &str, fp: Option<&str>) -> bool {
    if let Some(fp) = fp {
        let expect_fp = sign_media_with_fp(key, media_id, exp, fp);
        if subtle::ConstantTimeEq::ct_eq(expect_fp.as_bytes(), sig.as_bytes()).into() {
            return true;
        }
    }
    let expect = sign_media(key, media_id, exp);
    subtle::ConstantTimeEq::ct_eq(expect.as_bytes(), sig.as_bytes()).into()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 预计算向量（Rust/TS 双锁）：与 tools/transcriber/__tests__/api-client.test.ts
    /// 的向量为**同一组值**——两侧实现漂移会在各自测试失败。全部由
    /// `node -e 'createHmac("sha256", key).update(msg).digest("hex")'` 独立生成。
    const K: &str = "k";

    /// M1 两段式向量（TS 侧既有向量，本文件补 Rust 锁）。
    #[test]
    fn precomputed_two_part_vector() {
        assert_eq!(
            sign_media(K, "m", 123),
            "3d2dc485f29e280c2a5dbf7988b55d23378e06aa891b1df1372714ca19f2fed9"
        );
    }

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

    /// 双格式验签矩阵：三段式对 fp 验真、错 fp 拒；两段式无 fp 验真；
    /// 两段式 + 任意 fp 参数回落通过；乱签拒。
    #[test]
    fn verify_dual_format_matrix() {
        let fp = "abcdef0123456789";
        let sig3 = sign_media_with_fp(K, "m", 123, fp);
        let sig2 = sign_media(K, "m", 123);

        assert!(verify_media_sig(K, "m", 123, &sig3, Some(fp)), "3-part with matching fp");
        assert!(!verify_media_sig(K, "m", 123, &sig3, Some("0000000000000000")), "3-part with wrong fp");
        assert!(!verify_media_sig(K, "m", 123, &sig3, None), "3-part sig without fp param must not verify as 2-part");
        assert!(verify_media_sig(K, "m", 123, &sig2, None), "legacy 2-part without fp");
        assert!(verify_media_sig(K, "m", 123, &sig2, Some(fp)), "legacy 2-part falls back when fp param present");
        assert!(!verify_media_sig(K, "m", 123, "deadbeef", None), "garbage sig rejected");
        assert!(!verify_media_sig(K, "m", 124, &sig2, None), "exp mismatch rejected");
    }
}
