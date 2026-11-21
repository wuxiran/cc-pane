//! 供应商密钥存储：系统钥匙串（macOS 钥匙串 / Windows 凭据管理器 / Linux Secret Service）。
//!
//! 沿用 SSH 密码（`ssh_credential_service`）与设备令牌（`device_service`）的做法：
//! `keyring` crate + 可替换后端 + 进程内「临时值」覆盖层。
//!
//! **谁读钥匙串**：桌面主程序（以及独立运行的 `cc-panes-web`）。终端会话由常驻的
//! `cc-panes-daemon` 创建，它是另一个可执行文件——macOS 上不同可执行文件读同一条目会弹
//! 系统授权框。所以和 SSH 密码一样：主程序读出本次启动要用的密钥，经
//! [`ProviderSecretStore::set_temporary`] 推给 daemon 的内存，daemon 优先用这份，
//! 不落盘。
//!
//! **没有钥匙串时**（无界面 Linux、关掉 `secret-service` 特性的 `cc-panes-web`）：
//! [`ProviderSecretStore::is_available`] 为 false，调用方保持文件存储并标 `SecretStorage::File`。
//! 钥匙串可用但某次读写失败时返回错误，**不会**悄悄退回明文。
//!
//! 密钥值不进日志：这里的错误信息只带条目名（供应商 / 账号 id），从不带值。

use crate::utils::APP_DIR_NAME;
use anyhow::{Context, Result};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

/// 可替换的密钥后端。生产用系统钥匙串，测试用内存 / 故障替身。
pub trait ProviderSecretBackend: Send + Sync {
    /// 当前环境有没有可用的钥匙串。false 时调用方回退到文件存储。
    fn is_available(&self) -> bool;
    fn set(&self, key: &str, value: &str) -> Result<()>;
    fn get(&self, key: &str) -> Result<Option<String>>;
    fn delete(&self, key: &str) -> Result<()>;
}

struct SystemSecretBackend {
    service_name: String,
    available: OnceLock<bool>,
}

impl SystemSecretBackend {
    fn new() -> Self {
        Self {
            service_name: format!("cc-panes:{}:provider-secret", APP_DIR_NAME),
            available: OnceLock::new(),
        }
    }

    fn entry(&self, key: &str) -> Result<keyring::Entry> {
        keyring::Entry::new(&self.service_name, key)
            .with_context(|| format!("Failed to open system credential entry for {key}"))
    }

    /// Linux 上没编进 `secret-service` 特性时，keyring 会退回一个**不持久**的内存 mock，
    /// 写进去重启就没了——必须当作「没有钥匙串」。其余平台探测一次不存在的条目：
    /// 读到「无此条目」说明钥匙串能用（不会触发授权框），其它错误说明用不了。
    fn probe(&self) -> bool {
        if !cfg!(any(
            target_os = "macos",
            target_os = "windows",
            feature = "secret-service"
        )) {
            return false;
        }
        match self
            .entry("__availability_probe__")
            .and_then(|entry| match entry.get_password() {
                Ok(_) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(error) => Err(anyhow::Error::new(error)),
            }) {
            Ok(()) => true,
            Err(error) => {
                tracing::warn!(
                    error = %error,
                    "System credential store is unavailable; provider secrets stay in providers.json"
                );
                false
            }
        }
    }
}

impl ProviderSecretBackend for SystemSecretBackend {
    fn is_available(&self) -> bool {
        *self.available.get_or_init(|| self.probe())
    }

    fn set(&self, key: &str, value: &str) -> Result<()> {
        self.entry(key)?
            .set_password(value)
            .with_context(|| format!("Failed to store provider secret {key}"))
    }

    fn get(&self, key: &str) -> Result<Option<String>> {
        match self.entry(key)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => {
                Err(error).with_context(|| format!("Failed to read provider secret {key}"))
            }
        }
    }

    fn delete(&self, key: &str) -> Result<()> {
        match self.entry(key)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => {
                Err(error).with_context(|| format!("Failed to delete provider secret {key}"))
            }
        }
    }
}

#[derive(Default)]
struct MemorySecretBackend {
    entries: Mutex<HashMap<String, String>>,
}

impl ProviderSecretBackend for MemorySecretBackend {
    fn is_available(&self) -> bool {
        true
    }

    fn set(&self, key: &str, value: &str) -> Result<()> {
        self.entries
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(key.to_string(), value.to_string());
        Ok(())
    }

    fn get(&self, key: &str) -> Result<Option<String>> {
        Ok(self
            .entries
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(key)
            .cloned())
    }

    fn delete(&self, key: &str) -> Result<()> {
        self.entries
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(key);
        Ok(())
    }
}

/// 「没有钥匙串」后端：任何读写都报错，`is_available` 为 false。
struct UnavailableSecretBackend;

impl ProviderSecretBackend for UnavailableSecretBackend {
    fn is_available(&self) -> bool {
        false
    }

