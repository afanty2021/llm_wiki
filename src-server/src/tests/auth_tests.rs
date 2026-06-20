#[cfg(test)]
mod auth_tests {
    use chrono::{Duration, Utc};
    use crate::utils::{
        generate_access_token, verify_token, generate_refresh_token,
        verify_refresh_token, hash_password, verify_password,
        encrypt_api_key, decrypt_api_key, hash_refresh_token,
    };

    const TEST_SECRET: &str = "test_secret_key_for_jwt_token_generation_and_verification";
    const ENCRYPTION_SECRET: [u8; 32] = [
        116, 101, 115, 116, 95, 115, 101, 99, 114, 101, 116, 95, 51, 50, 95, 98,
        121, 116, 101, 115, 95, 108, 111, 110, 103, 95, 102, 111, 114, 95, 97, 101,
    ];
    const WRONG_SECRET: [u8; 32] = [
        100, 105, 102, 102, 101, 114, 101, 110, 116, 95, 115, 101, 99, 114, 101, 116,
        95, 51, 50, 95, 98, 121, 116, 101, 115, 95, 108, 111, 110, 103, 95, 104,
    ];

    // =========================================================================
    // Token generation edge cases
    // =========================================================================

    #[test]
    fn test_generate_access_token_with_zero_ttl() {
        let result = generate_access_token(1, "user", TEST_SECRET, Duration::seconds(0));
        assert!(result.is_ok());
        let token = result.unwrap();
        assert!(!token.is_empty());
    }

    #[test]
    fn test_generate_access_token_negative_user_id() {
        let result = generate_access_token(-1, "user", TEST_SECRET, Duration::hours(1));
        assert!(result.is_ok());
    }

    #[test]
    fn test_generate_access_token_special_characters_in_username() {
        let username = "user@domain.com/テスト_测试";
        let token = generate_access_token(1, username, TEST_SECRET, Duration::hours(1)).unwrap();
        let claims = verify_token(&token, TEST_SECRET).unwrap();
        assert_eq!(claims.username, username);
    }

    #[test]
    fn test_generate_access_token_empty_username() {
        let result = generate_access_token(1, "", TEST_SECRET, Duration::hours(1));
        assert!(result.is_ok());
    }

    #[test]
    fn test_generate_refresh_token_very_short_ttl() {
        let result = generate_refresh_token(1, TEST_SECRET, Duration::seconds(1));
        assert!(result.is_ok());
        let (token, jti) = result.unwrap();
        assert!(!token.is_empty());
        assert!(!jti.is_empty());
    }

    #[test]
    fn test_generate_refresh_token_uniqueness_of_jti() {
        let (_, jti1) = generate_refresh_token(1, TEST_SECRET, Duration::hours(1)).unwrap();
        let (_, jti2) = generate_refresh_token(1, TEST_SECRET, Duration::hours(1)).unwrap();
        assert_ne!(jti1, jti2, "JTI values should be unique UUIDs");
    }

    #[test]
    fn test_generate_refresh_token_uniqueness_of_token() {
        let (token1, _) = generate_refresh_token(1, TEST_SECRET, Duration::hours(1)).unwrap();
        let (token2, _) = generate_refresh_token(1, TEST_SECRET, Duration::hours(1)).unwrap();
        assert_ne!(token1, token2, "Refresh tokens should differ due to unique jti");
    }

    // =========================================================================
    // Token verification — edge cases and tampered tokens
    // =========================================================================

    #[test]
    fn test_verify_token_empty_string() {
        let result = verify_token("", TEST_SECRET);
        assert!(result.is_err());
    }

    #[test]
    fn test_verify_token_only_bearer_prefix() {
        let result = verify_token("Bearer ", TEST_SECRET);
        assert!(result.is_err());
    }

    #[test]
    fn test_verify_token_garbage_string() {
        let result = verify_token("this.is.not.a.valid.jwt.token", TEST_SECRET);
        assert!(result.is_err());
    }

