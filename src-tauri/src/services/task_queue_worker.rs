use std::sync::Arc;
use std::time::Duration;

use cc_cli_adapters::CliToolRegistry;
use cc_panes_core::services::{
    BackendTaskQueueDispatchGateway, SessionStateMachine, TaskQueueDispatchGateway,
    TaskQueueDispatchOutcome, TaskQueueDispatcher, TaskQueueService,
};
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, watch};
use tracing::{debug, warn};

use crate::commands::task_queue_snapshot_for_session;
use crate::services::{LaunchHistoryService, TerminalBackendState};
use crate::utils::AppResult;

const LEVEL_SCAN_INTERVAL: Duration = Duration::from_secs(3);
const LEVEL_SCAN_BATCH_SIZE: usize = 64;
const TASK_QUEUE_UPDATED_EVENT: &str = "task-queue-updated";

enum WorkerCommand {
    Session(String),
    Scan,
}

struct DynamicTaskQueueGateway {
    terminal_backend: Arc<TerminalBackendState>,
    state_machine: Arc<SessionStateMachine>,
}

impl DynamicTaskQueueGateway {
    fn current(&self) -> BackendTaskQueueDispatchGateway {
        BackendTaskQueueDispatchGateway::new(
            self.terminal_backend.backend(),
            self.state_machine.clone(),
        )
    }
}

impl TaskQueueDispatchGateway for DynamicTaskQueueGateway {
    fn readiness(
        &self,
        session_id: &str,
    ) -> AppResult<cc_panes_core::services::TaskQueueReadiness> {
        self.current().readiness(session_id)
    }

    fn submit_text(
        &self,
        session_id: &str,
        prompt: &str,
    ) -> Result<(), cc_panes_core::services::TaskQueueSubmitFailure> {
        self.current().submit_text(session_id, prompt)
    }

    fn mark_submit_started(&self, session_id: &str) {
        self.state_machine.mark_automatic_submit_started(session_id);
    }
}

pub struct TaskQueueWorker {
    command_tx: mpsc::Sender<WorkerCommand>,
    stop_tx: watch::Sender<bool>,
}

impl TaskQueueWorker {
    #[allow(clippy::too_many_arguments)]
    pub fn start(
        app: AppHandle,
        service: Arc<TaskQueueService>,
        terminal_backend: Arc<TerminalBackendState>,
        state_machine: Arc<SessionStateMachine>,
        launch_history: Arc<LaunchHistoryService>,
        registry: Arc<CliToolRegistry>,
    ) -> AppResult<Arc<Self>> {
        let now = now_millis();
        let recovered = service.repository().recover_inflight(now)?;
        if recovered > 0 {
            warn!(
                recovered,
                "task queue recovered interrupted dispatches as unknown"
            );
        }
        let active_sessions = service.repository().active_session_ids()?;
        for session_id in &active_sessions {
            state_machine.register_for_automatic_submit(session_id);
        }

        let gateway = Arc::new(DynamicTaskQueueGateway {
            terminal_backend: terminal_backend.clone(),
            state_machine: state_machine.clone(),
        });
        let dispatcher = Arc::new(TaskQueueDispatcher::new(service.clone(), gateway));
        let (command_tx, command_rx) = mpsc::channel(256);
        let (stop_tx, stop_rx) = watch::channel(false);

        tauri::async_runtime::spawn(run_worker(
            app,
            service,
            terminal_backend,
            state_machine,
            launch_history,
            registry,
            dispatcher,
            command_rx,
            stop_rx,
        ));

        let worker = Arc::new(Self {
            command_tx,
            stop_tx,
        });
        worker.schedule_all();
        Ok(worker)
    }

    pub fn schedule(&self, session_id: impl Into<String>) {
        let _ = self
            .command_tx
            .try_send(WorkerCommand::Session(session_id.into()));
    }

    pub fn schedule_all(&self) {
        let _ = self.command_tx.try_send(WorkerCommand::Scan);
    }

