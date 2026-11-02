use crate::services::{
    LaunchHistoryService, SessionStatusInfo, TerminalBackend, TerminalBackendState,
};
use crate::utils::{AppError, AppResult};
use cc_panes_core::models::turn_checkpoint::*;
use cc_panes_core::repository::LaunchRecord;
use cc_panes_core::services::TurnCheckpointService;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use tauri::State;

/// Also used by ACP lifecycle hooks. The permit stays with the blocking worker
/// if its caller is cancelled, so abandoned requests cannot bypass the bound.
pub(crate) async fn run_checkpoint_job<T: Send + 'static>(
    operation: impl FnOnce() -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    static GATE: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
    let permit = GATE
        .get_or_init(|| Arc::new(tokio::sync::Semaphore::new(2)))
        .clone()
        .acquire_owned()
        .await
        .map_err(|error| AppError::from(error.to_string()))?;
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        operation()
    })
    .await
    .map_err(|error| AppError::from(error.to_string()))?
}

#[tauri::command]
pub async fn list_turn_checkpoints(
    service: State<'_, Arc<TurnCheckpointService>>,
    chat_id: String,
) -> AppResult<Vec<TurnCheckpointRecord>> {
    let service = service.inner().clone();
    run_checkpoint_job(move || service.list(&chat_id)).await
}

#[tauri::command]
pub async fn review_turn_checkpoint(
    service: State<'_, Arc<TurnCheckpointService>>,
    terminals: State<'_, Arc<TerminalBackendState>>,
    history: State<'_, Arc<LaunchHistoryService>>,
    id: String,
) -> AppResult<TurnCheckpointReview> {
    let service = service.inner().clone();
    let backend = terminals.backend();
    let history = history.inner().clone();
    run_checkpoint_job(move || {
        let mut review = service.review(&id)?;
        if review.can_restore {
            if let Err(error) =
                ensure_no_live_cli_in(&*backend, &history, Path::new(&review.record.cwd))
            {
                review.can_restore = false;
                review.blocked_reason = Some(error.to_string());
            }
        }
        Ok(review)
    })
    .await
}

#[tauri::command]
pub async fn begin_cli_turn_checkpoint(
    service: State<'_, Arc<TurnCheckpointService>>,
    terminals: State<'_, Arc<TerminalBackendState>>,
    history: State<'_, Arc<LaunchHistoryService>>,
    session_id: String,
) -> AppResult<TurnCheckpointRecord> {
    let service = service.inner().clone();
    let backend = terminals.backend();
    let history = history.inner().clone();
    run_checkpoint_job(move || {
        let status = backend
            .get_session_status(&session_id)?
            .filter(|status| status.session_id == session_id && !status.status.is_terminal())
            .ok_or_else(|| AppError::from("CLI session is no longer running"))?;
        if status.runtime_kind.as_deref() != Some("local") {
            return Err("Turn recording requires a verified local CLI session; remote or legacy sessions are unavailable".into());
        }
        let cwd = cli_recording_directory(&history, &session_id)?;
        service.begin_cli(&session_id, &cwd)
    })
    .await
}

#[tauri::command]
pub async fn finish_cli_turn_checkpoint(
    service: State<'_, Arc<TurnCheckpointService>>,
    session_id: String,
    id: String,
) -> AppResult<TurnCheckpointRecord> {
    let service = service.inner().clone();
    // The saved before snapshot determines cwd, even if the PTY has exited.
    // Never accept a replacement directory from a tab that may have switched.
    run_checkpoint_job(move || service.finish_cli(&session_id, &id)).await
}

#[tauri::command]
pub async fn restore_turn_checkpoint(
    service: State<'_, Arc<TurnCheckpointService>>,
    chats: State<'_, Arc<crate::services::AcpChatService>>,
    terminals: State<'_, Arc<TerminalBackendState>>,
    history: State<'_, Arc<LaunchHistoryService>>,
    id: String,
    revision: String,
) -> AppResult<RestoreTurnCheckpointResult> {
    let probe = service.inner().clone();
    let probe_id = id.clone();
    let review = run_checkpoint_job(move || probe.review(&probe_id)).await?;
    if chats
        .has_background_tools_in(std::path::Path::new(&review.record.cwd))
        .await
    {
        return Err(AppError::coded(
            "CHECKPOINT_BACKGROUND_TOOLS",
            "Stop managed background commands in this repository before restoring a checkpoint",
        ));
    }
    let service = service.inner().clone();
    let backend = terminals.backend();
    let history = history.inner().clone();
    run_checkpoint_job(move || {
        ensure_no_live_cli_in(&*backend, &history, Path::new(&review.record.cwd))?;
        service.restore(&id, &revision)
    })
    .await
}

fn cli_recording_directory(history: &LaunchHistoryService, session_id: &str) -> AppResult<PathBuf> {
    let record = history
        .find_by_pty_session_id(session_id)
        .map_err(AppError::from)?
        .ok_or_else(|| {
            AppError::from("CLI launch directory is unavailable; no recording was started")
        })?;
    recording_directory(&record, session_id)
}

fn recording_directory(record: &LaunchRecord, session_id: &str) -> AppResult<PathBuf> {
    if record.pty_session_id.as_deref() != Some(session_id) || record.runtime_kind != "local" {
        return Err("CLI launch metadata does not match a local session".into());
    }
    let cwd = record
        .launch_cwd
        .as_deref()
        .or(record.workspace_path.as_deref())
        .unwrap_or(&record.project_path);
    let path = PathBuf::from(cwd);
    if !path.is_absolute() || cwd.chars().any(char::is_control) {
        return Err("CLI launch directory is invalid".into());
    }
    Ok(path)
}

