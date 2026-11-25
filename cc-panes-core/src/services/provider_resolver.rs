use crate::models::provider::{AccountKind, Provider, ProviderAccount};
use crate::models::{CliTool, LaunchProviderSelection};
use crate::utils::error::{AppError, AppResult};
use crate::utils::LaunchRuntime;
use cc_cli_adapters::CliToolRegistry;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProviderMode {
    Native,
    Managed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProviderSource {
    Request,
    LaunchProfile,
    LegacyWorkspace,
    DefaultProvider,
    Native,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ModelSource {
    Request,
    LaunchProfile,
    ProviderDefault,
    NativeDefault,
}

impl ModelSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Request => "request",
            Self::LaunchProfile => "launchProfile",
            Self::ProviderDefault => "providerDefault",
            Self::NativeDefault => "nativeDefault",
        }
    }
}

#[derive(Debug, Clone)]
pub struct ProviderResolutionInput<'a> {
    pub cli_tool: CliTool,
    pub selection: LaunchProviderSelection,
    pub requested_provider_id: Option<&'a str>,
    pub requested_model_id: Option<&'a str>,
    pub profile_provider_id: Option<&'a str>,
    pub profile_model_id: Option<&'a str>,
    pub workspace_provider_id: Option<&'a str>,
    /// 账号跟着它所属的那一层供应商走：请求里的账号只对请求里的供应商生效，
    /// 运行配置 / 工作空间同理。都没指定时用供应商的默认账号。
    pub requested_account_id: Option<&'a str>,
    pub profile_account_id: Option<&'a str>,
    pub workspace_account_id: Option<&'a str>,
    /// 当前 CLI 工具自己的持久化默认 Provider id。
    pub default_provider_id: Option<&'a str>,
    pub adapter_options: Option<&'a HashMap<String, serde_json::Value>>,
}

#[derive(Debug, Clone)]
pub struct ResolvedProviderPlan {
    pub mode: ProviderMode,
    pub selection: LaunchProviderSelection,
    pub source: ProviderSource,
    pub provider: Option<Provider>,
    /// 实际使用的账号（托管模式下总是有值：指定的账号或供应商的默认账号）。
    pub account_id: Option<String>,
    pub model_id: Option<String>,
    pub model_label: Option<String>,
    pub model_default_effort: Option<String>,
    pub model_source: ModelSource,
}

impl ResolvedProviderPlan {
    pub fn apply_model_adapter_defaults(
        &self,
        adapter_options: &mut HashMap<String, serde_json::Value>,
    ) {
        if adapter_options.contains_key("effort") {
            return;
        }
        if let Some(effort) = self.model_default_effort.as_ref() {
            adapter_options.insert(
                "effort".to_string(),
                serde_json::Value::String(effort.clone()),
            );
        }
    }
}

pub fn managed_provider_conflict_env_keys(cli_tool: CliTool) -> &'static [&'static str] {
    match cli_tool {
        CliTool::Claude => &[
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_AUTH_TOKEN",
            "ANTHROPIC_BASE_URL",
            "ANTHROPIC_MODEL",
            "ANTHROPIC_DEFAULT_SONNET_MODEL",
            "ANTHROPIC_DEFAULT_HAIKU_MODEL",
            "ANTHROPIC_DEFAULT_OPUS_MODEL",
            "CLAUDE_CODE_SUBAGENT_MODEL",
            "CLAUDE_CODE_USE_BEDROCK",
            "CLAUDE_CODE_USE_VERTEX",
            "AWS_REGION",
            "AWS_PROFILE",
            "CLOUD_ML_REGION",
            "ANTHROPIC_VERTEX_PROJECT_ID",
            "CLAUDE_CONFIG_DIR",
        ],
        CliTool::Codex => &[
            "CODEX_API_KEY",
            "OPENAI_API_KEY",
            "OPENAI_BASE_URL",
            "CCPANES_CODEX_API_KEY",
        ],
        CliTool::Gemini => &["GEMINI_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_BASE"],
        CliTool::Kimi => &[
            "KIMI_API_KEY",
            "KIMI_BASE_URL",
            "KIMI_SHARE_DIR",
            "KIMI_MODEL_NAME",
            "KIMI_MODEL_API_KEY",
            "KIMI_MODEL_PROVIDER_TYPE",
            "KIMI_MODEL_BASE_URL",
        ],
        CliTool::Opencode => &[
            "OPENAI_API_KEY",
            "OPENAI_BASE_URL",
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_BASE_URL",
            "OPENCODE_CONFIG",
        ],
        CliTool::Cursor => &["CURSOR_API_KEY"],
        CliTool::Grok => &[
            "XAI_API_KEY",
            "XAI_BASE_URL",
            "GROK_MODELS_BASE_URL",
            "GROK_CLI_CHAT_PROXY_BASE_URL",
        ],
        // The Pi family (Pi and Oh My Pi) resolves credentials from documented
        // provider environment variables. Remove inherited values before
        // injecting the selected managed Provider (especially Anthropic
        // auth-token precedence). Also clear generic CC-Panes Provider
        // variables that the adapters do not support, so a managed custom
        // endpoint cannot bypass adapter validation.
        CliTool::Pi | CliTool::Omp => &[
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_AUTH_TOKEN",
            "ANTHROPIC_OAUTH_TOKEN",
            "ANTHROPIC_BASE_URL",
            "CODEX_API_KEY",
            "OPENAI_API_KEY",
            "OPENAI_BASE_URL",
            "GEMINI_API_KEY",
            "GEMINI_API_BASE",
            "XAI_API_KEY",
            "XAI_BASE_URL",
            "GROK_MODELS_BASE_URL",
            "GROK_CLI_CHAT_PROXY_BASE_URL",
            "CLAUDE_CODE_USE_BEDROCK",
            "CLAUDE_CODE_USE_VERTEX",
            "AWS_REGION",
            "AWS_PROFILE",
            "AWS_BEARER_TOKEN_BEDROCK",
            "CLOUD_ML_REGION",
            "ANTHROPIC_VERTEX_PROJECT_ID",
            "GOOGLE_CLOUD_API_KEY",
            "GOOGLE_CLOUD_PROJECT",
            "GCLOUD_PROJECT",
            "GOOGLE_CLOUD_LOCATION",
            "PI_CODING_AGENT_DIR",
            "PI_CODING_AGENT_SESSION_DIR",
        ],
        // jcode 原生读取 ANTHROPIC_*（anthropic-api 通道）与 OPENAI_API_KEY，
        // 且有自己的 JCODE_* 覆盖变量。managed 启动前清掉继承值，防止用户
        // shell 里的凭证/端点覆盖本次托管 Provider；`-p`/`--model` flag 虽然
        // 优先于 JCODE_PROVIDER/JCODE_MODEL，仍一并清除保持启动确定性。
        CliTool::Jcode => &[
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_AUTH_TOKEN",
            "ANTHROPIC_OAUTH_TOKEN",
            "ANTHROPIC_BASE_URL",
            "OPENAI_API_KEY",
            "JCODE_API_KEY",
            "JCODE_API_BASE",
            "JCODE_ANTHROPIC_API_BASE",
            "JCODE_ANTHROPIC_AUTH",
            "JCODE_PROVIDER",
            "JCODE_MODEL",
        ],
        // Antigravity（agy）只接 Gemini 类型：密钥账号用 `GEMINI_API_KEY`。两个都设时 agy 用
        // `GOOGLE_API_KEY`（1.5.14 二进制里的提示："Both GOOGLE_API_KEY and GEMINI_API_KEY are
        // set. Using GOOGLE_API_KEY."），继承下来会盖掉托管密钥，所以清掉。
        CliTool::Antigravity => &[
            "GEMINI_API_KEY",
            "GOOGLE_API_KEY",
            "GEMINI_API_BASE",
            "GOOGLE_GEMINI_BASE_URL",
        ],
        // 终端 CLI（Kiro / fx / Muse）不接托管 Provider（compatible_provider_types 为空），
        // 凭证完全由 CLI 自身登录态或用户环境变量（KIRO_API_KEY / META_API_KEY）提供，
        // 这里不清任何继承变量，避免误删用户的原生凭证。
        CliTool::Kiro | CliTool::Fx | CliTool::Muse => &[],
        CliTool::None => &[],
    }
}

