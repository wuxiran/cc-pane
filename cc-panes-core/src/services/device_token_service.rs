//! 设备令牌：让另一台 CC-Panes（桌面端）以 Bearer 令牌访问本机的 cc-panes-web。
//!
//! 令牌只在创建时以明文返回一次，落盘的是 SHA-256 摘要（令牌本身是 32 字节随机数，
//! 不需要慢哈希）。存储在独立的 `device-tokens.json` 而不是 `config.toml`：
//! `cc-panes-web token create` 可以在服务运行时另起进程写入，服务端按文件 mtime
//! 重新加载，吊销即时生效，也不会和桌面端写 config.toml 互相覆盖。

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

use anyhow::{Context, Result};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::utils::atomic_file::write_atomic;

pub const DEVICE_TOKEN_PREFIX: &str = "ccp_dev_";
pub const DEVICE_TOKENS_FILE: &str = "device-tokens.json";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceTokenRecord {
    pub id: String,
    /// 使用该令牌的设备名（通常是对端桌面机的主机名）
    pub name: String,
    /// 令牌前若干位，仅用于在列表里辨认，不能用来鉴权
    pub hint: String,
    pub token_sha256: String,
    pub created_at: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceTokenFile {
    #[serde(default)]
    tokens: Vec<DeviceTokenRecord>,
    /// 当前有效的一次性配对码（只存摘要）。桌面端生成，cc-panes-web 进程兑换。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pairing: Option<PairingCode>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairingCode {
    code_sha256: String,
    expires_at: chrono::DateTime<chrono::Utc>,
    /// 剩余可尝试次数；用完即作废，防止在有效期内暴力枚举 6 位码。
    attempts_left: u8,
}

pub const PAIRING_CODE_TTL_SECS: i64 = 5 * 60;
const PAIRING_MAX_ATTEMPTS: u8 = 5;

/// 配对码兑换结果。
#[derive(Debug)]
pub enum PairingOutcome {
    Paired {
        record: DeviceTokenRecord,
        token: String,
    },
    /// 没有进行中的配对、已过期，或码不对
    Rejected,
}

#[derive(Default)]
struct Cache {
    modified: Option<SystemTime>,
    len: u64,
    tokens: Vec<DeviceTokenRecord>,
}

pub struct DeviceTokenService {
    path: PathBuf,
    cache: Mutex<Cache>,
    /// 进程内串行化读-改-写（并发配对请求不能互相覆盖）。
    write_lock: Mutex<()>,
}

impl DeviceTokenService {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            cache: Mutex::new(Cache::default()),
            write_lock: Mutex::new(()),
        }
    }

    pub fn in_data_dir(data_dir: &Path) -> Self {
        Self::new(data_dir.join(DEVICE_TOKENS_FILE))
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn list(&self) -> Vec<DeviceTokenRecord> {
        self.load()
    }

    pub fn has_tokens(&self) -> bool {
        !self.load().is_empty()
    }

    /// 创建令牌，返回记录和**唯一一次**可见的明文令牌。
    pub fn create(&self, name: &str) -> Result<(DeviceTokenRecord, String)> {
        let name = name.trim();
        let name = if name.is_empty() { "device" } else { name };
        let token = generate_token();
        let record = DeviceTokenRecord {
            id: uuid::Uuid::new_v4().to_string(),
            name: name.to_string(),
            hint: token.chars().take(DEVICE_TOKEN_PREFIX.len() + 6).collect(),
            token_sha256: sha256_hex(&token),
            created_at: chrono::Utc::now().to_rfc3339(),
        };
        let _guard = self
            .write_lock
            .lock()
            .unwrap_or_else(|err| err.into_inner());
        let mut file = self.read_file()?;
        file.tokens.push(record.clone());
        self.write_file(&file)?;
        Ok((record, token))
    }

    /// 生成新的 6 位一次性配对码（覆盖旧的），返回明文码和过期时间。
    pub fn create_pairing_code(&self) -> Result<(String, chrono::DateTime<chrono::Utc>)> {
        let code = format!("{:06}", OsRng.next_u32() % 1_000_000);
        let expires_at = chrono::Utc::now() + chrono::Duration::seconds(PAIRING_CODE_TTL_SECS);
        let _guard = self
            .write_lock
            .lock()
            .unwrap_or_else(|err| err.into_inner());
        let mut file = self.read_file()?;
        file.pairing = Some(PairingCode {
            code_sha256: sha256_hex(&code),
            expires_at,
            attempts_left: PAIRING_MAX_ATTEMPTS,
        });
        self.write_file(&file)?;
        Ok((code, expires_at))
    }

    pub fn cancel_pairing(&self) -> Result<()> {
        let _guard = self
            .write_lock
            .lock()
            .unwrap_or_else(|err| err.into_inner());
        let mut file = self.read_file()?;
        if file.pairing.take().is_some() {
            self.write_file(&file)?;
        }
        Ok(())
    }

    /// 是否有进行中（未过期、还有尝试次数）的配对。
    pub fn pairing_active(&self) -> bool {
        self.read_file()
            .ok()
            .and_then(|file| file.pairing)
            .is_some_and(|pairing| {
                pairing.attempts_left > 0 && pairing.expires_at > chrono::Utc::now()
            })
    }

    /// 用配对码换设备令牌。成功后配对码立即作废；失败会消耗一次尝试机会。
    pub fn redeem_pairing_code(&self, code: &str, device_name: &str) -> Result<PairingOutcome> {
        let _guard = self
            .write_lock
            .lock()
            .unwrap_or_else(|err| err.into_inner());
        let mut file = self.read_file()?;
        let Some(mut pairing) = file.pairing.take() else {
            return Ok(PairingOutcome::Rejected);
        };
        if pairing.expires_at <= chrono::Utc::now() || pairing.attempts_left == 0 {
            self.write_file(&file)?;
            return Ok(PairingOutcome::Rejected);
        }
        let digest = sha256_hex(code.trim());
        if !constant_time_eq(pairing.code_sha256.as_bytes(), digest.as_bytes()) {
            pairing.attempts_left -= 1;
            if pairing.attempts_left > 0 {
                file.pairing = Some(pairing);
            }
            self.write_file(&file)?;
            return Ok(PairingOutcome::Rejected);
        }
        let name = device_name.trim();
        let name = if name.is_empty() { "device" } else { name };
        let token = generate_token();
        let record = DeviceTokenRecord {
            id: uuid::Uuid::new_v4().to_string(),
            name: name.to_string(),
            hint: token.chars().take(DEVICE_TOKEN_PREFIX.len() + 6).collect(),
            token_sha256: sha256_hex(&token),
            created_at: chrono::Utc::now().to_rfc3339(),
        };
        file.tokens.push(record.clone());
        self.write_file(&file)?;
        Ok(PairingOutcome::Paired { record, token })
    }

    /// 按 id 吊销；`id` 也接受设备名（同名全部吊销），方便命令行使用。
    pub fn revoke(&self, id_or_name: &str) -> Result<usize> {
        let _guard = self
            .write_lock
            .lock()
            .unwrap_or_else(|err| err.into_inner());
        let mut file = self.read_file()?;
        let before = file.tokens.len();
        file.tokens
            .retain(|record| record.id != id_or_name && record.name != id_or_name);
        let removed = before - file.tokens.len();
        if removed > 0 {
            self.write_file(&file)?;
        }
        Ok(removed)
    }

    pub fn verify(&self, token: &str) -> Option<DeviceTokenRecord> {
        let token = token.trim();
        if !token.starts_with(DEVICE_TOKEN_PREFIX) {
            return None;
        }
        let digest = sha256_hex(token);
        self.load()
            .into_iter()
            .find(|record| constant_time_eq(record.token_sha256.as_bytes(), digest.as_bytes()))
    }

    fn load(&self) -> Vec<DeviceTokenRecord> {
        let meta = std::fs::metadata(&self.path).ok();
        let modified = meta.as_ref().and_then(|meta| meta.modified().ok());
        let len = meta.as_ref().map_or(0, |meta| meta.len());
        let mut cache = self.cache.lock().unwrap_or_else(|err| err.into_inner());
        if meta.is_none() {
            cache.modified = None;
            cache.len = 0;
            cache.tokens.clear();
            return Vec::new();
        }
        if cache.modified != modified || cache.len != len {
            match self.read_file() {
                Ok(file) => {
                    cache.tokens = file.tokens;
                    cache.modified = modified;
                    cache.len = len;
                }
                Err(error) => {
                    // 文件损坏时宁可全部拒绝，也不沿用可能已被吊销的旧缓存。
                    tracing::warn!(%error, path = %self.path.display(), "device token file unreadable");
                    cache.tokens.clear();
                    cache.modified = None;
                    cache.len = 0;
                }
            }
        }
        cache.tokens.clone()
    }

    fn read_file(&self) -> Result<DeviceTokenFile> {
        match std::fs::read_to_string(&self.path) {
            Ok(text) if text.trim().is_empty() => Ok(DeviceTokenFile::default()),
            Ok(text) => serde_json::from_str(&text)
                .with_context(|| format!("invalid {}", self.path.display())),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Ok(DeviceTokenFile::default())
            }
            Err(error) => Err(error).with_context(|| format!("read {}", self.path.display())),
        }
    }

    fn write_file(&self, file: &DeviceTokenFile) -> Result<()> {
        let json = serde_json::to_string_pretty(file)?;
        write_atomic(&self.path, json)?;
        restrict_permissions(&self.path);
        // 下一次 load 按新的 mtime 重读
        let mut cache = self.cache.lock().unwrap_or_else(|err| err.into_inner());
        cache.modified = None;
        Ok(())
    }
}