fn ensure_no_live_cli_in(
    backend: &dyn TerminalBackend,
    history: &LaunchHistoryService,
    cwd: &Path,
) -> AppResult<()> {
    ensure_no_live_cli_sessions_in(backend.get_all_status()?, history, cwd)
}

fn ensure_no_live_cli_sessions_in(
    statuses: Vec<SessionStatusInfo>,
    history: &LaunchHistoryService,
    cwd: &Path,
) -> AppResult<()> {
    let root = dunce::canonicalize(cwd).map_err(AppError::from)?;
    for status in statuses {
        if status.status.is_terminal() || status.runtime_kind.as_deref() == Some("ssh") {
            continue;
        }
        // A WSL terminal can write this Windows checkout through /mnt/c or a
        // UNC mount. Without a verified path mapping, treating it as remote
        // would silently bypass the live-writer guard.
        if status.runtime_kind.as_deref() == Some("wsl") {
            return Err(AppError::coded(
                "CHECKPOINT_WSL_CLI",
                "Close WSL CLI terminals before restoring; their mapping to local files cannot be verified",
            ));
        }
        let directory = cli_recording_directory(history, &status.session_id)?;
        let directory = dunce::canonicalize(directory).map_err(AppError::from)?;
        if directory.starts_with(&root) || root.starts_with(&directory) {
            return Err(AppError::coded(
                "CHECKPOINT_LIVE_CLI",
                "Close CLI terminals in this repository before restoring; idle status cannot prove background processes have stopped",
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use cc_panes_core::repository::{Database, HistoryRepository};

    fn record(root: &Path) -> LaunchRecord {
        serde_json::from_value(serde_json::json!({
            "id": 1, "projectId": "launch-one", "projectName": "fixture",
            "projectPath": root.join("project"), "launchedAt": "2026-01-01T00:00:00Z",
            "ptySessionId": "pty-one", "cliTool": "codex", "runtimeKind": "local",
            "workspacePath": root.join("workspace"), "launchCwd": root.join("worktree"),
        }))
        .unwrap()
    }

    fn status(state: &str, runtime: &str) -> SessionStatusInfo {
        serde_json::from_value(serde_json::json!({
            "sessionId": "pty-one", "status": state, "runtimeKind": runtime,
            "lastOutputAt": 0, "updatedAt": 0,
        }))
        .unwrap()
    }

    #[test]
    fn manual_recording_resolves_exact_launch_directory_before_workspace_and_project() {
        let root = tempfile::tempdir().unwrap();
        let mut launch = record(root.path());
        assert_eq!(
            recording_directory(&launch, "pty-one").unwrap(),
            root.path().join("worktree")
        );
        launch.launch_cwd = None;
        assert_eq!(
            recording_directory(&launch, "pty-one").unwrap(),
            root.path().join("workspace")
        );
        launch.workspace_path = None;
        assert_eq!(
            recording_directory(&launch, "pty-one").unwrap(),
            root.path().join("project")
        );
    }

    #[test]
    fn manual_recording_rejects_wrong_session_remote_runtime_and_relative_paths() {
        let root = tempfile::tempdir().unwrap();
        let mut launch = record(root.path());
        assert!(recording_directory(&launch, "pty-other").is_err());
        launch.runtime_kind = "ssh".into();
        assert!(recording_directory(&launch, "pty-one").is_err());
        launch.runtime_kind = "local".into();
        launch.launch_cwd = Some("relative/worktree".into());
        assert!(recording_directory(&launch, "pty-one").is_err());
    }

    #[test]
    fn idle_local_cli_blocks_restore_while_exited_remote_and_other_repos_do_not() {
        let root = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let db = Arc::new(Database::new_fallback().unwrap());
        let history = LaunchHistoryService::new(Arc::new(HistoryRepository::new(db)));
        history
            .add_with_pty_session(
                "launch-one",
                "fixture",
                root.path().to_str().unwrap(),
                "pty-one",
                "codex",
                "local",
                None,
                None,
                None,
                Some(root.path().to_str().unwrap()),
                None,
                None,
                None,
                None,
                None,
            )
            .unwrap();
        let error =
            ensure_no_live_cli_sessions_in(vec![status("idle", "local")], &history, root.path())
                .unwrap_err();
        assert_eq!(error.code(), Some("CHECKPOINT_LIVE_CLI"));
        assert!(ensure_no_live_cli_sessions_in(
            vec![status("exited", "local")],
            &history,
            root.path()
        )
        .is_ok());
        assert!(ensure_no_live_cli_sessions_in(
            vec![status("thinking", "ssh")],
            &history,
            root.path()
        )
        .is_ok());
        let wsl =
            ensure_no_live_cli_sessions_in(vec![status("idle", "wsl")], &history, root.path())
                .unwrap_err();
        assert_eq!(wsl.code(), Some("CHECKPOINT_WSL_CLI"));
        assert!(ensure_no_live_cli_sessions_in(
            vec![status("exited", "wsl")],
            &history,
            root.path(),
        )
        .is_ok());
        assert!(ensure_no_live_cli_sessions_in(
            vec![status("idle", "local")],
            &history,
            other.path()
        )
        .is_ok());
        let mut unknown = status("idle", "local");
        unknown.session_id = "unknown-session".into();
        assert!(ensure_no_live_cli_sessions_in(vec![unknown], &history, root.path()).is_err());
    }
}