pub fn resolve_provider_plan(
    input: ProviderResolutionInput<'_>,
    providers: &[Provider],
    registry: &CliToolRegistry,
) -> AppResult<ResolvedProviderPlan> {
    let selection = effective_selection(&input);
    let requested = normalize_id(input.requested_provider_id);
    let profile = normalize_id(input.profile_provider_id);
    let workspace = normalize_id(input.workspace_provider_id);

    if selection == LaunchProviderSelection::None {
        return Ok(native_plan());
    }
    if requested == Some(crate::models::provider::SYSTEM_PROVIDER_ID) {
        return Ok(native_plan());
    }

    if input.cli_tool == CliTool::None {
        if selection == LaunchProviderSelection::Explicit {
            return Err(provider_error(
                "PROVIDER_UNSUPPORTED",
                "Plain shell sessions do not support managed providers",
                input.cli_tool,
                requested,
            ));
        }
        return Ok(native_plan());
    }

    let selected = match selection {
        LaunchProviderSelection::None => unreachable!("handled above"),
        LaunchProviderSelection::Explicit => {
            let id = requested.ok_or_else(|| {
                provider_error(
                    "PROVIDER_REQUIRED",
                    "Managed provider mode requires a provider id",
                    input.cli_tool,
                    None,
                )
            })?;
            Some((id, ProviderSource::Request))
        }
        LaunchProviderSelection::Inherit => requested
            .map(|id| (id, ProviderSource::Request))
            .or_else(|| profile.map(|id| (id, ProviderSource::LaunchProfile)))
            .or_else(|| workspace.map(|id| (id, ProviderSource::LegacyWorkspace)))
            .or_else(|| {
                compatible_default_provider_id(
                    input.default_provider_id,
                    providers,
                    input.cli_tool,
                    registry,
                )
                .map(|id| (id, ProviderSource::DefaultProvider))
            }),
    };

    let Some((provider_id, source)) = selected else {
        return Ok(ResolvedProviderPlan {
            mode: ProviderMode::Native,
            selection,
            source: ProviderSource::Native,
            provider: None,
            account_id: None,
            model_id: None,
            model_label: None,
            model_default_effort: None,
            model_source: ModelSource::NativeDefault,
        });
    };
    if provider_id == crate::models::provider::SYSTEM_PROVIDER_ID {
        return Ok(native_plan());
    }

    let provider = providers
        .iter()
        .find(|provider| provider.id == provider_id)
        .cloned()
        .ok_or_else(|| {
            provider_error(
                "PROVIDER_NOT_FOUND",
                format!("Provider '{provider_id}' was not found"),
                input.cli_tool,
                Some(provider_id),
            )
        })?;

    // 请求里点名的账号对选中的供应商都生效，不管供应商本身来自请求、运行配置、工作空间
    // 还是默认值：会话恢复 / 历史重放带回来的就是「当时实际用的账号」，供应商那一半
    // 可能是继承来的。点了名却找不到就报错，不会悄悄换成默认账号。
    let selected_account_id = normalize_id(input.requested_account_id).or(match source {
        ProviderSource::LaunchProfile => normalize_id(input.profile_account_id),
        ProviderSource::LegacyWorkspace => normalize_id(input.workspace_account_id),
        ProviderSource::Request | ProviderSource::DefaultProvider | ProviderSource::Native => None,
    });
    let account = provider
        .resolve_account(selected_account_id, input.cli_tool.as_id())
        .ok_or_else(|| {
            let mut error_params = HashMap::from([
                ("cliTool".to_string(), input.cli_tool.as_id().to_string()),
                ("providerId".to_string(), provider_id.to_string()),
            ]);
            if let Some(account_id) = selected_account_id {
                error_params.insert("accountId".to_string(), account_id.to_string());
            }
            AppError::coded_with_params(
                "PROVIDER_ACCOUNT_NOT_FOUND",
                format!(
                    "Account '{}' was not found on Provider '{provider_id}'",
                    selected_account_id.unwrap_or("<default>")
                ),
                error_params,
            )
        })?;
    let account = account.as_ref();
    let account_id = account.id.clone();

    if !super::ProviderService::managed_configuration_is_usable(&provider, account) {
        return Err(provider_error(
            "PROVIDER_CONFIG_INVALID",
            format!("Provider '{provider_id}' has no usable managed configuration"),
            input.cli_tool,
            Some(provider_id),
        ));
    }

    let adapter = registry.get(input.cli_tool.as_id()).ok_or_else(|| {
        provider_error(
            "PROVIDER_UNSUPPORTED",
            format!(
                "CLI '{}' has no registered provider adapter",
                input.cli_tool.as_id()
            ),
            input.cli_tool,
            Some(provider_id),
        )
    })?;
    let provider_type = serde_json::to_value(provider.provider_type)
        .ok()
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_default();
    if account_login_mismatch(account, input.cli_tool) {
        let mut error_params = HashMap::from([
            ("cliTool".to_string(), input.cli_tool.as_id().to_string()),
            ("providerId".to_string(), provider_id.to_string()),
            ("accountId".to_string(), account_id.clone()),
        ]);
        if let Some(account_cli) = account.cli_tool.as_ref() {
            error_params.insert("accountCliTool".to_string(), account_cli.clone());
        }
        return Err(AppError::coded_with_params(
            "PROVIDER_ACCOUNT_INCOMPATIBLE",
            format!(
                "Account '{account_id}' is a login for CLI '{}' and cannot be used with CLI '{}'",
                account.cli_tool.as_deref().unwrap_or("<unknown>"),
                input.cli_tool.as_id()
            ),
            error_params,
        ));
    }
    let type_compatible = adapter.capabilities().supports_provider
        && adapter
            .capabilities()
            .compatible_provider_types
            .iter()
            .any(|compatible| compatible == &provider_type);
    if !type_compatible {
        return Err(provider_error(
            "PROVIDER_INCOMPATIBLE",
            format!(
                "Provider '{provider_id}' ({provider_type}) is not compatible with CLI '{}'",
                input.cli_tool.as_id()
            ),
            input.cli_tool,
            Some(provider_id),
        ));
    }

    let requested_model = normalize_id(input.requested_model_id);
    let profile_model = normalize_id(input.profile_model_id);
    let (selected_model_id, model_source) = if let Some(model_id) = requested_model {
        (Some(model_id), ModelSource::Request)
    } else if source == ProviderSource::LaunchProfile {
        profile_model
            .map(|model_id| (Some(model_id), ModelSource::LaunchProfile))
            .unwrap_or_else(|| {
                (
                    provider.default_model_id.as_deref(),
                    ModelSource::ProviderDefault,
                )
            })
    } else {
        (
            provider.default_model_id.as_deref(),
            ModelSource::ProviderDefault,
        )
    };
    let selected_model = selected_model_id
        .map(|model_id| {
            provider
                .models
                .iter()
                .find(|model| model.id == model_id)
                .ok_or_else(|| {
                    provider_model_error(
                        "PROVIDER_MODEL_NOT_FOUND",
                        format!(
                            "Model '{model_id}' is not configured for Provider '{provider_id}'"
                        ),
                        input.cli_tool,
                        provider_id,
                        model_id,
                    )
                })
        })
        .transpose()?;

    Ok(ResolvedProviderPlan {
        mode: ProviderMode::Managed,
        selection,
        source,
        model_id: selected_model.map(|model| model.id.clone()),
        model_label: selected_model.and_then(|model| model.label.clone()),
        model_default_effort: selected_model.and_then(|model| model.default_effort.clone()),
        model_source: if selected_model.is_some() {
            model_source
        } else {
            ModelSource::NativeDefault
        },
        provider: Some(provider),
        account_id: Some(account_id),
    })
}

fn effective_selection(input: &ProviderResolutionInput<'_>) -> LaunchProviderSelection {
    let legacy_native_kimi = input.cli_tool == CliTool::Kimi
        && input.selection == LaunchProviderSelection::Inherit
        && input
            .adapter_options
            .and_then(|options| options.get("kimiConfigMode"))
            .and_then(serde_json::Value::as_str)
            == Some("native");
    // Pi-native provider/model values mean the profile intentionally relies on
    // Pi's own auth/configuration. Honor that intent before inherited workspace
    // and default Provider fallback, while an explicit managed selection still
    // remains authoritative.
    let pi_native_configuration = input.cli_tool == CliTool::Pi
        && input.selection == LaunchProviderSelection::Inherit
        && input.adapter_options.is_some_and(|options| {
            ["piNativeProvider", "piNativeModel"].iter().any(|key| {
                options
                    .get(*key)
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|value| !value.trim().is_empty())
            })
        });
    if legacy_native_kimi || pi_native_configuration {
        LaunchProviderSelection::None
    } else {
        input.selection
    }
}

/// 登录账号的目录在本机（「配置目录」类型指向 ccswitch JSON 文件的旧用法除外）。
fn is_local_login_dir(account: &ProviderAccount) -> bool {
    account
        .login_dir()
        .is_some_and(|dir| !std::path::Path::new(dir).is_file())
}