    pub fn stop(&self) {
        let _ = self.stop_tx.send(true);
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_worker(
    app: AppHandle,
    service: Arc<TaskQueueService>,
    terminal_backend: Arc<TerminalBackendState>,
    state_machine: Arc<SessionStateMachine>,
    launch_history: Arc<LaunchHistoryService>,
    registry: Arc<CliToolRegistry>,
    dispatcher: Arc<TaskQueueDispatcher>,
    mut command_rx: mpsc::Receiver<WorkerCommand>,
    mut stop_rx: watch::Receiver<bool>,
) {
    let mut transitions = state_machine.subscribe_transitions();
    let mut ticker = tokio::time::interval(LEVEL_SCAN_INTERVAL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut scan_cursor = 0;

    loop {
        tokio::select! {
            changed = stop_rx.changed() => {
                if changed.is_err() || *stop_rx.borrow() {
                    break;
                }
            }
            command = command_rx.recv() => {
                match command {
                    Some(WorkerCommand::Session(session_id)) => {
                        state_machine.register_for_automatic_submit(&session_id);
                        dispatch_and_publish(
                            &app,
                            &service,
                            &terminal_backend,
                            &launch_history,
                            &registry,
                            &dispatcher,
                            session_id,
                        ).await;
                    }
                    Some(WorkerCommand::Scan) => {
                        scan_active_sessions(
                            &app,
                            &service,
                            &terminal_backend,
                            &state_machine,
                            &launch_history,
                            &registry,
                            &dispatcher,
                            &mut scan_cursor,
                        ).await;
                    }
                    None => break,
                }
            }
            transition = transitions.recv() => {
                match transition {
                    Ok(transition) => {
                        dispatch_and_publish(
                            &app,
                            &service,
                            &terminal_backend,
                            &launch_history,
                            &registry,
                            &dispatcher,
                            transition.pty_session_id,
                        ).await;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                        warn!(skipped, "task queue transition listener lagged; running level scan");
                        scan_active_sessions(
                            &app,
                            &service,
                            &terminal_backend,
                            &state_machine,
                            &launch_history,
                            &registry,
                            &dispatcher,
                            &mut scan_cursor,
                        ).await;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
            _ = ticker.tick() => {
                scan_active_sessions(
                    &app,
                    &service,
                    &terminal_backend,
                    &state_machine,
                    &launch_history,
                    &registry,
                    &dispatcher,
                    &mut scan_cursor,
                ).await;
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn scan_active_sessions(
    app: &AppHandle,
    service: &Arc<TaskQueueService>,
    terminal_backend: &Arc<TerminalBackendState>,
    state_machine: &Arc<SessionStateMachine>,
    launch_history: &Arc<LaunchHistoryService>,
    registry: &Arc<CliToolRegistry>,
    dispatcher: &Arc<TaskQueueDispatcher>,
    cursor: &mut usize,
) {
    let service_for_query = service.clone();
    let sessions = match tauri::async_runtime::spawn_blocking(move || {
        service_for_query.repository().active_session_ids()
    })
    .await
    {
        Ok(Ok(sessions)) => sessions,
        Ok(Err(error)) => {
            warn!(error = %error, "task queue level scan query failed");
            return;
        }
        Err(error) => {
            warn!(error = %error, "task queue level scan task failed");
            return;
        }
    };

    for session_id in next_scan_batch(&sessions, cursor, LEVEL_SCAN_BATCH_SIZE) {
        state_machine.register_for_automatic_submit(&session_id);
        dispatch_and_publish(
            app,
            service,
            terminal_backend,
            launch_history,
            registry,
            dispatcher,
            session_id,
        )
        .await;
    }
}

#[allow(clippy::too_many_arguments)]
async fn dispatch_and_publish(
    app: &AppHandle,
    service: &Arc<TaskQueueService>,
    terminal_backend: &Arc<TerminalBackendState>,
    launch_history: &Arc<LaunchHistoryService>,
    registry: &Arc<CliToolRegistry>,
    dispatcher: &Arc<TaskQueueDispatcher>,
    session_id: String,
) {
    let dispatcher = dispatcher.clone();
    let dispatch_session_id = session_id.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        dispatcher.check_session(&dispatch_session_id, now_millis())
    })
    .await;
    let outcome = match outcome {
        Ok(Ok(outcome)) => outcome,
        Ok(Err(error)) => {
            debug!(session_id = %session_id, error = %error, "task queue dispatch check failed");
            return;
        }
        Err(error) => {
            warn!(session_id = %session_id, error = %error, "task queue dispatch task failed");
            return;
        }
    };
    if matches!(outcome, TaskQueueDispatchOutcome::Noop) {
        return;
    }

    let service = service.clone();
    let terminal_backend = terminal_backend.clone();
    let launch_history = launch_history.clone();
    let registry = registry.clone();
    let snapshot_session_id = session_id.clone();
    let snapshot = tauri::async_runtime::spawn_blocking(move || {
        task_queue_snapshot_for_session(
            &service,
            &terminal_backend,
            &launch_history,
            &registry,
            &snapshot_session_id,
            false,
        )
    })
    .await;
    match snapshot {
        Ok(Ok(snapshot)) => {
            if let Err(error) = app.emit(TASK_QUEUE_UPDATED_EVENT, snapshot) {
                debug!(session_id = %session_id, error = %error, "task queue event emit failed");
            }
        }
        Ok(Err(error)) => {
            debug!(session_id = %session_id, error = %error, "task queue snapshot refresh failed");
        }
        Err(error) => {
            warn!(session_id = %session_id, error = %error, "task queue snapshot task failed");
        }
    }
}

fn next_scan_batch(sessions: &[String], cursor: &mut usize, limit: usize) -> Vec<String> {
    if sessions.is_empty() || limit == 0 {
        *cursor = 0;
        return Vec::new();
    }
    *cursor %= sessions.len();
    let count = sessions.len().min(limit);
    let batch = (0..count)
        .map(|offset| sessions[(*cursor + offset) % sessions.len()].clone())
        .collect();
    *cursor = (*cursor + count) % sessions.len();
    batch
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::{next_scan_batch, LEVEL_SCAN_INTERVAL};

    #[test]
    fn level_scan_matches_reference_watchdog_interval() {
        assert_eq!(LEVEL_SCAN_INTERVAL, std::time::Duration::from_secs(3));
    }

    #[test]
    fn bounded_scan_rotates_without_starving_tail_sessions() {
        let sessions = (0..5)
            .map(|index| format!("pty-{index}"))
            .collect::<Vec<_>>();
        let mut cursor = 0;

        assert_eq!(
            next_scan_batch(&sessions, &mut cursor, 2),
            vec!["pty-0", "pty-1"]
        );
        assert_eq!(
            next_scan_batch(&sessions, &mut cursor, 2),
            vec!["pty-2", "pty-3"]
        );
        assert_eq!(
            next_scan_batch(&sessions, &mut cursor, 2),
            vec!["pty-4", "pty-0"]
        );
    }
}
