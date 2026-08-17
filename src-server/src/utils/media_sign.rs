//! 媒体 URL 签名（Task 7 / Task 12 CLI 共用算法）。
//! `sig = HMAC-SHA256(key, "{media_id}:{exp}")` → hex；校验用常数时间比较防时序侧信道。

use hmac::{Hmac, Mac};
use sha2::Sha256;

pub fn sign_media(key: &str, media_id: &str, exp: i64) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(key.as_bytes()).expect("hmac key");
    mac.update(format!("{media_id}:{exp}").as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

pub fn verify_media_sig(key: &str, media_id: &str, exp: i64, sig: &str) -> bool {
    let expect = sign_media(key, media_id, exp);
    subtle::ConstantTimeEq::ct_eq(expect.as_bytes(), sig.as_bytes()).into()
}
