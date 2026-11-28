//! Bot 组网（docs/112 §5）桌面命令：联系人、对端管理、发消息、远程权限。
use std::sync::Arc;

use cc_panes_core::models::{DeviceSummary, MeshAddressSource};
use cc_panes_core::services::remote_terminal::RemoteSessionRouter;
use cc_panes_core::services::DeviceService;
use tauri::{AppHandle, Manager, State};

use crate::services::bot_mesh::discovery::DiscoveryReport;
use crate::services::bot_mesh::outbound::{SendRequest, Sender};
use crate::services::bot_mesh::peers::{self, MeshPeerView};
use crate::services::bot_mesh::{ContactsView, OutboxEntry, RemotePatch, SharedBot};
use crate::services::BotMeshService;
use crate::utils::{AppError, AppResult};

type Mesh<'a> = State<'a, Arc<BotMeshService>>;

#[tauri::command]
pub async fn mesh_contacts(mesh: Mesh<'_>, refresh: Option<bool>) -> AppResult<ContactsView> {
    Ok(mesh.inner().contacts(refresh.unwrap_or(false), true).await)
}

#[tauri::command]
pub async fn mesh_peers(mesh: Mesh<'_>) -> AppResult<Vec<MeshPeerView>> {
    let mesh = mesh.inner().clone();
    tauri::async_runtime::spawn_blocking(move || mesh.peers().list())
        .await
        .map_err(|e| AppError::from(e.to_string()))
}

#[tauri::command]
pub async fn mesh_discover(mesh: Mesh<'_>) -> AppResult<DiscoveryReport> {
    Ok(mesh.inner().discover().await)
}

/// 用对方的配对码互联（复用 docs/111 `device_pair`），并记下对方实例 id 与地址来源。
#[tauri::command]
pub async fn mesh_pair_peer(
    mesh: Mesh<'_>,
    devices: State<'_, Arc<DeviceService>>,
    name: String,
    base_url: String,
    code: String,
    source: Option<MeshAddressSource>,
) -> AppResult<DeviceSummary> {
    let summary = crate::commands::device_pair(name, base_url.clone(), code, devices).await?;
    let mesh = mesh.inner().clone();
    let device_id = summary.device.id.clone();
    let mut record = mesh.peers().record(&device_id);
    record.merge_address(&base_url, source.unwrap_or(MeshAddressSource::Manual));
    mesh.peers().save(&record);
    if let Ok(endpoint) = mesh.peers().endpoint(&device_id).await {
        if let Ok(info) = peers::peer_get(&endpoint, "/api/device/info").await {
            mesh.peers().remember_identity(&device_id, &info);
        }
    }
    Ok(summary)
}

#[tauri::command]
pub async fn mesh_remove_peer(
    mesh: Mesh<'_>,
    devices: State<'_, Arc<DeviceService>>,
    router: State<'_, Arc<RemoteSessionRouter>>,
    device_id: String,
) -> AppResult<()> {
    mesh.peers().forget(&device_id);
    mesh.invalidate_contacts(&device_id);
    crate::commands::device_remove(device_id, devices, router).await
}

#[tauri::command]
pub async fn mesh_send(
    mesh: Mesh<'_>,
    device_id: String,
    bot_id: String,
    text: String,
) -> AppResult<OutboxEntry> {
    let request = SendRequest {
        device_id: Some(device_id),
        bot_id,
        text,
        prompt_id: None,
    };
    let sender = Sender {
        label: "desktop".to_string(),
        caller_bot: None,
        agent: false,
    };
    mesh.inner().send(request, sender).await
}

#[tauri::command]
pub async fn mesh_outbox(mesh: Mesh<'_>) -> AppResult<Vec<OutboxEntry>> {
    Ok(mesh.outbox())
}

#[tauri::command]
pub async fn mesh_clear_outbox(mesh: Mesh<'_>, id: String) -> AppResult<()> {
    mesh.clear_outbox_entry(&id);
    Ok(())
}

#[tauri::command]
pub async fn mesh_respond_permission(
    mesh: Mesh<'_>,
    device_id: String,
    bot_id: String,
    request_key: String,
    option_id: Option<String>,
) -> AppResult<()> {
    mesh.respond_permission(&device_id, &bot_id, request_key, option_id)
        .await
}

#[tauri::command]
pub async fn mesh_set_bot_remote(
    mesh: Mesh<'_>,
    bot_id: String,
    patch: RemotePatch,
) -> AppResult<SharedBot> {
    mesh.update_remote_settings(&bot_id, patch).await
}

/// Web 访问设置变化后对齐 mDNS 广播（服务尚未就绪时静默跳过）。
pub fn sync_mesh_advertisement(app: &AppHandle) {
    if let Some(mesh) = app.try_state::<Arc<BotMeshService>>() {
        let mesh = mesh.inner().clone();
        tauri::async_runtime::spawn_blocking(move || mesh.sync_advertisement());
    }
}