#[cfg(unix)]
fn restrict_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &Path) {}

fn generate_token() -> String {
    let mut bytes = [0_u8; 32];
    OsRng.fill_bytes(&mut bytes);
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("{DEVICE_TOKEN_PREFIX}{hex}")
}

fn sha256_hex(value: &str) -> String {
    Sha256::digest(value.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    left.len() == right.len()
        && left
            .iter()
            .zip(right)
            .fold(0_u8, |acc, (a, b)| acc | (a ^ b))
            == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_service(name: &str) -> DeviceTokenService {
        let dir = std::env::temp_dir().join(format!(
            "cc-panes-device-token-{name}-{}",
            uuid::Uuid::new_v4()
        ));
        DeviceTokenService::in_data_dir(&dir)
    }

    #[test]
    fn create_verify_revoke_roundtrip() {
        let service = temp_service("roundtrip");
        assert!(!service.has_tokens());
        let (record, token) = service.create("laptop").expect("create");
        assert!(token.starts_with(DEVICE_TOKEN_PREFIX));
        assert_ne!(record.token_sha256, token, "plaintext must not be stored");
        assert_eq!(
            service.verify(&token).map(|r| r.id),
            Some(record.id.clone())
        );
        assert!(service.verify("ccp_dev_nope").is_none());
        assert!(service.verify(&record.token_sha256).is_none());

        assert_eq!(service.revoke(&record.id).expect("revoke"), 1);
        assert!(service.verify(&token).is_none());
    }

    #[test]
    fn external_writer_is_picked_up() {
        let service = temp_service("external");
        let other = DeviceTokenService::new(service.path().to_path_buf());
        assert!(service.list().is_empty());
        let (_, token) = other.create("desk").expect("create");
        assert!(service.verify(&token).is_some());
        other.revoke("desk").expect("revoke by name");
        assert!(service.verify(&token).is_none());
    }

    #[test]
    fn pairing_code_is_single_use_and_limited_in_attempts() {
        let service = temp_service("pairing");
        assert!(matches!(
            service.redeem_pairing_code("123456", "x").expect("redeem"),
            PairingOutcome::Rejected
        ));

        let (code, _) = service.create_pairing_code().expect("code");
        assert_eq!(code.len(), 6);
        assert!(service.pairing_active());
        let wrong = if code == "000000" { "111111" } else { "000000" };
        assert!(matches!(
            service.redeem_pairing_code(wrong, "x").expect("redeem"),
            PairingOutcome::Rejected
        ));
        let PairingOutcome::Paired { record, token } = service
            .redeem_pairing_code(&code, "laptop")
            .expect("redeem")
        else {
            panic!("correct code must pair");
        };
        assert_eq!(record.name, "laptop");
        assert!(service.verify(&token).is_some());
        // 用过即作废
        assert!(!service.pairing_active());
        assert!(matches!(
            service.redeem_pairing_code(&code, "again").expect("redeem"),
            PairingOutcome::Rejected
        ));

        // 错 5 次作废，正确码也不再可用
        let (code, _) = service.create_pairing_code().expect("code");
        let wrong = if code == "000000" { "111111" } else { "000000" };
        for _ in 0..PAIRING_MAX_ATTEMPTS {
            service.redeem_pairing_code(wrong, "x").expect("redeem");
        }
        assert!(!service.pairing_active());
        assert!(matches!(
            service.redeem_pairing_code(&code, "x").expect("redeem"),
            PairingOutcome::Rejected
        ));
        // 令牌没有被配对码逻辑冲掉
        assert!(service.verify(&token).is_some());
    }

    #[test]
    fn corrupt_file_rejects_everything() {
        let service = temp_service("corrupt");
        let (_, token) = service.create("desk").expect("create");
        assert!(service.verify(&token).is_some());
        std::fs::write(service.path(), "{not json").expect("corrupt");
        assert!(service.verify(&token).is_none());
    }
}