    #[test]
    fn test_verify_token_tampered_payload() {
        let token = generate_access_token(42, "tamper_test", TEST_SECRET, Duration::hours(1)).unwrap();

        let parts: Vec<&str> = token.split('.').collect();
        assert_eq!(parts.len(), 3, "JWT should have 3 parts");

        let mut tampered_parts = parts.clone();
        let mut payload = tampered_parts[1].as_bytes().to_vec();
        if let Some(byte) = payload.get_mut(1) {
            *byte ^= 1; // flip one bit
        }
        tampered_parts[1] = std::str::from_utf8(&payload).unwrap_or(tampered_parts[1]);
        let tampered = tampered_parts.join(".");

        let result = verify_token(&tampered, TEST_SECRET);
        assert!(result.is_err());
    }

    #[test]
    fn test_verify_token_tampered_signature() {
        let token = generate_access_token(42, "sig_test", TEST_SECRET, Duration::hours(1)).unwrap();

        let parts: Vec<&str> = token.split('.').collect();
        let signature_tampered = parts[2].to_string() + "X";
        let tampered = format!("{}.{}.{}", parts[0], parts[1], signature_tampered);

        let result = verify_token(&tampered, TEST_SECRET);
        assert!(result.is_err());
    }

    #[test]
    fn test_verify_token_header_tampered() {
        let token = generate_access_token(99, "hdr_test", TEST_SECRET, Duration::hours(1)).unwrap();

        let parts: Vec<&str> = token.split('.').collect();
        // URL-safe base64 of {"alg":"HS256","typ":"JWT"}
        let fake_header = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
        let tampered = format!("{}.{}.{}", fake_header, parts[1], parts[2]);

        let result = verify_token(&tampered, TEST_SECRET);
        assert!(result.is_err());
    }

    #[test]
    fn test_verify_token_extra_parts() {
        let token = generate_access_token(1, "user", TEST_SECRET, Duration::hours(1)).unwrap();
        let malformed = format!("{}.extra", token);
        let result = verify_token(&malformed, TEST_SECRET);
        assert!(result.is_err());
    }

    #[test]
    fn test_verify_refresh_token_with_bearer_prefix() {
        let user_id = 777;
        let ttl = Duration::days(7);
        let (token, original_jti) = generate_refresh_token(user_id, TEST_SECRET, ttl).unwrap();
        let bearer_token = format!("Bearer {}", token);

        let (extracted_user_id, extracted_jti) =
            verify_refresh_token(&bearer_token, TEST_SECRET).unwrap();
        assert_eq!(extracted_user_id, user_id);
        assert_eq!(extracted_jti, original_jti);
    }

    #[test]
    fn test_verify_refresh_token_with_access_token() {
        // Access tokens can also be decoded as refresh tokens since the
        // structs overlap (extra fields are ignored by default serde).
        // However, the `jti` from an access token will be an empty string.
        let access_token = generate_access_token(1, "user", TEST_SECRET, Duration::hours(1)).unwrap();
        let result = verify_refresh_token(&access_token, TEST_SECRET);
        // It may or may not fail depending on exact claim structure.
        // The key insight: if it succeeds, the jti will be empty
        if let Ok((uid, jti)) = result {
            assert_eq!(uid, 1);
            assert!(jti.is_empty(), "Access token JTI should be empty");
        }
    }

    #[test]
    fn test_verify_refresh_token_tampered() {
        let (token, _) = generate_refresh_token(1, TEST_SECRET, Duration::days(7)).unwrap();
        let tampered = token + "x";
        let result = verify_refresh_token(&tampered, TEST_SECRET);
        assert!(result.is_err());
    }

    // =========================================================================
    // Token claims field validation
    // =========================================================================

    #[test]
    fn test_token_claims_iat_not_in_future() {
        let token = generate_access_token(42, "iat_test", TEST_SECRET, Duration::hours(1)).unwrap();
        let claims = verify_token(&token, TEST_SECRET).unwrap();
        let now = Utc::now().timestamp();
        assert!(claims.iat <= now, "iat should not be in the future");
    }

