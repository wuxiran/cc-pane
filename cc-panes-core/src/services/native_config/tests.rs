use super::*;
use crate::models::provider::{Provider, ProviderModel, ProviderType};
use serde_json::json;

fn by_key(merged: &MergedNativeConfig) -> BTreeMap<String, (String, NativeConfigSource)> {
    merged
        .entries()
        .into_iter()
        .map(|entry| (entry.key, (entry.value, entry.source)))
        .collect()
}

fn openai_provider(fragment: Option<&str>) -> Provider {
    let mut provider = Provider {
        id: "relay".into(),
        name: "Relay".into(),
        provider_type: ProviderType::OpenAI,
        models: vec![ProviderModel {
            id: "gpt-5.5".into(),
            context_window_tokens: Some(400_000),
            default_effort: Some("high".into()),
            ..ProviderModel::default()
        }],
        default_model_id: Some("gpt-5.5".into()),
        ..Provider::default()
    };
    if let Some(fragment) = fragment {
        provider
            .native_overrides
            .insert("codex".into(), fragment.into());
    }
    provider
}

#[test]
fn deep_merges_provider_then_profile_with_sources() {
    let merged = merge_native_config(
        "codex",
        Some("disable_response_storage = true\n[tui]\nanimations = false\nnotifications = true\n"),
        Some("service_tier = \"fast\"\n[tui]\nanimations = true\n"),
        &ManagedNativeFields::default(),
    );
    assert!(merged.issues.is_empty());
    let entries = by_key(&merged);
    assert_eq!(
        entries["disable_response_storage"],
        ("true".into(), NativeConfigSource::Provider)
    );
    assert_eq!(
        entries["tui.animations"],
        ("true".into(), NativeConfigSource::Profile)
    );
    assert_eq!(
        entries["tui.notifications"],
        ("true".into(), NativeConfigSource::Provider)
    );
    assert_eq!(
        entries["service_tier"],
        ("\"fast\"".into(), NativeConfigSource::Profile)
    );
}

#[test]
fn explicit_fields_win_and_are_not_emitted_twice() {
    let managed = ManagedNativeFields {
        model_id: Some("gpt-5.5".into()),
        effort: Some("max".into()),
        yolo: true,
        ..ManagedNativeFields::default()
    };
    let merged = merge_native_config(
        "codex",
        None,
        Some("model = \"other\"\nmodel_reasoning_effort = \"low\"\napproval_policy = \"on-request\"\nsandbox_mode = \"read-only\"\nplan_mode_reasoning_effort = \"high\"\n"),
        &managed,
    );
    let entries = by_key(&merged);
    assert_eq!(
        entries["model"],
        ("\"gpt-5.5\"".into(), NativeConfigSource::Managed)
    );
    assert_eq!(
        entries["model_reasoning_effort"],
        ("\"xhigh\"".into(), NativeConfigSource::Managed)
    );
    assert_eq!(entries["approval_policy"].1, NativeConfigSource::Managed);
    assert_eq!(entries["sandbox_mode"].1, NativeConfigSource::Managed);
    assert_eq!(
        merged.codex_config_args(),
        vec!["plan_mode_reasoning_effort=\"high\"".to_string()]
    );
}

#[test]
fn unset_explicit_fields_leave_fragment_values_in_place() {
    let merged = merge_native_config(
        "codex",
        None,
        Some("model = \"from-profile\"\napproval_policy = \"never\"\n"),
        &ManagedNativeFields::default(),
    );
    assert_eq!(
        merged.codex_config_args(),
        vec![
            "approval_policy=\"never\"".to_string(),
            "model=\"from-profile\"".to_string()
        ]
    );
}

#[test]
fn context_window_is_a_base_layer_that_fragments_override() {
    let managed = ManagedNativeFields {
        context_window_tokens: Some(400_000),
        ..ManagedNativeFields::default()
    };
    let merged = merge_native_config("codex", None, None, &managed);
    assert_eq!(
        merged.codex_config_args(),
        vec!["model_context_window=400000"]
    );
    assert_eq!(
        by_key(&merged)["model_context_window"].1,
        NativeConfigSource::Provider
    );

    let merged = merge_native_config(
        "codex",
        None,
        Some("model_context_window = 1000000"),
        &managed,
    );
    assert_eq!(
        merged.codex_config_args(),
        vec!["model_context_window=1000000"]
    );
    assert_eq!(
        by_key(&merged)["model_context_window"].1,
        NativeConfigSource::Profile
    );
}

