//! 从 cc-switch SQLite 抄一份供应商到 CC-Panes。单向、不去同步。

use crate::models::provider::{Provider, ProviderModel, ProviderType};
use anyhow::{Context, Result};
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};

const CC_SWITCH_DB_REL: [&str; 2] = [".cc-switch", "cc-switch.db"];

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CcSwitchImportReport {
    pub imported: usize,
    pub skipped_duplicate: usize,
    pub skipped_empty: usize,
    pub skipped_unsupported: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CcSwitchImportCandidate {
    pub name: String,
    pub provider_type: ProviderType,
    pub api_key: Option<String>,
    pub base_url: Option<String>,
    pub default_model_id: Option<String>,
    pub codex_wire_api: Option<String>,
}

#[derive(Debug, Default)]
pub struct CcSwitchImportBatch {
    pub candidates: Vec<CcSwitchImportCandidate>,
    pub skipped_empty: usize,
    pub skipped_unsupported: usize,
}

pub fn cc_switch_db_path() -> Option<PathBuf> {
    dirs::home_dir().map(|home| {
        let mut path = home;
        for part in CC_SWITCH_DB_REL {
            path.push(part);
        }
        path
    })
}

pub fn load_cc_switch_providers(db_path: &Path) -> Result<CcSwitchImportBatch> {
    let conn = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .with_context(|| format!("failed to open {}", db_path.display()))?;
    let mut stmt = conn
        .prepare("SELECT app_type, name, settings_config FROM providers")
        .context("cc-switch providers table is missing")?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .context("failed to query cc-switch providers")?;

    let mut out = CcSwitchImportBatch::default();
    for row in rows {
        let (app_type, name, settings_raw) =
            row.context("failed to read cc-switch provider row")?;
        if provider_type_for_app(&app_type).is_none() {
            out.skipped_unsupported += 1;
            continue;
        }
        // Do not echo source configuration in errors: it can contain credentials.
        let settings: Value = serde_json::from_str(&settings_raw)
            .map_err(|_| anyhow::anyhow!("cc-switch provider configuration is not valid JSON"))?;
        if !supported_settings(&app_type, &settings) {
            out.skipped_unsupported += 1;
            continue;
        }
        if app_type.trim().eq_ignore_ascii_case("codex") {
            if let Some(config) = settings.get("config").and_then(Value::as_str) {
                config.parse::<toml::Value>().map_err(|_| {
                    anyhow::anyhow!("cc-switch Codex configuration is not valid TOML")
                })?;
            }
        }
        if let Some(candidate) = map_cc_switch_row(&app_type, &name, &settings) {
            out.candidates.push(candidate);
        } else {
            out.skipped_empty += 1;
        }
    }
    Ok(out)
}

pub fn map_cc_switch_row(
    app_type: &str,
    name: &str,
    settings: &Value,
) -> Option<CcSwitchImportCandidate> {
    if !supported_settings(app_type, settings) {
        return None;
    }
    let provider_type = provider_type_for_app(app_type)?;
    let name = name.trim();
    if name.is_empty() {
        return None;
    }
    let mut api_key = first_nonempty(settings, key_names(provider_type));
    let mut base_url = first_nonempty(settings, url_names(provider_type));
    let mut default_model_id =
        first_nonempty(settings, &["ANTHROPIC_MODEL", "OPENAI_MODEL", "model"]);
    let mut codex_wire_api = None;
    if provider_type == ProviderType::OpenAI {
        if let Some(config) = settings.get("config").and_then(Value::as_str) {
            let config = config.parse::<toml::Value>().ok()?;
            let provider = selected_codex_provider(&config)?;
            base_url = base_url.or_else(|| toml_string(provider, "base_url"));
            api_key = api_key.or_else(|| toml_string(provider, "experimental_bearer_token"));
            default_model_id = default_model_id.or_else(|| toml_string(&config, "model"));
            codex_wire_api = toml_string(provider, "wire_api");
        }
    }
    if provider_type == ProviderType::OpenCode {
        if let Some(options) = settings.get("options") {
            api_key = api_key.or_else(|| first_nonempty(options, &["apiKey"]));
            base_url = base_url.or_else(|| first_nonempty(options, &["baseURL"]));
        }
    }
    if api_key.is_none() && base_url.is_none() {
        return None;
    }
    Some(CcSwitchImportCandidate {
        name: name.to_string(),
        provider_type,
        api_key,
        base_url,
        default_model_id,
        codex_wire_api,
    })
}

pub fn candidate_to_provider(candidate: &CcSwitchImportCandidate) -> Provider {
    let models = candidate
        .default_model_id
        .as_deref()
        .map(|id| {
            vec![ProviderModel {
                id: id.to_string(),
                label: None,
                default_effort: None,
                context_window_tokens: None,
                context_size: None,
            }]
        })
        .unwrap_or_default();
    Provider {
        id: copied_provider_id(candidate),
        name: candidate.name.clone(),
        provider_type: candidate.provider_type,
        api_key: candidate.api_key.clone(),
        base_url: candidate.base_url.clone(),
        region: None,
        project_id: None,
        aws_profile: None,
        config_dir: None,
        models,
        default_model_id: candidate.default_model_id.clone(),
        codex_wire_api: candidate.codex_wire_api.clone(),
        is_default: false,
    }
}

fn provider_type_for_app(app_type: &str) -> Option<ProviderType> {
    Some(match app_type.trim().to_ascii_lowercase().as_str() {
        "claude" => ProviderType::Anthropic,
        "codex" => ProviderType::OpenAI,
        "gemini" => ProviderType::Gemini,
        "opencode" => ProviderType::OpenCode,
        _ => return None,
    })
}

fn supported_settings(app_type: &str, settings: &Value) -> bool {
    // CC-Panes' OpenCode provider currently injects OpenAI-compatible options.
    // Do not silently reinterpret Anthropic/Bedrock/Google credentials as OpenAI.
    !app_type.trim().eq_ignore_ascii_case("opencode")
        || settings
            .get("npm")
            .and_then(Value::as_str)
            .is_none_or(|npm| matches!(npm, "@ai-sdk/openai" | "@ai-sdk/openai-compatible"))
}

fn key_names(provider_type: ProviderType) -> &'static [&'static str] {
    match provider_type {
        ProviderType::Anthropic | ProviderType::Proxy => {
            &["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]
        }
        ProviderType::OpenAI => &["OPENAI_API_KEY", "CODEX_API_KEY"],
        ProviderType::Gemini => &["GEMINI_API_KEY"],
        ProviderType::OpenCode => &[
            "OPENAI_API_KEY",
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_AUTH_TOKEN",
        ],
        _ => &[],
    }
}

fn url_names(provider_type: ProviderType) -> &'static [&'static str] {
    match provider_type {
        ProviderType::Anthropic | ProviderType::Proxy => &["ANTHROPIC_BASE_URL"],
        ProviderType::OpenAI => &["OPENAI_BASE_URL"],
        ProviderType::Gemini => &["GEMINI_API_BASE", "GOOGLE_GEMINI_BASE_URL"],
        ProviderType::OpenCode => &["OPENAI_BASE_URL", "ANTHROPIC_BASE_URL"],
        _ => &[],
    }
}

