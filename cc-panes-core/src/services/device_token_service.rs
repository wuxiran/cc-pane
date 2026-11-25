//! 设备令牌：让另一台 CC-Panes（桌面端）以 Bearer 令牌访问本机的 cc-panes-web。
//!
//! 令牌只在创建时以明文返回一次，落盘的是 SHA-256 摘要（令牌本身是 32 字节随机数，
//! 不需要慢哈希）。存储在独立的 `device-tokens.json` 而不是 `config.toml`：
//! `cc-panes-web token create` 可以在服务运行时另起进程写入，服务端按文件 mtime
//! 重新加载，吊销即时生效，也不会和桌面端写 config.toml 互相覆盖。
//!
//! 活跃度（最后在线时间 / IP）另存 `device-token-activity.json`，而**不**写回令牌文件：
//! 令牌文件只在创建 / 吊销时改写，鉴权热路径上的节流写入绝不会和另一进程的吊销
//! 互相覆盖（读-改-写跨进程没有锁，写回令牌文件可能把刚吊销的令牌复活）。

use std::collections::HashMap;

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

use anyhow::{Context, Result};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::utils::atomic_file::write_atomic;

pub const DEVICE_TOKEN_PREFIX: &str = "ccp_dev_";
pub const DEVICE_TOKENS_FILE: &str = "device-tokens.json";
pub const DEVICE_TOKEN_ACTIVITY_FILE: &str = "device-token-activity.json";
/// 新配对令牌的默认有效期（天）。
pub const DEFAULT_DEVICE_TOKEN_TTL_DAYS: u32 = 90;
/// 同一令牌两次活跃度落盘的最小间隔：避免每个请求都改写文件。
const ACTIVITY_WRITE_INTERVAL: Duration = Duration::from_secs(60);

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
    /// 过期时间（RFC 3339）。缺省 = 永不过期：老令牌与 `cc-panes-web token create` 建的令牌不受影响。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
}

impl DeviceTokenRecord {
    /// 是否已过期。`expires_at` 无法解析时按已过期处理（fail-closed）。
    pub fn is_expired_at(&self, now: chrono::DateTime<chrono::Utc>) -> bool {
        self.expires_at.as_deref().is_some_and(|value| {
            chrono::DateTime::parse_from_rfc3339(value)
                .map(|at| at.with_timezone(&chrono::Utc) <= now)
                .unwrap_or(true)
        })
    }
}

/// 令牌的活跃度（单独落盘，见模块文档）。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceTokenActivity {
    pub last_seen_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_ip: Option<String>,
}

/// 给界面看的设备条目：不含令牌摘要，附带活跃度与过期状态。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceAccessEntry {
    pub id: String,
    pub name: String,
    pub hint: String,
    pub created_at: String,
    pub expires_at: Option<String>,
    pub expired: bool,
    pub last_seen_at: Option<String>,
    pub last_ip: Option<String>,
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
    /// 兑换出的令牌有效期（天）。缺省 = 永不过期（老版本桌面端写的配对码）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    token_ttl_days: Option<u32>,
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
    /// 每个令牌最近一次活跃度落盘的时刻（节流用，进程内）。
    activity_writes: Mutex<HashMap<String, Instant>>,
}

impl DeviceTokenService {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            cache: Mutex::new(Cache::default()),
            write_lock: Mutex::new(()),
            activity_writes: Mutex::new(HashMap::new()),
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

    /// 创建令牌，返回记录和**唯一一次**可见的明文令牌。永不过期（命令行建的令牌）。
    pub fn create(&self, name: &str) -> Result<(DeviceTokenRecord, String)> {
        self.create_with_ttl(name, None)
    }

    /// 创建令牌；`ttl_days` 为 `None` = 永不过期。
    pub fn create_with_ttl(
        &self,
        name: &str,
        ttl_days: Option<u32>,
    ) -> Result<(DeviceTokenRecord, String)> {
        let (record, token) = new_record(name, ttl_days);
        let _guard = self
            .write_lock
            .lock()
            .unwrap_or_else(|err| err.into_inner());
        let mut file = self.read_file()?;
        file.tokens.push(record.clone());
        self.write_file(&file)?;
        Ok((record, token))
    }

