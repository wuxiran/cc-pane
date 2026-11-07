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
struct DeviceTokenFile {
    #[serde(default)]
    tokens: Vec<DeviceTokenRecord>,
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
}

impl DeviceTokenService {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            cache: Mutex::new(Cache::default()),
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
        let mut tokens = self.read_file()?;
        tokens.push(record.clone());
        self.write_file(&tokens)?;
        Ok((record, token))
    }

    /// 按 id 吊销；`id` 也接受设备名（同名全部吊销），方便命令行使用。
    pub fn revoke(&self, id_or_name: &str) -> Result<usize> {
        let mut tokens = self.read_file()?;
        let before = tokens.len();
        tokens.retain(|record| record.id != id_or_name && record.name != id_or_name);
        let removed = before - tokens.len();
        if removed > 0 {
            self.write_file(&tokens)?;
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
                Ok(tokens) => {
                    cache.tokens = tokens;
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

    fn read_file(&self) -> Result<Vec<DeviceTokenRecord>> {
        match std::fs::read_to_string(&self.path) {
            Ok(text) if text.trim().is_empty() => Ok(Vec::new()),
            Ok(text) => {
                let file: DeviceTokenFile = serde_json::from_str(&text)
                    .with_context(|| format!("invalid {}", self.path.display()))?;
                Ok(file.tokens)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(error) => Err(error).with_context(|| format!("read {}", self.path.display())),
        }
    }

    fn write_file(&self, tokens: &[DeviceTokenRecord]) -> Result<()> {
        let json = serde_json::to_string_pretty(&DeviceTokenFile {
            tokens: tokens.to_vec(),
        })?;
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
    fn corrupt_file_rejects_everything() {
        let service = temp_service("corrupt");
        let (_, token) = service.create("desk").expect("create");
        assert!(service.verify(&token).is_some());
        std::fs::write(service.path(), "{not json").expect("corrupt");
        assert!(service.verify(&token).is_none());
    }
}