    #[test]
    fn test_token_claims_exp_is_correct() {
        let ttl = Duration::hours(2);
        let token = generate_access_token(42, "exp_test", TEST_SECRET, ttl).unwrap();
        let claims = verify_token(&token, TEST_SECRET).unwrap();
        let expected_exp = Utc::now().timestamp() + ttl.num_seconds();
        assert!((claims.exp - expected_exp).abs() <= 5,
            "exp should be within 5s of expected; got exp={}, expected_exp={}", claims.exp, expected_exp);
    }

    // =========================================================================
    // Edge cases: short TTLs and clock skew
    // =========================================================================

    #[test]
    fn test_verify_token_very_short_ttl() {
        let token = generate_access_token(1, "quick", TEST_SECRET, Duration::seconds(1)).unwrap();
        let result = verify_token(&token, TEST_SECRET);
        // The default validation has a small leeway so 1s TTL should be ok immediately
        assert!(result.is_ok(), "Token with 1s TTL should be valid immediately after generation");
    }

    #[test]
    fn test_token_expiry_behaviour() {
        // Generate token with very short negative TTL — exp is well in the past
        // jsonwebtoken default validation has a 60-second leeway, so use -120s
        let token = generate_access_token(1, "expired", TEST_SECRET, Duration::seconds(-120)).unwrap();
        let result = verify_token(&token, TEST_SECRET);
        assert!(result.is_err());
    }

    // =========================================================================
    // Password hashing — edge cases
    // =========================================================================

    #[test]
    fn test_hash_password_edge_cases() {
        // Very long password
        let long_password = "a".repeat(1024);
        let hash = hash_password(&long_password).unwrap();
        assert!(!hash.is_empty());
        assert!(verify_password(&long_password, &hash).unwrap());

        // Password with special characters
        let special = "p@$$w0rd!@#$%^&*()_+-=[]{}|;:',.<>?/~`";
        let hash = hash_password(special).unwrap();
        assert!(verify_password(special, &hash).unwrap());
        assert!(!verify_password("different", &hash).unwrap());

        // Unicode password
        let unicode = "パスワード🔐测试密码";
        let hash = hash_password(unicode).unwrap();
        assert!(verify_password(unicode, &hash).unwrap());
    }

    #[test]
    fn test_hash_password_uniqueness() {
        let password = "same_password";
        let hash1 = hash_password(password).unwrap();
        let hash2 = hash_password(password).unwrap();
        assert_ne!(hash1, hash2, "Bcrypt hashes should be unique due to salting");
        // Both should still verify correctly
        assert!(verify_password(password, &hash1).unwrap());
        assert!(verify_password(password, &hash2).unwrap());
    }

    #[test]
    fn test_verify_password_empty_password() {
        let hash = hash_password("some_password").unwrap();
        let result = verify_password("", &hash).unwrap();
        assert!(!result, "Empty password should not match");
    }

    #[test]
    fn test_verify_password_tampered_hash() {
        let password = "my_secret";
        let hash = hash_password(password).unwrap();

        // Corrupt the hash deterministically. 不可用 `hash.replace("a","b")`——
        // bcrypt 哈希是随机盐的 base64 串，约 39% 概率不含 'a'，此时 replace 是 no-op，
        // 哈希未变 → verify 返回 Ok(true) → 断言偶发失败（flaky）。
        // 改为翻转末位 hash 字符到保证不同的 bcrypt-base64 字符。
        let mut bytes = hash.into_bytes();
        let last = bytes.len() - 1;
        bytes[last] = if bytes[last] == b'a' { b'b' } else { b'a' };
        let tampered = String::from_utf8(bytes).unwrap();
        let result = verify_password(password, &tampered);
        match result {
            Ok(verified) => assert!(!verified, "Tampered hash should not verify as true"),
            Err(_) => {} // Error from tampered hash is also fine
        }
    }

    // =========================================================================
    // API key encryption — edge cases
    // =========================================================================

