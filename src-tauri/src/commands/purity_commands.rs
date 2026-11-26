//! 中转纯度检测命令。密钥在后端读、在后端用，不经过前端。

use crate::services::channel_purity::{ChannelPurityService, PurityStatus};
use crate::services::{ProviderService, SettingsService};
use crate::utils::{AppError, AppResult};
use std::sync::Arc;
use tauri::State;

/// 当前任务和所有供应商最近一次的检测报告。
#[tauri::command]
pub fn channel_purity_status(service: State<'_, Arc<ChannelPurityService>>) -> PurityStatus {
    service.status()
}

/// 开始检测一条供应商（不指定账号时用默认账号）。会真实调用模型、产生少量费用。
/// 需要先在「设置 → 隐私」打开中转纯度。
#[tauri::command]
pub async fn channel_purity_start(
    provider_id: String,
    account_id: Option<String>,
    service: State<'_, Arc<ChannelPurityService>>,
    providers: State<'_, Arc<ProviderService>>,
    settings: State<'_, Arc<SettingsService>>,
) -> AppResult<()> {
    // 默认关闭：没在「设置 → 隐私」打开就不跑（入口本来也藏着，这里兜底）。
    if !settings.get_settings().privacy.channel_purity {
        return Err(AppError::coded("PURITY_DISABLED", "PURITY_DISABLED"));
    }
    let service = Arc::clone(service.inner());
    let providers = Arc::clone(providers.inner());
    // 读钥匙串可能阻塞，放到阻塞线程。
    tauri::async_runtime::spawn_blocking(move || {
        service.start(&providers, &provider_id, account_id.as_deref())
    })
    .await
    .map_err(|error| AppError::from(format!("Purity task failed: {error}")))?
    .map_err(|code| {
        if code.starts_with("PURITY_") {
            AppError::coded(&code, code.clone())
        } else {
            AppError::from(code)
        }
    })
}

#[tauri::command]
pub fn channel_purity_cancel(service: State<'_, Arc<ChannelPurityService>>) {
    service.cancel();
}

/// 删掉某条供应商的检测报告（供应商被删除时前端调用）。
#[tauri::command]
pub fn channel_purity_forget(provider_id: String, service: State<'_, Arc<ChannelPurityService>>) {
    service.forget(&provider_id);
}