#[test]
fn type_change_replaces_whole_subtree() {
    let merged = merge_native_config(
        "codex",
        Some("[features]\nweb_search = true\nshell = false\n"),
        Some("features = []\n"),
        &ManagedNativeFields::default(),
    );
    assert_eq!(merged.codex_config_args(), vec!["features=[]"]);
    let merged = merge_native_config(
        "codex",
        Some("features = 3\n"),
        Some("[features]\nweb_search = true\n"),
        &ManagedNativeFields::default(),
    );
    assert_eq!(merged.codex_config_args(), vec!["features.web_search=true"]);
}

#[test]
fn codex_args_quote_keys_and_render_toml_literals() {
    let merged = merge_native_config(
        "codex",
        None,
        Some(
            "notify = [\"say\", \"done \\\"x\\\"\"]\nratio = 1.5\nempty = {}\n[profiles.\"gpt 5\"]\nmodel = \"x\"\n[[skills.config]]\npath = \"/a\"\n",
        ),
        &ManagedNativeFields::default(),
    );
    let args = merged.codex_config_args();
    assert!(args.contains(&"empty={}".to_string()), "{args:?}");
    assert!(
        args.contains(&"notify=[\"say\", 'done \"x\"']".to_string())
            || args.contains(&"notify=[\"say\", \"done \\\"x\\\"\"]".to_string()),
        "{args:?}"
    );
    assert!(
        args.contains(&"profiles.\"gpt 5\".model=\"x\"".to_string()),
        "{args:?}"
    );
    assert!(args.contains(&"ratio=1.5".to_string()), "{args:?}");
    // 数组整体作为一个值传入（含其中的内联表）
    let skills = args
        .iter()
        .find(|arg| arg.starts_with("skills.config="))
        .unwrap();
    assert!(skills.contains("path = \"/a\""), "{skills}");
    // 每个值都能被 TOML 解析回来
    for arg in &args {
        let (_, value) = arg.split_once('=').unwrap();
        format!("v = {value}").parse::<toml::Table>().unwrap();
    }
}

#[test]
fn codex_validation_rejects_managed_and_secret_keys() {
    let issues = validate_fragment(
        "codex",
        "model_provider = \"x\"\n[model_providers.x]\nbase_url = \"u\"\n[mcp_servers.a]\ncommand = \"a\"\n[hooks]\n[projects.\"/tmp\"]\ntrust_level = \"trusted\"\n[tools]\napi_key = \"sk\"\n",
    );
    let keys: Vec<_> = issues
        .iter()
        .filter_map(|issue| issue.key.clone())
        .collect();
    for key in [
        "model_provider",
        "model_providers",
        "mcp_servers",
        "hooks",
        "projects",
        "tools.api_key",
    ] {
        assert!(keys.contains(&key.to_string()), "missing {key}: {keys:?}");
    }
    assert!(issues
        .iter()
        .any(|issue| issue.code == NativeConfigIssueCode::SecretKey));
    // 被拒的键不会进入合并结果，其余照常生效
    let merged = merge_native_config(
        "codex",
        None,
        Some("model_provider = \"x\"\nservice_tier = \"fast\"\n"),
        &ManagedNativeFields::default(),
    );
    assert_eq!(merged.codex_config_args(), vec!["service_tier=\"fast\""]);
    assert_eq!(merged.issues.len(), 1);
    assert_eq!(merged.issues[0].layer, Some(NativeConfigSource::Profile));
}

#[test]
fn parse_errors_never_echo_fragment_content() {
    let issues = validate_fragment("codex", "token_holder = \"sk-very-secret\n");
    assert_eq!(issues.len(), 1);
    assert_eq!(issues[0].code, NativeConfigIssueCode::ParseError);
    assert!(
        !issues[0].message.contains("sk-very-secret"),
        "{}",
        issues[0].message
    );
    assert!(issues[0].message.contains("line 1"));

    let issues = validate_fragment("claude", "{\"x\": \"sk-very-secret\"");
    assert_eq!(issues[0].code, NativeConfigIssueCode::ParseError);
    assert!(!issues[0].message.contains("sk-very-secret"));

    let issues = validate_fragment("claude", "[1, 2]");
    assert_eq!(issues[0].code, NativeConfigIssueCode::NotAnObject);
    // 解析失败：整层不生效
    let merged = merge_native_config(
        "codex",
        Some("= broken"),
        None,
        &ManagedNativeFields::default(),
    );
    assert!(merged.leaves.is_empty());
    assert_eq!(merged.issues[0].layer, Some(NativeConfigSource::Provider));
}

