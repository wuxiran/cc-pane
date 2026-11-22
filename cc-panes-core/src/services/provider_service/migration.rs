//! `providers.json` 的读取、旧格式迁移、密钥进钥匙串、落盘。
//!
//! 文件格式版本记在顶层 `schema_version`（见 `PROVIDER_SCHEMA_VERSION`）：
//! 旧文件没有这个字段（= 1），供应商上直接放 `apiKey` / `baseUrl` / `configDir`；
//! 2 起是「账号 + 多接口 + 环境变量」，密钥不落盘。
//!
//! 迁移步骤（只由「拥有者」进程做——桌面主程序或独立运行的 cc-panes-web；
//! daemon 只在内存里按新结构读，不写文件、不写钥匙串）：
//! 1. 读旧文件，在内存里变成新结构（旧 `apiKey` 先以明文挂在默认账号上）；
//! 2. 把原文件备份到同目录 `providers.json.bak-<时间戳>`；
//! 3. 密钥写进钥匙串（没有钥匙串时保留在文件里并标 `file`）；
//! 4. 原子写新文件。
//!
//! 第 3、4 步任一失败：撤回本次写进钥匙串的条目，原文件一个字节不动，
//! 本进程继续用内存里的结构工作，下次启动再试。重复执行结果相同。
//!
//! 备份带明文密钥，不长留：之后某次启动读到的已是新格式、无需再迁移，并且每个密钥都能
//! 定位（钥匙串里读得到 / `file` 的明文还在）时，删掉全部备份（见 `load_at_startup`）。

use super::{ProviderService, MAX_PROVIDER_CONFIG_BYTES, MAX_PROVIDER_COUNT, PROVIDER_CLI_TOOLS};
use crate::models::provider::{
    AccountKind, Provider, ProviderConfig, ProviderEnvVar, SecretStorage, PROVIDER_SCHEMA_VERSION,
    SYSTEM_PROVIDER_ID,
};
use crate::services::provider_secret_service::{
    account_env_secret_key, account_secret_key, provider_env_secret_key,
};
use anyhow::{Context, Result};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use tracing::{info, warn};

/// 落盘时从每条供应商上剥掉的兼容字段：它们只是内存 / 对外的镜像。
const LEGACY_PROVIDER_FIELDS: [&str; 3] = ["apiKey", "baseUrl", "configDir"];

/// 一次对钥匙串的写入：条目名，以及写之前它的值（没有则为 `None`）。
pub(super) struct SecretWrite {
    key: String,
    previous: Option<String>,
}

pub(super) struct LoadedConfig {
    pub config: ProviderConfig,
    /// 原文件内容，备份用。
    pub raw: String,
}

impl ProviderService {
    /// 读文件并在内存里归一成新结构。纯读，不写文件、不碰钥匙串。
    pub(super) fn load_from_file(path: &Path) -> Result<LoadedConfig> {
        if path.metadata().map(|metadata| metadata.len()).unwrap_or(0) > MAX_PROVIDER_CONFIG_BYTES {
            anyhow::bail!(
                "providers config exceeds {} bytes",
                MAX_PROVIDER_CONFIG_BYTES
            );
        }
        let raw =
            std::fs::read_to_string(path).with_context(|| "Failed to read providers config")?;
        // 加载层清洗：provider_type == "media" 是老媒体生成 Provider，功能已删除。
        // 必须按原始字符串过滤——删除 ProviderType::Media 变体后手写 Deserialize
        // 会把它回退为 Anthropic，导致一个 base_url 指向图片/视频 API 的假 Anthropic
        // Provider 出现在 LLM Provider 列表里。
        let mut parsed: serde_json::Value =
            serde_json::from_str(&raw).with_context(|| "Failed to parse providers.json")?;
        if let Some(providers) = parsed.get_mut("providers").and_then(|v| v.as_array_mut()) {
            providers.retain(|p| {
                p.get("providerType")
                    .and_then(|v| v.as_str())
                    .map(|t| t != "media")
                    .unwrap_or(true)
            });
        }
        let mut config: ProviderConfig =
            serde_json::from_value(parsed).with_context(|| "Failed to parse providers.json")?;
        if config.providers.len() > MAX_PROVIDER_COUNT {
            // Older writers could exceed this limit. The file-size bound still
            // applies, but valid saved credentials must remain readable/recoverable.
            warn!(
                count = config.providers.len(),
                limit = MAX_PROVIDER_COUNT,
                "Provider configuration exceeds the creation limit; keeping existing entries"
            );
        }
        let mut ids = HashSet::with_capacity(config.providers.len());
        for provider in &mut config.providers {
            Self::normalize_provider_models(provider)?;
            Self::normalize_accounts(provider, None, true)?;
            Self::validate_provider(provider)?;
            if !ids.insert(provider.id.clone()) {
                anyhow::bail!("Duplicate Provider id '{}'", provider.id);
            }
        }
        config.default_provider_ids.retain(|cli_tool, provider_id| {
            PROVIDER_CLI_TOOLS.contains(&cli_tool.as_str())
                && (provider_id == SYSTEM_PROVIDER_ID || ids.contains(provider_id))
        });
        Self::migrate_legacy_defaults(&mut config);
        Ok(LoadedConfig { config, raw })
    }

