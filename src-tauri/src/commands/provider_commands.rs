use crate::models::provider::{Provider, SystemProviderInfo};
use crate::services::{CcSwitchImportReport, ProviderService};
use crate::utils::AppResult;
use cc_panes_core::services::{
    CreateLoginAccountRequest, DeleteAccountOutcome, LoginAccountService, LoginAccountStatus,
    LoginAccountView, LoginCommand, ProviderApiCredentials, ProviderEnvPreviewEntry,
    SettingsService,
};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, State};
use tracing::debug;

#[tauri::command]
pub fn list_providers(service: State<'_, Arc<ProviderService>>) -> AppResult<Vec<Provider>> {
    // 界面拿到的永远是清掉密钥明文的副本，只有「有没有、存在哪」的标记。
    Ok(service.list_providers_for_display())
}

#[tauri::command]
pub fn get_provider(
    id: String,
    service: State<'_, Arc<ProviderService>>,
) -> AppResult<Option<Provider>> {
    Ok(service.get_provider_for_display(&id))
}

#[tauri::command]
pub fn get_default_provider(
    service: State<'_, Arc<ProviderService>>,
) -> AppResult<Option<Provider>> {
    Ok(service.get_default_provider_for_display())
}

/// 注入预览：选定账号和 CLI 后将要带给会话的环境变量，敏感值已打码。不读钥匙串。
#[tauri::command]
pub fn preview_provider_env(
    provider_id: String,
    account_id: Option<String>,
    cli_tool: Option<String>,
    service: State<'_, Arc<ProviderService>>,
) -> AppResult<Vec<ProviderEnvPreviewEntry>> {
    Ok(service.preview_env(&provider_id, account_id.as_deref(), cli_tool.as_deref())?)
}

/// 测试连接 / 拉模型列表 / 一次性补全用：读出某个账号的密钥与接口地址。
/// 会读钥匙串；返回值只在内存里用，不要落盘、不要进日志。
#[tauri::command]
pub async fn resolve_provider_api_credentials(
    provider_id: String,
    account_id: Option<String>,
    service: State<'_, Arc<ProviderService>>,
) -> AppResult<ProviderApiCredentials> {
    debug!(provider_id = %provider_id, "cmd::resolve_provider_api_credentials");
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || {
        service.resolve_api_credentials(&provider_id, account_id.as_deref())
    })
    .await
    .map_err(|error| crate::utils::AppError::from(format!("Provider secret task failed: {error}")))?
    .map_err(Into::into)
}

/// 密钥存储状态：当前环境有没有可用的系统钥匙串。没有时密钥留在 providers.json
/// 并标为 `file`，界面据此提示「未进钥匙串」。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSecretStatus {
    pub keychain_available: bool,
}

#[tauri::command]
pub fn get_provider_secret_status(
    service: State<'_, Arc<ProviderService>>,
) -> AppResult<ProviderSecretStatus> {
    Ok(ProviderSecretStatus {
        keychain_available: service.keychain_available(),
    })
}

/// 登录账号的操作会碰文件系统（建目录、链接）和钥匙串查询（只查在不在），放到阻塞线程里做。
async fn with_login_accounts<T: Send + 'static>(
    service: &Arc<ProviderService>,
    task: impl FnOnce(LoginAccountService) -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    let providers = Arc::clone(service);
    tauri::async_runtime::spawn_blocking(move || {
        task(LoginAccountService::for_provider_service(providers))
    })
    .await
    .map_err(|error| crate::utils::AppError::from(format!("Login account task failed: {error}")))?
}

/// 这条供应商下的登录账号：每个可在它下面登录的 CLI 一个合成的「默认登录」，加上用户建的。
/// 每条都带登录状态（已登录 / 未登录 / 未知）和账号邮箱。
#[tauri::command]
pub async fn list_login_accounts(
    provider_id: String,
    service: State<'_, Arc<ProviderService>>,
) -> AppResult<Vec<LoginAccountView>> {
    with_login_accounts(service.inner(), move |accounts| {
        accounts.list_login_accounts(&provider_id)
    })
    .await
}

/// 新建登录账号：CC-Panes 自己建目录、把默认目录里的设置 / 技能 / 指令文件链接进来。
/// 用户只给名字和颜色；之后用 `get_login_account_command` 拿登录命令去终端里登录。
#[tauri::command]
pub async fn create_login_account(
    provider_id: String,
    request: CreateLoginAccountRequest,
    service: State<'_, Arc<ProviderService>>,
) -> AppResult<LoginAccountView> {
    debug!(provider_id = %provider_id, cli_tool = %request.cli_tool, "cmd::create_login_account");
    with_login_accounts(service.inner(), move |accounts| {
        accounts.create_login_account(&provider_id, request)
    })
    .await
}

/// 某个登录账号是否已登录、是哪个号。不读凭据内容；读不出时是「未知」。
/// `cli_tool` 只在查合成的默认登录时需要。
#[tauri::command]
pub async fn get_login_account_status(
    provider_id: String,
    account_id: String,
    cli_tool: Option<String>,
    service: State<'_, Arc<ProviderService>>,
) -> AppResult<LoginAccountStatus> {
    with_login_accounts(service.inner(), move |accounts| {
        accounts.login_status(&provider_id, &account_id, cli_tool.as_deref())
    })
    .await
}