#[test]
fn claude_validation_rejects_routing_env_and_secrets() {
    let issues = validate_fragment(
        "claude",
        r#"{"env":{"ANTHROPIC_BASE_URL":"x","ANTHROPIC_AUTH_TOKEN":"y","CLAUDE_CODE_MAX_OUTPUT_TOKENS":"8000","MY_SECRET":"z"},"apiKeyHelper":"/bin/k","permissions":{"allow":["Bash"]}}"#,
    );
    let keys: Vec<_> = issues
        .iter()
        .filter_map(|issue| issue.key.clone())
        .collect();
    assert!(keys.contains(&"env.ANTHROPIC_BASE_URL".to_string()));
    assert!(keys.contains(&"env.ANTHROPIC_AUTH_TOKEN".to_string()));
    assert!(keys.contains(&"env.MY_SECRET".to_string()));
    assert_eq!(keys.len(), 3, "{keys:?}");
}

#[test]
fn secret_name_heuristic() {
    for name in [
        "api_key",
        "apiKey",
        "OPENAI_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "experimental_bearer_token",
        "client_secret_path",
        "password",
        "credentials",
        "APIKEY",
    ] {
        assert!(looks_like_secret(name), "{name}");
    }
    for name in [
        "model_auto_compact_token_limit",
        "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
        "bearer_token_env_var",
        "apiKeyHelper",
        "keyboard",
        "model",
        "max_tokens",
    ] {
        assert!(!looks_like_secret(name), "{name}");
    }
}

