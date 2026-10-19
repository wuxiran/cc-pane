use crate::models::ssh_machine::{SshMachine, SshMachineUpsertRequest};
use crate::services::{SshConnectivityResult, SshMachineService};
use crate::utils::path_validator::validate_ssh_machine;
use crate::utils::{AppError, AppResult};
use std::sync::Arc;
use tauri::State;
use tracing::debug;

// Keychain access can wait for OS authorization. File-backed mutations can
// block too, so none of these operations may run on Tauri's UI thread.
async fn run_ssh_machine_task<T, F>(task: F) -> AppResult<T>
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
pub async fn list_ssh_machines(
    service: State<'_, Arc<SshMachineService>>,
) -> AppResult<Vec<SshMachine>> {
    let service = service.inner().clone();
    run_ssh_machine_task(move || Ok(service.list())).await
}

#[tauri::command]
pub async fn get_ssh_machine(
    id: String,
    service: State<'_, Arc<SshMachineService>>,
) -> AppResult<Option<SshMachine>> {
    let service = service.inner().clone();
    run_ssh_machine_task(move || Ok(service.get(&id))).await
}

#[tauri::command]
pub async fn add_ssh_machine(
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
    let service = service.inner().clone();
    run_ssh_machine_task(move || service.add(request)).await
}

#[tauri::command]
pub async fn update_ssh_machine(
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
    let service = service.inner().clone();
    run_ssh_machine_task(move || service.update(request)).await
}

#[tauri::command]
pub async fn remove_ssh_machine(
    id: String,
    service: State<'_, Arc<SshMachineService>>,
) -> AppResult<()> {
    debug!(id = %id, "cmd::remove_ssh_machine");
    let service = service.inner().clone();
    run_ssh_machine_task(move || service.remove(&id)).await
}

#[tauri::command]
pub async fn check_ssh_connectivity(
    id: String,
    service: State<'_, Arc<SshMachineService>>,
) -> AppResult<SshConnectivityResult> {
    debug!(id = %id, "cmd::check_ssh_connectivity");
    Ok(service.check_connectivity(&id).await?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test(flavor = "current_thread")]
    async fn waiting_for_credentials_does_not_block_the_async_caller() {
        let caller_thread = std::thread::current().id();
        let (started, ready) = tokio::sync::oneshot::channel();
        let (release, waiting) = std::sync::mpsc::channel();
        let lookup = run_ssh_machine_task(move || {
            let worker_thread = std::thread::current().id();
            started.send(worker_thread).unwrap();
            // Bounded wait makes a regression fail instead of hanging the test.
            waiting.recv_timeout(Duration::from_secs(2))?;
            Ok(worker_thread)
        });
        let progress = async {
            let worker_thread = tokio::time::timeout(Duration::from_secs(1), ready)
                .await
                .unwrap()
                .unwrap();
            assert_ne!(caller_thread, worker_thread);
            release.send(()).unwrap();
        };
        let (result, ()) = tokio::join!(lookup, progress);
        assert_ne!(result.unwrap(), caller_thread);
    }

    #[tokio::test]
    async fn credential_failures_are_returned_to_the_caller() {
        let error = run_ssh_machine_task::<(), _>(|| anyhow::bail!("credential access denied"))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("credential access denied"));
    }
}