    fn set(&self, key: &str, _: &str) -> Result<()> {
        anyhow::bail!("No system credential store is available to store {key}")
    }

    fn get(&self, key: &str) -> Result<Option<String>> {
        anyhow::bail!("No system credential store is available to read {key}")
    }

    fn delete(&self, _: &str) -> Result<()> {
        Ok(())
    }
}

/// 供应商密钥存储：后端 + 进程内临时覆盖层。
pub struct ProviderSecretStore {
    backend: Arc<dyn ProviderSecretBackend>,
    /// 别的进程（主程序）推过来的、只活在本进程内存里的值。读取时优先于后端。
    temporary: Mutex<HashMap<String, String>>,
}

impl ProviderSecretStore {
    /// 系统钥匙串。
    pub fn system() -> Self {
        Self::with_backend(Arc::new(SystemSecretBackend::new()))
    }

    /// 内存后端（测试用；行为等同「钥匙串可用」）。
    pub fn memory() -> Self {
        Self::with_backend(Arc::new(MemorySecretBackend::default()))
    }

    /// 「没有钥匙串」：调用方会回退到文件存储。
    pub fn unavailable() -> Self {
        Self::with_backend(Arc::new(UnavailableSecretBackend))
    }

    pub fn with_backend(backend: Arc<dyn ProviderSecretBackend>) -> Self {
        Self {
            backend,
            temporary: Mutex::new(HashMap::new()),
        }
    }

    pub fn is_available(&self) -> bool {
        self.backend.is_available()
    }

    pub fn store(&self, key: &str, value: &str) -> Result<()> {
        self.backend.set(key, value)?;
        self.temporary_guard().remove(key);
        Ok(())
    }

    /// 读一条密钥：先看临时覆盖层，再读钥匙串。
    pub fn load(&self, key: &str) -> Result<Option<String>> {
        if let Some(value) = self.temporary_guard().get(key).cloned() {
            return Ok(Some(value));
        }
        self.backend.get(key)
    }

    pub fn delete(&self, key: &str) -> Result<()> {
        self.temporary_guard().remove(key);
        self.backend.delete(key)
    }

    /// 接收别的进程读好的密钥，只放内存。同名覆盖，不清其它条目。
    pub fn set_temporary(&self, entries: HashMap<String, String>) {
        self.temporary_guard().extend(entries);
    }

    fn temporary_guard(&self) -> std::sync::MutexGuard<'_, HashMap<String, String>> {
        self.temporary
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }
}

/// 密钥账号的密钥在钥匙串里的条目名。
pub fn account_secret_key(provider_id: &str, account_id: &str) -> String {
    format!("{provider_id}/account/{account_id}/key")
}

/// 账号一级敏感环境变量的条目名。
pub fn account_env_secret_key(provider_id: &str, account_id: &str, name: &str) -> String {
    format!("{provider_id}/account/{account_id}/env/{name}")
}

/// 供应商一级敏感环境变量的条目名。
pub fn provider_env_secret_key(provider_id: &str, name: &str) -> String {
    format!("{provider_id}/env/{name}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_store_round_trips_and_deletes() {
        let store = ProviderSecretStore::memory();
        assert!(store.is_available());
        store.store("p/account/a/key", "sk-1").unwrap();
        assert_eq!(
            store.load("p/account/a/key").unwrap().as_deref(),
            Some("sk-1")
        );
        store.delete("p/account/a/key").unwrap();
        assert_eq!(store.load("p/account/a/key").unwrap(), None);
    }

    #[test]
    fn unavailable_store_reports_unavailable_and_never_pretends_to_store() {
        let store = ProviderSecretStore::unavailable();
        assert!(!store.is_available());
        assert!(store.store("k", "v").is_err());
        assert!(store.load("k").is_err());
    }

    #[test]
    fn temporary_values_take_precedence_and_are_dropped_by_a_real_store() {
        let store = ProviderSecretStore::memory();
        store.store("k", "persisted").unwrap();
        store.set_temporary(HashMap::from([("k".to_string(), "pushed".to_string())]));
        assert_eq!(store.load("k").unwrap().as_deref(), Some("pushed"));
        store.store("k", "rotated").unwrap();
        assert_eq!(store.load("k").unwrap().as_deref(), Some("rotated"));
    }

    #[test]
    fn temporary_values_work_without_any_credential_store() {
        // daemon 侧：自己读不了钥匙串，也能用主程序推过来的值。
        let store = ProviderSecretStore::unavailable();
        store.set_temporary(HashMap::from([("k".to_string(), "pushed".to_string())]));
        assert_eq!(store.load("k").unwrap().as_deref(), Some("pushed"));
    }

    #[test]
    fn entry_names_are_distinct_per_scope() {
        assert_eq!(account_secret_key("p", "a"), "p/account/a/key");
        assert_eq!(account_env_secret_key("p", "a", "X"), "p/account/a/env/X");
        assert_eq!(provider_env_secret_key("p", "X"), "p/env/X");
    }
}
