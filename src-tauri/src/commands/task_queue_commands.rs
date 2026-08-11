use std::path::Path;
use std::sync::Arc;

use cc_cli_adapters::CliToolRegistry;
use cc_panes_core::models::task_queue::{
    StagedTaskQueueImage, TaskQueueControlPatch, TaskQueueItemDraft, TaskQueueSnapshot,
};
use cc_panes_core::services::{AutomaticWriteAuthority, TaskQueueService};
use tauri::{AppHandle, Emitter, Manager, State};
use tracing::debug;

use crate::services::{
    LaunchHistoryService, ScreenshotService, SettingsService, TaskQueueWorker, TerminalBackendState,
};
use crate::utils::{AppError, AppResult};

const TASK_QUEUE_UPDATED_EVENT: &str = "task-queue-updated";

struct QueueSessionFacts {
    cli_tool: String,
    live: bool,
    authority: AutomaticWriteAuthority,
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn validate_session_facts(
    cli_tool: Option<&str>,
    live: bool,
    authority: AutomaticWriteAuthority,
    require_write: bool,
) -> AppResult<()> {
    if cli_tool.is_none_or(|value| value.trim().is_empty() || value == "none") {
        return Err(AppError::coded(
            "SESSION_NOT_FOUND",
            "Task queues require a terminal session with a CLI tool",
        ));
    }
    if require_write && (!live || matches!(authority, AutomaticWriteAuthority::Unavailable)) {
        return Err(AppError::coded(
            "SESSION_NOT_WRITABLE",
            "Terminal session is not owned by this application instance",
        ));
    }
    Ok(())
}

fn session_facts(
    session_id: &str,
    terminal_backend: &TerminalBackendState,
    launch_history: &LaunchHistoryService,
    require_write: bool,
) -> AppResult<QueueSessionFacts> {
    let record = launch_history.find_by_pty_session_id(session_id)?;
    let cli_tool = record.as_ref().map(|record| record.cli_tool.as_str());
    let backend = terminal_backend.backend();
    let live = backend
        .get_session_status(session_id)?
        .is_some_and(|status| !status.status.is_terminal());
    let authority = backend
        .automatic_write_authority(session_id)
        .unwrap_or(AutomaticWriteAuthority::Unavailable);
    validate_session_facts(cli_tool, live, authority.clone(), require_write)?;
    Ok(QueueSessionFacts {
        cli_tool: cli_tool.unwrap_or_default().to_string(),
        live,
        authority,
    })
}

fn unattended_supported(facts: &QueueSessionFacts, registry: &CliToolRegistry) -> bool {
    facts.live
        && !matches!(facts.authority, AutomaticWriteAuthority::Unavailable)
        && registry
            .get(&facts.cli_tool)
            .and_then(|adapter| adapter.permission_request_capability())
            .is_some()
}

fn decorate_snapshot(
    mut snapshot: TaskQueueSnapshot,
    facts: &QueueSessionFacts,
    registry: &CliToolRegistry,
) -> TaskQueueSnapshot {
    snapshot.unattended_supported = unattended_supported(facts, registry);
    snapshot
}

pub(crate) fn task_queue_snapshot_for_session(
    service: &TaskQueueService,
    terminal_backend: &TerminalBackendState,
    launch_history: &LaunchHistoryService,
    registry: &CliToolRegistry,
    session_id: &str,
    require_write: bool,
) -> AppResult<TaskQueueSnapshot> {
    let facts = session_facts(session_id, terminal_backend, launch_history, require_write)?;
    Ok(decorate_snapshot(
        service.snapshot(session_id)?,
        &facts,
        registry,
    ))
}

fn schedule_dispatch(app: &AppHandle, session_id: &str) {
    app.state::<Arc<TaskQueueWorker>>().schedule(session_id);
}

fn emit_snapshot(app: &AppHandle, snapshot: &TaskQueueSnapshot) -> AppResult<()> {
    app.emit(TASK_QUEUE_UPDATED_EVENT, snapshot)
        .map_err(|error| AppError::from(format!("Failed to publish task queue update: {error}")))
}

#[tauri::command]
pub fn get_terminal_task_queue(
    service: State<'_, Arc<TaskQueueService>>,
    terminal_backend: State<'_, Arc<TerminalBackendState>>,
    launch_history: State<'_, Arc<LaunchHistoryService>>,
    registry: State<'_, Arc<CliToolRegistry>>,
    session_id: String,
) -> AppResult<TaskQueueSnapshot> {
    task_queue_snapshot_for_session(
        &service,
        &terminal_backend,
        &launch_history,
        &registry,
        &session_id,
        false,
    )
}

#[tauri::command]
pub async fn stage_terminal_task_queue_clipboard_image(
    app: AppHandle,
    service: State<'_, Arc<TaskQueueService>>,
    terminal_backend: State<'_, Arc<TerminalBackendState>>,
    launch_history: State<'_, Arc<LaunchHistoryService>>,
    session_id: String,
) -> AppResult<StagedTaskQueueImage> {
    session_facts(&session_id, &terminal_backend, &launch_history, true)?;
    let service = service.inner().clone();
    let retention_days = app
        .state::<Arc<SettingsService>>()
        .get_settings()
        .screenshot
        .retention_days;
    let app_handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_clipboard_manager::ClipboardExt;

        let image = app_handle.clipboard().read_image().map_err(|error| {
            AppError::coded(
                "IMAGE_STAGE_FAILED",
                format!("Clipboard image is unavailable: {error}"),
            )
        })?;
        let saved = ScreenshotService::save_terminal_paste_image(&image, retention_days)?;
        service.stage_image(
            &session_id,
            Path::new(&saved.file_path),
            saved.width,
            saved.height,
        )
    })
    .await
    .map_err(|error| AppError::from(format!("Failed to join clipboard image task: {error}")))?
}

