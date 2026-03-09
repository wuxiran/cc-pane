use crate::models::provider::Provider;
use crate::services::ProviderService;
use crate::utils::AppResult;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, State};
use tracing::debug;

#[tauri::command]
pub fn list_providers(
    service: State<'_, Arc<ProviderService>>,
) -> AppResult<Vec<Provider>> {
    Ok(service.list_providers())
}

#[tauri::command]
pub fn get_provider(
    id: String,
    service: State<'_, Arc<ProviderService>>,
) -> AppResult<Option<Provider>> {
    Ok(service.get_provider(&id))
}

#[tauri::command]
pub fn get_default_provider(
    service: State<'_, Arc<ProviderService>>,
) -> AppResult<Option<Provider>> {
    Ok(service.get_default_provider())
}

#[tauri::command]
pub fn add_provider(
    provider: Provider,
    service: State<'_, Arc<ProviderService>>,
) -> AppResult<()> {
    debug!(id = %provider.id, name = %provider.name, "cmd::add_provider");
    Ok(service.add_provider(provider)?)
}

#[tauri::command]
pub fn update_provider(
    provider: Provider,
    service: State<'_, Arc<ProviderService>>,
) -> AppResult<()> {
    debug!(id = %provider.id, "cmd::update_provider");
    Ok(service.update_provider(provider)?)
}

#[tauri::command]
pub fn remove_provider(
    id: String,
    service: State<'_, Arc<ProviderService>>,
) -> AppResult<()> {
    debug!(id = %id, "cmd::remove_provider");
    Ok(service.remove_provider(&id)?)
}

#[tauri::command]
pub fn set_default_provider(
    id: String,
    service: State<'_, Arc<ProviderService>>,
) -> AppResult<()> {
    debug!(id = %id, "cmd::set_default_provider");
    Ok(service.set_default(&id)?)
}

/// 配置目录信息
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigDirInfo {
    pub path: String,
    pub has_settings: bool,
    pub has_credentials: bool,
    pub settings_summary: Option<String>,
    pub files: Vec<String>,
}

/// 读取 Claude Code 配置目录或 ccswitch 配置文件信息
#[tauri::command]
pub fn read_config_dir_info(path: String) -> AppResult<ConfigDirInfo> {
    let p = PathBuf::from(&path);

    if p.is_file() {
        // 文件模式：解析 JSON 配置文件（ccswitch 格式）
        return read_config_file_info(&p, path);
    }

    if !p.is_dir() {
        return Err(format!("路径不存在: {}", path).into());
    }

    // 目录模式：保持原有行为
    let mut files = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&p) {
        for entry in entries.flatten() {
            if let Some(name) = entry.file_name().to_str() {
                files.push(name.to_string());
            }
        }
    }
    files.sort();

    let has_settings = p.join("settings.json").is_file();
    let has_credentials = p.join(".credentials.json").is_file();

    let settings_summary = if has_settings {
        std::fs::read_to_string(p.join("settings.json"))
            .ok()
            .and_then(|content| {
                serde_json::from_str::<serde_json::Value>(&content).ok()
            })
            .map(|val| {
                let mut parts = Vec::new();
                if let Some(model) = val.get("model").and_then(|v| v.as_str()) {
                    parts.push(format!("model: {}", model));
                }
                if let Some(provider) = val.get("provider").and_then(|v| v.as_str()) {
                    parts.push(format!("provider: {}", provider));
                }
                if parts.is_empty() {
                    let keys: Vec<String> = val.as_object()
                        .map(|obj| obj.keys().take(5).cloned().collect())
                        .unwrap_or_default();
                    format!("keys: {}", keys.join(", "))
                } else {
                    parts.join(", ")
                }
            })
    } else {
        None
    };

    Ok(ConfigDirInfo {
        path,
        has_settings,
        has_credentials,
        settings_summary,
        files,
    })
}

/// 读取 ccswitch JSON 配置文件信息
fn read_config_file_info(file_path: &Path, path: String) -> AppResult<ConfigDirInfo> {
    let content = std::fs::read_to_string(file_path)
        .map_err(|e| format!("无法读取文件: {}", e))?;

    let json: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("JSON 解析失败: {}", e))?;

    let env_keys: Vec<String> = json
        .get("env")
        .and_then(|v| v.as_object())
        .map(|obj| obj.keys().cloned().collect())
        .unwrap_or_default();

    let summary = if env_keys.is_empty() {
        None
    } else {
        Some(format!("env 变量 ({}): {}", env_keys.len(), env_keys.join(", ")))
    };

    Ok(ConfigDirInfo {
        path,
        has_settings: false,
        has_credentials: false,
        settings_summary: summary,
        files: env_keys,
    })
}

/// 在系统文件管理器中打开路径
#[tauri::command]
pub fn open_path_in_explorer(app: AppHandle, path: String) -> AppResult<()> {
    debug!(path = %path, "cmd::open_path_in_explorer");
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_path(&path, None::<&str>)
        .map_err(|e| e.to_string())?;
    Ok(())
}