    /// 读文件；需要时把迁移结果落盘（仅拥有者）。落盘失败不影响本次读取结果。
    pub(super) fn load_and_migrate(&self) -> Result<ProviderConfig> {
        self.load_and_maybe_migrate().map(|(config, _)| config)
    }

    /// 启动时读文件。读到的文件本来就是新格式、不用再迁移，并且每个密钥都能定位时，
    /// 说明之前那次迁移已经被一次正常加载验证过：删掉迁移留下的 `providers.json.bak-*`
    /// （里面是迁移前的原样内容，带明文密钥）。只有拥有者做；删除失败只记日志。
    pub(super) fn load_at_startup(&self) -> Result<ProviderConfig> {
        let (config, already_current) = self.load_and_maybe_migrate()?;
        if self.owns_storage && already_current {
            let backups = self.migration_backups();
            if !backups.is_empty() && self.all_secrets_locatable(&config) {
                Self::remove_migration_backups(&backups);
            }
        }
        Ok(config)
    }

    /// 返回 `(配置, 文件读进来时就已是新格式且无需迁移)`。
    fn load_and_maybe_migrate(&self) -> Result<(ProviderConfig, bool)> {
        let LoadedConfig { config, raw } = Self::load_from_file(&self.config_path)?;
        let needs_migration = self.needs_migration(&config);
        if !self.owns_storage || self.migration_failed.load(Ordering::Relaxed) || !needs_migration {
            return Ok((config, !needs_migration));
        }
        match self.persist_migration(&config, &raw) {
            Ok(migrated) => {
                info!(
                    path = %self.config_path.display(),
                    schema_version = PROVIDER_SCHEMA_VERSION,
                    "[ProviderService] Migrated providers config"
                );
                Ok((migrated, false))
            }
            Err(error) => {
                // 原文件没动。本进程不再反复重试（每次读都会走到这里），下次启动再试。
                self.migration_failed.store(true, Ordering::Relaxed);
                warn!(
                    path = %self.config_path.display(),
                    error = %error,
                    "[ProviderService] Providers config migration failed; original file kept, will retry on next start"
                );
                Ok((config, false))
            }
        }
    }

    /// 同目录下迁移留下的备份文件。
    fn migration_backups(&self) -> Vec<PathBuf> {
        let (dir, prefix) = self.backup_location();
        let Ok(entries) = std::fs::read_dir(&dir) else {
            return Vec::new();
        };
        entries
            .flatten()
            .filter(|entry| {
                entry
                    .file_name()
                    .to_str()
                    .is_some_and(|name| name.starts_with(&prefix))
            })
            .map(|entry| entry.path())
            .collect()
    }

