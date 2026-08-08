use crate::models::filesystem::{DirListing, FileContent, ImageFileContent};
use crate::services::{SshFileService, TerminalBackendState};
use crate::utils::{AppError, AppResult};
use std::sync::Arc;
use tauri::State;
use tracing::debug;

async fn run_sftp_task<T, F>(task: F) -> AppResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> anyhow::Result<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|error| AppError::from(error.to_string()))?
        .map_err(AppError::from)
}

#[tauri::command]
pub async fn ssh_fs_configure_password(
    machine_id: String,
    password: String,
    remember: bool,
    service: State<'_, Arc<SshFileService>>,
    terminal_backend: State<'_, Arc<TerminalBackendState>>,
) -> AppResult<()> {
    debug!(machine_id = %machine_id, remember, "cmd::ssh_fs_configure_password");
    let service = service.inner().clone();
    let verified_machine_id = machine_id.clone();
    let verified_password = password.clone();
    run_sftp_task(move || {
        service.configure_password(&verified_machine_id, &verified_password, remember)
    })
    .await?;

    if let Some(client) = terminal_backend.daemon_client() {
        tauri::async_runtime::spawn_blocking(move || {
            client.set_temporary_ssh_password(&machine_id, &password)
        })
        .await
        .map_err(|error| AppError::from(error.to_string()))??;
    }
    Ok(())
}

#[tauri::command]
pub async fn ssh_fs_list_directory(
    machine_id: String,
    path: String,
    show_hidden: bool,
    service: State<'_, Arc<SshFileService>>,
) -> AppResult<DirListing> {
    debug!(machine_id = %machine_id, path = %path, "cmd::ssh_fs_list_directory");
    let service = service.inner().clone();
    run_sftp_task(move || service.list_directory(&machine_id, &path, show_hidden)).await
}

#[tauri::command]
pub async fn ssh_fs_read_file(
    machine_id: String,
    path: String,
    service: State<'_, Arc<SshFileService>>,
) -> AppResult<FileContent> {
    debug!(machine_id = %machine_id, path = %path, "cmd::ssh_fs_read_file");
    let service = service.inner().clone();
    run_sftp_task(move || service.read_file(&machine_id, &path)).await
}

#[tauri::command]
pub async fn ssh_fs_read_image(
    machine_id: String,
    path: String,
    service: State<'_, Arc<SshFileService>>,
) -> AppResult<ImageFileContent> {
    debug!(machine_id = %machine_id, path = %path, "cmd::ssh_fs_read_image");
    let service = service.inner().clone();
    run_sftp_task(move || service.read_image(&machine_id, &path)).await
}

#[tauri::command]
pub async fn ssh_fs_write_file(
    machine_id: String,
    path: String,
    content: String,
    service: State<'_, Arc<SshFileService>>,
) -> AppResult<()> {
    debug!(machine_id = %machine_id, path = %path, "cmd::ssh_fs_write_file");
    let service = service.inner().clone();
    run_sftp_task(move || service.write_file(&machine_id, &path, &content)).await
}

#[tauri::command]
pub async fn ssh_fs_create_file(
    machine_id: String,
    parent: String,
    name: String,
    service: State<'_, Arc<SshFileService>>,
) -> AppResult<()> {
    debug!(machine_id = %machine_id, parent = %parent, name = %name, "cmd::ssh_fs_create_file");
    let service = service.inner().clone();
    run_sftp_task(move || service.create_file(&machine_id, &parent, &name)).await
}

#[tauri::command]
pub async fn ssh_fs_create_directory(
    machine_id: String,
    parent: String,
    name: String,
    service: State<'_, Arc<SshFileService>>,
) -> AppResult<()> {
    debug!(machine_id = %machine_id, parent = %parent, name = %name, "cmd::ssh_fs_create_directory");
    let service = service.inner().clone();
    run_sftp_task(move || service.create_directory(&machine_id, &parent, &name)).await
}

#[tauri::command]
pub async fn ssh_fs_rename_entry(
    machine_id: String,
    path: String,
    new_name: String,
    service: State<'_, Arc<SshFileService>>,
) -> AppResult<()> {
    debug!(machine_id = %machine_id, path = %path, new_name = %new_name, "cmd::ssh_fs_rename_entry");
    let service = service.inner().clone();
    run_sftp_task(move || service.rename_entry(&machine_id, &path, &new_name)).await
}

#[tauri::command]
pub async fn ssh_fs_delete_entry(
    machine_id: String,
    path: String,
    service: State<'_, Arc<SshFileService>>,
) -> AppResult<()> {
    debug!(machine_id = %machine_id, path = %path, "cmd::ssh_fs_delete_entry");
    let service = service.inner().clone();
    run_sftp_task(move || service.delete_entry(&machine_id, &path)).await
}

#[tauri::command]
pub async fn ssh_fs_upload_file(
    machine_id: String,
    local_path: String,
    remote_parent: String,
    service: State<'_, Arc<SshFileService>>,
) -> AppResult<u64> {
    debug!(machine_id = %machine_id, remote_parent = %remote_parent, "cmd::ssh_fs_upload_file");
    let service = service.inner().clone();
    run_sftp_task(move || service.upload_file(&machine_id, &local_path, &remote_parent)).await
}

#[tauri::command]
pub async fn ssh_fs_download_file(
    machine_id: String,
    remote_path: String,
    local_path: String,
    service: State<'_, Arc<SshFileService>>,
) -> AppResult<u64> {
    debug!(machine_id = %machine_id, remote_path = %remote_path, "cmd::ssh_fs_download_file");
    let service = service.inner().clone();
    run_sftp_task(move || service.download_file(&machine_id, &remote_path, &local_path)).await
}

#[tauri::command]
pub async fn ssh_fs_set_permissions(
    machine_id: String,
    path: String,
    mode: u32,
    service: State<'_, Arc<SshFileService>>,
) -> AppResult<()> {
    debug!(machine_id = %machine_id, path = %path, mode, "cmd::ssh_fs_set_permissions");
    let service = service.inner().clone();
    run_sftp_task(move || service.set_permissions(&machine_id, &path, mode)).await
}
