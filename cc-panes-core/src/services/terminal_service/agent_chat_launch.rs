//! Agent Chat（ACP / Codex App Server）的运行配置注入。
//!
//! Agent Chat 不走 PTY，也不调适配器的 `build_command`——那条路有终端会话专属的
//! 副作用（写 `--settings` 文件、预写 trust、链接技能、MCP 配置文件……）。这里只复用
//! 与终端启动**同一套解析规则**：
//!
//! 运行配置 → `resolve_provider_plan`（供应商 / 账号 / 模型）→
//! `ProviderService::resolve_launch_env`（密钥、地址、登录目录）→
//! `native_config::apply_to_adapter_options`（中转站片段 ← 运行配置片段）。
//!
//! 产物是一份「环境变量 + Codex `-c` 覆盖」叠加层，由 src-tauri 的 ACP 启动层按引擎注入。
//! 密钥只进子进程环境，不进参数、不进日志（`Debug` 只打变量名）。

use super::*;

/// 运行配置解析出的 Agent Chat 启动叠加层。
#[derive(Clone, Default)]
pub struct AgentChatLaunchOverlay {
    pub profile_id: String,
    pub profile_name: String,
    /// 注入子进程的环境变量（按顺序应用，后者覆盖前者）。可能含密钥。
    pub env: Vec<(String, String)>,
    /// 先从继承环境里删掉的变量（托管供应商清掉 app 环境里的冲突凭证）。
    pub env_remove: Vec<String>,
    /// Codex：`key=value`（值为 TOML 字面量），每条对应一个 `-c`。从不含密钥。
    pub codex_config: Vec<String>,
    /// 没能带进 Agent Chat 的配置项（只记名字，供日志 / 界面说明）。
    pub skipped: Vec<String>,
}

impl std::fmt::Debug for AgentChatLaunchOverlay {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AgentChatLaunchOverlay")
            .field("profile_id", &self.profile_id)
            .field(
                "env",
                &self.env.iter().map(|(key, _)| key).collect::<Vec<_>>(),
            )
            .field("env_remove", &self.env_remove)
            .field("codex_config_count", &self.codex_config.len())
            .field("skipped", &self.skipped)
            .finish()
    }
}

/// Claude 托管供应商时要把模型写进的环境变量（与 claude 适配器 `MODEL_ENV_KEYS` 同口径）。
const CLAUDE_MODEL_ENV_KEYS: &[&str] = &[
    "ANTHROPIC_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "CLAUDE_CODE_SUBAGENT_MODEL",
];

impl TerminalService {
    /// 按运行配置解析 Agent Chat 的启动叠加层（只支持本机 Codex / Claude）。
    ///
    /// 与终端启动的差异是刻意的：不继承工作空间的供应商（Agent Chat 选「系统默认」时
    /// 保持 CLI 自己的登录与配置，选了运行配置才托管）；YOLO 不参与（权限由聊天界面管）。
    pub fn build_agent_chat_launch_overlay(
        &self,
        cli_tool: CliTool,
        launch_profile_id: &str,
    ) -> AppResult<AgentChatLaunchOverlay> {
        if !matches!(cli_tool, CliTool::Codex | CliTool::Claude) {
            return Err(AppError::coded(
                "ACP_PROFILE_UNSUPPORTED",
                format!(
                    "Launch profiles are not supported for '{}' in Agent Chat",
                    cli_tool.as_id()
                ),
            ));
        }
        let id = launch_profile_id.trim();
        let profile_service = self.launch_profile_service.read().clone().ok_or_else(|| {
            AppError::coded(
                "ACP_PROFILE_UNAVAILABLE",
                "Launch profiles are not available yet",
            )
        })?;
        let profile = profile_service.get_profile(id).ok_or_else(|| {
            AppError::coded_with_params(
                "ACP_PROFILE_NOT_FOUND",
                format!("Launch profile '{id}' was not found"),
                HashMap::from([("profileId".to_string(), id.to_string())]),
            )
        })?;
        if profile_service.selected_profile_compatibility(id, Some(cli_tool.as_id()), None)
            != Some(true)
        {
            return Err(AppError::coded_with_params(
                "ACP_PROFILE_INCOMPATIBLE",
                format!(
                    "Launch profile '{}' does not target '{}'",
                    profile.name,
                    cli_tool.as_id()
                ),
                HashMap::from([
                    ("profileId".to_string(), id.to_string()),
                    ("cliTool".to_string(), cli_tool.as_id().to_string()),
                ]),
            ));
        }
        self.overlay_for_profile(cli_tool, &profile)
    }

