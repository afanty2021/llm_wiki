use aes_gcm::{
    aead::{Aead, AeadCore, KeyInit, OsRng},
    Aes256Gcm, Key, Nonce
};
use sha2::{Sha256, Digest};
use crate::AppError;

/// Hash a password using bcrypt
pub fn hash_password(password: &str) -> Result<String, AppError> {
    bcrypt::hash(password, bcrypt::DEFAULT_COST)
        .map_err(|e| AppError::InternalError(format!("Password hashing failed: {}", e)))
}

/// Verify a password against a bcrypt hash
pub fn verify_password(password: &str, hash: &str) -> Result<bool, AppError> {
    bcrypt::verify(password, hash)
        .map_err(|e| AppError::InternalError(format!("Password verification failed: {}", e)))
}

/// Encrypt an API key using AES-256-GCM
/// Returns hex-encoded (nonce + ciphertext)
pub fn encrypt_api_key(api_key: &str, secret: &[u8; 32]) -> Result<String, AppError> {
    let key = Key::<Aes256Gcm>::from_slice(secret);
    let cipher = Aes256Gcm::new(key);

    // Generate random nonce (must be unique for each encryption)
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);

    let ciphertext = cipher.encrypt(&nonce, api_key.as_bytes())
        .map_err(|e| AppError::EncryptionError(format!("Encryption failed: {}", e)))?;

    // Combine nonce + ciphertext and encode as hex
    let mut combined = nonce.to_vec();
    combined.extend_from_slice(&ciphertext);
    Ok(hex::encode(combined))
}

/// Decrypt an API key using AES-256-GCM
/// Expects hex-encoded (nonce + ciphertext)
pub fn decrypt_api_key(encrypted: &str, secret: &[u8; 32]) -> Result<String, AppError> {
    let combined = hex::decode(encrypted)
        .map_err(|_| AppError::EncryptionError("Invalid hex encoding".to_string()))?;

    if combined.len() < 12 {
        return Err(AppError::EncryptionError("Invalid encrypted data".to_string()));
    }

    let (nonce_bytes, ciphertext) = combined.split_at(12);
    let nonce = Nonce::from_slice(nonce_bytes);
    let key = Key::<Aes256Gcm>::from_slice(secret);
    let cipher = Aes256Gcm::new(key);

    cipher
        .decrypt(nonce, ciphertext)
        .map(|bytes| String::from_utf8_lossy(&bytes).to_string())
        .map_err(|_| AppError::EncryptionError("Decryption failed".to_string()))
}

/// Hash a refresh token using SHA-256
/// Used for secure storage of refresh tokens in database
pub fn hash_refresh_token(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    let result = hasher.finalize();
    hex::encode(result)
}
