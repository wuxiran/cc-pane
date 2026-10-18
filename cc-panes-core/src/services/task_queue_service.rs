use crate::models::task_queue::{
    PermissionDecisionStatus, TaskQueueControlPatch, TaskQueueItemDraft, TaskQueueSnapshot,
};
use crate::repository::TaskQueueRepository;
use crate::services::{AutomaticWriteAuthority, TerminalBackend};
use crate::utils::error::{AppError, AppResult};
use cc_cli_adapters::{ClaudeAdapter, CliToolAdapter};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

#[path = "task_queue_service/images.rs"]
mod images;
pub use images::{TASK_QUEUE_IMAGE_RETENTION, TASK_QUEUE_IMAGE_STORAGE_MAX_BYTES};

pub const TASK_QUEUE_IMAGE_MAX_BYTES: u64 = 20 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnattendedPermissionDecision {
    AllowNew,
    AllowExisting,
    NoDecision,
}

pub struct TaskQueueService {
    repository: Arc<TaskQueueRepository>,
    image_root: PathBuf,
    trusted_source_root: PathBuf,
    image_lock: Mutex<()>,
}

impl TaskQueueService {
    pub fn new(
        repository: Arc<TaskQueueRepository>,
        image_root: PathBuf,
        trusted_source_root: PathBuf,
    ) -> Self {
        Self {
            repository,
            image_root,
            trusted_source_root,
            image_lock: Mutex::new(()),
        }
    }

    pub fn repository(&self) -> &Arc<TaskQueueRepository> {
        &self.repository
    }

    pub fn snapshot(&self, session_id: &str) -> AppResult<TaskQueueSnapshot> {
        self.repository.snapshot(session_id)
    }

    pub fn set_global_enabled(&self, enabled: bool, now: i64) -> AppResult<()> {
        self.repository.set_global_enabled(enabled, now)?;
        Ok(())
    }

    pub fn authorize_unattended_permission_request(
        &self,
        session_id: &str,
        cli_tool: &str,
        payload: &serde_json::Value,
        backend: &dyn TerminalBackend,
        now: i64,
    ) -> AppResult<UnattendedPermissionDecision> {
        if cli_tool != "claude" {
            return Ok(UnattendedPermissionDecision::NoDecision);
        }
        let request = match ClaudeAdapter::new().validate_permission_request(payload) {
            Ok(request) if request.tool_name != "AskUserQuestion" => request,
            _ => return Ok(UnattendedPermissionDecision::NoDecision),
        };
        let Some(status) = backend.get_session_status(session_id)? else {
            return Ok(UnattendedPermissionDecision::NoDecision);
        };
        if status.status.is_terminal()
            || matches!(
                backend.automatic_write_authority(session_id)?,
                AutomaticWriteAuthority::Unavailable
            )
        {
            return Ok(UnattendedPermissionDecision::NoDecision);
        }

        let fingerprint = permission_request_fingerprint(&request)?;
        let Some(record) = self.repository.record_permission_decision_if_eligible(
            session_id,
            &request.tool_use_id,
            &fingerprint,
            now,
        )?
        else {
            return Ok(UnattendedPermissionDecision::NoDecision);
        };
        Ok(match record.status {
            PermissionDecisionStatus::Inserted if record.decision.as_deref() == Some("allow") => {
                UnattendedPermissionDecision::AllowNew
            }
            PermissionDecisionStatus::Existing if record.decision.as_deref() == Some("allow") => {
                UnattendedPermissionDecision::AllowExisting
            }
            _ => UnattendedPermissionDecision::NoDecision,
        })
    }

    pub fn add_item(
        &self,
        session_id: &str,
        draft: &TaskQueueItemDraft,
        now: i64,
    ) -> AppResult<TaskQueueSnapshot> {
        let _guard = self
            .image_lock
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let draft = draft.validated()?;
        let mut unique_refs = HashSet::new();
        for image_ref in &draft.image_refs {
            if !unique_refs.insert(image_ref.as_str()) {
                return Err(AppError::coded(
                    "IMAGE_REF_INVALID",
                    "A staged image may appear only once in a task",
                ));
            }
            self.resolve_image_ref(session_id, image_ref)?;
        }
        self.repository.add_item(session_id, &draft, now)
    }

    pub fn delete_item(
        &self,
        session_id: &str,
        item_id: &str,
        now: i64,
    ) -> AppResult<TaskQueueSnapshot> {
        // A delivery-unknown item may already be in use by the CLI. Cancellation only
        // removes the queue reference; session exit or retention cleanup releases files.
        self.repository.delete_item(session_id, item_id, now)
    }

    pub fn clear_queue(&self, session_id: &str, now: i64) -> AppResult<TaskQueueSnapshot> {
        self.repository.clear_queue(session_id, now)
    }

