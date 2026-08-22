#[cfg(test)]
mod tests {
    use chrono::Duration;

    const TEST_SECRET: &str = "test_secret_key_for_jwt_token_generation_and_verification";

    #[test]
    fn test_generate_access_token() {
        let user_id = 123;
        let username = "testuser";
        let ttl = Duration::hours(1);

        let token = crate::utils::generate_access_token(user_id, username, TEST_SECRET, ttl).unwrap();

        assert!(!token.is_empty());
        assert!(!token.contains("Bearer"));
    }

    #[test]
    fn test_verify_token() {
        let user_id = 456;
        let username = "testuser2";
        let ttl = Duration::hours(1);

        let token = crate::utils::generate_access_token(user_id, username, TEST_SECRET, ttl).unwrap();

        let claims = crate::utils::verify_token(&token, TEST_SECRET).unwrap();
        assert_eq!(claims.sub, user_id.to_string());
        assert_eq!(claims.username, username);
    }

    #[test]
    fn test_verify_token_with_bearer_prefix() {
        let user_id = 789;
        let username = "testuser3";
        let ttl = Duration::hours(1);

        let token = crate::utils::generate_access_token(user_id, username, TEST_SECRET, ttl).unwrap();
        let bearer_token = format!("Bearer {}", token);

        let claims = crate::utils::verify_token(&bearer_token, TEST_SECRET).unwrap();
        assert_eq!(claims.sub, user_id.to_string());
    }

    #[test]
    fn test_verify_token_invalid_secret() {
        let user_id = 999;
        let username = "testuser4";
        let ttl = Duration::hours(1);

        let token = crate::utils::generate_access_token(user_id, username, TEST_SECRET, ttl).unwrap();

        let result = crate::utils::verify_token(&token, "wrong_secret");
        assert!(result.is_err());
    }

    #[test]
    fn test_generate_refresh_token() {
        let user_id = 321;
        let ttl = Duration::days(7);

        let (token, jti) = crate::utils::generate_refresh_token(user_id, TEST_SECRET, ttl).unwrap();

        assert!(!token.is_empty());
        assert!(!jti.is_empty());
    }

    #[test]
    fn test_verify_refresh_token() {
        let user_id = 654;
        let ttl = Duration::days(7);

        let (token, original_jti) = crate::utils::generate_refresh_token(user_id, TEST_SECRET, ttl).unwrap();

        let (extracted_user_id, extracted_jti) = crate::utils::verify_refresh_token(&token, TEST_SECRET).unwrap();
        assert_eq!(extracted_user_id, user_id);
        assert_eq!(extracted_jti, original_jti);
    }

    #[test]
    fn test_hash_password() {
        let password = "my_secure_password";
        let hash = crate::utils::hash_password(password).unwrap();

        assert!(!hash.is_empty());
        assert_ne!(hash, password);
        assert!(hash.starts_with("$2b$"));
    }

    #[test]
    fn test_verify_password() {
        let password = "my_secure_password";
        let wrong_password = "wrong_password";
        let hash = crate::utils::hash_password(password).unwrap();

        assert!(crate::utils::verify_password(password, &hash).unwrap());
        assert!(!crate::utils::verify_password(wrong_password, &hash).unwrap());
    }

    #[test]
    fn test_encrypt_decrypt_api_key() {
        let api_key = "sk-1234567890abcdef";
        let secret: [u8; 32] = [
            116, 101, 115, 116, 95, 115, 101, 99, 114, 101, 116, 95, 51, 50, 95, 98,
            121, 116, 101, 115, 95, 108, 111, 110, 103, 95, 102, 111, 114, 95, 97, 101,
        ]; // "test_secret_32_bytes_long_for_ae" in bytes

        let encrypted = crate::utils::encrypt_api_key(api_key, &secret).unwrap();
        assert!(!encrypted.is_empty());
        assert_ne!(encrypted, api_key);

        let decrypted = crate::utils::decrypt_api_key(&encrypted, &secret).unwrap();
        assert_eq!(decrypted, api_key);
    }

    #[test]
    fn test_decrypt_api_key_wrong_secret() {
        let api_key = "sk-1234567890abcdef";
        let secret: [u8; 32] = [
            116, 101, 115, 116, 95, 115, 101, 99, 114, 101, 116, 95, 51, 50, 95, 98,
            121, 116, 101, 115, 95, 108, 111, 110, 103, 95, 102, 111, 114, 95, 97, 101,
        ]; // "test_secret_32_bytes_long_for_ae" in bytes
        let wrong_secret: [u8; 32] = [
            100, 105, 102, 102, 101, 114, 101, 110, 116, 95, 115, 101, 99, 114, 101, 116,
            95, 51, 50, 95, 98, 121, 116, 101, 115, 95, 108, 111, 110, 103, 95, 104,
        ]; // "different_secret_32_bytes_long_h" in bytes

        let encrypted = crate::utils::encrypt_api_key(api_key, &secret).unwrap();

        let result = crate::utils::decrypt_api_key(&encrypted, &wrong_secret);
        assert!(result.is_err());
    }

    #[test]
    fn test_hash_refresh_token() {
        let token = "refresh_token_string";
        let hash1 = crate::utils::hash_refresh_token(token);
        let hash2 = crate::utils::hash_refresh_token(token);

        assert!(!hash1.is_empty());
        assert_eq!(hash1, hash2); // Same input should produce same hash
        assert_ne!(hash1, token); // Hash should be different from input
    }

