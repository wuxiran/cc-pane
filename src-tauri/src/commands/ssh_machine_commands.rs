use crate::models::ssh_machine::{SshMachine, SshMachineUpsertRequest};
use crate::services::{SshConnectivityResult, SshMachineService};
use crate::utils::path_validator::validate_ssh_machine;
use crate::utils::AppResult;
use std::sync::Arc;
use tauri::State;
use tracing::debug;

#[tauri::command]
pub fn list_ssh_machines(service: State<'_, Arc<SshMachineService>>) -> AppResult<Vec<SshMachine>> {
    Ok(service.list())
}

#[tauri::command]
pub fn get_ssh_machine(
    id: String,
    service: State<'_, Arc<SshMachineService>>,
) -> AppResult<Option<SshMachine>> {
    Ok(service.get(&id))
}

#[tauri::command]
pub fn add_ssh_machine(
    request: SshMachineUpsertRequest,
    service: State<'_, Arc<SshMachineService>>,
) -> AppResult<SshMachine> {
    debug!(
        id = %request.machine.id,
        name = %request.machine.name,
        remember_password = request.remember_password,
        "cmd::add_ssh_machine"
    );
    validate_ssh_machine(&request.machine)?;
    Ok(service.add(request)?)
}

#[tauri::command]
pub fn update_ssh_machine(
    request: SshMachineUpsertRequest,
    service: State<'_, Arc<SshMachineService>>,
) -> AppResult<SshMachine> {
    debug!(
        id = %request.machine.id,
        remember_password = request.remember_password,
        clear_stored_password = request.clear_stored_password,
        "cmd::update_ssh_machine"
    );
    validate_ssh_machine(&request.machine)?;
    Ok(service.update(request)?)
}

#[tauri::command]
pub fn remove_ssh_machine(id: String, service: State<'_, Arc<SshMachineService>>) -> AppResult<()> {
    debug!(id = %id, "cmd::remove_ssh_machine");
    Ok(service.remove(&id)?)
}

#[tauri::command]
pub async fn check_ssh_connectivity(
    id: String,
    service: State<'_, Arc<SshMachineService>>,
) -> AppResult<SshConnectivityResult> {
    debug!(id = %id, "cmd::check_ssh_connectivity");
    Ok(service.check_connectivity(&id).await?)
}