fn first_nonempty(settings: &Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(value) = lookup_setting(settings, key) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

fn lookup_setting(settings: &Value, key: &str) -> Option<String> {
    for bag in ["env", "auth"] {
        if let Some(value) = settings
            .get(bag)
            .and_then(Value::as_object)
            .and_then(|obj| obj.get(key))
            .and_then(Value::as_str)
        {
            return Some(value.to_string());
        }
    }
    settings
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn toml_string(value: &toml::Value, key: &str) -> Option<String> {
    value
        .get(key)?
        .as_str()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string)
}

fn selected_codex_provider(config: &toml::Value) -> Option<&toml::Value> {
    let providers = config
        .get("model_providers")
        .and_then(toml::Value::as_table);
    if let Some(selected) = config.get("model_provider").and_then(toml::Value::as_str) {
        return providers.and_then(|items| items.get(selected)).or_else(|| {
            // OpenAI is a built-in provider and need not have a custom table.
            (selected == "openai").then_some(config)
        });
    }
    match providers {
        Some(items) if items.len() == 1 => items.values().next(),
        Some(items) if !items.is_empty() => None,
        _ => Some(config),
    }
}

fn copied_provider_id(candidate: &CcSwitchImportCandidate) -> String {
    let slug: String = candidate
        .name
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    let slug = slug.trim_matches('-');
    let slug: String = if slug.is_empty() {
        "provider".to_string()
    } else {
        slug.chars().take(40).collect()
    };
    let nonce = &uuid::Uuid::new_v4().simple().to_string()[..8];
    let app = match candidate.provider_type {
        ProviderType::Anthropic => "claude",
        ProviderType::OpenAI => "codex",
        ProviderType::Gemini => "gemini",
        ProviderType::OpenCode => "opencode",
        _ => "other",
    };
    format!("ccsw-{app}-{slug}-{nonce}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;
    use serde_json::json;

    #[test]
    fn maps_claude_env_auth_token_and_base_url() {
        let row = map_cc_switch_row(
            "claude",
            "  Relay  ",
            &json!({
                "env": {
                    "ANTHROPIC_AUTH_TOKEN": "sk-ant-copy",
                    "ANTHROPIC_BASE_URL": "https://api.example.com",
                    "ANTHROPIC_MODEL": "claude-sonnet-4-5"
                }
            }),
        )
        .unwrap();
        assert_eq!(row.name, "Relay");
        assert_eq!(row.provider_type, ProviderType::Anthropic);
        assert_eq!(row.api_key.as_deref(), Some("sk-ant-copy"));
        assert_eq!(row.base_url.as_deref(), Some("https://api.example.com"));
        assert_eq!(row.default_model_id.as_deref(), Some("claude-sonnet-4-5"));
    }

    #[test]
    fn maps_codex_auth_and_toml_base_url() {
        let row = map_cc_switch_row(
            "codex",
            "Codex Relay",
            &json!({
                "auth": { "OPENAI_API_KEY": "sk-codex" },
                "config": "model = \"gpt-5\"\n[model_providers.relay]\nbase_url = \"https://codex.example.com/v1\"\n"
            }),
        )
        .unwrap();
        assert_eq!(row.provider_type, ProviderType::OpenAI);
        assert_eq!(row.api_key.as_deref(), Some("sk-codex"));
        assert_eq!(row.default_model_id.as_deref(), Some("gpt-5"));
        assert_eq!(
            row.base_url.as_deref(),
            Some("https://codex.example.com/v1")
        );
    }

    #[test]
    fn maps_gemini_and_opencode_env() {
        let gemini = map_cc_switch_row(
            "gemini",
            "Gemini",
            &json!({ "env": { "GEMINI_API_KEY": "gem-key" } }),
        )
        .unwrap();
        assert_eq!(gemini.provider_type, ProviderType::Gemini);
        assert_eq!(gemini.api_key.as_deref(), Some("gem-key"));

        let opencode = map_cc_switch_row(
            "opencode",
            "OC",
            &json!({
                "env": {
                    "OPENAI_API_KEY": "oc-key",
                    "OPENAI_BASE_URL": "https://openrouter.ai/api/v1"
                }
            }),
        )
        .unwrap();
        assert_eq!(opencode.provider_type, ProviderType::OpenCode);
        assert_eq!(opencode.api_key.as_deref(), Some("oc-key"));
    }

    #[test]
    fn codex_uses_selected_table_and_preserves_model_and_wire_api() {
        let settings = json!({
            "auth": {"OPENAI_API_KEY": "test-key"},
            "config": "model_provider = 'selected'\nmodel = 'test-model'\n[model_providers.other]\nbase_url = 'https://wrong.example'\n[model_providers.selected]\nbase_url = 'https://selected.example/v1' # comment\nwire_api = 'responses'\n"
        });
        let row = map_cc_switch_row("codex", "Selected", &settings).unwrap();
        assert_eq!(row.base_url.as_deref(), Some("https://selected.example/v1"));
        assert_eq!(row.default_model_id.as_deref(), Some("test-model"));
        assert_eq!(
            candidate_to_provider(&row).codex_wire_api.as_deref(),
            Some("responses")
        );
    }

    #[test]
    fn codex_does_not_guess_between_ambiguous_provider_tables() {
        let settings = json!({"auth":{"OPENAI_API_KEY":"test-key"},
            "config":"[model_providers.a]\nbase_url='https://a.example'\n[model_providers.b]\nbase_url='https://b.example'"});
        assert!(map_cc_switch_row("codex", "Ambiguous", &settings).is_none());
    }

    #[test]
    fn maps_opencode_options_and_skips_incompatible_protocols() {
        let mut settings = json!({"npm":"@ai-sdk/openai-compatible",
            "options":{"apiKey":"test-key","baseURL":"https://example.test/v1"}});
        let row = map_cc_switch_row("opencode", "Compatible", &settings).unwrap();
        assert_eq!(row.api_key.as_deref(), Some("test-key"));
        assert_eq!(row.base_url.as_deref(), Some("https://example.test/v1"));
        settings["npm"] = json!("@ai-sdk/anthropic");
        assert!(map_cc_switch_row("opencode", "Different protocol", &settings).is_none());
    }

    #[test]
    fn skips_unsupported_and_empty_rows() {
        assert!(map_cc_switch_row("openclaw", "Bot", &json!({ "env": { "FOO": "1" } })).is_none());
        assert!(map_cc_switch_row(
            "claude",
            "   ",
            &json!({ "env": { "ANTHROPIC_API_KEY": "x" } })
        )
        .is_none());
        assert!(map_cc_switch_row("claude", "Empty", &json!({ "env": {} })).is_none());
    }

    #[test]
    fn loads_rows_from_sqlite() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("cc-switch.db");
        let conn = Connection::open(&db_path).unwrap();
        conn.execute(
            "CREATE TABLE providers (
                id TEXT NOT NULL,
                app_type TEXT NOT NULL,
                name TEXT NOT NULL,
                settings_config TEXT NOT NULL,
                PRIMARY KEY (id, app_type)
            )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO providers (id, app_type, name, settings_config) VALUES (?1, ?2, ?3, ?4)",
            params![
                "p1",
                "claude",
                "Copied",
                json!({"env":{"ANTHROPIC_API_KEY":"sk-1","ANTHROPIC_BASE_URL":"https://a.example"}}).to_string(),
            ],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO providers (id, app_type, name, settings_config) VALUES (?1, ?2, ?3, ?4)",
            params![
                "p2",
                "openclaw",
                "Skip",
                json!({"env":{"FOO":"1"}}).to_string()
            ],
        )
        .unwrap();

        let loaded = load_cc_switch_providers(&db_path).unwrap();
        assert_eq!(loaded.candidates.len(), 1);
        assert_eq!(loaded.skipped_unsupported, 1);
        assert_eq!(loaded.candidates[0].name, "Copied");
        assert_eq!(loaded.candidates[0].api_key.as_deref(), Some("sk-1"));
    }
}
