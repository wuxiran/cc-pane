use crate::models::ssh_machine::SshMachine;
use crate::services::SshMachineService;
use crate::utils::path_validator::validate_ssh_machine;
use crate::utils::AppResult;
use std::sync::Arc;
use tauri::State;
use tracing::debug;

#[tauri::command]
pub fn list_ssh_machines(
    service: State<'_, Arc<SshMachineService>>,
) -> AppResult<Vec<SshMachine>> {
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
    machine: SshMachine,
    service: State<'_, Arc<SshMachineService>>,
) -> AppResult<()> {
    debug!(id = %machine.id, name = %machine.name, "cmd::add_ssh_machine");
    validate_ssh_machine(&machine)?;
    Ok(service.add(machine)?)
}

#[tauri::command]
pub fn update_ssh_machine(
    machine: SshMachine,
    service: State<'_, Arc<SshMachineService>>,
) -> AppResult<()> {
    debug!(id = %machine.id, "cmd::update_ssh_machine");
    validate_ssh_machine(&machine)?;
    Ok(service.update(machine)?)
}

#[tauri::command]
pub fn remove_ssh_machine(
    id: String,
    service: State<'_, Arc<SshMachineService>>,
) -> AppResult<()> {
    debug!(id = %id, "cmd::remove_ssh_machine");
    Ok(service.remove(&id)?)
}
