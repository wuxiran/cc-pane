//! Durable turn admission/completion and repository checkpoints share one run ID.
use super::journal::{RunJournal, RunRecord};
use super::*;
use crate::commands::turn_checkpoint_commands::run_checkpoint_job;
use cc_panes_core::services::TurnCheckpointService;

pub(super) struct ActiveRun {
    id: String,
    checkpoint_id: String,
    cancel_requested: bool,
    interrupted: bool,
}

impl AcpChatSession {
    pub(super) async fn begin_recorded_turn(
        &self,
        session_id: &str,
        blocks: &[Value],
    ) -> AppResult<()> {
        let id = uuid::Uuid::new_v4().to_string();
        let service = self.checkpoints.clone();
        let chat = self.chat_id.clone();
        let turn_id = id.clone();
        let cwd = self.cwd.clone();
        let checkpoint = run_checkpoint_job(move || service.begin(&chat, &turn_id, &cwd)).await?;
        let snapshot = self.snapshot().await;
        let record = RunRecord {
            id: id.clone(),
            chat_id: self.chat_id.clone(),
            engine_id: snapshot.engine_id,
            acp_session_id: session_id.into(),
            cwd: self.cwd.to_string_lossy().into(),
            started_at: super::unix_millis(),
            finished_at: None,
            status: "running".into(),
            checkpoint_id: Some(checkpoint.id.clone()),
            recording_error: None,
            event_count: 0,
        };
        if let Err(error) = self.journal.begin(record, &json!({"prompt":blocks})).await {
            let service = self.checkpoints.clone();
            let checkpoint_id = checkpoint.id;
            let _ = run_checkpoint_job(move || service.finish(&checkpoint_id, "failed")).await;
            return Err(error);
        }
        let interrupted = self.snapshot.read().await.phase != AcpChatPhase::Generating;
        *self.active_run.lock().unwrap_or_else(|p| p.into_inner()) = Some(ActiveRun {
            id,
            checkpoint_id: checkpoint.id,
            cancel_requested: false,
            interrupted,
        });
        Ok(())
    }

    pub(super) fn record_event(&self, kind: &str, payload: &Value) {
        if let Some(run) = self
            .active_run
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_ref()
        {
            self.journal.event(&run.id, kind, payload);
        }
    }

    pub(super) fn recorded_run_id(&self) -> Option<String> {
        self.active_run
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_ref()
            .map(|run| run.id.clone())
    }

    pub(super) fn mark_run_cancel_requested(&self) {
        if let Some(run) = self
            .active_run
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_mut()
        {
            run.cancel_requested = true;
        }
    }

    pub(super) fn mark_run_interrupted(&self) {
        if let Some(run) = self
            .active_run
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_mut()
        {
            run.interrupted = true;
        }
    }

    /// Caller holds turn_control and has observed prompt completion or terminated
    /// the adapter and its tools. Merely sending session/cancel is not completion.
    pub(super) async fn finish_recorded_turn(&self, status: &str) {
        let _writes = self.client_writes.write().await;
        let active = self
            .active_run
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take();
        let Some(run) = active else { return };
        let outcome = if run.cancel_requested {
            "cancelled"
        } else if run.interrupted {
            "interrupted"
        } else {
            status
        }
        .to_string();
        let service = self.checkpoints.clone();
        let checkpoint_id = run.checkpoint_id.clone();
        let finish_status = outcome.clone();
        let background = self.terminals.has_running().await;
        if let Err(error) = run_checkpoint_job(move || {
            if background { service.finish_unavailable(&checkpoint_id, &finish_status, "Managed background commands are still running; this checkpoint cannot be restored") }
            else { service.finish(&checkpoint_id, &finish_status) }
        }).await {
            self.journal.event(&run.id,"recording_notice", &json!({"error":format!("Checkpoint finalization failed: {error}")}));
            self.emit("notice",json!({"message":format!("Checkpoint finalization failed: {error}")}));
        }
        match self
            .journal
            .finish(run.id, outcome, Some(run.checkpoint_id))
            .await
        {
            Ok(Some(error)) => self.emit("notice", json!({"message":error})),
            Ok(None) => {}
            Err(error) => {
                self.emit("notice", json!({"message":error.to_string()}));
                tracing::error!(%error, "Agent run history finalization failed");
            }
        }
    }
}

impl AcpChatService {
    pub async fn has_background_tools_in(&self, repository: &Path) -> bool {
        let sessions: Vec<_> = self.sessions.read().await.values().cloned().collect();
        for session in sessions {
            if session.terminals.has_running_in(repository).await {
                return true;
            }
        }
        false
    }
    pub async fn list_run_records(
        &self,
        filter: journal::RunFilter,
    ) -> AppResult<journal::RunPage> {
        self.journal.list(filter).await
    }
    pub async fn read_run_events(&self, id: String, after: u64) -> AppResult<journal::EventPage> {
        self.journal.read(id, after).await
    }
    pub fn checkpoint_service(&self) -> Arc<TurnCheckpointService> {
        self.checkpoints.clone()
    }
    pub(super) fn create_journal(chats_dir: &Path) -> RunJournal {
        RunJournal::new(chats_dir.join("runtime-records"))
    }
}