#[tauri::command]
pub fn add_terminal_task_queue_item(
    app: AppHandle,
    service: State<'_, Arc<TaskQueueService>>,
    terminal_backend: State<'_, Arc<TerminalBackendState>>,
    launch_history: State<'_, Arc<LaunchHistoryService>>,
    registry: State<'_, Arc<CliToolRegistry>>,
    session_id: String,
    draft: TaskQueueItemDraft,
) -> AppResult<TaskQueueSnapshot> {
    let facts = session_facts(&session_id, &terminal_backend, &launch_history, true)?;
    let snapshot = decorate_snapshot(
        service.add_item(&session_id, &draft, now_millis())?,
        &facts,
        &registry,
    );
    emit_snapshot(&app, &snapshot)?;
    schedule_dispatch(&app, &session_id);
    Ok(snapshot)
}

#[tauri::command]
pub fn delete_terminal_task_queue_item(
    app: AppHandle,
    service: State<'_, Arc<TaskQueueService>>,
    terminal_backend: State<'_, Arc<TerminalBackendState>>,
    launch_history: State<'_, Arc<LaunchHistoryService>>,
    registry: State<'_, Arc<CliToolRegistry>>,
    session_id: String,
    item_id: String,
) -> AppResult<TaskQueueSnapshot> {
    let facts = session_facts(&session_id, &terminal_backend, &launch_history, true)?;
    let snapshot = decorate_snapshot(
        service.delete_item(&session_id, &item_id, now_millis())?,
        &facts,
        &registry,
    );
    emit_snapshot(&app, &snapshot)?;
    schedule_dispatch(&app, &session_id);
    Ok(snapshot)
}