    fn overlay_for_profile(
        &self,
        cli_tool: CliTool,
        profile: &LaunchProfile,
    ) -> AppResult<AgentChatLaunchOverlay> {
        let mut adapter_options = profile.adapter_options.clone();
        let default_provider_id = self
            .provider_service
            .get_default_provider_id(cli_tool.as_id());
        let providers = self.provider_service.list_providers();
        let plan = resolve_provider_plan(
            ProviderResolutionInput {
                cli_tool,
                selection: LaunchProviderSelection::Inherit,
                requested_provider_id: None,
                requested_model_id: None,
                profile_provider_id: profile.provider_id.as_deref(),
                profile_model_id: profile.model_id.as_deref(),
                workspace_provider_id: None,
                requested_account_id: None,
                profile_account_id: profile.provider_account_id.as_deref(),
                workspace_account_id: None,
                default_provider_id: default_provider_id.as_deref(),
                adapter_options: Some(&adapter_options),
            },
            &providers,
            &self.cli_registry,
        )?;
        plan.apply_model_adapter_defaults(&mut adapter_options);
        validate_provider_runtime(&plan, LaunchRuntime::Local, cli_tool)?;
        crate::services::relay_gateway_probe::ensure_relay_gateway_reachable(
            &plan,
            LaunchRuntime::Local,
        )?;
        let launch_env = self
            .resolve_provider_launch_env(&plan, cli_tool)
            .map_err(AppError::from)?;
        crate::services::native_config::apply_to_adapter_options(
            &mut adapter_options,
            cli_tool.as_id(),
            plan.provider.as_ref(),
            Some(profile),
            plan.model_id.as_deref(),
            false,
        );

        let mut overlay = AgentChatLaunchOverlay {
            profile_id: profile.id.clone(),
            profile_name: profile.name.clone(),
            ..Default::default()
        };
        if plan.mode == ProviderMode::Managed {
            overlay.env_remove = managed_provider_conflict_env_keys(cli_tool)
                .iter()
                .map(|key| (*key).to_string())
                .collect();
        }
        let mut generated: Vec<(String, String)> = launch_env.env_map().into_iter().collect();
        generated.sort();
        overlay.env.extend(generated);
        match cli_tool {
            CliTool::Codex => codex_overlay(&mut overlay, &plan, &launch_env, &adapter_options),
            _ => claude_overlay(&mut overlay, &plan, &adapter_options),
        }
        // 用户在供应商 / 账号上填的变量最后应用：优先于自动生成的（与终端同口径）。
        let mut custom: Vec<(String, String)> = launch_env.custom_env_map().into_iter().collect();
        custom.sort();
        overlay.env.extend(custom);
        info!(
            cli_tool = cli_tool.as_id(),
            profile_id = %overlay.profile_id,
            mode = ?plan.mode,
            overlay = ?overlay,
            "resolved agent chat launch profile"
        );
        Ok(overlay)
    }
}

fn codex_overlay(
    overlay: &mut AgentChatLaunchOverlay,
    plan: &ResolvedProviderPlan,
    launch_env: &ProviderLaunchEnv,
    adapter_options: &HashMap<String, serde_json::Value>,
) {
    let provider = plan
        .provider
        .clone()
        .map(|provider| to_cli_provider(provider, launch_env));
    let mut args = Vec::new();
    let mut env_inject = HashMap::new();
    cc_cli_adapters::CodexAdapter::push_provider_overrides(
        &mut args,
        &mut env_inject,
        provider.as_ref(),
    );
    args.extend(cc_cli_adapters::native_codex_config_args(adapter_options));
    overlay.codex_config.extend(config_values(&args));
    if let Some(model) = plan.model_id.as_deref().filter(|model| !model.is_empty()) {
        overlay
            .codex_config
            .push(format!("model={}", toml_string(model)));
    }
    if let Some(effort) = cc_cli_adapters::effort_from_options(adapter_options)
        .and_then(|effort| cc_cli_adapters::codex_reasoning_effort(&effort))
    {
        // 带引号：同一份覆盖还要转成 codex-acp 的 CODEX_CONFIG JSON，裸字面量不是合法 TOML。
        overlay
            .codex_config
            .push(format!("model_reasoning_effort={}", toml_string(effort)));
    }
    let mut injected: Vec<(String, String)> = env_inject.into_iter().collect();
    injected.sort();
    overlay.env.extend(injected);
}

