//! 「供应商 + 账号 + 目标 CLI → 这次启动要注入的环境变量」的统一入口。
//!
//! 合并顺序：按类型自动生成 → 供应商填的 → 账号填的，后者覆盖前者。
//! 读密钥只发生在这里（启动）和 [`ProviderService::resolve_api_credentials`]
//! （测试连接 / 拉模型列表）；预览不读钥匙串，敏感值一律打码。

use super::ProviderService;
use crate::models::provider::{
    AccountKind, Provider, ProviderAccount, ProviderEnvVar, SecretStorage, SYSTEM_PROVIDER_ID,
};
use crate::services::provider_secret_service::{
    account_env_secret_key, account_secret_key, provider_env_secret_key,
};
use crate::utils::error::AppError;
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use tracing::warn;

/// 预览里敏感值的打码占位。
pub const MASKED_SECRET: &str = "••••";

/// 一个变量来自哪一层。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProviderEnvLayer {
    /// 按供应商类型 / 目标 CLI 自动生成（密钥、地址、登录目录）。
    Generated,
    /// 供应商填的。
    Provider,
    /// 账号填的。
    Account,
}

/// 解析出的一个变量。值是明文；`Debug` 对敏感值打码。
#[derive(Clone, PartialEq, Eq)]
pub struct ResolvedEnvVar {
    pub name: String,
    pub value: String,
    pub sensitive: bool,
    pub layer: ProviderEnvLayer,
    /// 它盖掉了哪一层的同名变量（没有则为 `None`）。
    pub overrides: Option<ProviderEnvLayer>,
}

impl std::fmt::Debug for ResolvedEnvVar {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let value = if self.sensitive {
            MASKED_SECRET
        } else {
            self.value.as_str()
        };
        f.debug_struct("ResolvedEnvVar")
            .field("name", &self.name)
            .field("value", &value)
            .field("sensitive", &self.sensitive)
            .field("layer", &self.layer)
            .field("overrides", &self.overrides)
            .finish()
    }
}

/// 一次启动解析出的结果。值是明文，只活在内存里：不写回文件，不进日志
/// （`Debug` 输出会打码）。
#[derive(Clone, Default)]
pub struct ProviderLaunchEnv {
    /// 实际使用的账号 id。
    pub account_id: Option<String>,
    /// 最终注入的变量，按出现顺序。
    pub vars: Vec<ResolvedEnvVar>,
    /// 账号的密钥明文（登录账号为 `None`）。适配器不走环境变量、直接要密钥时用它。
    pub api_key: Option<String>,
    /// 目标 CLI 取到的接口地址。
    pub base_url: Option<String>,
    /// 登录账号的目录（仅当账号属于目标 CLI）。
    pub config_dir: Option<String>,
    /// Codex 实际使用的 wire API。
    pub codex_wire_api: Option<String>,
}

impl std::fmt::Debug for ProviderLaunchEnv {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProviderLaunchEnv")
            .field("account_id", &self.account_id)
            .field(
                "vars",
                &self
                    .vars
                    .iter()
                    .map(|var| var.name.as_str())
                    .collect::<Vec<_>>(),
            )
            .field("has_api_key", &self.api_key.is_some())
            .field("base_url", &self.base_url)
            .field("config_dir", &self.config_dir)
            .finish()
    }
}

impl ProviderLaunchEnv {
    /// 全部要注入的变量。
    pub fn env_map(&self) -> HashMap<String, String> {
        self.vars
            .iter()
            .map(|var| (var.name.clone(), var.value.clone()))
            .collect()
    }

    /// 只含用户填的（供应商 + 账号两层）。适配器自己注入环境变量之后要再盖一遍，
    /// 保证「用户填的优先」对每个 CLI 都成立。
    pub fn custom_env_map(&self) -> HashMap<String, String> {
        self.vars
            .iter()
            .filter(|var| var.layer != ProviderEnvLayer::Generated)
            .map(|var| (var.name.clone(), var.value.clone()))
            .collect()
    }
}

/// 注入预览的一行。敏感值已打码。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderEnvPreviewEntry {
    pub name: String,
    pub value: String,
    pub sensitive: bool,
    pub layer: ProviderEnvLayer,
    /// 用户填的值盖掉了自动生成的同名变量（界面据此提示）。
    pub overrides_generated: bool,
}