    #[test]
    fn test_encrypt_empty_string() {
        let result = encrypt_api_key("", &ENCRYPTION_SECRET);
        assert!(result.is_ok());
        let decrypted = decrypt_api_key(&result.unwrap(), &ENCRYPTION_SECRET).unwrap();
        assert_eq!(decrypted, "");
    }

    #[test]
    fn test_encrypt_long_api_key() {
        let api_key = "sk-".to_string() + &"a".repeat(4096);
        let encrypted = encrypt_api_key(&api_key, &ENCRYPTION_SECRET).unwrap();
        assert!(!encrypted.is_empty());
        let decrypted = decrypt_api_key(&encrypted, &ENCRYPTION_SECRET).unwrap();
        assert_eq!(decrypted, api_key);
    }

    #[test]
    fn test_encrypt_unicode_api_key() {
        let api_key = "sk-パスワード🔑测试";
        let encrypted = encrypt_api_key(api_key, &ENCRYPTION_SECRET).unwrap();
        let decrypted = decrypt_api_key(&encrypted, &ENCRYPTION_SECRET).unwrap();
        assert_eq!(decrypted, api_key);
    }

    #[test]
    fn test_encrypt_nonce_uniqueness() {
        let api_key = "sk-same-key-12345";
        let enc1 = encrypt_api_key(api_key, &ENCRYPTION_SECRET).unwrap();
        let enc2 = encrypt_api_key(api_key, &ENCRYPTION_SECRET).unwrap();
        assert_ne!(enc1, enc2, "Same plaintext should produce different ciphertext (nonce uniqueness)");
        // Both should decrypt to the same value
        assert_eq!(decrypt_api_key(&enc1, &ENCRYPTION_SECRET).unwrap(), api_key);
        assert_eq!(decrypt_api_key(&enc2, &ENCRYPTION_SECRET).unwrap(), api_key);
    }

    #[test]
    fn test_decrypt_invalid_hex() {
        let result = decrypt_api_key("not-valid-hex!!", &ENCRYPTION_SECRET);
        assert!(result.is_err());
    }

    #[test]
    fn test_decrypt_too_short_data() {
        // Need at least 12 bytes for the nonce — "aa" is 1 byte
        let result = decrypt_api_key("aa", &ENCRYPTION_SECRET);
        assert!(result.is_err());
    }

    #[test]
    fn test_decrypt_tampered_ciphertext() {
        let api_key = "sk-tamper-test-123";
        let encrypted = encrypt_api_key(api_key, &ENCRYPTION_SECRET).unwrap();

        let mut chars: Vec<char> = encrypted.chars().collect();
        // Flip the first hex char after the nonce (position 24 = nonce hex chars)
        if chars.len() > 24 {
            chars[24] = if chars[24] == 'a' { 'b' } else { 'a' };
        }
        let tampered: String = chars.into_iter().collect();

        let result = decrypt_api_key(&tampered, &ENCRYPTION_SECRET);
        assert!(result.is_err(), "Tampered ciphertext should fail decryption");
    }

    #[test]
    fn test_decrypt_wrong_encryption_key() {
        let api_key = "sk-encrypt-key-test";
        let encrypted = encrypt_api_key(api_key, &ENCRYPTION_SECRET).unwrap();
        let result = decrypt_api_key(&encrypted, &WRONG_SECRET);
        assert!(result.is_err());
    }

    // =========================================================================
    // Refresh token hashing — edge cases
    // =========================================================================

    #[test]
    fn test_hash_refresh_token_empty_string() {
        let hash = hash_refresh_token("");
        assert!(!hash.is_empty());
        assert_eq!(hash.len(), 64); // SHA-256 produces 32 bytes = 64 hex chars
    }

    #[test]
    fn test_hash_refresh_token_long_token() {
        let long_token = "x".repeat(10000);
        let hash = hash_refresh_token(&long_token);
        assert_eq!(hash.len(), 64);
    }

    #[test]
    fn test_hash_refresh_token_consistent() {
        let token = "consistent_refresh_token_for_testing";
        let hash1 = hash_refresh_token(token);
        let hash2 = hash_refresh_token(token);
        let hash3 = hash_refresh_token(token);
        assert_eq!(hash1, hash2);
        assert_eq!(hash2, hash3);
    }

