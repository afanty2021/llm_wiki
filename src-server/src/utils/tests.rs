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

        let encrypted = crate::utils::encrypt_api_key(api_key, &secret);
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

        let encrypted = crate::utils::encrypt_api_key(api_key, &secret);

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
}