    #[test]
    fn test_hash_refresh_token_different_inputs() {
        let token1 = "refresh_token_string_1";
        let token2 = "refresh_token_string_2";

        let hash1 = crate::utils::hash_refresh_token(token1);
        let hash2 = crate::utils::hash_refresh_token(token2);

        assert_ne!(hash1, hash2); // Different inputs should produce different hashes
    }

    // ============ Task 6：JWT typ 隔离（access / plan_link 互斥） ============

    use crate::AppError;

    #[test]
    fn test_access_token_carries_typ_access() {
        let token = crate::utils::generate_access_token(1, "u", TEST_SECRET, Duration::hours(1)).unwrap();
        let claims = crate::utils::verify_token(&token, TEST_SECRET).unwrap();
        assert_eq!(claims.typ.as_deref(), Some("access"), "new access tokens must carry typ=access");
    }

    /// 存量兼容：M1 签发的旧 token 无 typ 字段（None）→ verify_token 照常通过。
    #[test]
    fn test_legacy_token_without_typ_still_verifies() {
        use jsonwebtoken::{encode, EncodingKey, Header};
        use crate::models::Claims;

        let now = chrono::Utc::now();
        let claims = Claims {
            sub: "11".to_string(),
            username: "legacy".to_string(),
            exp: (now + Duration::hours(1)).timestamp(),
            iat: now.timestamp(),
            jti: String::new(),
            typ: None,
        };
        let token = encode(
            &Header::default(),
            &claims,
            &EncodingKey::from_secret(TEST_SECRET.as_ref()),
        )
        .unwrap();

        let decoded = crate::utils::verify_token(&token, TEST_SECRET).unwrap();
        assert_eq!(decoded.sub, "11");
        assert!(decoded.typ.is_none());
    }

    /// plan_link 往返：generate → verify 得回 (user_id, plan_id)。
    #[test]
    fn test_plan_link_token_round_trip() {
        let token =
            crate::utils::generate_plan_link_token(7, 42, TEST_SECRET, Duration::hours(1)).unwrap();
        let (user_id, plan_id) = crate::utils::verify_plan_link_token(&token, TEST_SECRET).unwrap();
        assert_eq!(user_id, 7);
        assert_eq!(plan_id, 42);
    }

    /// /api 侧隔离：plan_link token 不能当 access 用 —— verify_token（require_auth 底层）
    /// 对其返回 AuthInvalid（claims 结构不符 + typ 隔离，殊途同归 401）。
    #[test]
    fn test_plan_link_token_rejected_by_verify_token() {
        let token =
            crate::utils::generate_plan_link_token(7, 42, TEST_SECRET, Duration::hours(1)).unwrap();
        let err = crate::utils::verify_token(&token, TEST_SECRET).unwrap_err();
        assert!(matches!(err, AppError::AuthInvalid(_)), "got: {:?}", err);
    }

    /// /t/ 侧隔离：access token 交给 verify_plan_link_token → PermissionDenied（403 域内拒绝）。
    #[test]
    fn test_verify_plan_link_token_on_access_token_permission_denied() {
        let token = crate::utils::generate_access_token(1, "u", TEST_SECRET, Duration::hours(1)).unwrap();
        let err = crate::utils::verify_plan_link_token(&token, TEST_SECRET).unwrap_err();
        assert!(matches!(err, AppError::PermissionDenied), "got: {:?}", err);
    }

    /// 过期 plan_link → PermissionDenied（403，brief 错误语义）。
    /// 负 TTL 取 -120s：越过 default Validation 的 60s leeway，确保命中过期分支。
    #[test]
    fn test_verify_plan_link_token_expired_permission_denied() {
        let token =
            crate::utils::generate_plan_link_token(7, 42, TEST_SECRET, Duration::seconds(-120))
                .unwrap();
        let err = crate::utils::verify_plan_link_token(&token, TEST_SECRET).unwrap_err();
        assert!(matches!(err, AppError::PermissionDenied), "got: {:?}", err);
    }

    /// 签名无效 → AuthInvalid（401，沿用 jwt.rs 惯例）。
    #[test]
    fn test_verify_plan_link_token_wrong_secret_auth_invalid() {
        let token =
            crate::utils::generate_plan_link_token(7, 42, TEST_SECRET, Duration::hours(1)).unwrap();
        let err = crate::utils::verify_plan_link_token(&token, "wrong_secret").unwrap_err();
        assert!(matches!(err, AppError::AuthInvalid(_)), "got: {:?}", err);
    }

    /// typ 显式不符（伪造 plid 齐备但 typ=access 的 token）→ decode 成功后仍须 PermissionDenied。
    #[test]
    fn test_verify_plan_link_token_wrong_typ_after_decode_permission_denied() {
        use jsonwebtoken::{encode, EncodingKey, Header};
        use crate::models::PlanLinkClaims;

        let now = chrono::Utc::now();
        // 手工构造 typ="access" 且带 plid 的 token：能通过 PlanLinkClaims 反序列化，
        // 只能靠 decode 后的显式 typ 检查拦截。
        let claims = PlanLinkClaims {
            sub: "7".to_string(),
            plid: 42,
            exp: (now + Duration::hours(1)).timestamp(),
            typ: "access".to_string(),
        };
        let token = encode(
            &Header::default(),
            &claims,
            &EncodingKey::from_secret(TEST_SECRET.as_ref()),
        )
        .unwrap();

        let err = crate::utils::verify_plan_link_token(&token, TEST_SECRET).unwrap_err();
        assert!(matches!(err, AppError::PermissionDenied), "got: {:?}", err);
    }
}