    /// 配置里引用的每个密钥 / 敏感值都找得到：`keychain` 的在钥匙串里读得到，
    /// `file` 的明文还在文件里。有一个找不到就保留备份（那可能是唯一的副本）。
    fn all_secrets_locatable(&self, config: &ProviderConfig) -> bool {
        let located = |inline: bool, storage: SecretStorage, key: String| match storage {
            SecretStorage::None => true,
            SecretStorage::File => inline,
            SecretStorage::Keychain => matches!(self.secrets.load(&key), Ok(Some(_))),
        };
        let env_located = |entries: &[ProviderEnvVar], key: &dyn Fn(&str) -> String| {
            entries
                .iter()
                .filter(|entry| entry.sensitive)
                .all(|entry| located(entry.value.is_some(), entry.storage, key(&entry.name)))
        };
        config.providers.iter().all(|provider| {
            env_located(&provider.env, &|name| {
                provider_env_secret_key(&provider.id, name)
            }) && provider.accounts.iter().all(|account| {
                (account.kind != AccountKind::ApiKey
                    || located(
                        account.secret.is_some(),
                        account.secret_storage,
                        account_secret_key(&provider.id, &account.id),
                    ))
                    && env_located(&account.env, &|name| {
                        account_env_secret_key(&provider.id, &account.id, name)
                    })
            })
        })
    }

    /// 删除备份。失败只记路径和错误（备份内容、密钥都不进日志）。
    fn remove_migration_backups(backups: &[PathBuf]) {
        let mut removed = 0usize;
        for path in backups {
            match std::fs::remove_file(path) {
                Ok(()) => removed += 1,
                Err(error) => warn!(
                    path = %path.display(),
                    error = %error,
                    "[ProviderService] Failed to delete a providers migration backup"
                ),
            }
        }
        if removed > 0 {
            info!(
                removed,
                "[ProviderService] Deleted providers migration backups after a verified load"
            );
        }
    }

    fn backup_location(&self) -> (PathBuf, String) {
        let file_name = self
            .config_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("providers.json");
        let dir = self
            .config_path
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_default();
        (dir, format!("{file_name}.bak-"))
    }

    /// 旧格式，或还有明文等着进钥匙串（含「上次没有钥匙串、现在有了」）。
    fn needs_migration(&self, config: &ProviderConfig) -> bool {
        if config.schema_version < PROVIDER_SCHEMA_VERSION {
            return true;
        }
        let keychain = self.secrets.is_available();
        let pending = |inline: bool, storage: SecretStorage| {
            inline && (storage != SecretStorage::File || keychain)
        };
        let env_pending = |entries: &[ProviderEnvVar]| {
            entries
                .iter()
                .any(|entry| entry.sensitive && pending(entry.value.is_some(), entry.storage))
        };
        config.providers.iter().any(|provider| {
            env_pending(&provider.env)
                || provider.accounts.iter().any(|account| {
                    pending(account.secret.is_some(), account.secret_storage)
                        || env_pending(&account.env)
                })
        })
    }

    fn persist_migration(&self, config: &ProviderConfig, raw: &str) -> Result<ProviderConfig> {
        self.backup_original(raw)?;
        let mut next = config.clone();
        let mut written = Vec::new();
        let result = next
            .providers
            .iter_mut()
            .try_for_each(|provider| self.externalize_secrets(provider, &mut written))
            .and_then(|()| {
                next.schema_version = PROVIDER_SCHEMA_VERSION;
                self.save_to_file(&next)
            });
        if let Err(error) = result {
            self.rollback_secrets(&written);
            return Err(error);
        }
        Ok(next)
    }