/// 一份运行配置在本机 / WSL / SSH 通用：运行配置或工作空间带来的登录账号若是本机目录，
/// 在 WSL / SSH 会话里自动换成能带过去的账号（供应商默认账号，否则该 CLI 的「默认登录」，
/// 即用对端 CLI 自己的登录），而不是报 `PROVIDER_LOGIN_ACCOUNT_LOCAL_ONLY`。
///
/// 请求里**点名**的账号（启动器手选、会话恢复带回的）不换：那是这一次的明确意图，
/// 照旧交给 [`validate_provider_runtime`] 报错。返回给用户看的说明（发生替换时）。
pub fn adapt_plan_for_runtime(
    plan: &mut ResolvedProviderPlan,
    runtime: LaunchRuntime,
    cli_tool: CliTool,
    account_requested: bool,
) -> Option<String> {
    if runtime == LaunchRuntime::Local || account_requested {
        return None;
    }
    if !matches!(
        plan.source,
        ProviderSource::LaunchProfile | ProviderSource::LegacyWorkspace
    ) {
        return None;
    }
    let provider = plan.provider.as_ref()?;
    let current = provider.resolve_account(plan.account_id.as_deref(), cli_tool.as_id())?;
    if !is_local_login_dir(&current) {
        return None;
    }
    let portable = |account: &ProviderAccount| {
        !is_local_login_dir(account)
            && !account_login_mismatch(account, cli_tool)
            && super::ProviderService::managed_configuration_is_usable(provider, account)
    };
    let replacement = provider
        .default_account()
        .filter(|account| portable(account))
        .map(|account| account.id.clone())
        .or_else(|| {
            provider
                .resolve_account(
                    Some(crate::models::provider::DEFAULT_LOGIN_ACCOUNT_ID),
                    cli_tool.as_id(),
                )
                .map(|account| account.id.clone())
        })?;
    let runtime_label = match runtime {
        LaunchRuntime::Ssh => "SSH",
        _ => "WSL",
    };
    let note = format!(
        "Login account '{}' only exists on this machine; this {runtime_label} session uses account '{}' instead",
        current.id, replacement
    );
    plan.account_id = Some(replacement);
    Some(note)
}

pub fn validate_provider_runtime(
    plan: &ResolvedProviderPlan,
    runtime: LaunchRuntime,
    cli_tool: CliTool,
) -> AppResult<()> {
    if runtime == LaunchRuntime::Ssh && matches!(cli_tool, CliTool::Pi | CliTool::Omp) {
        let display = match cli_tool {
            CliTool::Omp => "Oh My Pi",
            _ => "Pi",
        };
        return Err(provider_error(
            "PI_SSH_UNSUPPORTED",
            format!(
                "{display} launch over SSH is disabled; use a local or WSL runtime so the native {display} installation and auth remain on the target host"
            ),
            cli_tool,
            plan.provider.as_ref().map(|provider| provider.id.as_str()),
        ));
    }
    // 登录账号的目录是本机路径：WSL / SSH 那一侧既看不到这个目录，也不该收到一个本机路径
    // 当 `CODEX_HOME` 之类的变量。明确拒绝，而不是把路径原样带过去。
    // （「配置目录」类型指向 ccswitch JSON 文件的旧用法不设目录变量，不受影响。）
    if runtime != LaunchRuntime::Local {
        if let Some(provider) = plan.provider.as_ref() {
            let account = provider.resolve_account(plan.account_id.as_deref(), cli_tool.as_id());
            let local_dir = account
                .as_ref()
                .and_then(|account| account.login_dir())
                .filter(|dir| !std::path::Path::new(dir).is_file());
            if local_dir.is_some() {
                let runtime_label = match runtime {
                    LaunchRuntime::Ssh => "SSH",
                    _ => "WSL",
                };
                let account_id = plan.account_id.clone().unwrap_or_default();
                return Err(AppError::coded_with_params(
                    "PROVIDER_LOGIN_ACCOUNT_LOCAL_ONLY",
                    format!(
                        "Login account '{account_id}' lives in a directory on this machine and cannot be used in a {runtime_label} session; choose the default login or a key account, or sign in on the {runtime_label} side"
                    ),
                    HashMap::from([
                        ("cliTool".to_string(), cli_tool.as_id().to_string()),
                        ("providerId".to_string(), provider.id.clone()),
                        ("accountId".to_string(), account_id),
                        ("runtime".to_string(), runtime_label.to_lowercase()),
                    ]),
                ));
            }
        }
    }
    // 托管供应商走 SSH 不再一刀切拒绝：应用内 SSH2 通道把凭证经带外文件送过去（不进任何
    // 进程参数）；只有系统 ssh 回退路径仍拒绝——那是传输层的事，判在 create_session。
    Ok(())
}

/// 登录账号属于别的 CLI：目录对不上，这次启动既没有密钥也没有登录。
fn account_login_mismatch(account: &ProviderAccount, cli_tool: CliTool) -> bool {
    account.kind == AccountKind::Login && account.cli_tool.as_deref() != Some(cli_tool.as_id())
}

/// 默认回退用：供应商的默认账号对这个 CLI 是否有可用的托管配置。
fn provider_has_managed_configuration(provider: &Provider, cli_tool: CliTool) -> bool {
    provider.default_account().is_some_and(|account| {
        !account_login_mismatch(account, cli_tool)
            && super::ProviderService::managed_configuration_is_usable(provider, account)
    })
}

fn compatible_default_provider_id<'a>(
    default_provider_id: Option<&'a str>,
    providers: &'a [Provider],
    cli_tool: CliTool,
    registry: &CliToolRegistry,
) -> Option<&'a str> {
    if default_provider_id == Some(crate::models::provider::SYSTEM_PROVIDER_ID) {
        return default_provider_id;
    }
    let adapter = registry.get(cli_tool.as_id())?;
    let selected = match default_provider_id {
        Some(id) => providers.iter().find(|provider| provider.id == id),
        None => providers.iter().find(|provider| provider.is_default),
    }?;
    if !provider_has_managed_configuration(selected, cli_tool) {
        return None;
    }
    let provider_type = serde_json::to_value(selected.provider_type)
        .ok()
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_default();
    (adapter.capabilities().supports_provider
        && adapter
            .capabilities()
            .compatible_provider_types
            .iter()
            .any(|compatible| compatible == &provider_type))
    .then_some(selected.id.as_str())
}

fn normalize_id(id: Option<&str>) -> Option<&str> {
    id.map(str::trim).filter(|value| !value.is_empty())
}

fn native_plan() -> ResolvedProviderPlan {
    ResolvedProviderPlan {
        mode: ProviderMode::Native,
        selection: LaunchProviderSelection::None,
        source: ProviderSource::Native,
        provider: None,
        account_id: None,
        model_id: None,
        model_label: None,
        model_default_effort: None,
        model_source: ModelSource::NativeDefault,
    }
}

fn provider_model_error(
    code: &str,
    message: impl Into<String>,
    cli_tool: CliTool,
    provider_id: &str,
    model_id: &str,
) -> AppError {
    AppError::coded_with_params(
        code,
        message,
        HashMap::from([
            ("cliTool".to_string(), cli_tool.as_id().to_string()),
            ("providerId".to_string(), provider_id.to_string()),
            ("modelId".to_string(), model_id.to_string()),
        ]),
    )
}