fn claude_overlay(
    overlay: &mut AgentChatLaunchOverlay,
    plan: &ResolvedProviderPlan,
    adapter_options: &HashMap<String, serde_json::Value>,
) {
    // 原生 Claude 片段：只有 `env` 段能经进程环境带进 claude-agent-acp（它不收 `--settings`）；
    // 其余键记进 skipped，界面据此说明。生成的路由变量在后面覆盖它（与适配器同口径）。
    if let Some(settings) = adapter_options
        .get(cc_cli_adapters::NATIVE_CLAUDE_SETTINGS_OPTION)
        .and_then(serde_json::Value::as_object)
    {
        for (key, value) in settings {
            if key == "env" {
                if let Some(env) = value.as_object() {
                    let base: Vec<(String, String)> = env
                        .iter()
                        .filter_map(|(name, value)| {
                            value
                                .as_str()
                                .map(|value| (name.clone(), value.to_string()))
                        })
                        .collect();
                    overlay.env.splice(0..0, base);
                }
            } else {
                overlay.skipped.push(format!("claudeSettings.{key}"));
            }
        }
    }
    if plan.mode == ProviderMode::Managed {
        if let Some(model) = plan.model_id.as_deref().filter(|model| !model.is_empty()) {
            let model = match adapter_options
                .get("__ccpanesContextSize")
                .and_then(serde_json::Value::as_str)
            {
                Some(size) => cc_cli_adapters::context_size::apply_context_size_suffix(model, size),
                None => model.to_string(),
            };
            for key in CLAUDE_MODEL_ENV_KEYS {
                overlay.env.push(((*key).to_string(), model.clone()));
            }
        }
    }
    if let Some(tokens) = cc_cli_adapters::effort_from_options(adapter_options)
        .and_then(|effort| cc_cli_adapters::claude_max_thinking_tokens(&effort))
    {
        overlay
            .env
            .push(("MAX_THINKING_TOKENS".to_string(), tokens.to_string()));
    }
}

/// `["-c", "k=v", ...]` → `["k=v", ...]`。
fn config_values(args: &[String]) -> Vec<String> {
    args.chunks(2)
        .filter(|pair| pair.len() == 2 && pair[0] == "-c")
        .map(|pair| pair[1].clone())
        .collect()
}

fn toml_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

/// 把 `key=value`（TOML 字面量）覆盖列表转成嵌套 JSON 对象——codex-acp 经 `CODEX_CONFIG`
/// 收配置（它不认 `-c`）。点分键按 TOML 语义拆层；解析失败的条目跳过并返回其键名。
pub fn codex_config_overrides_to_json(
    overrides: &[String],
) -> (serde_json::Map<String, serde_json::Value>, Vec<String>) {
    let mut root = serde_json::Map::new();
    let mut rejected = Vec::new();
    for entry in overrides {
        let parsed = toml::from_str::<toml::Table>(entry)
            .ok()
            .and_then(|table| serde_json::to_value(table).ok());
        match parsed {
            Some(serde_json::Value::Object(map)) => deep_merge(&mut root, map),
            _ => rejected.push(entry.split('=').next().unwrap_or_default().to_string()),
        }
    }
    (root, rejected)
}

fn deep_merge(
    target: &mut serde_json::Map<String, serde_json::Value>,
    source: serde_json::Map<String, serde_json::Value>,
) {
    for (key, value) in source {
        match (target.get_mut(&key), value) {
            (Some(serde_json::Value::Object(existing)), serde_json::Value::Object(incoming)) => {
                deep_merge(existing, incoming)
            }
            (_, value) => {
                target.insert(key, value);
            }
        }
    }
}

#[cfg(test)]
mod agent_chat_launch_tests {
    use super::*;

    #[test]
    fn codex_overrides_become_nested_json() {
        let (json, rejected) = codex_config_overrides_to_json(&[
            "model_provider=\"ccpanes_relay\"".to_string(),
            "model_providers.ccpanes_relay.base_url=\"https://relay.example/v1\"".to_string(),
            "model_providers.ccpanes_relay.env_key=\"CCPANES_CODEX_API_KEY\"".to_string(),
            "model_reasoning_effort=\"high\"".to_string(),
            "model_context_window=400000".to_string(),
            "not valid toml".to_string(),
        ]);
        assert_eq!(json["model_provider"], "ccpanes_relay");
        assert_eq!(
            json["model_providers"]["ccpanes_relay"]["base_url"],
            "https://relay.example/v1"
        );
        assert_eq!(
            json["model_providers"]["ccpanes_relay"]["env_key"],
            "CCPANES_CODEX_API_KEY"
        );
        assert_eq!(json["model_reasoning_effort"], "high");
        assert_eq!(json["model_context_window"], 400000);
        assert_eq!(rejected, vec!["not valid toml".to_string()]);
    }

    #[test]
    fn overlay_debug_never_prints_values() {
        let overlay = AgentChatLaunchOverlay {
            env: vec![("CODEX_API_KEY".into(), "sk-secret-value".into())],
            ..Default::default()
        };
        let printed = format!("{overlay:?}");
        assert!(printed.contains("CODEX_API_KEY"));
        assert!(!printed.contains("sk-secret-value"));
    }

    #[test]
    fn config_values_keep_only_dash_c_pairs() {
        let args = vec![
            "-c".to_string(),
            "a=1".to_string(),
            "--model".to_string(),
            "x".to_string(),
            "-c".to_string(),
            "b=\"2\"".to_string(),
        ];
        assert_eq!(config_values(&args), vec!["a=1", "b=\"2\""]);
    }
}
