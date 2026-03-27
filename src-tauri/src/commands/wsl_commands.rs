use crate::models::wsl::WslDistro;
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
    #[cfg(target_os = "windows")] ssh_service: State<'_, Arc<crate::services::SshMachineService>>,
) -> AppResult<Vec<WslDistro>> {
    debug!("cmd::discover_wsl_distros");

    #[cfg(target_os = "windows")]
    {
        let existing = ssh_service.list();
        let distros = cc_panes_core::services::wsl_discovery_service::discover(&existing).await?;
        Ok(distros)
    }

    #[cfg(not(target_os = "windows"))]
    {
        Ok(Vec::new())
    }
}