fn provider_error(
    code: &str,
    message: impl Into<String>,
    cli_tool: CliTool,
    provider_id: Option<&str>,
) -> AppError {
    let mut params = HashMap::from([("cliTool".to_string(), cli_tool.as_id().to_string())]);
    if let Some(provider_id) = provider_id {
        params.insert("providerId".to_string(), provider_id.to_string());
    }
    AppError::coded_with_params(code, message, params)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::provider::{ProviderModel, ProviderType, SYSTEM_PROVIDER_ID};

    /// 这些测试手写的 Provider 只带旧字段（`api_key` / `base_url` / `config_dir`）。
    /// 生产路径拿到的永远是 `ProviderService::list_providers()` 归一过的结构，所以这里先同样
    /// 归一（建默认账号、地址进接口）再解析。同名遮蔽 `super::resolve_provider_plan`。
    fn resolve_provider_plan(
        input: ProviderResolutionInput<'_>,
        providers: &[Provider],
        registry: &CliToolRegistry,
    ) -> AppResult<ResolvedProviderPlan> {
        let providers: Vec<Provider> = providers
            .iter()
            .cloned()
            .map(|provider| {
                crate::services::ProviderService::normalize_legacy_provider(provider)
                    .expect("test provider should normalize")
            })
            .collect();
        super::resolve_provider_plan(input, &providers, registry)
    }

    fn provider(id: &str, provider_type: ProviderType) -> Provider {
        Provider {
            id: id.to_string(),
            name: format!("Provider {id}"),
            provider_type,
            api_key: Some("test-secret".to_string()),
            base_url: Some("https://example.test/v1".to_string()),
            region: None,
            project_id: None,
            aws_profile: None,
            config_dir: None,
            models: Vec::new(),
            default_model_id: None,
            codex_wire_api: None,
            is_default: false,
            ..Provider::default()
        }
    }

    fn resolve(
        cli_tool: CliTool,
        selection: LaunchProviderSelection,
        requested: Option<&str>,
        profile: Option<&str>,
        workspace: Option<&str>,
        providers: &[Provider],
    ) -> AppResult<ResolvedProviderPlan> {
        resolve_provider_plan(
            ProviderResolutionInput {
                cli_tool,
                selection,
                requested_provider_id: requested,
                requested_model_id: None,
                profile_provider_id: profile,
                profile_model_id: None,
                workspace_provider_id: workspace,
                requested_account_id: None,
                profile_account_id: None,
                workspace_account_id: None,
                default_provider_id: providers
                    .iter()
                    .find(|provider| provider.is_default)
                    .map(|provider| provider.id.as_str()),
                adapter_options: None,
            },
            providers,
            &CliToolRegistry::with_builtin_adapters(),
        )
    }

    fn provider_with_models() -> Provider {
        let mut configured = provider("anthropic", ProviderType::Anthropic);
        configured.models = vec![
            ProviderModel {
                id: "provider-default".to_string(),
                label: Some("Provider Default".to_string()),
                default_effort: Some("high".to_string()),
                context_window_tokens: None,
                context_size: None,
                hidden: false,
            },
            ProviderModel {
                id: "profile-model".to_string(),
                label: Some("Profile Model".to_string()),
                default_effort: Some("low".to_string()),
                context_window_tokens: None,
                context_size: None,
                hidden: false,
            },
            ProviderModel {
                id: "request-model".to_string(),
                label: Some("Request Model".to_string()),
                default_effort: Some("xhigh".to_string()),
                context_window_tokens: None,
                context_size: None,
                hidden: false,
            },
        ];
        configured.default_model_id = Some("provider-default".to_string());
        configured
    }

    fn resolve_model(
        selection: LaunchProviderSelection,
        requested_provider_id: Option<&str>,
        requested_model_id: Option<&str>,
        profile_provider_id: Option<&str>,
        profile_model_id: Option<&str>,
        providers: &[Provider],
    ) -> AppResult<ResolvedProviderPlan> {
        resolve_provider_plan(
            ProviderResolutionInput {
                cli_tool: CliTool::Claude,
                selection,
                requested_provider_id,
                requested_model_id,
                profile_provider_id,
                profile_model_id,
                workspace_provider_id: None,
                requested_account_id: None,
                profile_account_id: None,
                workspace_account_id: None,
                default_provider_id: providers
                    .iter()
                    .find(|provider| provider.is_default)
                    .map(|provider| provider.id.as_str()),
                adapter_options: None,
            },
            providers,
            &CliToolRegistry::with_builtin_adapters(),
        )
    }

    #[test]
    fn model_resolution_prefers_request_then_profile_then_provider_default() {
        let providers = [provider_with_models()];

        let requested = resolve_model(
            LaunchProviderSelection::Inherit,
            Some("anthropic"),
            Some("request-model"),
            Some("anthropic"),
            Some("profile-model"),
            &providers,
        )
        .unwrap();
        assert_eq!(requested.model_id.as_deref(), Some("request-model"));
        assert_eq!(requested.model_default_effort.as_deref(), Some("xhigh"));
        assert_eq!(requested.model_source, ModelSource::Request);

        let profiled = resolve_model(
            LaunchProviderSelection::Inherit,
            None,
            None,
            Some("anthropic"),
            Some("profile-model"),
            &providers,
        )
        .unwrap();
        assert_eq!(profiled.model_id.as_deref(), Some("profile-model"));
        assert_eq!(profiled.model_default_effort.as_deref(), Some("low"));
        assert_eq!(profiled.model_source, ModelSource::LaunchProfile);

        let provider_default = resolve_model(
            LaunchProviderSelection::Inherit,
            None,
            None,
            Some("anthropic"),
            None,
            &providers,
        )
        .unwrap();
        assert_eq!(
            provider_default.model_id.as_deref(),
            Some("provider-default")
        );
        assert_eq!(
            provider_default.model_default_effort.as_deref(),
            Some("high")
        );
        assert_eq!(provider_default.model_source, ModelSource::ProviderDefault);
    }

    #[test]
    fn model_effort_defaults_only_when_launch_options_do_not_override_it() {
        let providers = [provider_with_models()];
        let plan = resolve_model(
            LaunchProviderSelection::Inherit,
            None,
            None,
            Some("anthropic"),
            Some("profile-model"),
            &providers,
        )
        .unwrap();

        let mut inherited = HashMap::new();
        plan.apply_model_adapter_defaults(&mut inherited);
        assert_eq!(inherited.get("effort"), Some(&serde_json::json!("low")));

        let mut overridden = HashMap::from([("effort".to_string(), serde_json::json!("max"))]);
        plan.apply_model_adapter_defaults(&mut overridden);
        assert_eq!(overridden.get("effort"), Some(&serde_json::json!("max")));
    }

    #[test]
    fn native_mode_ignores_model_metadata() {
        let providers = [provider_with_models()];
        let plan = resolve_model(
            LaunchProviderSelection::None,
            Some("anthropic"),
            Some("request-model"),
            Some("anthropic"),
            Some("profile-model"),
            &providers,
        )
        .unwrap();

        assert_eq!(plan.mode, ProviderMode::Native);
        assert_eq!(plan.model_id, None);
        assert_eq!(plan.model_source, ModelSource::NativeDefault);
    }

    #[test]
    fn stale_selected_model_returns_structured_error() {
        let providers = [provider_with_models()];
        let error = resolve_model(
            LaunchProviderSelection::Explicit,
            Some("anthropic"),
            Some("removed-model"),
            None,
            None,
            &providers,
        )
        .unwrap_err();

        assert_eq!(error.code(), Some("PROVIDER_MODEL_NOT_FOUND"));
        assert!(!error.to_string().contains("test-secret"));
    }

    #[test]
    fn provider_without_model_catalog_keeps_cli_native_default() {
        let providers = [provider("anthropic", ProviderType::Anthropic)];
        let plan = resolve_model(
            LaunchProviderSelection::Explicit,
            Some("anthropic"),
            None,
            None,
            None,
            &providers,
        )
        .unwrap();

        assert_eq!(plan.mode, ProviderMode::Managed);
        assert_eq!(plan.model_id, None);
        assert_eq!(plan.model_source, ModelSource::NativeDefault);
    }

    #[test]
    fn none_ignores_all_provider_bindings() {
        let providers = [provider("request", ProviderType::Anthropic)];
        let plan = resolve(
            CliTool::Claude,
            LaunchProviderSelection::None,
            Some("request"),
            Some("profile"),
            Some("workspace"),
            &providers,
        )
        .unwrap();

        assert_eq!(plan.mode, ProviderMode::Native);
        assert_eq!(plan.selection, LaunchProviderSelection::None);
        assert_eq!(plan.source, ProviderSource::Native);
        assert!(plan.provider.is_none());
    }

    #[test]
    fn explicit_valid_compatible_provider_is_managed() {
        let providers = [provider("anthropic", ProviderType::Anthropic)];
        let plan = resolve(
            CliTool::Claude,
            LaunchProviderSelection::Explicit,
            Some("anthropic"),
            None,
            None,
            &providers,
        )
        .unwrap();

        assert_eq!(plan.mode, ProviderMode::Managed);
        assert_eq!(plan.source, ProviderSource::Request);
        assert_eq!(
            plan.provider.as_ref().map(|item| item.id.as_str()),
            Some("anthropic")
        );
    }

    #[test]
    fn explicit_requires_non_empty_provider_id() {
        for requested in [None, Some(""), Some("   ")] {
            let error = resolve(
                CliTool::Claude,
                LaunchProviderSelection::Explicit,
                requested,
                None,
                None,
                &[],
            )
            .unwrap_err();
            assert_eq!(error.code(), Some("PROVIDER_REQUIRED"));
        }
    }

    #[test]
    fn selected_provider_must_exist() {
        let error = resolve(
            CliTool::Claude,
            LaunchProviderSelection::Explicit,
            Some("deleted"),
            None,
            None,
            &[],
        )
        .unwrap_err();
        assert_eq!(error.code(), Some("PROVIDER_NOT_FOUND"));
        assert!(!error.to_string().contains("test-secret"));
    }

    #[test]
    fn selected_provider_must_match_cli_capability() {
        let providers = [provider("openai", ProviderType::OpenAI)];
        let error = resolve(
            CliTool::Claude,
            LaunchProviderSelection::Explicit,
            Some("openai"),
            None,
            None,
            &providers,
        )
        .unwrap_err();
        assert_eq!(error.code(), Some("PROVIDER_INCOMPATIBLE"));
    }

    #[test]
    fn explicit_provider_requires_usable_managed_configuration() {
        let mut empty = provider("empty", ProviderType::Anthropic);
        empty.api_key = None;
        empty.base_url = None;
        let error = resolve(
            CliTool::Claude,
            LaunchProviderSelection::Explicit,
            Some("empty"),
            None,
            None,
            &[empty],
        )
        .unwrap_err();
        assert_eq!(error.code(), Some("PROVIDER_CONFIG_INVALID"));
    }

    #[test]
    fn kimi_managed_provider_requires_an_api_key() {
        let mut url_only = provider("kimi-url-only", ProviderType::Kimi);
        url_only.api_key = None;
        let error = resolve(
            CliTool::Kimi,
            LaunchProviderSelection::Explicit,
            Some("kimi-url-only"),
            None,
            None,
            &[url_only],
        )
        .unwrap_err();

        assert_eq!(error.code(), Some("PROVIDER_CONFIG_INVALID"));
    }

    #[test]
    fn config_profile_must_exist_and_contain_usable_env() {
        let dir = tempfile::tempdir().unwrap();
        let mut profile = provider("profile", ProviderType::ConfigProfile);
        profile.api_key = None;
        profile.base_url = None;
        profile.config_dir = Some(
            dir.path()
                .join("missing.json")
                .to_string_lossy()
                .to_string(),
        );
        let missing = resolve(
            CliTool::Claude,
            LaunchProviderSelection::Explicit,
            Some("profile"),
            None,
            None,
            &[profile.clone()],
        )
        .unwrap_err();
        assert_eq!(missing.code(), Some("PROVIDER_CONFIG_INVALID"));

        let config_path = dir.path().join("profile.json");
        std::fs::write(&config_path, r#"{"env": {}}"#).unwrap();
        profile.config_dir = Some(config_path.to_string_lossy().to_string());
        let empty = resolve(
            CliTool::Claude,
            LaunchProviderSelection::Explicit,
            Some("profile"),
            None,
            None,
            &[profile],
        )
        .unwrap_err();
        assert_eq!(empty.code(), Some("PROVIDER_CONFIG_INVALID"));
    }

    #[test]
    fn config_profile_requires_an_existing_path_with_usable_content() {
        let mut missing = provider("missing-profile", ProviderType::ConfigProfile);
        missing.api_key = None;
        missing.base_url = None;
        missing.config_dir = Some(
            std::env::temp_dir()
                .join(format!("cc-panes-missing-profile-{}", uuid::Uuid::new_v4()))
                .to_string_lossy()
                .into_owned(),
        );
        let error = resolve(
            CliTool::Claude,
            LaunchProviderSelection::Explicit,
            Some("missing-profile"),
            None,
            None,
            &[missing],
        )
        .unwrap_err();
        assert_eq!(error.code(), Some("PROVIDER_CONFIG_INVALID"));

        let dir = tempfile::tempdir().unwrap();
        let config_path = dir.path().join("profile.json");
        std::fs::write(&config_path, r#"{"env":{}}"#).unwrap();
        let mut empty = provider("empty-profile", ProviderType::ConfigProfile);
        empty.api_key = None;
        empty.base_url = None;
        empty.config_dir = Some(config_path.to_string_lossy().into_owned());
        let error = resolve(
            CliTool::Claude,
            LaunchProviderSelection::Explicit,
            Some("empty-profile"),
            None,
            None,
            &[empty],
        )
        .unwrap_err();
        assert_eq!(error.code(), Some("PROVIDER_CONFIG_INVALID"));

        std::fs::write(
            &config_path,
            r#"{"env":{"ANTHROPIC_API_KEY":"test-secret"}}"#,
        )
        .unwrap();
        let mut usable = provider("usable-profile", ProviderType::ConfigProfile);
        usable.api_key = None;
        usable.base_url = None;
        usable.config_dir = Some(config_path.to_string_lossy().into_owned());
        let plan = resolve(
            CliTool::Claude,
            LaunchProviderSelection::Explicit,
            Some("usable-profile"),
            None,
            None,
            &[usable],
        )
        .unwrap();
        assert_eq!(plan.mode, ProviderMode::Managed);
    }

    #[test]
    fn inherit_prefers_request_then_profile_then_workspace() {
        let providers = [
            provider("request", ProviderType::Anthropic),
            provider("profile", ProviderType::Anthropic),
            provider("workspace", ProviderType::Anthropic),
        ];

        let request = resolve(
            CliTool::Claude,
            LaunchProviderSelection::Inherit,
            Some("request"),
            Some("profile"),
            Some("workspace"),
            &providers,
        )
        .unwrap();
        assert_eq!(request.source, ProviderSource::Request);
        assert_eq!(request.provider.unwrap().id, "request");

        let profile = resolve(
            CliTool::Claude,
            LaunchProviderSelection::Inherit,
            None,
            Some("profile"),
            Some("workspace"),
            &providers,
        )
        .unwrap();
        assert_eq!(profile.source, ProviderSource::LaunchProfile);
        assert_eq!(profile.provider.unwrap().id, "profile");

        let workspace = resolve(
            CliTool::Claude,
            LaunchProviderSelection::Inherit,
            None,
            None,
            Some("workspace"),
            &providers,
        )
        .unwrap();
        assert_eq!(workspace.source, ProviderSource::LegacyWorkspace);
        assert_eq!(workspace.provider.unwrap().id, "workspace");
    }

    #[test]
    fn inherit_without_binding_uses_the_compatible_persisted_default() {
        let mut default_provider = provider("global-default", ProviderType::Anthropic);
        default_provider.is_default = true;
        let providers = [default_provider];
        let plan = resolve(
            CliTool::Claude,
            LaunchProviderSelection::Inherit,
            None,
            None,
            None,
            &providers,
        )
        .unwrap();
        assert_eq!(plan.mode, ProviderMode::Managed);
        assert_eq!(plan.source, ProviderSource::DefaultProvider);
        assert_eq!(plan.provider.unwrap().id, "global-default");
    }

    #[test]
    fn scoped_default_is_used_only_after_explicit_and_bound_choices() {
        let providers = [
            provider("request", ProviderType::Anthropic),
            provider("profile", ProviderType::Anthropic),
            provider("workspace", ProviderType::Anthropic),
            provider("default", ProviderType::Anthropic),
        ];
        let registry = CliToolRegistry::with_builtin_adapters();

        let resolve_with = |requested, profile, workspace| {
            resolve_provider_plan(
                ProviderResolutionInput {
                    cli_tool: CliTool::Claude,
                    selection: LaunchProviderSelection::Inherit,
                    requested_provider_id: requested,
                    requested_model_id: None,
                    profile_provider_id: profile,
                    profile_model_id: None,
                    workspace_provider_id: workspace,
                    requested_account_id: None,
                    profile_account_id: None,
                    workspace_account_id: None,
                    default_provider_id: Some("default"),
                    adapter_options: None,
                },
                &providers,
                &registry,
            )
            .unwrap()
        };

        assert_eq!(
            resolve_with(Some("request"), Some("profile"), Some("workspace"))
                .provider
                .unwrap()
                .id,
            "request"
        );
        assert_eq!(
            resolve_with(None, Some("profile"), Some("workspace"))
                .provider
                .unwrap()
                .id,
            "profile"
        );
        assert_eq!(
            resolve_with(None, None, Some("workspace"))
                .provider
                .unwrap()
                .id,
            "workspace"
        );
        assert_eq!(
            resolve_with(None, None, None).provider.unwrap().id,
            "default"
        );
    }

    #[test]
    fn incompatible_persisted_default_falls_back_to_native() {
        let mut default_provider = provider("claude-default", ProviderType::Anthropic);
        default_provider.is_default = true;
        let providers = [default_provider];
        let plan = resolve(
            CliTool::Codex,
            LaunchProviderSelection::Inherit,
            None,
            None,
            None,
            &providers,
        )
        .unwrap();

        assert_eq!(plan.mode, ProviderMode::Native);
        assert!(plan.provider.is_none());
    }

    #[test]
    fn inherit_without_binding_stays_native_when_no_default_is_marked() {
        let providers = [provider("not-default", ProviderType::Anthropic)];
        let plan = resolve(
            CliTool::Claude,
            LaunchProviderSelection::Inherit,
            None,
            None,
            None,
            &providers,
        )
        .unwrap();

        assert_eq!(plan.mode, ProviderMode::Native);
        assert!(plan.provider.is_none());
    }

    #[test]
    fn system_sentinel_normalizes_to_native_none() {
        let plan = resolve(
            CliTool::Claude,
            LaunchProviderSelection::Explicit,
            Some(SYSTEM_PROVIDER_ID),
            None,
            None,
            &[],
        )
        .unwrap();
        assert_eq!(plan.mode, ProviderMode::Native);
        assert_eq!(plan.selection, LaunchProviderSelection::None);
        assert!(plan.provider.is_none());
    }

    #[test]
    fn plain_shell_system_sentinel_normalizes_before_explicit_rejection() {
        let plan = resolve(
            CliTool::None,
            LaunchProviderSelection::Explicit,
            Some(SYSTEM_PROVIDER_ID),
            None,
            None,
            &[],
        )
        .unwrap();

        assert_eq!(plan.mode, ProviderMode::Native);
        assert_eq!(plan.selection, LaunchProviderSelection::None);
    }

    #[test]
    fn lower_priority_system_sentinel_does_not_override_request_provider() {
        let providers = [provider("request", ProviderType::Anthropic)];
        let plan = resolve(
            CliTool::Claude,
            LaunchProviderSelection::Inherit,
            Some("request"),
            Some(SYSTEM_PROVIDER_ID),
            None,
            &providers,
        )
        .unwrap();
        assert_eq!(plan.mode, ProviderMode::Managed);
        assert_eq!(plan.provider.unwrap().id, "request");
    }

    #[test]
    fn plain_shell_rejects_explicit_real_provider() {
        let providers = [provider("anthropic", ProviderType::Anthropic)];
        let error = resolve(
            CliTool::None,
            LaunchProviderSelection::Explicit,
            Some("anthropic"),
            None,
            None,
            &providers,
        )
        .unwrap_err();
        assert_eq!(error.code(), Some("PROVIDER_UNSUPPORTED"));
    }

    #[test]
    fn managed_conflict_lists_are_cli_scoped_and_never_apply_to_shell() {
        assert!(managed_provider_conflict_env_keys(CliTool::Claude)
            .contains(&"CLAUDE_CODE_USE_BEDROCK"));
        assert!(managed_provider_conflict_env_keys(CliTool::Claude).contains(&"ANTHROPIC_MODEL"));
        assert!(managed_provider_conflict_env_keys(CliTool::Claude)
            .contains(&"CLAUDE_CODE_SUBAGENT_MODEL"));
        assert!(!managed_provider_conflict_env_keys(CliTool::Codex)
            .contains(&"CLAUDE_CODE_USE_BEDROCK"));
        assert!(managed_provider_conflict_env_keys(CliTool::Codex).contains(&"OPENAI_BASE_URL"));
        assert!(managed_provider_conflict_env_keys(CliTool::Pi).contains(&"OPENAI_API_KEY"));
        assert!(managed_provider_conflict_env_keys(CliTool::Pi).contains(&"ANTHROPIC_AUTH_TOKEN"));
        assert!(managed_provider_conflict_env_keys(CliTool::Pi).contains(&"PI_CODING_AGENT_DIR"));
        assert!(managed_provider_conflict_env_keys(CliTool::Pi)
            .contains(&"PI_CODING_AGENT_SESSION_DIR"));
        assert!(managed_provider_conflict_env_keys(CliTool::None).is_empty());
    }

    #[test]
    fn legacy_kimi_native_option_only_overrides_inherit_selection() {
        let providers = [provider("kimi", ProviderType::Kimi)];
        let adapter_options = HashMap::from([(
            "kimiConfigMode".to_string(),
            serde_json::Value::String("native".to_string()),
        )]);

        let inherited = resolve_provider_plan(
            ProviderResolutionInput {
                cli_tool: CliTool::Kimi,
                selection: LaunchProviderSelection::Inherit,
                requested_provider_id: Some("kimi"),
                requested_model_id: None,
                profile_provider_id: None,
                profile_model_id: None,
                workspace_provider_id: None,
                requested_account_id: None,
                profile_account_id: None,
                workspace_account_id: None,
                default_provider_id: None,
                adapter_options: Some(&adapter_options),
            },
            &providers,
            &CliToolRegistry::with_builtin_adapters(),
        )
        .unwrap();
        assert_eq!(inherited.mode, ProviderMode::Native);

        let explicit = resolve_provider_plan(
            ProviderResolutionInput {
                cli_tool: CliTool::Kimi,
                selection: LaunchProviderSelection::Explicit,
                requested_provider_id: Some("kimi"),
                requested_model_id: None,
                profile_provider_id: None,
                profile_model_id: None,
                workspace_provider_id: None,
                requested_account_id: None,
                profile_account_id: None,
                workspace_account_id: None,
                default_provider_id: None,
                adapter_options: Some(&adapter_options),
            },
            &providers,
            &CliToolRegistry::with_builtin_adapters(),
        )
        .unwrap();
        assert_eq!(explicit.mode, ProviderMode::Managed);
    }

    #[test]
    fn pi_native_options_override_inherited_provider_fallback_only() {
        let mut managed = provider("pi-managed", ProviderType::OpenAI);
        managed.is_default = true;
        let providers = [managed];
        let adapter_options = HashMap::from([
            (
                "piNativeProvider".to_string(),
                serde_json::Value::String("anthropic".to_string()),
            ),
            (
                "piNativeModel".to_string(),
                serde_json::Value::String("claude-sonnet".to_string()),
            ),
        ]);

        let inherited = resolve_provider_plan(
            ProviderResolutionInput {
                cli_tool: CliTool::Pi,
                selection: LaunchProviderSelection::Inherit,
                requested_provider_id: Some("pi-managed"),
                requested_model_id: None,
                profile_provider_id: Some("pi-managed"),
                profile_model_id: None,
                workspace_provider_id: Some("pi-managed"),
                requested_account_id: None,
                profile_account_id: None,
                workspace_account_id: None,
                default_provider_id: Some("pi-managed"),
                adapter_options: Some(&adapter_options),
            },
            &providers,
            &CliToolRegistry::with_builtin_adapters(),
        )
        .unwrap();
        assert_eq!(inherited.mode, ProviderMode::Native);
        assert_eq!(inherited.source, ProviderSource::Native);

        let explicit = resolve_provider_plan(
            ProviderResolutionInput {
                cli_tool: CliTool::Pi,
                selection: LaunchProviderSelection::Explicit,
                requested_provider_id: Some("pi-managed"),
                requested_model_id: None,
                profile_provider_id: None,
                profile_model_id: None,
                workspace_provider_id: None,
                requested_account_id: None,
                profile_account_id: None,
                workspace_account_id: None,
                default_provider_id: Some("pi-managed"),
                adapter_options: Some(&adapter_options),
            },
            &providers,
            &CliToolRegistry::with_builtin_adapters(),
        )
        .unwrap();
        assert_eq!(explicit.mode, ProviderMode::Managed);
        assert_eq!(
            explicit
                .provider
                .as_ref()
                .map(|provider| provider.id.as_str()),
            Some("pi-managed")
        );
    }

    #[test]
    fn all_builtin_adapters_resolve_paired_managed_and_native_modes() {
        let cases = [
            (CliTool::Claude, ProviderType::Anthropic),
            (CliTool::Codex, ProviderType::OpenAI),
            (CliTool::Gemini, ProviderType::Gemini),
            (CliTool::Kimi, ProviderType::Kimi),
            (CliTool::Opencode, ProviderType::OpenCode),
            (CliTool::Cursor, ProviderType::Cursor),
            (CliTool::Grok, ProviderType::Grok),
            (CliTool::Pi, ProviderType::OpenAI),
        ];
        for (cli_tool, provider_type) in cases {
            let configured = provider(cli_tool.as_id(), provider_type);
            let managed = resolve(
                cli_tool,
                LaunchProviderSelection::Explicit,
                Some(cli_tool.as_id()),
                None,
                None,
                std::slice::from_ref(&configured),
            )
            .unwrap();
            assert_eq!(managed.mode, ProviderMode::Managed, "{}", cli_tool.as_id());
            let account_id = managed.account_id.clone();
            let managed_provider = managed.provider.unwrap();
            let account = managed_provider.account(account_id.as_deref()).unwrap();
            assert!(!managed_provider
                .generated_env(cli_tool.as_id(), account, Some("test-secret"))
                .is_empty());

            let native = resolve(
                cli_tool,
                LaunchProviderSelection::None,
                Some(cli_tool.as_id()),
                Some(cli_tool.as_id()),
                Some(cli_tool.as_id()),
                std::slice::from_ref(&configured),
            )
            .unwrap();
            assert_eq!(native.mode, ProviderMode::Native, "{}", cli_tool.as_id());
            assert!(native.provider.is_none());
        }
    }

    #[test]
    fn ssh_managed_and_native_both_pass_runtime_validation() {
        let providers = [provider("anthropic", ProviderType::Anthropic)];
        let managed = resolve(
            CliTool::Claude,
            LaunchProviderSelection::Explicit,
            Some("anthropic"),
            None,
            None,
            &providers,
        )
        .unwrap();
        // 传输是否安全由 create_session 按「应用内 SSH2 / 系统 ssh」判定，这里不再拦
        assert!(validate_provider_runtime(&managed, LaunchRuntime::Ssh, CliTool::Claude).is_ok());
        assert!(validate_provider_runtime(&managed, LaunchRuntime::Local, CliTool::Claude).is_ok());
        assert!(validate_provider_runtime(&managed, LaunchRuntime::Wsl, CliTool::Claude).is_ok());

        let native = resolve(
            CliTool::Claude,
            LaunchProviderSelection::None,
            None,
            None,
            None,
            &[],
        )
        .unwrap();
        assert!(validate_provider_runtime(&native, LaunchRuntime::Ssh, CliTool::Claude).is_ok());
        let error =
            validate_provider_runtime(&native, LaunchRuntime::Ssh, CliTool::Pi).unwrap_err();
        assert_eq!(error.code(), Some("PI_SSH_UNSUPPORTED"));
    }

    // ---- 账号 ----

    use crate::models::provider::{AccountKind, ProviderAccount};

    fn key_account(id: &str) -> ProviderAccount {
        ProviderAccount {
            id: id.to_string(),
            name: id.to_string(),
            kind: AccountKind::ApiKey,
            secret: Some(format!("secret-{id}")),
            ..ProviderAccount::default()
        }
    }

    fn login_account(id: &str, cli_tool: &str) -> ProviderAccount {
        ProviderAccount {
            id: id.to_string(),
            name: id.to_string(),
            kind: AccountKind::Login,
            cli_tool: Some(cli_tool.to_string()),
            config_dir: Some(format!("/accounts/{id}")),
            ..ProviderAccount::default()
        }
    }

    /// 两个密钥账号的供应商，默认账号是 `home`。
    fn provider_with_accounts(id: &str) -> Provider {
        let mut configured = provider(id, ProviderType::Anthropic);
        configured.api_key = None;
        configured.accounts = vec![key_account("work"), key_account("home")];
        configured.default_account_id = Some("home".to_string());
        configured
    }

    #[allow(clippy::too_many_arguments)]
    fn resolve_accounts(
        cli_tool: CliTool,
        requested: (Option<&str>, Option<&str>),
        profile: (Option<&str>, Option<&str>),
        workspace: (Option<&str>, Option<&str>),
        default_provider_id: Option<&str>,
        providers: &[Provider],
    ) -> AppResult<ResolvedProviderPlan> {
        resolve_provider_plan(
            ProviderResolutionInput {
                cli_tool,
                selection: LaunchProviderSelection::Inherit,
                requested_provider_id: requested.0,
                requested_model_id: None,
                profile_provider_id: profile.0,
                profile_model_id: None,
                workspace_provider_id: workspace.0,
                requested_account_id: requested.1,
                profile_account_id: profile.1,
                workspace_account_id: workspace.1,
                default_provider_id,
                adapter_options: None,
            },
            providers,
            &CliToolRegistry::with_builtin_adapters(),
        )
    }

    #[test]
    fn unspecified_account_falls_back_to_the_provider_default_account() {
        let providers = vec![provider_with_accounts("p1")];

        // 运行配置 / 工作空间 / 请求只记了供应商：用默认账号。
        for (requested, profile, workspace) in [
            (Some("p1"), None, None),
            (None, Some("p1"), None),
            (None, None, Some("p1")),
        ] {
            let plan = resolve_accounts(
                CliTool::Claude,
                (requested, None),
                (profile, None),
                (workspace, None),
                None,
                &providers,
            )
            .unwrap();
            assert_eq!(plan.mode, ProviderMode::Managed);
            assert_eq!(plan.account_id.as_deref(), Some("home"));
        }

        // 按 CLI 默认供应商回退时同样用默认账号。
        let plan = resolve_accounts(
            CliTool::Claude,
            (None, None),
            (None, None),
            (None, None),
            Some("p1"),
            &providers,
        )
        .unwrap();
        assert_eq!(plan.source, ProviderSource::DefaultProvider);
        assert_eq!(plan.account_id.as_deref(), Some("home"));
    }

    #[test]
    fn replaying_the_resolved_pair_survives_a_default_provider_switch() {
        // 两家都只有一个叫 `default` 的密钥账号（旧数据迁移后的常态）。
        let providers = vec![
            provider("provider-a", ProviderType::Anthropic),
            provider("provider-b", ProviderType::Anthropic),
        ];

        // 第一次启动：请求没点名供应商，继承到当时的默认供应商 A。
        let first = resolve_accounts(
            CliTool::Claude,
            (None, None),
            (None, None),
            (None, None),
            Some("provider-a"),
            &providers,
        )
        .unwrap();
        assert_eq!(first.source, ProviderSource::DefaultProvider);
        let recorded_provider = first.provider.as_ref().map(|p| p.id.clone());
        let recorded_account = first.account_id.clone();
        assert_eq!(recorded_provider.as_deref(), Some("provider-a"));
        assert_eq!(recorded_account.as_deref(), Some("default"));

        // 之后默认供应商换成了 B。只带账号回来（旧行为）会静默落到 B 的 `default` 上——
        // 这正是要堵的洞：
        let account_only = resolve_accounts(
            CliTool::Claude,
            (None, recorded_account.as_deref()),
            (None, None),
            (None, None),
            Some("provider-b"),
            &providers,
        )
        .unwrap();
        assert_eq!(
            account_only.provider.as_ref().map(|p| p.id.as_str()),
            Some("provider-b")
        );

        // 带着记下的那一对回来：仍是 A 的原账号，和现在的默认值无关。
        let replayed = resolve_accounts(
            CliTool::Claude,
            (recorded_provider.as_deref(), recorded_account.as_deref()),
            (None, None),
            (None, None),
            Some("provider-b"),
            &providers,
        )
        .unwrap();
        assert_eq!(
            replayed.provider.as_ref().map(|p| p.id.as_str()),
            Some("provider-a")
        );
        assert_eq!(replayed.account_id.as_deref(), Some("default"));
    }

    #[test]
    fn account_follows_the_layer_that_selected_the_provider() {
        let providers = vec![provider_with_accounts("p1"), provider_with_accounts("p2")];

        // 运行配置指定了账号。
        let plan = resolve_accounts(
            CliTool::Claude,
            (None, None),
            (Some("p1"), Some("work")),
            (Some("p2"), Some("work")),
            None,
            &providers,
        )
        .unwrap();
        assert_eq!(plan.source, ProviderSource::LaunchProfile);
        assert_eq!(plan.account_id.as_deref(), Some("work"));

        // 工作空间绑定了账号。
        let plan = resolve_accounts(
            CliTool::Claude,
            (None, None),
            (None, None),
            (Some("p2"), Some("work")),
            None,
            &providers,
        )
        .unwrap();
        assert_eq!(plan.source, ProviderSource::LegacyWorkspace);
        assert_eq!(plan.account_id.as_deref(), Some("work"));

        // 请求选了供应商但没选账号：不借用运行配置里（属于另一条供应商）的账号。
        let plan = resolve_accounts(
            CliTool::Claude,
            (Some("p2"), None),
            (Some("p1"), Some("work")),
            (None, None),
            None,
            &providers,
        )
        .unwrap();
        assert_eq!(plan.source, ProviderSource::Request);
        assert_eq!(plan.provider.as_ref().unwrap().id, "p2");
        assert_eq!(plan.account_id.as_deref(), Some("home"));

        // 请求里同时选了供应商和账号：最优先。
        let plan = resolve_accounts(
            CliTool::Claude,
            (Some("p2"), Some("work")),
            (Some("p1"), Some("home")),
            (None, None),
            None,
            &providers,
        )
        .unwrap();
        assert_eq!(plan.account_id.as_deref(), Some("work"));
    }

    #[test]
    fn unknown_account_is_a_structured_error() {
        let providers = vec![provider_with_accounts("p1")];

        let error = resolve_accounts(
            CliTool::Claude,
            (Some("p1"), Some("gone")),
            (None, None),
            (None, None),
            None,
            &providers,
        )
        .unwrap_err();

        assert_eq!(error.code(), Some("PROVIDER_ACCOUNT_NOT_FOUND"));
        assert!(!error.to_string().contains("secret-"));
    }

    /// 登录账号的目录是本机路径：WSL / SSH 下明确拒绝，不把路径带过去。
    /// 不带目录的「默认登录」和密钥账号不受影响。
    #[test]
    fn login_account_directories_are_rejected_for_wsl_and_ssh_runtimes() {
        let account_dir = tempfile::tempdir().unwrap();
        let mut configured = provider("p1", ProviderType::OpenAI);
        configured.api_key = None;
        configured.base_url = None;
        let mut login = login_account("login", "codex");
        login.config_dir = Some(account_dir.path().to_string_lossy().into_owned());
        configured.accounts = vec![key_account("key"), login];
        let providers = vec![configured];
        let plan_for = |account: &str| {
            resolve_accounts(
                CliTool::Codex,
                (Some("p1"), Some(account)),
                (None, None),
                (None, None),
                None,
                &providers,
            )
            .unwrap()
        };

        let login_plan = plan_for("login");
        assert!(
            validate_provider_runtime(&login_plan, LaunchRuntime::Local, CliTool::Codex).is_ok()
        );
        for runtime in [LaunchRuntime::Wsl, LaunchRuntime::Ssh] {
            let error =
                validate_provider_runtime(&login_plan, runtime, CliTool::Codex).unwrap_err();
            assert_eq!(error.code(), Some("PROVIDER_LOGIN_ACCOUNT_LOCAL_ONLY"));
            assert!(
                !error
                    .to_string()
                    .contains(&*account_dir.path().to_string_lossy()),
                "the error must not carry the local path: {error}"
            );
        }

        // 默认登录没有本机目录：WSL 下照常可用（用 WSL 那一侧 CLI 自己的登录）。
        let default_login = plan_for(crate::models::provider::DEFAULT_LOGIN_ACCOUNT_ID);
        assert_eq!(
            default_login.account_id.as_deref(),
            Some(crate::models::provider::DEFAULT_LOGIN_ACCOUNT_ID)
        );
        assert!(
            validate_provider_runtime(&default_login, LaunchRuntime::Wsl, CliTool::Codex).is_ok()
        );
        // 密钥账号在 WSL 下也照常可用。
        assert!(
            validate_provider_runtime(&plan_for("key"), LaunchRuntime::Wsl, CliTool::Codex).is_ok()
        );
    }

    /// 一份运行配置多处通用：配置里挑的本机登录账号到了 WSL / SSH 自动换成能带过去的账号；
    /// 请求里点名的不换（照旧报 LOCAL_ONLY）。
    #[test]
    fn profile_login_account_is_swapped_for_remote_runtimes_but_requested_one_is_not() {
        let account_dir = tempfile::tempdir().unwrap();
        let mut configured = provider("p1", ProviderType::OpenAI);
        configured.api_key = None;
        configured.base_url = None;
        let mut login = login_account("login", "codex");
        login.config_dir = Some(account_dir.path().to_string_lossy().into_owned());
        configured.accounts = vec![key_account("key"), login];
        let providers = vec![configured];

        let from_profile = || {
            resolve_accounts(
                CliTool::Codex,
                (None, None),
                (Some("p1"), Some("login")),
                (None, None),
                None,
                &providers,
            )
            .unwrap()
        };
        for runtime in [LaunchRuntime::Wsl, LaunchRuntime::Ssh] {
            let mut plan = from_profile();
            let note = adapt_plan_for_runtime(&mut plan, runtime, CliTool::Codex, false);
            assert!(note.is_some());
            assert_eq!(plan.account_id.as_deref(), Some("key"));
            assert!(validate_provider_runtime(&plan, runtime, CliTool::Codex).is_ok());
        }
        // 本机不动
        let mut local = from_profile();
        assert!(
            adapt_plan_for_runtime(&mut local, LaunchRuntime::Local, CliTool::Codex, false)
                .is_none()
        );
        assert_eq!(local.account_id.as_deref(), Some("login"));

        // 启动器点名的账号：不换，照旧报错
        let mut requested = resolve_accounts(
            CliTool::Codex,
            (Some("p1"), Some("login")),
            (None, None),
            (None, None),
            None,
            &providers,
        )
        .unwrap();
        assert!(
            adapt_plan_for_runtime(&mut requested, LaunchRuntime::Wsl, CliTool::Codex, true)
                .is_none()
        );
        let error =
            validate_provider_runtime(&requested, LaunchRuntime::Wsl, CliTool::Codex).unwrap_err();
        assert_eq!(error.code(), Some("PROVIDER_LOGIN_ACCOUNT_LOCAL_ONLY"));
    }

    /// 「配置目录」类型指向 ccswitch JSON 文件的旧用法不设目录变量：WSL 下行为不变。
    #[test]
    fn config_profile_json_file_still_launches_in_wsl() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("profile.json");
        std::fs::write(
            &file,
            r#"{"env":{"ANTHROPIC_BASE_URL":"https://example.test"}}"#,
        )
        .unwrap();
        let mut configured = provider("p1", ProviderType::ConfigProfile);
        configured.api_key = None;
        configured.base_url = None;
        configured.config_dir = Some(file.to_string_lossy().into_owned());
        let providers =
            vec![crate::services::ProviderService::normalize_legacy_provider(configured).unwrap()];

        let plan = resolve_accounts(
            CliTool::Claude,
            (Some("p1"), None),
            (None, None),
            (None, None),
            None,
            &providers,
        )
        .unwrap();

        assert!(validate_provider_runtime(&plan, LaunchRuntime::Wsl, CliTool::Claude).is_ok());
    }

    /// 恢复 / 历史重放带回来的是「当时实际用的账号」，供应商那一半可能是继承来的
    /// （运行配置、工作空间、默认供应商）。点了名的账号必须生效；在选中的供应商上找不到
    /// （账号已被删除）就报错，不能悄悄换成默认账号。
    #[test]
    fn requested_account_is_honored_whatever_the_provider_source_and_never_silently_replaced() {
        let providers = vec![provider_with_accounts("p1")];
        let sources: [(Option<&str>, Option<&str>, Option<&str>); 3] = [
            (Some("p1"), None, None),
            (None, Some("p1"), None),
            (None, None, Some("p1")),
        ];
        for (profile, workspace, default_provider) in sources {
            let plan = resolve_accounts(
                CliTool::Claude,
                (None, Some("work")),
                (profile, Some("home")),
                (workspace, None),
                default_provider,
                &providers,
            )
            .unwrap();
            assert_eq!(plan.account_id.as_deref(), Some("work"));

            let error = resolve_accounts(
                CliTool::Claude,
                (None, Some("deleted-account")),
                (profile, Some("home")),
                (workspace, None),
                default_provider,
                &providers,
            )
            .unwrap_err();
            assert_eq!(error.code(), Some("PROVIDER_ACCOUNT_NOT_FOUND"));
        }
    }

    /// 支持登录账号的供应商类型与适配器的兼容类型一致。
    #[test]
    fn login_cli_tools_match_the_adapter_compatibility_lists() {
        let registry = CliToolRegistry::with_builtin_adapters();
        for provider_type in [
            ProviderType::Anthropic,
            ProviderType::Bedrock,
            ProviderType::Vertex,
            ProviderType::Proxy,
            ProviderType::LocalGateway,
            ProviderType::OpenAI,
            ProviderType::Gemini,
            ProviderType::Grok,
        ] {
            let configured = provider("p1", provider_type);
            let type_id = serde_json::to_value(provider_type).unwrap();
            for cli in configured.login_cli_tools() {
                let adapter = registry.get(cli).unwrap();
                let compatible = adapter
                    .capabilities()
                    .compatible_provider_types
                    .iter()
                    .any(|item| Some(item.as_str()) == type_id.as_str());
                assert!(
                    compatible,
                    "{cli} cannot launch with provider type {type_id}"
                );
            }
        }
    }

    #[test]
    fn login_accounts_resolve_for_their_own_cli_only() {
        let cases = [
            (CliTool::Claude, ProviderType::Anthropic),
            (CliTool::Codex, ProviderType::OpenAI),
            (CliTool::Gemini, ProviderType::Gemini),
            (CliTool::Antigravity, ProviderType::Gemini),
            (CliTool::Grok, ProviderType::Grok),
        ];
        for (cli_tool, provider_type) in cases {
            let mut configured = provider("p1", provider_type);
            configured.api_key = None;
            configured.base_url = None;
            configured.accounts =
                vec![key_account("key"), login_account("login", cli_tool.as_id())];
            let providers = vec![configured];

            let plan = resolve_accounts(
                cli_tool,
                (Some("p1"), Some("login")),
                (None, None),
                (None, None),
                None,
                &providers,
            )
            .unwrap_or_else(|error| panic!("{} login account: {error}", cli_tool.as_id()));
            assert_eq!(plan.mode, ProviderMode::Managed, "{}", cli_tool.as_id());
            assert_eq!(plan.account_id.as_deref(), Some("login"));
        }

        // 登录账号属于别的 CLI：明确报错，而不是带着「没有密钥也没有登录」去启动。
        let mut configured = provider("p1", ProviderType::Anthropic);
        configured.api_key = None;
        configured.accounts = vec![login_account("login", "claude")];
        let providers = vec![configured];
        let error = resolve_accounts(
            CliTool::Jcode,
            (Some("p1"), Some("login")),
            (None, None),
            (None, None),
            None,
            &providers,
        )
        .unwrap_err();
        assert_eq!(error.code(), Some("PROVIDER_ACCOUNT_INCOMPATIBLE"));

        // 作为「该 CLI 的默认供应商」回退时不报错，直接退回原生。
        let plan = resolve_accounts(
            CliTool::Jcode,
            (None, None),
            (None, None),
            (None, None),
            Some("p1"),
            &providers,
        )
        .unwrap();
        assert_eq!(plan.mode, ProviderMode::Native);

        // Antigravity 也接 Gemini 类型的密钥账号（注入 GEMINI_API_KEY）。
        let mut gemini = provider("g1", ProviderType::Gemini);
        gemini.api_key = None;
        gemini.accounts = vec![key_account("key")];
        let plan = resolve_accounts(
            CliTool::Antigravity,
            (Some("g1"), None),
            (None, None),
            (None, None),
            None,
            &[gemini],
        )
        .unwrap();
        assert_eq!(plan.mode, ProviderMode::Managed);
        assert_eq!(plan.account_id.as_deref(), Some("key"));

        // 但不接别的类型。
        let anthropic = provider("a1", ProviderType::Anthropic);
        let error = resolve_accounts(
            CliTool::Antigravity,
            (Some("a1"), None),
            (None, None),
            (None, None),
            None,
            &[anthropic],
        )
        .unwrap_err();
        assert_eq!(error.code(), Some("PROVIDER_INCOMPATIBLE"));
    }
}