    #[test]
    fn test_hash_refresh_token_no_collisions() {
        let hash1 = hash_refresh_token("token_v1");
        let hash2 = hash_refresh_token("token_v2");
        let hash3 = hash_refresh_token("token_v1 "); // trailing space
        assert_ne!(hash1, hash2);
        assert_ne!(hash1, hash3);
    }

    // =========================================================================
    // Integration-style: simulate a full auth lifecycle
    // =========================================================================

    #[test]
    fn test_full_auth_lifecycle_simulated() {
        // Simulate what happens in a real auth flow:
        // 1. User registers → password is hashed
        // 2. User logs in → password verified, tokens generated
        // 3. Access token used to authenticate requests
        // 4. Refresh token used to get new tokens
        // 5. Refresh token hashed for secure DB storage

        let user_id = 42;
        let username = "auth_lifecycle_test_user";
        let password = "SecureP@ssw0rd123!";

        // Step 1: Register — hash the password
        let password_hash = hash_password(password).unwrap();
        assert_ne!(password_hash, password);
        assert!(password_hash.starts_with("$2b$"));

        // Step 2: Login — verify password and generate tokens
        assert!(verify_password(password, &password_hash).unwrap());
        assert!(!verify_password("wrong_password", &password_hash).unwrap());

        let access_token = generate_access_token(user_id, username, TEST_SECRET, Duration::hours(1)).unwrap();
        let (refresh_token, jti) = generate_refresh_token(user_id, TEST_SECRET, Duration::days(7)).unwrap();

        assert!(!access_token.is_empty());
        assert!(!refresh_token.is_empty());
        assert!(!jti.is_empty());

        // Step 3: Authenticate requests — verify access token
        let claims = verify_token(&format!("Bearer {}", access_token), TEST_SECRET).unwrap();
        assert_eq!(claims.sub, user_id.to_string());
        assert_eq!(claims.username, username);

        // Step 4: Token refresh — verify and use refresh token
        let (extracted_user_id, extracted_jti) =
            verify_refresh_token(&refresh_token, TEST_SECRET).unwrap();
        assert_eq!(extracted_user_id, user_id);
        assert_eq!(extracted_jti, jti);

        // Step 5: Store refresh token hash in DB
        let refresh_hash = hash_refresh_token(&refresh_token);
        assert_eq!(refresh_hash.len(), 64);

        // Simulate DB lookup: hash the incoming token and compare
        let lookup_hash = hash_refresh_token(&refresh_token);
        assert_eq!(lookup_hash, refresh_hash);

        // A different token should NOT match
        let different_hash = hash_refresh_token("some_other_token");
        assert_ne!(different_hash, refresh_hash);

        // An invalid/expired access token should be rejected
        let result = verify_token("Bearer some.garbage.token", TEST_SECRET);
        assert!(result.is_err());
    }

    // =========================================================================
    // Test: Claims serialization round-trip (verification of sub structure)
    // =========================================================================

    #[test]
    fn test_multiple_users_distinct_tokens() {
        let users = vec![
            (1, "alice"),
            (2, "bob"),
            (3, "charlie"),
            (4, "diana"),
        ];

        let tokens: Vec<_> = users.iter().map(|(id, name)| {
            let token = generate_access_token(*id, name, TEST_SECRET, Duration::hours(1)).unwrap();
            (id, name, token)
        }).collect();

        // Verify each token independently
        for (expected_id, expected_name, token) in &tokens {
            let claims = verify_token(token, TEST_SECRET).unwrap();
            assert_eq!(claims.sub, expected_id.to_string());
            // expected_name is &&str, use * to get &str, then compare String to &str
            assert_eq!(claims.username, **expected_name);
        }

        // All tokens should be different
        for i in 0..tokens.len() {
            for j in (i + 1)..tokens.len() {
                assert_ne!(tokens[i].2, tokens[j].2,
                    "Tokens for different users should be unique");
            }
        }
    }
}
