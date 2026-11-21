//! 账号 / 接口 / 自定义环境变量的归一化与校验，以及旧字段（`apiKey` / `baseUrl` /
//! `configDir`）到新结构的承接。读旧文件和接收旧界面的写入走的是同一段逻辑。

use super::{
    ProviderService, MAX_CONFIG_ENV_ITEMS, MAX_PROVIDER_FIELD_CHARS, MAX_PROVIDER_ID_CHARS,
    MAX_PROVIDER_NAME_CHARS, MAX_PROVIDER_SECRET_CHARS, MAX_PROVIDER_URL_CHARS,
};
use crate::models::provider::{
    login_dir_env_var, AccountKind, EndpointKind, Provider, ProviderAccount, ProviderEnvVar,
    ProviderType, SecretStorage,
};
use anyhow::{Context, Result};
use std::collections::HashSet;

pub(super) const MAX_PROVIDER_ACCOUNTS: usize = 32;

fn nonblank(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

impl ProviderService {
    /// 把一个只带旧字段（`api_key` / `base_url` / `config_dir`）的 Provider 归一成新结构：
    /// 建出默认账号、把地址放进类型对应的接口。不落盘、不碰钥匙串（密钥留在
    /// `accounts[..].secret` 里）。给不经过 `add_provider` 就要拿去解析的调用方（如测试）用。
    pub fn normalize_legacy_provider(mut provider: Provider) -> Result<Provider> {
        Self::normalize_accounts(&mut provider, None, false)?;
        Ok(provider)
    }

    /// 把一个 Provider 归一成落盘前的内部形态。
    ///
    /// - `existing`：更新时传被替换的那条，用来承接界面拿不到的东西
    ///   （已存的密钥标记、`File` 回退时的明文、旧界面不认识的新字段）。
    /// - `from_disk`：读文件时为 true，此时信任文件里的存储标记。
    ///
    /// 归一后：至少一个账号、默认账号有效、`api_key` 为空，
    /// `base_url` / `config_dir` 是主接口与默认登录账号目录的镜像。
    /// 新输入的密钥仍以明文留在 `secret` / `value`，等提交时再移进钥匙串。
    pub(super) fn normalize_accounts(
        provider: &mut Provider,
        existing: Option<&Provider>,
        from_disk: bool,
    ) -> Result<()> {
        // 旧界面 / 旧客户端不认识账号，也就不会带回接口、环境变量、来源——没带的那一组沿用已存的。
        let legacy_client = provider.accounts.is_empty();
        // 连接口也没带：`base_url` 才是权威值（见 `absorb_legacy_fields`）。
        let legacy_endpoints = legacy_client && provider.endpoints.is_empty();
        if let Some(existing) = existing {
            if legacy_client {
                provider.accounts = existing.accounts.clone();
                provider.default_account_id = existing.default_account_id.clone();
                if provider.env.is_empty() {
                    provider.env = existing.env.clone();
                }
            }
            if legacy_endpoints {
                provider.endpoints = existing.endpoints.clone();
            }
            if provider.source.is_none() {
                provider.source = existing.source.clone();
            }
        }
        if provider.accounts.is_empty() {
            provider
                .accounts
                .push(ProviderAccount::default_for(provider.provider_type));
        }

        for account in &mut provider.accounts {
            let previous = existing
                .and_then(|existing| existing.accounts.iter().find(|item| item.id == account.id));
            Self::normalize_account(account, previous, from_disk)?;
        }
        Self::normalize_env_entries(
            &mut provider.env,
            existing.map(|existing| existing.env.as_slice()),
            from_disk,
        )?;

        let default_valid = provider
            .default_account_id
            .as_deref()
            .is_some_and(|id| provider.accounts.iter().any(|account| account.id == id));
        if !default_valid {
            provider.default_account_id =
                provider.accounts.first().map(|account| account.id.clone());
        }

        Self::absorb_legacy_fields(provider, existing, legacy_client, legacy_endpoints);
        Self::refresh_legacy_mirrors(provider);
        Self::validate_accounts(provider)
    }

    fn normalize_account(
        account: &mut ProviderAccount,
        previous: Option<&ProviderAccount>,
        from_disk: bool,
    ) -> Result<()> {
        account.id = account.id.trim().to_string();
        account.name = account.name.trim().to_string();
        account.color = nonblank(account.color.as_deref()).map(str::to_string);
        account.cli_tool = nonblank(account.cli_tool.as_deref()).map(str::to_string);
        account.config_dir = nonblank(account.config_dir.as_deref()).map(str::to_string);
        account.secret = account
            .secret
            .take()
            .filter(|value| !value.trim().is_empty());

        match account.kind {
            AccountKind::Login => {
                // 登录账号不带密钥；CC-Panes 不读、不存登录凭据本身。
                account.secret = None;
                account.secret_storage = SecretStorage::None;
            }
            AccountKind::ApiKey => {
                account.cli_tool = None;
                account.config_dir = None;
                if !from_disk && account.secret.is_none() {
                    // 界面拿到的是清掉明文的副本：标记还在 = 沿用已存的；标记为 none = 清除。
                    let kept = previous
                        .filter(|previous| previous.kind == AccountKind::ApiKey)
                        .filter(|_| !account.secret_storage.is_none());
                    account.secret = kept.and_then(|previous| previous.secret.clone());
                    account.secret_storage = kept
                        .map(|previous| previous.secret_storage)
                        .unwrap_or(SecretStorage::None);
                }
                if account.secret.is_some() && account.secret_storage != SecretStorage::File {
                    // 明文在手且不是文件回退：视为「待存入钥匙串」。
                    account.secret_storage = SecretStorage::None;
                }
            }
        }
        Self::normalize_env_entries(
            &mut account.env,
            previous.map(|previous| previous.env.as_slice()),
            from_disk,
        )
    }

    fn normalize_env_entries(
        entries: &mut [ProviderEnvVar],
        previous: Option<&[ProviderEnvVar]>,
        from_disk: bool,
    ) -> Result<()> {
        for entry in entries.iter_mut() {
            entry.name = entry.name.trim().to_string();
            if !entry.sensitive {
                entry.storage = SecretStorage::None;
                entry.value = Some(entry.value.take().unwrap_or_default());
                continue;
            }
            entry.value = entry.value.take().filter(|value| !value.is_empty());
            if !from_disk && entry.value.is_none() {
                let kept = previous
                    .and_then(|previous| {
                        previous
                            .iter()
                            .find(|item| item.name == entry.name && item.sensitive)
                    })
                    .filter(|_| !entry.storage.is_none());
                entry.value = kept.and_then(|previous| previous.value.clone());
                entry.storage = kept
                    .map(|previous| previous.storage)
                    .unwrap_or(SecretStorage::None);
            }
            if entry.value.is_some() && entry.storage != SecretStorage::File {
                entry.storage = SecretStorage::None;
            }
        }
        Ok(())
    }

    /// 承接旧字段。只对**旧客户端**（没带 `accounts` 的写入、以及旧格式文件）生效；
    /// 带了 `accounts` 的新客户端以 `accounts` / `endpoints` 为准，这三个字段直接忽略——
    /// 否则它原样带回来的旧镜像会把刚改的新值盖掉。
    ///
    /// - `api_key`：旧界面读不到已存的密钥，所以是补丁语义——缺省不动、空串清除、非空替换。
    /// - `base_url`：旧界面读得到镜像，所以是权威值——有值写入主接口，缺省 / 空串清除主接口。
    ///   仅当这次写入连 `endpoints` 也没带时生效（`legacy_endpoints`）。
    /// - `config_dir`：只在「配置目录」类型下是权威值（旧界面只在这个类型下显示它）。
    fn absorb_legacy_fields(
        provider: &mut Provider,
        existing: Option<&Provider>,
        legacy_client: bool,
        legacy_endpoints: bool,
    ) {
        let api_key = provider.api_key.take();
        let config_dir = provider.config_dir.take();
        let base_url = provider.base_url.take();
        if !legacy_client {
            return;
        }
        let default_id = provider.default_account_id.clone();
        let provider_type = provider.provider_type;
        let is_config_profile = provider_type == ProviderType::ConfigProfile;

        if let Some(account) = provider
            .accounts
            .iter_mut()
            .find(|account| Some(&account.id) == default_id.as_ref())
        {
            // 旧界面把类型从「配置目录」换成了别的：原来的目录账号不再适用，变回密钥账号。
            let left_config_profile = !is_config_profile
                && existing
                    .is_some_and(|existing| existing.provider_type == ProviderType::ConfigProfile);
            if left_config_profile && account.kind == AccountKind::Login {
                account.kind = AccountKind::ApiKey;
                account.cli_tool = None;
                account.config_dir = None;
            }
            if let Some(key) = api_key {
                if key.trim().is_empty() {
                    if account.kind == AccountKind::ApiKey {
                        account.secret = None;
                        account.secret_storage = SecretStorage::None;
                    }
                } else if !is_config_profile {
                    account.kind = AccountKind::ApiKey;
                    account.cli_tool = None;
                    account.config_dir = None;
                    account.secret = Some(key);
                    account.secret_storage = SecretStorage::None;
                }
            }
            if is_config_profile {
                // 「配置目录」类型：默认账号就是一个 Claude 登录账号，目录以旧字段为准。
                account.kind = AccountKind::Login;
                account.cli_tool = Some("claude".to_string());
                account.config_dir = nonblank(config_dir.as_deref()).map(str::to_string);
                account.secret = None;
                account.secret_storage = SecretStorage::None;
            }
        }

        if legacy_endpoints {
            let kind = provider.mirrored_endpoint_kind();
            provider.endpoints.set(kind, base_url);
        }
    }

    /// 重算兼容视图：`base_url` 镜像主接口，`config_dir` 镜像默认登录账号的目录。
    pub(super) fn refresh_legacy_mirrors(provider: &mut Provider) {
        provider.api_key = None;
        provider.base_url = provider
            .endpoints
            .get(provider.mirrored_endpoint_kind())
            .map(str::to_string);
        provider.config_dir = provider
            .default_account()
            .and_then(ProviderAccount::login_dir)
            .map(str::to_string);
    }

    fn validate_accounts(provider: &Provider) -> Result<()> {
        if provider.accounts.len() > MAX_PROVIDER_ACCOUNTS {
            anyhow::bail!("Provider has more than {MAX_PROVIDER_ACCOUNTS} accounts");
        }
        let mut ids = HashSet::with_capacity(provider.accounts.len());
        for account in &provider.accounts {
            if !Self::valid_entity_id(&account.id) {
                anyhow::bail!("Provider account id is invalid");
            }
            if !ids.insert(account.id.as_str()) {
                anyhow::bail!("Duplicate Provider account id '{}'", account.id);
            }
            if account.name.is_empty() || account.name.chars().count() > MAX_PROVIDER_NAME_CHARS {
                anyhow::bail!("Provider account name is invalid");
            }
            Self::validate_optional_length(account.color.as_deref(), 64, "account color")?;
            Self::validate_optional_length(
                account.secret.as_deref(),
                MAX_PROVIDER_SECRET_CHARS,
                "apiKey",
            )?;
            Self::validate_optional_length(
                account.config_dir.as_deref(),
                MAX_PROVIDER_FIELD_CHARS,
                "account configDir",
            )?;
            if account.kind == AccountKind::Login {
                let cli_tool = account.cli_tool.as_deref().unwrap_or_default();
                if login_dir_env_var(cli_tool).is_none() {
                    anyhow::bail!("Provider login account targets an unsupported CLI '{cli_tool}'");
                }
            }
            Self::validate_env_entries(&account.env)?;
        }
        Self::validate_env_entries(&provider.env)?;
        for kind in EndpointKind::ALL {
            if let Some(url) = provider.endpoints.get(kind) {
                Self::validate_endpoint_url(url)?;
            }
        }
        Ok(())
    }

    fn validate_env_entries(entries: &[ProviderEnvVar]) -> Result<()> {
        if entries.len() > MAX_CONFIG_ENV_ITEMS {
            anyhow::bail!("Provider env exceeds {MAX_CONFIG_ENV_ITEMS} entries");
        }
        let mut names = HashSet::with_capacity(entries.len());
        for entry in entries {
            if !Self::valid_custom_env_name(&entry.name) {
                anyhow::bail!("Provider env name '{}' is invalid", entry.name);
            }
            if !names.insert(entry.name.as_str()) {
                anyhow::bail!("Duplicate Provider env name '{}'", entry.name);
            }
            Self::validate_optional_length(
                entry.value.as_deref(),
                MAX_PROVIDER_SECRET_CHARS,
                "env value",
            )?;
        }
        Ok(())
    }

    pub(super) fn validate_endpoint_url(url: &str) -> Result<()> {
        if url.chars().count() > MAX_PROVIDER_URL_CHARS {
            anyhow::bail!("Provider baseUrl is too long");
        }
        let parsed = url::Url::parse(url).context("Provider baseUrl is invalid")?;
        if !matches!(parsed.scheme(), "http" | "https") {
            anyhow::bail!("Provider baseUrl must use http or https");
        }
        Ok(())
    }

    /// 供应商 / 账号 id 的字符集。账号 id 会进钥匙串条目名，不能含分隔符 `/`。
    pub(super) fn valid_entity_id(id: &str) -> bool {
        !id.is_empty()
            && id.chars().count() <= MAX_PROVIDER_ID_CHARS
            && id.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':')
            })
    }

    /// 自定义环境变量名：POSIX 风格，允许小写（如 `http_proxy`）。
    pub(super) fn valid_custom_env_name(name: &str) -> bool {
        let mut chars = name.chars();
        name.len() <= 256
            && matches!(chars.next(), Some(first) if first.is_ascii_alphabetic() || first == '_')
            && chars.all(|character| character.is_ascii_alphanumeric() || character == '_')
    }
}
