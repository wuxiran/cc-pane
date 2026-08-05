use crate::models::{provider::Provider, CliTool, LaunchProviderSelection};
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
        CliTool::Kimi => &["KIMI_API_KEY", "KIMI_BASE_URL", "KIMI_SHARE_DIR"],
        CliTool::Glm => &[
            "ZAI_API_KEY",
            "ZAI_BASE_URL",
            "CRUSH_GLOBAL_CONFIG",
            "CRUSH_GLOBAL_DATA",
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

    if !provider_has_managed_configuration(&provider) {
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
    if !adapter.capabilities().supports_provider
        || !adapter
            .capabilities()
            .compatible_provider_types
            .iter()
            .any(|compatible| compatible == &provider_type)
    {
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
    if legacy_native_kimi {
        LaunchProviderSelection::None
    } else {
        input.selection
    }
}

pub fn validate_provider_runtime(
    plan: &ResolvedProviderPlan,
    runtime: LaunchRuntime,
    cli_tool: CliTool,
) -> AppResult<()> {
    if runtime == LaunchRuntime::Ssh && plan.mode == ProviderMode::Managed {
        return Err(provider_error(
            "PROVIDER_SSH_MANAGED_UNSAFE",
            "Managed providers over SSH are disabled because the current transport would expose credentials in the local process arguments",
            cli_tool,
            plan.provider.as_ref().map(|provider| provider.id.as_str()),
        ));
    }
    Ok(())
}

fn provider_has_managed_configuration(provider: &Provider) -> bool {
    super::ProviderService::managed_configuration_is_usable(provider)
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
    if !provider_has_managed_configuration(selected) {
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
            is_default: false,
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
            },
            ProviderModel {
                id: "profile-model".to_string(),
                label: Some("Profile Model".to_string()),
                default_effort: Some("low".to_string()),
                context_window_tokens: None,
            },
            ProviderModel {
                id: "request-model".to_string(),
                label: Some("Request Model".to_string()),
                default_effort: Some("xhigh".to_string()),
                context_window_tokens: None,
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
        assert!(!managed_provider_conflict_env_keys(CliTool::Codex)
            .contains(&"CLAUDE_CODE_USE_BEDROCK"));
        assert!(managed_provider_conflict_env_keys(CliTool::Codex).contains(&"OPENAI_BASE_URL"));
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
    fn all_builtin_adapters_resolve_paired_managed_and_native_modes() {
        let cases = [
            (CliTool::Claude, ProviderType::Anthropic),
            (CliTool::Codex, ProviderType::OpenAI),
            (CliTool::Gemini, ProviderType::Gemini),
            (CliTool::Kimi, ProviderType::Kimi),
            (CliTool::Glm, ProviderType::Glm),
            (CliTool::Opencode, ProviderType::OpenCode),
            (CliTool::Cursor, ProviderType::Cursor),
            (CliTool::Grok, ProviderType::Grok),
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
            assert!(!managed.provider.unwrap().to_env_vars().is_empty());

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
    fn ssh_managed_is_blocked_without_argv_safe_transport_but_native_is_allowed() {
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
        let error =
            validate_provider_runtime(&managed, LaunchRuntime::Ssh, CliTool::Claude).unwrap_err();
        assert_eq!(error.code(), Some("PROVIDER_SSH_MANAGED_UNSAFE"));
        assert!(!error.to_string().contains("test-secret"));
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
    }
}