    /// 生成新的 6 位一次性配对码（覆盖旧的），兑换出的令牌按默认有效期过期。
    pub fn create_pairing_code(&self) -> Result<(String, chrono::DateTime<chrono::Utc>)> {
        self.create_pairing_code_with_ttl(Some(DEFAULT_DEVICE_TOKEN_TTL_DAYS))
    }

    /// 生成新的 6 位一次性配对码（覆盖旧的），返回明文码和过期时间。
    /// `token_ttl_days` 决定兑换出的令牌多久后过期，`None` = 永不过期。
    pub fn create_pairing_code_with_ttl(
        &self,
        token_ttl_days: Option<u32>,
    ) -> Result<(String, chrono::DateTime<chrono::Utc>)> {
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
            token_ttl_days: token_ttl_days.filter(|days| *days > 0),
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
        let (record, token) = new_record(device_name, pairing.token_ttl_days);
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

    /// 吊销除 `keep_id` 以外的全部令牌，返回吊销数量。
    pub fn revoke_all_except(&self, keep_id: Option<&str>) -> Result<usize> {
        let _guard = self
            .write_lock
            .lock()
            .unwrap_or_else(|err| err.into_inner());
        let mut file = self.read_file()?;
        let before = file.tokens.len();
        file.tokens
            .retain(|record| Some(record.id.as_str()) == keep_id);
        let removed = before - file.tokens.len();
        if removed > 0 {
            self.write_file(&file)?;
        }
        Ok(removed)
    }

    /// 校验令牌：摘要匹配且未过期。不记录活跃度。
    pub fn verify(&self, token: &str) -> Option<DeviceTokenRecord> {
        let token = token.trim();
        if !token.starts_with(DEVICE_TOKEN_PREFIX) {
            return None;
        }
        let digest = sha256_hex(token);
        let now = chrono::Utc::now();
        self.load()
            .into_iter()
            .find(|record| constant_time_eq(record.token_sha256.as_bytes(), digest.as_bytes()))
            .filter(|record| !record.is_expired_at(now))
    }

    /// 校验令牌并记录活跃度（同一令牌每分钟至多落盘一次）。落盘失败只告警，不影响鉴权。
    pub fn verify_and_touch(&self, token: &str, ip: Option<&str>) -> Option<DeviceTokenRecord> {
        let record = self.verify(token)?;
        if let Err(error) = self.touch(&record.id, ip) {
            tracing::warn!(%error, "failed to record device token activity");
        }
        Some(record)
    }

    /// 记录一次活跃；返回是否真的写了文件（被节流时为 false）。
    pub fn touch(&self, id: &str, ip: Option<&str>) -> Result<bool> {
        {
            let mut writes = self
                .activity_writes
                .lock()
                .unwrap_or_else(|err| err.into_inner());
            let now = Instant::now();
            if writes
                .get(id)
                .is_some_and(|last| now.duration_since(*last) < ACTIVITY_WRITE_INTERVAL)
            {
                return Ok(false);
            }
            writes.insert(id.to_string(), now);
        }
        let _guard = self
            .write_lock
            .lock()
            .unwrap_or_else(|err| err.into_inner());
        let live: Vec<String> = self.load().into_iter().map(|record| record.id).collect();
        let mut activity = self.read_activity();
        activity.retain(|key, _| live.contains(key));
        activity.insert(
            id.to_string(),
            DeviceTokenActivity {
                last_seen_at: chrono::Utc::now().to_rfc3339(),
                last_ip: ip.map(str::to_string).filter(|value| !value.is_empty()),
            },
        );
        let json = serde_json::to_string_pretty(&activity)?;
        let path = self.activity_path();
        write_atomic(&path, json)?;
        restrict_permissions(&path);
        Ok(true)
    }

    /// 界面用的设备列表：附带活跃度与过期状态，不含令牌摘要。
    pub fn list_entries(&self) -> Vec<DeviceAccessEntry> {
        let activity = self.read_activity();
        let now = chrono::Utc::now();
        self.load()
            .into_iter()
            .map(|record| {
                let seen = activity.get(&record.id);
                DeviceAccessEntry {
                    expired: record.is_expired_at(now),
                    last_seen_at: seen.map(|value| value.last_seen_at.clone()),
                    last_ip: seen.and_then(|value| value.last_ip.clone()),
                    id: record.id,
                    name: record.name,
                    hint: record.hint,
                    created_at: record.created_at,
                    expires_at: record.expires_at,
                }
            })
            .collect()
    }

    fn activity_path(&self) -> PathBuf {
        self.path.with_file_name(DEVICE_TOKEN_ACTIVITY_FILE)
    }

    /// 活跃度只是展示用：读不到 / 损坏一律当作空。
    fn read_activity(&self) -> HashMap<String, DeviceTokenActivity> {
        std::fs::read_to_string(self.activity_path())
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
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

fn new_record(name: &str, ttl_days: Option<u32>) -> (DeviceTokenRecord, String) {
    let name = name.trim();
    let name = if name.is_empty() { "device" } else { name };
    let token = generate_token();
    let now = chrono::Utc::now();
    let record = DeviceTokenRecord {
        id: uuid::Uuid::new_v4().to_string(),
        name: name.to_string(),
        hint: token.chars().take(DEVICE_TOKEN_PREFIX.len() + 6).collect(),
        token_sha256: sha256_hex(&token),
        created_at: now.to_rfc3339(),
        expires_at: ttl_days
            .filter(|days| *days > 0)
            .map(|days| (now + chrono::Duration::days(i64::from(days))).to_rfc3339()),
    };
    (record, token)
}

fn generate_token() -> String {
    let mut bytes = [0_u8; 32];
    OsRng.fill_bytes(&mut bytes);
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("{DEVICE_TOKEN_PREFIX}{hex}")
}

pub fn sha256_hex(value: &str) -> String {
    Sha256::digest(value.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
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
    fn expired_tokens_are_rejected_and_listed_as_expired() {
        let service = temp_service("expiry");
        let (forever, forever_token) = service.create("old").expect("create");
        assert!(
            forever.expires_at.is_none(),
            "legacy/CLI tokens never expire"
        );
        let (_, fresh_token) = service.create_with_ttl("fresh", Some(30)).expect("create");
        let (stale, stale_token) = service.create_with_ttl("stale", Some(30)).expect("create");

        // 把 stale 的过期时间改到过去（模拟 30 天后）
        let mut file = service.read_file().expect("read");
        for record in &mut file.tokens {
            if record.id == stale.id {
                record.expires_at =
                    Some((chrono::Utc::now() - chrono::Duration::minutes(1)).to_rfc3339());
            }
        }
        service.write_file(&file).expect("write");

        assert!(service.verify(&forever_token).is_some());
        assert!(service.verify(&fresh_token).is_some());
        assert!(
            service.verify(&stale_token).is_none(),
            "expired token must be rejected"
        );
        assert!(service
            .verify_and_touch(&stale_token, Some("10.0.0.1"))
            .is_none());

        let entries = service.list_entries();
        let stale_entry = entries
            .iter()
            .find(|entry| entry.id == stale.id)
            .expect("listed");
        assert!(stale_entry.expired);
        assert!(entries
            .iter()
            .filter(|entry| entry.id != stale.id)
            .all(|entry| !entry.expired));
        // 已过期的令牌仍可移除
        assert_eq!(service.revoke(&stale.id).expect("revoke"), 1);
    }

    #[test]
    fn legacy_records_without_expiry_deserialize_as_never_expiring() {
        let service = temp_service("legacy");
        std::fs::create_dir_all(service.path().parent().unwrap()).unwrap();
        std::fs::write(
            service.path(),
            r#"{"tokens":[{"id":"a","name":"n","hint":"h","tokenSha256":"x","createdAt":"2024-01-01T00:00:00Z"}]}"#,
        )
        .unwrap();
        let entries = service.list_entries();
        assert_eq!(entries.len(), 1);
        assert!(entries[0].expires_at.is_none());
        assert!(!entries[0].expired);
    }

    #[test]
    fn pairing_ttl_is_applied_to_redeemed_token() {
        let service = temp_service("pairing-ttl");
        let (code, _) = service.create_pairing_code().expect("code");
        let PairingOutcome::Paired { record, .. } = service
            .redeem_pairing_code(&code, "laptop")
            .expect("redeem")
        else {
            panic!("pair");
        };
        let expires = chrono::DateTime::parse_from_rfc3339(record.expires_at.as_deref().unwrap())
            .unwrap()
            .with_timezone(&chrono::Utc);
        let days = (expires - chrono::Utc::now()).num_days();
        assert!(
            (89..=90).contains(&days),
            "default ttl is 90 days, got {days}"
        );

        let (code, _) = service.create_pairing_code_with_ttl(None).expect("code");
        let PairingOutcome::Paired { record, .. } =
            service.redeem_pairing_code(&code, "desk").expect("redeem")
        else {
            panic!("pair");
        };
        assert!(record.expires_at.is_none(), "never = no expiry");
    }

    #[test]
    fn activity_is_recorded_and_throttled_without_touching_token_file() {
        let service = temp_service("activity");
        let (record, token) = service.create("laptop").expect("create");
        let tokens_before = std::fs::read_to_string(service.path()).expect("tokens");

        assert!(service
            .verify_and_touch(&token, Some("192.168.1.5"))
            .is_some());
        let entry = service.list_entries().remove(0);
        assert_eq!(entry.last_ip.as_deref(), Some("192.168.1.5"));
        let first_seen = entry.last_seen_at.clone().expect("seen");

        // 一分钟内的第二次鉴权不落盘
        assert!(!service
            .touch(&record.id, Some("192.168.1.9"))
            .expect("touch"));
        let entry = service.list_entries().remove(0);
        assert_eq!(entry.last_ip.as_deref(), Some("192.168.1.5"));
        assert_eq!(entry.last_seen_at.as_deref(), Some(first_seen.as_str()));

        // 节流窗口过去后再写
        service
            .activity_writes
            .lock()
            .unwrap()
            .insert(record.id.clone(), Instant::now() - ACTIVITY_WRITE_INTERVAL);
        assert!(service
            .touch(&record.id, Some("192.168.1.9"))
            .expect("touch"));
        assert_eq!(
            service.list_entries().remove(0).last_ip.as_deref(),
            Some("192.168.1.9")
        );

        // 令牌文件从未被活跃度改写：另一进程的吊销不会被覆盖
        assert_eq!(
            std::fs::read_to_string(service.path()).expect("tokens"),
            tokens_before
        );
        let other = DeviceTokenService::new(service.path().to_path_buf());
        other.revoke(&record.id).expect("revoke");
        assert!(service
            .verify_and_touch(&token, Some("192.168.1.9"))
            .is_none());
    }

    #[test]
    fn revoke_all_except_keeps_the_caller() {
        let service = temp_service("revoke-others");
        let (keep, keep_token) = service.create("me").expect("create");
        let (_, other_a) = service.create("a").expect("create");
        let (_, other_b) = service.create_with_ttl("b", Some(30)).expect("create");
        assert_eq!(
            service.revoke_all_except(Some(&keep.id)).expect("revoke"),
            2
        );
        assert!(service.verify(&keep_token).is_some());
        assert!(service.verify(&other_a).is_none());
        assert!(service.verify(&other_b).is_none());
        assert_eq!(service.revoke_all_except(None).expect("revoke"), 1);
        assert!(service.list().is_empty());
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