/// 为某个登录账号生成登录命令：要在终端里执行的命令、参数和环境变量。
#[tauri::command]
pub async fn get_login_account_command(
    provider_id: String,
    account_id: String,
    cli_tool: Option<String>,
    service: State<'_, Arc<ProviderService>>,
    settings: State<'_, Arc<SettingsService>>,
) -> AppResult<LoginCommand> {
    let launchers = settings.get_settings().cli_launchers;
    with_login_accounts(service.inner(), move |accounts| {
        accounts.login_command(&provider_id, &account_id, cli_tool.as_deref(), &|cli| {
            launchers.command_for(cli).map(str::to_string)
        })
    })
    .await
}

/// 删除一个账号（密钥账号或登录账号）。登录账号的目录默认保留；`delete_dir = true` 时
/// 同时删目录，但只删 CC-Panes 自己建的——用户手填的外部目录永不删除。
#[tauri::command]
pub async fn delete_provider_account(
    provider_id: String,
    account_id: String,
    delete_dir: Option<bool>,
    service: State<'_, Arc<ProviderService>>,
) -> AppResult<DeleteAccountOutcome> {
    debug!(provider_id = %provider_id, account_id = %account_id, "cmd::delete_provider_account");
    with_login_accounts(service.inner(), move |accounts| {
        accounts.delete_account(&provider_id, &account_id, delete_dir.unwrap_or(false))
    })
    .await
}

#[tauri::command]
pub fn add_provider(provider: Provider, service: State<'_, Arc<ProviderService>>) -> AppResult<()> {
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
pub fn remove_provider(id: String, service: State<'_, Arc<ProviderService>>) -> AppResult<()> {
    debug!(id = %id, "cmd::remove_provider");
    Ok(service.remove_provider(&id)?)
}

#[tauri::command]
pub fn set_default_provider(
    id: String,
    cli_tool: Option<String>,
    service: State<'_, Arc<ProviderService>>,
) -> AppResult<()> {
    debug!(id = %id, cli_tool = ?cli_tool, "cmd::set_default_provider");
    match cli_tool {
        Some(cli_tool) => Ok(service.set_default_for_cli(&cli_tool, &id)?),
        None => Ok(service.set_default(&id)?),
    }
}

/// 探测「系统环境变量」条目：是否可用（cc-switch 已安装或宿主已设 Anthropic 凭证）、
/// 命中了哪些变量名，以及用户是否已把它设为默认凭证。
#[tauri::command]
pub fn detect_system_provider(
    service: State<'_, Arc<ProviderService>>,
) -> AppResult<SystemProviderInfo> {
    Ok(service.system_provider_info())
}

/// 从本机 `~/.cc-switch/cc-switch.db` 抄入供应商（去重，不改默认）。
#[tauri::command]
pub async fn import_cc_switch_providers(
    service: State<'_, Arc<ProviderService>>,
) -> AppResult<CcSwitchImportReport> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || service.import_cc_switch_providers(None))
        .await
        .map_err(|error| {
            crate::utils::AppError::from(format!("Provider import task failed: {error}"))
        })?
        .map_err(Into::into)
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
            .and_then(|content| serde_json::from_str::<serde_json::Value>(&content).ok())
            .map(|val| {
                let mut parts = Vec::new();
                if let Some(model) = val.get("model").and_then(|v| v.as_str()) {
                    parts.push(format!("model: {}", model));
                }
                if let Some(provider) = val.get("provider").and_then(|v| v.as_str()) {
                    parts.push(format!("provider: {}", provider));
                }
                if parts.is_empty() {
                    let keys: Vec<String> = val
                        .as_object()
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
    let content = std::fs::read_to_string(file_path).map_err(|e| format!("无法读取文件: {}", e))?;

    let json: serde_json::Value =
        serde_json::from_str(&content).map_err(|e| format!("JSON 解析失败: {}", e))?;

    let env_keys: Vec<String> = json
        .get("env")
        .and_then(|v| v.as_object())
        .map(|obj| obj.keys().cloned().collect())
        .unwrap_or_default();

    let summary = if env_keys.is_empty() {
        None
    } else {
        Some(format!(
            "env 变量 ({}): {}",
            env_keys.len(),
            env_keys.join(", ")
        ))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_config_file_info_summarizes_env_keys() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("config.json");
        std::fs::write(
            &file,
            r#"{"env":{"ANTHROPIC_BASE_URL":"https://x","ANTHROPIC_AUTH_TOKEN":"sk"}}"#,
        )
        .unwrap();

        let info = read_config_file_info(&file, "config.json".to_string()).unwrap();

        assert_eq!(info.path, "config.json");
        assert!(!info.has_settings);
        assert!(!info.has_credentials);
        assert_eq!(info.files.len(), 2);
        let summary = info.settings_summary.unwrap();
        assert!(summary.contains("env 变量 (2)"));
        assert!(summary.contains("ANTHROPIC_BASE_URL"));
    }

    #[test]
    fn read_config_file_info_without_env_has_no_summary() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("config.json");
        std::fs::write(&file, r#"{"model":"opus"}"#).unwrap();

        let info = read_config_file_info(&file, "config.json".to_string()).unwrap();

        assert_eq!(info.settings_summary, None);
        assert!(info.files.is_empty());
    }

    #[test]
    fn read_config_file_info_rejects_invalid_json() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("config.json");
        std::fs::write(&file, "not json").unwrap();

        let result = read_config_file_info(&file, "config.json".to_string());
        assert!(result.is_err());
    }

    #[test]
    fn read_config_file_info_rejects_missing_file() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("missing.json");
        let result = read_config_file_info(&file, "missing.json".to_string());
        assert!(result.is_err());
    }
}
