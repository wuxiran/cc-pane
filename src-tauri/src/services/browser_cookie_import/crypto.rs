//! Chromium（macOS）cookie 加解密原语。
//!
//! - key = PBKDF2-HMAC-SHA1(钥匙串密码, salt = "saltysalt", 1003 次, 16 字节)
//! - `v10` 前缀 → AES-128-CBC，IV = 16 个空格，PKCS7 填充
//! - cookies 库 meta.version ≥ 24 时，明文前 32 字节是 SHA-256(host_key)，需要去掉
//!
//! 这里只处理字节，不打印任何密钥 / 明文。

use aes::Aes128;
use cbc::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
use hmac::{Hmac, Mac};
use sha1::Sha1;

pub const KEY_LEN: usize = 16;
const SALT: &[u8] = b"saltysalt";
const ITERATIONS: u32 = 1003;
const IV: [u8; 16] = [b' '; 16];
const V10_PREFIX: &[u8] = b"v10";
/// cookies 库从这个 schema 版本起在明文前拼接 SHA-256(host_key)。
pub const HOST_DIGEST_SCHEMA_VERSION: i64 = 24;
const HOST_DIGEST_LEN: usize = 32;

type Aes128CbcDec = cbc::Decryptor<Aes128>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DecryptError {
    /// 不是 v10 前缀（例如 Windows 的 v20 app-bound 加密）
    UnsupportedVersion,
    /// 填充 / 长度不对，通常是密钥错误
    BadCiphertext,
    /// v24 前缀长度不足
    MissingHostDigest,
    /// 解出来不是 UTF-8
    NotUtf8,
}

/// PBKDF2-HMAC-SHA1，只需要单块（16 字节 < SHA1 的 20 字节输出）。
pub fn derive_key(password: &[u8]) -> [u8; KEY_LEN] {
    let new_mac = || Hmac::<Sha1>::new_from_slice(password).expect("HMAC accepts any key length");
    // U1 = PRF(P, S || INT(1))
    let mut mac = new_mac();
    mac.update(SALT);
    mac.update(&1u32.to_be_bytes());
    let mut u = mac.finalize().into_bytes();
    let mut t = u;
    for _ in 1..ITERATIONS {
        let mut mac = new_mac();
        mac.update(&u);
        u = mac.finalize().into_bytes();
        for (acc, b) in t.iter_mut().zip(u.iter()) {
            *acc ^= b;
        }
    }
    let mut key = [0u8; KEY_LEN];
    key.copy_from_slice(&t[..KEY_LEN]);
    key
}

/// 解密 `encrypted_value`，返回 cookie 明文。
pub fn decrypt_cookie_value(
    key: &[u8; KEY_LEN],
    encrypted: &[u8],
    schema_version: i64,
) -> Result<String, DecryptError> {
    let body = encrypted
        .strip_prefix(V10_PREFIX)
        .ok_or(DecryptError::UnsupportedVersion)?;
    if body.is_empty() || body.len() % 16 != 0 {
        return Err(DecryptError::BadCiphertext);
    }
    let mut buf = body.to_vec();
    let plain = Aes128CbcDec::new(key.into(), &IV.into())
        .decrypt_padded_mut::<Pkcs7>(&mut buf)
        .map_err(|_| DecryptError::BadCiphertext)?;
    let plain = if schema_version >= HOST_DIGEST_SCHEMA_VERSION {
        plain
            .get(HOST_DIGEST_LEN..)
            .ok_or(DecryptError::MissingHostDigest)?
    } else {
        plain
    };
    String::from_utf8(plain.to_vec()).map_err(|_| DecryptError::NotUtf8)
}

#[cfg(test)]
pub(crate) fn encrypt_for_test(
    key: &[u8; KEY_LEN],
    host_key: &str,
    value: &str,
    schema_version: i64,
) -> Vec<u8> {
    use cbc::cipher::BlockEncryptMut;
    use sha2::{Digest, Sha256};
    let mut plain = Vec::new();
    if schema_version >= HOST_DIGEST_SCHEMA_VERSION {
        plain.extend_from_slice(&Sha256::digest(host_key.as_bytes()));
    }
    plain.extend_from_slice(value.as_bytes());
    let msg_len = plain.len();
    plain.resize(msg_len + 16, 0);
    let ct = cbc::Encryptor::<Aes128>::new(key.into(), &IV.into())
        .encrypt_padded_mut::<Pkcs7>(&mut plain, msg_len)
        .unwrap()
        .to_vec();
    let mut out = V10_PREFIX.to_vec();
    out.extend_from_slice(&ct);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    #[test]
    fn browser_pbkdf2_matches_reference_implementation() {
        // 期望值来自 Python `hashlib.pbkdf2_hmac("sha1", pw, b"saltysalt", 1003, 16)`。
        assert_eq!(
            hex(&derive_key(b"peanuts")),
            "d9a09d499b4e1b7461f28e67972c6dbd"
        );
    }

    #[test]
    fn browser_decrypt_roundtrip_pre_v24() {
        let key = derive_key(b"test-password");
        let ct = encrypt_for_test(&key, ".example.com", "session=abc", 23);
        assert_eq!(decrypt_cookie_value(&key, &ct, 23).unwrap(), "session=abc");
    }

    #[test]
    fn browser_decrypt_v24_strips_host_digest() {
        let key = derive_key(b"test-password");
        let ct = encrypt_for_test(&key, ".example.com", "tok", 24);
        assert_eq!(decrypt_cookie_value(&key, &ct, 24).unwrap(), "tok");
        // 若误当旧版本解，会把 32 字节摘要当明文 → 大概率非 UTF-8 或不相等
        assert_ne!(
            decrypt_cookie_value(&key, &ct, 23).ok().as_deref(),
            Some("tok")
        );
    }

    #[test]
    fn browser_decrypt_v24_empty_value() {
        let key = derive_key(b"pw");
        let ct = encrypt_for_test(&key, "example.com", "", 24);
        assert_eq!(decrypt_cookie_value(&key, &ct, 24).unwrap(), "");
    }

    #[test]
    fn browser_decrypt_rejects_wrong_key_and_prefix() {
        let key = derive_key(b"right");
        let ct = encrypt_for_test(&key, "a.com", "value-long-enough-0123456789", 23);
        let wrong = derive_key(b"wrong");
        assert!(decrypt_cookie_value(&wrong, &ct, 23).is_err());
        let mut v20 = ct.clone();
        v20[1] = b'2';
        assert_eq!(
            decrypt_cookie_value(&key, &v20, 23),
            Err(DecryptError::UnsupportedVersion)
        );
        assert_eq!(
            decrypt_cookie_value(&key, b"v10abc", 23),
            Err(DecryptError::BadCiphertext)
        );
    }
}