    /// 迁移前把原文件备份到同目录（带时间戳）。已有内容完全相同的备份时不再重复写。
    fn backup_original(&self, raw: &str) -> Result<PathBuf> {
        let (dir, prefix) = self.backup_location();
        for path in self.migration_backups() {
            if std::fs::read_to_string(&path).is_ok_and(|content| content == raw) {
                return Ok(path);
            }
        }
        let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S%3f");
        let backup_path = dir.join(format!("{prefix}{stamp}"));
        crate::utils::atomic_file::write_atomic(&backup_path, raw)
            .with_context(|| "Failed to back up providers config before migration")?;
        // 备份里是迁移前的原样内容（可能含明文密钥），收紧到仅本人可读。
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&backup_path, std::fs::Permissions::from_mode(0o600));
        }
        Ok(backup_path)
    }

    /// 把一条供应商上还以明文挂着的密钥 / 敏感值移进钥匙串。
    ///
    /// 有钥匙串：写入成功后清掉明文、标 `keychain`；写入失败返回错误（**不**退回明文）。
    /// 没有钥匙串：明文留在原处、标 `file`（「未进钥匙串」）。
    /// `written` 记录本次写过的条目和它原来的值，供失败时撤回（见 [`SecretWrite`]）。
    pub(super) fn externalize_secrets(
        &self,
        provider: &mut Provider,
        written: &mut Vec<SecretWrite>,
    ) -> Result<()> {
        let keychain = self.secrets.is_available();
        let provider_id = provider.id.clone();
        let mut move_out =
            |value: &mut Option<String>, storage: &mut SecretStorage, key: String| -> Result<()> {
                let Some(plain) = value.as_deref() else {
                    return Ok(());
                };
                if !keychain {
                    *storage = SecretStorage::File;
                    return Ok(());
                }
                // 记下原值：这可能是一次换密钥，后面落盘失败时要能还原，而不是直接删掉。
                let previous = self.secrets.load(&key).ok().flatten();
                self.secrets.store(&key, plain)?;
                written.push(SecretWrite { key, previous });
                *value = None;
                *storage = SecretStorage::Keychain;
                Ok(())
            };

        for entry in provider.env.iter_mut().filter(|entry| entry.sensitive) {
            let key = provider_env_secret_key(&provider_id, &entry.name);
            move_out(&mut entry.value, &mut entry.storage, key)?;
        }
        for account in &mut provider.accounts {
            if account.kind == AccountKind::ApiKey {
                let key = account_secret_key(&provider_id, &account.id);
                move_out(&mut account.secret, &mut account.secret_storage, key)?;
            }
            for entry in account.env.iter_mut().filter(|entry| entry.sensitive) {
                let key = account_env_secret_key(&provider_id, &account.id, &entry.name);
                move_out(&mut entry.value, &mut entry.storage, key)?;
            }
        }
        Ok(())
    }

    /// 撤回本次对钥匙串的写入：原来有值的还原，原来没有的删除。
    pub(super) fn rollback_secrets(&self, writes: &[SecretWrite]) {
        for write in writes.iter().rev() {
            let result = match write.previous.as_deref() {
                Some(previous) => self.secrets.store(&write.key, previous),
                None => self.secrets.delete(&write.key),
            };
            if let Err(error) = result {
                warn!(error = %error, "[ProviderService] Failed to roll back a stored provider secret");
            }
        }
    }

    /// 一份配置引用了哪些钥匙串条目。
    pub(super) fn keychain_keys(config: &ProviderConfig) -> HashSet<String> {
        let mut keys = HashSet::new();
        for provider in &config.providers {
            for entry in &provider.env {
                if entry.sensitive && entry.storage == SecretStorage::Keychain {
                    keys.insert(provider_env_secret_key(&provider.id, &entry.name));
                }
            }
            for account in &provider.accounts {
                if account.secret_storage == SecretStorage::Keychain {
                    keys.insert(account_secret_key(&provider.id, &account.id));
                }
                for entry in &account.env {
                    if entry.sensitive && entry.storage == SecretStorage::Keychain {
                        keys.insert(account_env_secret_key(
                            &provider.id,
                            &account.id,
                            &entry.name,
                        ));
                    }
                }
            }
        }
        keys
    }

    pub(super) fn save_to_file(&self, config: &ProviderConfig) -> Result<()> {
        let mut value =
            serde_json::to_value(config).with_context(|| "Failed to serialize providers config")?;
        if let Some(providers) = value.get_mut("providers").and_then(|v| v.as_array_mut()) {
            for provider in providers.iter_mut().filter_map(|p| p.as_object_mut()) {
                for field in LEGACY_PROVIDER_FIELDS {
                    provider.remove(field);
                }
            }
        }
        let content = serde_json::to_string_pretty(&value)
            .with_context(|| "Failed to serialize providers config")?;
        if content.len() as u64 > MAX_PROVIDER_CONFIG_BYTES {
            anyhow::bail!(
                "providers config exceeds {} bytes",
                MAX_PROVIDER_CONFIG_BYTES
            );
        }
        // 原子写（temp+fsync+rename，内部会建父目录）杜绝崩溃/断电写到一半导致截断丢失。
        // 文件里没有密钥明文（没有钥匙串的环境除外，见 `SecretStorage::File`）。
        crate::utils::atomic_file::write_atomic(&self.config_path, content)
            .with_context(|| "Failed to write providers config")?;
        Ok(())
    }
}
