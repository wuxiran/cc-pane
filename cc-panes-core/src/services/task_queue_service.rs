use crate::models::task_queue::{
    PermissionDecisionStatus, StagedTaskQueueImage, TaskQueueControlPatch, TaskQueueItem,
    TaskQueueItemDraft, TaskQueueSnapshot,
};
use crate::repository::TaskQueueRepository;
use crate::services::{AutomaticWriteAuthority, TerminalBackend};
use crate::utils::error::{AppError, AppResult};
use cc_cli_adapters::{ClaudeAdapter, CliToolAdapter};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::File;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use uuid::Uuid;

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
        let before = self.repository.snapshot(session_id)?;
        let image_refs = before
            .items
            .iter()
            .find(|item| item.id == item_id)
            .map(|item| item.image_refs.clone())
            .unwrap_or_default();
        let snapshot = self.repository.delete_item(session_id, item_id, now)?;
        self.remove_images(session_id, &image_refs);
        Ok(snapshot)
    }

    pub fn clear_queue(&self, session_id: &str, now: i64) -> AppResult<TaskQueueSnapshot> {
        let before = self.repository.snapshot(session_id)?;
        let snapshot = self.repository.clear_queue(session_id, now)?;
        let retained: HashSet<&str> = snapshot
            .items
            .iter()
            .flat_map(|item| item.image_refs.iter().map(String::as_str))
            .collect();
        let removed = before
            .items
            .iter()
            .flat_map(|item| item.image_refs.iter())
            .filter(|image_ref| !retained.contains(image_ref.as_str()))
            .cloned()
            .collect::<Vec<_>>();
        self.remove_images(session_id, &removed);
        Ok(snapshot)
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
        let image_refs = self
            .repository
            .snapshot(session_id)?
            .items
            .into_iter()
            .find(|item| item.id == item_id)
            .map(|item| item.image_refs)
            .unwrap_or_default();
        let completed = self
            .repository
            .complete_claim(session_id, item_id, token, now)?;
        if completed {
            self.remove_images(session_id, &image_refs);
        }
        Ok(completed)
    }

    pub fn stage_image(
        &self,
        session_id: &str,
        source: &Path,
        width: u32,
        height: u32,
    ) -> AppResult<StagedTaskQueueImage> {
        if width == 0 || height == 0 {
            return Err(image_error("Clipboard image dimensions must be non-zero"));
        }
        reject_link_or_reparse(source)?;
        let trusted_root = self
            .trusted_source_root
            .canonicalize()
            .map_err(|_| image_error("Trusted clipboard image directory is unavailable"))?;
        let source = source
            .canonicalize()
            .map_err(|_| image_error("Clipboard image is unavailable"))?;
        if !source.starts_with(&trusted_root) {
            return Err(image_error(
                "Clipboard image is outside the trusted directory",
            ));
        }
        let metadata = source
            .metadata()
            .map_err(|_| image_error("Clipboard image metadata is unavailable"))?;
        if !metadata.is_file() || metadata.len() == 0 || metadata.len() > TASK_QUEUE_IMAGE_MAX_BYTES
        {
            return Err(image_error(
                "Clipboard image has an invalid size or file type",
            ));
        }
        let extension = detect_image_extension(&source)?;

        std::fs::create_dir_all(&self.image_root)
            .map_err(|e| stage_error(format!("Failed to create image directory: {e}")))?;
        reject_link_or_reparse(&self.image_root)?;
        let session_dir = self.session_image_dir(session_id);
        std::fs::create_dir_all(&session_dir)
            .map_err(|e| stage_error(format!("Failed to create session image directory: {e}")))?;
        reject_link_or_reparse(&session_dir)?;

        let image_ref = format!("{}.{}", Uuid::new_v4(), extension);
        let destination = session_dir.join(&image_ref);
        let temporary = session_dir.join(format!(".{image_ref}.tmp"));
        let copied = std::fs::copy(&source, &temporary)
            .map_err(|e| stage_error(format!("Failed to stage clipboard image: {e}")))?;
        if copied != metadata.len() {
            let _ = std::fs::remove_file(&temporary);
            return Err(stage_error("Clipboard image copy was incomplete"));
        }
        std::fs::rename(&temporary, &destination).map_err(|e| {
            let _ = std::fs::remove_file(&temporary);
            stage_error(format!("Failed to publish staged clipboard image: {e}"))
        })?;
        self.resolve_image_ref(session_id, &image_ref)?;
        Ok(StagedTaskQueueImage {
            image_ref,
            width,
            height,
        })
    }

    pub fn effective_prompt(&self, session_id: &str, item: &TaskQueueItem) -> AppResult<String> {
        if item.session_id != session_id {
            return Err(AppError::coded(
                "IMAGE_REF_INVALID",
                "Queued task belongs to another terminal session",
            ));
        }
        let paths = item
            .image_refs
            .iter()
            .map(|image_ref| {
                self.resolve_image_ref(session_id, image_ref)
                    .map(|path| path.to_string_lossy().into_owned())
            })
            .collect::<AppResult<Vec<_>>>()?;
        Ok(Self::compose_prompt(&paths, &item.text))
    }

    pub fn compose_prompt(image_paths: &[String], text: &str) -> String {
        let image_part = image_paths.join(" ");
        let text = text.trim();
        match (image_part.is_empty(), text.is_empty()) {
            (false, false) => format!("{image_part}\n{text}"),
            (false, true) => image_part,
            (true, false) => text.to_string(),
            (true, true) => String::new(),
        }
    }

    pub fn resolve_image_ref(&self, session_id: &str, image_ref: &str) -> AppResult<PathBuf> {
        validate_opaque_ref(image_ref)?;
        let session_dir = self.session_image_dir(session_id);
        let canonical_dir = session_dir
            .canonicalize()
            .map_err(|_| image_error("Staged image directory is unavailable"))?;
        reject_link_or_reparse(&canonical_dir)?;
        let path = session_dir.join(image_ref);
        reject_link_or_reparse(&path)?;
        let canonical_path = path
            .canonicalize()
            .map_err(|_| image_error("Staged image reference does not exist"))?;
        if !canonical_path.starts_with(&canonical_dir) {
            return Err(image_error(
                "Staged image reference escapes its session directory",
            ));
        }
        let metadata = canonical_path
            .metadata()
            .map_err(|_| image_error("Staged image metadata is unavailable"))?;
        if !metadata.is_file() || metadata.len() == 0 || metadata.len() > TASK_QUEUE_IMAGE_MAX_BYTES
        {
            return Err(image_error("Staged image has an invalid size or file type"));
        }
        let detected_extension = detect_image_extension(&canonical_path)?;
        let declared_extension = Path::new(image_ref)
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        if declared_extension != detected_extension {
            return Err(image_error(
                "Staged image content does not match its declared format",
            ));
        }
        Ok(canonical_path)
    }

    pub fn prune_unreferenced_images(&self) -> AppResult<usize> {
        if !self.image_root.exists() {
            return Ok(0);
        }
        reject_link_or_reparse(&self.image_root)?;
        let mut referenced = HashSet::new();
        for session_id in self.repository.active_session_ids()? {
            let snapshot = self.repository.snapshot(&session_id)?;
            for image_ref in snapshot.items.iter().flat_map(|item| &item.image_refs) {
                if let Ok(path) = self.resolve_image_ref(&session_id, image_ref) {
                    referenced.insert(path);
                }
            }
        }
        let mut removed = 0;
        for directory in std::fs::read_dir(&self.image_root)? {
            let directory = directory?;
            reject_link_or_reparse(&directory.path())?;
            if !directory.file_type()?.is_dir() {
                continue;
            }
            for entry in std::fs::read_dir(directory.path())? {
                let entry = entry?;
                reject_link_or_reparse(&entry.path())?;
                if entry.file_type()?.is_file() {
                    let path = entry.path().canonicalize()?;
                    if !referenced.contains(&path) {
                        std::fs::remove_file(path)?;
                        removed += 1;
                    }
                }
            }
        }
        Ok(removed)
    }

    fn session_image_dir(&self, session_id: &str) -> PathBuf {
        let digest = Sha256::digest(session_id.as_bytes());
        self.image_root.join(format!("{digest:x}"))
    }

    fn remove_images(&self, session_id: &str, image_refs: &[String]) {
        for image_ref in image_refs {
            if let Ok(path) = self.resolve_image_ref(session_id, image_ref) {
                let _ = std::fs::remove_file(path);
            }
        }
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

fn validate_opaque_ref(image_ref: &str) -> AppResult<()> {
    let path = Path::new(image_ref);
    if path.components().count() != 1
        || !matches!(path.components().next(), Some(Component::Normal(_)))
    {
        return Err(image_error(
            "Image reference is not an opaque file identifier",
        ));
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !matches!(extension.as_str(), "png" | "jpg" | "webp") {
        return Err(image_error("Image reference uses an unsupported format"));
    }
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    Uuid::parse_str(stem).map_err(|_| image_error("Image reference is not valid"))?;
    Ok(())
}

fn detect_image_extension(path: &Path) -> AppResult<&'static str> {
    let mut file = File::open(path).map_err(|_| image_error("Image data cannot be read"))?;
    let mut header = [0_u8; 12];
    let read = file
        .read(&mut header)
        .map_err(|_| image_error("Image data cannot be read"))?;
    if read >= 8 && header[..8] == *b"\x89PNG\r\n\x1a\n" {
        return Ok("png");
    }
    if read >= 3 && header[..3] == [0xff, 0xd8, 0xff] {
        return Ok("jpg");
    }
    if read >= 12 && header[..4] == *b"RIFF" && header[8..12] == *b"WEBP" {
        return Ok("webp");
    }
    Err(image_error("Image data is not PNG, JPEG, or WebP"))
}

fn reject_link_or_reparse(path: &Path) -> AppResult<()> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|_| image_error("Image path metadata is unavailable"))?;
    if metadata.file_type().is_symlink() || is_reparse_point(&metadata) {
        return Err(image_error("Image paths cannot be links or reparse points"));
    }
    Ok(())
}

#[cfg(windows)]
fn is_reparse_point(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_reparse_point(_metadata: &std::fs::Metadata) -> bool {
    false
}

fn image_error(message: impl Into<String>) -> AppError {
    AppError::coded("IMAGE_REF_INVALID", message)
}

fn stage_error(message: impl Into<String>) -> AppError {
    AppError::coded("IMAGE_STAGE_FAILED", message)
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
            }))
        }

        fn get_session_output(&self, session_id: &str, _lines: usize) -> AppResult<SessionOutput> {
            Ok(SessionOutput {
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