#[test]
fn claude_overlay_unflattens_and_skips_managed_keys() {
    let managed = ManagedNativeFields {
        model_id: Some("claude-opus".into()),
        effort: Some("high".into()),
        yolo: true,
        ..ManagedNativeFields::default()
    };
    let merged = merge_native_config(
        "claude",
        Some(r#"{"alwaysThinkingEnabled":true,"env":{"DISABLE_TELEMETRY":"1"}}"#),
        Some(
            r#"{"model":"x","permissions":{"defaultMode":"plan","allow":["Bash(ls)"]},"env":{"MAX_THINKING_TOKENS":"1"}}"#,
        ),
        &managed,
    );
    assert!(merged.issues.is_empty(), "{:?}", merged.issues);
    assert_eq!(
        Value::Object(merged.claude_settings_overlay()),
        json!({
            "alwaysThinkingEnabled": true,
            "env": {"DISABLE_TELEMETRY": "1"},
            "permissions": {"allow": ["Bash(ls)"]}
        })
    );
    let entries = by_key(&merged);
    assert_eq!(
        entries["permissions.defaultMode"].1,
        NativeConfigSource::Managed
    );
    assert_eq!(
        entries["env.MAX_THINKING_TOKENS"].1,
        NativeConfigSource::Managed
    );
    assert_eq!(
        entries["model"],
        ("\"claude-opus\"".into(), NativeConfigSource::Managed)
    );
}

#[test]
fn normalize_overrides_strips_blank_and_rejects_bad_keys() {
    let ok = normalize_overrides(Some(BTreeMap::from([
        ("codex".to_string(), "service_tier = \"fast\"".to_string()),
        ("claude".to_string(), "  \n".to_string()),
    ])))
    .unwrap();
    assert_eq!(ok.len(), 1);
    assert!(ok.contains_key("codex"));

    let error = normalize_overrides(Some(BTreeMap::from([(
        "codex".to_string(),
        "[mcp_servers.x]\ncommand = \"y\"".to_string(),
    )])))
    .unwrap_err();
    assert!(error.to_string().contains("mcp_servers"), "{error}");

    let error = normalize_overrides(Some(BTreeMap::from([(
        "gemini".to_string(),
        "{}".to_string(),
    )])))
    .unwrap_err();
    assert!(error.to_string().contains("gemini"));
}

#[test]
fn claude_context_size_prefers_explicit_then_one_million_window() {
    let mut provider = Provider {
        models: vec![
            ProviderModel {
                id: "big".into(),
                context_window_tokens: Some(1_000_000),
                ..ProviderModel::default()
            },
            ProviderModel {
                id: "small".into(),
                context_window_tokens: Some(200_000),
                ..ProviderModel::default()
            },
        ],
        ..Provider::default()
    };
    assert_eq!(
        claude_context_size(Some(&provider), Some("big")).as_deref(),
        Some("1m")
    );
    assert_eq!(claude_context_size(Some(&provider), Some("small")), None);
    assert_eq!(claude_context_size(Some(&provider), Some("missing")), None);
    provider.models[1].context_size = Some("500k".into());
    assert_eq!(
        claude_context_size(Some(&provider), Some("small")).as_deref(),
        Some("500k")
    );
}

#[test]
fn apply_to_adapter_options_sets_codex_args_and_claude_context() {
    let provider = openai_provider(Some("disable_response_storage = true"));
    let mut profile_overrides = BTreeMap::new();
    profile_overrides.insert("codex".to_string(), "service_tier = \"fast\"".to_string());
    let profile = crate::models::LaunchProfile {
        id: "p".into(),
        name: "P".into(),
        alias: None,
        description: None,
        provider_id: Some("relay".into()),
        provider_account_id: None,
        model_id: None,
        adapter_options: HashMap::new(),
        target_tools: vec!["codex".into()],
        target_runtime: None,
        yolo_mode: false,
        mcp_policy: Default::default(),
        skill_policy: Default::default(),
        native_overrides: profile_overrides,
        is_default: false,
        created_at: String::new(),
        updated_at: String::new(),
    };
    let mut options = HashMap::new();
    apply_to_adapter_options(
        &mut options,
        "codex",
        Some(&provider),
        Some(&profile),
        Some("gpt-5.5"),
        false,
    );
    let args = cc_cli_adapters::native_codex_config_args(&options);
    assert_eq!(
        args,
        vec![
            "-c",
            "disable_response_storage=true",
            "-c",
            "model_context_window=400000",
            "-c",
            "service_tier=\"fast\"",
        ]
    );

    let mut claude_provider = provider.clone();
    claude_provider.models[0].context_window_tokens = Some(1_000_000);
    let mut options = HashMap::new();
    apply_to_adapter_options(
        &mut options,
        "claude",
        Some(&claude_provider),
        None,
        Some("gpt-5.5"),
        false,
    );
    assert_eq!(options.get("__ccpanesContextSize"), Some(&json!("1m")));
    assert!(!options.contains_key(cc_cli_adapters::NATIVE_CLAUDE_SETTINGS_OPTION));
}

#[test]
fn preview_resolves_provider_model_effort_and_runtimes() {
    let provider = openai_provider(Some("disable_response_storage = true"));
    let draft = LaunchProfileDraft {
        name: Some("P".into()),
        alias: None,
        description: None,
        provider_id: None,
        provider_account_id: None,
        model_id: None,
        adapter_options: HashMap::new(),
        target_tools: vec!["codex".into()],
        target_runtime: None,
        yolo_mode: true,
        mcp_policy: Default::default(),
        skill_policy: Default::default(),
        native_overrides: Some(BTreeMap::from([(
            "codex".to_string(),
            "approval_policy = \"on-request\"\nmodel_providers = 1".to_string(),
        )])),
        is_default: false,
    };
    let preview = preview_native_config(&draft, "codex", &[provider], Some("relay"));
    assert!(preview.supported);
    assert_eq!(preview.provider_name.as_deref(), Some("Relay"));
    assert_eq!(preview.model_id.as_deref(), Some("gpt-5.5"));
    let entries: BTreeMap<_, _> = preview
        .entries
        .iter()
        .map(|entry| (entry.key.as_str(), (entry.value.as_str(), entry.source)))
        .collect();
    assert_eq!(
        entries["model_reasoning_effort"],
        ("\"high\"", NativeConfigSource::Managed)
    );
    assert_eq!(
        entries["approval_policy"],
        ("\"never\"", NativeConfigSource::Managed)
    );
    assert_eq!(
        entries["model_provider"],
        ("\"ccpanes_relay\"", NativeConfigSource::Managed)
    );
    assert_eq!(
        entries["model_context_window"].1,
        NativeConfigSource::Provider
    );
    assert_eq!(
        entries["disable_response_storage"].1,
        NativeConfigSource::Provider
    );
    assert_eq!(preview.issues.len(), 1);
    assert_eq!(preview.runtimes.len(), 3);
    assert!(preview.runtimes.iter().all(|runtime| runtime.applied));

    let claude = preview_native_config(&draft, "claude", &[], None);
    assert!(claude
        .runtimes
        .iter()
        .any(|runtime| runtime.runtime == "wsl" && !runtime.applied));
    let other = preview_native_config(&draft, "gemini", &[], None);
    assert!(!other.supported);
}

#[test]
fn old_files_without_native_overrides_still_load() {
    let provider: Provider =
        serde_json::from_value(json!({"id":"a","name":"A","providerType":"open_ai"})).unwrap();
    assert!(provider.native_overrides.is_empty());
    let serialized = serde_json::to_value(&provider).unwrap();
    assert!(serialized.get("nativeOverrides").is_none());
}