    pub fn update_control(
        &self,
        session_id: &str,
        patch: &TaskQueueControlPatch,
        now: i64,
    ) -> AppResult<TaskQueueSnapshot> {
        self.repository.update_control(session_id, patch, now)
    }

    pub fn retry_item(
        &self,
        session_id: &str,
        item_id: &str,
        now: i64,
    ) -> AppResult<TaskQueueSnapshot> {
        self.repository.retry_item(session_id, item_id, now)
    }

    pub fn complete_claim(
        &self,
        session_id: &str,
        item_id: &str,
        token: &str,
        now: i64,
    ) -> AppResult<bool> {
        // PTY submission acknowledges bytes, not attachment consumption. Keep the
        // image lease established by effective_prompt until session exit or expiry.
        self.repository
            .complete_claim(session_id, item_id, token, now)
    }
}

fn permission_request_fingerprint(
    request: &cc_cli_adapters::StructuredPermissionRequest,
) -> AppResult<String> {
    let bytes = serde_json::to_vec(request).map_err(|error| {
        AppError::from(format!("Failed to fingerprint permission request: {error}"))
    })?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

#[cfg(test)]
mod unattended_responder_tests {
    use super::*;
    use crate::models::task_queue::{TaskQueueControlPatch, TaskQueueItemDraft};
    use crate::models::{CreateSessionRequest, TerminalReplaySnapshot};
    use crate::repository::Database;
    use crate::services::terminal_service::{SessionOutput, SessionStatus};
    use crate::services::{AutomaticWriteAuthority, SessionStatusInfo, TerminalBackend};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Mutex;

    struct PermissionBackend {
        live: AtomicBool,
        authority: Mutex<AutomaticWriteAuthority>,
        submit_calls: AtomicUsize,
    }

    impl PermissionBackend {
        fn writable() -> Self {
            Self {
                live: AtomicBool::new(true),
                authority: Mutex::new(AutomaticWriteAuthority::ExclusiveInProcess),
                submit_calls: AtomicUsize::new(0),
            }
        }

        fn set_live(&self, live: bool) {
            self.live.store(live, Ordering::SeqCst);
        }

        fn set_authority(&self, authority: AutomaticWriteAuthority) {
            *self.authority.lock().unwrap() = authority;
        }

        fn submit_count(&self) -> usize {
            self.submit_calls.load(Ordering::SeqCst)
        }
    }

    impl TerminalBackend for PermissionBackend {
        fn create_session(&self, _request: CreateSessionRequest) -> AppResult<String> {
            Err(AppError::from("not used by unattended responder tests"))
        }

        fn write(&self, _session_id: &str, _data: &str) -> AppResult<()> {
            Ok(())
        }

        fn submit_text_to_session(&self, _session_id: &str, _text: &str) -> AppResult<()> {
            self.submit_calls.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }

        fn resize(&self, _session_id: &str, _cols: u16, _rows: u16) -> AppResult<()> {
            Ok(())
        }

        fn kill(&self, _session_id: &str) -> AppResult<()> {
            Ok(())
        }

        fn get_all_status(&self) -> AppResult<Vec<SessionStatusInfo>> {
            Ok(self.get_session_status("pty-1")?.into_iter().collect())
        }

        fn get_session_status(&self, session_id: &str) -> AppResult<Option<SessionStatusInfo>> {
            if session_id != "pty-1" || !self.live.load(Ordering::SeqCst) {
                return Ok(None);
            }
            Ok(Some(SessionStatusInfo {
                session_id: session_id.to_string(),
                status: SessionStatus::WaitingInput,
                last_output_at: 0,
                pid: Some(42),
                exit_code: None,
                current_tool_name: Some("Bash".to_string()),
                current_tool_use_id: Some("tool-1".to_string()),
                current_tool_summary: None,
                updated_at: 0,
                osc_progress: None,
                resource_policy: None,
                job_memory_warning: None,
                runtime_kind: None,
                wsl_distro: None,
                heavy_queue: None,
            }))
        }

        fn get_session_output(&self, session_id: &str, _lines: usize) -> AppResult<SessionOutput> {
            Ok(SessionOutput {
                exited: None,
                retained: None,
                session_id: session_id.to_string(),
                lines: Vec::new(),
            })
        }

        fn get_session_replay_snapshot(
            &self,
            _session_id: &str,
        ) -> AppResult<Option<TerminalReplaySnapshot>> {
            Ok(None)
        }

        fn automatic_write_authority(
            &self,
            _session_id: &str,
        ) -> AppResult<AutomaticWriteAuthority> {
            Ok(self.authority.lock().unwrap().clone())
        }
    }

    struct Fixture {
        service: TaskQueueService,
        backend: PermissionBackend,
        _image_root: tempfile::TempDir,
        _trusted_root: tempfile::TempDir,
    }

    fn fixture(with_item: bool, unattended: bool) -> Fixture {
        let repository = Arc::new(TaskQueueRepository::new(Arc::new(
            Database::new_fallback().expect("database"),
        )));
        let image_root = tempfile::tempdir().expect("image root");
        let trusted_root = tempfile::tempdir().expect("trusted root");
        let service = TaskQueueService::new(
            repository,
            image_root.path().to_path_buf(),
            trusted_root.path().to_path_buf(),
        );
        if with_item {
            service
                .add_item(
                    "pty-1",
                    &TaskQueueItemDraft::new("queued follow-up", vec![]).unwrap(),
                    1,
                )
                .unwrap();
        }
        if unattended {
            service
                .update_control(
                    "pty-1",
                    &TaskQueueControlPatch {
                        paused: None,
                        unattended: Some(true),
                    },
                    2,
                )
                .unwrap();
        }
        Fixture {
            service,
            backend: PermissionBackend::writable(),
            _image_root: image_root,
            _trusted_root: trusted_root,
        }
    }

    fn permission_payload(command: &str) -> serde_json::Value {
        serde_json::json!({
            "hook_event_name": "PermissionRequest",
            "tool_use_id": "tool-1",
            "tool_name": "Bash",
            "tool_input": { "command": command }
        })
    }

    #[test]
    fn unattended_responder_allows_exact_claude_request_idempotently_without_terminal_submit() {
        let fixture = fixture(true, true);
        let payload = permission_payload("cargo test");

        let first = fixture
            .service
            .authorize_unattended_permission_request(
                "pty-1",
                "claude",
                &payload,
                &fixture.backend,
                10,
            )
            .unwrap();
        let duplicate = fixture
            .service
            .authorize_unattended_permission_request(
                "pty-1",
                "claude",
                &payload,
                &fixture.backend,
                11,
            )
            .unwrap();

        assert_eq!(first, UnattendedPermissionDecision::AllowNew);
        assert_eq!(duplicate, UnattendedPermissionDecision::AllowExisting);
        assert_eq!(fixture.backend.submit_count(), 0);
    }

    #[test]
    fn unattended_responder_rejects_same_tool_id_with_different_fingerprint() {
        let fixture = fixture(true, true);
        fixture
            .service
            .authorize_unattended_permission_request(
                "pty-1",
                "claude",
                &permission_payload("cargo test"),
                &fixture.backend,
                10,
            )
            .unwrap();

        let mismatch = fixture
            .service
            .authorize_unattended_permission_request(
                "pty-1",
                "claude",
                &permission_payload("cargo publish"),
                &fixture.backend,
                11,
            )
            .unwrap();

        assert_eq!(mismatch, UnattendedPermissionDecision::NoDecision);
        assert_eq!(fixture.backend.submit_count(), 0);
    }

    #[test]
    fn unattended_responder_fail_closed_gates_never_approve_or_submit() {
        for case in [
            "global-disabled",
            "queue-empty",
            "unattended-off",
            "lease-lost",
            "session-missing",
            "non-claude",
        ] {
            let with_item = case != "queue-empty";
            let unattended = case != "unattended-off";
            let fixture = fixture(with_item, unattended);
            if case == "global-disabled" {
                fixture.service.set_global_enabled(false, 3).unwrap();
            }
            if case == "lease-lost" {
                fixture
                    .backend
                    .set_authority(AutomaticWriteAuthority::Unavailable);
            }
            if case == "session-missing" {
                fixture.backend.set_live(false);
            }
            let cli_tool = if case == "non-claude" {
                "codex"
            } else {
                "claude"
            };

            let decision = fixture
                .service
                .authorize_unattended_permission_request(
                    "pty-1",
                    cli_tool,
                    &permission_payload("cargo test"),
                    &fixture.backend,
                    10,
                )
                .unwrap();

            assert_eq!(decision, UnattendedPermissionDecision::NoDecision, "{case}");
            assert_eq!(fixture.backend.submit_count(), 0, "{case}");
        }
    }

    #[test]
    fn unattended_responder_rejects_notification_and_malformed_payloads() {
        let invalid_payloads = [
            serde_json::json!({
                "hook_event_name": "Notification",
                "tool_use_id": "tool-1",
                "tool_name": "Bash",
                "tool_input": {}
            }),
            serde_json::json!({
                "hook_event_name": "PermissionRequest",
                "tool_name": "Bash",
                "tool_input": {}
            }),
            serde_json::json!({
                "hook_event_name": "PermissionRequest",
                "tool_use_id": "tool-1",
                "tool_name": "AskUserQuestion",
                "tool_input": null
            }),
        ];

        for payload in invalid_payloads {
            let fixture = fixture(true, true);
            let decision = fixture
                .service
                .authorize_unattended_permission_request(
                    "pty-1",
                    "claude",
                    &payload,
                    &fixture.backend,
                    10,
                )
                .unwrap();
            assert_eq!(decision, UnattendedPermissionDecision::NoDecision);
            assert_eq!(fixture.backend.submit_count(), 0);
        }
    }
}