/// 测试连接 / 拉模型列表用的凭据。只在内存里传递。
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderApiCredentials {
    pub api_key: Option<String>,
    /// 供应商主接口的地址（旧 `baseUrl` 语义）。
    pub base_url: Option<String>,
    pub endpoints: crate::models::provider::ProviderEndpoints,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum SecretMode {
    /// 真的读钥匙串。
    Read,
    /// 不读，只给打码占位。
    Mask,
}

fn secret_error(code: &str, message: String, provider_id: &str) -> anyhow::Error {
    anyhow::Error::new(AppError::coded_with_params(
        code,
        message,
        HashMap::from([("providerId".to_string(), provider_id.to_string())]),
    ))
}

fn looks_sensitive(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    ["KEY", "TOKEN", "SECRET", "PASSWORD"]
        .iter()
        .any(|needle| upper.contains(needle))
}

impl ProviderService {
    /// 供应商类型的原生 CLI（不指定目标 CLI 时按它解析）。
    pub fn native_cli_for(provider: &Provider) -> &'static str {
        Self::native_cli_for_provider_type(provider.provider_type)
    }

    /// 统一入口：解析这次启动要注入的环境变量（会读钥匙串）。
    ///
    /// `account_id` 为 `None` 时用供应商的默认账号。密钥标记为「在钥匙串」却读不到时返回
    /// 错误（`PROVIDER_SECRET_UNAVAILABLE`），不会带着空密钥悄悄启动。
    pub fn resolve_launch_env(
        &self,
        provider: &Provider,
        account_id: Option<&str>,
        cli_tool: &str,
    ) -> Result<ProviderLaunchEnv> {
        self.build_launch_env(provider, account_id, cli_tool, SecretMode::Read)
    }

    /// 预览：将要注入的变量列表，敏感值打码。不读钥匙串。
    pub fn preview_env(
        &self,
        provider_id: &str,
        account_id: Option<&str>,
        cli_tool: Option<&str>,
    ) -> Result<Vec<ProviderEnvPreviewEntry>> {
        if provider_id == SYSTEM_PROVIDER_ID {
            return Ok(Vec::new());
        }
        let provider = self
            .get_provider(provider_id)
            .ok_or_else(|| anyhow::anyhow!("Provider '{provider_id}' not found"))?;
        let cli_tool = cli_tool
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| Self::native_cli_for(&provider));
        let resolved = self.build_launch_env(&provider, account_id, cli_tool, SecretMode::Mask)?;
        Ok(resolved
            .vars
            .into_iter()
            .map(|var| ProviderEnvPreviewEntry {
                overrides_generated: var.layer != ProviderEnvLayer::Generated
                    && var.overrides == Some(ProviderEnvLayer::Generated),
                value: if var.sensitive {
                    MASKED_SECRET.to_string()
                } else {
                    var.value
                },
                name: var.name,
                sensitive: var.sensitive,
                layer: var.layer,
            })
            .collect())
    }

    /// 测试连接 / 拉模型列表用：读出账号密钥和接口地址（会读钥匙串）。
    pub fn resolve_api_credentials(
        &self,
        provider_id: &str,
        account_id: Option<&str>,
    ) -> Result<ProviderApiCredentials> {
        let provider = self
            .get_provider(provider_id)
            .ok_or_else(|| anyhow::anyhow!("Provider '{provider_id}' not found"))?;
        let account = Self::account_or_error(&provider, account_id, None)?;
        Ok(ProviderApiCredentials {
            api_key: self.account_secret(&provider, &account, SecretMode::Read)?,
            base_url: provider.base_url.clone(),
            endpoints: provider.endpoints.clone(),
        })
    }

    /// 这次启动会用到的钥匙串条目（条目名 → 明文）。主程序读出来推给 daemon 用，
    /// 与 SSH 密码的同步方式一致。只含「在钥匙串」的条目。
    pub fn launch_secret_entries(
        &self,
        provider: &Provider,
        account_id: Option<&str>,
    ) -> Result<HashMap<String, String>> {
        let account = Self::account_or_error(provider, account_id, None)?;
        let mut keys = Vec::new();
        if account.kind == AccountKind::ApiKey && account.secret_storage == SecretStorage::Keychain
        {
            keys.push(account_secret_key(&provider.id, &account.id));
        }
        keys.extend(
            provider
                .env
                .iter()
                .filter(|entry| entry.sensitive && entry.storage == SecretStorage::Keychain)
                .map(|entry| provider_env_secret_key(&provider.id, &entry.name)),
        );
        keys.extend(
            account
                .env
                .iter()
                .filter(|entry| entry.sensitive && entry.storage == SecretStorage::Keychain)
                .map(|entry| account_env_secret_key(&provider.id, &account.id, &entry.name)),
        );
        let mut entries = HashMap::with_capacity(keys.len());
        for key in keys {
            let value = self.secrets.load(&key)?.ok_or_else(|| {
                secret_error(
                    "PROVIDER_SECRET_UNAVAILABLE",
                    format!("Stored secret '{key}' is missing from the credential store"),
                    &provider.id,
                )
            })?;
            entries.insert(key, value);
        }
        Ok(entries)
    }

    /// 兼容视图：把默认账号的密钥读出来填进 `api_key`。仅供需要整条凭据的后端调用方
    /// （DSH 路由映射）使用，不要把结果交给界面。读不到密钥的供应商保持 `api_key = None`。
    pub fn list_providers_with_default_secret(&self) -> Vec<Provider> {
        self.list_providers()
            .into_iter()
            .map(|mut provider| {
                let key = provider.default_account().and_then(|account| {
                    self.account_secret(&provider, account, SecretMode::Read)
                        .unwrap_or_else(|error| {
                            warn!(
                                provider_id = %provider.id,
                                error = %error,
                                "[ProviderService] Failed to read provider secret"
                            );
                            None
                        })
                });
                provider.api_key = key;
                provider
            })
            .collect()
    }

    /// 取账号；认得合成的「默认登录」（见 [`Provider::resolve_account`]）。`cli_tool` 为
    /// `None`（不针对某个 CLI：测试连接、推密钥给 daemon）时，默认登录按「没有密钥、没有
    /// 目录」的登录账号处理。
    pub(super) fn account_or_error<'a>(
        provider: &'a Provider,
        account_id: Option<&str>,
        cli_tool: Option<&str>,
    ) -> Result<std::borrow::Cow<'a, ProviderAccount>> {
        let cli_tool = cli_tool.unwrap_or_else(|| {
            provider
                .login_cli_tools()
                .first()
                .copied()
                .unwrap_or_default()
        });
        provider
            .resolve_account(account_id, cli_tool)
            .ok_or_else(|| {
                anyhow::Error::new(AppError::coded_with_params(
                    "PROVIDER_ACCOUNT_NOT_FOUND",
                    format!(
                        "Account '{}' was not found on Provider '{}'",
                        account_id.unwrap_or("<default>"),
                        provider.id
                    ),
                    HashMap::from([
                        ("providerId".to_string(), provider.id.clone()),
                        (
                            "accountId".to_string(),
                            account_id.unwrap_or_default().to_string(),
                        ),
                    ]),
                ))
            })
    }

    fn account_secret(
        &self,
        provider: &Provider,
        account: &ProviderAccount,
        mode: SecretMode,
    ) -> Result<Option<String>> {
        if account.kind != AccountKind::ApiKey {
            return Ok(None);
        }
        self.secret_value(
            provider,
            account.secret.as_deref(),
            account.secret_storage,
            &account_secret_key(&provider.id, &account.id),
            mode,
        )
    }

    /// 取一个密钥 / 敏感值：手上有明文（文件回退或尚未迁移）直接用；
    /// 标记为钥匙串则去读，读不到就报错。
    fn secret_value(
        &self,
        provider: &Provider,
        inline: Option<&str>,
        storage: SecretStorage,
        key: &str,
        mode: SecretMode,
    ) -> Result<Option<String>> {
        if let Some(value) = inline.filter(|value| !value.is_empty()) {
            return Ok(Some(match mode {
                SecretMode::Read => value.to_string(),
                SecretMode::Mask => MASKED_SECRET.to_string(),
            }));
        }
        if storage != SecretStorage::Keychain {
            return Ok(None);
        }
        if mode == SecretMode::Mask {
            return Ok(Some(MASKED_SECRET.to_string()));
        }
        match self.secrets.load(key) {
            Ok(Some(value)) => Ok(Some(value)),
            Ok(None) => Err(secret_error(
                "PROVIDER_SECRET_UNAVAILABLE",
                format!("Stored secret '{key}' is missing from the credential store"),
                &provider.id,
            )),
            Err(error) => Err(secret_error(
                "PROVIDER_SECRET_UNAVAILABLE",
                format!("Stored secret '{key}' could not be read: {error}"),
                &provider.id,
            )),
        }
    }

    fn build_launch_env(
        &self,
        provider: &Provider,
        account_id: Option<&str>,
        cli_tool: &str,
        mode: SecretMode,
    ) -> Result<ProviderLaunchEnv> {
        let account = Self::account_or_error(provider, account_id, Some(cli_tool))?;
        let account = account.as_ref();
        let api_key = self.account_secret(provider, account, mode)?;

        let mut vars: Vec<ResolvedEnvVar> = self
            .generated_vars(provider, account, cli_tool, api_key.as_deref())
            .into_iter()
            .map(|(name, value, sensitive)| ResolvedEnvVar {
                name,
                value,
                sensitive,
                layer: ProviderEnvLayer::Generated,
                overrides: None,
            })
            .collect();

        let layers: [(&[ProviderEnvVar], ProviderEnvLayer); 2] = [
            (&provider.env, ProviderEnvLayer::Provider),
            (&account.env, ProviderEnvLayer::Account),
        ];
        for (entries, layer) in layers {
            for entry in entries {
                let value = if entry.sensitive {
                    let key = match layer {
                        ProviderEnvLayer::Account => {
                            account_env_secret_key(&provider.id, &account.id, &entry.name)
                        }
                        _ => provider_env_secret_key(&provider.id, &entry.name),
                    };
                    self.secret_value(provider, entry.value.as_deref(), entry.storage, &key, mode)?
                        .unwrap_or_default()
                } else {
                    entry.value.clone().unwrap_or_default()
                };
                let resolved = ResolvedEnvVar {
                    name: entry.name.clone(),
                    value,
                    sensitive: entry.sensitive,
                    layer,
                    overrides: None,
                };
                match vars.iter_mut().find(|var| var.name == entry.name) {
                    Some(existing) => {
                        let overrides = Some(existing.overrides.unwrap_or(existing.layer));
                        *existing = ResolvedEnvVar {
                            overrides,
                            ..resolved
                        };
                    }
                    None => vars.push(resolved),
                }
            }
        }

        let login_dir = account
            .login_dir()
            .filter(|_| account.cli_tool.as_deref() == Some(cli_tool));
        Ok(ProviderLaunchEnv {
            account_id: Some(account.id.clone()),
            vars,
            api_key: api_key.filter(|_| mode == SecretMode::Read),
            base_url: provider
                .endpoint_for_cli(cli_tool)
                .map(|(_, url)| url.to_string()),
            config_dir: login_dir.map(str::to_string),
            codex_wire_api: provider.effective_codex_wire_api(),
        })
    }

    /// 自动生成层。「配置目录」类型的登录账号若指向的是一个 JSON 文件（ccswitch 格式
    /// `{"env": {...}}`），沿用现状：读文件里的 env，而不是设 `CLAUDE_CONFIG_DIR`。
    fn generated_vars(
        &self,
        provider: &Provider,
        account: &ProviderAccount,
        cli_tool: &str,
        api_key: Option<&str>,
    ) -> Vec<(String, String, bool)> {
        use crate::models::provider::ProviderType;
        if provider.provider_type == ProviderType::ConfigProfile {
            let Some(config_path) = account.login_dir() else {
                return Vec::new();
            };
            let path = Path::new(config_path);
            if path.is_file() {
                return match Self::parse_env_config_file(path) {
                    Ok(vars) => {
                        let mut vars: Vec<_> = vars
                            .into_iter()
                            .map(|(name, value)| {
                                let sensitive = looks_sensitive(&name);
                                (name, value, sensitive)
                            })
                            .collect();
                        vars.sort_by(|left, right| left.0.cmp(&right.0));
                        vars
                    }
                    Err(error) => {
                        warn!(
                            "[ProviderService] Failed to parse config file {}: {}",
                            config_path, error
                        );
                        Vec::new()
                    }
                };
            }
            if !path.is_dir() {
                warn!(
                    "[ProviderService] Config path does not exist: {}",
                    config_path
                );
                return Vec::new();
            }
        }
        provider.generated_env(cli_tool, account, api_key)
    }
}