#[tauri::command]
pub fn clear_terminal_task_queue(
    app: AppHandle,
    service: State<'_, Arc<TaskQueueService>>,
    terminal_backend: State<'_, Arc<TerminalBackendState>>,
    launch_history: State<'_, Arc<LaunchHistoryService>>,
    registry: State<'_, Arc<CliToolRegistry>>,
    session_id: String,
) -> AppResult<TaskQueueSnapshot> {
    let facts = session_facts(&session_id, &terminal_backend, &launch_history, true)?;
    let snapshot = decorate_snapshot(
        service.clear_queue(&session_id, now_millis())?,
        &facts,
        &registry,
    );
    emit_snapshot(&app, &snapshot)?;
    schedule_dispatch(&app, &session_id);
    Ok(snapshot)
}

#[tauri::command]
pub fn update_terminal_task_queue(
    app: AppHandle,
    service: State<'_, Arc<TaskQueueService>>,
    terminal_backend: State<'_, Arc<TerminalBackendState>>,
    launch_history: State<'_, Arc<LaunchHistoryService>>,
    registry: State<'_, Arc<CliToolRegistry>>,
    session_id: String,
    patch: TaskQueueControlPatch,
) -> AppResult<TaskQueueSnapshot> {
    let require_write = patch.paused.is_some() || patch.unattended != Some(false);
    let facts = session_facts(
        &session_id,
        &terminal_backend,
        &launch_history,
        require_write,
    )?;
    if patch.unattended == Some(true) && !unattended_supported(&facts, &registry) {
        return Err(AppError::coded(
            "UNATTENDED_UNSUPPORTED",
            "This terminal does not support structured unattended permission decisions",
        ));
    }
    let snapshot = decorate_snapshot(
        service.update_control(&session_id, &patch, now_millis())?,
        &facts,
        &registry,
    );
    emit_snapshot(&app, &snapshot)?;
    schedule_dispatch(&app, &session_id);
    Ok(snapshot)
}

#[tauri::command]
pub fn retry_terminal_task_queue_item(
    app: AppHandle,
    service: State<'_, Arc<TaskQueueService>>,
    terminal_backend: State<'_, Arc<TerminalBackendState>>,
    launch_history: State<'_, Arc<LaunchHistoryService>>,
    registry: State<'_, Arc<CliToolRegistry>>,
    session_id: String,
    item_id: String,
) -> AppResult<TaskQueueSnapshot> {
    debug!(session_id = %session_id, item_id = %item_id, "retrying terminal task queue item");
    let facts = session_facts(&session_id, &terminal_backend, &launch_history, true)?;
    let snapshot = decorate_snapshot(
        service.retry_item(&session_id, &item_id, now_millis())?,
        &facts,
        &registry,
    );
    emit_snapshot(&app, &snapshot)?;
    schedule_dispatch(&app, &session_id);
    Ok(snapshot)
}

#[cfg(test)]
mod tests {
    use cc_panes_core::services::AutomaticWriteAuthority;

    use super::validate_session_facts;

    #[test]
    fn session_validation_requires_a_cli_binding() {
        let missing = validate_session_facts(
            None,
            true,
            AutomaticWriteAuthority::ExclusiveInProcess,
            false,
        )
        .unwrap_err();
        assert_eq!(missing.code(), Some("SESSION_NOT_FOUND"));

        let shell = validate_session_facts(
            Some("none"),
            true,
            AutomaticWriteAuthority::ExclusiveInProcess,
            false,
        )
        .unwrap_err();
        assert_eq!(shell.code(), Some("SESSION_NOT_FOUND"));
    }

    #[test]
    fn mutation_validation_requires_live_owned_session() {
        let exited = validate_session_facts(
            Some("claude"),
            false,
            AutomaticWriteAuthority::ExclusiveInProcess,
            true,
        )
        .unwrap_err();
        assert_eq!(exited.code(), Some("SESSION_NOT_WRITABLE"));

        let lost_lease = validate_session_facts(
            Some("claude"),
            true,
            AutomaticWriteAuthority::Unavailable,
            true,
        )
        .unwrap_err();
        assert_eq!(lost_lease.code(), Some("SESSION_NOT_WRITABLE"));
    }
}
