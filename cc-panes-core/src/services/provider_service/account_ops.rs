//! 单个账号的增删（整条供应商的增改走 `add_provider` / `update_provider`）。
//!
//! 登录账号由 [`crate::services::LoginAccountService`] 建目录后调这里登记；
//! 这里只管 `providers.json` 和钥匙串里的条目，不碰任何目录。

use super::ProviderService;
use crate::models::provider::{Provider, ProviderAccount, DEFAULT_LOGIN_ACCOUNT_NAME};
use crate::utils::error::AppError;
use anyhow::Result;
use std::collections::HashMap;

fn account_error(code: &str, message: String, provider_id: &str, account: &str) -> anyhow::Error {
    anyhow::Error::new(AppError::coded_with_params(
        code,
        message,
        HashMap::from([
            ("providerId".to_string(), provider_id.to_string()),
            ("account".to_string(), account.to_string()),
        ]),
    ))
}

impl ProviderService {
    /// 这个名字在这条供应商下能不能用：不能为空、不能和已有账号重名（不分大小写）、
    /// 不能占用合成账号的名字「默认登录」。
    pub fn ensure_account_name_available(provider: &Provider, name: &str) -> Result<()> {
        let name = name.trim();
        if name.is_empty() {
            return Err(account_error(
                "PROVIDER_ACCOUNT_NAME_INVALID",
                "Account name is required".to_string(),
                &provider.id,
                name,
            ));
        }
        let taken = name == DEFAULT_LOGIN_ACCOUNT_NAME
            || provider
                .accounts
                .iter()
                .any(|account| account.name.trim().to_lowercase() == name.to_lowercase());
        if taken {
            return Err(account_error(
                "PROVIDER_ACCOUNT_NAME_EXISTS",
                format!(
                    "Provider '{}' already has an account named '{name}'",
                    provider.id
                ),
                &provider.id,
                name,
            ));
        }
        Ok(())
    }

    /// 在一条供应商下登记一个新账号，返回更新后的供应商。重名、重 id 会被拒绝。
    pub fn add_account(&self, provider_id: &str, account: ProviderAccount) -> Result<Provider> {
        let mut config = self.lock_latest_config();
        let pos = config
            .providers
            .iter()
            .position(|provider| provider.id == provider_id)
            .ok_or_else(|| anyhow::anyhow!("Provider '{provider_id}' not found"))?;
        let existing = config.providers[pos].clone();
        Self::ensure_account_name_available(&existing, &account.name)?;
        if existing.accounts.iter().any(|item| item.id == account.id) {
            return Err(account_error(
                "PROVIDER_ACCOUNT_ID_EXISTS",
                format!(
                    "Provider '{provider_id}' already has an account with id '{}'",
                    account.id
                ),
                provider_id,
                &account.id,
            ));
        }

        let mut provider = existing.clone();
        provider.accounts.push(account);
        Self::normalize_accounts(&mut provider, Some(&existing), false)?;
        Self::validate_provider(&provider)?;
        let mut next = config.clone();
        next.providers[pos] = provider.clone();
        self.commit_config(&mut config, next)?;
        Ok(provider)
    }

    /// 从一条供应商下删掉一个账号，返回被删的账号（含它的目录路径，调用方据此决定删不删目录）。
    ///
    /// 最后一个账号不能删（供应商落盘后至少要有一个账号）；删的是默认账号时，
    /// 默认账号改成剩下的第一个。运行配置 / 工作空间里若还指着被删的账号，
    /// 启动时会得到 `PROVIDER_ACCOUNT_NOT_FOUND`，不会悄悄换号。
    pub fn remove_account(&self, provider_id: &str, account_id: &str) -> Result<ProviderAccount> {
        let mut config = self.lock_latest_config();
        let pos = config
            .providers
            .iter()
            .position(|provider| provider.id == provider_id)
            .ok_or_else(|| anyhow::anyhow!("Provider '{provider_id}' not found"))?;
        let existing = config.providers[pos].clone();
        let account_pos = existing
            .accounts
            .iter()
            .position(|account| account.id == account_id)
            .ok_or_else(|| {
                account_error(
                    "PROVIDER_ACCOUNT_NOT_FOUND",
                    format!("Account '{account_id}' was not found on Provider '{provider_id}'"),
                    provider_id,
                    account_id,
                )
            })?;
        if existing.accounts.len() == 1 {
            return Err(account_error(
                "PROVIDER_ACCOUNT_LAST",
                format!(
                    "Account '{account_id}' is the only account of Provider '{provider_id}'; delete the Provider instead"
                ),
                provider_id,
                account_id,
            ));
        }

        let mut provider = existing.clone();
        let removed = provider.accounts.remove(account_pos);
        if provider.default_account_id.as_deref() == Some(account_id) {
            provider.default_account_id =
                provider.accounts.first().map(|account| account.id.clone());
        }
        Self::normalize_accounts(&mut provider, Some(&existing), false)?;
        Self::validate_provider(&provider)?;
        let mut next = config.clone();
        next.providers[pos] = provider;
        self.commit_config(&mut config, next)?;
        Ok(removed)
    }
}
