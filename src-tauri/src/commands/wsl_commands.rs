use crate::models::wsl::WslDistro;
use crate::services::SshMachineService;
use crate::utils::AppResult;
use std::sync::Arc;
use tauri::State;
use tracing::debug;

/// 发现已安装的 WSL 分发版
///
/// - Windows: 调用 `wsl.exe --list --verbose` 解析分发版列表
/// - 非 Windows: 返回空列表
#[tauri::command]
pub async fn discover_wsl_distros(
    _ssh_service: State<'_, Arc<SshMachineService>>,
) -> AppResult<Vec<WslDistro>> {
    debug!("cmd::discover_wsl_distros");

    #[cfg(target_os = "windows")]
    {
        let service = _ssh_service.inner().clone();
        let existing = tauri::async_runtime::spawn_blocking(move || service.list())
            .await
            .map_err(|error| crate::utils::AppError::from(error.to_string()))?;
        let distros = cc_panes_core::services::wsl_discovery_service::discover(&existing).await?;
        Ok(distros)
    }

    #[cfg(not(target_os = "windows"))]
    {
        Ok(Vec::new())
    }
}
